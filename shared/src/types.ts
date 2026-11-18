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

/** 开发/演示环境的快捷登录账号（仅 MNEMOS_DEMO=1 时由后端返回）。 */
export interface DemoAccount {
  email: string;
  name: string;
  role: Role;
  password: string;
  title?: string;
}

/** 企业微信 Mock 登录配置（仅开发/演示环境提供）。 */
export interface WecomMockConfig {
  enabled: boolean;
  provider: { slug: 'wecom'; name: string };
  appid: string;
  agentid: string;
  /** 登录使用的演示账号（省去扫码） */
  account: { email: string; name: string };
  hint: string;
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
  /* --- v6.1 检索与写管线 --- */
  /** 检索模式：混合 / 仅关键词 / 仅向量 */
  retrievalMode: 'hybrid' | 'keyword' | 'vector';
  /** 融合权重；未列出的信号按 0 处理 */
  retrievalWeights: RetrievalWeights;
  /** 本地 embedding 模型或外部模型名 */
  embeddingModel: string;
  /** 完全重复判定（内容哈希）后仍合并的相似度阈值 */
  mergeThreshold: number;
  /** 高相似度去重阈值（>= 视为重复，不再新增） */
  dedupeThreshold: number;
  /** 写入后异步抽取实体 */
  autoExtractEntities: boolean;
  /* --- v6.1 P2 合规 --- */
  /** PII 脱敏：off=不处理；basic=写入时按隐私规则扫描（默认 off） */
  piiRedaction: 'off' | 'basic';
  /** v6.2：是否执行提示词（LLM）隐私规则（需配置 LLM；失败静默回退正则） */
  privacyLlmEnabled: boolean;
}

export interface RetrievalWeights {
  vector: number;
  keyword: number;
  recency: number;
  importance: number;
  entity: number;
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
  /** 人合并后指向 canonical person */
  mergedInto?: string;
  /** 合规/同意标记（自由 JSON） */
  consent?: Record<string, unknown>;
  deletedAt?: string;
}

