/**
 * MnemosClient 单元测试（node:test + 本地 node:http mock，零额外依赖）。
 *
 * 覆盖：Bearer 鉴权、v5 分区路径、snake_case 请求体、错误归一（401 / 403 / 404 / 超时 / 网络）、
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

  it('写记忆的请求体使用 snake_case，且只带显式字段', async () => {
    let received = null
    const { server, url } = await startMock(({ res, body }) => {
      received = body
      sendMemory(res)
    })
    try {
      await makeClient(url).addMemory('ws-demo-1234abcd', {
        text: '拆分订单查询',
        person_id: 'prs_1',
        scope: 'person',
        session_id: 'sess_1',
        category: 'fact',
        tags: ['orders'],
        infer: false,
      })
      assert.deepEqual(received, {
        text: '拆分订单查询',
        person_id: 'prs_1',
        scope: 'person',
        session_id: 'sess_1',
        category: 'fact',
        tags: ['orders'],
        infer: false,
      })
    } finally {
      await closeServer(server)
    }
  })

  it('search 请求体是 query + person_id/scope/category/top_k', async () => {
    let received = null
    const { server, url } = await startMock(({ res, body }) => {
      received = body
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [], took_ms: 1 }))
    })
    try {
      await makeClient(url).searchMemories('ws-demo-1234abcd', {
        query: '订单查询',
        person_id: 'dsh-agent',
        scope: 'person',
        category: 'fact',
        top_k: 5,
      })
      assert.deepEqual(received, {
        query: '订单查询',
        person_id: 'dsh-agent',
        scope: 'person',
        category: 'fact',
        top_k: 5,
      })
    } finally {
      await closeServer(server)
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

  it('未配置 orgApiKey 时本地短路，不发请求', async () => {
    const { server, url, requests } = await startMock(({ res }) => sendMemory(res))
    try {
      await assert.rejects(makeClient(url, { orgApiKey: '' }).getPartition('x'), (error) => {
        assert.equal(error.code, 'missing_api_key')
        assert.match(error.action, /orgApiKey/)
        return true
      })
      assert.equal(requests.length, 0)
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

describe('MnemosClient 分区 / 人 ensure', () => {
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
