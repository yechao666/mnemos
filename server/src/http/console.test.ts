import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword } from '../lib/password.ts';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/** 控制台 /api（camelCase）端到端测试。 */

async function login(fx: HttpFixture, email = 'owner@test.dev', password = 'Demo123456'): Promise<string> {
  fx.db
    .prepare('UPDATE users SET password_hash = ? WHERE email = ?')
    .run(hashPassword(password), email);
  const res = await request(fx.baseUrl, 'POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'token'));
}

test('控制台认证：login / me / logout，me 返回 partitions', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const token = await login(fx);
  const me = await request(fx.baseUrl, 'GET', '/api/auth/me', { session: token });
  assert.equal(me.status, 200);
  assert.equal(field(me.json, 'user.email'), 'owner@test.dev');
  assert.equal(field(me.json, 'org.slug'), 'test-org');
  const partitions = field(me.json, 'partitions') as Array<Record<string, unknown>>;
  assert.deepEqual(partitions.map((item) => item.slug).sort(), ['alpha', 'beta']);
  assert.ok(partitions.every((item) => typeof item.stats === 'object'));

  const logout = await request(fx.baseUrl, 'POST', '/api/auth/logout', { session: token });
  assert.equal(logout.status, 200);
  const after = await request(fx.baseUrl, 'GET', '/api/auth/me', { session: token });
  assert.equal(after.status, 401);

  const bad = await request(fx.baseUrl, 'POST', '/api/auth/login', {
    body: { email: 'owner@test.dev', password: 'wrong-password' },
  });
  assert.equal(bad.status, 401);
});

test('控制台分区：列表带 stats、详情、PATCH 设置、统计、reconcile', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const list = await request(fx.baseUrl, 'GET', '/api/partitions', { session: fx.sessions.owner });
  assert.equal(list.status, 200);
  const items = list.json as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.equal(items[0]?.stats !== undefined, true);

  const detail = await request(fx.baseUrl, 'GET', '/api/partitions/alpha', { session: fx.sessions.developer });
  assert.equal(detail.status, 200);
  assert.equal(field(detail.json, 'id'), fx.partitionId);
  assert.equal(field(detail.json, 'stats.personsTotal'), 0);

  const patched = await request(fx.baseUrl, 'PATCH', '/api/partitions/alpha', {
    session: fx.sessions.admin,
    body: { name: 'Alpha 改名', settings: { defaultScope: 'person', briefMaxChars: 500 } },
  });
  assert.equal(patched.status, 200);
  assert.equal(field(patched.json, 'name'), 'Alpha 改名');
  assert.equal(field(patched.json, 'settings.defaultScope'), 'person');

  const viewerPatch = await request(fx.baseUrl, 'PATCH', '/api/partitions/alpha', {
    session: fx.sessions.viewer,
    body: { name: 'x' },
  });
  assert.equal(viewerPatch.status, 403);

  const foreign = await request(fx.baseUrl, 'GET', '/api/partitions/foreign', { session: fx.sessions.owner });
  assert.equal(foreign.status, 404);

  const reconcile = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/reconcile', {
    session: fx.sessions.admin,
    body: {},
  });
  assert.equal(reconcile.status, 200);
  assert.equal(field(reconcile.json, 'personsTotal'), 0);
});