export interface PersonInput {
  externalId: string;
  type?: PersonType;
  displayName?: string;
  attributes?: Record<string, unknown>;
  status?: PersonStatus;
  /** 合规/同意标记（自由 JSON）；PATCH 时整体覆盖 */
  consent?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* v6.1 P1：结构化画像 / 生命周期                                       */
/* ------------------------------------------------------------------ */

export interface PersonFact {
  id: string;
  partitionId: string;
  personId: string;
  key: string;
  value: string;
  confidence: number;
  validFrom: string;
  validTo?: string;
  sourceMemoryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonFactInput {
  key: string;
  value: string;
  confidence?: number;
  sourceMemoryId?: string;
}

export interface PersonProfile {
  person: Person;
  facts: PersonFact[];
  summary: string;
  generatedAt?: string;
  /** v6.1 P1：本次是否直接命中 person_profiles 缓存（未重新生成） */
  cached?: boolean;
}

export interface PersonMergeResult {
  person: Person;
  mergedFrom: Person;
  movedMemories: number;
  movedFacts: number;
}

export interface PersonExport {
  person: Person;
  facts: PersonFact[];
  memories: Memory[];
  exportedAt: string;
  /** 记忆超过上限（10000）时为 true；memories 只含前 10000 条 */
  truncated?: boolean;
}

export interface PersonListQuery {
  type?: PersonType;
  status?: PersonStatus;
  q?: string;
  sort?: PersonSort;
  cursor?: string;
  limit?: number;
  /** 包含已合并（merged_into 非空）的人；默认排除 merged/deleted */
  includeMerged?: boolean;
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

/** 多模态附件类型（P2）：媒体本体由调用方托管，这里只存 URL/元数据/描述。 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

export interface MemoryAttachmentInput {
  kind: AttachmentKind;
  url: string;
  mime?: string;
  size?: number;
  caption?: string;
}

export interface MemoryAttachment extends MemoryAttachmentInput {
  id: string;
  memoryId: string;
  createdAt: string;
}

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
  /** v6.1 时序与演化 */
  validFrom?: string;
  validTo?: string;
  supersededBy?: string;
  supersedes?: string;
  factKey?: string;
  feedbackUp?: number;
  feedbackDown?: number;
  /** 附件数量（列表按页批量统计，避免 N+1） */
  attachmentCount?: number;
  /** 详情（GET 记忆）才返回附件明细；批量列表只带 attachmentCount */
  attachments?: MemoryAttachment[];
  /** v6.2：正文中的 {{token}} 占位符数量（列表/检索只带计数，不带值） */
  placeholderCount?: number;
  /** v6.2：最近一次隐私规则扫描时间（ISO） */
  privacyScannedAt?: string;
}

export interface MemoryDetail {
  memory: Memory;
  person: Person | null;
  /** 默认只返回 key/元信息；reveal=true 时 value 有值 */
  placeholders?: MemoryPlaceholder[];
}

/* ------------------------------------------------------------------ */
/* v6.2：隐私规则域                                                     */
/* ------------------------------------------------------------------ */

export type PrivacyRuleScope = 'global' | 'partition';
export type PrivacyRuleKind = 'regex' | 'prompt';
export type PrivacyAction = 'mask' | 'placeholder';
export type PrivacyMaskMode = 'email' | 'keepFirstLast' | 'keepLast' | 'full';

export interface PrivacyRule {
  id: string;
  scope: PrivacyRuleScope;
  partitionId?: string;
  code: string;
  name: string;
  kind: PrivacyRuleKind;
  pattern?: string;
  flags: string;
  instruction?: string;
  entityType: string;
  action: PrivacyAction;
  maskMode: PrivacyMaskMode;
  maskKeepLast: number;
  maskKeepFirst: number;
  enabled: boolean;
  priority: number;
  builtin: boolean;
  /** 规则库分组（行业/领域） */
  groupKey: string;
  /** 结构/校验位校验器 */
  validator: string;
  /** 上下文关键词：命中值附近需出现其一 */
  contextKeywords: string[];
  caseSensitive: boolean;
  region: string;
  severity: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
}

export interface PrivacyRuleGroup {
  key: string;
  name: string;
  industry: string;
  description: string;
  sortOrder: number;
  builtin: boolean;
  /** 该组全局规则数 */
  ruleCount: number;
  /** 当前分区生效条数（含全局启用 + 分区覆盖） */
  enabledCount: number;
  /** 当前分区的覆盖条数 */
  appliedCount: number;
}

export interface PrivacyRuleInput {
  code?: string;
  name: string;
  kind: PrivacyRuleKind;
  pattern?: string;
  flags?: string;
  instruction?: string;
  entityType?: string;
  action?: PrivacyAction;
  maskMode?: PrivacyMaskMode;
  maskKeepLast?: number;
  maskKeepFirst?: number;
  enabled?: boolean;
  priority?: number;
  groupKey?: string;
  validator?: string;
  contextKeywords?: string[];
  caseSensitive?: boolean;
  region?: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface PrivacyScanHit {
  code: string;
  entityType: string;
  value: string;
  start: number;
  end: number;
  action: PrivacyAction;
}

export interface PrivacyScanResult {
  text: string;
  redacted: boolean;
  hits: PrivacyScanHit[];
  placeholders: Record<string, string>;
}

export interface MemoryPlaceholder {
  placeholder: string;
  kind?: string;
  encrypted: boolean;
  value?: string;
}

/* ------------------------------------------------------------------ */
/* v6.1：检索 / 历史 / 反馈 / 异步任务                                  */
/* ------------------------------------------------------------------ */

export type MemorySearchMode = 'hybrid' | 'keyword' | 'vector';

export interface MemorySearchInput {
  partitionId: string;
  query: string;
  personId?: string;
  personExternalId?: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  /** 默认 hybrid */
  mode?: MemorySearchMode;
  topK?: number;
  /** 回看某个时间点有效的事实（ISO） */
  asOf?: string;
  includeSuperseded?: boolean;
  /** 人级视角（仅本人 + 分区共享）；控制台/审计可设 true 看全部 */
  includePrivate?: boolean;
}

export interface MemorySearchSignals {
  vector: number;
  keyword: number;
  recency: number;
  importance: number;
  entity: number;
}

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

/* ------------------------------------------------------------------ */
/* v6.1 P2：实体 / 关系图                                               */
/* ------------------------------------------------------------------ */

export interface EntityGraphNode {
  id: string;
  label: string;
  type: string;
  /** 实体权重（分区内被提及次数 / 关联记忆累计 salience） */
  weight: number;
  /** 关联记忆数 */
  memories: number;
}

export interface EntityGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface EntityGraphTypeCount {
  type: string;
  count: number;
}

export interface EntityGraphStats {
  nodes: number;
  edges: number;
  topTypes: EntityGraphTypeCount[];
}

export interface EntityGraph {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
  stats: EntityGraphStats;
}

export interface EntityGraphQuery {
  partitionId: string;
  /** 内部 id 或 external_id；缺省为分区级图 */
  personId?: string;
  /** 节点上限（1–500，默认 100） */
  limit?: number;
}

export interface EntitySummary {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
  memories: number;
  createdAt: string;
}

export interface EntityListQuery {
  partitionId: string;
  personId?: string;
  q?: string;
  limit?: number;
}

export interface EntityList {
  items: EntitySummary[];
  nextCursor: string | null;
}

export type MemoryHistoryEvent =
  | 'ADD'
  | 'UPDATE'
  | 'MERGE'
  | 'SUPERSEDE'
  | 'DELETE'
  | 'NOOP'
  | 'FEEDBACK'
  | 'RESTORE'
  | 'PRIVACY';

export interface MemoryHistoryEntry {
  id: string;
  partitionId: string;
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

export type MemoryJobType = 'embed' | 'consolidate' | 'extract' | 'profile' | 'summarize' | 'privacy';
export type MemoryJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface MemoryJob {
  id: string;
  partitionId: string;
  type: MemoryJobType;
  status: MemoryJobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  runAfter: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 写入返回：新增时 memory；重复/合并时 memory=已有或合并后的记忆，event 说明行为。 */
export interface MemoryAddResult {
  memory: Memory;
  event: 'ADD' | 'MERGE' | 'NOOP' | 'SUPERSEDE';
  supersededId?: string;
  /** v6.1 P2：本次写入是否触发 PII 脱敏（审计 memory.pii_redacted 用） */
  piiRedacted?: boolean;
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
  /** v6.1：显式取代某条记忆（同分区同人），旧记忆会被置为失效 */
  supersedesId?: string;
  /** v6.1：槽位键（如 preference.language）；同键旧记忆自动被取代 */
  factKey?: string;
  /** v6.1：事实生效时间（默认 now） */
  validFrom?: string;
  /** v6.1 P2：多模态附件（≤10，url≤2000） */
  attachments?: MemoryAttachmentInput[];
  /** v6.2：占位符映射（正文用 {{key}}，敏感值放这里） */
  placeholders?: Record<string, string>;
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
  /** v6.2：替换占位符映射（整体覆盖；未出现在正文的键忽略） */
  placeholders?: Record<string, string>;
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
  /** v6.2：本批次被隐私规则改写的记忆条数 */
  privacyRedacted?: number;
  /** v6.2：本批次隐私命中（替换处数） */
  privacyHits?: number;
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
  /** v6.1：带写管线事件（ADD/MERGE/NOOP/SUPERSEDE）的写入结果。 */
  addMemoryResult(input: AddMemoryInput): MemoryAddResult;
  listMemories(query: MemoryListQuery): CursorPage<Memory>;
  getMemory(partitionId: string, id: string): MemoryDetail | null;
  updateMemory(partitionId: string, id: string, input: UpdateMemoryInput, actor: Actor): Memory;
  removeMemory(partitionId: string, id: string, actor: Actor): void;
  /* --- v6.1：检索 / 历史 / 反馈 --- */
  searchMemories(input: MemorySearchInput): MemorySearchResponse;
  memoryHistory(partitionId: string, id: string): MemoryHistoryEntry[];
  feedback(partitionId: string, id: string, input: MemoryFeedbackInput, actor: Actor): Memory;
  /* --- v6.1 P2：实体 / 关系图 --- */
  entityGraph(query: EntityGraphQuery): EntityGraph;
  listEntities(query: EntityListQuery): EntityList;

  /* --- v6.2：隐私规则 --- */
  listPrivacyRules(partitionId?: string): PrivacyRule[];
  listPrivacyRuleGroups(partitionId?: string): PrivacyRuleGroup[];
  applyPrivacyGroup(partitionId: string, groupKey: string, enabled: boolean, actor: Actor): PrivacyRule[];
  createPrivacyRule(
    scope: PrivacyRuleScope,
    partitionId: string | null,
    input: PrivacyRuleInput,
    actor: Actor,
    orgId?: string,
  ): PrivacyRule;
  updatePrivacyRule(id: string, input: Partial<PrivacyRuleInput>, actor: Actor, orgId?: string): PrivacyRule;
  deletePrivacyRule(id: string, actor: Actor, orgId?: string): void;
  previewPrivacy(partitionId: string | null, text: string): PrivacyScanResult;
  memoryPlaceholders(partitionId: string, memoryId: string, reveal?: boolean): MemoryPlaceholder[];
  /** v6.2：规则变更后重扫分区记忆（regex + 可选 prompt）；返回统计 */
  rescanPrivacy?(
    partitionId: string,
    options?: { personId?: string; limit?: number },
    actor?: Actor,
  ): Promise<{ scanned: number; changed: number; placeholders: number; hits: number }>;

  /* --- v6.1 P1：画像 / 生命周期 --- */
  personProfile(partitionId: string, personRef: string): PersonProfile;
  /** 按需生成画像（可调用 LLM；HTTP GET /profile 使用；缺省时退化为确定性摘要） */
  refreshPersonProfile?(
    partitionId: string,
    personRef: string,
    options?: { force?: boolean },
  ): Promise<PersonProfile>;
  listPersonFacts(partitionId: string, personRef: string): PersonFact[];
  upsertPersonFact(partitionId: string, personRef: string, input: PersonFactInput, actor: Actor): PersonFact;
  removePersonFact(partitionId: string, personRef: string, factId: string, actor: Actor): void;
  mergePersons(partitionId: string, personRef: string, targetRef: string, actor: Actor): PersonMergeResult;
  archivePerson(partitionId: string, personRef: string, actor: Actor): Person;
  deletePerson(partitionId: string, personRef: string, input: { hard?: boolean }, actor: Actor): void;
  exportPerson(partitionId: string, personRef: string): PersonExport;

  /* --- 简报 / 上下文 / 做梦 --- */
  brief(input: BriefInput): Promise<MemoryBrief>;
  context(input: ContextInput): Promise<PersonContext>;
  dreamStatus(input: { partitionId: string; personId?: string }): MemoryDreamStatus;
  dream(input: MemoryDreamInput, actor: Actor): Promise<MemoryDreamResult>;
}
