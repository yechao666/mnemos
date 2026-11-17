import type { DatabaseSync } from 'node:sqlite';
import type { Partition } from '../../../shared/src/types.ts';
import { HttpError } from '../http/respond.ts';

/**
 * 月度写入配额（memory_tokens）评估与强制。
 * 口径：usage_events 中本月（UTC 自然月）memory_tokens 累加；配额 <= 0 视为不限量。
 */

export interface QuotaState {
  partitionId: string;
  used: number;
  limit: number;
  exceeded: boolean;
  resetAt: string;
  retryAfter: number;
}

export function startOfUtcMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function startOfNextUtcMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function monthlyMemoryTokens(db: DatabaseSync, partitionId: string, now: Date = new Date()): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(memory_tokens), 0) AS tokens FROM usage_events WHERE partition_id = ? AND created_at >= ?',
    )
    .get(partitionId, startOfUtcMonth(now).toISOString()) as unknown as { tokens: number } | undefined;
  return row?.tokens ?? 0;
}

export function evaluatePartitionQuota(db: DatabaseSync, partition: Partition, now: Date = new Date()): QuotaState {
  const limit = Number(partition.settings.monthlyQuota ?? 0);
  const used = monthlyMemoryTokens(db, partition.id, now);
  const reset = startOfNextUtcMonth(now);
  return {
    partitionId: partition.id,
    used,
    limit: Number.isFinite(limit) ? limit : 0,
    exceeded: Number.isFinite(limit) && limit > 0 && used >= limit,
    resetAt: reset.toISOString(),
    retryAfter: Math.max(1, Math.ceil((reset.getTime() - now.getTime()) / 1_000)),
  };
}

/** 配额耗尽时抛出 429 QUOTA_EXCEEDED（调用方应在抛出前写 Retry-After 头）。 */
export function assertQuota(state: QuotaState): void {
  if (!state.exceeded) return;
  throw new HttpError(
    429,
    'QUOTA_EXCEEDED',
    `本月记忆写入额度已用尽（${state.used}/${state.limit} tokens），将于 ${state.resetAt.slice(0, 10)} 重置`,
    { used: state.used, limit: state.limit, resetAt: state.resetAt },
  );
}
