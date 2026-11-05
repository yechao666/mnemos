import { useNavigate } from 'react-router-dom';
import {
  Avatar,
  Button,
  Callout,
  Card,
  Icon,
  SectionHead,
  Skeleton,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { clickableRowStyle } from '../shared.tsx';
import { agentAvatarName, agentTone, isTaskRunning, TaskStatusBadge } from './shared.tsx';

const MAX_ROWS = 4;

/** 概览页精简卡：活跃 Agent 与进行中的任务，帮助人类快速定位当前工作。 */
export function AgentActivityCard({ projectId }: { projectId: string }) {
  const navigate = useNavigate();

  const agentsAsync = useAsync(() => api.agents.list(projectId), [projectId], Boolean(projectId));
  const tasksAsync = useAsync(
    () => api.tasks.list(projectId, { limit: 50 }),
    [projectId],
    Boolean(projectId),
  );

  const agents = agentsAsync.data ?? [];
  const tasks = tasksAsync.data ?? [];

  const activeAgents = [...agents]
    .filter((agent) => agent.status === 'active')
    .sort(
      (left, right) =>
        new Date(right.lastActiveAt ?? right.createdAt).getTime() -
        new Date(left.lastActiveAt ?? left.createdAt).getTime(),
    )
    .slice(0, MAX_ROWS);

  const runningTasks = [...tasks]
    .filter((task) => isTaskRunning(task.status))
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    .slice(0, MAX_ROWS);

  const unavailable =
    Boolean(agentsAsync.error && !agentsAsync.data) && Boolean(tasksAsync.error && !tasksAsync.data);

  const retry = () => {
    void agentsAsync.refresh();
    void tasksAsync.refresh();
  };

  return (
    <Card pad>
      <SectionHead
        title="Agent 活动"
        desc="谁在写记忆、正在推进哪些任务"
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              iconRight="arrowRight"
              onClick={() => navigate(`/projects/${projectId}/agents`)}
            >
              注册表
            </Button>
            <Button
              size="sm"
              variant="ghost"
              iconRight="arrowRight"
              onClick={() => navigate(`/projects/${projectId}/tasks`)}
            >
              任务会话
            </Button>
          </>
        }
      />

      {unavailable ? (
        <div className="mt-12">
          <Callout tone="amber" icon="info">
            <div className="vstack gap-8">
              <div>Agent 原生接口尚未就绪，注册表与任务数据将在后端上线后自动显示。</div>
              <div>
                <Button size="sm" variant="outline" icon="refresh" onClick={retry}>
                  重试
                </Button>
              </div>
            </div>
          </Callout>
        </div>
      ) : (
        <div className="grid grid-2 mt-12">
          <div className="vstack gap-8">
            <div className="tiny dim">活跃 Agent</div>

            {agentsAsync.loading && !agentsAsync.data ? (
              <div className="vstack gap-8">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} h={30} />
                ))}
              </div>
            ) : agentsAsync.error && !agentsAsync.data ? (
              <div className="tiny dim hstack gap-8">
                Agent 数据暂不可用。
                <Button size="sm" variant="ghost" icon="refresh" onClick={retry}>
                  重试
                </Button>
              </div>
            ) : activeAgents.length ? (
              activeAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  style={clickableRowStyle}
                  title={`查看 ${agent.name}`}
                  onClick={() => navigate(`/projects/${projectId}/agents`)}
                >
                  <div className="between gap-10">
                    <span className="hstack gap-8" style={{ minWidth: 0 }}>
                      <Avatar name={agentAvatarName(agent.name)} tone={agentTone(agent)} size="sm" />
                      <span className="vstack" style={{ minWidth: 0 }}>
                        <span className="small strong truncate">{agent.name}</span>
                        <span className="tiny dim truncate" title={agent.model}>
                          {agent.model || agent.role || '未指定模型'}
                        </span>
                      </span>
                    </span>
                    <span className="tiny dim nowrap">
                      {fmtInt(agent.stats?.memories ?? 0)} 记忆
                      {agent.lastActiveAt ? ` · ${fmtRelative(agent.lastActiveAt)}` : ''}
                    </span>
                  </div>
                </button>
              ))
            ) : (
              <div className="tiny dim">暂无活跃 Agent。</div>
            )}
          </div>

          <div className="vstack gap-8">
            <div className="tiny dim">进行中任务</div>

            {tasksAsync.loading && !tasksAsync.data ? (
              <div className="vstack gap-8">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} h={30} />
                ))}
              </div>
            ) : tasksAsync.error && !tasksAsync.data ? (
              <div className="tiny dim hstack gap-8">
                任务数据暂不可用。
                <Button size="sm" variant="ghost" icon="refresh" onClick={retry}>
                  重试
                </Button>
              </div>
            ) : runningTasks.length ? (
              runningTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  style={clickableRowStyle}
                  title={`查看任务：${task.title}`}
                  onClick={() => navigate(`/projects/${projectId}/tasks`)}
                >
                  <div className="between gap-10">
                    <span className="vstack" style={{ minWidth: 0 }}>
                      <span className="small strong truncate">{task.title}</span>
                      <span className="tiny dim truncate">
                        {task.ownerAgentName ?? task.ownerAgentId ?? '未指定 owner'}
                      </span>
                    </span>
                    <TaskStatusBadge status={task.status} />
                  </div>
                  <div className="tiny dim mt-4 hstack gap-6">
                    <Icon name="brain" size={10} />
                    {fmtInt(task.memoryCount)} 条记忆
                    <span>·</span>
                    {fmtRelative(task.startedAt)}开始
                  </div>
                </button>
              ))
            ) : (
              <div className="tiny dim">暂无进行中任务。</div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
