/**
 * Mnemos v6 公开 API 的数据类型。
 *
 * v6 领域只有三个核心：**分区（Partition）+ 人（Person）+ 记忆（Memory）**。
 * 记忆永远属于一个人（`person_id` NOT NULL），共享由记忆级 `scope` 决定。
 *
 * 约定：
 * - 响应模型使用 snake_case（与 `/v1/*` 线上契约一致），控制台 `/api` 的
 *   camelCase 响应也由客户端统一归一化成同一套 snake_case 视图；
 * - 入参以 TypeScript 习惯的 camelCase 为主，同时接受 snake_case 别名；
 *   客户端统一序列化成 snake_case 发送；
 * - 人 / 记忆列表统一是游标分页 `CursorPage`（不返回 total，也不做 COUNT(*)）。
 *
 * 本文件保持 **自包含**（不 import shared 包），便于独立发布 `@mnemos/sdk`。
 */

/* ------------------------------------------------------------------ */
/* 基础枚举                                                            */
/* ------------------------------------------------------------------ */

/** 分区状态。 */
export type PartitionStatus = 'active' | 'paused' | 'archived';

/** 人的类型：真人 / 智能体 / 服务 / 其他。 */
export type PersonType = 'human' | 'agent' | 'service' | 'other';
/** 人的状态。 */
export type PersonStatus = 'active' | 'archived' | 'deleted';
/** 人列表排序：recent=最近活跃，new=最近新建，name=显示名。 */
export type PersonSort = 'recent' | 'new' | 'name';

/** 记忆可见范围：person=仅本人；partition=分区共享；session=仅当前会话。 */
export type MemoryScope = 'person' | 'partition' | 'session';
/** 记忆状态。 */
export type MemoryStatus = 'active' | 'archived' | 'deleted';
/** 检索模式：混合 / 仅关键词 / 仅向量。 */
export type SearchMode = 'hybrid' | 'keyword' | 'vector';
/** 多模态附件类型：图片 / 音频 / 视频 / 文件。 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';
/** 记忆来源。 */
export type MemorySource = 'api' | 'conversation' | 'agent' | 'import' | 'playground' | 'dream';

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
  | 'insight'
  | 'decision'
  | 'progress'
  | 'lesson'
  | 'risk'
  | 'change'
  | 'acceptance'
  | 'assumption'
  | 'dependency';

/** API Key 作用域。 */
export type ApiScope = 'memories:read' | 'memories:write' | 'admin';
/** API Key 类型：`partition` 只能访问绑定的分区；`org` 可访问本组织任意分区。 */
export type ApiKeyKind = 'partition' | 'org';

/** 一次做梦（增量记忆巩固）的运行状态。 */
export type MemoryDreamRunStatus = 'running' | 'completed' | 'skipped' | 'failed';
/** 做梦触发方式：定时调度 / 手动。 */
export type MemoryDreamTrigger = 'manual' | 'schedule';

/** 对话消息角色（写入记忆的 `messages` 用）。 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/* ------------------------------------------------------------------ */
/* 分区（Partition）                                                   */
/* ------------------------------------------------------------------ */

/** 混合检索权重（未列出的信号按 0 处理）。 */
export interface RetrievalWeights {
  /** 向量（本地 hash-384 或外部 embedding）相似度。 */
  vector: number;
  /** 关键词（FTS + CJK 二元组覆盖率）。 */
  keyword: number;
  /** 时效（越新越高）。 */
  recency: number;
  /** 记忆重要度。 */
  importance: number;
  /** 实体命中（P2，默认 0）。 */
  entity: number;
}

