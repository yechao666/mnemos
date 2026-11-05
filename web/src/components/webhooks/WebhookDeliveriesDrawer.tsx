import { useState } from 'react';
import type { Webhook, WebhookDelivery } from '@shared';
import { api, ApiError } from '@lib/api.ts';
import { fmtDateTime, fmtFullDateTime, fmtMs, fmtRelative } from '@lib/format.ts';
import { useAsync } from '@lib/hooks.ts';
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  Drawer,
  EmptyState,
  ErrorState,
  Pagination,
  Segmented,
  Select,
  Table,
  useToast,
  type Column,
} from '@ui';
import { TableScroller } from '../project-ops/common.tsx';
import {
  DELIVERY_STATUS_META,
  deliveryPayload,
  deliveryStatusLabel,
  deliveryStatusTone,
  eventLabel,
  formatBody,
  httpStatusTone,
  type WebhookEventOption,
} from './shared.tsx';

type DeliveryFilter = 'all' | 'success' | 'failed' | 'dead';

const STATUS_OPTIONS: { value: DeliveryFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'dead', label: '死信' },
];

const PAGE_SIZE_OPTIONS = [
  { value: '20', label: '每页 20 条' },
  { value: '50', label: '每页 50 条' },
  { value: '100', label: '每页 100 条' },
];

function errorSummary(delivery: WebhookDelivery): string {
  const value = delivery.error?.trim();
  if (value) return value;
  if (delivery.responseStatus && delivery.responseStatus >= 400) {
    return `接收方返回 HTTP ${delivery.responseStatus}`;
  }
  return '—';
}

