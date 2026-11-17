import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/**
 * 中立记忆服务 v5 的 HTTP 路由级测试：
 *  - v1 中立面：分区 / 人 / 记忆 / 简报 / 上下文 / 做梦；
 *  - org key 与 project key 的鉴权边界；
 *  - 控制台 /api 人维度与角色分层、org key 管理；
 *  - 旧 v1 API 兼容回归（user_id/agent_id/visibility ↔ person/scope）。
 */

async function fixture(t: TestContext): Promise<HttpFixture> {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  return fx;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), '期望 JSON 对象');
  return value as Record<string, unknown>;
}

function asArray(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), '期望 JSON 数组');
  return value as Record<string, unknown>[];
}

/* ------------------------------------------------------------------ */
/* 一、分区与 org key / project key 边界                               */
/* ------------------------------------------------------------------ */

test('org key 按 slug 幂等建分区；project key 不可建分区', async (t) => {
  const fx = await fixture(t);

  const first = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    key: fx.orgKey,
    body: { slug: 'ws-demo', name: '演示工作区', description: 'DSH 工作区' },
  });
  assert.equal(first.status, 201);
  const partition = asRecord(field(first.json, 'partition'));
  assert.match(String(partition.id), /^prj_/);
  assert.equal(partition.slug, 'ws-demo');
  assert.equal(partition.name, '演示工作区');
  assert.equal(field(first.json, 'created'), true);

  const second = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    key: fx.orgKey,
    body: { slug: 'ws-demo', name: '改名后的工作区' },
  });
  assert.equal(second.status, 200);
  assert.equal(field(second.json, 'created'), false);
  assert.equal(field(second.json, 'partition.id'), partition.id);
  assert.equal(field(second.json, 'partition.name'), '改名后的工作区');

  const bySlug = await request(fx.baseUrl, 'GET', '/v1/partitions/ws-demo', { key: fx.orgKey });
  assert.equal(bySlug.status, 200);
  assert.equal(field(bySlug.json, 'partition.id'), partition.id);

  const byId = await request(fx.baseUrl, 'GET', `/v1/partitions/${String(partition.id)}`, { key: fx.orgKey });
  assert.equal(byId.status, 200);
  assert.equal(field(byId.json, 'partition.slug'), 'ws-demo');

  // project key 即使有 admin scope 也不能建分区（org key 专属）。
  const projectCreate = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    key: fx.projectKey,
    body: { slug: 'project-owned' },
  });
  assert.equal(projectCreate.status, 403);
  assert.equal(field(projectCreate.json, 'error.code'), 'FORBIDDEN');
});

test('project key 只能访问自身分区；org key 可访问本组织任意分区', async (t) => {
  const fx = await fixture(t);

  const own = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha', { key: fx.projectKey });
  assert.equal(own.status, 200);
  assert.equal(field(own.json, 'partition.id'), fx.projectId);

  const other = await request(fx.baseUrl, 'GET', '/v1/partitions/beta', { key: fx.projectKey });
  assert.equal(other.status, 404);

  for (const ref of ['beta', fx.betaId]) {
    const viaOrg = await request(fx.baseUrl, 'GET', `/v1/partitions/${ref}`, { key: fx.orgKey });
    assert.equal(viaOrg.status, 200, `org key 应能访问 ${ref}`);
    assert.equal(field(viaOrg.json, 'partition.id'), fx.betaId);
  }

  // 其他组织的分区对 org key 也是 404（不泄露存在性）。
  const foreign = await request(fx.baseUrl, 'GET', '/v1/partitions/foreign', { key: fx.orgKey });
  assert.equal(foreign.status, 404);

  // 只读 key 写记忆 → 403（scope 校验保留）。
  const readOnlyWrite = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/memories', {
    key: fx.projectReadKey,
    body: { text: 'x', infer: false },
  });
  assert.equal(readOnlyWrite.status, 403);
  assert.equal(field(readOnlyWrite.json, 'error.code'), 'FORBIDDEN');

  // org key 不能隐式落到锚点分区调用旧分区级端点。
  const orgOnLegacy = await request(fx.baseUrl, 'GET', '/v1/memories', { key: fx.orgKey });
  assert.equal(orgOnLegacy.status, 403);

  // 旧 /v1/projects/:id 是 /v1/partitions/:id 的别名。
  const alias = await request(fx.baseUrl, 'GET', '/v1/projects/alpha', { key: fx.orgKey });
  assert.equal(alias.status, 200);
  assert.equal(field(alias.json, 'partition.id'), fx.projectId);
});

