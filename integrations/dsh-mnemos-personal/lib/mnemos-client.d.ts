/**
 * Mnemos v6 中立 REST 客户端（`/v1/partitions/:partition/...`，org key 鉴权，snake_case 入参）。
 *
 * 契约来源：本仓库 `docs/v6-architecture.md` 第 3 节「API（v6，干净面）」：
 * - 鉴权：`Authorization: Bearer mnemos_live_*`；org key 可访问/创建本组织任意分区。
 * - 端点默认挂在 `/v1/partitions/:partition/...`，`:partition` 支持分区 id 或 slug。
 * - JSON 一律 snake_case。
 * - 人 / 记忆列表统一**游标分页**：响应 `{ items, next_cursor, partition_stats }`，
 *   不返回 total（百万级不 COUNT(*)）；`limit` 默认 50、上限 200。
 * - 错误体沿用旧约定：`{ error: { code, message, details?, requestId } }`，
 *   `x-request-id` 响应头里也有同一个 id。
 *
 * 本插件只负责「分区 + 人 + 记忆 + 简报 / 上下文 / 做梦」这几条链路；所有失败都归一成
 * {@link MnemosApiError}（带 `status` / `code` / `action`），工具层再转成
 * `{ ok:false, error, action }`，`execute()` 永远不抛异常。
 *
 * 响应解析刻意宽容：服务端可能用 `{ items }` 或 `{ results }` / 裸数组，单条写入可能返回
 * `{ items:[...] }` / `{ memory }` / 裸记忆对象；这里统一归一，避免一次后端小改动就让读路径全挂。
 */
