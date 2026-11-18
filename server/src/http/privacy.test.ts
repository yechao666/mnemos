import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword } from '../lib/password.ts';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/** v6.2 隐私规则域 HTTP 验收：权限 / 规则 CRUD / preview / 占位符 reveal / 重扫审计。 */

async function login(fx: HttpFixture, email = 'owner@test.dev', password = 'Demo123456'): Promise<string> {
  fx.db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), email);
  const res = await request(fx.baseUrl, 'POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'token'));
}

async function createPerson(fx: HttpFixture, externalId: string): Promise<string> {
  const res = await request(fx.baseUrl, 'PUT', `/v1/partitions/alpha/persons/${externalId}`, {
    key: fx.partitionKey,
    body: { type: 'human', display_name: externalId },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'id'));
}

test('privacy HTTP：规则读取/写入权限、内置规则不可删、审计', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const viewer = await login(fx, 'viewer@test.dev');
  const admin = await login(fx, 'admin@test.dev');
  const owner = await login(fx, 'owner@test.dev');

  const globalList = await request(fx.baseUrl, 'GET', '/api/privacy/rules?scope=global', { session: viewer });
  assert.equal(globalList.status, 200, JSON.stringify(globalList.json));
  const globalItems = field(globalList.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(globalItems.length, 8);
  assert.equal(globalItems[0]?.scope, 'global');
  assert.equal(typeof globalItems[0]?.maskMode, 'string');
  assert.equal(typeof globalItems[0]?.entityType, 'string');

  // global 写仅 owner
  const adminCreate = await request(fx.baseUrl, 'POST', '/api/privacy/rules', {
    session: admin,
    body: { scope: 'global', code: 'custom_global', name: '自定义全局', kind: 'regex', pattern: 'G-\\d{3}' },
  });
  assert.equal(adminCreate.status, 403, JSON.stringify(adminCreate.json));

  const ownerCreate = await request(fx.baseUrl, 'POST', '/api/privacy/rules', {
    session: owner,
    body: {
      scope: 'global',
      code: 'custom_global',
      name: '自定义全局',
      kind: 'regex',
      pattern: 'G-\\d{3}',
      action: 'mask',
      maskMode: 'full',
      priority: 50,
    },
  });
  assert.equal(ownerCreate.status, 201, JSON.stringify(ownerCreate.json));
  const customId = String(field(ownerCreate.json, 'rule.id'));
  assert.equal(field(ownerCreate.json, 'rule.code'), 'custom_global');
  assert.equal(field(ownerCreate.json, 'rule.builtin'), false);

  const badRegex = await request(fx.baseUrl, 'POST', '/api/privacy/rules', {
    session: owner,
    body: { scope: 'global', code: 'bad_regex_rule', name: '坏正则', kind: 'regex', pattern: '(' },
  });
  assert.equal(badRegex.status, 400, JSON.stringify(badRegex.json));

  const builtinId = String(globalItems.find((item) => item.code === 'email')?.id);
  const builtinDelete = await request(fx.baseUrl, 'DELETE', `/api/privacy/rules/${builtinId}`, { session: owner });
  assert.equal(builtinDelete.status, 400, JSON.stringify(builtinDelete.json));

  const disableBuiltin = await request(fx.baseUrl, 'PATCH', `/api/privacy/rules/${builtinId}`, {
    session: owner,
    body: { enabled: false },
  });
  assert.equal(disableBuiltin.status, 200, JSON.stringify(disableBuiltin.json));
  assert.equal(field(disableBuiltin.json, 'rule.enabled'), false);

  const deleteCustom = await request(fx.baseUrl, 'DELETE', `/api/privacy/rules/${customId}`, { session: owner });
  assert.equal(deleteCustom.status, 204);

  // 分区规则：admin 可写、developer 不可写；读取 viewer+
  const partitionCreate = await request(fx.baseUrl, 'POST', '/api/privacy/rules', {
    session: admin,
    body: {
      scope: 'partition',
      partition_id: 'alpha',
      code: 'employee_id',
      name: '工号',
      kind: 'regex',
      pattern: 'EMP-\\d{6}',
      action: 'mask',
      maskMode: 'keepLast',
      maskKeepLast: 2,
      priority: 5,
    },
  });
  assert.equal(partitionCreate.status, 201, JSON.stringify(partitionCreate.json));
  assert.equal(field(partitionCreate.json, 'rule.partitionId'), 'ptn_alpha');

  const developer = await login(fx, 'developer@test.dev');
  const developerCreate = await request(fx.baseUrl, 'POST', '/api/privacy/rules', {
    session: developer,
    body: { scope: 'partition', partition_id: 'alpha', code: 'dev_rule', name: 'dev', kind: 'regex', pattern: 'X' },
  });
  assert.equal(developerCreate.status, 403, JSON.stringify(developerCreate.json));

  const partitionList = await request(fx.baseUrl, 'GET', '/api/privacy/rules?scope=partition&partition_id=alpha', {
    session: viewer,
  });
  assert.equal(partitionList.status, 200, JSON.stringify(partitionList.json));
  const partitionItems = field(partitionList.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(partitionItems.some((item) => item.code === 'employee_id' && item.partitionId === 'ptn_alpha'), true);
  // scope=partition 只返回分区自有规则（全局规则在 global tab），否则前端「覆盖全局」标签会误判。
  assert.equal(partitionItems.every((item) => item.scope === 'partition'), true);

  // 全局规则审计归属组织（无 partition_id），分区规则审计可在分区审计里看到。
  const allActions = (
    fx.db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'privacy.rule.%' ORDER BY created_at").all() as unknown as {
      action: string;
    }[]
  ).map((row) => row.action);
  assert.ok(allActions.includes('privacy.rule.create'), JSON.stringify(allActions));
  assert.ok(allActions.includes('privacy.rule.update'));
  assert.ok(allActions.includes('privacy.rule.delete'));
  const partitionAudit = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/audit?limit=100', {
    session: admin,
  });
  const partitionActions = (field(partitionAudit.json, 'items') as Array<Record<string, unknown>>).map(
    (item) => item.action,
  );
  assert.ok(partitionActions.includes('privacy.rule.create'), JSON.stringify(partitionActions));
});

