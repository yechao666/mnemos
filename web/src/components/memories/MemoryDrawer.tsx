import { useEffect, useState, type ReactNode } from 'react';
import type {
  Memory,
  MemoryHistoryEntry,
  MemorySearchHit,
} from '@lib/types.ts';
import { HISTORY_EVENT_META } from '@lib/constants.ts';
import { api } from '@lib/api.ts';
import { useAsync } from '@lib/hooks.ts';
import { fmtFullDateTime, fmtInt, fmtRelative, truncateMiddle } from '@lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  Drawer,
  EmptyState,
  ErrorState,
  Icon,
  Skeleton,
  useToast,
} from '@ui';
import {
  MemoryContent,
  MemoryFactKey,
  MemoryFeedbackBadge,
  MemoryMeta,
  MemoryTemporalBadge,
} from './shared.tsx';
import { AttachmentGallery } from './Attachments.tsx';
import { SearchHitInsight } from './SearchSignals.tsx';

/** 判断一条记忆是否来自检索结果（带 score/signals/matchedOn）。 */
function asSearchHit(memory: Memory | MemorySearchHit | null): MemorySearchHit | null {
  return memory && 'signals' in memory ? (memory as MemorySearchHit) : null;
}

function linkedMemoryIds(entry: MemoryHistoryEntry): string[] {
  const ids = new Set<string>();
  for (const key of [
    'supersededId',
    'superseded_id',
    'supersededBy',
    'superseded_by',
    'supersedesId',
    'supersedes_id',
    'supersedes',
    'targetId',
    'target_id',
    'memoryId',
    'memory_id',
  ]) {
    const value = entry.meta[key];
    if (typeof value === 'string' && value && value !== entry.memoryId) ids.add(value);
  }
  return [...ids];
}

