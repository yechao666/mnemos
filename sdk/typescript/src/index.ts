/**
 * `@mnemos/sdk` —— Mnemos v6 官方 TypeScript SDK。
 *
 * v6 只有三个核心：**分区（Partition）+ 人（Person）+ 记忆（Memory）**。
 * 所有数据端点都在 `/v1/partitions/:partition/...` 下，`:partition` 支持内部 id
 * 或 slug；人 / 记忆列表统一使用游标分页（`{ items, next_cursor, partition_stats }`）。
 *
 * 设计要点：
 * - 零运行时依赖，Node ≥18（全局 fetch）与浏览器通用；
 * - 入参接受 camelCase 与 snake_case，统一序列化为 snake_case；
 * - 响应统一归一化为 snake_case（含控制台 camelCase 响应）；
 * - 429 / 502 / 503 / 504 与网络错误指数退避重试，尊重 `Retry-After`；
 * - 写请求可传 `idempotencyKey`，重试时复用同一个 `Idempotency-Key`；
 * - 删除 v5 的 agents / tasks / briefing / webhooks / graph 等领域方法。
 */

import type {
  AddMemoryResponse,
  ApiKey,
  CursorPage,
  HealthResponse,
  KeyInput,
  KeyRotateInput,
  Memory,
  MemoryBrief,
  MemoryDetail,
  MemoryDreamInput,
  MemoryDreamResult,
  MemoryDreamStatus,
  MemoryInput,
  MemoryListQuery,
  MemoryMutationResponse,
  MemorySearchInput,
  MemoryUpdateInput,
  MnemosClientOptions,
  Partition,
  PartitionInput,
  PartitionSettings,
  PartitionSettingsInput,
  PartitionStats,
  Person,
  PersonBriefQuery,
  PersonContext,
  PersonContextInput,
  PersonInput,
  PersonListQuery,
  PersonUpdateInput,
  RequestOptions,
  SearchResponse,
} from './types.js';

/** SDK 版本。 */
export const SDK_VERSION = '1.0.0';
/** 默认服务地址。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4380';
/** 默认单次请求超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 默认最大重试次数。 */
export const DEFAULT_MAX_RETRIES = 2;
/** 游标分页默认条数。 */
export const DEFAULT_PAGE_LIMIT = 50;
/** 游标分页最大条数。 */
export const MAX_PAGE_LIMIT = 200;

/** 可重试的 HTTP 状态码。 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** 指数退避基数（毫秒）。 */
const RETRY_BASE_DELAY_MS = 200;

type JsonRecord = Record<string, unknown>;
type QueryValue = string | number | boolean | null | undefined;
type Query = Record<string, QueryValue | QueryValue[]>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/* ------------------------------------------------------------------ */
/* 枚举常量（归一化兜底用）                                             */
/* ------------------------------------------------------------------ */

const MEMORY_CATEGORIES = [
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
] as const;
const MEMORY_SCOPES = ['person', 'partition', 'session'] as const;
const MEMORY_STATUSES = ['active', 'archived', 'deleted'] as const;
const MEMORY_SOURCES = ['api', 'conversation', 'agent', 'import', 'playground', 'dream'] as const;
const PERSON_TYPES = ['human', 'agent', 'service', 'other'] as const;
const PERSON_STATUSES = ['active', 'archived', 'deleted'] as const;
const PERSON_SORTS = ['recent', 'new', 'name'] as const;
const PARTITION_STATUSES = ['active', 'paused', 'archived'] as const;
const DREAM_RUN_STATUSES = ['running', 'completed', 'skipped', 'failed'] as const;
const DREAM_TRIGGERS = ['manual', 'schedule'] as const;
const API_SCOPES = ['memories:read', 'memories:write', 'admin'] as const;
const API_KEY_KINDS = ['partition', 'org'] as const;

/** 分区设置缺省值（与 shared 常量保持一致）。 */
const DEFAULT_SETTINGS: PartitionSettings = {
  default_scope: 'partition',
  brief_max_chars: 1200,
  brief_enabled: true,
  dream_enabled: true,
  dream_interval_minutes: 1440,
  retention_days: 0,
  monthly_quota: 0,
  person_auto_create: true,
  locale: 'zh-CN',
};

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

/** 构造 MnemosApiError 的参数。 */
export interface MnemosApiErrorInit {
  status: number;
  code: string;
  requestId?: string | null;
  details?: unknown;
  retryAfterMs?: number | null;
}

/**
 * Mnemos API 错误。
 *
 * - 服务端返回非 2xx：`status` 为 HTTP 状态，`code` 取错误体里的稳定标识；
 * - 网络错误：`status = 0`、`code = "network_error"`；
 * - 超时：`status = 0`、`code = "timeout"`；
 * - 主动取消：`status = 0`、`code = "aborted"`。
 */
export class MnemosApiError extends Error {
  /** HTTP 状态码；网络/超时为 0。 */
  readonly status: number;
  /** 稳定错误码，例如 `VALIDATION_ERROR`、`RATE_LIMITED`。 */
  readonly code: string;
  /** 服务端请求 ID（响应头 `x-request-id` 兜底）。 */
  readonly requestId: string | null;
  /** 错误体中的 `details`。 */
  readonly details: unknown;
  /** 本次响应建议的重试等待（毫秒），来自 `Retry-After`。 */
  readonly retryAfterMs: number | null;