test('privacy HTTP：preview / v1 规则读写 / 占位符写入与 reveal', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const personId = await createPerson(fx, 'alice');
  assert.ok(personId);

  const created = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/alice/memories', {
    key: fx.partitionKey,
    body: {
      text: '手机 {{phone_a1b2}}，邮箱 {{mail_c3d4}}。',
      placeholders: {
        phone_a1b2: '18334423321',
        mail_c3d4: 'zhangsan@example.com',
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const memoryId = String(field(created.json, 'memory.id'));
  assert.equal(field(created.json, 'memory.content'), '手机 {{phone_a1b2}}，邮箱 {{mail_c3d4}}。');
  assert.equal(field(created.json, 'memory.placeholder_count'), 2);
  assert.equal(field(created.json, 'memory.privacy_scanned_at'), null);

  const list = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/memories', { key: fx.partitionKey });
  assert.equal(field(list.json, 'items.0.placeholder_count'), 2);
  assert.equal(JSON.stringify(list.json).includes('18334423321'), false);

  const detail = await request(fx.baseUrl, 'GET', `/v1/partitions/alpha/memories/${memoryId}`, {
    key: fx.partitionKey,
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  const holders = field(detail.json, 'placeholders') as Array<Record<string, unknown>>;
  assert.deepEqual(holders.map((item) => item.placeholder), ['phone_a1b2', 'mail_c3d4']);
  assert.equal(holders.every((item) => item.value === undefined), true);

  const revealed = await request(
    fx.baseUrl,
    'GET',
    `/v1/partitions/alpha/memories/${memoryId}?reveal=placeholders`,
    { key: fx.partitionKey },
  );
  assert.equal(revealed.status, 200, JSON.stringify(revealed.json));
  const revealedHolders = field(revealed.json, 'placeholders') as Array<Record<string, unknown>>;
  assert.equal(revealedHolders[0]?.value, '18334423321');
  assert.equal(revealedHolders[1]?.value, 'zhangsan@example.com');

  // 控制台 camelCase 同构
  const viewer = await login(fx, 'viewer@test.dev');
  const consoleDetail = await request(fx.baseUrl, 'GET', `/api/partitions/alpha/memories/${memoryId}`, {
    session: viewer,
  });
  assert.equal(consoleDetail.status, 200, JSON.stringify(consoleDetail.json));
  const consoleHolders = field(consoleDetail.json, 'placeholders') as Array<Record<string, unknown>>;
  assert.equal(consoleHolders[0]?.placeholder, 'phone_a1b2');
  assert.equal(consoleHolders[0]?.value, undefined);
  assert.equal(field(consoleDetail.json, 'memory.placeholderCount'), 2);
  const consoleReveal = await request(
    fx.baseUrl,
    'GET',
    `/api/partitions/alpha/memories/${memoryId}?reveal=placeholders`,
    { session: viewer },
  );
  const consoleRevealed = field(consoleReveal.json, 'placeholders') as Array<Record<string, unknown>>;
  assert.equal(consoleRevealed[0]?.value, '18334423321');

  // preview 不落库
  const preview = await request(fx.baseUrl, 'POST', '/api/privacy/preview', {
    session: viewer,
    body: { partition_id: 'alpha', text: '联系 alice@example.com 或 13812345678' },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(field(preview.json, 'redacted'), true);
  assert.equal(String(field(preview.json, 'text')).includes('alice@example.com'), false);
  assert.equal((field(preview.json, 'hits') as unknown[]).length, 2);

  // v1 读规则（snake_case），写规则需要 admin scope
  const v1Rules = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/privacy/rules', { key: fx.partitionKey });
  assert.equal(v1Rules.status, 200, JSON.stringify(v1Rules.json));
  const v1Items = field(v1Rules.json, 'items') as Array<Record<string, unknown>>;
  assert.ok(v1Items.length >= 8);
  assert.equal(typeof v1Items[0]?.entity_type, 'string');
  assert.equal(typeof v1Items[0]?.mask_mode, 'string');

  const v1Create = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/privacy/rules', {
    key: fx.partitionKey,
    body: { code: 'v1_emp', name: 'v1 工号', kind: 'regex', pattern: 'V1-\\d{4}', mask_mode: 'full' },
  });
  assert.equal(v1Create.status, 201, JSON.stringify(v1Create.json));
  assert.equal(field(v1Create.json, 'rule.code'), 'v1_emp');

  const readOnlyCreate = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/privacy/rules', {
    key: fx.partitionReadKey,
    body: { code: 'readonly_rule', name: 'readonly', kind: 'regex', pattern: 'R-\\d{2}' },
  });
  assert.equal(readOnlyCreate.status, 403, JSON.stringify(readOnlyCreate.json));

  const readOnlyList = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/privacy/rules', {
    key: fx.partitionReadKey,
  });
  assert.equal(readOnlyList.status, 200);
});