/* ------------------------------------------------------------------ */
/* 二、v1 人 CRUD                                                       */
/* ------------------------------------------------------------------ */

test('v1 人：PUT upsert / 列表 / 详情 / PATCH / external 歧义', async (t) => {
  const fx = await fixture(t);
  const base = '/v1/partitions/alpha';

  const created = await request(fx.baseUrl, 'PUT', `${base}/persons/user-123`, {
    key: fx.orgKey,
    body: { type: 'human', display_name: '张三', attributes: { tier: 'gold' } },
  });
  assert.equal(created.status, 200);
  const person = asRecord(field(created.json, 'person'));
  assert.match(String(person.id), /^prs_/);
  assert.equal(person.external_id, 'user-123');
  assert.equal(person.type, 'human');
  assert.equal(person.display_name, '张三');
  assert.deepEqual(person.attributes, { tier: 'gold' });
  assert.equal(field(person, 'stats.memories'), 0);

  const agent = await request(fx.baseUrl, 'PUT', `${base}/persons/agent-a`, {
    key: fx.orgKey,
    body: { type: 'agent', display_name: '代码智能体 A' },
  });
  assert.equal(agent.status, 200);
  assert.equal(field(agent.json, 'person.type'), 'agent');

  const list = await request(fx.baseUrl, 'GET', `${base}/persons?type=human&q=张`, { key: fx.orgKey });
  assert.equal(list.status, 200);
  assert.equal(field(list.json, 'count'), 1);
  const people = asArray(field(list.json, 'results'));
  assert.equal(people[0]?.external_id, 'user-123');
  assert.equal(field(list.json, 'page'), 1);
  assert.equal(field(list.json, 'page_size'), 20);

  const detail = await request(fx.baseUrl, 'GET', `${base}/persons/user-123`, { key: fx.orgKey });
  assert.equal(detail.status, 200);
  assert.equal(field(detail.json, 'person.id'), person.id);

  const patched = await request(fx.baseUrl, 'PATCH', `${base}/persons/user-123`, {
    key: fx.orgKey,
    body: { display_name: '张三（VIP）', status: 'archived' },
  });
  assert.equal(patched.status, 200);
  assert.equal(field(patched.json, 'person.display_name'), '张三（VIP）');
  assert.equal(field(patched.json, 'person.status'), 'archived');

  // 同一 external_id 同时存在 human / agent：GET 不猜，返回 404。
  await request(fx.baseUrl, 'PUT', `${base}/persons/shared-id`, {
    key: fx.orgKey,
    body: { type: 'human' },
  });
  await request(fx.baseUrl, 'PUT', `${base}/persons/shared-id`, {
    key: fx.orgKey,
    body: { type: 'agent' },
  });
  const ambiguous = await request(fx.baseUrl, 'GET', `${base}/persons/shared-id`, { key: fx.orgKey });
  assert.equal(ambiguous.status, 404);

  const invalidType = await request(fx.baseUrl, 'PUT', `${base}/persons/bad-type`, {
    key: fx.orgKey,
    body: { type: 'robot' },
  });
  assert.equal(invalidType.status, 400);

  const missing = await request(fx.baseUrl, 'GET', `${base}/persons/nobody`, { key: fx.orgKey });
  assert.equal(missing.status, 404);
});

/* ------------------------------------------------------------------ */
/* 三、按人写 / 查（隔离）                                              */
/* ------------------------------------------------------------------ */

