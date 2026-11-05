import type { DatabaseSync } from 'node:sqlite';
import type { Project, ProjectStats } from '../../../../shared/src/types.ts';
import { percentile, round } from '../respond.ts';

/** 项目级统计聚合：项目列表 / 概览 / 仪表盘 / 公开 v1 共用同一口径。 */

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function startOfUtcMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

interface MemoryAggregateRow {
  active: number;
  recent: number;
  previous: number;
  users: number;
  agents: number;
  storage: number;
  last_memory_at: string | null;
}

interface UsageAggregateRow {
  op: string;
  c: number;
  tokens: number;
  hits: number;
}

export function computeProjectStats(db: DatabaseSync, project: Project): ProjectStats {
  const weekAgo = isoDaysAgo(7);
  const twoWeeksAgo = isoDaysAgo(14);
  const monthAgo = isoDaysAgo(30);

  const memory = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS recent,
         COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS previous,
         COUNT(DISTINCT CASE WHEN user_id IS NOT NULL THEN user_id END) AS users,
         COUNT(DISTINCT CASE WHEN agent_id IS NOT NULL THEN agent_id END) AS agents,
         COALESCE(SUM(LENGTH(content) + COALESCE(LENGTH(embedding), 0)), 0) AS storage,
         MAX(updated_at) AS last_memory_at
       FROM memories WHERE project_id = ?`,
    )
    .get(weekAgo, twoWeeksAgo, weekAgo, project.id) as unknown as MemoryAggregateRow | undefined;

  const entityRow = db.prepare('SELECT COUNT(*) AS c FROM entities WHERE project_id = ?').get(project.id) as unknown as
    | { c: number }
    | undefined;
  const relationRow = db.prepare('SELECT COUNT(*) AS c FROM relations WHERE project_id = ?').get(project.id) as unknown as
    | { c: number }
    | undefined;

  const usageRows = db
    .prepare(
      `SELECT operation AS op,
              COUNT(*) AS c,
              COALESCE(SUM(memory_tokens), 0) AS tokens,
              COALESCE(SUM(CASE WHEN result_count > 0 THEN 1 ELSE 0 END), 0) AS hits
         FROM usage_events
        WHERE project_id = ? AND created_at >= ?
        GROUP BY operation`,
    )
    .all(project.id, weekAgo) as unknown as UsageAggregateRow[];

  const latencyRows = db
    .prepare(
      `SELECT latency_ms AS ms FROM usage_events
        WHERE project_id = ? AND operation = 'search' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 500`,
    )
    .all(project.id, weekAgo) as unknown as { ms: number }[];

  const monthTokensRow = db
    .prepare('SELECT COALESCE(SUM(memory_tokens), 0) AS tokens FROM usage_events WHERE project_id = ? AND created_at >= ?')
    .get(project.id, startOfUtcMonth()) as unknown as { tokens: number } | undefined;

  const savedRow = db
    .prepare(
      `SELECT COALESCE(SUM(memory_tokens), 0) AS tokens FROM usage_events
        WHERE project_id = ? AND operation = 'search' AND created_at >= ?`,
    )
    .get(project.id, monthAgo) as unknown as { tokens: number } | undefined;

  const lastUsageRow = db
    .prepare('SELECT MAX(created_at) AS at FROM usage_events WHERE project_id = ?')
    .get(project.id) as unknown as { at: string | null } | undefined;
  const lastAuditRow = db
    .prepare('SELECT MAX(created_at) AS at FROM audit_logs WHERE project_id = ?')
    .get(project.id) as unknown as { at: string | null } | undefined;

  const searchRow = usageRows.find((row) => row.op === 'search');
  const addRow = usageRows.find((row) => row.op === 'add');
  const searches7d = searchRow?.c ?? 0;
  const adds7d = addRow?.c ?? 0;
  const latencies = latencyRows.map((row) => row.ms ?? 0);
  const quota = project.settings.monthlyQuota ?? 0;
  const monthTokens = monthTokensRow?.tokens ?? 0;
  const active = memory?.active ?? 0;
  const recent = memory?.recent ?? 0;
  const previous = memory?.previous ?? 0;

  const lastActivityCandidates = [memory?.last_memory_at, lastUsageRow?.at, lastAuditRow?.at].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const lastActivityAt = lastActivityCandidates.length > 0 ? lastActivityCandidates.sort().at(-1) : undefined;

  return {
    memories: active,
    users: memory?.users ?? 0,
    agents: memory?.agents ?? 0,
    entities: entityRow?.c ?? 0,
    relations: relationRow?.c ?? 0,
    searches7d,
    adds7d,
    tokensSaved: savedRow?.tokens ?? 0,
    storageBytes: memory?.storage ?? 0,
    quotaUsedPct: quota > 0 ? round((monthTokens / quota) * 100, 1) : 0,
    recallP50Ms: percentile(latencies, 0.5),
    recallP95Ms: percentile(latencies, 0.95),
    hitRate: searches7d > 0 ? round((searchRow?.hits ?? 0) / searches7d, 3) : 0,
    growthPct: previous > 0 ? round(((recent - previous) / previous) * 100, 1) : recent > 0 ? 100 : 0,
    lastActivityAt,
  };
}