function HistoryEntryItem({
  entry,
  onOpenMemory,
}: {
  entry: MemoryHistoryEntry;
  onOpenMemory?: (memoryId: string) => void;
}) {
  const meta = HISTORY_EVENT_META[entry.event] ?? HISTORY_EVENT_META.UPDATE;
  const links = linkedMemoryIds(entry);
  return (
    <li className="memory-timeline-item">
      <span
        className="memory-timeline-dot"
        style={{ background: `var(--${meta.tone})`, boxShadow: `0 0 0 3px color-mix(in srgb, var(--${meta.tone}) 22%, transparent)` }}
      />
      <div className="memory-timeline-body">
        <div className="between wrap gap-8">
          <div className="hstack gap-6 wrap">
            <Badge tone={meta.tone} size="sm">
              {meta.label}
            </Badge>
            <span className="small" title={meta.desc}>{meta.desc}</span>
          </div>
          <span className="tiny dim nowrap" title={fmtFullDateTime(entry.createdAt)}>
            {fmtRelative(entry.createdAt)}
          </span>
        </div>
        <div className="tiny dim mt-4 hstack gap-8 wrap">
          <span title={entry.actor ?? 'system'}>操作者：{entry.actor || 'system'}</span>
          {entry.reason ? <span>· 原因：{entry.reason}</span> : null}
          <span className="mono" title={entry.id}>#{truncateMiddle(entry.id, 8, 4)}</span>
        </div>

        {entry.oldContent || entry.newContent ? (
          <div className="history-diff mt-6">
            {entry.oldContent ? (
              <details className="history-fold">
                <summary>旧内容</summary>
                <div className="history-text is-old">{entry.oldContent}</div>
              </details>
            ) : null}
            {entry.newContent ? (
              <details className="history-fold">
                <summary>新内容</summary>
                <div className="history-text is-new">{entry.newContent}</div>
              </details>
            ) : null}
          </div>
        ) : null}

        {links.length && onOpenMemory ? (
          <div className="chip-row mt-6">
            <span className="tiny dim">关联</span>
            {links.slice(0, 3).map((id) => (
              <button key={id} type="button" className="link-button mono tiny" onClick={() => onOpenMemory(id)} title={id}>
                {truncateMiddle(id, 10, 5)}
              </button>
            ))}
          </div>
        ) : null}

        {entry.meta && Object.keys(entry.meta).length ? (
          <details className="history-fold mt-4">
            <summary>meta</summary>
            <pre className="history-meta">{JSON.stringify(entry.meta, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function HistoryTimeline({
  entries,
  loading,
  error,
  onRetry,
  onOpenMemory,
}: {
  entries: MemoryHistoryEntry[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenMemory?: (memoryId: string) => void;
}) {
  if (loading && entries.length === 0) {
    return (
      <div className="vstack gap-8">
        {[0, 1, 2].map((index) => <Skeleton key={index} h={52} style={{ borderRadius: 8 }} />)}
      </div>
    );
  }
  if (error && entries.length === 0) {
    return (
      <div className="vstack gap-8">
        <Callout tone="amber" icon="info">
          历史接口尚未就绪或请求失败：<span className="mono">{error}</span>
        </Callout>
        <div>
          <Button size="sm" icon="refresh" onClick={onRetry}>重试</Button>
        </div>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        compact
        icon="clock"
        title="暂无变更历史"
        description="写入、合并、取代与反馈都会记录到 memory_history。"
      />
    );
  }
  return (
    <ol className="memory-timeline">
      {entries.map((entry) => (
        <HistoryEntryItem key={entry.id} entry={entry} onOpenMemory={onOpenMemory} />
      ))}
    </ol>
  );
}

function DetailCell({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="memory-detail-cell" title={title}>
      <span className="memory-detail-key">{label}</span>
      <span className="memory-detail-value">{value}</span>
    </div>
  );
}

export interface MemoryDrawerProps {
  open: boolean;
  partitionId: string;
  memory: Memory | MemorySearchHit | null;
  /** 当前检索词，反馈时一并提交，便于服务端归因。 */
  searchQuery?: string;
  canManage?: boolean;
  onClose: () => void;
  /** 打开另一条记忆（例如 supersededBy / 历史关联记忆）。 */
  onOpenMemory?: (memoryId: string) => void;
  /** 反馈 / 打开新版本后通知列表刷新。 */
  onChanged?: () => void;
}

/**
 * 记忆详情抽屉（v6.1）：
 *  - 内容 + 时序状态（validFrom/validTo/supersededBy/factKey）
 *  - 检索解释（当从搜索结果打开时展示 score + 信号分解）
 *  - 「有帮助 / 没帮助」反馈
 *  - 历史时间线（ADD/UPDATE/MERGE/SUPERSEDE/FEEDBACK…，old/new 折叠）
 */
export function MemoryDrawer({
  open,
  partitionId,
  memory,
  searchQuery,
  canManage = true,
  onClose,
  onOpenMemory,
  onChanged,
}: MemoryDrawerProps) {
  const toast = useToast();
  const [detail, setDetail] = useState<Memory | null>(memory);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState<'' | 'up' | 'down'>('');

  useEffect(() => {
    setDetail(memory);
    setReason('');
  }, [memory]);

  const memoryId = memory?.id ?? '';
  const enabled = open && Boolean(partitionId && memoryId);

  const detailQuery = useAsync(
    () => api.memories.get(partitionId, memoryId),
    [partitionId, memoryId],
    enabled,
  );
  const historyQuery = useAsync(
    () => api.memories.history(partitionId, memoryId),
    [partitionId, memoryId],
    enabled,
  );

  // 避免切换记忆时短暂显示上一条记忆的详情（useAsync 在依赖变化时会保留旧 data）。
  const fetched = detailQuery.data && detailQuery.data.id === memoryId ? detailQuery.data : null;
  const current = fetched ?? detail ?? memory;
  const insight = asSearchHit(memory);
  // 切换记忆时丢弃上一条记忆的历史，避免 useAsync 保留旧 data 造成串台。
  const history = (historyQuery.data ?? []).filter((entry) => !entry.memoryId || entry.memoryId === memoryId);

  const refreshAll = async () => {
    setDetail((prev) => prev ?? memory);
    await Promise.all([detailQuery.refresh(), historyQuery.refresh()]);
    onChanged?.();
  };

  const submitFeedback = async (helpful: boolean) => {
    if (!memory || !canManage || submitting) return;
    setSubmitting(helpful ? 'up' : 'down');
    try {
      const updated = await api.memories.feedback(partitionId, memory.id, {
        helpful,
        query: searchQuery?.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      if (updated) setDetail(updated);
      setReason('');
      toast.success(helpful ? '已记录：这条记忆有帮助' : '已记录：这条记忆没帮助');
      await refreshAll();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '反馈提交失败');
    } finally {
      setSubmitting('');
    }
  };

  const openLinked = (id: string) => {
    if (!id) return;
    onOpenMemory?.(id);
  };

  return (
    <Drawer
      open={open && Boolean(memory)}
      onClose={onClose}
      wide
      title="记忆详情"
      subtitle={memory ? <span className="mono" title={memory.id}>{truncateMiddle(memory.id, 14, 6)}</span> : null}
      footer={
        memory ? (
          <>
            <CopyButton value={memory.id} label="复制 ID" />
            <Button variant="secondary" onClick={onClose}>关闭</Button>
          </>
        ) : null
      }
    >
      {!current ? (
        <EmptyState compact icon="brain" title="未选择记忆" description="从记忆列表点击一行打开详情。" />
      ) : (
        <>
          <section className="vstack gap-10">
            <MemoryContent memory={current} clamp={false} />
            <MemoryMeta memory={current} onOpenSuperseded={openLinked} />
            {insight ? <SearchHitInsight hit={insight} /> : null}
          </section>

          <section>
            <div className="section-title">时序与状态</div>
            <div className="memory-detail-grid mt-8">
              <DetailCell
                label="当前状态"
                value={<MemoryTemporalBadge memory={current} onOpenSuperseded={openLinked} />}
              />
              <DetailCell
                label="记忆状态"
                value={
                  <Badge
                    tone={current.status === 'active' ? 'green' : current.status === 'archived' ? 'slate' : 'red'}
                    size="sm"
                  >
                    {current.status}
                  </Badge>
                }
              />
              <DetailCell label="生效时间" value={fmtFullDateTime(current.validFrom ?? current.createdAt)} />
              <DetailCell
                label="失效时间"
                value={current.validTo ? fmtFullDateTime(current.validTo) : '—（当前有效）'}
              />
              <DetailCell
                label="事实槽位"
                value={current.factKey ? <MemoryFactKey factKey={current.factKey} /> : '—'}
              />
              <DetailCell
                label="取代了"
                value={
                  current.supersedes ? (
                    <button type="button" className="link-button mono tiny" onClick={() => openLinked(current.supersedes!)}>
                      {truncateMiddle(current.supersedes, 12, 5)}
                    </button>
                  ) : (
                    '—'
                  )
                }
              />
              <DetailCell
                label="被谁取代"
                value={
                  current.supersededBy ? (
                    <button type="button" className="link-button mono tiny" onClick={() => openLinked(current.supersededBy!)}>
                      {truncateMiddle(current.supersededBy, 12, 5)}
                    </button>
                  ) : (
                    '—'
                  )
                }
              />
              <DetailCell label="创建 / 更新" value={`${fmtFullDateTime(current.createdAt)} · ${fmtFullDateTime(current.updatedAt)}`} />
              <DetailCell
                label="反馈"
                value={
                  current.feedbackUp || current.feedbackDown ? (
                    <MemoryFeedbackBadge memory={current} />
                  ) : (
                    '暂无反馈'
                  )
                }
              />
            </div>
            {Object.keys(current.metadata ?? {}).length ? (
              <details className="history-fold mt-8">
                <summary>metadata</summary>
                <pre className="history-meta">{JSON.stringify(current.metadata, null, 2)}</pre>
              </details>
            ) : null}
          </section>

          {current.attachments?.length || current.attachmentCount ? (
            <section>
              <div className="between wrap gap-8">
                <div>
                  <div className="section-title">附件</div>
                  <div className="tiny dim mt-4">
                    多模态附件（图片 / 音频 / 视频 / 文件）；媒体本体由调用方托管，这里只展示 URL 与描述，caption 参与检索。
                  </div>
                </div>
                <Badge tone="slate" size="sm">
                  {fmtInt(current.attachments?.length ?? current.attachmentCount ?? 0)} 个
                </Badge>
              </div>
              <div className="mt-10">
                <AttachmentGallery attachments={current.attachments} count={current.attachmentCount} />
              </div>
            </section>
          ) : null}

          <section>
            <div className="between wrap gap-8">
              <div>
                <div className="section-title">这条记忆有帮助吗？</div>
                <div className="tiny dim mt-4">反馈会写入 memory_history 与 feedback 计数，并按比例微调置信度，影响后续检索排序。</div>
              </div>
              <MemoryFeedbackBadge memory={current} />
            </div>
            <div className="feedback-row mt-10">
              <Button
                size="sm"
                variant={submitting === 'up' ? 'primary' : 'secondary'}
                icon="checkCircle"
                loading={submitting === 'up'}
                disabled={!canManage || Boolean(submitting)}
                title={canManage ? '标记有帮助' : '需要开发者权限'}
                onClick={() => void submitFeedback(true)}
              >
                有帮助
              </Button>
              <Button
                size="sm"
                variant={submitting === 'down' ? 'danger' : 'secondary'}
                icon="xCircle"
                loading={submitting === 'down'}
                disabled={!canManage || Boolean(submitting)}
                title={canManage ? '标记没帮助' : '需要开发者权限'}
                onClick={() => void submitFeedback(false)}
              >
                没帮助
              </Button>
              <input
                className="input"
                value={reason}
                placeholder="可选：补充原因（例如“事实已过期”）"
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                style={{ flex: 1, minWidth: 180 }}
                aria-label="反馈原因"
              />
            </div>
            {!canManage ? <div className="tiny dim mt-6">当前账号为只读权限，无法提交反馈。</div> : null}
          </section>

          <section>
            <div className="between wrap gap-8">
              <div>
                <div className="section-title">历史时间线</div>
                <div className="tiny dim mt-4">ADD / UPDATE / MERGE / SUPERSEDE / FEEDBACK；旧值与新值可展开查看。</div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                loading={historyQuery.loading}
                onClick={() => void historyQuery.refresh()}
              >
                刷新
              </Button>
            </div>
            {historyQuery.error && history.length > 0 ? (
              <Callout tone="amber" icon="alert">
                刷新历史失败，已保留上次结果：{historyQuery.error}
              </Callout>
            ) : null}
            <div className="mt-12">
              <HistoryTimeline
                entries={history}
                loading={historyQuery.loading}
                error={historyQuery.error}
                onRetry={() => void historyQuery.refresh()}
                onOpenMemory={onOpenMemory ? openLinked : undefined}
              />
            </div>
          </section>

          {historyQuery.error ? null : historyQuery.loading ? null : (
            <div className="tiny dim">
              <Icon name="info" size={11} /> 历史与反馈由 <span className="mono">memory_history / memory_feedback</span> 提供，随写入、合并、取代与反馈自动记录。
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

/** 供列表/详情复用：点击行打开抽屉时，把 MemorySearchHit 的信号带进抽屉。 */
export function isSearchHit(memory: Memory): memory is MemorySearchHit {
  return 'signals' in memory;
}
