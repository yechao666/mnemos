/**
 * v6 控制台 API 客户端（信息架构：分区 → 人 → 记忆）。
 *
 * 契约：docs/v6-architecture.md 第 3 节。要点：
 *  - 列表一律游标分页 `{ items, nextCursor, partitionStats }`，不返回 total；
 *  - 头部统计读 partition_stats（每个列表响应自带 partitionStats）；
 *  - 控制台 `/api` 与公开 `/v1` 同构（camelCase）；本层负责把 snake_case / 旧字段名归一化，
 *    后端尚未上线时页面也能以错误态稳定展示。
 */

import type {
  ApiKey,
  ApiKeyWithSecret,
  AuditLog,
  AuthResponse,
  CursorPage,
  DemoAccount,
  WecomMockConfig,
  DreamResult,
  DreamRun,
  DreamStatus,
  HealthInfo,
  Memory,
  MemoryBrief,
  MemoryCategory,
  MemoryFeedbackInput,
  MemoryHistoryEntry,
  MemoryHistoryEvent,
  MemorySearchHit,
  MemorySearchMode,
  MemorySearchResponse,
  MemorySearchSignals,
  MemoryScope,
  MemoryStatus,
  Org,
  OrgUser,
  Partition,
  PartitionStats,
  Person,
  PersonContext,
  PersonInput,
  PersonStatus,
  PersonType,
  Role,
  UsageAnalytics,
  User,
} from './types.ts';

