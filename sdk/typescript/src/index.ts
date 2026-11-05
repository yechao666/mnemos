/**
 * `@mnemos/sdk` —— Mnemos 官方 TypeScript SDK。
 *
 * 设计要点：
 * - 零运行时依赖，Node ≥18（全局 fetch）与浏览器通用；
 * - 请求参数支持 camelCase 别名，统一序列化为 snake_case；
 * - 响应模型统一归一化为 snake_case（兼容服务端不同接口的命名差异）；
 * - 429 / 502 / 503 / 504 与网络错误指数退避重试，尊重 `Retry-After`；
 * - 写请求可传 `idempotencyKey`，重试时复用同一个 `Idempotency-Key`。
 */

import type {
  AddMemoryResponse,
  Agent,
  AgentCreateInput,
  AgentListResponse,
  Briefing,
  ChatMessage,
  ContextBuildInput,
  EntityRef,
  FeedbackInput,
  GraphData,
  GraphInput,
  GraphEdge,
  GraphNode,
  HealthResponse,
  ImportDocument,
  ImportMemoryInput,
  ImportResult,
  Memory,
  MemoryAddInput,
  MemoryDetail,
  MemoryEvent,
  MemoryHistoryEntry,
  MemoryHistoryResponse,
  MemoryListInput,
  MemoryListResponse,
  MemorySearchInput,
  MemoryUpdateInput,
  MnemosClientOptions,
  MutationResponse,
  ProjectExport,
  ProjectMetrics,
  Relation,
  RequestOptions,
  SearchFilters,
  SearchHit,
  SearchResponse,
  SignalScores,
  StatsResponse,
  Task,
  TaskCreateInput,
  TaskFinishInput,
  TaskFinishResponse,
  TaskListInput,
  TaskListResponse,
  Webhook,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookDeliveryListInput,
  WebhookDeliveryListResponse,
  WebhookDeliveryStatus,
  WebhookEventType,
  WebhookListResponse,
  WebhookUpdateInput,
} from './types.js';

/** SDK 版本。 */
export const SDK_VERSION = '1.0.0';
/** 默认服务地址。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4380';
/** 默认单次请求超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 默认最大重试次数。 */
export const DEFAULT_MAX_RETRIES = 2;

/** 可重试的 HTTP 状态码。 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** 指数退避基数（毫秒）。 */
const RETRY_BASE_DELAY_MS = 200;

type JsonRecord = Record<string, unknown>;
type QueryValue = string | number | boolean | null | undefined;
type Query = Record<string, QueryValue | QueryValue[]>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

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
  /** 稳定错误码，例如 `validation_error`、`rate_limited`。 */
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
  return typeof value === 'string' ? value : null;
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

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

/* ------------------------------------------------------------------ */
/* 响应归一化                                                          */
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
] as const;
const VISIBILITIES = ['project', 'agent', 'task'] as const;
const MEMORY_STATUSES = ['active', 'archived', 'deleted'] as const;
const MEMORY_SOURCES = ['conversation', 'api', 'agent', 'import', 'playground'] as const;
const MEMORY_EVENTS = ['ADD', 'UPDATE', 'DELETE', 'MERGE', 'NOOP'] as const;
const AGENT_STATUSES = ['active', 'idle', 'retired'] as const;
const TASK_STATUSES = ['open', 'active', 'done', 'abandoned'] as const;
const WEBHOOK_EVENT_TYPES = [
  'memory.created',
  'memory.updated',
  'memory.deleted',
  'task.finished',
  'agent.registered',
  'key.created',
  'key.revoked',
  'quota.exceeded',
] as const;
const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivering', 'success', 'failed', 'dead'] as const;
const SECTION_KEYS = [
  'project',
  'conventions',
  'decisions',
  'experience',
  'incidents',
  'agent_notes',
  'open_tasks',
] as const;

function normalizeSignals(value: unknown): SignalScores {
  const record = asRecord(value);
  return {
    semantic: asNumber(record.semantic),
    keyword: asNumber(record.keyword),
    entity: asNumber(record.entity),
    recency: asNumber(record.recency),
    importance: asNumber(record.importance),
  };
}

function normalizeMemory(value: unknown): Memory {
  const record = asRecord(value);
  const content = asString(record.content, asString(record.memory));
  return {
    id: asString(record.id),
    content,
    memory: asString(record.memory, content),
    project_id: asNullableString(record.project_id ?? record.projectId),
    user_id: asNullableString(record.user_id ?? record.userId),
    agent_id: asNullableString(record.agent_id ?? record.agentId),
    run_id: asNullableString(record.run_id ?? record.runId),
    app_id: asNullableString(record.app_id ?? record.appId),
    task_id: asNullableString(record.task_id ?? record.taskId),
    visibility: oneOf(record.visibility, VISIBILITIES, 'project'),
    category: oneOf(record.category, MEMORY_CATEGORIES, 'fact'),
    importance: asNumber(record.importance),
    confidence: asNumber(record.confidence),
    source: oneOf(record.source, MEMORY_SOURCES, 'api'),
    status: oneOf(record.status, MEMORY_STATUSES, 'active'),
    tags: asStringArray(record.tags),
    metadata: asRecord(record.metadata),
    created_at: asString(record.created_at, asString(record.createdAt)),
    updated_at: asString(record.updated_at, asString(record.updatedAt)),
    last_accessed_at: asNullableString(record.last_accessed_at ?? record.lastAccessedAt),
    access_count: asNumber(record.access_count, asNumber(record.accessCount)),
    expires_at: asNullableString(record.expires_at ?? record.expiresAt),
  };
}