  constructor(message: string, init: MnemosApiErrorInit) {
    super(message);
    this.name = 'MnemosApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null) return null;
  return null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

function asRecordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 读取字段：优先主名，其次兼容别名。 */
function pick<T>(primary: T | undefined, alias: T | undefined): T | undefined {
  return primary !== undefined ? primary : alias;
}

/** 去掉值为 undefined 的字段，避免发送无意义参数。 */
function compact(input: JsonRecord): JsonRecord {
  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

/** 构造查询参数对象（去掉 null/undefined）。 */
function queryFrom(input: Record<string, QueryValue>): Query {
  const output: Query = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) output[key] = value;
  }
  return output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 指数退避 + 抖动。 */
function backoffDelay(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return base + Math.random() * base * 0.5;
}

/** 解析 `Retry-After`（秒数或 HTTP 日期）。 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

/** 创建超时信号；优先使用 `AbortSignal.timeout`。 */
function createTimeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.append(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

function encodeRef(value: string): string {
  return encodeURIComponent(value);
}

/** 校验分页 limit（1–200）；不传时服务端默认 50。 */
function assertLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new TypeError(`limit 必须是 1–${MAX_PAGE_LIMIT} 的整数`);
  }
  return limit;
}

/** PATCH 请求体不能为空。 */
function assertPatchBody(action: string, body: JsonRecord): JsonRecord {
  if (Object.keys(body).length === 0) {
    throw new TypeError(`${action}: 至少提供一个待更新字段`);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* 响应归一化                                                          */
/* ------------------------------------------------------------------ */

function normalizeSettings(value: unknown): PartitionSettings {
  const raw = asRecord(value);
  return {
    default_scope: oneOf(raw.default_scope ?? raw.defaultScope, MEMORY_SCOPES, DEFAULT_SETTINGS.default_scope),
    brief_max_chars: asNumber(
      raw.brief_max_chars ?? raw.briefMaxChars,
      DEFAULT_SETTINGS.brief_max_chars,
    ),
    brief_enabled: asBoolean(raw.brief_enabled ?? raw.briefEnabled, DEFAULT_SETTINGS.brief_enabled),
    dream_enabled: asBoolean(raw.dream_enabled ?? raw.dreamEnabled, DEFAULT_SETTINGS.dream_enabled),
    dream_interval_minutes: asNumber(
      raw.dream_interval_minutes ?? raw.dreamIntervalMinutes,
      DEFAULT_SETTINGS.dream_interval_minutes,
    ),
    retention_days: asNumber(raw.retention_days ?? raw.retentionDays, DEFAULT_SETTINGS.retention_days),
    monthly_quota: asNumber(raw.monthly_quota ?? raw.monthlyQuota, DEFAULT_SETTINGS.monthly_quota),
    person_auto_create: asBoolean(
      raw.person_auto_create ?? raw.personAutoCreate,
      DEFAULT_SETTINGS.person_auto_create,
    ),
    locale: asString(raw.locale, DEFAULT_SETTINGS.locale),
  };
}

function normalizeStats(value: unknown): PartitionStats {
  const raw = asRecord(value);
  return {
    partition_id: asString(raw.partition_id ?? raw.partitionId),
    persons_total: asNumber(raw.persons_total ?? raw.personsTotal),
    persons_human: asNumber(raw.persons_human ?? raw.personsHuman),
    persons_agent: asNumber(raw.persons_agent ?? raw.personsAgent),
    persons_service: asNumber(raw.persons_service ?? raw.personsService),
    memories_total: asNumber(raw.memories_total ?? raw.memoriesTotal),
    shared_total: asNumber(raw.shared_total ?? raw.sharedTotal),
    sessions_total: asNumber(raw.sessions_total ?? raw.sessionsTotal),
    updated_at: asString(raw.updated_at ?? raw.updatedAt),
  };
}

function normalizePartition(value: unknown): Partition {
  const raw = asRecord(value);
  const partition: Partition = {
    id: asString(raw.id),
    org_id: asString(raw.org_id ?? raw.orgId),
    slug: asString(raw.slug),
    name: asString(raw.name),
    description: asString(raw.description),
    status: oneOf(raw.status, PARTITION_STATUSES, 'active'),
    settings: normalizeSettings(raw.settings),
    created_at: asString(raw.created_at ?? raw.createdAt),
    updated_at: asString(raw.updated_at ?? raw.updatedAt),
    archived_at: asNullableString(raw.archived_at ?? raw.archivedAt),
  };
  const stats = raw.stats;
  if (stats !== undefined && stats !== null) partition.stats = normalizeStats(stats);
  return partition;
}

function normalizePerson(value: unknown): Person {
  const raw = asRecord(value);
  return {
    id: asString(raw.id),
    partition_id: asString(raw.partition_id ?? raw.partitionId),
    external_id: asString(raw.external_id ?? raw.externalId),
    type: oneOf(raw.type, PERSON_TYPES, 'human'),
    display_name: asString(raw.display_name ?? raw.displayName),
    attributes: asRecordOf(raw.attributes),
    status: oneOf(raw.status, PERSON_STATUSES, 'active'),
    memory_count: asNumber(raw.memory_count ?? raw.memoryCount),
    shared_memory_count: asNumber(raw.shared_memory_count ?? raw.sharedMemoryCount),
    session_count: asNumber(raw.session_count ?? raw.sessionCount),
    last_memory_at: asNullableString(raw.last_memory_at ?? raw.lastMemoryAt),
    first_seen_at: asString(raw.first_seen_at ?? raw.firstSeenAt),
    last_seen_at: asString(raw.last_seen_at ?? raw.lastSeenAt),
    created_at: asString(raw.created_at ?? raw.createdAt),
    updated_at: asString(raw.updated_at ?? raw.updatedAt),
  };
}

function normalizeMemory(value: unknown): Memory {
  const raw = asRecord(value);
  return {
    id: asString(raw.id),
    partition_id: asString(raw.partition_id ?? raw.partitionId),
    person_id: asString(raw.person_id ?? raw.personId),
    person_external_id: asNullableString(raw.person_external_id ?? raw.personExternalId),
    actor_person_id: asNullableString(raw.actor_person_id ?? raw.actorPersonId),
    scope: oneOf(raw.scope, MEMORY_SCOPES, 'partition'),
    session_id: asNullableString(raw.session_id ?? raw.sessionId),
    category: oneOf(raw.category, MEMORY_CATEGORIES, 'fact'),
    content: asString(raw.content ?? raw.memory),
    importance: asNumber(raw.importance, 0.5),
    confidence: asNumber(raw.confidence, 0.8),
    source: oneOf(raw.source, MEMORY_SOURCES, 'api'),
    status: oneOf(raw.status, MEMORY_STATUSES, 'active'),
    tags: asStringArray(raw.tags),
    metadata: asRecordOf(raw.metadata),
    created_at: asString(raw.created_at ?? raw.createdAt),
    updated_at: asString(raw.updated_at ?? raw.updatedAt),
    expires_at: asNullableString(raw.expires_at ?? raw.expiresAt),
    dreamed_at: asNullableString(raw.dreamed_at ?? raw.dreamedAt),
  };
}

function normalizePage<T>(value: unknown, map: (item: unknown) => T): CursorPage<T> {
  const raw = asRecord(value);
  const page: CursorPage<T> = {
    items: asArray(raw.items ?? raw.results).map(map),
    next_cursor: asNullableString(raw.next_cursor ?? raw.nextCursor),
  };
  const stats = raw.partition_stats ?? raw.partitionStats;
  if (stats !== undefined && stats !== null) page.partition_stats = normalizeStats(stats);
  return page;
}

function normalizeAddResponse(value: unknown): AddMemoryResponse {
  const raw = asRecord(value);
  const memoryRaw = raw.memory ?? asArray(raw.results)[0] ?? raw;
  return {
    memory: normalizeMemory(memoryRaw),
    events: asArray(raw.events).map((event) => {
      const item = asRecord(event);
      return {
        type: 'ADD' as const,
        memory_id: asString(item.memory_id ?? item.memoryId),
        at: asString(item.at),
      };
    }),
  };
}

function normalizeMemoryDetail(value: unknown): MemoryDetail {
  const raw = asRecord(value);
  return {
    memory: normalizeMemory(raw.memory),
    person: raw.person === null || raw.person === undefined ? null : normalizePerson(raw.person),
  };
}

function normalizeMemoryMutation(value: unknown): MemoryMutationResponse {
  const raw = asRecord(value);
  return { memory: normalizeMemory(raw.memory ?? raw) };
}

function normalizeSearchResponse(value: unknown): SearchResponse {
  const raw = asRecord(value);
  const response: SearchResponse = {
    results: asArray(raw.results).map(normalizeMemory),
    took_ms: asNumber(raw.took_ms ?? raw.tookMs),
    next_cursor: asNullableString(raw.next_cursor ?? raw.nextCursor),
  };
  const stats = raw.partition_stats ?? raw.partitionStats;
  if (stats !== undefined && stats !== null) response.partition_stats = normalizeStats(stats);
  return response;
}

function normalizeBriefItem(value: unknown) {
  const raw = asRecord(value);
  return {
    id: asString(raw.id),
    content: asString(raw.content),
    category: oneOf(raw.category, MEMORY_CATEGORIES, 'fact'),
    importance: asNumber(raw.importance, 0.5),
    scope: oneOf(raw.scope, MEMORY_SCOPES, 'partition'),
    updated_at: asString(raw.updated_at ?? raw.updatedAt),
    person_id: asString(raw.person_id ?? raw.personId),
    person_external_id: asNullableString(raw.person_external_id ?? raw.personExternalId),
  };
}

function normalizeBrief(value: unknown): MemoryBrief {
  const raw = asRecord(value);
  return {
    partition_id: asString(raw.partition_id ?? raw.partitionId),
    person_id: asNullableString(raw.person_id ?? raw.personId),
    scope_key: asString(raw.scope_key ?? raw.scopeKey),
    text: asString(raw.text),
    max_chars: asNumber(raw.max_chars ?? raw.maxChars),
    count: asNumber(raw.count),
    model: asString(raw.model),
    cached: asBoolean(raw.cached),
    source_hash: asString(raw.source_hash ?? raw.sourceHash),
    generated_at: asString(raw.generated_at ?? raw.generatedAt),
    recent: asArray(raw.recent).map(normalizeBriefItem),
  };
}

function normalizeContext(value: unknown): PersonContext {
  const raw = asRecord(value);
  return {
    person: normalizePerson(raw.person),
    brief: normalizeBrief(raw.brief),
    memories: asArray(raw.memories).map(normalizeMemory),
    shared: asArray(raw.shared).map(normalizeMemory),
    prompt: asString(raw.prompt),
    token_estimate: asNumber(raw.token_estimate ?? raw.tokenEstimate),
    citations: asStringArray(raw.citations),
    built_at: asString(raw.built_at ?? raw.builtAt),
  };
}

function normalizeDreamRun(value: unknown) {
  const raw = asRecord(value);
  return {
    id: asString(raw.id),
    partition_id: asString(raw.partition_id ?? raw.partitionId),
    person_id: asNullableString(raw.person_id ?? raw.personId),
    trigger: oneOf(raw.trigger, DREAM_TRIGGERS, 'manual'),
    status: oneOf(raw.status, DREAM_RUN_STATUSES, 'completed'),
    input_count: asNumber(raw.input_count ?? raw.inputCount),
    insight_count: asNumber(raw.insight_count ?? raw.insightCount),
    summary: asNullableString(raw.summary),
    error: asNullableString(raw.error),
    started_at: asString(raw.started_at ?? raw.startedAt),
    finished_at: asNullableString(raw.finished_at ?? raw.finishedAt),
  };
}

function normalizeDreamStatus(value: unknown): MemoryDreamStatus {
  const raw = asRecord(value);
  const settings = asRecord(raw.settings);
  const lastRun = raw.last_run ?? raw.lastRun;
  return {
    settings: {
      enabled: asBoolean(settings.enabled),
      interval_minutes: asNumber(settings.interval_minutes ?? settings.intervalMinutes),
      last_at: asNullableString(settings.last_at ?? settings.lastAt),
    },
    person_id: asNullableString(raw.person_id ?? raw.personId),
    pending_count: asNumber(raw.pending_count ?? raw.pendingCount),
    last_run: lastRun === null || lastRun === undefined ? null : normalizeDreamRun(lastRun),
    runs: asArray(raw.runs).map(normalizeDreamRun),
  };
}

function normalizeDreamResult(value: unknown): MemoryDreamResult {
  const raw = asRecord(value);
  return {
    run: raw.run === null || raw.run === undefined ? null : normalizeDreamRun(raw.run),
    status: normalizeDreamStatus(raw.status),
  };
}

function normalizeApiKey(value: unknown): ApiKey {
  const raw = asRecord(value);
  return {
    id: asString(raw.id),
    partition_id: asNullableString(raw.partition_id ?? raw.partitionId),
    org_id: asNullableString(raw.org_id ?? raw.orgId),
    kind: oneOf(raw.kind, API_KEY_KINDS, 'partition'),
    name: asString(raw.name),
    prefix: asString(raw.prefix),
    scopes: asArray(raw.scopes).map((scope) => oneOf(scope, API_SCOPES, 'memories:read')),
    created_by: asString(raw.created_by ?? raw.createdBy),
    created_at: asString(raw.created_at ?? raw.createdAt),
    last_used_at: asNullableString(raw.last_used_at ?? raw.lastUsedAt),
    revoked_at: asNullableString(raw.revoked_at ?? raw.revokedAt),
    expires_at: asNullableString(raw.expires_at ?? raw.expiresAt),
    allowed_ips: asStringArray(raw.allowed_ips ?? raw.allowedIps),
    rotated_from: asNullableString(raw.rotated_from ?? raw.rotatedFrom),
    rotated_at: asNullableString(raw.rotated_at ?? raw.rotatedAt),
    rate_limit_per_min: asNumber(raw.rate_limit_per_min ?? raw.rateLimitPerMin),
    ...(typeof raw.secret === 'string' ? { secret: raw.secret } : {}),
  };
}

function normalizeHealth(value: unknown): HealthResponse {
  const raw = asRecord(value);
  return {
    ok: asBoolean(raw.ok),
    version: asString(raw.version),
    uptime_ms: asNumber(raw.uptime_ms ?? raw.uptimeMs),
    schema_version: asNumber(raw.schema_version ?? raw.schemaVersion),
    db: raw.db === 'ok' ? 'ok' : 'error',
    node: asString(raw.node),
  };
}

/* ------------------------------------------------------------------ */
/* 请求体 / 查询串构造（camelCase → snake_case）                        */
/* ------------------------------------------------------------------ */

function settingsBody(input: PartitionSettingsInput | undefined): JsonRecord | undefined {
  if (!input) return undefined;
  const body = compact({
    default_scope: pick(input.defaultScope, input.default_scope),
    brief_max_chars: pick(input.briefMaxChars, input.brief_max_chars),
    brief_enabled: pick(input.briefEnabled, input.brief_enabled),
    dream_enabled: pick(input.dreamEnabled, input.dream_enabled),
    dream_interval_minutes: pick(input.dreamIntervalMinutes, input.dream_interval_minutes),
    retention_days: pick(input.retentionDays, input.retention_days),
    monthly_quota: pick(input.monthlyQuota, input.monthly_quota),
    person_auto_create: pick(input.personAutoCreate, input.person_auto_create),
    locale: input.locale,
  });
  return Object.keys(body).length === 0 ? undefined : body;
}

function partitionBody(input: PartitionInput, includeSlug: boolean): JsonRecord {
  return compact({
    ...(includeSlug ? { slug: input.slug } : {}),
    name: input.name,
    description: input.description,
    status: input.status,
    settings: settingsBody(input.settings),
  });
}

function personUpsertBody(input: PersonInput): JsonRecord {
  return compact({
    external_id: pick(input.externalId, input.external_id),
    type: input.type,
    display_name: pick(input.displayName, input.display_name),
    attributes: input.attributes,
    status: input.status,
  });
}

function personUpdateBody(input: PersonUpdateInput): JsonRecord {
  return compact({
    display_name: pick(input.displayName, input.display_name),
    attributes: input.attributes,
    status: input.status,
  });
}

function personListQuery(input: PersonListQuery): Query {
  return queryFrom({
    type: input.type,
    status: input.status,
    q: input.q,
    sort: input.sort,
    cursor: input.cursor,
    limit: assertLimit(input.limit),
  });
}

function memoryAddBody(input: MemoryInput): JsonRecord {
  const text = pick(input.text, input.content);
  const messages = input.messages;
  if (!text?.trim() && !messages?.length) {
    throw new TypeError('memories.add: text / content / messages 至少提供一个');
  }
  return compact({
    text,
    content: input.content,
    messages: messages?.map((message) => ({ role: message.role, content: message.content, name: message.name })),
    scope: input.scope,
    session_id: pick(input.sessionId, input.session_id),
    session_title: pick(input.sessionTitle, input.session_title),
    category: input.category,
    importance: input.importance,
    confidence: input.confidence,
    source: input.source,
    tags: input.tags,
    metadata: input.metadata,
    expires_at: pick(input.expiresAt, input.expires_at),
  });
}

function memoryUpdateBody(input: MemoryUpdateInput): JsonRecord {
  return compact({
    content: input.content,
    category: input.category,
    importance: input.importance,
    confidence: input.confidence,
    status: input.status,
    tags: input.tags,
    metadata: input.metadata,
    expires_at: pick(input.expiresAt, input.expires_at),
  });
}

function memoryListQuery(input: MemoryListQuery): Query {
  return queryFrom({
    person_id: pick(input.personId, input.person_id),
    person_external_id: pick(input.personExternalId, input.person_external_id),
    scope: input.scope,
    category: input.category,
    status: input.status,
    q: input.q,
    cursor: input.cursor,
    limit: assertLimit(input.limit),
  });
}

function personBriefQuery(input: PersonBriefQuery): Query {
  return queryFrom({
    force: input.force,
    max_chars: pick(input.maxChars, input.max_chars),
  });
}

function personContextBody(input: PersonContextInput): JsonRecord {
  return compact({
    query: input.query,
    budget_tokens: pick(input.budgetTokens, input.budget_tokens),
    include_partition: pick(input.includePartition, input.include_partition),
  });
}

function dreamRunBody(input: MemoryDreamInput): JsonRecord {
  return compact({ batch_size: pick(input.batchSize, input.batch_size) });
}

function keyBody(input: KeyInput): JsonRecord {
  return compact({
    name: input.name,
    scopes: input.scopes,
    rateLimitPerMin: pick(input.rateLimitPerMin, input.rate_limit_per_min),
    expiresAt: pick(input.expiresAt, input.expires_at),
    allowedIps: pick(input.allowedIps, input.allowed_ips),
  });
}

function keyRotateBody(input: KeyRotateInput): JsonRecord {
  return compact({ graceHours: pick(input.graceHours, input.grace_hours) });
}

/* ------------------------------------------------------------------ */
/* 传输层                                                              */
/* ------------------------------------------------------------------ */

export interface RequestConfig {
  body?: unknown;
  query?: Query;
  options?: RequestOptions;
}

/** 资源类依赖的最小传输接口（内部使用）。 */
export interface RequestTransport {
  request<T>(method: HttpMethod, path: string, config?: RequestConfig): Promise<T>;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (text.trim() === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MnemosApiError('响应不是合法 JSON', {
      status: response.status,
      code: 'invalid_response',
      requestId: response.headers.get('x-request-id'),
      details: { body: text.slice(0, 200) },
    });
  }
}

async function toApiError(response: Response): Promise<MnemosApiError> {
  let payload: unknown = null;
  const text = await response.text().catch(() => '');
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  const rawError = isRecord(payload) ? payload.error : undefined;
  const error = isRecord(rawError) ? rawError : {};
  const requestId =
    asNullableString(error.requestId) ??
    asNullableString(error.request_id) ??
    response.headers.get('x-request-id');
  const code = asString(error.code, `http_${response.status}`);
  const message = asString(error.message, `Mnemos API 请求失败（HTTP ${response.status}）`);
  return new MnemosApiError(message, {
    status: response.status,
    code,
    requestId,
    details: error.details ?? null,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  });
}

/**
 * 判断该方法在失败时是否可以安全重试。
 *
 * v6 服务端没有幂等记录存储，因此非只读 POST（写记忆 / 做梦 / 建密钥）
 * 一律不自动重试；只有只读检索 POST 可以安全重放。PUT/PATCH/DELETE 因为
 * 语义幂等，允许重试。
 */
function canRetryRequest(method: HttpMethod, path: string): boolean {
  if (method === 'GET') return true;
  if (method === 'POST') return path.endsWith('/memories/search');
  // PUT / PATCH / DELETE 语义上幂等。
  return method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/* ------------------------------------------------------------------ */
/* 资源：partitions                                                    */
/* ------------------------------------------------------------------ */

/** 分区（App / 项目 / 租户 / 工作区）。 */
export class PartitionsResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  /** 列出本组织可见分区（需要 org key）。 */
  async list(options?: RequestOptions): Promise<Partition[]> {
    const raw = await this.transport.request<unknown>('GET', '/v1/partitions', { options });
    return asArray(raw).map(normalizePartition);
  }

  /** 建 / 幂等 upsert 分区（org key + admin 权限）。 */
  async create(input: PartitionInput, options?: RequestOptions): Promise<Partition> {
    const raw = await this.transport.request<unknown>('POST', '/v1/partitions', {
      body: partitionBody(input, true),
      options,
    });
    return normalizePartition(raw);
  }

  /** 分区信息 + settings（不含敏感字段）。 */
  async get(partition: string, options?: RequestOptions): Promise<Partition> {
    const raw = await this.transport.request<unknown>('GET', `/v1/partitions/${encodeRef(partition)}`, {
      options,
    });
    return normalizePartition(raw);
  }

  /** 局部更新分区（admin 权限）。 */
  async update(
    partition: string,
    input: Partial<Omit<PartitionInput, 'slug'>>,
    options?: RequestOptions,
  ): Promise<Partition> {
    const body = assertPatchBody(
      'partitions.update',
      compact({
        name: input.name,
        description: input.description,
        status: input.status,
        settings: settingsBody(input.settings),
      }),
    );
    const raw = await this.transport.request<unknown>('PATCH', `/v1/partitions/${encodeRef(partition)}`, {
      body,
      options,
    });
    return normalizePartition(raw);
  }

  /** 分区统计（直接读 `partition_stats`，O(1)）。 */
  async stats(partition: string, options?: RequestOptions): Promise<PartitionStats> {
    const raw = await this.transport.request<unknown>(
      'GET',
      `/v1/partitions/${encodeRef(partition)}/stats`,
      { options },
    );
    return normalizeStats(raw);
  }
}

/* ------------------------------------------------------------------ */
/* 资源：persons                                                       */
/* ------------------------------------------------------------------ */

/** 人（记忆主体：真人 / 智能体 / 服务）。 */
export class PersonsResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  private base(partition: string): string {
    return `/v1/partitions/${encodeRef(partition)}/persons`;
  }

  /**
   * 人列表：游标分页（`cursor` / `limit` / `q` / `type` / `status` / `sort`）。
   *
   * 响应带 `partition_stats` 头部统计；不返回 total。
   */
  async list(
    partition: string,
    input: PersonListQuery = {},
    options?: RequestOptions,
  ): Promise<CursorPage<Person>> {
    const raw = await this.transport.request<unknown>('GET', this.base(partition), {
      query: personListQuery(input),
      options,
    });
    return normalizePage(raw, normalizePerson);
  }

  /** 人详情（`personRef` 支持内部 id 或 external id）。 */
  async get(partition: string, personRef: string, options?: RequestOptions): Promise<Person> {
    const raw = await this.transport.request<unknown>(
      'GET',
      `${this.base(partition)}/${encodeRef(personRef)}`,
      { options },
    );
    return normalizePerson(raw);
  }

  /** 建档 / 更新人（`PUT .../persons/:externalId`）。 */
  async upsert(
    partition: string,
    externalId: string,
    input: PersonInput = {},
    options?: RequestOptions,
  ): Promise<Person> {
    if (!externalId.trim()) throw new TypeError('persons.upsert: externalId 不能为空');
    const raw = await this.transport.request<unknown>(
      'PUT',
      `${this.base(partition)}/${encodeRef(externalId)}`,
      { body: personUpsertBody(input), options },
    );
    return normalizePerson(raw);
  }

  /** 局部更新人（展示名 / attributes / status）。 */
  async update(
    partition: string,
    personRef: string,
    input: PersonUpdateInput,
    options?: RequestOptions,
  ): Promise<Person> {
    const raw = await this.transport.request<unknown>(
      'PATCH',
      `${this.base(partition)}/${encodeRef(personRef)}`,
      { body: assertPatchBody('persons.update', personUpdateBody(input)), options },
    );
    return normalizePerson(raw);
  }
}

/* ------------------------------------------------------------------ */
/* 资源：memories                                                      */
/* ------------------------------------------------------------------ */

/** 记忆（永远属于一个人；共享由 `scope` 决定）。 */
export class MemoriesResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  private base(partition: string): string {
    return `/v1/partitions/${encodeRef(partition)}/memories`;
  }

  private personBase(partition: string, personRef: string): string {
    return `/v1/partitions/${encodeRef(partition)}/persons/${encodeRef(personRef)}/memories`;
  }

  /**
   * 分区内记忆全局列表（游标分页）：可按人（内部 / 外部 ID）、scope、分类、
   * 状态与 `q` 过滤。
   */
  async list(
    partition: string,
    input: MemoryListQuery = {},
    options?: RequestOptions,
  ): Promise<CursorPage<Memory>> {
    const raw = await this.transport.request<unknown>('GET', this.base(partition), {
      query: memoryListQuery(input),
      options,
    });
    return normalizePage(raw, normalizeMemory);
  }

  /** 某人的记忆列表（游标分页 + scope/category 过滤）。 */
  async listByPerson(
    partition: string,
    personRef: string,
    input: MemoryListQuery = {},
    options?: RequestOptions,
  ): Promise<CursorPage<Memory>> {
    const query = memoryListQuery(input);
    // 人路径已经限定主体，不再重复发送 person_id。
    delete query.person_id;
    delete query.person_external_id;
    const raw = await this.transport.request<unknown>('GET', this.personBase(partition, personRef), {
      query,
      options,
    });
    return normalizePage(raw, normalizeMemory);
  }

  /** 写入记忆（`personRef` 必填；scope 缺省取分区设置）。 */
  async add(
    partition: string,
    personRef: string,
    input: MemoryInput,
    options?: RequestOptions,
  ): Promise<AddMemoryResponse> {
    const raw = await this.transport.request<unknown>('POST', this.personBase(partition, personRef), {
      body: memoryAddBody(input),
      options,
    });
    return normalizeAddResponse(raw);
  }

  /** 全文检索（FTS5 前缀匹配）。 */
  async search(
    partition: string,
    input: MemorySearchInput,
    options?: RequestOptions,
  ): Promise<SearchResponse> {
    if (!input.query?.trim()) throw new TypeError('memories.search: query 不能为空');
    const raw = await this.transport.request<unknown>(
      'POST',
      `${this.base(partition)}/search`,
      {
        body: compact({
          query: input.query,
          person_id: pick(input.personId, input.person_id),
          scope: input.scope,
          category: input.category,
          top_k: pick(input.topK, input.top_k),
        }),
        options,
      },
    );
    return normalizeSearchResponse(raw);
  }

  /** 记忆详情（含归属人）。 */
  async get(partition: string, id: string, options?: RequestOptions): Promise<MemoryDetail> {
    const raw = await this.transport.request<unknown>(
      'GET',
      `${this.base(partition)}/${encodeRef(id)}`,
      { options },
    );
    return normalizeMemoryDetail(raw);
  }

  /** 更新记忆（只发送提供的字段）。 */
  async update(
    partition: string,
    id: string,
    input: MemoryUpdateInput,
    options?: RequestOptions,
  ): Promise<MemoryMutationResponse> {
    const raw = await this.transport.request<unknown>(
      'PATCH',
      `${this.base(partition)}/${encodeRef(id)}`,
      { body: assertPatchBody('memories.update', memoryUpdateBody(input)), options },
    );
    return normalizeMemoryMutation(raw);
  }

  /** 删除记忆（服务端返回 204）。 */
  async delete(partition: string, id: string, options?: RequestOptions): Promise<void> {
    await this.transport.request<void>('DELETE', `${this.base(partition)}/${encodeRef(id)}`, { options });
  }
}

/* ------------------------------------------------------------------ */
/* 资源：keys（控制台端点，需会话 token）                               */
/* ------------------------------------------------------------------ */

/** 组织级 API Key（仅组织 owner 可管理）。 */
export class OrgKeysResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  async list(options?: RequestOptions): Promise<ApiKey[]> {
    const raw = await this.transport.request<unknown>('GET', '/api/org/keys', { options });
    return asArray(raw).map(normalizeApiKey);
  }