import type { MnemosConfig, PersonType } from './config.js';
/** 记忆可见范围（v6 语义：person=仅该人、partition=分区共享、session=仅当前会话）。 */
export type MemoryScope = 'person' | 'partition' | 'session';
/** 单次 HTTP 请求缺省超时（毫秒）。 */
export declare const DEFAULT_TIMEOUT_MS = 15000;
/** 检索缺省条数（服务端上限 50）。 */
export declare const DEFAULT_TOP_K = 8;
/** 检索条数上限（服务端 top_k 上限）。 */
export declare const MAX_TOP_K = 50;
/** 列表缺省条数（v6 游标分页：默认 50）。 */
export declare const DEFAULT_LIST_LIMIT = 50;
/** 列表条数上限（v6 游标分页：最大 200）。 */
export declare const MAX_LIST_LIMIT = 200;
/** 人列表排序（v6：recent / name / new，各有索引）。 */
export type PersonSort = 'recent' | 'name' | 'new';
/** 一条记忆（v6 读视图；`content` 是正文，`person_id` 是归属人的内部 id）。 */
export interface MnemosMemory {
    id?: string;
    content?: string;
    /** 旧读视图兼容字段（同 content）。 */
    memory?: string;
    person_id?: string | null;
    person_external_id?: string | null;
    actor_person_id?: string | null;
    scope?: MemoryScope;
    session_id?: string | null;
    category?: string;
    importance?: number;
    confidence?: number;
    source?: string;
    status?: string;
    tags?: string[];
    metadata?: Record<string, unknown> | null;
    created_at?: string;
    updated_at?: string;
    expires_at?: string | null;
    dreamed_at?: string | null;
    /** 仅搜索结果带：融合分与逐信号分解。 */
    score?: number;
    signals?: Record<string, number>;
    matched_on?: string[];
    [key: string]: unknown;
}
/** 一个人（v6：计数反规范化在 persons 行上，列表不再逐行查 stats）。 */
export interface MnemosPerson {
    id?: string;
    external_id?: string;
    type?: string;
    display_name?: string;
    attributes?: Record<string, unknown>;
    status?: string;
    /** scope=person + session 属于本人的记忆数。 */
    memory_count?: number;
    /** 该人写的 scope=partition 记忆数。 */
    shared_memory_count?: number;
    session_count?: number;
    last_memory_at?: string | null;
    first_seen_at?: string | null;
    last_seen_at?: string | null;
    created_at?: string;
    updated_at?: string;
    [key: string]: unknown;
}
/** 分区（v6：取代 projects，命名正式改为 partitions）。 */
export interface MnemosPartition {
    id?: string;
    slug?: string;
    name?: string;
    description?: string;
    status?: string;
    settings?: Record<string, unknown>;
    [key: string]: unknown;
}
/** 分区统计（v6：直接读 partition_stats 表，O(1)）。 */
export interface MnemosPartitionStats {
    partition_id?: string;
    persons_total?: number;
    persons_human?: number;
    persons_agent?: number;
    persons_service?: number;
    memories_total?: number;
    shared_total?: number;
    sessions_total?: number;
    updated_at?: string;
    [key: string]: unknown;
}
/** 人的简报（`GET /v1/partitions/:p/persons/:person/brief`）。 */
export interface MnemosBrief {
    person_id?: string;
    text?: string;
    max_chars?: number;
    model?: string;
    source_hash?: string;
    generated_at?: string;
    cached?: boolean;
    count?: number;
    recent?: MnemosMemory[];
    [key: string]: unknown;
}
/** 人的上下文（`POST /v1/partitions/:p/persons/:person/context`）。 */
export interface MnemosPersonContext {
    person?: MnemosPerson;
    brief?: MnemosBrief;
    memories?: MnemosMemory[];
    shared?: MnemosMemory[];
    /** 可直接注入提示词的中文 Markdown。 */
    prompt?: string;
    token_estimate?: number;
    citations?: string[];
    built_at?: string;
    [key: string]: unknown;
}
/** v6 游标分页响应（归一后）。 */
export interface CursorPage<T> {
    items: T[];
    /** 下一页游标；没有更多时缺省。 */
    next_cursor?: string;
    /** 头部统计（服务端直接读 partition_stats，避免 COUNT(*)）。 */
    partition_stats?: Record<string, unknown>;
    /** 原始响应（调试 / 兼容用）。 */
    raw: unknown;
}
/** 写记忆的结果（v6 人级端点；服务端可能返回单条或列表）。 */
export interface MemoryWriteResult {
    memories: MnemosMemory[];
    events: unknown[];
    raw: unknown;
}
/** 检索结果（v6：优先专用检索端点，缺省时退化为记忆列表的 `q` 全文搜索）。 */
export interface MemorySearchResult {
    results: MnemosMemory[];
    took_ms?: number;
    next_cursor?: string;
    raw: unknown;
}
/** 客户端错误统一形状。 */
export interface MnemosApiErrorInit {
    message: string;
    /** HTTP 状态码；网络层失败时为 undefined。 */
    status?: number;
    /** 服务端 `error.code`，或本地错误码（network_error / timeout / missing_api_key …）。 */
    code?: string;
    /** 建议的下一步动作（工具层原样透传给模型）。 */
    action?: string;
    requestId?: string;
    details?: unknown;
    method?: string;
    path?: string;
}
/** 请求失败（非 2xx、网络错误、配置缺失）。 */
export declare class MnemosApiError extends Error {
    readonly status?: number;
    readonly code: string;
    readonly action: string;
    readonly requestId?: string;
    readonly details?: unknown;
    readonly method?: string;
    readonly path?: string;
    constructor(init: MnemosApiErrorInit);
}
/** 请求超时（继承 MnemosApiError，`code === 'timeout'`）。 */
export declare class MnemosTimeoutError extends MnemosApiError {
    readonly timeoutMs: number;
    constructor(timeoutMs: number, method: string, path: string);
}
/** 分区的本地视图（缓存用）：id 可能未知（服务端未返回时回落到 slug）。 */
export interface PartitionInfo {
    slug: string;
    name: string;
    id?: string;
    raw?: unknown;
}
/** 人的本地视图（缓存用）。 */
export interface PersonInfo {
    externalId: string;
    id?: string;
    type?: string;
    raw?: unknown;
}
/** 客户端可选项（超时覆盖仅供测试/特殊部署使用）。 */
export interface MnemosClientOptions {
    timeoutMs?: number;
}
/** 写记忆的请求体（由工具层组装；person 在路径里，不重复进 body）。 */
export interface AddMemoryBody {
    text?: string;
    /** 记忆正文别名（与 text 二选一；占位符协议示例用 content）。 */
    content?: string;
    messages?: Array<{
        role: string;
        content: string;
    }>;
    scope?: MemoryScope;
    session_id?: string;
    category?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    /** 占位符映射：正文里的 `{{key}}` → 真实值；正文只存 token，值由服务端加密保存。 */
    placeholders?: Record<string, string>;
}
/** 检索的请求体。 */
export interface SearchMemoriesBody {
    query: string;
    person_id?: string;
    scope?: MemoryScope;
    category?: string;
    top_k?: number;
}
/** 人列表查询（v6 游标分页 + FTS 前缀搜索 + 类型/状态筛选 + 排序）。 */
export interface PersonListQuery {
    cursor?: string;
    limit?: number;
    q?: string;
    type?: string;
    status?: string;
    sort?: PersonSort;
}
/** 记忆列表查询（v6 游标分页；person_id / scope / category / q 全文搜索）。 */
export interface MemoryListQuery {
    cursor?: string;
    limit?: number;
    person_id?: string;
    scope?: MemoryScope;
    category?: string;
    q?: string;
}
/** 更新人资料的请求体（PATCH；只发显式给出的字段）。 */
export interface PersonUpdateBody {
    type?: PersonType;
    display_name?: string;
    attributes?: Record<string, unknown>;
    status?: string;
}
/**
 * 看起来像分区的内部 id（v6 `ptn_*`；旧 `prj_*`）。
 * 这种引用必须直接 GET，不能拿去 `POST /v1/partitions {slug}` 当成新 slug upsert。
 */
