/**
 * mnemos_* 工具测试（node:test）。
 *
 * 主体部分对着本地 node:http mock 跑：mock 严格照抄 Mnemos `/v1` 的真实形状
 * （创建返回 camelCase Memory；读路径返回 snake_case v1 视图；finish 返回
 * `{task, memories}`），所以工具的入参拼装、输出 schema 与 render 都被真实覆盖。
 *
 * 另外有一段**真实服务**只读冒烟（默认打 http://127.0.0.1:4380）：服务不可达时自动跳过，
 * 不会因为环境没起服务而让 `node --test` 变红。
 * 真机写入测试默认关闭，避免污染演示数据；需要时：
 *   MNEMOS_TEST_WRITE=1 node --test test/tools.test.mjs
 * 该用例会自己创建一条带 DELETEME 标记的记忆并在 finally 里删掉。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, beforeEach, describe, it } from 'node:test'

import { MnemosClient } from '../lib/mnemos-client.js'
import { createMnemosTools } from '../lib/tools.js'

const LIVE_URL = process.env.MNEMOS_TEST_URL ?? 'http://127.0.0.1:4380'
const LIVE_KEY = process.env.MNEMOS_TEST_API_KEY ?? 'mnemos_live_demo_orion_python'
const LIVE_WRITE = process.env.MNEMOS_TEST_WRITE === '1'

/* ------------------------------------------------------------------ */
/* 本地 mock：照抄 /v1 契约                                            */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString()
}

function createState() {
  return {
    seq: 0,
    memories: new Map(),
    tasks: new Map(),
    agents: [{ id: 'agent_seed', name: '种子 Agent', role: 'coder', model: 'deepseek-chat', capabilities: [] }],
    requests: [],
    statsAllowed: false,
  }
}

/** 服务端 POST /v1/memories 返回 camelCase 的 Memory（与真实服务一致）。 */
function camelMemory(memory) {
  return {
    id: memory.id,
    projectId: 'prj_unit',
    userId: memory.user_id,
    agentId: memory.agent_id,
    taskId: memory.task_id,
    visibility: memory.visibility,
    content: memory.memory,
    category: memory.category,
    importance: memory.importance,
    confidence: memory.confidence,
    source: 'api',
    status: memory.status,
    tags: memory.tags,
    metadata: memory.metadata,
    createdAt: memory.created_at,
    updatedAt: memory.updated_at,
    accessCount: memory.access_count,
  }
}