  async create(input: KeyInput, options?: RequestOptions): Promise<ApiKey> {
    const raw = await this.transport.request<unknown>('POST', '/api/org/keys', {
      body: keyBody(input),
      options,
    });
    return normalizeApiKey(raw);
  }

  async revoke(keyId: string, options?: RequestOptions): Promise<void> {
    await this.transport.request<void>('DELETE', `/api/org/keys/${encodeRef(keyId)}`, { options });
  }
}

/**
 * API Key 管理（控制台端点）。
 *
 * 这些方法走 `/api/partitions/:partition/keys`（控制台鉴权），因此客户端的
 * `apiKey` 需要是控制台会话 token，而不是 `mnemos_live_*` API Key。
 */
export class KeysResource {
  private readonly transport: RequestTransport;
  /** 组织级密钥。 */
  readonly org: OrgKeysResource;

  constructor(transport: RequestTransport) {
    this.transport = transport;
    this.org = new OrgKeysResource(transport);
  }

  private base(partition: string): string {
    return `/api/partitions/${encodeRef(partition)}/keys`;
  }

  async list(partition: string, options?: RequestOptions): Promise<ApiKey[]> {
    const raw = await this.transport.request<unknown>('GET', this.base(partition), { options });
    return asArray(raw).map(normalizeApiKey);
  }

