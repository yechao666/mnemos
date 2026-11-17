/**
 * 工具层测试：node:test + 假 Mnemos **v6** 服务（test/helpers.mjs），不依赖真实后端。
 *
 * 覆盖：分区绑定与隔离、默认人、按人隔离、游标分页（persons / memories）、scope=session 缺省
 * session_id、readOnly 拦截、简报 / 上下文 prompt、人管理、连接自检、错误归一
 * （{ok:false,error,action}）、ensure 降级、v6 partition_stats。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MnemosClient } from '../lib/mnemos-client.js'
import { MNEMOS_TOOL_NAMES, createMnemosTools } from '../lib/tools.js'
import { workspaceSlug } from '../lib/workspace.js'
import { createMnemosFake } from './helpers.mjs'

/** 构造裸配置。 */
function makeConfig(baseUrl, overrides = {}) {
  return {
    baseUrl,
    orgApiKey: 'test_org_key',
    personId: 'dsh-agent',
    personType: 'agent',
    partitionMode: 'workspace',
    fixedPartition: '',
    readOnly: false,
    systemPrompt: true,
    ...overrides,
  }
}

/** 构造工具集：工作区从 exec.agent.session.header.cwd 取，缺省用 fallback。 */
function makeHarness(fake, configOverrides = {}, fallbackWorkspace = '/work/demo') {
  const config = makeConfig(fake.url, configOverrides)
  const client = new MnemosClient(() => config)
  const resolveWorkspacePath = (exec) => exec?.agent?.session?.header?.cwd ?? fallbackWorkspace
  const tools = createMnemosTools(client, () => config, resolveWorkspacePath)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const exec = (cwd = fallbackWorkspace, sessionId = 'sess_current') => ({
    agent: { session: { id: sessionId, header: { cwd } } },
  })
  return { config, client, tools, byName, exec }
}

/** 取工具返回的渲染文本。 */
function renderOf(tool, args, result) {
  const blocks = tool.output.render(args, result)
  assert.ok(Array.isArray(blocks) && blocks.length > 0)
  assert.equal(blocks[0].type, 'text')
  return blocks[0].text
}

/** v6 人级写记忆请求（POST .../persons/:person/memories）。 */
function addRequestOf(fake) {
  return fake.requests.find(
    (request) => request.method === 'POST' && /\/persons\/[^/]+\/memories$/.test(request.pathname),
  )
}

describe('工具清单', () => {
  it('注册 8 个 mnemos_* 工具，名称与文档一致', async () => {
    const fake = await createMnemosFake()
    try {
      const harness = makeHarness(fake)
      assert.deepEqual(
        harness.tools.map((tool) => tool.name),
        [...MNEMOS_TOOL_NAMES],
      )
      assert.equal(harness.tools.length, 8)
    } finally {
      await fake.close()
    }
  })

  it('所有工具都有 description / parameters / output.render', async () => {
    const fake = await createMnemosFake()
    try {
      for (const tool of makeHarness(fake).tools) {
        assert.equal(typeof tool.description, 'string')
        assert.ok(tool.description.length > 10, `${tool.name} 缺少 description`)
        assert.equal(tool.parameters.type, 'object')
        assert.equal(typeof tool.output.render, 'function')
        assert.ok(tool.output.schema, `${tool.name} 缺少 output.schema`)
      }
    } finally {
      await fake.close()
    }
  })
})