export declare function looksLikePartitionId(value: string): boolean;
/** 从 `{ partition }` / 裸分区对象提取分区视图。 */
export declare function extractPartition(payload: unknown, fallbackSlug: string, fallbackName?: string): PartitionInfo;
/** 从 `{ person }` / 裸人对象提取人的视图。 */
export declare function extractPerson(payload: unknown, fallbackExternalId: string): PersonInfo;
/**
 * 从列表响应里取数组：容忍 `items`（v6）/ `results` / 裸数组。
 * 单条响应（`{ memory }` / 裸记忆对象）也会被归一成单元素数组。
 */
export declare function extractMemories(payload: unknown): MnemosMemory[];
/** 从响应里取人数组：容忍 `items` / `results` / `persons` / `people` / 裸数组。 */
export declare function extractPeople(payload: unknown): MnemosPerson[];
/** 把 v6 列表响应归一成 `{ items, next_cursor, partition_stats }`。 */
export declare function extractCursorPage<T>(payload: unknown, ...itemKeys: string[]): CursorPage<T>;
/** 分区统计响应：容忍 `{ stats }` / `{ partition_stats }` / 裸对象。 */
export declare function extractStats(payload: unknown): Record<string, unknown>;
/**
 * 读取活配置的 Mnemos 客户端：每次请求都重新解析配置，
 * 因此设置页改动（baseUrl / orgApiKey / personId …）无需重建客户端或重挂工具。
 */
