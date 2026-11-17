/**
 * 只读查询：列表分页、历史、实体、关系与邻居。
 * 全部使用 prepared statement 参数化；不做任何写入。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  EntityRef,
  ListMemoriesInput,
  Memory,
  MemoryHistoryEntry,
  Paginated,
  Relation,
} from '../../../shared/src/types.ts';
import { escapeLike } from '../lib/ids.ts';
import { chunk, mapHistory, mapMemory, visibilityClause, type HistoryRow, type MemoryRow } from './store.ts';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * 列表查询的内部扩展：personId/scope 已在 service 层解析为内部 id，
 * 并附带调用方视角（本人 person / 会话）用于可见性判定。
 */
export interface ListMemoriesQuery extends ListMemoriesInput {
  /** 已解析的 person 内部 id（按人筛选） */
  personFilterId?: string;
  /** 调用方本人（person 内部 id） */
  callerPersonId?: string | null;
  /** 调用方会话 id（由 taskId 泛化而来） */
  sessionId?: string | null;
}

/** 列表分页（默认只看 active，按 sort 排序）。 */
export function listMemories(db: DatabaseSync, input: ListMemoriesQuery): Paginated<Memory> {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE)));
  const where: string[] = ['m.project_id = ?'];
  const params: (string | number)[] = [input.projectId];

  where.push('m.status = ?');
  params.push(input.status ?? 'active');
  if (input.personFilterId !== undefined) {
    where.push('m.person_id = ?');
    params.push(input.personFilterId);
  }
  if (input.userId !== undefined) {
    where.push('m.user_id = ?');
    params.push(input.userId);
  }
  if (input.writtenByAgentId !== undefined) {
    where.push('m.agent_id = ?');
    params.push(input.writtenByAgentId);
  }
  if (input.runId !== undefined) {
    where.push('m.run_id = ?');
    params.push(input.runId);
  }
  if (input.taskId !== undefined) {
    where.push('m.task_id = ?');
    params.push(input.taskId);
  }
  const visible = visibilityClause({
    callerPersonId: input.callerPersonId,
    callerSessionId: input.sessionId,
    agentId: input.agentId,
    taskId: input.taskId,
    scope: input.scope,
    visibility: input.visibility,
    includePrivate: input.includePrivate,
  });
  if (visible.sql) {
    where.push(visible.sql);
    params.push(...visible.params);
  }
  if (input.category) {
    where.push('m.category = ?');
    params.push(input.category);
  }
  if (input.q && input.q.trim()) {
    where.push("m.content LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(input.q.trim())}%`);
  }

  const clause = where.join(' AND ');
  let orderBy = 'm.created_at DESC, m.id DESC';
  if (input.sort === 'importance') orderBy = 'm.importance DESC, m.created_at DESC, m.id DESC';
  else if (input.sort === 'accessed') orderBy = 'm.last_accessed_at IS NULL, m.last_accessed_at DESC, m.created_at DESC, m.id DESC';

  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM memories m WHERE ${clause}`).get(...params) as unknown as { c: number } | undefined;
  const total = Number(countRow?.c ?? 0);
  const rows = db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m LEFT JOIN persons p ON p.id = m.person_id
        WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as MemoryRow[];

  return {
    items: rows.map(mapMemory),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** 记忆变更历史（最新在前）。 */
export function listHistory(db: DatabaseSync, projectId: string, memoryId: string, limit = 100): MemoryHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_history WHERE project_id = ? AND memory_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(projectId, memoryId, limit) as unknown as HistoryRow[];
  return rows.map(mapHistory);
}

interface EntityRow {
  id: string;
  name: string;
  type: string;
  mention_count: number;
}

/** 记忆关联的实体（按 salience 排序）。 */
export function listMemoryEntities(db: DatabaseSync, projectId: string, memoryId: string): EntityRef[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.type, e.mention_count
       FROM memory_entities me
       JOIN entities e ON e.id = me.entity_id
       WHERE me.memory_id = ? AND e.project_id = ?
       ORDER BY me.salience DESC, e.mention_count DESC, e.name ASC`,
    )
    .all(memoryId, projectId) as unknown as EntityRow[];
  return rows.map((row) => ({ id: row.id, name: row.name, type: row.type, mentionCount: Number(row.mention_count) }));
}

interface RelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation: string;
  memory_id: string | null;
  weight: number;
  created_at: string;
}

function mapRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relation: row.relation,
    memoryId: row.memory_id ?? undefined,
    weight: Number(row.weight),
    createdAt: row.created_at,
  };
}

/** 与给定实体集合相关的边（两个方向）。 */
export function listRelationsForEntities(db: DatabaseSync, projectId: string, entityIds: string[]): Relation[] {
  if (entityIds.length === 0) return [];
  const relations: Relation[] = [];
  for (const ids of chunk(entityIds, 400)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT * FROM relations
         WHERE project_id = ? AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))
         ORDER BY weight DESC, created_at DESC, id ASC`,
      )
      .all(projectId, ...ids, ...ids) as unknown as RelationRow[];
    for (const row of rows) relations.push(mapRelation(row));
  }
  return relations;
}

/** 邻居实体：通过关系边相连的其他实体（排除自身），按连接数排序。 */
export function listNeighborEntities(
  db: DatabaseSync,
  projectId: string,
  entityIds: string[],
  limit = 12,
): EntityRef[] {
  if (entityIds.length === 0) return [];
  const own = new Set(entityIds);
  const connections = new Map<string, number>();
  for (const ids of chunk(entityIds, 400)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT source_entity_id, target_entity_id FROM relations
         WHERE project_id = ? AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))`,
      )
      .all(projectId, ...ids, ...ids) as unknown as { source_entity_id: string; target_entity_id: string }[];
    for (const row of rows) {
      for (const id of [row.source_entity_id, row.target_entity_id]) {
        if (own.has(id)) continue;
        connections.set(id, (connections.get(id) ?? 0) + 1);
      }
    }
  }
  if (connections.size === 0) return [];

  const neighbors: EntityRef[] = [];
  for (const ids of chunk([...connections.keys()], 400)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT id, name, type, mention_count FROM entities WHERE project_id = ? AND id IN (${placeholders})`)
      .all(projectId, ...ids) as unknown as EntityRow[];
    for (const row of rows) {
      neighbors.push({ id: row.id, name: row.name, type: row.type, mentionCount: Number(row.mention_count) });
    }
  }
  return neighbors
    .sort((a, b) => (connections.get(b.id) ?? 0) - (connections.get(a.id) ?? 0) || b.mentionCount - a.mentionCount || a.name.localeCompare(b.name))
    .slice(0, limit);
}
