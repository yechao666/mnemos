import { useEffect, useState } from 'react';
import type { ApiKey, ApiKeyWithSecret } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { fmtDateTime } from '@lib/format.ts';
import { Badge, Button, Callout, Field, Modal, Select } from '@ui';
import { KEY_GRACE_OPTIONS, KEY_LIFECYCLE_META, keyLifecycle } from './keyMeta.ts';

/**
 * 密钥轮换：生成新密钥并设置旧密钥宽限期。
 * 轮换成功由父组件复用「一次性密钥」Modal 展示新密钥。
 */
export function KeyRotateModal({
  projectId,
  target,
  onClose,
  onRotated,
}: {
  projectId: string;
  target: ApiKey | null;
  onClose: () => void;
  onRotated: (created: ApiKeyWithSecret, graceHours: number) => void;
}) {
  const [grace, setGrace] = useState('24');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setGrace('24');
    setSubmitting(false);
    setError(null);
  }, [target]);

  if (!target) return null;

  const lifecycle = keyLifecycle(target);
  const meta = KEY_LIFECYCLE_META[lifecycle];
  const graceValue = Number(grace);
  const immediate = graceValue === 0;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.projects.keys.rotate(projectId, target.id, graceValue);
      onRotated(created, graceValue);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '轮换密钥失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="轮换 API 密钥"
      description="为同一用途生成新密钥，并按宽限期平滑下线旧密钥。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="refresh" loading={submitting} onClick={() => void submit()}>
            确认轮换
          </Button>
        </>
      }
    >
      <div className="metric-grid">
        <div className="metric">
          <span className="metric-label">密钥名称</span>
          <span className="metric-value">{target.name}</span>
        </div>
        <div className="metric">
          <span className="metric-label">当前状态</span>
          <span className="metric-value">
            <Badge tone={meta.tone} size="sm">{meta.label}</Badge>
          </span>
        </div>
        <div className="metric">
          <span className="metric-label">前缀</span>
          <span className="metric-value mono">{target.prefix}…</span>
        </div>
        <div className="metric">
          <span className="metric-label">原有效期</span>
          <span className="metric-value" style={lifecycle === 'expired' ? { color: 'var(--red)' } : undefined}>
            {target.expiresAt ? fmtDateTime(target.expiresAt) : '永不过期'}
          </span>
        </div>
      </div>

      <Field
        label="旧密钥宽限期"
        htmlFor="key-rotate-grace"
        hint="新密钥立即生效；旧密钥在宽限期结束后自动吊销，期间仍可调用。"
      >
        <Select
          id="key-rotate-grace"
          options={KEY_GRACE_OPTIONS.map((option) => ({
            value: String(option.value),
            label: option.label,
          }))}
          value={grace}
          onChange={(event) => setGrace(event.target.value)}
        />
      </Field>

      <Callout tone={immediate ? 'red' : 'amber'} icon="alert">
        {immediate ? (
          <>
            <strong>旧密钥将立即失效。</strong>
            所有使用该密钥的服务会立刻返回认证错误，请确认已完成替换或正处于可接受的中断窗口。
          </>
        ) : (
          <>
            <strong>旧密钥将在 {graceValue} 小时后自动吊销。</strong>
            请在宽限期内完成所有调用方的配置替换；宽限期结束后旧密钥立即失效。
          </>
        )}
      </Callout>

      <div className="tiny dim">
        轮换不会修改新密钥的作用域、限流与 IP 白名单；如需调整，请创建新密钥。
      </div>

      {error ? (
        <Callout tone="red" icon="alert">{error}</Callout>
      ) : null}
    </Modal>
  );
}
