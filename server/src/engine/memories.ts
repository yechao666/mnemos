import type { DatabaseSync } from 'node:sqlite';
import type {
  AddMemoryInput,
  Actor,
  CursorPage,
  Memory,
  MemoryCategory,
  MemoryDetail,
  MemoryListQuery,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  PersonType,
  UpdateMemoryInput,
} from '../../../shared/src/types.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { decodeCursor, encodeCursor, normalizeLimit } from './cursor.ts';
import { engineErrors } from './errors.ts';
import { findPartitionById, loadStatsRow } from './partition.ts';
import { findPersonRow, resolvePerson, upsertPerson } from './persons.ts';
import {
  escapeLike,
  ftsQuery,
  likeContains,
  needsSubstringSearch,
  parseSettings,
  toMemory,
  toPerson,
  toStats,
  type MemoryRow,
  type PersonRow,
} from './rows.ts';

export const MEMORY_SCOPES: MemoryScope[] = ['person', 'partition', 'session'];
export const MEMORY_STATUSES: MemoryStatus[] = ['active', 'archived', 'deleted'];
export const MEMORY_SOURCES: MemorySource[] = ['api', 'conversation', 'agent', 'import', 'playground', 'dream'];
export const MEMORY_CATEGORIES: MemoryCategory[] = [
  'preference',
  'identity',
  'fact',
  'plan',
  'relationship',
  'event',
  'skill',
  'constraint',
  'context',
  'insight',
  'decision',
  'progress',
  'lesson',
  'risk',
  'change',
  'acceptance',
  'assumption',
  'dependency',
];

const MAX_CONTENT_CHARS = 20_000;

function clamp01(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function scopeOf(value: unknown, fallback: MemoryScope): MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as string[]).includes(value) ? (value as MemoryScope) : fallback;
}

function categoryOf(value: unknown): MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as string[]).includes(value)
    ? (value as MemoryCategory)
    : 'fact';
}

function sourceOf(value: unknown): MemorySource {
  return typeof value === 'string' && (MEMORY_SOURCES as string[]).includes(value) ? (value as MemorySource) : 'api';
}

function statusOf(value: unknown): MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as string[]).includes(value)
    ? (value as MemoryStatus)
    : 'active';
}

/** 校验并解析写入人：personId / personExternalId(+type)；分区允许自动建档。 */
function resolveWritePerson(
  db: DatabaseSync,
  partitionId: string,
  input: AddMemoryInput,
  autoCreate: boolean,
): PersonRow {
  if (input.personId) {
    const row = findPersonRow(db, partitionId, input.personId);
    if (!row) throw engineErrors.notFound('记忆归属的人不存在');
    return row;
  }
  if (input.personExternalId) {
    const type = (input.personType ?? 'human') as PersonType;
    const existing = db
      .prepare('SELECT * FROM persons WHERE partition_id = ? AND type = ? AND external_id = ?')
      .get(partitionId, type, input.personExternalId) as unknown as PersonRow | undefined;
    if (existing) return existing;
    if (!autoCreate) throw engineErrors.notFound('记忆归属的人不存在');
    const person = upsertPerson(
      db,
      partitionId,
      { externalId: input.personExternalId, type, displayName: input.personExternalId },
      input.actor,
    );
    return findPersonRow(db, partitionId, person.id) as PersonRow;
  }
  throw engineErrors.validation('写入记忆必须指定 person_id 或 person_external_id');
}

