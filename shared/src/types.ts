/**
 * Mnemos 共享领域契约 —— 服务端与控制台共用的唯一事实来源。
 * 所有 HTTP JSON 载荷均为 camelCase（公开 v1 API 额外接受/返回 snake_case，由 http 层适配）。
 */

/* ------------------------------------------------------------------ */
/* 基础枚举                                                            */
/* ------------------------------------------------------------------ */

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';
export type ApiScope = 'memories:read' | 'memories:write' | 'graph:read' | 'admin';
export type ProjectStatus = 'active' | 'paused' | 'archived';
export type MemoryStatus = 'active' | 'archived' | 'deleted';
export type MemorySource = 'conversation' | 'api' | 'agent' | 'import' | 'playground' | 'dream';
export type ExtractionMode = 'additive' | 'consolidate';
export type ActorType = 'user' | 'api_key' | 'system';

export type MemoryEventType = 'ADD' | 'UPDATE' | 'DELETE' | 'MERGE' | 'NOOP';

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

export interface Actor {
  type: ActorType;
  id: string;
  label: string;
  ip?: string;
  userAgent?: string;
}

/* ------------------------------------------------------------------ */
/* 组织 / 用户 / 项目                                                  */
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

export interface RetrievalWeights {
  semantic: number;
  keyword: number;
  entity: number;
  recency: number;
}

export interface ProjectSettings {
  extractionMode: ExtractionMode;
  embeddingModel: string;
  topK: number;
  threshold: number;
  retentionDays: number;
  graphEnabled: boolean;
  dedupeThreshold: number;
  weights: RetrievalWeights;
  monthlyQuota: number;
  webhookUrl?: string;
  locale: string;
  /** 新记忆缺省可见范围：消费类 App 用 person，协作项目用 partition */
  defaultScope: MemoryScope;
  /** 写入不存在的 person 时是否自动建档 */
  personAutoCreate: boolean;
  /* --- 记忆简报（最近记忆压缩，可直接注入 Agent 上下文） --- */
  /** 简报字符上限（100–5000） */
  briefMaxChars: number;
  /** 是否把记忆简报注入任务简报 prompt */
  briefEnabled: boolean;
  /* --- 记忆做梦（增量记忆巩固） --- */
  dreamEnabled: boolean;
  /** 复盘总结周期（分钟，1–43200） */
  dreamIntervalMinutes: number;
  /* --- 周报/月报 --- */
  reportsEnabled: boolean;
  /** 1=周一 … 7=周日 */
  weeklyReportDay: number;
  weeklyReportTime: string;
  /** 1–28 */
  monthlyReportDay: number;
  monthlyReportTime: string;
}

export interface Project {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string;
  status: ProjectStatus;
  region: string;
  env: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  settings: ProjectSettings;
}

export interface ProjectStats {
  memories: number;
  users: number;
  agents: number;
  entities: number;
  relations: number;
  searches7d: number;
  adds7d: number;
  tokensSaved: number;
  storageBytes: number;
  quotaUsedPct: number;
  recallP50Ms: number;
  recallP95Ms: number;
  hitRate: number;
  growthPct: number;
  lastActivityAt?: string;
}

export interface ProjectSummary extends Project {
  stats: ProjectStats;
  members: number;
  keys: number;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  avatarColor: string;
  joinedAt: string;
}

