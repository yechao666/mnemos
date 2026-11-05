import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../../../shared/src/types.ts';
import { HttpError } from '../http/respond.ts';

/**
 * 月度写入配额（memory_tokens）评估与强制。
 * 口径与统计页一致：usage_events 中本月（UTC 自然月）memory_tokens 累加。
 * 配额 <= 0 视为不限量；读请求不使用该逻辑。
 */

export interface QuotaState {
  projectId: string;
  used: number;
  limit: number;
  exceeded: boolean;
  /** 下月 1 日 00:00 UTC，额度重置时间 */
  resetAt: string;
  /** 距离重置的秒数，用于 Retry-After */
  retryAfter: number;
}

export function startOfUtcMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function startOfNextUtcMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** 本月已消耗的 memory_tokens（与项目统计/配额显示同一 SQL 口径）。 */
export function monthlyMemoryTokens(db: DatabaseSync, projectId: string, now: Date = new Date()): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(memory_tokens), 0) AS tokens FROM usage_events WHERE project_id = ? AND created_at >= ?',
    )
    .get(projectId, startOfUtcMonth(now).toISOString()) as unknown as { tokens: number } | undefined;
  return row?.tokens ?? 0;
}

export function evaluateProjectQuota(db: DatabaseSync, project: Project, now: Date = new Date()): QuotaState {
  const limit = Number(project.settings.monthlyQuota ?? 0);
  const used = monthlyMemoryTokens(db, project.id, now);
  const reset = startOfNextUtcMonth(now);
  const retryAfter = Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1_000));
  return {
    projectId: project.id,
    used,
    limit: Number.isFinite(limit) ? limit : 0,
    exceeded: Number.isFinite(limit) && limit > 0 && used >= limit,
    resetAt: reset.toISOString(),
    retryAfter,
  };
}

/** 配额耗尽时抛出 429 quota_exceeded（调用方应在抛出前写入 Retry-After 头）。 */
export function assertQuota(state: QuotaState): void {
  if (!state.exceeded) return;
  throw new HttpError(
    429,
    'quota_exceeded',
    `本月记忆写入额度已用尽（${state.used}/${state.limit} tokens），将于 ${state.resetAt.slice(0, 10)} 重置`,
    { used: state.used, limit: state.limit, resetAt: state.resetAt },
  );
}
