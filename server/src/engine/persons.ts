import type { DatabaseSync } from 'node:sqlite';
import type {
  Actor,
  CursorPage,
  Memory,
  Person,
  PersonExport,
  PersonInput,
  PersonListQuery,
  PersonMergeResult,
  PersonStatus,
  PersonType,
} from '../../../shared/src/types.ts';
import { tx } from '../db/index.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { decodeCursor, encodeCursor, normalizeLimit } from './cursor.ts';
import { engineErrors } from './errors.ts';
import { loadStatsRow, reconcileCounts } from './partition.ts';
import {
  escapeLike,
  ftsQuery,
  likeContains,
  needsSubstringSearch,
  toMemory,
  toPerson,
  toPersonFact,
  toStats,
  type MemoryRow,
  type PersonFactRow,
  type PersonRow,
} from './rows.ts';

export const PERSON_TYPES: PersonType[] = ['human', 'agent', 'service', 'other'];
export const PERSON_STATUSES: PersonStatus[] = ['active', 'archived', 'deleted'];

/** 人导出记忆上限（超过时截断并标记 truncated）。 */
export const PERSON_EXPORT_MEMORY_LIMIT = 10_000;

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

/**
 * 跟随 merged_into 找到 canonical 人（源人合并后指向目标）。
 * 循环/悬空引用时停在最后一个可解析节点，保证不会死循环。
 */
export function followMergedPersonRow(db: DatabaseSync, partitionId: string, row: PersonRow): PersonRow {
  let current = row;
  const visited = new Set<string>([current.id]);
  while (current.merged_into) {
    const nextId = current.merged_into;
    if (visited.has(nextId)) break;
    const next = findPersonById(db, partitionId, nextId);
    if (!next) break;
    visited.add(next.id);
    current = next;
  }
  return current;
}

/** 按 id / external_id 解析并跟随 merged_into（返回 canonical 原始行）。 */
export function resolvePersonRow(db: DatabaseSync, partitionId: string, ref: string): PersonRow | null {
  const row = findPersonRow(db, partitionId, ref);
  return row ? followMergedPersonRow(db, partitionId, row) : null;
}

