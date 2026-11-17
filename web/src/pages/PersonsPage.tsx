import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Person, PersonStatus, PersonType } from '@lib/types.ts';
import {
  PERSON_ROW_HEIGHT,
  PERSON_SORT_OPTIONS,
  PERSON_STATUS_OPTIONS,
  PERSON_TYPE_OPTIONS,
  type PersonSort,
} from '@lib/constants.ts';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  PageHead,
  SearchInput,
  Select,
  Skeleton,
  Stat,
  Switch,
} from '@ui';
import { api } from '@lib/api.ts';
import { useCursorList, useDebounced } from '@lib/hooks.ts';
import { fmtCompact, fmtInt, fmtRelative } from '@lib/format.ts';
import { partitionInitial } from '../components/shell/util.ts';
import {
  PersonExternalIdChip,
  PersonStatusBadge,
  PersonTypeBadge,
  personDisplayName,
  personTone,
} from '../components/persons/shared.tsx';
import { WindowedList } from '../components/virtual/WindowedList.tsx';
import { usePartitionContext } from '@lib/partition-context.tsx';

/**
 * 人列表（核心，百万级）：
 *  - 头部统计读 partition_stats（列表响应自带），不 COUNT(*)、不逐行查 stats；
 *  - FTS 前缀搜索 300ms 防抖；类型/状态筛选；排序 recent/new/name；
 *  - 服务端游标分页（每页 50），滚动到底自动加载；
 *  - 自实现窗口化：固定行高 56px，只渲染可视行；
 *  - 筛选条件写入 URL query，可回放。
 */