  /** 创建分区 key；响应里的 `secret` 只出现一次。 */
  async create(partition: string, input: KeyInput, options?: RequestOptions): Promise<ApiKey> {
    const raw = await this.transport.request<unknown>('POST', this.base(partition), {
      body: keyBody(input),
      options,
    });
    return normalizeApiKey(raw);
  }

  /** 轮换分区 key（v6 立即吊销旧 key；`graceHours` 仅写审计）。 */
  async rotate(
    partition: string,
    keyId: string,
    input: KeyRotateInput = {},
    options?: RequestOptions,
  ): Promise<ApiKey> {
    const raw = await this.transport.request<unknown>(
      'POST',
      `${this.base(partition)}/${encodeRef(keyId)}/rotate`,
      { body: keyRotateBody(input), options },
    );
    return normalizeApiKey(raw);
  }

  /** 吊销分区 key。 */
  async revoke(partition: string, keyId: string, options?: RequestOptions): Promise<void> {
    await this.transport.request<void>(
      'DELETE',
      `${this.base(partition)}/${encodeRef(keyId)}`,
      { options },
    );
  }
}

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

/** Mnemos 客户端。 */
export class MnemosClient implements RequestTransport {
  /** 分区（App / 项目 / 租户 / 工作区）。 */
  readonly partitions: PartitionsResource;
  /** 人（记忆主体）。 */
  readonly persons: PersonsResource;
  /** 记忆。 */
  readonly memories: MemoriesResource;
  /** API Key 管理（控制台会话 token）。 */
  readonly keys: KeysResource;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MnemosClientOptions) {
    if (!options || typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new TypeError('MnemosClient: apiKey 不能为空');
    }
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    try {
      // 只做合法性校验；保留可能存在的路径前缀。
      new URL(baseUrl);
    } catch {
      throw new TypeError(`MnemosClient: baseUrl 不是合法 URL：${baseUrl}`);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('MnemosClient: timeoutMs 必须为正数');
    }
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new TypeError('MnemosClient: maxRetries 必须为非负整数');
    }
    const impl = options.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new TypeError('MnemosClient: 当前运行时没有全局 fetch，请通过 fetchImpl 注入');
    }

    this.apiKey = options.apiKey.trim();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetchImpl = impl.bind(globalThis);

    this.partitions = new PartitionsResource(this);
    this.persons = new PersonsResource(this);
    this.memories = new MemoriesResource(this);
    this.keys = new KeysResource(this);
  }

  /** 发送一次（含重试）API 请求。内部方法，资源类使用。 */
  async request<T>(method: HttpMethod, path: string, config: RequestConfig = {}): Promise<T> {
    const options = config.options ?? {};
    const url = this.buildUrl(path, config.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
      'x-mnemos-sdk': `typescript/${SDK_VERSION}`,
    };
    if (config.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    Object.assign(headers, options.headers ?? {});

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const retryableRequest = canRetryRequest(method, path);
    const requestBody = config.body === undefined ? undefined : JSON.stringify(config.body);
    let lastError: MnemosApiError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (options.signal?.aborted) {
        throw new MnemosApiError('请求已被取消', { status: 0, code: 'aborted', requestId: null });
      }
      const timeoutSignal = createTimeoutSignal(timeoutMs);
      const controller = new AbortController();
      const onTimeout = (): void => controller.abort();
      const onExternalAbort = (): void => controller.abort();
      timeoutSignal.addEventListener('abort', onTimeout, { once: true });
      options.signal?.addEventListener('abort', onExternalAbort, { once: true });

      let retryable = false;
      let retryAfterMs: number | null = null;

      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });

        if (response.ok) {
          if (response.status === 204) return undefined as T;
          return await parseJsonResponse<T>(response);
        }

        const apiError = await toApiError(response);
        lastError = apiError;
        retryable = RETRYABLE_STATUS.has(response.status) && retryableRequest;
        retryAfterMs = apiError.retryAfterMs;
      } catch (error) {
        if (error instanceof MnemosApiError) throw error;
        const timedOut = timeoutSignal.aborted;
        const externallyAborted = options.signal?.aborted ?? false;
        if (externallyAborted && !timedOut) {
          throw new MnemosApiError('请求已被取消', { status: 0, code: 'aborted', requestId: null });
        }
        const details = error instanceof Error ? { name: error.name, message: error.message } : undefined;
        lastError = new MnemosApiError(timedOut ? `请求超时（>${timeoutMs}ms）` : '网络请求失败', {
          status: 0,
          code: timedOut ? 'timeout' : 'network_error',
          requestId: null,
          details,
        });
        retryable = true;
      } finally {
        timeoutSignal.removeEventListener('abort', onTimeout);
        options.signal?.removeEventListener('abort', onExternalAbort);
      }

      if (!retryable || !retryableRequest || attempt >= this.maxRetries) {
        if (lastError) throw lastError;
        throw new MnemosApiError('请求失败', { status: 0, code: 'unknown_error', requestId: null });
      }
      const delay = retryAfterMs ?? backoffDelay(attempt);
      await sleep(delay);
    }

    if (lastError) throw lastError;
    throw new MnemosApiError('请求失败', { status: 0, code: 'unknown_error', requestId: null });
  }

  /* ------------------------------------------------------------------ */
  /* 人级简报 / 上下文 / 做梦                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 获取人级简报：最近的活跃记忆压缩成不超过 `maxChars` 的文本。
   *
   * 命中缓存时 `cached=true`；传 `force: true` 可跳过缓存重新生成。
   */
  async personBrief(
    partition: string,
    personRef: string,
    input: PersonBriefQuery = {},
    options?: RequestOptions,
  ): Promise<MemoryBrief> {
    const raw = await this.request<unknown>(
      'GET',
      `/v1/partitions/${encodeRef(partition)}/persons/${encodeRef(personRef)}/brief`,
      { query: personBriefQuery(input), options },
    );
    return normalizeBrief(raw);
  }

  /** 人级上下文：资料 + 简报 + 相关记忆 +（可选）分区共享知识，附带可注入的 prompt。 */
  async personContext(
    partition: string,
    personRef: string,
    input: PersonContextInput = {},
    options?: RequestOptions,
  ): Promise<PersonContext> {
    const raw = await this.request<unknown>(
      'POST',
      `/v1/partitions/${encodeRef(partition)}/persons/${encodeRef(personRef)}/context`,
      { body: personContextBody(input), options },
    );
    return normalizeContext(raw);
  }

  /** 人级做梦状态：设置、待整理数、最近运行记录。 */
  async personDream(
    partition: string,
    personRef: string,
    options?: RequestOptions,
  ): Promise<MemoryDreamStatus> {
    const raw = await this.request<unknown>(
      'GET',
      `/v1/partitions/${encodeRef(partition)}/persons/${encodeRef(personRef)}/dream`,
      { options },
    );
    return normalizeDreamStatus(raw);
  }

  /** 手动触发一次人级做梦（增量记忆巩固）。 */
  async personDreamRun(
    partition: string,
    personRef: string,
    input: MemoryDreamInput = {},
    options?: RequestOptions,
  ): Promise<MemoryDreamResult> {
    const raw = await this.request<unknown>(
      'POST',
      `/v1/partitions/${encodeRef(partition)}/persons/${encodeRef(personRef)}/dream/run`,
      { body: dreamRunBody(input), options },
    );
    return normalizeDreamResult(raw);
  }

  /* ------------------------------------------------------------------ */
  /* 健康检查                                                            */
  /* ------------------------------------------------------------------ */

  /** 健康检查（无需鉴权）。 */
  async health(options?: RequestOptions): Promise<HealthResponse> {
    const raw = await this.request<unknown>('GET', '/health', { options });
    return normalizeHealth(raw);
  }

  private buildUrl(path: string, query: Query | undefined): string {
    return `${this.baseUrl}${path}${buildQuery(query)}`;
  }
}

