import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { MemoryCategory, MemoryStatus, SearchHit } from '@shared';
import { CATEGORY_LABEL, MEMORY_CATEGORIES, MEMORY_STATUSES } from '@shared';
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  ConfirmDialog,
  Drawer,
  ErrorState,
  Field,
  Icon,
  LoadingBlock,
  Select,
  Textarea,
  useToast,
} from '@ui';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtDate, fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { toneForCategory, toneForStatus } from '@lib/tone.ts';
import {
  formatScore,
  iconForEvent,
  normalizePct,
  SOURCE_LABEL,
  SignalBreakdown,
  toneForEvent,
} from './shared.tsx';
import { TaskIdChip, VisibilityBadge, visibilityOf } from './agent/shared.tsx';

export interface MemoryDrawerProps {
  memoryId: string | null;
  /** 来自混合检索时携带分数与信号，用于信号分解区块。 */
  hit?: SearchHit | null;
  /** 当前检索词，随反馈一并提交。 */
  query?: string;
  onClose: () => void;
  onChanged?: () => void;
  onDeleted?: () => void;
}

const CATEGORY_OPTIONS = MEMORY_CATEGORIES.map((category) => ({
  value: category.value,
  label: category.label,
}));

const STATUS_OPTIONS = MEMORY_STATUSES.map((status) => ({
  value: status.value,
  label: status.label,
}));

