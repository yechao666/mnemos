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
  EntityGraph,
  EntityGraphEdge,
  EntityGraphNode,
  EntityGraphTypeCount,
  EntitySummary,
  HealthInfo,
  Memory,
  MemoryAttachment,
  MemoryAttachmentInput,
  MemoryBrief,
  MemoryCategory,
  MemoryDetail,
  MemoryFeedbackInput,
  MemoryHistoryEntry,
  MemoryHistoryEvent,
  MemoryPlaceholder,
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
  PersonExport,
  PersonFact,
  PersonFactInput,
  PersonInput,
  PersonMergeResult,
  PersonProfile,
  PersonStatus,
  PersonType,
  PrivacyAction,
  PrivacyMaskMode,
  PrivacyRule,
  PrivacyRuleInput,
  PrivacyRuleKind,
  PrivacyRuleScope,
  PrivacyScanHit,
  PrivacyScanResult,
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
  return Boolean(
    error &&
      (error.includes('404') ||
        error.includes('不存在') ||
        error.includes('未找到') ||
        error.includes('NOT_FOUND')),
  );
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
    // v6.1 P2：默认不脱敏，保证旧分区行为不变。
    piiRedaction: raw.piiRedaction === 'basic' || raw.pii_redaction === 'basic' ? 'basic' : 'off',
    // v6.2：prompt 规则默认关闭，需显式开启并配置 LLM。
    privacyLlmEnabled: bool(raw.privacyLlmEnabled ?? raw.privacy_llm_enabled),
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
    mergedInto: optStr(raw.mergedInto ?? raw.merged_into),
    consent: Object.keys(parseJsonRecord(raw.consent)).length ? parseJsonRecord(raw.consent) : undefined,
    deletedAt: optStr(raw.deletedAt ?? raw.deleted_at),
  };
}

/* ------------------------------------------------------------------ */
/* v6.1 P1：画像 / facts / 生命周期 归一化                              */
/* ------------------------------------------------------------------ */

function adaptFact(value: unknown): PersonFact {
  const raw = asRecord(value);
  return {
    id: str(raw.id),
    partitionId: str(raw.partitionId ?? raw.partition_id),
    personId: str(raw.personId ?? raw.person_id),
    key: str(raw.key ?? raw.factKey ?? raw.fact_key),
    value: str(raw.value),
    confidence: num(raw.confidence, 0.7),
    validFrom: str(raw.validFrom ?? raw.valid_from ?? raw.createdAt ?? raw.created_at),
    validTo: optStr(raw.validTo ?? raw.valid_to),
    sourceMemoryId: optStr(raw.sourceMemoryId ?? raw.source_memory_id),
    createdAt: str(raw.createdAt ?? raw.created_at),
    updatedAt: str(raw.updatedAt ?? raw.updated_at),
  };
}

/** facts 可能是裸数组、{items} 或 {facts}。 */
function adaptFactList(value: unknown): PersonFact[] {
  const list = Array.isArray(value)
    ? value
    : Array.isArray(asRecord(value).items)
      ? (asRecord(value).items as unknown[])
      : Array.isArray(asRecord(value).facts)
        ? (asRecord(value).facts as unknown[])
        : [];
  return list.map(adaptFact);
}

export function adaptPersonProfile(value: unknown): PersonProfile {
  const outer = asRecord(value);
  const raw = asRecord(outer.profile ?? outer);
  const factsSource = raw.facts ?? raw.items ?? outer.facts;
  return {
    person: adaptPerson(raw.person ?? outer.person ?? {}),
    facts: adaptFactList(factsSource),
    summary: str(raw.summary ?? outer.summary),
    generatedAt: optStr(
      raw.generatedAt ?? raw.generated_at ?? outer.generatedAt ?? outer.generated_at,
    ),
    cached: bool(raw.cached ?? outer.cached),
  };
}

function adaptMergeResult(value: unknown): PersonMergeResult {
  const outer = asRecord(value);
  const raw = asRecord(outer.result ?? outer);
  return {
    person: adaptPerson(raw.person ?? raw.target ?? raw.canonical ?? {}),
    mergedFrom: adaptPerson(raw.mergedFrom ?? raw.merged_from ?? raw.source ?? {}),
    movedMemories: num(raw.movedMemories ?? raw.moved_memories),
    movedFacts: num(raw.movedFacts ?? raw.moved_facts),
  };
}

