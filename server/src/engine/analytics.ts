/**
 * 图谱与项目统计（只读聚合）。
 * 全部字段严格对齐 ProjectStats / GraphData 契约。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { GraphData, GraphEdge, GraphNode, ProjectSettings, ProjectStats } from '../../../shared/src/types.ts';
import { isoDaysAgo } from '../lib/ids.ts';

function round(value: number, digits: number): number {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as unknown as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  return Number(value ?? 0);
}

/** 图谱：节点为 active 记忆中出现过的实体（按提及记忆数取前 limit）。 */
export function buildGraph(db: DatabaseSync, projectId: string, limit: number, graphEnabled = true): GraphData {
  const nodeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 40));
  const entities = countRows(db, 'SELECT COUNT(*) AS c FROM entities WHERE project_id = ?', projectId);
  const topTypes = db
    .prepare('SELECT type, COUNT(*) AS count FROM entities WHERE project_id = ? GROUP BY type ORDER BY count DESC, type ASC LIMIT 5')
    .all(projectId) as unknown as { type: string; count: number }[];

  const empty: GraphData = {
    nodes: [],
    edges: [],
    stats: { nodes: 0, edges: 0, entities, density: 0, topTypes: topTypes.map((row) => ({ type: row.type, count: Number(row.count) })) },
  };
  if (!graphEnabled) return empty;

  const nodeRows = db
    .prepare(
      `SELECT e.id, e.name, e.type, COUNT(DISTINCT me.memory_id) AS memories, e.mention_count
       FROM entities e
       JOIN memory_entities me ON me.entity_id = e.id
       JOIN memories m ON m.id = me.memory_id AND m.status = 'active' AND m.project_id = e.project_id
       WHERE e.project_id = ?
       GROUP BY e.id
       ORDER BY memories DESC, e.mention_count DESC, e.name ASC
       LIMIT ?`,
    )
    .all(projectId, nodeLimit) as unknown as { id: string; name: string; type: string; memories: number; mention_count: number }[];
  if (nodeRows.length === 0) return empty;

  const maxMemories = Math.max(1, ...nodeRows.map((row) => Number(row.memories)));
  const nodes: GraphNode[] = nodeRows.map((row) => ({
    id: row.id,
    label: row.name,
    type: row.type,
    weight: round(Number(row.memories) / maxMemories, 3),
    memories: Number(row.memories),
  }));

  const nodeIds = nodeRows.map((row) => row.id);
  const placeholders = nodeIds.map(() => '?').join(', ');
  const edgeRows = db
    .prepare(
      `SELECT r.id, r.source_entity_id, r.target_entity_id, r.relation, r.weight
       FROM relations r
       LEFT JOIN memories m ON m.id = r.memory_id
       WHERE r.project_id = ?
         AND (r.memory_id IS NULL OR m.status = 'active')
         AND r.source_entity_id IN (${placeholders})
         AND r.target_entity_id IN (${placeholders})
       ORDER BY r.weight DESC, r.id ASC
       LIMIT 1200`,
    )
    .all(projectId, ...nodeIds, ...nodeIds) as unknown as {
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    relation: string;
    weight: number;
  }[];

  const maxWeight = Math.max(1e-6, ...edgeRows.map((row) => Number(row.weight)));
  const edges: GraphEdge[] = edgeRows.map((row) => ({
    id: row.id,
    source: row.source_entity_id,
    target: row.target_entity_id,
    relation: row.relation,
    weight: round(Number(row.weight) / maxWeight, 3),
  }));

  // 密度按「不同节点对」计算：同一对实体可能有多条不同关系标签
  const n = nodes.length;
  const pairs = new Set(edges.map((edge) => (edge.source < edge.target ? `${edge.source}|${edge.target}` : `${edge.target}|${edge.source}`)));
  const density = n > 1 ? round(pairs.size / ((n * (n - 1)) / 2), 3) : 0;
  return {
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      entities,
      density,
      topTypes: topTypes.map((row) => ({ type: row.type, count: Number(row.count) })),
    },
  };
}