export declare class MnemosClient {
    private readonly config;
    private readonly timeoutMs;
    /** slug → 分区视图（首次 ensure 成功后缓存，进程内不再重复 POST）。 */
    private readonly partitionCache;
    /** slug → 进行中的 ensure（并发工具调用只发一次 POST）。 */
    private readonly partitionInflight;
    /** `${分区引用}\0${externalId}` → 人视图（首次 PUT 成功后缓存）。 */
    private readonly personCache;
    constructor(config: () => MnemosConfig, options?: MnemosClientOptions);
    /** 配置里的服务地址（规范化去尾斜杠，不校验可用性；状态自检用）。 */
    resolvedBaseUrl(): string;
    /** 当前是否配置了 org API Key（只报布尔，绝不返回密钥）。 */
    isApiKeyConfigured(): boolean;
    /** 生效超时（毫秒）。 */
    getTimeoutMs(): number;
    /** 分区路径前缀：`/v1/partitions/:partition`（:partition 支持 id 或 slug）。 */
    private partitionPath;
    /** 发一个请求：拼 URL、鉴权、超时、解析错误体（不重试，写接口幂等性由服务端保证）。 */
    private request;
    /**
     * 确保分区存在（首次 `POST /v1/partitions`，服务端按 slug 幂等 upsert），并缓存结果。
     *
     * - 并发调用共享同一个 in-flight Promise，避免同一分区重复 POST；
     * - 服务端返回 409 时退回 `GET /v1/partitions/:slug`；
     * - 响应没带内部 id 时补一次 GET，以便路径优先用 id（服务端两者都支持）。
     *
     * @param slug 分区 slug（workspace 模式为 `ws-<basename>-<hash8>`）。
     * @param name 分区展示名（缺省同 slug）。
     * @returns 分区视图（至少含 slug / name）。
     */
    ensurePartition(slug: string, name?: string): Promise<PartitionInfo>;
    private doEnsurePartition;
    /** `GET /v1/partitions/:partition` —— 分区信息（含 settings）。 */
    getPartition(partitionRef: string): Promise<unknown>;
    /** `GET /v1/partitions/:partition/stats` —— 分区统计（直接读 partition_stats）。 */
    getPartitionStats(partitionRef: string): Promise<Record<string, unknown>>;
    /** 清空缓存（测试 / 配置切换后强制重新 ensure）。 */
    clearCache(): void;
    /**
     * 确保人存在（`PUT /v1/partitions/:p/persons/:externalId`，服务端 lazy upsert），并缓存。
     *
     * @param partitionRef 分区 slug 或 id。
     * @param externalId 人的 external_id（App user_id / agent id）。
     * @param options 可选类型 / 展示名 / 属性（只发显式给出的字段，避免覆盖已有资料）。
     * @returns 人视图（至少含 externalId）。
     */
    ensurePerson(partitionRef: string, externalId: string, options?: {
        type?: PersonType;
        displayName?: string;
        attributes?: Record<string, unknown>;
    }): Promise<PersonInfo>;
    /** `GET /v1/partitions/:p/persons/:person` —— 人详情（计数在 persons 行上）。 */
    getPerson(partitionRef: string, personRef: string): Promise<unknown>;
    /** `PATCH /v1/partitions/:p/persons/:person` —— 更新展示名 / 类型 / 属性 / 状态。 */
    updatePerson(partitionRef: string, personRef: string, body: PersonUpdateBody): Promise<unknown>;
    /** `GET /v1/partitions/:p/persons` —— 人列表（游标分页 + q / type / status / sort）。 */
    listPersons(partitionRef: string, query?: PersonListQuery): Promise<CursorPage<MnemosPerson>>;
    /** `GET /v1/partitions/:p/persons/:person/brief` —— 人的简报。 */
    getPersonBrief(partitionRef: string, personRef: string): Promise<unknown>;
    /** `POST /v1/partitions/:p/persons/:person/context` —— 人的上下文（含可直接注入的 prompt）。 */
    getPersonContext(partitionRef: string, personRef: string, body?: Record<string, unknown>): Promise<unknown>;
    /** `GET /v1/partitions/:p/persons/:person/dream` —— 人级做梦状态。 */
    getPersonDream(partitionRef: string, personRef: string): Promise<unknown>;
    /** `POST /v1/partitions/:p/persons/:person/dream/run` —— 触发人级做梦。 */
    runPersonDream(partitionRef: string, personRef: string, body?: Record<string, unknown>): Promise<unknown>;
    /** `POST /v1/partitions/:p/persons/:person/memories` —— 给该人写记忆（person 在路径里）。 */
    addMemory(partitionRef: string, personRef: string, body: AddMemoryBody): Promise<MemoryWriteResult>;
    /** `GET /v1/partitions/:p/persons/:person/memories` —— 该人记忆：游标分页 + scope/category。 */
    listPersonMemories(partitionRef: string, personRef: string, query?: MemoryListQuery): Promise<CursorPage<MnemosMemory>>;
    /** `GET /v1/partitions/:p/memories` —— 记忆全局列表（person_id / scope / category / q，游标分页）。 */
    listMemories(partitionRef: string, query?: MemoryListQuery): Promise<CursorPage<MnemosMemory>>;
    /**
     * 检索记忆。
     *
     * v6 的检索就是「记忆列表 + `q`」（FTS 前缀），`POST .../memories/search` 是官方兼容端点
     * （v6 后端返回 `{ results, took_ms, next_cursor, partition_stats }`）。注意它的 `person_id`
     * 是**作者过滤**而不是「该人可见」：默认检索（未指定 scope）要取两次 —— 本人记忆 + 分区共享 ——
     * 再按 id 去重，才与工具承诺的「该人可见 + 分区共享知识」一致。
     */
    searchMemories(partitionRef: string, body: SearchMemoriesBody): Promise<MemorySearchResult>;
    /** 单次检索：优先 `POST .../memories/search`，端点不存在时退化为 `GET .../memories?q=`。 */
    private searchOnce;
    /** `GET /v1/partitions/:p/memories/:id` —— 记忆详情。 */
    getMemory(partitionRef: string, id: string): Promise<unknown>;
}
