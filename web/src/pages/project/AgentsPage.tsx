import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Task } from '@shared';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  PageHead,
  Skeleton,
  Stat,
  useToast,
} from '@ui';
import { useAsync } from '@lib/hooks.ts';
import { api } from '@lib/api.ts';
import { fmtInt } from '@lib/format.ts';
import { AgentCard } from '../../components/project/agent/AgentCard.tsx';
import { AgentCreateModal } from '../../components/project/agent/AgentCreateModal.tsx';
import { AgentDrawer } from '../../components/project/agent/AgentDrawer.tsx';
import { isNotFoundError } from '../../components/project/agent/shared.tsx';

/** Agent 注册表：观察项目内有哪些 Agent、各自的能力与记忆足迹。 */
export function AgentsPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const toast = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const agentsAsync = useAsync(() => api.agents.list(projectId), [projectId], Boolean(projectId));
  const tasksAsync = useAsync(
    () => api.tasks.list(projectId, { limit: 100 }),
    [projectId],
    Boolean(projectId),
  );

  const agents = agentsAsync.data ?? [];
  const tasks = tasksAsync.data ?? [];

  const latestTaskByAgent = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) {
      if (!task.ownerAgentId) continue;
      const current = map.get(task.ownerAgentId);
      if (!current || new Date(task.startedAt).getTime() > new Date(current.startedAt).getTime()) {
        map.set(task.ownerAgentId, task);
      }
    }
    return map;
  }, [tasks]);

  const activeCount = agents.filter((agent) => agent.status === 'active').length;
  const memoryCount = agents.reduce((sum, agent) => sum + (agent.stats?.memories ?? 0), 0);
  const privateMemoryCount = agents.reduce((sum, agent) => sum + (agent.stats?.privateMemories ?? 0), 0);

  const selectedAgent = detailId ? agents.find((agent) => agent.id === detailId) ?? null : null;
  const loading = agentsAsync.loading || tasksAsync.loading;

  const refreshAll = () => {
    void agentsAsync.refresh();
    void tasksAsync.refresh();
  };

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · Agent 原生"
        title="Agent 注册表"
        desc="项目内 Agent 的身份、能力与记忆足迹。"
        actions={
          <>
            <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
              新建 Agent
            </Button>
            <Button icon="refresh" loading={loading} onClick={refreshAll}>
              刷新
            </Button>
          </>
        }
      />

      {agentsAsync.loading && !agentsAsync.data ? (
        <>
          <div className="grid grid-4">
            {[0, 1, 2, 3].map((index) => (
              <Card key={index} pad>
                <Skeleton h={66} />
              </Card>
            ))}
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {[0, 1, 2].map((index) => (
              <Card key={index} pad>
                <div className="vstack gap-12">
                  <Skeleton w={180} h={42} />
                  <Skeleton h={12} />
                  <Skeleton w="80%" h={12} />
                  <Skeleton h={44} />
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : null}

      {!agentsAsync.loading && agentsAsync.error && !agentsAsync.data ? (
        <Card pad>
          <div className="vstack gap-10">
            <ErrorState message={agentsAsync.error} onRetry={() => void agentsAsync.refresh()} />
            {isNotFoundError(agentsAsync.error) ? (
              <Callout tone="amber" icon="info">
                Agent 注册表接口尚未就绪时会返回 404；实现完成后点击「重试」即可加载，页面其余部分不受影响。
              </Callout>
            ) : null}
          </div>
        </Card>
      ) : null}

      {agentsAsync.data ? (
        <>
          {agentsAsync.error ? (
            <Callout tone="amber" icon="alert">
              刷新 Agent 列表失败，当前展示上一次成功获取的数据：{agentsAsync.error}
            </Callout>
          ) : null}

          {tasksAsync.error ? (
            <Callout tone="amber" icon="info">
              任务数据暂不可用（{tasksAsync.error}），卡片暂不显示最近任务；Agent 信息不受影响。
            </Callout>
          ) : null}

          <div className="grid grid-4">
            <Stat
              label="Agent 总数"
              value={fmtInt(agents.length)}
              icon="bot"
              tone="violet"
              hint="注册表内的 Agent 身份数"
            />
            <Stat
              label="活跃 Agent"
              value={fmtInt(activeCount)}
              icon="zap"
              tone="green"
              hint="状态为活跃的 Agent"
            />
            <Stat
              label="Agent 写入记忆"
              value={fmtInt(memoryCount)}
              icon="brain"
              tone="cyan"
              hint="所有 Agent 的记忆总数"
            />
            <Stat
              label="私有记忆"
              value={fmtInt(privateMemoryCount)}
              icon="lock"
              tone="amber"
              hint="仅写入 Agent 可见的记忆"
            />
          </div>

          {agents.length ? (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  recentTask={latestTaskByAgent.get(agent.id)}
                  onOpen={() => setDetailId(agent.id)}
                />
              ))}
            </div>
          ) : (
            <Card pad>
              <EmptyState
                icon="bot"
                title="还没有注册任何 Agent"
                description="创建 Agent 后，可在任务中指派 owner，并区分项目共享与 Agent 私有记忆。Agent 通过 API 首次写入记忆时也会自动出现在这里。"
                action={
                  <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                    创建第一个 Agent
                  </Button>
                }
              />
            </Card>
          )}
        </>
      ) : null}

      <AgentCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
        onCreated={(agent) => {
          setCreateOpen(false);
          toast.success(`Agent「${agent.name}」已创建`);
          refreshAll();
        }}
      />

      <AgentDrawer agent={selectedAgent} onClose={() => setDetailId(null)} />
    </div>
  );
}