/** 分区设置（响应视图，snake_case）。 */
export interface PartitionSettings {
  /** 新记忆缺省可见范围（消费类 App 用 person，协作分区用 partition）。 */
  default_scope: MemoryScope;
  /** 人级/分区级简报字符上限（100–5000）。 */
  brief_max_chars: number;
  brief_enabled: boolean;
  dream_enabled: boolean;
  /** 做梦周期（分钟，1–43200）。 */
  dream_interval_minutes: number;
  /** 记忆保留天数（0=不限）。 */
  retention_days: number;
  /** 月度写入 token 配额（0=不限）。 */
  monthly_quota: number;
  /** 写入未知人时是否自动建档。 */
  person_auto_create: boolean;
  locale: string;
  /* --- v6.1 检索与写管线 --- */
  /** 检索模式：hybrid / keyword / vector（默认 hybrid）。 */
  retrieval_mode: SearchMode;
  /** 融合权重（默认 0.45 / 0.3 / 0.15 / 0.1 / 0）。 */
  retrieval_weights: RetrievalWeights;
  /** 本地 embedding 模型或外部模型名。 */
  embedding_model: string;
  /** 相似度 ≥ 该阈值时把新写入合并进已有记忆（0–1，默认 0.95）。 */
  merge_threshold: number;
  /** 相似度 ≥ 该阈值时视为重复、不再新增（0–1，默认 0.98）。 */
  dedupe_threshold: number;
  /** 写入后异步抽取实体（默认 true）。 */
  auto_extract_entities: boolean;
  /** PII 脱敏：off / basic（basic 保留后四位）。 */
  pii_redaction: 'off' | 'basic';
}

/** 分区设置入参：camelCase 与 snake_case 均可。 */
export interface PartitionSettingsInput {
  defaultScope?: MemoryScope;
  default_scope?: MemoryScope;
  briefMaxChars?: number;
  brief_max_chars?: number;
  briefEnabled?: boolean;
  brief_enabled?: boolean;
  dreamEnabled?: boolean;
  dream_enabled?: boolean;
  dreamIntervalMinutes?: number;
  dream_interval_minutes?: number;
  retentionDays?: number;
  retention_days?: number;
  monthlyQuota?: number;
  monthly_quota?: number;
  personAutoCreate?: boolean;
  person_auto_create?: boolean;
  locale?: string;
  /* --- v6.1 检索与写管线 --- */
  retrievalMode?: SearchMode;
  retrieval_mode?: SearchMode;
  retrievalWeights?: Partial<RetrievalWeights>;
  retrieval_weights?: Partial<RetrievalWeights>;
  embeddingModel?: string;
  embedding_model?: string;
  mergeThreshold?: number;
  merge_threshold?: number;
  dedupeThreshold?: number;
  dedupe_threshold?: number;
  autoExtractEntities?: boolean;
  auto_extract_entities?: boolean;
  /** v6.1 P2：PII 脱敏开关。 */
  piiRedaction?: 'off' | 'basic';
  pii_redaction?: 'off' | 'basic';
}

/** 分区头部聚合：列表页直接读 `partition_stats`，绝不 COUNT(*)。 */
export interface PartitionStats {
  partition_id: string;
  persons_total: number;
  persons_human: number;
  persons_agent: number;
  persons_service: number;
  memories_total: number;
  shared_total: number;
  sessions_total: number;
  updated_at: string;
}

/** 分区：App / 项目 / 租户 / 工作区。v6 的隔离边界。 */
export interface Partition {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string;
  status: PartitionStatus;
  settings: PartitionSettings;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  /** 列表/详情附带的分区统计（来自 partition_stats，O(1)）。 */
  stats?: PartitionStats;
}

/** 建 / 幂等 upsert 分区入参。 */
export interface PartitionInput {
  slug: string;
  name?: string;
  description?: string;
  status?: PartitionStatus;
  settings?: PartitionSettingsInput;
}

/* ------------------------------------------------------------------ */
/* 人（Person）                                                        */
/* ------------------------------------------------------------------ */

/**
 * 记忆的主体「人」：真人（App 用户 / 员工）或智能体。
 *
 * 与登录账号无关；`external_id` 由调用方定义（App 的 user_id、Agent 的 id/name）。
 * `memory_count` / `shared_memory_count` / `session_count` 为反规范化计数，列表页直接用。
 */
export interface Person {
  id: string;
  partition_id: string;
  external_id: string;
  type: PersonType;
  display_name: string;
  attributes: Record<string, unknown>;
  status: PersonStatus;
  /** scope=person + session 且属于本人的记忆数。 */
  memory_count: number;
  /** 该作者的 scope=partition 共享记忆数。 */
  shared_memory_count: number;
  session_count: number;
  last_memory_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  /* --- v6.1 P1/P2 生命周期与合规 --- */
  /** 合并后指向 canonical 人的内部 id；null=未合并。 */
  merged_into: string | null;
  /** 同意/合规标记（自由 JSON）；控制台与 v1 均可整体覆盖。 */
  consent: Record<string, unknown>;
  /** 软删除时间；null=未删除。 */
  deleted_at: string | null;
}

