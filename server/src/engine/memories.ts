import type { DatabaseSync } from 'node:sqlite';
import type {
  AddMemoryInput,
  Actor,
  CursorPage,
  Memory,
  MemoryAddResult,
  MemoryCategory,
  MemoryDetail,
  MemoryFeedbackInput,
  MemoryHistoryEntry,
  MemoryListQuery,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  PersonType,
  PrivacyScanResult,
  UpdateMemoryInput,
} from '../../../shared/src/types.ts';
import { tx } from '../db/index.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { memoryContentHash } from '../lib/text.ts';
import { attachmentCounts, insertAttachments, listAttachments, normalizeAttachments, withAttachmentCounts } from './attachments.ts';
import { decodeCursor, encodeCursor, normalizeLimit } from './cursor.ts';
import { blobToEmbedding, cosine, embedText, EMBEDDING_DIM, EMBEDDING_MODEL, embeddingToBlob } from './embed.ts';
import { engineErrors } from './errors.ts';
import { listMemoryHistory, writeHistory } from './history.ts';
import { enqueueMemoryJobs } from './jobs.ts';
import {
  countMemoryPlaceholders,
  countPlaceholderTokens,
  listMemoryPlaceholders,
  placeholderTokensOf,
  pruneMemoryPlaceholders,
  privacyJobNeeded,
  scanText,
  validatePlaceholders,
  withPlaceholderCounts,
  writeMemoryPlaceholders,
} from './privacy.ts';
import { findPartitionById, loadStatsRow } from './partition.ts';
import { findPersonRow, resolvePerson, resolvePersonRow, upsertPerson } from './persons.ts';
import {
  escapeLike,
  ftsQuery,
  likeContains,
  needsSubstringSearch,
  parseJson,
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

function normalizeIso(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw engineErrors.validation('时间必须是合法的 ISO 8601 字符串');
  return new Date(parsed).toISOString();
}

function factKeyOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key ? key.slice(0, 120) : null;
}

