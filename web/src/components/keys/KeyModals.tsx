import { useEffect, useState } from 'react';
import type { ApiKeyWithSecret } from '@lib/types.ts';
import { Button, Checkbox, CopyButton, Field, Input, Modal, useToast } from '@ui';
import type { KeyCreateInput } from '@lib/api.ts';

export const KEY_SCOPE_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: 'memories:read', label: '记忆读取', desc: '列表、搜索、详情、简报、上下文' },
  { value: 'memories:write', label: '记忆写入', desc: '新增、更新、删除记忆' },
  { value: 'admin', label: '管理', desc: '分区设置、密钥、用量与审计' },
];

/** 一次性展示新密钥（secret 只返回一次）。 */
export function KeySecretModal({
  open,
  onClose,
  keyInfo,
}: {
  open: boolean;
  onClose: () => void;
  keyInfo: ApiKeyWithSecret | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="密钥已创建"
      description="出于安全考虑，密钥明文只显示这一次；请立即复制并妥善保存。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          {keyInfo ? <CopyButton value={keyInfo.secret} label="复制密钥" /> : null}
        </>
      }
    >
      {keyInfo ? (
        <div className="vstack gap-12">
          <Field label="名称">
            <Input readOnly value={keyInfo.name} />
          </Field>
          <Field label="密钥" hint="可放入 Authorization: Bearer <secret> 或 x-api-key 请求头。">
            <Input readOnly className="mono" value={keyInfo.secret} />
          </Field>
          <div className="tiny dim">
            前缀 <span className="mono">{keyInfo.prefix}</span> · 作用域{' '}
            <span className="mono">{keyInfo.scopes.join(', ') || '—'}</span>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/** 创建分区密钥 / 组织密钥。 */
export function KeyCreateModal({
  open,
  onClose,
  kind,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  kind: 'partition' | 'org';
  onCreate: (input: KeyCreateInput) => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['memories:read', 'memories:write']);
  const [rateLimit, setRateLimit] = useState('600');
  const [expiresAt, setExpiresAt] = useState('');
  const [allowedIps, setAllowedIps] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setScopes(['memories:read', 'memories:write']);
    setRateLimit('600');
    setExpiresAt('');
    setAllowedIps('');
    setError(null);
  }, [open]);

  const submit = async () => {
    if (submitting) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请填写密钥名称。');
      return;
    }
    if (scopes.length === 0) {
      setError('至少选择一个作用域。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: trimmed,
        scopes,
        rateLimitPerMin: Number(rateLimit) || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        allowedIps: allowedIps
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      });
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '创建失败';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={kind === 'org' ? '新建组织密钥' : '新建分区密钥'}
      description={
        kind === 'org'
          ? '组织密钥可访问/创建本组织任意分区（仅 owner 可管理）。'
          : '分区密钥只能访问当前分区，按作用域最小授权。'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="key" loading={submitting} onClick={() => void submit()}>
            创建密钥
          </Button>
        </>
      }
    >
      <div className="vstack gap-12">
        <Field label="名称" required htmlFor="key-name">
          <Input
            id="key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={kind === 'org' ? '例如：DSH 插件（组织）' : '例如：生产后端服务'}
            autoFocus
          />
        </Field>

        <Field label="作用域">
          <div className="vstack gap-8">
            {KEY_SCOPE_OPTIONS.map((scope) => (
              <Checkbox
                key={scope.value}
                checked={scopes.includes(scope.value)}
                onChange={(next) =>
                  setScopes((current) =>
                    next ? [...current, scope.value] : current.filter((item) => item !== scope.value),
                  )
                }
                label={
                  <span className="vstack" style={{ gap: 1 }}>
                    <span className="small">{scope.label}</span>
                    <span className="tiny dim">{scope.desc}</span>
                  </span>
                }
              />
            ))}
          </div>
        </Field>

        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="每分钟限流" htmlFor="key-rate">
            <Input
              id="key-rate"
              value={rateLimit}
              onChange={(event) => setRateLimit(event.target.value.replace(/[^0-9]/g, ''))}
              placeholder="600"
            />
          </Field>
          <Field label="有效期（可选）" htmlFor="key-expires">
            <Input
              id="key-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="IP 白名单（可选）"
          htmlFor="key-ips"
          hint="留空表示不限制；支持逗号或空格分隔。"
        >
          <Input
            id="key-ips"
            value={allowedIps}
            onChange={(event) => setAllowedIps(event.target.value)}
            placeholder="10.0.0.0/8, 203.0.113.8"
          />
        </Field>

        {error ? (
          <div className="field-error" role="alert">{error}</div>
        ) : null}
      </div>
    </Modal>
  );
}
