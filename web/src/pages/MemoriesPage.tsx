import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemorySearchHit,
  MemorySearchMode,
} from '@lib/types.ts';
import {
  CATEGORY_OPTIONS,
  MEMORY_SCOPES,
  PAGE_SIZE,
  RETRIEVAL_MODES,
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
  Segmented,
  Select,
  Skeleton,
  useToast,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync, useCursorList, useDebounced } from '@lib/hooks.ts';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { useAuth } from '@lib/auth.tsx';
import { fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import {
  MemoryContent,
  MemoryMeta,
} from '../components/memories/shared.tsx';
import { SearchHitInsight, SearchStrategyBadges } from '../components/memories/SearchSignals.tsx';
import { MemoryDrawer } from '../components/memories/MemoryDrawer.tsx';

const SCOPE_SELECT_OPTIONS = [
  { value: '', label: '全部范围' },
  ...MEMORY_SCOPES.map((scope) => ({ value: scope.value, label: scope.label })),
];

const MODE_OPTIONS = RETRIEVAL_MODES.map((item) => ({ value: item.value, label: item.label }));

function isMode(value: string | null): value is MemorySearchMode {
  return value === 'hybrid' || value === 'keyword' || value === 'vector';
}

/**
 * 记忆列表（v6.1）：
 *  - 无关键词：服务端游标分页 list（百万级设计，不做全量加载/COUNT）；
 *  - 有关键词：POST /memories/search 混合检索（mode=hybrid|keyword|vector），
 *    展示综合得分 + 信号分解（vector/keyword/recency/importance/entity）+ matchedOn；
 *  - 点击行打开记忆抽屉：时序状态、检索解释、历史时间线与反馈。
 */
export function MemoriesPage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();
  const { partition, stats: partitionStats } = usePartitionContext();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  // 批量删除与反馈需要 developer 及以上（与后端写权限一致）。
  const canManage = Boolean(user && ROLE_RANK[user.role] >= ROLE_RANK.developer);
  const [searchParams, setSearchParams] = useSearchParams();

  const qParam = searchParams.get('q') ?? '';
  const personParam = searchParams.get('person') ?? '';
  const scopeParam = (searchParams.get('scope') as MemoryScope | null) ?? '';
  const categoryParam = (searchParams.get('category') as MemoryCategory | null) ?? '';
  const modeParamRaw = searchParams.get('mode');
  const settingsMode = partition?.settings?.retrievalMode;
  const mode: MemorySearchMode = isMode(modeParamRaw)
    ? modeParamRaw
    : settingsMode === 'keyword' || settingsMode === 'vector'
      ? settingsMode
      : 'hybrid';
  const isSearch = Boolean(qParam);

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

  // 有检索词时走 searchMemories；普通浏览仍走游标 list（两者互斥，避免全量加载）。
  const search = useAsync(
    () =>
      api.memories.search(partitionId, {
        query: qParam,
        personId: effectivePersonId,
        scope: scopeParam || undefined,
        category: categoryParam || undefined,
        mode,
        topK: PAGE_SIZE,
      }),
    [partitionId, qParam, effectivePersonId, scopeParam, categoryParam, mode],
    Boolean(partitionId && qParam),
  );

  const list = useCursorList<Memory>(
    (cursor) =>
      api.memories.list(partitionId, {
        personId: effectivePersonId,
        scope: scopeParam || undefined,
        category: categoryParam || undefined,
        cursor,
        limit: PAGE_SIZE,
      }),
    [partitionId, effectivePersonId, scopeParam, categoryParam],
    Boolean(partitionId) && !qParam,
  );

  const hits = search.data?.hits ?? [];
  const rows: Memory[] = isSearch ? hits : list.items;
  const hitMap = useMemo(
    () => new Map<string, MemorySearchHit>(hits.map((hit) => [hit.id, hit])),
    [hits],
  );
  const activeLoading = isSearch ? search.loading : list.loading;
  const activeError = isSearch ? search.error : list.error;
  const stats = list.partitionStats ?? partitionStats;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [drawerMemory, setDrawerMemory] = useState<Memory | null>(null);

  // 列表刷新/筛选/检索模式变化后清理选择，避免误删不在当前结果里的记忆。
  useEffect(() => {
    setSelected(new Set());
  }, [partitionId, qParam, personParam, scopeParam, categoryParam, mode]);

  const hasFilters = Boolean(qParam || personParam || scopeParam || categoryParam);
  const selectedRows = useMemo(
    () => rows.filter((memory) => selected.has(memory.id)),
    [rows, selected],
  );

  const refreshActive = async () => {
    if (isSearch) await search.refresh();
    else await list.refresh();
  };

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

  const openMemoryById = async (id: string) => {
    if (!id) return;
    const known = hitMap.get(id) ?? rows.find((memory) => memory.id === id);
    if (known) {
      setDrawerMemory(known);
      return;
    }
    try {
      setDrawerMemory(await api.memories.get(partitionId, id));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '无法加载关联记忆');
    }
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
    await refreshActive();
  };

  const modeLabel = RETRIEVAL_MODES.find((item) => item.value === mode)?.label ?? mode;

  return (
    <div className="page">
      <PageHead
        eyebrow="记忆"
        title="记忆浏览器"
        desc={`分区「${partition?.name ?? partitionId}」内的记忆：按人 / 可见范围 / 分类筛选；有关键词时走混合检索（向量 + 关键词 + 时效 + 重要度），并展示得分与信号分解。普通列表仍为游标分页，不返回 total。`}
        actions={
          <>
            <Button icon="settings" onClick={() => navigate(`/partitions/${partitionId}/settings#retrieval`)}>
              检索设置
            </Button>
            <Button
              icon="refresh"
              loading={activeLoading}
              onClick={() => void refreshActive()}
            >
              刷新
            </Button>
          </>
        }
      />

      <div className="grid grid-4">
        <div className="kpi tone-violet">
          <div className="kpi-top"><span className="kpi-label">{isSearch ? '检索命中' : '已加载'}</span><span className="kpi-icon"><Icon name="search" size={14} /></span></div>
          <div className="kpi-value">{fmtInt(rows.length)}</div>
          <div className="kpi-foot">
            <span className="truncate">
              {isSearch
                ? `${modeLabel} · ${search.data ? `${Math.round(search.data.tookMs)}ms` : '检索中…'}`
                : list.hasMore
                  ? '还有更多（游标）'
                  : '已到底'}
            </span>
          </div>
        </div>
        <div className="kpi tone-green">
          <div className="kpi-top"><span className="kpi-label">分区共享</span><span className="kpi-icon"><Icon name="users" size={14} /></span></div>
          <div className="kpi-value">{fmtInt(stats?.sharedTotal ?? 0)}</div>
          <div className="kpi-foot"><span>scope=partition</span></div>
        </div>
        <div className="kpi tone-cyan">
          <div className="kpi-top"><span className="kpi-label">分区记忆总数</span><span className="kpi-icon"><Icon name="database" size={14} /></span></div>
          <div className="kpi-value">{fmtInt(stats?.memoriesTotal ?? 0)}</div>
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
              <SearchInput value={query} onChange={setQuery} placeholder="搜索记忆（混合检索：向量 + 关键词）" />
              <div className="hstack gap-6" title="检索模式：混合 / 关键词 / 向量">
                <span className="tiny dim nowrap">模式</span>
                <Segmented
                  options={MODE_OPTIONS}
                  value={mode}
                  onChange={(next) => patchParams({ mode: next })}
                />
              </div>
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

          {isSearch ? (
            <div className="search-summary mt-10">
              <SearchStrategyBadges
                modeLabel={modeLabel}
                count={rows.length}
                tookMs={search.data ? search.data.tookMs : null}
                strategy={search.data?.strategy}
              />
              <span className="tiny dim">
                检索结果按综合得分排序，最多 {PAGE_SIZE} 条（服务端候选集上限内）；清空关键词回到游标列表。
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="x"
                onClick={() => {
                  setQuery('');
                  patchParams({ q: undefined });
                }}
              >
                返回列表
              </Button>
            </div>
          ) : (
            <div className="tiny dim mt-8">
              批量操作只作用于已加载的记忆（当前页），不提供「全选全部」；共享记忆与私有记忆都会按 scope 标注。
            </div>
          )}
        </div>

        {activeError && rows.length > 0 ? (
          <div style={{ padding: '0 16px 12px' }}>
            <Callout tone="amber" icon="alert">
              {isSearch ? '检索失败' : '加载失败'}，已保留已加载的记忆：{activeError}
            </Callout>
          </div>
        ) : null}

        {activeLoading && rows.length === 0 ? (
          <div className="vstack gap-10" style={{ padding: '0 16px 16px' }}>
            {[0, 1, 2, 3].map((index) => <Skeleton key={index} h={isSearch ? 118 : 72} style={{ borderRadius: 10 }} />)}
          </div>
        ) : activeError && rows.length === 0 ? (
          <div style={{ padding: '10px 16px 20px' }}>
            <ErrorState message={activeError} onRetry={() => void refreshActive()} />
            {isSearch ? (
              <Callout tone="amber" icon="info">
                检索接口可能尚未上线（POST <span className="mono">/memories/search</span>）。清空关键词可回到普通游标列表，页面其他功能不受影响。
              </Callout>
            ) : null}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '10px 16px 20px' }}>
            {hasFilters ? (
              <EmptyState
                icon="filter"
                title={isSearch ? '没有命中的记忆' : '没有符合条件的记忆'}
                description={isSearch ? '换个关键词、检索模式或清空筛选后再试。' : '调整搜索关键词或筛选条件后再试。'}
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
            {rows.map((memory) => {
              const checked = selected.has(memory.id);
              const hit = hitMap.get(memory.id);
              return (
                <div
                  key={memory.id}
                  className={`v6-memory-item is-clickable${checked ? ' is-selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setDrawerMemory(memory)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setDrawerMemory(memory);
                    }
                  }}
                >
                  {canManage ? (
                    <div
                      style={{ paddingTop: 2 }}
                      onClick={(event) => event.stopPropagation()}
                    >
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
                    {hit ? (
                      <SearchHitInsight hit={hit} weights={partition?.settings?.retrievalWeights} />
                    ) : null}
                    <div className="hstack gap-8 wrap mt-8">
                      <MemoryMeta memory={memory} onOpenSuperseded={(id) => void openMemoryById(id)} />
                      <span className="tiny dim mono" title={memory.id}>{memory.id}</span>
                    </div>
                  </div>
                  <div className="vstack gap-4" style={{ alignItems: 'flex-end' }}>
                    <div className="hstack gap-2">
                      <IconButton
                        icon="eye"
                        label="打开记忆详情与历史"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDrawerMemory(memory);
                        }}
                      />
                      {canManage ? (
                        <IconButton
                          icon="trash"
                          label="删除这条记忆"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelected(new Set([memory.id]));
                            setConfirmOpen(true);
                          }}
                        />
                      ) : null}
                    </div>
                    <Badge tone="slate" size="sm">{memory.status}</Badge>
                  </div>
                </div>
              );
            })}

            <div className="between wrap gap-10" style={{ padding: '14px 16px', borderTop: '1px solid var(--border-faint)' }}>
              <span className="tiny dim">
                {isSearch
                  ? `检索结果按得分排序，共 ${fmtInt(rows.length)} 条`
                  : list.hasMore
                    ? '继续加载更早的记忆（每次 50 条）'
                    : `已加载全部 ${fmtInt(list.items.length)} 条`}
              </span>
              {!isSearch && list.hasMore ? (
                <Button size="sm" variant="secondary" icon="chevronDown" loading={list.loadingMore} onClick={() => void list.loadMore()}>
                  加载更多
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </Card>

      <MemoryDrawer
        open={Boolean(drawerMemory)}
        partitionId={partitionId}
        memory={drawerMemory}
        searchQuery={qParam}
        canManage={canManage}
        onClose={() => setDrawerMemory(null)}
        onOpenMemory={(id) => void openMemoryById(id)}
        onChanged={() => void refreshActive()}
      />

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
