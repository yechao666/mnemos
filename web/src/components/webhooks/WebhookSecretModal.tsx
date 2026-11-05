import type { WebhookWithSecret } from '@shared';
import { Button, Callout, CodeBlock, CopyButton, Modal } from '@ui';
import { SIGNATURE_HEADER, SIGNING_BASE, eventSummary } from './shared.tsx';

const NODE_SNIPPET = [
  "import crypto from 'node:crypto';",
  '',
  '// 原始请求体：不要使用重新序列化后的 JSON',
  'const rawBody = req.rawBody;',
  'const secret = process.env.MNEMOS_WEBHOOK_SECRET; // 替换为上方密钥',
  "const header = req.headers['x-mnemos-signature']; // t=1710000000,v1=5f1c…",
  '',
  "const parts = Object.fromEntries(header.split(',').map((item) => item.split('=', 2)));",
  'const expected = crypto',
  "  .createHmac('sha256', secret)",
  '  .update(`${parts.t}.${rawBody}`)',
  "  .digest('hex');",
  '',
  'if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) {',
  "  throw new Error('时间戳超出 5 分钟');",
  '}',
  "const received = Buffer.from(parts.v1 ?? '', 'hex');",
  "const expectedBuf = Buffer.from(expected, 'hex');",
  'if (received.length !== expectedBuf.length || !crypto.timingSafeEqual(received, expectedBuf)) {',
  "  throw new Error('签名不匹配');",
  '}',
].join('\n');

const PYTHON_SNIPPET = [
  'import hashlib',
  'import hmac',
  'import os',
  'import time',
  '',
  'raw_body = request.get_data()  # 原始字节，不要重新序列化',
  'secret = os.environ["MNEMOS_WEBHOOK_SECRET"]  # 替换为上方密钥',
  'header = request.headers["X-Mnemos-Signature"]  # t=1710000000,v1=5f1c…',
  '',
  'parts = dict(item.split("=", 1) for item in header.split(","))',
  'expected = hmac.new(',
  '    secret.encode(),',
  '    "{}.".format(parts["t"]).encode() + raw_body,',
  '    hashlib.sha256,',
  ').hexdigest()',
  '',
  'if abs(time.time() - int(parts["t"])) > 300:',
  '    raise ValueError("时间戳超出 5 分钟")',
  'if not hmac.compare_digest(expected, parts["v1"]):',
  '    raise ValueError("签名不匹配")',
].join('\n');

export function WebhookSecretModal({
  webhook,
  mode,
  onClose,
}: {
  webhook: WebhookWithSecret | null;
  mode: 'create' | 'rotate';
  onClose: () => void;
}) {
  if (!webhook) return null;
  const rotating = mode === 'rotate';

  return (
    <Modal
      open
      onClose={onClose}
      title={rotating ? '签名密钥已轮换' : '事件订阅已创建'}
      description="订阅密钥仅显示一次，关闭后无法再次查看。"
      size="lg"
      footer={
        <Button variant="primary" icon="check" onClick={onClose}>
          我已保存，关闭
        </Button>
      }
    >
      <div className="vstack gap-16">
        <Callout tone="amber" icon="alert">
          <strong>请立即复制并保存到密钥管理服务或环境变量。</strong>
          关闭此窗口后，控制台不再展示完整密钥；若泄露，只能轮换密钥并下线旧密钥。
        </Callout>

        {rotating ? (
          <Callout tone="cyan" icon="refresh">
            <strong>旧密钥已立即失效。</strong>
            请在所有消费方完成替换前暂停投递，或提前做好双密钥灰度；未通过新密钥签名的投递会在接收方校验失败。
          </Callout>
        ) : null}

        <div className="metric-grid">
          <div className="metric">
            <span className="metric-label">订阅名称</span>
            <span className="metric-value">{webhook.name}</span>
          </div>
          <div className="metric">
            <span className="metric-label">启用状态</span>
            <span className="metric-value">{webhook.enabled ? '启用' : '已暂停'}</span>
          </div>
          <div className="metric">
            <span className="metric-label">事件类型</span>
            <span className="metric-value">{eventSummary(webhook.eventTypes)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">订阅 ID</span>
            <span className="metric-value mono">{webhook.id}</span>
          </div>
          <div className="metric" style={{ gridColumn: '1 / -1' }}>
            <span className="metric-label">推送地址</span>
            <span className="metric-value mono" style={{ wordBreak: 'break-all' }}>
              {webhook.url}
            </span>
          </div>
        </div>

        <div className="code-block">
          <div className="code-head">
            <span className="mono">签名密钥</span>
            <CopyButton value={webhook.secret} label="复制密钥" />
          </div>
          <pre className="code-body" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {webhook.secret}
          </pre>
        </div>

        <div>
          <div className="doc-h3 mb-8">请求头格式</div>
          <div className="code-inline" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {`${SIGNATURE_HEADER}: t=1710000000,v1=<hex>`}
          </div>
          <div className="tiny dim mt-8" style={{ lineHeight: 1.6 }}>
            签名值为 <span className="mono">HMAC-SHA256(secret, {SIGNING_BASE})</span> 的小写十六进制；同一请求的
            <span className="mono"> t </span>
            为 Unix 秒级时间戳。请注意：必须使用原始请求体参与计算，重新序列化 JSON 会导致签名不一致。
          </div>
        </div>

        <div>
          <div className="doc-h3 mb-8">签名校验示例 · Node.js</div>
          <CodeBlock
            code={NODE_SNIPPET}
            title="verify.js"
            language="javascript"
          />
        </div>

        <div>
          <div className="doc-h3 mb-8">签名校验示例 · Python</div>
          <CodeBlock
            code={PYTHON_SNIPPET}
            title="verify.py"
            language="python"
          />
        </div>

        <Callout tone="slate" icon="info">
          <strong>重试与幂等。</strong>
          投递失败会按指数退避自动重试，连续失败后进入死信队列；重试与手动重放都可能产生重复请求，请使用载荷中的
          <span className="mono"> id </span>
          做幂等去重，并在
          <span className="mono"> t </span>
          超出 5 分钟时拒绝请求。
        </Callout>
      </div>
    </Modal>
  );
}
