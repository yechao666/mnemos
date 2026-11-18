import assert from 'node:assert/strict';
import test from 'node:test';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/** 公开 v1 API（snake_case）端到端测试。 */

async function createPerson(
  fx: HttpFixture,
  externalId: string,
  body: Record<string, unknown> = { type: 'human', display_name: externalId },
): Promise<string> {
  const res = await request(fx.baseUrl, 'PUT', `/v1/partitions/${fx.partitionSlug}/persons/${externalId}`, {
    key: fx.partitionKey,
    body,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'id'));
}

test('v1 鉴权：key 缺失/无效、分区越权、org key 跨分区、只读 key', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const missing = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons');
  assert.equal(missing.status, 401);
  assert.equal(field(missing.json, 'error.code'), 'INVALID_API_KEY');

  const invalid = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons', { key: 'mnemos_live_nope' });
  assert.equal(invalid.status, 401);

  const read = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons', { key: fx.partitionReadKey });
  assert.equal(read.status, 200);
  assert.ok(Array.isArray(field(read.json, 'items')));

  const writeDenied = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionReadKey,
    body: { text: 'x' },
  });
  assert.equal(writeDenied.status, 403);

  // 分区 key 不能访问其它分区
  const cross = await request(fx.baseUrl, 'GET', '/v1/partitions/beta/persons', { key: fx.partitionKey });
  assert.equal(cross.status, 404);

  // org key 可以访问任意分区
  const orgBeta = await request(fx.baseUrl, 'GET', '/v1/partitions/beta/persons', { key: fx.orgKey });
  assert.equal(orgBeta.status, 200);

  // 外部组织的 org key 看不到本组织分区
  const foreign = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons', { key: fx.foreignOrgKey });
  assert.equal(foreign.status, 404);

  // 分区 key 不能创建分区；org key + admin 可以
  const deniedCreate = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    key: fx.partitionKey,
    body: { slug: 'gamma' },
  });
  assert.equal(deniedCreate.status, 403);

  const created = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    key: fx.orgKey,
    body: { slug: 'gamma', name: 'Gamma' },
  });
  assert.equal(created.status, 200);
  assert.equal(field(created.json, 'slug'), 'gamma');
});

test('v1 分区：upsert 幂等、列表、详情、设置、统计', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const first = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    key: fx.orgKey,
    body: { slug: 'gamma', name: 'Gamma', settings: { default_scope: 'person', brief_max_chars: 600 } },
  });
  const gammaId = String(field(first.json, 'id'));
  const again = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    key: fx.orgKey,
    body: { slug: 'gamma', name: 'Gamma 2' },
  });
  assert.equal(field(again.json, 'id'), gammaId, '同 slug 幂等 upsert');
  assert.equal(field(again.json, 'name'), 'Gamma 2');
  assert.equal(field(again.json, 'settings.default_scope'), 'person');
  assert.equal(field(again.json, 'settings.brief_max_chars'), 600);

  const list = await request(fx.baseUrl, 'GET', '/v1/partitions', { key: fx.orgKey });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json));
  const slugs = (list.json as Array<Record<string, unknown>>).map((item) => item.slug);
  assert.deepEqual(slugs.sort(), ['alpha', 'beta', 'gamma']);

  const detail = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha', { key: fx.partitionKey });
  assert.equal(detail.status, 200);
  assert.equal(field(detail.json, 'id'), fx.partitionId);
  assert.equal(field(detail.json, 'org_id'), fx.orgId);

  const patched = await request(fx.baseUrl, 'PATCH', '/v1/partitions/alpha', {
    key: fx.partitionKey,
    body: { name: 'Alpha 新名', settings: { dream_enabled: false } },
  });
  assert.equal(patched.status, 200);
  assert.equal(field(patched.json, 'name'), 'Alpha 新名');
  assert.equal(field(patched.json, 'settings.dream_enabled'), false);

  const stats = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/stats', { key: fx.partitionKey });
  assert.equal(stats.status, 200);
  assert.equal(field(stats.json, 'partition_id'), fx.partitionId);
  assert.equal(field(stats.json, 'persons_total'), 0);
});