/** 会话校验：session_id 全局唯一；已存在时必须同分区同人，否则按首次写入自动建会话。 */
function ensureSession(
  db: DatabaseSync,
  partitionId: string,
  personId: string,
  sessionId: string,
  title: string,
): void {
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as unknown as
    | { partition_id: string; person_id: string; title: string }
    | undefined;
  if (existing) {
    if (existing.partition_id !== partitionId || existing.person_id !== personId) {
      throw engineErrors.conflict('session_id 已属于其他分区或人');
    }
    if (title && !existing.title) {
      db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title.slice(0, 200), sessionId);
    }
    return;
  }
  const at = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, partition_id, person_id, title, status, started_at, ended_at, metadata)
     VALUES (?, ?, ?, ?, 'active', ?, NULL, '{}')`,
  ).run(sessionId, partitionId, personId, title.slice(0, 200), at);
}

export function addMemory(db: DatabaseSync, input: AddMemoryInput): Memory {
  const partition = findPartitionById(db, input.partitionId);
  if (!partition) throw engineErrors.notFound('分区不存在');
  if (partition.status === 'archived') throw engineErrors.archivedPartition();
  const settings = parseSettings(partition.settings);

  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (!content) throw engineErrors.validation('content 不能为空');
  if (content.length > MAX_CONTENT_CHARS) throw engineErrors.validation('content 最长 20000 字符');

  const person = resolveWritePerson(db, input.partitionId, input, settings.personAutoCreate);
  const scope = scopeOf(input.scope, settings.defaultScope);

  let sessionId: string | null = null;
  if (scope === 'session') {
    if (!input.sessionId || !input.sessionId.trim()) {
      throw engineErrors.validation('scope=session 时必须提供 session_id');
    }
    sessionId = input.sessionId.trim().slice(0, 128);
    ensureSession(db, input.partitionId, person.id, sessionId, input.sessionTitle ?? '');
  } else if (input.sessionId) {
    sessionId = input.sessionId.trim().slice(0, 128);
    ensureSession(db, input.partitionId, person.id, sessionId, input.sessionTitle ?? '');
  }

  let actorPersonId = person.id;
  if (input.actorPersonId) {
    const actorRow = findPersonRow(db, input.partitionId, input.actorPersonId);
    actorPersonId = actorRow ? actorRow.id : person.id;
  }

  const at = nowIso();
  const id = newId('mem');
  const expiresAt = input.expiresAt === null ? null : input.expiresAt ?? null;
  db.prepare(
    `INSERT INTO memories
       (id, partition_id, person_id, actor_person_id, scope, session_id, category, content,
        importance, confidence, source, status, tags, metadata, created_at, updated_at, expires_at, dreamed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.partitionId,
    person.id,
    actorPersonId,
    scope,
    sessionId,
    categoryOf(input.category),
    content,
    clamp01(input.importance, 0.5),
    clamp01(input.confidence, 0.8),
    sourceOf(input.source),
    JSON.stringify(input.tags ?? []),
    JSON.stringify(input.metadata ?? {}),
    at,
    at,
    expiresAt,
  );
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as MemoryRow;
  return toMemory({ ...row, person_external_id: person.external_id });
}

function memoryFromJoinedRow(row: MemoryRow): Memory {
  return toMemory(row);
}

export function listMemories(db: DatabaseSync, query: MemoryListQuery): CursorPage<Memory> {
  const limit = normalizeLimit(query.limit);
  const where: string[] = ['m.partition_id = ?'];
  const params: (string | number)[] = [query.partitionId];

  if (query.personId || query.personExternalId) {
    const ref = query.personId ?? query.personExternalId ?? '';
    const person = findPersonRow(db, query.partitionId, ref);
    if (!person) {
      return {
        items: [],
        nextCursor: null,
        partitionStats: toStats(loadStatsRow(db, query.partitionId)),
      };
    }
    where.push('m.person_id = ?');
    params.push(person.id);
  }
  if (query.scope) {
    if (!(MEMORY_SCOPES as string[]).includes(query.scope)) throw engineErrors.validation('scope 不合法');
    where.push('m.scope = ?');
    params.push(query.scope);
  }
  if (query.category) {
    if (!(MEMORY_CATEGORIES as string[]).includes(query.category)) throw engineErrors.validation('category 不合法');
    where.push('m.category = ?');
    params.push(query.category);
  }
  if (query.status) {
    if (!(MEMORY_STATUSES as string[]).includes(query.status)) throw engineErrors.validation('status 不合法');
    where.push('m.status = ?');
    params.push(query.status);
  }

  const q = (query.q ?? '').trim();
  if (q) {
    const match = ftsQuery(q);
    if (needsSubstringSearch(q)) {
      where.push("m.content LIKE ? ESCAPE '\\'");
      params.push(likeContains(q.slice(0, 200)));
    } else if (q.length >= 3 && match) {
      where.push('m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
      params.push(match);
    } else {
      where.push("m.content LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(q.slice(0, 200))}%`);
    }
  }

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, 'recent');
    where.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
    params.push(cursor.v, cursor.v, cursor.id);
  }

  const rows = db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m
         JOIN persons p ON p.id = m.person_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as unknown as MemoryRow[];

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(memoryFromJoinedRow);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ v: last.createdAt, id: last.id, s: 'recent' }) : null;

  return {
    items,
    nextCursor,
    partitionStats: toStats(loadStatsRow(db, query.partitionId)),
  };
}