export type {
  AddMemoryInput,
  AddMemoryResponse,
  ApiErrorPayload,
  ApiKey,
  ApiKeyKind,
  ApiScope,
  Audit,
  AuditLog,
  ChatMessage,
  CursorPage,
  DreamResult,
  DreamRun,
  DreamRunInput,
  DreamStatus,
  HealthResponse,
  Key,
  KeyInput,
  KeyRotateInput,
  Memory,
  MemoryAddResponse,
  MemoryBrief,
  MemoryBriefItem,
  MemoryCategory,
  MemoryDetail,
  MemoryDreamInput,
  MemoryDreamResult,
  MemoryDreamRun,
  MemoryDreamRunStatus,
  MemoryDreamSettings,
  MemoryDreamStatus,
  MemoryDreamTrigger,
  MemoryEvent,
  MemoryInput,
  MemoryListQuery,
  MemoryMutationResponse,
  MemoryScope,
  MemorySearchInput,
  MemorySource,
  MemoryStatus,
  MemoryUpdateInput,
  MessageRole,
  MnemosClientOptions,
  Partition,
  PartitionInput,
  PartitionSettings,
  PartitionSettingsInput,
  PartitionStats,
  PartitionStatus,
  Person,
  PersonBrief,
  PersonBriefQuery,
  PersonContext,
  PersonContextInput,
  PersonInput,
  PersonListQuery,
  PersonSort,
  PersonStatus,
  PersonType,
  PersonUpdateInput,
  RequestOptions,
  SearchResponse,
  Session,
  Usage,
  UsageAnalytics,
  UsageBreakdownRow,
  UsagePoint,
} from './types.js';

export default MnemosClient;