test('v1 人：PUT 建档/更新、详情、游标列表、FTS 搜索、PATCH', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const aliceId = await createPerson(fx, 'user_1001', { type: 'human', display_name: '张小明' });
  await createPerson(fx, 'user_1002', { type: 'human', display_name: '李雷' });
  await createPerson(fx, 'agent_alpha', { type: 'agent', display_name: '阿尔法' });

  // 幂等更新
  const updated = await request(fx.baseUrl, 'PUT', '/v1/partitions/alpha/persons/user_1001', {
    key: fx.partitionKey,
    body: { display_name: '张小明（更新）' },
  });
  assert.equal(field(updated.json, 'id'), aliceId);
  assert.equal(field(updated.json, 'display_name'), '张小明（更新）');

  const byExternal = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/user_1001', {
    key: fx.partitionKey,
  });
  assert.equal(field(byExternal.json, 'external_id'), 'user_1001');
  assert.equal(field(byExternal.json, 'memory_count'), 0);

  const byId = await request(fx.baseUrl, 'GET', `/v1/partitions/alpha/persons/${aliceId}`, {
    key: fx.partitionKey,
  });
  assert.equal(byId.status, 200);
  assert.equal(field(byId.json, 'external_id'), 'user_1001');

  const page1 = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons?limit=2&sort=name', {
    key: fx.partitionKey,
  });
  assert.equal(page1.status, 200);
  assert.equal((field(page1.json, 'items') as unknown[]).length, 2);
  assert.ok(field(page1.json, 'next_cursor'));
  assert.equal(field(page1.json, 'partition_stats.persons_total'), 3);

  const page2 = await request(
    fx.baseUrl,
    'GET',
    `/v1/partitions/alpha/persons?limit=2&sort=name&cursor=${encodeURIComponent(String(field(page1.json, 'next_cursor')))}`,
    { key: fx.partitionKey },
  );
  assert.equal((field(page2.json, 'items') as unknown[]).length, 1);
  assert.equal(field(page2.json, 'next_cursor'), null);

  const search = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons?q=user_100', {
    key: fx.partitionKey,
  });
  assert.deepEqual(
    (field(search.json, 'items') as Array<Record<string, unknown>>).map((item) => item.external_id).sort(),
    ['user_1001', 'user_1002'],
  );

  const byType = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons?type=agent', {
    key: fx.partitionKey,
  });
  assert.equal((field(byType.json, 'items') as unknown[]).length, 1);

  const patched = await request(fx.baseUrl, 'PATCH', '/v1/partitions/alpha/persons/user_1001', {
    key: fx.partitionKey,
    body: { display_name: '张小明 2', attributes: { team: 'pm' } },
  });
  assert.equal(field(patched.json, 'display_name'), '张小明 2');
  assert.equal(field(patched.json, 'attributes.team'), 'pm');
});

test('v1 记忆：写入/列表/筛选/详情/更新/删除/搜索', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const aliceId = await createPerson(fx, 'alice');
  const bobId = await createPerson(fx, 'bob');

  const created = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: { text: 'Alice 喜欢美式咖啡', scope: 'person', category: 'preference', tags: ['drink'] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const memoryId = String(field(created.json, 'memory.id'));
  assert.equal(field(created.json, 'memory.scope'), 'person');
  assert.equal(field(created.json, 'memory.person_external_id'), 'alice');
  assert.equal(field(created.json, 'memory.person_id'), aliceId);

  // 默认 scope 取分区设置（alpha settings '{}' → partition）
  const shared = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/bob/memories', {
    key: fx.partitionKey,
    body: { text: '团队周一发布', category: 'decision' },
  });
  assert.equal(field(shared.json, 'memory.scope'), 'partition');

  const personList = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
  });
  assert.equal((field(personList.json, 'items') as unknown[]).length, 1);
  assert.ok(field(personList.json, 'partition_stats'));
  assert.equal(field(personList.json, 'partition_stats.memories_total'), 2);
  assert.equal(field(personList.json, 'partition_stats.shared_total'), 1);

  const globalList = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/memories?scope=partition', {
    key: fx.partitionKey,
  });
  assert.equal((field(globalList.json, 'items') as unknown[]).length, 1);
  assert.equal(field(globalList.json, 'items.0.person_external_id'), 'bob');

  const detail = await request(fx.baseUrl, 'GET', `/v1/partitions/alpha/memories/${memoryId}`, {
    key: fx.partitionKey,
  });
  assert.equal(detail.status, 200);
  assert.equal(field(detail.json, 'memory.content'), 'Alice 喜欢美式咖啡');
  assert.equal(field(detail.json, 'person.external_id'), 'alice');

  const patched = await request(fx.baseUrl, 'PATCH', `/v1/partitions/alpha/memories/${memoryId}`, {
    key: fx.partitionKey,
    body: { content: 'Alice 改喝拿铁', importance: 0.9 },
  });
  assert.equal(field(patched.json, 'memory.content'), 'Alice 改喝拿铁');

  const q = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/memories?q=拿铁', { key: fx.partitionKey });
  assert.equal((field(q.json, 'items') as unknown[]).length, 1);

  const search = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/memories/search', {
    key: fx.partitionKey,
    body: { query: '发布', top_k: 5 },
  });
  assert.equal(search.status, 200);
  assert.equal((field(search.json, 'results') as unknown[]).length, 1);

  // session scope 必须带 session_id
  const invalidSession = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: { text: 'x', scope: 'session' },
  });
  assert.equal(invalidSession.status, 400);
  assert.equal(field(invalidSession.json, 'error.code'), 'VALIDATION');

  const sessionMemory = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: { text: '会话内约定', scope: 'session', session_id: 'conv_1', session_title: '第一轮' },
  });
  assert.equal(sessionMemory.status, 201);
  assert.equal(field(sessionMemory.json, 'memory.session_id'), 'conv_1');

  const removed = await request(fx.baseUrl, 'DELETE', `/v1/partitions/alpha/memories/${memoryId}`, {
    key: fx.partitionKey,
  });
  assert.equal(removed.status, 204);
  const gone = await request(fx.baseUrl, 'GET', `/v1/partitions/alpha/memories/${memoryId}`, {
    key: fx.partitionKey,
  });
  assert.equal(gone.status, 404);
});

