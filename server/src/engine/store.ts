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
  MemoryScope,
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
  /* --- schema v5：中立服务（人 / 可见范围 / 会话） --- */
  person_id: string | null;
  actor_person_id: string | null;
  scope: string;
  session_id: string | null;
  /** 查询时通过 LEFT JOIN persons 附带的外部 id（不是 memories 列） */
  person_external_id?: string | null;
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
    defaultScope: isMemoryScope(source.defaultScope) ? source.defaultScope : defaults.defaultScope,
    personAutoCreate:
      typeof source.personAutoCreate === 'boolean' ? source.personAutoCreate : defaults.personAutoCreate,
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

const MEMORY_SCOPES: MemoryScope[] = ['person', 'partition', 'session'];

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as string[]).includes(value);
}

/** v5 可见范围归一化；存量行只带 visibility 时按旧映射回退。 */
export function asScope(value: unknown, visibility?: unknown): MemoryScope {
  if (isMemoryScope(value)) return value;
  const legacy = asVisibility(visibility);
  return legacy === 'agent' ? 'person' : legacy === 'task' ? 'session' : 'partition';
}

/** 旧 visibility → v5 scope：project↔partition、agent↔person、task↔session。 */
export function scopeFromVisibility(visibility: MemoryVisibility): MemoryScope {
  return visibility === 'agent' ? 'person' : visibility === 'task' ? 'session' : 'partition';
}

/** v5 scope → 旧 visibility（双写兼容列）。 */
export function visibilityFromScope(scope: MemoryScope): MemoryVisibility {
  return scope === 'person' ? 'agent' : scope === 'session' ? 'task' : 'project';
}