export function getPerson(db: DatabaseSync, partitionId: string, ref: string): Person | null {
  const row = resolvePersonRow(db, partitionId, ref);
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
    // P2：consent 为整体覆盖（未传则保留原值）。
    const consent = input.consent !== undefined ? JSON.stringify(input.consent) : (existing.consent ?? '{}');
    db.prepare(
      `UPDATE persons
          SET display_name = ?, attributes = ?, status = ?, consent = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(displayName, attributes, status, consent, at, at, existing.id);
    return toPerson({
      ...existing,
      display_name: displayName,
      attributes,
      status,
      consent,
      last_seen_at: at,
      updated_at: at,
    });
  }

  db.prepare(
    `INSERT INTO persons
       (id, partition_id, external_id, type, display_name, attributes, status, consent,
        memory_count, shared_memory_count, session_count,
        last_memory_at, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?, ?, ?)`,
  ).run(
    newId('prs'),
    partitionId,
    externalId,
    type,
    (input.displayName ?? '').trim().slice(0, 120),
    JSON.stringify(input.attributes ?? {}),
    input.status ?? 'active',
    JSON.stringify(input.consent ?? {}),
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
  const consent = input.consent !== undefined ? JSON.stringify(input.consent) : (existing.consent ?? '{}');

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
        SET type = ?, display_name = ?, attributes = ?, status = ?, consent = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(type, displayName, attributes, status, consent, at, at, existing.id);
  return toPerson({
    ...existing,
    type,
    display_name: displayName,
    attributes,
    status,
    consent,
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

  // 默认只列「当前人」：排除已合并（merged_into 非空）与软删（status=deleted）。
  // 控制台排查历史时可传 includeMerged=true（并可用 status=deleted 精查）。
  if (query.includeMerged !== true) {
    where.push('p.merged_into IS NULL');
    if (!query.status) where.push("p.status <> 'deleted'");
  }

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

/* ------------------------------------------------------------------ */
/* v6.1 P1：人生命周期（merge / archive / delete / export）             */
/* ------------------------------------------------------------------ */

/** 合并后同一 key 只保留一条当前有效 fact（取 updated_at / valid_from 最新）。 */
function closeDuplicateActiveFacts(db: DatabaseSync, partitionId: string, personId: string, at: string): void {
  const rows = db
    .prepare(
      `SELECT id, key FROM person_facts
        WHERE partition_id = ? AND person_id = ? AND valid_to IS NULL
        ORDER BY key ASC, updated_at DESC, valid_from DESC, id DESC`,
    )
    .all(partitionId, personId) as unknown as { id: string; key: string }[];
  const seen = new Set<string>();
  const close = db.prepare('UPDATE person_facts SET valid_to = ?, updated_at = ? WHERE id = ?');
  for (const row of rows) {
    if (!seen.has(row.key)) {
      seen.add(row.key);
      continue;
    }
    close.run(at, at, row.id);
  }
}

/**
 * 合并两个人：memories / person_facts / memory_feedback / memory_history / sessions 迁移到目标，
 * 同一 fact_key 的重复当前事实只保留一条；源 status=archived + merged_into=target（deleted_at 不动）。
 * 计数通过 reconcile 重算（person_id 变更不会命中触发器）。
 */
export function mergePersons(
  db: DatabaseSync,
  partitionId: string,
  sourceRef: string,
  targetRef: string,
  _actor: Actor,
): PersonMergeResult {
  return tx(db, () => {
    const source = resolvePersonRow(db, partitionId, sourceRef);
    if (!source) throw engineErrors.notFound('源人不存在');
    const target = resolvePersonRow(db, partitionId, targetRef);
    if (!target) throw engineErrors.notFound('目标人不存在');
    if (source.id === target.id) throw engineErrors.validation('源人与目标是同一人，无需合并');
    if (source.status === 'deleted') throw engineErrors.conflict('源人已删除，无法合并');
    if (target.status === 'deleted') throw engineErrors.conflict('目标人已删除，无法合并');

    const at = nowIso();
    const movedMemories = Number(
      db
        .prepare('UPDATE memories SET person_id = ? WHERE partition_id = ? AND person_id = ?')
        .run(target.id, partitionId, source.id).changes ?? 0,
    );
    const movedFacts = Number(
      db
        .prepare('UPDATE person_facts SET person_id = ?, updated_at = ? WHERE partition_id = ? AND person_id = ?')
        .run(target.id, at, partitionId, source.id).changes ?? 0,
    );
    db.prepare('UPDATE memory_feedback SET person_id = ? WHERE partition_id = ? AND person_id = ?').run(
      target.id,
      partitionId,
      source.id,
    );
    db.prepare('UPDATE memory_history SET person_id = ? WHERE partition_id = ? AND person_id = ?').run(
      target.id,
      partitionId,
      source.id,
    );
    db.prepare('UPDATE sessions SET person_id = ? WHERE partition_id = ? AND person_id = ?').run(
      target.id,
      partitionId,
      source.id,
    );
    closeDuplicateActiveFacts(db, partitionId, target.id, at);

    // 画像缓存失效：源人缓存删除，目标人下次读取重算。
    db.prepare('DELETE FROM person_profiles WHERE partition_id = ? AND person_id IN (?, ?)').run(
      partitionId,
      source.id,
      target.id,
    );

    db.prepare(
      `UPDATE persons
          SET status = 'archived', merged_into = ?, updated_at = ?
        WHERE id = ? AND partition_id = ?`,
    ).run(target.id, at, source.id, partitionId);

    reconcileCounts(db, partitionId);

    const mergedFromRow = findPersonById(db, partitionId, source.id) as PersonRow;
    const personRow = findPersonById(db, partitionId, target.id) as PersonRow;
    return {
      person: toPerson(personRow),
      mergedFrom: toPerson(mergedFromRow),
      movedMemories,
      movedFacts,
    };
  });
}

/** 归档：status=archived，保留全部可读数据。 */
export function archivePerson(db: DatabaseSync, partitionId: string, ref: string, _actor: Actor): Person {
  const existing = resolvePerson(db, partitionId, ref);
  if (existing.status === 'deleted') throw engineErrors.conflict('该人已删除，无法归档');
  const at = nowIso();
  db.prepare("UPDATE persons SET status = 'archived', updated_at = ? WHERE id = ? AND partition_id = ?").run(
    at,
    existing.id,
    partitionId,
  );
  const row = findPersonById(db, partitionId, existing.id);
  if (!row) throw engineErrors.notFound('人不存在');
  return toPerson(row);
}

/**
 * 删除人：
 *  - 默认软删：status=deleted + deleted_at=now，记忆/facts 保留（可导出/审计）。
 *  - hard=true：物理删除该人的 memories（含 FTS/实体/历史/反馈）、person_facts、
 *    person_profiles、sessions，最后删 persons；悬空的 merged_into 置 NULL。
 *    调用方必须已做权限校验（仅 owner / admin-scope key）。
 */
export function deletePerson(
  db: DatabaseSync,
  partitionId: string,
  ref: string,
  input: { hard?: boolean },
  _actor: Actor,
): void {
  const existing = resolvePersonRow(db, partitionId, ref);
  if (!existing) throw engineErrors.notFound('人不存在');
  const at = nowIso();

  if (input.hard !== true) {
    db.prepare(
      `UPDATE persons
          SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
        WHERE id = ? AND partition_id = ?`,
    ).run(at, at, existing.id, partitionId);
    return;
  }

  tx(db, () => {
    db.prepare('UPDATE persons SET merged_into = NULL, updated_at = ? WHERE partition_id = ? AND merged_into = ?').run(
      at,
      partitionId,
      existing.id,
    );
    db.prepare(
      `DELETE FROM memory_entities
        WHERE memory_id IN (SELECT id FROM memories WHERE partition_id = ? AND person_id = ?)`,
    ).run(partitionId, existing.id);
    // P2：实体共现关系与附件同样按该人的记忆清理（无 FK，需显式删除）。
    db.prepare(
      `DELETE FROM relations
        WHERE partition_id = ?
          AND memory_id IN (SELECT id FROM memories WHERE partition_id = ? AND person_id = ?)`,
    ).run(partitionId, partitionId, existing.id);
    db.prepare(
      `DELETE FROM memory_attachments
        WHERE partition_id = ?
          AND memory_id IN (SELECT id FROM memories WHERE partition_id = ? AND person_id = ?)`,
    ).run(partitionId, partitionId, existing.id);
    db.prepare(
      `DELETE FROM memory_placeholders
        WHERE partition_id = ?
          AND memory_id IN (SELECT id FROM memories WHERE partition_id = ? AND person_id = ?)`,
    ).run(partitionId, partitionId, existing.id);
    db.prepare(
      `DELETE FROM memory_feedback
        WHERE partition_id = ?
          AND (person_id = ? OR memory_id IN (SELECT id FROM memories WHERE partition_id = ? AND person_id = ?))`,
    ).run(partitionId, existing.id, partitionId, existing.id);
    db.prepare(
      `DELETE FROM memory_history
        WHERE partition_id = ?
          AND (person_id = ? OR memory_id IN (SELECT id FROM memories WHERE partition_id = ? AND person_id = ?))`,
    ).run(partitionId, existing.id, partitionId, existing.id);
    // actor_person_id 是软引用（无 FK）：清空，避免留下悬空 actors。
    db.prepare('UPDATE memories SET actor_person_id = NULL WHERE partition_id = ? AND actor_person_id = ?').run(
      partitionId,
      existing.id,
    );
    db.prepare('DELETE FROM memories WHERE partition_id = ? AND person_id = ?').run(partitionId, existing.id);
    db.prepare('DELETE FROM person_facts WHERE partition_id = ? AND person_id = ?').run(partitionId, existing.id);
    db.prepare('DELETE FROM person_profiles WHERE partition_id = ? AND person_id = ?').run(partitionId, existing.id);
    db.prepare('DELETE FROM memory_briefs WHERE partition_id = ? AND person_id = ?').run(partitionId, existing.id);
    db.prepare('DELETE FROM sessions WHERE partition_id = ? AND person_id = ?').run(partitionId, existing.id);
    db.prepare('DELETE FROM persons WHERE id = ? AND partition_id = ?').run(existing.id, partitionId);
    reconcileCounts(db, partitionId);
  });
}

/**
 * 合规导出：canonical person + 全部 facts（含历史版本）+ 最近 10000 条 memories。
 * 超过上限时 truncated=true。
 */
export function exportPerson(db: DatabaseSync, partitionId: string, ref: string): PersonExport {
  const row = resolvePersonRow(db, partitionId, ref);
  if (!row) throw engineErrors.notFound('人不存在');
  const person = toPerson(row);

  const facts = (
    db
      .prepare(
        `SELECT * FROM person_facts
          WHERE partition_id = ? AND person_id = ?
          ORDER BY valid_from ASC, id ASC`,
      )
      .all(partitionId, person.id) as unknown as PersonFactRow[]
  ).map(toPersonFact);

  const rows = db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m JOIN persons p ON p.id = m.person_id
        WHERE m.partition_id = ? AND m.person_id = ?
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(partitionId, person.id, PERSON_EXPORT_MEMORY_LIMIT + 1) as unknown as MemoryRow[];

  const truncated = rows.length > PERSON_EXPORT_MEMORY_LIMIT;
  const memories: Memory[] = (truncated ? rows.slice(0, PERSON_EXPORT_MEMORY_LIMIT) : rows).map(toMemory);

  return {
    person,
    facts,
    memories,
    exportedAt: nowIso(),
    ...(truncated ? { truncated: true } : {}),
  };
}
