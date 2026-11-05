import type { DatabaseSync } from 'node:sqlite';
import type { UsageAnalytics, UsageBreakdownRow, UsagePoint } from '../../../../shared/src/types.ts';
import { percentile, round } from '../respond.ts';

/** 用量聚合：按天时间序列、按操作/渠道/密钥拆分、延迟分位。 */

interface UsageRow {
  created_at: string;
  operation: string;
  channel: string;
  api_key_id: string | null;
  latency_ms: number;
  status: number;
  result_count: number;
  memory_tokens: number;
}

export interface UsageTotals {
  adds: number;
  searches: number;
  retrievals: number;
  tokens: number;
  errors: number;
  errorRate: number;
}

const RETRIEVAL_OPERATIONS = new Set(['list', 'get', 'graph']);

function inClause(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function dayStart(daysAgo: number): Date {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date;
}

export function blankUsagePoints(days: number): UsagePoint[] {
  const points: UsagePoint[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    points.push({ date: dayStart(offset).toISOString().slice(0, 10), adds: 0, searches: 0, retrievals: 0, tokens: 0, errors: 0 });
  }
  return points;
}

function rangeStartIso(days: number): string {
  return dayStart(Math.max(0, days - 1)).toISOString();
}

export function usagePoints(db: DatabaseSync, projectIds: string[], days: number): UsagePoint[] {
  const clampedDays = Math.min(90, Math.max(1, Math.trunc(days)));
  const points = blankUsagePoints(clampedDays);
  if (projectIds.length === 0) return points;
  const byDate = new Map(points.map((point) => [point.date, point]));

  const rows = db
    .prepare(
      `SELECT created_at, operation, status, memory_tokens
         FROM usage_events
        WHERE project_id IN (${inClause(projectIds.length)}) AND created_at >= ?`,
    )
    .all(...projectIds, rangeStartIso(clampedDays)) as unknown as Array<{
    created_at: string;
    operation: string;
    status: number;
    memory_tokens: number;
  }>;

  for (const row of rows) {
    const point = byDate.get(row.created_at.slice(0, 10));
    if (!point) continue;
    if (row.operation === 'add') point.adds += 1;
    else if (row.operation === 'search') point.searches += 1;
    else if (RETRIEVAL_OPERATIONS.has(row.operation)) point.retrievals += 1;
    point.tokens += row.memory_tokens ?? 0;
    if (row.status >= 400) point.errors += 1;
  }

  return points;
}

function breakdown(
  rows: UsageRow[],
  keyOf: (row: UsageRow) => string,
  total: number,
): UsageBreakdownRow[] {
  const buckets = new Map<string, { count: number; latencies: number[] }>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = buckets.get(key) ?? { count: 0, latencies: [] };
    bucket.count += 1;
    bucket.latencies.push(row.latency_ms ?? 0);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([label, bucket]) => ({
      label,
      count: bucket.count,
      share: total > 0 ? round(bucket.count / total, 3) : 0,
      latencyP50: percentile(bucket.latencies, 0.5),
    }))
    .sort((a, b) => b.count - a.count);
}

