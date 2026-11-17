import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword } from '../lib/password.ts';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/** v6.1 P0 HTTP 验收：检索 / 历史 / 反馈 / 幂等 / 设置字段 / jobs tick。 */

async function login(fx: HttpFixture, email = 'owner@test.dev', password = 'Demo123456'): Promise<string> {
  fx.db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), email);
  const res = await request(fx.baseUrl, 'POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'token'));
}

async function createPerson(fx: HttpFixture, externalId: string): Promise<string> {
  const res = await request(fx.baseUrl, 'PUT', `/v1/partitions/${fx.partitionSlug}/persons/${externalId}`, {
    key: fx.partitionKey,
    body: { type: 'human', display_name: externalId },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'id'));
}

test('v6.1 v1：search 返回 hits/signals/mode/strategy（兼容 results）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');
  for (const text of ['Alice 喜欢美式咖啡', '团队周一发布', 'Bob 负责检索模块']) {
    const res = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
      key: fx.partitionKey,
      body: { text, scope: 'partition' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }

  const search = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/memories/search', {
    key: fx.partitionKey,
    body: { query: '发布', top_k: 5 },
  });
  assert.equal(search.status, 200, JSON.stringify(search.json));
  assert.equal(field(search.json, 'mode'), 'hybrid');
  assert.ok(String(field(search.json, 'strategy')).startsWith('hybrid'));
  assert.ok(typeof field(search.json, 'took_ms') === 'number');
  const hits = field(search.json, 'hits') as Array<Record<string, unknown>>;
  assert.ok(hits.length >= 1);
  assert.ok(hits[0]?.signals && typeof hits[0].signals === 'object');
  assert.ok(Array.isArray(hits[0]?.matched_on));
  assert.ok(Array.isArray(field(search.json, 'results')));

  // keyword 模式
  const keyword = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/memories/search', {
    key: fx.partitionKey,
    body: { query: '检索', mode: 'keyword', top_k: 5 },
  });
  assert.equal(field(keyword.json, 'mode'), 'keyword');
  assert.ok((field(keyword.json, 'hits') as unknown[]).length >= 1);
});

test('v6.1 v1：history 与 feedback 端点', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');
  const created = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: { text: 'Alice 喜欢简洁周报', scope: 'partition' },
  });
  assert.equal(created.status, 201);
  const memoryId = String(field(created.json, 'memory.id'));

  const history = await request(fx.baseUrl, 'GET', `/v1/partitions/alpha/memories/${memoryId}/history`, {
    key: fx.partitionKey,
  });
  assert.equal(history.status, 200, JSON.stringify(history.json));
  const items = field(history.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(items[0]?.event, 'ADD');

  const feedback = await request(fx.baseUrl, 'POST', `/v1/partitions/alpha/memories/${memoryId}/feedback`, {
    key: fx.partitionKey,
    body: { helpful: true, query: '周报' },
  });
  assert.equal(feedback.status, 200, JSON.stringify(feedback.json));
  assert.equal(field(feedback.json, 'memory.feedback_up'), 1);
  assert.equal(field(feedback.json, 'memory.confidence'), 0.85);

  const after = await request(fx.baseUrl, 'GET', `/v1/partitions/alpha/memories/${memoryId}/history`, {
    key: fx.partitionKey,
  });
  const events = (field(after.json, 'items') as Array<Record<string, unknown>>).map((item) => item.event);
  assert.ok(events.includes('FEEDBACK'));
});