function normalizeHit(value: unknown): SearchHit {
  const record = asRecord(value);
  return {
    ...normalizeMemory(record),
    score: asNumber(record.score),
    signals: normalizeSignals(record.signals),
    matched_on: asStringArray(record.matched_on ?? record.matchedOn),
    entities: asStringArray(record.entities),
  };
}

function normalizeEvent(value: unknown): MemoryEvent {
  const record = asRecord(value);
  return {
    type: oneOf(record.type, MEMORY_EVENTS, 'ADD'),
    memory_id: asNullableString(record.memory_id ?? record.memoryId),
    content: asString(record.content),
    reason: asNullableString(record.reason) ?? undefined,
    at: asString(record.at),
  };
}

function normalizeHistoryEntry(value: unknown): MemoryHistoryEntry {
  const record = asRecord(value);
  return {
    id: asString(record.id),
    memory_id: asString(record.memory_id, asString(record.memoryId)),
    event: oneOf(record.event, MEMORY_EVENTS, 'UPDATE'),
    old_content: asNullableString(record.old_content ?? record.old_memory ?? record.oldContent),
    new_content: asNullableString(record.new_content ?? record.new_memory ?? record.newContent),
    actor: asString(record.actor),
    reason: asNullableString(record.reason),
    created_at: asString(record.created_at, asString(record.createdAt)),
    meta: asRecord(record.meta),
  };
}

function normalizeEntity(value: unknown): EntityRef {
  const record = asRecord(value);
  return {
    id: asString(record.id),
    name: asString(record.name),
    type: asString(record.type),
    mention_count: asNumber(record.mention_count, asNumber(record.mentionCount)),
  };
}

function normalizeRelation(value: unknown): Relation {
  const record = asRecord(value);
  return {
    id: asString(record.id),
    source_entity_id: asString(record.source_entity_id, asString(record.sourceEntityId)),
    target_entity_id: asString(record.target_entity_id, asString(record.targetEntityId)),
    relation: asString(record.relation),
    memory_id: asNullableString(record.memory_id ?? record.memoryId),
    weight: asNumber(record.weight),
    created_at: asString(record.created_at, asString(record.createdAt)),
  };
}

function normalizeAgent(value: unknown): Agent {
  const record = asRecord(value);
  const stats = asRecord(record.stats);
  return {
    id: asString(record.id),
    project_id: asString(record.project_id, asString(record.projectId)),
    name: asString(record.name),
    role: asString(record.role),
    model: asString(record.model),
    description: asString(record.description),
    capabilities: asStringArray(record.capabilities),
    status: oneOf(record.status, AGENT_STATUSES, 'active'),
    metadata: asRecord(record.metadata),
    created_at: asString(record.created_at, asString(record.createdAt)),
    last_active_at: asNullableString(record.last_active_at ?? record.lastActiveAt),
    stats: {
      memories: asNumber(stats.memories),
      private_memories: asNumber(stats.private_memories, asNumber(stats.privateMemories)),
      tasks: asNumber(stats.tasks),
      last_task_at: asNullableString(stats.last_task_at ?? stats.lastTaskAt),
    },
  };
}

function normalizeTask(value: unknown): Task {
  const record = asRecord(value);
  return {
    id: asString(record.id),
    project_id: asString(record.project_id, asString(record.projectId)),
    title: asString(record.title),
    goal: asString(record.goal),
    status: oneOf(record.status, TASK_STATUSES, 'open'),
    owner_agent_id: asNullableString(record.owner_agent_id ?? record.ownerAgentId),
    owner_agent_name: asNullableString(record.owner_agent_name ?? record.ownerAgentName),
    branch: asNullableString(record.branch),
    summary: asNullableString(record.summary),
    metadata: asRecord(record.metadata),
    created_at: asString(record.created_at, asString(record.createdAt)),
    started_at: asString(record.started_at, asString(record.startedAt)),
    ended_at: asNullableString(record.ended_at ?? record.endedAt),
    memory_count: asNumber(record.memory_count, asNumber(record.memoryCount)),
    agent_count: asNumber(record.agent_count, asNumber(record.agentCount)),
  };
}

