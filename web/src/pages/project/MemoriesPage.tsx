import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Memory, MemoryCategory, MemoryStatus, MemoryVisibility, SearchHit } from '@shared';
import { CATEGORY_LABEL, MEMORY_CATEGORIES, MEMORY_STATUSES, PAGE_SIZE } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  PageHead,
  Pagination,
  Progress,
  SearchInput,
  Select,
  Table,
  useToast,
  type Column,
} from '@ui';
import { useAsync, useDebounced } from '@lib/hooks.ts';
import { api, type MemoryListParams, type MemoryListResponse } from '@lib/api.ts';
import {
  downloadText,
  fmtFullDateTime,
  fmtInt,
  fmtMs,
  fmtRelative,
} from '@lib/format.ts';
import { toneForCategory } from '@lib/tone.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import { MemoryDrawer } from '../../components/project/MemoryDrawer.tsx';
import { MemoryContent, ScopeChips, ScoreMeter } from '../../components/project/shared.tsx';
import {
  TaskIdChip,
  VisibilityBadge,
  VISIBILITY_OPTIONS,
  visibilityOf,
} from '../../components/project/agent/shared.tsx';

type MemoryRow = Memory & Partial<Pick<SearchHit, 'score' | 'signals' | 'matchedOn' | 'entities'>>;
type BulkAction = 'delete' | 'archive' | 'restore';

const SORT_OPTIONS = [
  { value: 'recent', label: '最近更新' },
  { value: 'importance', label: '重要度优先' },
  { value: 'accessed', label: '访问量优先' },
];

const CATEGORY_OPTIONS = [
  { value: '', label: '全部类别' },
  ...MEMORY_CATEGORIES.map((category) => ({ value: category.value, label: category.label })),
];

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...MEMORY_STATUSES.map((status) => ({ value: status.value, label: status.label })),
];

const BULK_LABEL: Record<BulkAction, string> = {
  delete: '删除',
  archive: '归档',
  restore: '恢复',
};

const BULK_DESC: Record<BulkAction, string> = {
  delete: '删除后这些记忆将不再参与检索与图谱构建，操作会记录到审计日志。',
  archive: '归档后这些记忆默认不参与检索，可随时恢复。',
  restore: '恢复后这些记忆会重新参与检索。',
};

