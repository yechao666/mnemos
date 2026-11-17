/**
 * Mnemos v6 共享领域契约 —— 服务端与控制台共用的唯一事实来源。
 *
 * 核心只有三个：Partition（分区）+ Person（人）+ Memory（记忆）。
 * 控制台 /api 一律 camelCase；公开 v1 API 为 snake_case（由 http 层序列化）。
 * 列表协议统一为游标分页 CursorPage（不返回 total、不做 COUNT(*)）。
 */

/* ------------------------------------------------------------------ */
/* 基础枚举                                                            */
/* ------------------------------------------------------------------ */

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';
export type ApiScope = 'memories:read' | 'memories:write' | 'admin';
export type ActorType = 'user' | 'api_key' | 'system';

export type PartitionStatus = 'active' | 'paused' | 'archived';

export type PersonType = 'human' | 'agent' | 'service' | 'other';
export type PersonStatus = 'active' | 'archived' | 'deleted';
/** 人列表排序：recent=最近活跃，new=最近新建，name=显示名。 */
export type PersonSort = 'recent' | 'new' | 'name';

/** 记忆可见范围：person=仅本人；partition=分区共享；session=仅当前会话。 */
export type MemoryScope = 'person' | 'partition' | 'session';
export type MemoryStatus = 'active' | 'archived' | 'deleted';
export type MemorySource = 'api' | 'conversation' | 'agent' | 'import' | 'playground' | 'dream';

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

export type ApiKeyKind = 'partition' | 'org';

export interface Actor {
  type: ActorType;
  id: string;
  label: string;
  ip?: string;
  userAgent?: string;
}

/* ------------------------------------------------------------------ */
/* 组织 / 控制台账号                                                   */
/* ------------------------------------------------------------------ */

export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  createdAt: string;
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  title?: string;
  avatarColor: string;
  status: 'active' | 'disabled';
  createdAt: string;
  lastSeenAt?: string;
  lastLoginAt?: string;
  passwordChangedAt?: string;
}

export interface OrgUser extends User {
  activeSessions: number;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: Role;
  title?: string;
  password?: string;
}

export interface UpdateUserInput {
  role?: Role;
  status?: 'active' | 'disabled';
  title?: string;
  name?: string;
}

export interface ResetPasswordResult {
  userId: string;
  temporaryPassword: string;
}

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
}

export interface AuthResponse {
  token: string;
  user: User;
  org: Org;
}

/* ------------------------------------------------------------------ */
/* 分区（Partition）                                                   */
/* ------------------------------------------------------------------ */

export interface PartitionSettings {
  /** 新记忆缺省可见范围（消费类 App 用 person，协作分区用 partition） */
  defaultScope: MemoryScope;
  /** 人级/分区级简报字符上限（100–5000） */
  briefMaxChars: number;
  briefEnabled: boolean;
  dreamEnabled: boolean;
  /** 做梦周期（分钟，1–43200） */
  dreamIntervalMinutes: number;
  /** 记忆保留天数（0=不限） */
  retentionDays: number;
  /** 月度写入 token 配额（0=不限） */
  monthlyQuota: number;
  /** 写入未知人时是否自动建档 */
  personAutoCreate: boolean;
  locale: string;
}

/** 分区：App / 项目 / 租户。取代 v5 的 projects，表名 partitions。 */
export interface Partition {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string;
  status: PartitionStatus;
  settings: PartitionSettings;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** 列表/详情附带的分区统计（来自 partition_stats，O(1)） */
  stats?: PartitionStats;
}

/** 分区头部聚合：列表页直接读这张表，绝不 COUNT(*)。 */
export interface PartitionStats {
  partitionId: string;
  personsTotal: number;
  personsHuman: number;
  personsAgent: number;
  personsService: number;
  memoriesTotal: number;
  sharedTotal: number;
  sessionsTotal: number;
  updatedAt: string;
}

export interface PartitionInput {
  slug: string;
  name?: string;
  description?: string;
  status?: PartitionStatus;
  settings?: Partial<PartitionSettings>;
}

/* ------------------------------------------------------------------ */
/* 人（Person）                                                        */
/* ------------------------------------------------------------------ */

/**
 * 记忆的主体「人」：真人（App 用户 / 员工）或智能体。
 * 与登录账号（User）无关；externalId 由调用方定义（App 的 user_id、Agent 的 id/name）。
 * memoryCount / sharedMemoryCount / sessionCount 为反规范化计数，列表页直接用。
 */
