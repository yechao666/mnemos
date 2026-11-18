/**
 * MnemosClient 单元测试（node:test + 本地 node:http mock，零额外依赖）。
 *
 * 覆盖 v6 契约：Bearer 鉴权、`/v1/partitions/:p/...`（id 或 slug）、snake_case 请求体、
 * 人/记忆游标分页（`{items,next_cursor,partition_stats}`）、人级记忆写入、检索主路径与
 * `GET memories?q=` 退化路径、brief/context/dream、错误归一（401 / 403 / 404 / 超时 / 网络）、
 * 分区 ensure 幂等（并发只 POST 一次、成功后缓存、409 退化为 GET）、人 ensure 缓存、未配置 key 的本地短路。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MnemosApiError, MnemosClient, MnemosTimeoutError } from '../lib/mnemos-client.js'
import { closeServer, createMnemosFake, startMock } from './helpers.mjs'

/** 构造客户端（裸配置，覆盖 baseUrl / key / 超时）。 */
function makeClient(baseUrl, overrides = {}, options = {}) {
  const config = {
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
  return new MnemosClient(() => config, options)
}

describe('MnemosClient 请求层', () => {
  it('发送 Bearer 鉴权头，并按 /v1/partitions/:p 路径请求', async () => {
    const seen = {}
    const { server, url } = await startMock(({ req, res }) => {
      seen.method = req.method
      seen.path = new URL(req.url, 'http://x').pathname
      seen.authorization = req.headers.authorization
      sendMemory(res)
    })
    try {
      const payload = await makeClient(url).getMemory('ws-demo-1234abcd', 'mem_1')
      assert.equal(payload.memory.id, 'mem_1')
      assert.equal(seen.method, 'GET')
      assert.equal(seen.path, '/v1/partitions/ws-demo-1234abcd/memories/mem_1')
      assert.equal(seen.authorization, 'Bearer test_org_key')
    } finally {
      await closeServer(server)
    }
  })

  it('分区引用支持内部 id：路径原样使用（服务端兼容 id 或 slug）', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedPerson(partition.id, 'alice', { type: 'human' })
      const client = makeClient(fake.url)
      const payload = await client.getPerson(partition.id, 'alice')
      assert.equal(payload.external_id, 'alice')
      const last = fake.requests[fake.requests.length - 1]
      assert.equal(last.pathname, `/v1/partitions/${partition.id}/persons/alice`)
    } finally {
      await fake.close()
    }
  })

  it('写记忆走人级端点，body 使用 snake_case 且只带显式字段', async () => {
    let received = null
    let seenPath = null
    const { server, url } = await startMock(({ req, res, body }) => {
      received = body
      seenPath = new URL(req.url, 'http://x').pathname
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [{ id: 'mem_1', content: '拆分订单查询', scope: 'person' }] }))
    })
    try {
      const written = await makeClient(url).addMemory('ws-demo-1234abcd', 'prs_1', {
        text: '拆分订单查询',
        scope: 'person',
        session_id: 'sess_1',
        category: 'fact',
        tags: ['orders'],
      })
      assert.equal(seenPath, '/v1/partitions/ws-demo-1234abcd/persons/prs_1/memories')
      assert.deepEqual(received, {
        text: '拆分订单查询',
        scope: 'person',
        session_id: 'sess_1',
        category: 'fact',
        tags: ['orders'],
      })
      assert.equal(written.memories.length, 1)
      assert.equal(written.memories[0].content, '拆分订单查询')
    } finally {
      await closeServer(server)
    }
  })

  it('search 优先走 POST /memories/search，请求体是 query + person_id/scope/category/top_k', async () => {
    let received = null
    let seenPath = null
    const { server, url } = await startMock(({ req, res, body }) => {
      received = body
      seenPath = new URL(req.url, 'http://x').pathname
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [{ id: 'mem_1', content: 'x', score: 0.9 }], took_ms: 2 }))
    })
    try {
      const result = await makeClient(url).searchMemories('ws-demo-1234abcd', {
        query: '订单查询',
        person_id: 'dsh-agent',
        scope: 'person',
        category: 'fact',
        top_k: 5,
      })
      assert.equal(seenPath, '/v1/partitions/ws-demo-1234abcd/memories/search')
      assert.deepEqual(received, {
        query: '订单查询',
        person_id: 'dsh-agent',
        scope: 'person',
        category: 'fact',
        top_k: 5,
      })
      assert.equal(result.results.length, 1)
      assert.equal(result.took_ms, 2)
    } finally {
      await closeServer(server)
    }
  })

  it('search 端点不存在（404）时退化为 GET /memories?q=，并合并本人记忆 + 分区共享', async () => {
    const fake = await createMnemosFake({ searchEndpoint: false })
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedPerson(partition.slug, 'dsh-agent', { type: 'agent' })
      fake.seedMemory(partition.slug, 'dsh-agent', '订单查询要拆分', { scope: 'person' })
      // 别人写的分区共享：v6 的 person_id 是作者过滤，必须再查一次 scope=partition 才能看到。
      fake.seedMemory(partition.slug, 'alice', '订单检索的共享约定', { scope: 'partition' })
      const result = await makeClient(fake.url).searchMemories('ws-demo-1234abcd', {
        query: '订单',
        person_id: 'dsh-agent',
        top_k: 5,
      })
      const texts = result.results.map((memory) => memory.content).join('|')
      assert.match(texts, /订单查询要拆分/)
      assert.match(texts, /订单检索的共享约定/)

      const searchRequest = fake.requests.find((request) => request.pathname.endsWith('/memories/search'))
      assert.ok(searchRequest, '应先尝试 POST search')
      const listQueries = fake.requests.filter(
        (request) => request.method === 'GET' && request.pathname.endsWith('/memories'),
      )
      assert.equal(listQueries.length, 2, '本人 + 分区共享各一次列表查询')
      const ownQuery = listQueries.find((request) => request.query.person_id === 'dsh-agent')
      const sharedQuery = listQueries.find((request) => request.query.scope === 'partition')
      assert.ok(ownQuery, '应有按人（作者）查询')
      assert.ok(sharedQuery, '应有分区共享查询')
      assert.equal(ownQuery.query.q, '订单')
      assert.equal(ownQuery.query.limit, '5')
      assert.equal(sharedQuery.query.q, '订单')
      assert.equal(sharedQuery.query.limit, '5')
    } finally {
      await fake.close()
    }
  })

  it('分区统计读 GET /stats 并归一为扁平对象', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedPerson(partition.slug, 'dsh-agent', { type: 'agent' })
      const stats = await makeClient(fake.url).getPartitionStats(partition.slug)
      assert.equal(stats.persons_total, 1)
      assert.equal(stats.persons_agent, 1)
      assert.equal(stats.memories_total, 0)
      assert.equal(stats.shared_total, 0)
      assert.equal(
        fake.countRequests('GET', `/v1/partitions/${partition.slug}/stats`),
        1,
      )
    } finally {
      await fake.close()
    }
  })
})