describe('mnemos_workspace：工作区 → 分区 + 默认人', () => {
  it('首次调用建分区与默认人，返回分区 / 人 / partition_stats；二次调用复用缓存', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      const result = await byName.get('mnemos_workspace').execute({}, exec())
      assert.equal(result.ok, true, result.error)
      const expectedSlug = workspaceSlug('/work/demo')
      assert.equal(result.partition.slug, expectedSlug)
      assert.equal(result.person.external_id, 'dsh-agent')
      assert.equal(result.person.type, 'agent')
      assert.equal(result.person.memory_count, 0)
      // v6：统计直接来自 partition_stats（人的计数在 persons 行上）。
      assert.deepEqual(result.stats, {
        partition_id: result.partition.id,
        persons_total: 1,
        persons_human: 0,
        persons_agent: 1,
        persons_service: 0,
        memories_total: 0,
        shared_total: 0,
        sessions_total: 0,
        updated_at: '2026-11-17T00:00:00.000Z',
      })
      assert.match(renderOf(byName.get('mnemos_workspace'), {}, result), /分区已就绪/)

      // 假服务端真的存了分区 / 人
      assert.ok(fake.state.partitions.has(expectedSlug))
      assert.ok(fake.state.persons.has(`${expectedSlug}/dsh-agent`))

      // 二次调用：不再 POST /v1/partitions
      const again = await byName.get('mnemos_workspace').execute({}, exec())
      assert.equal(again.ok, true)
      assert.equal(fake.countRequests('POST', '/v1/partitions'), 1)
    } finally {
      await fake.close()
    }
  })

  it('不同工作区 → 不同分区（互不可见）', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      const alpha = workspaceSlug('/work/alpha')
      const beta = workspaceSlug('/work/beta')
      assert.notEqual(alpha, beta)

      const addAlpha = await byName.get('mnemos_add').execute({ text: 'alpha 的私有约定' }, exec('/work/alpha'))
      assert.equal(addAlpha.ok, true, addAlpha.error)

      const alphaSearch = await byName.get('mnemos_search').execute({ query: '约定' }, exec('/work/alpha'))
      assert.equal(alphaSearch.ok, true)
      assert.equal(alphaSearch.count, 1)

      const betaSearch = await byName.get('mnemos_search').execute({ query: '约定' }, exec('/work/beta'))
      assert.equal(betaSearch.ok, true)
      assert.equal(betaSearch.count, 0, '不同工作区的记忆必须互不可见')

      assert.ok(fake.state.partitions.has(alpha))
      assert.ok(fake.state.partitions.has(beta))
    } finally {
      await fake.close()
    }
  })

  it('fixed 模式用 fixedPartition，不再按工作区派生', async () => {
    const fake = await createMnemosFake()
    try {
      fake.seedPartition('mnemos-prod', 'mnemos-prod')
      const { byName, exec } = makeHarness(fake, { partitionMode: 'fixed', fixedPartition: 'mnemos-prod' })
      const result = await byName.get('mnemos_workspace').execute({}, exec('/work/whatever'))
      assert.equal(result.ok, true, result.error)
      assert.equal(result.partition.slug, 'mnemos-prod')
      // fixed 模式不再按工作区派生 slug；首次 ensure 仍会幂等 POST 一次（服务端按 slug upsert）。
      assert.equal(fake.countRequests('POST', '/v1/partitions'), 1)
      assert.deepEqual(fake.requests.find((request) => request.method === 'POST').body, { slug: 'mnemos-prod', name: 'mnemos-prod' })
    } finally {
      await fake.close()
    }
  })

  it('fixed 模式可填分区内部 id：直接 GET，不按 id 新建分区', async () => {
    const fake = await createMnemosFake()
    try {
      const seeded = fake.seedPartition('mnemos-prod', 'mnemos-prod')
      const { byName, exec } = makeHarness(fake, { partitionMode: 'fixed', fixedPartition: seeded.id })
      const result = await byName.get('mnemos_workspace').execute({}, exec('/work/whatever'))
      assert.equal(result.ok, true, result.error)
      assert.equal(result.partition.slug, 'mnemos-prod')
      assert.equal(result.partition.id, seeded.id)
      assert.equal(fake.countRequests('POST', '/v1/partitions'), 0)
    } finally {
      await fake.close()
    }
  })
})

