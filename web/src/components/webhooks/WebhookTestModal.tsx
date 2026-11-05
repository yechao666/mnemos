import type { Webhook, WebhookTestResult } from '@shared';
import { fmtFullDateTime, fmtMs } from '@lib/format.ts';
import { Badge, Button, Callout, Modal } from '@ui';
import { deliveryStatusLabel, deliveryStatusTone, httpStatusTone } from './shared.tsx';

export interface WebhookTestOutcome {
  webhook: Webhook;
  result: WebhookTestResult;
  at: string;
}

export function WebhookTestModal({
  outcome,
  onClose,
  onViewDeliveries,
}: {
  outcome: WebhookTestOutcome | null;
  onClose: () => void;
  onViewDeliveries: (webhook: Webhook) => void;
}) {
  if (!outcome) return null;
  const { webhook, result } = outcome;
  const succeeded = result.status === 'success';
  const tone = deliveryStatusTone(result.status);

  return (
    <Modal
      open
      onClose={onClose}
      title="测试投递结果"
      description={`已向「${webhook.name}」发送一条测试事件，结果同步展示在下方的投递记录中。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button icon="list" onClick={() => onViewDeliveries(webhook)}>
            查看投递记录
          </Button>
        </>
      }
    >
      <div className="vstack gap-16">
        <div className="between">
          <div className="hstack gap-8">
            <Badge tone={tone} dot>
              {deliveryStatusLabel(result.status)}
            </Badge>
            <span className="small muted truncate" style={{ maxWidth: 240 }} title={webhook.url}>
              {webhook.url}
            </span>
          </div>
          <span className="tiny dim nowrap">{fmtFullDateTime(outcome.at)}</span>
        </div>

        <div className="metric-grid">
          <div className="metric">
            <span className="metric-label">HTTP 状态</span>
            <span className="metric-value">
              {result.responseStatus != null ? (
                <Badge tone={httpStatusTone(result.responseStatus)} size="sm">
                  {result.responseStatus}
                </Badge>
              ) : (
                '—'
              )}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">延迟</span>
            <span className="metric-value">{fmtMs(result.latencyMs)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">投递状态</span>
            <span className="metric-value">{deliveryStatusLabel(result.status)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">投递 ID</span>
            <span className="metric-value mono">{result.deliveryId}</span>
          </div>
        </div>

        {result.error ? (
          <Callout tone="red" icon="xCircle">
            <strong>接收方未确认成功。</strong>
            <span className="mono" style={{ wordBreak: 'break-word' }}>
              {' '}
              {result.error}
            </span>
          </Callout>
        ) : succeeded ? (
          <Callout tone="green" icon="checkCircle">
            <strong>接收方返回 2xx，测试投递成功。</strong>
            请确认接收端已完成签名校验，并按载荷中的
            <span className="mono"> id </span>
            做幂等处理。
          </Callout>
        ) : (
          <Callout tone="amber" icon="alert">
            投递未成功，系统会按退避策略自动重试。可在投递记录中查看每次尝试的响应与错误。
          </Callout>
        )}
      </div>
    </Modal>
  );
}