describe('MnemosClient v6 游标分页', () => {
  it('listPersons 使用 cursor/limit，响应 {items,next_cursor,partition_stats}', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedPerson(partition.slug, 'alice', { type: 'human' })
      fake.seedPerson(partition.slug, 'bob', { type: 'human' })
      fake.seedPerson(partition.slug, 'dsh-agent', { type: 'agent' })
      const client = makeClient(fake.url)

      const first = await client.listPersons(partition.slug, { limit: 2, sort: 'name' })
      assert.equal(first.items.length, 2)
      assert.ok(first.next_cursor)
      assert.equal(first.partition_stats.persons_total, 3)

      const second = await client.listPersons(partition.slug, { limit: 2, sort: 'name', cursor: first.next_cursor })
      assert.equal(second.items.length, 1)
      assert.equal(second.next_cursor, undefined)
      assert.equal(second.partition_stats.persons_total, 3)

      const request = fake.requests.find((item) => item.pathname.endsWith('/persons'))
      assert.equal(request.query.limit, '2')
      assert.equal(request.query.sort, 'name')
    } finally {
      await fake.close()
    }
  })

  it('listPersons 支持 q / type / status 过滤', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedPerson(partition.slug, 'alice', { type: 'human', display_name: 'Alice' })
      fake.seedPerson(partition.slug, 'dsh-agent', { type: 'agent' })
      const client = makeClient(fake.url)

      const agents = await client.listPersons(partition.slug, { type: 'agent' })
      assert.deepEqual(agents.items.map((person) => person.external_id), ['dsh-agent'])

      const searched = await client.listPersons(partition.slug, { q: 'ali' })
      assert.deepEqual(searched.items.map((person) => person.external_id), ['alice'])
    } finally {
      await fake.close()
    }
  })

  it('listPersonMemories 按人游标分页，并支持 scope/category 过滤', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedMemory(partition.slug, 'dsh-agent', 'a', { scope: 'person', category: 'fact' })
      fake.seedMemory(partition.slug, 'dsh-agent', 'b', { scope: 'person', category: 'preference' })
      fake.seedMemory(partition.slug, 'dsh-agent', 'c', { scope: 'partition' })
      const client = makeClient(fake.url)

      const first = await client.listPersonMemories(partition.slug, 'dsh-agent', { limit: 2 })
      assert.equal(first.items.length, 2)
      assert.ok(first.next_cursor)
      const second = await client.listPersonMemories(partition.slug, 'dsh-agent', {
        limit: 2,
        cursor: first.next_cursor,
      })
      assert.equal(second.items.length, 1)

      const personal = await client.listPersonMemories(partition.slug, 'dsh-agent', { scope: 'person' })
      assert.equal(personal.items.length, 2)
      const preferences = await client.listPersonMemories(partition.slug, 'dsh-agent', { category: 'preference' })
      assert.equal(preferences.items.length, 1)
      assert.equal(preferences.items[0].content, 'b')
    } finally {
      await fake.close()
    }
  })

  it('listMemories（全局列表）支持 person_id / scope 过滤', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedMemory(partition.slug, 'dsh-agent', 'agent 私有', { scope: 'person' })
      fake.seedMemory(partition.slug, 'alice', 'alice 私有', { scope: 'person' })
      fake.seedMemory(partition.slug, 'dsh-agent', '分区共享', { scope: 'partition' })
      const client = makeClient(fake.url)

      const visible = await client.listMemories(partition.slug, { person_id: 'dsh-agent' })
      const contents = visible.items.map((memory) => memory.content).join('|')
      assert.match(contents, /agent 私有/)
      assert.match(contents, /分区共享/)
      assert.doesNotMatch(contents, /alice 私有/)

      const shared = await client.listMemories(partition.slug, { scope: 'partition' })
      assert.equal(shared.items.length, 1)
      assert.equal(shared.items[0].content, '分区共享')
      assert.equal(shared.partition_stats.shared_total, 1)
    } finally {
      await fake.close()
    }
  })
})

