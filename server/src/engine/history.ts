import type { DatabaseSync } from 'node:sqlite';
import type { Actor, MemoryHistoryEntry, MemoryHistoryEvent } from '../../../shared/src/types.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { parseJson } from './rows.ts';

/** 逐条记忆的变更历史（v6.1 P0）：ADD / UPDATE / MERGE / SUPERSEDE / DELETE / NOOP / FEEDBACK。 */

export interface HistoryRow {
  id: string;
  partition_id: string;
  person_id: string | null;
  memory_id: string;
  event: string;
  old_content: string | null;
  new_content: string | null;
  actor: string | null;
  reason: string | null;
  meta: string;
  created_at: string;
}

export interface WriteHistoryInput {
  partitionId: string;
  memoryId: string;
  personId?: string | null;
  event: MemoryHistoryEvent;
  oldContent?: string | null;
  newContent?: string | null;
  actor?: Actor | string | null;
  reason?: string | null;
  meta?: Record<string, unknown>;
  createdAt?: string;
}

/** 审计里的 actor 统一成可读字符串（label 优先），同时把 id/type 写进 meta 由调用方决定。 */
export function actorLabel(actor: Actor | string | null | undefined): string | null {
  if (!actor) return null;
  if (typeof actor === 'string') return actor.slice(0, 200);
  return (actor.label || `${actor.type}:${actor.id}`).slice(0, 200);
}

export function writeHistory(db: DatabaseSync, input: WriteHistoryInput): string {
  const id = newId('hist');
  db.prepare(
    `INSERT INTO memory_history
       (id, partition_id, person_id, memory_id, event, old_content, new_content, actor, reason, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.partitionId,
    input.personId ?? null,
    input.memoryId,
    input.event,
    input.oldContent ?? null,
    input.newContent ?? null,
    actorLabel(input.actor),
    input.reason ? input.reason.slice(0, 500) : null,
    JSON.stringify(input.meta ?? {}),
    input.createdAt ?? nowIso(),
  );
  return id;
}

export function toHistoryEntry(row: HistoryRow): MemoryHistoryEntry {
  return {
    id: row.id,
    partitionId: row.partition_id,
    memoryId: row.memory_id,
    personId: row.person_id ?? undefined,
    event: row.event as MemoryHistoryEvent,
    oldContent: row.old_content ?? undefined,
    newContent: row.new_content ?? undefined,
    actor: row.actor ?? undefined,
    reason: row.reason ?? undefined,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    createdAt: row.created_at,
  };
}

/** 按记忆读历史（新→旧）。 */
export function listMemoryHistory(db: DatabaseSync, partitionId: string, memoryId: string): MemoryHistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_history
        WHERE partition_id = ? AND memory_id = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(partitionId, memoryId) as unknown as HistoryRow[];
  return rows.map(toHistoryEntry);
}
