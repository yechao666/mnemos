/**
 * 记忆持久化层：行映射、项目设置合并、以及「一条记忆 + 全部派生索引」的写入。
 *
 * 契约：memories / memory_terms / entities / memory_entities / relations / memory_history
 * 六张表在同一个事务内保持一致（调用方负责事务边界）。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  BRIEF_MAX_CHARS,
  BRIEF_MIN_CHARS,
  DEFAULT_PROJECT_SETTINGS,
  DREAM_MAX_INTERVAL_MINUTES,
  DREAM_MIN_INTERVAL_MINUTES,
} from '../../../shared/src/constants.ts';
import type {
  Memory,
  MemoryCategory,
  MemoryEventType,
  MemoryHistoryEntry,
  MemorySource,
  MemoryStatus,
  MemoryVisibility,
  ProjectSettings,
  RetrievalWeights,
} from '../../../shared/src/types.ts';
import { newId, nowIso, sha256 } from '../lib/ids.ts';
import { DIM, embedText, vectorToBlob, blobToVector, cosine } from './embed.ts';
import { normalizeText, rankTerms, termFrequencies } from './tokenize.ts';
import type { ExtractedEntity, ExtractedRelation } from './extract.ts';
import { normalizeEntityName } from './extract.ts';

/** memories 表行（snake_case）。 */
export interface MemoryRow {
  id: string;
  project_id: string;
  user_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  app_id: string | null;
  task_id: string | null;
  visibility: string;
  content: string;
  normalized_hash: string;
  category: string;
  importance: number;
  confidence: number;
  source: string;
  status: string;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  expires_at: string | null;
  embedding: Uint8Array | null;
  embedding_model: string | null;
  dim: number | null;
}