describe('MnemosClient 人 / 记忆读写', () => {
  it('ensurePerson 用 PUT persons/:externalId 建档并缓存', async () => {
    const fake = await createMnemosFake()
    try {
      fake.seedPartition('ws-demo-1234abcd', 'demo')
      const client = makeClient(fake.url)
      const first = await client.ensurePerson('ws-demo-1234abcd', 'dsh-agent', { type: 'agent' })
      const second = await client.ensurePerson('ws-demo-1234abcd', 'dsh-agent', { type: 'agent' })
      assert.equal(first.externalId, 'dsh-agent')
      assert.equal(second.id, first.id)
      assert.equal(fake.countRequests('PUT', '/v1/partitions/ws-demo-1234abcd/persons/dsh-agent'), 1)
      assert.deepEqual(fake.requests[0].body, { type: 'agent' })
    } finally {
      await fake.close()
    }
  })

  it('updatePerson 用 PATCH persons/:person 更新资料', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedPerson(partition.slug, 'alice', { type: 'human', display_name: 'Alice' })
      const payload = await makeClient(fake.url).updatePerson(partition.slug, 'alice', {
        display_name: 'Alice Zhang',
        attributes: { team: 'growth' },
      })
      assert.equal(payload.display_name, 'Alice Zhang')
      assert.deepEqual(payload.attributes, { team: 'growth' })
      const request = fake.requests.find((item) => item.method === 'PATCH')
      assert.deepEqual(request.body, { display_name: 'Alice Zhang', attributes: { team: 'growth' } })
    } finally {
      await fake.close()
    }
  })

  it('getMemory 读单条；人级 brief / context / dream 走 v6 端点', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedMemory(partition.slug, 'dsh-agent', '喜欢用表格汇报', { scope: 'person', category: 'preference' })
      const client = makeClient(fake.url)

      const brief = await client.getPersonBrief(partition.slug, 'dsh-agent')
      assert.match(brief.text, /喜欢用表格汇报/)
      assert.equal(brief.count, 1)

      const context = await client.getPersonContext(partition.slug, 'dsh-agent', { query: '汇报' })
      assert.match(context.prompt, /人物上下文/)
      assert.equal(context.memories.length, 1)

      const dream = await client.getPersonDream(partition.slug, 'dsh-agent')
      assert.equal(dream.person_id, fake.state.persons.get(`${partition.slug}/dsh-agent`).id)
      assert.equal(dream.pending_count, 0)

      const run = await client.runPersonDream(partition.slug, 'dsh-agent')
      assert.equal(run.run.status, 'succeeded')
      assert.equal(run.run.input_count, 1)
    } finally {
      await fake.close()
    }
  })
})