function adaptPersonExport(value: unknown): PersonExport {
  const outer = asRecord(value);
  const raw = asRecord(outer.export ?? outer);
  const memories = Array.isArray(raw.memories)
    ? raw.memories
    : Array.isArray(asRecord(raw.memories).items)
      ? (asRecord(raw.memories).items as unknown[])
      : [];
  return {
    person: adaptPerson(raw.person ?? raw),
    facts: adaptFactList(raw.facts),
    memories: memories.map(adaptMemory),
    exportedAt: str(raw.exportedAt ?? raw.exported_at),
    truncated: bool(raw.truncated) || undefined,
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

function adaptAttachment(value: unknown): MemoryAttachment {
  const raw = asRecord(value);
  const kindRaw = str(raw.kind, 'file');
  const kind: MemoryAttachment['kind'] =
    kindRaw === 'image' || kindRaw === 'audio' || kindRaw === 'video' ? kindRaw : 'file';
  return {
    id: str(raw.id),
    memoryId: str(raw.memoryId ?? raw.memory_id),
    kind,
    url: str(raw.url),
    mime: optStr(raw.mime),
    size: typeof raw.size === 'number' ? raw.size : undefined,
    caption: optStr(raw.caption),
    createdAt: str(raw.createdAt ?? raw.created_at),
  };
}

function adaptAttachments(value: unknown): MemoryAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(adaptAttachment);
}

export function adaptMemory(value: unknown): Memory {
  const raw = asRecord(value);
  const attachments = adaptAttachments(raw.attachments);
  const metadata = parseJsonRecord(raw.metadata);
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
    attachmentCount: num(raw.attachmentCount ?? raw.attachment_count) || attachments?.length || undefined,
    attachments,
    // v6.2：占位符数量（列表/搜索只返回计数，不返回明文）。
    placeholderCount:
      num(
        raw.placeholderCount ??
          raw.placeholder_count ??
          metadata.placeholderCount ??
          metadata.placeholder_count,
      ) || undefined,
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

/* ------------------------------------------------------------------ */
/* v6.1 P2：实体 / 关系图归一化                                        */
/* ------------------------------------------------------------------ */

function adaptGraphNode(value: unknown): EntityGraphNode {
  const raw = asRecord(value);
  return {
    id: str(raw.id),
    label: str(raw.label ?? raw.name),
    type: str(raw.type, 'concept'),
    weight: num(raw.weight ?? raw.mentionCount ?? raw.mention_count),
    memories: num(raw.memories ?? raw.memoryCount ?? raw.memory_count),
  };
}

function adaptGraphEdge(value: unknown): EntityGraphEdge {
  const raw = asRecord(value);
  return {
    id: str(raw.id),
    source: str(raw.source ?? raw.sourceEntityId ?? raw.source_entity_id),
    target: str(raw.target ?? raw.targetEntityId ?? raw.target_entity_id),
    relation: str(raw.relation, 'co_occurs'),
    weight: num(raw.weight, 1),
  };
}

function adaptGraphTypeCount(value: unknown): EntityGraphTypeCount {
  const raw = asRecord(value);
  return { type: str(raw.type, 'concept'), count: num(raw.count) };
}

export function adaptEntityGraph(value: unknown): EntityGraph {
  const raw = asRecord(value);
  const stats = asRecord(raw.stats);
  const topTypesRaw = stats.topTypes ?? stats.top_types;
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map(adaptGraphNode);
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).map(adaptGraphEdge);
  return {
    nodes,
    edges,
    stats: {
      nodes: num(stats.nodes, nodes.length),
      edges: num(stats.edges, edges.length),
      topTypes: (Array.isArray(topTypesRaw) ? topTypesRaw : []).map(adaptGraphTypeCount),
    },
  };
}

export function adaptEntitySummary(value: unknown): EntitySummary {
  const raw = asRecord(value);
  return {
    id: str(raw.id),
    name: str(raw.name ?? raw.label),
    type: str(raw.type, 'concept'),
    mentionCount: num(raw.mentionCount ?? raw.mention_count),
    memories: num(raw.memories),
    createdAt: optStr(raw.createdAt ?? raw.created_at),
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
/* v6.2：隐私规则 / 预览 / 占位符 归一化                                */
/* ------------------------------------------------------------------ */

function adaptPrivacyKind(value: unknown): PrivacyRuleKind {
  return value === 'prompt' ? 'prompt' : 'regex';
}

function adaptPrivacyAction(value: unknown): PrivacyAction {
  return value === 'placeholder' ? 'placeholder' : 'mask';
}

function adaptMaskMode(value: unknown): PrivacyMaskMode {
  const text = str(value, 'email');
  if (text === 'keepFirstLast' || text === 'keep_first_last') return 'keepFirstLast';
  if (text === 'keepLast' || text === 'keep_last') return 'keepLast';
  if (text === 'full') return 'full';
  return 'email';
}

function adaptPrivacyRule(value: unknown): PrivacyRule {
  const raw = asRecord(value);
  const code = str(raw.code);
  return {
    id: str(raw.id ?? raw.ruleId ?? raw.rule_id, code),
    scope: raw.scope === 'global' ? 'global' : 'partition',
    partitionId: optStr(raw.partitionId ?? raw.partition_id),
    code,
    name: str(raw.name, code),
    kind: adaptPrivacyKind(raw.kind),
    pattern: optStr(raw.pattern),
    flags: str(raw.flags, 'g'),
    instruction: optStr(raw.instruction),
    entityType: str(raw.entityType ?? raw.entity_type, code || 'pii'),
    action: adaptPrivacyAction(raw.action),
    maskMode: adaptMaskMode(raw.maskMode ?? raw.mask_mode),
    maskKeepLast: num(raw.maskKeepLast ?? raw.mask_keep_last, 4),
    maskKeepFirst: num(raw.maskKeepFirst ?? raw.mask_keep_first, 0),
    enabled: raw.enabled !== false,
    priority: num(raw.priority, 100),
    builtin: bool(raw.builtin),
    createdAt: str(raw.createdAt ?? raw.created_at),
    updatedAt: str(raw.updatedAt ?? raw.updated_at),
  };
}

/** 规则列表兼容裸数组、{items} 与 {rules}。 */
function adaptPrivacyRuleList(value: unknown): PrivacyRule[] {
  const outer = asRecord(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(outer.items)
      ? outer.items
      : Array.isArray(outer.rules)
        ? outer.rules
        : Array.isArray(outer.data)
          ? outer.data
          : [];
  return list.map(adaptPrivacyRule);
}

function adaptScanHit(value: unknown): PrivacyScanHit {
  const raw = asRecord(value);
  return {
    code: str(raw.code, 'pii'),
    entityType: str(raw.entityType ?? raw.entity_type, str(raw.code, 'pii')),
    value: str(raw.value),
    start: num(raw.start),
    end: num(raw.end),
    action: adaptPrivacyAction(raw.action),
  };
}

/** 预览结果：兼容 {result} / {preview} 包裹与 placeholders 的数组/对象两种形状。 */
function adaptScanResult(value: unknown): PrivacyScanResult {
  const outer = asRecord(value);
  const raw = asRecord(outer.result ?? outer.preview ?? outer);
  const hits = (Array.isArray(raw.hits) ? raw.hits : []).map(adaptScanHit);
  const placeholders: Record<string, string> = {};
  const placeholdersRaw = raw.placeholders;
  if (Array.isArray(placeholdersRaw)) {
    for (const item of placeholdersRaw) {
      const row = asRecord(item);
      const key = str(row.placeholder ?? row.key ?? row.token);
      if (key) placeholders[key] = str(row.value);
    }
  } else {
    for (const [key, entry] of Object.entries(asRecord(placeholdersRaw))) {
      if (typeof entry === 'string') placeholders[key] = entry;
    }
  }
  return {
    text: str(raw.text ?? raw.redactedText ?? raw.redacted_text ?? outer.text),
    redacted: bool(raw.redacted ?? raw.changed, hits.length > 0),
    hits,
    placeholders,
  };
}

function adaptPlaceholder(value: unknown): MemoryPlaceholder {
  const raw = asRecord(value);
  const encryptedRaw = raw.encrypted;
  const encrypted =
    encryptedRaw === false || encryptedRaw === 0 || encryptedRaw === '0' || encryptedRaw === 'false'
      ? false
      : true;
  return {
    placeholder: str(raw.placeholder ?? raw.key ?? raw.token),
    kind: optStr(raw.kind ?? raw.type ?? raw.entityType ?? raw.entity_type),
    encrypted,
    value: optStr(raw.value),
  };
}

function adaptPlaceholders(value: unknown): MemoryPlaceholder[] {
  if (Array.isArray(value)) return value.map(adaptPlaceholder);
  const record = asRecord(value);
  if (Array.isArray(record.items)) return record.items.map(adaptPlaceholder);
  // 兼容 { token: value } 形式的映射表
  return Object.entries(record)
    .filter(([, entry]) => typeof entry === 'string')
    .map(([placeholder, entry]) => ({ placeholder, encrypted: true, value: String(entry) }));
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
  /** v6.1：包含已合并到其他人的人（默认由服务端排除） */
  includeMerged?: boolean;
}

export interface PersonUpdateInput {
  displayName?: string;
  attributes?: Record<string, unknown>;
  status?: PersonStatus;
  /** v6.1 P2：合规/同意标记（整体覆盖） */
  consent?: Record<string, unknown>;
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
  /* --- v6.1 P2 多模态 --- */
  /** 附件（≤10）：URL 由调用方托管，caption 参与检索。 */
  attachments?: MemoryAttachmentInput[];
  /* --- v6.2 隐私占位符 --- */
  /** 占位符映射：正文用 {{key}}，敏感真实值放这里（服务端加密存储）。 */
  placeholders?: Record<string, string>;
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

/** 隐私规则写请求体：camelCase（控制台契约）+ 关键字段 snake_case 兼容并行实现。 */
function privacyRuleBody(input: PrivacyRuleInput): Record<string, unknown> {
  return {
    code: input.code,
    name: input.name,
    kind: input.kind,
    pattern: input.pattern,
    flags: input.flags,
    instruction: input.instruction,
    entityType: input.entityType,
    entity_type: input.entityType,
    action: input.action,
    maskMode: input.maskMode,
    mask_mode: input.maskMode,
    maskKeepLast: input.maskKeepLast,
    mask_keep_last: input.maskKeepLast,
    maskKeepFirst: input.maskKeepFirst,
    mask_keep_first: input.maskKeepFirst,
    enabled: input.enabled,
    priority: input.priority,
  };
}

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
    /* --- v6.1 P2：实体关系图 --- */
    /** 分区（或某人视角）的实体关系图：节点 / 边 / 统计（topTypes）。 */
    graph: async (
      partitionId: string,
      params: { personId?: string; limit?: number } = {},
    ): Promise<EntityGraph> =>
      adaptEntityGraph(
        await request<unknown>(
          `${partitionPath(partitionId)}/graph${qs({
            personId: params.personId,
            person_id: params.personId,
            limit: params.limit,
          })}`,
        ),
      ),
    /** 实体列表（按关联记忆数排序；q 做名称前缀/包含匹配）。 */
    entities: async (
      partitionId: string,
      params: { personId?: string; q?: string; limit?: number } = {},
    ): Promise<CursorPage<EntitySummary>> =>
      adaptPage(
        await request<unknown>(
          `${partitionPath(partitionId)}/entities${qs({
            personId: params.personId,
            person_id: params.personId,
            q: params.q,
            limit: params.limit,
          })}`,
        ),
        adaptEntitySummary,
      ),
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
    list: async (partitionId: string, params: PersonListParams = {}): Promise<CursorPage<Person>> => {
      const { includeMerged, ...rest } = params;
      // 控制台 camelCase 与 v1 snake_case 同时携带，兼容并行实现。
      const query = qs({
        ...rest,
        includeMerged: includeMerged || undefined,
        include_merged: includeMerged || undefined,
      });
      return adaptPage(await request<unknown>(`${partitionPath(partitionId)}/persons${query}`), adaptPerson);
    },
    get: async (partitionId: string, personRef: string): Promise<Person> =>
      adaptPerson(await request<unknown>(personPath(partitionId, personRef))),
    upsert: async (partitionId: string, input: PersonInput): Promise<Person> =>
      adaptPerson(
        await request<unknown>(
          `${partitionPath(partitionId)}/persons/${encodeURIComponent(input.externalId)}`,
          { method: 'PUT', body: JSON.stringify(input) },
        ),
      ),
    update: async (partitionId: string, personRef: string, input: PersonUpdateInput): Promise<Person> =>
      adaptPerson(
        await request<unknown>(personPath(partitionId, personRef), {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      ),
    /**
     * v6.1 P1：人画像（当前 facts + 摘要 + generatedAt）。
     * `force` 用于请求服务端重新生成摘要（不被支持时只是忽略该参数，仍返回缓存）。
     */
    profile: async (
      partitionId: string,
      personRef: string,
      params: { force?: boolean } = {},
    ): Promise<PersonProfile> =>
      adaptPersonProfile(
        await request<unknown>(
          `${personPath(partitionId, personRef)}/profile${qs({
            force: params.force || undefined,
            // 服务端兼容别名 refresh；不带 force 时命中缓存（sourceHash 未变则 generatedAt 不变）。
            refresh: params.force || undefined,
          })}`,
        ),
      ),
    /** 当前有效的 facts（画像卡也可直接用 profile.facts）。 */
    facts: {
      list: async (partitionId: string, personRef: string): Promise<PersonFact[]> =>
        adaptFactList(await request<unknown>(`${personPath(partitionId, personRef)}/facts`)),
      /** 显式维护事实槽位：同 person+key 的新 fact 会关闭旧 fact 的 validTo。 */
      upsert: async (
        partitionId: string,
        personRef: string,
        input: PersonFactInput,
      ): Promise<PersonFact> => {
        const raw = await request<unknown>(`${personPath(partitionId, personRef)}/facts`, {
          method: 'PUT',
          body: JSON.stringify({
            key: input.key,
            value: input.value,
            confidence: input.confidence,
            sourceMemoryId: input.sourceMemoryId,
            source_memory_id: input.sourceMemoryId,
          }),
        });
        const record = asRecord(raw);
        return adaptFact(record.fact ?? raw);
      },
      remove: (partitionId: string, personRef: string, factId: string) =>
        request<{ ok: boolean }>(
          `${personPath(partitionId, personRef)}/facts/${encodeURIComponent(factId)}`,
          { method: 'DELETE' },
        ),
    },
    /** 合并到另一人：迁移 memories/facts/feedback，源人标记 mergedInto 并归档。 */
    merge: async (
      partitionId: string,
      personRef: string,
      targetRef: string,
    ): Promise<PersonMergeResult> =>
      adaptMergeResult(
        await request<unknown>(`${personPath(partitionId, personRef)}/merge`, {
          method: 'POST',
          // targetId 为内部 id 或 externalId；camelCase / snake_case 同时携带，服务端取其一。
          body: JSON.stringify({
            targetId: targetRef,
            target_id: targetRef,
            targetExternalId: targetRef,
            target_external_id: targetRef,
          }),
        }),
      ),
    archive: async (partitionId: string, personRef: string): Promise<Person> =>
      adaptPerson(
        await request<unknown>(`${personPath(partitionId, personRef)}/archive`, {
          method: 'POST',
          body: '{}',
        }),
      ),
    /** 导出人的资料 + facts + 全部记忆（JSON；服务端可能截断并置 truncated）。 */
    export: async (partitionId: string, personRef: string): Promise<PersonExport> =>
      adaptPersonExport(
        await request<unknown>(`${personPath(partitionId, personRef)}/export`),
      ),
    /**
     * 删除人：默认软删（status=deleted + deletedAt）；`hard=true` 仅 owner 且级联记忆。
     */
    remove: (partitionId: string, personRef: string, params: { hard?: boolean } = {}) =>
      request<{ ok: boolean }>(
        `${personPath(partitionId, personRef)}${qs({ hard: params.hard || undefined })}`,
        { method: 'DELETE' },
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
          // v6.1 P2：附件（kind/url/mime/size/caption，≤10）
          attachments: input.attachments,
          // v6.2：隐私占位符映射（正文只存 {{key}}，真实值由服务端加密存储）
          placeholders: input.placeholders,
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
    /**
     * v6.2 记忆详情（MemoryDetail）：默认返回占位符 key/kind/encrypted，
     * `reveal=true` 时按 `?reveal=placeholders` 取解密后的真实值（需 memories:read）。
     */
    detail: async (
      partitionId: string,
      memoryId: string,
      params: { reveal?: boolean } = {},
    ): Promise<MemoryDetail> => {
      const raw = await request<unknown>(
        `${partitionPath(partitionId)}/memories/${encodeURIComponent(memoryId)}${qs({
          reveal: params.reveal ? 'placeholders' : undefined,
        })}`,
      );
      const record = asRecord(raw);
      const memoryRaw = asRecord(record.memory ?? raw);
      const holdersRaw = record.placeholders ?? memoryRaw.placeholders;
      return {
        memory: adaptMemory(memoryRaw),
        person: record.person ? adaptPerson(record.person) : null,
        placeholders: holdersRaw === undefined ? undefined : adaptPlaceholders(holdersRaw),
      };
    },
    /** 占位符映射：默认只返回 key/kind/encrypted；reveal=true 才带解密值。 */
    placeholders: async (
      partitionId: string,
      memoryId: string,
      reveal = false,
    ): Promise<MemoryPlaceholder[]> => {
      const detail = await api.memories.detail(partitionId, memoryId, { reveal });
      return detail.placeholders ?? [];
    },
    update: async (
      partitionId: string,
      memoryId: string,
      input: {
        content?: string;
        category?: string;
        importance?: number;
        status?: string;
        tags?: string[];
        placeholders?: Record<string, string>;
      },
    ): Promise<Memory> =>
      adaptMemory(
        await request<unknown>(`${partitionPath(partitionId)}/memories/${encodeURIComponent(memoryId)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...input,
            // v6.2：替换占位符映射（整体覆盖；正文未使用的键由服务端忽略）
            placeholders: input.placeholders,
          }),
        }),
      ),
    remove: (partitionId: string, memoryId: string) =>
      request<{ ok: boolean }>(`${partitionPath(partitionId)}/memories/${encodeURIComponent(memoryId)}`, {
        method: 'DELETE',
      }),
  },

  /* --- v6.2：隐私规则域 --- */
  privacy: {
    /** 规则列表：scope=global 读组织全局规则；scope=partition 读指定分区（需 partitionId）。 */
    listRules: async (params: { scope: PrivacyRuleScope; partitionId?: string }): Promise<PrivacyRule[]> => {
      const raw = await request<unknown>(
        `/api/privacy/rules${qs({
          scope: params.scope,
          partition_id: params.partitionId,
          partitionId: params.partitionId,
        })}`,
      );
      return adaptPrivacyRuleList(raw);
    },
    /** 新建规则：global 需 owner，partition 需 admin+（权限由服务端校验）。 */
    createRule: async (
      input: PrivacyRuleInput & { scope: PrivacyRuleScope; partitionId?: string },
    ): Promise<PrivacyRule> => {
      const { scope, partitionId, ...rule } = input;
      const raw = await request<unknown>('/api/privacy/rules', {
        method: 'POST',
        body: JSON.stringify({
          ...privacyRuleBody(rule),
          scope,
          partitionId,
          partition_id: partitionId,
        }),
      });
      return adaptPrivacyRule(asRecord(raw).rule ?? raw);
    },
    /** 更新规则（含启停）：PATCH /api/privacy/rules/:id。 */
    updateRule: async (id: string, input: Partial<PrivacyRuleInput>): Promise<PrivacyRule> => {
      const raw = await request<unknown>(`/api/privacy/rules/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(privacyRuleBody(input as PrivacyRuleInput)),
      });
      return adaptPrivacyRule(asRecord(raw).rule ?? raw);
    },
    removeRule: (id: string) =>
      request<{ ok: boolean }>(`/api/privacy/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /** 试跑：不落库，返回命中、替换后文本与占位符映射。 */
    preview: async (input: { partitionId?: string; text: string }): Promise<PrivacyScanResult> => {
      const raw = await request<unknown>('/api/privacy/preview', {
        method: 'POST',
        body: JSON.stringify({
          partitionId: input.partitionId,
          partition_id: input.partitionId,
          text: input.text,
        }),
      });
      return adaptScanResult(raw);
    },
    /** 重扫分区记忆（规则变更后使用；admin+）。 */
    rescan: (partitionId: string, params: { personId?: string; limit?: number } = {}) =>
      request<Record<string, unknown>>(`${partitionPath(partitionId)}/privacy/rescan`, {
        method: 'POST',
        body: JSON.stringify({
          personId: params.personId,
          person_id: params.personId,
          limit: params.limit,
        }),
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
