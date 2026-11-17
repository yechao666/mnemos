/**
 * v6 控制台本地类型契约（信息架构：组织 → 分区 → 人 → 记忆）。
 *
 * v6 后端与 shared/src/types.ts 在并行重建，控制台在此先按 docs/v6-architecture.md
 * 第 3、4 节定义客户端类型；后端上线后如字段有差异，只需要同步本文件与 api.ts 的归一化层。
 */

/* ------------------------------------------------------------------ */
/* 组织与控制台账号（仅用于登录 / 权限）                                */
/* ------------------------------------------------------------------ */

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  createdAt?: string;
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  avatarColor?: string;
  createdAt?: string;
  lastSeenAt?: string;
  lastLoginAt?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
  org: Org;
}

export interface OrgUser {
  id: string;
  orgId?: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt?: string;
  lastSeenAt?: string;
}

export interface WecomMockConfig {
  enabled: boolean;
  provider: { slug: 'wecom'; name: string };
  appid: string;
  agentid: string;
  account: { email: string; name: string };
  hint: string;
}

export interface DemoAccount {
  email: string;
  name: string;
  role: Role;
  password: string;
  title?: string;
}

/* ------------------------------------------------------------------ */
/* 分区                                                                */
/* ------------------------------------------------------------------ */

export type PartitionStatus = 'active' | 'paused' | 'archived';

/** 分区统计（partition_stats，O(1) 读取；列表头部一律读它，不做 COUNT(*)）。 */
export interface PartitionStats {
  partitionId?: string;
  personsTotal: number;
  personsHuman: number;
  personsAgent: number;
  personsService: number;
  memoriesTotal: number;
  sharedTotal: number;
  sessionsTotal: number;
  updatedAt?: string;
}

export type MemorySearchMode = 'hybrid' | 'keyword' | 'vector';

/** 融合检索的 5 个信号。 */
export interface RetrievalWeights {
  vector: number;
  keyword: number;
  recency: number;
  importance: number;
  entity: number;
}

export type RetrievalSignal = keyof RetrievalWeights;

export interface PartitionSettings {
  defaultScope?: MemoryScope;
  personAutoCreate?: boolean;
  briefMaxChars?: number;
  briefEnabled?: boolean;
  dreamEnabled?: boolean;
  dreamIntervalMinutes?: number;
  monthlyQuota?: number;
  /* --- v6.1 检索与写管线 --- */
  /** 检索模式：混合 / 仅关键词 / 仅向量 */
  retrievalMode?: MemorySearchMode;
  /** 融合权重；缺省按服务端默认值（0.45/0.3/0.15/0.1/0） */
  retrievalWeights?: Partial<RetrievalWeights>;
  /** 本地 embedding 模型或外部模型名 */
  embeddingModel?: string;
  /** 相似度 >= 该值视为重复，走合并/去重 */
  mergeThreshold?: number;
  /** 高相似度去重阈值（>= 视为完全重复） */
  dedupeThreshold?: number;
  /** 写入后异步抽取实体 */
  autoExtractEntities?: boolean;
  [key: string]: unknown;
}