export interface ApiKey {
  id: string;
  projectId: string;
  /** project=只属于该分区；org=组织级，可访问/创建本组织任意分区（DSH 插件按工作区建分区用） */
  kind?: ApiKeyKind;
  /** org key 所属组织 */
  orgId?: string;
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
/* 记忆                                                                */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

export type MemoryVisibility = 'project' | 'agent' | 'task';

/** 中立服务的可见范围：person=仅该人；partition=分区共享；session=仅当前会话。 */
export type MemoryScope = 'person' | 'partition' | 'session';

export type ApiKeyKind = 'project' | 'org';

/* ------------------------------------------------------------------ */
/* 人（Person）与分区（Partition）                                     */
/* ------------------------------------------------------------------ */

export type PersonType = 'human' | 'agent' | 'service' | 'other';
export type PersonStatus = 'active' | 'archived' | 'deleted';

/**
 * 记忆的主体「人」：真人（App 用户 / 员工）或智能体。
 * 与登录账号（User）无关；externalId 由调用方定义（App 的 user_id、Agent 的 id/name）。
 */
export interface Person {
  id: string;
  partitionId: string;
  externalId: string;
  type: PersonType;
  displayName: string;
  attributes: Record<string, unknown>;
  status: PersonStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  stats?: PersonStats;
}

export interface PersonStats {
  memories: number;
  sharedMemories: number;
  sessions: number;
  lastMemoryAt?: string;
}

export interface PersonInput {
  externalId: string;
  type?: PersonType;
  displayName?: string;
  attributes?: Record<string, unknown>;
  status?: PersonStatus;
}

export interface PersonListInput {
  projectId: string;
  type?: PersonType;
  status?: PersonStatus;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'recent' | 'name' | 'memories';
}

export interface PersonContextInput {
  projectId: string;
  /** 内部 id 或 external_id */
  personRef: string;
  query?: string;
  budgetTokens?: number;
  /** 是否带上分区共享知识（默认 true） */
  includePartition?: boolean;
}

/** 人的上下文：资料 + 人的简报 + 相关记忆 + 分区共享知识，可直接注入提示词。 */
export interface PersonContext {
  person: Person;
  brief: MemoryBrief;
  /** 与 query 最相关、且属于该人的记忆 */
  memories: Memory[];
  /** 分区共享知识（scope=partition，person_id 可有可无） */
  shared: Memory[];
  prompt: string;
  tokenEstimate: number;
  citations: string[];
  builtAt: string;
}

/** 分区（项目/应用/租户）：对外叫 Partition，存储上仍用 projects。 */
export type Partition = Project;

export interface PartitionInput {
  slug: string;
  name?: string;
  description?: string;
  region?: string;
  env?: string;
}


export interface Memory {
  id: string;
  projectId: string;
  /** 记忆主体（归属人，内部 id）；为空表示分区共享知识 */
  personId?: string;
  /** 写入者（可与人不同）；系统/做梦写入时为一个系统人 */
  actorPersonId?: string;
  /** 人的外部 ID（App user_id / Agent id），便于调用方直接比对 */
  personExternalId?: string;
  /** 会话（task_id / run_id 的泛化） */
  sessionId?: string;
  /** 可见范围：person | partition | session */
  scope: MemoryScope;
  userId?: string;
  agentId?: string;
  runId?: string;
  appId?: string;
  /** 产生该记忆的任务会话（跨时间段归因） */
  taskId?: string;
  /** project=项目共享；agent=仅该 Agent 私有；task=仅当前任务可见 */
  visibility: MemoryVisibility;
  content: string;
  category: MemoryCategory;
  importance: number;
  confidence: number;
  source: MemorySource;
  status: MemoryStatus;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  expiresAt?: string;
}

export interface SignalScores {
  semantic: number;
  keyword: number;
  entity: number;
  recency: number;
  importance: number;
}

export interface SearchHit extends Memory {
  score: number;
  signals: SignalScores;
  matchedOn: string[];
  entities: string[];
}

export interface SearchResponse {
  results: SearchHit[];
  total: number;
  tookMs: number;
  queryTerms: string[];
  strategy: string;
  weights: RetrievalWeights;
}

export interface MemoryHistoryEntry {
  id: string;
  memoryId: string;
  event: MemoryEventType;
  oldContent?: string;
  newContent?: string;
  actor: string;
  reason?: string;
  createdAt: string;
  meta: Record<string, unknown>;
}

export interface EntityRef {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
}

export interface Relation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relation: string;
  memoryId?: string;
  weight: number;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Agent 与任务会话（Agent 原生模型）                                   */
/* ------------------------------------------------------------------ */

export type AgentStatus = 'active' | 'idle' | 'retired';

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  role: string;
  model: string;
  description: string;
  /** 能力标签，例如 code-review / sql / oncall / frontend */
  capabilities: string[];
  status: AgentStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  lastActiveAt?: string;
  stats: {
    memories: number;
    privateMemories: number;
    tasks: number;
    lastTaskAt?: string;
  };
}

export interface AgentInput {
  name: string;
  role?: string;
  model?: string;
  description?: string;
  capabilities?: string[];
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
}

export type TaskStatus = 'open' | 'active' | 'done' | 'abandoned';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  ownerAgentId?: string;
  ownerAgentName?: string;
  branch?: string;
  summary?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  startedAt: string;
  endedAt?: string;
  memoryCount: number;
  agentCount: number;
}

export interface TaskInput {
  title: string;
  goal?: string;
  ownerAgentId?: string;
  branch?: string;
  status?: TaskStatus;
  metadata?: Record<string, unknown>;
}