/** 记忆详情抽屉：查看 / 编辑 / 反馈 / 删除，并展示检索信号、实体与变更历史。 */
export function MemoryDrawer({
  memoryId,
  hit,
  query,
  onClose,
  onChanged,
  onDeleted,
}: MemoryDrawerProps) {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const { data, loading, error, refresh } = useAsync(
    () => (memoryId ? api.memories.get(memoryId) : Promise.resolve(null)),
    [memoryId],
    Boolean(memoryId),
  );

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState<'up' | 'down' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [draftContent, setDraftContent] = useState('');
  const [draftCategory, setDraftCategory] = useState<MemoryCategory>('fact');
  const [draftImportance, setDraftImportance] = useState(0.5);
  const [draftStatus, setDraftStatus] = useState<MemoryStatus>('active');

  useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
  }, [memoryId]);

  const memory = data?.memory ?? null;
  const searchHit: SearchHit | null = hit && memory && hit.id === memory.id ? hit : null;

  const startEdit = () => {
    if (!memory) return;
    setDraftContent(memory.content);
    setDraftCategory(memory.category);
    setDraftImportance(memory.importance);
    setDraftStatus(memory.status);
    setEditing(true);
  };

  const save = async () => {
    if (!memoryId) return;
    if (!draftContent.trim()) {
      toast.warning('记忆内容不能为空');
      return;
    }
    setSaving(true);
    try {
      await api.memories.update(memoryId, {
        content: draftContent.trim(),
        category: draftCategory,
        importance: draftImportance,
        status: draftStatus,
      });
      toast.success('记忆已更新');
      setEditing(false);
      await refresh();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新记忆失败');
    } finally {
      setSaving(false);
    }
  };

  const sendFeedback = async (helpful: boolean) => {
    if (!memoryId) return;
    setFeedbackBusy(helpful ? 'up' : 'down');
    try {
      await api.memories.feedback(memoryId, {
        helpful,
        query: query?.trim() ? query.trim() : undefined,
      });
      toast.success(helpful ? '已记录为有帮助，将用于优化召回排序' : '已记录为无帮助，我们会继续改进');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交反馈失败');
    } finally {
      setFeedbackBusy(null);
    }
  };

  const remove = async () => {
    if (!memoryId) return;
    setDeleteBusy(true);
    try {
      await api.memories.remove(memoryId);
      toast.success('记忆已删除');
      setConfirmDelete(false);
      onDeleted?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除记忆失败');
    } finally {
      setDeleteBusy(false);
    }
  };

  const metadata = (memory?.metadata ?? {}) as Record<string, unknown>;
  const hasMetadata = Object.keys(metadata).length > 0;
  const statusLabel = MEMORY_STATUSES.find((status) => status.value === memory?.status)?.label ?? '';

  return (
    <>
      <Drawer
        open={Boolean(memoryId)}
        onClose={onClose}
        wide
        title="记忆详情"
        subtitle={<span className="mono tiny">{memoryId ?? ''}</span>}
        footer={
          memory ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon="checkCircle"
                loading={feedbackBusy === 'up'}
                disabled={feedbackBusy !== null}
                onClick={() => void sendFeedback(true)}
              >
                有帮助
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="xCircle"
                loading={feedbackBusy === 'down'}
                disabled={feedbackBusy !== null}
                onClick={() => void sendFeedback(false)}
              >
                无帮助
              </Button>
              <span className="ml-auto" />
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                onClick={() => setConfirmDelete(true)}
                disabled={deleteBusy}
              >
                删除
              </Button>
            </>
          ) : undefined
        }
      >
        {loading && !data ? <LoadingBlock label="正在加载记忆详情…" /> : null}
        {error && !data ? <ErrorState message={error} onRetry={() => void refresh()} /> : null}
        {error && data ? (
          <Callout tone="amber" icon="alert">
            刷新失败：{error}
          </Callout>
        ) : null}

        {memory ? (
          <>
            <div className="between gap-12">
              <div className="chip-row">
                <Badge tone={toneForCategory(memory.category)} size="sm">
                  {CATEGORY_LABEL[memory.category]}
                </Badge>
                <Badge tone={toneForStatus(memory.status)} size="sm" dot>
                  {statusLabel}
                </Badge>
                <span className="tag">{SOURCE_LABEL[memory.source]}</span>
              </div>
              {!editing ? (
                <Button size="sm" variant="ghost" icon="pencil" onClick={startEdit}>
                  编辑
                </Button>
              ) : null}
            </div>

            {editing ? (
              <div className="vstack gap-12">
                <Field label="记忆内容" hint="内容会重新进入索引，并记录一条变更历史。">
                  <Textarea
                    rows={6}
                    value={draftContent}
                    onChange={(event) => setDraftContent(event.target.value)}
                  />
                </Field>
                <div className="grid grid-2">
                  <Field label="分类">
                    <Select
                      options={CATEGORY_OPTIONS}
                      value={draftCategory}
                      onChange={(event) => setDraftCategory(event.target.value as MemoryCategory)}
                    />
                  </Field>
                  <Field label="状态">
                    <Select
                      options={STATUS_OPTIONS}
                      value={draftStatus}
                      onChange={(event) => setDraftStatus(event.target.value as MemoryStatus)}
                    />
                  </Field>
                </div>
                <Field label={`重要度 ${draftImportance.toFixed(2)}`}>
                  <input
                    type="range"
                    className="slider"
                    min={0}
                    max={1}
                    step={0.01}
                    value={draftImportance}
                    aria-label="重要度"
                    onChange={(event) => setDraftImportance(Number(event.target.value))}
                  />
                </Field>
                <div className="hstack gap-8">
                  <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
                    保存修改
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setEditing(false)}
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <div className="vstack gap-10">
                <div className="section-title">
                  <Icon name="brain" size={13} />
                  记忆内容
                </div>
                <div className="mem-content" style={{ whiteSpace: 'pre-wrap' }}>
                  {memory.content}
                </div>
                <div className="chip-row">
                  {memory.tags.length ? (
                    memory.tags.map((tag) => (
                      <span key={tag} className="tag">
                        {tag}
                      </span>
                    ))
                  ) : (
                    <span className="tiny dim">暂无标签</span>
                  )}
                </div>
              </div>
            )}

            <div className="divider" />

            <div className="vstack gap-10">
              <div className="section-title">元信息</div>
              <div className="metric-grid">
                <div className="metric">
                  <span className="metric-label">来源</span>
                  <span className="metric-value">{SOURCE_LABEL[memory.source]}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">可见性</span>
                  <span className="metric-value">
                    <VisibilityBadge visibility={visibilityOf(memory)} />
                  </span>
                </div>
                <div className="metric">
                  <span className="metric-label">任务</span>
                  <span className="metric-value">
                    {memory.taskId ? <TaskIdChip taskId={memory.taskId} /> : '未归属任务'}
                  </span>
                </div>
                <div className="metric">
                  <span className="metric-label">写入 Agent</span>
                  <span className="metric-value mono truncate" title={memory.agentId}>
                    {memory.agentId ?? '—'}
                  </span>
                </div>
                <div className="metric">
                  <span className="metric-label">置信度</span>
                  <span className="metric-value">{memory.confidence.toFixed(2)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">访问次数</span>
                  <span className="metric-value">{fmtInt(memory.accessCount)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">重要度</span>
                  <span className="metric-value">{memory.importance.toFixed(2)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">创建时间</span>
                  <span className="metric-value">{fmtFullDateTime(memory.createdAt)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">更新时间</span>
                  <span className="metric-value">{fmtFullDateTime(memory.updatedAt)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">最近访问</span>
                  <span className="metric-value">
                    {memory.lastAccessedAt ? fmtRelative(memory.lastAccessedAt) : '从未'}
                  </span>
                </div>
                <div className="metric">
                  <span className="metric-label">有效期</span>
                  <span className="metric-value">
                    {memory.expiresAt ? fmtDate(memory.expiresAt) : '永久有效'}
                  </span>
                </div>
              </div>
            </div>

            <div className="divider" />

            <div className="vstack gap-10">
              <div className="between gap-12">
                <div className="section-title">附加元数据</div>
                {hasMetadata ? (
                  <span className="tiny dim mono">{Object.keys(metadata).length} 个字段</span>
                ) : null}
              </div>
              {hasMetadata ? (
                <CodeBlock
                  title="metadata.json"
                  language="json"
                  code={JSON.stringify(metadata, null, 2)}
                />
              ) : (
                <div className="tiny dim">无附加元数据。</div>
              )}
            </div>

            {searchHit && searchHit.signals ? (
              <>
                <div className="divider" />
                <div className="vstack gap-10">
                  <div className="between gap-12">
                    <div className="section-title">检索信号分解</div>
                    <span className="hstack gap-6">
                      <span className="tiny dim">综合得分</span>
                      <span className="mono small">{formatScore(searchHit.score)}</span>
                    </span>
                  </div>
                  <div className="score-bar tone-violet">
                    <span className="score-track">
                      <span
                        className="score-fill"
                        style={{
                          width: `${Math.max(0, Math.min(100, normalizePct(searchHit.score)))}%`,
                        }}
                      />
                    </span>
                  </div>
                  <SignalBreakdown values={searchHit.signals} />
                  {searchHit.matchedOn.length ? (
                    <div className="chip-row">
                      <span className="tiny dim">命中信号</span>
                      {searchHit.matchedOn.map((signal) => (
                        <span key={signal} className="tag">
                          {signal}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            <div className="divider" />

            <div className="vstack gap-10">
              <div className="section-title">相关实体</div>
              {data?.entities.length ? (
                <div className="chip-row">
                  {data.entities.map((entity) => (
                    <button
                      key={entity.id}
                      type="button"
                      className="chip chip-clickable"
                      title={`${entity.name} · ${entity.type}`}
                      onClick={() =>
                        navigate(
                          `/projects/${projectId}/graph?entity=${encodeURIComponent(entity.name)}`,
                        )
                      }
                    >
                      <span
                        className="dot"
                        style={{ width: 5, height: 5, background: 'var(--pink)', boxShadow: 'none' }}
                      />
                      <span className="truncate" style={{ maxWidth: 130 }}>
                        {entity.name}
                      </span>
                      <span className="tiny dim mono">{fmtInt(entity.mentionCount)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="tiny dim">该记忆暂未关联图谱实体。</div>
              )}
            </div>

            <div className="divider" />

            <div className="vstack gap-10">
              <div className="section-title">变更历史</div>
              {data?.history.length ? (
                <div className="timeline">
                  {data.history.map((entry) => (
                    <div key={entry.id} className={`tl-item tone-${toneForEvent(entry.event)}`}>
                      <span className="tl-dot">
                        <Icon name={iconForEvent(entry.event)} size={11} />
                      </span>
                      <div className="tl-body">
                        <div className="tl-title">
                          <Badge tone={toneForEvent(entry.event)} size="sm">
                            {entry.event}
                          </Badge>{' '}
                          <span className="muted">{entry.actor}</span>
                        </div>
                        {entry.oldContent ? (
                          <div
                            className="tiny dim mt-4 clamp-2"
                            style={{ textDecoration: 'line-through' }}
                          >
                            {entry.oldContent}
                          </div>
                        ) : null}
                        {entry.newContent ? (
                          <div className="tiny soft mt-4 clamp-2">{entry.newContent}</div>
                        ) : null}
                        {entry.reason ? <div className="tiny dim mt-4">{entry.reason}</div> : null}
                        <div className="tl-time" title={fmtFullDateTime(entry.createdAt)}>
                          {fmtRelative(entry.createdAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tiny dim">暂无变更记录。</div>
              )}
            </div>
          </>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => {
          if (!deleteBusy) setConfirmDelete(false);
        }}
        onConfirm={() => void remove()}
        title="删除记忆"
        description="删除后该记忆将不再参与检索与图谱构建，操作会记录到审计日志。"
        confirmLabel="删除记忆"
        loading={deleteBusy}
      />
    </>
  );
}
