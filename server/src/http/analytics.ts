import type { DatabaseSync } from 'node:sqlite';
import type {
  AuditLog,
  CursorPage,
  UsageAnalytics,
  UsageBreakdownRow,
  UsagePoint,
} from '../../../shared/src/types.ts';
import { decodeCursor, encodeCursor, normalizeLimit } from '../engine/cursor.ts';
import { toAuditLog, type AuditRow } from './mappers.ts';
import { percentile, round } from './respond.ts';

/** 用量与审计查询（控制台 /api）。 */

const RETRIEVAL_OPS = new Set(['list', 'get', 'brief', 'context', 'retrieve', 'stats']);

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function dayRange(days: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(start.getTime() - index * 86_400_000);
    keys.push(date.toISOString().slice(0, 10));
  }
  return keys;
}

function breakdown(map: Map<string, { count: number }>, total: number): UsageBreakdownRow[] {
  return [...map.entries()]
    .map(([label, value]) => ({
      label,
      count: value.count,
      share: total > 0 ? round(value.count / total, 4) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

export function partitionUsage(db: DatabaseSync, partitionId: string, days: number): UsageAnalytics {
  const safeDays = Math.min(90, Math.max(1, Math.trunc(days)));
  const since = `${dayRange(safeDays)[0]}T00:00:00.000Z`;
  const rows = db
    .prepare(
      `SELECT created_at, operation, channel, status, latency_ms, memory_tokens, api_key_id
         FROM usage_events
        WHERE partition_id = ? AND created_at >= ?`,
    )
    .all(partitionId, since) as unknown as Array<{
    created_at: string;
    operation: string;
    channel: string;
    status: number;
    latency_ms: number;
    memory_tokens: number;
    api_key_id: string | null;
  }>;

  const points = new Map<string, UsagePoint>();
  for (const key of dayRange(safeDays)) {
    points.set(key, { date: key, adds: 0, searches: 0, retrievals: 0, tokens: 0, errors: 0 });
  }
  const byOperation = new Map<string, { count: number }>();
  const byChannel = new Map<string, { count: number }>();
  const byKey = new Map<string, { count: number }>();
  const latencies: number[] = [];
  let adds = 0;
  let searches = 0;
  let retrievals = 0;
  let tokens = 0;
  let errors = 0;

  for (const row of rows) {
    const key = dayKey(row.created_at);
    const point = points.get(key);
    if (point) {
      if (row.operation === 'add') point.adds += 1;
      else if (row.operation === 'search') point.searches += 1;
      else if (RETRIEVAL_OPS.has(row.operation)) point.retrievals += 1;
      point.tokens += row.memory_tokens;
      if (row.status >= 400) point.errors += 1;
    }
    if (row.operation === 'add') adds += 1;
    else if (row.operation === 'search') searches += 1;
    else if (RETRIEVAL_OPS.has(row.operation)) retrievals += 1;
    tokens += row.memory_tokens;
    if (row.status >= 400) errors += 1;

    byOperation.set(row.operation, { count: (byOperation.get(row.operation)?.count ?? 0) + 1 });
    byChannel.set(row.channel, { count: (byChannel.get(row.channel)?.count ?? 0) + 1 });
    if (row.api_key_id) byKey.set(row.api_key_id, { count: (byKey.get(row.api_key_id)?.count ?? 0) + 1 });
    if (Number.isFinite(row.latency_ms)) latencies.push(row.latency_ms);
  }

  // api_key_id → 名称
  const keyNames = new Map<string, string>();
  if (byKey.size > 0) {
    const placeholders = [...byKey.keys()].map(() => '?').join(', ');
    const keyRows = db
      .prepare(`SELECT id, name FROM api_keys WHERE id IN (${placeholders})`)
      .all(...byKey.keys()) as unknown as Array<{ id: string; name: string }>;
    for (const row of keyRows) keyNames.set(row.id, row.name);
  }
  const byKeyNamed = new Map<string, { count: number }>();
  for (const [id, value] of byKey) byKeyNamed.set(keyNames.get(id) ?? id, value);

  const total = rows.length;
  return {
    points: [...points.values()],
    byOperation: breakdown(byOperation, total),
    byChannel: breakdown(byChannel, total),
    byKey: breakdown(byKeyNamed, total),
    latency: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    totals: {
      adds,
      searches,
      retrievals,
      tokens,
      errors,
      errorRate: total > 0 ? round(errors / total, 4) : 0,
    },
  };
}

/** 分区审计：游标（created_at DESC, id DESC）。 */
export function listAudit(
  db: DatabaseSync,
  partitionId: string,
  input: { cursor?: string; limit?: number } = {},
): CursorPage<AuditLog> {
  const limit = normalizeLimit(input.limit);
  const where = ['partition_id = ?'];
  const params: (string | number)[] = [partitionId];
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, 'recent');
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = db
    .prepare(
      `SELECT * FROM audit_logs
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as unknown as AuditRow[];
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(toAuditLog);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ v: last.createdAt, id: last.id, s: 'recent' }) : null,
  };
}
