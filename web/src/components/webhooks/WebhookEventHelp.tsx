import type { WebhookEventOption } from './shared.tsx';
import { DEFAULT_EVENT_TYPES } from './shared.tsx';
import { Badge, Card, SectionHead, Table, type Column } from '@ui';
import { TableScroller } from '../project-ops/common.tsx';

export function WebhookEventHelp({ options }: { options: WebhookEventOption[] }) {
  const columns: Column<WebhookEventOption>[] = [
    {
      key: 'type',
      header: '事件',
      width: 230,
      render: (option) => (
        <div className="vstack gap-2">
          <span className="mono small">{option.type}</span>
          <span className="tiny dim">{option.label}</span>
        </div>
      ),
    },
    {
      key: 'description',
      header: '触发时机',
      render: (option) => <span className="small muted">{option.description}</span>,
    },
    {
      key: 'default',
      header: '默认',
      width: 84,
      align: 'center',
      render: (option) =>
        DEFAULT_EVENT_TYPES.includes(option.type) ? (
          <Badge tone="violet" size="sm">
            默认订阅
          </Badge>
        ) : (
          <span className="tiny dim">—</span>
        ),
    },
  ];

  return (
    <Card pad>
      <SectionHead
        title="事件类型说明"
        desc="订阅后，Mnemos 会把事件以 POST + JSON 推送到你的地址；同一事件可能因重试或重放重复到达，请按载荷中的 id 做幂等去重。"
      />
      <div className="mt-16">
        <TableScroller minWidth={720}>
          <Table columns={columns} rows={options} rowKey={(option) => option.type} />
        </TableScroller>
      </div>
      <div className="tiny dim mt-16" style={{ lineHeight: 1.7 }}>
        载荷结构包含
        <span className="mono"> id </span>、
        <span className="mono"> type </span>、
        <span className="mono"> at </span>、
        <span className="mono"> projectId </span>、
        <span className="mono"> actor </span>
        与
        <span className="mono"> data </span>
        字段；data 内容随事件类型变化。接收端应在 5 分钟内完成签名与时间戳校验，并快速返回 2xx，避免超时触发重试。
      </div>
    </Card>
  );
}
