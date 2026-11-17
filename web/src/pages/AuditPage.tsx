import { useParams } from 'react-router-dom';
import type { AuditLog } from '@lib/types.ts';
import { api } from '@lib/api.ts';
import { useCursorList } from '@lib/hooks.ts';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { actionLabel, toneForAction } from '@lib/tone.ts';
import { Badge, Button, Callout, Card, EmptyState, ErrorState, PageHead, Skeleton, Table, type Column } from '@ui';


/** 审计：游标分页读取控制台操作留痕（只读）。 */
export function AuditPage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();
  const { partition } = usePartitionContext();

  const list = useCursorList<AuditLog>(
    (cursor) => api.partitions.audit(partitionId, { cursor, limit: 50 }),
    [partitionId],
    Boolean(partitionId),
  );

  const columns: Column<AuditLog>[] = [
    {
      key: 'createdAt',
      header: '时间',
      width: 150,
      render: (row) => <span className="tiny mono" title={fmtFullDateTime(row.createdAt)}>{fmtFullDateTime(row.createdAt)}</span>,
    },
    {
      key: 'action',
      header: '动作',
      width: 190,
      render: (row) => (
        <Badge tone={toneForAction(row.action, row.actorType)} size="sm">
          {actionLabel(row.action)}
        </Badge>
      ),
    },
    {
      key: 'actor',
      header: '操作者',
      width: 200,
      render: (row) => (
        <div style={{ minWidth: 0 }}>
          <div className="small truncate">{row.actorLabel || '—'}</div>
          <div className="tiny dim truncate">{row.actorType}{row.actorId ? ` · ${row.actorId}` : ''}</div>
        </div>
      ),
    },
    {
      key: 'resource',
      header: '资源',
      width: 220,
      render: (row) => (
        <div style={{ minWidth: 0 }}>
          <div className="tiny mono truncate">{row.resourceType || '—'}</div>
          <div className="tiny dim mono truncate">{row.resourceId ?? ''}</div>
        </div>
      ),
    },
    {
      key: 'detail',
      header: '详情',
      render: (row) => {
        const text = Object.keys(row.detail).length ? JSON.stringify(row.detail) : '—';
        return <span className="tiny dim mono truncate" title={text}>{text}</span>;
      },
    },
    {
      key: 'ip',
      header: 'IP',
      width: 120,
      render: (row) => <span className="tiny dim mono">{row.ip ?? '—'}</span>,
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="审计"
        title="审计日志"
        desc={`分区「${partition?.name ?? partitionId}」的操作留痕：写入、检索、密钥与设置变更。游标分页，每次 50 条。`}
        actions={
          <Button icon="refresh" loading={list.loading} onClick={() => void list.refresh()}>
            刷新
          </Button>
        }
      />

      {list.error && list.items.length > 0 ? (
        <Callout tone="amber" icon="alert">加载更多失败，已保留已加载的日志：{list.error}</Callout>
      ) : null}

      <Card>
        {list.loading && list.items.length === 0 ? (
          <div className="vstack gap-10" style={{ padding: 16 }}>
            {[0, 1, 2, 3, 4].map((index) => <Skeleton key={index} h={34} />)}
          </div>
        ) : list.error && list.items.length === 0 ? (
          <div style={{ padding: 16 }}>
            <ErrorState message={list.error} onRetry={() => void list.refresh()} />
          </div>
        ) : list.items.length === 0 ? (
          <div style={{ padding: 16 }}>
            <EmptyState icon="shield" title="暂无审计记录" description="控制台与 API 的写操作会自动留痕。" compact />
          </div>
        ) : (
          <Table columns={columns} rows={list.items} rowKey={(row) => row.id} />
        )}

        {list.items.length > 0 ? (
          <div className="between wrap gap-10" style={{ padding: '12px 16px', borderTop: '1px solid var(--border-faint)' }}>
            <span className="tiny dim">
              已加载 {fmtInt(list.items.length)} 条{list.hasMore ? ' · 还有更多' : ' · 已到底'}
              {list.items[0] ? ` · 最近 ${fmtRelative(list.items[0].createdAt)}` : ''}
            </span>
            {list.hasMore ? (
              <Button size="sm" variant="secondary" icon="chevronDown" loading={list.loadingMore} onClick={() => void list.loadMore()}>
                加载更多
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
