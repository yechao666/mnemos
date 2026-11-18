import { DEFAULT_PARTITION_SETTINGS } from '../../../shared/src/constants.ts';
import type {
  Memory,
  MemoryBrief,
  MemoryCategory,
  MemoryDreamRun,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  Partition,
  PartitionSettings,
  PartitionStats,
  PartitionStatus,
  Person,
  PersonFact,
  PersonStatus,
  PersonType,
  RetrievalWeights,
  Session,
} from '../../../shared/src/types.ts';

/** SQLite 行 → 领域 DTO 的映射层（引擎内部使用）。 */

export interface PartitionRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  settings: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface StatsRow {
  partition_id: string;
  persons_total: number;
  persons_human: number;
  persons_agent: number;
  persons_service: number;
  memories_total: number;
  shared_total: number;
  sessions_total: number;
  updated_at: string;
}

export interface PersonRow {
  id: string;
  partition_id: string;
  external_id: string;
  type: string;
  display_name: string;
  attributes: string;
  status: string;
  memory_count: number;
  shared_memory_count: number;
  session_count: number;
  last_memory_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  /* --- v6.1 --- */
  merged_into?: string | null;
  consent?: string | null;
  deleted_at?: string | null;
}

export interface MemoryRow {
  id: string;
  partition_id: string;
  person_id: string;
  actor_person_id: string | null;
  person_external_id?: string | null;
  scope: string;
  session_id: string | null;
  category: string;
  content: string;
  importance: number;
  confidence: number;
  source: string;
  status: string;
  tags: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  dreamed_at: string | null;
  /* --- v6.1 --- */
  normalized_hash: string | null;
  embedding: Uint8Array | null;
  embedding_model: string | null;
  dim: number | null;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  supersedes: string | null;
  fact_key: string | null;
  feedback_up: number;
  feedback_down: number;
  /* --- v6.2 隐私规则 --- */
  privacy_scanned_at?: string | null;
  /** 批量查询附加列（可选；不来自表本身） */
  placeholder_count?: number;
}

/** person_facts 行（当前有效 = valid_to IS NULL）。 */
export interface PersonFactRow {
  id: string;
  partition_id: string;
  person_id: string;
  key: string;
  value: string;
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  source_memory_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  partition_id: string;
  person_id: string;
  title: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  metadata: string;
}

export interface BriefRow {
  partition_id: string;
  scope_key: string;
  person_id: string | null;
  text: string;
  max_chars: number;
  model: string;
  source_hash: string;
  generated_at: string;
}