test('privacy HTTP：settings.privacy_llm_enabled 读写 + 控制台占位符写入', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const admin = await login(fx, 'admin@test.dev');
  await createPerson(fx, 'bob');

  const patched = await request(fx.baseUrl, 'PATCH', '/api/partitions/alpha', {
    session: admin,
    body: { settings: { privacyLlmEnabled: true, piiRedaction: 'basic' } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(field(patched.json, 'settings.privacyLlmEnabled'), true);
  assert.equal(field(patched.json, 'settings.piiRedaction'), 'basic');
  const v1Partition = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha', { key: fx.partitionKey });
  assert.equal(field(v1Partition.json, 'settings.privacy_llm_enabled'), true);

  const created = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/persons/bob/memories', {
    session: admin,
    body: {
      text: '座机 {{tel_001}}',
      placeholders: { tel_001: '010-88886666' },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(field(created.json, 'memory.content'), '座机 {{tel_001}}');
  assert.equal(field(created.json, 'memory.placeholderCount'), 1);
  const memoryId = String(field(created.json, 'memory.id'));
  const detail = await request(fx.baseUrl, 'GET', `/api/partitions/alpha/memories/${memoryId}`, {
    session: admin,
  });
  assert.equal(field(detail.json, 'memory.placeholderCount'), 1);
  const holders = field(detail.json, 'placeholders') as Array<Record<string, unknown>>;
  assert.equal(holders[0]?.placeholder, 'tel_001');
});

test('privacy HTTP：rescan 权限/统计/审计，规则生效后历史记忆被脱敏', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  await createPerson(fx, 'carol');
  const created = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/persons/carol/memories', {
    key: fx.partitionKey,
    body: { text: '电话 13812345678' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const memoryId = String(field(created.json, 'memory.id'));

  const developer = await login(fx, 'developer@test.dev');
  const admin = await login(fx, 'admin@test.dev');
  const denied = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/privacy/rescan', {
    session: developer,
    body: { limit: 10 },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.json));

  const patched = await request(fx.baseUrl, 'PATCH', '/api/partitions/alpha', {
    session: admin,
    body: { settings: { piiRedaction: 'basic' } },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));

  const rescanned = await request(fx.baseUrl, 'POST', '/api/partitions/alpha/privacy/rescan', {
    session: admin,
    body: { limit: 10 },
  });
  assert.equal(rescanned.status, 200, JSON.stringify(rescanned.json));
  assert.ok(Number(field(rescanned.json, 'scanned')) >= 1);
  assert.ok(Number(field(rescanned.json, 'changed')) >= 1);
  assert.ok(Number(field(rescanned.json, 'hits')) >= 1);

  const detail = await request(fx.baseUrl, 'GET', `/api/partitions/alpha/memories/${memoryId}`, {
    session: admin,
  });
  const content = String(field(detail.json, 'memory.content'));
  assert.equal(content.includes('13812345678'), false);
  assert.ok(content.includes('138****5678'), content);

  const audit = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/audit?limit=100', { session: admin });
  const actions = (field(audit.json, 'items') as Array<Record<string, unknown>>).map((item) => item.action);
  assert.ok(actions.includes('memory.privacy.scan'), JSON.stringify(actions));
});