export function PersonsPage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();
  const { stats: layoutStats } = usePartitionContext();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const qParam = searchParams.get('q') ?? '';
  const type = (searchParams.get('type') as PersonType | null) ?? '';
  const status = (searchParams.get('status') as PersonStatus | null) ?? '';
  const sort = ((searchParams.get('sort') as PersonSort | null) ?? 'recent');
  const activeSort: PersonSort = sort === 'new' || sort === 'name' ? sort : 'recent';
  // v6.1：默认由后端过滤已合并/已删除的人；开关用于排查合并历史。
  const includeMerged = searchParams.get('merged') === '1';

  const [query, setQuery] = useState(qParam);
  const debouncedQuery = useDebounced(query, 300);
  const trimmedQuery = debouncedQuery.trim();

  // URL 是可回放的唯一事实：输入框防抖后才写回 query。
  useEffect(() => {
    if (trimmedQuery === qParam) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (trimmedQuery) next.set('q', trimmedQuery);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmedQuery]);

  // 浏览器前进/后退时把 URL 中的 q 同步回输入框。
  useEffect(() => {
    setQuery(qParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam]);

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

  const list = useCursorList<Person>(
    (cursor) =>
      api.persons.list(partitionId, {
        q: qParam || undefined,
        type: type || undefined,
        status: status || undefined,
        sort: activeSort,
        cursor,
        limit: 50,
        includeMerged: includeMerged || undefined,
      }),
    [partitionId, qParam, type, status, activeSort, includeMerged],
    Boolean(partitionId),
  );

  // 列表响应自带 partitionStats；请求失败/未返回时用分区布局读取的统计兜底。
  const stats = list.partitionStats ?? layoutStats;
  const hasFilters = Boolean(qParam || type || status || includeMerged);
  const filtersKey = `${qParam}|${type}|${status}|${activeSort}|${includeMerged ? 'merged' : ''}`;

  const clearFilters = () => {
    setQuery('');
    setSearchParams({}, { replace: true });
  };

  const countValue = (value: number | undefined) =>
    value === undefined ? <Skeleton w={48} h={22} /> : fmtInt(value);

  const rows = list.items;
  const summary = useMemo(
    () => ({
      loaded: rows.length,
      hasMore: list.hasMore,
    }),
    [rows.length, list.hasMore],
  );

  const openPerson = (person: Person) => {
    navigate(`/partitions/${partitionId}/persons/${encodeURIComponent(person.id)}`);
  };

  const emptyNode = hasFilters ? (
    <EmptyState
      icon="filter"
      title="没有符合条件的人"
      description="调整关键词、类型或状态后重试。搜索走 FTS 前缀匹配（q 为空时按索引排序）。"
      action={<Button size="sm" icon="x" onClick={clearFilters}>清空筛选</Button>}
    />
  ) : (
    <EmptyState
      icon="users"
      title="这个分区还没有人"
      description="人（Person）是记忆的主体：App 用户、员工、智能体或服务。调用方写入记忆时会按 external id 自动建档。"
    />
  );

  return (
    <div className="page">
      <PageHead
        eyebrow="人 · 记忆主体"
        title="人"
        desc="分区内记忆的归属主体。人不是登录账号；列表按百万级设计：服务端游标分页 + 窗口化只渲染可视行。"
        actions={
          <>
            <Button variant="secondary" icon="brain" onClick={() => navigate(`/partitions/${partitionId}/memories`)}>
              记忆浏览器
            </Button>
            <Button icon="refresh" loading={list.loading} onClick={() => void list.refresh()}>
              刷新
            </Button>
          </>
        }
      />

      <div className="grid grid-4">
        <Stat
          label="人总数"
          value={countValue(stats?.personsTotal)}
          icon="users"
          tone="violet"
          hint="读取 partition_stats，不做 COUNT(*)"
        />
        <Stat
          label="真人"
          value={countValue(stats?.personsHuman)}
          icon="user"
          tone="blue"
          hint="App 用户 / 员工等自然人"
        />
        <Stat
          label="智能体"
          value={countValue(stats?.personsAgent)}
          icon="bot"
          tone="cyan"
          hint="AI Agent / 数字员工"
        />
        <Stat
          label="记忆 / 共享"
          value={countValue(stats?.memoriesTotal)}
          icon="brain"
          tone="amber"
          hint={`共享 ${fmtCompact(stats?.sharedTotal ?? 0)} 条`}
        />
      </div>

      {list.error && rows.length > 0 ? (
        <Callout tone="amber" icon="alert">
          加载下一页失败，已保留已加载的人：{list.error}
        </Callout>
      ) : null}

      <Card>
        <div style={{ padding: '14px 16px' }}>
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="搜索显示名 / external ID（FTS 前缀）"
                onSubmit={() => {
                  if (trimmedQuery !== qParam) {
                    setSearchParams(
                      (prev) => {
                        const next = new URLSearchParams(prev);
                        if (trimmedQuery) next.set('q', trimmedQuery);
                        else next.delete('q');
                        return next;
                      },
                      { replace: true },
                    );
                  }
                }}
              />
              <Select
                options={PERSON_TYPE_OPTIONS}
                value={type}
                aria-label="按类型筛选"
                style={{ width: 124 }}
                onChange={(event) => patchParams({ type: event.target.value || undefined })}
              />
              <Select
                options={PERSON_STATUS_OPTIONS}
                value={status}
                aria-label="按状态筛选"
                style={{ width: 120 }}
                onChange={(event) => patchParams({ status: event.target.value || undefined })}
              />
              <Select
                options={PERSON_SORT_OPTIONS}
                value={activeSort}
                aria-label="排序方式"
                style={{ width: 132 }}
                onChange={(event) => patchParams({ sort: event.target.value === 'recent' ? undefined : event.target.value })}
              />
              <Switch
                checked={includeMerged}
                label="包含已合并"
                onChange={(next) => patchParams({ merged: next ? '1' : undefined })}
              />
            </div>
            <div className="toolbar-right">
              {hasFilters ? (
                <Button size="sm" variant="ghost" icon="x" onClick={clearFilters}>
                  清空筛选
                </Button>
              ) : null}
              <span className="tiny dim nowrap">
                已加载 {fmtInt(summary.loaded)} 人{summary.hasMore ? ' · 滚动加载更多' : ' · 已到底'}
              </span>
            </div>
          </div>
        </div>

        {list.error && rows.length === 0 ? (
          <div style={{ padding: '10px 16px 20px' }}>
            <ErrorState message={list.error} onRetry={() => void list.refresh()} />
          </div>
        ) : list.loading && rows.length === 0 ? (
          <div className="vstack gap-10" style={{ padding: '0 16px 16px' }}>
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} h={PERSON_ROW_HEIGHT - 8} style={{ borderRadius: 10 }} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '10px 16px 20px' }}>{emptyNode}</div>
        ) : (
          <WindowedList<Person>
            key={filtersKey}
            items={rows}
            rowHeight={PERSON_ROW_HEIGHT}
            overscan={8}
            label="人列表"
            renderRow={(person) => <PersonRow person={person} onClick={() => openPerson(person)} />}
            rowKey={(person) => person.id}
            onEndReached={() => void list.loadMore()}
            hasMore={list.hasMore}
            loadingMore={list.loadingMore}
            style={{ height: 'min(64vh, 720px)' }}
            footer={
              <div className="between wrap gap-8">
                <span className="tiny dim">
                  {list.hasMore
                    ? '继续向下滚动，自动加载下一页（每次 50 人）'
                    : `已加载全部 ${fmtInt(rows.length)} 人`}
                </span>
                {list.loadingMore ? (
                  <span className="hstack gap-6 tiny dim">
                    <span className="spinner-lg" style={{ width: 12, height: 12 }} />
                    加载中…
                  </span>
                ) : null}
              </div>
            }
          />
        )}
      </Card>

      <Callout tone="slate" icon="info">
        行内容保持极简（显示名 / external_id / 类型 / 记忆数 / 最近活跃），避免百万级列表携带大字段；
        覆盖筛选条件时整个列表以 URL 为事实来源，刷新或分享链接可回放。
      </Callout>
    </div>
  );
}