export function WebhookDeliveriesDrawer({
  webhook,
  eventOptions,
  canReplay,
  onClose,
  onChanged,
}: {
  webhook: Webhook;
  eventOptions: WebhookEventOption[];
  canReplay: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<DeliveryFilter>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<WebhookDelivery | null>(null);
  const [replaying, setReplaying] = useState(false);

  const { data, loading, error, refresh } = useAsync(
    () =>
      api.webhooks.deliveries(webhook.id, {
        page,
        pageSize,
        status: status === 'all' ? undefined : status,
      }),
    [webhook.id, page, pageSize, status],
  );

  const items = data?.items ?? [];
  const filtered = status !== 'all';

  const replay = async (delivery: WebhookDelivery) => {
    if (replaying) return;
    setReplaying(true);
    try {
      const result = await api.webhooks.replay(delivery.id);
      if (result.status === 'success') {
        toast.success(`已重新投递 · HTTP ${result.responseStatus ?? '—'} · ${fmtMs(result.latencyMs)}`);
      } else {
        toast.warning(`重放已入队，当前状态：${deliveryStatusLabel(result.status)}`);
      }
      setSelected(null);
      await refresh();
      onChanged();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '重放投递失败，请稍后重试。');
    } finally {
      setReplaying(false);
    }
  };

  const columns: Column<WebhookDelivery>[] = [
    {
      key: 'createdAt',
      header: '时间',
      width: 96,
      render: (delivery) => (
        <div className="vstack gap-2">
          <span className="tiny mono nowrap">{fmtDateTime(delivery.createdAt)}</span>
          <span className="tiny dim" title={fmtFullDateTime(delivery.createdAt)}>
            {fmtRelative(delivery.createdAt)}
          </span>
        </div>
      ),
    },
    {
      key: 'eventType',
      header: '事件类型',
      width: 150,
      render: (delivery) => (
        <div className="vstack gap-2">
          <span className="mono tiny">{delivery.eventType}</span>
          <span className="tiny dim truncate" title={eventLabel(delivery.eventType, eventOptions)}>
            {eventLabel(delivery.eventType, eventOptions)}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      width: 78,
      render: (delivery) => (
        <Badge tone={deliveryStatusTone(delivery.status)} size="sm" dot>
          {deliveryStatusLabel(delivery.status)}
        </Badge>
      ),
    },
    {
      key: 'attempts',
      header: '尝试',
      width: 56,
      render: (delivery) => (
        <span className="small mono">
          {delivery.attempts}/{delivery.maxAttempts}
        </span>
      ),
    },
    {
      key: 'responseStatus',
      header: 'HTTP',
      width: 58,
      render: (delivery) =>
        delivery.responseStatus != null ? (
          <Badge tone={httpStatusTone(delivery.responseStatus)} size="sm">
            {delivery.responseStatus}
          </Badge>
        ) : (
          <span className="tiny dim">—</span>
        ),
    },
    {
      key: 'latencyMs',
      header: '延迟',
      width: 64,
      render: (delivery) => (
        <span className="small mono">{fmtMs(delivery.latencyMs)}</span>
      ),
    },
    {
      key: 'error',
      header: '错误摘要',
      width: 160,
      render: (delivery) => {
        const summary = errorSummary(delivery);
        return summary === '—' ? (
          <span className="tiny dim">—</span>
        ) : (
          <span
            className="tiny truncate"
            title={summary}
            style={{ display: 'block', maxWidth: 140, color: 'var(--red)' }}
          >
            {summary}
          </span>
        );
      },
    },
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      title="投递记录"
      subtitle={`${webhook.name} · ${webhook.url}`}
      wide
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="toolbar">
        <div className="toolbar-left">
          <Segmented
            options={STATUS_OPTIONS}
            value={status}
            onChange={(next) => {
              setStatus(next);
              setPage(1);
            }}
          />
          <Select
            aria-label="每页条数"
            style={{ width: 150 }}
            value={String(pageSize)}
            options={PAGE_SIZE_OPTIONS}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          />
        </div>
        <div className="toolbar-right">
          {data ? (
            <Badge tone="slate" size="sm">
              共 {data.total.toLocaleString('zh-CN')} 条
            </Badge>
          ) : null}
          <Button
            size="sm"
            icon="refresh"
            loading={loading}
            onClick={() => {
              void refresh();
            }}
          >
            刷新
          </Button>
        </div>
      </div>

      {error && data ? (
        <Callout tone="red" icon="alert">
          刷新投递记录失败，当前展示上一次成功获取的数据：{error}
        </Callout>
      ) : null}

      {error && !data ? (
        <ErrorState
          message={error}
          onRetry={() => {
            void refresh();
          }}
        />
      ) : (
        <TableScroller minWidth={640}>
          <Table
            columns={columns}
            rows={items}
            rowKey={(delivery) => delivery.id}
            onRowClick={(delivery) => setSelected(delivery)}
            loading={loading && !data}
            empty={
              <EmptyState
                icon="send"
                title={filtered ? '没有匹配的投递记录' : '还没有投递记录'}
                description={
                  filtered
                    ? '尝试切换状态筛选，或稍后刷新查看最新投递。'
                    : '事件触发或手动测试投递后，每一次尝试都会记录在这里，可查看响应并重放。'
                }
              />
            }
          />
        </TableScroller>
      )}

      {data && data.total > 0 ? (
        <Pagination
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          pageSize={data.pageSize}
          onChange={setPage}
        />
      ) : null}

      {selected ? (
        <WebhookDeliveryDetail
          delivery={selected}
          eventOptions={eventOptions}
          canReplay={canReplay}
          replaying={replaying}
          onClose={() => setSelected(null)}
          onReplay={replay}
        />
      ) : null}
    </Drawer>
  );
}

function WebhookDeliveryDetail({
  delivery,
  eventOptions,
  canReplay,
  replaying,
  onClose,
  onReplay,
}: {
  delivery: WebhookDelivery;
  eventOptions: WebhookEventOption[];
  canReplay: boolean;
  replaying: boolean;
  onClose: () => void;
  onReplay: (delivery: WebhookDelivery) => void;
}) {
  const payload = deliveryPayload(delivery);
  const response = delivery.responseBody?.trim() ? formatBody(delivery.responseBody) : null;
  const statusMeta = DELIVERY_STATUS_META[delivery.status];


  return (
    <Drawer
      open
      onClose={onClose}
      title="投递详情"
      subtitle={`${delivery.eventType} · ${fmtFullDateTime(delivery.createdAt)}`}
      wide
      footer={
        <>
          {canReplay ? null : <span className="tiny dim">重放需要项目管理员权限</span>}
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          {canReplay ? (
            <Button variant="primary" icon="refresh" loading={replaying} onClick={() => onReplay(delivery)}>
              重放
            </Button>
          ) : null}
        </>
      }
    >
      <div className="vstack gap-20">
        <div className="hstack gap-8 wrap">
          <Badge tone={statusMeta?.tone ?? 'slate'} dot>
            {statusMeta?.label ?? delivery.status}
          </Badge>
          {delivery.responseStatus != null ? (
            <Badge tone={httpStatusTone(delivery.responseStatus)} size="sm">
              HTTP {delivery.responseStatus}
            </Badge>
          ) : null}
          <span className="tiny dim">
            {eventLabel(delivery.eventType, eventOptions)}
          </span>
        </div>

        <div className="metric-grid">
          <div className="metric">
            <span className="metric-label">尝试次数</span>
            <span className="metric-value">
              {delivery.attempts} / {delivery.maxAttempts}
            </span>
          </div>
          <div className="metric">
            <span className="metric-label">延迟</span>
            <span className="metric-value">{fmtMs(delivery.latencyMs)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">创建时间</span>
            <span className="metric-value">{fmtFullDateTime(delivery.createdAt)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">完成时间</span>
            <span className="metric-value">{fmtFullDateTime(delivery.deliveredAt)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">下次重试</span>
            <span className="metric-value">{fmtFullDateTime(delivery.nextAttemptAt)}</span>
          </div>
          <div className="metric">
            <span className="metric-label">事件 ID</span>
            <span className="metric-value mono tiny" style={{ wordBreak: 'break-all' }}>
              {delivery.eventId ?? '—'}
            </span>
          </div>
          <div className="metric" style={{ gridColumn: '1 / -1' }}>
            <span className="metric-label">投递 ID</span>
            <span className="metric-value mono tiny" style={{ wordBreak: 'break-all' }}>
              {delivery.id}
            </span>
          </div>
        </div>

        <div>
          <div className="doc-h3 mb-8">请求载荷</div>
          {payload ? (
            <CodeBlock
              code={payload.text}
              title={payload.json ? 'payload.json' : 'payload.txt'}
              language={payload.json ? 'json' : 'text'}
            />
          ) : (
            <Callout tone="slate" icon="info">
              该记录未保留请求载荷。可复制事件 ID 在业务侧日志中核对，或重新触发一次事件后再查看。
            </Callout>
          )}
        </div>

        <div>
          <div className="doc-h3 mb-8">响应内容</div>
          {response ? (
            <CodeBlock
              code={response.text}
              title={response.json ? 'response.json' : 'response.txt'}
              language={response.json ? 'json' : 'text'}
            />
          ) : (
            <span className="tiny dim">接收方未返回可记录的响应内容。</span>
          )}
        </div>

        {delivery.error ? (
          <div>
            <div className="doc-h3 mb-8">错误</div>
            <Callout tone="red" icon="xCircle">
              <span style={{ wordBreak: 'break-word' }}>{delivery.error}</span>
            </Callout>
          </div>
        ) : null}

        {!canReplay ? (
          <Callout tone="amber" icon="lock">
            当前账号没有投递重放权限，只能查看投递记录。重放需要项目管理员（admin / owner）。
          </Callout>
        ) : null}
      </div>
    </Drawer>
  );
}
