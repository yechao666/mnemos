import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { WebhookEventPayload } from '../../../shared/src/types.ts';
import type { WebhookDispatcher } from '../contracts.ts';
import { migrate } from '../db/index.ts';
import { loadEnv, type Env } from '../env.ts';
import { EventBus } from '../lib/bus.ts';
import { createWebhookDispatcher, createWebhookService } from './index.ts';
import type { WebhookRow } from './mappers.ts';
import { parseSignatureHeader, verifySignature } from './signature.ts';
import {
  countDeliveries,
  createOrgAndProject,
  createTestLogger,
  createTestMetrics,
  latestDelivery,
  liveEvent,
  seedWebhook,
  startReceiver,
} from './test-helpers.ts';

interface DispatchFixture {
  db: DatabaseSync;
  env: Env;
  bus: EventBus;
  dispatcher: WebhookDispatcher;
  projectId: string;
}

function setup(t: TestContext, overrides: Partial<Env> = {}): DispatchFixture {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const { projectId } = createOrgAndProject(db);
  const env = loadEnv({
    dbPath: ':memory:',
    webhooksEnabled: true,
    webhookWorkerIntervalMs: 3_600_000,
    webhookMaxAttempts: 6,
    webhookTimeoutMs: 2_000,
    webhookAllowPrivate: true,
    ...overrides,
  });
  const bus = new EventBus();
  const dispatcher = createWebhookDispatcher({
    db,
    env,
    bus,
    logger: createTestLogger(),
    metrics: createTestMetrics(),
  });
  t.after(() => {
    dispatcher.stop();
    db.close();
  });
  return { db, env, bus, dispatcher, projectId };
}

interface DeliveryRow {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  response_status: number | null;
  response_body: string | null;
  latency_ms: number | null;
  error: string | null;
  delivered_at: string | null;
  event_type: string;
}

interface WebhookRowShape {
  failure_count: number;
  last_status: number | null;
  last_delivery_at: string | null;
  enabled: number;
  disabled_at: string | null;
}

function deliveryOf(fx: DispatchFixture, webhookId: string): DeliveryRow {
  const row = latestDelivery(fx.db, webhookId);
  assert.ok(row, '缺少投递记录');
  return row as unknown as DeliveryRow;
}

function webhookRowOf(fx: DispatchFixture, webhookId: string): WebhookRowShape {
  return fx.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId) as unknown as WebhookRowShape;
}

test('投递成功：HMAC 头、payload 与数据库状态正确', async (t) => {
  const fx = setup(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const hook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
  });

  fx.dispatcher.start();
  fx.bus.publish(liveEvent(fx.projectId, 'memory.added', { memoryId: 'mem_1', category: 'fact' }));
  await fx.dispatcher.tickNow();

  assert.equal(receiver.requests.length, 1);
  const captured = receiver.requests[0];
  assert.ok(captured);
  assert.equal(captured.headers['content-type'], 'application/json');
  assert.equal(captured.headers['user-agent'], 'Mnemos-Webhook/1.0');
  assert.equal(captured.headers['x-mnemos-event'], 'memory.created');
  assert.equal(captured.headers['x-mnemos-project'], fx.projectId);
  assert.ok(captured.headers['x-mnemos-timestamp']);
  assert.match(String(captured.headers['x-mnemos-timestamp']), /^\d+$/);

  const signature = String(captured.headers['x-mnemos-signature']);
  assert.equal(verifySignature(hook.secret, captured.body, signature), true);
  assert.equal(verifySignature(hook.secret, `${captured.body} `, signature), false);
  assert.equal(String(parseSignatureHeader(signature)?.timestamp), captured.headers['x-mnemos-timestamp']);

  const payload = JSON.parse(captured.body) as WebhookEventPayload;
  assert.equal(payload.type, 'memory.created');
  assert.equal(payload.projectId, fx.projectId);
  assert.equal(payload.projectSlug, 'test');
  assert.equal(payload.actor, '测试用户');
  assert.equal(payload.data.summary, '测试事件');
  assert.equal(payload.data.memoryId, 'mem_1');
  assert.equal(payload.data.category, 'fact');

  const delivery = deliveryOf(fx, hook.id);
  assert.equal(captured.headers['x-mnemos-delivery'], delivery.id);
  assert.equal(delivery.event_type, 'memory.created');
  assert.equal(delivery.status, 'success');
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.response_status, 200);
  assert.ok(delivery.delivered_at);
  assert.equal(JSON.parse(delivery.response_body ?? '{}').ok, true);
  assert.equal(delivery.error, null);

  const webhook = webhookRowOf(fx, hook.id);
  assert.equal(webhook.last_status, 200);
  assert.equal(webhook.failure_count, 0);
  assert.ok(webhook.last_delivery_at);
});