function insertMemory(state, body) {
  const content = body.text ?? body.messages?.[0]?.content ?? ''
  const id = `mem_${++state.seq}`
  const memory = {
    id,
    memory: content,
    user_id: body.user_id ?? null,
    agent_id: body.agent_id ?? null,
    run_id: body.run_id ?? null,
    app_id: body.app_id ?? null,
    task_id: body.task_id ?? null,
    visibility: body.visibility ?? 'project',
    category: 'fact',
    importance: 0.5,
    confidence: 0.8,
    source: 'api',
    status: 'active',
    tags: body.tags ?? [],
    metadata: body.metadata ?? {},
    created_at: nowIso(),
    updated_at: nowIso(),
    last_accessed_at: null,
    access_count: 0,
    expires_at: null,
  }
  state.memories.set(id, memory)
  if (memory.task_id && state.tasks.has(memory.task_id)) {
    state.tasks.get(memory.task_id).memory_count += 1
  }
  return memory
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function notFound(res) {
  sendJson(res, 404, { error: { code: 'not_found', message: '资源不存在', requestId: 'req_mock' } })
}

async function handleRequest(state, { req, res, body, url }) {
  const { pathname } = url
  const method = req.method ?? 'GET'
  state.requests.push({ method, path: pathname, query: url.searchParams, body })

  // 健康检查 / 统计
  if (method === 'GET' && pathname === '/v1/health') {
    return sendJson(res, 200, { ok: true, version: '1.1.0-mock', uptime_ms: 61000 })
  }
  if (method === 'GET' && pathname === '/v1/stats') {
    if (!state.statsAllowed) {
      return sendJson(res, 403, { error: { code: 'forbidden', message: '缺少 admin 作用域', requestId: 'req_stats' } })
    }
    return sendJson(res, 200, { metrics: { total_memories: 12, agents: 3, searches_7d: 40, hit_rate: 0.9, recall_p95_ms: 55 } })
  }

  // 检索
  if (method === 'POST' && pathname === '/v1/memories/search') {
    const active = [...state.memories.values()].filter((memory) => memory.status === 'active')
    const topK = body.top_k ?? 8
    const hits = active.slice(0, topK).map((memory) => ({
      ...memory,
      score: 0.91,
      signals: { semantic: 0.8, keyword: 0.6 },
      matched_on: ['semantic', 'keyword'],
    }))
    return sendJson(res, 200, { results: hits, took_ms: 4.2, signals: { strategy: 'hybrid' } })
  }

  // 写入
  if (method === 'POST' && pathname === '/v1/memories') {
    const memory = insertMemory(state, body)
    return sendJson(res, 200, {
      results: [camelMemory(memory)],
      events: [{ type: 'ADD', memoryId: memory.id, content: memory.memory, at: memory.created_at }],
      tookMs: 1.5,
    })
  }

  // 列表
  if (method === 'GET' && pathname === '/v1/memories') {
    const page = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('page_size') ?? 20)
    let rows = [...state.memories.values()].filter((memory) => memory.status === 'active')
    for (const key of ['user_id', 'agent_id', 'task_id', 'category']) {
      const value = url.searchParams.get(key)
      if (value) rows = rows.filter((memory) => memory[key] === value)
    }
    const total = rows.length
    rows = rows.slice((page - 1) * pageSize, page * pageSize)
    return sendJson(res, 200, { results: rows, count: total, page, page_size: pageSize })
  }

  // 单条记忆 / 历史 / 更新 / 删除
  const memoryMatch = pathname.match(/^\/v1\/memories\/([^/]+)(\/history|\/feedback)?$/)
  if (memoryMatch) {
    const memory = state.memories.get(memoryMatch[1])
    if (!memory) return notFound(res)
    if (memoryMatch[2] === '/history') {
      return sendJson(res, 200, {
        results: [{ id: 'hist_1', memory_id: memory.id, event: 'ADD', old_memory: null, new_memory: memory.memory, actor: 'tester', created_at: memory.created_at }],
      })
    }
    if (method === 'GET') {
      return sendJson(res, 200, {
        ...memory,
        history: [{ id: 'hist_1', event: 'ADD', new_memory: memory.memory, created_at: memory.created_at }],
        entities: [{ id: 'ent_1', name: '订单', type: 'concept', mention_count: 2 }],
        relations: [],
        neighbors: [],
      })
    }
    if (method === 'PUT') {
      if (body.text) memory.memory = body.text
      if (body.category) memory.category = body.category
      if (body.importance !== undefined) memory.importance = body.importance
      memory.updated_at = nowIso()
      return sendJson(res, 200, { message: 'updated' })
    }
    if (method === 'DELETE') {
      memory.status = 'deleted'
      memory.updated_at = nowIso()
      return sendJson(res, 200, { message: 'deleted' })
    }
  }

  // 任务简报
  if (method === 'POST' && pathname === '/v1/context') {
    return sendJson(res, 200, {
      project: { id: 'prj_unit', name: '单元测试项目', description: 'mock 项目' },
      agent: { id: body.agent_id ?? 'dsh-agent', name: '开发 Agent', role: 'developer' },
      task: body.task_id ? { id: body.task_id, title: '联调任务', status: 'active' } : null,
      sections: [{ key: 'project', title: '项目背景', description: '', hits: [] }],
      prompt: '# 任务简报：单元测试项目\n\n- 这是一条会被注入的约定\n- 记住先读规范',
      token_estimate: 42,
      citations: ['mem_1', 'mem_2'],
      built_at: nowIso(),
      took_ms: 9,
    })
  }

  // 任务
  if (method === 'POST' && pathname === '/v1/tasks') {
    const id = `task_${++state.seq}`
    const task = {
      id,
      project_id: 'prj_unit',
      title: body.title,
      goal: body.goal ?? null,
      status: body.status ?? 'active',
      owner_agent_id: body.owner_agent_id ?? null,
      owner_agent_name: '开发 Agent',
      branch: body.branch ?? null,
      summary: null,
      metadata: {},
      created_at: nowIso(),
      started_at: nowIso(),
      ended_at: null,
      memory_count: 0,
      agent_count: 1,
    }
    state.tasks.set(id, task)
    return sendJson(res, 200, task)
  }
  if (method === 'GET' && pathname === '/v1/tasks') {
    const rows = [...state.tasks.values()]
    return sendJson(res, 200, { results: rows, count: rows.length })
  }
  const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)(\/finish)?$/)
  if (taskMatch) {
    const task = state.tasks.get(taskMatch[1])
    if (!task) return notFound(res)
    if (taskMatch[2] === '/finish' && method === 'POST') {
      task.status = body.status ?? 'done'
      task.summary = body.summary ?? task.summary
      task.ended_at = nowIso()
      const created = []
      for (const [field, category] of [
        ['decisions', 'fact'],
        ['lessons', 'constraint'],
        ['notes', 'event'],
      ]) {
        for (const content of body[field] ?? []) {
          const memory = insertMemory(state, {
            text: content,
            task_id: task.id,
            agent_id: body.agent_id,
            visibility: 'project',
          })
          memory.category = category
          created.push(memory)
        }
      }
      return sendJson(res, 200, { task, memories: created })
    }
    if (method === 'GET') return sendJson(res, 200, task)
  }

  // Agent 注册表
  if (method === 'GET' && pathname === '/v1/agents') {
    return sendJson(res, 200, { results: state.agents, count: state.agents.length })
  }
  if (method === 'POST' && pathname === '/v1/agents') {
    const agent = {
      id: `agent_${++state.seq}`,
      project_id: 'prj_unit',
      name: body.name,
      role: body.role ?? null,
      model: body.model ?? null,
      capabilities: body.capabilities ?? [],
      status: 'active',
      stats: { memories: 0, private_memories: 0, tasks: 0, last_task_at: null },
    }
    state.agents.push(agent)
    return sendJson(res, 200, agent)
  }

  return notFound(res)
}