function normalizeBriefing(value: unknown): Briefing {
  const record = asRecord(value);
  const project = asRecord(record.project);
  return {
    project: {
      id: asString(project.id),
      name: asString(project.name),
      description: asString(project.description),
    },
    agent: isRecord(record.agent) ? normalizeAgent(record.agent) : null,
    task: isRecord(record.task) ? normalizeTask(record.task) : null,
    sections: asArray(record.sections).map((section) => {
      const item = asRecord(section);
      return {
        key: oneOf(item.key, SECTION_KEYS, 'project'),
        title: asString(item.title),
        description: asString(item.description),
        hits: asArray(item.hits).map(normalizeHit),
      };
    }),
    prompt: asString(record.prompt),
    token_estimate: asNumber(record.token_estimate, asNumber(record.tokenEstimate)),
    citations: asStringArray(record.citations),
    built_at: asString(record.built_at, asString(record.builtAt)),
    took_ms: asNumber(record.took_ms, asNumber(record.tookMs)),
  };
}

function normalizeGraph(value: unknown): GraphData {
  const record = asRecord(value);
  const stats = asRecord(record.stats);
  const data: GraphData = {
    nodes: asArray(record.nodes).map((node): GraphNode => {
      const item = asRecord(node);
      return {
        id: asString(item.id),
        label: asString(item.label),
        type: asString(item.type),
        weight: asNumber(item.weight),
        memories: asNumber(item.memories),
      };
    }),
    edges: asArray(record.edges).map((edge): GraphEdge => {
      const item = asRecord(edge);
      return {
        id: asString(item.id),
        source: asString(item.source),
        target: asString(item.target),
        relation: asString(item.relation),
        weight: asNumber(item.weight),
      };
    }),
  };
  if (Object.keys(stats).length > 0) {
    data.stats = {
      nodes: asNumber(stats.nodes),
      edges: asNumber(stats.edges),
      entities: asNumber(stats.entities),
      density: asNumber(stats.density),
      top_types: asArray(stats.top_types ?? stats.topTypes).map((entry) => {
        const item = asRecord(entry);
        return { type: asString(item.type), count: asNumber(item.count) };
      }),
    };
  }
  return data;
}

function normalizeMetrics(value: unknown): ProjectMetrics {
  const record = asRecord(value);
  return {
    total_memories: asNumber(record.total_memories, asNumber(record.totalMemories)),
    users: asNumber(record.users),
    agents: asNumber(record.agents),
    entities: asNumber(record.entities),
    relations: asNumber(record.relations),
    searches_7d: asNumber(record.searches_7d, asNumber(record.searches7d)),
    adds_7d: asNumber(record.adds_7d, asNumber(record.adds7d)),
    tokens_saved: asNumber(record.tokens_saved, asNumber(record.tokensSaved)),
    storage_bytes: asNumber(record.storage_bytes, asNumber(record.storageBytes)),
    quota_used_pct: asNumber(record.quota_used_pct, asNumber(record.quotaUsedPct)),
    recall_p50_ms: asNumber(record.recall_p50_ms, asNumber(record.recallP50Ms)),
    recall_p95_ms: asNumber(record.recall_p95_ms, asNumber(record.recallP95Ms)),
    hit_rate: asNumber(record.hit_rate, asNumber(record.hitRate)),
    growth_pct: asNumber(record.growth_pct, asNumber(record.growthPct)),
    last_activity_at: asNullableString(record.last_activity_at ?? record.lastActivityAt),
  };
}

function normalizeWebhook(value: unknown): Webhook {
  const record = asRecord(value);
  return {
    id: asString(record.id),
    project_id: asString(record.project_id, asString(record.projectId)),
    name: asString(record.name),
    url: asString(record.url),
    secret: asNullableString(record.secret) ?? undefined,
    event_types: asStringArray(record.event_types ?? record.eventTypes).filter(
      (value): value is WebhookEventType => (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value),
    ),
    enabled: asBoolean(record.enabled, true),
    description: asString(record.description),
    created_by: asNullableString(record.created_by ?? record.createdBy),
    created_at: asString(record.created_at, asString(record.createdAt)),
    updated_at: asString(record.updated_at, asString(record.updatedAt)),
    last_delivery_at: asNullableString(record.last_delivery_at ?? record.lastDeliveryAt),
    last_status: typeof record.last_status === 'number' ? record.last_status : null,
    failure_count: asNumber(record.failure_count, asNumber(record.failureCount)),
    disabled_at: asNullableString(record.disabled_at ?? record.disabledAt),
  };
}

