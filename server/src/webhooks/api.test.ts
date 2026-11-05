import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { AppContext, Platform } from '../contracts.ts';
import { migrate } from '../db/index.ts';
import { createMemoryService } from '../engine/index.ts';
import { loadEnv, type Env } from '../env.ts';
import { createHttpServer } from '../http/server.ts';
import { EventBus } from '../lib/bus.ts';
import {
  addProjectMember,
  createOrgAndProject,
  createTestLogger,
  createTestMetrics,
  seedApiKey,
  seedDelivery,
  seedUserSession,
  startReceiver,
  type TestReceiver,
} from './test-helpers.ts';

interface ApiFixture {
  db: DatabaseSync;
  server: Server;
  base: string;
  env: Env;
  projectId: string;
  ownerToken: string;
  viewerToken: string;
  apiKeySecret: string;
}

const OWNER_TOKEN = 'session-token-owner';
const VIEWER_TOKEN = 'session-token-viewer';
const API_KEY_SECRET = 'mnemos_live_webhook_api_test_secret';

async function setupApi(t: TestContext): Promise<ApiFixture> {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const { projectId } = createOrgAndProject(db);

  seedUserSession(db, {
    id: 'usr_owner',
    orgId: 'org_test',
    email: 'owner@mnemos.test',
    name: '林薇',
    role: 'owner',
    token: OWNER_TOKEN,
  });
  seedUserSession(db, {
    id: 'usr_viewer',
    orgId: 'org_test',
    email: 'viewer@mnemos.test',
    name: '苏妍',
    role: 'viewer',
    token: VIEWER_TOKEN,
  });
  addProjectMember(db, projectId, 'usr_viewer', 'viewer');
  seedApiKey(db, projectId, API_KEY_SECRET, ['admin']);

  const env = loadEnv({
    authDisabled: false,
    demoMode: false,
    dbPath: ':memory:',
    webhooksEnabled: false,
    webhookAllowPrivate: true,
    webhookTimeoutMs: 2_000,
    webhookMaxAttempts: 2,
  });

  const logger = createTestLogger();
  const metrics = createTestMetrics();
  const platform = {
    logger,
    metrics,
    maintenance: {
      start: () => undefined,
      stop: () => undefined,
      run: async () => {
        throw new Error('not used');
      },
      history: () => [],
    },
    backups: {
      create: async () => {
        throw new Error('not used');
      },
      list: () => [],
      pathOf: () => null,
    },
    shutdown: async () => undefined,
  } as unknown as Platform;

  const context: AppContext = {
    db,
    engine: createMemoryService(db),
    env,
    bus: new EventBus(),
    startedAt: Date.now(),
    logger,
    metrics,
    platform,
  };

  const server = createHttpServer(context);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    db.close();
  });

  const address = server.address() as AddressInfo;
  return {
    db,
    server,
    base: `http://127.0.0.1:${address.port}`,
    env,
    projectId,
    ownerToken: OWNER_TOKEN,
    viewerToken: VIEWER_TOKEN,
    apiKeySecret: API_KEY_SECRET,
  };
}

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
}