/** 建档 / 更新人入参。 */
export interface PersonInput {
  /** 外部 ID；`persons.upsert(partition, externalId, input)` 的路径参数优先。 */
  externalId?: string;
  external_id?: string;
  type?: PersonType;
  displayName?: string;
  display_name?: string;
  attributes?: Record<string, unknown>;
  status?: PersonStatus;
  /** v6.1 P2：同意/合规标记（整体覆盖）。 */
  consent?: Record<string, unknown>;
}

/** 局部更新人：只能更新展示名 / attributes / status / consent。 */
export interface PersonUpdateInput {
  displayName?: string;
  display_name?: string;
  attributes?: Record<string, unknown>;
  status?: PersonStatus;
  consent?: Record<string, unknown>;
}

/** 人列表查询（游标分页）。 */
export interface PersonListQuery {
  type?: PersonType;
  status?: PersonStatus;
  /** FTS5 前缀搜索显示名 / external_id。 */
  q?: string;
  sort?: PersonSort;
  cursor?: string;
  /** 默认 50，最大 200。 */
  limit?: number;
  /** 包含已合并（merged_into 非空）的人；默认排除 merged/deleted。 */
  includeMerged?: boolean;
  include_merged?: boolean;
}

/* ------------------------------------------------------------------ */
/* 会话（可选分组）                                                     */
/* ------------------------------------------------------------------ */

export interface Session {
  id: string;
  partition_id: string;
  person_id: string;
  title: string;
  status: 'active' | 'ended';
  started_at: string;
  ended_at?: string;
  metadata: Record<string, unknown>;
}

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

/** 多模态附件入参：媒体本体由调用方托管，这里只记录 URL 与元数据。 */
export interface MemoryAttachmentInput {
  kind: AttachmentKind;
  /** ≤2000 字符；配置 MNEMOS_ENCRYPTION_KEY 时服务端加密落库。 */
  url: string;
  mime?: string;
  size?: number;
  /** 附件描述；参与轻量检索（caption 关键词）。 */
  caption?: string;
}

/** 已落库的附件（读取视图）。 */
export interface MemoryAttachment extends MemoryAttachmentInput {
  id: string;
  memory_id: string;
  created_at: string;
}

/** 记忆实体。 */
export interface Memory {
  id: string;
  partition_id: string;
  /** 记忆主体（归属人，内部 id）——NOT NULL。 */
  person_id: string;
  /** 人的外部 ID（App user_id / Agent id），便于调用方直接比对。 */
  person_external_id: string | null;
  /** 写入者（可与人不同）。 */
  actor_person_id: string | null;
  scope: MemoryScope;
  session_id: string | null;
  category: MemoryCategory;
  content: string;
  importance: number;
  confidence: number;
  source: MemorySource;
  status: MemoryStatus;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  dreamed_at: string | null;
  /* --- v6.1 时序与演化 --- */
  /** 事实生效时间（默认=created_at）。 */
  valid_from: string | null;
  /** 失效时间；null=当前有效。 */
  valid_to: string | null;
  /** 被哪条记忆取代（内部 id）。 */
  superseded_by: string | null;
  /** 取代了哪条记忆（内部 id）。 */
  supersedes: string | null;
  /** 槽位键（如 preference.language）；同 key 新写入会自动取代旧事实。 */
  fact_key: string | null;
  /** 有帮助反馈计数。 */
  feedback_up: number;
  /** 没帮助反馈计数。 */
  feedback_down: number;
  /* --- v6.1 P2 多模态 --- */
  /** 附件数量（列表页按页批量统计，避免 N+1）。 */
  attachment_count: number;
  /** 附件明细（仅详情/写入响应返回）。 */
  attachments?: MemoryAttachment[];
}

/** 写入记忆入参（`text` / `content` / `messages` 至少一个）。 */
export interface MemoryInput {
  text?: string;
  content?: string;
  messages?: ChatMessage[];
  scope?: MemoryScope;
  sessionId?: string;
  session_id?: string;
  sessionTitle?: string;
  session_title?: string;
  category?: MemoryCategory;
  /** 0–1。 */
  importance?: number;
  /** 0–1。 */
  confidence?: number;
  source?: MemorySource;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
  expires_at?: string | null;
  /* --- v6.1 写管线 --- */
  /** 显式取代某条记忆（旧记忆 valid_to=now / superseded_by=new）。 */
  supersedesId?: string;
  supersedes_id?: string;
  /** 事实槽位键；同 key 的新写入自动取代旧事实。 */
  factKey?: string;
  fact_key?: string;
  /** 事实生效时间（ISO；缺省为服务端 now）。 */
  validFrom?: string;
  valid_from?: string;
  /** 多模态附件（≤10；url ≤2000）。 */
  attachments?: MemoryAttachmentInput[];
}