function normalizeDelivery(value: unknown): WebhookDelivery {
  const record = asRecord(value);
  const responseStatus = record.response_status ?? record.responseStatus;
  const latency = record.latency_ms ?? record.latencyMs;
  return {
    id: asString(record.id),
    webhook_id: asString(record.webhook_id, asString(record.webhookId)),
    project_id: asNullableString(record.project_id ?? record.projectId),
    event_type: oneOf(record.event_type ?? record.eventType, WEBHOOK_EVENT_TYPES, 'memory.created'),
    event_id: asNullableString(record.event_id ?? record.eventId),
    status: oneOf(record.status, WEBHOOK_DELIVERY_STATUSES, 'pending'),
    attempts: asNumber(record.attempts),
    max_attempts: asNumber(record.max_attempts, asNumber(record.maxAttempts, 6)),
    next_attempt_at: asNullableString(record.next_attempt_at ?? record.nextAttemptAt),
    response_status: typeof responseStatus === 'number' ? responseStatus : null,
    response_body: asNullableString(record.response_body ?? record.responseBody),
    latency_ms: typeof latency === 'number' ? latency : null,
    error: asNullableString(record.error),
    created_at: asString(record.created_at, asString(record.createdAt)),
    delivered_at: asNullableString(record.delivered_at ?? record.deliveredAt),
  };
}

function normalizeExport(value: unknown): ProjectExport {
  const record = asRecord(value);
  const project = asRecord(record.project);
  return {
    format: 'mnemos-export/v1',
    exported_at: asString(record.exported_at, asString(record.exportedAt)),
    project: {
      id: asString(project.id),
      slug: asString(project.slug),
      name: asString(project.name),
    },
    agents: asArray(record.agents).map(normalizeAgent),
    tasks: asArray(record.tasks).map(normalizeTask),
    memories: asArray(record.memories).map(normalizeMemory),
  };
}

function normalizeAddResponse(value: unknown): AddMemoryResponse {
  const record = asRecord(value);
  return {
    results: asArray(record.results).map(normalizeMemory),
    events: asArray(record.events).map(normalizeEvent),
    took_ms: asNumber(record.took_ms, asNumber(record.tookMs)),
    extracted: typeof record.extracted === 'number' ? record.extracted : undefined,
    merged: typeof record.merged === 'number' ? record.merged : undefined,
    skipped: typeof record.skipped === 'number' ? record.skipped : undefined,
  };
}

function normalizeSearchResponse(value: unknown): SearchResponse {
  const record = asRecord(value);
  const signals = isRecord(record.signals) ? record.signals : undefined;
  return {
    results: asArray(record.results).map(normalizeHit),
    total: asNumber(record.total, asArray(record.results).length),
    took_ms: asNumber(record.took_ms, asNumber(record.tookMs)),
    signals,
  };
}

function normalizeListResponse(value: unknown): MemoryListResponse {
  const record = asRecord(value);
  const results = asArray(record.results);
  return {
    results: results.map(normalizeMemory),
    count: asNumber(record.count, results.length),
    page: asNumber(record.page, 1),
    page_size: asNumber(record.page_size, asNumber(record.pageSize, results.length)),
  };
}

function normalizeDetail(value: unknown): MemoryDetail {
  const record = asRecord(value);
  return {
    ...normalizeMemory(record),
    history: asArray(record.history).map(normalizeHistoryEntry),
    entities: asArray(record.entities).map(normalizeEntity),
    relations: asArray(record.relations).map(normalizeRelation),
    neighbors: asArray(record.neighbors).map(normalizeEntity),
  };
}