test('v1 记忆：按人写入与检索隔离、scope 语义校验', async (t) => {
  const fx = await fixture(t);
  const base = '/v1/partitions/alpha';

  for (const externalId of ['user-123', 'user-456']) {
    const created = await request(fx.baseUrl, 'PUT', `${base}/persons/${externalId}`, {
      key: fx.orgKey,
      body: { type: 'human' },
    });
    assert.equal(created.status, 200);
  }

  const addA = await request(fx.baseUrl, 'POST', `${base}/memories`, {
    key: fx.orgKey,
    body: { text: '用户 123 喜欢喝黑咖啡，不加糖', person_id: 'user-123', scope: 'person', infer: false },
  });
  assert.equal(addA.status, 200);
  const memoryA = asRecord(asArray(field(addA.json, 'results'))[0]);
  assert.equal(memoryA.scope, 'person');
  assert.equal(memoryA.person_external_id, 'user-123');
  assert.equal(typeof memoryA.person_id, 'string');

  const addB = await request(fx.baseUrl, 'POST', `${base}/memories`, {
    key: fx.orgKey,
    body: { text: '用户 456 对牛奶过敏，需要避开乳制品', person_external_id: 'user-456', scope: 'person', infer: false },
  });
  assert.equal(addB.status, 200);

  const shared = await request(fx.baseUrl, 'POST', `${base}/memories`, {
    key: fx.orgKey,
    body: { text: '团队约定：每周五下午做记忆复盘', scope: 'partition', infer: false },
  });
  assert.equal(shared.status, 200);
  assert.equal(field(shared.json, 'results.0.scope'), 'partition');

  // 检索按人隔离：以 user-123 视角搜「牛奶」不应看到 user-456 的私有记忆。
  const searchA = await request(fx.baseUrl, 'POST', `${base}/memories/search`, {
    key: fx.orgKey,
    body: { query: '牛奶', person_id: 'user-123' },
  });
  assert.equal(searchA.status, 200);
  assert.equal(field(searchA.json, 'count'), 0);
  assert.equal(typeof field(searchA.json, 'took_ms'), 'number');

  const searchB = await request(fx.baseUrl, 'POST', `${base}/memories/search`, {
    key: fx.orgKey,
    body: { query: '牛奶', person_id: 'user-456' },
  });
  assert.equal(searchB.status, 200);
  assert.equal(field(searchB.json, 'count'), 1);
  assert.equal(field(searchB.json, 'results.0.person_external_id'), 'user-456');

  const searchShared = await request(fx.baseUrl, 'POST', `${base}/memories/search`, {
    key: fx.orgKey,
    body: { query: '复盘', scope: 'partition' },
  });
  assert.equal(searchShared.status, 200);
  assert.equal(field(searchShared.json, 'count'), 1);

  // 列表按人过滤（控制台审计视角 include_private=true 才能看到该人私有记忆）。
  const listA = await request(
    fx.baseUrl,
    'GET',
    `${base}/memories?person_id=user-123&include_private=true&page_size=50`,
    { key: fx.orgKey },
  );
  assert.equal(listA.status, 200);
  const itemsA = asArray(field(listA.json, 'results'));
  assert.equal(itemsA.length, 1);
  assert.equal(itemsA[0]?.person_external_id, 'user-123');
  assert.equal(field(listA.json, 'count'), 1);

  // 默认调用方视角（include_private=false）+ person=user-123：只看该人自己的 person 记忆。
  const listOwn = await request(fx.baseUrl, 'GET', `${base}/memories?person_id=user-123&page_size=50`, {
    key: fx.orgKey,
  });
  assert.equal(listOwn.status, 200);
  assert.equal(field(listOwn.json, 'count'), 1);

  // scope 语义校验：person 无 person / session 无 session → 422。
  const badScopePerson = await request(fx.baseUrl, 'POST', `${base}/memories`, {
    key: fx.orgKey,
    body: { text: '没有归属人的私有记忆', scope: 'person', infer: false },
  });
  assert.equal(badScopePerson.status, 422);

  const badScopeSession = await request(fx.baseUrl, 'POST', `${base}/memories`, {
    key: fx.orgKey,
    body: { text: '没有会话的会话记忆', scope: 'session', infer: false },
  });
  assert.equal(badScopeSession.status, 422);

  // 记忆详情 / 修改 / 删除。
  const memoryId = String(memoryA.id);
  const detail = await request(fx.baseUrl, 'GET', `${base}/memories/${memoryId}`, { key: fx.orgKey });
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(field(detail.json, 'history')));

  const updated = await request(fx.baseUrl, 'PATCH', `${base}/memories/${memoryId}`, {
    key: fx.orgKey,
    body: { importance: 0.9 },
  });
  assert.equal(updated.status, 200);
  assert.equal(field(updated.json, 'importance'), 0.9);

  const removed = await request(fx.baseUrl, 'DELETE', `${base}/memories/${memoryId}`, { key: fx.orgKey });
  assert.equal(removed.status, 200);
  assert.equal(field(removed.json, 'ok'), true);

  const gone = await request(fx.baseUrl, 'GET', `${base}/memories/${memoryId}`, { key: fx.orgKey });
  assert.equal(gone.status, 200, '软删除后仍可按 id 读取（status=deleted）');
  assert.equal(field(gone.json, 'status'), 'deleted');
});