/** `MemoryInput` 的别名（与 shared 的 AddMemoryInput 语义一致）。 */
export type AddMemoryInput = MemoryInput;

/** 记忆列表查询（游标分页）。 */
export interface MemoryListQuery {
  /** 全局列表按内部人 ID 过滤。 */
  personId?: string;
  person_id?: string;
  /** 全局列表按人的外部 ID 过滤。 */
  personExternalId?: string;
  person_external_id?: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  status?: MemoryStatus;
  /** FTS5 前缀检索；空则按索引排序。 */
  q?: string;
  cursor?: string;
  /** 默认 50，最大 200。 */
  limit?: number;
}

/** 全文/混合检索入参（`POST .../memories/search`）。 */
export interface MemorySearchInput {
  query: string;
  /** 按人（内部 id）过滤。 */
  personId?: string;
  person_id?: string;
  /** 按人的外部 ID 过滤（与 personId 二选一）。 */
  personExternalId?: string;
  person_external_id?: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  /** 检索模式，缺省取分区设置（默认 hybrid）。 */
  mode?: SearchMode;
  /** 返回条数（1–50，默认 8）。 */
  topK?: number;
  top_k?: number;
  /** 回看某个时间点有效的事实（ISO 8601）。 */
  asOf?: string;
  as_of?: string;
  /** 包含已被取代/失效的记忆（默认 false）。 */
  includeSuperseded?: boolean;
  include_superseded?: boolean;
  /** 人级视角：只看本人 + 分区共享；控制台/审计可设 true 看全部。 */
  includePrivate?: boolean;
  include_private?: boolean;
}

/** 更新记忆入参：只发送提供的字段。 */
export interface MemoryUpdateInput {
  content?: string;
  category?: MemoryCategory;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
  expires_at?: string | null;
}

/** 记忆详情（含归属人）。 */
export interface MemoryDetail {
  memory: Memory;
  person: Person | null;
}

/** 写入记忆后返回的变更事件。 */
export interface MemoryEvent {
  type: 'ADD' | 'MERGE' | 'NOOP' | 'SUPERSEDE';
  memory_id: string;
  at: string;
}

/** 写入记忆响应。 */
export interface AddMemoryResponse {
  memory: Memory;
  /** v6.1：本次写入触发的动作（ADD 新增 / MERGE 合并 / NOOP 重复 / SUPERSEDE 取代）。 */
  event: 'ADD' | 'MERGE' | 'NOOP' | 'SUPERSEDE';
  /** 被取代的旧记忆 id（仅 SUPERSEDE）。 */
  superseded_id: string | null;
  events: MemoryEvent[];
}

/** 写入记忆响应的兼容别名。 */
export type MemoryAddResponse = AddMemoryResponse;

/** 单条命中的融合信号（0–1）。 */
export interface MemorySearchSignals {
  vector: number;
  keyword: number;
  recency: number;
  importance: number;
  entity: number;
}

/** 检索命中：记忆 + 融合分数 + 信号分解 + 命中来源。 */
export interface MemorySearchHit extends Memory {
  score: number;
  signals: MemorySearchSignals;
  /** 命中的信号/字段，如 `keyword` / `vector` / `caption`。 */
  matched_on: string[];
}

/**
 * 混合检索响应（`POST .../memories/search`）。
 *
 * v6.1 契约字段：`hits`（带 signals）/ `took_ms` / `mode` / `strategy`；
 * `results` 是 v6 兼容别名（等价于 `hits` 去掉 signals），保留以兼容旧调用方。
 */
export interface SearchResponse {
  hits: MemorySearchHit[];
  /** @deprecated v6 兼容字段；请改用 `hits`。 */
  results: Memory[];
  took_ms: number;
  mode: SearchMode;
  /** 服务端实际采用的检索策略（如 `hybrid:vector+keyword+recency`）。 */
  strategy: string;
  next_cursor: string | null;
  partition_stats?: PartitionStats;
}

/** 记忆更新 / 反馈响应（`PATCH` / `feedback` 返回 `{ memory }`）。 */
export interface MemoryMutationResponse {
  memory: Memory;
}

