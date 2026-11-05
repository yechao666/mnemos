import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAsync } from '@lib/hooks.ts';
import { fmtCompact, fmtDay, fmtInt, fmtMs, fmtPct } from '@lib/format.ts';
import { actionLabel } from '@lib/tone.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import { api } from '@lib/api.ts';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  PageHead,
  SectionHead,
  Segmented,
  Skeleton,
  Stat,
  useToast,
} from '@ui';
import { BarChart, CHART_PALETTE, DonutChart, LineChart } from '@charts';
import { PendingProject } from '../../components/project-ops/common.tsx';

type RangeDays = 7 | 30 | 90;

const RANGE_OPTIONS: { value: RangeDays; label: string }[] = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
];

const CHANNEL_LABEL: Record<string, string> = {
  console: '控制台',
  api: '公开 API',
  playground: '演练场',
  sdk: 'SDK',
  system: '系统任务',
  import: '批量导入',
};

function channelLabel(label: string): string {
  return CHANNEL_LABEL[label] ?? label;
}

export function UsagePage() {
  const { project, loading: projectLoading, error: projectError, refresh: refreshProject } = useProjectContext();
  const { projectId: routeProjectId } = useParams<{ projectId: string }>();
  const projectId = project?.id ?? routeProjectId ?? '';
  const navigate = useNavigate();
  const toast = useToast();

  const [days, setDays] = useState<RangeDays>(30);

  const { data, loading, error, refresh } = useAsync(
    () => api.projects.usage(projectId, days),
    [projectId, days],
    Boolean(projectId),
  );

  const head = (
    <PageHead
      eyebrow="项目 · 观测"
      title="用量分析"
      desc="写入、检索、Token 注入与延迟的按日趋势；数据来自项目 API 调用与演练场。"
      actions={
        <Segmented
          options={RANGE_OPTIONS}
          value={days}
          onChange={(next) => setDays(next)}
        />
      }
    />
  );

  if (!projectId) {
    return (
      <div className="page">
        {head}
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

  if (loading && !data) {
    return (
      <div className="page">
        {head}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(178px, 1fr))' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Card key={i} pad>
              <Skeleton h={66} />
            </Card>
          ))}
        </div>
        <Card pad>
          <Skeleton h={250} />
        </Card>
        <Card pad>
          <Skeleton h={170} />
        </Card>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page">
        {head}
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        {head}
        <Card pad>
          <ErrorState message="用量数据暂不可用。" onRetry={() => void refresh()} />
        </Card>
      </div>
    );
  }

  const totals = data.totals;
  const points = data.points;
  const totalOps = totals.adds + totals.searches + totals.retrievals;
  const errorRatePct = totals.errorRate <= 1 ? totals.errorRate * 100 : totals.errorRate;
  const hasUsage =
    totalOps > 0 ||
    totals.tokens > 0 ||
    points.some((point) => point.adds > 0 || point.searches > 0 || point.retrievals > 0 || point.tokens > 0) ||
    data.byChannel.length > 0;

  const gotoPlayground = () => navigate(`/projects/${projectId}/playground`);
  const gotoDocs = () => navigate(`/projects/${projectId}/docs`);

  const downloadUsage = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mnemos-usage-${projectId}-${days}d.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success('用量数据已导出');
  };

  if (!hasUsage) {
    return (
      <div className="page">
        {head}
        <Card pad>
          <EmptyState
            icon="activity"
            title="所选范围内暂无用量"
            description="调用公开 API，或前往演练场执行一次记忆写入 / 检索。用量会在请求完成后出现在这里。"
            action={
              <div className="hstack gap-8 wrap">
                <Button variant="primary" icon="play" onClick={gotoPlayground}>
                  前往演练场
                </Button>
                <Button variant="outline" icon="book" onClick={gotoDocs}>
                  查看 API 文档
                </Button>
              </div>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      {head}

      {error ? (
        <Callout tone="red" icon="alert">
          刷新用量失败，当前展示上一次成功获取的数据：{error}
        </Callout>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(178px, 1fr))' }}>
        <Stat
          label="写入次数"
          value={fmtCompact(totals.adds)}
          icon="plus"
          tone="violet"
          hint={`近 ${days} 天新增记忆`}
          spark={points.map((point) => point.adds)}
          sparkColor="var(--violet)"
        />
        <Stat
          label="检索次数"
          value={fmtCompact(totals.searches)}
          icon="search"
          tone="cyan"
          hint={`记忆注入 ${fmtCompact(totals.retrievals)} 次`}
          spark={points.map((point) => point.searches)}
          sparkColor="var(--cyan)"
        />
        <Stat
          label="记忆注入 Token"
          value={fmtCompact(totals.tokens)}
          unit="tokens"
          icon="database"
          tone="pink"
          hint="检索结果注入上下文的 Token 总量"
        />
        <Stat
          label="错误率"
          value={fmtPct(errorRatePct, 2)}
          icon="alert"
          tone={errorRatePct > 1 ? 'red' : 'green'}
          hint={`${fmtInt(totals.errors)} 次错误请求`}
        />
        <Stat
          label="P95 延迟"
          value={fmtMs(data.latency.p95)}
          icon="clock"
          tone="amber"
          hint={`P50 ${fmtMs(data.latency.p50)}`}
        />
      </div>

      <Card className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">每日写入与检索</div>
            <div className="chart-sub">近 {days} 天 · 按自然日聚合</div>
          </div>
          <div className="legend">
            <span className="legend-item">
              <span className="legend-dot" style={{ background: 'var(--chart-1)' }} />
              写入
            </span>
            <span className="legend-item">
              <span className="legend-dot" style={{ background: 'var(--chart-2)' }} />
              检索
            </span>
          </div>
        </div>
        {points.length ? (
          <LineChart
            points={points.map((point) => ({ label: fmtDay(point.date), values: [point.adds, point.searches] }))}
            series={[
              { name: '写入', color: 'var(--chart-1)' },
              { name: '检索', color: 'var(--chart-2)' },
            ]}
            height={250}
            valueFormat={(value) => fmtCompact(value)}
          />
        ) : (
          <EmptyState compact icon="activity" title="暂无按日数据" description="该范围内还没有可聚合的请求记录。" />
        )}
      </Card>

      <div className="grid grid-2">
        <Card pad>
          <SectionHead title="按操作" desc="不同 API 操作的调用次数" />
          <div className="mt-16">
            {data.byOperation.length ? (
              <BarChart
                data={data.byOperation.map((row) => ({ label: actionLabel(row.label), value: row.count }))}
                horizontal
                color="var(--chart-1)"
                valueFormat={(value) => fmtCompact(value)}
              />
            ) : (
              <EmptyState compact icon="activity" title="暂无操作数据" description="发起一次写入或检索后即可看到分布。" />
            )}
          </div>
        </Card>

        <Card pad>
          <SectionHead title="按通道" desc="请求来源的渠道分布" />
          <div className="mt-16">
            {data.byChannel.length ? (
              <BarChart
                data={data.byChannel.map((row) => ({ label: channelLabel(row.label), value: row.count }))}
                horizontal
                color="var(--chart-2)"
                valueFormat={(value) => fmtCompact(value)}
              />
            ) : (
              <EmptyState compact icon="layers" title="暂无通道数据" description="控制台、API 与演练场的请求会分别统计。" />
            )}
          </div>
        </Card>
      </div>

      <Card pad>
        <SectionHead
          title="按密钥"
          desc="API 密钥维度的调用量，用于识别异常或过期客户端"
          actions={
            <Button size="sm" variant="ghost" icon="download" onClick={downloadUsage}>
              导出 JSON
            </Button>
          }
        />
        <div className="mt-16">
          {data.byKey.length ? (
            <BarChart
              data={data.byKey.map((row) => ({ label: row.label || '未命名密钥', value: row.count }))}
              horizontal
              color="var(--chart-3)"
              valueFormat={(value) => fmtCompact(value)}
            />
          ) : (
            <EmptyState
              compact
              icon="key"
              title="未使用 API Key"
              description="当前请求来自控制台会话或未识别客户端；创建密钥并接入服务端后，此处会按密钥拆分。"
              action={
                <Button size="sm" variant="outline" icon="key" onClick={() => navigate(`/projects/${projectId}/keys`)}>
                  管理密钥
                </Button>
              }
            />
          )}
        </div>
      </Card>

      <div className="grid grid-2">
        <Card pad>
          <SectionHead title="延迟分位" desc="检索接口从收到请求到返回结果的耗时" />
          <div className="grid grid-3 mt-16">
            <div className="metric">
              <span className="metric-label">P50</span>
              <span className="metric-value" style={{ fontSize: 22 }}>
                {fmtMs(data.latency.p50)}
              </span>
            </div>
            <div className="metric">
              <span className="metric-label">P95</span>
              <span className="metric-value" style={{ fontSize: 22 }}>
                {fmtMs(data.latency.p95)}
              </span>
            </div>
            <div className="metric">
              <span className="metric-label">P99</span>
              <span className="metric-value" style={{ fontSize: 22 }}>
                {fmtMs(data.latency.p99)}
              </span>
            </div>
          </div>
          <div className="mt-16">
            <Callout tone="violet" icon="info">
              P95 表示 95% 的检索请求在该耗时内完成；P99 反映长尾请求。若 P99 明显高于 P50，通常意味着图谱遍历或大结果集排序偏慢。
            </Callout>
          </div>
        </Card>

        <Card pad>
          <SectionHead title="通道占比" desc="按请求来源查看调用结构" />
          <div className="mt-16">
            {data.byChannel.length ? (
              <DonutChart
                data={data.byChannel.map((row, index) => ({
                  label: channelLabel(row.label),
                  value: row.count,
                  color: CHART_PALETTE[index % CHART_PALETTE.length],
                }))}
                centerValue={fmtCompact(totalOps)}
                centerLabel="操作次数"
                valueFormat={(value) => fmtCompact(value)}
              />
            ) : (
              <EmptyState compact icon="gauge" title="暂无通道占比" description="至少产生一次请求后才会显示构成。" />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