function normalizeMutation(value: unknown): MutationResponse {
  const record = asRecord(value);
  return {
    message: asString(record.message, 'ok'),
    ok: typeof record.ok === 'boolean' ? record.ok : undefined,
    deleted: typeof record.deleted === 'number' ? record.deleted : undefined,
    affected: typeof record.affected === 'number' ? record.affected : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* 请求体构造                                                          */
/* ------------------------------------------------------------------ */

function memoryAddBody(input: MemoryAddInput): JsonRecord {
  return compact({
    messages: input.messages,
    text: input.text,
    user_id: pick(input.userId, input.user_id),
    agent_id: pick(input.agentId, input.agent_id),
    run_id: pick(input.runId, input.run_id),
    app_id: pick(input.appId, input.app_id),
    task_id: pick(input.taskId, input.task_id),
    visibility: input.visibility,
    metadata: input.metadata,
    infer: input.infer,
    mode: input.mode,
  });
}

function searchFiltersBody(filters: SearchFilters | undefined): JsonRecord | undefined {
  if (!filters) return undefined;
  const body = compact({
    status: filters.status,
    category: filters.category,
    tags: filters.tags,
    created_after: pick(filters.createdAfter, filters.created_after),
    created_before: pick(filters.createdBefore, filters.created_before),
    min_importance: pick(filters.minImportance, filters.min_importance),
    metadata: filters.metadata,
    user_id: pick(filters.userId, filters.user_id),
    agent_id: pick(filters.agentId, filters.agent_id),
    run_id: pick(filters.runId, filters.run_id),
  });
  return Object.keys(body).length > 0 ? body : undefined;
}

function searchBody(input: MemorySearchInput): JsonRecord {
  return compact({
    query: input.query,
    user_id: pick(input.userId, input.user_id),
    agent_id: pick(input.agentId, input.agent_id),
    task_id: pick(input.taskId, input.task_id),
    run_id: pick(input.runId, input.run_id),
    app_id: pick(input.appId, input.app_id),
    written_by_agent_id: pick(input.writtenByAgentId, input.written_by_agent_id),
    visibility: input.visibility,
    top_k: pick(input.topK, input.top_k),
    threshold: input.threshold,
    include_private: pick(input.includePrivate, input.include_private),
    filters: searchFiltersBody(input.filters),
  });
}

function listQuery(input: MemoryListInput): Query {
  return queryFrom({
    user_id: pick(input.userId, input.user_id),
    agent_id: pick(input.agentId, input.agent_id),
    run_id: pick(input.runId, input.run_id),
    app_id: pick(input.appId, input.app_id),
    task_id: pick(input.taskId, input.task_id),
    visibility: input.visibility,
    category: input.category,
    page: input.page,
    page_size: pick(input.pageSize, input.page_size),
  });
}

function updateBody(input: MemoryUpdateInput): JsonRecord {
  if (!input.text && !input.content) {
    throw new TypeError('memories.update: text 与 content 至少提供一个');
  }
  return compact({
    text: input.text,
    content: input.content,
    category: input.category,
    importance: input.importance,
  });
}

function agentCreateBody(input: AgentCreateInput): JsonRecord {
  return compact({
    name: input.name,
    role: input.role,
    model: input.model,
    description: input.description,
    capabilities: input.capabilities,
    status: input.status,
    metadata: input.metadata,
  });
}

function taskCreateBody(input: TaskCreateInput): JsonRecord {
  return compact({
    title: input.title,
    goal: input.goal,
    owner_agent_id: pick(input.ownerAgentId, input.owner_agent_id),
    branch: input.branch,
    status: input.status,
  });
}

function taskFinishBody(input: TaskFinishInput): JsonRecord {
  return compact({
    status: input.status,
    summary: input.summary,
    decisions: input.decisions,
    lessons: input.lessons,
    notes: input.notes,
    agent_id: pick(input.agentId, input.agent_id),
  });
}

function contextBody(input: ContextBuildInput): JsonRecord {
  return compact({
    agent_id: pick(input.agentId, input.agent_id),
    task_id: pick(input.taskId, input.task_id),
    query: input.query,
    budget_tokens: pick(input.budgetTokens, input.budget_tokens),
  });
}

function taskListQuery(input: TaskListInput): Query {
  return queryFrom({
    status: input.status,
    agent_id: pick(input.agentId, input.agent_id),
    limit: input.limit,
  });
}

function webhookBody(input: WebhookCreateInput | WebhookUpdateInput): JsonRecord {
  return compact({
    name: input.name,
    url: input.url,
    event_types: pick(input.eventTypes, input.event_types),
    enabled: input.enabled,
    description: input.description,
  });
}

/** 把 SDK 归一化的导出文档转回服务端导入格式。 */
function exportToImportDocument(document: ProjectExport): ImportDocument {
  return {
    format: document.format,
    memories: document.memories.map((memory): ImportMemoryInput => {
      const item: ImportMemoryInput = {
        content: memory.content,
        visibility: memory.visibility,
        tags: memory.tags,
        metadata: memory.metadata,
      };
      if (memory.user_id) item.userId = memory.user_id;
      if (memory.agent_id) item.agentId = memory.agent_id;
      if (memory.run_id) item.runId = memory.run_id;
      if (memory.app_id) item.appId = memory.app_id;
      if (memory.task_id) item.taskId = memory.task_id;
      return item;
    }),
  };
}

function isProjectExport(value: unknown): value is ProjectExport {
  return isRecord(value) && Array.isArray(value.memories) && typeof value.exported_at === 'string';
}

/* ------------------------------------------------------------------ */
/* HTTP 传输层                                                         */
/* ------------------------------------------------------------------ */

/** 单次请求配置。 */
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
  if (text.trim() === '') {
    throw new MnemosApiError('响应为空，期望 JSON', {
      status: response.status,
      code: 'invalid_response',
      requestId: response.headers.get('x-request-id'),
    });
  }
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

/** 判断该方法在失败时是否可以安全重试。 */
function canRetryRequest(method: HttpMethod, path: string, idempotencyKey: string | undefined): boolean {
  if (method === 'GET') return true;
  if (method === 'POST') {
    if (idempotencyKey) return true;
    // 检索是只读 POST，可安全重试。
    return path === '/v1/memories/search';
  }
  // PUT / DELETE 语义上幂等。
  return method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/* ------------------------------------------------------------------ */
/* 资源：memories                                                      */
/* ------------------------------------------------------------------ */

/** 记忆资源。 */
export class MemoriesResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  /** 写入记忆（`messages` 与 `text` 至少一个）。 */
  async add(input: MemoryAddInput, options?: RequestOptions): Promise<AddMemoryResponse> {
    const raw = await this.transport.request<unknown>('POST', '/v1/memories', {
      body: memoryAddBody(input),
      options,
    });
    return normalizeAddResponse(raw);
  }

  /** 混合检索记忆。 */
  async search(input: MemorySearchInput, options?: RequestOptions): Promise<SearchResponse> {
    const raw = await this.transport.request<unknown>('POST', '/v1/memories/search', {
      body: searchBody(input),
      options,
    });
    return normalizeSearchResponse(raw);
  }

  /** 分页列出记忆。 */
  async list(input: MemoryListInput = {}, options?: RequestOptions): Promise<MemoryListResponse> {
    const raw = await this.transport.request<unknown>('GET', '/v1/memories', {
      query: listQuery(input),
      options,
    });
    return normalizeListResponse(raw);
  }

  /** 记忆详情（含历史、实体、关系）。 */
  async get(id: string, options?: RequestOptions): Promise<MemoryDetail> {
    const raw = await this.transport.request<unknown>('GET', `/v1/memories/${encodeURIComponent(id)}`, {
      options,
    });
    return normalizeDetail(raw);
  }

  /** 更新记忆正文 / 分类 / 重要度。 */
  async update(id: string, input: MemoryUpdateInput, options?: RequestOptions): Promise<MutationResponse> {
    const raw = await this.transport.request<unknown>('PUT', `/v1/memories/${encodeURIComponent(id)}`, {
      body: updateBody(input),
      options,
    });
    return normalizeMutation(raw);
  }

  /** 软删除单条记忆。 */
  async delete(id: string, options?: RequestOptions): Promise<MutationResponse> {
    const raw = await this.transport.request<unknown>('DELETE', `/v1/memories/${encodeURIComponent(id)}`, {
      options,
    });
    return normalizeMutation(raw);
  }

  /** 变更历史。 */
  async history(id: string, options?: RequestOptions): Promise<MemoryHistoryResponse> {
    const raw = await this.transport.request<unknown>('GET', `/v1/memories/${encodeURIComponent(id)}/history`, {
      options,
    });
    const record = asRecord(raw);
    return { results: asArray(record.results).map(normalizeHistoryEntry) };
  }

  /** 反馈（调整重要度）。 */
  async feedback(id: string, input: FeedbackInput, options?: RequestOptions): Promise<Memory> {
    const raw = await this.transport.request<unknown>('POST', `/v1/memories/${encodeURIComponent(id)}/feedback`, {
      body: compact({ helpful: input.helpful, query: input.query }),
      options,
    });
    return normalizeMemory(raw);
  }
}

/* ------------------------------------------------------------------ */
/* 资源：agents / tasks / context                                      */
/* ------------------------------------------------------------------ */

/** Agent 注册表资源。 */
export class AgentsResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  /** 项目内 Agent 列表。 */
  async list(options?: RequestOptions): Promise<AgentListResponse> {
    const raw = await this.transport.request<unknown>('GET', '/v1/agents', { options });
    const record = asRecord(raw);
    const results = asArray(record.results);
    return { results: results.map(normalizeAgent), count: asNumber(record.count, results.length) };
  }

  /** 注册 Agent。 */
  async create(input: AgentCreateInput, options?: RequestOptions): Promise<Agent> {
    const raw = await this.transport.request<unknown>('POST', '/v1/agents', {
      body: agentCreateBody(input),
      options,
    });
    return normalizeAgent(raw);
  }
}

/** 任务会话资源。 */
export class TasksResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  /** 任务列表（按开始时间倒序）。 */
  async list(input: TaskListInput = {}, options?: RequestOptions): Promise<TaskListResponse> {
    const raw = await this.transport.request<unknown>('GET', '/v1/tasks', {
      query: taskListQuery(input),
      options,
    });
    const record = asRecord(raw);
    const results = asArray(record.results);
    return { results: results.map(normalizeTask), count: asNumber(record.count, results.length) };
  }

  /** 开始任务。 */
  async create(input: TaskCreateInput, options?: RequestOptions): Promise<Task> {
    const raw = await this.transport.request<unknown>('POST', '/v1/tasks', {
      body: taskCreateBody(input),
      options,
    });
    return normalizeTask(raw);
  }

  /** 任务详情。 */
  async get(id: string, options?: RequestOptions): Promise<Task> {
    const raw = await this.transport.request<unknown>('GET', `/v1/tasks/${encodeURIComponent(id)}`, { options });
    return normalizeTask(raw);
  }

  /** 结束任务并沉淀决策 / 经验 / 备注。 */
  async finish(id: string, input: TaskFinishInput = {}, options?: RequestOptions): Promise<TaskFinishResponse> {
    const raw = await this.transport.request<unknown>('POST', `/v1/tasks/${encodeURIComponent(id)}/finish`, {
      body: taskFinishBody(input),
      options,
    });
    const record = asRecord(raw);
    return {
      task: normalizeTask(record.task),
      memories: asArray(record.memories).map(normalizeMemory),
    };
  }
}