describe('MnemosClient v6.1 画像 / 历史 / 反馈 / 更新', () => {
  it('getPersonProfile 走 /profile，渲染数据来自 facts + summary；force=1 不命中缓存', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedFact(partition.slug, 'dsh-agent', { key: 'city', value: '上海', confidence: 0.95 })
      const client = makeClient(fake.url)

      const cached = await client.getPersonProfile(partition.slug, 'dsh-agent')
      assert.equal(cached.facts.length, 1)
      assert.equal(cached.facts[0].key, 'city')
      assert.equal(cached.facts[0].value, '上海')
      assert.match(cached.summary, /上海/)
      assert.equal(cached.cached, true)
      assert.equal(fake.requests.find((item) => item.pathname.endsWith('/profile')).query.force, undefined)

      const forced = await client.getPersonProfile(partition.slug, 'dsh-agent', { force: true })
      assert.equal(forced.cached, false)
      const profileRequests = fake.requests.filter((item) => item.pathname.endsWith('/profile'))
      assert.equal(profileRequests.at(-1).query.force, '1')
    } finally {
      await fake.close()
    }
  })

  it('getMemoryHistory / feedbackMemory / updateMemory 走对应端点并归一 memory', async () => {
    const fake = await createMnemosFake()
    try {
      const partition = fake.seedPartition('ws-demo-1234abcd', 'demo')
      fake.seedPerson(partition.slug, 'dsh-agent', { type: 'agent' })
      const client = makeClient(fake.url)

      const written = await client.addMemory(partition.slug, 'dsh-agent', { text: '旧内容', scope: 'person' })
      const id = written.memories[0].id
      assert.ok(id)

      const history = await client.getMemoryHistory(partition.slug, id)
      assert.equal(history.length, 1)
      assert.equal(history[0].event, 'ADD')
      assert.equal(history[0].new_content, '旧内容')
      assert.equal(history[0].actor, 'api_key:test')

      const feedback = await client.feedbackMemory(partition.slug, id, { helpful: true, query: '怎么部署' })
      assert.equal(feedback.memory.confidence, 0.85)
      assert.equal(feedback.memory.feedback_up, 1)
      assert.equal(feedback.memory.feedback_down, 0)
      const feedbackRequest = fake.requests.find((item) => item.pathname.endsWith('/feedback'))
      assert.deepEqual(feedbackRequest.body, { helpful: true, query: '怎么部署' })

      const updated = await client.updateMemory(partition.slug, id, {
        content: '新内容',
        importance: 0.9,
        tags: ['a'],
        metadata: { k: 'v' },
      })
      assert.equal(updated.memory.content, '新内容')
      assert.equal(updated.memory.importance, 0.9)
      assert.deepEqual(updated.memory.tags, ['a'])
      assert.deepEqual(updated.memory.metadata, { k: 'v' })
      const patchRequest = fake.requests.find((item) => item.method === 'PATCH')
      assert.deepEqual(patchRequest.body, {
        content: '新内容',
        importance: 0.9,
        tags: ['a'],
        metadata: { k: 'v' },
      })

      const after = await client.getMemoryHistory(partition.slug, id)
      assert.deepEqual(
        after.map((entry) => entry.event),
        ['UPDATE', 'FEEDBACK', 'ADD'],
        '历史按新→旧返回',
      )
      assert.equal(after[0].old_content, '旧内容')
      assert.equal(after[0].new_content, '新内容')
    } finally {
      await fake.close()
    }
  })
})

