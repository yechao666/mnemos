/**
 * MnemosClient 单元测试（node:test + 本地 node:http mock，零额外依赖）。
 *
 * 覆盖：Bearer 鉴权头、方法与路径、search 请求体形状、错误体映射（403 / 429 / 500）、
 * 超时、读路径重试（首 503 后成功）、写路径不重试、未配置 apiKey 的本地短路。
 *
 * 运行：pnpm test（会先 build，再从 lib/ 导入）。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'

import { MnemosApiError, MnemosClient, MnemosTimeoutError } from '../lib/mnemos-client.js'

/**
 * 起一个本地 mock 服务。
 * @param {(ctx: {req: http.IncomingMessage, res: http.ServerResponse, body: any, url: URL}) => void | Promise<void>} handler
 */
function startMock(handler) {
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
      await handler({ req, res, body, url })
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'mock_error', message: String(error) } })
      else res.end()
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** 关闭 mock 服务：先断开 keep-alive 连接，否则 server.close 会一直等。 */
async function closeServer(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

/** 构造客户端；overrides 可覆盖 baseUrl / apiKey / timeoutMs。 */
function makeClient(baseUrl, overrides = {}) {
  const config = { baseUrl, apiKey: 'mnemos_live_unit_test', timeoutMs: 2000, ...overrides }
  return new MnemosClient(() => config)
}

describe('MnemosClient', () => {
  it('发送 Bearer 鉴权头，并按 /v1 路径请求', async () => {
    const seen = {}
    const { server, url } = await startMock(({ req, res }) => {
      seen.method = req.method
      seen.path = new URL(req.url, 'http://x').pathname
      seen.authorization = req.headers.authorization
      sendJson(res, 200, { id: 'mem_1', memory: '一条记忆' })
    })
    try {
      const memory = await makeClient(url).getMemory('mem_1')
      assert.equal(memory.memory, '一条记忆')
      assert.equal(seen.method, 'GET')
      assert.equal(seen.path, '/v1/memories/mem_1')
      assert.equal(seen.authorization, 'Bearer mnemos_live_unit_test')
    } finally {
      await closeServer(server)
    }
  })

  it('search 的请求体使用 snake_case，并把 category 放进 filters', async () => {
    let received = null
    const { server, url } = await startMock(({ res, body }) => {
      received = body
      sendJson(res, 200, { results: [{ id: 'mem_1', memory: 'x', score: 0.9 }], took_ms: 2, signals: {} })
    })
    try {
      const response = await makeClient(url).search({
        query: '订单查询拆分',
        user_id: 'u1',
        agent_id: 'a1',
        task_id: 't1',
        visibility: 'project',
        top_k: 5,
        threshold: 0.2,
        category: 'fact',
      })
      assert.equal(response.results.length, 1)
      assert.deepEqual(received, {
        query: '订单查询拆分',
        user_id: 'u1',
        agent_id: 'a1',
        task_id: 't1',
        visibility: 'project',
        top_k: 5,
        threshold: 0.2,
        filters: { category: 'fact' },
      })
    } finally {
      await closeServer(server)
    }
  })

  it('add 的请求体只带显式传入的字段，并保留 messages 形状', async () => {
    let received = null
    const { server, url } = await startMock(({ res, body }) => {
      received = body
      sendJson(res, 200, {
        results: [{ id: 'mem_1', content: '记住了', projectId: 'prj_1' }],
        events: [{ type: 'ADD', memoryId: 'mem_1', content: '记住了', at: '2026-01-01T00:00:00.000Z' }],
        tookMs: 1,
      })
    })
    try {
      const response = await makeClient(url).add({
        messages: [{ role: 'user', content: '记住了' }],
        agent_id: 'a1',
        infer: false,
      })
      assert.equal(response.results.length, 1)
      assert.deepEqual(received, {
        messages: [{ role: 'user', content: '记住了' }],
        agent_id: 'a1',
        infer: false,
      })
    } finally {
      await closeServer(server)
    }
  })

  it('把服务端错误体映射为 MnemosApiError（403 / 429 / 500）', async () => {
    const cases = [
      { status: 403, code: 'forbidden', message: '当前密钥缺少 memories:write 作用域', requestId: 'req_403' },
      { status: 429, code: 'rate_limited', message: '超出密钥限流', requestId: 'req_429' },
      { status: 500, code: 'internal_error', message: '未预期的服务端异常', requestId: 'req_500' },
    ]
    for (const item of cases) {
      const { server, url } = await startMock(({ res }) => {
        sendJson(res, item.status, {
          error: { code: item.code, message: item.message, requestId: item.requestId },
        })
      })
      try {
        await assert.rejects(
          () => makeClient(url).listMemories({ page_size: 1 }),
          (error) => {
            assert.ok(error instanceof MnemosApiError)
            assert.equal(error.status, item.status)
            assert.equal(error.code, item.code)
            assert.equal(error.requestId, item.requestId)
            // 错误信息必须可操作：包含状态码、服务端原因与下一步提示。
            assert.match(error.message, new RegExp(String(item.status)))
            assert.match(error.message, new RegExp(item.code))
            assert.match(error.message, new RegExp(item.message))
            return true
          },
        )
      } finally {
        await closeServer(server)
      }
    }
  })

  it('超时抛出 MnemosTimeoutError（code=timeout）', async () => {
    const { server, url } = await startMock(({ res }) => {
      // 故意比 timeoutMs 慢很多
      setTimeout(() => sendJson(res, 200, { ok: true }), 400)
    })
    try {
      const client = makeClient(url, { timeoutMs: 60 })
      const startedAt = Date.now()
      await assert.rejects(
        () => client.health(),
        (error) => {
          assert.ok(error instanceof MnemosTimeoutError)
          assert.ok(error instanceof MnemosApiError)
          assert.equal(error.code, 'timeout')
          assert.equal(error.timeoutMs, 60)
          return true
        },
      )
      assert.ok(Date.now() - startedAt >= 50, '超时应当在 timeoutMs 之后才失败')
    } finally {
      await closeServer(server)
    }
  })

  it('读路径在首个 503 后重试一次并成功', async () => {
    let calls = 0
    const { server, url } = await startMock(({ res }) => {
      calls += 1
      if (calls === 1) sendJson(res, 503, { error: { code: 'unavailable', message: '数据库维护中' } })
      else sendJson(res, 200, { ok: true, version: '1.1.0' })
    })
    try {
      const startedAt = Date.now()
      const health = await makeClient(url).health()
      assert.equal(health.ok, true)
      assert.equal(calls, 2, '应当只重试一次')
      assert.ok(Date.now() - startedAt >= 180, '重试前应有约 200ms 退避')
    } finally {
      await closeServer(server)
    }
  })

  it('search / context 这类只读 POST 也会重试', async () => {
    let calls = 0
    const { server, url } = await startMock(({ res }) => {
      calls += 1
      if (calls === 1) sendJson(res, 504, { error: { code: 'gateway_timeout', message: '上游超时' } })
      else sendJson(res, 200, { results: [], took_ms: 1, prompt: '# 简报', token_estimate: 10 })
    })
    try {
      const client = makeClient(url)
      const search = await client.search({ query: 'x' })
      assert.deepEqual(search.results, [])
      assert.equal(calls, 2)
    } finally {
      await closeServer(server)
    }
  })

  it('写操作不重试（避免重复写入）', async () => {
    let calls = 0
    const { server, url } = await startMock(({ res }) => {
      calls += 1
      sendJson(res, 503, { error: { code: 'unavailable', message: '维护中' } })
    })
    try {
      await assert.rejects(
        () => makeClient(url).add({ text: 'x' }),
        (error) => error instanceof MnemosApiError && error.status === 503,
      )
      assert.equal(calls, 1, '写操作失败后不应重试')
    } finally {
      await closeServer(server)
    }
  })

  it('未配置 apiKey 时本地短路，不发网络请求', async () => {
    let calls = 0
    const { server, url } = await startMock(({ req, res }) => {
      calls += 1
      const path = new URL(req.url, 'http://x').pathname
      if (path === '/v1/health') sendJson(res, 200, { ok: true, version: '1.1.0' })
      else sendJson(res, 200, { results: [] })
    })
    try {
      await assert.rejects(
        () => makeClient(url, { apiKey: '' }).search({ query: 'x' }),
        (error) => error instanceof MnemosApiError && error.code === 'missing_api_key',
      )
      assert.equal(calls, 0)
      // 但健康检查不需要 Key，仍然可达
      const health = await makeClient(url, { apiKey: '' }).health()
      assert.equal(health.ok, true)
      assert.equal(calls, 1)
    } finally {
      await closeServer(server)
    }
  })

  it('history 解包 results，context 使用 snake_case 入参，delete 走 DELETE', async () => {
    const requests = []
    const { server, url } = await startMock(({ req, res, body }) => {
      const path = new URL(req.url, 'http://x').pathname
      requests.push({ method: req.method, path, body })
      if (path.endsWith('/history')) {
        sendJson(res, 200, { results: [{ id: 'h1', event: 'ADD', new_memory: 'x' }] })
      } else if (path === '/v1/context') {
        sendJson(res, 200, { prompt: '# 简报', token_estimate: 12, citations: ['mem_1'], sections: [] })
      } else {
        sendJson(res, 200, { message: 'deleted' })
      }
    })
    try {
      const client = makeClient(url)
      const history = await client.history('mem_1')
      assert.equal(history.length, 1)
      assert.equal(history[0].event, 'ADD')

      const briefing = await client.context({ agent_id: 'a1', task_id: 't1', budget_tokens: 800 })
      assert.equal(briefing.prompt, '# 简报')

      const removed = await client.deleteMemory('mem_1')
      assert.equal(removed.message, 'deleted')

      assert.deepEqual(requests[1].body, { agent_id: 'a1', task_id: 't1', budget_tokens: 800 })
      assert.equal(requests[2].method, 'DELETE')
      assert.equal(requests[2].path, '/v1/memories/mem_1')
    } finally {
      await closeServer(server)
    }
  })
})