function startMockServer(state) {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    if (raw !== '') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      await handleRequest(state, { req, res, body, url })
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'mock_error', message: String(error) } })
      else res.end()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

async function closeServer(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

/* ------------------------------------------------------------------ */
/* 测试环境                                                            */
/* ------------------------------------------------------------------ */

const state = createState()
let mockServer
let mockUrl = ''
let live = false

/** 用指定配置构造全套工具。 */
function build(overrides = {}) {
  const config = {
    baseUrl: mockUrl,
    apiKey: 'mnemos_live_unit_test',
    defaultAgentId: 'dsh-agent',
    defaultUserId: 'unit-user',
    defaultTaskId: '',
    defaultTopK: 8,
    readOnly: false,
    announceToAgent: true,
    enabled: true,
    timeoutMs: 3000,
    ...overrides,
  }
  const client = new MnemosClient(() => config)
  const tools = Object.fromEntries(createMnemosTools(client, () => config).map((tool) => [tool.name, tool]))
  return { config, tools }
}

/** 取出最近一次某路径的请求。 */
function lastRequest(method, path) {
  for (let index = state.requests.length - 1; index >= 0; index -= 1) {
    const request = state.requests[index]
    if (request.method === method && request.path === path) return request
  }
  return undefined
}

/** 渲染工具输出为纯文本。 */
function renderText(tool, args, result) {
  return tool.output.render(args, result)
    .map((block) => block.text)
    .join('')
}

before(async () => {
  const started = await startMockServer(state)
  mockServer = started.server
  mockUrl = started.url
  try {
    const response = await fetch(`${LIVE_URL}/v1/health`, { signal: AbortSignal.timeout(1500) })
    live = response.ok
  } catch {
    live = false
  }
})

after(async () => {
  if (mockServer) await closeServer(mockServer)
})

beforeEach(() => {
  state.memories.clear()
  state.tasks.clear()
  state.agents = [{ id: 'agent_seed', name: '种子 Agent', role: 'coder', model: 'deepseek-chat', capabilities: [] }]
  state.requests.length = 0
  state.statsAllowed = false
  state.seq = 0
})

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

describe('工具定义', () => {
  it('注册 10 个工具，命名与约定一致', () => {
    const { tools } = build()
    assert.deepEqual(Object.keys(tools), [
      'mnemos_search',
      'mnemos_add',
      'mnemos_context',
      'mnemos_task',
      'mnemos_get',
      'mnemos_update',
      'mnemos_delete',
      'mnemos_history',
      'mnemos_agent',
      'mnemos_status',
    ])
  })

  it('每个工具都有原始 JSON Schema 参数、输出 schema 与 render', () => {
    const { tools } = build()
    for (const [name, tool] of Object.entries(tools)) {
      assert.equal(tool.name, name)
      assert.equal(typeof tool.description, 'string')
      assert.equal(tool.parameters.type, 'object', `${name} 的 parameters 必须是 JSON Schema`)
      assert.equal(tool.output.schema.type, 'object', `${name} 的 output.schema 必须是 JSON Schema`)
      assert.equal(typeof tool.output.render, 'function', `${name} 缺少 render`)
      assert.equal(typeof tool.execute, 'function', `${name} 缺少 execute`)
      // 输出 schema 必定包含 ok，且声明了 error（"ok/error 必有"），并容忍新增字段。
      assert.ok(tool.output.schema.properties.ok, `${name} 的输出 schema 缺少 ok`)
      assert.ok(tool.output.schema.properties.error, `${name} 的输出 schema 缺少 error`)
      assert.equal(tool.output.schema.additionalProperties, true, `${name} 的输出 schema 必须容忍新增字段`)
      assert.deepEqual(tool.output.schema.required.includes('ok'), true, `${name} 的 ok 必须是必填`)
    }
  })
})

/* ------------------------------------------------------------------ */
/* 检索 / 写入 / 简报                                                  */
/* ------------------------------------------------------------------ */

describe('mnemos_search', () => {
  it('默认用 defaultTopK 检索，render 输出分数/分类/可见性/归属/content', async () => {
    const { tools } = build()
    // 先放一条记忆进去
    await tools.mnemos_add.execute({ text: '订单查询走 read replica' })

    const result = await tools.mnemos_search.execute({ query: '订单查询' })
    assert.equal(result.ok, true)
    assert.equal(result.count, 1)
    assert.equal(result.tookMs, 4.2)

    const request = lastRequest('POST', '/v1/memories/search')
    assert.equal(request.body.query, '订单查询')
    assert.equal(request.body.top_k, 8)
    assert.equal(request.body.agent_id, undefined, '检索不回落默认 agent_id')

    const text = renderText(tools.mnemos_search, { query: '订单查询' }, result)
    assert.match(text, /Mnemos 搜索「订单查询」→ 1 条/)
    assert.match(text, /\[0\.910\]/)
    assert.match(text, /fact · project · agent=/)
    assert.match(text, /订单查询走 read replica/)
    assert.match(text, /id：mem_1/)
  })

  it('失败时返回 ok:false 而不是抛异常', async () => {
    const { tools } = build({ baseUrl: 'http://127.0.0.1:9' })
    const result = await tools.mnemos_search.execute({ query: 'x' })
    assert.equal(result.ok, false)
    assert.equal(result.count, 0)
    assert.match(result.error, /连接失败|network_error/)
  })
})

describe('mnemos_add', () => {
  it('字符串 messages 按 user 角色写入，默认带上 defaultAgentId / defaultUserId', async () => {
    const { tools } = build()
    const result = await tools.mnemos_add.execute({ messages: '记住：发布前必须跑全量测试' })
    assert.equal(result.ok, true)
    assert.equal(result.results.length, 1)

    const request = lastRequest('POST', '/v1/memories')
    assert.deepEqual(request.body.messages, [{ role: 'user', content: '记住：发布前必须跑全量测试' }])
    assert.equal(request.body.agent_id, 'dsh-agent')
    assert.equal(request.body.user_id, 'unit-user')

    const text = renderText(tools.mnemos_add, {}, result)
    assert.match(text, /新增 1 条/)
    assert.match(text, /发布前必须跑全量测试/)
  })

  it('text 与 messages 都没给时给出可操作的错误', async () => {
    const { tools } = build()
    const result = await tools.mnemos_add.execute({})
    assert.equal(result.ok, false)
    assert.match(result.error, /messages 或 text/)
  })

  it('readOnly 拦截写入，且不发请求', async () => {
    const { tools } = build({ readOnly: true })
    const result = await tools.mnemos_add.execute({ text: 'x' })
    assert.equal(result.ok, false)
    assert.match(result.error, /readOnly 模式已开启/)
    assert.equal(state.requests.length, 0)
  })
})

describe('mnemos_context', () => {
  it('返回 prompt 且 render 输出完整简报正文', async () => {
    const { tools } = build()
    const result = await tools.mnemos_context.execute({ task_id: 'task_x', budget_tokens: 600 })
    assert.equal(result.ok, true)
    assert.equal(result.token_estimate, 42)
    assert.deepEqual(result.citations, ['mem_1', 'mem_2'])

    const request = lastRequest('POST', '/v1/context')
    assert.equal(request.body.task_id, 'task_x')
    assert.equal(request.body.budget_tokens, 600)
    assert.equal(request.body.agent_id, 'dsh-agent', '简报回落默认 agent_id')

    const text = renderText(tools.mnemos_context, {}, result)
    // 核心能力：完整 prompt 必须出现在输出里
    assert.match(text, /# 任务简报：单元测试项目/)
    assert.match(text, /这是一条会被注入的约定/)
    assert.match(text, /约 42 tokens/)
    assert.match(text, /2 条引用/)
  })

  it('prompt 为空时给出排查提示', async () => {
    const { tools } = build({ baseUrl: 'http://127.0.0.1:9' })
    const result = await tools.mnemos_context.execute({})
    assert.equal(result.ok, false)
    assert.match(renderText(tools.mnemos_context, {}, result), /失败/)
  })
})

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

describe('mnemos_task', () => {
  it('start 创建任务，finish 结束并回报写入记忆数', async () => {
    const { tools } = build()
    const start = await tools.mnemos_task.execute({
      action: 'start',
      title: '拆分订单查询服务',
      goal: 'P99 < 300ms',
      branch: 'feat/query-service',
    })
    assert.equal(start.ok, true)
    assert.equal(start.task.title, '拆分订单查询服务')
    assert.equal(start.task.owner_agent_id, 'dsh-agent')
    assert.match(renderText(tools.mnemos_task, {}, start), /任务已开始/)

    const finish = await tools.mnemos_task.execute({
      action: 'finish',
      task_id: start.task.id,
      status: 'done',
      summary: '首期完成',
      decisions: ['查询走 read replica'],
      lessons: ['先补双写对账'],
      notes: ['灰度两批'],
      agent_id: 'agent-coder',
    })
    assert.equal(finish.ok, true)
    assert.equal(finish.task.status, 'done')
    assert.equal(finish.memories.length, 3)

    const request = lastRequest('POST', `/v1/tasks/${start.task.id}/finish`)
    assert.deepEqual(request.body, {
      status: 'done',
      summary: '首期完成',
      decisions: ['查询走 read replica'],
      lessons: ['先补双写对账'],
      notes: ['灰度两批'],
      agent_id: 'agent-coder',
    })

    const text = renderText(tools.mnemos_task, {}, finish)
    assert.match(text, /任务已结束/)
    assert.match(text, /已沉淀 3 条项目共享记忆/)
    assert.match(text, /查询走 read replica/)
  })

  it('finish 的 status 只能是 done / abandoned', async () => {
    const { tools } = build()
    const start = await tools.mnemos_task.execute({ action: 'start', title: 't' })
    const result = await tools.mnemos_task.execute({ action: 'finish', task_id: start.task.id, status: 'active' })
    assert.equal(result.ok, false)
    assert.match(result.error, /done 或 abandoned/)
  })

  it('list / get 正常工作', async () => {
    const { tools } = build()
    const start = await tools.mnemos_task.execute({ action: 'start', title: '任务 A' })
    const list = await tools.mnemos_task.execute({ action: 'list' })
    assert.equal(list.ok, true)
    assert.equal(list.count, 1)
    assert.match(renderText(tools.mnemos_task, {}, list), /任务 A/)

    const detail = await tools.mnemos_task.execute({ action: 'get', task_id: start.task.id })
    assert.equal(detail.ok, true)
    assert.match(renderText(tools.mnemos_task, {}, detail), /状态：active/)
  })

  it('readOnly 拦截 start / finish', async () => {
    const { tools } = build({ readOnly: true })
    const start = await tools.mnemos_task.execute({ action: 'start', title: 't' })
    assert.equal(start.ok, false)
    assert.match(start.error, /readOnly 模式已开启/)
    const finish = await tools.mnemos_task.execute({ action: 'finish', task_id: 'task_1', status: 'done' })
    assert.equal(finish.ok, false)
    assert.match(finish.error, /readOnly 模式已开启/)
    assert.equal(state.requests.length, 0)
  })
})

/* ------------------------------------------------------------------ */
/* 记忆管理                                                            */
/* ------------------------------------------------------------------ */

describe('mnemos_get', () => {
  it('按 id 返回详情，列表按 status / sort 本地处理', async () => {
    const { tools } = build()
    await tools.mnemos_add.execute({ text: '记忆一' })
    await tools.mnemos_add.execute({ text: '记忆二' })

    const detail = await tools.mnemos_get.execute({ id: 'mem_1' })
    assert.equal(detail.ok, true)
    const detailText = renderText(tools.mnemos_get, {}, detail)
    assert.match(detailText, /记忆一/)
    assert.match(detailText, /分类：fact/)
    assert.match(detailText, /实体：订单/)

    const list = await tools.mnemos_get.execute({ status: 'active', page_size: 1 })
    assert.equal(list.ok, true)
    assert.equal(list.count, 1)
    assert.equal(list.total, 2)
    assert.match(renderText(tools.mnemos_get, {}, list), /第 1 页/)

    const archived = await tools.mnemos_get.execute({ status: 'archived' })
    assert.equal(archived.count, 0)
  })
})

describe('mnemos_update', () => {
  it('只支持 content / category / importance；混传时把 ignored 标出来', async () => {
    const { tools } = build()
    await tools.mnemos_add.execute({ text: '旧内容' })

    const mixed = await tools.mnemos_update.execute({
      id: 'mem_1',
      content: '新内容',
      category: 'constraint',
      status: 'archived',
    })
    assert.equal(mixed.ok, true)
    assert.deepEqual(mixed.applied, ['content', 'category'])
    assert.deepEqual(mixed.ignored, ['status'])
    const request = lastRequest('PUT', '/v1/memories/mem_1')
    assert.deepEqual(request.body, { text: '新内容', category: 'constraint' })
    assert.match(renderText(tools.mnemos_update, { id: 'mem_1' }, mixed), /status 当前 \/v1 更新接口不支持/)

    const onlyStatus = await tools.mnemos_update.execute({ id: 'mem_1', status: 'archived' })
    assert.equal(onlyStatus.ok, false)
    assert.match(onlyStatus.error, /只支持 content \/ category \/ importance/)

    const nothing = await tools.mnemos_update.execute({ id: 'mem_1' })
    assert.equal(nothing.ok, false)
    assert.match(nothing.error, /至少提供/)
  })

  it('readOnly 拦截更新', async () => {
    const { tools } = build({ readOnly: true })
    const result = await tools.mnemos_update.execute({ id: 'mem_1', content: 'x' })
    assert.equal(result.ok, false)
    assert.match(result.error, /readOnly 模式已开启/)
    assert.equal(state.requests.length, 0)
  })
})

describe('mnemos_delete', () => {
  it('没有 confirm: true 时不删除，也不发请求', async () => {
    const { tools } = build()
    await tools.mnemos_add.execute({ text: '别删我' })
    state.requests.length = 0

    const blocked = await tools.mnemos_delete.execute({ id: 'mem_1' })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /显式确认/)
    assert.equal(state.requests.length, 0)

    const removed = await tools.mnemos_delete.execute({ id: 'mem_1', confirm: true })
    assert.equal(removed.ok, true)
    assert.equal(lastRequest('DELETE', '/v1/memories/mem_1') !== undefined, true)
    assert.match(renderText(tools.mnemos_delete, { id: 'mem_1' }, removed), /已删除 memory mem_1/)
  })

  it('readOnly 拦截删除（即使 confirm=true）', async () => {
    const { tools } = build({ readOnly: true })
    const result = await tools.mnemos_delete.execute({ id: 'mem_1', confirm: true })
    assert.equal(result.ok, false)
    assert.match(result.error, /readOnly 模式已开启/)
    assert.equal(state.requests.length, 0)
  })
})

describe('mnemos_history', () => {
  it('解包 results 并渲染变更历史', async () => {
    const { tools } = build()
    await tools.mnemos_add.execute({ text: '一条记忆' })
    const result = await tools.mnemos_history.execute({ id: 'mem_1' })
    assert.equal(result.ok, true)
    assert.equal(result.history.length, 1)
    const text = renderText(tools.mnemos_history, {}, result)
    assert.match(text, /\[ADD\]/)
    assert.match(text, /一条记忆/)
  })
})

describe('mnemos_agent', () => {
  it('list 与 register 都工作，readOnly 拦截 register', async () => {
    const { tools } = build()
    const list = await tools.mnemos_agent.execute({ action: 'list' })
    assert.equal(list.ok, true)
    assert.equal(list.count, 1)

    const registered = await tools.mnemos_agent.execute({
      action: 'register',
      name: '联调 Agent',
      role: 'tester',
      model: 'deepseek-flash',
      capabilities: ['test'],
    })
    assert.equal(registered.ok, true)
    assert.equal(registered.agent.name, '联调 Agent')
    assert.match(renderText(tools.mnemos_agent, {}, registered), /已注册 Agent/)

    const readOnlyTools = build({ readOnly: true }).tools
    const blocked = await readOnlyTools.mnemos_agent.execute({ action: 'register', name: 'x' })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /readOnly 模式已开启/)
  })
})