export interface Person {
  id: string;
  partitionId: string;
  externalId: string;
  type: PersonType;
  displayName: string;
  attributes: Record<string, unknown>;
  status: PersonStatus;
  memoryCount: number;
  sharedMemoryCount: number;
  sessionCount: number;
  lastMemoryAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonInput {
  externalId: string;
  type?: PersonType;
  displayName?: string;
  attributes?: Record<string, unknown>;
  status?: PersonStatus;
}

export interface PersonListQuery {
  type?: PersonType;
  status?: PersonStatus;
  q?: string;
  sort?: PersonSort;
  cursor?: string;
  limit?: number;
}

/* ------------------------------------------------------------------ */
/* 会话（可选分组）                                                     */
/* ------------------------------------------------------------------ */

export interface Session {
  id: string;
  partitionId: string;
  personId: string;
  title: string;
  status: 'active' | 'ended';
  startedAt: string;
  endedAt?: string;
  metadata: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 记忆                                                                */
/* ------------------------------------------------------------------ */

export interface Memory {
  id: string;
  partitionId: string;
  /** 记忆主体（归属人，内部 id）——NOT NULL */
  personId: string;
  /** 写入者（可与人不同） */
  actorPersonId?: string;
  /** 人的外部 ID（App user_id / Agent id），便于调用方直接比对 */
  personExternalId?: string;
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
}

export interface MemoryDetail {
  memory: Memory;
  person: Person | null;
}

/** 写入记忆：person 必填（内部 id 或 external id + type）。 */
export interface AddMemoryInput {
  partitionId: string;
  /** 内部 id */
  personId?: string;
  /** 外部 id（与 personId 二选一；缺省按 type 解析/建档） */
  personExternalId?: string;
  personType?: PersonType;
  actorPersonId?: string;
  scope?: MemoryScope;
  sessionId?: string;
  sessionTitle?: string;
  category?: MemoryCategory;
  content: string;
  importance?: number;
  confidence?: number;
  source?: MemorySource;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
  actor: Actor;
}

export interface MemoryListQuery {
  partitionId: string;
  personId?: string;
  personExternalId?: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  status?: MemoryStatus;
  /** FTS5 前缀检索；空则按索引排序 */
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
}

/* ------------------------------------------------------------------ */
/* 游标分页                                                            */
/* ------------------------------------------------------------------ */

/** 统一列表协议：不返回 total；头部统计读 partition_stats。 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  partitionStats?: PartitionStats;
}

/* ------------------------------------------------------------------ */
/* 记忆简报（brief）/ 上下文（context）/ 做梦（dream）                  */
/* ------------------------------------------------------------------ */

export interface MemoryBriefItem {
  id: string;
  content: string;
  category: MemoryCategory;
  importance: number;
  scope: MemoryScope;
  updatedAt: string;
  personId: string;
  personExternalId?: string;
}

/** 记忆简报：取最近的活跃记忆压缩成有字符上限、可直接注入提示词的文本。 */
export interface MemoryBrief {
  partitionId: string;
  /** 人级简报时带上该人（内部 id） */
  personId?: string;
  scopeKey: string;
  text: string;
  maxChars: number;
  count: number;
  /** mnemos-condense（确定性压缩）或实际 LLM 模型名 */
  model: string;
  /** 是否命中缓存 */
  cached: boolean;
  sourceHash: string;
  generatedAt: string;
  recent: MemoryBriefItem[];
}

export interface BriefInput {
  partitionId: string;
  personId?: string;
  maxChars?: number;
  force?: boolean;
  /** 是否允许调用 LLM 润色（默认 false） */
  allowLlm?: boolean;
}

/** 人的上下文：资料 + 人的简报 + 相关记忆 + 分区共享知识，可直接注入提示词。 */
export interface PersonContext {
  person: Person;
  brief: MemoryBrief;
  memories: Memory[];
  shared: Memory[];
  prompt: string;
  tokenEstimate: number;
  citations: string[];
  builtAt: string;
}

export interface ContextInput {
  partitionId: string;
  personId: string;
  query?: string;
  budgetTokens?: number;
  includePartition?: boolean;
}

export type MemoryDreamRunStatus = 'running' | 'completed' | 'skipped' | 'failed';
export type MemoryDreamTrigger = 'manual' | 'schedule';

/** 一次做梦（增量记忆巩固）的运行记录。 */
export interface MemoryDreamRun {
  id: string;
  partitionId: string;
  /** 人级做梦时的归属人（内部 id）；分区级为空 */
  personId?: string;
  trigger: MemoryDreamTrigger;
  status: MemoryDreamRunStatus;
  inputCount: number;
  insightCount: number;
  summary?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface MemoryDreamSettings {
  enabled: boolean;
  intervalMinutes: number;
  lastAt?: string;
}

export interface MemoryDreamStatus {
  settings: MemoryDreamSettings;
  personId?: string;
  pendingCount: number;
  lastRun?: MemoryDreamRun;
  runs: MemoryDreamRun[];
}

export interface MemoryDreamInput {
  partitionId: string;
  personId?: string;
  trigger?: MemoryDreamTrigger;
  /** 单批最多处理的记忆条数（1–200，默认 50） */
  batchSize?: number;
}

export interface MemoryDreamResult {
  run: MemoryDreamRun | null;
  status: MemoryDreamStatus;
}

/* ------------------------------------------------------------------ */
/* API Key                                                             */
/* ------------------------------------------------------------------ */

export interface ApiKey {
  id: string;
  /** 分区 key 绑定的分区；org key 为空 */
  partitionId?: string;
  /** org key 所属组织 */
  orgId?: string;
  kind: ApiKeyKind;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  allowedIps: string[];
  rotatedFrom?: string;
  rotatedAt?: string;
  rateLimitPerMin: number;
}

export interface ApiKeyWithSecret extends ApiKey {
  secret: string;
}

/* ------------------------------------------------------------------ */
/* 用量 / 审计 / 运维                                                   */
/* ------------------------------------------------------------------ */

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
  latencyP50?: number;
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

export interface BackupInfo {
  id: string;
  file: string;
  sizeBytes: number;
  createdAt: string;
  kind: 'manual' | 'scheduled' | 'preflight';
}

export interface MaintenanceRun {
  id: string;
  kind: string;
  status: 'running' | 'success' | 'failed';
  summary: Record<string, unknown>;
  actor?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface OpsStatus {
  version: string;
  node: string;
  env: string;
  startedAt: string;
  uptimeMs: number;
  database: {
    path: string;
    sizeBytes: number;
    walSizeBytes: number;
    schemaVersion: number;
    journalMode: string;
  };
  counts: {
    orgs: number;
    users: number;
    partitions: number;
    persons: number;
    memories: number;
    apiKeys: number;
    auditEvents: number;
    usageEvents: number;
  };
  quotas: {
    partitionId: string;
    name: string;
    usedTokens: number;
    monthlyQuota: number;
    usedPct: number;
    memories: number;
  }[];
  retention: {
    partitionId: string;
    name: string;
    retentionDays: number;
    expiredMemories: number;
  }[];
  backups: BackupInfo[];
  maintenance: MaintenanceRun[];
  metrics: {
    requestsTotal: number;
    errorsTotal: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    sseClients: number;
    rateLimitedTotal: number;
    authFailuresTotal: number;
  };
}

export interface OpsMaintenanceInput {
  dryRun?: boolean;
  vacuum?: boolean;
}

export interface OpsMaintenanceResult {
  runId: string;
  dryRun: boolean;
  expiredArchived: number;
  deletedPurged: number;
  sessionsPurged: number;
  walCheckpointed: boolean;
  vacuumed: boolean;
  durationMs: number;
}

export interface ReconcileResult {
  partitionId: string;
  personsTotal: number;
  memoriesTotal: number;
  sharedTotal: number;
  sessionsTotal: number;
  updatedPersons: number;
}

/* ------------------------------------------------------------------ */
/* 服务端内部接口                                                      */
/* ------------------------------------------------------------------ */

/**
 * v6 记忆服务（引擎公开面）。
 * 同步方法直接访问 SQLite；brief/context/dream 可能调用 LLM，返回 Promise。
 */
export interface MemoryService {
  /* --- 分区 --- */
  upsertPartition(orgId: string, input: PartitionInput, actor: Actor): Partition;
  listPartitions(orgId: string): Partition[];
  getPartition(orgId: string, ref: string): Partition | null;
  updatePartition(orgId: string, ref: string, input: Partial<PartitionInput>, actor: Actor): Partition;
  partitionStats(partitionId: string): PartitionStats;

  /* --- 人 --- */
  upsertPerson(partitionId: string, input: PersonInput, actor: Actor): Person;
  listPersons(partitionId: string, query: PersonListQuery): CursorPage<Person>;
  getPerson(partitionId: string, ref: string): Person | null;
  updatePerson(partitionId: string, ref: string, input: Partial<PersonInput>, actor: Actor): Person;
  reconcileCounts(partitionId: string): ReconcileResult;

  /* --- 记忆 --- */
  addMemory(input: AddMemoryInput): Memory;
  listMemories(query: MemoryListQuery): CursorPage<Memory>;
  getMemory(partitionId: string, id: string): MemoryDetail | null;
  updateMemory(partitionId: string, id: string, input: UpdateMemoryInput, actor: Actor): Memory;
  removeMemory(partitionId: string, id: string, actor: Actor): void;

  /* --- 简报 / 上下文 / 做梦 --- */
  brief(input: BriefInput): Promise<MemoryBrief>;
  context(input: ContextInput): Promise<PersonContext>;
  dreamStatus(input: { partitionId: string; personId?: string }): MemoryDreamStatus;
  dream(input: MemoryDreamInput, actor: Actor): Promise<MemoryDreamResult>;
}