describe('MnemosClient 错误归一', () => {
  it('401 → code/action 指明检查 orgApiKey，消息含状态码', async () => {
    const { server, url } = await startMock(({ res }) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'INVALID_API_KEY', message: 'bad key' } }))
    })
    try {
      await assert.rejects(makeClient(url).getPartition('ws-demo-1234abcd'), (error) => {
        assert.ok(error instanceof MnemosApiError)
        assert.equal(error.status, 401)
        assert.equal(error.code, 'INVALID_API_KEY')
        assert.match(error.action, /orgApiKey/)
        assert.match(error.message, /401/)
        return true
      })
    } finally {
      await closeServer(server)
    }
  })

  it('403 → action 指明 org key 作用域不足', async () => {
    const { server, url } = await startMock(({ res }) => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'scope' } }))
    })
    try {
      await assert.rejects(makeClient(url).getPartition('x'), (error) => {
        assert.match(error.action, /memories:read|admin/)
        return true
      })
    } finally {
      await closeServer(server)
    }
  })

  it('未配置 orgApiKey 时照常发请求，但不带 Authorization（本地免密）', async () => {
    const seen = {}
    const { server, url, requests } = await startMock(({ req, res }) => {
      seen.method = req.method
      seen.path = new URL(req.url, 'http://x').pathname
      seen.authorization = req.headers.authorization
      sendMemory(res)
    })
    try {
      const payload = await makeClient(url, { orgApiKey: '  ' }).getPartition('ws-demo-1234abcd')
      assert.equal(payload.memory.id, 'mem_1')
      assert.equal(requests.length, 1, '免密模式也必须真的发请求（不再本地短路）')
      assert.equal(seen.authorization, undefined, '免密模式请求不得带 Authorization')
      assert.equal(seen.path, '/v1/partitions/ws-demo-1234abcd')
      assert.equal(makeClient(url, { orgApiKey: '' }).authMode(), 'none')
      assert.equal(makeClient(url).authMode(), 'orgKey')
    } finally {
      await closeServer(server)
    }
  })

  it('免密模式下服务端 401 → code/action 提示配置 key 或 MNEMOS_DEV_NO_API_KEY=1', async () => {
    const fake = await createMnemosFake()
    try {
      fake.seedPartition('ws-demo-1234abcd', 'demo')
      await assert.rejects(makeClient(fake.url, { orgApiKey: '' }).getPartition('ws-demo-1234abcd'), (error) => {
        assert.ok(error instanceof MnemosApiError)
        assert.equal(error.status, 401)
        assert.match(error.action, /orgApiKey/)
        assert.match(error.action, /MNEMOS_DEV_NO_API_KEY=1/)
        assert.doesNotMatch(error.action, /orgApiKey 无效或已失效/)
        return true
      })
    } finally {
      await fake.close()
    }
  })

  it('免密模式下服务端 403 → action 同样提示补齐 key / 本地免密', async () => {
    const { server, url } = await startMock(({ res }) => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'no scope' } }))
    })
    try {
      await assert.rejects(makeClient(url, { orgApiKey: '' }).getPartition('x'), (error) => {
        assert.equal(error.status, 403)
        assert.match(error.action, /MNEMOS_DEV_NO_API_KEY=1/)
        return true
      })
    } finally {
      await closeServer(server)
    }
  })

  it('baseUrl 为空时本地短路（missing_base_url）', async () => {
    const client = makeClient('')
    await assert.rejects(client.getPartition('x'), (error) => {
      assert.equal(error.code, 'missing_base_url')
      return true
    })
  })

  it('超时归为 MnemosTimeoutError（code=timeout）', async () => {
    // 永不响应的 handler：客户端 50ms 超时。
    const { server, url } = await startMock(() => new Promise(() => {}))
    try {
      await assert.rejects(makeClient(url, {}, { timeoutMs: 50 }).getPartition('x'), (error) => {
        assert.ok(error instanceof MnemosTimeoutError)
        assert.equal(error.code, 'timeout')
        assert.match(error.action, /服务已启动|超时|baseUrl/)
        return true
      })
    } finally {
      await closeServer(server)
    }
  })

  it('连接失败归为 network_error', async () => {
    // 127.0.0.1:1 上的服务必然拒绝连接。
    await assert.rejects(makeClient('http://127.0.0.1:1').getPartition('x'), (error) => {
      assert.equal(error.code, 'network_error')
      assert.match(error.action, /baseUrl/)
      return true
    })
  })
})