test('重试：首次 500 → failed 且 next_attempt_at 位于未来；提前后重投成功', async (t) => {
  const fx = setup(t);
  const receiver = await startReceiver((_req, res, index) => {
    if (index === 0) {
      res.statusCode = 500;
      res.end('first attempt fails');
      return;
    }
    res.statusCode = 204;
    res.end();
  });
  t.after(() => receiver.close());

  const hook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
  });

  fx.dispatcher.start();
  fx.bus.publish(liveEvent(fx.projectId, 'memory.added'));
  await fx.dispatcher.tickNow();

  assert.equal(receiver.requests.length, 1);
  const failed = deliveryOf(fx, hook.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.response_status, 500);
  assert.equal(failed.delivered_at, null);
  assert.ok(failed.next_attempt_at);
  assert.ok(Date.parse(failed.next_attempt_at) > Date.now() + 3_000, 'next_attempt_at 应在未来（5s 退避）');
  assert.equal(webhookRowOf(fx, hook.id).failure_count, 1);

  fx.db
    .prepare('UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), failed.id);

  await fx.dispatcher.tickNow();

  assert.equal(receiver.requests.length, 2);
  const success = deliveryOf(fx, hook.id);
  assert.equal(success.status, 'success');
  assert.equal(success.attempts, 2);
  assert.equal(success.response_status, 204);
  assert.ok(success.delivered_at);
  assert.equal(success.next_attempt_at, null);
  assert.equal(webhookRowOf(fx, hook.id).failure_count, 0);

  await fx.dispatcher.tickNow();
  assert.equal(receiver.requests.length, 2, '成功后不应重复投递');
});

test('死信：max_attempts 用尽后进入 dead，不再重试', async (t) => {
  const fx = setup(t, { webhookMaxAttempts: 2 });
  const receiver = await startReceiver((_req, res) => {
    res.statusCode = 502;
    res.end('always fails');
  });
  t.after(() => receiver.close());

  const hook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
  });

  fx.dispatcher.start();
  fx.bus.publish(liveEvent(fx.projectId, 'memory.added'));
  await fx.dispatcher.tickNow();

  const first = deliveryOf(fx, hook.id);
  assert.equal(first.status, 'failed');
  assert.equal(first.attempts, 1);
  assert.equal(first.max_attempts, 2);

  fx.db
    .prepare('UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), first.id);
  await fx.dispatcher.tickNow();

  const dead = deliveryOf(fx, hook.id);
  assert.equal(dead.status, 'dead');
  assert.equal(dead.attempts, 2);
  assert.equal(dead.next_attempt_at, null);
  assert.ok(dead.error);

  await fx.dispatcher.tickNow();
  assert.equal(receiver.requests.length, 2, 'dead 后不再重试');
});

test('连续失败 ≥10 次自动禁用 webhook', async (t) => {
  const fx = setup(t);
  const receiver = await startReceiver((_req, res) => {
    res.statusCode = 500;
    res.end('fail');
  });
  t.after(() => receiver.close());

  const hook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
  });
  fx.db.prepare('UPDATE webhooks SET failure_count = 9 WHERE id = ?').run(hook.id);

  fx.dispatcher.start();
  fx.bus.publish(liveEvent(fx.projectId, 'memory.added'));
  await fx.dispatcher.tickNow();

  const webhook = webhookRowOf(fx, hook.id);
  assert.equal(webhook.failure_count, 10);
  assert.equal(webhook.enabled, 0);
  assert.ok(webhook.disabled_at);
});