/** 记忆浏览器：混合检索、多维筛选、批量维护与详情抽屉。 */
export function MemoriesPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { project } = useProjectContext();

  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [q, setQ] = useState(urlQuery);
  const [term, setTerm] = useState(urlQuery.trim());
  const debouncedQ = useDebounced(q, 350);

  useEffect(() => {
    setQ(urlQuery);
    setTerm(urlQuery.trim());
    setPage(1);
  }, [urlQuery]);

  const [userId, setUserId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [category, setCategory] = useState<MemoryCategory | ''>('');
  const [status, setStatus] = useState<MemoryStatus | ''>('');
  const [visibility, setVisibility] = useState<MemoryVisibility | ''>('');
  const [taskId, setTaskId] = useState('');
  const [sort, setSort] = useState<'recent' | 'importance' | 'accessed'>('recent');
  const [page, setPage] = useState(1);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<{ action: BulkAction; ids: string[] } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [detail, setDetail] = useState<{ id: string; hit?: SearchHit } | null>(null);

  useEffect(() => {
    setTerm(debouncedQ.trim());
    setPage(1);
  }, [debouncedQ]);

  useEffect(() => {
    setPage(1);
  }, [term, userId, agentId, category, status, visibility, taskId, sort]);

  useEffect(() => {
    setSelected((prev) => (prev.size ? new Set<string>() : prev));
  }, [term, userId, agentId, category, status, visibility, taskId, sort, page]);

  const { data, loading, error, refresh } = useAsync<MemoryListResponse>(() => {
    // 控制台是审计视角：includePrivate 让私有记忆也可被人类筛选与查看。
    const params: MemoryListParams = { page, pageSize: PAGE_SIZE, sort, includePrivate: true };
    if (term) params.q = term;
    if (userId.trim()) params.userId = userId.trim();
    if (agentId.trim()) params.writtenByAgentId = agentId.trim();
    if (category) params.category = category;
    if (status) params.status = status;
    if (visibility) params.visibility = visibility;
    if (taskId.trim()) params.taskId = taskId.trim();
    return api.memories.list(projectId, params);
  }, [projectId, term, userId, agentId, category, status, visibility, taskId, sort, page], Boolean(projectId));

  const isSearch = term.length > 0;
  const rows: MemoryRow[] = useMemo(() => {
    if (!data) return [];
    // 服务端在 q 非空时会把分数/信号合入 items；以 items 为准保持分页顺序，
    // 同时用 hits 补齐可能缺失的命中信息。
    if (!data.items.length && data.hits?.length) return data.hits;
    const byId = new Map((data.hits ?? []).map((hit) => [hit.id, hit]));
    return data.items.map((item) => {
      const hit = byId.get(item.id);
      return hit ? { ...item, ...hit } : item;
    });
  }, [data]);

  const scoreMap = useMemo(() => {
    const map = new Map<string, SearchHit>();
    (data?.hits ?? []).forEach((hit) => map.set(hit.id, hit));
    return map;
  }, [data]);

  const hitForRow = (row: MemoryRow): SearchHit | undefined => {
    if (row.score != null && row.signals) {
      return {
        ...row,
        score: row.score,
        signals: row.signals,
        matchedOn: row.matchedOn ?? [],
        entities: row.entities ?? [],
      };
    }
    return scoreMap.get(row.id);
  };

  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const hasFilters = Boolean(term || userId || agentId || category || status || visibility || taskId);

  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const toggleKey = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) visibleIds.forEach((id) => next.add(id));
      else visibleIds.forEach((id) => next.delete(id));
      return next;
    });
  };

  const clearFilters = () => {
    setQ('');
    setTerm('');
    setUserId('');
    setAgentId('');
    setCategory('');
    setStatus('');
    setVisibility('');
    setTaskId('');
    setSort('recent');
    setPage(1);
    setSelected(new Set());
  };

  const exportRows = () => {
    if (!rows.length) return;
    const payload = {
      project: project?.slug ?? projectId,
      query: term || null,
      exportedAt: new Date().toISOString(),
      page,
      pageSize: PAGE_SIZE,
      total,
      items: rows,
    };
    downloadText(
      `mnemos-${project?.slug ?? 'memories'}-page-${page}.json`,
      JSON.stringify(payload, null, 2),
    );
    toast.success(`已导出当前页 ${rows.length} 条记忆`);
  };

  const runBulk = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      const result = await api.memories.bulk({ action: confirm.action, ids: confirm.ids });
      toast.success(`${BULK_LABEL[confirm.action]}成功，影响 ${fmtInt(result.affected)} 条记忆`);
      if (detail && confirm.ids.includes(detail.id)) setDetail(null);
      setConfirm(null);
      setSelected(new Set());
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${BULK_LABEL[confirm.action]}失败`);
    } finally {
      setConfirmBusy(false);
    }
  };

  const columns: Column<MemoryRow>[] = [];
  columns.push({
    key: 'content',
    header: '记忆内容',
    width: '36%',
    render: (row) => (
      <MemoryContent content={row.content} category={row.category} tags={row.tags} maxWidth={520} />
    ),
  });

  if (isSearch) {
    columns.push({
      key: 'score',
      header: '相关度',
      width: 138,
      render: (row) =>
        row.score == null ? (
          <span className="tiny dim">—</span>
        ) : (
          <div className="vstack gap-4" style={{ alignItems: 'flex-start' }}>
            <ScoreMeter score={row.score} />
            {row.matchedOn?.length ? (
              <div className="chip-row">
                {row.matchedOn.slice(0, 3).map((signal) => (
                  <span key={signal} className="tag">
                    {signal}
                  </span>
                ))}
                {row.matchedOn.length > 3 ? (
                  <span className="tiny dim">+{row.matchedOn.length - 3}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ),
    });
  }

  columns.push(
    {
      key: 'scope',
      header: '作用域',
      width: 176,
      render: (row) => (
        <ScopeChips userId={row.userId} agentId={row.agentId} runId={row.runId} />
      ),
    },
    {
      key: 'visibility',
      header: '可见性',
      width: 158,
      render: (row) => (
        <div className="vstack gap-4" style={{ alignItems: 'flex-start' }}>
          <VisibilityBadge visibility={visibilityOf(row)} />
          {row.taskId ? <TaskIdChip taskId={row.taskId} /> : null}
        </div>
      ),
    },
    {
      key: 'importance',
      header: '重要度',
      width: 124,
      render: (row) => (
        <div className="hstack gap-6">
          <div style={{ width: 54 }}>
            <Progress
              value={Math.max(0, Math.min(100, row.importance * 100))}
              tone={toneForCategory(row.category)}
              thin
            />
          </div>
          <span className="mono tiny">{row.importance.toFixed(2)}</span>
        </div>
      ),
    },
    {
      key: 'category',
      header: '分类',
      width: 92,
      render: (row) => (
        <Badge tone={toneForCategory(row.category)} size="sm">
          {CATEGORY_LABEL[row.category]}
        </Badge>
      ),
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      width: 112,
      render: (row) => (
        <span className="tiny muted" title={fmtFullDateTime(row.updatedAt)}>
          {fmtRelative(row.updatedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: 84,
      align: 'right',
      render: (row) => (
        <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }}>
          <IconButton
            icon="eye"
            label="查看记忆详情"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              setDetail({ id: row.id, hit: hitForRow(row) });
            }}
          />
          <IconButton
            icon="trash"
            label="删除记忆"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              setConfirm({ action: 'delete', ids: [row.id] });
            }}
          />
        </div>
      ),
    },
  );

  const emptyNode = isSearch ? (
    <EmptyState
      icon="search"
      title="没有匹配的记忆"
      description={`没有找到与「${term}」相关的记忆，试试更宽泛的关键词，或清空筛选条件。`}
      action={
        <Button size="sm" variant="secondary" icon="x" onClick={clearFilters}>
          清空筛选
        </Button>
      }
    />
  ) : hasFilters ? (
    <EmptyState
      icon="filter"
      title="没有符合筛选条件的记忆"
      description="调整用户、Agent、类别、状态、可见性或任务筛选后重试。"
      action={
        <Button size="sm" variant="secondary" icon="x" onClick={clearFilters}>
          清空筛选
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon="brain"
      title="还没有记忆"
      description="通过 API 或演练场写入第一条记忆后，这里会展示项目的全部记忆。"
      action={
        <Button
          size="sm"
          variant="primary"
          icon="play"
          onClick={() => navigate(`/projects/${projectId}/playground`)}
        >
          前往演练场
        </Button>
      }
    />
  );

  return (
    <div className="page">
      <PageHead
        eyebrow="记忆"
        title="记忆浏览器"
        desc="浏览、检索与维护项目内的全部记忆；搜索会融合语义向量与关键词信号。"
        actions={
          <Button
            variant="secondary"
            icon="play"
            onClick={() => navigate(`/projects/${projectId}/playground`)}
          >
            写入记忆
          </Button>
        }
      />

      {error && data ? (
        <Callout tone="amber" icon="alert">
          刷新失败：{error}
        </Callout>
      ) : null}

      <Card>
        <div style={{ padding: '14px 16px' }}>
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput
                value={q}
                onChange={setQ}
                placeholder="搜索记忆内容"
                onSubmit={() => {
                  setTerm(q.trim());
                  setPage(1);
                }}
              />
              <Select
                options={SORT_OPTIONS}
                value={sort}
                aria-label="排序方式"
                style={{ width: 132 }}
                onChange={(event) =>
                  setSort(event.target.value as 'recent' | 'importance' | 'accessed')
                }
              />
            </div>
            <div className="toolbar-right">
              <IconButton
                icon="refresh"
                label="刷新记忆列表"
                disabled={loading}
                onClick={() => void refresh()}
              />
              <Button
                size="sm"
                icon="download"
                disabled={!rows.length}
                onClick={exportRows}
              >
                导出当前页
              </Button>
            </div>
          </div>

          <div className="toolbar mt-12">
            <div className="toolbar-left">
              <Input
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                placeholder="用户 ID"
                aria-label="按用户 ID 筛选"
                style={{ width: 148 }}
              />
              <Input
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                placeholder="Agent ID"
                aria-label="按 Agent ID 筛选"
                style={{ width: 148 }}
              />
              <Select
                options={CATEGORY_OPTIONS}
                value={category}
                aria-label="按分类筛选"
                style={{ width: 126 }}
                onChange={(event) => setCategory(event.target.value as MemoryCategory | '')}
              />
              <Select
                options={STATUS_OPTIONS}
                value={status}
                aria-label="按状态筛选"
                style={{ width: 118 }}
                onChange={(event) => setStatus(event.target.value as MemoryStatus | '')}
              />
              <Select
                options={[{ value: '', label: '全部可见性' }, ...VISIBILITY_OPTIONS]}
                value={visibility}
                aria-label="按可见性筛选"
                style={{ width: 128 }}
                onChange={(event) => setVisibility(event.target.value as MemoryVisibility | '')}
              />
              <Input
                value={taskId}
                onChange={(event) => setTaskId(event.target.value)}
                placeholder="任务 ID"
                aria-label="按任务 ID 筛选"
                style={{ width: 170 }}
              />
            </div>
            <div className="toolbar-right">
              <Checkbox checked={allSelected} onChange={toggleAll} label="全选本页" />
              {hasFilters ? (
                <Button size="sm" variant="ghost" icon="x" onClick={clearFilters}>
                  清空筛选
                </Button>
              ) : null}
            </div>
          </div>

          {isSearch ? (
            <div className="hstack gap-8 wrap mt-12">
              <Badge tone="violet" size="sm" dot>
                混合检索
              </Badge>
              <span className="small muted">
                {loading && !data
                  ? '正在检索…'
                  : `命中 ${fmtInt(total)} 条 · 耗时 ${fmtMs(data?.tookMs)}`}
              </span>
              {q.trim() !== term ? <span className="tiny dim">输入变化，等待检索…</span> : null}
            </div>
          ) : null}

          {selected.size > 0 ? (
            <div
              className="between gap-12 wrap mt-12"
              style={{
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
              }}
            >
              <span className="small">
                已选择 <span className="strong">{selected.size}</span> 条记忆
              </span>
              <div className="hstack gap-8 wrap">
                <Button
                  size="sm"
                  variant="outline"
                  icon="layers"
                  onClick={() => setConfirm({ action: 'archive', ids: [...selected] })}
                >
                  归档
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  icon="refresh"
                  onClick={() => setConfirm({ action: 'restore', ids: [...selected] })}
                >
                  恢复
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  onClick={() => setConfirm({ action: 'delete', ids: [...selected] })}
                >
                  删除
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  取消选择
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {error && !data ? (
          <div style={{ padding: '10px 16px 20px' }}>
            <ErrorState message={error} onRetry={() => void refresh()} />
          </div>
        ) : (
          <Table<MemoryRow>
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={loading}
            onRowClick={(row) => setDetail({ id: row.id, hit: hitForRow(row) })}
            selectedKeys={selected}
            onToggleKey={toggleKey}
            empty={emptyNode}
          />
        )}

        {total > 0 ? (
          <div style={{ borderTop: '1px solid var(--border-faint)' }}>
            <Pagination
              page={data?.page ?? page}
              totalPages={totalPages}
              total={total}
              pageSize={PAGE_SIZE}
              onChange={setPage}
            />
          </div>
        ) : null}
      </Card>

      <MemoryDrawer
        memoryId={detail?.id ?? null}
        hit={detail?.hit ?? null}
        query={term}
        onClose={() => setDetail(null)}
        onChanged={() => {
          void refresh();
        }}
        onDeleted={() => {
          void refresh();
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => {
          if (!confirmBusy) setConfirm(null);
        }}
        onConfirm={() => void runBulk()}
        title={confirm ? `${BULK_LABEL[confirm.action]}记忆` : '批量操作'}
        description={
          confirm
            ? `将${BULK_LABEL[confirm.action]} ${confirm.ids.length} 条记忆。${BULK_DESC[confirm.action]}`
            : undefined
        }
        confirmLabel={confirm ? BULK_LABEL[confirm.action] : '确认'}
        tone={confirm?.action === 'delete' ? 'red' : 'violet'}
        loading={confirmBusy}
      />
    </div>
  );
}