describe('mnemos_status', () => {
  it('健康检查可达；stats 403 时降级为只报 health', async () => {
    const { tools } = build()
    const result = await tools.mnemos_status.execute({})
    assert.equal(result.ok, true)
    assert.equal(result.reachable, true)
    assert.equal(result.version, '1.1.0-mock')
    assert.equal(result.apiKeyConfigured, true)
    assert.equal(result.stats, undefined)
    assert.match(result.statsError, /admin/)

    const text = renderText(tools.mnemos_status, {}, result)
    assert.match(text, /Mnemos 服务可达/)
    assert.match(text, /apiKey 已配置/)
    assert.match(text, /统计不可用/)
    // 绝不泄露密钥字面量
    assert.equal(text.includes('mnemos_live_unit_test'), false)
  })

  it('stats 可用时输出项目统计', async () => {
    state.statsAllowed = true
    const { tools } = build()
    const result = await tools.mnemos_status.execute({})
    assert.equal(result.stats.total_memories, 12)
    const text = renderText(tools.mnemos_status, {}, result)
    assert.match(text, /记忆 12/)
    assert.match(text, /命中率 90\.0%/)
  })

  it('服务不可达时返回 ok:false 与可操作的错误', async () => {
    const { tools } = build({ baseUrl: 'http://127.0.0.1:9' })
    const result = await tools.mnemos_status.execute({})
    assert.equal(result.ok, false)
    assert.equal(result.reachable, false)
    assert.match(renderText(tools.mnemos_status, {}, result), /Mnemos 服务不可达/)
  })
})