export interface DreamRunRow {
  id: string;
  partition_id: string;
  person_id: string | null;
  trigger: string;
  status: string;
  input_count: number;
  insight_count: number;
  summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as unknown;
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonArray<T>(raw: string | null | undefined): T[] {
  const value = parseJson<unknown>(raw, []);
  return Array.isArray(value) ? (value as T[]) : [];
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function clampUnit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const RETRIEVAL_KEYS: (keyof RetrievalWeights)[] = ['vector', 'keyword', 'recency', 'importance', 'entity'];

/**
 * 合并检索权重：逐字段 clamp 到 0–1；全为 0 时回退默认权重（避免分数恒为 0）。
 */
export function parseRetrievalWeights(
  raw: unknown,
  fallback: RetrievalWeights = DEFAULT_PARTITION_SETTINGS.retrievalWeights,
): RetrievalWeights {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = {} as RetrievalWeights;
  let total = 0;
  for (const key of RETRIEVAL_KEYS) {
    const value = clampUnit(source[key], fallback[key]);
    result[key] = value;
    total += value;
  }
  return total > 0 ? result : { ...fallback };
}

/** 合并默认设置（容忍旧数据缺字段）。 */
export function parseSettings(raw: string | null | undefined): PartitionSettings {
  const parsed = parseJson<Partial<PartitionSettings>>(raw, {});
  return {
    defaultScope: oneOf<MemoryScope>(parsed.defaultScope, ['person', 'partition', 'session'], DEFAULT_PARTITION_SETTINGS.defaultScope),
    briefMaxChars: clampInt(parsed.briefMaxChars, DEFAULT_PARTITION_SETTINGS.briefMaxChars, 100, 5000),
    briefEnabled:
      typeof parsed.briefEnabled === 'boolean' ? parsed.briefEnabled : DEFAULT_PARTITION_SETTINGS.briefEnabled,
    dreamEnabled:
      typeof parsed.dreamEnabled === 'boolean' ? parsed.dreamEnabled : DEFAULT_PARTITION_SETTINGS.dreamEnabled,
    dreamIntervalMinutes: clampInt(
      parsed.dreamIntervalMinutes,
      DEFAULT_PARTITION_SETTINGS.dreamIntervalMinutes,
      1,
      43_200,
    ),
    retentionDays: clampInt(parsed.retentionDays, DEFAULT_PARTITION_SETTINGS.retentionDays, 0, 3650),
    monthlyQuota: clampInt(parsed.monthlyQuota, DEFAULT_PARTITION_SETTINGS.monthlyQuota, 0, Number.MAX_SAFE_INTEGER),
    personAutoCreate:
      typeof parsed.personAutoCreate === 'boolean'
        ? parsed.personAutoCreate
        : DEFAULT_PARTITION_SETTINGS.personAutoCreate,
    locale: typeof parsed.locale === 'string' && parsed.locale.trim() ? parsed.locale.trim().slice(0, 20) : DEFAULT_PARTITION_SETTINGS.locale,
    retrievalMode: oneOf<'hybrid' | 'keyword' | 'vector'>(
      parsed.retrievalMode,
      ['hybrid', 'keyword', 'vector'],
      DEFAULT_PARTITION_SETTINGS.retrievalMode,
    ),
    retrievalWeights: parseRetrievalWeights(parsed.retrievalWeights),
    embeddingModel:
      typeof parsed.embeddingModel === 'string' && parsed.embeddingModel.trim()
        ? parsed.embeddingModel.trim().slice(0, 80)
        : DEFAULT_PARTITION_SETTINGS.embeddingModel,
    mergeThreshold: clampUnit(parsed.mergeThreshold, DEFAULT_PARTITION_SETTINGS.mergeThreshold),
    dedupeThreshold: clampUnit(parsed.dedupeThreshold, DEFAULT_PARTITION_SETTINGS.dedupeThreshold),
    autoExtractEntities:
      typeof parsed.autoExtractEntities === 'boolean'
        ? parsed.autoExtractEntities
        : DEFAULT_PARTITION_SETTINGS.autoExtractEntities,
    piiRedaction: oneOf<'off' | 'basic'>(
      parsed.piiRedaction,
      ['off', 'basic'],
      DEFAULT_PARTITION_SETTINGS.piiRedaction,
    ),
    /* --- v6.2 隐私规则 --- */
    privacyLlmEnabled:
      typeof parsed.privacyLlmEnabled === 'boolean'
        ? parsed.privacyLlmEnabled
        : DEFAULT_PARTITION_SETTINGS.privacyLlmEnabled,
  };
}

export function mergeSettings(
  base: PartitionSettings,
  patch: Partial<PartitionSettings> | undefined,
): PartitionSettings {
  if (!patch) return base;
  const merged: PartitionSettings = { ...base, ...patch };
  merged.defaultScope = oneOf<MemoryScope>(merged.defaultScope, ['person', 'partition', 'session'], base.defaultScope);
  merged.briefMaxChars = clampInt(merged.briefMaxChars, base.briefMaxChars, 100, 5000);
  merged.dreamIntervalMinutes = clampInt(merged.dreamIntervalMinutes, base.dreamIntervalMinutes, 1, 43_200);
  merged.retentionDays = clampInt(merged.retentionDays, base.retentionDays, 0, 3650);
  merged.monthlyQuota = clampInt(merged.monthlyQuota, base.monthlyQuota, 0, Number.MAX_SAFE_INTEGER);
  merged.locale = String(merged.locale || base.locale).slice(0, 20);
  /* --- v6.1 --- */
  merged.retrievalMode = oneOf<'hybrid' | 'keyword' | 'vector'>(
    merged.retrievalMode,
    ['hybrid', 'keyword', 'vector'],
    base.retrievalMode,
  );
  // 权重支持局部 patch：只覆盖传入的键，其余沿用 base。
  const patchWeights =
    patch.retrievalWeights && typeof patch.retrievalWeights === 'object'
      ? (patch.retrievalWeights as Partial<RetrievalWeights>)
      : undefined;
  merged.retrievalWeights = parseRetrievalWeights(
    patchWeights ? { ...base.retrievalWeights, ...patchWeights } : merged.retrievalWeights,
    base.retrievalWeights,
  );
  merged.embeddingModel =
    typeof merged.embeddingModel === 'string' && merged.embeddingModel.trim()
      ? merged.embeddingModel.trim().slice(0, 80)
      : base.embeddingModel;
  merged.mergeThreshold = clampUnit(merged.mergeThreshold, base.mergeThreshold);
  merged.dedupeThreshold = clampUnit(merged.dedupeThreshold, base.dedupeThreshold);
  merged.autoExtractEntities =
    typeof merged.autoExtractEntities === 'boolean' ? merged.autoExtractEntities : base.autoExtractEntities;
  merged.piiRedaction = oneOf<'off' | 'basic'>(merged.piiRedaction, ['off', 'basic'], base.piiRedaction);
  merged.privacyLlmEnabled =
    typeof merged.privacyLlmEnabled === 'boolean' ? merged.privacyLlmEnabled : base.privacyLlmEnabled;
  return merged;
}

export function toStats(row: StatsRow): PartitionStats {
  return {
    partitionId: row.partition_id,
    personsTotal: row.persons_total,
    personsHuman: row.persons_human,
    personsAgent: row.persons_agent,
    personsService: row.persons_service,
    memoriesTotal: row.memories_total,
    sharedTotal: row.shared_total,
    sessionsTotal: row.sessions_total,
    updatedAt: row.updated_at,
  };
}

export function toPartition(row: PartitionRow, stats?: StatsRow | null): Partition {
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status as PartitionStatus,
    settings: parseSettings(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
    ...(stats ? { stats: toStats(stats) } : {}),
  };
}

export function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    partitionId: row.partition_id,
    externalId: row.external_id,
    type: row.type as PersonType,
    displayName: row.display_name,
    attributes: parseJson<Record<string, unknown>>(row.attributes, {}),
    status: row.status as PersonStatus,
    memoryCount: row.memory_count,
    sharedMemoryCount: row.shared_memory_count,
    sessionCount: row.session_count,
    lastMemoryAt: row.last_memory_at ?? undefined,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    /* --- v6.1 --- */
    mergedInto: row.merged_into ?? undefined,
    consent: parseJson<Record<string, unknown>>(row.consent, {}),
    deletedAt: row.deleted_at ?? undefined,
  };
}

