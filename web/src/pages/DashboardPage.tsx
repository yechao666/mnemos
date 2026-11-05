import { Link, useNavigate } from 'react-router-dom';
import type { MemoryCategory, UsagePoint } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  LoadingBlock,
  PageHead,
  Progress,
  Skeleton,
  Stat,
  type IconName,
} from '@ui';
import { LineChart, DonutChart } from '@charts';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { useAuth } from '@lib/auth.tsx';
import { fmtCompact, fmtDateTime, fmtDay, fmtInt, fmtPct, fmtRelative } from '@lib/format.ts';
import { actionLabel, ROLE_LABEL, toneForAction, toneForCategory, toneForEventType } from '@lib/tone.ts';
import { CATEGORY_LABEL } from '@shared';
import { liveEventLabel, useLiveEvents } from '../components/shell/useLiveEvents.ts';
import { projectTone } from '../components/shell/util.ts';

const ACTION_ICONS: { prefix: string; icon: IconName }[] = [
  { prefix: 'memory.create', icon: 'brain' },
  { prefix: 'memory.update', icon: 'pencil' },
  { prefix: 'memory.delete', icon: 'trash' },
  { prefix: 'memory.bulk', icon: 'layers' },
  { prefix: 'memory.search', icon: 'search' },
  { prefix: 'memory.read', icon: 'eye' },
  { prefix: 'memory.feedback', icon: 'star' },
  { prefix: 'key.', icon: 'key' },
  { prefix: 'member.', icon: 'users' },
  { prefix: 'auth.', icon: 'user' },
  { prefix: 'settings.', icon: 'settings' },
  { prefix: 'project.', icon: 'folder' },
];

function iconForAction(action: string): IconName {
  return ACTION_ICONS.find((entry) => action.startsWith(entry.prefix))?.icon ?? 'activity';
}

function weekOverWeek(points: UsagePoint[], pick: (point: UsagePoint) => number): number | undefined {
  if (points.length < 14) return undefined;
  const recent = points.slice(-7);
  const previous = points.slice(-14, -7);
  const recentSum = recent.reduce((sum, point) => sum + pick(point), 0);
  const previousSum = previous.reduce((sum, point) => sum + pick(point), 0);
  if (previousSum <= 0) return undefined;
  return ((recentSum - previousSum) / previousSum) * 100;
}

function asPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return value <= 1 ? value * 100 : value;
}

