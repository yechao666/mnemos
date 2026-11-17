import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Partition, PartitionStatus, PartitionStats } from '@lib/types.ts';
import { PARTITION_STATUS_OPTIONS } from '@lib/constants.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  Modal,
  PageHead,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  Stat,
  Table,
  Textarea,
  useToast,
  type Column,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync, useDebounced } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtCompact, fmtInt, fmtRelative } from '@lib/format.ts';
import { partitionInitial, partitionStatusLabel, partitionStatusTone, partitionTone, shortHash, slugify } from '../components/shell/util.ts';

type ViewMode = 'grid' | 'table';

const EMPTY_STATS: PartitionStats = {
  personsTotal: 0,
  personsHuman: 0,
  personsAgent: 0,
  personsService: 0,
  memoriesTotal: 0,
  sharedTotal: 0,
  sessionsTotal: 0,
};

export function PartitionsPage() {
  const navigate = useNavigate();
  const { refresh: refreshAuth } = useAuth();
  const { data, loading, error, refresh } = useAsync(() => api.partitions.list(), []);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 200);
  const [status, setStatus] = useState<'all' | PartitionStatus>('all');
  const [view, setView] = useState<ViewMode>('grid');
  const [createOpen, setCreateOpen] = useState(false);

  // 分区数量是「组织级小集合」；若后端未随列表返回 stats，则按分区补齐（不扫全表）。
  const [statsFallback, setStatsFallback] = useState<Record<string, PartitionStats>>({});
  useEffect(() => {
    const list = data ?? [];
    const missing = list.filter((partition) => !partition.stats);
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (partition) => [partition.id, await api.partitions.stats(partition.id)] as const),
    ).then((entries) => {
      if (cancelled) return;
      setStatsFallback(Object.fromEntries(entries));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [data]);

  const statsOf = (partition: Partition): PartitionStats =>
    partition.stats ?? statsFallback[partition.id] ?? EMPTY_STATS;

  const rows = useMemo(() => {
    const keyword = debouncedQuery.trim().toLowerCase();
    return (data ?? [])
      .filter((partition) => {
        if (status !== 'all' && partition.status !== status) return false;
        if (!keyword) return true;
        return `${partition.name} ${partition.slug} ${partition.description}`.toLowerCase().includes(keyword);
      })
      .sort((left, right) => {
        const leftAt = statsOf(left).updatedAt ?? left.updatedAt;
        const rightAt = statsOf(right).updatedAt ?? right.updatedAt;
        return new Date(rightAt).getTime() - new Date(leftAt).getTime();
      });
  }, [data, debouncedQuery, status, statsFallback]);

  const totals = useMemo(() => {
    const base = { ...EMPTY_STATS };
    for (const partition of data ?? []) {
      const stats = statsOf(partition);
      base.personsTotal += stats.personsTotal;
      base.personsHuman += stats.personsHuman;
      base.personsAgent += stats.personsAgent;
      base.personsService += stats.personsService;
      base.memoriesTotal += stats.memoriesTotal;
      base.sharedTotal += stats.sharedTotal;
      base.sessionsTotal += stats.sessionsTotal;
    }
    return base;
  }, [data, statsFallback]);

  const resetFilters = () => {
    setQuery('');
    setStatus('all');
  };

  const columns: Column<Partition>[] = [
    {
      key: 'name',
      header: '分区',
      width: '30%',
      render: (partition) => (
        <div className="hstack gap-10" style={{ minWidth: 0 }}>
          <span className={`project-mark tone-${partitionTone(partition.id)}`} aria-hidden="true">
            {partitionInitial(partition.name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="strong truncate">{partition.name}</div>
            <div className="tiny dim truncate">{partition.description || '暂无描述'}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'slug',
      header: 'slug',
      width: 150,
      render: (partition) => <span className="tiny dim mono">{partition.slug}</span>,
    },
    {
      key: 'status',
      header: '状态',
      width: 96,
      render: (partition) => (
        <Badge tone={partitionStatusTone(partition.status)} size="sm" dot>
          {partitionStatusLabel(partition.status)}
        </Badge>
      ),
    },
    {
      key: 'persons',
      header: '人',
      width: 96,
      align: 'right',
      render: (partition) => <span className="mono">{fmtInt(statsOf(partition).personsTotal)}</span>,
    },
    {
      key: 'memories',
      header: '记忆',
      width: 96,
      align: 'right',
      render: (partition) => <span className="mono">{fmtInt(statsOf(partition).memoriesTotal)}</span>,
    },
    {
      key: 'shared',
      header: '共享',
      width: 96,
      align: 'right',
      render: (partition) => <span className="mono">{fmtInt(statsOf(partition).sharedTotal)}</span>,
    },
    {
      key: 'recent',
      header: '最近活跃',
      width: 120,
      render: (partition) => (
        <span className="tiny dim" title={statsOf(partition).updatedAt ?? partition.updatedAt}>
          {fmtRelative(statsOf(partition).updatedAt ?? partition.updatedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 88,
      align: 'right',
      render: (partition) => (
        <Button
          size="sm"
          variant="ghost"
          iconRight="arrowRight"
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/partitions/${partition.id}`);
          }}
        >
          进入
        </Button>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        eyebrow="分区"
        title="分区"
        desc="分区（Partition）是记忆隔离与权限的最小单元：一个 App、项目或租户一个分区。进入分区后即可按人浏览记忆。"
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
            新建分区
          </Button>
        }
      />

      <div className="grid grid-4">
        <Stat label="分区" value={loading && !data ? <Skeleton w={40} h={22} /> : fmtInt(data?.length ?? 0)} icon="layers" tone="violet" hint="当前组织" />
        <Stat label="人" value={fmtInt(totals.personsTotal)} icon="users" tone="blue" hint={`真人 ${fmtCompact(totals.personsHuman)} · 智能体 ${fmtCompact(totals.personsAgent)}`} />
        <Stat label="记忆" value={fmtInt(totals.memoriesTotal)} icon="brain" tone="cyan" hint={`共享 ${fmtCompact(totals.sharedTotal)}`} />
        <Stat label="会话" value={fmtInt(totals.sessionsTotal)} icon="branch" tone="amber" hint="可选分组" />
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <SearchInput value={query} onChange={setQuery} placeholder="搜索分区名称、slug 或描述…" />
          <Select
            aria-label="状态筛选"
            options={PARTITION_STATUS_OPTIONS}
            value={status}
            style={{ width: 146 }}
            onChange={(event) => setStatus(event.target.value as 'all' | PartitionStatus)}
          />
        </div>
        <div className="toolbar-right">
          <span className="tiny dim">显示 {fmtInt(rows.length)} / {fmtInt(data?.length ?? 0)} 个分区</span>
          <Segmented
            options={[
              { value: 'grid', label: '网格' },
              { value: 'table', label: '表格' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      {error && data ? (
        <Callout tone="amber" icon="alert">刷新失败，当前展示上次加载的分区列表：{error}</Callout>
      ) : null}

      {loading && !data ? (
        <div className="grid grid-3">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Card key={index} className="project-card">
              <div className="hstack gap-12">
                <Skeleton w={38} h={38} style={{ borderRadius: 11 }} />
                <div className="vstack grow gap-6">
                  <Skeleton w="60%" h={13} />
                  <Skeleton w="40%" h={10} />
                </div>
              </div>
              <Skeleton w="100%" h={56} style={{ borderRadius: 12 }} />
              <Skeleton w="55%" h={22} />
            </Card>
          ))}
        </div>
      ) : error && !data ? (
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      ) : (data?.length ?? 0) === 0 ? (
        <Card pad>
          <EmptyState
            icon="layers"
            title="还没有分区，先创建第一个"
            description="分区拥有独立的人、记忆、密钥、用量与审计；适合按 App、业务线或环境拆分。"
            action={
              <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                新建分区
              </Button>
            }
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card pad>
          <EmptyState
            icon="filter"
            title="没有匹配的分区"
            description="调整搜索关键词或状态筛选后再试。"
            action={<Button size="sm" icon="x" onClick={resetFilters}>清空筛选</Button>}
          />
        </Card>
      ) : view === 'grid' ? (
        <div className="grid grid-3">
          {rows.map((partition) => {
            const stats = statsOf(partition);
            return (
              <Card
                key={partition.id}
                hover
                className="project-card v6-partition-card"
                onClick={() => navigate(`/partitions/${partition.id}`)}
              >
                <div className="project-card-top">
                  <div className={`project-mark tone-${partitionTone(partition.id)}`} aria-hidden="true">
                    {partitionInitial(partition.name)}
                  </div>
                  <div className="grow">
                    <div className="between" style={{ gap: 8 }}>
                      <span className="project-name truncate">{partition.name}</span>
                      <Badge tone={partitionStatusTone(partition.status)} size="sm" dot>
                        {partitionStatusLabel(partition.status)}
                      </Badge>
                    </div>
                    <div className="project-slug truncate mono">{partition.slug}</div>
                  </div>
                </div>

                <div className="project-desc clamp-2">{partition.description || '暂无分区描述'}</div>

                <div className="project-metrics">
                  <div>
                    <div className="pm-value">{fmtCompact(stats.personsTotal)}</div>
                    <div className="pm-label">人</div>
                  </div>
                  <div>
                    <div className="pm-value">{fmtCompact(stats.memoriesTotal)}</div>
                    <div className="pm-label">记忆</div>
                  </div>
                  <div>
                    <div className="pm-value">{fmtCompact(stats.sharedTotal)}</div>
                    <div className="pm-label">共享</div>
                  </div>
                </div>

                <div className="between tiny dim">
                  <span className="hstack gap-6">
                    <Icon name="users" size={11} />
                    真人 {fmtCompact(stats.personsHuman)} · 智能体 {fmtCompact(stats.personsAgent)}
                  </span>
                  <span title={stats.updatedAt ?? partition.updatedAt}>
                    {fmtRelative(stats.updatedAt ?? partition.updatedAt)}
                  </span>
                </div>

                <div className="between" style={{ marginTop: 'auto', gap: 8 }}>
                  <span className="tiny dim">更新于 {fmtRelative(partition.updatedAt)}</span>
                  <span className="hstack gap-4 tiny nowrap" style={{ color: 'var(--violet)' }}>
                    进入 <Icon name="arrowRight" size={12} />
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(partition) => partition.id}
            onRowClick={(partition) => navigate(`/partitions/${partition.id}`)}
          />
        </Card>
      )}

      <CreatePartitionModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (partition) => {
          await refreshAuth();
          await refresh();
          navigate(`/partitions/${partition.id}`);
        }}
      />
    </div>
  );
}

function CreatePartitionModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (partition: Partition) => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSlug('');
    setSlugTouched(false);
    setDescription('');
    setFormError(null);
  }, [open]);

  const onNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) {
      setSlug(value.trim() ? slugify(value) || `partition-${shortHash(value)}` : '');
    }
  };

  const submit = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('请填写分区名称。');
      return;
    }
    const slugValue = (slug.trim() || slugify(trimmed) || `partition-${shortHash(trimmed)}`).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(slugValue)) {
      setFormError('slug 只能包含小写字母、数字与连字符。');
      return;
    }
    setCreating(true);
    setFormError(null);
    try {
      const created = await api.partitions.create({
        name: trimmed,
        slug: slugValue,
        description: description.trim(),
      });
      toast.success(`分区「${created.name}」已创建`);
      onClose();
      await onCreated(created);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '创建失败，请稍后重试。');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建分区"
      description="分区是记忆隔离与权限授予的最小单元，创建后可在分区设置中调整默认 scope 与做梦周期。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon="plus" loading={creating} onClick={() => void submit()}>
            创建分区
          </Button>
        </>
      }
    >
      <Field label="分区名称" required htmlFor="partition-name">
        <Input
          id="partition-name"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="例如：知物感恩 App"
          autoFocus
        />
      </Field>

      <Field label="slug" htmlFor="partition-slug" hint="用于 API 路径与 DSH 插件引用，仅支持小写字母、数字与连字符。">
        <Input
          id="partition-slug"
          className="mono"
          value={slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value);
          }}
          placeholder="zhiwu-app"
        />
      </Field>

      <Field label="分区描述" htmlFor="partition-description">
        <Textarea
          id="partition-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="说明这个分区承载哪类记忆、由哪些应用写入与检索。"
          style={{ minHeight: 78 }}
        />
      </Field>

      {formError ? <div className="field-error" role="alert">{formError}</div> : null}
    </Modal>
  );
}