const TOKEN_KEY = 'mnemos.session';
export const UNAUTHORIZED_EVENT = 'mnemos:unauthorized';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isNotFoundError(error: string | null | undefined): boolean {
  return Boolean(error && (error.includes('404') || error.includes('不存在')));
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 请求基础                                                            */
/* ------------------------------------------------------------------ */

function qs(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    sp.set(key, String(value));
  }
  const text = sp.toString();
  return text ? `?${text}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, 'network_error', '无法连接 Mnemos 服务，请确认后端已启动。');
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      setToken(null);
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    const body = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? `http_${response.status}`,
      body?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      body?.error?.details,
    );
  }

  return payload as T;
}

/* ------------------------------------------------------------------ */
/* 归一化：兼容 camelCase / snake_case 与 v5 旧字段                    */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function optStr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseJsonRecord(value: unknown): Raw {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Raw;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function pickStringArray(value: unknown): string[] {
  return parseJsonArray(value).filter((item): item is string => typeof item === 'string');
}

export function adaptStats(value: unknown): PartitionStats {
  const raw = asRecord(value);
  const persons = asRecord(raw.persons);
  return {
    partitionId: optStr(raw.partitionId ?? raw.partition_id),
    personsTotal: num(raw.personsTotal ?? raw.persons_total ?? persons.total),
    personsHuman: num(raw.personsHuman ?? raw.persons_human ?? persons.human),
    personsAgent: num(raw.personsAgent ?? raw.persons_agent ?? persons.agent),
    personsService: num(raw.personsService ?? raw.persons_service ?? persons.service),
    memoriesTotal: num(raw.memoriesTotal ?? raw.memories_total),
    sharedTotal: num(raw.sharedTotal ?? raw.shared_total),
    sessionsTotal: num(raw.sessionsTotal ?? raw.sessions_total),
    updatedAt: optStr(raw.updatedAt ?? raw.updated_at),
  };
}

const DEFAULT_RETRIEVAL_WEIGHTS = {
  vector: 0.45,
  keyword: 0.3,
  recency: 0.15,
  importance: 0.1,
  entity: 0,
};

/**
 * 分区 settings 归一化：v6 旧分区没有 v6.1 字段，这里补默认值，
 * 保证设置页表单（权重滑块/阈值）永远拿到数字，不会出现 NaN。
 */
function adaptSettings(value: unknown): Partition['settings'] {
  const raw = parseJsonRecord(value);
  const weights = asRecord(raw.retrievalWeights ?? raw.retrieval_weights);
  const mode = raw.retrievalMode ?? raw.retrieval_mode;
  return {
    ...raw,
    retrievalMode: mode === 'keyword' || mode === 'vector' ? mode : 'hybrid',
    retrievalWeights: {
      vector: num(weights.vector, DEFAULT_RETRIEVAL_WEIGHTS.vector),
      keyword: num(weights.keyword, DEFAULT_RETRIEVAL_WEIGHTS.keyword),
      recency: num(weights.recency, DEFAULT_RETRIEVAL_WEIGHTS.recency),
      importance: num(weights.importance, DEFAULT_RETRIEVAL_WEIGHTS.importance),
      entity: num(weights.entity, DEFAULT_RETRIEVAL_WEIGHTS.entity),
    },
    embeddingModel: str(raw.embeddingModel ?? raw.embedding_model, 'mnemos-hash-384'),
    mergeThreshold: num(raw.mergeThreshold ?? raw.merge_threshold, 0.95),
    dedupeThreshold: num(raw.dedupeThreshold ?? raw.dedupe_threshold, 0.98),
    autoExtractEntities: bool(raw.autoExtractEntities ?? raw.auto_extract_entities, true),
  };
}

export function adaptPartition(value: unknown): Partition {
  const raw = asRecord(value);
  const statusRaw = str(raw.status, 'active');
  const status: Partition['status'] =
    statusRaw === 'paused' || statusRaw === 'archived' ? statusRaw : 'active';
  return {
    id: str(raw.id ?? raw.partitionId ?? raw.partition_id),
    orgId: str(raw.orgId ?? raw.org_id),
    slug: str(raw.slug),
    name: str(raw.name, str(raw.slug, '未命名分区')),
    description: str(raw.description),
    status,
    settings: adaptSettings(raw.settings),
    stats: raw.stats ? adaptStats(raw.stats) : undefined,
    createdAt: str(raw.createdAt ?? raw.created_at),
    updatedAt: str(raw.updatedAt ?? raw.updated_at),
    archivedAt: optStr(raw.archivedAt ?? raw.archived_at),
  };
}

function adaptPersonType(value: unknown): PersonType {
  return value === 'agent' || value === 'service' || value === 'other' ? value : 'human';
}

function adaptPersonStatus(value: unknown): PersonStatus {
  return value === 'archived' || value === 'deleted' ? value : 'active';
}

export function adaptPerson(value: unknown): Person {
  const raw = asRecord(value);
  const stats = asRecord(raw.stats);
  return {
    id: str(raw.id),
    partitionId: str(raw.partitionId ?? raw.partition_id ?? raw.projectId),
    externalId: str(raw.externalId ?? raw.external_id),
    type: adaptPersonType(raw.type),
    displayName: str(raw.displayName ?? raw.display_name),
    attributes: parseJsonRecord(raw.attributes),
    status: adaptPersonStatus(raw.status),
    memoryCount: num(raw.memoryCount ?? raw.memory_count ?? stats.memories),
    sharedMemoryCount: num(raw.sharedMemoryCount ?? raw.shared_memory_count ?? stats.sharedMemories),
    sessionCount: num(raw.sessionCount ?? raw.session_count ?? stats.sessions),
    lastMemoryAt: optStr(raw.lastMemoryAt ?? raw.last_memory_at ?? stats.lastMemoryAt),
    firstSeenAt: optStr(raw.firstSeenAt ?? raw.first_seen_at),
    lastSeenAt: optStr(raw.lastSeenAt ?? raw.last_seen_at),
    createdAt: optStr(raw.createdAt ?? raw.created_at),
    updatedAt: optStr(raw.updatedAt ?? raw.updated_at),
  };
}

function adaptScope(value: unknown, visibility?: unknown): MemoryScope {
  if (value === 'person' || value === 'partition' || value === 'session') return value;
  if (visibility === 'agent') return 'person';
  if (visibility === 'task') return 'session';
  return 'partition';
}

function adaptMemoryCategory(value: unknown): MemoryCategory {
  const text = str(value, 'fact');
  return text as MemoryCategory;
}

export function adaptMemory(value: unknown): Memory {
  const raw = asRecord(value);
  return {
    id: str(raw.id),
    partitionId: str(raw.partitionId ?? raw.partition_id ?? raw.projectId ?? raw.project_id),
    personId: str(raw.personId ?? raw.person_id),
    personExternalId: optStr(raw.personExternalId ?? raw.person_external_id),
    actorPersonId: optStr(raw.actorPersonId ?? raw.actor_person_id),
    scope: adaptScope(raw.scope, raw.visibility),
    sessionId: optStr(raw.sessionId ?? raw.session_id),
    category: adaptMemoryCategory(raw.category),
    content: str(raw.content),
    importance: num(raw.importance, 0.5),
    confidence: num(raw.confidence, 0.8),
    source: (str(raw.source, 'api') as Memory['source']),
    status: (raw.status === 'archived' || raw.status === 'deleted' ? raw.status : 'active') as MemoryStatus,
    tags: pickStringArray(raw.tags),
    metadata: parseJsonRecord(raw.metadata),
    createdAt: str(raw.createdAt ?? raw.created_at),
    updatedAt: str(raw.updatedAt ?? raw.updated_at),
    expiresAt: optStr(raw.expiresAt ?? raw.expires_at),
    dreamedAt: optStr(raw.dreamedAt ?? raw.dreamed_at),
    validFrom: optStr(raw.validFrom ?? raw.valid_from),
    validTo: optStr(raw.validTo ?? raw.valid_to),
    supersededBy: optStr(raw.supersededBy ?? raw.superseded_by),
    supersedes: optStr(raw.supersedes),
    factKey: optStr(raw.factKey ?? raw.fact_key),
    feedbackUp: num(raw.feedbackUp ?? raw.feedback_up),
    feedbackDown: num(raw.feedbackDown ?? raw.feedback_down),
    attachmentCount: num(raw.attachmentCount ?? raw.attachment_count) || undefined,
  };
}

function adaptSignals(value: unknown): MemorySearchSignals {
  const raw = asRecord(value);
  return {
    vector: num(raw.vector),
    keyword: num(raw.keyword),
    recency: num(raw.recency),
    importance: num(raw.importance),
    entity: num(raw.entity),
  };
}

/** 检索命中：兼容 camelCase / snake_case 与 v1 的 `results` 形状。 */
function adaptSearchHit(value: unknown): MemorySearchHit {
  const raw = asRecord(value);
  return {
    ...adaptMemory(raw),
    score: num(raw.score ?? raw.finalScore ?? raw.final_score),
    // 后端可能把信号平铺在命中对象上（v1 兼容），也可能包在 signals 里。
    signals: adaptSignals(raw.signals ?? raw.signalScores ?? raw.signal_scores ?? raw),
    matchedOn: (() => {
      const value = raw.matchedOn ?? raw.matched_on ?? raw.signalsMatched;
      if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
      }
      return pickStringArray(value);
    })(),
  };
}

function adaptSearchResponse(value: unknown): MemorySearchResponse {
  const raw = asRecord(value);
  const list = Array.isArray(raw.hits)
    ? raw.hits
    : Array.isArray(raw.results)
      ? raw.results
      : Array.isArray(raw.items)
        ? raw.items
        : [];
  const modeRaw = raw.mode;
  const mode: MemorySearchMode =
    modeRaw === 'keyword' || modeRaw === 'vector' ? modeRaw : 'hybrid';
  return {
    hits: list.map(adaptSearchHit),
    tookMs: num(raw.tookMs ?? raw.took_ms),
    mode,
    strategy: str(raw.strategy),
  };
}

const MEMORY_HISTORY_EVENTS: MemoryHistoryEvent[] = [
  'ADD',
  'UPDATE',
  'MERGE',
  'SUPERSEDE',
  'DELETE',
  'NOOP',
  'FEEDBACK',
  'RESTORE',
];

function adaptHistoryEntry(value: unknown): MemoryHistoryEntry {
  const raw = asRecord(value);
  const eventRaw = str(raw.event).toUpperCase();
  const event = (MEMORY_HISTORY_EVENTS as string[]).includes(eventRaw)
    ? (eventRaw as MemoryHistoryEvent)
    : 'UPDATE';
  return {
    id: str(raw.id),
    partitionId: optStr(raw.partitionId ?? raw.partition_id),
    memoryId: str(raw.memoryId ?? raw.memory_id),
    personId: optStr(raw.personId ?? raw.person_id),
    event,
    oldContent: optStr(raw.oldContent ?? raw.old_content),
    newContent: optStr(raw.newContent ?? raw.new_content),
    actor: optStr(raw.actor),
    reason: optStr(raw.reason),
    meta: parseJsonRecord(raw.meta),
    createdAt: str(raw.createdAt ?? raw.created_at),
  };
}

function adaptPage<T>(value: unknown, adaptItem: (item: unknown) => T): CursorPage<T> {
  const raw = asRecord(value);
  const source = Array.isArray(raw.items)
    ? raw.items
    : Array.isArray(raw.results)
      ? raw.results
      : Array.isArray(raw.data)
        ? raw.data
        : [];
  const statsRaw = raw.partitionStats ?? raw.partition_stats;
  return {
    items: source.map(adaptItem),
    nextCursor: optStr(raw.nextCursor ?? raw.next_cursor) ?? null,
    partitionStats: statsRaw ? adaptStats(statsRaw) : undefined,
    page: typeof raw.page === 'number' ? raw.page : undefined,
    totalPages: num(raw.totalPages ?? raw.total_pages, 0) || undefined,
  };
}

function adaptBrief(value: unknown): MemoryBrief {
  const raw = asRecord(value);
  const recent = Array.isArray(raw.recent) ? raw.recent : Array.isArray(raw.items) ? raw.items : [];
  return {
    partitionId: optStr(raw.partitionId ?? raw.partition_id),
    personId: optStr(raw.personId ?? raw.person_id),
    text: str(raw.text),
    maxChars: num(raw.maxChars ?? raw.max_chars, 500),
    count: num(raw.count),
    model: str(raw.model, 'mnemos'),
    cached: bool(raw.cached),
    generatedAt: optStr(raw.generatedAt ?? raw.generated_at),
    recent: recent.map((item) => {
      const row = asRecord(item);
      return {
        id: str(row.id),
        content: str(row.content),
        category: adaptMemoryCategory(row.category),
        importance: num(row.importance, 0.5),
        updatedAt: optStr(row.updatedAt ?? row.updated_at),
        personId: optStr(row.personId ?? row.person_id),
        personExternalId: optStr(row.personExternalId ?? row.person_external_id),
        scope: row.scope === 'person' || row.scope === 'partition' || row.scope === 'session' ? row.scope : undefined,
      };
    }),
  };
}

function adaptContext(value: unknown): PersonContext {
  const raw = asRecord(value);
  return {
    brief: raw.brief ? adaptBrief(raw.brief) : undefined,
    memories: Array.isArray(raw.memories) ? raw.memories.map(adaptMemory) : [],
    shared: Array.isArray(raw.shared) ? raw.shared.map(adaptMemory) : [],
    prompt: str(raw.prompt),
    tokenEstimate: num(raw.tokenEstimate ?? raw.token_estimate),
    citations: pickStringArray(raw.citations),
    builtAt: optStr(raw.builtAt ?? raw.built_at),
  };
}

function adaptDreamRun(value: unknown): DreamRun {
  const raw = asRecord(value);
  const status = raw.status === 'running' || raw.status === 'completed' || raw.status === 'skipped' || raw.status === 'failed'
    ? raw.status
    : 'completed';
  return {
    id: str(raw.id),
    partitionId: optStr(raw.partitionId ?? raw.partition_id),
    personId: optStr(raw.personId ?? raw.person_id),
    trigger: raw.trigger === 'schedule' ? 'schedule' : 'manual',
    status,
    inputCount: num(raw.inputCount ?? raw.input_count),
    insightCount: num(raw.insightCount ?? raw.insight_count),
    summary: optStr(raw.summary),
    error: optStr(raw.error),
    startedAt: str(raw.startedAt ?? raw.started_at),
    finishedAt: optStr(raw.finishedAt ?? raw.finished_at),
  };
}

function adaptDreamStatus(value: unknown): DreamStatus {
  const raw = asRecord(value);
  const settings = asRecord(raw.settings);
  const list = Array.isArray(raw.runs) ? raw.runs : [];
  return {
    settings: {
      enabled: bool(settings.enabled, true),
      intervalMinutes: num(settings.intervalMinutes ?? settings.interval_minutes, 1440),
      lastAt: optStr(settings.lastAt ?? settings.last_at),
    },
    personId: optStr(raw.personId ?? raw.person_id),
    pendingCount: num(raw.pendingCount ?? raw.pending_count),
    lastRun: raw.lastRun ? adaptDreamRun(raw.lastRun) : raw.last_run ? adaptDreamRun(raw.last_run) : undefined,
    runs: list.map(adaptDreamRun),
  };
}

function adaptKey(value: unknown): ApiKey {
  const raw = asRecord(value);
  const rawKind = str(raw.kind, 'partition');
  return {
    id: str(raw.id),
    partitionId: optStr(raw.partitionId ?? raw.partition_id),
    orgId: optStr(raw.orgId ?? raw.org_id),
    kind: rawKind === 'org' ? 'org' : 'partition',
    name: str(raw.name),
    prefix: str(raw.prefix),
    scopes: pickStringArray(raw.scopes),
    createdBy: optStr(raw.createdBy ?? raw.created_by),
    createdAt: str(raw.createdAt ?? raw.created_at),
    lastUsedAt: optStr(raw.lastUsedAt ?? raw.last_used_at),
    revokedAt: optStr(raw.revokedAt ?? raw.revoked_at),
    expiresAt: optStr(raw.expiresAt ?? raw.expires_at),
    allowedIps: pickStringArray(raw.allowedIps ?? raw.allowed_ips),
    rateLimitPerMin: num(raw.rateLimitPerMin ?? raw.rate_limit_per_min, 600),
    rotatedFrom: optStr(raw.rotatedFrom ?? raw.rotated_from),
    rotatedAt: optStr(raw.rotatedAt ?? raw.rotated_at),
  };
}

function adaptKeyWithSecret(value: unknown): ApiKeyWithSecret {
  const raw = asRecord(value);
  return { ...adaptKey(value), secret: str(raw.secret) };
}

function adaptAudit(value: unknown): AuditLog {
  const raw = asRecord(value);
  return {
    id: str(raw.id),
    orgId: optStr(raw.orgId ?? raw.org_id),
    partitionId: optStr(raw.partitionId ?? raw.partition_id ?? raw.projectId),
    actorType: raw.actorType === 'api_key' || raw.actorType === 'system' ? raw.actorType : 'user',
    actorId: optStr(raw.actorId ?? raw.actor_id),
    actorLabel: str(raw.actorLabel ?? raw.actor_label),
    action: str(raw.action),
    resourceType: str(raw.resourceType ?? raw.resource_type),
    resourceId: optStr(raw.resourceId ?? raw.resource_id),
    detail: parseJsonRecord(raw.detail),
    ip: optStr(raw.ip),
    userAgent: optStr(raw.userAgent ?? raw.user_agent),
    createdAt: str(raw.createdAt ?? raw.created_at),
  };
}

function adaptUsage(value: unknown): UsageAnalytics {
  const raw = asRecord(value);
  const totals = asRecord(raw.totals);
  const mapPoints = Array.isArray(raw.points) ? raw.points : [];
  const mapBreakdown = (input: unknown) =>
    (Array.isArray(input) ? input : []).map((item) => {
      const row = asRecord(item);
      return { label: str(row.label), count: num(row.count), share: num(row.share) };
    });
  const latency = asRecord(raw.latency);
  return {
    points: mapPoints.map((item) => {
      const row = asRecord(item);
      return {
        date: str(row.date),
        adds: num(row.adds),
        searches: num(row.searches),
        retrievals: num(row.retrievals),
        tokens: num(row.tokens),
        errors: num(row.errors),
      };
    }),
    byOperation: mapBreakdown(raw.byOperation ?? raw.by_operation),
    byChannel: mapBreakdown(raw.byChannel ?? raw.by_channel),
    byKey: mapBreakdown(raw.byKey ?? raw.by_key),
    latency: { p50: num(latency.p50), p95: num(latency.p95), p99: num(latency.p99) },
    totals: {
      adds: num(totals.adds),
      searches: num(totals.searches),
      retrievals: num(totals.retrievals),
      tokens: num(totals.tokens),
      errors: num(totals.errors),
      errorRate: num(totals.errorRate ?? totals.error_rate),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 入参类型                                                            */
/* ------------------------------------------------------------------ */

export interface PersonListParams {
  q?: string;
  type?: PersonType | '';
  status?: PersonStatus | '';
  sort?: 'recent' | 'new' | 'name';
  cursor?: string | null;
  limit?: number;
}

export interface MemoryListParams {
  q?: string;
  personId?: string;
  scope?: MemoryScope | '';
  category?: MemoryCategory | '';
  cursor?: string | null;
  limit?: number;
}

/** v6.1 混合检索入参（控制台已是 camelCase；请求体同时带 snake_case 兼容 v1 契约）。 */
export interface MemorySearchParams {
  query: string;
  personId?: string;
  personExternalId?: string;
  scope?: MemoryScope | '';
  category?: MemoryCategory | '';
  mode?: MemorySearchMode;
  topK?: number;
  asOf?: string;
  includeSuperseded?: boolean;
  includePrivate?: boolean;
}

export interface BriefParams {
  force?: boolean;
  maxChars?: number;
}

export interface BuildContextParams {
  query?: string;
  budgetTokens?: number;
  includePartition?: boolean;
}

export interface AuditListParams {
  cursor?: string | null;
  limit?: number;
  action?: string;
}

export interface MemoryCreateInput {
  text: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  tags?: string[];
  sessionId?: string;
  infer?: boolean;
  /* --- v6.1 写管线 --- */
  /** 显式取代某条记忆（旧记忆 valid_to=now / superseded_by=新记忆） */
  supersedesId?: string;
  /** 事实槽位键（如 preference.language） */
  factKey?: string;
  /** 事实生效时间（ISO） */
  validFrom?: string;
  /** 幂等键：相同 key + body 24h 内返回首次响应 */
  idempotencyKey?: string;
}

export interface KeyCreateInput {
  name: string;
  scopes: string[];
  rateLimitPerMin?: number;
  expiresAt?: string;
  allowedIps?: string[];
}

export interface OrgKeyCreateInput extends KeyCreateInput {
  partitionId?: string;
}

export interface OrgUserCreateInput {
  email: string;
  name: string;
  role: Role;
  title?: string;
}

export interface PartitionUpdateInput {
  name?: string;
  description?: string;
  status?: Partition['status'];
  settings?: Record<string, unknown>;
}

const partitionPath = (partitionId: string): string => `/api/partitions/${encodeURIComponent(partitionId)}`;

const personPath = (partitionId: string, personRef: string): string =>
  `${partitionPath(partitionId)}/persons/${encodeURIComponent(personRef)}`;

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<AuthResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
    me: async (): Promise<{ user: User; org: Org; partitions: Partition[] }> => {
      const payload = await request<{
        user: User;
        org: Org;
        partitions?: unknown[];
        /** v5 兼容字段（后端切换期间可能仍返回 projects） */
        projects?: unknown[];
      }>('/api/auth/me');
      let partitions: Partition[];
      if (Array.isArray(payload.partitions)) {
        partitions = payload.partitions.map(adaptPartition);
      } else if (Array.isArray(payload.projects)) {
        partitions = payload.projects.map(adaptPartition);
      } else {
        try {
          partitions = await api.partitions.list();
        } catch {
          partitions = [];
        }
      }
      return { user: payload.user, org: payload.org, partitions };
    },
    demoAccounts: () => request<DemoAccount[]>('/api/auth/demo-accounts'),
    /** 企业微信 Mock 配置（仅开发/演示环境；未启用时 404） */
    wecomMock: () => request<WecomMockConfig>('/api/auth/wecom/mock'),
    /** 企业微信 Mock 一键登录（仅开发/演示环境） */
    wecomMockLogin: () =>
      request<AuthResponse>('/api/auth/wecom/mock/login', { method: 'POST' }),
  },

  authPassword: {
    change: (input: { currentPassword: string; newPassword: string }) =>
      request<{ ok: boolean }>('/api/auth/password', { method: 'PATCH', body: JSON.stringify(input) }),
  },

  health: async (): Promise<HealthInfo> => {
    const raw = await request<Record<string, unknown>>('/api/health');
    return { ok: raw.ok !== false, version: str(raw.version, '6'), uptimeMs: num(raw.uptimeMs ?? raw.uptime_ms) };
  },

  partitions: {
    list: async (): Promise<Partition[]> => {
      const raw = await request<unknown>('/api/partitions');
      const list = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw).items) ? (asRecord(raw).items as unknown[]) : [];
      return list.map(adaptPartition);
    },
    get: async (partitionId: string): Promise<Partition> =>
      adaptPartition(await request<unknown>(partitionPath(partitionId))),
    create: async (input: { name: string; slug?: string; description?: string }): Promise<Partition> =>
      adaptPartition(
        await request<unknown>('/api/partitions', { method: 'POST', body: JSON.stringify(input) }),
      ),
    update: async (partitionId: string, input: PartitionUpdateInput): Promise<Partition> =>
      adaptPartition(
        await request<unknown>(partitionPath(partitionId), { method: 'PATCH', body: JSON.stringify(input) }),
      ),
    stats: async (partitionId: string): Promise<PartitionStats> =>
      adaptStats(await request<unknown>(`${partitionPath(partitionId)}/stats`)),
    usage: async (partitionId: string, days = 30): Promise<UsageAnalytics> =>
      adaptUsage(await request<unknown>(`${partitionPath(partitionId)}/usage${qs({ days })}`)),
    audit: async (partitionId: string, params: AuditListParams = {}): Promise<CursorPage<AuditLog>> =>
      adaptPage(
        await request<unknown>(`${partitionPath(partitionId)}/audit${qs({ ...params })}`),
        adaptAudit,
      ),
    keys: {
      list: async (partitionId: string): Promise<ApiKey[]> => {
        const raw = await request<unknown>(`${partitionPath(partitionId)}/keys`);
        const list = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw).items) ? (asRecord(raw).items as unknown[]) : [];
        return list.map(adaptKey);
      },
      create: async (partitionId: string, input: KeyCreateInput): Promise<ApiKeyWithSecret> =>
        adaptKeyWithSecret(
          await request<unknown>(`${partitionPath(partitionId)}/keys`, {
            method: 'POST',
            body: JSON.stringify(input),
          }),
        ),
      rotate: async (partitionId: string, keyId: string, graceHours = 0): Promise<ApiKeyWithSecret> =>
        adaptKeyWithSecret(
          await request<unknown>(`${partitionPath(partitionId)}/keys/${encodeURIComponent(keyId)}/rotate`, {
            method: 'POST',
            body: JSON.stringify({ graceHours }),
          }),
        ),
      revoke: (partitionId: string, keyId: string) =>
        request<{ ok: boolean }>(`${partitionPath(partitionId)}/keys/${encodeURIComponent(keyId)}`, {
          method: 'DELETE',
        }),
    },
  },

  persons: {
    /** 人列表：服务端游标分页 + FTS 前缀搜索；响应自带分区头部统计。 */
    list: async (partitionId: string, params: PersonListParams = {}): Promise<CursorPage<Person>> =>
      adaptPage(
        await request<unknown>(`${partitionPath(partitionId)}/persons${qs({ ...params })}`),
        adaptPerson,
      ),
    get: async (partitionId: string, personRef: string): Promise<Person> =>
      adaptPerson(await request<unknown>(personPath(partitionId, personRef))),
    upsert: async (partitionId: string, input: PersonInput): Promise<Person> =>
      adaptPerson(
        await request<unknown>(
          `${partitionPath(partitionId)}/persons/${encodeURIComponent(input.externalId)}`,
          { method: 'PUT', body: JSON.stringify(input) },
        ),
      ),
    update: async (partitionId: string, personRef: string, input: Partial<PersonInput>): Promise<Person> =>
      adaptPerson(
        await request<unknown>(personPath(partitionId, personRef), {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      ),
    /** 该人的记忆：游标分页 + scope/category 过滤。 */
    memories: async (
      partitionId: string,
      personRef: string,
      params: Omit<MemoryListParams, 'personId'> = {},
    ): Promise<CursorPage<Memory>> =>
      adaptPage(
        await request<unknown>(`${personPath(partitionId, personRef)}/memories${qs({ ...params })}`),
        adaptMemory,
      ),
    createMemory: async (
      partitionId: string,
      personRef: string,
      input: MemoryCreateInput,
    ): Promise<Memory> => {
      const headers: Record<string, string> = {};
      if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
      const raw = await request<unknown>(`${personPath(partitionId, personRef)}/memories`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: input.text,
          scope: input.scope,
          category: input.category,
          tags: input.tags,
          sessionId: input.sessionId,
          infer: input.infer,
          // v6.1：显式取代 / 事实槽位 / 生效时间（camelCase 控制台 + snake_case v1 兼容）
          supersedesId: input.supersedesId,
          supersedes_id: input.supersedesId,
          factKey: input.factKey,
          fact_key: input.factKey,
          validFrom: input.validFrom,
          valid_from: input.validFrom,
        }),
      });
      // 控制台写入返回 { memory }；适配裸 Memory 与包裹两种形状。
      return adaptMemory(asRecord(raw).memory ?? raw);
    },
    brief: async (partitionId: string, personRef: string, params: BriefParams = {}): Promise<MemoryBrief> =>
      adaptBrief(
        await request<unknown>(`${personPath(partitionId, personRef)}/brief${qs({ ...params })}`),
      ),
    context: async (
      partitionId: string,
      personRef: string,
      input: BuildContextParams = {},
    ): Promise<PersonContext> =>
      adaptContext(
        await request<unknown>(`${personPath(partitionId, personRef)}/context`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      ),
    dream: async (partitionId: string, personRef: string): Promise<DreamStatus> =>
      adaptDreamStatus(await request<unknown>(`${personPath(partitionId, personRef)}/dream`)),
    runDream: async (partitionId: string, personRef: string): Promise<DreamResult> => {
      const raw = await request<unknown>(`${personPath(partitionId, personRef)}/dream/run`, {
        method: 'POST',
        body: '{}',
      });
      const record = asRecord(raw);
      return {
        run: record.run ? adaptDreamRun(record.run) : null,
        status: adaptDreamStatus(record.status ?? record),
      };
    },
  },

  memories: {
    /** 分区记忆全局列表：游标分页 + person/scope/category 过滤 + FTS。 */
    list: async (partitionId: string, params: MemoryListParams = {}): Promise<CursorPage<Memory>> =>
      adaptPage(
        await request<unknown>(`${partitionPath(partitionId)}/memories${qs({ ...params })}`),
        adaptMemory,
      ),
    /**
     * v6.1 混合检索：POST /api/partitions/:p/memories/search。
     * 返回 hits（score + signals + matchedOn）、tookMs、mode、strategy；
     * 无游标分页（服务端候选集上限 + top_k），普通浏览仍走 list。
     */
    search: async (partitionId: string, params: MemorySearchParams): Promise<MemorySearchResponse> => {
      const { query, ...rest } = params;
      const raw = await request<unknown>(`${partitionPath(partitionId)}/memories/search`, {
        method: 'POST',
        body: JSON.stringify({
          query,
          // camelCase（控制台契约）与 snake_case（v1 / roadmap 契约）同时携带，兼容并行实现。
          personId: rest.personId,
          person_id: rest.personId,
          personExternalId: rest.personExternalId,
          person_external_id: rest.personExternalId,
          scope: rest.scope || undefined,
          category: rest.category || undefined,
          mode: rest.mode,
          topK: rest.topK,
          top_k: rest.topK,
          asOf: rest.asOf,
          as_of: rest.asOf,
          includeSuperseded: rest.includeSuperseded,
          include_superseded: rest.includeSuperseded,
          includePrivate: rest.includePrivate,
          include_private: rest.includePrivate,
        }),
      });
      return adaptSearchResponse(raw);
    },
    /** 单条记忆的变更历史（ADD/UPDATE/MERGE/SUPERSEDE/FEEDBACK…）。 */
    history: async (partitionId: string, memoryId: string): Promise<MemoryHistoryEntry[]> => {
      const raw = await request<unknown>(
        `${partitionPath(partitionId)}/memories/${encodeURIComponent(memoryId)}/history`,
      );
      const record = asRecord(raw);
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray(record.items)
          ? record.items
          : Array.isArray(record.history)
            ? record.history
            : Array.isArray(record.entries)
              ? record.entries
              : [];
      return list.map(adaptHistoryEntry);
    },
    /** 检索反馈：有帮助/没帮助，服务端会按比例微调 confidence/重要度。 */
    feedback: async (
      partitionId: string,
      memoryId: string,
      input: MemoryFeedbackInput,
    ): Promise<Memory | null> => {
      const raw = await request<unknown>(
        `${partitionPath(partitionId)}/memories/${encodeURIComponent(memoryId)}/feedback`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      const record = asRecord(raw);
      const memory = asRecord(record.memory ?? raw);
      // 部分实现只回 { ok: true }：此时由调用方刷新详情。
      return memory.id ? adaptMemory(memory) : null;
    },
    get: async (partitionId: string, memoryId: string): Promise<Memory> => {
      const raw = await request<unknown>(`${partitionPath(partitionId)}/memories/${encodeURIComponent(memoryId)}`);
      // MemoryDetail = { memory, person }
      return adaptMemory(asRecord(raw).memory ?? raw);
    },
    update: async (
      partitionId: string,
      memoryId: string,
      input: { content?: string; category?: string; importance?: number; status?: string; tags?: string[] },
    ): Promise<Memory> =>
      adaptMemory(
        await request<unknown>(`${partitionPath(partitionId)}/memories/${encodeURIComponent(memoryId)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      ),
    remove: (partitionId: string, memoryId: string) =>
      request<{ ok: boolean }>(`${partitionPath(partitionId)}/memories/${encodeURIComponent(memoryId)}`, {
        method: 'DELETE',
      }),
  },

  org: {
    get: async (): Promise<Org> => {
      const raw = await request<unknown>('/api/org');
      return (asRecord(raw).org ?? raw) as Org;
    },
    users: {
      list: async (): Promise<OrgUser[]> => {
        const raw = await request<unknown>('/api/org/users');
        return Array.isArray(raw) ? (raw as OrgUser[]) : ((asRecord(raw).items as OrgUser[]) ?? []);
      },
      create: (input: OrgUserCreateInput) =>
        request<{ user: OrgUser; temporaryPassword: string }>('/api/org/users', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      update: (userId: string, input: Partial<OrgUserCreateInput> & { status?: string }) =>
        request<OrgUser>(`/api/org/users/${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      resetPassword: (userId: string) =>
        request<{ temporaryPassword: string }>(`/api/org/users/${encodeURIComponent(userId)}/reset-password`, {
          method: 'POST',
        }),
    },
    keys: {
      list: async (): Promise<ApiKey[]> => {
        const raw = await request<unknown>('/api/org/keys');
        const list = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw).items) ? (asRecord(raw).items as unknown[]) : [];
        return list.map(adaptKey);
      },
      create: async (input: OrgKeyCreateInput): Promise<ApiKeyWithSecret> =>
        adaptKeyWithSecret(
          await request<unknown>('/api/org/keys', { method: 'POST', body: JSON.stringify(input) }),
        ),
      revoke: (keyId: string) =>
        request<{ ok: boolean }>(`/api/org/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' }),
    },
  },
};