function fetchMemoryRow(db: DatabaseSync, partitionId: string, id: string): MemoryRow | undefined {
  return db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m JOIN persons p ON p.id = m.person_id
        WHERE m.partition_id = ? AND m.id = ?`,
    )
    .get(partitionId, id) as unknown as MemoryRow | undefined;
}

function memoryOf(db: DatabaseSync, partitionId: string, id: string): Memory {
  const row = fetchMemoryRow(db, partitionId, id);
  if (!row) throw engineErrors.notFound('记忆不存在');
  return withPlaceholderCounts(db, withAttachmentCounts(db, [toMemory(row)]))[0];
}

const EMPTY_SCAN: PrivacyScanResult = { text: '', redacted: false, hits: [], placeholders: {} };

function scanKinds(scan: PrivacyScanResult): Record<string, string> {
  if (Object.keys(scan.placeholders).length === 0) return {};
  const kinds: Record<string, string> = {};
  for (const [token, value] of Object.entries(scan.placeholders)) {
    const hit = scan.hits.find((item) => item.value === value);
    if (hit) kinds[token] = hit.entityType;
  }
  return kinds;
}

/** 以实际行数回填 metadata.placeholderCount（NOOP/MERGE 时用）。 */
function syncPlaceholderMetadata(db: DatabaseSync, memoryId: string): number {
  const count = countMemoryPlaceholders(db, memoryId);
  const row = db.prepare('SELECT metadata FROM memories WHERE id = ?').get(memoryId) as unknown as
    | { metadata: string }
    | undefined;
  if (!row) return count;
  const metadata = parseJson<Record<string, unknown>>(row.metadata, {});
  if (count > 0) metadata.placeholderCount = count;
  else delete metadata.placeholderCount;
  db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), memoryId);
  return count;
}

function writePrivacyHistory(
  db: DatabaseSync,
  input: {
    partitionId: string;
    personId: string;
    memoryId: string;
    oldContent: string;
    newContent: string;
    actor: Actor;
    hits: PrivacyScanResult['hits'];
    placeholders: number;
    reason: string;
  },
): void {
  writeHistory(db, {
    partitionId: input.partitionId,
    personId: input.personId,
    memoryId: input.memoryId,
    event: 'PRIVACY',
    oldContent: input.oldContent,
    newContent: input.newContent,
    actor: input.actor,
    reason: input.reason,
    meta: {
      hits: input.hits.length,
      codes: [...new Set(input.hits.map((hit) => hit.code))],
      kinds: [...new Set(input.hits.map((hit) => hit.entityType))],
      placeholders: input.placeholders,
    },
  });
}

interface NearDuplicate {
  row: MemoryRow;
  similarity: number;
}

/** 同人同分区最近 200 条有效记忆中找余弦最高者（用于 NOOP / MERGE）。 */
function findNearDuplicate(
  db: DatabaseSync,
  partitionId: string,
  personId: string,
  vector: Float32Array,
): NearDuplicate | null {
  const rows = db
    .prepare(
      `SELECT * FROM memories
        WHERE partition_id = ? AND person_id = ? AND status = 'active'
          AND valid_to IS NULL AND embedding IS NOT NULL
        ORDER BY created_at DESC LIMIT 200`,
    )
    .all(partitionId, personId) as unknown as MemoryRow[];
  let best: NearDuplicate | null = null;
  for (const row of rows) {
    const similarity = cosine(vector, blobToEmbedding(row.embedding));
    if (!best || similarity > best.similarity) best = { row, similarity };
  }
  return best && best.similarity >= 0 ? best : null;
}

function unionTags(raw: string, tags: string[] | undefined): string {
  const existing = (() => {
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  })();
  return JSON.stringify([...new Set([...existing, ...(tags ?? [])])]);
}

/**
 * 写管线（v6.1 P0）：
 *   归一化 hash 完全重复 → NOOP（返回已有 + history NOOP）
 *   余弦 ≥ dedupeThreshold → NOOP（近重复）
 *   余弦 ≥ mergeThreshold  → MERGE（更新内容/重要度/标签/metadata + history MERGE）
 *   显式 supersedesId 或相同 factKey → 旧记忆 valid_to=now / superseded_by=新 id，新记忆 supersedes=旧 id
 * 所有分支都在同一事务内写 memory_history 与入队异步任务。
 */
export function addMemory(db: DatabaseSync, input: AddMemoryInput): MemoryAddResult {
  const partition = findPartitionById(db, input.partitionId);
  if (!partition) throw engineErrors.notFound('分区不存在');
  if (partition.status === 'archived') throw engineErrors.archivedPartition();
  const settings = parseSettings(partition.settings);

  const rawContent = typeof input.content === 'string' ? input.content.trim() : '';
  if (!rawContent) throw engineErrors.validation('content 不能为空');
  if (rawContent.length > MAX_CONTENT_CHARS) throw engineErrors.validation('content 最长 20000 字符');
  // v6.2：显式占位符映射在总开关 off 时也保存（调用方主动抽离）；映射必须覆盖正文全部 token。
  const explicit = validatePlaceholders(rawContent, input.placeholders);
  // 写入同步路径只跑 regex；prompt 规则由 privacy job 异步补齐。off 时原样落库。
  const scan = settings.piiRedaction === 'basic' ? scanText(db, input.partitionId, rawContent) : EMPTY_SCAN;
  const content = settings.piiRedaction === 'basic' ? scan.text : rawContent;
  const placeholderValues: Record<string, string> = { ...explicit.mapping, ...scan.placeholders };
  const placeholderKinds = scanKinds(scan);
  const placeholderCount = countPlaceholderTokens(content);
  const schedulePrivacyScan = privacyJobNeeded(db, input.partitionId);
  const attachments = normalizeAttachments(input.attachments);

  const person = resolveWritePerson(db, input.partitionId, input, settings.personAutoCreate);
  const scope = scopeOf(input.scope, settings.defaultScope);

  let sessionId: string | null = null;
  if (scope === 'session') {
    if (!input.sessionId || !input.sessionId.trim()) {
      throw engineErrors.validation('scope=session 时必须提供 session_id');
    }
    sessionId = input.sessionId.trim().slice(0, 128);
  } else if (input.sessionId) {
    sessionId = input.sessionId.trim().slice(0, 128);
  }

  let actorPersonId = person.id;
  if (input.actorPersonId) {
    const actorRow = findPersonRow(db, input.partitionId, input.actorPersonId);
    actorPersonId = actorRow ? actorRow.id : person.id;
  }

  const now = nowIso();
  const explicitValidFrom = normalizeIso(input.validFrom);
  const validFrom = explicitValidFrom ?? now;
  const normalizedHash = memoryContentHash(content);
  const vector = embedText(content);
  const factKey = factKeyOf(input.factKey);
  const category = categoryOf(input.category);
  const importance = clamp01(input.importance, 0.5);
  const confidence = clamp01(input.confidence, 0.8);
  const source = sourceOf(input.source);
  const tags = JSON.stringify(input.tags ?? []);
  const metadataObject: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (scan.redacted) metadataObject.piiRedacted = true;
  if (placeholderCount > 0) metadataObject.placeholderCount = placeholderCount;
  const metadata = JSON.stringify(metadataObject);
  const privacyScannedAt = settings.piiRedaction === 'basic' ? now : null;
  const expiresAt = input.expiresAt === null ? null : input.expiresAt ?? null;
  const supersedesId = input.supersedesId?.trim() || null;

  if (sessionId) ensureSession(db, input.partitionId, person.id, sessionId, input.sessionTitle ?? '');

  return tx(db, (): MemoryAddResult => {
    /* 1) 完全重复：内容 hash 相同 */
    const duplicate = db
      .prepare(
        `SELECT * FROM memories
          WHERE partition_id = ? AND person_id = ? AND normalized_hash = ? AND status = 'active'
            AND valid_to IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.partitionId, person.id, normalizedHash) as unknown as MemoryRow | undefined;
    if (duplicate) {
      writeHistory(db, {
        partitionId: input.partitionId,
        personId: person.id,
        memoryId: duplicate.id,
        event: 'NOOP',
        oldContent: duplicate.content,
        newContent: content,
        actor: input.actor,
        reason: 'duplicate:hash',
        meta: { normalizedHash, similarity: 1 },
      });
      // 内容重复（NOOP）仍允许补充附件：附件是独立资源，不改变记忆内容。
      insertAttachments(db, input.partitionId, duplicate.id, attachments);
      // v6.2：NOOP 时合并/追加占位符映射（已有 token 不覆盖），并回填 metadata.placeholderCount。
      const written = writeMemoryPlaceholders(db, {
        partitionId: input.partitionId,
        memoryId: duplicate.id,
        content,
        mapping: placeholderValues,
        kinds: placeholderKinds,
        mode: 'merge',
      });
      pruneMemoryPlaceholders(db, duplicate.id, content);
      syncPlaceholderMetadata(db, duplicate.id);
      if (scan.redacted || written > 0) {
        writePrivacyHistory(db, {
          partitionId: input.partitionId,
          personId: person.id,
          memoryId: duplicate.id,
          oldContent: duplicate.content,
          newContent: duplicate.content,
          actor: input.actor,
          hits: scan.hits,
          placeholders: Object.keys(scan.placeholders).length,
          reason: scan.redacted ? 'privacy:scan' : 'privacy:placeholders',
        });
      }
      return {
        memory: withPlaceholderCounts(db, withAttachmentCounts(db, [memoryOf(db, input.partitionId, duplicate.id)]))[0],
        event: 'NOOP',
        ...(scan.redacted ? { piiRedacted: true } : {}),
      };
    }

    /* 2) 近重复 / 合并：同人同分区余弦（显式取代 / factKey 优先，不做自动合并） */
    const near = supersedesId || factKey ? null : findNearDuplicate(db, input.partitionId, person.id, vector);
    if (near && near.similarity >= settings.dedupeThreshold) {
      writeHistory(db, {
        partitionId: input.partitionId,
        personId: person.id,
        memoryId: near.row.id,
        event: 'NOOP',
        oldContent: near.row.content,
        newContent: content,
        actor: input.actor,
        reason: 'duplicate:similarity',
        meta: { similarity: Number(near.similarity.toFixed(6)), threshold: settings.dedupeThreshold },
      });
      // 近重复（NOOP）同样允许补充附件。
      insertAttachments(db, input.partitionId, near.row.id, attachments);
      const written = writeMemoryPlaceholders(db, {
        partitionId: input.partitionId,
        memoryId: near.row.id,
        content,
        mapping: placeholderValues,
        kinds: placeholderKinds,
        mode: 'merge',
      });
      pruneMemoryPlaceholders(db, near.row.id, content);
      syncPlaceholderMetadata(db, near.row.id);
      if (scan.redacted || written > 0) {
        writePrivacyHistory(db, {
          partitionId: input.partitionId,
          personId: person.id,
          memoryId: near.row.id,
          oldContent: near.row.content,
          newContent: near.row.content,
          actor: input.actor,
          hits: scan.hits,
          placeholders: Object.keys(scan.placeholders).length,
          reason: scan.redacted ? 'privacy:scan' : 'privacy:placeholders',
        });
      }
      return {
        memory: withPlaceholderCounts(db, withAttachmentCounts(db, [memoryOf(db, input.partitionId, near.row.id)]))[0],
        event: 'NOOP',
        ...(scan.redacted ? { piiRedacted: true } : {}),
      };
    }
    if (near && near.similarity >= settings.mergeThreshold) {
      const mergedTags = unionTags(near.row.tags, input.tags);
      const mergedMetadataObject = {
        ...(() => {
          try {
            return JSON.parse(near.row.metadata) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
        ...(input.metadata ?? {}),
        ...(scan.redacted ? { piiRedacted: true } : {}),
        ...(placeholderCount > 0 ? { placeholderCount } : {}),
      };
      if (placeholderCount === 0) delete mergedMetadataObject.placeholderCount;
      const mergedMetadata = JSON.stringify(mergedMetadataObject);
      const mergedImportance = Math.max(near.row.importance, importance);
      const mergedConfidence = Math.max(near.row.confidence, confidence);
      db.prepare(
        `UPDATE memories
            SET content = ?, normalized_hash = ?, embedding = ?, embedding_model = ?, dim = ?,
                importance = ?, confidence = ?, tags = ?, metadata = ?, category = ?, privacy_scanned_at = ?,
                updated_at = ?
          WHERE id = ?`,
      ).run(
        content,
        normalizedHash,
        embeddingToBlob(vector),
        EMBEDDING_MODEL,
        EMBEDDING_DIM,
        mergedImportance,
        mergedConfidence,
        mergedTags,
        mergedMetadata,
        category,
        privacyScannedAt,
        now,
        near.row.id,
      );
      writeMemoryPlaceholders(db, {
        partitionId: input.partitionId,
        memoryId: near.row.id,
        content,
        mapping: placeholderValues,
        kinds: placeholderKinds,
        mode: 'replace',
      });
      pruneMemoryPlaceholders(db, near.row.id, content);
      syncPlaceholderMetadata(db, near.row.id);
      if (scan.redacted || placeholderCount > 0) {
        writePrivacyHistory(db, {
          partitionId: input.partitionId,
          personId: person.id,
          memoryId: near.row.id,
          oldContent: near.row.content,
          newContent: content,
          actor: input.actor,
          hits: scan.hits,
          placeholders: Object.keys(scan.placeholders).length,
          reason: scan.redacted ? 'privacy:scan' : 'privacy:placeholders',
        });
      }
      writeHistory(db, {
        partitionId: input.partitionId,
        personId: person.id,
        memoryId: near.row.id,
        event: 'MERGE',
        oldContent: near.row.content,
        newContent: content,
        actor: input.actor,
        reason: 'merge:similarity',
        meta: { similarity: Number(near.similarity.toFixed(6)), threshold: settings.mergeThreshold },
      });
      enqueueMemoryJobs(db, {
        partitionId: input.partitionId,
        personId: person.id,
        memoryId: near.row.id,
        hasEmbedding: true,
        autoExtractEntities: settings.autoExtractEntities,
        factKey,
        privacyScan: schedulePrivacyScan,
      });
      // P2：合并写入同样接受附件（追加到已有记忆）。
      insertAttachments(db, input.partitionId, near.row.id, attachments);
      const merged = withPlaceholderCounts(db, withAttachmentCounts(db, [memoryOf(db, input.partitionId, near.row.id)]))[0];
      return { memory: merged, event: 'MERGE', ...(scan.redacted ? { piiRedacted: true } : {}) };
    }

    /* 3) 取代：显式 supersedesId 或同 factKey 的旧记忆 */
    const supersedeIds: string[] = [];
    const oldRows: MemoryRow[] = [];
    const pushSupersede = (row: MemoryRow | undefined): void => {
      if (!row) return;
      if (supersedeIds.includes(row.id)) return;
      supersedeIds.push(row.id);
      oldRows.push(row);
    };
    if (supersedesId) {
      const old = db
        .prepare('SELECT * FROM memories WHERE partition_id = ? AND person_id = ? AND id = ?')
        .get(input.partitionId, person.id, supersedesId) as unknown as MemoryRow | undefined;
      if (!old) throw engineErrors.notFound('被取代的记忆不存在');
      if (old.valid_to) throw engineErrors.conflict('被取代的记忆已失效');
      pushSupersede(old);
    }
    if (factKey) {
      const sameFact = db
        .prepare(
          `SELECT * FROM memories
            WHERE partition_id = ? AND person_id = ? AND fact_key = ? AND status = 'active'
              AND valid_to IS NULL
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(input.partitionId, person.id, factKey) as unknown as MemoryRow | undefined;
      if (sameFact && !supersedeIds.includes(sameFact.id)) pushSupersede(sameFact);
    }

    /* 4) 写入新记忆 */
    const id = newId('mem');
    db.prepare(
      `INSERT INTO memories
         (id, partition_id, person_id, actor_person_id, scope, session_id, category, content,
          importance, confidence, source, status, tags, metadata, created_at, updated_at, expires_at, dreamed_at,
          normalized_hash, embedding, embedding_model, dim, valid_from, valid_to, superseded_by, supersedes,
          fact_key, feedback_up, feedback_down, privacy_scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL,
               ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, 0, ?)`,
    ).run(
      id,
      input.partitionId,
      person.id,
      actorPersonId,
      scope,
      sessionId,
      category,
      content,
      importance,
      confidence,
      source,
      tags,
      metadata,
      now,
      now,
      expiresAt,
      normalizedHash,
      embeddingToBlob(vector),
      EMBEDDING_MODEL,
      EMBEDDING_DIM,
      validFrom,
      oldRows[0]?.id ?? null,
      factKey,
      privacyScannedAt,
    );
    // P2：多模态附件（memory_attachments），写入与主体同事务。
    insertAttachments(db, input.partitionId, id, attachments);
    // v6.2：占位符映射（显式 + 扫描自动生成）与记忆同事务落库。
    writeMemoryPlaceholders(db, {
      partitionId: input.partitionId,
      memoryId: id,
      content,
      mapping: placeholderValues,
      kinds: placeholderKinds,
      mode: 'replace',
    });
    pruneMemoryPlaceholders(db, id, content);
    if (scan.redacted || placeholderCount > 0) {
      writePrivacyHistory(db, {
        partitionId: input.partitionId,
        personId: person.id,
        memoryId: id,
        oldContent: '',
        newContent: content,
        actor: input.actor,
        hits: scan.hits,
        placeholders: Object.keys(scan.placeholders).length,
        reason: scan.redacted ? 'privacy:scan' : 'privacy:placeholders',
      });
    }

    for (const old of oldRows) {
      db.prepare(
        'UPDATE memories SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND valid_to IS NULL',
      ).run(now, id, now, old.id);
      writeHistory(db, {
        partitionId: input.partitionId,
        personId: person.id,
        memoryId: old.id,
        event: 'SUPERSEDE',
        oldContent: old.content,
        newContent: content,
        actor: input.actor,
        reason: 'superseded',
        meta: { supersededBy: id, factKey: factKey ?? undefined },
        createdAt: now,
      });
    }

    writeHistory(db, {
      partitionId: input.partitionId,
      personId: person.id,
      memoryId: id,
      event: 'ADD',
      newContent: content,
      actor: input.actor,
      reason: 'add',
      meta: {
        scope,
        category,
        factKey: factKey ?? undefined,
        supersedes: oldRows[0]?.id ?? undefined,
        attachments: attachments.length > 0 ? attachments.length : undefined,
      },
      createdAt: now,
    });

    enqueueMemoryJobs(db, {
      partitionId: input.partitionId,
      personId: person.id,
      memoryId: id,
      hasEmbedding: true,
      autoExtractEntities: settings.autoExtractEntities,
      factKey,
      privacyScan: schedulePrivacyScan,
    });

    return {
      memory: withPlaceholderCounts(db, withAttachmentCounts(db, [memoryOf(db, input.partitionId, id)]))[0],
      event: oldRows.length > 0 ? 'SUPERSEDE' : 'ADD',
      supersededId: oldRows[0]?.id,
      ...(scan.redacted ? { piiRedacted: true } : {}),
    };
  });
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
    // 跟随 merged_into：按被合并源人查询时返回 canonical 人的记忆。
    const person = resolvePersonRow(db, query.partitionId, ref);
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
  const items = withPlaceholderCounts(
    db,
    withAttachmentCounts(db, (hasMore ? rows.slice(0, limit) : rows).map(memoryFromJoinedRow)),
  );
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
  const memory = toMemory(row);
  const attachments = listAttachments(db, id);
  memory.attachmentCount = attachments.length;
  memory.attachments = attachments;
  // v6.2：详情默认返回占位符 key/kind/encrypted；?reveal=placeholders 由路由层再解密。
  const placeholders = listMemoryPlaceholders(db, partitionId, id, false);
  memory.placeholderCount = placeholders.length;
  return {
    memory,
    person: personRow ? toPerson(personRow) : null,
    ...(placeholders.length > 0 ? { placeholders } : {}),
  };
}

export function updateMemory(
  db: DatabaseSync,
  partitionId: string,
  id: string,
  input: UpdateMemoryInput,
  actor: Actor,
): Memory {
  return tx(db, () => {
    const existing = db
      .prepare('SELECT * FROM memories WHERE partition_id = ? AND id = ?')
      .get(partitionId, id) as unknown as MemoryRow | undefined;
    if (!existing) throw engineErrors.notFound('记忆不存在');

    const partitionRow = db.prepare('SELECT settings FROM partitions WHERE id = ?').get(partitionId) as unknown as
      | { settings: string }
      | undefined;
    const settings = parseSettings(partitionRow?.settings ?? null);
    const at = nowIso();
    const existingPlaceholders = listMemoryPlaceholders(db, partitionId, id, false);
    const existingKeySet = new Set(existingPlaceholders.map((item) => item.placeholder));
    const existingKinds: Record<string, string> = {};
    for (const item of existingPlaceholders) if (item.kind) existingKinds[item.placeholder] = item.kind;

    const sets: string[] = [];
    const params: (string | number | null | Uint8Array)[] = [];
    let nextContent = existing.content;
    let piiRedacted = false;
    let scan: PrivacyScanResult = EMPTY_SCAN;
    let explicit: ReturnType<typeof validatePlaceholders> | null = null;
    let mappingToWrite: Record<string, string> | null = null;
    let mappingMode: 'replace' | 'merge' = 'merge';
    let contentChanged = false;

    if (input.content !== undefined) {
      const raw = input.content.trim();
      if (!raw) throw engineErrors.validation('content 不能为空');
      if (raw.length > MAX_CONTENT_CHARS) throw engineErrors.validation('content 最长 20000 字符');
      if (input.placeholders !== undefined) {
        explicit = validatePlaceholders(raw, input.placeholders);
      } else {
        // 未提交映射时，正文 token 必须已有映射（更新不改变既有占位符值）。
        const missing = placeholderTokensOf(raw).filter((token) => !existingKeySet.has(token));
        if (missing.length > 0) {
          throw engineErrors.validation(`以下占位符缺少映射值：${missing.map((token) => `{{${token}}}`).join('、')}`);
        }
      }
      // v6.2：更新内容时按规则扫描（同步只跑 regex；prompt 交给 privacy job）。
      scan = settings.piiRedaction === 'basic' ? scanText(db, partitionId, raw) : EMPTY_SCAN;
      const content = settings.piiRedaction === 'basic' ? scan.text : raw;
      piiRedacted = scan.redacted;
      nextContent = content;
      contentChanged = content !== existing.content;
      sets.push('content = ?', 'normalized_hash = ?', 'embedding = ?', 'embedding_model = ?', 'dim = ?');
      params.push(
        content,
        memoryContentHash(content),
        embeddingToBlob(embedText(content)),
        EMBEDDING_MODEL,
        EMBEDDING_DIM,
      );
      sets.push('privacy_scanned_at = ?');
      params.push(settings.piiRedaction === 'basic' ? at : null);
    } else if (input.placeholders !== undefined) {
      explicit = validatePlaceholders(existing.content, input.placeholders);
    }

    if (explicit) {
      mappingToWrite = { ...explicit.mapping, ...scan.placeholders };
      mappingMode = 'replace';
    } else if (Object.keys(scan.placeholders).length > 0) {
      mappingToWrite = scan.placeholders;
      mappingMode = 'merge';
    }

    const nextPlaceholderCount = countPlaceholderTokens(nextContent);
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
    if (input.metadata !== undefined || piiRedacted || mappingToWrite) {
      const metadataObject: Record<string, unknown> = {
        ...(input.metadata ?? parseJson<Record<string, unknown>>(existing.metadata, {})),
      };
      if (piiRedacted) metadataObject.piiRedacted = true;
      if (nextPlaceholderCount > 0) metadataObject.placeholderCount = nextPlaceholderCount;
      else delete metadataObject.placeholderCount;
      sets.push('metadata = ?');
      params.push(JSON.stringify(metadataObject));
    }
    if (input.expiresAt !== undefined) {
      sets.push('expires_at = ?');
      params.push(input.expiresAt);
    }
    if (sets.length === 0) throw engineErrors.validation('至少提供一个待更新字段');

    sets.push('updated_at = ?');
    params.push(at);
    db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE partition_id = ? AND id = ?`).run(...params, partitionId, id);

    let placeholdersWritten = 0;
    if (mappingToWrite) {
      placeholdersWritten = writeMemoryPlaceholders(db, {
        partitionId,
        memoryId: id,
        content: nextContent,
        mapping: mappingToWrite,
        kinds: { ...existingKinds, ...scanKinds(scan) },
        mode: mappingMode,
      });
    }
    if (contentChanged) pruneMemoryPlaceholders(db, id, nextContent);
    if (mappingToWrite || contentChanged) syncPlaceholderMetadata(db, id);

    writeHistory(db, {
      partitionId,
      personId: existing.person_id,
      memoryId: id,
      event: 'UPDATE',
      oldContent: existing.content,
      newContent: nextContent,
      actor,
      reason: 'update',
      meta: {
        fields: Object.keys(input).filter((key) => (input as Record<string, unknown>)[key] !== undefined),
        before: { importance: existing.importance, confidence: existing.confidence, status: existing.status },
        after: {
          importance: input.importance ?? existing.importance,
          confidence: input.confidence ?? existing.confidence,
          status: input.status ?? existing.status,
        },
        normalizedHash: nextContent === existing.content ? undefined : memoryContentHash(nextContent),
        piiRedacted: piiRedacted || undefined,
      },
      createdAt: at,
    });

    if (scan.redacted || mappingToWrite || placeholdersWritten > 0) {
      writePrivacyHistory(db, {
        partitionId,
        personId: existing.person_id,
        memoryId: id,
        oldContent: existing.content,
        newContent: nextContent,
        actor,
        hits: scan.hits,
        placeholders: Object.keys(scan.placeholders).length,
        reason: scan.redacted ? 'privacy:scan' : 'privacy:placeholders',
      });
    }

    if (contentChanged && privacyJobNeeded(db, partitionId)) {
      enqueueMemoryJobs(db, {
        partitionId,
        personId: existing.person_id,
        memoryId: id,
        hasEmbedding: true,
        autoExtractEntities: settings.autoExtractEntities,
        factKey: existing.fact_key ?? undefined,
        privacyScan: true,
      });
    }

    return memoryOf(db, partitionId, id);
  });
}

export function removeMemory(db: DatabaseSync, partitionId: string, id: string, actor?: Actor): void {
  tx(db, () => {
    const existing = db
      .prepare('SELECT * FROM memories WHERE partition_id = ? AND id = ?')
      .get(partitionId, id) as unknown as MemoryRow | undefined;
    if (!existing) throw engineErrors.notFound('记忆不存在');
    writeHistory(db, {
      partitionId,
      personId: existing.person_id,
      memoryId: id,
      event: 'DELETE',
      oldContent: existing.content,
      actor: actor ?? null,
      reason: 'delete',
      meta: { personId: existing.person_id, scope: existing.scope },
    });
    // P2：按 memory_id 清理实体关联 / 共现关系 / 附件（无 FK，需显式清理）。
    db.prepare('DELETE FROM relations WHERE memory_id = ?').run(id);
    db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(id);
    db.prepare('DELETE FROM memory_attachments WHERE memory_id = ?').run(id);
    db.prepare('DELETE FROM memory_placeholders WHERE memory_id = ?').run(id);
    db.prepare('DELETE FROM memories WHERE partition_id = ? AND id = ?').run(partitionId, id);
  });
}

/** 检索反馈：helpful 计数 + confidence ±0.05（夹在 0.05–1），写 FEEDBACK history。 */
export function feedbackMemory(
  db: DatabaseSync,
  partitionId: string,
  id: string,
  input: MemoryFeedbackInput,
  actor: Actor,
): Memory {
  return tx(db, () => {
    const existing = db
      .prepare('SELECT * FROM memories WHERE partition_id = ? AND id = ?')
      .get(partitionId, id) as unknown as MemoryRow | undefined;
    if (!existing) throw engineErrors.notFound('记忆不存在');
    const helpful = input.helpful === true;
    const before = existing.confidence;
    const after = Math.round(Math.min(1, Math.max(0.05, before + (helpful ? 0.05 : -0.05))) * 10_000) / 10_000;
    const at = nowIso();
    db.prepare(
      `INSERT INTO memory_feedback (id, partition_id, memory_id, person_id, helpful, query, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('fb'),
      partitionId,
      id,
      existing.person_id,
      helpful ? 1 : 0,
      input.query ? input.query.slice(0, 2000) : null,
      actor.label || `${actor.type}:${actor.id}`,
      at,
    );
    if (helpful) {
      db.prepare('UPDATE memories SET feedback_up = feedback_up + 1, confidence = ? WHERE id = ?').run(after, id);
    } else {
      db.prepare('UPDATE memories SET feedback_down = feedback_down + 1, confidence = ? WHERE id = ?').run(after, id);
    }
    writeHistory(db, {
      partitionId,
      personId: existing.person_id,
      memoryId: id,
      event: 'FEEDBACK',
      oldContent: existing.content,
      newContent: existing.content,
      actor,
      reason: input.reason ?? (helpful ? 'helpful' : 'not-helpful'),
      meta: {
        helpful,
        query: input.query ?? undefined,
        confidenceBefore: Number(before.toFixed(4)),
        confidenceAfter: Number(after.toFixed(4)),
      },
      createdAt: at,
    });
    return memoryOf(db, partitionId, id);
  });
}

export function memoryHistory(db: DatabaseSync, partitionId: string, id: string): MemoryHistoryEntry[] {
  const existing = db
    .prepare('SELECT id FROM memories WHERE partition_id = ? AND id = ?')
    .get(partitionId, id) as unknown as { id: string } | undefined;
  if (!existing) throw engineErrors.notFound('记忆不存在');
  return listMemoryHistory(db, partitionId, id);
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
            WHERE m.partition_id = ? AND m.status = 'active' AND m.valid_to IS NULL
              AND (m.person_id = ? OR m.scope = 'partition')
            ORDER BY m.importance DESC, m.created_at DESC, m.id DESC
            LIMIT ?`,
        )
        .all(partitionId, personId, limit) as unknown as MemoryRow[])
    : (db
        .prepare(
          `SELECT m.*, p.external_id AS person_external_id
             FROM memories m JOIN persons p ON p.id = m.person_id
            WHERE m.partition_id = ? AND m.status = 'active' AND m.valid_to IS NULL AND m.scope = 'partition'
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
  const where = [
    'm.partition_id = ?',
    'm.person_id = ?',
    "m.status = 'active'",
    'm.valid_to IS NULL',
    "m.scope IN ('person', 'session')",
  ];
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
  const where = ["m.partition_id = ?", "m.status = 'active'", 'm.valid_to IS NULL', "m.scope = 'partition'"];
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
            WHERE m.partition_id = ? AND m.person_id = ? AND m.status = 'active' AND m.valid_to IS NULL
              AND m.scope IN ('person', 'session') AND m.dreamed_at IS NULL
            ORDER BY m.created_at ASC, m.id ASC
            LIMIT ?`,
        )
        .all(partitionId, personId, limit) as unknown as MemoryRow[])
    : (db
        .prepare(
          `SELECT m.*, p.external_id AS person_external_id
             FROM memories m JOIN persons p ON p.id = m.person_id
            WHERE m.partition_id = ? AND m.status = 'active' AND m.valid_to IS NULL AND m.scope = 'partition'
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
            WHERE partition_id = ? AND person_id = ? AND status = 'active' AND valid_to IS NULL
              AND scope IN ('person', 'session') AND dreamed_at IS NULL`,
        )
        .get(partitionId, personId) as unknown as { c: number })
    : (db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories
            WHERE partition_id = ? AND status = 'active' AND valid_to IS NULL AND scope = 'partition' AND dreamed_at IS NULL`,
        )
        .get(partitionId) as unknown as { c: number });
  return row?.c ?? 0;
}

export function markDreamed(db: DatabaseSync, ids: string[], at: string): void {
  const stmt = db.prepare('UPDATE memories SET dreamed_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(at, id);
}
