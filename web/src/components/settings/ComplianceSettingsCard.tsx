import type { PiiRedactionMode } from '@lib/types.ts';
import { PII_REDACTION_EXAMPLES, PII_REDACTION_OPTIONS } from '@lib/constants.ts';
import { Badge, Callout, Card, SectionHead, Segmented } from '@ui';

/**
 * 分区设置里的「PII 与合规」卡片（v6.1 P2）：
 *  - settings.piiRedaction = off | basic；
 *  - basic 在写入时对手机号 / 邮箱 / 身份证 / 银行卡做正则脱敏；
 *  - 展示脱敏示例与边界（只影响新写入，不回溯改写历史记忆）。
 *
 * 表单受控于 SettingsPage 的 FormState，随「保存设置」一起 PATCH /api/partitions/:p。
 */
export function ComplianceSettingsCard({
  value,
  onChange,
}: {
  value: PiiRedactionMode;
  onChange: (next: PiiRedactionMode) => void;
}) {
  const current = PII_REDACTION_OPTIONS.find((option) => option.value === value) ?? PII_REDACTION_OPTIONS[0]!;

  return (
    <Card pad>
      <SectionHead
        title="PII 与合规"
        desc="写入记忆前对个人敏感信息做脱敏；开关按分区生效，随「保存设置」一起提交。"
        actions={<Badge tone="amber" size="sm">v6.1 P2</Badge>}
      />
      <div className="vstack gap-14 mt-14">
        <div className="between wrap gap-10">
          <div>
            <div className="small">PII 脱敏级别（settings.piiRedaction）</div>
            <div className="tiny dim mt-4">{current.desc}</div>
          </div>
          <Segmented
            options={PII_REDACTION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            value={value}
            onChange={(next) => onChange(next as PiiRedactionMode)}
          />
        </div>

        <div className="pii-examples">
          <div className="between wrap gap-8">
            <div>
              <div className="small">脱敏示例</div>
              <div className="tiny dim mt-4">
                基础脱敏会保留可读结构（如后 4 位），仅隐藏中间敏感部分；示例仅示意，实际以服务端正则为准。
              </div>
            </div>
            <Badge tone={value === 'basic' ? 'green' : 'slate'} size="sm" dot>
              {value === 'basic' ? '写入时生效' : '关闭（原文落库）'}
            </Badge>
          </div>
          <div className="pii-example-table mt-10">
            <div className="pii-example-row is-head">
              <span>类型</span>
              <span>原文</span>
              <span>{value === 'basic' ? '脱敏后' : '未启用时'}</span>
            </div>
            {PII_REDACTION_EXAMPLES.map((example) => (
              <div className="pii-example-row" key={example.label}>
                <span className="tiny dim">{example.label}</span>
                <span className="mono tiny">{example.before}</span>
                {value === 'basic' ? (
                  <span className="mono tiny pii-after">{example.after}</span>
                ) : (
                  <span className="tiny dim">保持原文</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {value === 'basic' ? (
          <Callout tone="green" icon="shield">
            新写入的记忆会在落库前完成脱敏，写入审计会标记 <span className="mono">memory.pii_redacted</span>。
            脱敏不回溯历史数据：此前写入的记忆保持原样；如需清理，请通过人的导出 / 删除（P1 生命周期）处理。
          </Callout>
        ) : (
          <Callout tone="amber" icon="alert">
            关闭后手机号、邮箱、身份证、银行卡等会以原文落库。请确认业务合规要求；涉及 C 端用户数据时建议开启「基础脱敏」。
          </Callout>
        )}
      </div>
    </Card>
  );
}
