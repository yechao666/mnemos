import { useNavigate } from 'react-router-dom';
import type { Memory, Person } from '@lib/types.ts';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtCompact, fmtInt, fmtRelative } from '@lib/format.ts';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  Skeleton,
  Stat,
} from '@ui';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { CategoryBadge, MemoryContent } from '../components/memories/shared.tsx';
import { PersonStatusBadge, PersonTypeBadge, personDisplayName, personTone } from '../components/persons/shared.tsx';

/** 分区概览：统计卡（读 partition_stats）+ 最近活跃人 + 最近记忆（各取游标前 10）。 */
export function PartitionOverviewPage() {
  const navigate = useNavigate();
  const { partition, stats } = usePartitionContext();
  const partitionId = partition?.id ?? '';

  const personsQuery = useAsync(
    () => api.persons.list(partitionId, { limit: 10, sort: 'recent' }),
    [partitionId],
    Boolean(partitionId),
  );
  const memoriesQuery = useAsync(
    () => api.memories.list(partitionId, { limit: 10 }),
    [partitionId],
    Boolean(partitionId),
  );

  const persons = personsQuery.data?.items ?? [];
  const memories = memoriesQuery.data?.items ?? [];
  const loading = !stats;

  const count = (value: number | undefined) =>
    value === undefined ? <Skeleton w={54} h={22} /> : fmtInt(value);

  return (
    <div className="page">
      <div className="grid grid-4">
        <Stat
          label="人总数"
          value={count(stats?.personsTotal)}
          icon="users"
          tone="violet"
          hint={`真人 ${fmtCompact(stats?.personsHuman ?? 0)} · 智能体 ${fmtCompact(stats?.personsAgent ?? 0)} · 服务 ${fmtCompact(stats?.personsService ?? 0)}`}
        />
        <Stat
          label="记忆"
          value={count(stats?.memoriesTotal)}
          icon="brain"
          tone="cyan"
          hint={`共享 ${fmtCompact(stats?.sharedTotal ?? 0)} 条`}
        />
        <Stat
          label="共享记忆"
          value={count(stats?.sharedTotal)}
          icon="users"
          tone="green"
          hint="scope=partition，分区内所有人可见"
        />
        <Stat
          label="会话"
          value={count(stats?.sessionsTotal)}
          icon="branch"
          tone="amber"
          hint="可选分组，把同一串交互归组"
        />
      </div>

      {loading ? (
        <Card pad>
          <div className="vstack gap-10">
            <Skeleton w={180} h={14} />
            <Skeleton h={54} style={{ borderRadius: 10 }} />
            <Skeleton h={54} style={{ borderRadius: 10 }} />
            <Skeleton h={54} style={{ borderRadius: 10 }} />
          </div>
        </Card>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card pad>
          <div className="between wrap gap-10">
            <div>
              <div className="section-title">最近活跃的人</div>
              <div className="tiny dim mt-4">按最近活跃时间排序，只取前 10 位。</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              iconRight="arrowRight"
              onClick={() => navigate(`/partitions/${partitionId}/persons`)}
            >
              全部人
            </Button>
          </div>

          {personsQuery.loading && !personsQuery.data ? (
            <div className="vstack gap-8 mt-12">
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} h={52} style={{ borderRadius: 10 }} />
              ))}
            </div>
          ) : personsQuery.error && !personsQuery.data ? (
            <div className="mt-12">
              <ErrorState message={personsQuery.error} onRetry={() => void personsQuery.refresh()} />
            </div>
          ) : persons.length === 0 ? (
            <div className="mt-12">
              <EmptyState
                compact
                icon="users"
                title="还没有人"
                description="调用方写入记忆时会自动建档；也可以用 PUT /v1/partitions/:p/persons/:externalId 预先建档。"
              />
            </div>
          ) : (
            <div className="vstack gap-6 mt-12">
              {persons.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  onClick={() => navigate(`/partitions/${partitionId}/persons/${encodeURIComponent(person.id)}`)}
                />
              ))}
            </div>
          )}
        </Card>

        <Card pad>
          <div className="between wrap gap-10">
            <div>
              <div className="section-title">最近记忆</div>
              <div className="tiny dim mt-4">分区内最新写入的 10 条记忆。</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              iconRight="arrowRight"
              onClick={() => navigate(`/partitions/${partitionId}/memories`)}
            >
              记忆浏览器
            </Button>
          </div>

          {memoriesQuery.loading && !memoriesQuery.data ? (
            <div className="vstack gap-8 mt-12">
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} h={64} style={{ borderRadius: 10 }} />
              ))}
            </div>
          ) : memoriesQuery.error && !memoriesQuery.data ? (
            <div className="mt-12">
              <ErrorState message={memoriesQuery.error} onRetry={() => void memoriesQuery.refresh()} />
            </div>
          ) : memories.length === 0 ? (
            <div className="mt-12">
              <EmptyState
                compact
                icon="brain"
                title="还没有记忆"
                description="写入第一条记忆后，这里会展示最近内容与来源。"
              />
            </div>
          ) : (
            <div className="vstack gap-8 mt-12">
              {memories.map((memory) => (
                <MemoryRow key={memory.id} memory={memory} />
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card pad>
        <div className="between wrap gap-12">
          <div>
            <div className="section-title">
              <Icon name="info" size={14} /> 关于这个分区
            </div>
            <div className="tiny dim mt-4">
              slug <span className="mono">{partition?.slug ?? '—'}</span> · 状态{' '}
              {partition?.status ?? '—'} · 创建于 {partition?.createdAt ? fmtRelative(partition.createdAt) : '—'}
            </div>
          </div>
          <div className="hstack gap-8 wrap">
            <Button size="sm" icon="key" onClick={() => navigate(`/partitions/${partitionId}/keys`)}>
              密钥
            </Button>
            <Button size="sm" icon="code" onClick={() => navigate(`/partitions/${partitionId}/docs`)}>
              API 文档
            </Button>
            <Button size="sm" icon="settings" onClick={() => navigate(`/partitions/${partitionId}/settings`)}>
              设置
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function PersonRow({ person, onClick }: { person: Person; onClick: () => void }) {
  return (
    <button type="button" className="v6-row-card" onClick={onClick}>
      <Avatar name={personDisplayName(person)} tone={personTone(person)} size="sm" square />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="hstack gap-6">
          <span className="strong truncate">{personDisplayName(person)}</span>
          <PersonTypeBadge type={person.type} size="sm" />
          <PersonStatusBadge status={person.status} size="sm" />
        </span>
        <span className="tiny dim mono truncate" style={{ display: 'block' }}>{person.externalId}</span>
      </span>
      <span className="vstack" style={{ alignItems: 'flex-end', gap: 2 }}>
        <span className="small mono">{fmtInt(person.memoryCount)} 记忆</span>
        <span className="tiny dim">{fmtRelative(person.lastSeenAt ?? person.lastMemoryAt)}</span>
      </span>
      <Icon name="chevronRight" size={14} />
    </button>
  );
}

function MemoryRow({ memory }: { memory: Memory }) {
  return (
    <div className="v6-memory-row">
      <MemoryContent memory={memory} clamp />
      <div className="between wrap gap-8 mt-4 tiny dim">
        <span className="hstack gap-6">
          <CategoryBadge category={memory.category} size="sm" />
          <span className="mono truncate" style={{ maxWidth: 180 }}>
            {memory.personExternalId || memory.personId}
          </span>
        </span>
        <span title={memory.updatedAt}>{fmtRelative(memory.updatedAt)}</span>
      </div>
    </div>
  );
}
