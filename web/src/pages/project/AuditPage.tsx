import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { AuditLog } from '@shared';
import { PAGE_SIZE } from '@shared';
import { api } from '@lib/api.ts';
import { downloadText, fmtFullDateTime, fmtRelative } from '@lib/format.ts';
import { useAsync, useDebounced } from '@lib/hooks.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import { actionLabel, toneForAction } from '@lib/tone.ts';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  PageHead,
  Pagination,
  SearchInput,
  Select,
  Table,
  useToast,
  type Column,
  type Tone,
} from '@ui';
import { AuditDetailDrawer } from '../../components/project-ops/audit/AuditDetailDrawer.tsx';
import { PendingProject, TableScroller } from '../../components/project-ops/common.tsx';

const ACTOR_META: Record<AuditLog['actorType'], { label: string; tone: Tone }> = {
  user: { label: '用户', tone: 'violet' },
  api_key: { label: 'API Key', tone: 'cyan' },
  system: { label: '系统', tone: 'slate' },
};

const PAGE_SIZE_OPTIONS = [20, 50, 100].map((size) => ({ value: String(size), label: `每页 ${size} 条` }));

export function AuditPage() {
  const { project, loading: projectLoading, error: projectError, refresh: refreshProject } = useProjectContext();
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const projectId = project?.id ?? routeProjectId ?? '';
  const toast = useToast();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [action, setAction] = useState('');
  const [actorInput, setActorInput] = useState('');
  const actor = useDebounced(actorInput, 350);
  const [knownActions, setKnownActions] = useState<string[]>([]);
  const [selected, setSelected] = useState<AuditLog | null>(null);

  useEffect(() => {
    setPage(1);
  }, [action, actor, pageSize]);

  const { data, loading, error, refresh } = useAsync(
    () =>
      api.projects.audit(projectId, {
        page,
        pageSize,
        action: action || undefined,
        actor: actor.trim() || undefined,
      }),
    [projectId, page, pageSize, action, actor],
    Boolean(projectId),
  );

  useEffect(() => {
    if (!data) return;
    setKnownActions((prev) => {
      const merged = new Set(prev);
      for (const item of data.items) merged.add(item.action);
      return [...merged].sort((a, b) => a.localeCompare(b));
    });
  }, [data]);

  const items = data?.items ?? [];

  const actionOptions = [
    { value: '', label: '全部操作' },
    ...[...new Set([...knownActions, ...(action ? [action] : [])])]
      .sort((a, b) => a.localeCompare(b))
      .map((value) => ({ value, label: actionLabel(value) })),
  ];

  const clearFilters = () => {
    setAction('');
    setActorInput('');
    setPage(1);
  };

  const exportPage = () => {
    if (!data) return;
    const payload = {
      projectId,
      exportedAt: new Date().toISOString(),
      filters: {
        action: action || null,
        actor: actor.trim() || null,
      },
      page: data.page,
      pageSize: data.pageSize,
      total: data.total,
      items: data.items,
    };
    downloadText(`mnemos-audit-${projectId}-p${data.page}.json`, JSON.stringify(payload, null, 2));
    toast.success('已导出本页审计日志');
  };

  const columns: Column<AuditLog>[] = [
    {
      key: 'createdAt',
      header: '时间',
      width: 120,
      render: (log) => (
        <span className="tiny muted nowrap" title={fmtFullDateTime(log.createdAt)}>
          {fmtRelative(log.createdAt)}
        </span>
      ),
    },
    {
      key: 'actor',
      header: '执行者',
      width: 210,
      render: (log) => {
        const meta = ACTOR_META[log.actorType] ?? { label: log.actorType, tone: 'slate' as Tone };
        return (
          <div className="hstack gap-8">
            <Avatar name={log.actorLabel} tone={meta.tone} size="sm" />
            <div className="vstack gap-4" style={{ minWidth: 0 }}>
              <span className="small soft truncate" title={log.actorLabel}>
                {log.actorLabel}
              </span>
              <span>
                <Badge tone={meta.tone} size="sm">
                  {meta.label}
                </Badge>
              </span>
            </div>
          </div>
        );
      },
    },
    {
      key: 'action',
      header: '动作',
      width: 150,
      render: (log) => (
        <span title={log.action}>
          <Badge tone={toneForAction(log.action, log.actorType)} size="sm">
            {actionLabel(log.action)}
          </Badge>
        </span>
      ),
    },
    {
      key: 'resource',
      header: '资源',
      width: 190,
      render: (log) => (
        <div className="vstack gap-4">
          <span className="tiny muted">{log.resourceType}</span>
          <span className="mono tiny dim truncate" title={log.resourceId ?? ''}>
            {log.resourceId ?? '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'ip',
      header: 'IP',
      width: 130,
      render: (log) => <span className="mono tiny dim">{log.ip ?? '—'}</span>,
    },
    {
      key: 'detail',
      header: '详情',
      width: 82,
      align: 'right',
      render: (log) => (
        <Button size="sm" variant="ghost" icon="eye" onClick={() => setSelected(log)}>
          查看
        </Button>
      ),
    },
  ];

  if (!projectId) {
    return (
      <div className="page">
        <PageHead eyebrow="项目 · 合规" title="审计日志" desc="记录项目内所有敏感操作，用于合规追溯。" />
        <PendingProject
          loading={projectLoading}
          error={projectError}
          onRetry={() => {
            void refreshProject();
          }}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · 合规"
        title="审计日志"
        desc="密钥、成员、设置与记忆操作都会留下审计记录；支持按动作与执行者筛选。"
      />

      {error && data ? (
        <Callout tone="red" icon="alert">
          刷新审计日志失败，当前展示上一次成功获取的数据：{error}
        </Callout>
      ) : null}

      {error && !data ? (
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      ) : (
        <Card>
          <div className="toolbar" style={{ padding: '16px 20px' }}>
            <div className="toolbar-left">
              <Select
                aria-label="按操作筛选"
                value={action}
                options={actionOptions}
                onChange={(event) => setAction(event.target.value)}
              />
              <SearchInput
                value={actorInput}
                onChange={setActorInput}
                placeholder="按执行者筛选…"
              />
              <Select
                aria-label="分页大小"
                value={String(pageSize)}
                options={PAGE_SIZE_OPTIONS}
                onChange={(event) => setPageSize(Number(event.target.value))}
              />
            </div>
            <div className="toolbar-right">
              {data ? (
                <Badge tone="slate" size="sm">
                  共 {data.total.toLocaleString('zh-CN')} 条
                </Badge>
              ) : null}
              <Button size="sm" icon="download" disabled={!items.length} onClick={exportPage}>
                导出本页 JSON
              </Button>
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

          <TableScroller minWidth={items.length ? 960 : undefined}>
            <Table
              columns={columns}
              rows={items}
              rowKey={(log) => log.id}
              loading={loading && !data}
              empty={
                <EmptyState
                  icon="shield"
                  title={action || actor.trim() ? '没有匹配的审计记录' : '暂无审计日志'}
                  description={
                    action || actor.trim()
                      ? '尝试放宽筛选条件，或清除筛选后查看全部记录。'
                      : '执行密钥创建、成员调整、项目设置变更或记忆删除后，记录会出现在这里。'
                  }
                  action={
                    action || actor.trim() ? (
                      <Button size="sm" variant="outline" onClick={clearFilters}>
                        清除筛选
                      </Button>
                    ) : undefined
                  }
                />
              }
            />
          </TableScroller>

          {data && data.total > 0 ? (
            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              pageSize={data.pageSize}
              onChange={setPage}
            />
          ) : null}
        </Card>
      )}

      <AuditDetailDrawer log={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
