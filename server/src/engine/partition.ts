import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PARTITION_SETTINGS } from '../../../shared/src/constants.ts';
import type {
  Actor,
  Partition,
  PartitionInput,
  PartitionStats,
  ReconcileResult,
} from '../../../shared/src/types.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { engineErrors } from './errors.ts';
import {
  mergeSettings,
  parseSettings,
  toPartition,
  toStats,
  type PartitionRow,
  type StatsRow,
} from './rows.ts';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

function validateSlug(slug: string): string {
  const value = slug.trim().toLowerCase();
  if (!SLUG_RE.test(value)) {
    throw engineErrors.validation('slug 仅支持小写字母、数字与连字符，且以字母或数字开头');
  }
  return value;
}

export function findPartitionById(db: DatabaseSync, id: string): PartitionRow | null {
  const row = db.prepare('SELECT * FROM partitions WHERE id = ?').get(id) as unknown as PartitionRow | undefined;
  return row ?? null;
}

export function findPartitionBySlug(db: DatabaseSync, orgId: string, slug: string): PartitionRow | null {
  const row = db
    .prepare('SELECT * FROM partitions WHERE org_id = ? AND slug = ?')
    .get(orgId, slug) as unknown as PartitionRow | undefined;
  return row ?? null;
}

/** 按内部 id 或组织内 slug 查找分区。 */
export function findPartitionRow(db: DatabaseSync, orgId: string, ref: string): PartitionRow | null {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) return null;
  const byId = findPartitionById(db, value);
  if (byId) return byId.org_id === orgId ? byId : null;
  return findPartitionBySlug(db, orgId, value);
}

export function loadStatsRow(db: DatabaseSync, partitionId: string): StatsRow {
  const row = db.prepare('SELECT * FROM partition_stats WHERE partition_id = ?').get(partitionId) as unknown as
    | StatsRow
    | undefined;
  if (row) return row;
  return {
    partition_id: partitionId,
    persons_total: 0,
    persons_human: 0,
    persons_agent: 0,
    persons_service: 0,
    memories_total: 0,
    shared_total: 0,
    sessions_total: 0,
    updated_at: nowIso(),
  };
}

