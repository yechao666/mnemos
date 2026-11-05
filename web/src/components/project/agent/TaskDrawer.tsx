import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { FinishTaskInput } from '@shared';
import { CATEGORY_LABEL } from '@shared';
import {
  Badge,
  Button,
  Callout,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  LoadingBlock,
  SectionHead,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '@ui';
import { api, ApiError } from '@lib/api.ts';
import type { MemoryListParams } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtDateTime, fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { toneForCategory } from '@lib/tone.ts';
import { clickableRowStyle } from '../shared.tsx';
import { MemoryDrawer } from '../MemoryDrawer.tsx';
import {
  isNotFoundError,
  TaskStatusBadge,
  VisibilityBadge,
  visibilityOf,
} from './shared.tsx';
import { BriefingPreview } from './BriefingPreview.tsx';

type FinishStatus = 'done' | 'abandoned';

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 任务详情：目标与归因、本次任务写入的记忆、结束沉淀与上下文简报。 */
export function TaskDrawer({
  taskId,
  onClose,
  onFinished,
}: {
  taskId: string | null;
  onClose: () => void;
  onFinished?: () => void;
}) {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const toast = useToast();

  const { data: task, loading, error, refresh } = useAsync(
    () => (taskId ? api.tasks.get(taskId) : Promise.resolve(null)),
    [taskId],
    Boolean(taskId),
  );

  const memoriesAsync = useAsync(
    () => {
      const params: MemoryListParams = {
        taskId: taskId ?? undefined,
        includePrivate: true,
        pageSize: 50,
        sort: 'recent',
      };
      return api.memories.list(projectId, params);
    },
    [projectId, taskId],
    Boolean(projectId && taskId),
  );

  const [summary, setSummary] = useState('');
  const [decisions, setDecisions] = useState('');
  const [lessons, setLessons] = useState('');
  const [notes, setNotes] = useState('');
  const [finishStatus, setFinishStatus] = useState<FinishStatus>('done');
  const [finishing, setFinishing] = useState(false);

  const [memoryId, setMemoryId] = useState<string | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);

  useEffect(() => {
    setSummary('');
    setDecisions('');
    setLessons('');
    setNotes('');
    setFinishStatus('done');
    setFinishing(false);
    setMemoryId(null);
    setBriefingOpen(false);
  }, [taskId]);

  const memories = memoriesAsync.data?.items ?? [];
  const ended = task ? task.status === 'done' || task.status === 'abandoned' : false;

  const submitFinish = async () => {
    if (!taskId || !task) return;
    setFinishing(true);
    try {
      const input: FinishTaskInput = { status: finishStatus };
      if (summary.trim()) input.summary = summary.trim();
      const decisionLines = splitLines(decisions);
      const lessonLines = splitLines(lessons);
      const noteLines = splitLines(notes);
      if (decisionLines.length) input.decisions = decisionLines;
      if (lessonLines.length) input.lessons = lessonLines;
      if (noteLines.length) input.notes = noteLines;
      if (task.ownerAgentId) input.agentId = task.ownerAgentId;

      const result = await api.tasks.finish(taskId, input);
      toast.success(`任务已结束，写入 ${fmtInt(result.memories?.length ?? 0)} 条项目共享记忆`);
      setSummary('');
      setDecisions('');
      setLessons('');
      setNotes('');
      await refresh();
      await memoriesAsync.refresh();
      onFinished?.();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : '结束任务失败，请稍后重试。');
    } finally {
      setFinishing(false);
    }
  };

  return (
    <>
      <Drawer
        open={Boolean(taskId)}
        onClose={onClose}
        wide
        title="任务详情"
        subtitle={taskId ? <span className="mono tiny">{taskId}</span> : undefined}
        footer={
          task ? (
            <>
              <Button variant="primary" icon="sparkles" onClick={() => setBriefingOpen(true)}>
                上下文简报
              </Button>
              <span className="ml-auto" />
              <Button variant="ghost" onClick={onClose}>
                关闭
              </Button>
            </>
          ) : undefined
        }
      >
        {loading && !task ? <LoadingBlock label="正在加载任务详情…" /> : null}

        {!loading && error && !task ? (
          <div className="vstack gap-10">
            <ErrorState message={error} onRetry={() => void refresh()} />
            {isNotFoundError(error) ? (
              <Callout tone="amber" icon="info">
                任务接口尚未就绪时会返回 404；实现完成后点击「重试」即可加载，无需刷新页面。
              </Callout>
            ) : null}
          </div>
        ) : null}

        {task ? (
          <div className="vstack gap-16">
            {error ? (
              <Callout tone="amber" icon="alert">
                刷新任务失败，当前展示上一次成功获取的数据：{error}
              </Callout>
            ) : null}

            <div className="vstack gap-8">
              <div className="hstack gap-8 wrap">
                <span className="strong" style={{ fontSize: 18 }}>
                  {task.title}
                </span>
                <TaskStatusBadge status={task.status} />
              </div>
              <div className="mem-content" style={{ whiteSpace: 'pre-wrap' }}>
                {task.goal || '未填写任务目标。'}
              </div>
            </div>

            <div className="metric-grid">
              <div className="metric">
                <span className="metric-label">Owner Agent</span>
                <span className="metric-value" title={task.ownerAgentId}>
                  {task.ownerAgentName ?? task.ownerAgentId ?? '未指定'}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">分支</span>
                <span className="metric-value mono">{task.branch || '未指定'}</span>
              </div>
              <div className="metric">
                <span className="metric-label">开始时间</span>
                <span className="metric-value" title={fmtFullDateTime(task.startedAt)}>
                  {fmtDateTime(task.startedAt)}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">结束时间</span>
                <span className="metric-value" title={task.endedAt ? fmtFullDateTime(task.endedAt) : undefined}>
                  {task.endedAt ? fmtDateTime(task.endedAt) : '进行中'}
                </span>
              </div>
              <div className="metric">
                <span className="metric-label">写入记忆</span>
                <span className="metric-value">{fmtInt(task.memoryCount)} 条</span>
              </div>
              <div className="metric">
                <span className="metric-label">参与 Agent</span>
                <span className="metric-value">{fmtInt(task.agentCount)} 个</span>
              </div>
            </div>

            {task.summary ? (
              <div className="vstack gap-6">
                <div className="section-title">任务摘要</div>
                <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
                  {task.summary}
                </div>
              </div>
            ) : null}

            <div className="divider" />

            <div className="vstack gap-10">
              <SectionHead
                title="本次任务写入的记忆"
                desc="包含项目共享、Agent 私有与任务内记忆"
                actions={
                  <Badge tone="slate" size="sm">
                    {fmtInt(task.memoryCount)} 条
                  </Badge>
                }
              />

              {memoriesAsync.loading && !memoriesAsync.data ? (
                <div className="vstack gap-8">
                  {[0, 1, 2].map((index) => (
                    <Skeleton key={index} h={42} />
                  ))}
                </div>
              ) : null}

              {memoriesAsync.error ? (
                <Callout tone="amber" icon="alert">
                  无法加载任务记忆：{memoriesAsync.error}
                </Callout>
              ) : null}

              {!memoriesAsync.loading && !memoriesAsync.error && memories.length === 0 ? (
                <EmptyState
                  compact
                  icon="brain"
                  title="本次任务还没有写入记忆"
                  description="任务进行中写入的记忆会带上 task_id，并出现在这里；结束任务时提交的决策与经验也会写入共享记忆。"
                />
              ) : null}

              {memories.length ? (
                <div className="vstack">
                  {memories.map((memory, index) => (
                    <div key={memory.id}>
                      {index > 0 ? <div className="divider" /> : null}
                      <button
                        type="button"
                        style={clickableRowStyle}
                        title="查看记忆详情"
                        onClick={() => setMemoryId(memory.id)}
                      >
                        <div className="between gap-12" style={{ alignItems: 'flex-start' }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div className="mem-content clamp-2">{memory.content}</div>
                            <div className="chip-row mt-6">
                              <Badge tone={toneForCategory(memory.category)} size="sm">
                                {CATEGORY_LABEL[memory.category]}
                              </Badge>
                              <VisibilityBadge visibility={visibilityOf(memory)} />
                              {memory.agentId ? (
                                <span className="chip" title={`写入 Agent：${memory.agentId}`}>
                                  <Icon name="bot" size={11} />
                                  <span className="truncate" style={{ maxWidth: 140 }}>
                                    {memory.agentId === task.ownerAgentId && task.ownerAgentName
                                      ? task.ownerAgentName
                                      : memory.agentId}
                                  </span>
                                </span>
                              ) : null}
                              <span className="tiny dim" title={fmtFullDateTime(memory.createdAt)}>
                                {fmtRelative(memory.createdAt)}
                              </span>
                            </div>
                          </div>
                          <Icon name="eye" size={13} />
                        </div>
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="divider" />

            {ended ? (
              <div className="vstack gap-10">
                <SectionHead title="任务已结束" desc="结束时的决策与经验已写入项目共享记忆" />
                <Callout tone="blue" icon="checkCircle">
                  <div className="vstack gap-4">
                    <div>任务已于 {fmtFullDateTime(task.endedAt)} 结束。</div>
                    <div className="tiny dim">结束时的决策与经验已写入项目共享记忆；上方摘要保留在任务记录中。</div>
                  </div>
                </Callout>
              </div>
            ) : (
              <div className="vstack gap-12">
                <SectionHead
                  title="结束任务"
                  desc="结束时会写入项目共享记忆，供下一个 Agent 在简报中复用"
                />

                <Callout tone="violet" icon="info">
                  决策、经验与补充记录均为每行一条；空行会自动忽略。提交后它们会以项目共享可见性写入记忆，并保留本任务的 task_id 与 owner Agent 作为来源。
                </Callout>

                <Field label="任务摘要" hint="写回任务摘要，方便人类快速回顾；不会单独生成记忆。">
                  <Textarea
                    rows={3}
                    value={summary}
                    placeholder="例如：查询服务已拆出，契约未变，压测通过。"
                    onChange={(event) => setSummary(event.target.value)}
                  />
                </Field>

                <div className="grid grid-2">
                  <Field label="决策" hint="每行一条，写入项目共享记忆。">
                    <Textarea
                      rows={4}
                      value={decisions}
                      placeholder={'例如：查询服务使用只读副本\n接口契约保持 v1 不变'}
                      onChange={(event) => setDecisions(event.target.value)}
                    />
                  </Field>
                  <Field label="经验与教训" hint="每行一条，写入项目共享记忆。">
                    <Textarea
                      rows={4}
                      value={lessons}
                      placeholder={'例如：分片键必须带 order_id\n压测需覆盖 50 并发'}
                      onChange={(event) => setLessons(event.target.value)}
                    />
                  </Field>
                </div>

                <Field label="补充记录" hint="每行一条，默认项目共享。">
                  <Textarea
                    rows={2}
                    value={notes}
                    placeholder="例如：回滚方案已记录在发布单"
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </Field>

                <div className="between gap-12 wrap">
                  <Select
                    aria-label="结束状态"
                    options={[
                      { value: 'done', label: '标记为已完成' },
                      { value: 'abandoned', label: '标记为已放弃' },
                    ]}
                    value={finishStatus}
                    style={{ width: 180 }}
                    onChange={(event) => setFinishStatus(event.target.value as FinishStatus)}
                  />
                  <Button
                    variant="primary"
                    icon="checkCircle"
                    loading={finishing}
                    onClick={() => void submitFinish()}
                  >
                    结束任务并沉淀
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Drawer>

      <MemoryDrawer
        memoryId={memoryId}
        onClose={() => setMemoryId(null)}
        onChanged={() => {
          void memoriesAsync.refresh();
        }}
        onDeleted={() => {
          void memoriesAsync.refresh();
          void refresh();
        }}
      />

      {task ? (
        <BriefingPreview
          open={briefingOpen}
          onClose={() => setBriefingOpen(false)}
          projectId={projectId}
          agentId={task.ownerAgentId}
          taskId={task.id}
        />
      ) : null}
    </>
  );
}
