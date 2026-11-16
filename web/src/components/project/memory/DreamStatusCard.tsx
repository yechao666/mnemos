import type { MemoryDreamStatus } from '@shared';
import { Badge, Button, Callout, Card, Skeleton } from '@ui';
import { fmtInt, fmtRelative } from '@lib/format.ts';
import { intervalLabel } from './shared.tsx';

export interface DreamStatusCardProps {
  status: MemoryDreamStatus | null;
  loading: boolean;
  error: string | null;
  /** 项目记忆总数（页面从记忆列表 total 传入） */
  memoryCount: number;
  /** 洞见数量（category === 'insight'） */
  insightCount: number;
  /** 写操作需 admin：只读角色隐藏设置与「立即复盘」 */
  canManage: boolean;
  /** 「立即复盘」进行中 */
  running: boolean;
  onRun: () => void;
  onOpenSettings: () => void;
  onOpenRuns: () => void;
  onRetry: () => void;
}

/**
 * 记忆复盘总结紧凑状态条：记忆/洞见/待整理指标 + 开关状态 + 手动复盘总结与运行记录入口。
 */
export function DreamStatusCard({
  status,
  loading,
  error,
  memoryCount,
  insightCount,
  canManage,
  running,
  onRun,
  onOpenSettings,
  onOpenRuns,
  onRetry,
}: DreamStatusCardProps) {
  const settings = status?.settings;
  const enabled = settings?.enabled ?? false;
  const lastAt = settings?.lastAt ?? status?.lastRun?.startedAt;
  const lastRun = status?.lastRun;
  const initialLoading = loading && !status;

  return (
    <Card pad className="memory-status-strip">
      <div className="memory-metrics">
        <div>
          <strong>{fmtInt(memoryCount)}</strong>
          <span>记忆</span>
        </div>
        <div>
          <strong>{fmtInt(insightCount)}</strong>
          <span>洞见</span>
        </div>
        <div>
          <strong>{status ? fmtInt(status.pendingCount) : '—'}</strong>
          <span>待整理</span>
        </div>
      </div>

      {initialLoading ? (
        <div className="memory-dream-inline">
          <Skeleton w={300} h={26} style={{ borderRadius: 999 }} />
        </div>
      ) : status ? (
        <div className="memory-dream-inline">
          <Badge tone={enabled ? 'green' : 'slate'} dot>
            {enabled ? '复盘总结已启用' : '复盘总结已停用'}
          </Badge>
          <span className="tiny dim">
            每 {enabled ? intervalLabel(settings?.intervalMinutes) : '—'} · 上次{' '}
            {lastAt ? fmtRelative(lastAt) : '尚未'}
          </span>
          {canManage ? (
            <Button size="sm" variant="ghost" icon="settings" onClick={onOpenSettings}>
              设置
            </Button>
          ) : null}
          {canManage ? (
            <Button
              size="sm"
              variant="primary"
              icon="sparkles"
              loading={running}
              disabled={running}
              onClick={onRun}
            >
              立即复盘
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon="list" onClick={onOpenRuns}>
            查看记录
          </Button>
        </div>
      ) : null}

      {error ? (
        <Callout tone="red" icon="alert">
          <div className="vstack gap-8">
            <span>复盘总结状态加载失败：{error}</span>
            <div>
              <Button size="sm" variant="outline" icon="refresh" onClick={onRetry}>
                重试
              </Button>
            </div>
          </div>
        </Callout>
      ) : lastRun?.status === 'failed' ? (
        <Callout tone="amber" icon="alert">
          上次复盘总结失败：{lastRun.error ?? '未返回错误信息'}
        </Callout>
      ) : null}
    </Card>
  );
}
