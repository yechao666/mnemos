import type { ReactNode } from 'react';
import type { MaintenanceRun } from '@shared';
import type { Tone } from '@ui';
import { fmtMs } from '@lib/format.ts';

/** 毫秒运行时长 → 中文可读时长。 */
export function fmtUptime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

/**
 * 数据库路径脱敏：仅保留根目录与文件名，隐藏部署目录层级。
 * 完整路径仅出现在服务端启动日志中，避免控制台泄露主机目录结构。
 */
export function maskDbPath(path: string | null | undefined): string {
  const trimmed = (path ?? '').trim();
  if (!trimmed) return '—';
  const normalized = trimmed.replace(/^sqlite:/, '').replace(/^file:/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  const head = parts[0] ?? '';
  const file = parts[parts.length - 1] ?? '';
  return `/${head}/…/${file}`;
}

/** 配额使用率配色：>100% 红、>85% 琥珀。 */
export function quotaTone(usedPct: number): Tone {
  if (usedPct > 100) return 'red';
  if (usedPct > 85) return 'amber';
  return 'violet';
}

export function quotaLabel(usedPct: number): string {
  if (usedPct > 100) return '已超额';
  if (usedPct > 85) return '接近上限';
  return '正常';
}

const MAINTENANCE_STATUS: Record<MaintenanceRun['status'], { label: string; tone: Tone }> = {
  running: { label: '执行中', tone: 'blue' },
  success: { label: '成功', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
};

export function maintenanceStatusMeta(status: MaintenanceRun['status']): { label: string; tone: Tone } {
  return MAINTENANCE_STATUS[status] ?? { label: status, tone: 'slate' };
}

const MAINTENANCE_KINDS: Record<string, string> = {
  manual: '手动维护',
  scheduled: '定时维护',
  preflight: '备份前检查',
  retention: '保留期归档',
  cleanup: '数据清理',
};

export function maintenanceKindLabel(kind: string): string {
  return MAINTENANCE_KINDS[kind] ?? kind;
}

const SUMMARY_KEYS: { key: string; label: string }[] = [
  { key: 'expiredArchived', label: '归档过期' },
  { key: 'deletedPurged', label: '清理已删除' },
  { key: 'idempotencyPurged', label: '清理幂等记录' },
  { key: 'sessionsPurged', label: '清理会话' },
];

/** 维护摘要 → 中文短语（未知字段不展示，避免泄露内部结构）。 */
export function summarizeMaintenance(run: MaintenanceRun): string {
  const summary = run.summary ?? {};
  const parts: string[] = [];
  if (summary.dryRun === true) parts.push('演练');
  for (const item of SUMMARY_KEYS) {
    const value = summary[item.key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      parts.push(`${item.label} ${Math.round(value)}`);
    }
  }
  if (summary.walCheckpointed === true) parts.push('WAL 检查点');
  if (summary.vacuumed === true) parts.push('VACUUM');
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** 维护耗时：优先按开始/结束时间计算，其次读取摘要中的 durationMs。 */
export function maintenanceDuration(run: MaintenanceRun): string {
  const started = Date.parse(run.startedAt);
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
    return fmtMs(finished - started);
  }
  const raw = run.summary?.durationMs;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return fmtMs(raw);
  return run.status === 'running' ? '进行中' : '—';
}

/** 运维卡片内统一的两列指标项。 */
export function Metric({ label, value, mono }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}