describe('mnemos_add：默认人与写路径（v6 人级端点）', () => {
  it('缺省 scope 不传；写路径用默认人的内部 id（POST persons/:person/memories）', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      const result = await byName.get('mnemos_add').execute({ text: '订单查询要拆分' }, exec())
      assert.equal(result.ok, true, result.error)
      assert.equal(result.added, 1)

      const addRequest = addRequestOf(fake)
      assert.ok(addRequest, '应走 POST /persons/:person/memories')
      const expectedSlug = workspaceSlug('/work/demo')
      const person = fake.state.persons.get(`${expectedSlug}/dsh-agent`)
      assert.equal(addRequest.pathname, `/v1/partitions/${expectedSlug}/persons/${person.id}/memories`)
      assert.equal(addRequest.body.text, '订单查询要拆分')
      assert.equal(addRequest.body.scope, undefined)
      assert.equal(addRequest.body.person_id, undefined, 'person 在路径里，body 不再重复')
      assert.equal(fake.state.memories[0].person_external_id, 'dsh-agent')
    } finally {
      await fake.close()
    }
  })

  it('显式 person_id / scope / category / tags 会进入请求体，并先给人建档', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      const result = await byName.get('mnemos_add').execute(
        {
          text: 'Alice 偏好深色主题',
          person_id: 'alice',
          scope: 'person',
          category: 'preference',
          tags: ['ui'],
        },
        exec(),
      )
      assert.equal(result.ok, true, result.error)
      const slug = workspaceSlug('/work/demo')
      const person = fake.state.persons.get(`${slug}/alice`)
      assert.ok(person, '写前应 PUT 建档')
      const addRequest = addRequestOf(fake)
      assert.equal(addRequest.pathname, `/v1/partitions/${slug}/persons/${person.id}/memories`)
      assert.equal(addRequest.body.scope, 'person')
      assert.equal(addRequest.body.category, 'preference')
      assert.deepEqual(addRequest.body.tags, ['ui'])
    } finally {
      await fake.close()
    }
  })

  it('scope=session 缺省用当前 DSH 会话 id；没有会话 id 时报错并给 action', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      const ok = await byName.get('mnemos_add').execute({ text: '本次会话的临时上下文', scope: 'session' }, exec('/work/demo', 'sess_42'))
      assert.equal(ok.ok, true, ok.error)
      assert.equal(addRequestOf(fake).body.session_id, 'sess_42')

      const withoutSession = await byName.get('mnemos_add').execute(
        { text: 'x', scope: 'session' },
        { agent: { session: {} } },
      )
      assert.equal(withoutSession.ok, false)
      assert.match(withoutSession.action, /session_id/)
    } finally {
      await fake.close()
    }
  })

  it('text 与 messages 都缺 / scope 非法时报错，不抛异常', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      const empty = await byName.get('mnemos_add').execute({}, exec())
      assert.equal(empty.ok, false)
      assert.match(empty.action, /text|messages/)

      const badScope = await byName.get('mnemos_add').execute({ text: 'x', scope: 'world' }, exec())
      assert.equal(badScope.ok, false)
      assert.match(badScope.action, /person/)

      assert.equal(fake.state.memories.length, 0)
    } finally {
      await fake.close()
    }
  })
})