test('v6.1 幂等：相同 Idempotency-Key + body 回放，不同 body 409', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');
  const path = '/v1/partitions/alpha/persons/alice/memories';
  const body = { text: 'Alice 的幂等写入', scope: 'partition' };

  const first = await request(fx.baseUrl, 'POST', path, {
    key: fx.partitionKey,
    body,
    headers: { 'idempotency-key': 'idem-test-1' },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const replay = await request(fx.baseUrl, 'POST', path, {
    key: fx.partitionKey,
    body,
    headers: { 'idempotency-key': 'idem-test-1' },
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(field(replay.json, 'memory.id'), field(first.json, 'memory.id'));

  const conflict = await request(fx.baseUrl, 'POST', path, {
    key: fx.partitionKey,
    body: { text: '不同的内容', scope: 'partition' },
    headers: { 'idempotency-key': 'idem-test-1' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(field(conflict.json, 'error.code'), 'CONFLICT');

  const list = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/memories', { key: fx.partitionKey });
  assert.equal((field(list.json, 'items') as unknown[]).length, 1);
});

test('v6.1：partition settings 新字段（console + v1）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const token = await login(fx);
  const patched = await request(fx.baseUrl, 'PATCH', '/api/partitions/alpha', {
    session: token,
    body: {
      settings: {
        retrievalMode: 'keyword',
        retrievalWeights: { vector: 0.2, keyword: 0.8 },
        embeddingModel: 'mnemos-hash-384',
        mergeThreshold: 0.9,
        dedupeThreshold: 0.99,
        autoExtractEntities: false,
      },
    },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const settings = field(patched.json, 'settings') as Record<string, unknown>;
  assert.equal(settings.retrievalMode, 'keyword');
  assert.equal((settings.retrievalWeights as Record<string, number>).keyword, 0.8);
  assert.equal((settings.retrievalWeights as Record<string, number>).recency, 0.15, '未传权重沿用默认');
  assert.equal(settings.mergeThreshold, 0.9);
  assert.equal(settings.autoExtractEntities, false);

  const v1 = await request(fx.baseUrl, 'PATCH', '/v1/partitions/alpha', {
    key: fx.orgKey,
    body: {
      settings: {
        retrieval_mode: 'vector',
        retrieval_weights: { vector: 0.9 },
        merge_threshold: 0.8,
        dedupe_threshold: 0.97,
        auto_extract_entities: true,
      },
    },
  });
  assert.equal(v1.status, 200, JSON.stringify(v1.json));
  assert.equal(field(v1.json, 'settings.retrieval_mode'), 'vector');
  assert.equal(field(v1.json, 'settings.merge_threshold'), 0.8);
  assert.equal(field(v1.json, 'settings.auto_extract_entities'), true);
});

test('v6.1：写接口支持 fact_key / valid_from / supersedes_id，jobs tick 仅 admin', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'alice');
  const path = '/v1/partitions/alpha/persons/alice/memories';
  const first = await request(fx.baseUrl, 'POST', path, {
    key: fx.partitionKey,
    body: { text: 'Alice 偏好中文回答', fact_key: 'preference.language', valid_from: '2024-01-01T00:00:00.000Z' },
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(field(first.json, 'memory.fact_key'), 'preference.language');
  assert.equal(field(first.json, 'memory.valid_from'), '2024-01-01T00:00:00.000Z');
  const firstId = String(field(first.json, 'memory.id'));

  const second = await request(fx.baseUrl, 'POST', path, {
    key: fx.partitionKey,
    body: { text: 'Alice 偏好英文回答', fact_key: 'preference.language' },
  });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(field(second.json, 'event'), 'SUPERSEDE');
  assert.equal(field(second.json, 'superseded_id'), firstId);

  const token = await login(fx);
  const tick = await request(fx.baseUrl, 'POST', '/api/ops/jobs/tick', { session: token, body: { limit: 10 } });
  assert.equal(tick.status, 200, JSON.stringify(tick.json));
  assert.ok(typeof field(tick.json, 'processed') === 'number');

  const devToken = await login(fx, 'developer@test.dev');
  const denied = await request(fx.baseUrl, 'POST', '/api/ops/jobs/tick', { session: devToken, body: {} });
  assert.equal(denied.status, 403);
});

test('v6.1 console：search / history / feedback（控制台 camelCase 契约）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const token = await login(fx);
  await createPerson(fx, 'alice');
  const created = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/memories', {
    session: token,
    body: { text: 'Alice 喜欢简洁周报', scope: 'person', category: 'preference' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const memoryId = String(field(created.json, 'memory.id'));

  const search = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/memories/search', {
    session: token,
    body: { query: '周报', topK: 5, includePrivate: true },
  });
  assert.equal(search.status, 200, JSON.stringify(search.json));
  assert.equal(field(search.json, 'mode'), 'hybrid');
  assert.equal(typeof field(search.json, 'tookMs'), 'number');
  assert.equal(field(search.json, 'took_ms'), field(search.json, 'tookMs'));
  const hits = field(search.json, 'hits') as Array<Record<string, unknown>>;
  assert.ok(hits.length >= 1);
  assert.ok(Array.isArray(hits[0]?.matchedOn));

  const history = await request(fx.baseUrl, 'GET', `/api/partitions/alpha/memories/${memoryId}/history`, {
    session: token,
  });
  assert.equal(history.status, 200);
  const historyItems = field(history.json, 'items') as Array<Record<string, unknown>> | undefined;
  const list = Array.isArray(history.json) ? (history.json as Array<Record<string, unknown>>) : (historyItems ?? []);
  assert.equal(list[0]?.event, 'ADD');

  const feedback = await request(fx.baseUrl, 'POST', `/api/partitions/alpha/memories/${memoryId}/feedback`, {
    session: token,
    body: { helpful: false, query: '周报' },
  });
  assert.equal(feedback.status, 200, JSON.stringify(feedback.json));
  assert.equal(field(feedback.json, 'memory.feedbackDown'), 1);
  assert.ok((field(feedback.json, 'memory.confidence') as number) < 0.8);
});
