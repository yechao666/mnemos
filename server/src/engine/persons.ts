/**
 * 人（Person）：记忆的主体。
 *
 * 分区（projects）内的一等实体，按 `(project_id, type, external_id)` 唯一；
 * external_id 由调用方定义（App 的 user_id、Agent 的 id/name、DSH 主体名…），
 * 同一个 external_id 可以同时存在 human 与 agent 两条记录，因此解析时支持类型上下文。
 *
 * 本文件只负责持久化与映射（不做 HTTP 语义判断）；审计在写入时按调用方 actor 落库。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  Actor,
  Paginated,
  Person,
  PersonInput,
  PersonListInput,
  PersonStats,
  PersonStatus,
  PersonType,
} from '../../../shared/src/types.ts';
import { writeAudit } from '../lib/audit.ts';
import { escapeLike, newId, nowIso } from '../lib/ids.ts';
import { notFound, unprocessable } from './errors.ts';
import { parseMetadata } from './store.ts';

export const PERSON_TYPES: PersonType[] = ['human', 'agent', 'service', 'other'];
export const PERSON_STATUSES: PersonStatus[] = ['active', 'archived', 'deleted'];

export interface PersonRow {
  id: string;
  project_id: string;
  external_id: string;
  type: string;
  display_name: string;
  attributes: string;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export function isPersonType(value: unknown): value is PersonType {
  return typeof value === 'string' && (PERSON_TYPES as string[]).includes(value);
}

export function isPersonStatus(value: unknown): value is PersonStatus {
  return typeof value === 'string' && (PERSON_STATUSES as string[]).includes(value);
}

/** 行 → 契约对象（partitionId 沿用 projects.id）。 */
export function mapPerson(row: PersonRow, stats?: PersonStats): Person {
  const person: Person = {
    id: row.id,
    partitionId: row.project_id,
    externalId: row.external_id,
    type: row.type as PersonType,
    displayName: row.display_name,
    attributes: parseMetadata(row.attributes),
    status: row.status as PersonStatus,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (stats) person.stats = stats;
  return person;
}

function projectOrgId(db: DatabaseSync, projectId: string): string | undefined {
  const row = db.prepare('SELECT org_id FROM projects WHERE id = ?').get(projectId) as unknown as
    | { org_id?: string }
    | undefined;
  return row?.org_id;
}

/* ------------------------------------------------------------------ */
/* 查询 / 解析                                                          */
/* ------------------------------------------------------------------ */

export function getPersonRow(db: DatabaseSync, projectId: string, personId: string): PersonRow | undefined {
  return db.prepare('SELECT * FROM persons WHERE project_id = ? AND id = ?').get(projectId, personId) as unknown as
    | PersonRow
    | undefined;
}

export interface ResolvePersonOptions {
  /** 期望的类型（调用上下文：user_id → human、agent_id → agent），用于消歧同名 external_id */
  type?: PersonType;
}

/**
 * 解析 person 引用：
 * 1) 先按内部 id（prs_xxx）精确命中；
 * 2) 再按 external_id：命中多个时优先 type 与调用上下文一致者，其次 status=active，
 *    仍无法判定（如同类型多条 active）时返回 null，由调用方报错。
 */
export function resolvePerson(
  db: DatabaseSync,
  projectId: string,
  ref: string,
  options: ResolvePersonOptions = {},
): PersonRow | null {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) return null;

  const byId = getPersonRow(db, projectId, value);
  if (byId) return byId;

  const rows = db
    .prepare('SELECT * FROM persons WHERE project_id = ? AND external_id = ? ORDER BY created_at ASC, id ASC')
    .all(projectId, value) as unknown as PersonRow[];
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  const typed = options.type ? rows.filter((row) => row.type === options.type) : rows;
  if (typed.length === 1) return typed[0];
  const active = typed.filter((row) => row.status === 'active');
  if (active.length === 1) return active[0];
  return null;
}