/* ------------------------------------------------------------------ */
/* 真实服务（只读；默认跳过写入，避免污染演示数据）                      */
/* ------------------------------------------------------------------ */

describe('真实 Mnemos 服务（只读冒烟）', () => {
  it('search / context / status 可用', async (t) => {
    if (!live) {
      t.skip(`未发现运行中的 Mnemos（${LIVE_URL}），跳过真机冒烟`)
      return
    }
    // 演示项目的 Agent id 不叫 dsh-agent，所以这里把默认 agent 置空：
    // 简报的 agent_id 指向未注册的 Agent 时服务端会返回 404 Agent 不存在。
    const { tools } = build({ baseUrl: LIVE_URL, apiKey: LIVE_KEY, defaultAgentId: '', defaultUserId: '' })

    const search = await tools.mnemos_search.execute({ query: '订单查询拆分', top_k: 3 })
    assert.equal(search.ok, true)
    assert.ok(search.count >= 1, '演示项目里应当能检索到记忆')
    assert.match(renderText(tools.mnemos_search, { query: '订单查询拆分' }, search), /Mnemos 搜索「订单查询拆分」/)

    const briefing = await tools.mnemos_context.execute({})
    assert.equal(briefing.ok, true)
    assert.equal(typeof briefing.prompt, 'string')
    assert.ok(briefing.prompt.length > 0, '演示项目应当能生成任务简报')
    assert.match(briefing.prompt, /项目简报/)

    const status = await tools.mnemos_status.execute({})
    assert.equal(status.ok, true)
    assert.equal(status.reachable, true)
    assert.equal(status.apiKeyConfigured, true)
  })

  it('写入 → 删除（仅 MNEMOS_TEST_WRITE=1 时执行，自清理）', async (t) => {
    if (!live) {
      t.skip(`未发现运行中的 Mnemos（${LIVE_URL}），跳过真机写入`)
      return
    }
    if (!LIVE_WRITE) {
      t.skip('真机写入测试默认关闭（避免污染演示数据）；设置 MNEMOS_TEST_WRITE=1 启用')
      return
    }
    const { tools } = build({
      baseUrl: LIVE_URL,
      apiKey: LIVE_KEY,
      defaultUserId: 'dsh-mnemos-selftest',
      defaultAgentId: 'dsh-agent',
    })
    const marker = `dsh-mnemos 自动化测试 DELETEME ${Date.now()}`
    const added = await tools.mnemos_add.execute({ text: marker, infer: false })
    assert.equal(added.ok, true)
    assert.equal(added.results.length, 1)
    const id = added.results[0].id
    assert.ok(id, '写入应当返回记忆 id')
    try {
      const removed = await tools.mnemos_delete.execute({ id, confirm: true })
      assert.equal(removed.ok, true)
    } finally {
      // 兜底清理：即使断言失败也尽量删掉测试记忆
      await tools.mnemos_delete.execute({ id, confirm: true }).catch(() => undefined)
    }
  })
})
