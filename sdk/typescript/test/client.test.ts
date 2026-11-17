/**
 * Mnemos v6 TypeScript SDK 测试（mock fetch，不启动真实服务）。
 *
 * 运行：node --test test/*.test.ts
 *
 * 覆盖：v6 端点路径 / snake_case 请求体 / 游标分页查询 /
 *       响应归一化 / 错误映射 / 幂等键 / 429·5xx 重试 / 超时与取消。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MnemosApiError, MnemosClient } from '../src/index.ts';

/* ------------------------------------------------------------------ */
/* mock fetch                                                          */
/* ------------------------------------------------------------------ */

interface CapturedCall {
  url: string;
  path: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type MockHandler = (call: CapturedCall, index: number) => Response | Promise<Response>;

interface FetchMock {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
}

function createFetchMock(handler: MockHandler): FetchMock {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const rawBody = await request.text();
    const url = new URL(request.url);
    const call: CapturedCall = {
      url: request.url,
      path: url.pathname,
      method: request.method,
      headers: request.headers,
      body: rawBody === '' ? undefined : (JSON.parse(rawBody) as unknown),
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function empty(status = 204): Response {
  return new Response(null, { status });
}

function clientFor(mock: FetchMock, overrides: Partial<ConstructorParameters<typeof MnemosClient>[0]> = {}): MnemosClient {
  return new MnemosClient({
    apiKey: 'mnemos_live_demo_v6',
    baseUrl: 'http://mnemos.test',
    fetchImpl: mock.fetchImpl,
    ...overrides,
  });
}

function queryOf(call: CapturedCall): URLSearchParams {
  return new URL(call.url).searchParams;
}

/* ------------------------------------------------------------------ */
/* fixtures（服务端 snake_case 响应）                                   */
/* ------------------------------------------------------------------ */

const partitionFixture = {
  id: 'prt_demo',
  org_id: 'org_demo',
  slug: 'ws-demo',
  name: '演示分区',
  description: 'v6 演示',
  status: 'active',
  settings: {
    default_scope: 'partition',
    brief_max_chars: 1200,
    brief_enabled: true,
    dream_enabled: true,
    dream_interval_minutes: 1440,
    retention_days: 0,
    monthly_quota: 0,
    person_auto_create: true,
    locale: 'zh-CN',
  },
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-02T00:00:00.000Z',
  archived_at: null,
  stats: {
    partition_id: 'prt_demo',
    persons_total: 12,
    persons_human: 10,
    persons_agent: 2,
    persons_service: 0,
    memories_total: 34,
    shared_total: 8,
    sessions_total: 5,
    updated_at: '2026-11-02T00:00:00.000Z',
  },
};

const personFixture = {
  id: 'per_1',
  partition_id: 'prt_demo',
  external_id: 'user-1',
  type: 'human',
  display_name: '周野',
  attributes: { role: 'dev' },
  status: 'active',
  memory_count: 3,
  shared_memory_count: 1,
  session_count: 2,
  last_memory_at: '2026-11-03T10:00:00.000Z',
  first_seen_at: '2026-11-01T00:00:00.000Z',
  last_seen_at: '2026-11-03T10:00:00.000Z',
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-03T10:00:00.000Z',
};

const memoryFixture = {
  id: 'mem_1',
  partition_id: 'prt_demo',
  person_id: 'per_1',
  person_external_id: 'user-1',
  actor_person_id: 'per_1',
  scope: 'partition',
  session_id: null,
  category: 'preference',
  content: '周野偏好用中文写评审意见。',
  importance: 0.7,
  confidence: 0.9,
  source: 'api',
  status: 'active',
  tags: ['偏好'],
  metadata: { channel: 'test' },
  created_at: '2026-11-03T10:00:00.000Z',
  updated_at: '2026-11-03T10:00:00.000Z',
  expires_at: null,
  dreamed_at: null,
};

const briefFixture = {
  partition_id: 'prt_demo',
  person_id: 'per_1',
  scope_key: 'person:per_1',
  text: '周野偏好用中文写评审意见。',
  max_chars: 1200,
  count: 1,
  model: 'mnemos-condense',
  cached: false,
  source_hash: 'hash_1',
  generated_at: '2026-11-04T00:00:00.000Z',
  recent: [
    {
      id: 'mem_1',
      content: '周野偏好用中文写评审意见。',
      category: 'preference',
      importance: 0.7,
      scope: 'partition',
      updated_at: '2026-11-03T10:00:00.000Z',
      person_id: 'per_1',
      person_external_id: 'user-1',
    },
  ],
};

const dreamRunFixture = {
  id: 'dr_1',
  partition_id: 'prt_demo',
  person_id: 'per_1',
  trigger: 'manual',
  status: 'completed',
  input_count: 4,
  insight_count: 1,
  summary: '巩固 4 条记忆',
  error: null,
  started_at: '2026-11-04T00:00:00.000Z',
  finished_at: '2026-11-04T00:00:01.000Z',
};

const dreamStatusFixture = {
  settings: { enabled: true, interval_minutes: 1440, last_at: '2026-11-04T00:00:00.000Z' },
  person_id: 'per_1',
  pending_count: 2,
  last_run: dreamRunFixture,
  runs: [dreamRunFixture],
};

/* ------------------------------------------------------------------ */
/* 1. 分区：create / get / update / stats / list                       */
/* ------------------------------------------------------------------ */

test('partitions.create：snake_case 请求体、settings 归一化、响应驼峰兼容', async () => {
  const mock = createFetchMock(() => json(partitionFixture));
  const client = clientFor(mock);

  const partition = await client.partitions.create({
    slug: 'ws-demo',
    name: '演示分区',
    description: 'v6 演示',
    settings: { defaultScope: 'person', briefMaxChars: 800, locale: 'zh-CN' },
  });

  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/partitions');
  assert.equal(call.headers.get('authorization'), 'Bearer mnemos_live_demo_v6');
  assert.match(String(call.headers.get('x-mnemos-sdk')), /^typescript\//);
  assert.deepEqual(call.body, {
    slug: 'ws-demo',
    name: '演示分区',
    description: 'v6 演示',
    settings: { default_scope: 'person', brief_max_chars: 800, locale: 'zh-CN' },
  });

  assert.equal(partition.slug, 'ws-demo');
  assert.equal(partition.settings.default_scope, 'partition');
  assert.equal(partition.stats?.persons_total, 12);
  assert.equal(partition.stats?.shared_total, 8);
  assert.equal(partition.archived_at, null);
});

test('partitions.get / stats / list / update：路径与字段', async () => {
  const mock = createFetchMock((call) => {
    if (call.method === 'GET' && call.path === '/v1/partitions') return json([partitionFixture]);
    if (call.method === 'PATCH') return json({ ...partitionFixture, name: '改名后' });
    if (call.path.endsWith('/stats')) return json(partitionFixture.stats);
    return json(partitionFixture);
  });
  const client = clientFor(mock);

  const list = await client.partitions.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, 'prt_demo');

  const partition = await client.partitions.get('ws demo');
  assert.equal(mock.calls[1]?.path, '/v1/partitions/ws%20demo');
  assert.equal(partition.name, '演示分区');

  const stats = await client.partitions.stats('ws-demo');
  assert.equal(mock.calls[2]?.path, '/v1/partitions/ws-demo/stats');
  assert.equal(stats.memories_total, 34);
  assert.equal(stats.sessions_total, 5);

  const updated = await client.partitions.update('ws-demo', {
    name: '改名后',
    settings: { dreamIntervalMinutes: 60 },
  });
  assert.equal(mock.calls[3]?.method, 'PATCH');
  assert.deepEqual(mock.calls[3]?.body, { name: '改名后', settings: { dream_interval_minutes: 60 } });
  assert.equal(updated.name, '改名后');
});

/* ------------------------------------------------------------------ */
/* 2. 人：list 游标 / get / upsert / update                            */
/* ------------------------------------------------------------------ */

test('persons.list：cursor/limit/q/type/status/sort 查询与分页归一化', async () => {
  const mock = createFetchMock(() =>
    json({
      items: [personFixture],
      next_cursor: 'cursor_2',
      partition_stats: partitionFixture.stats,
    }),
  );
  const client = clientFor(mock);

  const page = await client.persons.list('ws-demo', {
    type: 'human',
    status: 'active',
    q: '周',
    sort: 'recent',
    cursor: 'cursor_1',
    limit: 50,
  });

  assert.equal(mock.calls[0]?.path, '/v1/partitions/ws-demo/persons');
  const query = queryOf(mock.calls[0] as CapturedCall);
  assert.equal(query.get('type'), 'human');
  assert.equal(query.get('status'), 'active');
  assert.equal(query.get('q'), '周');
  assert.equal(query.get('sort'), 'recent');
  assert.equal(query.get('cursor'), 'cursor_1');
  assert.equal(query.get('limit'), '50');

  assert.equal(page.items.length, 1);
  assert.equal(page.next_cursor, 'cursor_2');
  assert.equal(page.partition_stats?.persons_total, 12);
  assert.equal(page.items[0]?.memory_count, 3);
  assert.equal(page.items[0]?.last_memory_at, '2026-11-03T10:00:00.000Z');
});

test('persons.get / upsert / update：路径编码、camelCase 请求体转 snake_case', async () => {
  const mock = createFetchMock((call) => {
    if (call.method === 'PUT') {
      return json({ ...personFixture, external_id: 'user 1', display_name: '周野（更新）' });
    }
    if (call.method === 'PATCH') return json({ ...personFixture, status: 'archived' });
    return json(personFixture);
  });
  const client = clientFor(mock);

  const person = await client.persons.get('ws-demo', 'per_1');
  assert.equal(mock.calls[0]?.path, '/v1/partitions/ws-demo/persons/per_1');
  assert.equal(person.external_id, 'user-1');

  await client.persons.upsert('ws-demo', 'user 1', {
    type: 'agent',
    displayName: '周野（更新）',
    attributes: { team: 'core' },
  });
  const upsertCall = mock.calls[1] as CapturedCall;
  assert.equal(upsertCall.method, 'PUT');
  assert.equal(upsertCall.path, '/v1/partitions/ws-demo/persons/user%201');
  assert.deepEqual(upsertCall.body, {
    type: 'agent',
    display_name: '周野（更新）',
    attributes: { team: 'core' },
  });

  await client.persons.update('ws-demo', 'user-1', { status: 'archived' });
  const updateCall = mock.calls[2] as CapturedCall;
  assert.equal(updateCall.method, 'PATCH');
  assert.deepEqual(updateCall.body, { status: 'archived' });
});

test('persons.update：空 PATCH 体在客户端直接拒绝', async () => {
  const mock = createFetchMock(() => json(personFixture));
  const client = clientFor(mock);
  await assert.rejects(() => client.persons.update('ws-demo', 'user-1', {}), /至少提供一个待更新字段/);
  assert.equal(mock.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* 3. 记忆：按人 list/add、全局 list、search、get/update/delete         */
/* ------------------------------------------------------------------ */

test('memories.add：按人路径、snake_case 请求体与响应事件归一化', async () => {
  const mock = createFetchMock(() =>
    json(
      {
        memory: memoryFixture,
        events: [{ type: 'ADD', memory_id: 'mem_1', at: '2026-11-03T10:00:00.000Z' }],
      },
      201,
    ),
  );
  const client = clientFor(mock);

  const result = await client.memories.add('ws-demo', 'user-1', {
    text: '周野偏好用中文写评审意见。',
    scope: 'partition',
    category: 'preference',
    importance: 0.7,
    sessionId: 'ses_1',
    sessionTitle: '评审',
    tags: ['偏好'],
    metadata: { channel: 'test' },
  });

  const call = mock.calls[0] as CapturedCall;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/partitions/ws-demo/persons/user-1/memories');
  assert.deepEqual(call.body, {
    text: '周野偏好用中文写评审意见。',
    scope: 'partition',
    session_id: 'ses_1',
    session_title: '评审',
    category: 'preference',
    importance: 0.7,
    tags: ['偏好'],
    metadata: { channel: 'test' },
  });

  assert.equal(result.memory.id, 'mem_1');
  assert.equal(result.memory.person_external_id, 'user-1');
  assert.equal(result.memory.dreamed_at, null);
  assert.deepEqual(result.events, [
    { type: 'ADD', memory_id: 'mem_1', at: '2026-11-03T10:00:00.000Z' },
  ]);
});

test('memories.add：text/messages 都缺失时客户端报错', async () => {
  const mock = createFetchMock(() => json({ memory: memoryFixture }));
  const client = clientFor(mock);
  await assert.rejects(() => client.memories.add('ws-demo', 'user-1', {}), /至少提供一个/);
  assert.equal(mock.calls.length, 0);
});

test('memories.listByPerson：scope/category 查询、不重复 person_id', async () => {
  const mock = createFetchMock(() =>
    json({ items: [memoryFixture], next_cursor: null, partition_stats: partitionFixture.stats }),
  );
  const client = clientFor(mock);

  const page = await client.memories.listByPerson('ws-demo', 'per_1', {
    scope: 'partition',
    category: 'preference',
    q: '评审',
    cursor: 'c1',
    limit: 20,
  });

  const call = mock.calls[0] as CapturedCall;
  assert.equal(call.path, '/v1/partitions/ws-demo/persons/per_1/memories');
  const query = queryOf(call);
  assert.equal(query.get('scope'), 'partition');
  assert.equal(query.get('category'), 'preference');
  assert.equal(query.get('q'), '评审');
  assert.equal(query.get('cursor'), 'c1');
  assert.equal(query.get('limit'), '20');
  assert.equal(query.has('person_id'), false);
  assert.equal(query.has('person_external_id'), false);

  assert.equal(page.items[0]?.content, '周野偏好用中文写评审意见。');
  assert.equal(page.next_cursor, null);
});

test('memories.list：全局游标列表，person_id / person_external_id 过滤', async () => {
  const mock = createFetchMock(() => json({ items: [memoryFixture], next_cursor: 'next_1' }));
  const client = clientFor(mock);

  const page = await client.memories.list('ws-demo', {
    personId: 'per_1',
    personExternalId: 'user-1',
    status: 'active',
    limit: 100,
  });

  const call = mock.calls[0] as CapturedCall;
  assert.equal(call.path, '/v1/partitions/ws-demo/memories');
  const query = queryOf(call);
  assert.equal(query.get('person_id'), 'per_1');
  assert.equal(query.get('person_external_id'), 'user-1');
  assert.equal(query.get('status'), 'active');
  assert.equal(query.get('limit'), '100');
  assert.equal(page.next_cursor, 'next_1');
  assert.equal(page.items[0]?.id, 'mem_1');
});

test('memories.list：limit 越界由客户端拦截', async () => {
  const mock = createFetchMock(() => json({ items: [], next_cursor: null }));
  const client = clientFor(mock);
  await assert.rejects(() => client.memories.list('ws-demo', { limit: 500 }), /limit 必须是 1–200/);
  assert.equal(mock.calls.length, 0);
});

test('memories.search：POST /memories/search、top_k 转换与结果归一化', async () => {
  const mock = createFetchMock(() =>
    json({
      results: [memoryFixture],
      took_ms: 4,
      next_cursor: 'cursor_search',
      partition_stats: partitionFixture.stats,
    }),
  );
  const client = clientFor(mock);

  const response = await client.memories.search('ws-demo', {
    query: '评审偏好',
    personId: 'per_1',
    scope: 'partition',
    category: 'preference',
    topK: 5,
  });

  const call = mock.calls[0] as CapturedCall;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/partitions/ws-demo/memories/search');
  assert.deepEqual(call.body, {
    query: '评审偏好',
    person_id: 'per_1',
    scope: 'partition',
    category: 'preference',
    top_k: 5,
  });
  assert.equal(response.took_ms, 4);
  assert.equal(response.results[0]?.id, 'mem_1');
  assert.equal(response.next_cursor, 'cursor_search');
  assert.equal(response.partition_stats?.memories_total, 34);
});

test('memories.get / update / delete：详情、PATCH 体与 204', async () => {
  const mock = createFetchMock((call) => {
    if (call.method === 'GET') return json({ memory: memoryFixture, person: personFixture });
    if (call.method === 'PATCH') {
      return json({ memory: { ...memoryFixture, content: '更新后的正文', status: 'archived' } });
    }
    return empty(204);
  });
  const client = clientFor(mock);

  const detail = await client.memories.get('ws-demo', 'mem_1');
  assert.equal(mock.calls[0]?.path, '/v1/partitions/ws-demo/memories/mem_1');
  assert.equal(detail.memory.id, 'mem_1');
  assert.equal(detail.person?.external_id, 'user-1');

  const updated = await client.memories.update('ws-demo', 'mem_1', {
    content: '更新后的正文',
    status: 'archived',
    expiresAt: null,
  });
  assert.deepEqual(mock.calls[1]?.body, {
    content: '更新后的正文',
    status: 'archived',
    expires_at: null,
  });
  assert.equal(updated.memory.content, '更新后的正文');

  const deleted = await client.memories.delete('ws-demo', 'mem_1');
  assert.equal(deleted, undefined);
  assert.equal(mock.calls[2]?.method, 'DELETE');
});

/* ------------------------------------------------------------------ */
/* 4. 人级简报 / 上下文 / 做梦                                          */
/* ------------------------------------------------------------------ */

test('personBrief：force/max_chars 查询与 recent 归一化', async () => {
  const mock = createFetchMock(() => json(briefFixture));
  const client = clientFor(mock);

  const brief = await client.personBrief('ws-demo', 'user-1', { force: true, maxChars: 800 });
  const call = mock.calls[0] as CapturedCall;
  assert.equal(call.path, '/v1/partitions/ws-demo/persons/user-1/brief');
  const query = queryOf(call);
  assert.equal(query.get('force'), 'true');
  assert.equal(query.get('max_chars'), '800');

  assert.equal(brief.scope_key, 'person:per_1');
  assert.equal(brief.cached, false);
  assert.equal(brief.recent[0]?.person_external_id, 'user-1');
});

test('personContext：snake_case 请求体与 prompt/citations 归一化', async () => {
  const mock = createFetchMock(() =>
    json({
      person: personFixture,
      brief: briefFixture,
      memories: [memoryFixture],
      shared: [{ ...memoryFixture, id: 'mem_shared', scope: 'partition' }],
      prompt: '你是周野的助手。',
      token_estimate: 128,
      citations: ['mem_1', 'mem_shared'],
      built_at: '2026-11-04T00:00:00.000Z',
    }),
  );
  const client = clientFor(mock);

  const context = await client.personContext('ws-demo', 'per_1', {
    query: '评审偏好',
    budgetTokens: 800,
    includePartition: true,
  });

  const call = mock.calls[0] as CapturedCall;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/partitions/ws-demo/persons/per_1/context');
  assert.deepEqual(call.body, {
    query: '评审偏好',
    budget_tokens: 800,
    include_partition: true,
  });
  assert.equal(context.person.display_name, '周野');
  assert.equal(context.token_estimate, 128);
  assert.deepEqual(context.citations, ['mem_1', 'mem_shared']);
  assert.equal(context.shared.length, 1);
});

test('personDream / personDreamRun：状态与手动运行归一化', async () => {
  const mock = createFetchMock((call) => {
    if (call.method === 'POST') return json({ run: dreamRunFixture, status: dreamStatusFixture });
    return json(dreamStatusFixture);
  });
  const client = clientFor(mock);

  const status = await client.personDream('ws-demo', 'user-1');
  assert.equal(mock.calls[0]?.path, '/v1/partitions/ws-demo/persons/user-1/dream');
  assert.equal(status.settings.interval_minutes, 1440);
  assert.equal(status.pending_count, 2);
  assert.equal(status.last_run?.input_count, 4);

  const result = await client.personDreamRun('ws-demo', 'user-1', { batchSize: 20 });
  const runCall = mock.calls[1] as CapturedCall;
  assert.equal(runCall.path, '/v1/partitions/ws-demo/persons/user-1/dream/run');
  assert.deepEqual(runCall.body, { batch_size: 20 });
  assert.equal(result.run?.insight_count, 1);
  assert.equal(result.status.runs.length, 1);
});

/* ------------------------------------------------------------------ */
/* 5. API Key（控制台端点，camelCase 响应归一化）                       */
/* ------------------------------------------------------------------ */

const keyFixture = {
  id: 'key_1',
  partitionId: 'prt_demo',
  orgId: null,
  kind: 'partition',
  name: 'CI',
  prefix: 'mnemos_live_ab12',
  scopes: ['memories:read', 'memories:write'],
  createdBy: 'usr_1',
  createdAt: '2026-11-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
  allowedIps: ['10.0.0.0/8'],
  rotatedFrom: null,
  rotatedAt: null,
  rateLimitPerMin: 600,
};

test('keys：分区 key list/create/rotate/revoke 与 org key', async () => {
  const mock = createFetchMock((call) => {
    if (call.method === 'GET' && call.path === '/api/org/keys') {
      return json([{ ...keyFixture, kind: 'org', partitionId: null, orgId: 'org_demo' }]);
    }
    if (call.method === 'POST' && call.path === '/api/org/keys') {
      return json({ ...keyFixture, id: 'key_org', kind: 'org', partitionId: null, orgId: 'org_demo', secret: 'mnemos_live_org_secret' }, 201);
    }
    if (call.method === 'GET') return json([keyFixture]);
    if (call.method === 'POST' && call.path.endsWith('/rotate')) {
      return json({ ...keyFixture, id: 'key_2', secret: 'mnemos_live_new_secret' }, 201);
    }
    if (call.method === 'POST') return json({ ...keyFixture, secret: 'mnemos_live_secret' }, 201);
    return empty(204);
  });
  const client = clientFor(mock);

  const list = await client.keys.list('ws-demo');
  assert.equal(mock.calls[0]?.path, '/api/partitions/ws-demo/keys');
  assert.equal(list[0]?.partition_id, 'prt_demo');
  assert.equal(list[0]?.rate_limit_per_min, 600);
  assert.deepEqual(list[0]?.allowed_ips, ['10.0.0.0/8']);

  const created = await client.keys.create('ws-demo', {
    name: 'CI',
    scopes: ['memories:read', 'memories:write'],
    rateLimitPerMin: 600,
    allowedIps: ['10.0.0.0/8'],
  });
  assert.deepEqual(mock.calls[1]?.body, {
    name: 'CI',
    scopes: ['memories:read', 'memories:write'],
    rateLimitPerMin: 600,
    allowedIps: ['10.0.0.0/8'],
  });
  assert.equal(created.secret, 'mnemos_live_secret');

  const rotated = await client.keys.rotate('ws-demo', 'key_1', { graceHours: 0 });
  assert.equal(mock.calls[2]?.path, '/api/partitions/ws-demo/keys/key_1/rotate');
  assert.deepEqual(mock.calls[2]?.body, { graceHours: 0 });
  assert.equal(rotated.secret, 'mnemos_live_new_secret');

  await client.keys.revoke('ws-demo', 'key_2');
  assert.equal(mock.calls[3]?.path, '/api/partitions/ws-demo/keys/key_2');

  const orgKeys = await client.keys.org.list();
  assert.equal(orgKeys[0]?.kind, 'org');
  assert.equal(orgKeys[0]?.org_id, 'org_demo');

  const orgKey = await client.keys.org.create({ name: 'org', scopes: ['admin'] });
  assert.equal(orgKey.secret, 'mnemos_live_org_secret');

  await client.keys.org.revoke('key_org');
  assert.equal(mock.calls[6]?.path, '/api/org/keys/key_org');
});

/* ------------------------------------------------------------------ */
/* 6. 健康检查                                                         */
/* ------------------------------------------------------------------ */

test('health：GET /health 且 camelCase 归一化', async () => {
  const mock = createFetchMock(() =>
    json({ ok: true, version: '6.0.0', uptimeMs: 1234, schemaVersion: 6, db: 'ok', node: 'v26.11.1' }),
  );
  const client = clientFor(mock);

  const health = await client.health();
  assert.equal(mock.calls[0]?.path, '/health');
  assert.equal(health.ok, true);
  assert.equal(health.uptime_ms, 1234);
  assert.equal(health.schema_version, 6);
  assert.equal(health.db, 'ok');
});

/* ------------------------------------------------------------------ */
/* 7. 错误映射                                                         */
/* ------------------------------------------------------------------ */

test('错误映射：status/code/message/details/requestId（响应头兜底）', async () => {
  const mock = createFetchMock((call) => {
    if (call.path.endsWith('/bad')) {
      return json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: '参数不合法',
            details: [{ path: 'query', message: '不能为空' }],
            requestId: 'req_body',
          },
        },
        400,
      );
    }
    return json({ error: { code: 'NOT_FOUND', message: '记忆不存在' } }, 404, {
      'x-request-id': 'req_header',
    });
  });
  const client = clientFor(mock);

  await assert.rejects(
    () => client.memories.get('ws-demo', 'bad'),
    (error: unknown) => {
      assert.ok(error instanceof MnemosApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message, '参数不合法');
      assert.equal(error.requestId, 'req_body');
      assert.deepEqual(error.details, [{ path: 'query', message: '不能为空' }]);
      return true;
    },
  );

  await assert.rejects(
    () => client.memories.get('ws-demo', 'missing'),
    (error: unknown) => {
      assert.ok(error instanceof MnemosApiError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.requestId, 'req_header');
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* 8. 重试 / 幂等 / 超时 / 取消                                        */
/* ------------------------------------------------------------------ */

test('429：按 Retry-After 重试后成功', async () => {
  const mock = createFetchMock((_call, index) => {
    if (index === 0) {
      return json(
        { error: { code: 'RATE_LIMITED', message: '请求过于频繁', requestId: 'req_429' } },
        429,
        { 'retry-after': '0' },
      );
    }
    return json({ items: [personFixture], next_cursor: null });
  });
  const client = clientFor(mock, { maxRetries: 2 });

  const page = await client.persons.list('ws-demo');
  assert.equal(mock.calls.length, 2);
  assert.equal(page.items[0]?.id, 'per_1');
});

test('503：GET 指数退避重试', async () => {
  const mock = createFetchMock((_call, index) => {
    if (index === 0) return json({ error: { code: 'SERVICE_UNAVAILABLE', message: '稍后重试' } }, 503);
    return json({ items: [], next_cursor: null });
  });
  const client = clientFor(mock, { maxRetries: 1 });

  const startedAt = Date.now();
  const page = await client.persons.list('ws-demo');
  const elapsed = Date.now() - startedAt;

  assert.equal(mock.calls.length, 2);
  assert.ok(elapsed >= 150, `应至少经历一次指数退避，实际 ${elapsed}ms`);
  assert.equal(page.items.length, 0);
});

test('非幂等 POST：无幂等键不重试；带 idempotencyKey 可安全重试；检索 POST 总是可重试', async () => {
  // 写记忆（无幂等键）：服务端 503 时只尝试一次，避免重复写入。
  const addMock = createFetchMock(() =>
    json({ error: { code: 'SERVICE_UNAVAILABLE', message: '稍后重试' } }, 503),
  );
  const addClient = clientFor(addMock, { maxRetries: 2 });
  await assert.rejects(
    () => addClient.memories.add('ws-demo', 'user-1', { text: '不会重试' }),
    (error: unknown) => {
      assert.ok(error instanceof MnemosApiError);
      assert.equal(error.status, 503);
      return true;
    },
  );
  assert.equal(addMock.calls.length, 1);
  assert.equal(addMock.calls[0]?.headers.get('idempotency-key'), null);

  // 写记忆（带幂等键）：服务端 v6.1 持久化 24h 幂等记录，可安全重试并复用同一键。
  const idempotentMock = createFetchMock((_call, index) => {
    if (index === 0) {
      return json({ error: { code: 'SERVICE_UNAVAILABLE', message: '稍后重试' } }, 503);
    }
    return json(
      {
        memory: memoryFixture,
        event: 'ADD',
        superseded_id: null,
        events: [{ type: 'ADD', memory_id: 'mem_1', at: '2026-11-03T10:00:00.000Z' }],
      },
      201,
    );
  });
  const idempotentClient = clientFor(idempotentMock, { maxRetries: 2 });
  const added = await idempotentClient.memories.add(
    'ws-demo',
    'user-1',
    { text: '可安全重试' },
    { idempotencyKey: 'idem-key-12345678' },
  );
  assert.equal(idempotentMock.calls.length, 2);
  assert.equal(idempotentMock.calls[0]?.headers.get('idempotency-key'), 'idem-key-12345678');
  assert.equal(idempotentMock.calls[1]?.headers.get('idempotency-key'), 'idem-key-12345678');
  assert.equal(added.event, 'ADD');

  // 检索是只读 POST，允许指数退避重试。
  const searchMock = createFetchMock((_call, index) => {
    if (index === 0) return json({ error: { code: 'SERVICE_UNAVAILABLE', message: '稍后重试' } }, 503);
    return json({
      hits: [{ ...memoryFixture, score: 0.9, signals: {}, matched_on: ['keyword'] }],
      took_ms: 2,
      mode: 'hybrid',
      strategy: 'hybrid',
    });
  });
  const searchClient = clientFor(searchMock, { maxRetries: 2 });
  const response = await searchClient.memories.search('ws-demo', { query: '评审' });

  assert.equal(searchMock.calls.length, 2);
  assert.equal(searchMock.calls[0]?.headers.get('idempotency-key'), null);
  assert.equal(response.hits[0]?.id, 'mem_1');
});

test('超时：单次尝试超时映射为 code=timeout', async () => {
  let calls = 0;
  // 模拟真实 fetch：AbortSignal 触发时 reject。
  const timeoutFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      calls += 1;
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });

  const client = new MnemosClient({
    apiKey: 'mnemos_live_demo_v6',
    baseUrl: 'http://mnemos.test',
    fetchImpl: timeoutFetch,
    timeoutMs: 20,
    maxRetries: 0,
  });

  await assert.rejects(
    () => client.health(),
    (error: unknown) => {
      assert.ok(error instanceof MnemosApiError);
      assert.equal(error.status, 0);
      assert.equal(error.code, 'timeout');
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('取消：已 abort 的 signal 不发起请求', async () => {
  const mock = createFetchMock(() => json(personFixture));
  const client = clientFor(mock);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => client.persons.get('ws-demo', 'per_1', { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof MnemosApiError);
      assert.equal(error.code, 'aborted');
      assert.equal(error.status, 0);
      return true;
    },
  );
  assert.equal(mock.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* 8b. v6.1：settings / 写管线 / 检索信号 / 历史反馈                     */
/* ------------------------------------------------------------------ */

const v61Settings = {
  default_scope: 'partition',
  brief_max_chars: 1200,
  brief_enabled: true,
  dream_enabled: true,
  dream_interval_minutes: 1440,
  retention_days: 0,
  monthly_quota: 0,
  person_auto_create: true,
  locale: 'zh-CN',
  retrieval_mode: 'hybrid',
  retrieval_weights: { vector: 0.5, keyword: 0.25, recency: 0.15, importance: 0.1, entity: 0 },
  embedding_model: 'mnemos-hash-384',
  merge_threshold: 0.93,
  dedupe_threshold: 0.97,
  auto_extract_entities: true,
  pii_redaction: 'basic',
};

const memoryV61Fixture = {
  ...memoryFixture,
  valid_from: '2026-11-03T10:00:00.000Z',
  valid_to: null,
  superseded_by: null,
  supersedes: null,
  fact_key: 'preference.tone',
  feedback_up: 2,
  feedback_down: 0,
  attachment_count: 1,
  attachments: [
    {
      id: 'att_1',
      memory_id: 'mem_1',
      kind: 'image',
      url: 'https://example.com/a.png',
      mime: 'image/png',
      size: 1024,
      caption: '白板照片',
      created_at: '2026-11-03T10:00:00.000Z',
    },
  ],
};

const personFactFixture = {
  id: 'fact_1',
  partition_id: 'prt_demo',
  person_id: 'per_1',
  key: 'identity.job',
  value: '产品经理',
  confidence: 0.9,
  valid_from: '2026-11-03T10:00:00.000Z',
  valid_to: null,
  source_memory_id: 'mem_1',
  created_at: '2026-11-03T10:00:00.000Z',
  updated_at: '2026-11-03T10:00:00.000Z',
};

test('v6.1 settings：新字段归一化（camelCase 兼容）与 PATCH 序列化', async () => {
  const mock = createFetchMock((call) => {
    if (call.method === 'PATCH') return json({ ...partitionFixture, settings: v61Settings });
    return json({ ...partitionFixture, settings: { ...v61Settings, retrievalMode: 'keyword' } });
  });
  const client = clientFor(mock);

  const partition = await client.partitions.get('ws-demo');
  assert.equal(partition.settings.retrieval_mode, 'hybrid');
  assert.equal(partition.settings.retrieval_weights.vector, 0.5);
  assert.equal(partition.settings.embedding_model, 'mnemos-hash-384');
  assert.equal(partition.settings.merge_threshold, 0.93);
  assert.equal(partition.settings.dedupe_threshold, 0.97);
  assert.equal(partition.settings.auto_extract_entities, true);
  assert.equal(partition.settings.pii_redaction, 'basic');

  await client.partitions.update('ws-demo', {
    settings: {
      retrievalMode: 'keyword',
      retrievalWeights: { vector: 0.6, keyword: 0.4 },
      embeddingModel: 'text-embedding-3-small',
      mergeThreshold: 0.9,
      dedupeThreshold: 0.95,
      autoExtractEntities: false,
      piiRedaction: 'off',
    },
  });
  assert.deepEqual(mock.calls[1]?.body, {
    settings: {
      retrieval_mode: 'keyword',
      retrieval_weights: { vector: 0.6, keyword: 0.4 },
      embedding_model: 'text-embedding-3-small',
      merge_threshold: 0.9,
      dedupe_threshold: 0.95,
      auto_extract_entities: false,
      pii_redaction: 'off',
    },
  });
});

test('v6.1 写记忆：attachments / supersedesId / factKey / validFrom + Idempotency-Key', async () => {
  const mock = createFetchMock(() =>
    json(
      {
        memory: memoryV61Fixture,
        event: 'SUPERSEDE',
        superseded_id: 'mem_old',
        events: [{ type: 'SUPERSEDE', memory_id: 'mem_1', at: '2026-11-03T10:00:00.000Z' }],
      },
      201,
    ),
  );
  const client = clientFor(mock);

  const result = await client.memories.add(
    'ws-demo',
    'user-1',
    {
      text: '周野偏好简洁的中文评审意见。',
      scope: 'person',
      category: 'preference',
      supersedesId: 'mem_old',
      factKey: 'preference.tone',
      validFrom: '2026-11-03T10:00:00.000Z',
      attachments: [{ kind: 'image', url: 'https://example.com/a.png', caption: '白板照片' }],
    },
    { idempotencyKey: 'idem-write-0001' },
  );

  const call = mock.calls[0] as CapturedCall;
  assert.equal(call.headers.get('idempotency-key'), 'idem-write-0001');
  assert.deepEqual(call.body, {
    text: '周野偏好简洁的中文评审意见。',
    scope: 'person',
    category: 'preference',
    supersedes_id: 'mem_old',
    fact_key: 'preference.tone',
    valid_from: '2026-11-03T10:00:00.000Z',
    attachments: [{ kind: 'image', url: 'https://example.com/a.png', caption: '白板照片' }],
  });
  assert.equal(result.event, 'SUPERSEDE');
  assert.equal(result.superseded_id, 'mem_old');
  assert.equal(result.memory.valid_to, null);
  assert.equal(result.memory.fact_key, 'preference.tone');
  assert.equal(result.memory.feedback_up, 2);
  assert.equal(result.memory.attachment_count, 1);
  assert.equal(result.memory.attachments?.[0]?.caption, '白板照片');
  assert.equal(result.events[0]?.type, 'SUPERSEDE');
});

test('memories.add：attachments 超过 10 个在客户端拒绝', async () => {
  const mock = createFetchMock(() => json({ memory: memoryFixture }));
  const client = clientFor(mock);
  const attachments = Array.from({ length: 11 }, (_item, index) => ({
    kind: 'file' as const,
    url: `https://example.com/${index}.pdf`,
  }));
  await assert.rejects(
    () => client.memories.add('ws-demo', 'user-1', { text: '附件过多', attachments }),
    /attachments 最多 10 个/,
  );
  assert.equal(mock.calls.length, 0);
});

test('v6.1 memories.search：hits/signals/mode/strategy 与 mode/as_of/include_superseded 请求体', async () => {
  const mock = createFetchMock(() =>
    json({
      hits: [
        {
          ...memoryV61Fixture,
          score: 0.87,
          signals: { vector: 0.8, keyword: 0.9, recency: 0.5, importance: 0.7, entity: 0 },
          matched_on: ['keyword', 'vector'],
        },
      ],
      took_ms: 7,
      mode: 'hybrid',
      strategy: 'hybrid:weighted',
      results: [memoryV61Fixture],
      partition_stats: partitionFixture.stats,
    }),
  );
  const client = clientFor(mock);

  const response = await client.memories.search('ws-demo', {
    query: '评审偏好',
    personExternalId: 'user-1',
    mode: 'hybrid',
    topK: 5,
    asOf: '2026-11-01T00:00:00.000Z',
    includeSuperseded: true,
  });

  assert.deepEqual(mock.calls[0]?.body, {
    query: '评审偏好',
    person_external_id: 'user-1',
    mode: 'hybrid',
    top_k: 5,
    as_of: '2026-11-01T00:00:00.000Z',
    include_superseded: true,
  });
  assert.equal(response.took_ms, 7);
  assert.equal(response.mode, 'hybrid');
  assert.equal(response.strategy, 'hybrid:weighted');
  assert.equal(response.hits[0]?.score, 0.87);
  assert.equal(response.hits[0]?.signals.keyword, 0.9);
  assert.deepEqual(response.hits[0]?.matched_on, ['keyword', 'vector']);
  assert.equal(response.results[0]?.id, 'mem_1');
  assert.equal(response.partition_stats?.memories_total, 34);
});

test('v6.1 历史 / 反馈：history 数组与 feedback 归一化', async () => {
  const mock = createFetchMock((call) => {
    if (call.path.endsWith('/history')) {
      return json({
        items: [
          {
            id: 'hist_1',
            partition_id: 'prt_demo',
            memory_id: 'mem_1',
            person_id: 'per_1',
            event: 'SUPERSEDE',
            old_content: '旧内容',
            new_content: '新内容',
            actor: 'user:usr_1',
            reason: 'superseded',
            meta: { supersededBy: 'mem_2' },
            created_at: '2026-11-03T10:00:00.000Z',
          },
        ],
      });
    }
    return json({ memory: { ...memoryV61Fixture, confidence: 0.95, feedback_up: 3 } });
  });
  const client = clientFor(mock);

  const history = await client.memories.history('ws-demo', 'mem_1');
  assert.equal(mock.calls[0]?.path, '/v1/partitions/ws-demo/memories/mem_1/history');
  assert.equal(history.length, 1);
  assert.equal(history[0]?.event, 'SUPERSEDE');
  assert.equal(history[0]?.old_content, '旧内容');
  assert.equal(history[0]?.actor, 'user:usr_1');
  assert.deepEqual(history[0]?.meta, { supersededBy: 'mem_2' });

  const feedback = await client.memories.feedback('ws-demo', 'mem_1', {
    helpful: true,
    query: '评审偏好',
    reason: '命中正确',
  });
  const feedbackCall = mock.calls[1] as CapturedCall;
  assert.equal(feedbackCall.method, 'POST');
  assert.equal(feedbackCall.path, '/v1/partitions/ws-demo/memories/mem_1/feedback');
  assert.deepEqual(feedbackCall.body, { helpful: true, query: '评审偏好', reason: '命中正确' });
  assert.equal(feedback.memory.feedback_up, 3);
  assert.equal(feedback.memory.confidence, 0.95);
});

/* ------------------------------------------------------------------ */
/* 8c. v6.1：画像 / facts / 生命周期                                    */
/* ------------------------------------------------------------------ */

test('persons.profile / listFacts / upsertFact / upsertFacts / removeFact', async () => {
  const mock = createFetchMock((call) => {
    if (call.method === 'GET' && call.path.endsWith('/profile')) {
      return json({
        person: personFixture,
        facts: [personFactFixture],
        summary: '产品经理，关注评审。',
        generated_at: '2026-11-04T00:00:00.000Z',
        cached: false,
      });
    }
    if (call.method === 'GET') return json({ items: [personFactFixture] });
    if (call.method === 'PUT' && call.body && (call.body as { facts?: unknown[] }).facts) {
      return json({ items: [personFactFixture] });
    }
    if (call.method === 'PUT') return json({ fact: personFactFixture });
    return empty(204);
  });
  const client = clientFor(mock);

  const profile = await client.persons.profile('ws-demo', 'user-1', { force: true });
  assert.equal(mock.calls[0]?.path, '/v1/partitions/ws-demo/persons/user-1/profile');
  assert.equal(queryOf(mock.calls[0] as CapturedCall).get('force'), 'true');
  assert.equal(profile.summary, '产品经理，关注评审。');
  assert.equal(profile.cached, false);
  assert.equal(profile.facts[0]?.key, 'identity.job');

  const facts = await client.persons.listFacts('ws-demo', 'user-1');
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.valid_to, null);

  const fact = await client.persons.upsertFact('ws-demo', 'user-1', {
    key: 'identity.job',
    value: '产品经理',
    confidence: 0.9,
    sourceMemoryId: 'mem_1',
  });
  assert.deepEqual(mock.calls[2]?.body, {
    key: 'identity.job',
    value: '产品经理',
    confidence: 0.9,
    source_memory_id: 'mem_1',
  });
  assert.equal(fact.id, 'fact_1');

  const items = await client.persons.upsertFacts('ws-demo', 'user-1', [
    { key: 'identity.job', value: '产品经理' },
    { key: 'preference.tone', value: '简洁' },
  ]);
  assert.equal(items.length, 1);
  assert.equal((mock.calls[3]?.body as { facts: unknown[] }).facts.length, 2);

  await client.persons.removeFact('ws-demo', 'user-1', 'fact_1');
  assert.equal(mock.calls[4]?.method, 'DELETE');
  assert.equal(mock.calls[4]?.path, '/v1/partitions/ws-demo/persons/user-1/facts/fact_1');
});

test('persons.merge / archive / export / remove(hard) 与 consent / include_merged', async () => {
  const mock = createFetchMock((call) => {
    if (call.path.endsWith('/merge')) {
      return json({
        person: { ...personFixture, id: 'per_2', external_id: 'user-2' },
        merged_from: personFixture,
        moved_memories: 5,
        moved_facts: 2,
      });
    }
    if (call.path.endsWith('/archive')) {
      return json({ ...personFixture, status: 'archived' });
    }
    if (call.path.endsWith('/export')) {
      return json({
        person: personFixture,
        facts: [personFactFixture],
        memories: [memoryV61Fixture],
        exported_at: '2026-11-04T00:00:00.000Z',
        truncated: false,
      });
    }
    if (call.method === 'DELETE') return empty(204);
    if (call.method === 'PUT') return json({ ...personFixture, consent: { marketing: true } });
    if (call.method === 'PATCH') return json({ ...personFixture, consent: { marketing: false } });
    return json({ items: [], next_cursor: null });
  });
  const client = clientFor(mock);

  const merged = await client.persons.merge('ws-demo', 'user-1', { targetExternalId: 'user-2' });
  assert.equal(mock.calls[0]?.method, 'POST');
  assert.equal(mock.calls[0]?.path, '/v1/partitions/ws-demo/persons/user-1/merge');
  assert.deepEqual(mock.calls[0]?.body, { target_external_id: 'user-2' });
  assert.equal(merged.person.id, 'per_2');
  assert.equal(merged.merged_from.external_id, 'user-1');
  assert.equal(merged.moved_memories, 5);
  assert.equal(merged.moved_facts, 2);

  const archived = await client.persons.archive('ws-demo', 'user-1');
  assert.equal(archived.status, 'archived');

  const exported = await client.persons.export('ws-demo', 'user-1');
  assert.equal(mock.calls[2]?.path, '/v1/partitions/ws-demo/persons/user-1/export');
  assert.equal(exported.facts[0]?.key, 'identity.job');
  assert.equal(exported.memories[0]?.id, 'mem_1');
  assert.equal(exported.truncated, false);

  await client.persons.remove('ws-demo', 'user-1');
  assert.equal(queryOf(mock.calls[3] as CapturedCall).has('hard'), false);

  await client.persons.remove('ws-demo', 'user-1', { hard: true });
  assert.equal(mock.calls[4]?.method, 'DELETE');
  assert.equal(queryOf(mock.calls[4] as CapturedCall).get('hard'), 'true');

  const upserted = await client.persons.upsert('ws-demo', 'user-1', { consent: { marketing: true } });
  assert.deepEqual(mock.calls[5]?.body, { consent: { marketing: true } });
  assert.deepEqual(upserted.consent, { marketing: true });

  const updated = await client.persons.update('ws-demo', 'user-1', { consent: { marketing: false } });
  assert.deepEqual(mock.calls[6]?.body, { consent: { marketing: false } });
  assert.deepEqual(updated.consent, { marketing: false });

  await client.persons.list('ws-demo', { includeMerged: true });
  assert.equal(queryOf(mock.calls[7] as CapturedCall).get('include_merged'), 'true');
});

test('persons.remove：空 body 的 DELETE 也返回 void', async () => {
  const mock = createFetchMock(() => empty(204));
  const client = clientFor(mock);
  const result = await client.persons.remove('ws-demo', 'user-1', { hard: true });
  assert.equal(result, undefined);
});

/* ------------------------------------------------------------------ */
/* 8d. v6.1 P2：图谱 / 实体                                             */
/* ------------------------------------------------------------------ */

test('graph / entities：路径、查询、响应归一化', async () => {
  const mock = createFetchMock((call) => {
    if (call.path.endsWith('/graph')) {
      return json({
        nodes: [
          { id: 'ent_1', label: 'Mnemos', type: 'project', weight: 3, memories: 2 },
          { id: 'ent_2', label: 'SQLite', type: 'tech', weight: 1, memories: 1 },
        ],
        edges: [{ id: 'rel_1', source: 'ent_1', target: 'ent_2', relation: 'co_occurs', weight: 1 }],
        stats: { nodes: 2, edges: 1, top_types: [{ type: 'project', count: 1 }] },
      });
    }
    return json({ items: [{ id: 'ent_1', name: 'Mnemos', type: 'project', mention_count: 3, memories: 2, created_at: '2026-11-01T00:00:00.000Z' }], next_cursor: null });
  });
  const client = clientFor(mock);

  const graph = await client.graph('ws-demo', { personId: 'per_1', limit: 50 });
  assert.equal(mock.calls[0]?.path, '/v1/partitions/ws-demo/graph');
  const graphQuery = queryOf(mock.calls[0] as CapturedCall);
  assert.equal(graphQuery.get('person_id'), 'per_1');
  assert.equal(graphQuery.get('limit'), '50');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0]?.label, 'Mnemos');
  assert.equal(graph.edges[0]?.relation, 'co_occurs');
  assert.equal(graph.stats.top_types[0]?.type, 'project');

  const entities = await client.entities('ws-demo', { q: 'Mne', personId: 'per_1', limit: 20 });
  assert.equal(mock.calls[1]?.path, '/v1/partitions/ws-demo/entities');
  const entityQuery = queryOf(mock.calls[1] as CapturedCall);
  assert.equal(entityQuery.get('person_id'), 'per_1');
  assert.equal(entityQuery.get('q'), 'Mne');
  assert.equal(entityQuery.get('limit'), '20');
  assert.equal(entities.items[0]?.name, 'Mnemos');
  assert.equal(entities.items[0]?.mention_count, 3);
  assert.equal(entities.next_cursor, null);
});

/* ------------------------------------------------------------------ */
/* 9. 构造参数校验                                                     */
/* ------------------------------------------------------------------ */

test('构造参数：apiKey / baseUrl / timeoutMs 校验', () => {
  assert.throws(() => new MnemosClient({ apiKey: '' }), /apiKey 不能为空/);
  assert.throws(
    () => new MnemosClient({ apiKey: 'k', baseUrl: 'not-a-url' }),
    /baseUrl 不是合法 URL/,
  );
  assert.throws(
    () => new MnemosClient({ apiKey: 'k', timeoutMs: 0 }),
    /timeoutMs 必须为正数/,
  );
  assert.throws(
    () => new MnemosClient({ apiKey: 'k', maxRetries: -1 }),
    /maxRetries 必须为非负整数/,
  );
});
