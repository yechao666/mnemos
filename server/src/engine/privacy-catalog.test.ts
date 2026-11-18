import assert from 'node:assert/strict';
import test from 'node:test';
import { scanText } from './index.ts';
import { PRIVACY_CATALOG, PRIVACY_GROUPS } from '../db/privacy-catalog.ts';
import { setup } from './test-helpers.ts';

/**
 * v6.3 隐私规则库引擎验收：validator / contextKeywords / caseSensitive /
 * 规则分组统计与整组启停（含审计）/ 85 条目录全量可扫描。
 */

function partitionRule(
  fx: ReturnType<typeof setup>,
  input: {
    code: string;
    pattern: string;
    priority?: number;
    validator?: string;
    contextKeywords?: string[];
    caseSensitive?: boolean;
    enabled?: boolean;
    maskKeepLast?: number;
  },
) {
  return fx.svc.createPrivacyRule(
    'partition',
    fx.partitionId,
    {
      code: input.code,
      name: `测试 ${input.code}`,
      kind: 'regex',
      pattern: input.pattern,
      action: 'mask',
      maskMode: 'keepLast',
      maskKeepLast: input.maskKeepLast ?? 4,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 1,
      validator: input.validator,
      contextKeywords: input.contextKeywords,
      caseSensitive: input.caseSensitive,
    },
    fx.actor,
  );
}

/* ------------------------------------------------------------------ */
/* validator                                                          */
/* ------------------------------------------------------------------ */

test('privacy validator：luhn/cn_id 不通过则跳过命中，未知 validator fail-open', () => {
  const fx = setup();
  partitionRule(fx, { code: 'test_card', pattern: String.raw`(?<!\d)\d{16,19}(?!\d)`, validator: 'luhn' });

  const invalidCard = scanText(fx.db, fx.partitionId, '卡号 4111111111111112 未通过 luhn');
  assert.equal(invalidCard.hits.filter((hit) => hit.code === 'test_card').length, 0);
  assert.equal(invalidCard.text, '卡号 4111111111111112 未通过 luhn', '校验失败不得替换');

  const validCard = scanText(fx.db, fx.partitionId, '卡号 4111111111111111');
  assert.equal(validCard.hits.filter((hit) => hit.code === 'test_card').length, 1);
  assert.ok(validCard.text.includes('1111'));

  const invalidId = scanText(fx.db, fx.partitionId, '身份证 110105194912310021');
  assert.equal(invalidId.hits.length, 0, '内置 id_card 的 cn_id 校验位不通过');

  // 直接改库模拟历史 / 未知 validator：扫描按 fail-open 不拦截。
  fx.db
    .prepare("UPDATE privacy_rules SET validator = 'mystery_check' WHERE scope = 'partition' AND partition_id = ? AND code = 'test_card'")
    .run(fx.partitionId);
  const failOpen = scanText(fx.db, fx.partitionId, '卡号 4111111111111112');
  assert.equal(failOpen.hits.filter((hit) => hit.code === 'test_card').length, 1);
  fx.db.close();
});

/* ------------------------------------------------------------------ */
/* contextKeywords / caseSensitive                                    */
/* ------------------------------------------------------------------ */

test('privacy contextKeywords：前后 32 字符窗口内出现任一关键词才命中（大小写不敏感）', () => {
  const fx = setup();
  partitionRule(fx, {
    code: 'ctx_order',
    pattern: String.raw`(?<!\d)\d{12}(?!\d)`,
    contextKeywords: ['订单', 'order'],
  });

  assert.equal(scanText(fx.db, fx.partitionId, '订单号 123456789012').hits.length, 1, '中文关键词命中');
  assert.equal(scanText(fx.db, fx.partitionId, 'Order 123456789012').hits.length, 1, '关键词大小写不敏感');
  assert.equal(scanText(fx.db, fx.partitionId, '编号 123456789012').hits.length, 0, '无关键词不命中');

  // 32 字符窗口：关键词距值 ≤32 命中，>32 不命中（关键词 3 字符 + 28 填充 = 值前 31 字符）。
  const near = `订单${'x'.repeat(28)}123456789012`;
  const far = `订单${'x'.repeat(40)}123456789012`;
  assert.equal(scanText(fx.db, fx.partitionId, near).hits.length, 1, '窗口内命中');
  assert.equal(scanText(fx.db, fx.partitionId, far).hits.length, 0, '超出窗口不命中');
  fx.db.close();
});