describe('按人组织：检索 / 列表隔离', () => {
  it('默认搜索只看到默认人与分区共享；换人可看到该人私有记忆', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      await byName.get('mnemos_add').execute({ text: 'agent 私有经验', scope: 'person' }, exec())
      await byName.get('mnemos_add').execute({ text: 'alice 私有偏好', person_id: 'alice', scope: 'person' }, exec())
      await byName.get('mnemos_add').execute({ text: '分区共享约定', scope: 'partition' }, exec())

      const own = await byName.get('mnemos_search').execute({ query: '经验' }, exec())
      assert.equal(own.ok, true)
      assert.equal(own.count, 2, '默认人：自己的 person 记忆 + 分区共享')
      const texts = own.results.map((memory) => memory.content).join('|')
      assert.match(texts, /agent 私有经验/)
      assert.match(texts, /分区共享约定/)
      assert.doesNotMatch(texts, /alice 私有偏好/)

      const alice = await byName.get('mnemos_search').execute({ query: '偏好', person_id: 'alice' }, exec())
      assert.equal(alice.ok, true)
      // alice 视角 = 自己的 person 记忆 + 分区共享（不含 dsh-agent 的私有记忆）
      assert.equal(alice.count, 2)
      const aliceTexts = alice.results.map((memory) => memory.content).join('|')
      assert.match(aliceTexts, /alice 私有偏好/)
      assert.doesNotMatch(aliceTexts, /agent 私有经验/)

      const shared = await byName.get('mnemos_search').execute({ query: '约定', scope: 'partition' }, exec())
      assert.equal(shared.ok, true)
      assert.equal(shared.count, 1)
      assert.match(shared.results[0].content, /分区共享约定/)
    } finally {
      await fake.close()
    }
  })

  it('v6 没有 search 端点时退化为列表 q 搜索，仍包含他人写的分区共享', async () => {
    const fake = await createMnemosFake({ searchEndpoint: false })
    try {
      const { byName, exec } = makeHarness(fake)
      await byName.get('mnemos_add').execute({ text: 'agent 私有经验', scope: 'person' }, exec())
      await byName.get('mnemos_add').execute({ text: '共享经验约定', person_id: 'alice', scope: 'partition' }, exec())
      const result = await byName.get('mnemos_search').execute({ query: '经验' }, exec())
      assert.equal(result.ok, true, result.error)
      assert.equal(result.count, 2)
      const texts = result.results.map((memory) => memory.content).join('|')
      assert.match(texts, /agent 私有经验/)
      assert.match(texts, /共享经验约定/)
    } finally {
      await fake.close()
    }
  })

  it('mnemos_get：按 id 取详情 / 默认人游标列表', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      const add = await byName.get('mnemos_add').execute({ text: '详情记忆', scope: 'person' }, exec())
      const id = add.results[0].id

      const detail = await byName.get('mnemos_get').execute({ id }, exec())
      assert.equal(detail.ok, true, detail.error)
      assert.equal(detail.memory.content, '详情记忆')
      assert.equal(renderOf(byName.get('mnemos_get'), { id }, detail), '详情记忆\nid：mem_1 · 分类：fact · scope：person\nperson：dsh-agent · session：-\n状态：active · 更新：2026-11-17T00:00:00.000Z')

      const list = await byName.get('mnemos_get').execute({}, exec())
      assert.equal(list.ok, true, list.error)
      assert.equal(list.count, 1)
      assert.equal(list.next_cursor, undefined)
    } finally {
      await fake.close()
    }
  })

  it('mnemos_get 列表用 cursor/limit 翻页，scope=partition 只列共享', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      for (const content of ['一', '二', '三']) {
        await byName.get('mnemos_add').execute({ text: content, scope: 'person' }, exec())
      }
      await byName.get('mnemos_add').execute({ text: '共享', scope: 'partition' }, exec())

      const first = await byName.get('mnemos_get').execute({ limit: 2 }, exec())
      assert.equal(first.ok, true, first.error)
      assert.equal(first.count, 2)
      assert.ok(first.next_cursor, '还有下一页时返回 next_cursor')

      const second = await byName.get('mnemos_get').execute({ limit: 2, cursor: first.next_cursor }, exec())
      assert.equal(second.ok, true)
      assert.equal(second.count, 2)
      assert.equal(second.next_cursor, undefined)

      const shared = await byName.get('mnemos_get').execute({ scope: 'partition' }, exec())
      assert.equal(shared.ok, true)
      assert.equal(shared.count, 1)
      assert.equal(shared.results[0].content, '共享')
    } finally {
      await fake.close()
    }
  })
})

describe('mnemos_brief / mnemos_context', () => {
  it('brief 返回默认人的简报文本', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      await byName.get('mnemos_add').execute({ text: '喜欢用表格汇报', scope: 'person', category: 'preference' }, exec())
      const result = await byName.get('mnemos_brief').execute({}, exec())
      assert.equal(result.ok, true, result.error)
      assert.equal(result.person_id, 'dsh-agent')
      assert.match(result.text, /喜欢用表格汇报/)
      assert.equal(result.count, 1)
      assert.match(renderOf(byName.get('mnemos_brief'), {}, result), /Mnemos 简报/)
    } finally {
      await fake.close()
    }
  })

  it('context 返回可直接注入的 prompt，person_id 可换人', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      await byName.get('mnemos_add').execute({ text: 'alice 的记忆', person_id: 'alice', scope: 'person' }, exec())
      await byName.get('mnemos_add').execute({ text: '共享知识', scope: 'partition' }, exec())

      const alice = await byName.get('mnemos_context').execute({ person_id: 'alice' }, exec())
      assert.equal(alice.ok, true, alice.error)
      assert.equal(alice.person_id, 'alice')
      assert.match(alice.prompt, /alice 的记忆/)
      assert.equal(alice.memory_count, 1)
      assert.equal(alice.shared_count, 1)
      assert.match(renderOf(byName.get('mnemos_context'), { person_id: 'alice' }, alice), /人物上下文/)
    } finally {
      await fake.close()
    }
  })
})