/** 固定行高 56px 的人员行。 */
function PersonRow({ person, onClick }: { person: Person; onClick: () => void }) {
  return (
    <button type="button" className="v6-person-row" onClick={onClick} title={`${personDisplayName(person)} · ${person.externalId}`}>
      <span className="v6-person-cell v6-person-cell-main">
        <Avatar name={personDisplayName(person)} tone={personTone(person)} size="sm" square />
        <span className="vstack" style={{ minWidth: 0, gap: 1 }}>
          <span className="hstack gap-6" style={{ minWidth: 0 }}>
            <span className="strong truncate">{personDisplayName(person)}</span>
            <PersonTypeBadge type={person.type} size="sm" />
            {person.status !== 'active' ? <PersonStatusBadge status={person.status} size="sm" /> : null}
            {person.mergedInto ? (
              <Badge tone="amber" size="sm" dot>
                已合并
              </Badge>
            ) : null}
          </span>
          <PersonExternalIdChip externalId={person.externalId} />
        </span>
      </span>
      <span className="v6-person-cell v6-person-cell-type">
        <span className={`project-mark tone-${personTone(person)}`} style={{ width: 24, height: 24, borderRadius: 8, fontSize: 10 }} aria-hidden="true">
          {partitionInitial(personDisplayName(person))}
        </span>
        <Badge tone={person.type === 'agent' ? 'cyan' : person.type === 'service' ? 'amber' : person.type === 'human' ? 'blue' : 'slate'} size="sm">
          {person.type === 'agent' ? '智能体' : person.type === 'service' ? '服务' : person.type === 'human' ? '真人' : '其他'}
        </Badge>
      </span>
      <span className="v6-person-cell v6-person-cell-count">
        <span className="mono strong">{fmtInt(person.memoryCount)}</span>
        <span className="tiny dim">记忆</span>
      </span>
      <span className="v6-person-cell v6-person-cell-shared">
        <span className="mono">{fmtInt(person.sharedMemoryCount)}</span>
        <span className="tiny dim">共享</span>
      </span>
      <span className="v6-person-cell v6-person-cell-time">
        <span className="small">{fmtRelative(person.lastSeenAt ?? person.lastMemoryAt)}</span>
        <span className="tiny dim" title={person.lastSeenAt ?? person.lastMemoryAt}>
          最近活跃
        </span>
      </span>
    </button>
  );
}