test('过滤：只投递 enabled 且 event_types 匹配的 webhook；search.performed 不投递', async (t) => {
  const fx = setup(t);
  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const match = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
  });
  const other = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.updated'],
  });
  const disabled = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
    enabled: false,
  });
  const searchHook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['search.performed'],
  });

  fx.dispatcher.start();
  fx.bus.publish(liveEvent(fx.projectId, 'memory.added'));
  await fx.dispatcher.tickNow();

  assert.equal(countDeliveries(fx.db, match.id), 1);
  assert.equal(countDeliveries(fx.db, other.id), 0);
  assert.equal(countDeliveries(fx.db, disabled.id), 0);
  assert.equal(countDeliveries(fx.db, searchHook.id), 0);

  fx.bus.publish(liveEvent(fx.projectId, 'search.performed'));
  await fx.dispatcher.tickNow();
  assert.equal(countDeliveries(fx.db, match.id), 1);
  assert.equal(countDeliveries(fx.db, other.id), 0);
  assert.equal(countDeliveries(fx.db, searchHook.id), 0);

  fx.bus.publish(liveEvent(fx.projectId, 'memory.updated'));
  await fx.dispatcher.tickNow();
  assert.equal(countDeliveries(fx.db, match.id), 1);
  assert.equal(countDeliveries(fx.db, other.id), 1);

  // 其它项目的事件不会投递到本项目 webhook
  fx.bus.publish(liveEvent('proj_other', 'memory.added'));
  await fx.dispatcher.tickNow();
  assert.equal(countDeliveries(fx.db, match.id), 1);
  assert.equal(receiver.requests.length, 2);
});

test('webhooksEnabled=false：不订阅、tickNow 直接返回', async (t) => {
  const fx = setup(t, { webhooksEnabled: false });
  const receiver = await startReceiver();
  t.after(() => receiver.close());

  const hook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
  });

  fx.dispatcher.start();
  fx.bus.publish(liveEvent(fx.projectId, 'memory.added'));
  await fx.dispatcher.tickNow();

  assert.equal(countDeliveries(fx.db, hook.id), 0);
  assert.equal(receiver.requests.length, 0);
});

test('响应体截断到 2KB', async (t) => {
  const fx = setup(t);
  const receiver = await startReceiver((_req, res) => {
    res.statusCode = 500;
    res.end('x'.repeat(5_000));
  });
  t.after(() => receiver.close());

  const hook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
  });

  fx.dispatcher.start();
  fx.bus.publish(liveEvent(fx.projectId, 'memory.added'));
  await fx.dispatcher.tickNow();

  const delivery = deliveryOf(fx, hook.id);
  assert.equal(delivery.status, 'failed');
  assert.ok(delivery.response_body);
  assert.ok(Buffer.byteLength(delivery.response_body, 'utf8') <= 2_048);
});

test('测试投递失败不进入重试队列（max_attempts=1）', async (t) => {
  const fx = setup(t);
  const receiver = await startReceiver((_req, res) => {
    res.statusCode = 500;
    res.end('test endpoint fails');
  });
  t.after(() => receiver.close());

  const hook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: receiver.url,
    eventTypes: ['memory.created'],
  });
  const row = fx.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(hook.id) as unknown as WebhookRow;
  const service = createWebhookService({
    db: fx.db,
    env: fx.env,
    logger: createTestLogger(),
    metrics: createTestMetrics(),
  });

  const result = await service.sendTest(row, 'test', '测试用户');
  assert.equal(result.status, 'failed');
  assert.equal(result.responseStatus, 500);

  fx.dispatcher.start();
  await fx.dispatcher.tickNow();

  assert.equal(receiver.requests.length, 1, '测试投递不应被 worker 重试');
  const delivery = deliveryOf(fx, hook.id);
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.max_attempts, 1);
  assert.equal(delivery.next_attempt_at, null);
});

test('SSRF：投递前拒绝内网地址并记录失败原因', async (t) => {
  const fx = setup(t, { webhookAllowPrivate: false });
  const hook = seedWebhook(fx.db, {
    projectId: fx.projectId,
    url: 'http://127.0.0.1:9/hook',
    eventTypes: ['memory.created'],
  });

  fx.dispatcher.start();
  fx.bus.publish(liveEvent(fx.projectId, 'memory.added'));
  await fx.dispatcher.tickNow();

  const delivery = deliveryOf(fx, hook.id);
  assert.equal(delivery.status, 'failed');
  assert.match(String(delivery.error), /回环地址/);
  assert.equal(delivery.next_attempt_at !== null, true);
});