export interface Partition {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string;
  status: PartitionStatus;
  settings: PartitionSettings;
  stats?: PartitionStats;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface PartitionInput {
  name: string;
  slug?: string;
  description?: string;
}

/* ------------------------------------------------------------------ */
/* 人                                                                  */
/* ------------------------------------------------------------------ */

export type PersonType = 'human' | 'agent' | 'service' | 'other';
export type PersonStatus = 'active' | 'archived' | 'deleted';

export interface Person {
  id: string;
  partitionId: string;
  externalId: string;
  type: PersonType;
  displayName: string;
  attributes: Record<string, unknown>;
  status: PersonStatus;
  /** 反规范化计数（persons 行内，列表不逐行请求 stats） */
  memoryCount: number;
  sharedMemoryCount: number;
  sessionCount: number;
  lastMemoryAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PersonInput {
  externalId: string;
  type?: PersonType;
  displayName?: string;
  attributes?: Record<string, unknown>;
  status?: PersonStatus;
}

/* ------------------------------------------------------------------ */
/* 记忆                                                                */
/* ------------------------------------------------------------------ */

export type MemoryScope = 'person' | 'partition' | 'session';
export type MemoryStatus = 'active' | 'archived' | 'deleted';
export type MemorySource = 'conversation' | 'api' | 'agent' | 'import' | 'playground' | 'dream';
export type MemoryCategory =
  | 'preference'
  | 'identity'
  | 'fact'
  | 'plan'
  | 'relationship'
  | 'event'
  | 'skill'
  | 'constraint'
  | 'context'
  | 'insight'
  | 'decision'
  | 'progress'
  | 'lesson'
  | 'risk'
  | 'change'
  | 'acceptance'
  | 'assumption'
  | 'dependency';

export interface Memory {
  id: string;
  partitionId: string;
  personId: string;
  /** 人的外部 ID，便于直接比对（后端可能不返回） */
  personExternalId?: string;
  actorPersonId?: string;
  scope: MemoryScope;
  sessionId?: string;
  category: MemoryCategory;
  content: string;
  importance: number;
  confidence: number;
  source: MemorySource;
  status: MemoryStatus;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  dreamedAt?: string;
  /* --- v6.1 时序与演化 --- */
  /** 事实生效时间（缺省 = createdAt） */
  validFrom?: string;
  /** 失效时间；为空表示当前有效 */
  validTo?: string;
  /** 被哪条记忆取代 */
  supersededBy?: string;
  /** 取代了哪条记忆 */
  supersedes?: string;
  /** 槽位键（如 preference.language） */
  factKey?: string;
  feedbackUp?: number;
  feedbackDown?: number;
  attachmentCount?: number;
}

/* ------------------------------------------------------------------ */
/* v6.1：检索 / 历史 / 反馈                                            */
/* ------------------------------------------------------------------ */

export interface MemorySearchSignals {
  vector: number;
  keyword: number;
  recency: number;
  importance: number;
  entity: number;
}

/** 检索命中：综合得分 + 信号分解 + 命中来源（vector/keyword/recency…）。 */
export interface MemorySearchHit extends Memory {
  score: number;
  signals: MemorySearchSignals;
  matchedOn: string[];
}

export interface MemorySearchResponse {
  hits: MemorySearchHit[];
  tookMs: number;
  mode: MemorySearchMode;
  strategy: string;
}

export type MemoryHistoryEvent =
  | 'ADD'
  | 'UPDATE'
  | 'MERGE'
  | 'SUPERSEDE'
  | 'DELETE'
  | 'NOOP'
  | 'FEEDBACK'
  | 'RESTORE';

/** 单条记忆的变更历史（控制台抽屉时间线）。 */
export interface MemoryHistoryEntry {
  id: string;
  partitionId?: string;
  memoryId: string;
  personId?: string;
  event: MemoryHistoryEvent;
  oldContent?: string;
  newContent?: string;
  actor?: string;
  reason?: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryFeedbackInput {
  helpful: boolean;
  query?: string;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* 简报 / 上下文 / 做梦                                                */
/* ------------------------------------------------------------------ */

export interface MemoryBriefItem {
  id: string;
  content: string;
  category: MemoryCategory;
  importance?: number;
  updatedAt?: string;
  personId?: string;
  personExternalId?: string;
  scope?: MemoryScope;
}

export interface MemoryBrief {
  partitionId?: string;
  personId?: string;
  text: string;
  maxChars: number;
  count: number;
  model: string;
  cached: boolean;
  generatedAt?: string;
  recent: MemoryBriefItem[];
}

export interface PersonContext {
  brief?: MemoryBrief;
  memories: Memory[];
  shared: Memory[];
  prompt: string;
  tokenEstimate: number;
  citations: string[];
  builtAt?: string;
}

export type DreamRunStatus = 'running' | 'completed' | 'skipped' | 'failed';
export type DreamTrigger = 'schedule' | 'manual';

export interface DreamRun {
  id: string;
  partitionId?: string;
  personId?: string;
  trigger: DreamTrigger;
  status: DreamRunStatus;
  inputCount: number;
  insightCount: number;
  summary?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface DreamSettings {
  enabled: boolean;
  intervalMinutes: number;
  lastAt?: string;
}

export interface DreamStatus {
  settings: DreamSettings;
  personId?: string;
  pendingCount: number;
  lastRun?: DreamRun;
  runs: DreamRun[];
}

export interface DreamResult {
  run: DreamRun | null;
  status: DreamStatus;
}

/* ------------------------------------------------------------------ */
/* 分页（游标协议）                                                    */
/* ------------------------------------------------------------------ */

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  partitionStats?: PartitionStats;
  /** 部分端点（审计）可能返回分页信息，用于兼容 */
  page?: number;
  totalPages?: number;
}

/* ------------------------------------------------------------------ */
/* 密钥 / 审计 / 用量                                                  */
/* ------------------------------------------------------------------ */

export type ApiScope = 'memories:read' | 'memories:write' | 'admin';
export type ApiKeyKind = 'partition' | 'org';

export interface ApiKey {
  id: string;
  partitionId?: string;
  orgId?: string;
  kind: ApiKeyKind;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  allowedIps: string[];
  rateLimitPerMin: number;
  rotatedFrom?: string;
  rotatedAt?: string;
}

export interface ApiKeyWithSecret extends ApiKey {
  secret: string;
}

export type ActorType = 'user' | 'api_key' | 'system';

export interface AuditLog {
  id: string;
  orgId?: string;
  partitionId?: string;
  actorType: ActorType;
  actorId?: string;
  actorLabel: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  detail: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  createdAt: string;
}

export interface UsagePoint {
  date: string;
  adds: number;
  searches: number;
  retrievals: number;
  tokens: number;
  errors: number;
}

export interface UsageBreakdownRow {
  label: string;
  count: number;
  share: number;
}

export interface UsageAnalytics {
  points: UsagePoint[];
  byOperation: UsageBreakdownRow[];
  byChannel: UsageBreakdownRow[];
  byKey: UsageBreakdownRow[];
  latency: { p50: number; p95: number; p99: number };
  totals: {
    adds: number;
    searches: number;
    retrievals: number;
    tokens: number;
    errors: number;
    errorRate: number;
  };
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  uptimeMs?: number;
}
