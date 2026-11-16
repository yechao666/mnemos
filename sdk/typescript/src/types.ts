/**
 * Mnemos 公开 v1 API 的数据类型。
 *
 * 约定：
 * - 请求参数与响应字段使用 snake_case（与 `/v1/*` 线上契约一致）；
 * - 为了贴合 TypeScript 调用习惯，入参同时接受 camelCase 别名（如 `userId`），
 *   客户端会统一序列化成 snake_case 发送；
 * - 响应模型会把服务端返回的 camelCase 字段（例如写入接口的 `createdAt`）
 *   归一化为 snake_case，因此调用方只需要面对一套命名。
 */

/* ------------------------------------------------------------------ */
/* 基础枚举                                                            */
/* ------------------------------------------------------------------ */

/** 对话消息角色。 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
/** 记忆分类。 */
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
  | 'insight';
/** 可见性：项目共享 / 仅 Agent 私有 / 仅任务可见。 */
export type MemoryVisibility = 'project' | 'agent' | 'task';
/** 记忆状态。 */
export type MemoryStatus = 'active' | 'archived' | 'deleted';
/** 记忆来源。 */
export type MemorySource = 'conversation' | 'api' | 'agent' | 'import' | 'playground' | 'dream';
/** 事实抽取模式：追加或相似去重合并。 */
export type ExtractionMode = 'additive' | 'consolidate';
/** 记忆变更事件类型。 */
export type MemoryEventType = 'ADD' | 'UPDATE' | 'DELETE' | 'MERGE' | 'NOOP';
/** Agent 状态。 */
export type AgentStatus = 'active' | 'idle' | 'retired';
/** 任务会话状态。 */
export type TaskStatus = 'open' | 'active' | 'done' | 'abandoned';

/* ------------------------------------------------------------------ */
/* 记忆                                                                */
/* ------------------------------------------------------------------ */

/** 写入记忆时使用的对话消息。 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** 可选的消息作者名（工具调用等场景）。 */
  name?: string;
}

/** 记忆实体。 */
export interface Memory {
  id: string;
  /** 记忆正文（推荐字段）。 */
  content: string;
  /** 正文别名：`/v1` 列表与检索接口的字段名是 `memory`，与 `content` 相同。 */
  memory: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  app_id: string | null;
  task_id: string | null;
  visibility: MemoryVisibility;
  category: MemoryCategory;
  importance: number;
  confidence: number;
  source: MemorySource;
  status: MemoryStatus;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  expires_at: string | null;
}

/** 检索命中的逐信号分解。 */
export interface SignalScores {
  semantic: number;
  keyword: number;
  entity: number;
  recency: number;
  importance: number;
}

/** 检索命中：记忆 + 融合分 + 信号分解。 */
export interface SearchHit extends Memory {
  score: number;
  signals: SignalScores;
  matched_on: string[];
  entities: string[];
}

/** 检索响应附带的策略信息。 */
export interface SearchSignalsMeta {
  weights?: Record<string, number>;
  strategy?: string;
  query_terms?: string[];
  [key: string]: unknown;
}

/** 记忆变更历史。 */
export interface MemoryHistoryEntry {
  id: string;
  memory_id: string;
  event: MemoryEventType;
  old_content: string | null;
  new_content: string | null;
  actor: string;
  reason: string | null;
  created_at: string;
  meta: Record<string, unknown>;
}

/** 记忆写入产生的引擎事件。 */
export interface MemoryEvent {
  type: MemoryEventType;
  memory_id: string | null;
  content: string;
  reason?: string;
  at: string;
}

/** 实体引用（图谱节点/邻居）。 */
export interface EntityRef {
  id: string;
  name: string;
  type: string;
  mention_count: number;
}