export function getMemory(db: DatabaseSync, partitionId: string, id: string): MemoryDetail | null {
  const row = db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m
         JOIN persons p ON p.id = m.person_id
        WHERE m.partition_id = ? AND m.id = ?`,
    )
    .get(partitionId, id) as unknown as MemoryRow | undefined;
  if (!row) return null;
  const personRow = db.prepare('SELECT * FROM persons WHERE id = ?').get(row.person_id) as unknown as
    | PersonRow
    | undefined;
  return {
    memory: toMemory(row),
    person: personRow ? toPerson(personRow) : null,
  };
}

export function updateMemory(
  db: DatabaseSync,
  partitionId: string,
  id: string,
  input: UpdateMemoryInput,
  _actor: Actor,
): Memory {
  const existing = db
    .prepare('SELECT * FROM memories WHERE partition_id = ? AND id = ?')
    .get(partitionId, id) as unknown as MemoryRow | undefined;
  if (!existing) throw engineErrors.notFound('记忆不存在');

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.content !== undefined) {
    const content = input.content.trim();
    if (!content) throw engineErrors.validation('content 不能为空');
    if (content.length > MAX_CONTENT_CHARS) throw engineErrors.validation('content 最长 20000 字符');
    sets.push('content = ?');
    params.push(content);
  }
  if (input.category !== undefined) {
    if (!(MEMORY_CATEGORIES as string[]).includes(input.category)) throw engineErrors.validation('category 不合法');
    sets.push('category = ?');
    params.push(input.category);
  }
  if (input.importance !== undefined) {
    sets.push('importance = ?');
    params.push(clamp01(input.importance, existing.importance));
  }
  if (input.confidence !== undefined) {
    sets.push('confidence = ?');
    params.push(clamp01(input.confidence, existing.confidence));
  }
  if (input.status !== undefined) {
    if (!(MEMORY_STATUSES as string[]).includes(input.status)) throw engineErrors.validation('status 不合法');
    sets.push('status = ?');
    params.push(input.status);
  }
  if (input.tags !== undefined) {
    sets.push('tags = ?');
    params.push(JSON.stringify(input.tags));
  }
  if (input.metadata !== undefined) {
    sets.push('metadata = ?');
    params.push(JSON.stringify(input.metadata));
  }
  if (input.expiresAt !== undefined) {
    sets.push('expires_at = ?');
    params.push(input.expiresAt);
  }
  if (sets.length === 0) throw engineErrors.validation('至少提供一个待更新字段');

  sets.push('updated_at = ?');
  params.push(nowIso());
  db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE partition_id = ? AND id = ?`).run(...params, partitionId, id);

  const row = db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m JOIN persons p ON p.id = m.person_id
        WHERE m.partition_id = ? AND m.id = ?`,
    )
    .get(partitionId, id) as unknown as MemoryRow;
  return toMemory(row);
}

export function removeMemory(db: DatabaseSync, partitionId: string, id: string): void {
  const existing = db
    .prepare('SELECT id FROM memories WHERE partition_id = ? AND id = ?')
    .get(partitionId, id) as unknown as { id: string } | undefined;
  if (!existing) throw engineErrors.notFound('记忆不存在');
  db.prepare('DELETE FROM memories WHERE partition_id = ? AND id = ?').run(partitionId, id);
}

/* ------------------------------------------------------------------ */
/* 内部查询：简报 / 上下文 / 做梦 复用                                  */
/* ------------------------------------------------------------------ */

/** 按人取最近活跃记忆（简报人级：本人记忆 + 相关分区共享）。 */
export function briefSourceMemories(
  db: DatabaseSync,
  partitionId: string,
  personId?: string,
  limit = 100,
): Memory[] {
  const rows = personId
    ? (db
        .prepare(
          `SELECT m.*, p.external_id AS person_external_id
             FROM memories m JOIN persons p ON p.id = m.person_id
            WHERE m.partition_id = ? AND m.status = 'active'
              AND (m.person_id = ? OR m.scope = 'partition')
            ORDER BY m.importance DESC, m.created_at DESC, m.id DESC
            LIMIT ?`,
        )
        .all(partitionId, personId, limit) as unknown as MemoryRow[])
    : (db
        .prepare(
          `SELECT m.*, p.external_id AS person_external_id
             FROM memories m JOIN persons p ON p.id = m.person_id
            WHERE m.partition_id = ? AND m.status = 'active' AND m.scope = 'partition'
            ORDER BY m.importance DESC, m.created_at DESC, m.id DESC
            LIMIT ?`,
        )
        .all(partitionId, limit) as unknown as MemoryRow[]);
  return rows.map(toMemory);
}

/** 上下文用检索：仅该人的记忆（scope=person/session），query 走 FTS 前缀。 */
export function personMemories(
  db: DatabaseSync,
  partitionId: string,
  personId: string,
  query: string | undefined,
  limit: number,
): Memory[] {
  const q = (query ?? '').trim();
  const where = ["m.partition_id = ?", 'm.person_id = ?', "m.status = 'active'", "m.scope IN ('person', 'session')"];
  const params: (string | number)[] = [partitionId, personId];
  if (q) {
    const match = ftsQuery(q);
    if (needsSubstringSearch(q)) {
      where.push("m.content LIKE ? ESCAPE '\\'");
      params.push(likeContains(q.slice(0, 200)));
    } else if (q.length >= 3 && match) {
      where.push('m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
      params.push(match);
    } else {
      where.push("m.content LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(q.slice(0, 200))}%`);
    }
  }
  const rows = db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m JOIN persons p ON p.id = m.person_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.importance DESC, m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as MemoryRow[];
  return rows.map(toMemory);
}