export interface FinishTaskInput {
  status?: 'done' | 'abandoned';
  summary?: string;
  /** 本次任务产生的决策，写入项目共享记忆 */
  decisions?: string[];
  /** 本次任务踩过的坑 / 可复用经验，写入项目共享记忆 */
  lessons?: string[];
  /** 本次任务的关键进展，写入项目共享记录 */
  progress?: string[];
  /** 风险、阻塞及其状态变化 */
  risks?: string[];
  /** 范围、排期、验收标准等变更 */
  changes?: string[];
  /** 验收与质量证据 */
  acceptance?: string[];
  /** 未验证假设与待确认问题 */
  assumptions?: string[];
  /** 跨团队依赖与承诺 */
  dependencies?: string[];
  /** 额外记录（默认项目共享） */
  notes?: string[];
  agentId?: string;
}

export interface BriefingInput {
  projectId: string;
  agentId?: string;
  taskId?: string;
  query?: string;
  budgetTokens?: number;
  includePrivate?: boolean;
}

export type BriefingSectionKey =
  | 'project'
  | 'conventions'
  | 'decisions'
  | 'experience'
  | 'incidents'
  | 'agent_notes'
  | 'open_tasks';

export interface BriefingSection {
  key: BriefingSectionKey;
  title: string;
  description: string;
  hits: SearchHit[];
}

export interface Briefing {
  project: { id: string; name: string; description: string };
  agent?: Agent;
  task?: Task;
  sections: BriefingSection[];
  /** 可直接注入 Agent 系统提示词的 Markdown 文本 */
  prompt: string;
  tokenEstimate: number;
  citations: string[];
  builtAt: string;
  tookMs: number;
  /** 记忆简报（最近记忆压缩）；项目开启 briefEnabled 时同时注入 prompt 首段 */
  brief?: BriefingBrief;
}

/** 任务简报里携带的“记忆简报”快照：控制台预览与 Agent 实际拿到的一致。 */
export interface BriefingBrief {
  text: string;
  maxChars: number;
  count: number;
}

/* ------------------------------------------------------------------ */
/* 记忆简报（brief）与做梦（dream）                                     */
/* ------------------------------------------------------------------ */

/** 简报中引用的记忆摘要，便于控制台展示“这条简报由什么组成”。 */
export interface MemoryBriefItem {
  id: string;
  content: string;
  category: MemoryCategory;
  importance: number;
  updatedAt: string;
  taskId?: string;
  agentId?: string;
  personId?: string;
  personExternalId?: string;
  scope?: MemoryScope;
}

/** 记忆简报：取最近的活跃记忆/洞见压缩成有字符上限、可直接注入提示词的文本。 */
export interface MemoryBrief {
  projectId: string;
  /** 人级简报时带上该人（内部 id） */
  personId?: string;
  /** 简报正文；暂无可用记忆时为空串 */
  text: string;
  maxChars: number;
  /** 纳入简报的记忆条数 */
  count: number;
  /** mnemos-condense（确定性压缩）或实际调用的 LLM 模型名 */
  model: string;
  /** 是否命中缓存 */
  cached: boolean;
  generatedAt: string;
  recent: MemoryBriefItem[];
}

export interface MemoryBriefInput {
  projectId: string;
  /** 人级简报：只取该人的 person 记忆 + 与其相关的分区共享记忆 */
  personId?: string;
  /** 覆盖项目设置里的 briefMaxChars（不落库） */
  maxChars?: number;
  /** 按该 Agent 的可见性生成；不传时只使用项目共享记忆 */
  agentId?: string;
  /** 控制台/审计视角：包含所有 Agent 私有记忆（默认 false） */
  includePrivate?: boolean;
  /** 忽略缓存，重新生成 */
  force?: boolean;
  /** 是否允许调用 LLM 润色（默认 false，热路径只用确定性压缩） */
  allowLlm?: boolean;
}

export type MemoryDreamRunStatus = 'running' | 'completed' | 'skipped' | 'failed';
export type MemoryDreamTrigger = 'schedule' | 'manual';

/** 一次做梦（增量记忆巩固）的运行记录。 */
export interface MemoryDreamRun {
  id: string;
  projectId: string;
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
  /** 上次做梦时间（取最近一次运行） */
  lastAt?: string;
}


export type MemoryReportPeriod = 'week' | 'month';