function findByKey(db: DatabaseSync, projectId: string, type: PersonType, externalId: string): PersonRow | undefined {
  return db
    .prepare('SELECT * FROM persons WHERE project_id = ? AND type = ? AND external_id = ?')
    .get(projectId, type, externalId) as unknown as PersonRow | undefined;
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

export interface UpsertPersonOptions {
  /** 传入则写审计（HTTP/设置类写操作） */
  actor?: Actor;
  /** 是否顺带刷新 last_seen_at（默认 true） */
  touch?: boolean;
}

/**
 * 按 `(project, type, external_id)` 幂等 upsert：
 * - 新建：id = prs_xxx，first/lastSeenAt、attributes JSON 落库；
 * - 已存在：更新 displayName / attributes / status（未提供的字段保持不变），刷新 lastSeenAt。
 *
 * displayName 缺省取 externalId（人类可读的兜底）；attributes 传入时整体替换。
 */
export function upsertPerson(
  db: DatabaseSync,
  projectId: string,
  input: PersonInput,
  options: UpsertPersonOptions = {},
): PersonRow {
  const externalId = typeof input.externalId === 'string' ? input.externalId.trim() : '';
  if (!externalId) throw unprocessable('person.externalId 不能为空');
  if (input.type !== undefined && !isPersonType(input.type)) {
    throw unprocessable(`person.type 不合法：${String(input.type)}`);
  }
  if (input.status !== undefined && !isPersonStatus(input.status)) {
    throw unprocessable(`person.status 不合法：${String(input.status)}`);
  }
  const type: PersonType = input.type ?? 'human';
  const status: PersonStatus | undefined = input.status;
  const at = nowIso();
  const displayName = input.displayName !== undefined ? input.displayName.trim() : externalId;
  const attributes = input.attributes !== undefined ? JSON.stringify(input.attributes) : '{}';
  const touch = options.touch !== false;

  const existing = findByKey(db, projectId, type, externalId);
  let row: PersonRow;
  if (existing) {
    const nextDisplayName = input.displayName !== undefined ? displayName : existing.display_name || externalId;
    const nextAttributes = input.attributes !== undefined ? attributes : existing.attributes;
    const nextStatus = status ?? existing.status;
    db.prepare(
      `UPDATE persons
          SET display_name = ?, attributes = ?, status = ?,
              last_seen_at = CASE WHEN ? THEN ? ELSE last_seen_at END,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      nextDisplayName,
      nextAttributes,
      nextStatus,
      touch ? 1 : 0,
      at,
      at,
      existing.id,
    );
    row = getPersonRow(db, projectId, existing.id)!;
  } else {
    const id = newId('prs');
    db.prepare(
      `INSERT INTO persons
         (id, project_id, external_id, type, display_name, attributes, status,
          first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      externalId,
      type,
      displayName,
      attributes,
      status ?? 'active',
      at,
      at,
      at,
      at,
    );
    row = getPersonRow(db, projectId, id)!;
  }

  if (options.actor) {
    writeAudit(db, {
      orgId: projectOrgId(db, projectId),
      projectId,
      actor: options.actor,
      action: existing ? 'person.upsert' : 'person.create',
      resourceType: 'person',
      resourceId: row.id,
      detail: {
        externalId,
        type,
        status: row.status,
        displayName: row.display_name,
        created: !existing,
      },
    });
  }
  return row;
}

/** 更新人的显示名 / attributes / status（type 与 externalId 不可改，迁移重复人待后续合并 API）。 */
export function updatePerson(
  db: DatabaseSync,
  projectId: string,
  personRef: string,
  input: Partial<PersonInput>,
  actor?: Actor,
): PersonRow {
  const row = resolvePerson(db, projectId, personRef, { type: isPersonType(input.type) ? input.type : undefined });
  if (!row) throw notFound('人不存在');
  if (input.type !== undefined && input.type !== row.type) {
    throw unprocessable('person.type 不支持修改');
  }
  if (input.status !== undefined && !isPersonStatus(input.status)) {
    throw unprocessable(`person.status 不合法：${String(input.status)}`);
  }
  const at = nowIso();
  const displayName = input.displayName !== undefined ? input.displayName.trim() : row.display_name;
  const attributes = input.attributes !== undefined ? JSON.stringify(input.attributes) : row.attributes;
  const status = input.status ?? row.status;
  db.prepare(
    `UPDATE persons SET display_name = ?, attributes = ?, status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
  ).run(displayName, attributes, status, at, at, row.id);
  const updated = getPersonRow(db, projectId, row.id)!;

  if (actor) {
    const changed: Record<string, unknown> = {};
    if (input.displayName !== undefined && displayName !== row.display_name) {
      changed.displayName = { from: row.display_name, to: displayName };
    }
    if (input.status !== undefined && status !== row.status) changed.status = { from: row.status, to: status };
    if (input.attributes !== undefined && attributes !== row.attributes) changed.attributes = true;
    writeAudit(db, {
      orgId: projectOrgId(db, projectId),
      projectId,
      actor,
      action: 'person.update',
      resourceType: 'person',
      resourceId: row.id,
      detail: { externalId: row.external_id, type: row.type, changed },
    });
  }
  return updated;
}

/** 刷新 last_seen_at（写入记忆时调用；已是最新则不改 updated_at）。 */
export function touchPerson(db: DatabaseSync, projectId: string, personRef: string, at = nowIso()): void {
  const row = getPersonRow(db, projectId, personRef) ?? resolvePerson(db, projectId, personRef);
  if (!row) return;
  db.prepare('UPDATE persons SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
}

/** 系统人（做梦等后台主体）：按 (type=service, external_id) 懒创建，不写审计。 */
export function ensureSystemPerson(
  db: DatabaseSync,
  projectId: string,
  externalId = 'mnemos-dream',
  displayName = '做梦系统',
): PersonRow {
  const existing = findByKey(db, projectId, 'service', externalId);
  if (existing) return existing;
  return upsertPerson(db, projectId, {
    externalId,
    type: 'service',
    displayName,
    attributes: { role: 'system' },
    status: 'active',
  });
}

/* ------------------------------------------------------------------ */
/* 统计 / 列表                                                          */
/* ------------------------------------------------------------------ */

interface PersonStatsRow {
  person_id: string;
  memories: number;
  shared_memories: number;
  sessions: number;
  last_memory_at: string | null;
}

function emptyStats(): PersonStats {
  return { memories: 0, sharedMemories: 0, sessions: 0 };
}

function mapStats(row: PersonStatsRow | undefined): PersonStats {
  if (!row) return emptyStats();
  const stats: PersonStats = {
    memories: Number(row.memories ?? 0),
    sharedMemories: Number(row.shared_memories ?? 0),
    sessions: Number(row.sessions ?? 0),
  };
  if (row.last_memory_at) stats.lastMemoryAt = row.last_memory_at;
  return stats;
}

const STATS_COLUMNS = `
  COUNT(*) AS memories,
  COALESCE(SUM(CASE WHEN scope = 'partition' THEN 1 ELSE 0 END), 0) AS shared_memories,
  COUNT(DISTINCT CASE WHEN session_id IS NOT NULL AND session_id <> '' THEN session_id END) AS sessions,
  MAX(updated_at) AS last_memory_at
`;

/** 单人的记忆统计（按 memories.person_id 聚合 active 记忆）。 */
export function loadPersonStats(db: DatabaseSync, projectId: string, personId: string): PersonStats {
  const row = db
    .prepare(
      `SELECT person_id, ${STATS_COLUMNS}
         FROM memories
        WHERE project_id = ? AND person_id = ? AND status = 'active'
        GROUP BY person_id`,
    )
    .get(projectId, personId) as unknown as PersonStatsRow | undefined;
  return mapStats(row);
}

/** 批量统计（人列表分页内的人，避免 N+1）。 */
export function loadPersonStatsBatch(
  db: DatabaseSync,
  projectId: string,
  personIds: string[],
): Map<string, PersonStats> {
  const stats = new Map<string, PersonStats>();
  const unique = [...new Set(personIds.filter((id) => typeof id === 'string' && id.length > 0))];
  for (const ids of chunkIds(unique)) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT person_id, ${STATS_COLUMNS}
           FROM memories
          WHERE project_id = ? AND status = 'active' AND person_id IN (${placeholders})
          GROUP BY person_id`,
      )
      .all(projectId, ...ids) as unknown as PersonStatsRow[];
    for (const row of rows) stats.set(row.person_id, mapStats(row));
  }
  return stats;
}

/** SQL 参数上限保护（本地小工具，避免依赖 store 的 chunk 增加耦合）。 */
function chunkIds(ids: string[], size = 400): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** 人列表：分页 + type/status/q 过滤 + stats 聚合。 */
export function listPersons(db: DatabaseSync, input: PersonListInput): Paginated<Person> {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.pageSize ?? DEFAULT_PAGE_SIZE)));
  if (input.type !== undefined && !isPersonType(input.type)) {
    throw unprocessable(`person.type 不合法：${String(input.type)}`);
  }
  if (input.status !== undefined && !isPersonStatus(input.status)) {
    throw unprocessable(`person.status 不合法：${String(input.status)}`);
  }

  const where: string[] = ['p.project_id = ?'];
  const params: (string | number)[] = [input.projectId];
  if (input.type) {
    where.push('p.type = ?');
    params.push(input.type);
  }
  if (input.status) {
    where.push('p.status = ?');
    params.push(input.status);
  }
  if (input.q && input.q.trim()) {
    const like = `%${escapeLike(input.q.trim())}%`;
    where.push("(p.display_name LIKE ? ESCAPE '\\' OR p.external_id LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  const clause = where.join(' AND ');

  let orderBy = 'p.last_seen_at DESC, p.id DESC';
  if (input.sort === 'name') orderBy = 'p.display_name COLLATE NOCASE ASC, p.id ASC';
  else if (input.sort === 'memories') {
    orderBy = `(SELECT COUNT(*) FROM memories m
                 WHERE m.project_id = p.project_id AND m.person_id = p.id AND m.status = 'active') DESC,
               p.last_seen_at DESC, p.id DESC`;
  }

  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM persons p WHERE ${clause}`).get(...params) as unknown as
    | { c: number }
    | undefined;
  const total = Number(countRow?.c ?? 0);
  const rows = db
    .prepare(`SELECT p.* FROM persons p WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as unknown as PersonRow[];
  const stats = loadPersonStatsBatch(
    db,
    input.projectId,
    rows.map((row) => row.id),
  );

  return {
    items: rows.map((row) => mapPerson(row, stats.get(row.id) ?? emptyStats())),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