describe('mnemos_person：list / get / upsert', () => {
  it('upsert 建档后可 list / get；拒绝内部 id 做 upsert', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      const upsert = await byName.get('mnemos_person').execute(
        { action: 'upsert', person_id: 'alice', type: 'human', display_name: 'Alice', attributes: { team: 'growth' } },
        exec(),
      )
      assert.equal(upsert.ok, true, upsert.error)
      assert.equal(upsert.person.external_id, 'alice')
      assert.equal(upsert.person.type, 'human')
      assert.equal(upsert.person.display_name, 'Alice')
      assert.deepEqual(upsert.person.attributes, { team: 'growth' })

      const list = await byName.get('mnemos_person').execute({ action: 'list' }, exec())
      assert.equal(list.ok, true)
      assert.equal(list.count, 1)
      assert.equal(list.people[0].external_id, 'alice')

      const get = await byName.get('mnemos_person').execute({ action: 'get', person_id: 'alice' }, exec())
      assert.equal(get.ok, true)
      assert.equal(get.person.external_id, 'alice')

      const internal = await byName.get('mnemos_person').execute({ action: 'upsert', person_id: 'prs_1' }, exec())
      assert.equal(internal.ok, false)
      assert.match(internal.action, /external_id/)
    } finally {
      await fake.close()
    }
  })

  it('list 用 v6 游标分页（cursor/limit），返回 next_cursor 与 partition_stats', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      for (const [externalId, type] of [
        ['alice', 'human'],
        ['bob', 'human'],
        ['dsh-agent', 'agent'],
      ]) {
        await byName.get('mnemos_person').execute(
          { action: 'upsert', person_id: externalId, type, display_name: externalId },
          exec(),
        )
      }

      const first = await byName.get('mnemos_person').execute({ action: 'list', limit: 2 }, exec())
      assert.equal(first.ok, true, first.error)
      assert.equal(first.count, 2)
      assert.ok(first.next_cursor, '还有下一页时返回 next_cursor')
      assert.equal(first.partition_stats.persons_total, 3)

      const second = await byName.get('mnemos_person').execute(
        { action: 'list', limit: 2, cursor: first.next_cursor },
        exec(),
      )
      assert.equal(second.ok, true)
      assert.equal(second.count, 1)
      assert.equal(second.next_cursor, undefined)
    } finally {
      await fake.close()
    }
  })
})

describe('readOnly 模式', () => {
  it('拦截 mnemos_add 与 mnemos_person upsert，不产生写请求；读工具照常', async () => {
    const fake = await createMnemosFake()
    try {
      fake.seedPartition(workspaceSlug('/work/demo'), 'demo')
      fake.seedPerson(workspaceSlug('/work/demo'), 'dsh-agent', { type: 'agent' })
      const { byName, exec } = makeHarness(fake, { readOnly: true })

      const add = await byName.get('mnemos_add').execute({ text: 'x' }, exec())
      assert.equal(add.ok, false)
      assert.match(add.error, /readOnly/)
      assert.match(add.action, /readOnly/)

      const upsert = await byName.get('mnemos_person').execute({ action: 'upsert', person_id: 'alice' }, exec())
      assert.equal(upsert.ok, false)
      assert.match(upsert.error, /readOnly/)

      const writes = fake.requests.filter(
        (request) => request.method === 'POST' && request.pathname.includes('/memories'),
      )
      assert.equal(writes.length, 0)
      assert.equal(
        fake.requests.filter((request) => request.method === 'PUT' && request.pathname.includes('/persons/')).length,
        0,
      )

      const search = await byName.get('mnemos_search').execute({ query: 'x' }, exec())
      assert.equal(search.ok, true)
      // readOnly 连建分区都不做
      assert.equal(fake.countRequests('POST', '/v1/partitions'), 0)
    } finally {
      await fake.close()
    }
  })
})

