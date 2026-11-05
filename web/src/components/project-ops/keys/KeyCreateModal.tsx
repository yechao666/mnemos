import { useEffect, useState } from 'react';
import type { ApiKeyWithSecret, ApiScope } from '@shared';
import { SCOPES } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { Button, Callout, Checkbox, Field, Input, Modal, Select, Textarea } from '@ui';

const DEFAULT_SCOPES: ApiScope[] = ['memories:read', 'memories:write'];

const EXPIRY_OPTIONS = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '365 天' },
  { value: 'never', label: '永不过期' },
];

const IPV4 = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}';
const IPV4_RE = new RegExp(`^${IPV4}$`);
const CIDR_RE = new RegExp(`^${IPV4}\\/(?:3[0-2]|[12]?\\d)$`);

function isIpEntry(value: string): boolean {
  return IPV4_RE.test(value) || CIDR_RE.test(value);
}

/** 按逗号、分号或换行拆分 IP，允许重复值但会去重。 */
function parseIpList(input: string): string[] {
  const tokens = input
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(tokens)];
}

export function KeyCreateModal({
  open,
  onClose,
  projectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (created: ApiKeyWithSecret) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(DEFAULT_SCOPES);
  const [rateLimit, setRateLimit] = useState('600');
  const [expiry, setExpiry] = useState('90');
  const [ipInput, setIpInput] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setScopes(DEFAULT_SCOPES);
    setRateLimit('600');
    setExpiry('90');
    setIpInput('');
    setTouched(false);
    setSubmitting(false);
    setError(null);
  }, [open]);

  const trimmedName = name.trim();
  const rateLimitValue = Number(rateLimit);
  const ipEntries = parseIpList(ipInput);
  const invalidIps = ipEntries.filter((entry) => !isIpEntry(entry));
  const nameError = trimmedName.length === 0 ? '请输入密钥名称' : trimmedName.length > 60 ? '名称不能超过 60 个字符' : null;
  const scopesError = scopes.length === 0 ? '至少选择一个作用域' : null;
  const rateLimitError =
    !Number.isFinite(rateLimitValue) || !Number.isInteger(rateLimitValue) || rateLimitValue < 1 || rateLimitValue > 100000
      ? '请输入 1–100000 之间的整数'
      : null;
  const ipError =
    invalidIps.length > 0
      ? `格式不正确：${invalidIps.slice(0, 3).join('、')}${invalidIps.length > 3 ? ' 等' : ''}。仅支持 IPv4 或 CIDR。`
      : ipEntries.length > 20
        ? 'IP 白名单最多支持 20 条规则'
        : null;
  const valid = !nameError && !scopesError && !rateLimitError && !ipError;

  const toggleScope = (value: ApiScope, checked: boolean) => {
    setScopes((prev) => (checked ? [...prev, value] : prev.filter((scope) => scope !== value)));
  };

  const submit = async () => {
    setTouched(true);
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const orderedScopes = SCOPES.filter((scope) => scopes.includes(scope.value)).map((scope) => scope.value);
      const days = Number(expiry);
      const expiresAt =
        expiry === 'never' || !Number.isFinite(days) || days <= 0
          ? undefined
          : new Date(Date.now() + days * 86_400_000).toISOString();
      const created = await api.projects.keys.create(projectId, {
        name: trimmedName,
        scopes: orderedScopes,
        rateLimitPerMin: rateLimitValue,
        expiresAt,
        allowedIps: ipEntries.length > 0 ? ipEntries : undefined,
      });
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '创建密钥失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建 API 密钥"
      description="密钥按项目隔离，创建后仅展示一次完整内容。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" icon="key" loading={submitting} onClick={() => void submit()}>
            创建密钥
          </Button>
        </>
      }
    >
      <div className="vstack gap-16">
        <Field
          label="名称"
          htmlFor="key-name"
          required
          error={touched && nameError ? nameError : undefined}
          hint="用于识别调用方，例如「生产服务端」「本地脚本」。"
        >
          <Input
            id="key-name"
            value={name}
            placeholder="例如：订单服务 · 生产"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </Field>

        <Field
          label="作用域"
          required
          error={touched && scopesError ? scopesError : undefined}
          hint="遵循最小权限原则，只勾选服务实际需要的权限。"
        >
          <div className="vstack gap-8">
            {SCOPES.map((scope) => (
              <Checkbox
                key={scope.value}
                checked={scopes.includes(scope.value)}
                onChange={(checked) => toggleScope(scope.value, checked)}
                label={
                  <span>
                    <span className="small strong">{scope.label}</span>
                    <span className="tiny dim"> · {scope.desc}</span>
                    <span className="mono tiny dim">（{scope.value}）</span>
                  </span>
                }
              />
            ))}
          </div>
        </Field>

        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field
            label="限流"
            htmlFor="key-rate-limit"
            error={touched && rateLimitError ? rateLimitError : undefined}
            hint="每分钟允许的请求数，超出后返回 429。"
          >
            <Input
              id="key-rate-limit"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={rateLimit}
              onChange={(event) => setRateLimit(event.target.value)}
              suffix="次 / 分钟"
              style={{ paddingLeft: 11, paddingRight: 74 }}
            />
          </Field>

          <Field
            label="有效期"
            htmlFor="key-expiry"
            hint="到期后密钥自动失效，建议按环境设置 90 天以内。"
          >
            <Select
              id="key-expiry"
              options={EXPIRY_OPTIONS}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="IP 白名单"
          htmlFor="key-allowed-ips"
          error={touched && ipError ? ipError : undefined}
          hint="逗号或换行分隔，支持 IPv4 与 CIDR；留空表示不限制来源 IP。"
        >
          <Textarea
            id="key-allowed-ips"
            className="mono"
            value={ipInput}
            placeholder={'203.0.113.7\n10.0.0.0/8'}
            style={{ minHeight: 64 }}
            onChange={(event) => setIpInput(event.target.value)}
          />
        </Field>

        {error ? (
          <Callout tone="red" icon="alert">
            {error}
          </Callout>
        ) : null}
      </div>
    </Modal>
  );
}