/* ------------------------------------------------------------------ */
/* 四、人级简报 / 上下文 / 做梦                                         */
/* ------------------------------------------------------------------ */

test('v1 人级 brief / context / dream', async (t) => {
  const fx = await fixture(t);
  const base = '/v1/partitions/alpha';

  await request(fx.baseUrl, 'PUT', `${base}/persons/user-123`, {
    key: fx.orgKey,
    body: { type: 'human', display_name: '张三', attributes: { role: '产品经理' } },
  });
  for (const text of ['张三负责知物感恩 App 的产品规划', '张三偏好每周一上午做需求评审']) {
    const added = await request(fx.baseUrl, 'POST', `${base}/memories`, {
      key: fx.orgKey,
      body: { text, person_id: 'user-123', scope: 'person', infer: false },
    });
    assert.equal(added.status, 200);
  }
  await request(fx.baseUrl, 'POST', `${base}/memories`, {
    key: fx.orgKey,
    body: { text: '团队共享：所有需求评审需要提前一天预约会议室', scope: 'partition', infer: false },
  });

  const brief = await request(fx.baseUrl, 'GET', `${base}/persons/user-123/brief`, { key: fx.orgKey });
  assert.equal(brief.status, 200);
  const briefText = String(field(brief.json, 'text'));
  assert.ok(briefText.includes('张三'), `简报应包含该人记忆：${briefText}`);
  assert.equal(typeof field(brief.json, 'max_chars'), 'number');
  assert.equal(typeof field(brief.json, 'person_id'), 'string');
  assert.ok(asArray(field(brief.json, 'recent')).length >= 1);

  const context = await request(fx.baseUrl, 'POST', `${base}/persons/user-123/context`, {
    key: fx.orgKey,
    body: { query: '评审', include_partition: true },
  });
  assert.equal(context.status, 200);
  assert.equal(field(context.json, 'person.external_id'), 'user-123');
  const prompt = String(field(context.json, 'prompt'));
  assert.ok(prompt.includes('# 人的上下文'), 'prompt 应包含人物上下文标题');
  assert.ok(asArray(field(context.json, 'memories')).length >= 1);
  assert.equal(typeof field(context.json, 'token_estimate'), 'number');
  assert.ok(Number(field(context.json, 'token_estimate')) > 0);

  const status = await request(fx.baseUrl, 'GET', `${base}/persons/user-123/dream`, { key: fx.orgKey });
  assert.equal(status.status, 200);
  assert.equal(typeof field(status.json, 'pending_count'), 'number');
  assert.ok(Number(field(status.json, 'pending_count')) >= 2);
  assert.equal(typeof field(status.json, 'person_id'), 'string');
  assert.deepEqual(asArray(field(status.json, 'runs')), []);

  const run = await request(fx.baseUrl, 'POST', `${base}/persons/user-123/dream/run`, { key: fx.orgKey });
  assert.equal(run.status, 200);
  const runRecord = asRecord(field(run.json, 'run'));
  assert.match(String(runRecord.id), /^dream_/);
  assert.ok(['completed', 'skipped'].includes(String(runRecord.status)));

  const after = await request(fx.baseUrl, 'GET', `${base}/persons/user-123/dream`, { key: fx.orgKey });
  assert.equal(after.status, 200);
  assert.ok(asArray(field(after.json, 'runs')).length >= 1);
  assert.equal(field(after.json, 'last_run.id'), runRecord.id);

  // 不存在的做梦人 → 404（人级状态接口）。
  const missing = await request(fx.baseUrl, 'GET', `${base}/persons/nobody/dream`, { key: fx.orgKey });
  assert.equal(missing.status, 404);
});

