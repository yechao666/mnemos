import { useEffect, useState } from 'react';
import type {
  PrivacyAction,
  PrivacyMaskMode,
  PrivacyRule,
  PrivacyRuleInput,
  PrivacyRuleKind,
  PrivacyRuleScope,
} from '@lib/types.ts';
import {
  PRIVACY_ACTION_OPTIONS,
  PRIVACY_GROUPS,
  PRIVACY_MASK_MODES,
  PRIVACY_REGION_OPTIONS,
  PRIVACY_RULE_KINDS,
  PRIVACY_SEVERITIES,
  PRIVACY_VALIDATORS,
} from '@lib/constants.ts';
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@ui';
import { api } from '@lib/api.ts';

interface RuleDraft {
  code: string;
  name: string;
  kind: PrivacyRuleKind;
  pattern: string;
  flags: string;
  instruction: string;
  entityType: string;
  action: PrivacyAction;
  maskMode: PrivacyMaskMode;
  maskKeepLast: string;
  maskKeepFirst: string;
  priority: string;
  enabled: boolean;
  /* --- v6.3 规则库字段 --- */
  groupKey: string;
  validator: string;
  /** 逗号分隔；提交时拆成数组 */
  contextKeywords: string;
  caseSensitive: boolean;
  region: string;
  severity: 'low' | 'medium' | 'high';
}

function draftFrom(rule: PrivacyRule | null, defaultGroupKey?: string): RuleDraft {
  return {
    code: rule?.code ?? '',
    name: rule?.name ?? '',
    kind: rule?.kind ?? 'regex',
    pattern: rule?.pattern ?? '',
    flags: rule?.flags || 'g',
    instruction: rule?.instruction ?? '',
    entityType: rule?.entityType ?? '',
    action: rule?.action ?? 'mask',
    maskMode: rule?.maskMode ?? 'email',
    maskKeepLast: String(rule?.maskKeepLast ?? 4),
    maskKeepFirst: String(rule?.maskKeepFirst ?? 0),
    priority: String(rule?.priority ?? 100),
    enabled: rule?.enabled ?? true,
    groupKey: rule?.groupKey || defaultGroupKey || 'common',
    validator: rule?.validator || 'none',
    contextKeywords: (rule?.contextKeywords ?? []).join(', '),
    caseSensitive: rule?.caseSensitive ?? true,
    region: rule?.region || 'global',
    severity: rule?.severity ?? 'medium',
  };
}

/** 逗号 / 中文逗号分隔的关键词 → 去重数组。 */
function parseKeywords(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[,，]/)) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** 本地校验：与服务端约束保持一致的最小集合，避免明显无效的请求。 */
function validateDraft(draft: RuleDraft, editing: boolean): string | null {
  const code = draft.code.trim();
  const name = draft.name.trim();
  if (!name) return '规则名称不能为空。';
  if (!editing) {
    if (!code) return '规则 code 不能为空（用于同 code 覆盖，例如 email / phone）。';
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(code)) {
      return '规则 code 只能包含字母、数字、_、-、.、:（1–64 位）。';
    }
  }
  if (draft.kind === 'regex') {
    if (!draft.pattern.trim()) return '正则规则需要填写 pattern。';
    try {
      // 只做语法校验；flags 非法会在这里抛错。
      new RegExp(draft.pattern, draft.flags || 'g');
    } catch (cause) {
      return `正则表达式无效：${cause instanceof Error ? cause.message : '请检查 pattern / flags'}`;
    }
  } else if (!draft.instruction.trim()) {
    return '提示词规则需要填写 instruction（告诉 LLM 抽取什么）。';
  }
  const priority = Number(draft.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100000) {
    return '优先级需要 0–100000 的整数（小者先执行，默认 100）。';
  }
  if (draft.action === 'mask') {
    const keepLast = Number(draft.maskKeepLast);
    const keepFirst = Number(draft.maskKeepFirst);
    for (const value of [keepLast, keepFirst]) {
      if (!Number.isInteger(value) || value < 0 || value > 64) {
        return '保留位数需要 0–64 的整数。';
      }
    }
    if (draft.maskMode === 'keepFirstLast' && keepFirst + keepLast > 64) {
      return '保留首尾位数之和不能超过 64。';
    }
  }
  /* --- v6.3 规则库字段 --- */
  if (!draft.groupKey.trim() || draft.groupKey.trim().length > 40) {
    return '规则库分组不能为空（最多 40 字；可在 18 个内置组中选择）。';
  }
  if (draft.kind === 'regex') {
    if (!PRIVACY_VALIDATORS.some((item) => item.value === draft.validator)) {
      return '请选择有效的校验器（可先用 none）。';
    }
    const keywords = parseKeywords(draft.contextKeywords);
    if (keywords.length > 20) return '上下文关键词最多 20 个。';
    const tooLong = keywords.find((keyword) => keyword.length > 40);
    if (tooLong) return `上下文关键词「${tooLong}」过长（最多 40 字）。`;
  }
  if (!draft.region.trim()) return '适用地区不能为空（如 global / CN / US）。';
  if (draft.region.trim().length > 32) return '适用地区最多 32 字。';
  if (!PRIVACY_SEVERITIES.some((item) => item.value === draft.severity)) {
    return '请选择有效的严重级别。';
  }
  return null;
}