/** 任务简报资源。 */
export class ContextResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  /** 构建可直接注入 system prompt 的任务简报。 */
  async build(input: ContextBuildInput = {}, options?: RequestOptions): Promise<Briefing> {
    const raw = await this.transport.request<unknown>('POST', '/v1/context', {
      body: contextBody(input),
      options,
    });
    return normalizeBriefing(raw);
  }
}

/* ------------------------------------------------------------------ */
/* 资源：webhooks（beta）                                              */
/* ------------------------------------------------------------------ */

/**
 * Webhook 资源。
 *
 * 服务端已提供 `/v1/webhooks`、`/v1/webhooks/{id}/rotate-secret`、
 * `/v1/webhooks/{id}/deliveries` 与 `/v1/webhook-deliveries/{id}/replay`。
 *
 * @beta 端点与字段仍可能调整，生产接入前请确认 `docs/api.md`。
 */
export class WebhooksResource {
  private readonly transport: RequestTransport;

  constructor(transport: RequestTransport) {
    this.transport = transport;
  }

  /**
   * 列出 Webhook。
   *
   * @beta
   */
  async list(options?: RequestOptions): Promise<WebhookListResponse> {
    const raw = await this.transport.request<unknown>('GET', '/v1/webhooks', { options });
    // 服务端 v1 直接返回数组；兼容旧版 { results } 包装。
    const items = Array.isArray(raw) ? raw : asArray(asRecord(raw).results);
    return { results: items.map(normalizeWebhook), count: items.length };
  }

