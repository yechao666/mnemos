import { useNavigate, useParams } from 'react-router-dom';
import type { MemoryCategory } from '@shared';
import { CATEGORY_LABEL } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Card,
  CodeBlock,
  EmptyState,
  ErrorState,
  Icon,
  LoadingBlock,
  PageHead,
  SectionHead,
  Skeleton,
  Stat,
} from '@ui';
import { DonutChart, LineChart } from '@charts';
import { useAsync } from '@lib/hooks.ts';
import { api } from '@lib/api.ts';
import {
  fmtBytes,
  fmtDay,
  fmtFullDateTime,
  fmtInt,
  fmtMs,
  fmtRelative,
} from '@lib/format.ts';
import { actionLabel, toneForAction, toneForCategory } from '@lib/tone.ts';
import { useProjectContext } from '@lib/project-context.tsx';
import {
  clickableRowStyle,
  fmtRate,
  iconForAction,
  projectTone,
} from '../../components/project/shared.tsx';
import { AgentActivityCard } from '../../components/project/agent/AgentActivityCard.tsx';

function categoryLabel(name: string): string {
  return CATEGORY_LABEL[name as MemoryCategory] ?? name;
}

function categoryColor(name: string): string {
  return `var(--${toneForCategory(name)})`;
}

/** 项目概览：KPI、健康检查、用量趋势、分类构成与最近动态。 */
export function ProjectOverviewPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { project } = useProjectContext();
  const { data, loading, error, refresh } = useAsync(
    () => api.projects.overview(projectId),
    [projectId],
    Boolean(projectId),
  );

  if (loading && !data) {
    return (
      <div className="page">
        <PageHead
          eyebrow="概览"
          title="项目概览"
          desc="项目运行状态、用量趋势与最近动态。"
        />
        <div className="grid grid-4">
          {[0, 1, 2, 3].map((index) => (
            <Card key={index} pad>
              <Skeleton w={76} h={10} />
              <div className="mt-12">
                <Skeleton w={128} h={26} />
              </div>
              <div className="mt-12">
                <Skeleton w={140} h={10} />
              </div>
            </Card>
          ))}
        </div>
        <Card pad>
          <LoadingBlock label="正在加载项目概览…" />
        </Card>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page">
        <PageHead eyebrow="概览" title="项目概览" desc="项目运行状态、用量趋势与最近动态。" />
        <Card pad>
          <ErrorState message={error} onRetry={() => void refresh()} />
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <PageHead eyebrow="概览" title="项目概览" desc="项目运行状态、用量趋势与最近动态。" />
        <Card pad>
          <LoadingBlock label="正在加载项目概览…" />
        </Card>
      </div>
    );
  }

  const { stats, health, topEntities, categories, recentMemories, recentActivity } = data;
  const usagePoints = data.usage.slice(-14);
  const healthy = health.status === 'healthy';
  const addCurl = buildAddCurl(projectId);
  const searchCurl = buildSearchCurl(projectId);
  const tone = projectTone(project?.name ?? projectId);

  return (
    <div className="page">
      <PageHead
        eyebrow="概览"
        title="项目概览"
        desc="项目运行状态、用量趋势与最近动态。"
        actions={
          <>
            <Button icon="play" onClick={() => navigate(`/projects/${projectId}/playground`)}>
              前往演练场
            </Button>
            <Button variant="ghost" icon="refresh" onClick={() => void refresh()}>
              刷新
            </Button>
          </>
        }
      />

      {stats.memories === 0 ? (
        <Callout tone="violet" icon="sparkles">
          这个项目还没有记忆。可以前往「演练场」写入第一条记忆，或使用下方 curl 示例通过 API 接入。
        </Callout>
      ) : null}

      <div className="grid grid-4">
        <Stat
          label="记忆总量"
          value={fmtInt(stats.memories)}
          icon="brain"
          tone={tone}
          delta={stats.growthPct}
          hint={`近 7 日写入调用 ${fmtInt(stats.adds7d)} 次`}
          spark={usagePoints.length > 1 ? usagePoints.map((point) => point.adds) : undefined}
        />
        <Stat
          label="用户 / Agent"
          value={`${fmtInt(stats.users)} / ${fmtInt(stats.agents)}`}
          icon="users"
          tone="cyan"
          hint={`近 7 日检索 ${fmtInt(stats.searches7d)} 次`}
        />
        <Stat
          label="图谱实体 / 关系"
          value={`${fmtInt(stats.entities)} / ${fmtInt(stats.relations)}`}
          icon="graph"
          tone="pink"
          hint={`存储占用 ${fmtBytes(stats.storageBytes)}`}
        />
        <Stat
          label="召回 P50"
          value={fmtMs(stats.recallP50Ms)}
          icon="gauge"
          tone="green"
          hint={`P95 ${fmtMs(stats.recallP95Ms)} · 命中率 ${fmtRate(stats.hitRate)}`}
        />
      </div>

      <AgentActivityCard projectId={projectId} />

      <div className="grid grid-2">
        <Card pad>
          <SectionHead
            title="健康检查"
            desc="核心依赖的实时探测结果"
            actions={
              <span className={`health-chip tone-${healthy ? 'green' : 'amber'}`}>
                <Icon name={healthy ? 'checkCircle' : 'alert'} size={12} />
                {healthy ? '运行正常' : '部分降级'}
              </span>
            }
          />
          <div className="vstack gap-10 mt-12">
            {health.checks.length ? (
              health.checks.map((check) => (
                <div key={check.name} className="between gap-12">
                  <div className="hstack gap-8" style={{ minWidth: 0 }}>
                    <span
                      className="dot"
                      style={{
                        width: 7,
                        height: 7,
                        background: check.ok ? 'var(--green)' : 'var(--red)',
                        boxShadow: `0 0 10px ${check.ok ? 'var(--green)' : 'var(--red)'}`,
                      }}
                    />
                    <span className="small">{check.name}</span>
                  </div>
                  <span className="tiny dim truncate" style={{ maxWidth: 220 }} title={check.detail}>
                    {check.detail}
                  </span>
                </div>
              ))
            ) : (
              <div className="tiny dim">暂无检查项。</div>
            )}
          </div>
        </Card>

        <Card pad>
          <SectionHead
            title="高频实体"
            desc="图谱中权重最高的实体"
            actions={
              <Button
                size="sm"
                variant="ghost"
                iconRight="arrowRight"
                onClick={() => navigate(`/projects/${projectId}/graph`)}
              >
                查看图谱
              </Button>
            }
          />
          {topEntities.length ? (
            <div className="chip-row mt-12">
              {topEntities.map((entity) => (
                <button
                  key={entity.id}
                  type="button"
                  className="chip chip-clickable"
                  title={`${entity.name} · ${entity.type}`}
                  onClick={() =>
                    navigate(`/projects/${projectId}/graph?entity=${encodeURIComponent(entity.name)}`)
                  }
                >
                  <span
                    className="dot"
                    style={{ width: 5, height: 5, background: 'var(--pink)', boxShadow: 'none' }}
                  />
                  <span className="truncate" style={{ maxWidth: 120 }}>
                    {entity.name}
                  </span>
                  <span className="tiny dim mono">{fmtInt(entity.mentionCount)}</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              icon="graph"
              title="暂无实体数据"
              description="写入记忆并启用图谱后，系统会自动抽取实体与关系。"
            />
          )}
        </Card>
      </div>

      <div className="grid grid-3">
        <Card pad className="span-2">
          <SectionHead
            title="近 14 天用量"
            desc="每日写入与检索次数"
            actions={
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
            }
          />
          {usagePoints.length ? (
            <div className="mt-12">
              <LineChart
                points={usagePoints.map((point) => ({
                  label: fmtDay(point.date),
                  values: [point.adds, point.searches],
                }))}
                series={[
                  { name: '写入', color: 'var(--chart-1)' },
                  { name: '检索', color: 'var(--chart-2)' },
                ]}
                height={236}
              />
            </div>
          ) : (
            <EmptyState
              compact
              icon="activity"
              title="暂无用量数据"
              description="项目产生写入或检索后，这里会展示 14 天趋势。"
            />
          )}
        </Card>

        <Card pad>
          <SectionHead title="分类构成" desc="按记忆分类统计" />
          {categories.length ? (
            <div className="mt-12">
              <DonutChart
                data={categories.map((category) => ({
                  label: categoryLabel(category.name),
                  value: category.count,
                  color: categoryColor(category.name),
                }))}
                centerValue={fmtInt(stats.memories)}
                centerLabel="记忆总量"
              />
            </div>
          ) : (
            <EmptyState
              compact
              icon="layers"
              title="暂无分类数据"
              description="写入记忆后，系统会自动完成分类。"
            />
          )}
        </Card>
      </div>

      <div className="grid grid-3">
        <Card pad className="span-2">
          <SectionHead
            title="最近记忆"
            desc="最新写入或更新的记忆"
            actions={
              <Button
                size="sm"
                variant="ghost"
                iconRight="arrowRight"
                onClick={() => navigate(`/projects/${projectId}/memories`)}
              >
                浏览全部
              </Button>
            }
          />
          {recentMemories.length ? (
            <div className="vstack mt-8">
              {recentMemories.map((memory, index) => (
                <div key={memory.id}>
                  {index > 0 ? <div className="divider" /> : null}
                  <button
                    type="button"
                    style={clickableRowStyle}
                    onClick={() => navigate(`/projects/${projectId}/memories`)}
                  >
                    <div className="between gap-12" style={{ alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="mem-content clamp-2">{memory.content}</div>
                        <div className="chip-row mt-6">
                          <Badge tone={toneForCategory(memory.category)} size="sm">
                            {CATEGORY_LABEL[memory.category]}
                          </Badge>
                          {memory.tags.slice(0, 2).map((tag) => (
                            <span key={tag} className="tag">
                              {tag}
                            </span>
                          ))}
                          <span className="tiny dim" title={fmtFullDateTime(memory.updatedAt)}>
                            {fmtRelative(memory.updatedAt)}
                          </span>
                        </div>
                      </div>
                      <span className="score-bar tone-violet">
                        <span className="score-track">
                          <span
                            className="score-fill"
                            style={{ width: `${Math.max(0, Math.min(100, memory.importance * 100))}%` }}
                          />
                        </span>
                        <span>{memory.importance.toFixed(2)}</span>
                      </span>
                    </div>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              icon="brain"
              title="暂无记忆"
              description="通过 API 或演练场写入第一条记忆，这里会展示最近内容。"
            />
          )}
        </Card>

        <Card pad>
          <SectionHead
            title="最近活动"
            desc="项目审计日志"
            actions={
              <Button
                size="sm"
                variant="ghost"
                iconRight="arrowRight"
                onClick={() => navigate(`/projects/${projectId}/audit`)}
              >
                审计日志
              </Button>
            }
          />
          {recentActivity.length ? (
            <div className="timeline mt-12">
              {recentActivity.map((entry) => (
                <div key={entry.id} className="tl-item">
                  <span className={`tl-dot tone-${toneForAction(entry.action, entry.actorType)}`}>
                    <Icon name={iconForAction(entry.action)} size={11} />
                  </span>
                  <div className="tl-body">
                    <div className="tl-title">
                      <strong>{entry.actorLabel}</strong> {actionLabel(entry.action)}
                    </div>
                    <div className="tl-time" title={fmtFullDateTime(entry.createdAt)}>
                      {fmtRelative(entry.createdAt)}
                      {entry.resourceType ? ` · ${entry.resourceType}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              icon="activity"
              title="暂无活动"
              description="密钥、记忆与设置的变更都会记录在这里。"
            />
          )}
        </Card>
      </div>

      <Card pad>
        <SectionHead
          title="快速接入"
          desc="使用项目 API Key 调用公开 v1 接口"
          actions={
            <Button
              size="sm"
              icon="key"
              onClick={() => navigate(`/projects/${projectId}/keys`)}
            >
              管理密钥
            </Button>
          }
        />
        <div className="mt-12">
          <Callout tone="violet" icon="info">
            请先在「密钥」页创建 API Key，并以{' '}
            <span className="code-inline">Authorization: Bearer $MNEMOS_API_KEY</span>{' '}
            请求头携带；下方示例中的 <span className="code-inline">project_id</span> 已填入当前项目。
          </Callout>
        </div>
        <div className="grid grid-2 mt-16">
          <CodeBlock title="写入记忆 · POST /v1/memories" language="bash" code={addCurl} />
          <CodeBlock title="检索记忆 · POST /v1/memories/search" language="bash" code={searchCurl} />
        </div>
      </Card>
    </div>
  );
}

function buildAddCurl(projectId: string): string {
  return `curl -X POST "$MNEMOS_BASE_URL/v1/memories" \\
  -H "Authorization: Bearer $MNEMOS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "project_id": "${projectId}",
    "messages": [
      { "role": "user", "content": "我偏好靠窗的座位" }
    ],
    "user_id": "u_1001"
  }'`;
}

function buildSearchCurl(projectId: string): string {
  return `curl -X POST "$MNEMOS_BASE_URL/v1/memories/search" \\
  -H "Authorization: Bearer $MNEMOS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "project_id": "${projectId}",
    "query": "用户偏好什么座位",
    "user_id": "u_1001",
    "top_k": 5
  }'`;
}