export function usageAnalytics(db: DatabaseSync, projectId: string, days: number): UsageAnalytics {
  const clampedDays = Math.min(90, Math.max(1, Math.trunc(days)));
  const points = blankUsagePoints(clampedDays);
  const byDate = new Map(points.map((point) => [point.date, point]));

  const rows = db
    .prepare(
      `SELECT created_at, operation, channel, api_key_id, latency_ms, status, result_count, memory_tokens
         FROM usage_events
        WHERE project_id = ? AND created_at >= ?
        ORDER BY created_at ASC`,
    )
    .all(projectId, rangeStartIso(clampedDays)) as unknown as UsageRow[];

  const totals: UsageTotals = { adds: 0, searches: 0, retrievals: 0, tokens: 0, errors: 0, errorRate: 0 };
  for (const row of rows) {
    const point = byDate.get(row.created_at.slice(0, 10));
    if (point) {
      if (row.operation === 'add') point.adds += 1;
      else if (row.operation === 'search') point.searches += 1;
      else if (RETRIEVAL_OPERATIONS.has(row.operation)) point.retrievals += 1;
      point.tokens += row.memory_tokens ?? 0;
      if (row.status >= 400) point.errors += 1;
    }
    if (row.operation === 'add') totals.adds += 1;
    else if (row.operation === 'search') totals.searches += 1;
    else if (RETRIEVAL_OPERATIONS.has(row.operation)) totals.retrievals += 1;
    totals.tokens += row.memory_tokens ?? 0;
    if (row.status >= 400) totals.errors += 1;
  }
  totals.errorRate = rows.length > 0 ? round(totals.errors / rows.length, 4) : 0;

  const keyRows = db.prepare('SELECT id, name FROM api_keys WHERE project_id = ?').all(projectId) as unknown as Array<{
    id: string;
    name: string;
  }>;
  const keyNames = new Map(keyRows.map((row) => [row.id, row.name]));
  const allLatencies = rows.map((row) => row.latency_ms ?? 0);

  return {
    points,
    byOperation: breakdown(rows, (row) => row.operation, rows.length),
    byChannel: breakdown(rows, (row) => row.channel, rows.length),
    byKey: breakdown(rows, (row) => (row.api_key_id ? keyNames.get(row.api_key_id) ?? '已删除密钥' : '控制台会话'), rows.length),
    latency: {
      p50: percentile(allLatencies, 0.5),
      p95: percentile(allLatencies, 0.95),
      p99: percentile(allLatencies, 0.99),
    },
    totals,
  };
}

export interface DashboardUsageTotals {
  searches7d: number;
  adds7d: number;
  tokensSaved: number;
  p50: number;
  errorRate: number;
}

/** 仪表盘用的跨项目聚合（近 7 天 + 近 30 天 token 节省）。 */
export function aggregateUsageTotals(db: DatabaseSync, projectIds: string[]): DashboardUsageTotals {
  if (projectIds.length === 0) return { searches7d: 0, adds7d: 0, tokensSaved: 0, p50: 0, errorRate: 0 };
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const placeholders = inClause(projectIds.length);

  const opRows = db
    .prepare(
      `SELECT operation AS op, COUNT(*) AS c FROM usage_events
        WHERE project_id IN (${placeholders}) AND created_at >= ?
        GROUP BY operation`,
    )
    .all(...projectIds, weekAgo) as unknown as Array<{ op: string; c: number }>;

  const statusRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
         FROM usage_events WHERE project_id IN (${placeholders}) AND created_at >= ?`,
    )
    .get(...projectIds, weekAgo) as unknown as { total: number; errors: number } | undefined;

  const latencyRows = db
    .prepare(
      `SELECT latency_ms AS ms FROM usage_events
        WHERE project_id IN (${placeholders}) AND operation = 'search' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 500`,
    )
    .all(...projectIds, weekAgo) as unknown as Array<{ ms: number }>;

  const tokensRow = db
    .prepare(
      `SELECT COALESCE(SUM(memory_tokens), 0) AS tokens FROM usage_events
        WHERE project_id IN (${placeholders}) AND operation = 'search' AND created_at >= ?`,
    )
    .get(...projectIds, monthAgo) as unknown as { tokens: number } | undefined;

  const searches7d = opRows.find((row) => row.op === 'search')?.c ?? 0;
  const adds7d = opRows.find((row) => row.op === 'add')?.c ?? 0;
  const total = statusRow?.total ?? 0;
  const errors = statusRow?.errors ?? 0;

  return {
    searches7d,
    adds7d,
    tokensSaved: tokensRow?.tokens ?? 0,
    p50: percentile(
      latencyRows.map((row) => row.ms ?? 0),
      0.5,
    ),
    errorRate: total > 0 ? round(errors / total, 4) : 0,
  };
}
