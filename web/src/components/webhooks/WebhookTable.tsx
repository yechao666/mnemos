import type { ReactNode } from 'react';
import type { Webhook, WebhookEventType } from '@shared';
import { fmtFullDateTime, fmtRelative } from '@lib/format.ts';
import { Badge, Button, IconButton, Switch, Table, type Column } from '@ui';
import { TableScroller } from '../project-ops/common.tsx';
import {
  eventLabel,
  httpStatusTone,
  type WebhookEventOption,
} from './shared.tsx';

function EventChips({
  types,
  options,
}: {
  types: WebhookEventType[];
  options: WebhookEventOption[];
}) {
  if (types.length === 0) return <span className="tiny dim">未选择事件</span>;
  const visible = types.slice(0, 3);
  const hidden = types.length - visible.length;
  const title = types.map((type) => `${type}（${eventLabel(type, options)}）`).join('\n');
  return (
    <span className="chip-row" title={title}>
      {visible.map((type) => (
        <span key={type} className="chip mono" title={eventLabel(type, options)}>
          {type}
        </span>
      ))}
      {hidden > 0 ? <span className="chip">+{hidden}</span> : null}
    </span>
  );
}

function stopRowClick(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export function WebhookTable({
  webhooks,
  loading,
  readOnly,
  togglingId,
  testingId,
  eventOptions,
  empty,
  onToggle,
  onTest,
  onRotate,
  onEdit,
  onDelete,
  onDeliveries,
}: {
  webhooks: Webhook[];
  loading: boolean;
  readOnly: boolean;
  togglingId: string | null;
  testingId: string | null;
  eventOptions: WebhookEventOption[];
  empty: ReactNode;
  onToggle: (webhook: Webhook, enabled: boolean) => void;
  onTest: (webhook: Webhook) => void;
  onRotate: (webhook: Webhook) => void;
  onEdit: (webhook: Webhook) => void;
  onDelete: (webhook: Webhook) => void;
  onDeliveries: (webhook: Webhook) => void;
}) {
  const columns: Column<Webhook>[] = [
    {
      key: 'name',
      header: '订阅',
      width: 170,
      render: (webhook) => (
        <div className="vstack gap-2" style={{ minWidth: 0 }}>
          <span className="strong small truncate" title={webhook.name}>
            {webhook.name}
          </span>
          {webhook.description ? (
            <span className="tiny dim truncate" title={webhook.description} style={{ maxWidth: 190 }}>
              {webhook.description}
            </span>
          ) : (
            <span className="tiny dim">无描述</span>
          )}
        </div>
      ),
    },
    {
      key: 'url',
      header: '推送地址',
      width: 230,
      mono: true,
      render: (webhook) => (
        <span
          className="mono tiny truncate"
          title={webhook.url}
          style={{ display: 'block', maxWidth: 210 }}
        >
          {webhook.url}
        </span>
      ),
    },
    {
      key: 'eventTypes',
      header: '事件类型',
      width: 210,
      render: (webhook) => <EventChips types={webhook.eventTypes} options={eventOptions} />,
    },
    {
      key: 'enabled',
      header: '启用',
      width: readOnly ? 82 : 70,
      render: (webhook) =>
        readOnly ? (
          <Badge tone={webhook.enabled ? 'green' : 'slate'} size="sm" dot>
            {webhook.enabled ? '启用' : '停用'}
          </Badge>
        ) : (
          <span
            onClick={stopRowClick}
            title={webhook.enabled ? '点击暂停投递' : '点击启用订阅'}
          >
            <Switch
              checked={webhook.enabled}
              disabled={togglingId === webhook.id}
              onChange={(next) => onToggle(webhook, next)}
            />
          </span>
        ),
    },
    {
      key: 'lastDeliveryAt',
      header: '最近投递',
      width: 120,
      render: (webhook) =>
        webhook.lastDeliveryAt ? (
          <div className="vstack gap-2">
            <span className="hstack gap-6">
              {webhook.lastStatus != null ? (
                <Badge tone={httpStatusTone(webhook.lastStatus)} size="sm">
                  HTTP {webhook.lastStatus}
                </Badge>
              ) : (
                <Badge tone="slate" size="sm">
                  无响应
                </Badge>
              )}
            </span>
            <span className="tiny dim" title={fmtFullDateTime(webhook.lastDeliveryAt)}>
              {fmtRelative(webhook.lastDeliveryAt)}
            </span>
          </div>
        ) : (
          <span className="tiny dim">尚未投递</span>
        ),
    },
    {
      key: 'failureCount',
      header: '失败次数',
      width: 70,
      align: 'right',
      render: (webhook) => (
        <span
          className={webhook.failureCount > 0 ? 'small mono strong' : 'small mono dim'}
          style={webhook.failureCount > 0 ? { color: 'var(--red)' } : undefined}
        >
          {webhook.failureCount}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: readOnly ? 92 : 240,
      align: 'right',
      render: (webhook) => (
        <div
          className="hstack gap-4"
          style={{ justifyContent: 'flex-end' }}
          onClick={stopRowClick}
        >
          <Button size="sm" variant="ghost" icon="list" onClick={() => onDeliveries(webhook)}>
            记录
          </Button>
          {readOnly ? null : (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon="play"
                loading={testingId === webhook.id}
                title="向该地址发送一条测试事件"
                onClick={() => onTest(webhook)}
              >
                测试
              </Button>
              <IconButton
                icon="refresh"
                size="sm"
                label="轮换签名密钥"
                onClick={() => onRotate(webhook)}
              />
              <IconButton icon="pencil" size="sm" label="编辑订阅" onClick={() => onEdit(webhook)} />
              <IconButton icon="trash" size="sm" label="删除订阅" onClick={() => onDelete(webhook)} />
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <TableScroller minWidth={webhooks.length ? 1060 : undefined}>
      <Table
        columns={columns}
        rows={webhooks}
        rowKey={(webhook) => webhook.id}
        loading={loading}
        empty={empty}
        onRowClick={onDeliveries}
      />
    </TableScroller>
  );
}
