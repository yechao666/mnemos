import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword } from '../lib/password.ts';
import { field, request, setupHttpFixture, type HttpFixture } from './test-helpers.ts';

/** v6.3 规则库分组 HTTP 验收：console/v1 分组统计、整组启停、字段过滤与审计。 */

async function login(fx: HttpFixture, email = 'owner@test.dev', password = 'Demo123456'): Promise<string> {
  fx.db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), email);
  const res = await request(fx.baseUrl, 'POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return String(field(res.json, 'token'));
}

function sum(items: Array<Record<string, unknown>>, key: string): number {
  return items.reduce((total, item) => total + Number(item[key] ?? 0), 0);
}

test('privacy groups HTTP：console 分组统计 + 整组启停 + 权限 + 审计', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const viewer = await login(fx, 'viewer@test.dev');
  const admin = await login(fx, 'admin@test.dev');
  const developer = await login(fx, 'developer@test.dev');

  // 全局统计：18 组 / 85 条 / 默认启用 4 条
  const globalGroups = await request(fx.baseUrl, 'GET', '/api/privacy/groups', { session: viewer });
  assert.equal(globalGroups.status, 200, JSON.stringify(globalGroups.json));
  const globalItems = field(globalGroups.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(globalItems.length, 18);
  assert.equal(sum(globalItems, 'ruleCount'), 85);
  assert.equal(sum(globalItems, 'enabledCount'), 4);
  assert.equal(sum(globalItems, 'appliedCount'), 0);
  for (const key of ['key', 'name', 'industry', 'description', 'sortOrder', 'builtin', 'ruleCount', 'enabledCount', 'appliedCount']) {
    assert.ok(key in (globalItems[0] ?? {}), `缺少字段 ${key}`);
  }

  // 分区统计：alpha 尚无覆盖
  const partitionGroups = await request(fx.baseUrl, 'GET', '/api/privacy/groups?partitionId=alpha', {
    session: viewer,
  });
  const partitionItems = field(partitionGroups.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(partitionItems.length, 18);
  assert.equal(sum(partitionItems, 'appliedCount'), 0);
  assert.equal(sum(partitionItems, 'enabledCount'), 4);

  // 整组启用 finance（admin）：返回 group + 生效规则
  const applied = await request(fx.baseUrl, 'POST', '/api/privacy/groups/finance/apply', {
    session: admin,
    body: { partitionId: 'alpha', enabled: true },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  const finance = field(applied.json, 'group') as Record<string, unknown>;
  assert.equal(finance.key, 'finance');
  assert.ok(Number(finance.ruleCount) >= 10);
  assert.equal(finance.enabledCount, finance.ruleCount);
  assert.equal(finance.appliedCount, finance.ruleCount);
  const appliedRules = field(applied.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(appliedRules.length, finance.ruleCount);
  assert.equal(appliedRules.every((rule) => rule.scope === 'partition'), true);
  const sampleRule = appliedRules[0] ?? {};
  for (const key of ['groupKey', 'validator', 'contextKeywords', 'caseSensitive', 'region', 'severity']) {
    assert.ok(key in sampleRule, `规则序列化缺少 ${key}`);
  }

  const after = await request(fx.baseUrl, 'GET', '/api/privacy/groups?partition_id=alpha', { session: viewer });
  const financeAfter = (field(after.json, 'items') as Array<Record<string, unknown>>).find(
    (item) => item.key === 'finance',
  );
  assert.equal(financeAfter?.enabledCount, finance.ruleCount);
  assert.equal(financeAfter?.appliedCount, finance.ruleCount);
  assert.equal(sum(field(after.json, 'items') as Array<Record<string, unknown>>, 'appliedCount'), finance.ruleCount);

  // 整组停用：覆盖仍存在但 enabledCount=0
  const disabled = await request(fx.baseUrl, 'POST', '/api/privacy/groups/finance/apply', {
    session: admin,
    body: { partition_id: 'alpha', enabled: false },
  });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.json));
  assert.equal(field(disabled.json, 'group.enabledCount'), 0);
  assert.equal(field(disabled.json, 'group.appliedCount'), finance.ruleCount);

  // 权限：developer 不可整组启停；viewer 可读
  const denied = await request(fx.baseUrl, 'POST', '/api/privacy/groups/finance/apply', {
    session: developer,
    body: { partitionId: 'alpha', enabled: true },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.json));

  const missingPartition = await request(fx.baseUrl, 'POST', '/api/privacy/groups/finance/apply', {
    session: admin,
    body: { enabled: true },
  });
  assert.equal(missingPartition.status, 400, JSON.stringify(missingPartition.json));

  const unknownGroup = await request(fx.baseUrl, 'POST', '/api/privacy/groups/no_such_group/apply', {
    session: admin,
    body: { partitionId: 'alpha', enabled: true },
  });
  assert.equal(unknownGroup.status, 404, JSON.stringify(unknownGroup.json));

  // 审计：privacy.group.apply 记到分区审计
  const audit = await request(fx.baseUrl, 'GET', '/api/partitions/alpha/audit?limit=100', { session: admin });
  const actions = (field(audit.json, 'items') as Array<Record<string, unknown>>).map((item) => item.action);
  assert.ok(actions.includes('privacy.group.apply'), JSON.stringify(actions));
  const auditRow = fx.db
    .prepare("SELECT detail FROM audit_logs WHERE action = 'privacy.group.apply' ORDER BY created_at DESC LIMIT 1")
    .get() as unknown as { detail: string };
  const detail = JSON.parse(auditRow.detail) as { group?: string; enabled?: boolean; count?: number };
  assert.equal(detail.group, 'finance');
  assert.equal(detail.enabled, false);
  assert.equal(detail.count, finance.ruleCount);
});

test('privacy groups HTTP：v1 分组端点（snake_case）+ 规则 group_key 过滤', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());

  const groups = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/privacy/groups', { key: fx.partitionKey });
  assert.equal(groups.status, 200, JSON.stringify(groups.json));
  const items = field(groups.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(items.length, 18);
  const first = items[0] ?? {};
  for (const key of ['key', 'name', 'industry', 'description', 'sort_order', 'builtin', 'rule_count', 'enabled_count', 'applied_count']) {
    assert.ok(key in first, `v1 分组缺少字段 ${key}`);
  }
  assert.equal(sum(items, 'rule_count'), 85);

  const applied = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/privacy/groups/finance/apply', {
    key: fx.partitionKey,
    body: { enabled: true },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.equal(field(applied.json, 'group.key'), 'finance');
  assert.equal(field(applied.json, 'group.enabled_count'), field(applied.json, 'group.rule_count'));
  const appliedRules = field(applied.json, 'items') as Array<Record<string, unknown>>;
  assert.ok(appliedRules.length >= 10);
  const rule = appliedRules[0] ?? {};
  for (const key of ['group_key', 'validator', 'context_keywords', 'case_sensitive', 'region', 'severity']) {
    assert.ok(key in rule, `v1 规则缺少字段 ${key}`);
  }

  const readOnly = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/privacy/groups/finance/apply', {
    key: fx.partitionReadKey,
    body: { enabled: false },
  });
  assert.equal(readOnly.status, 403, JSON.stringify(readOnly.json));

  // 规则列表过滤：console（分区自有）与 v1（合并后的生效规则）
  const consolePartitionRules = await request(
    fx.baseUrl,
    'GET',
    '/api/privacy/rules?scope=partition&partition_id=alpha&groupKey=finance',
    { session: await login(fx, 'viewer@test.dev') },
  );
  const consoleRules = field(consolePartitionRules.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(consoleRules.length, appliedRules.length);
  assert.equal(consoleRules.every((item) => item.groupKey === 'finance' && item.scope === 'partition'), true);

  const consoleGlobalRules = await request(fx.baseUrl, 'GET', '/api/privacy/rules?scope=global&group_key=finance', {
    session: await login(fx, 'viewer@test.dev'),
  });
  const globalRules = field(consoleGlobalRules.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(globalRules.length, 11);
  assert.equal(globalRules.every((item) => item.groupKey === 'finance'), true);

  const v1Rules = await request(fx.baseUrl, 'GET', '/v1/partitions/alpha/privacy/rules?group_key=finance', {
    key: fx.partitionKey,
  });
  const v1Items = field(v1Rules.json, 'items') as Array<Record<string, unknown>>;
  assert.equal(v1Items.length, 11);
  assert.equal(v1Items.every((item) => item.group_key === 'finance'), true);

  // enabled 可省略，缺省 true
  const defaultEnabled = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/privacy/groups/contact/apply', {
    key: fx.partitionKey,
    body: {},
  });
  assert.equal(defaultEnabled.status, 200, JSON.stringify(defaultEnabled.json));
  assert.equal(field(defaultEnabled.json, 'group.enabled_count'), field(defaultEnabled.json, 'group.rule_count'));
});