/** 实体关系。 */
export interface Relation {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation: string;
  memory_id: string | null;
  weight: number;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Agent / 任务 / 简报                                                  */
/* ------------------------------------------------------------------ */

/** Agent 注册表条目。 */
export interface Agent {
  id: string;
  project_id: string;
  name: string;
  role: string;
  model: string;
  description: string;
  capabilities: string[];
  status: AgentStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  last_active_at: string | null;
  stats: {
    memories: number;
    private_memories: number;
    tasks: number;
    last_task_at: string | null;
  };
}

/** 任务会话。 */
export interface Task {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  owner_agent_id: string | null;
  owner_agent_name: string | null;
  branch: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  started_at: string;
  ended_at: string | null;
  memory_count: number;
  agent_count: number;
}

/** 简报分区 key。 */
export type BriefingSectionKey =
  | 'project'
  | 'conventions'
  | 'decisions'
  | 'experience'
  | 'incidents'
  | 'agent_notes'
  | 'open_tasks';

/** 简报分区。 */
export interface BriefingSection {
  key: BriefingSectionKey;
  title: string;
  description: string;
  hits: SearchHit[];
}

/** 任务简报：可直接拼进 system prompt。 */
export interface Briefing {
  project: { id: string; name: string; description: string };
  agent: Agent | null;
  task: Task | null;
  sections: BriefingSection[];
  /** 中文 Markdown 文本，可直接注入系统提示词。 */
  prompt: string;
  token_estimate: number;
  citations: string[];
  built_at: string;
  took_ms: number;
  /** 记忆简报（最近记忆压缩）；项目开启 briefEnabled 时同时注入 `prompt` 首段。 */
  brief?: BriefingBrief;
}

/** 任务简报里携带的“记忆简报”快照：控制台预览与 Agent 实际拿到的一致。 */
export interface BriefingBrief {
  /** 简报正文（Markdown / 纯文本）。 */
  text: string;
  /** 生成的字符上限。 */
  max_chars: number;
  /** 纳入简报的记忆条数。 */
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
  updated_at: string;
  task_id?: string;
  agent_id?: string;
}

/** 记忆简报：最近的活跃记忆/洞见压缩成有字符上限、可直接注入提示词的文本。 */
export interface MemoryBrief {
  project_id: string;
  /** 简报正文；暂无可用记忆时为空串。 */
  text: string;
  max_chars: number;
  /** 纳入简报的记忆条数。 */
  count: number;
  /** `mnemos-condense`（确定性压缩）或实际调用的 LLM 模型名。 */
  model: string;
  /** 是否命中 `memory_briefs` 缓存。 */
  cached: boolean;
  generated_at: string;
  recent: MemoryBriefItem[];
}

/** 生成记忆简报的查询参数。 */
export interface MemoryBriefInput {
  /** 覆盖项目设置里的 `brief_max_chars`（不落库，服务端 clamp 到 100–5000）。 */
  maxChars?: number;
  max_chars?: number;
  /**
   * 不传 = 控制台审计全量视角（含所有 Agent 私有）；传 = 按该 Agent 视角生成
   * （项目共享 + 该 Agent 私有，排除其他 Agent 私有）。
   */
  agentId?: string;
  agent_id?: string;
  /** 忽略缓存、重新生成。 */
  force?: boolean;
}

/** 一次做梦（增量记忆巩固）的运行状态。 */
export type MemoryDreamRunStatus = 'running' | 'completed' | 'skipped' | 'failed';
/** 做梦触发方式：定时调度 / 手动。 */
export type MemoryDreamTrigger = 'schedule' | 'manual';

/** 一次做梦的运行记录。 */
export interface MemoryDreamRun {
  id: string;
  project_id: string;
  trigger: MemoryDreamTrigger;
  status: MemoryDreamRunStatus;
  input_count: number;
  insight_count: number;
  summary?: string;
  error?: string;
  started_at: string;
  finished_at?: string;
}

/** 项目级做梦设置。 */
export interface MemoryDreamSettings {
  enabled: boolean;
  interval_minutes: number;
  /** 上次做梦时间（取最近一次运行）。 */
  last_at?: string;
}

/** 做梦状态：设置 + 待整理数 + 最近运行记录。 */
export interface MemoryDreamStatus {
  settings: MemoryDreamSettings;
  /** 尚未做梦的活跃记忆数。 */
  pending_count: number;
  last_run?: MemoryDreamRun;
  /** 最近 10 次运行记录（新 → 旧）。 */
  runs: MemoryDreamRun[];
}

/** 更新做梦设置的入参。 */
export interface MemoryDreamSettingsInput {
  enabled?: boolean;
  intervalMinutes?: number;
  interval_minutes?: number;
}

/** 手动触发一次做梦的响应。 */
export interface MemoryDreamResult {
  /** 该项目正在做梦时为 `null`（HTTP 409）。 */
  run: MemoryDreamRun | null;
  status: MemoryDreamStatus;
}

/* ------------------------------------------------------------------ */
/* 图谱 / 统计                                                          */
/* ------------------------------------------------------------------ */

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
  stats?: {
    nodes: number;
    edges: number;
    entities: number;
    density: number;
    top_types: { type: string; count: number }[];
  };
}

/** 项目指标。 */
export interface ProjectMetrics {
  total_memories: number;
  users: number;
  agents: number;
  entities: number;
  relations: number;
  searches_7d: number;
  adds_7d: number;
  tokens_saved: number;
  storage_bytes: number;
  quota_used_pct: number;
  recall_p50_ms: number;
  recall_p95_ms: number;
  hit_rate: number;
  growth_pct: number;
  last_activity_at: string | null;
}

export interface StatsResponse {
  metrics: ProjectMetrics;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptime_ms: number;
}

/* ------------------------------------------------------------------ */
/* Webhook（beta）                                                      */
/* ------------------------------------------------------------------ */