/** 上下文用：分区共享知识。 */
export function sharedMemories(
  db: DatabaseSync,
  partitionId: string,
  query: string | undefined,
  limit: number,
): Memory[] {
  const q = (query ?? '').trim();
  const where = ["m.partition_id = ?", "m.status = 'active'", "m.scope = 'partition'"];
  const params: (string | number)[] = [partitionId];
  if (q) {
    const match = ftsQuery(q);
    if (needsSubstringSearch(q)) {
      where.push("m.content LIKE ? ESCAPE '\\'");
      params.push(likeContains(q.slice(0, 200)));
    } else if (q.length >= 3 && match) {
      where.push('m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
      params.push(match);
    } else {
      where.push("m.content LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(q.slice(0, 200))}%`);
    }
  }
  const rows = db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m JOIN persons p ON p.id = m.person_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.importance DESC, m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as MemoryRow[];
  return rows.map(toMemory);
}

/** 做梦输入：未巩固的活跃记忆（人级只看本人 person/session；分区级看 scope=partition）。 */
export function pendingDreamMemories(
  db: DatabaseSync,
  partitionId: string,
  personId: string | undefined,
  limit: number,
): Memory[] {
  const rows = personId
    ? (db
        .prepare(
          `SELECT m.*, p.external_id AS person_external_id
             FROM memories m JOIN persons p ON p.id = m.person_id
            WHERE m.partition_id = ? AND m.person_id = ? AND m.status = 'active'
              AND m.scope IN ('person', 'session') AND m.dreamed_at IS NULL
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT ?`,
        )
        .all(partitionId, personId, limit) as unknown as MemoryRow[])
    : (db
        .prepare(
          `SELECT m.*, p.external_id AS person_external_id
             FROM memories m JOIN persons p ON p.id = m.person_id
            WHERE m.partition_id = ? AND m.status = 'active' AND m.scope = 'partition'
              AND m.dreamed_at IS NULL
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT ?`,
        )
        .all(partitionId, limit) as unknown as MemoryRow[]);
  return rows.map(toMemory);
}

export function pendingDreamCount(db: DatabaseSync, partitionId: string, personId?: string): number {
  const row = personId
    ? (db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories
            WHERE partition_id = ? AND person_id = ? AND status = 'active'
              AND scope IN ('person', 'session') AND dreamed_at IS NULL`,
        )
        .get(partitionId, personId) as unknown as { c: number })
    : (db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories
            WHERE partition_id = ? AND status = 'active' AND scope = 'partition' AND dreamed_at IS NULL`,
        )
        .get(partitionId) as unknown as { c: number });
  return row?.c ?? 0;
}

export function markDreamed(db: DatabaseSync, ids: string[], at: string): void {
  const stmt = db.prepare('UPDATE memories SET dreamed_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(at, id);
}