describe('mnemos_status：连接自检', () => {
  it('分区与人就绪时 ok；分区不存在时给出可操作提示', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake)
      // 先让工作区工具建好分区 / 人
      assert.equal((await byName.get('mnemos_workspace').execute({}, exec())).ok, true)

      const result = await byName.get('mnemos_status').execute({}, exec())
      assert.equal(result.ok, true, result.error)
      assert.equal(result.reachable, true)
      assert.equal(result.apiKeyConfigured, true)
      assert.equal(result.partitionExists, true)
      assert.equal(result.personExists, true)
      assert.equal(result.partitionSlug, workspaceSlug('/work/demo'))
      assert.match(renderOf(byName.get('mnemos_status'), {}, result), /Mnemos 连接：服务可达/)

      const missing = await byName.get('mnemos_status').execute({}, exec('/work/never-created'))
      assert.equal(missing.ok, false)
      assert.equal(missing.reachable, true)
      assert.equal(missing.partitionExists, false)
      assert.match(missing.action, /mnemos_workspace/)
    } finally {
      await fake.close()
    }
  })

  it('orgApiKey 缺失时不发请求，直接报配置缺失', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake, { orgApiKey: '' })
      const result = await byName.get('mnemos_status').execute({}, exec())
      assert.equal(result.ok, false)
      assert.equal(result.apiKeyConfigured, false)
      assert.match(result.action, /orgApiKey/)
      assert.equal(fake.requests.length, 0)
    } finally {
      await fake.close()
    }
  })

  it('key 无效（401）时报告不可达与错误原因', async () => {
    const fake = await createMnemosFake()
    try {
      const { byName, exec } = makeHarness(fake, { orgApiKey: 'wrong_key' })
      const result = await byName.get('mnemos_status').execute({}, exec())
      assert.equal(result.ok, false)
      assert.equal(result.reachable, false)
      assert.match(result.error, /401|INVALID_API_KEY/)
    } finally {
      await fake.close()
    }
  })
})

describe('错误归一与降级', () => {
  it('服务端 403 时工具返回 {ok:false,error,action}，execute 不抛', async () => {
    const fake = await createMnemosFake({
      failures: [{ method: 'POST', path: /\/memories\/search$/, status: 403, code: 'FORBIDDEN', message: 'no scope' }],
    })
    try {
      const { byName, exec } = makeHarness(fake)
      const result = await byName.get('mnemos_search').execute({ query: 'x' }, exec())
      assert.equal(result.ok, false)
      assert.match(result.error, /403|FORBIDDEN/)
      assert.match(result.action, /作用域|memories:read/)
      assert.match(renderOf(byName.get('mnemos_search'), { query: 'x' }, result), /失败/)
    } finally {
      await fake.close()
    }
  })

  it('org key 没有 admin（POST 分区 403）时，读工具按 slug 降级并带 warning', async () => {
    const fake = await createMnemosFake({ missingAdmin: true })
    try {
      fake.seedPartition(workspaceSlug('/work/demo'), 'demo')
      const { byName, exec } = makeHarness(fake)
      const result = await byName.get('mnemos_search').execute({ query: 'x' }, exec())
      assert.equal(result.ok, true, result.error)
      assert.match(result.warning, /无法自动创建分区/)
    } finally {
      await fake.close()
    }
  })

  it('分区不存在且无法创建时，mnemos_workspace 返回失败原因与 action', async () => {
    const fake = await createMnemosFake({ missingAdmin: true })
    try {
      const { byName, exec } = makeHarness(fake)
      const result = await byName.get('mnemos_workspace').execute({}, exec())
      assert.equal(result.ok, false)
      assert.match(result.error, /404|NOT_FOUND/)
      assert.match(result.action, /mnemos_workspace|admin/)
    } finally {
      await fake.close()
    }
  })
})