/** 可订阅的 Webhook 事件类型。 */
export type WebhookEventType =
  | 'memory.created'
  | 'memory.updated'
  | 'memory.deleted'
  | 'task.finished'
  | 'agent.registered'
  | 'key.created'
  | 'key.revoked'
  | 'quota.exceeded';

/** Webhook 投递状态。 */
export type WebhookDeliveryStatus = 'pending' | 'delivering' | 'success' | 'failed' | 'dead';

/**
 * Webhook 订阅（**beta**：端点可能随服务端实现调整）。
 */
export interface Webhook {
  id: string;
  project_id: string;
  name: string;
  url: string;
  /** 签名密钥；仅在创建/轮换时返回明文。 */
  secret?: string;
  event_types: WebhookEventType[];
  enabled: boolean;
  description: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_delivery_at: string | null;
  last_status: number | null;
  failure_count: number;
  disabled_at: string | null;
}

/** Webhook 投递记录。 */
export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  project_id: string | null;
  event_type: WebhookEventType;
  event_id: string | null;
  status: WebhookDeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  response_status: number | null;
  response_body: string | null;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入                                                          */
/* ------------------------------------------------------------------ */

/**
 * `mnemos-export/v1` 导出文档（SDK 归一化为 snake_case）。
 */
export interface ProjectExport {
  format: 'mnemos-export/v1';
  exported_at: string;
  project: { id: string; slug: string; name: string };
  agents: Agent[];
  tasks: Task[];
  memories: Memory[];
}

