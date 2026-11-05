import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { migrate } from '../db/index.ts';
import { sha256 } from '../lib/ids.ts';
import type { RequestContext } from './context.ts';
import { withIdempotency } from './idempotency.ts';

interface FakeResponse {
  statusCode: number;
  headersSent: boolean;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | undefined;
  end(chunk?: string): void;
}

function createResponse(): FakeResponse {
  return {
    statusCode: 0,
    headersSent: false,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.headersSent = true;
    },
  };
}

function createContext(
  db: DatabaseSync,
  headers: Record<string, string>,
  body: unknown,
  response: FakeResponse,
  projectId = 'prj_idem',
): RequestContext {
  return {
    app: { db } as unknown as RequestContext['app'],
    req: { headers } as unknown as IncomingMessage,
    res: response as unknown as ServerResponse,
    url: new URL('http://127.0.0.1/v1/memories'),
    method: 'POST',
    pathname: '/v1/memories',
    params: {},
    requestId: 'req_test',
    ip: '127.0.0.1',
    userAgent: 'test',
    auth: null,
    project: { id: projectId } as unknown as RequestContext['project'],
    usage: null,
    readBody: async () => body,
    body: async () => body,
    query: () => ({}) as never,
    json: () => undefined,
    markUsage: () => undefined,
    noteUsage: () => undefined,
  } as unknown as RequestContext;
}

function createDb(t: TestContext): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  t.after(() => db.close());
  return db;
}

function parse(response: FakeResponse): unknown {
  return response.body.length > 0 ? (JSON.parse(response.body) as unknown) : null;
}

test('无 Idempotency-Key 时直接执行并返回', async (t) => {
  const db = createDb(t);
  const response = createResponse();
  const rc = createContext(db, {}, { text: 'hello' }, response);
  let calls = 0;

  await withIdempotency(rc, 'POST /v1/memories', async () => {
    calls += 1;
    return { status: 201, body: { ok: true, calls } };
  });

  assert.equal(calls, 1);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(parse(response), { ok: true, calls: 1 });
  assert.equal(response.headers['x-idempotent-replayed'], undefined);
});

test('同 key + 同请求体回放已存响应', async (t) => {
  const db = createDb(t);
  const headers = { 'idempotency-key': 'order-12345' };
  let calls = 0;
  const handler = async () => {
    calls += 1;
    return { status: 202, body: { memoryId: 'mem_1', calls } };
  };

  const first = createResponse();
  await withIdempotency(createContext(db, headers, { text: '同一个请求' }, first), 'POST /v1/memories', handler);
  assert.equal(first.statusCode, 202);
  assert.equal(first.headers['x-idempotent-replayed'], undefined);

  const second = createResponse();
  await withIdempotency(
    createContext(db, headers, { text: '同一个请求' }, second),
    'POST /v1/memories',
    async () => {
      throw new Error('回放路径不应再次执行 handler');
    },
  );

  assert.equal(calls, 1);
  assert.equal(second.statusCode, 202);
  assert.equal(second.headers['x-idempotent-replayed'], 'true');
  assert.deepEqual(parse(second), parse(first));
});

test('同 key + 不同请求体返回 409 idempotency_conflict', async (t) => {
  const db = createDb(t);
  const headers = { 'idempotency-key': 'order-abcdef' };
  const first = createResponse();
  await withIdempotency(createContext(db, headers, { text: 'A' }, first), 'POST /v1/memories', async () => ({
    status: 200,
    body: { ok: true },
  }));

  const second = createResponse();
  await assert.rejects(
    () =>
      withIdempotency(createContext(db, headers, { text: 'B' }, second), 'POST /v1/memories', async () => ({
        status: 200,
        body: { ok: true },
      })),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === 'idempotency_conflict',
  );
  assert.equal(second.headersSent, false);
});

test('同 key 复用到不同 endpoint 视为冲突', async (t) => {
  const db = createDb(t);
  const headers = { 'idempotency-key': 'order-endpoint-1' };
  const body = { title: '同一个 body' };
  const first = createResponse();
  await withIdempotency(createContext(db, headers, body, first), 'POST /v1/tasks', async () => ({
    status: 200,
    body: { ok: true },
  }));

  const second = createResponse();
  await assert.rejects(
    () =>
      withIdempotency(createContext(db, headers, body, second), 'POST /v1/memories', async () => ({
        status: 200,
        body: { ok: true },
      })),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === 'idempotency_conflict',
  );
});

test('5xx 响应不缓存，下一次请求重新执行', async (t) => {
  const db = createDb(t);
  const headers = { 'idempotency-key': 'order-50000x' };
  let calls = 0;

  const first = createResponse();
  await withIdempotency(createContext(db, headers, { text: 'x' }, first), 'POST /v1/memories', async () => {
    calls += 1;
    return { status: 500, body: { error: { code: 'INTERNAL_ERROR' } } };
  });
  assert.equal(first.statusCode, 500);

  const second = createResponse();
  await withIdempotency(createContext(db, headers, { text: 'x' }, second), 'POST /v1/memories', async () => {
    calls += 1;
    return { status: 200, body: { ok: true } };
  });

  assert.equal(calls, 2);
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['x-idempotent-replayed'], undefined);
});

test('非法 Idempotency-Key 返回 400', async (t) => {
  const db = createDb(t);
  const response = createResponse();
  await assert.rejects(
    () =>
      withIdempotency(
        createContext(db, { 'idempotency-key': 'bad key!' }, { text: 'x' }, response),
        'POST /v1/memories',
        async () => ({ status: 200, body: {} }),
      ),
    (error: { status?: number; code?: string }) => error.status === 400 && error.code === 'invalid_idempotency_key',
  );
});

test('崩溃遗留的过期抢占行可被接管', async (t) => {
  const db = createDb(t);
  const headers = { 'idempotency-key': 'order-stale01' };
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO idempotency_keys
       (key, project_id, endpoint, request_hash, status_code, response, created_at, expires_at)
     VALUES (?, 'prj_idem', 'POST /v1/memories', ?, 0, '', ?, ?)`,
  ).run('order-stale01', sha256(JSON.stringify({ text: 'x' })), createdAt, expiresAt);

  const response = createResponse();
  let calls = 0;
  await withIdempotency(createContext(db, headers, { text: 'x' }, response), 'POST /v1/memories', async () => {
    calls += 1;
    return { status: 200, body: { ok: true } };
  });

  assert.equal(calls, 1);
  assert.equal(response.statusCode, 200);
});

test('进行中的幂等请求最多等待 2s 后返回 409 idempotency_in_progress', async (t) => {
  const db = createDb(t);
  const headers = { 'idempotency-key': 'order-busy01' };
  const now = new Date();
  db.prepare(
    `INSERT INTO idempotency_keys
       (key, project_id, endpoint, request_hash, status_code, response, created_at, expires_at)
     VALUES (?, 'prj_idem', 'POST /v1/memories', ?, 0, '', ?, ?)`,
  ).run(
    'order-busy01',
    sha256(JSON.stringify({ text: 'x' })),
    now.toISOString(),
    new Date(now.getTime() + 3_600_000).toISOString(),
  );

  const started = Date.now();
  await assert.rejects(
    () =>
      withIdempotency(
        createContext(db, headers, { text: 'x' }, createResponse()),
        'POST /v1/memories',
        async () => ({ status: 200, body: {} }),
      ),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === 'idempotency_in_progress',
  );
  assert.ok(Date.now() - started >= 1_900, '应至少等待约 2s');
});