export interface HistoryRow {
  id: string;
  memory_id: string;
  project_id: string;
  event: string;
  old_content: string | null;
  new_content: string | null;
  actor: string;
  reason: string | null;
  meta: string;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* 项目设置                                                            */
/* ------------------------------------------------------------------ */

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** 与 DEFAULT_PROJECT_SETTINGS 深度合并（含 weights 子对象）。 */
export function mergeSettings(raw: unknown): ProjectSettings {
  const defaults = DEFAULT_PROJECT_SETTINGS;
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const weightsRaw = source.weights && typeof source.weights === 'object' ? (source.weights as Record<string, unknown>) : {};
  const weights: RetrievalWeights = {
    semantic: Math.max(0, asNumber(weightsRaw.semantic, defaults.weights.semantic)),
    keyword: Math.max(0, asNumber(weightsRaw.keyword, defaults.weights.keyword)),
    entity: Math.max(0, asNumber(weightsRaw.entity, defaults.weights.entity)),
    recency: Math.max(0, asNumber(weightsRaw.recency, defaults.weights.recency)),
  };
  const settings: ProjectSettings = {
    extractionMode: source.extractionMode === 'consolidate' ? 'consolidate' : defaults.extractionMode,
    embeddingModel: asString(source.embeddingModel, defaults.embeddingModel),
    topK: Math.max(1, Math.round(asNumber(source.topK, defaults.topK))),
    threshold: Math.max(0, Math.min(1, asNumber(source.threshold, defaults.threshold))),
    retentionDays: Math.max(1, Math.round(asNumber(source.retentionDays, defaults.retentionDays))),
    graphEnabled: typeof source.graphEnabled === 'boolean' ? source.graphEnabled : defaults.graphEnabled,
    dedupeThreshold: Math.max(0, Math.min(1, asNumber(source.dedupeThreshold, defaults.dedupeThreshold))),
    weights,
    monthlyQuota: Math.max(1, Math.round(asNumber(source.monthlyQuota, defaults.monthlyQuota))),
    locale: asString(source.locale, defaults.locale),
    briefMaxChars: Math.max(
      BRIEF_MIN_CHARS,
      Math.min(BRIEF_MAX_CHARS, Math.round(asNumber(source.briefMaxChars, defaults.briefMaxChars))),
    ),
    briefEnabled: typeof source.briefEnabled === 'boolean' ? source.briefEnabled : defaults.briefEnabled,
    dreamEnabled: typeof source.dreamEnabled === 'boolean' ? source.dreamEnabled : defaults.dreamEnabled,
    dreamIntervalMinutes: Math.max(
      DREAM_MIN_INTERVAL_MINUTES,
      Math.min(
        DREAM_MAX_INTERVAL_MINUTES,
        Math.round(asNumber(source.dreamIntervalMinutes, defaults.dreamIntervalMinutes)),
      ),
    ),
    reportsEnabled:
      typeof source.reportsEnabled === 'boolean' ? source.reportsEnabled : defaults.reportsEnabled,
    weeklyReportDay: Math.max(1, Math.min(7, Math.round(asNumber(source.weeklyReportDay, defaults.weeklyReportDay)))),
    weeklyReportTime:
      typeof source.weeklyReportTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(source.weeklyReportTime)
        ? source.weeklyReportTime
        : defaults.weeklyReportTime,
    monthlyReportDay: Math.max(1, Math.min(28, Math.round(asNumber(source.monthlyReportDay, defaults.monthlyReportDay)))),
    monthlyReportTime:
      typeof source.monthlyReportTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(source.monthlyReportTime)
        ? source.monthlyReportTime
        : defaults.monthlyReportTime,
  };
  if (typeof source.webhookUrl === 'string' && source.webhookUrl.length > 0) settings.webhookUrl = source.webhookUrl;
  return settings;
}

/** 读取项目设置；项目不存在或 JSON 损坏时回退默认值。 */
export function loadSettings(db: DatabaseSync, projectId: string): ProjectSettings {
  const row = db.prepare('SELECT settings FROM projects WHERE id = ?').get(projectId) as { settings?: string } | undefined;
  if (!row?.settings) return mergeSettings(null);
  try {
    return mergeSettings(JSON.parse(row.settings));
  } catch {
    return mergeSettings(null);
  }
}

/* ------------------------------------------------------------------ */
/* 行映射                                                              */
/* ------------------------------------------------------------------ */

export function parseTagList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 归一化可见性：旧数据 / 异常值回退 project（迁移列有默认值，这里只做兜底）。 */
export function asVisibility(value: unknown): MemoryVisibility {
  return value === 'agent' || value === 'task' ? value : 'project';
}

/** 行 → 领域对象（schema 未定义的字段一律不出现）。 */
export function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    runId: row.run_id ?? undefined,
    appId: row.app_id ?? undefined,
    taskId: row.task_id ?? undefined,
    visibility: asVisibility(row.visibility),
    content: row.content,
    category: row.category as MemoryCategory,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    source: row.source as MemorySource,
    status: row.status as MemoryStatus,
    tags: parseTagList(row.tags),
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at ?? undefined,
    accessCount: Number(row.access_count),
    expiresAt: row.expires_at ?? undefined,
  };
}

export function mapHistory(row: HistoryRow): MemoryHistoryEntry {
  return {
    id: row.id,
    memoryId: row.memory_id,
    event: row.event as MemoryEventType,
    oldContent: row.old_content ?? undefined,
    newContent: row.new_content ?? undefined,
    actor: row.actor,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    meta: parseMetadata(row.meta),
  };
}

/* ------------------------------------------------------------------ */
/* 查询基础                                                            */
/* ------------------------------------------------------------------ */

export function getMemoryRow(db: DatabaseSync, projectId: string, id: string): MemoryRow | undefined {
  return db.prepare('SELECT * FROM memories WHERE project_id = ? AND id = ?').get(projectId, id) as unknown as MemoryRow | undefined;
}

export function requireMemoryRow(db: DatabaseSync, projectId: string, id: string): MemoryRow {
  const row = getMemoryRow(db, projectId, id);
  if (!row) throw new Error(`memory not found: ${id}`);
  return row;
}

/** 作用域相等（null 安全，SQLite 的 IS 支持绑定参数）。 */
export interface MemoryScope {
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  appId?: string | null;
}