/* ------------------------------------------------------------------ */
/* 五、控制台 /api 人维度与角色分层                                     */
/* ------------------------------------------------------------------ */

test('控制台人维度：viewer 读 / admin 写；记忆列表按人过滤', async (t) => {
  const fx = await fixture(t);
  const base = '/api/projects/prj_alpha';

  const list = await request(fx.baseUrl, 'GET', `${base}/persons?pageSize=50`, { session: fx.sessions.viewer });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(field(list.json, 'items')));
  assert.equal(field(list.json, 'page'), 1);

  const viewerWrite = await request(fx.baseUrl, 'PUT', `${base}/persons/user-777`, {
    session: fx.sessions.viewer,
    body: { displayName: '越权写入' },
  });
  assert.equal(viewerWrite.status, 403);

  const developerWrite = await request(fx.baseUrl, 'PUT', `${base}/persons/user-777`, {
    session: fx.sessions.developer,
    body: { displayName: '开发也需 admin' },
  });
  assert.equal(developerWrite.status, 403);

  const adminWrite = await request(fx.baseUrl, 'PUT', `${base}/persons/user-777`, {
    session: fx.sessions.admin,
    body: { type: 'human', displayName: '控制台建档', attributes: { source: 'console' } },
  });
  assert.equal(adminWrite.status, 200);
  const personId = String(field(adminWrite.json, 'id'));
  assert.match(personId, /^prs_/);
  assert.equal(field(adminWrite.json, 'externalId'), 'user-777');
  assert.equal(field(adminWrite.json, 'partitionId'), 'prj_alpha');

  const patched = await request(fx.baseUrl, 'PATCH', `${base}/persons/user-777`, {
    session: fx.sessions.admin,
    body: { displayName: '改名' },
  });
  assert.equal(patched.status, 200);
  assert.equal(field(patched.json, 'displayName'), '改名');

  // 控制台写入必须能用 playground 新字段（personExternalId / scope / sessionId）。
  const add = await request(fx.baseUrl, 'POST', `${base}/playground/add`, {
    session: fx.sessions.admin,
    body: {
      text: '控制台写入的私有记忆，属于 user-777',
      personExternalId: 'user-777',
      scope: 'person',
      infer: false,
    },
  });
  assert.equal(add.status, 200);
  assert.equal(field(add.json, 'results.0.personId'), personId);
  assert.equal(field(add.json, 'results.0.scope'), 'person');

  const sessionAdd = await request(fx.baseUrl, 'POST', `${base}/playground/add`, {
    session: fx.sessions.admin,
    body: {
      text: '仅本次会话可见的记忆',
      personExternalId: 'user-777',
      scope: 'session',
      sessionId: 'sess_console_1',
      infer: false,
    },
  });
  assert.equal(sessionAdd.status, 200);
  assert.equal(field(sessionAdd.json, 'results.0.scope'), 'session');
  assert.equal(field(sessionAdd.json, 'results.0.sessionId'), 'sess_console_1');

  const byPerson = await request(
    fx.baseUrl,
    'GET',
    `${base}/memories?personId=user-777&includePrivate=true&pageSize=50`,
    { session: fx.sessions.viewer },
  );
  assert.equal(byPerson.status, 200);
  const items = asArray(field(byPerson.json, 'items'));
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.personId === personId));

  const byScope = await request(fx.baseUrl, 'GET', `${base}/memories?scope=session&pageSize=50`, {
    session: fx.sessions.viewer,
  });
  assert.equal(byScope.status, 200);
  assert.equal(field(byScope.json, 'total'), 1);

  // 控制台「分区」创建入口（与 /api/projects 等价）：developer+，viewer 不可。
  const viewerPartition = await request(fx.baseUrl, 'POST', '/api/partitions', {
    session: fx.sessions.viewer,
    body: { name: '越权分区', slug: 'forbidden-p' },
  });
  assert.equal(viewerPartition.status, 403);

  const newPartition = await request(fx.baseUrl, 'POST', '/api/partitions', {
    session: fx.sessions.developer,
    body: { name: '新分区', slug: 'gamma' },
  });
  assert.equal(newPartition.status, 201);
  assert.equal(field(newPartition.json, 'slug'), 'gamma');
  assert.match(String(field(newPartition.json, 'id')), /^prj_/);

  // 人级 brief / context / dream：viewer 可读，触发做梦需 admin。
  const brief = await request(fx.baseUrl, 'GET', `${base}/persons/user-777/brief`, { session: fx.sessions.viewer });
  assert.equal(brief.status, 200);
  assert.equal(field(brief.json, 'personId'), personId);

  const context = await request(fx.baseUrl, 'POST', `${base}/persons/user-777/context`, {
    session: fx.sessions.viewer,
    body: {},
  });
  assert.equal(context.status, 200);
  assert.equal(field(context.json, 'person.id'), personId);
  assert.ok(String(field(context.json, 'prompt')).length > 0);

  const dream = await request(fx.baseUrl, 'GET', `${base}/persons/user-777/dream`, { session: fx.sessions.viewer });
  assert.equal(dream.status, 200);
  assert.equal(field(dream.json, 'personId'), personId);
  assert.ok(Number(field(dream.json, 'pendingCount')) >= 1);

  const viewerRun = await request(fx.baseUrl, 'POST', `${base}/persons/user-777/dream/run`, {
    session: fx.sessions.viewer,
  });
  assert.equal(viewerRun.status, 403);

  const adminRun = await request(fx.baseUrl, 'POST', `${base}/persons/user-777/dream/run`, {
    session: fx.sessions.admin,
  });
  assert.equal(adminRun.status, 200);
  assert.ok(field(adminRun.json, 'run'));
});