describe('MnemosClient 分区 ensure', () => {
  it('首次 ensurePartition 发 POST /v1/partitions，成功后缓存不再 POST', async () => {
    const fake = await createMnemosFake()
    try {
      const client = makeClient(fake.url)
      const first = await client.ensurePartition('ws-demo-1234abcd', 'demo')
      const second = await client.ensurePartition('ws-demo-1234abcd', 'demo')
      assert.equal(first.slug, 'ws-demo-1234abcd')
      assert.equal(second.id, first.id)
      assert.equal(fake.countRequests('POST', '/v1/partitions'), 1)
      assert.deepEqual(fake.requests[0].body, { slug: 'ws-demo-1234abcd', name: 'demo' })
    } finally {
      await fake.close()
    }
  })

  it('fixed 模式传分区内部 id 时直接 GET（不把 id 当 slug 去 upsert）', async () => {
    const fake = await createMnemosFake()
    try {
      const seeded = fake.seedPartition('ws-demo-1234abcd', 'demo')
      const info = await makeClient(fake.url).ensurePartition(seeded.id, 'demo')
      assert.equal(info.slug, 'ws-demo-1234abcd')
      assert.equal(info.id, seeded.id)
      assert.equal(fake.countRequests('POST', '/v1/partitions'), 0)
      assert.equal(fake.countRequests('GET', `/v1/partitions/${seeded.id}`), 1)
    } finally {
      await fake.close()
    }
  })

  it('并发 ensurePartition 只发一次 POST', async () => {
    const fake = await createMnemosFake()
    try {
      const client = makeClient(fake.url)
      const [a, b, c] = await Promise.all([
        client.ensurePartition('ws-demo-1234abcd', 'demo'),
        client.ensurePartition('ws-demo-1234abcd', 'demo'),
        client.ensurePartition('ws-demo-1234abcd', 'demo'),
      ])
      assert.equal(a.id, b.id)
      assert.equal(b.id, c.id)
      assert.equal(fake.countRequests('POST', '/v1/partitions'), 1)
    } finally {
      await fake.close()
    }
  })

  it('服务端 409（已存在）时退化为 GET /v1/partitions/:slug', async () => {
    const fake = await createMnemosFake({ conflictOnExisting: true })
    try {
      fake.seedPartition('ws-demo-1234abcd', 'demo')
      const info = await makeClient(fake.url).ensurePartition('ws-demo-1234abcd', 'demo')
      assert.equal(info.slug, 'ws-demo-1234abcd')
      assert.ok(info.id)
      assert.equal(fake.countRequests('GET', '/v1/partitions/ws-demo-1234abcd'), 1)
    } finally {
      await fake.close()
    }
  })

  it('clearCache 后重新 ensure', async () => {
    const fake = await createMnemosFake()
    try {
      fake.seedPartition('ws-demo-1234abcd', 'demo')
      const client = makeClient(fake.url)
      await client.ensurePartition('ws-demo-1234abcd', 'demo')
      client.clearCache()
      await client.ensurePartition('ws-demo-1234abcd', 'demo')
      assert.equal(fake.countRequests('POST', '/v1/partitions'), 2)
    } finally {
      await fake.close()
    }
  })
})

/** 最小记忆响应。 */
function sendMemory(res) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ memory: { id: 'mem_1', content: '一条记忆', scope: 'person' } }))
}
