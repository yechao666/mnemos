import type { ApiKeyWithSecret } from '@shared';
import { fmtDateTime, fmtInt } from '@lib/format.ts';
import { Button, Callout, CodeBlock, CopyButton, Modal } from '@ui';
import { ScopeBadges } from './ScopeBadges.tsx';

export function KeySecretModal({
  created,
  onClose,
  mode = 'create',
  graceHours = 0,
}: {
  created: ApiKeyWithSecret | null;
  onClose: () => void;
  mode?: 'create' | 'rotate';
  graceHours?: number;
}) {
  if (!created) return null;
  const origin = typeof window === 'undefined' ? 'https://console.mnemos.dev' : window.location.origin;
  const curl = [
    `export MNEMOS_API_KEY="${created.secret}"`,
    '',
    `curl -X POST "${origin}/v1/memories" \\`,
    '  -H "Authorization: Bearer $MNEMOS_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"messages":[{"role":"user","content":"我偏好深色模式"}],"user_id":"user_123"}\'',
  ].join('\n');
  const rotating = mode === 'rotate';
  const expiresLabel = created.expiresAt ? fmtDateTime(created.expiresAt) : '永不过期';

  return (
    <Modal
      open
      onClose={onClose}
      title={rotating ? '密钥已轮换' : '密钥已创建'}
      description="完整密钥仅显示一次，关闭后无法再次查看。"
      size="lg"
      footer={
        <Button variant="primary" icon="check" onClick={onClose}>
          我已保存，关闭
        </Button>
      }
    >
      <div className="vstack gap-16">
        <Callout tone="amber" icon="alert">
          <strong>请立即复制并保存到安全位置。</strong>
          关闭此窗口后，控制台只保留密钥前缀，无法再次展示完整密钥。若泄露，请吊销后重新创建。
        </Callout>

        {rotating ? (
          <Callout tone="cyan" icon="refresh">
            <strong>旧密钥{graceHours > 0 ? `将在 ${graceHours} 小时后自动失效` : '已立即失效'}。</strong>
            {graceHours > 0
              ? '请在宽限期内完成所有调用方的配置替换，宽限期结束后旧密钥自动吊销。'
              : '所有使用旧密钥的服务会立即失去访问权限，请立刻更新环境变量与密钥管理服务。'}
          </Callout>
        ) : null}

        <div className="metric-grid">
          <div className="metric">
            <span className="metric-label">名称</span>
            <span className="metric-value">{created.name}</span>
          </div>
          <div className="metric">
            <span className="metric-label">有效期</span>
            <span className="metric-value" style={created.expiresAt ? undefined : { color: 'var(--amber)' }}>
              {expiresLabel}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">限流</span>
            <span className="metric-value">{fmtInt(created.rateLimitPerMin)} 次 / 分钟</span>
          </div>
          <div className="metric">
            <span className="metric-label">IP 白名单</span>
            <span className="metric-value" title={(created.allowedIps ?? []).join('、')}>
              {(created.allowedIps ?? []).length > 0 ? `${(created.allowedIps ?? []).length} 个来源` : '不限制'}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">作用域</span>
            <span className="metric-value">
              <ScopeBadges scopes={created.scopes} size="sm" />
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">前缀</span>
            <span className="metric-value mono">{created.prefix}…</span>
          </div>
        </div>

        <div className="code-block">
          <div className="code-head">
            <span className="mono">完整密钥</span>
            <CopyButton value={created.secret} label="复制密钥" />
          </div>
          <pre className="code-body" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {created.secret}
          </pre>
        </div>

        <div>
          <div className="doc-h3 mb-8">使用示例</div>
          <CodeBlock code={curl} language="bash" title="curl · 写入一条记忆" />
        </div>
      </div>
    </Modal>
  );
}