/** 行 → 领域对象（schema 未定义的字段一律不出现）。 */
export function mapMemory(row: MemoryRow): Memory {
  const memory: Memory = {
    id: row.id,
    projectId: row.project_id,
    personId: row.person_id ?? undefined,
    actorPersonId: row.actor_person_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    scope: asScope(row.scope, row.visibility),
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
  if (row.person_external_id) memory.personExternalId = row.person_external_id;
  return memory;
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
  return db
    .prepare(
      `SELECT m.*, p.external_id AS person_external_id
         FROM memories m LEFT JOIN persons p ON p.id = m.person_id
        WHERE m.project_id = ? AND m.id = ?`,
    )
    .get(projectId, id) as unknown as MemoryRow | undefined;
}

export function requireMemoryRow(db: DatabaseSync, projectId: string, id: string): MemoryRow {
  const row = getMemoryRow(db, projectId, id);
  if (!row) throw new Error(`memory not found: ${id}`);
  return row;
}

/** 旧作用域列（user/agent/run/app）：v5 之前的去重与隔离键，保留用于兼容。 */
export interface LegacyScopeFields {
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  appId?: string | null;
}

export const SCOPE_COLUMNS: { key: keyof LegacyScopeFields; column: string }[] = [
  { key: 'userId', column: 'user_id' },
  { key: 'agentId', column: 'agent_id' },
  { key: 'runId', column: 'run_id' },
  { key: 'appId', column: 'app_id' },
];

export function scopeClause(scope: LegacyScopeFields, alias = 'm'): { sql: string; params: (string | null)[] } {
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
  /** 调用方本人（person 内部 id）：可见自己的 scope=person 记忆 */
  callerPersonId?: string | null;
  /** 调用方会话：可见本会话的 scope=session 记忆 */
  callerSessionId?: string | null;
  /** 旧调用方 Agent 身份：兼容只按 agent_id 判定的存量数据 */
  agentId?: string | null;
  /** 旧调用方任务：兼容只按 task_id 判定的存量数据 */
  taskId?: string | null;
  /** 显式 scope 过滤（新契约） */
  scope?: MemoryScope;
  /** 旧 visibility 过滤；未给 scope 时映射为 scope 过滤 */
  visibility?: MemoryVisibility;
  /** 控制台 / 审计视角：不过滤可见性 */
  includePrivate?: boolean;
}

/**
 * Agent / 调用方可见性规则（SQL 片段，v5）：
 *  - includePrivate=true：不过滤（控制台 / 审计）；
 *  - 否则可见集合 = `scope=partition` ∪ 调用方本人的 `scope=person` ∪ 调用方本会话的 `scope=session`；
 *    旧 `agent_id` / `task_id` 仍参与匹配，兼容迁移前的写入；
 *  - 显式 scope / 旧 visibility 过滤叠加在最外层（visibility 映射为 scope）。
 */
export function visibilityClause(scope: VisibilityScope, alias = 'm'): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  const filterScope = scope.scope ?? (scope.visibility ? scopeFromVisibility(scope.visibility) : undefined);
  if (filterScope) {
    parts.push(`${alias}.scope = ?`);
    params.push(filterScope);
  }
  if (!scope.includePrivate) {
    const visible: string[] = [`${alias}.scope = 'partition'`];
    const visibleParams: string[] = [];
    if (scope.callerPersonId) {
      visible.push(`(${alias}.scope = 'person' AND ${alias}.person_id = ?)`);
      visibleParams.push(scope.callerPersonId);
    }
    if (scope.agentId) {
      visible.push(`(${alias}.scope = 'person' AND ${alias}.agent_id = ?)`);
      visibleParams.push(scope.agentId);
    }
    if (scope.callerSessionId) {
      visible.push(`(${alias}.scope = 'session' AND ${alias}.session_id = ?)`);
      visibleParams.push(scope.callerSessionId);
    }
    if (scope.taskId) {
      visible.push(`(${alias}.scope = 'session' AND ${alias}.task_id = ?)`);
      visibleParams.push(scope.taskId);
    }
    parts.push(`(${visible.join(' OR ')})`);
    params.push(...visibleParams);
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
  /** 记忆主体（person 内部 id）；NULL = 分区共享知识 */
  personId?: string | null;
  /** 写入者（person 内部 id）；缺省由 service 决定 */
  actorPersonId?: string | null;
  /** 可见范围；缺省按旧 visibility 映射，最终回退 partition */
  scope?: MemoryScope;
  /** 会话（task_id / run_id 的泛化） */
  sessionId?: string | null;
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
  const visibility = input.visibility ?? visibilityFromScope(input.scope ?? 'partition');
  const scope = input.scope ?? scopeFromVisibility(visibility);
  db.prepare(
    `INSERT INTO memories (
       id, project_id, user_id, agent_id, run_id, app_id, task_id, visibility, content, normalized_hash, category,
       importance, confidence, source, status, tags, metadata, created_at, updated_at,
       last_accessed_at, access_count, expires_at, embedding, embedding_model, dim,
       person_id, actor_person_id, scope, session_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.userId ?? null,
    input.agentId ?? null,
    input.runId ?? null,
    input.appId ?? null,
    input.taskId ?? null,
    visibility,
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
    input.personId ?? null,
    input.actorPersonId ?? null,
    scope,
    input.sessionId ?? null,
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

export interface SimilarMemoryOptions {
  /** 新契约：按 scope 隔离；缺省沿用旧 visibility 兼容逻辑 */
  scope?: MemoryScope;
  /** scope=person 时必须按 person_id 隔离，避免把不同人的相同内容合并 */
  personId?: string | null;
  /** scope=session 时按会话隔离 */
  sessionId?: string | null;
  /** 旧参数：按可见性过滤（与 scope 二选一） */
  visibility?: MemoryVisibility;
}

/**
 * 查找同作用域内的高相似记忆：
 * 1) 归一化哈希完全一致 → 直接命中；
 * 2) 共享词项取候选（最多 80 条），再按余弦相似度筛选。
 *
 * v5 隔离规则：
 *  - scope=person：按 `scope='person' AND person_id = ?` 匹配（不再叠加旧 user/agent 元组，
 *    同一人的记忆无论经由 person_id 还是旧 user_id/agent_id 写入都应去重）；
 *  - scope=partition / session：维持旧「分区内（user/agent/run/app 元组）+ scope」去重语义；
 *  - 未指定 scope 时退回旧 visibility 过滤。
 */
export function findSimilarMemory(
  db: DatabaseSync,
  projectId: string,
  scope: LegacyScopeFields,
  content: string,
  embedding: Float32Array,
  threshold: number,
  options: SimilarMemoryOptions = {},
): SimilarMemory | null {
  const extra: string[] = [];
  const extraParams: (string | null)[] = [];
  let scoped: { sql: string; params: (string | null)[] } = { sql: '1 = 1', params: [] };
  if (options.scope === 'person') {
    // 人级记忆只看 person_id；不同人即使内容相同也各自成条。
    extra.push("m.scope = 'person'");
    extra.push('m.person_id IS ?');
    extraParams.push(options.personId ?? null);
  } else {
    scoped = scopeClause(scope);
    if (options.scope) {
      extra.push('m.scope = ?');
      extraParams.push(options.scope);
    }
    if (options.scope === 'session') {
      extra.push('m.session_id IS ?');
      extraParams.push(options.sessionId ?? null);
    }
    if (!options.scope && options.visibility) {
      extra.push('m.visibility = ?');
      extraParams.push(options.visibility);
    }
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
