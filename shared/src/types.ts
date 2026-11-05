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
export type MemorySource = 'conversation' | 'api' | 'agent' | 'import' | 'playground';
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
  | 'context';

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

export interface Memory {
  id: string;
  projectId: string;
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
}