async function call(fx: ApiFixture, path: string, options: CallOptions = {}): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${fx.base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

test('Webhook 控制台与 v1 API', async (t) => {
  const fx = await setupApi(t);
  let webhookId = '';

  await t.test('创建返回 secret 一次，列表不返回 secret', async () => {
    const created = await call(fx, `/api/projects/${fx.projectId}/webhooks`, {
      method: 'POST',
      token: fx.ownerToken,
      body: {
        name: '订单事件',
        url: 'https://hooks.example.com/mnemos',
        eventTypes: ['memory.created', 'task.finished'],
        description: '订单与任务事件',
        enabled: true,
      },
    });
    assert.equal(created.status, 201);
    const body = asRecord(created.body);
    webhookId = String(body.id);
    assert.match(String(body.secret), /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(body.eventTypes, ['memory.created', 'task.finished']);
    assert.equal(body.enabled, true);

    const list = await call(fx, `/api/projects/${fx.projectId}/webhooks`, { token: fx.ownerToken });
    assert.equal(list.status, 200);
    const items = asRecords(list.body);
    assert.equal(items.length, 1);
    assert.equal('secret' in items[0], false);
    assert.equal(String(items[0]?.id), webhookId);
  });

  await t.test('创建时拒绝 file:// 与云元数据地址', async () => {
    const fileUrl = await call(fx, `/api/projects/${fx.projectId}/webhooks`, {
      method: 'POST',
      token: fx.ownerToken,
      body: { name: 'file', url: 'file:///etc/passwd', eventTypes: ['memory.created'] },
    });
    assert.equal(fileUrl.status, 400);

    const metadata = await call(fx, `/api/projects/${fx.projectId}/webhooks`, {
      method: 'POST',
      token: fx.ownerToken,
      body: {
        name: 'metadata',
        url: 'http://169.254.169.254/latest/meta-data/',
        eventTypes: ['memory.created'],
      },
    });
    assert.equal(metadata.status, 400);
    assert.match(String(asRecord(asRecord(metadata.body).error).message), /元数据/);
  });

  await t.test('统计与投递分页（默认 20 / 最大 100）', async () => {
    seedDelivery(fx.db, { webhookId, projectId: fx.projectId, status: 'success', latencyMs: 10 });
    seedDelivery(fx.db, { webhookId, projectId: fx.projectId, status: 'failed', latencyMs: 30 });
    seedDelivery(fx.db, { webhookId, projectId: fx.projectId, status: 'pending', latencyMs: 20 });

    const stats = await call(fx, `/api/projects/${fx.projectId}/webhooks/stats`, { token: fx.ownerToken });
    assert.equal(stats.status, 200);
    const statsBody = asRecord(stats.body);
    assert.equal(statsBody.total, 3);
    assert.equal(statsBody.success, 1);
    assert.equal(statsBody.failed, 1);
    assert.equal(statsBody.pending, 1);
    assert.equal(statsBody.dead, 0);
    assert.equal(statsBody.avgLatencyMs, 20);
    assert.equal(statsBody.last24h, 3);

    const page1 = await call(fx, `/api/webhooks/${webhookId}/deliveries?page=1&pageSize=2`, {
      token: fx.ownerToken,
    });
    assert.equal(page1.status, 200);
    const page1Body = asRecord(page1.body);
    assert.equal(page1Body.total, 3);
    assert.equal(page1Body.page, 1);
    assert.equal(page1Body.pageSize, 2);
    assert.equal(page1Body.totalPages, 2);
    assert.equal(asRecords(page1Body.items).length, 2);
    // 控制台投递详情需要 payload 预览（会截断到 16KB）
    assert.equal(typeof asRecords(page1Body.items)[0].payload, 'string');

    const page2 = await call(fx, `/api/webhooks/${webhookId}/deliveries?page=2&pageSize=2`, {
      token: fx.ownerToken,
    });
    assert.equal(asRecords(asRecord(page2.body).items).length, 1);

    const filtered = await call(fx, `/api/webhooks/${webhookId}/deliveries?status=pending`, {
      token: fx.ownerToken,
    });
    const filteredBody = asRecord(filtered.body);
    assert.equal(filteredBody.total, 1);
    const filteredItem = asRecords(filteredBody.items)[0];
    assert.equal(filteredItem?.status, 'pending');

    const clamped = await call(fx, `/api/webhooks/${webhookId}/deliveries?pageSize=500`, {
      token: fx.ownerToken,
    });
    assert.equal(asRecord(clamped.body).pageSize, 100);
  });

  await t.test('轮换 secret 后旧 secret 不再返回', async () => {
    const before = await call(fx, `/api/webhooks/${webhookId}/rotate-secret`, {
      method: 'POST',
      token: fx.ownerToken,
    });
    assert.equal(before.status, 200);
    const rotated = asRecord(before.body);
    assert.match(String(rotated.secret), /^whsec_/);

    const list = await call(fx, `/api/projects/${fx.projectId}/webhooks`, { token: fx.ownerToken });
    assert.equal('secret' in asRecords(list.body)[0]!, false);

    const again = await call(fx, `/api/webhooks/${webhookId}/rotate-secret`, {
      method: 'POST',
      token: fx.ownerToken,
    });
    assert.notEqual(asRecord(again.body).secret, rotated.secret);
  });

  await t.test('更新与重新启用', async () => {
    const updated = await call(fx, `/api/webhooks/${webhookId}`, {
      method: 'PATCH',
      token: fx.ownerToken,
      body: { name: '订单事件 v2', enabled: false, eventTypes: ['memory.created'] },
    });
    assert.equal(updated.status, 200);
    const updatedBody = asRecord(updated.body);
    assert.equal(updatedBody.name, '订单事件 v2');
    assert.equal(updatedBody.enabled, false);
    assert.ok(updatedBody.disabledAt);

    const enabled = await call(fx, `/api/webhooks/${webhookId}`, {
      method: 'PATCH',
      token: fx.ownerToken,
      body: { enabled: true },
    });
    const enabledBody = asRecord(enabled.body);
    assert.equal(enabledBody.enabled, true);
    assert.equal(enabledBody.disabledAt, undefined);
    assert.equal(enabledBody.failureCount, 0);
  });

  await t.test('权限：viewer 可读、写操作 403', async () => {
    const read = await call(fx, `/api/projects/${fx.projectId}/webhooks`, { token: fx.viewerToken });
    assert.equal(read.status, 200);

    const create = await call(fx, `/api/projects/${fx.projectId}/webhooks`, {
      method: 'POST',
      token: fx.viewerToken,
      body: {
        name: '越权创建',
        url: 'https://hooks.example.com/x',
        eventTypes: ['memory.created'],
      },
    });
    assert.equal(create.status, 403);

    const patch = await call(fx, `/api/webhooks/${webhookId}`, {
      method: 'PATCH',
      token: fx.viewerToken,
      body: { name: '越权更新' },
    });
    assert.equal(patch.status, 403);

    const del = await call(fx, `/api/webhooks/${webhookId}`, {
      method: 'DELETE',
      token: fx.viewerToken,
    });
    assert.equal(del.status, 403);
  });

  await t.test('event-types 列表包含 8 个可订阅事件且不含 search.performed', async () => {
    const response = await call(fx, '/api/webhooks/event-types', { token: fx.ownerToken });
    assert.equal(response.status, 200);
    const types = asRecords(response.body);
    assert.equal(types.length, 8);
    const values = types.map((item) => String(item.type));
    assert.ok(values.includes('memory.created'));
    assert.ok(values.includes('task.finished'));
    assert.ok(values.includes('key.revoked'));
    assert.ok(!values.includes('search.performed'));
    for (const item of types) {
      assert.equal(typeof item.label, 'string');
      assert.equal(typeof item.description, 'string');
    }
  });

  let receiver: TestReceiver | null = null;

  await t.test('测试投递命中本地端点并写入投递记录', async () => {
    receiver = await startReceiver();
    t.after(() => receiver?.close());

    const patch = await call(fx, `/api/webhooks/${webhookId}`, {
      method: 'PATCH',
      token: fx.ownerToken,
      body: { url: receiver.url },
    });
    assert.equal(patch.status, 200);

    const tested = await call(fx, `/api/webhooks/${webhookId}/test`, {
      method: 'POST',
      token: fx.ownerToken,
    });
    assert.equal(tested.status, 200);
    const result = asRecord(tested.body);
    assert.equal(result.status, 'success');
    assert.equal(result.responseStatus, 200);
    assert.equal(typeof result.deliveryId, 'string');
    assert.equal(receiver.requests.length, 1);

    const detail = await call(fx, `/api/webhooks/deliveries/${String(result.deliveryId)}`, {
      token: fx.ownerToken,
    });
    assert.equal(detail.status, 200);
    const delivery = asRecord(detail.body);
    assert.equal(delivery.eventType, 'webhook.test');
    assert.equal(delivery.status, 'success');
    assert.equal(delivery.attempts, 1);
  });

  await t.test('重放投递重置为 pending 且 attempts=0', async () => {
    const failed = seedDelivery(fx.db, {
      webhookId,
      projectId: fx.projectId,
      status: 'failed',
      attempts: 3,
    });
    const replayed = await call(fx, `/api/webhooks/deliveries/${failed}/replay`, {
      method: 'POST',
      token: fx.ownerToken,
    });
    assert.equal(replayed.status, 200);
    const delivery = asRecord(replayed.body);
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.attempts, 0);
    assert.ok(delivery.nextAttemptAt);
    assert.equal(delivery.deliveredAt, undefined);
  });

  await t.test('公开 v1：snake_case、掩码、CRUD 与重放', async () => {
    const list = await call(fx, '/v1/webhooks', { token: fx.apiKeySecret });
    assert.equal(list.status, 200);
    const items = asRecords(list.body);
    assert.ok(items.length >= 1);
    assert.equal('secret' in items[0]!, false);
    assert.equal(items[0]?.project_id, fx.projectId);
    assert.ok(Array.isArray(items[0]?.event_types));

    const created = await call(fx, '/v1/webhooks', {
      method: 'POST',
      token: fx.apiKeySecret,
      body: {
        name: 'v1 订阅',
        url: 'https://hooks.example.com/v1',
        event_types: ['memory.updated'],
        description: 'v1 创建',
      },
    });
    assert.equal(created.status, 201);
    const createdBody = asRecord(created.body);
    assert.match(String(createdBody.secret), /^whsec_/);
    assert.deepEqual(createdBody.event_types, ['memory.updated']);
    const v1Id = String(createdBody.id);

    const deliveries = await call(fx, `/v1/webhooks/${v1Id}/deliveries?page=1&page_size=5`, {
      token: fx.apiKeySecret,
    });
    assert.equal(deliveries.status, 200);
    const deliveriesBody = asRecord(deliveries.body);
    assert.equal(deliveriesBody.page, 1);
    assert.equal(deliveriesBody.page_size, 5);
    assert.equal(deliveriesBody.total, 0);
    assert.equal(deliveriesBody.total_pages, 1);
    assert.deepEqual(deliveriesBody.items, []);

    const patched = await call(fx, `/v1/webhooks/${v1Id}`, {
      method: 'PATCH',
      token: fx.apiKeySecret,
      body: { name: 'v1 订阅更新', enabled: false },
    });
    assert.equal(patched.status, 200);
    assert.equal(asRecord(patched.body).name, 'v1 订阅更新');
    assert.equal(asRecord(patched.body).enabled, false);
    assert.equal('secret' in asRecord(patched.body), false);

    const rotated = await call(fx, `/v1/webhooks/${v1Id}/rotate-secret`, {
      method: 'POST',
      token: fx.apiKeySecret,
    });
    assert.equal(rotated.status, 200);
    assert.match(String(asRecord(rotated.body).secret), /^whsec_/);

    const failedDelivery = seedDelivery(fx.db, {
      webhookId: v1Id,
      projectId: fx.projectId,
      status: 'failed',
      attempts: 2,
    });
    const replayed = await call(fx, `/v1/webhook-deliveries/${failedDelivery}/replay`, {
      method: 'POST',
      token: fx.apiKeySecret,
    });
    assert.equal(replayed.status, 200);
    const replayBody = asRecord(replayed.body);
    assert.equal(replayBody.status, 'pending');
    assert.equal(replayBody.attempts, 0);
    assert.ok(replayBody.next_attempt_at);
    assert.equal(replayBody.webhook_id, v1Id);

    const removed = await call(fx, `/v1/webhooks/${v1Id}`, {
      method: 'DELETE',
      token: fx.apiKeySecret,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { ok: true });

    const after = await call(fx, '/v1/webhooks', { token: fx.apiKeySecret });
    assert.ok(asRecords(after.body).every((item) => item.id !== v1Id));
  });

  await t.test('v1 无 admin scope 时拒绝写入', async () => {
    const readOnlySecret = 'mnemos_live_readonly_webhook_test';
    seedApiKey(fx.db, fx.projectId, readOnlySecret, ['memories:read']);

    const read = await call(fx, '/v1/webhooks', { token: readOnlySecret });
    assert.equal(read.status, 200);

    const write = await call(fx, '/v1/webhooks', {
      method: 'POST',
      token: readOnlySecret,
      body: { name: '只读越权', url: 'https://hooks.example.com/ro', event_types: ['memory.created'] },
    });
    assert.equal(write.status, 403);
  });
});