test('控制台人：PUT / 列表 / 详情 / PATCH / 排序 / 搜索 / 角色权限', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const put = await request(fx.baseUrl, 'PUT', '/api/partitions/alpha/persons/alice', {
    session: fx.sessions.developer,
    body: { type: 'human', displayName: 'Alice' },
  });
  assert.equal(put.status, 200);
  assert.equal(field(put.json, 'externalId'), 'alice');
  assert.equal(field(put.json, 'memoryCount'), 0);

  const viewerPut = await request(fx.baseUrl, 'PUT', '/api/partitions/alpha/persons/bob', {
    session: fx.sessions.viewer,
    body: { type: 'human' },
  });
  assert.equal(viewerPut.status, 403);

  await request(fx.baseUrl, 'PUT', '/api/partitions/alpha/persons/bob', {
    session: fx.sessions.developer,
    body: { type: 'human', displayName: 'Bob' },
  });

  const page = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons?limit=1', {
    session: fx.sessions.viewer,
  });
  assert.equal(page.status, 200);
  assert.equal((field(page.json, 'items') as unknown[]).length, 1);
  assert.ok(field(page.json, 'nextCursor'));
  assert.equal(field(page.json, 'partitionStats.personsTotal'), 2);

  const next = await request(
    fx.baseUrl,
    'GET',
    `/api/partitions/alpha/persons?limit=1&cursor=${encodeURIComponent(String(field(page.json, 'nextCursor')))}`,
    { session: fx.sessions.viewer },
  );
  assert.equal((field(next.json, 'items') as unknown[]).length, 1);

  const search = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons?q=ali', {
    session: fx.sessions.viewer,
  });
  assert.equal((field(search.json, 'items') as Array<Record<string, unknown>>)[0]?.externalId, 'alice');

  const detail = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons/alice', {
    session: fx.sessions.viewer,
  });
  assert.equal(field(detail.json, 'externalId'), 'alice');

  const patch = await request(fx.baseUrl, 'PATCH', '/api/partitions/alpha/persons/alice', {
    session: fx.sessions.developer,
    body: { displayName: 'Alice 2', attributes: { team: 'pm' } },
  });
  assert.equal(field(patch.json, 'displayName'), 'Alice 2');
  assert.equal(field(patch.json, 'attributes.team'), 'pm');
});

test('控制台记忆：写入 / 列表 / 详情 / 更新 / 删除 / 计数', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  await request(fx.baseUrl, 'PUT', '/api/partitions/alpha/persons/alice', {
    session: fx.sessions.developer,
    body: { type: 'human', displayName: 'Alice' },
  });

  const created = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/memories', {
    session: fx.sessions.developer,
    body: { text: 'Alice 喜欢简洁周报', scope: 'person', category: 'preference' },
  });
  assert.equal(created.status, 201);
  const memoryId = String(field(created.json, 'memory.id'));
  assert.equal(field(created.json, 'memory.scope'), 'person');

  const person = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons/alice', {
    session: fx.sessions.developer,
  });
  assert.equal(field(person.json, 'memoryCount'), 1);

  const list = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons/alice/memories', {
    session: fx.sessions.viewer,
  });
  assert.equal((field(list.json, 'items') as unknown[]).length, 1);
  assert.equal(field(list.json, 'partitionStats.memoriesTotal'), 1);

  const global = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/memories?personId=alice', {
    session: fx.sessions.viewer,
  });
  assert.equal((field(global.json, 'items') as unknown[]).length, 1);

  const detail = await request(fx.baseUrl, 'GET', `/api/partitions/alpha/memories/${memoryId}`, {
    session: fx.sessions.viewer,
  });
  assert.equal(field(detail.json, 'memory.content'), 'Alice 喜欢简洁周报');
  assert.equal(field(detail.json, 'person.externalId'), 'alice');

  const patched = await request(fx.baseUrl, 'PATCH', `/api/partitions/alpha/memories/${memoryId}`, {
    session: fx.sessions.developer,
    body: { content: 'Alice 喜欢详细周报', status: 'archived' },
  });
  assert.equal(field(patched.json, 'memory.content'), 'Alice 喜欢详细周报');
  assert.equal(field(patched.json, 'memory.status'), 'archived');

  const removed = await request(fx.baseUrl, 'DELETE', `/api/partitions/alpha/memories/${memoryId}`, {
    session: fx.sessions.developer,
  });
  assert.equal(removed.status, 204);
  const stats = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/stats', {
    session: fx.sessions.developer,
  });
  assert.equal(field(stats.json, 'memoriesTotal'), 0);
});