/** 分区创建 / 幂等 upsert（org key + admin）。 */
export function upsertPartition(
  db: DatabaseSync,
  orgId: string,
  input: PartitionInput,
  _actor: Actor,
): Partition {
  const slug = validateSlug(input.slug);
  const name = (input.name ?? slug).trim().slice(0, 120) || slug;
  const description = (input.description ?? '').trim().slice(0, 500);
  const at = nowIso();
  const existing = findPartitionBySlug(db, orgId, slug);

  if (existing) {
    const settings = mergeSettings(parseSettings(existing.settings), input.settings);
    const status = input.status ?? existing.status;
    db.prepare(
      `UPDATE partitions
          SET name = ?, description = ?, status = ?, settings = ?, updated_at = ?,
              archived_at = CASE WHEN ? = 'archived' AND archived_at IS NULL THEN ? ELSE archived_at END
        WHERE id = ?`,
    ).run(name, description, status, JSON.stringify(settings), at, status, at, existing.id);
    const row = findPartitionById(db, existing.id) as PartitionRow;
    return toPartition(row, loadStatsRow(db, row.id));
  }

  const id = newId('ptn');
  const settings = mergeSettings(DEFAULT_PARTITION_SETTINGS, input.settings);
  const status = input.status ?? 'active';
  db.prepare(
    `INSERT INTO partitions
       (id, org_id, slug, name, description, status, settings, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, orgId, slug, name, description, status, JSON.stringify(settings), at, at, status === 'archived' ? at : null);
  const row = findPartitionById(db, id) as PartitionRow;
  return toPartition(row, loadStatsRow(db, id));
}

export function listPartitions(db: DatabaseSync, orgId: string): Partition[] {
  const rows = db
    .prepare(
      `SELECT p.*, s.persons_total, s.persons_human, s.persons_agent, s.persons_service,
              s.memories_total, s.shared_total, s.sessions_total, s.updated_at AS s_updated_at
         FROM partitions p
         LEFT JOIN partition_stats s ON s.partition_id = p.id
        WHERE p.org_id = ?
        ORDER BY p.created_at ASC, p.id ASC`,
    )
    .all(orgId) as unknown as Array<
    PartitionRow & {
      persons_total: number | null;
      persons_human: number | null;
      persons_agent: number | null;
      persons_service: number | null;
      memories_total: number | null;
      shared_total: number | null;
      sessions_total: number | null;
      s_updated_at: string | null;
    }
  >;
  return rows.map((row) => {
    const stats: StatsRow =
      row.s_updated_at === null
        ? {
            partition_id: row.id,
            persons_total: 0,
            persons_human: 0,
            persons_agent: 0,
            persons_service: 0,
            memories_total: 0,
            shared_total: 0,
            sessions_total: 0,
            updated_at: row.updated_at,
          }
        : {
            partition_id: row.id,
            persons_total: row.persons_total ?? 0,
            persons_human: row.persons_human ?? 0,
            persons_agent: row.persons_agent ?? 0,
            persons_service: row.persons_service ?? 0,
            memories_total: row.memories_total ?? 0,
            shared_total: row.shared_total ?? 0,
            sessions_total: row.sessions_total ?? 0,
            updated_at: row.s_updated_at,
          };
    return toPartition(row, stats);
  });
}

export function getPartition(db: DatabaseSync, orgId: string, ref: string): Partition | null {
  const row = findPartitionRow(db, orgId, ref);
  if (!row) return null;
  return toPartition(row, loadStatsRow(db, row.id));
}

export function updatePartition(
  db: DatabaseSync,
  orgId: string,
  ref: string,
  input: Partial<PartitionInput>,
  _actor: Actor,
): Partition {
  const existing = findPartitionRow(db, orgId, ref);
  if (!existing) throw engineErrors.notFound('分区不存在');
  const settings = mergeSettings(parseSettings(existing.settings), input.settings);
  const status = input.status ?? existing.status;
  const name = input.name !== undefined ? input.name.trim().slice(0, 120) || existing.name : existing.name;
  const description = input.description !== undefined ? input.description.trim().slice(0, 500) : existing.description;
  const at = nowIso();
  db.prepare(
    `UPDATE partitions
        SET name = ?, description = ?, status = ?, settings = ?, updated_at = ?,
            archived_at = CASE WHEN ? = 'archived' AND archived_at IS NULL THEN ? ELSE archived_at END
      WHERE id = ?`,
  ).run(name, description, status, JSON.stringify(settings), at, status, at, existing.id);
  const row = findPartitionById(db, existing.id) as PartitionRow;
  return toPartition(row, loadStatsRow(db, row.id));
}

export function partitionStats(db: DatabaseSync, partitionId: string): PartitionStats {
  return toStats(loadStatsRow(db, partitionId));
}

/** 批量导入 / 迁移后校准：重算 partition_stats 与 persons 的反规范化计数。 */
export function reconcileCounts(db: DatabaseSync, partitionId: string): ReconcileResult {
  const at = nowIso();
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS persons_total,
         SUM(CASE WHEN type = 'human' THEN 1 ELSE 0 END) AS persons_human,
         SUM(CASE WHEN type = 'agent' THEN 1 ELSE 0 END) AS persons_agent,
         SUM(CASE WHEN type = 'service' THEN 1 ELSE 0 END) AS persons_service
       FROM persons WHERE partition_id = ?`,
    )
    .get(partitionId) as unknown as {
    persons_total: number;
    persons_human: number;
    persons_agent: number;
    persons_service: number;
  };
  const mem = db
    .prepare(
      `SELECT COUNT(*) AS memories_total,
              SUM(CASE WHEN scope = 'partition' THEN 1 ELSE 0 END) AS shared_total
         FROM memories WHERE partition_id = ?`,
    )
    .get(partitionId) as unknown as { memories_total: number; shared_total: number };
  const sessions = db
    .prepare('SELECT COUNT(*) AS c FROM sessions WHERE partition_id = ?')
    .get(partitionId) as unknown as { c: number };

  db.prepare(
    `INSERT INTO partition_stats
       (partition_id, persons_total, persons_human, persons_agent, persons_service,
        memories_total, shared_total, sessions_total, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(partition_id) DO UPDATE SET
       persons_total = excluded.persons_total,
       persons_human = excluded.persons_human,
       persons_agent = excluded.persons_agent,
       persons_service = excluded.persons_service,
       memories_total = excluded.memories_total,
       shared_total = excluded.shared_total,
       sessions_total = excluded.sessions_total,
       updated_at = excluded.updated_at`,
  ).run(
    partitionId,
    stats.persons_total ?? 0,
    stats.persons_human ?? 0,
    stats.persons_agent ?? 0,
    stats.persons_service ?? 0,
    mem.memories_total ?? 0,
    mem.shared_total ?? 0,
    sessions.c ?? 0,
    at,
  );

  const updated = db
    .prepare(
      `UPDATE persons
          SET memory_count = (
                SELECT COUNT(*) FROM memories m
                 WHERE m.person_id = persons.id AND m.scope IN ('person', 'session')
              ),
              shared_memory_count = (
                SELECT COUNT(*) FROM memories m
                 WHERE m.person_id = persons.id AND m.scope = 'partition'
              ),
              session_count = (SELECT COUNT(*) FROM sessions s WHERE s.person_id = persons.id),
              last_memory_at = (SELECT MAX(m.created_at) FROM memories m WHERE m.person_id = persons.id),
              updated_at = ?
        WHERE partition_id = ?`,
    )
    .run(at, partitionId);

  return {
    partitionId,
    personsTotal: stats.persons_total ?? 0,
    memoriesTotal: mem.memories_total ?? 0,
    sharedTotal: mem.shared_total ?? 0,
    sessionsTotal: sessions.c ?? 0,
    updatedPersons: Number(updated.changes ?? 0),
  };
}