/* ------------------------------------------------------------------ */
/* 六、控制台 org key 管理                                              */
/* ------------------------------------------------------------------ */

test('控制台 org key：仅 owner 创建/查看/吊销，密钥可跨分区使用', async (t) => {
  const fx = await fixture(t);

  const created = await request(fx.baseUrl, 'POST', '/api/org/keys', {
    session: fx.sessions.owner,
    body: { name: 'DSH 插件 key', scopes: ['memories:read', 'memories:write', 'admin'] },
  });
  assert.equal(created.status, 201);
  assert.equal(field(created.json, 'kind'), 'org');
  assert.equal(field(created.json, 'orgId'), fx.orgId);
  const secret = String(field(created.json, 'secret'));
  assert.ok(secret.startsWith('mnemos_live_'), '创建响应应返回一次性明文 secret');

  // 新 org key 可以访问本组织任意分区（含创建分区）。
  const beta = await request(fx.baseUrl, 'GET', '/v1/partitions/beta', { key: secret });
  assert.equal(beta.status, 200);
  const createPartition = await request(fx.baseUrl, 'POST', '/v1/partitions', {
    key: secret,
    body: { slug: 'ws-from-new-key' },
  });
  assert.equal(createPartition.status, 201);

  const list = await request(fx.baseUrl, 'GET', '/api/org/keys', { session: fx.sessions.owner });
  assert.equal(list.status, 200);
  const keys = asArray(list.json);
  assert.ok(keys.some((key) => key.kind === 'org' && key.id === field(created.json, 'id')));
  assert.ok(keys.every((key) => key.kind === 'org'), 'org key 列表只包含 kind=org');

  const adminList = await request(fx.baseUrl, 'GET', '/api/org/keys', { session: fx.sessions.admin });
  assert.equal(adminList.status, 403);
  const adminCreate = await request(fx.baseUrl, 'POST', '/api/org/keys', {
    session: fx.sessions.admin,
    body: { name: 'admins key', scopes: ['memories:read'] },
  });
  assert.equal(adminCreate.status, 403);

  // 项目 key 列表仍展示 kind=project（前端密钥页展示 kind/orgId）。
  const projectKeys = await request(fx.baseUrl, 'GET', '/api/projects/prj_alpha/keys', {
    session: fx.sessions.owner,
  });
  assert.equal(projectKeys.status, 200);
  const projectKeyRows = asArray(projectKeys.json);
  assert.ok(projectKeyRows.length >= 2);
  assert.ok(projectKeyRows.every((key) => key.kind === 'project'));

  // 吊销后 org key 立即失效。
  const revoked = await request(fx.baseUrl, 'DELETE', `/api/org/keys/${String(field(created.json, 'id'))}`, {
    session: fx.sessions.owner,
  });
  assert.equal(revoked.status, 200);
  assert.equal(field(revoked.json, 'ok'), true);
  const afterRevoke = await request(fx.baseUrl, 'GET', '/v1/partitions/beta', { key: secret });
  assert.equal(afterRevoke.status, 401);
  assert.equal(field(afterRevoke.json, 'error.code'), 'API_KEY_REVOKED');
});

