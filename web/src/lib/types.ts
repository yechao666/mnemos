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
  /* --- v6.1 P2 合规 --- */
  /** PII 脱敏：off=原文落库；basic=手机/邮箱/身份证/银行卡正则脱敏 */
  piiRedaction?: PiiRedactionMode;
  /* --- v6.2 隐私规则域 --- */
  /** 是否执行 kind=prompt 的隐私规则（需配置 LLM；失败静默回退 regex） */
  privacyLlmEnabled?: boolean;
  [key: string]: unknown;
}

/** PII 脱敏级别（分区设置 settings.piiRedaction）。 */
export type PiiRedactionMode = 'off' | 'basic';

/* ------------------------------------------------------------------ */
/* v6.2：隐私规则域                                                     */
/* ------------------------------------------------------------------ */

export type PrivacyRuleScope = 'global' | 'partition';
export type PrivacyRuleKind = 'regex' | 'prompt';
export type PrivacyAction = 'mask' | 'placeholder';
export type PrivacyMaskMode = 'email' | 'keepFirstLast' | 'keepLast' | 'full';

/** 隐私规则：全局（builtin 标记）或分区规则；同 code 时分区的覆盖全局。 */
export interface PrivacyRule {
  id: string;
  scope: PrivacyRuleScope;
  /** global 规则为空 */
  partitionId?: string;
  /** email/phone/id_card/bank_card/name/address/... */
  code: string;
  name: string;
  kind: PrivacyRuleKind;
  /** regex 源码（kind=regex） */
  pattern?: string;
  /** regex flags，默认 g */
  flags: string;
  /** prompt：告诉 LLM 抽取什么（kind=prompt） */
  instruction?: string;
  entityType: string;
  action: PrivacyAction;
  maskMode: PrivacyMaskMode;
  maskKeepLast: number;
  maskKeepFirst: number;
  enabled: boolean;
  /** 小者先执行，默认 100 */
  priority: number;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
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
  /** 替换后的文本（未命中时通常与输入一致） */
  text: string;
  redacted: boolean;
  hits: PrivacyScanHit[];
  /** 占位符映射：token → 命中的真实值（placeholder 动作时） */
  placeholders: Record<string, string>;
}

/** 记忆占位符：默认只返回值外的元信息；reveal 时才有 value。 */
export interface MemoryPlaceholder {
  placeholder: string;
  kind?: string;
  encrypted: boolean;
  value?: string;
}

export interface MemoryDetail {
  memory: Memory;
  person: Person | null;
  placeholders?: MemoryPlaceholder[];
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
  /** v6.1：人合并后的 canonical 目标（源人被归档并指向它） */
  mergedInto?: string;
  /** 合规/同意标记（自由 JSON） */
  consent?: Record<string, unknown>;
  /** 软删除时间 */
  deletedAt?: string;
}

export interface PersonInput {
  externalId: string;
  type?: PersonType;
  displayName?: string;
  attributes?: Record<string, unknown>;
  status?: PersonStatus;
  /** v6.1 P2：合规/同意标记（整体覆盖） */
  consent?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* v6.1 P1：结构化画像 / 生命周期                                       */
/* ------------------------------------------------------------------ */

/** 事实槽位（当前有效 = validTo 为空；更新会关闭旧 fact 的 validTo）。 */
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
  /** 摘要是否命中缓存（未重新生成） */
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
  /** 导出有上限（服务端截断时置 true） */
  truncated?: boolean;
}

/* ------------------------------------------------------------------ */
/* 记忆                                                                */
/* ------------------------------------------------------------------ */

export type MemoryScope = 'person' | 'partition' | 'session';
export type MemoryStatus = 'active' | 'archived' | 'deleted';
export type MemorySource = 'conversation' | 'api' | 'agent' | 'import' | 'playground' | 'dream';

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
  /** 附件数量（列表按页批量统计，避免 N+1） */
  attachmentCount?: number;
  /** 详情（GET 记忆）才返回附件明细；批量列表只带 attachmentCount */
  attachments?: MemoryAttachment[];
  /** v6.2：占位符数量（正文只存 token，真实值在映射表） */
  placeholderCount?: number;
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
  | 'RESTORE'
  | 'PRIVACY';

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
/* v6.1 P2：实体 / 关系图                                              */
/* ------------------------------------------------------------------ */

export interface EntityGraphNode {
  id: string;
  label: string;
  type: string;
  /** 实体权重（分区内关联记忆的 salience 累计） */
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

/** 实体列表行：mentionCount 为被提及次数，memories 为关联记忆数。 */
export interface EntitySummary {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
  memories: number;
  createdAt?: string;
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