function categoryLabel(name: string): string {
  return CATEGORY_LABEL[name as MemoryCategory] ?? name;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { user, org } = useAuth();
  const events = useLiveEvents();
  const { data, loading, error, refresh } = useAsync(() => api.dashboard(), []);

  const orgName = org?.name ?? data?.org.name ?? '当前组织';
  const roleLabel = user ? ROLE_LABEL[user.role] : '成员';
  const head = (
    <PageHead
      eyebrow="组织概览"
      title="概览"
      desc={`${orgName} · ${roleLabel}`}
      actions={
        <>
          <Button icon="refresh" loading={loading} onClick={() => void refresh()}>
            刷新
          </Button>
          <Button variant="primary" icon="plus" onClick={() => navigate('/projects')}>
            新建项目
          </Button>
        </>
      }
    />
  );

  if (!data) {
    return (
      <div className="page">
        {head}
        {loading ? (
          <>
            <div className="kpi-grid">
              {[0, 1, 2, 3].map((index) => (
                <div className="kpi" key={index}>
                  <Skeleton w="42%" h={11} />
                  <div style={{ height: 12 }} />
                  <Skeleton w="64%" h={26} />
                  <div style={{ height: 10 }} />
                  <Skeleton w="80%" h={10} />
                </div>
              ))}
            </div>
            <Card pad>
              <LoadingBlock label="正在汇总组织记忆指标…" />
            </Card>
          </>
        ) : (
          <Card pad>
            <ErrorState message={error ?? '暂未获取到组织概览数据。'} onRetry={() => void refresh()} />
          </Card>
        )}
      </div>
    );
  }

  if (data.projects.length === 0) {
    return (
      <div className="page">
        {head}
        <Card pad>
          <EmptyState
            icon="folder"
            title="还没有项目，先创建第一个"
            description="Mnemos 的记忆、检索与审计都以项目为隔离单元。创建项目后，概览会展示组织级的记忆增长、检索延迟与分类构成。"
            action={
              <Button variant="primary" icon="plus" onClick={() => navigate('/projects')}>
                新建项目
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const usage = data.usage;
  const linePoints = usage.slice(-30).map((point) => ({
    label: fmtDay(point.date),
    values: [point.adds, point.searches],
  }));
  const addSpark = usage.slice(-14).map((point) => point.adds);
  const searchSpark = usage.slice(-14).map((point) => point.searches);
  const writesDelta = weekOverWeek(usage, (point) => point.adds);
  const searchesDelta = weekOverWeek(usage, (point) => point.searches);
  const activeProjects = data.projects.filter((project) => project.status === 'active').length;
  const topMemoryCount = data.topProjects.reduce((max, project) => Math.max(max, project.memories), 0);
  const categoryTotal = data.categoryMix.reduce((sum, item) => sum + item.count, 0);
  const errorPct = asPercent(data.totals.errorRate);

  return (
    <div className="page">
      {head}

      {error ? (
        <Callout tone="amber" icon="alert">刷新失败，当前展示上次加载的组织数据。</Callout>
      ) : null}

      <div className="kpi-grid">
        <Stat
          label="记忆总量"
          value={fmtCompact(data.totals.memories)}
          unit="条"
          icon="database"
          tone="violet"
          delta={writesDelta}
          hint={`近 7 日写入调用 ${fmtInt(data.totals.adds7d)} 次`}
          spark={addSpark}
          sparkColor="var(--chart-1)"
        />
        <Stat
          label="活跃项目"
          value={fmtInt(activeProjects)}
          unit="个"
          icon="folder"
          tone="cyan"
          hint={`共 ${fmtInt(data.totals.projects)} 个项目 · ${activeProjects} 个运行中`}
        />
        <Stat
          label="近 7 日检索"
          value={fmtCompact(data.totals.searches7d)}
          unit="次"
          icon="search"
          tone="amber"
          delta={searchesDelta}
          spark={searchSpark}
          sparkColor="var(--chart-2)"
        />
        <Stat
          label="召回 P50"
          value={Math.round(data.totals.p50)}
          unit="ms"
          icon="gauge"
          tone="green"
          hint="端到端（检索与重排）"
        />
      </div>

      <div className="split">
        <div className="vstack gap-16">
          <Card>
            <div className="card-head">
              <div>
                <div className="card-title">近 30 天写入与检索</div>
                <div className="card-sub">按自然日汇总的记忆写入量与检索请求量</div>
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
            <div className="card-body">
              {linePoints.length === 0 ? (
                <EmptyState compact icon="activity" title="暂无用量序列" description="服务端尚未回传近 30 天的用量数据。" />
              ) : (
                <LineChart
                  points={linePoints}
                  series={[
                    { name: '写入', color: 'var(--chart-1)' },
                    { name: '检索', color: 'var(--chart-2)' },
                  ]}
                  height={228}
                  valueFormat={(value) => fmtCompact(value)}
                />
              )}
            </div>
          </Card>

          <Card>
            <div className="card-head">
              <div>
                <div className="card-title">项目记忆排行</div>
                <div className="card-sub">按记忆总量排序，进度为占组织记忆的比例</div>
              </div>
              <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => navigate('/projects')}>
                全部项目
              </Button>
            </div>
            <div className="card-body">
              {data.topProjects.length === 0 ? (
                <EmptyState compact icon="folder" title="暂无项目数据" description="项目尚未产生记忆。" />
              ) : (
                <div className="vstack gap-12">
                  {data.topProjects.slice(0, 6).map((project) => {
                    const share = topMemoryCount > 0 ? (project.memories / topMemoryCount) * 100 : 0;
                    const totalShare =
                      data.totals.memories > 0 ? (project.memories / data.totals.memories) * 100 : 0;
                    return (
                      <Link
                        key={project.id}
                        to={`/projects/${project.id}`}
                        className="vstack"
                        style={{ gap: 6, textAlign: 'left', width: '100%' }}
                      >
                        <span className="between" style={{ gap: 10 }}>
                          <span className="hstack gap-8" style={{ minWidth: 0 }}>
                            <span className={`dot tone-${projectTone(project.id)}`} aria-hidden="true" />
                            <span className="truncate strong" style={{ fontSize: 12.5 }}>{project.name}</span>
                            <span className="tiny dim truncate">{project.slug}</span>
                          </span>
                          <span className="mono tiny nowrap" style={{ color: 'var(--text-muted)' }}>
                            {fmtInt(project.memories)} 条 · {fmtPct(totalShare, 1)}
                          </span>
                        </span>
                        <Progress value={Math.max(1, share)} thin tone={projectTone(project.id)} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="vstack gap-16">
          <Card>
            <div className="card-head">
              <div>
                <div className="card-title">记忆分类构成</div>
                <div className="card-sub">按抽取分类统计的记忆占比</div>
              </div>
            </div>
            <div className="card-body">
              {data.categoryMix.length === 0 ? (
                <EmptyState compact icon="tag" title="暂无分类数据" description="写入记忆后这里会展示分类构成。" />
              ) : (
                <DonutChart
                  data={data.categoryMix.map((item) => ({
                    label: categoryLabel(item.name),
                    value: item.count,
                    color: `var(--${toneForCategory(item.name)})`,
                  }))}
                  size={150}
                  thickness={14}
                  centerValue={fmtCompact(categoryTotal)}
                  centerLabel="已分类记忆"
                  valueFormat={(value) => fmtInt(value)}
                />
              )}
            </div>
          </Card>

          <Card>
            <div className="card-head">
              <div>
                <div className="card-title">最近活动</div>
                <div className="card-sub">组织内最新 12 条审计记录</div>
              </div>
            </div>
            <div className="card-body">
              {data.recentActivity.length === 0 ? (
                <EmptyState compact icon="activity" title="暂无活动" description="团队的操作会记录在审计日志中。" />
              ) : (
                <div className="timeline">
                  {data.recentActivity.slice(0, 12).map((log) => (
                    <div className="tl-item" key={log.id}>
                      <span className={`tl-dot tone-${toneForAction(log.action, log.actorType)}`} aria-hidden="true">
                        <Icon name={iconForAction(log.action)} size={11} />
                      </span>
                      <div className="tl-body">
                        <div className="tl-title truncate">
                          <strong>{log.actorLabel}</strong> {actionLabel(log.action)}
                        </div>
                        <div className="tl-time" title={fmtDateTime(log.createdAt)}>
                          {fmtRelative(log.createdAt)}
                          {log.projectId ? <span className="dim"> · 项目内操作</span> : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card accent="cyan">
            <div className="card-head">
              <div>
                <div className="card-title">
                  <span className="dot tone-green dot-pulse" aria-hidden="true" />
                  实时事件流
                </div>
                <div className="card-sub">通过 SSE 推送的记忆与密钥事件</div>
              </div>
              <Badge tone="cyan" size="sm">{events.length > 0 ? '连接中' : '等待事件'}</Badge>
            </div>
            <div className="card-body">
              {events.length === 0 ? (
                <Callout tone="slate" icon="activity">
                  正在监听实时事件。当有人写入记忆、执行检索或创建密钥时，这里会即时出现。
                </Callout>
              ) : (
                <div className="vstack gap-12">
                  {events.slice(0, 6).map((event) => (
                    <div key={event.id} className="vstack" style={{ gap: 3 }}>
                      <div className="hstack gap-6">
                        <Badge tone={toneForEventType(event.type)} size="sm" dot>
                          {liveEventLabel(event.type)}
                        </Badge>
                        <span className="tiny dim truncate">{event.actor}</span>
                        <span className="tiny dim ml-auto nowrap" title={fmtDateTime(event.at)}>
                          {fmtRelative(event.at)}
                        </span>
                      </div>
                      <div className="small truncate" style={{ color: 'var(--text-soft)' }} title={event.summary}>
                        {event.summary}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <Card>
        <div className="card-head">
          <div>
            <div className="card-title">运营补充指标</div>
            <div className="card-sub">基于组织近 30 天观测数据</div>
          </div>
        </div>
        <div className="card-body">
          <div className="grid grid-4">
            <div className="metric">
              <span className="metric-label">请求错误率</span>
              <span className="metric-value">{fmtPct(errorPct, 2)}</span>
            </div>
            <div className="metric">
              <span className="metric-label">记忆注入 Token</span>
              <span className="metric-value">{fmtCompact(data.totals.tokensSaved)} tokens</span>
            </div>
            <div className="metric">
              <span className="metric-label">日均写入</span>
              <span className="metric-value">{fmtCompact(data.totals.adds7d / 7)} 次 / 天</span>
            </div>
            <div className="metric">
              <span className="metric-label">成员与智能体</span>
              <span className="metric-value">{fmtInt(data.totals.users)} 人 · {fmtInt(data.totals.agents)} 个</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
