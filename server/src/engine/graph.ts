import type { DatabaseSync } from 'node:sqlite';
import type {
  EntityGraph,
  EntityGraphEdge,
  EntityGraphNode,
  EntityGraphQuery,
  EntityList,
  EntityListQuery,
  EntitySummary,
} from '../../../shared/src/types.ts';
import { engineErrors } from './errors.ts';
import { resolvePersonRow } from './persons.ts';
import { likeContains } from './rows.ts';

/**
 * v6.1 P2 实体 / 关系图查询。
 *
 * 数据来自写管线：jobs extract 写 `entities` + `memory_entities`，并对同一记忆内的实体
 * 两两写 `relations(relation='co_occurs')`。本模块只读聚合，不做 N+1：
 *  - 图：节点按关联记忆数排序（默认 100，最多 500），边只取两端都在节点集内的关系；
 *  - 实体列表：mention_count / 关联记忆数，支持 q 子串与 person 过滤。
 */

const DEFAULT_GRAPH_LIMIT = 100;
const MAX_GRAPH_LIMIT = 500;
const DEFAULT_ENTITY_LIMIT = 50;
const MAX_ENTITY_LIMIT = 200;
const MAX_EDGE_LIMIT = 2000;

export interface GraphNodeRow {
  id: string;
  name: string;
  type: string;
  mention_count: number;
  memories: number;
  salience: number;
}

export interface GraphEdgeRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation: string;
  weight: number;
}

interface EntityListRow {
  id: string;
  name: string;
  type: string;
  mention_count: number;
  memories: number;
  created_at: string;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}

function resolvePersonFilter(db: DatabaseSync, partitionId: string, personRef: string | undefined): string | null {
  if (!personRef) return null;
  const person = resolvePersonRow(db, partitionId, personRef);
  if (!person) throw engineErrors.notFound('人不存在');
  return person.id;
}

/** 构建分区（或某人视角）的实体关系图。 */
export function buildEntityGraph(db: DatabaseSync, query: EntityGraphQuery): EntityGraph {
  const limit = clampLimit(query.limit, DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT);
  const personId = resolvePersonFilter(db, query.partitionId, query.personId);

  const nodeConditions = ['e.partition_id = ?'];
  const nodeParams: (string | number)[] = [query.partitionId];
  if (personId) {
    nodeConditions.push('m.person_id = ?');
    nodeParams.push(personId);
  }
  const nodeRows = db
    .prepare(
      `SELECT e.id AS id, e.name AS name, e.type AS type, e.mention_count AS mention_count,
              COUNT(DISTINCT me.memory_id) AS memories,
              COALESCE(SUM(me.salience), 0) AS salience
         FROM entities e
         JOIN memory_entities me ON me.entity_id = e.id
         JOIN memories m ON m.id = me.memory_id
        WHERE ${nodeConditions.join(' AND ')}
        GROUP BY e.id
        ORDER BY memories DESC, salience DESC, e.mention_count DESC, e.id ASC
        LIMIT ?`,
    )
    .all(...nodeParams, limit) as unknown as GraphNodeRow[];

  const nodes: EntityGraphNode[] = nodeRows.map((row) => ({
    id: row.id,
    label: row.name,
    type: row.type,
    weight: Math.round(Number(row.salience) * 1000) / 1000,
    memories: row.memories,
  }));

  const nodeIds = nodes.map((node) => node.id);
  let edges: EntityGraphEdge[] = [];
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => '?').join(', ');
    const edgeConditions = [
      'r.partition_id = ?',
      `r.source_entity_id IN (${placeholders})`,
      `r.target_entity_id IN (${placeholders})`,
    ];
    const edgeParams: (string | number)[] = [query.partitionId, ...nodeIds, ...nodeIds];
    if (personId) {
      // 人级视角：关系边必须由该人的记忆产生（避免把同分区其他人的共现边混进来）。
      edgeConditions.push('(r.memory_id IS NULL OR r.memory_id IN (SELECT id FROM memories WHERE partition_id = ? AND person_id = ?))');
      edgeParams.push(query.partitionId, personId);
    }
    const edgeRows = db
      .prepare(
        `SELECT r.id AS id, r.source_entity_id AS source_entity_id,
                r.target_entity_id AS target_entity_id, r.relation AS relation, r.weight AS weight
           FROM relations r
          WHERE ${edgeConditions.join(' AND ')}
          ORDER BY r.weight DESC, r.id ASC
          LIMIT ?`,
      )
      .all(...edgeParams, Math.min(MAX_EDGE_LIMIT, limit * 4)) as unknown as GraphEdgeRow[];
    edges = edgeRows.map((row) => ({
      id: row.id,
      source: row.source_entity_id,
      target: row.target_entity_id,
      relation: row.relation,
      weight: row.weight,
    }));
  }

  const typeCounts = new Map<string, number>();
  for (const node of nodes) typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
  const topTypes = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
    .slice(0, 5);

  return {
    nodes,
    edges,
    stats: { nodes: nodes.length, edges: edges.length, topTypes },
  };
}

/** 实体列表（q 子串匹配 name/normalized；person 过滤走关联记忆）。 */
export function listEntities(db: DatabaseSync, query: EntityListQuery): EntityList {
  const limit = clampLimit(query.limit, DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT);
  const personId = resolvePersonFilter(db, query.partitionId, query.personId);
  const conditions = ['e.partition_id = ?'];
  const params: (string | number)[] = [query.partitionId];
  const join = personId
    ? 'JOIN memory_entities me ON me.entity_id = e.id JOIN memories m ON m.id = me.memory_id'
    : 'LEFT JOIN memory_entities me ON me.entity_id = e.id';
  if (personId) {
    conditions.push('m.person_id = ?');
    params.push(personId);
  }
  const q = (query.q ?? '').trim();
  if (q) {
    conditions.push("(e.name LIKE ? ESCAPE '\\' OR e.normalized LIKE ? ESCAPE '\\')");
    const pattern = likeContains(q.slice(0, 200));
    params.push(pattern, pattern);
  }

  const rows = db
    .prepare(
      `SELECT e.id AS id, e.name AS name, e.type AS type, e.mention_count AS mention_count,
              COUNT(DISTINCT me.memory_id) AS memories, e.created_at AS created_at
         FROM entities e
         ${join}
        WHERE ${conditions.join(' AND ')}
        GROUP BY e.id
        ORDER BY memories DESC, e.mention_count DESC, e.name ASC, e.id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as EntityListRow[];

  const items: EntitySummary[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    mentionCount: row.mention_count,
    memories: row.memories,
    createdAt: row.created_at,
  }));
  return { items, nextCursor: null };
}
