/**
 * MCP server 测试：本地 fake HTTP（node:http）+ 直接调用 handler。
 *
 * 运行：cd integrations/mcp-mnemos && node --test test/
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { MnemosHttpClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { MnemosMcpServer } from '../src/server.js';

/* ------------------------------------------------------------------ */
/* fake Mnemos HTTP                                                    */
/* ------------------------------------------------------------------ */

async function startFake() {
  const routes = new Map();
  const requests = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: raw ? JSON.parse(raw) : null,
    };
    requests.push(record);

    const list = routes.get(`${req.method} ${url.pathname}`);
    if (!list || list.length === 0) {
      respond(res, 404, { error: { code: 'NOT_FOUND', message: 'fake 路由缺失' } });
      return;
    }
    const response = list.length > 1 ? list.shift() : list[0];
    respond(res, response.status ?? 200, response.body, response.headers ?? {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    route(method, path, ...responses) {
      routes.set(`${method} ${path}`, responses);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function respond(res, status, body, headers = {}) {
  const raw = body === undefined || body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
    connection: 'close',
    ...headers,
  });
  res.end(raw);
}

function makeServer(fake, overrides = {}) {
  const config = {
    baseUrl: fake.baseUrl,
    apiKey: 'mnemos_live_test',
    partition: 'ws-demo',
    person: 'dsh-agent',
    timeoutMs: 2_000,
    ...overrides,
  };
  const client = new MnemosHttpClient(config);
  const logs = [];
  const logger = { error: (...args) => logs.push(args.join(' ')) };
  return { config, client, logs, server: new MnemosMcpServer({ client, config, logger }) };
}

async function request(server, method, params, id = 1) {
  return server.handle({ jsonrpc: '2.0', id, method, params });
}

async function callTool(server, name, args = {}) {
  const response = await request(server, 'tools/call', { name, arguments: args });
  assert.ok(response.result, `tools/call 失败：${JSON.stringify(response.error)}`);
  return response.result;
}

function jsonOf(result) {
  assert.equal(result.isError, undefined, `工具不应失败：${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

/* ------------------------------------------------------------------ */
/* 协议                                                                */
/* ------------------------------------------------------------------ */

test('initialize：返回协议版本、capabilities 与 serverInfo', async () => {
  const fake = await startFake();
  const { server } = makeServer(fake);
  try {
    const response = await request(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, '2025-03-26');
    assert.deepEqual(response.result.capabilities.tools, { listChanged: false });
    assert.equal(response.result.serverInfo.name, 'mnemos-mcp');
    assert.match(response.result.instructions, /mnemos_context/);

    const unknownVersion = await request(server, 'initialize', { protocolVersion: '1999-01-01' });
    assert.equal(unknownVersion.result.protocolVersion, '2024-11-05');
  } finally {
    await fake.close();
  }
});

test('通知不返回响应；ping 返回空对象', async () => {
  const fake = await startFake();
  const { server } = makeServer(fake);
  try {
    const notification = await server.handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    assert.equal(notification, null);
    assert.deepEqual((await request(server, 'ping', {}, 7)).result, {});
  } finally {
    await fake.close();
  }
});

test('未知 method → -32601；非法 jsonrpc → -32600；handleLine 解析错误 → -32700', async () => {
  const fake = await startFake();
  const { server } = makeServer(fake);
  try {
    const unknown = await request(server, 'prompts/list', {});
    assert.equal(unknown.error.code, -32601);

    const invalid = await server.handle({ id: 3, method: 'ping' });
    assert.equal(invalid.error.code, -32600);

    assert.equal(await server.handleLine('   '), null);
    const parsed = JSON.parse(await server.handleLine('not-json'));
    assert.equal(parsed.error.code, -32700);
    assert.equal(parsed.id, null);

    const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }));
    assert.equal(JSON.parse(line).id, 9);
  } finally {
    await fake.close();
  }
});

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

test('tools/list 暴露 7 个工具，不含 handler', async () => {
  const fake = await startFake();
  const { server } = makeServer(fake);
  try {
    const response = await request(server, 'tools/list', {});
    const names = response.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'mnemos_search',
      'mnemos_add',
      'mnemos_brief',
      'mnemos_context',
      'mnemos_person',
      'mnemos_profile',
      'mnemos_status',
    ]);
    for (const tool of response.result.tools) {
      assert.ok(tool.description);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.handler, undefined);
    }
    const search = response.result.tools.find((tool) => tool.name === 'mnemos_search');
    assert.deepEqual(search.inputSchema.required, ['query']);
  } finally {
    await fake.close();
  }
});

test('mnemos_search：按默认人过滤、携带鉴权头、返回命中与信号', async () => {
  const fake = await startFake();
  fake.route('POST', '/v1/partitions/ws-demo/memories/search', {
    body: {
      hits: [{ id: 'mem_1', content: '偏好中文', score: 0.9, signals: { vector: 0.8, keyword: 0.7 } }],
      mode: 'hybrid',
      strategy: 'vector+keyword',
      took_ms: 3,
    },
  });
  const { server } = makeServer(fake);
  try {
    const result = await callTool(server, 'mnemos_search', { query: '偏好', top_k: 5 });
    const payload = jsonOf(result);
    assert.equal(payload.mode, 'hybrid');
    assert.equal(payload.hits[0].signals.keyword, 0.7);

    const sent = fake.requests[0];
    assert.equal(sent.path, '/v1/partitions/ws-demo/memories/search');
    assert.equal(sent.headers.authorization, 'Bearer mnemos_live_test');
    assert.equal(sent.body.query, '偏好');
    assert.equal(sent.body.person_external_id, 'dsh-agent');
    assert.equal(sent.body.top_k, 5);
  } finally {
    await fake.close();
  }
});

test('mnemos_search：all_people=true 时不带人过滤', async () => {
  const fake = await startFake();
  fake.route('POST', '/v1/partitions/ws-demo/memories/search', { body: { hits: [] } });
  const { server } = makeServer(fake);
  try {
    await callTool(server, 'mnemos_search', { query: '偏好', all_people: true, scope: 'partition' });
    assert.equal(fake.requests[0].body.person_external_id, undefined);
    assert.equal(fake.requests[0].body.scope, 'partition');
  } finally {
    await fake.close();
  }
});

test('mnemos_add：未知人 404 时先建档再重试，并支持幂等键', async () => {
  const fake = await startFake();
  fake.route(
    'POST',
    '/v1/partitions/ws-demo/persons/dsh-agent/memories',
    { status: 404, body: { error: { code: 'NOT_FOUND', message: '人不存在' } } },
    { status: 201, body: { memory: { id: 'mem_new', content: '新结论' }, event: 'ADD' } },
  );
  fake.route('PUT', '/v1/partitions/ws-demo/persons/dsh-agent', {
    body: { id: 'prs_1', external_id: 'dsh-agent', type: 'agent' },
  });
  const { server } = makeServer(fake);
  try {
    const result = await callTool(server, 'mnemos_add', { content: '新结论', category: 'decision', idempotency_key: 'idem-7' });
    const payload = jsonOf(result);
    assert.equal(payload.event, 'ADD');
    assert.equal(payload.memory.id, 'mem_new');

    assert.deepEqual(
      fake.requests.map((request) => `${request.method} ${request.path}`),
      [
        'POST /v1/partitions/ws-demo/persons/dsh-agent/memories',
        'PUT /v1/partitions/ws-demo/persons/dsh-agent',
        'POST /v1/partitions/ws-demo/persons/dsh-agent/memories',
      ],
    );
    assert.equal(fake.requests[0].headers['idempotency-key'], 'idem-7');
    assert.equal(fake.requests[0].body.content, '新结论');
    assert.equal(fake.requests[2].body.category, 'decision');
    assert.equal(fake.requests[1].body.type, 'agent');
  } finally {
    await fake.close();
  }
});

test('mnemos_add：缺少内容时返回 isError', async () => {
  const fake = await startFake();
  const { server } = makeServer(fake);
  try {
    const result = await callTool(server, 'mnemos_add', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /content/);
  } finally {
    await fake.close();
  }
});

test('mnemos_brief / mnemos_context 返回文本 + 元数据', async () => {
  const fake = await startFake();
  fake.route('GET', '/v1/partitions/ws-demo/persons/dsh-agent/brief', {
    body: { text: '- [决策] 使用 v6-rebuild', count: 1, cached: false, model: 'mnemos-condense' },
  });
  fake.route('POST', '/v1/partitions/ws-demo/persons/dsh-agent/context', {
    body: { prompt: '## 人物资料\n…', token_estimate: 128, citations: ['mem_1'] },
  });
  const { server } = makeServer(fake);
  try {
    const brief = await callTool(server, 'mnemos_brief', {});
    assert.equal(brief.content[0].text, '- [决策] 使用 v6-rebuild');
    assert.equal(JSON.parse(brief.content[1].text).count, 1);

    const context = await callTool(server, 'mnemos_context', { query: 'v6' });
    assert.match(context.content[0].text, /人物资料/);
    assert.equal(JSON.parse(context.content[1].text).token_estimate, 128);
    assert.equal(fake.requests[1].body.query, 'v6');
  } finally {
    await fake.close();
  }
});

test('mnemos_person：get / list / upsert / update 路径与参数', async () => {
  const fake = await startFake();
  fake.route('GET', '/v1/partitions/ws-demo/persons/dsh-agent', {
    body: { id: 'prs_1', external_id: 'dsh-agent' },
  });
  fake.route('GET', '/v1/partitions/ws-demo/persons', {
    body: { items: [{ id: 'prs_1' }], next_cursor: 'c2' },
  });
  fake.route('PUT', '/v1/partitions/ws-demo/persons/user-1', {
    body: { id: 'prs_2', external_id: 'user-1', type: 'human' },
  });
  fake.route('PATCH', '/v1/partitions/ws-demo/persons/prs_2', {
    body: { id: 'prs_2', display_name: '新名字' },
  });
  const { server } = makeServer(fake);
  try {
    const got = await callTool(server, 'mnemos_person', { action: 'get' });
    assert.equal(jsonOf(got).external_id, 'dsh-agent');

    const listed = await callTool(server, 'mnemos_person', { action: 'list', q: 'user', limit: 2 });
    assert.equal(jsonOf(listed).next_cursor, 'c2');
    assert.equal(fake.requests[1].query.q, 'user');
    assert.equal(fake.requests[1].query.limit, '2');

    const upserted = await callTool(server, 'mnemos_person', { action: 'upsert', external_id: 'user-1', type: 'human', display_name: '用户 1' });
    assert.equal(jsonOf(upserted).id, 'prs_2');
    assert.equal(fake.requests[2].body.type, 'human');

    const updated = await callTool(server, 'mnemos_person', { action: 'update', person: 'prs_2', display_name: '新名字' });
    assert.equal(jsonOf(updated).display_name, '新名字');
    assert.equal(fake.requests[3].body.display_name, '新名字');
  } finally {
    await fake.close();
  }
});

test('mnemos_status：汇总 health / stats / person，不输出密钥', async () => {
  const fake = await startFake();
  fake.route('GET', '/health', { body: { ok: true, version: '6.1.0' } });
  fake.route('GET', '/v1/partitions/ws-demo/stats', {
    body: { partition_id: 'ptn_1', persons_total: 3, memories_total: 12 },
  });
  fake.route('GET', '/v1/partitions/ws-demo/persons/dsh-agent', {
    body: { id: 'prs_1', external_id: 'dsh-agent', memory_count: 4 },
  });
  const { server } = makeServer(fake);
  try {
    const result = await callTool(server, 'mnemos_status', {});
    const payload = jsonOf(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.api_key_configured, true);
    assert.equal(payload.health.version, '6.1.0');
    assert.equal(payload.partition_stats.memories_total, 12);
    assert.equal(payload.person_info.memory_count, 4);
    assert.ok(!JSON.stringify(payload).includes('mnemos_live_test'));
  } finally {
    await fake.close();
  }
});

test('未知工具 / HTTP 错误 → isError 内容，不抛异常', async () => {
  const fake = await startFake();
  fake.route('POST', '/v1/partitions/ws-demo/memories/search', {
    status: 500,
    headers: { 'x-request-id': 'req_500' },
    body: { error: { code: 'INTERNAL_ERROR', message: '服务端异常' } },
  });
  const { server } = makeServer(fake);
  try {
    const unknown = await callTool(server, 'nope', {});
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /未知工具/);

    const failed = await callTool(server, 'mnemos_search', { query: 'x' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /INTERNAL_ERROR/);
    assert.match(failed.content[0].text, /req_500/);

    const missing = await callTool(server, 'mnemos_search', {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /参数缺失：query/);
  } finally {
    await fake.close();
  }
});

test('mnemos_profile：P1 端点 404 时给出明确 isError', async () => {
  const fake = await startFake();
  fake.route('GET', '/v1/partitions/ws-demo/persons/dsh-agent/profile', {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: '记忆不存在' } },
  });
  const { server } = makeServer(fake);
  try {
    const result = await callTool(server, 'mnemos_profile', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /P1/);
  } finally {
    await fake.close();
  }
});

/* ------------------------------------------------------------------ */
/* resources                                                           */
/* ------------------------------------------------------------------ */

test('resources/list 与 resources/read', async () => {
  const fake = await startFake();
  fake.route('GET', '/v1/partitions/ws-demo/stats', {
    body: { partition_id: 'ptn_1', persons_total: 1 },
  });
  fake.route('GET', '/v1/partitions/ws-demo/persons/dsh-agent/brief', {
    body: { text: '简报正文' },
  });
  fake.route('GET', '/v1/partitions/ws-demo/persons/dsh-agent/profile', {
    body: { summary: '画像摘要', facts: [] },
  });
  const { server } = makeServer(fake);
  try {
    const listed = await request(server, 'resources/list', {});
    const uris = listed.result.resources.map((resource) => resource.uri);
    assert.deepEqual(uris, [
      'mnemos://partition/ws-demo/stats',
      'mnemos://person/dsh-agent/brief',
      'mnemos://person/dsh-agent/profile',
    ]);

    const stats = await request(server, 'resources/read', {
      uri: 'mnemos://partition/ws-demo/stats',
    });
    assert.equal(stats.result.contents[0].mimeType, 'application/json');
    assert.equal(JSON.parse(stats.result.contents[0].text).persons_total, 1);

    const brief = await request(server, 'resources/read', {
      uri: 'mnemos://person/dsh-agent/brief',
    });
    assert.equal(brief.result.contents[0].text, '简报正文');

    const profile = await request(server, 'resources/read', {
      uri: 'mnemos://person/dsh-agent/profile',
    });
    assert.equal(JSON.parse(profile.result.contents[0].text).summary, '画像摘要');

    const unknown = await request(server, 'resources/read', { uri: 'mnemos://nope' });
    assert.equal(unknown.error.code, -32002);
  } finally {
    await fake.close();
  }
});

test('未配置分区时 resources/list 为空', async () => {
  const fake = await startFake();
  const { server } = makeServer(fake, { partition: '' });
  try {
    const listed = await request(server, 'resources/list', {});
    assert.deepEqual(listed.result.resources, []);
  } finally {
    await fake.close();
  }
});

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

test('loadConfig：默认值与环境变量覆盖', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.baseUrl, 'http://127.0.0.1:4380');
  assert.equal(defaults.person, 'dsh-agent');
  assert.equal(defaults.partition, '');
  assert.equal(defaults.timeoutMs, 30_000);

  const custom = loadConfig({
    MNEMOS_BASE_URL: 'http://mnemos.local:4380/',
    MNEMOS_API_KEY: ' mnemos_live_x ',
    MNEMOS_PARTITION: 'ws-demo',
    MNEMOS_PERSON: 'user-1',
    MNEMOS_TIMEOUT_MS: '5000',
  });
  assert.equal(custom.baseUrl, 'http://mnemos.local:4380');
  assert.equal(custom.apiKey, 'mnemos_live_x');
  assert.equal(custom.partition, 'ws-demo');
  assert.equal(custom.person, 'user-1');
  assert.equal(custom.timeoutMs, 5000);
});
