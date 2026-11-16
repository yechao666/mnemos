import type { MemoryDreamRun } from '@shared';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Modal,
  Skeleton,
} from '@ui';
import { fmtFullDateTime, fmtInt, fmtRelative } from '@lib/format.ts';
import { runStatusMeta, triggerLabel } from './shared.tsx';

export interface DreamRunsModalProps {
  open: boolean;
  onClose: () => void;
  /** 最近运行记录（新 → 旧），最多展示 10 条 */
  runs: MemoryDreamRun[];
  /** 状态仍在加载且没有缓存数据 */
  loading?: boolean;
  /** 状态加载失败时的错误通知 */
  error?: string | null;
}

const MAX_RUNS = 10;

/**
 * 复盘总结记录：状态、触发方式、输入/洞见条数、摘要或错误与时间。
 */
export function DreamRunsModal({ open, onClose, runs, loading = false, error }: DreamRunsModalProps) {
  const recent = runs.slice(0, MAX_RUNS);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="复盘总结记录"
      description={`最近 ${MAX_RUNS} 次复盘总结运行（新 → 旧）。`}
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {error ? (
        <Callout tone="red" icon="alert">
          {error}
        </Callout>
      ) : null}

      {loading && !runs.length ? (
        <div className="vstack gap-8">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} h={52} style={{ borderRadius: 10 }} />
          ))}
        </div>
      ) : recent.length ? (
        <div className="memory-run-list">
          {recent.map((run) => {
            const meta = runStatusMeta(run.status);
            const timeTitle = `${fmtFullDateTime(run.startedAt)}${
              run.finishedAt ? ` → ${fmtFullDateTime(run.finishedAt)}` : ''
            }`;
            return (
              <div key={run.id} className="memory-run-item">
                <div className="memory-run-head">
                  <div className="hstack gap-6 wrap">
                    <Badge tone={meta.tone} size="sm" dot={run.status === 'running'}>
                      {meta.label}
                    </Badge>
                    <span className="tiny dim">{triggerLabel(run.trigger)}</span>
                    <span className="tiny muted">
                      输入 {fmtInt(run.inputCount)} 条 → 洞见 {fmtInt(run.insightCount)} 条
                    </span>
                  </div>
                  <span className="tiny dim nowrap" title={timeTitle}>
                    {fmtRelative(run.startedAt)}
                  </span>
                </div>
                {run.error ? (
                  <div className="memory-run-text memory-run-error">{run.error}</div>
                ) : run.summary ? (
                  <div className="memory-run-text">{run.summary}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          compact
          icon="clock"
          title="还没有复盘总结记录"
          description="启用定时复盘总结或点击「立即复盘」后，这里会展示每次整理的结果。"
        />
      )}
    </Modal>
  );
}