  /**
   * 创建 Webhook。
   *
   * @beta
   */
  async create(input: WebhookCreateInput, options?: RequestOptions): Promise<Webhook> {
    const raw = await this.transport.request<unknown>('POST', '/v1/webhooks', {
      body: webhookBody(input),
      options,
    });
    return normalizeWebhook(raw);
  }

  /**
   * 更新 Webhook。
   *
   * @beta
   */
  async update(id: string, input: WebhookUpdateInput, options?: RequestOptions): Promise<Webhook> {
    const raw = await this.transport.request<unknown>('PATCH', `/v1/webhooks/${encodeURIComponent(id)}`, {
      body: webhookBody(input),
      options,
    });
    return normalizeWebhook(raw);
  }

  /**
   * 删除 Webhook。
   *
   * @beta
   */
  async delete(id: string, options?: RequestOptions): Promise<MutationResponse> {
    const raw = await this.transport.request<unknown>('DELETE', `/v1/webhooks/${encodeURIComponent(id)}`, {
      options,
    });
    return normalizeMutation(raw);
  }

  /**
   * 轮换签名密钥，返回带明文 `secret` 的 Webhook。
   *
   * @beta
   */
  async rotateSecret(id: string, options?: RequestOptions): Promise<Webhook> {
    const raw = await this.transport.request<unknown>(
      'POST',
      `/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`,
      { body: {}, options },
    );
    return normalizeWebhook(raw);
  }

  /**
   * 投递记录。
   *
   * @beta
   */
  async deliveries(
    id: string,
    input: WebhookDeliveryListInput = {},
    options?: RequestOptions,
  ): Promise<WebhookDeliveryListResponse> {
    const raw = await this.transport.request<unknown>('GET', `/v1/webhooks/${encodeURIComponent(id)}/deliveries`, {
      query: queryFrom({
        page: input.page,
        page_size: pick(input.pageSize, input.page_size) ?? input.limit,
        status: input.status,
      }),
      options,
    });
    const record = asRecord(raw);
    const items = asArray(record.items ?? record.results);
    return {
      items: items.map(normalizeDelivery),
      page: asNumber(record.page, 1),
      page_size: asNumber(record.page_size, asNumber(record.pageSize, items.length)),
      total: asNumber(record.total, items.length),
      total_pages: asNumber(record.total_pages, asNumber(record.totalPages, 1)),
    };
  }

  /**
   * 重放某次投递。
   *
   * 服务端端点为 `POST /v1/webhook-deliveries/{deliveryId}/replay`，只需要投递 ID；
   * 同时兼容早期的 `replay(webhookId, deliveryId)` 两参数写法。
   *
   * @beta
   */
  async replay(deliveryId: string, options?: RequestOptions): Promise<WebhookDelivery>;
  async replay(webhookId: string, deliveryId: string, options?: RequestOptions): Promise<WebhookDelivery>;
  async replay(
    deliveryIdOrWebhookId: string,
    optionsOrDeliveryId?: RequestOptions | string,
    maybeOptions?: RequestOptions,
  ): Promise<WebhookDelivery> {
    const deliveryId = typeof optionsOrDeliveryId === 'string' ? optionsOrDeliveryId : deliveryIdOrWebhookId;
    const options = typeof optionsOrDeliveryId === 'string' ? maybeOptions : optionsOrDeliveryId;
    const raw = await this.transport.request<unknown>(
      'POST',
      `/v1/webhook-deliveries/${encodeURIComponent(deliveryId)}/replay`,
      { body: {}, options },
    );
    return normalizeDelivery(raw);
  }
}

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