test('privacy caseSensitive：false 时忽略大小写，true 时严格匹配', () => {
  const fx = setup();
  partitionRule(fx, { code: 'case_insensitive', pattern: String.raw`EMP-\d{4}`, caseSensitive: false });
  partitionRule(fx, { code: 'case_sensitive', pattern: String.raw`ACME-\d{4}`, caseSensitive: true, priority: 2 });

  const insensitive = scanText(fx.db, fx.partitionId, '员工 emp-1234');
  assert.equal(insensitive.hits.filter((hit) => hit.code === 'case_insensitive').length, 1);

  const sensitive = scanText(fx.db, fx.partitionId, '客户 acme-5678');
  assert.equal(sensitive.hits.filter((hit) => hit.code === 'case_sensitive').length, 0);

  const exact = scanText(fx.db, fx.partitionId, '客户 ACME-5678');
  assert.equal(exact.hits.filter((hit) => hit.code === 'case_sensitive').length, 1);
  fx.db.close();
});

/* ------------------------------------------------------------------ */
/* 分组统计 / 整组启停                                                 */
/* ------------------------------------------------------------------ */

test('privacy groups：18 组 / 85 条统计，enabledCount 与 appliedCount 随覆盖变化', () => {
  const fx = setup();
  const groups = fx.svc.listPrivacyRuleGroups();
  assert.equal(groups.length, 18);
  assert.equal(groups.reduce((sum, group) => sum + group.ruleCount, 0), 85);
  assert.equal(groups.reduce((sum, group) => sum + group.appliedCount, 0), 0);
  assert.equal(groups.reduce((sum, group) => sum + group.enabledCount, 0), 4, '默认仅 4 条启用');
  const enabledGroups = groups.filter((group) => group.enabledCount > 0).map((group) => group.key).sort();
  assert.deepEqual(enabledGroups, ['contact', 'finance', 'identity_cn']);
  assert.deepEqual(
    groups.map((group) => group.key),
    [...groups].sort((left, right) => left.sortOrder - right.sortOrder).map((group) => group.key),
    '按 sortOrder 排序',
  );

  const finance = groups.find((group) => group.key === 'finance');
  assert.ok(finance);

  const applied = fx.svc.applyPrivacyGroup(fx.partitionId, 'finance', true, fx.actor);
  assert.equal(applied.length, finance.ruleCount, '返回该组生效规则');
  const afterEnable = fx.svc.listPrivacyRuleGroups(fx.partitionId).find((group) => group.key === 'finance');
  assert.equal(afterEnable?.enabledCount, finance.ruleCount);
  assert.equal(afterEnable?.appliedCount, finance.ruleCount);
  const partitionRows = fx.db
    .prepare("SELECT COUNT(*) AS c FROM privacy_rules WHERE scope = 'partition' AND partition_id = ? AND group_key = 'finance'")
    .get(fx.partitionId) as unknown as { c: number };
  assert.equal(partitionRows.c, finance.ruleCount, '每条全局规则一份分区覆盖');
  assert.equal(
    (fx.db
      .prepare("SELECT builtin FROM privacy_rules WHERE scope = 'partition' AND partition_id = ? LIMIT 1")
      .get(fx.partitionId) as unknown as { builtin: number }).builtin,
    0,
    '分区覆盖不是 builtin',
  );

  fx.svc.applyPrivacyGroup(fx.partitionId, 'finance', false, fx.actor);
  const afterDisable = fx.svc.listPrivacyRuleGroups(fx.partitionId).find((group) => group.key === 'finance');
  assert.equal(afterDisable?.enabledCount, 0, '整组停用后即使全局启用也被覆盖为 0');
  assert.equal(afterDisable?.appliedCount, finance.ruleCount);
  assert.equal(
    (fx.db
      .prepare("SELECT COUNT(*) AS c FROM privacy_rules WHERE scope = 'partition' AND partition_id = ? AND group_key = 'finance'")
      .get(fx.partitionId) as unknown as { c: number }).c,
    finance.ruleCount,
    '重复 apply 幂等（不重复插入）',
  );

  fx.svc.applyPrivacyGroup(fx.partitionId, 'finance', true, fx.actor);
  assert.equal(
    fx.svc.listPrivacyRuleGroups(fx.partitionId).find((group) => group.key === 'finance')?.enabledCount,
    finance.ruleCount,
  );

  // 审计：privacy.group.apply，detail 含 group/enabled/count
  const audits = fx.db
    .prepare("SELECT detail FROM audit_logs WHERE action = 'privacy.group.apply' ORDER BY created_at ASC")
    .all() as unknown as { detail: string }[];
  assert.equal(audits.length, 3);
  const first = JSON.parse(audits[0]?.detail ?? '{}') as { group?: string; enabled?: boolean; count?: number };
  assert.equal(first.group, 'finance');
  assert.equal(first.enabled, true);
  assert.equal(first.count, finance.ruleCount);
  fx.db.close();
});