/** 项目统计（ProjectStats 全字段）。 */
export function buildStats(db: DatabaseSync, projectId: string, settings: ProjectSettings): ProjectStats {
  const memories = countRows(db, "SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND status = 'active'", projectId);
  const users = countRows(
    db,
    "SELECT COUNT(DISTINCT user_id) AS c FROM memories WHERE project_id = ? AND status = 'active' AND user_id IS NOT NULL",
    projectId,
  );
  const agents = countRows(
    db,
    "SELECT COUNT(DISTINCT agent_id) AS c FROM memories WHERE project_id = ? AND status = 'active' AND agent_id IS NOT NULL",
    projectId,
  );
  const entities = countRows(db, 'SELECT COUNT(*) AS c FROM entities WHERE project_id = ?', projectId);
  const relations = countRows(db, 'SELECT COUNT(*) AS c FROM relations WHERE project_id = ?', projectId);

  const since7 = isoDaysAgo(7);
  const since14 = isoDaysAgo(14);
  const usageRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN operation = 'search' THEN 1 ELSE 0 END), 0) AS searches,
         COALESCE(SUM(CASE WHEN operation = 'add' THEN 1 ELSE 0 END), 0) AS adds,
         COALESCE(SUM(CASE WHEN operation = 'search' AND result_count > 0 THEN 1 ELSE 0 END), 0) AS search_hits
       FROM usage_events WHERE project_id = ? AND created_at >= ?`,
    )
    .get(projectId, since7) as unknown as { searches: number; adds: number; search_hits: number } | undefined;
  const searches7d = Number(usageRow?.searches ?? 0);
  const adds7d = Number(usageRow?.adds ?? 0);
  const searchHits = Number(usageRow?.search_hits ?? 0);

  const latencies = (
    db
      .prepare(
        `SELECT latency_ms FROM usage_events
         WHERE project_id = ? AND operation = 'search' AND created_at >= ?
         ORDER BY latency_ms ASC, id ASC`,
      )
      .all(projectId, since7) as unknown as { latency_ms: number }[]
  ).map((row) => Number(row.latency_ms));
  const percentile = (p: number): number => {
    if (latencies.length === 0) return 0;
    const index = Math.min(latencies.length - 1, Math.max(0, Math.ceil(p * latencies.length) - 1));
    return Math.round(latencies[index]);
  };

  const prevAdds = countRows(
    db,
    "SELECT COUNT(*) AS c FROM usage_events WHERE project_id = ? AND operation = 'add' AND created_at >= ? AND created_at < ?",
    projectId,
    since14,
    since7,
  );
  const growthPct = prevAdds > 0 ? round(((adds7d - prevAdds) / prevAdds) * 100, 1) : adds7d > 0 ? 100 : 0;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const tokensSaved = countRows(
    db,
    'SELECT COALESCE(SUM(memory_tokens), 0) AS c FROM usage_events WHERE project_id = ? AND created_at >= ?',
    projectId,
    monthStart,
  );

  const memoryAgg = db
    .prepare(
      `SELECT
         COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) AS content_bytes,
         COALESCE(SUM(COALESCE(dim, 0) * 4), 0) AS vector_bytes
       FROM memories WHERE project_id = ? AND status = 'active'`,
    )
    .get(projectId) as unknown as { content_bytes: number; vector_bytes: number } | undefined;
  const termAgg = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(mt.term)), 0) AS bytes
       FROM memory_terms mt
       JOIN memories m ON m.id = mt.memory_id AND m.status = 'active'
       WHERE mt.project_id = ?`,
    )
    .get(projectId) as unknown as { c: number; bytes: number } | undefined;
  const storageBytes = Math.round(
    Number(memoryAgg?.content_bytes ?? 0) + Number(memoryAgg?.vector_bytes ?? 0) + Number(termAgg?.c ?? 0) * 8 + Number(termAgg?.bytes ?? 0) * 2,
  );

  const quotaUsedPct = round((tokensSaved / Math.max(1, settings.monthlyQuota)) * 100, 1);
  const hitRate = searches7d > 0 ? round(searchHits / searches7d, 3) : 0;

  const activity = db
    .prepare(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(updated_at) AS at FROM memories WHERE project_id = ?
         UNION ALL
         SELECT MAX(created_at) AS at FROM usage_events WHERE project_id = ?
       )`,
    )
    .get(projectId, projectId) as unknown as { at: string | null } | undefined;

  const stats: ProjectStats = {
    memories,
    users,
    agents,
    entities,
    relations,
    searches7d,
    adds7d,
    tokensSaved,
    storageBytes,
    quotaUsedPct,
    recallP50Ms: percentile(0.5),
    recallP95Ms: percentile(0.95),
    hitRate,
    growthPct,
    lastActivityAt: activity?.at ?? undefined,
  };
  return stats;
}