export function toPersonFact(row: PersonFactRow): PersonFact {
  return {
    id: row.id,
    partitionId: row.partition_id,
    personId: row.person_id,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? undefined,
    sourceMemoryId: row.source_memory_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    partitionId: row.partition_id,
    personId: row.person_id,
    actorPersonId: row.actor_person_id ?? undefined,
    personExternalId: row.person_external_id ?? undefined,
    scope: row.scope as MemoryScope,
    sessionId: row.session_id ?? undefined,
    category: row.category as MemoryCategory,
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    source: row.source as MemorySource,
    status: row.status as MemoryStatus,
    tags: parseJsonArray<string>(row.tags),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
    dreamedAt: row.dreamed_at ?? undefined,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
    supersedes: row.supersedes ?? undefined,
    factKey: row.fact_key ?? undefined,
    feedbackUp: row.feedback_up ?? 0,
    feedbackDown: row.feedback_down ?? 0,
    ...(row.placeholder_count !== undefined ? { placeholderCount: row.placeholder_count } : {}),
    privacyScannedAt: row.privacy_scanned_at ?? undefined,
  };
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    partitionId: row.partition_id,
    personId: row.person_id,
    title: row.title,
    status: row.status === 'ended' ? 'ended' : 'active',
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  };
}

export function toBrief(row: BriefRow, recent: MemoryBrief['recent'], count: number, cached: boolean): MemoryBrief {
  return {
    partitionId: row.partition_id,
    personId: row.person_id ?? undefined,
    scopeKey: row.scope_key,
    text: row.text,
    maxChars: row.max_chars,
    count,
    model: row.model,
    cached,
    sourceHash: row.source_hash,
    generatedAt: row.generated_at,
    recent,
  };
}

export function toDreamRun(row: DreamRunRow): MemoryDreamRun {
  return {
    id: row.id,
    partitionId: row.partition_id,
    personId: row.person_id ?? undefined,
    trigger: row.trigger === 'schedule' ? 'schedule' : 'manual',
    status:
      row.status === 'completed' || row.status === 'skipped' || row.status === 'failed' || row.status === 'running'
        ? row.status
        : 'running',
    inputCount: row.input_count,
    insightCount: row.insight_count,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

/** 转义 LIKE 前缀里的通配符。 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 含 CJK 的查询退化为子串匹配（unicode61 把连续 CJK 当一个词，前缀搜索无法命中词中段）。 */
export function needsSubstringSearch(q: string): boolean {
  return CJK_RE.test(q);
}

/** LIKE 子串模式（转义通配符）。 */
export function likeContains(q: string): string {
  return `%${escapeLike(q)}%`;
}

/** 把 q 切成 FTS5 前缀查询：每个词加引号 + `*`，词之间 AND。 */
export function ftsQuery(q: string): string | null {
  const terms = q
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 8);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"*`).join(' ');
}