/**
 * 隐私规则编辑器（v6.2 / v6.3）：
 *  - kind=regex：pattern + flags（本地做一次 RegExp 语法校验）、validator（结构/校验位）、
 *    contextKeywords（命中值附近需出现关键词）、caseSensitive（关闭时自动加 i）；
 *  - kind=prompt：instruction（需要 LLM + 分区 privacyLlmEnabled）；
 *  - 所有规则：groupKey（18 个行业/领域组）、severity、region；
 *  - action=mask：maskMode + keepFirst/keepLast；action=placeholder：生成 {{pii_xxx}}。
 *
 * 全局规则仅 owner 可写；分区规则 admin+。服务端权限不足时展示错误。
 */
export function PrivacyRuleEditor({
  open,
  scope,
  partitionId,
  rule,
  seed,
  defaultGroupKey,
  onClose,
  onSaved,
}: {
  open: boolean;
  scope: PrivacyRuleScope;
  partitionId?: string;
  rule: PrivacyRule | null;
  /** 新建分区覆盖时用全局规则预填（code 锁定，创建同 code 覆盖）。 */
  seed?: PrivacyRule | null;
  /** 未选中任何规则时的默认分组（来自左栏当前行业）。 */
  defaultGroupKey?: string;
  onClose: () => void;
  onSaved: (rule: PrivacyRule) => void;
}) {
  const toast = useToast();
  const editing = Boolean(rule);
  const codeLocked = editing || Boolean(seed);
  const [draft, setDraft] = useState<RuleDraft>(() => draftFrom(rule ?? seed ?? null, defaultGroupKey));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(rule ?? seed ?? null, defaultGroupKey));
    setError(null);
    setSaving(false);
  }, [open, rule, seed, defaultGroupKey]);

  const patch = (next: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...next }));

  const validatorMeta = PRIVACY_VALIDATORS.find((item) => item.value === draft.validator);
  const severityMeta = PRIVACY_SEVERITIES.find((item) => item.value === draft.severity);
  const groupOptions = PRIVACY_GROUPS.some((group) => group.key === draft.groupKey)
    ? PRIVACY_GROUPS.map((group) => ({
        value: group.key,
        label: `${group.name} · ${group.industry}`,
      }))
    : [
        ...PRIVACY_GROUPS.map((group) => ({
          value: group.key,
          label: `${group.name} · ${group.industry}`,
        })),
        { value: draft.groupKey, label: `${draft.groupKey} · 自定义` },
      ];
  const regionOptions = PRIVACY_REGION_OPTIONS.some((item) => item.value === draft.region)
    ? PRIVACY_REGION_OPTIONS
    : [...PRIVACY_REGION_OPTIONS, { value: draft.region, label: `${draft.region} · 自定义` }];

  const submit = async () => {
    if (saving) return;
    const message = validateDraft(draft, editing);
    if (message) {
      setError(message);
      return;
    }
    const action = draft.action;
    const isRegex = draft.kind === 'regex';
    const input: PrivacyRuleInput = {
      name: draft.name.trim(),
      kind: draft.kind,
      pattern: isRegex ? draft.pattern : undefined,
      flags: isRegex ? draft.flags.trim() || 'g' : undefined,
      instruction: isRegex ? undefined : draft.instruction.trim(),
      entityType: draft.entityType.trim() || draft.code.trim(),
      action,
      maskMode: action === 'mask' ? draft.maskMode : 'email',
      maskKeepLast: action === 'mask' ? Number(draft.maskKeepLast) : undefined,
      maskKeepFirst: action === 'mask' ? Number(draft.maskKeepFirst) : undefined,
      priority: Number(draft.priority),
      enabled: draft.enabled,
      /* v6.3：自定义规则同样可选分组 / 校验器 / 上下文 */
      groupKey: draft.groupKey,
      validator: isRegex ? draft.validator : 'none',
      contextKeywords: isRegex ? parseKeywords(draft.contextKeywords) : [],
      caseSensitive: isRegex ? draft.caseSensitive : true,
      region: draft.region.trim() || 'global',
      severity: draft.severity,
    };
    if (!editing) input.code = draft.code.trim();

    setSaving(true);
    setError(null);
    try {
      const saved = rule
        ? await api.privacy.updateRule(rule.id, input)
        : await api.privacy.createRule({
            ...input,
            scope,
            partitionId: scope === 'partition' ? partitionId : undefined,
          });
      toast.success(editing ? '隐私规则已更新' : '隐私规则已创建');
      onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存隐私规则失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? '编辑隐私规则' : seed ? '创建分区覆盖规则' : '新建隐私规则'}
      description={
        seed
          ? '基于选中的全局规则创建同 code 分区覆盖：code 不可修改；保存后该分区使用这里的字段，其他分区不受影响。'
          : scope === 'global'
            ? '全局规则是组织默认值；分区可用同 code 的规则覆盖 pattern / instruction / action / enabled。'
            : '当前分区规则：同 code 时覆盖全局规则，priority 小者先执行。'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="check" loading={saving} onClick={() => void submit()}>
            {editing ? '保存规则' : seed ? '创建覆盖' : '创建规则'}
          </Button>
        </>
      }
    >
      <div className="vstack gap-12">
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field
            label="规则 code"
            required={!editing}
            htmlFor="privacy-rule-code"
            hint={codeLocked ? 'code 是覆盖键，创建后不可修改。' : '如 email / phone / id_card / name。'}
          >
            <Input
              id="privacy-rule-code"
              className="mono"
              value={draft.code}
              readOnly={codeLocked}
              placeholder="employee_id"
              maxLength={64}
              onChange={(event) => patch({ code: event.target.value })}
            />
          </Field>
          <Field label="名称" required htmlFor="privacy-rule-name">
            <Input
              id="privacy-rule-name"
              value={draft.name}
              placeholder="例如：员工工号"
              maxLength={120}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
        </div>

        <Field label="规则类型" hint={PRIVACY_RULE_KINDS.find((item) => item.value === draft.kind)?.desc}>
          <Segmented
            options={PRIVACY_RULE_KINDS.map((item) => ({ value: item.value, label: item.label }))}
            value={draft.kind}
            onChange={(next) => patch({ kind: next as PrivacyRuleKind })}
          />
        </Field>

        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field
            label="规则库分组 groupKey"
            htmlFor="privacy-rule-group"
            hint="规则库按 18 个行业/领域分组，整组启用/停用会为分区写入覆盖。"
          >
            <Select
              id="privacy-rule-group"
              options={groupOptions}
              value={draft.groupKey}
              onChange={(event) => patch({ groupKey: event.target.value })}
            />
          </Field>
          <Field label="严重级别 severity" htmlFor="privacy-rule-severity" hint={severityMeta?.desc}>
            <Select
              id="privacy-rule-severity"
              options={PRIVACY_SEVERITIES.map((item) => ({
                value: item.value,
                label: `${item.label} · ${item.value}`,
              }))}
              value={draft.severity}
              onChange={(event) => patch({ severity: event.target.value as RuleDraft['severity'] })}
            />
          </Field>
        </div>

        {draft.kind === 'regex' ? (
          <>
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 120px', gap: 12 }}>
              <Field label="正则 pattern" required htmlFor="privacy-rule-pattern" hint="只扫描命中片段；已替换的片段不会被后续规则重复命中。">
                <Textarea
                  id="privacy-rule-pattern"
                  className="mono"
                  value={draft.pattern}
                  placeholder="EMP-\\d{6}"
                  style={{ minHeight: 76 }}
                  onChange={(event) => patch({ pattern: event.target.value })}
                />
              </Field>
              <Field label="flags" htmlFor="privacy-rule-flags" hint="默认 g">
                <Input
                  id="privacy-rule-flags"
                  className="mono"
                  value={draft.flags}
                  placeholder="g"
                  maxLength={8}
                  onChange={(event) => patch({ flags: event.target.value.replace(/[^gimsuy]/g, '') })}
                />
              </Field>
            </div>

            <div className="grid grid-2" style={{ gap: 12 }}>
              <Field
                label="校验器 validator"
                htmlFor="privacy-rule-validator"
                hint={validatorMeta?.desc ?? '用于校验结构/校验位，降低正则误报。'}
              >
                <Select
                  id="privacy-rule-validator"
                  options={PRIVACY_VALIDATORS.map((item) => ({
                    value: item.value,
                    label: `${item.label} · ${item.value}`,
                  }))}
                  value={draft.validator}
                  onChange={(event) => patch({ validator: event.target.value })}
                />
              </Field>
              <Field
                label="适用地区 region"
                htmlFor="privacy-rule-region"
                hint="用于展示与统计，如 global / CN / US / EU。"
              >
                <Select
                  id="privacy-rule-region"
                  options={regionOptions}
                  value={draft.region}
                  onChange={(event) => patch({ region: event.target.value })}
                />
              </Field>
            </div>

            <Field
              label="上下文关键词 contextKeywords"
              htmlFor="privacy-rule-context"
              hint="逗号分隔；命中值前后 32 字符内需出现其一（不区分大小写），用于压缩误报。"
            >
              <Input
                id="privacy-rule-context"
                value={draft.contextKeywords}
                placeholder="CVV, CVC, 安全码"
                maxLength={400}
                onChange={(event) => patch({ contextKeywords: event.target.value })}
              />
              {parseKeywords(draft.contextKeywords).length ? (
                <div className="chip-row mt-6">
                  {parseKeywords(draft.contextKeywords).map((keyword) => (
                    <Badge key={keyword} tone="slate" size="sm">{keyword}</Badge>
                  ))}
                </div>
              ) : null}
            </Field>

            <div className="between wrap gap-10">
              <div>
                <div className="small">区分大小写 caseSensitive</div>
                <div className="tiny dim mt-4">
                  关闭后正则编译时自动加 <span className="mono">i</span> 标志；适合邮箱、域名等大小写不敏感场景。
                </div>
              </div>
              <Switch
                checked={draft.caseSensitive}
                onChange={(next) => patch({ caseSensitive: next })}
              />
            </div>
          </>
        ) : (
          <>
            <Field
              label="抽取指令 instruction"
              required
              htmlFor="privacy-rule-instruction"
              hint="告诉 LLM 抽取什么；仅在分区开启 privacyLlmEnabled 且 LLM 可用时执行，失败静默回退。"
            >
              <Textarea
                id="privacy-rule-instruction"
                value={draft.instruction}
                placeholder="抽取文本中出现的人名（中文姓名），只返回原文中确实出现的值。"
                style={{ minHeight: 88 }}
                onChange={(event) => patch({ instruction: event.target.value })}
              />
            </Field>
            <Field
              label="适用地区 region"
              htmlFor="privacy-rule-region-prompt"
              hint="用于展示与统计；提示词规则不做 validator / contextKeywords 过滤。"
            >
              <Select
                id="privacy-rule-region-prompt"
                options={regionOptions}
                value={draft.region}
                onChange={(event) => patch({ region: event.target.value })}
              />
            </Field>
          </>
        )}

        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="实体类型 entityType" htmlFor="privacy-rule-entity" hint="用于命中展示与统计；缺省同 code。">
            <Input
              id="privacy-rule-entity"
              className="mono"
              value={draft.entityType}
              placeholder="employee_id"
              maxLength={64}
              onChange={(event) => patch({ entityType: event.target.value })}
            />
          </Field>
          <Field label="优先级 priority" htmlFor="privacy-rule-priority" hint="小者先执行，默认 100。">
            <Input
              id="privacy-rule-priority"
              className="mono"
              value={draft.priority}
              inputMode="numeric"
              onChange={(event) => patch({ priority: event.target.value.replace(/[^0-9]/g, '') })}
            />
          </Field>
        </div>

        <Field label="命中动作" hint={PRIVACY_ACTION_OPTIONS.find((item) => item.value === draft.action)?.desc}>
          <Segmented
            options={PRIVACY_ACTION_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
            value={draft.action}
            onChange={(next) => patch({ action: next as PrivacyAction })}
          />
        </Field>

        {draft.action === 'mask' ? (
          <>
            <Field label="打码模式 maskMode" htmlFor="privacy-rule-mask-mode">
              <Select
                id="privacy-rule-mask-mode"
                options={PRIVACY_MASK_MODES.map((item) => ({ value: item.value, label: item.label }))}
                value={draft.maskMode}
                onChange={(event) => patch({ maskMode: event.target.value as PrivacyMaskMode })}
              />
            </Field>
            {draft.maskMode === 'keepFirstLast' || draft.maskMode === 'keepLast' ? (
              <div className="grid grid-2" style={{ gap: 12 }}>
                {draft.maskMode === 'keepFirstLast' ? (
                  <Field label="保留前 N 位" htmlFor="privacy-rule-keep-first">
                    <Input
                      id="privacy-rule-keep-first"
                      className="mono"
                      value={draft.maskKeepFirst}
                      inputMode="numeric"
                      onChange={(event) => patch({ maskKeepFirst: event.target.value.replace(/[^0-9]/g, '') })}
                    />
                  </Field>
                ) : null}
                <Field label="保留后 N 位" htmlFor="privacy-rule-keep-last">
                  <Input
                    id="privacy-rule-keep-last"
                    className="mono"
                    value={draft.maskKeepLast}
                    inputMode="numeric"
                    onChange={(event) => patch({ maskKeepLast: event.target.value.replace(/[^0-9]/g, '') })}
                  />
                </Field>
              </div>
            ) : null}
          </>
        ) : (
          <Callout tone="cyan" icon="shield">
            占位符动作会把命中值替换为 <span className="mono">{'{{pii_xxxxxxxx}}'}</span>（同值复用同一 token），
            真实值加密写入 <span className="mono">memory_placeholders</span>；读取时用 reveal 解密。
          </Callout>
        )}

        <div className="between wrap gap-10">
          <div>
            <div className="small">启用规则</div>
            <div className="tiny dim mt-4">停用后该规则不参与扫描；全局内置规则也可停用（分区可覆盖）。</div>
          </div>
          <Switch checked={draft.enabled} onChange={(next) => patch({ enabled: next })} />
        </div>

        {seed ? (
          <div className="hstack gap-8 wrap">
            <Badge tone="cyan" size="sm" dot>创建分区覆盖</Badge>
            <span className="tiny dim">
              覆盖 code <span className="mono">{seed.code}</span>；保存后该分区使用本规则，删除覆盖会回退到全局。
            </span>
          </div>
        ) : null}

        {rule?.builtin ? (
          <div className="hstack gap-8 wrap">
            <Badge tone="amber" size="sm" dot>全局内置</Badge>
            <span className="tiny dim">内置规则不可删除；owner 可改 / 停用，分区可新建同 code 规则覆盖。</span>
          </div>
        ) : null}

        {error ? <Callout tone="red" icon="alert">{error}</Callout> : null}
      </div>
    </Modal>
  );
}