export const SCOPE_COLUMNS: { key: keyof MemoryScope; column: string }[] = [
  { key: 'userId', column: 'user_id' },
  { key: 'agentId', column: 'agent_id' },
  { key: 'runId', column: 'run_id' },
  { key: 'appId', column: 'app_id' },
];

export function scopeClause(scope: MemoryScope, alias = 'm'): { sql: string; params: (string | null)[] } {
  const parts: string[] = [];
  const params: (string | null)[] = [];
  for (const { key, column } of SCOPE_COLUMNS) {
    parts.push(`${alias}.${column} IS ?`);
    params.push(scope[key] ?? null);
  }
  return { sql: parts.join(' AND '), params };
}

/* ------------------------------------------------------------------ */
/* 可见性                                                              */
/* ------------------------------------------------------------------ */

export interface VisibilityScope {
  /** 调用方 Agent：可见自己的私有记忆 */
  agentId?: string | null;
  /** 调用方任务：可见本任务写入的记忆 */
  taskId?: string | null;
  /** 显式过滤到某一种可见性 */
  visibility?: MemoryVisibility;
  /** 控制台 / 审计视角：不过滤可见性 */
  includePrivate?: boolean;
}

/**
 * Agent 原生可见性规则（SQL 片段）：
 *  - includePrivate=true：不过滤（控制台 / 审计）；
 *  - 否则只保留 `visibility='project'`，以及 `agent_id = 调用方 agentId`、
 *    `task_id = 调用方 taskId` 的记忆；
 *  - 显式 visibility 过滤叠加在最外层。
 */
export function visibilityClause(scope: VisibilityScope, alias = 'm'): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (scope.visibility) {
    parts.push(`${alias}.visibility = ?`);
    params.push(scope.visibility);
  }
  if (!scope.includePrivate) {
    const visible: string[] = [`${alias}.visibility = 'project'`];
    if (scope.agentId) {
      visible.push(`${alias}.agent_id = ?`);
      params.push(scope.agentId);
    }
    if (scope.taskId) {
      visible.push(`${alias}.task_id = ?`);
      params.push(scope.taskId);
    }
    parts.push(`(${visible.join(' OR ')})`);
  }
  return { sql: parts.join(' AND '), params };
}