test('privacy rules HTTP：v6.3 新字段创建 / 更新（console camelCase + v1 snake_case）', async (t) => {
  const fx = await setupHttpFixture();
  t.after(() => fx.close());
  const admin = await login(fx, 'admin@test.dev');

  const created = await request(fx.baseUrl, 'POST', '/api/privacy/rules', {
    session: admin,
    body: {
      scope: 'partition',
      partitionId: 'alpha',
      code: 'v63_rule',
      name: 'v6.3 字段规则',
      kind: 'regex',
      pattern: 'V63-\\d{4}',
      groupKey: 'hr',
      validator: 'luhn',
      contextKeywords: ['工号', 'employee'],
      caseSensitive: false,
      region: 'CN',
      severity: 'high',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(field(created.json, 'rule.groupKey'), 'hr');
  assert.equal(field(created.json, 'rule.validator'), 'luhn');
  assert.deepEqual(field(created.json, 'rule.contextKeywords'), ['工号', 'employee']);
  assert.equal(field(created.json, 'rule.caseSensitive'), false);
  assert.equal(field(created.json, 'rule.region'), 'CN');
  assert.equal(field(created.json, 'rule.severity'), 'high');
  const ruleId = String(field(created.json, 'rule.id'));

  const patched = await request(fx.baseUrl, 'PATCH', `/api/privacy/rules/${ruleId}`, {
    session: admin,
    body: { group_key: 'finance', severity: 'low', context_keywords: ['卡号', 'card'] },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(field(patched.json, 'rule.groupKey'), 'finance');
  assert.equal(field(patched.json, 'rule.severity'), 'low');
  assert.deepEqual(field(patched.json, 'rule.contextKeywords'), ['卡号', 'card']);

  // 未知分组 / 未知 validator：400
  const badGroup = await request(fx.baseUrl, 'POST', '/api/privacy/rules', {
    session: admin,
    body: { scope: 'partition', partitionId: 'alpha', code: 'bad_group', name: 'bad', kind: 'regex', pattern: 'X', groupKey: 'nope' },
  });
  assert.equal(badGroup.status, 400, JSON.stringify(badGroup.json));
  const badValidator = await request(fx.baseUrl, 'POST', '/api/privacy/rules', {
    session: admin,
    body: { scope: 'partition', partitionId: 'alpha', code: 'bad_validator', name: 'bad', kind: 'regex', pattern: 'X', validator: 'not valid!' },
  });
  assert.equal(badValidator.status, 400, JSON.stringify(badValidator.json));

  // v1：snake_case 字段读写
  const v1Created = await request(fx.baseUrl, 'POST', '/v1/partitions/alpha/privacy/rules', {
    key: fx.partitionKey,
    body: {
      code: 'v63_v1_rule',
      name: 'v1 v6.3 规则',
      kind: 'regex',
      pattern: 'V63V1-\\d{4}',
      group_key: 'legal',
      validator: 'uscc',
      context_keywords: ['合同'],
      case_sensitive: false,
      region: 'CN',
      severity: 'medium',
    },
  });
  assert.equal(v1Created.status, 201, JSON.stringify(v1Created.json));
  assert.equal(field(v1Created.json, 'rule.group_key'), 'legal');
  assert.equal(field(v1Created.json, 'rule.validator'), 'uscc');
  assert.deepEqual(field(v1Created.json, 'rule.context_keywords'), ['合同']);
  assert.equal(field(v1Created.json, 'rule.case_sensitive'), false);
});
