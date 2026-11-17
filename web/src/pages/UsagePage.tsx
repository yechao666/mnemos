import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { usePartitionContext } from '@lib/partition-context.tsx';
import { fmtCompact, fmtInt, fmtMs, fmtPct } from '@lib/format.ts';
import { Callout, Card, ErrorState, IconButton, PageHead, SectionHead, Segmented, Skeleton, Stat, Table } from '@ui';
import { BarChart, DonutChart, LineChart } from '@charts';

const DAY_OPTIONS = [7, 30, 90] as const;

/** 用量：读 /usage?days=N 的聚合结果，不加载原始事件。 */
export function UsagePage() {
  const { partitionId = '' } = useParams<{ partitionId: string }>();
  const { partition } = usePartitionContext();
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(30);

  const { data, loading, error, refresh } = useAsync(
    () => api.partitions.usage(partitionId, days),
    [partitionId, days],
    Boolean(partitionId),
  );

  const points = data?.points ?? [];
  const chartPoints = points.map((point) => ({
    label: point.date.slice(5),
    values: [point.adds, point.searches],
  }));

  return (
    <div className="page">
      <PageHead
        eyebrow="用量"
        title="用量与性能"
        desc={`分区「${partition?.name ?? partitionId}」最近 ${days} 天的聚合用量：写入、检索、Token 与延迟分位。`}
        actions={
          <>
            <Segmented
              options={DAY_OPTIONS.map((value) => ({ value, label: `${value} 天` }))}
              value={days}
              onChange={setDays}
            />
            <IconButton icon="refresh" label="刷新用量" disabled={loading} onClick={() => void refresh()} />
          </>
        }
      />

      {error && data ? (
        <Callout tone="amber" icon="alert">刷新失败，当前展示上次加载的用量：{error}</Callout>
      ) : null}

      {loading && !data ? (
        <div className="grid grid-4">
          {[0, 1, 2, 3].map((index) => <Skeleton key={index} h={92} style={{ borderRadius: 14 }} />)}
        </div>
      ) : error && !data ? (
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      ) : data ? (
        <>
          <div className="grid grid-4">
            <Stat label="记忆写入" value={fmtInt(data.totals.adds)} icon="brain" tone="violet" hint={`${days} 天累计`} />
            <Stat label="检索次数" value={fmtInt(data.totals.searches)} icon="search" tone="cyan" hint={`读取 ${fmtInt(data.totals.retrievals)} 次`} />
            <Stat label="注入 Token" value={fmtCompact(data.totals.tokens)} icon="database" tone="amber" hint="控制上下文成本" />
            <Stat
              label="错误率"
              value={fmtPct(data.totals.errorRate)}
              icon="alert"
              tone={data.totals.errorRate > 1 ? 'red' : 'green'}
              hint={`${fmtInt(data.totals.errors)} 次错误`}
            />
          </div>

          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <Card pad>
              <SectionHead title="写入与检索趋势" desc="按天聚合，竖轴为次数。" />
              <div style={{ marginTop: 12 }}>
                <LineChart
                  points={chartPoints}
                  series={[
                    { name: '写入', color: 'var(--chart-1)' },
                    { name: '检索', color: 'var(--chart-2)' },
                  ]}
                  height={220}
                  valueFormat={(value) => fmtCompact(value)}
                />
              </div>
              <div className="hstack gap-12 mt-8 tiny dim">
                <span className="hstack gap-6"><span className="legend-dot" style={{ background: 'var(--chart-1)' }} />写入</span>
                <span className="hstack gap-6"><span className="legend-dot" style={{ background: 'var(--chart-2)' }} />检索</span>
                <span className="ml-auto">p50 {fmtMs(data.latency.p50)} · p95 {fmtMs(data.latency.p95)} · p99 {fmtMs(data.latency.p99)}</span>
              </div>
            </Card>

            <Card pad>
              <SectionHead title="渠道分布" desc="控制台 / API / 系统等渠道占比。" />
              <div style={{ marginTop: 16 }}>
                <DonutChart
                  data={data.byChannel.map((row, index) => ({
                    label: row.label,
                    value: row.count,
                    color: `var(--chart-${(index % 6) + 1})`,
                  }))}
                  centerValue={fmtCompact(data.byChannel.reduce((sum, row) => sum + row.count, 0))}
                  centerLabel="调用"
                  valueFormat={(value) => fmtCompact(value)}
                />
              </div>
            </Card>
          </div>

          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <Card pad>
              <SectionHead title="按操作" desc="哪类操作消耗最多。" />
              <div style={{ marginTop: 14 }}>
                <BarChart
                  data={data.byOperation.map((row) => ({ label: row.label, value: row.count }))}
                  horizontal
                  height={200}
                  valueFormat={(value) => fmtCompact(value)}
                />
              </div>
            </Card>

            <Card pad>
              <SectionHead title="按密钥" desc="定位异常调用方。" />
              {data.byKey.length === 0 ? (
                <div className="tiny dim mt-12">暂无密钥维度数据。</div>
              ) : (
                <Table
                  columns={[
                    { key: 'label', header: '密钥', render: (row: { label: string; count: number; share: number }) => <span className="mono truncate">{row.label}</span> },
                    { key: 'count', header: '调用', align: 'right', width: 92, render: (row: { label: string; count: number; share: number }) => fmtInt(row.count) },
                    { key: 'share', header: '占比', align: 'right', width: 84, render: (row: { label: string; count: number; share: number }) => fmtPct(row.share) },
                  ]}
                  rows={data.byKey}
                  rowKey={(row) => row.label}
                />
              )}
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