/** 把数组切成若干块（SQL 参数上限保护）。 */
export function chunk<T>(items: T[], size = 500): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export function contentHash(content: string): string {
  return sha256(normalizeText(content));
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

export interface HistoryInput {
  projectId: string;
  memoryId: string;
  event: MemoryEventType;
  oldContent?: string | null;
  newContent?: string | null;
  actor: string;
  reason?: string | null;
  meta?: Record<string, unknown>;
  at?: string;
}

export function writeHistory(db: DatabaseSync, input: HistoryInput): void {
  db.prepare(
    `INSERT INTO memory_history
      (id, memory_id, project_id, event, old_content, new_content, actor, reason, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('hist'),
    input.memoryId,
    input.projectId,
    input.event,
    input.oldContent ?? null,
    input.newContent ?? null,
    input.actor,
    input.reason ?? null,
    JSON.stringify(input.meta ?? {}),
    input.at ?? nowIso(),
  );
}

/** 重建词项（BM25 索引）。 */
export function replaceTerms(db: DatabaseSync, projectId: string, memoryId: string, content: string): void {
  db.prepare('DELETE FROM memory_terms WHERE memory_id = ?').run(memoryId);
  const insert = db.prepare('INSERT OR REPLACE INTO memory_terms (memory_id, project_id, term, tf) VALUES (?, ?, ?, ?)');
  for (const [term, tf] of termFrequencies(content)) insert.run(memoryId, projectId, term, tf);
}

/** 解除实体关联并回退 mention_count（更新/重建内容时使用）。 */
export function detachEntities(db: DatabaseSync, memoryId: string): void {
  const rows = db.prepare('SELECT entity_id FROM memory_entities WHERE memory_id = ?').all(memoryId) as unknown as { entity_id: string }[];
  const decrement = db.prepare('UPDATE entities SET mention_count = MAX(0, mention_count - 1) WHERE id = ?');
  for (const row of rows) decrement.run(row.entity_id);
  db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(memoryId);
}

export interface EntityAttachResult {
  /** 归一化名 → entity id */
  ids: Map<string, string>;
}

/** 写入实体与提及关系，返回归一化名 → id 的映射（供关系连接）。 */
export function attachEntities(
  db: DatabaseSync,
  projectId: string,
  memoryId: string,
  entities: ExtractedEntity[],
  at: string,
): EntityAttachResult {
  const ids = new Map<string, string>();
  const upsert = db.prepare(
    `INSERT INTO entities (id, project_id, name, type, normalized, mention_count, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(project_id, normalized, type) DO UPDATE SET mention_count = entities.mention_count + 1`,
  );
  const find = db.prepare('SELECT id FROM entities WHERE project_id = ? AND normalized = ? AND type = ?');
  const link = db.prepare('INSERT OR REPLACE INTO memory_entities (memory_id, entity_id, salience) VALUES (?, ?, ?)');
  for (const entity of entities) {
    const normalized = normalizeEntityName(entity.name);
    if (!normalized) continue;
    upsert.run(newId('ent'), projectId, entity.name, entity.type, normalized, at);
    const row = find.get(projectId, normalized, entity.type) as unknown as { id: string } | undefined;
    if (!row) continue;
    link.run(memoryId, row.id, entity.salience);
    ids.set(normalized, row.id);
  }
  return { ids };
}

/** 写入关系边（同一 (source,target,relation) 只保留权重更高者）。 */
export function attachRelations(
  db: DatabaseSync,
  projectId: string,
  memoryId: string,
  relations: ExtractedRelation[],
  entityIds: Map<string, string>,
  at: string,
): void {
  const upsert = db.prepare(
    `INSERT INTO relations (id, project_id, source_entity_id, target_entity_id, relation, memory_id, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, source_entity_id, target_entity_id, relation)
     DO UPDATE SET weight = MAX(relations.weight, excluded.weight)`,
  );
  for (const relation of relations) {
    const source = entityIds.get(normalizeEntityName(relation.source));
    const target = entityIds.get(normalizeEntityName(relation.target));
    if (!source || !target || source === target) continue;
    upsert.run(newId('rel'), projectId, source, target, relation.relation, memoryId, relation.weight, at);
  }
}

export interface PersistMemoryInput {
  projectId: string;
  content: string;
  category: MemoryCategory;
  importance: number;
  confidence: number;
  source: MemorySource;
  tags?: string[];
  metadata?: Record<string, unknown>;
  userId?: string;
  agentId?: string;
  runId?: string;
  appId?: string;
  taskId?: string;
  visibility?: MemoryVisibility;
  entities?: ExtractedEntity[];
  relations?: ExtractedRelation[];
  embeddingModel?: string;
  /** 预先算好的向量（避免重复计算） */
  embedding?: Float32Array;
  actor: string;
  reason?: string;
  at?: string;
}

/** 写入一条新记忆及其全部派生索引，返回领域对象。 */
export function insertMemory(db: DatabaseSync, input: PersistMemoryInput): Memory {
  const at = input.at ?? nowIso();
  const id = newId('mem');
  const embedding = input.embedding ?? embedText(input.content);
  db.prepare(
    `INSERT INTO memories (
       id, project_id, user_id, agent_id, run_id, app_id, task_id, visibility, content, normalized_hash, category,
       importance, confidence, source, status, tags, metadata, created_at, updated_at,
       last_accessed_at, access_count, expires_at, embedding, embedding_model, dim
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.userId ?? null,
    input.agentId ?? null,
    input.runId ?? null,
    input.appId ?? null,
    input.taskId ?? null,
    input.visibility ?? 'project',
    input.content,
    contentHash(input.content),
    input.category,
    input.importance,
    input.confidence,
    input.source,
    'active',
    JSON.stringify(input.tags ?? []),
    JSON.stringify(input.metadata ?? {}),
    at,
    at,
    null,
    0,
    null,
    vectorToBlob(embedding),
    input.embeddingModel ?? DEFAULT_PROJECT_SETTINGS.embeddingModel,
    DIM,
  );
  replaceTerms(db, input.projectId, id, input.content);
  const attached = attachEntities(db, input.projectId, id, input.entities ?? [], at);
  attachRelations(db, input.projectId, id, input.relations ?? [], attached.ids, at);
  writeHistory(db, {
    projectId: input.projectId,
    memoryId: id,
    event: 'ADD',
    newContent: input.content,
    actor: input.actor,
    reason: input.reason ?? null,
    at,
  });
  return mapMemory(getMemoryRow(db, input.projectId, id)!);
}

/** 内容变更后重建向量与词项（实体由调用方重新挂载）。 */
export function refreshContentIndex(db: DatabaseSync, row: MemoryRow, content: string, embeddingModel: string, at: string): void {
  const embedding = embedText(content);
  db.prepare('UPDATE memories SET normalized_hash = ?, embedding = ?, embedding_model = ?, dim = ?, updated_at = ? WHERE id = ?').run(
    contentHash(content),
    vectorToBlob(embedding),
    embeddingModel,
    DIM,
    at,
    row.id,
  );
  replaceTerms(db, row.project_id, row.id, content);
}

/* ------------------------------------------------------------------ */
/* 去重（consolidate 模式）                                            */
/* ------------------------------------------------------------------ */

export interface SimilarMemory {
  row: MemoryRow;
  similarity: number;
  exact: boolean;
}

/**
 * 查找同作用域内的高相似记忆：
 * 1) 归一化哈希完全一致 → 直接命中；
 * 2) 共享词项取候选（最多 80 条），再按余弦相似度筛选。
 */
export function findSimilarMemory(
  db: DatabaseSync,
  projectId: string,
  scope: MemoryScope,
  content: string,
  embedding: Float32Array,
  threshold: number,
  options: { taskId?: string | null; visibility?: MemoryVisibility } = {},
): SimilarMemory | null {
  const scoped = scopeClause(scope);
  const extra: string[] = [];
  const extraParams: (string | null)[] = [];
  if (options.visibility) {
    extra.push('m.visibility = ?');
    extraParams.push(options.visibility);
  }
  if (options.taskId !== undefined) {
    extra.push('m.task_id IS ?');
    extraParams.push(options.taskId ?? null);
  }
  const extraSql = extra.length > 0 ? ` AND ${extra.join(' AND ')}` : '';

  const exact = db
    .prepare(
      `SELECT * FROM memories m WHERE m.project_id = ? AND m.status = 'active' AND m.normalized_hash = ? AND ${scoped.sql}${extraSql} LIMIT 1`,
    )
    .get(projectId, contentHash(content), ...scoped.params, ...extraParams) as unknown as MemoryRow | undefined;
  if (exact) return { row: exact, similarity: 1, exact: true };

  const terms = rankTerms(content, 12);
  if (terms.length === 0) return null;
  const placeholders = terms.map(() => '?').join(', ');
  const candidates = db
    .prepare(
      `SELECT m.* FROM memories m
       JOIN memory_terms t ON t.memory_id = m.id
       WHERE m.project_id = ? AND m.status = 'active' AND t.term IN (${placeholders}) AND ${scoped.sql}${extraSql}
       GROUP BY m.id
       ORDER BY COUNT(*) DESC, m.created_at DESC
       LIMIT 80`,
    )
    .all(projectId, ...terms, ...scoped.params, ...extraParams) as unknown as MemoryRow[];

  let best: SimilarMemory | null = null;
  for (const row of candidates) {
    const similarity = cosine(embedding, blobToVector(row.embedding));
    if (similarity >= threshold && (!best || similarity > best.similarity)) best = { row, similarity, exact: false };
  }
  return best;
}
