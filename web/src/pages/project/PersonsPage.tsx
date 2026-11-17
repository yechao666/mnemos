import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Person, PersonStatus, PersonType } from '@shared';
import { PAGE_SIZE } from '@shared';
import {
  Avatar,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  PageHead,
  Pagination,
  SearchInput,
  Select,
  Skeleton,
  Stat,
  Table,
  type Column,
} from '@ui';
import { useAsync, useDebounced } from '@lib/hooks.ts';
import { api, type PersonListParams } from '@lib/api.ts';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { isNotFoundError } from '../../components/project/agent/shared.tsx';
import {
  PERSON_SORT_OPTIONS,
  PERSON_STATUS_OPTIONS,
  PERSON_TYPE_OPTIONS,
  PersonExternalIdChip,
  PersonStatusBadge,
  PersonTypeBadge,
  personDisplayName,
  personTone,
} from '../../components/project/person/shared.tsx';

type PersonRow = Person;

/**
 * 人（Person）列表：记忆数据主体的注册表。
 * 人不是登录账号，而是 App 用户 / 智能体 / 服务等记忆归属主体。
 */
export function PersonsPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const debouncedQ = useDebounced(q, 350);
  const [type, setType] = useState<PersonType | ''>('');
  const [status, setStatus] = useState<PersonStatus | ''>('');
  const [sort, setSort] = useState<'recent' | 'name' | 'memories'>('recent');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setTerm(debouncedQ.trim());
    setPage(1);
  }, [debouncedQ]);

  useEffect(() => {
    setPage(1);
  }, [type, status, sort]);

  const { data, loading, error, refresh } = useAsync(() => {
    const params: PersonListParams = { page, pageSize: PAGE_SIZE, sort };
    if (term) params.q = term;
    if (type) params.type = type;
    if (status) params.status = status;
    return api.persons.list(projectId, params);
  }, [projectId, term, type, status, sort, page], Boolean(projectId));

  // 各类型总数：分页只覆盖当前页，单独取一次 total 才是全量口径。
  const humanAsync = useAsync(
    () => api.persons.list(projectId, { type: 'human', pageSize: 1 }).then((result) => result.total),
    [projectId],
    Boolean(projectId),
  );
  const agentAsync = useAsync(
    () => api.persons.list(projectId, { type: 'agent', pageSize: 1 }).then((result) => result.total),
    [projectId],
    Boolean(projectId),
  );
  const serviceAsync = useAsync(
    () => api.persons.list(projectId, { type: 'service', pageSize: 1 }).then((result) => result.total),
    [projectId],
    Boolean(projectId),
  );

  const rows = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const hasFilters = Boolean(term || type || status);

  const countOrDash = (value: number | null | undefined): string =>
    value == null ? '—' : fmtInt(value);

  const openPerson = (person: PersonRow) => {
    // 优先用内部 id 作为路由 ref；外部 id 仅作展示，避免特殊字符污染地址。
    navigate(`/projects/${projectId}/persons/${encodeURIComponent(person.id)}`);
  };

  const clearFilters = () => {
    setQ('');
    setTerm('');
    setType('');
    setStatus('');
    setSort('recent');
    setPage(1);
  };

  const columns: Column<PersonRow>[] = [
    {
      key: 'person',
      header: '人',
      width: '30%',
      render: (row) => (
        <div className="hstack gap-10" style={{ minWidth: 0 }}>
          <Avatar name={personDisplayName(row)} tone={personTone(row)} size="sm" square />
          <div className="vstack gap-4" style={{ minWidth: 0 }}>
            <span className="strong truncate" title={personDisplayName(row)}>
              {personDisplayName(row)}
            </span>
            <PersonExternalIdChip externalId={row.externalId} />
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      header: '类型',
      width: 96,
      render: (row) => <PersonTypeBadge type={row.type} size="sm" />,
    },
    {
      key: 'status',
      header: '状态',
      width: 96,
      render: (row) => <PersonStatusBadge status={row.status} size="sm" />,
    },
    {
      key: 'memories',
      header: '记忆',
      width: 84,
      align: 'right',
      render: (row) => <span className="mono">{fmtInt(row.stats?.memories ?? 0)}</span>,
    },
    {
      key: 'sharedMemories',
      header: '共享记忆',
      width: 96,
      align: 'right',
      render: (row) => <span className="mono">{fmtInt(row.stats?.sharedMemories ?? 0)}</span>,
    },
    {
      key: 'sessions',
      header: '会话',
      width: 78,
      align: 'right',
      render: (row) => <span className="mono">{fmtInt(row.stats?.sessions ?? 0)}</span>,
    },
    {
      key: 'lastSeenAt',
      header: '最近活跃',
      width: 116,
      render: (row) => (
        <span className="tiny muted" title={row.lastSeenAt}>
          {fmtRelative(row.lastSeenAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      width: 92,
      align: 'right',
      render: (row) => (
        <div className="hstack gap-2" style={{ justifyContent: 'flex-end' }}>
          <IconButton
            icon="brain"
            label="查看该人的记忆"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              navigate(`/projects/${projectId}/memories?person=${encodeURIComponent(row.externalId)}`);
            }}
          />
          <IconButton
            icon="eye"
            label="查看人详情"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              openPerson(row);
            }}
          />
        </div>
      ),
    },
  ];

  const emptyNode = hasFilters ? (
    <EmptyState
      icon="filter"
      title="没有符合条件的人"
      description="调整类型、状态或关键词后重试；人会在调用方首次写入记忆时自动建档。"
      action={
        <Button size="sm" variant="secondary" icon="x" onClick={clearFilters}>
          清空筛选
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon="users"
      title="还没有人"
      description="人（Person）是记忆的主体。调用方通过 API 带 person external id 写入记忆后，这里会出现对应的人。"
      action={
        <Button
          size="sm"
          variant="secondary"
          icon="list"
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
        eyebrow="人 · 记忆主体"
        title="人"
        desc="分区内记忆的归属主体：App 用户、智能体或服务。人不是登录账号，一个账号可以管理多个人。"
        actions={
          <>
            <Button
              variant="secondary"
              icon="brain"
              onClick={() => navigate(`/projects/${projectId}/memories`)}
            >
              记忆浏览器
            </Button>
            <Button icon="refresh" loading={loading} onClick={() => void refresh()}>
              刷新
            </Button>
          </>
        }
      />

      <div className="grid grid-4">
        <Stat
          label="人总数"
          value={loading && !data ? <Skeleton w={48} h={22} /> : fmtInt(total)}
          icon="users"
          tone="violet"
          hint="当前分区内的记忆主体"
        />
        <Stat
          label="真人"
          value={countOrDash(humanAsync.data)}
          icon="user"
          tone="blue"
          hint="App 用户 / 员工等自然人"
        />
        <Stat
          label="智能体"
          value={countOrDash(agentAsync.data)}
          icon="bot"
          tone="cyan"
          hint="AI Agent / 数字员工"
        />
        <Stat
          label="服务"
          value={countOrDash(serviceAsync.data)}
          icon="server"
          tone="amber"
          hint="后台服务或系统身份"
        />
      </div>

      {error && data ? (
        <Callout tone="amber" icon="alert">
          刷新人列表失败，当前展示上一次成功获取的数据：{error}
        </Callout>
      ) : null}

      <Card>
        <div style={{ padding: '14px 16px' }}>
          <div className="toolbar">
            <div className="toolbar-left">
              <SearchInput
                value={q}
                onChange={setQ}
                placeholder="搜索显示名 / external ID"
                onSubmit={() => {
                  setTerm(q.trim());
                  setPage(1);
                }}
              />
              <Select
                options={PERSON_TYPE_OPTIONS}
                value={type}
                aria-label="按类型筛选"
                style={{ width: 122 }}
                onChange={(event) => setType(event.target.value as PersonType | '')}
              />
              <Select
                options={PERSON_STATUS_OPTIONS}
                value={status}
                aria-label="按状态筛选"
                style={{ width: 118 }}
                onChange={(event) => setStatus(event.target.value as PersonStatus | '')}
              />
              <Select
                options={PERSON_SORT_OPTIONS}
                value={sort}
                aria-label="排序方式"
                style={{ width: 132 }}
                onChange={(event) =>
                  setSort(event.target.value as 'recent' | 'name' | 'memories')
                }
              />
            </div>
            <div className="toolbar-right">
              {hasFilters ? (
                <Button size="sm" variant="ghost" icon="x" onClick={clearFilters}>
                  清空筛选
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {error && !data ? (
          <div style={{ padding: '10px 16px 20px' }}>
            <div className="vstack gap-10">
              <ErrorState message={error} onRetry={() => void refresh()} />
              {isNotFoundError(error) ? (
                <Callout tone="amber" icon="info">
                  人（persons）接口尚未就绪时会返回 404；后端实现完成后点击「重试」即可加载，页面其他部分不受影响。
                </Callout>
              ) : null}
            </div>
          </div>
        ) : (
          <Table<PersonRow>
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={loading && !data}
            onRowClick={openPerson}
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

      <Callout tone="slate" icon="info">
        人级记忆的可见范围由 scope 决定（仅本人 / 分区共享 / 仅会话）；人的简报与上下文可在人详情页查看。
      </Callout>
    </div>
  );
}