export interface MemoryReportItem {
  id: string;
  content: string;
  category: MemoryCategory;
  createdAt: string;
  agentId?: string;
  taskId?: string;
  status?: string;
  severity?: string;
}

export interface MemoryReportSection {
  key: 'progress' | 'decisions' | 'lessons' | 'risks' | 'changes' | 'acceptance' | 'assumptions' | 'dependencies' | 'insights';
  title: string;
  count: number;
  items: MemoryReportItem[];
}

export interface MemoryReport {
  projectId: string;
  period: MemoryReportPeriod;
  title: string;
  start: string;
  end: string;
  sections: MemoryReportSection[];
  counts: Record<'progress' | 'decisions' | 'lessons' | 'risks' | 'changes' | 'acceptance' | 'assumptions' | 'dependencies' | 'insights', number>;
  markdown: string;
}

export interface MemoryDreamStatus {
  settings: MemoryDreamSettings;
  /** 人级状态时带上该人（内部 id）；分区级为空 */
  personId?: string;
  /** 尚未做梦的活跃记忆数 */
  pendingCount: number;
  lastRun?: MemoryDreamRun;
  /** 最近 10 次运行记录（新 → 旧） */
  runs: MemoryDreamRun[];
}

export interface MemoryDreamSettingsInput {
  enabled?: boolean;
  intervalMinutes?: number;
}

export interface MemoryDreamInput {
  projectId: string;
  /** 指定人：只巩固该人 scope=person 的新记忆；缺省为分区级（scope=partition） */
  personId?: string;
  trigger?: MemoryDreamTrigger;
  /** 单批最多处理的记忆条数（1–200，默认 50） */
  batchSize?: number;
}

export interface MemoryDreamResult {
  /** 该项目正在做梦时返回 null（路由层转 409） */
  run: MemoryDreamRun | null;
  status: MemoryDreamStatus;
}


export interface TaskWithMemories {
  task: Task;
  memories: Memory[];
}

export interface MemoryDetail {
  memory: Memory;
  history: MemoryHistoryEntry[];
  entities: EntityRef[];
  relations: Relation[];
  neighbors: EntityRef[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  weight: number;
  memories: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodes: number;
    edges: number;
    entities: number;
    density: number;
    topTypes: { type: string; count: number }[];
  };
}

/* ------------------------------------------------------------------ */
/* 记忆引擎 I/O                                                        */
/* ------------------------------------------------------------------ */

export interface AddMemoryInput {
  projectId: string;
  messages?: ChatMessage[];
  text?: string;
  /** 记忆主体：内部 id 或 external id（与 personExternalId 二选一） */
  personId?: string;
  personExternalId?: string;
  /** 写入者（默认同 person） */
  actorPersonId?: string;
  /** 可见范围；缺省取分区设置 defaultScope */
  scope?: MemoryScope;
  sessionId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  appId?: string;
  taskId?: string;
  visibility?: MemoryVisibility;
  metadata?: Record<string, unknown>;
  tags?: string[];
  infer?: boolean;
  mode?: ExtractionMode;
  source?: MemorySource;
  actor: Actor;
}

export interface MemoryEvent {
  type: MemoryEventType;
  memoryId?: string;
  content: string;
  reason?: string;
  at: string;
}

export interface AddMemoryResult {
  results: Memory[];
  events: MemoryEvent[];
  tookMs: number;
  extracted: number;
  merged: number;
  skipped: number;
}