/** Mnemos 客户端。 */
export class MnemosClient implements RequestTransport {
  /** 记忆。 */
  readonly memories: MemoriesResource;
  /** Agent 注册表。 */
  readonly agents: AgentsResource;
  /** 任务会话。 */
  readonly tasks: TasksResource;
  /** 任务简报。 */
  readonly context: ContextResource;
  /** Webhook（beta）。 */
  readonly webhooks: WebhooksResource;

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

    this.memories = new MemoriesResource(this);
    this.agents = new AgentsResource(this);
    this.tasks = new TasksResource(this);
    this.context = new ContextResource(this);
    this.webhooks = new WebhooksResource(this);
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
    const retryableRequest = canRetryRequest(method, path, options.idempotencyKey);
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

  /** 实体关系图谱。 */
  async graph(input: number | GraphInput = {}, options?: RequestOptions): Promise<GraphData> {
    const query: GraphInput = typeof input === 'number' ? { limit: input } : input;
    const raw = await this.request<unknown>('GET', '/v1/graph', {
      query: queryFrom({ limit: query.limit, user_id: pick(query.userId, query.user_id) }),
      options,
    });
    return normalizeGraph(raw);
  }

  /** 项目指标。 */
  async stats(options?: RequestOptions): Promise<StatsResponse> {
    const raw = await this.request<unknown>('GET', '/v1/stats', { options });
    return { metrics: normalizeMetrics(asRecord(raw).metrics) };
  }

  /** 健康检查（无需 API Key）。 */
  async health(options?: RequestOptions): Promise<HealthResponse> {
    const raw = await this.request<unknown>('GET', '/v1/health', { options });
    const record = asRecord(raw);
    return {
      ok: asBoolean(record.ok),
      version: asString(record.version),
      uptime_ms: asNumber(record.uptime_ms, asNumber(record.uptimeMs)),
    };
  }

  /** 导出项目（`mnemos-export/v1`，已归一化为 snake_case 模型）。 */
  async export(options?: RequestOptions): Promise<ProjectExport> {
    const raw = await this.request<unknown>('GET', '/v1/export', { options });
    return normalizeExport(raw);
  }

  /**
   * 导入记忆（≤1000 条/次）。
   *
   * 入参可以是 `export()` 返回的文档，也可以是 `{ memories: [...] }`；
   * 前者会自动转换回服务端导入格式。
   */
  async import(document: ProjectExport | ImportDocument, options?: RequestOptions): Promise<ImportResult> {
    const body = isProjectExport(document) ? exportToImportDocument(document) : document;
    const raw = await this.request<unknown>('POST', '/v1/import', { body, options });
    const record = asRecord(raw);
    return {
      imported: asNumber(record.imported),
      skipped: asNumber(record.skipped),
      failed: asNumber(record.failed),
      errors: asArray(record.errors).map((item) => {
        const entry = asRecord(item);
        return { index: asNumber(entry.index), message: asString(entry.message) };
      }),
    };
  }

  private buildUrl(path: string, query: Query | undefined): string {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${suffix}${buildQuery(query)}`;
  }
}

export type {
  AddMemoryResponse,
  Agent,
  AgentCreateInput,
  AgentListResponse,
  Briefing,
  ChatMessage,
  ContextBuildInput,
  EntityRef,
  FeedbackInput,
  GraphData,
  GraphInput,
  HealthResponse,
  ImportDocument,
  ImportMemoryInput,
  ImportResult,
  Memory,
  MemoryAddInput,
  MemoryCategory,
  MemoryDetail,
  MemoryEvent,
  MemoryHistoryEntry,
  MemoryHistoryResponse,
  MemoryListInput,
  MemoryListResponse,
  MemorySearchInput,
  MemoryStatus,
  MemoryUpdateInput,
  MemoryVisibility,
  MnemosClientOptions,
  MutationResponse,
  ProjectExport,
  ProjectMetrics,
  Relation,
  RequestOptions,
  SearchFilters,
  SearchHit,
  SearchResponse,
  SignalScores,
  StatsResponse,
  Task,
  TaskCreateInput,
  TaskFinishInput,
  TaskFinishResponse,
  TaskListInput,
  TaskListResponse,
  Webhook,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookDeliveryListInput,
  WebhookDeliveryListResponse,
  WebhookDeliveryStatus,
  WebhookEventType,
  WebhookListResponse,
  WebhookUpdateInput,
} from './types.js';

export default MnemosClient;
