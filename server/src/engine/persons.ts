import type { DatabaseSync } from 'node:sqlite';
import type {
  Actor,
  CursorPage,
  Person,
  PersonInput,
  PersonListQuery,
  PersonStatus,
  PersonType,
} from '../../../shared/src/types.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { decodeCursor, encodeCursor, normalizeLimit } from './cursor.ts';
import { engineErrors } from './errors.ts';
import { loadStatsRow } from './partition.ts';
import {
  escapeLike,
  ftsQuery,
  likeContains,
  needsSubstringSearch,
  toPerson,
  toStats,
  type PersonRow,
} from './rows.ts';

export const PERSON_TYPES: PersonType[] = ['human', 'agent', 'service', 'other'];
export const PERSON_STATUSES: PersonStatus[] = ['active', 'archived', 'deleted'];

export function isPersonType(value: unknown): value is PersonType {
  return typeof value === 'string' && (PERSON_TYPES as string[]).includes(value);
}

function validateExternalId(value: string): string {
  const externalId = typeof value === 'string' ? value.trim() : '';
  if (!externalId) throw engineErrors.validation('externalId 不能为空');
  if (externalId.length > 128) throw engineErrors.validation('externalId 最长 128 字符');
  return externalId;
}

function normalizeType(value: unknown): PersonType {
  return isPersonType(value) ? value : 'human';
}

export function findPersonById(db: DatabaseSync, partitionId: string, id: string): PersonRow | null {
  const row = db
    .prepare('SELECT * FROM persons WHERE partition_id = ? AND id = ?')
    .get(partitionId, id) as unknown as PersonRow | undefined;
  return row ?? null;
}

/** 按内部 id 或 external_id 解析人（external 可能有多种 type，取最早创建的一条）。 */
export function findPersonRow(db: DatabaseSync, partitionId: string, ref: string): PersonRow | null {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) return null;
  const byId = findPersonById(db, partitionId, value);
  if (byId) return byId;
  const row = db
    .prepare(
      `SELECT * FROM persons
        WHERE partition_id = ? AND external_id = ?
        ORDER BY created_at ASC, type ASC LIMIT 1`,
    )
    .get(partitionId, value) as unknown as PersonRow | undefined;
  return row ?? null;
}

export function getPerson(db: DatabaseSync, partitionId: string, ref: string): Person | null {
  const row = findPersonRow(db, partitionId, ref);
  return row ? toPerson(row) : null;
}

export function resolvePerson(db: DatabaseSync, partitionId: string, ref: string): Person {
  const person = getPerson(db, partitionId, ref);
  if (!person) throw engineErrors.notFound('人不存在');
  return person;
}

/**
 * 建档 / 更新人：按 (partition_id, type, external_id) 幂等。
 * 已存在时更新展示名 / 属性 / 状态，并刷新 last_seen_at。
 */