/* ------------------------------------------------------------------ */
/* v6.1：历史 / 反馈                                                    */
/* ------------------------------------------------------------------ */

/** 记忆变更事件类型。 */
export type MemoryHistoryEvent =
  | 'ADD'
  | 'UPDATE'
  | 'MERGE'
  | 'SUPERSEDE'
  | 'DELETE'
  | 'NOOP'
  | 'FEEDBACK'
  | 'RESTORE';

/** 逐条记忆的变更历史（`GET .../memories/:id/history`）。 */
export interface MemoryHistoryEntry {
  id: string;
  partition_id: string;
  memory_id: string;
  person_id: string | null;
  event: MemoryHistoryEvent;
  old_content: string | null;
  new_content: string | null;
  actor: string | null;
  reason: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

/** 检索反馈入参。 */
export interface MemoryFeedbackInput {
  /** true=有帮助（confidence +0.05）；false=没帮助（confidence -0.05）。 */
  helpful: boolean;
  /** 触发本次反馈的查询（可选，用于后续分析）。 */
  query?: string;
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* v6.1 P1：结构化画像 / 生命周期                                       */
/* ------------------------------------------------------------------ */

/** 结构化画像中的一条事实槽位。 */
export interface PersonFact {
  id: string;
  partition_id: string;
  person_id: string;
  /** 槽位键（如 identity.job / preference.language）。 */
  key: string;
  value: string;
  /** 0–1，默认 0.7。 */
  confidence: number;
  valid_from: string;
  /** null=当前有效；非空=已被新版本关闭。 */
  valid_to: string | null;
  source_memory_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 写入 / 更新单条 fact 的入参。 */
export interface PersonFactInput {
  key: string;
  value: string;
  confidence?: number;
  sourceMemoryId?: string;
  source_memory_id?: string;
}

/** 人的画像：资料 + 当前有效 facts + 摘要（异步生成，可缓存）。 */
export interface PersonProfile {
  person: Person;
  facts: PersonFact[];
  summary: string;
  generated_at: string | null;
  /** 本次是否直接命中 person_profiles 缓存。 */
  cached?: boolean;
}

/** 画像查询：`force` / `refresh` 跳过缓存重新生成。 */
export interface PersonProfileQuery {
  force?: boolean;
  refresh?: boolean;
}

/** 合并两个人后的结果。 */
export interface PersonMergeResult {
  /** canonical（目标）人。 */
  person: Person;
  /** 被合并（源）人，已归档且 merged_into 指向目标。 */
  merged_from: Person;
  moved_memories: number;
  moved_facts: number;
}

/** 合并入参：目标可用内部 id 或 external id。 */
export interface PersonMergeInput {
  targetId?: string;
  target_id?: string;
  targetExternalId?: string;
  target_external_id?: string;
}

/** 合规导出：人 + facts（含历史版本）+ 最近 10000 条记忆。 */
export interface PersonExport {
  person: Person;
  facts: PersonFact[];
  memories: Memory[];
  exported_at: string;
  /** 记忆超过 10000 条时为 true。 */
  truncated: boolean;
}

/** 删除人：默认软删（记忆/facts 保留）；hard=true 级联物理删除（仅 owner/admin key）。 */
export interface PersonRemoveOptions {
  hard?: boolean;
}

/* ------------------------------------------------------------------ */
/* v6.1 P2：实体 / 关系图                                               */
/* ------------------------------------------------------------------ */

/** 图节点（实体）。 */
export interface EntityGraphNode {
  id: string;
  label: string;
  type: string;
  /** 实体权重（分区内被提及次数 / 关联记忆累计 salience）。 */
  weight: number;
  /** 关联记忆数。 */
  memories: number;
}

/** 图边（关系）。 */
export interface EntityGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
}

/** 实体类型计数。 */
export interface EntityGraphTypeCount {
  type: string;
  count: number;
}

/** 图统计。 */
export interface EntityGraphStats {
  nodes: number;
  edges: number;
  top_types: EntityGraphTypeCount[];
}

/** 分区/人的实体关系图。 */
export interface EntityGraph {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
  stats: EntityGraphStats;
}

/** 图查询：personId 缺省为分区级图；limit 默认 100、最大 500。 */
export interface EntityGraphQuery {
  personId?: string;
  person_id?: string;
  limit?: number;
}

/** 实体列表项。 */
export interface EntitySummary {
  id: string;
  name: string;
  type: string;
  mention_count: number;
  memories: number;
  created_at: string;
}

/** 实体列表查询。 */
export interface EntityListQuery {
  personId?: string;
  person_id?: string;
  q?: string;
  /** 默认 50、最大 200。 */
  limit?: number;
}

/** 实体列表响应（`{ items, next_cursor }`）。 */
export interface EntityList {
  items: EntitySummary[];
  next_cursor: string | null;
}

/* ------------------------------------------------------------------ */
/* 游标分页                                                            */
/* ------------------------------------------------------------------ */

/**
 * 统一列表协议：`{ items, next_cursor, partition_stats? }`。
 *
 * 不返回 total；头部统计读 `partition_stats`。把响应里的 `next_cursor`
 * 传给下一次请求的 `cursor` 即可继续翻页，`null` 表示没有更多。
 */
export interface CursorPage<T> {
  items: T[];
  next_cursor: string | null;
  partition_stats?: PartitionStats;
}

/* ------------------------------------------------------------------ */
/* 记忆简报（brief）/ 上下文（context）/ 做梦（dream）                  */
/* ------------------------------------------------------------------ */

/** 简报中引用的记忆摘要。 */
export interface MemoryBriefItem {
  id: string;
  content: string;
  category: MemoryCategory;
  importance: number;
  scope: MemoryScope;
  updated_at: string;
  person_id: string;
  person_external_id: string | null;
}

/** 记忆简报：最近的活跃记忆压缩成有字符上限、可直接注入提示词的文本。 */
export interface MemoryBrief {
  partition_id: string;
  /** 人级简报时带上该人（内部 id）；分区级为 null。 */
  person_id: string | null;
  scope_key: string;
  text: string;
  max_chars: number;
  count: number;
  /** `mnemos-condense`（确定性压缩）或实际 LLM 模型名。 */
  model: string;
  /** 是否命中缓存。 */
  cached: boolean;
  source_hash: string;
  generated_at: string;
  recent: MemoryBriefItem[];
}

/** 人级简报（等价于 {@link MemoryBrief}）。 */
export type PersonBrief = MemoryBrief;

/** 人级简报查询。 */
export interface PersonBriefQuery {
  /** 忽略缓存、重新生成。 */
  force?: boolean;
  /** 覆盖分区设置里的字符上限（不落库，100–5000）。 */
  maxChars?: number;
  max_chars?: number;
}

/** 人的上下文入参：资料 + 人的简报 + 相关记忆 +（可选）分区共享知识。 */
export interface PersonContextInput {
  query?: string;
  budgetTokens?: number;
  budget_tokens?: number;
  /** 是否带上分区共享知识（默认为服务端设置）。 */
  includePartition?: boolean;
  include_partition?: boolean;
}

/** 人的上下文：可直接注入提示词的资料 + 简报 + 记忆 + prompt。 */
export interface PersonContext {
  person: Person;
  brief: MemoryBrief;
  /** 与 query 最相关、且属于该人的记忆。 */
  memories: Memory[];
  /** 分区共享知识（scope=partition）。 */
  shared: Memory[];
  prompt: string;
  token_estimate: number;
  citations: string[];
  built_at: string;
}

/** 一次做梦（增量记忆巩固）的运行记录。 */
export interface MemoryDreamRun {
  id: string;
  partition_id: string;
  /** 人级做梦时的归属人（内部 id）；分区级为 null。 */
  person_id: string | null;
  trigger: MemoryDreamTrigger;
  status: MemoryDreamRunStatus;
  input_count: number;
  insight_count: number;
  summary?: string | null;
  error?: string | null;
  started_at: string;
  finished_at: string | null;
}

/** 做梦运行记录（类型别名，便于直接用 `DreamRun`）。 */
export type DreamRun = MemoryDreamRun;

/** 分区级做梦设置。 */
export interface MemoryDreamSettings {
  enabled: boolean;
  interval_minutes: number;
  last_at: string | null;
}

/** 做梦状态：设置 + 待整理数 + 最近运行记录。 */
export interface MemoryDreamStatus {
  settings: MemoryDreamSettings;
  person_id: string | null;
  pending_count: number;
  last_run: MemoryDreamRun | null;
  runs: MemoryDreamRun[];
}

/** 做梦状态别名。 */
export type DreamStatus = MemoryDreamStatus;

/** 手动触发一次做梦的入参。 */
export interface MemoryDreamInput {
  /** 单批最多处理的记忆条数（1–200，默认 50）。 */
  batchSize?: number;
  batch_size?: number;
}

/** 手动触发做梦的入参别名。 */
export type DreamRunInput = MemoryDreamInput;

/** 一次做梦的结果：运行记录 + 最新状态。 */
export interface MemoryDreamResult {
  run: MemoryDreamRun | null;
  status: MemoryDreamStatus;
}

/** 做梦结果别名。 */
export type DreamResult = MemoryDreamResult;

/* ------------------------------------------------------------------ */
/* API Key（分区 / 组织）                                               */
/* ------------------------------------------------------------------ */

/** API Key 摘要（不含密钥本身）。 */
export interface ApiKey {
  id: string;
  /** 分区 key 绑定的分区；org key 为 null。 */
  partition_id: string | null;
  /** org key 所属组织；分区 key 为 null。 */
  org_id: string | null;
  kind: ApiKeyKind;
  name: string;
  /** 展示用前缀，例如 `mnemos_live_ab12`。 */
  prefix: string;
  scopes: ApiScope[];
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  allowed_ips: string[];
  rotated_from: string | null;
  rotated_at: string | null;
  rate_limit_per_min: number;
  /** 仅在创建 / 轮换响应中出现一次。 */
  secret?: string;
}

/** API Key 别名。 */
export type Key = ApiKey;

/** 创建 API Key 入参。 */
export interface KeyInput {
  name: string;
  scopes: ApiScope[];
  rateLimitPerMin?: number;
  rate_limit_per_min?: number;
  expiresAt?: string;
  expires_at?: string;
  allowedIps?: string[];
  allowed_ips?: string[];
}

/** 轮换 API Key 入参。 */
export interface KeyRotateInput {
  /** 仅用于审计记录；v6 会立即吊销旧 key（0–168）。 */
  graceHours?: number;
  grace_hours?: number;
}

/* ------------------------------------------------------------------ */
/* 用量 / 审计（控制台 /api 视图）                                      */
/* ------------------------------------------------------------------ */

/** 每日用量点。 */
export interface UsagePoint {
  date: string;
  adds: number;
  searches: number;
  retrievals: number;
  tokens: number;
  errors: number;
}

/** 用量分组行。 */
export interface UsageBreakdownRow {
  label: string;
  count: number;
  share: number;
  latency_p50?: number;
}

/** 分区用量分析（控制台）。 */
export interface UsageAnalytics {
  points: UsagePoint[];
  by_operation: UsageBreakdownRow[];
  by_channel: UsageBreakdownRow[];
  by_key: UsageBreakdownRow[];
  latency: { p50: number; p95: number; p99: number };
  totals: {
    adds: number;
    searches: number;
    retrievals: number;
    tokens: number;
    errors: number;
    error_rate: number;
  };
}

/** 用量分析别名。 */
export type Usage = UsageAnalytics;

/** 审计日志条目。 */
export interface AuditLog {
  id: string;
  org_id?: string;
  partition_id?: string;
  actor_type: 'user' | 'api_key' | 'system';
  actor_id?: string;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  detail: Record<string, unknown>;
  ip?: string;
  user_agent?: string;
  created_at: string;
}

/** 审计日志别名。 */
export type Audit = AuditLog;

/* ------------------------------------------------------------------ */
/* 健康检查                                                            */
/* ------------------------------------------------------------------ */

/** `GET /health` 响应。 */
export interface HealthResponse {
  ok: boolean;
  version: string;
  uptime_ms: number;
  schema_version: number;
  db: 'ok' | 'error';
  node: string;
}

/* ------------------------------------------------------------------ */
/* 客户端入参 / 错误体                                                  */
/* ------------------------------------------------------------------ */

/** 单个请求的可选参数。 */
export interface RequestOptions {
  /**
   * 幂等键（8–128 字符）。v6.1 服务端会持久化 24 小时：
   * 相同 key + 相同方法/路径/请求体直接回放首次响应，不同 body 返回 409。
   * 传了该键后，非只读 POST（写记忆等）发生 429/5xx/网络错误时可安全自动重试。
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
  /**
   * 访问令牌。
   *
   * - 公开 v1（分区/人/记忆/简报/做梦/health）传 `mnemos_live_*` API Key；
   * - 控制台端点（`client.keys.*`）传控制台会话 token。
   */
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