test('控制台简报 / 上下文 / 做梦 / 用量 / 审计', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  await request(fx.baseUrl, 'PUT', '/api/partitions/alpha/persons/alice', {
    session: fx.sessions.developer,
    body: { type: 'human', displayName: 'Alice' },
  });
  for (const text of ['Alice 偏好简洁周报', '团队约定周一发布']) {
    const res = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/memories', {
      session: fx.sessions.developer,
      body: { text, scope: text.startsWith('团队') ? 'partition' : 'person' },
    });
    assert.equal(res.status, 201);
  }

  const brief = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/persons/alice/brief', {
    session: fx.sessions.developer,
  });
  assert.equal(brief.status, 200);
  assert.ok(String(field(brief.json, 'text')).length > 0);
  assert.equal(field(brief.json, 'cached'), false);

  const context = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/context', {
    session: fx.sessions.developer,
    body: { query: '周报', budgetTokens: 1000 },
  });
  assert.equal(context.status, 200);
  assert.match(String(field(context.json, 'prompt')), /## 人物资料/);

  const dream = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/alice/dream/run', {
    session: fx.sessions.developer,
    body: { batchSize: 10 },
  });
  assert.equal(field(dream.json, 'run.status'), 'completed');

  const usage = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/usage?days=7', {
    session: fx.sessions.developer,
  });
  assert.equal(usage.status, 200);
  assert.ok(Number(field(usage.json, 'totals.adds')) >= 2);
  assert.ok(Array.isArray(field(usage.json, 'points')));
  assert.ok(Array.isArray(field(usage.json, 'byOperation')));

  const audit = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/audit', {
    session: fx.sessions.developer,
  });
  assert.equal(audit.status, 200);
  const actions = (field(audit.json, 'items') as Array<Record<string, unknown>>).map((item) => item.action);
  assert.ok(actions.includes('memory.add'));
  assert.ok(actions.includes('person.upsert'));
});

test('控制台密钥与组织账号权限', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const listBefore = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/keys', {
    session: fx.sessions.owner,
  });
  assert.equal(listBefore.status, 200);
  assert.equal((listBefore.json as unknown[]).length, 2);

  const create = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/keys', {
    session: fx.sessions.owner,
    body: { name: '新 key', scopes: ['memories:read'] },
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const keyId = String(field(create.json, 'id'));
  assert.ok(String(field(create.json, 'secret')).startsWith('mnemos_live_'));

  const rotate = await request(fx.baseUrl, 'POST', `/api/partitions/alpha/keys/${keyId}/rotate`, {
    session: fx.sessions.owner,
    body: {},
  });
  assert.equal(rotate.status, 201);
  assert.ok(String(field(rotate.json, 'secret')).startsWith('mnemos_live_'));

  const revoke = await request(fx.baseUrl, 'DELETE', `/api/partitions/alpha/keys/${keyId}`, {
    session: fx.sessions.owner,
  });
  assert.equal(revoke.status, 204);

  const developerCreate = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/keys', {
    session: fx.sessions.developer,
    body: { name: 'x', scopes: ['memories:read'] },
  });
  assert.equal(developerCreate.status, 403);

  const users = await request(fx.baseUrl, 'GET', '/api/org/users', { session: fx.sessions.admin });
  assert.equal(users.status, 200);
  assert.equal((users.json as unknown[]).length, 4);

  const created = await request(fx.baseUrl, 'POST', '/api/org/users', {
    session: fx.sessions.admin,
    body: { email: 'new@test.dev', name: 'New', role: 'developer' },
  });
  assert.equal(created.status, 201);
  const newUserId = String(field(created.json, 'user.id'));
  assert.ok(String(field(created.json, 'temporaryPassword')).length >= 8);

  const reset = await request(fx.baseUrl, 'POST', `/api/org/users/${newUserId}/reset-password`, {
    session: fx.sessions.admin,
    body: {},
  });
  assert.equal(reset.status, 200);

  const denyOwner = await request(fx.baseUrl, 'POST', '/api/org/users', {
    session: fx.sessions.admin,
    body: { email: 'owner2@test.dev', name: 'Owner2', role: 'owner' },
  });
  assert.equal(denyOwner.status, 403);

  const orgKeys = await request(fx.baseUrl, 'GET', '/api/org/keys', { session: fx.sessions.owner });
  assert.equal(orgKeys.status, 200);
  assert.equal((orgKeys.json as unknown[]).length, 1);

  const orgKeyCreate = await request(fx.baseUrl, 'POST', '/api/org/keys', {
    session: fx.sessions.owner,
    body: { name: 'org new', scopes: ['memories:read', 'memories:write', 'admin'] },
  });
  assert.equal(orgKeyCreate.status, 201);
  const orgKeyId = String(field(orgKeyCreate.json, 'id'));
  const orgKeyRevoke = await request(fx.baseUrl, 'DELETE', `/api/org/keys/${orgKeyId}`, {
    session: fx.sessions.owner,
  });
  assert.equal(orgKeyRevoke.status, 204);

  const nonOwnerOrgKeys = await request(fx.baseUrl, 'GET', '/api/org/keys', {
    session: fx.sessions.admin,
  });
  assert.equal(nonOwnerOrgKeys.status, 403);

  const health = await request(fx.baseUrl, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(field(health.json, 'ok'), true);
});
