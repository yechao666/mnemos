import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Memory, MemoryCategory, MemoryScope } from '@lib/types.ts';
import {
  CATEGORY_OPTIONS,
  MEMORY_SCOPES,
  PAGE_SIZE,
  ROLE_RANK,
} from '@lib/constants.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Input,
  PageHead,
  SearchInput,
  Select,
  Skeleton,
  useToast,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync, useCursorList, useDebounced } from '@lib/hooks.ts';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { useAuth } from '@lib/auth.tsx';
import { fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { MemoryContent, MemoryMeta } from '../components/memories/shared.tsx';

const SCOPE_SELECT_OPTIONS = [
  { value: '', label: '全部范围' },
  ...MEMORY_SCOPES.map((scope) => ({ value: scope.value, label: scope.label })),
];

/**
 * 记忆列表：服务端游标分页 + person/scope/分类筛选 + FTS 搜索。
 * 批量操作只作用于已加载的当前页，不提供「全选全部」这类百万级操作。
 */
export function MemoriesPage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();
  const { partition } = usePartitionContext();
  const { user } = useAuth();
  const toast = useToast();
  // 批量删除需要 developer 及以上（与后端写权限一致）。
  const canManage = Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.developer);
  const [searchParams, setSearchParams] = useSearchParams();

  const qParam = searchParams.get('q') ?? '';
  const personParam = searchParams.get('person') ?? '';
  const scopeParam = (searchParams.get('scope') as MemoryScope | null) ?? '';
  const categoryParam = (searchParams.get('category') as MemoryCategory | null) ?? '';

  const [query, setQuery] = useState(qParam);
  const [personInput, setPersonInput] = useState(personParam);
  const debouncedQuery = useDebounced(query, 300).trim();
  const debouncedPerson = useDebounced(personInput, 300).trim();

  useEffect(() => {
    if (debouncedQuery === qParam) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (debouncedQuery) next.set('q', debouncedQuery);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  useEffect(() => {
    if (debouncedPerson === personParam) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (debouncedPerson) next.set('person', debouncedPerson);
        else next.delete('person');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedPerson]);

  useEffect(() => {
    setQuery(qParam);
    setPersonInput(personParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam, personParam]);

  const patchParams = (patch: Record<string, string | undefined>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (!value) next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  // 控制台记忆列表按内部 personId 过滤；输入 external id 时先解析为内部 id（失败时原样传入，兼容内部 id）。
  const personLookup = useAsync(
    async () => (personParam ? (await api.persons.get(partitionId, personParam)).id : ''),
    [partitionId, personParam],
    Boolean(partitionId && personParam),
  );
  const effectivePersonId = personParam ? personLookup.data || personParam : undefined;

  const list = useCursorList<Memory>(
    (cursor) =>
      api.memories.list(partitionId, {
        q: qParam || undefined,
        personId: effectivePersonId,
        scope: scopeParam || undefined,
        category: categoryParam || undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    [partitionId, qParam, effectivePersonId, scopeParam, categoryParam],
    Boolean(partitionId),
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 列表刷新/筛选变化后清理选择，避免误删不在当前结果里的记忆。
  useEffect(() => {
    setSelected(new Set());
  }, [partitionId, qParam, personParam, scopeParam, categoryParam]);

  const hasFilters = Boolean(qParam || personParam || scopeParam || categoryParam);
  const selectedRows = useMemo(
    () => list.items.filter((memory) => selected.has(memory.id)),
    [list.items, selected],
  );

  const toggleRow = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setQuery('');
    setPersonInput('');
    setSearchParams({}, { replace: true });
  };

  const deleteSelected = async () => {
    if (deleting || selectedRows.length === 0) return;
    setDeleting(true);
    let removed = 0;
    const failures: string[] = [];
    for (const memory of selectedRows) {
      try {
        await api.memories.remove(partitionId, memory.id);
        removed += 1;
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : '删除失败');
      }
    }
    setDeleting(false);
    setConfirmOpen(false);
    setSelected(new Set());
    if (removed) toast.success(`已删除 ${removed} 条记忆`);
    if (failures.length) toast.error(`有 ${failures.length} 条删除失败：${failures[0]}`);
    await list.refresh();
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="记忆"
        title="记忆浏览器"
        desc={`分区「${partition?.name ?? partitionId}」内的记忆：按人 / 可见范围 / 分类筛选，q 走 FTS 前缀搜索。列表为游标分页，不返回 total。`}
        actions={
          <Button icon="refresh" loading={list.loading} onClick={() => void list.refresh()}>
            刷新
          </Button>
        }
      />

      <div className="grid grid-4">
        <div className="kpi tone-violet">
          <div className="kpi-top"><span className="kpi-label">已加载</span><span className="kpi-icon"><Icon name="brain" size={14} /></span></div>
          <div className="kpi-value">{fmtInt(list.items.length)}</div>
          <div className="kpi-foot"><span className="truncate">{list.hasMore ? '还有更多（游标）' : '已到底'}</span></div>
        </div>
        <div className="kpi tone-green">
          <div className="kpi-top"><span className="kpi-label">分区共享</span><span className="kpi-icon"><Icon name="users" size={14} /></span></div>
          <div className="kpi-value">{fmtInt(list.partitionStats?.sharedTotal ?? 0)}</div>
          <div className="kpi-foot"><span>scope=partition</span></div>
        </div>
        <div className="kpi tone-cyan">
          <div className="kpi-top"><span className="kpi-label">分区记忆总数</span><span className="kpi-icon"><Icon name="database" size={14} /></span></div>
          <div className="kpi-value">{fmtInt(list.partitionStats?.memoriesTotal ?? 0)}</div>
          <div className="kpi-foot"><span>读取 partition_stats</span></div>
        </div>
        <div className="kpi tone-amber">
          <div className="kpi-top"><span className="kpi-label">已选</span><span className="kpi-icon"><Icon name="check" size={14} /></span></div>
          <div className="kpi-value">{fmtInt(selected.size)}</div>
          <div className="kpi-foot"><span>仅限已加载的记忆</span></div>
        </div>
      </div>

      <Card>
        <div style={{ padding: '14px 16px' }}>
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput value={query} onChange={setQuery} placeholder="搜索记忆内容（FTS 前缀）" />
              <Input
                value={personInput}
                onChange={(event) => setPersonInput(event.target.value)}
                placeholder="按人筛选：external ID / 内部 ID"
                style={{ width: 240 }}
                aria-label="按人筛选"
              />
              <Select
                options={SCOPE_SELECT_OPTIONS}
                value={scopeParam}
                aria-label="按可见范围筛选"
                style={{ width: 124 }}
                onChange={(event) => patchParams({ scope: event.target.value || undefined })}
              />
              <Select
                options={CATEGORY_OPTIONS}
                value={categoryParam}
                aria-label="按分类筛选"
                style={{ width: 124 }}
                onChange={(event) => patchParams({ category: event.target.value || undefined })}
              />
            </div>
            <div className="toolbar-right">
              {hasFilters ? (
                <Button size="sm" variant="ghost" icon="x" onClick={clearFilters}>清空筛选</Button>
              ) : null}
              {canManage && selected.size > 0 ? (
                <Button size="sm" variant="danger" icon="trash" onClick={() => setConfirmOpen(true)}>
                  删除所选（{fmtInt(selected.size)}）
                </Button>
              ) : null}
            </div>
          </div>
          <div className="tiny dim mt-8">
            批量操作只作用于已加载的记忆（当前页），不提供「全选全部」；共享记忆与私有记忆都会按 scope 标注。
          </div>
        </div>

        {list.error && list.items.length > 0 ? (
          <div style={{ padding: '0 16px 12px' }}>
            <Callout tone="amber" icon="alert">加载失败，已保留已加载的记忆：{list.error}</Callout>
          </div>
        ) : null}

        {list.loading && list.items.length === 0 ? (
          <div className="vstack gap-10" style={{ padding: '0 16px 16px' }}>
            {[0, 1, 2, 3].map((index) => <Skeleton key={index} h={72} style={{ borderRadius: 10 }} />)}
          </div>
        ) : list.error && list.items.length === 0 ? (
          <div style={{ padding: '10px 16px 20px' }}>
            <ErrorState message={list.error} onRetry={() => void list.refresh()} />
          </div>
        ) : list.items.length === 0 ? (
          <div style={{ padding: '10px 16px 20px' }}>
            {hasFilters ? (
              <EmptyState
                icon="filter"
                title="没有符合条件的记忆"
                description="调整搜索关键词或筛选条件后再试。"
                action={<Button size="sm" icon="x" onClick={clearFilters}>清空筛选</Button>}
              />
            ) : (
              <EmptyState
                icon="brain"
                title="这个分区还没有记忆"
                description="通过 API 写入第一条记忆后，这里会按时间倒序展示。"
              />
            )}
          </div>
        ) : (
          <div className="vstack" style={{ gap: 0 }}>
            {list.items.map((memory) => {
              const checked = selected.has(memory.id);
              return (
                <div
                  key={memory.id}
                  className={`v6-memory-item${checked ? ' is-selected' : ''}`}
                >
                  {canManage ? (
                    <div style={{ paddingTop: 2 }}>
                      <input
                        type="checkbox"
                        aria-label={`选择记忆 ${memory.id}`}
                        checked={checked}
                        onChange={() => toggleRow(memory.id)}
                        style={{ accentColor: '#8b7cff', width: 15, height: 15 }}
                      />
                    </div>
                  ) : null}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="between wrap gap-8">
                      <MemoryContent memory={memory} clamp />
                      <span className="tiny dim nowrap" title={fmtFullDateTime(memory.updatedAt)}>
                        {fmtRelative(memory.updatedAt)}
                      </span>
                    </div>
                    <div className="hstack gap-8 wrap mt-8">
                      <MemoryMeta memory={memory} />
                      <span className="tiny dim mono" title={memory.id}>{memory.id}</span>
                    </div>
                  </div>
                  <div className="vstack gap-4" style={{ alignItems: 'flex-end' }}>
                    <Badge tone="slate" size="sm">{memory.status}</Badge>
                    {canManage ? (
                      <IconButton
                        icon="trash"
                        label="删除这条记忆"
                        size="sm"
                        onClick={() => {
                          setSelected(new Set([memory.id]));
                          setConfirmOpen(true);
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}

            <div className="between wrap gap-10" style={{ padding: '14px 16px', borderTop: '1px solid var(--border-faint)' }}>
              <span className="tiny dim">
                {list.hasMore ? '继续加载更早的记忆（每次 50 条）' : `已加载全部 ${fmtInt(list.items.length)} 条`}
              </span>
              {list.hasMore ? (
                <Button size="sm" variant="secondary" icon="chevronDown" loading={list.loadingMore} onClick={() => void list.loadMore()}>
                  加载更多
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void deleteSelected()}
        title="删除所选记忆"
        description={`将删除 ${fmtInt(selected.size)} 条已加载的记忆，操作会记录到审计日志且不可撤销。`}
        confirmLabel="删除"
        loading={deleting}
      />
    </div>
  );
}