/* ------------------------------------------------------------------ */
/* 七、旧 v1 兼容回归                                                   */
/* ------------------------------------------------------------------ */

test('旧 v1 API 回归：user_id/agent_id/visibility 映射到 person/scope', async (t) => {
  const fx = await fixture(t);

  const write = await request(fx.baseUrl, 'POST', '/v1/memories', {
    key: fx.projectKey,
    body: { text: '旧客户端写入的分区记忆', user_id: 'legacy-user', visibility: 'project', infer: false },
  });
  assert.equal(write.status, 200);
  const written = asRecord(asArray(field(write.json, 'results'))[0]);
  assert.equal(written.userId, 'legacy-user');
  assert.equal(written.visibility, 'project');
  assert.equal(written.scope, 'partition');
  assert.ok(written.personId, '旧 user_id 应映射出 person');

  const agentWrite = await request(fx.baseUrl, 'POST', '/v1/memories', {
    key: fx.projectKey,
    body: { text: '旧客户端写入的 agent 私有约定', agent_id: 'legacy-agent', visibility: 'agent', infer: false },
  });
  assert.equal(agentWrite.status, 200);
  const agentMemory = asRecord(asArray(field(agentWrite.json, 'results'))[0]);
  assert.equal(agentMemory.visibility, 'agent');
  assert.equal(agentMemory.scope, 'person');
  assert.ok(agentMemory.personId);

  const list = await request(fx.baseUrl, 'GET', '/v1/memories?user_id=legacy-user', { key: fx.projectKey });
  assert.equal(list.status, 200);
  assert.equal(field(list.json, 'count'), 1);
  const listed = asRecord(asArray(field(list.json, 'results'))[0]);
  assert.equal(listed.user_id, 'legacy-user');
  assert.ok('scope' in listed, '旧列表响应应补充 scope 字段（只增不改）');

  const search = await request(fx.baseUrl, 'POST', '/v1/memories/search', {
    key: fx.projectKey,
    body: { query: '旧客户端', user_id: 'legacy-user' },
  });
  assert.equal(search.status, 200);
  assert.ok(asArray(field(search.json, 'results')).length >= 1);

  const context = await request(fx.baseUrl, 'POST', '/v1/context', {
    key: fx.projectKey,
    body: { query: '旧客户端' },
  });
  assert.equal(context.status, 200);
  assert.ok(String(field(context.json, 'prompt')).length > 0);

  // 旧 agent 私有记忆在 v5 中立面按人检索可见（控制台/审计视角 include_private=true）。
  const viaPerson = await request(
    fx.baseUrl,
    'GET',
    '/v1/partitions/alpha/memories?person_id=legacy-agent&include_private=true&page_size=50',
    { key: fx.orgKey },
  );
  assert.equal(viaPerson.status, 200);
  assert.equal(field(viaPerson.json, 'count'), 1);
  assert.equal(field(viaPerson.json, 'results.0.person_external_id'), 'legacy-agent');

  // agent 人的 type 由旧 agent_id 映射为 agent；human 的 type 为 human。
  const persons = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/persons?page_size=50', {
    key: fx.orgKey,
  });
  assert.equal(persons.status, 200);
  const byType = new Map(
    asArray(field(persons.json, 'results')).map((person) => [person.external_id, person.type]),
  );
  assert.equal(byType.get('legacy-user'), 'human');
  assert.equal(byType.get('legacy-agent'), 'agent');

  // 旧端点仍要求 project key（org key 403），project key 行为不变。
  const agents = await request(fx.baseUrl, 'GET', '/v1/agents', { key: fx.projectKey });
  assert.equal(agents.status, 200);
  const stats = await request(fx.baseUrl, 'GET', '/v1/stats', { key: fx.projectKey });
  assert.equal(stats.status, 200);
  const health = await request(fx.baseUrl, 'GET', '/v1/health');
  assert.equal(health.status, 200);
  assert.equal(field(health.json, 'ok'), true);
});