test('privacy groups：已有分区规则只改 enabled，不覆盖自定义 pattern', () => {
  const fx = setup();
  const custom = fx.svc.createPrivacyRule(
    'partition',
    fx.partitionId,
    {
      code: 'passport_cn',
      name: '自定义护照',
      kind: 'regex',
      pattern: String.raw`CUSTOM-\d{3}`,
      enabled: false,
      priority: 3,
    },
    fx.actor,
  );
  assert.equal(custom.scope, 'partition');

  fx.svc.applyPrivacyGroup(fx.partitionId, 'identity_cn', true, fx.actor);
  const after = fx.svc.listPrivacyRules(fx.partitionId).find((rule) => rule.code === 'passport_cn');
  assert.equal(after?.scope, 'partition');
  assert.equal(after?.pattern, String.raw`CUSTOM-\d{3}`, 'pattern 保留');
  assert.equal(after?.name, '自定义护照', 'name 保留');
  assert.equal(after?.enabled, true, 'enabled 被整组启用');

  const group = fx.svc.listPrivacyRuleGroups(fx.partitionId).find((item) => item.key === 'identity_cn');
  assert.equal(group?.appliedCount, group?.ruleCount);
  fx.db.close();
});

test('privacy groups：apply 拒绝未知分组/分区', () => {
  const fx = setup();
  assert.throws(() => fx.svc.applyPrivacyGroup(fx.partitionId, 'no_such_group', true, fx.actor), /分组/);
  assert.throws(() => fx.svc.applyPrivacyGroup('ptn_missing', 'finance', true, fx.actor), /分区/);
  fx.db.close();
});

/* ------------------------------------------------------------------ */
/* 85 条目录全量可扫描                                                 */
/* ------------------------------------------------------------------ */

test('privacy catalog：18 组 / 85 条规则结构合法、每条 regex 均可执行', () => {
  assert.equal(PRIVACY_GROUPS.length, 18);
  assert.equal(PRIVACY_CATALOG.length, 85);
  assert.equal(new Set(PRIVACY_CATALOG.map((rule) => rule.code)).size, 85, 'code 唯一');
  const groupKeys = new Set(PRIVACY_GROUPS.map((group) => group.key));
  for (const rule of PRIVACY_CATALOG) {
    assert.ok(groupKeys.has(rule.groupKey), `未知分组 ${rule.groupKey}（${rule.code}）`);
    assert.ok(['regex', 'prompt'].includes(rule.kind));
    if (rule.kind === 'regex') {
      assert.ok(rule.pattern, `${rule.code} 缺 pattern`);
      assert.doesNotThrow(() => new RegExp(rule.pattern as string, rule.flags ?? 'g'), `${rule.code} 正则无法编译`);
    } else {
      assert.ok(rule.instruction, `${rule.code} 缺 instruction`);
    }
  }

  const fx = setup();
  const rules = fx.svc.listPrivacyRules();
  const sample = [
    '张三 alice@example.com 13812345678 11010519491231002X 4111111111111111',
    '地址 北京市朝阳区建国路88号 邮编 100022 生日 1990-01-01',
    'IBAN GB82WEST12345698765432 VIN 1HGCM82633A004352 坐标 39.9042,116.4074',
    'IP 192.168.1.1 / 2001:db8::1 MAC 00:1A:2B:3C:4D:5E',
    'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    'USCC 91350100M000100Y43 ETH 0x52908400098527886E0F7030069857D2E4169EE7',
    'BTC 1BoatSLRHtKNngkdXEeobR76b53LETtpyT 订单号 123456789012',
  ].join('\n');
  // 逐条规则单独执行（enabled=true），确保 85 条目录不会在扫描路径抛异常。
  for (const rule of rules) {
    assert.doesNotThrow(
      () => scanText(fx.db, fx.partitionId, sample, { rules: [{ ...rule, enabled: true }] }),
      `${rule.code} 扫描异常`,
    );
  }

  // 默认启用规则在真实合并路径中可命中。
  const scanned = scanText(fx.db, fx.partitionId, sample);
  const codes = new Set(scanned.hits.map((hit) => hit.code));
  for (const code of ['email', 'phone', 'id_card', 'bank_card']) {
    assert.ok(codes.has(code), `默认规则 ${code} 应命中`);
  }
  fx.db.close();
});

test('privacy catalog：分组覆盖后 85 条全部启用可扫描（抽样无异常）', () => {
  const fx = setup();
  for (const group of PRIVACY_GROUPS) {
    fx.svc.applyPrivacyGroup(fx.partitionId, group.key, true, fx.actor);
  }
  const groups = fx.svc.listPrivacyRuleGroups(fx.partitionId);
  assert.equal(groups.reduce((sum, group) => sum + group.enabledCount, 0), 85);
  assert.equal(groups.every((group) => group.appliedCount === group.ruleCount), true);

  const text =
    '张三 13812345678 alice@example.com 11010519491231002X 4111111111111111 ' +
    '订单号 123456789012 学号 20240101 准考证 20240101001';
  const scan = scanText(fx.db, fx.partitionId, text);
  assert.ok(scan.hits.length >= 4, JSON.stringify(scan.hits.map((hit) => hit.code)));
  fx.db.close();
});