test('v1 简报 / 上下文 / 做梦（人级 + 分区级）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  await createPerson(fx, 'alice');
  for (const text of ['Alice 偏好简洁周报', 'Alice 负责感恩日记', '团队约定周一发布']) {
    const res = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
      key: fx.partitionKey,
      body: { text, scope: text.startsWith('团队') ? 'partition' : 'person' },
    });
    assert.equal(res.status, 201);
  }

  const brief = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/brief', {
    key: fx.partitionKey,
  });
  assert.equal(brief.status, 200);
  assert.ok(String(field(brief.json, 'text')).length > 0);
  assert.equal(field(brief.json, 'count'), 3);
  assert.equal(field(brief.json, 'cached'), false);
  const brief2 = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/brief?force=false', {
    key: fx.partitionKey,
  });
  assert.equal(field(brief2.json, 'cached'), true);

  const context = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/context', {
    key: fx.partitionKey,
    body: { query: '周报', budget_tokens: 1200 },
  });
  assert.equal(context.status, 200);
  assert.equal(field(context.json, 'person.external_id'), 'alice');
  assert.match(String(field(context.json, 'prompt')), /## 人物资料/);
  assert.ok((field(context.json, 'citations') as unknown[]).length > 0);
  assert.ok(Number(field(context.json, 'token_estimate')) > 0);

  const dreamStatus = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/dream', {
    key: fx.partitionKey,
  });
  assert.equal(field(dreamStatus.json, 'pending_count'), 2);

  const run = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/dream/run', {
    key: fx.partitionKey,
    body: { batch_size: 10 },
  });
  assert.equal(run.status, 200);
  assert.equal(field(run.json, 'run.status'), 'completed');
  assert.equal(field(run.json, 'run.input_count'), 2);
  assert.equal(field(run.json, 'status.pending_count'), 0);

  const after = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons/alice/dream', {
    key: fx.partitionKey,
  });
  assert.equal(field(after.json, 'pending_count'), 0);

  const partitionDream = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/dream', { key: fx.partitionKey });
  assert.equal(field(partitionDream.json, 'pending_count'), 1);
  const partitionRun = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/dream/run', {
    key: fx.partitionKey,
    body: {},
  });
  assert.equal(field(partitionRun.json, 'run.status'), 'completed');
});

test('v1 旧的领域端点已移除（404）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  for (const path of [
    '/v1/memories',
    '/v1/agents',
    '/v1/tasks',
    '/v1/projects',
    '/v1/context',
    '/v1/partitions/alpha/agents',
    '/v1/partitions/alpha/tasks',
    // 注意：/v1/partitions/alpha/graph 在 v6.1 P2 已重新作为实体关系图端点（见 p2.test.ts）。
  ]) {
    const res = await request(fx.baseUrl, 'GET', path, { key: fx.orgKey });
    assert.equal(res.status, 404, `${path} 应返回 404`);
  }

  const health = await request(fx.baseUrl, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(field(health.json, 'ok'), true);
  assert.equal(field(health.json, 'schemaVersion'), 9);
});
