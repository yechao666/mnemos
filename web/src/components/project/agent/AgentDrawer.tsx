import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Agent } from '@shared';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Drawer,
  EmptyState,
  SectionHead,
  Skeleton,
} from '@ui';
import { api } from '@lib/api.ts';
import type { MemoryListParams } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { CATEGORY_LABEL } from '@shared';
import {
  fmtFullDateTime,
  fmtInt,
  fmtRelative,
} from '@lib/format.ts';
import { toneForCategory } from '@lib/tone.ts';
import { clickableRowStyle } from '../shared.tsx';
import {
  agentAvatarName,
  AgentStatusDot,
  agentTone,
  TaskStatusBadge,
  VisibilityBadge,
  visibilityOf,
} from './shared.tsx';
import { TaskDrawer } from './TaskDrawer.tsx';
import { BriefingPreview } from './BriefingPreview.tsx';

/** Agent 详情：身份、能力、记忆足迹、最近任务与简报入口。 */
export function AgentDrawer({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [taskId, setTaskId] = useState<string | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);

  const tasksAsync = useAsync(
    () => api.tasks.list(projectId, { agentId: agent?.id, limit: 5 }),
    [projectId, agent?.id],
    Boolean(projectId && agent),
  );

  const memoriesAsync = useAsync(
    () => {
      const params: MemoryListParams = {
        writtenByAgentId: agent?.id,
        includePrivate: true,
        pageSize: 5,
        sort: 'recent',
      };
      return api.memories.list(projectId, params);
    },
    [projectId, agent?.id],
    Boolean(projectId && agent),
  );

  useEffect(() => {
    setTaskId(null);
    setBriefingOpen(false);
  }, [agent?.id]);

  const tasks = [...(tasksAsync.data ?? [])]
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    .slice(0, 5);
  const memories = memoriesAsync.data?.items ?? [];
  const stats = agent?.stats ?? { memories: 0, privateMemories: 0, tasks: 0, lastTaskAt: undefined };

  return (
    <>
      <Drawer
        open={Boolean(agent)}
        onClose={onClose}
        wide
        title="Agent 详情"
        subtitle={agent ? <span className="mono tiny">{agent.id}</span> : undefined}
        footer={
          agent ? (
            <>
              <Button variant="primary" icon="sparkles" onClick={() => setBriefingOpen(true)}>
                生成简报
              </Button>
              <span className="ml-auto" />
              <Button variant="ghost" onClick={onClose}>
                关闭
              </Button>
            </>
          ) : undefined
        }
      >
        {agent ? (
          <div className="vstack gap-16">
            <div className="hstack gap-12" style={{ alignItems: 'flex-start' }}>
              <Avatar name={agentAvatarName(agent.name)} tone={agentTone(agent)} size="lg" square />
              <div className="grow">
                <div className="hstack gap-8 wrap">
                  <span className="strong" style={{ fontSize: 18 }}>
                    {agent.name}
                  </span>
                  {agent.role ? (
                    <Badge tone="cyan" size="sm">
                      {agent.role}
                    </Badge>
                  ) : null}
                  <AgentStatusDot status={agent.status} />
                </div>
                <div className="small dim mono mt-4" title={agent.model}>
                  {agent.model || '未指定模型'}
                </div>
                <div className="small muted mt-8">
                  {agent.description || '暂无描述，可在 Agent 注册信息中补充职责与能力边界。'}
                </div>
              </div>
            </div>

            <div className="metric-grid">
              <div className="metric">
                <span className="metric-label">记忆总数</span>
                <span className="metric-value">{fmtInt(stats.memories)}</span>
              </div>
              <div className="metric">
                <span className="metric-label">私有记忆</span>
                <span className="metric-value">{fmtInt(stats.privateMemories)}</span>
              </div>
              <div className="metric">
                <span className="metric-label">参与任务</span>
                <span className="metric-value">{fmtInt(stats.tasks)}</span>
              </div>
              <div className="metric">
                <span className="metric-label">最近任务</span>
                <span className="metric-value" title={stats.lastTaskAt ? fmtFullDateTime(stats.lastTaskAt) : undefined}>
                  {stats.lastTaskAt ? fmtRelative(stats.lastTaskAt) : '尚无任务'}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">最近活跃</span>
                <span className="metric-value" title={agent.lastActiveAt ? fmtFullDateTime(agent.lastActiveAt) : undefined}>
                  {agent.lastActiveAt ? fmtRelative(agent.lastActiveAt) : '尚无记录'}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">创建时间</span>
                <span className="metric-value">{fmtFullDateTime(agent.createdAt)}</span>
              </div>
            </div>

            <div className="vstack gap-8">
              <div className="section-title">能力</div>
              <div className="chip-row">
                {agent.capabilities?.length ? (
                  agent.capabilities.map((capability) => (
                    <span key={capability} className="tag">
                      {capability}
                    </span>
                  ))
                ) : (
                  <span className="tiny dim">未声明能力标签。</span>
                )}
              </div>
            </div>

            <div className="divider" />

            <div className="vstack gap-10">
              <SectionHead
                title="最近任务"
                desc="按开始时间倒序，最多 5 条"
                actions={
                  <Button
                    size="sm"
                    variant="ghost"
                    iconRight="arrowRight"
                    onClick={() => navigate(`/projects/${projectId}/tasks`)}
                  >
                    任务会话
                  </Button>
                }
              />

              {tasksAsync.loading && !tasksAsync.data ? (
                <div className="vstack gap-8">
                  {[0, 1, 2].map((index) => (
                    <Skeleton key={index} h={30} />
                  ))}
                </div>
              ) : null}

              {tasksAsync.error ? (
                <Callout tone="amber" icon="alert">
                  无法加载最近任务：{tasksAsync.error}
                </Callout>
              ) : null}

              {!tasksAsync.loading && !tasksAsync.error && tasks.length === 0 ? (
                <div className="tiny dim">该 Agent 还没有任务记录。</div>
              ) : null}

              {tasks.length ? (
                <div className="vstack">
                  {tasks.map((task, index) => (
                    <div key={task.id}>
                      {index > 0 ? <div className="divider" /> : null}
                      <button
                        type="button"
                        style={clickableRowStyle}
                        title={`查看任务：${task.title}`}
                        onClick={() => setTaskId(task.id)}
                      >
                        <div className="between gap-12">
                          <span className="small strong truncate">{task.title}</span>
                          <TaskStatusBadge status={task.status} />
                        </div>
                        <div className="tiny dim mt-4">
                          {fmtRelative(task.startedAt)} 开始 · {fmtInt(task.memoryCount)} 条记忆 · {fmtInt(task.agentCount)} 个 Agent
                        </div>
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="divider" />

            <div className="vstack gap-10">
              <SectionHead title="最近记忆" desc="该 Agent 最近写入的记忆，包含私有层" />

              {memoriesAsync.loading && !memoriesAsync.data ? (
                <div className="vstack gap-8">
                  {[0, 1, 2].map((index) => (
                    <Skeleton key={index} h={30} />
                  ))}
                </div>
              ) : null}

              {memoriesAsync.error ? (
                <Callout tone="amber" icon="alert">
                  无法加载最近记忆：{memoriesAsync.error}
                </Callout>
              ) : null}

              {!memoriesAsync.loading && !memoriesAsync.error && memories.length === 0 ? (
                <EmptyState
                  compact
                  icon="brain"
                  title="还没有记忆写入"
                  description="该 Agent 首次写入记忆后，会自动出现在注册表与这里。"
                />
              ) : null}

              {memories.length ? (
                <div className="vstack gap-10">
                  {memories.map((memory) => (
                    <div key={memory.id} className="vstack gap-4">
                      <div className="mem-content clamp-2">{memory.content}</div>
                      <div className="chip-row">
                        <Badge tone={toneForCategory(memory.category)} size="sm">
                          {CATEGORY_LABEL[memory.category]}
                        </Badge>
                        <VisibilityBadge visibility={visibilityOf(memory)} />
                        <span className="tiny dim" title={fmtFullDateTime(memory.createdAt)}>
                          {fmtRelative(memory.createdAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>

      <TaskDrawer
        taskId={taskId}
        onClose={() => setTaskId(null)}
        onFinished={() => {
          void tasksAsync.refresh();
          void memoriesAsync.refresh();
        }}
      />

      {agent ? (
        <BriefingPreview
          open={briefingOpen}
          onClose={() => setBriefingOpen(false)}
          projectId={projectId}
          agentId={agent.id}
        />
      ) : null}
    </>
  );
}