/** 单条导入记录（服务端导入格式，camelCase；允许透传未知字段）。 */
export interface ImportMemoryInput {
  content?: string;
  text?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  appId?: string;
  taskId?: string;
  visibility?: MemoryVisibility;
  tags?: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 导入文档：可以是完整导出文档，也可以只带 memories。 */
export interface ImportDocument {
  format?: string;
  memories: ImportMemoryInput[];
  [key: string]: unknown;
}

export interface ImportErrorItem {
  index: number;
  message: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errors: ImportErrorItem[];
}

/* ------------------------------------------------------------------ */
/* 请求入参                                                            */
/* ------------------------------------------------------------------ */

/** 写入记忆入参。`messages` 与 `text` 至少提供一个。 */
export interface MemoryAddInput {
  messages?: ChatMessage[];
  text?: string;
  userId?: string;
  user_id?: string;
  agentId?: string;
  agent_id?: string;
  runId?: string;
  run_id?: string;
  appId?: string;
  app_id?: string;
  taskId?: string;
  task_id?: string;
  visibility?: MemoryVisibility;
  metadata?: Record<string, unknown>;
  infer?: boolean;
  mode?: ExtractionMode;
}

/** 检索过滤条件。 */
export interface SearchFilters {
  status?: MemoryStatus;
  category?: MemoryCategory;
  tags?: string[];
  createdAfter?: string;
  createdBefore?: string;
  minImportance?: number;
  metadata?: Record<string, unknown>;
  userId?: string;
  agentId?: string;
  runId?: string;
  /** snake_case 别名。 */
  created_after?: string;
  created_before?: string;
  min_importance?: number;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
}

/** 检索入参。 */
export interface MemorySearchInput {
  query: string;
  userId?: string;
  user_id?: string;
  agentId?: string;
  agent_id?: string;
  taskId?: string;
  task_id?: string;
  runId?: string;
  run_id?: string;
  appId?: string;
  app_id?: string;
  /** 归属过滤：只看该 Agent 写入的记忆。 */
  writtenByAgentId?: string;
  written_by_agent_id?: string;
  visibility?: MemoryVisibility;
  topK?: number;
  top_k?: number;
  threshold?: number;
  includePrivate?: boolean;
  include_private?: boolean;
  filters?: SearchFilters;
}

/** 列表入参。 */
export interface MemoryListInput {
  userId?: string;
  user_id?: string;
  agentId?: string;
  agent_id?: string;
  runId?: string;
  run_id?: string;
  appId?: string;
  app_id?: string;
  taskId?: string;
  task_id?: string;
  visibility?: MemoryVisibility;
  category?: MemoryCategory;
  page?: number;
  pageSize?: number;
  page_size?: number;
}

/** 更新记忆入参：`text` / `content` 至少一个。 */
export interface MemoryUpdateInput {
  text?: string;
  content?: string;
  category?: MemoryCategory;
  importance?: number;
}

/** 反馈入参。 */
export interface FeedbackInput {
  helpful: boolean;
  query?: string;
}

/** 注册 Agent 入参。 */
export interface AgentCreateInput {
  name: string;
  role?: string;
  model?: string;
  description?: string;
  capabilities?: string[];
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
}

/** 开始任务入参。 */
export interface TaskCreateInput {
  title: string;
  goal?: string;
  ownerAgentId?: string;
  owner_agent_id?: string;
  branch?: string;
  status?: TaskStatus;
}

/** 结束任务入参：decisions / lessons / notes 会自动沉淀为项目记忆。 */
export interface TaskFinishInput {
  status?: 'done' | 'abandoned';
  summary?: string;
  decisions?: string[];
  lessons?: string[];
  notes?: string[];
  agentId?: string;
  agent_id?: string;
}

/** 任务列表入参。 */
export interface TaskListInput {
  status?: TaskStatus;
  agentId?: string;
  agent_id?: string;
  limit?: number;
}

/** 简报入参。 */
export interface ContextBuildInput {
  agentId?: string;
  agent_id?: string;
  taskId?: string;
  task_id?: string;
  query?: string;
  budgetTokens?: number;
  budget_tokens?: number;
}

/** 图谱查询入参。 */
export interface GraphInput {
  /** 节点上限，默认 120，最大 400。 */
  limit?: number;
  userId?: string;
  user_id?: string;
}

/** 创建 Webhook 入参（beta）。 */
export interface WebhookCreateInput {
  name: string;
  url: string;
  /** 至少订阅一个事件类型（服务端要求）。 */
  eventTypes?: WebhookEventType[];
  event_types?: WebhookEventType[];
  enabled?: boolean;
  description?: string;
}

/** 更新 Webhook 入参（beta）：只发送提供的字段。 */
export interface WebhookUpdateInput {
  name?: string;
  url?: string;
  eventTypes?: WebhookEventType[];
  event_types?: WebhookEventType[];
  enabled?: boolean;
  description?: string;
}

/** Webhook 投递列表入参（beta）。 */
export interface WebhookDeliveryListInput {
  page?: number;
  pageSize?: number;
  page_size?: number;
  /** 兼容别名，等价于 `page_size`。 */
  limit?: number;
  status?: WebhookDeliveryStatus;
}

/* ------------------------------------------------------------------ */
/* 响应                                                                */
/* ------------------------------------------------------------------ */

/** 写入记忆响应。 */
export interface AddMemoryResponse {
  results: Memory[];
  events: MemoryEvent[];
  took_ms: number;
  extracted?: number;
  merged?: number;
  skipped?: number;
}

/** 检索响应。 */
export interface SearchResponse {
  results: SearchHit[];
  total: number;
  took_ms: number;
  signals?: SearchSignalsMeta;
}

/** 列表响应。 */
export interface MemoryListResponse {
  results: Memory[];
  count: number;
  page: number;
  page_size: number;
}

/** 记忆详情响应。 */
export interface MemoryDetail extends Memory {
  history: MemoryHistoryEntry[];
  entities: EntityRef[];
  relations: Relation[];
  neighbors: EntityRef[];
}

/** 历史响应。 */
export interface MemoryHistoryResponse {
  results: MemoryHistoryEntry[];
}

/** Agent 列表响应。 */
export interface AgentListResponse {
  results: Agent[];
  count: number;
}

/** 任务列表响应。 */
export interface TaskListResponse {
  results: Task[];
  count: number;
}

/** 结束任务响应。 */
export interface TaskFinishResponse {
  task: Task;
  memories: Memory[];
}

/** Webhook 列表响应（beta）。 */
export interface WebhookListResponse {
  results: Webhook[];
  count: number;
}

/** Webhook 投递列表响应（beta，分页）。 */
export interface WebhookDeliveryListResponse {
  items: WebhookDelivery[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

/** 简单操作响应。 */
export interface MutationResponse {
  message: string;
  /** 服务端 `{ ok: true }` 形式的删除响应。 */
  ok?: boolean;
  deleted?: number;
  affected?: number;
}

/** 单个请求的可选参数。 */
export interface RequestOptions {
  /**
   * 幂等键（8–128 字符）。写请求传入后会在重试时复用同一个 key，
   * 服务端 24h 内回放首次结果。
   */
  idempotencyKey?: string;
  /** 外部取消信号（与超时信号自动合并）。 */
  signal?: AbortSignal;
  /** 覆盖客户端默认超时（毫秒，按单次尝试计算）。 */
  timeoutMs?: number;
  /** 附加请求头。 */
  headers?: Record<string, string>;
}

/** 客户端构造参数。 */
export interface MnemosClientOptions {
  /** API Key，`mnemos_live_*`。 */
  apiKey: string;
  /** 服务地址，默认 `http://127.0.0.1:4380`。 */
  baseUrl?: string;
  /** 单次请求超时（毫秒），默认 30s。 */
  timeoutMs?: number;
  /** 最大重试次数，默认 2。 */
  maxRetries?: number;
  /** 自定义 fetch（测试/特殊运行时）。 */
  fetchImpl?: typeof fetch;
}

/** 错误响应体。 */
export interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    requestId?: string;
    request_id?: string;
  };
}
