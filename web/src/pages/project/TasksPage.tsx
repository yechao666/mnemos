import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  PageHead,
  Segmented,
  Select,
  Skeleton,
  useToast,
} from '@ui';
import { useAsync } from '@lib/hooks.ts';
import { api } from '@lib/api.ts';
import { fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { TaskCreateModal } from '../../components/project/agent/TaskCreateModal.tsx';
import { TaskDrawer } from '../../components/project/agent/TaskDrawer.tsx';
import {
  isNotFoundError,
  isTaskRunning,
  TASK_STATUS_META,
  TaskStatusBadge,
  taskTimeRange,
} from '../../components/project/agent/shared.tsx';

type StatusFilter = 'all' | 'running' | 'done' | 'abandoned';

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'abandoned', label: '已放弃' },
];

/** 任务会话：同一项目里不同 Agent 跨时间接力的工作单元与记忆沉淀入口。 */
export function TasksPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const toast = useToast();

  const [status, setStatus] = useState<StatusFilter>('all');
  const [agentId, setAgentId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const agentsAsync = useAsync(() => api.agents.list(projectId), [projectId], Boolean(projectId));
  const tasksAsync = useAsync(
    () => api.tasks.list(projectId, { agentId: agentId || undefined, limit: 100 }),
    [projectId, agentId],
    Boolean(projectId),
  );

  const agents = agentsAsync.data ?? [];
  const tasks = tasksAsync.data ?? [];

  // 「进行中」同时覆盖 open 与 active；状态在客户端合并，避免发两次请求。
  const visibleTasks = useMemo(() => {
    return [...tasks]
      .filter((task) => !agentId || task.ownerAgentId === agentId)
      .filter((task) => {
        if (status === 'all') return true;
        if (status === 'running') return isTaskRunning(task.status);
        return task.status === status;
      })
      .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
  }, [tasks, agentId, status]);

  const runningCount = tasks.filter((task) => isTaskRunning(task.status)).length;
  const agentOptions = [
    { value: '', label: '全部 Agent' },
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const refreshAll = () => {
    void tasksAsync.refresh();
    void agentsAsync.refresh();
  };

  const resetFilters = () => {
    setStatus('all');
    setAgentId('');
  };

  const hasFilters = status !== 'all' || Boolean(agentId);
  const loading = tasksAsync.loading || agentsAsync.loading;

  return (
    <div className="page">
      <PageHead
        eyebrow="项目 · Agent 原生"
        title="任务会话"
        desc="同一项目里，不同 Agent 跨时间接力工作，记忆在这里沉淀与共享。"
        actions={
          <>
            <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
              新建任务
            </Button>
            <Button icon="refresh" loading={loading} onClick={refreshAll}>
              刷新
            </Button>
          </>
        }
      />

      {agentsAsync.error ? (
        <Callout tone="amber" icon="alert">
          Agent 列表暂不可用（{agentsAsync.error}）。任务浏览与创建仍可继续，创建时可暂不指定 owner。
        </Callout>
      ) : null}

      <Card>
        <div className="toolbar" style={{ padding: '14px 16px' }}>
          <div className="toolbar-left">
            <Segmented options={STATUS_FILTERS} value={status} onChange={setStatus} />
            <Select
              aria-label="按 Agent 筛选任务"
              options={agentOptions}
              value={agentId}
              style={{ width: 190 }}
              onChange={(event) => setAgentId(event.target.value)}
            />
            {hasFilters ? (
              <Button size="sm" variant="ghost" icon="x" onClick={resetFilters}>
                清空筛选
              </Button>
            ) : null}
          </div>
          <div className="toolbar-right">
            <Badge tone="slate" size="sm">
              共 {fmtInt(visibleTasks.length)} 条
            </Badge>
            <Badge tone={runningCount > 0 ? 'green' : 'slate'} size="sm" dot={runningCount > 0}>
              项目进行中 {fmtInt(runningCount)}
            </Badge>
          </div>
        </div>

        <div style={{ padding: '0 16px 18px' }}>
          {tasksAsync.loading && !tasksAsync.data ? (
            <div className="vstack gap-10">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} h={112} />
              ))}
            </div>
          ) : null}

          {!tasksAsync.loading && tasksAsync.error && !tasksAsync.data ? (
            <div className="vstack gap-10">
              <ErrorState message={tasksAsync.error} onRetry={() => void tasksAsync.refresh()} />
              {isNotFoundError(tasksAsync.error) ? (
                <div className="tiny dim center">任务接口尚未就绪时返回 404；实现完成后点击重试即可。</div>
              ) : null}
            </div>
          ) : null}

          {tasksAsync.error && tasksAsync.data ? (
            <div className="mb-12">
              <Callout tone="amber" icon="alert">
                刷新任务列表失败：{tasksAsync.error}
              </Callout>
            </div>
          ) : null}

          {!tasksAsync.loading && !tasksAsync.error && tasks.length === 0 ? (
            <EmptyState
              icon="branch"
              title="还没有任务会话"
              description="任务把不同 Agent、不同时间段的工作串起来。结束任务时提交的决策与经验会自动写入项目共享记忆，供下一次任务生成简报。"
              action={
                <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
                  创建第一个任务
                </Button>
              }
            />
          ) : null}

          {tasks.length > 0 && visibleTasks.length === 0 ? (
            <EmptyState
              icon="filter"
              title="没有符合筛选条件的任务"
              description="调整状态或 Agent 筛选后重试。"
              action={
                <Button size="sm" variant="secondary" icon="x" onClick={resetFilters}>
                  清空筛选
                </Button>
              }
            />
          ) : null}

          {visibleTasks.length ? (
            <div className="timeline">
              {visibleTasks.map((task) => {
                const meta = TASK_STATUS_META[task.status] ?? TASK_STATUS_META.open;
                return (
                  <div key={task.id} className={`tl-item tone-${meta.tone}`}>
                    <span className="tl-dot">
                      <Icon name={meta.icon} size={11} />
                    </span>
                    <div className="tl-body">
                      <button
                        type="button"
                        className="card card-hover card-pad"
                        style={{ width: '100%', textAlign: 'left', display: 'block' }}
                        title="查看任务详情"
                        onClick={() => setDetailId(task.id)}
                      >
                        <div className="between gap-12 wrap" style={{ alignItems: 'flex-start' }}>
                          <div className="hstack gap-8 wrap" style={{ minWidth: 0 }}>
                            <span className="strong truncate" style={{ fontSize: 14 }}>
                              {task.title}
                            </span>
                            <TaskStatusBadge status={task.status} />
                          </div>
                          <span className="tiny dim nowrap" title={`${fmtFullDateTime(task.startedAt)} 开始`}>
                            {taskTimeRange(task)}
                          </span>
                        </div>

                        <div className="small muted clamp-2 mt-4">
                          {task.goal || '未填写任务目标。'}
                        </div>

                        <div className="chip-row mt-8">
                          <span className="chip" title={task.ownerAgentId}>
                            <Icon name="bot" size={11} />
                            <span className="truncate" style={{ maxWidth: 140 }}>
                              {task.ownerAgentName ?? task.ownerAgentId ?? '未指定 owner'}
                            </span>
                          </span>
                          {task.branch ? (
                            <span className="chip mono" title={task.branch}>
                              <Icon name="branch" size={11} />
                              <span className="truncate" style={{ maxWidth: 170 }}>
                                {task.branch}
                              </span>
                            </span>
                          ) : null}
                          <span className="chip">
                            <Icon name="brain" size={11} />
                            {fmtInt(task.memoryCount)} 条记忆
                          </span>
                          <span className="chip">
                            <Icon name="users" size={11} />
                            {fmtInt(task.agentCount)} 个 Agent
                          </span>
                          <span className="tiny dim" title={fmtFullDateTime(task.startedAt)}>
                            {fmtRelative(task.startedAt)}开始
                          </span>
                        </div>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </Card>

      <TaskCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectId={projectId}
        agents={agents}
        onCreated={(task) => {
          setCreateOpen(false);
          toast.success(`任务「${task.title}」已创建`);
          void tasksAsync.refresh();
        }}
      />

      <TaskDrawer
        taskId={detailId}
        onClose={() => setDetailId(null)}
        onFinished={() => {
          void tasksAsync.refresh();
          void agentsAsync.refresh();
        }}
      />
    </div>
  );
}