export interface SearchFilters {
  status?: MemoryStatus;
  category?: MemoryCategory;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
  minImportance?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchMemoryInput {
  projectId: string;
  query: string;
  /** 按人过滤（内部 id 或 external id） */
  personId?: string;
  /** 按可见范围过滤 */
  scope?: MemoryScope;
  userId?: string;
  /** 调用方 Agent 身份：用于可见性判定（project 共享 + 自己的 private + 当前任务） */
  agentId?: string;
  /** 归属过滤：只看该 Agent 写入的记忆（控制台筛选用） */
  writtenByAgentId?: string;
  runId?: string;
  appId?: string;
  /** 仅返回该任务写入的记忆 */
  taskId?: string;
  /** 仅返回指定可见性 */
  visibility?: MemoryVisibility;
  /** 控制台/审计视角：包含所有 Agent 的私有记忆（默认 false） */
  includePrivate?: boolean;
  filters?: SearchFilters;
  topK?: number;
  threshold?: number;
}

export interface ListMemoriesInput {
  projectId: string;
  q?: string;
  /** 按人过滤（内部 id 或 external id） */
  personId?: string;
  /** 按可见范围过滤 */
  scope?: MemoryScope;
  userId?: string;
  /** 调用方 Agent 身份（可见性） */
  agentId?: string;
  /** 归属过滤：只看该 Agent 写入的记忆 */
  writtenByAgentId?: string;
  runId?: string;
  taskId?: string;
  visibility?: MemoryVisibility;
  includePrivate?: boolean;
  category?: MemoryCategory;
  status?: MemoryStatus;
  sort?: 'recent' | 'importance' | 'accessed';
  page?: number;
  pageSize?: number;
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  importance?: number;
  status?: MemoryStatus;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
}

export interface FeedbackInput {
  helpful: boolean;
  query?: string;
}

export interface BulkMemoryInput {
  action: 'delete' | 'archive' | 'restore';
  ids: string[];
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/* ------------------------------------------------------------------ */
/* 控制台 / 观测                                                       */
/* ------------------------------------------------------------------ */

export interface AuditLog {
  id: string;
  orgId?: string;
  projectId?: string;
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

export interface CategoryCount {
  name: string;
  count: number;
}

export interface ProjectOverview {
  stats: ProjectStats;
  usage: UsagePoint[];
  categories: CategoryCount[];
  topEntities: EntityRef[];
  recentActivity: AuditLog[];
  recentMemories: Memory[];
  keys: ApiKey[];
  health: { status: 'healthy' | 'degraded'; checks: { name: string; ok: boolean; detail: string }[] };
}

export interface DashboardSummary {
  org: Org;
  totals: {
    projects: number;
    memories: number;
    users: number;
    agents: number;
    searches7d: number;
    adds7d: number;
    tokensSaved: number;
    p50: number;
    errorRate: number;
  };
  usage: UsagePoint[];
  projects: ProjectSummary[];
  recentActivity: AuditLog[];
  topProjects: { id: string; name: string; memories: number; slug: string }[];
  categoryMix: CategoryCount[];
}

/* ------------------------------------------------------------------ */
/* Webhook 事件订阅                                                    */
/* ------------------------------------------------------------------ */

export type WebhookEventType =
  | 'memory.created'
  | 'memory.updated'
  | 'memory.deleted'
  | 'task.finished'
  | 'agent.registered'
  | 'key.created'
  | 'key.revoked'
  | 'quota.exceeded';

export interface Webhook {
  id: string;
  projectId: string;
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  enabled: boolean;
  description: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt?: string;
  lastStatus?: number;
  failureCount: number;
  disabledAt?: string;
}

export interface WebhookWithSecret extends Webhook {
  /** 仅在创建/轮换时返回一次 */
  secret: string;
}

export interface WebhookInput {
  name: string;
  url: string;
  eventTypes: WebhookEventType[];
  description?: string;
  enabled?: boolean;
}

export type WebhookDeliveryStatus = 'pending' | 'delivering' | 'success' | 'failed' | 'dead';

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  projectId: string;
  eventType: WebhookEventType | 'webhook.test';
  eventId?: string;
  /** 请求载荷（JSON 字符串，供控制台预览；可能被截断） */
  payload?: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  responseStatus?: number;
  responseBody?: string;
  latencyMs?: number;
  error?: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface WebhookTestResult {
  deliveryId: string;
  status: WebhookDeliveryStatus;
  responseStatus?: number;
  latencyMs?: number;
  error?: string;
}

export interface WebhookStats {
  total: number;
  success: number;
  failed: number;
  dead: number;
  pending: number;
  avgLatencyMs: number;
  last24h: number;
}

/** 事件载荷：发送到订阅方的最小、稳定结构。 */
export interface WebhookEventPayload {
  id: string;
  type: WebhookEventType;
  at: string;
  projectId: string;
  projectSlug?: string;
  actor: string;
  data: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 生产运维 / 组织管理                                                 */
/* ------------------------------------------------------------------ */

export interface OrgUser extends User {
  projectCount: number;
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
  /** 仅在重置时返回一次 */
  temporaryPassword: string;
}

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
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
    projects: number;
    memories: number;
    agents: number;
    tasks: number;
    apiKeys: number;
    auditEvents: number;
    usageEvents: number;
  };
  quotas: {
    projectId: string;
    name: string;
    usedTokens: number;
    monthlyQuota: number;
    usedPct: number;
    memories: number;
  }[];
  retention: {
    projectId: string;
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
  idempotencyPurged: number;
  sessionsPurged: number;
  walCheckpointed: boolean;
  vacuumed: boolean;
  durationMs: number;
}

export interface ProjectExport {
  format: 'mnemos-export/v1';
  exportedAt: string;
  project: { id: string; slug: string; name: string };
  agents: Agent[];
  tasks: Task[];
  memories: Memory[];
}

export interface AuthResponse {
  token: string;
  user: User;
  org: Org;
}

export interface DemoAccount {
  email: string;
  name: string;
  role: Role;
  password: string;
  title: string;
}

export interface LiveEvent {
  id: string;
  type:
    | 'memory.added'
    | 'memory.updated'
    | 'memory.deleted'
    | 'search.performed'
    | 'key.created'
    | 'key.revoked'
    | 'task.finished'
    | 'agent.registered'
    | 'quota.exceeded'
    | 'project.created';
  projectId?: string;
  projectName?: string;
  actor: string;
  summary: string;
  at: string;
  meta?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 服务端内部接口                                                      */
/* ------------------------------------------------------------------ */

export interface MemoryService {
  add(input: AddMemoryInput): Promise<AddMemoryResult>;
  search(input: SearchMemoryInput): Promise<SearchResponse>;
  list(input: ListMemoriesInput): Promise<Paginated<Memory>>;
  get(projectId: string, id: string): Promise<MemoryDetail | null>;
  update(projectId: string, id: string, input: UpdateMemoryInput, actor: Actor): Promise<Memory>;
  remove(projectId: string, id: string, actor: Actor): Promise<void>;
  bulk(projectId: string, input: BulkMemoryInput, actor: Actor): Promise<{ affected: number }>;
  history(projectId: string, id: string): Promise<MemoryHistoryEntry[]>;
  feedback(projectId: string, id: string, input: FeedbackInput, actor: Actor): Promise<Memory>;
  graph(projectId: string, limit: number): Promise<GraphData>;
  stats(projectId: string): Promise<ProjectStats>;
  /* --- Agent 原生：注册表 / 任务会话 / 任务简报 --- */
  agents(projectId: string): Promise<Agent[]>;
  agent(projectId: string, agentId: string): Promise<Agent | null>;
  createAgent(projectId: string, input: AgentInput, actor: Actor): Promise<Agent>;
  updateAgent(projectId: string, agentId: string, input: Partial<AgentInput>, actor: Actor): Promise<Agent>;
  tasks(projectId: string, params?: { status?: TaskStatus; agentId?: string; limit?: number }): Promise<Task[]>;
  task(projectId: string, taskId: string): Promise<Task | null>;
  createTask(projectId: string, input: TaskInput, actor: Actor): Promise<Task>;
  updateTask(projectId: string, taskId: string, input: Partial<TaskInput> & { summary?: string }, actor: Actor): Promise<Task>;
  finishTask(projectId: string, taskId: string, input: FinishTaskInput, actor: Actor): Promise<{ task: Task; memories: Memory[] }>;
  briefing(input: BriefingInput): Promise<Briefing>;
  /* --- 记忆简报 / 做梦 --- */
  brief(input: MemoryBriefInput): Promise<MemoryBrief>;
  updateBriefSettings(projectId: string, maxChars: number, actor: Actor): Promise<MemoryBrief>;
  dreamStatus(projectId: string): Promise<MemoryDreamStatus>;
  /** 人级做梦状态（pending/runs 只含该人） */
  personDreamStatus(projectId: string, personRef: string): Promise<MemoryDreamStatus>;
  updateDreamSettings(projectId: string, input: MemoryDreamSettingsInput, actor: Actor): Promise<MemoryDreamStatus>;
  dream(input: MemoryDreamInput, actor: Actor): Promise<MemoryDreamResult>;
  /* --- 中立服务：人（Person） --- */
  persons(input: PersonListInput): Promise<Paginated<Person>>;
  /** personRef 支持内部 id 或 external_id */
  person(projectId: string, personRef: string): Promise<Person | null>;
  upsertPerson(projectId: string, input: PersonInput, actor: Actor): Promise<Person>;
  updatePerson(projectId: string, personRef: string, input: Partial<PersonInput>, actor: Actor): Promise<Person>;
  /** 人的上下文：资料 + 人的简报 + 相关记忆 + 分区共享知识 */
  personContext(input: PersonContextInput): Promise<PersonContext>;
}