export function upsertPerson(
  db: DatabaseSync,
  partitionId: string,
  input: PersonInput,
  _actor: Actor,
): Person {
  const externalId = validateExternalId(input.externalId);
  const type = normalizeType(input.type);
  const at = nowIso();
  const existing = db
    .prepare('SELECT * FROM persons WHERE partition_id = ? AND type = ? AND external_id = ?')
    .get(partitionId, type, externalId) as unknown as PersonRow | undefined;

  if (existing) {
    const displayName = input.displayName !== undefined ? input.displayName.trim().slice(0, 120) : existing.display_name;
    const attributes = input.attributes !== undefined ? JSON.stringify(input.attributes) : existing.attributes;
    const status = input.status ?? existing.status;
    db.prepare(
      `UPDATE persons
          SET display_name = ?, attributes = ?, status = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(displayName, attributes, status, at, at, existing.id);
    return toPerson({ ...existing, display_name: displayName, attributes, status, last_seen_at: at, updated_at: at });
  }

  db.prepare(
    `INSERT INTO persons
       (id, partition_id, external_id, type, display_name, attributes, status,
        memory_count, shared_memory_count, session_count,
        last_memory_at, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?, ?, ?)`,
  ).run(
    newId('prs'),
    partitionId,
    externalId,
    type,
    (input.displayName ?? '').trim().slice(0, 120),
    JSON.stringify(input.attributes ?? {}),
    input.status ?? 'active',
    at,
    at,
    at,
    at,
  );
  const created = db
    .prepare('SELECT * FROM persons WHERE partition_id = ? AND type = ? AND external_id = ?')
    .get(partitionId, type, externalId) as unknown as PersonRow;
  return toPerson(created);
}

export function updatePerson(
  db: DatabaseSync,
  partitionId: string,
  ref: string,
  input: Partial<PersonInput>,
  _actor: Actor,
): Person {
  const existing = findPersonRow(db, partitionId, ref);
  if (!existing) throw engineErrors.notFound('人不存在');
  const at = nowIso();
  const displayName = input.displayName !== undefined ? input.displayName.trim().slice(0, 120) : existing.display_name;
  const attributes = input.attributes !== undefined ? JSON.stringify(input.attributes) : existing.attributes;
  const status = input.status ?? existing.status;

  let type = existing.type;
  if (input.type !== undefined && input.type !== existing.type) {
    if (!isPersonType(input.type)) throw engineErrors.validation('type 不合法');
    const duplicate = db
      .prepare('SELECT id FROM persons WHERE partition_id = ? AND type = ? AND external_id = ? AND id <> ?')
      .get(partitionId, input.type, existing.external_id, existing.id) as unknown as { id: string } | undefined;
    if (duplicate) throw engineErrors.conflict('同 external_id 的该类型人已存在');
    type = input.type;
  }

  db.prepare(
    `UPDATE persons
        SET type = ?, display_name = ?, attributes = ?, status = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(type, displayName, attributes, status, at, at, existing.id);
  return toPerson({
    ...existing,
    type,
    display_name: displayName,
    attributes,
    status,
    last_seen_at: at,
    updated_at: at,
  });
}

const PERSON_SORT_SQL = {
  recent: {
    value: 'p.last_seen_at',
    order: 'p.last_seen_at DESC, p.id DESC',
    before: '(p.last_seen_at < ? OR (p.last_seen_at = ? AND p.id < ?))',
  },
  new: {
    value: 'p.created_at',
    order: 'p.created_at DESC, p.id DESC',
    before: '(p.created_at < ? OR (p.created_at = ? AND p.id < ?))',
  },
  name: {
    value: 'p.display_name',
    order: 'p.display_name ASC, p.id ASC',
    before: '(p.display_name > ? OR (p.display_name = ? AND p.id > ?))',
  },
} as const;

/**
 * 人列表：keyset 游标（recent/new/name 三种排序各有索引），
 * q 走 FTS5 前缀；q < 3 字符退化到 external_id / display_name 的 LIKE 前缀。
 * 不 COUNT(*)，头部统计直接读 partition_stats。
 */
export function listPersons(db: DatabaseSync, partitionId: string, query: PersonListQuery): CursorPage<Person> {
  const sort = query.sort === 'new' || query.sort === 'name' ? query.sort : 'recent';
  const limit = normalizeLimit(query.limit);
  const where: string[] = ['p.partition_id = ?'];
  const params: (string | number)[] = [partitionId];

  if (query.type) {
    if (!isPersonType(query.type)) throw engineErrors.validation('type 不合法');
    where.push('p.type = ?');
    params.push(query.type);
  }
  if (query.status) {
    if (!(PERSON_STATUSES as string[]).includes(query.status)) throw engineErrors.validation('status 不合法');
    where.push('p.status = ?');
    params.push(query.status);
  }

  const q = (query.q ?? '').trim();
  if (q) {
    const match = ftsQuery(q);
    if (needsSubstringSearch(q)) {
      const contains = likeContains(q.slice(0, 128));
      where.push("(p.external_id LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\')");
      params.push(contains, contains);
    } else if (q.length >= 3 && match) {
      where.push('p.rowid IN (SELECT rowid FROM persons_fts WHERE persons_fts MATCH ?)');
      params.push(match);
    } else {
      const like = `${escapeLike(q.slice(0, 128))}%`;
      where.push("(p.external_id LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
  }

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, sort);
    where.push(PERSON_SORT_SQL[sort].before);
    params.push(cursor.v, cursor.v, cursor.id);
  }

  const sql = `SELECT p.* FROM persons p WHERE ${where.join(' AND ')} ORDER BY ${PERSON_SORT_SQL[sort].order} LIMIT ?`;
  params.push(limit + 1);
  const rows = db.prepare(sql).all(...params) as unknown as PersonRow[];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ v: String(last[sort === 'name' ? 'display_name' : sort === 'new' ? 'created_at' : 'last_seen_at']), id: last.id, s: sort })
      : null;

  return {
    items: items.map(toPerson),
    nextCursor,
    partitionStats: toStats(loadStatsRow(db, partitionId)),
  };
}
