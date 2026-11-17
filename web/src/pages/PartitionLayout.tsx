import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import type { Partition, PartitionStats } from '@lib/types.ts';
import { PARTITION_TABS } from '@lib/constants.ts';
import { Badge, Button, Card, ErrorState, Icon, IconButton, LoadingBlock, PageHead, Skeleton } from '@ui';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { PartitionContext, type PartitionContextValue } from '@lib/partition-context.tsx';
import {
  partitionInitial,
  partitionStatusLabel,
  partitionStatusTone,
  partitionTone,
} from '../components/shell/util.ts';

/** 分区工作区：统一拉取分区详情 + 统计，并向页签子页面提供 PartitionContext。 */
export function PartitionLayout() {
  const { partitionId } = useParams<{ partitionId: string }>();
  const navigate = useNavigate();
  const id = partitionId ?? '';

  const { data, loading, error, refresh } = useAsync(async () => {
    const [partition, stats] = await Promise.all([
      api.partitions.get(id),
      api.partitions.stats(id).catch(() => undefined),
    ]);
    return { partition, stats };
  }, [id], Boolean(id));

  const [partition, setPartitionState] = useState<Partition | null>(null);
  const [stats, setStats] = useState<PartitionStats | null>(null);

  useEffect(() => {
    if (data?.partition && (data.partition.id === id || data.partition.slug === id)) {
      setPartitionState(data.partition);
      setStats(data.stats ?? data.partition.stats ?? null);
    }
  }, [data, id]);

  // 切换分区的瞬间不要展示上一个分区的数据。
  const active = partition && (partition.id === id || partition.slug === id) ? partition : null;
  const activeStats = active ? stats : null;

  const setPartition = useCallback((next: Partition | null) => setPartitionState(next), []);

  const refreshPartition = useCallback(async (): Promise<Partition | null> => {
    const result = await refresh();
    return result?.partition ?? null;
  }, [refresh]);

  const contextValue = useMemo<PartitionContextValue>(
    () => ({ partition: active, stats: activeStats, loading, error, refresh: refreshPartition, setPartition }),
    [active, activeStats, loading, error, refreshPartition, setPartition],
  );

  if (!id) {
    return (
      <div className="page">
        <PageHead
          eyebrow="分区"
          title="缺少分区标识"
          desc="当前地址未包含分区 ID，请从分区列表重新进入。"
          actions={<Button icon="chevronLeft" onClick={() => navigate('/partitions')}>返回分区列表</Button>}
        />
        <Card pad>
          <ErrorState message="分区 ID 缺失，无法加载工作区。" />
        </Card>
      </div>
    );
  }

  if (!active) {
    if (!error) return <LayoutSkeleton />;
    const notFound = error.includes('404') || error.includes('不存在');
    return (
      <div className="page">
        <PageHead
          eyebrow="分区"
          title={notFound ? '分区不存在' : '无法加载分区'}
          desc={`分区 ${id}：${error}`}
          actions={<Button icon="chevronLeft" onClick={() => navigate('/partitions')}>返回分区列表</Button>}
        />
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      </div>
    );
  }

  return (
    <PartitionContext.Provider value={contextValue}>
      <div className="page">
        <div className="page-head">
          <div className="hstack gap-12" style={{ alignItems: 'flex-start' }}>
            <span
              className={`project-mark tone-${partitionTone(active.id)}`}
              style={{ width: 48, height: 48, borderRadius: 14, fontSize: 18 }}
              aria-hidden="true"
            >
              {partitionInitial(active.name)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="page-eyebrow">分区工作区 · App / 项目 / 租户</div>
              <h1 className="page-title">{active.name}</h1>
              <div className="hstack gap-8 wrap mt-8">
                <span className="project-slug mono">{active.slug}</span>
                <Badge tone={partitionStatusTone(active.status)} size="sm" dot>
                  {partitionStatusLabel(active.status)}
                </Badge>
                <span className="pill">
                  <Icon name="users" size={11} /> {fmtInt(activeStats?.personsTotal)} 人
                </span>
                <span className="pill">
                  <Icon name="brain" size={11} /> {fmtInt(activeStats?.memoriesTotal)} 记忆
                </span>
                {active.description ? <span className="tiny dim truncate" style={{ maxWidth: 360 }}>{active.description}</span> : null}
                <span className="tiny dim" title={active.updatedAt}>更新于 {fmtRelative(active.updatedAt)}</span>
              </div>
            </div>
          </div>
          <div className="page-actions">
            {loading ? (
              <span className="tiny dim hstack gap-6">
                <span className="spinner-lg" style={{ width: 12, height: 12 }} />
                同步中
              </span>
            ) : null}
            <Button icon="users" onClick={() => navigate(`/partitions/${active.id}/persons`)}>
              人列表
            </Button>
            <Button variant="primary" icon="key" onClick={() => navigate(`/partitions/${active.id}/keys`)}>
              新建密钥
            </Button>
            <IconButton icon="refresh" label="刷新分区" disabled={loading} onClick={() => void refresh()} />
          </div>
        </div>

        <nav className="tabs" aria-label="分区页签">
          {PARTITION_TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <Outlet />
      </div>
    </PartitionContext.Provider>
  );
}

function LayoutSkeleton() {
  return (
    <div className="page">
      <div className="page-head">
        <div className="hstack gap-12" style={{ alignItems: 'flex-start' }}>
          <Skeleton w={48} h={48} style={{ borderRadius: 14 }} />
          <div className="vstack gap-8">
            <Skeleton w={120} h={10} />
            <Skeleton w={240} h={24} />
            <Skeleton w={320} h={12} />
          </div>
        </div>
        <div className="hstack gap-10">
          <Skeleton w={88} h={32} style={{ borderRadius: 9 }} />
          <Skeleton w={96} h={32} style={{ borderRadius: 9 }} />
        </div>
      </div>
      <Skeleton h={38} />
      <Card pad>
        <LoadingBlock label="正在加载分区工作区…" />
      </Card>
    </div>
  );
}
