/**
 * Mnemos 新版中立 REST 客户端（`/v1/partitions/:partition/...`，org key 鉴权，snake_case 入参）。
 *
 * 契约来源：本仓库 `docs/neutral-memory-model.md` 第 5 节「API（v1 中立面）」：
 * - 鉴权：`Authorization: Bearer mnemos_live_*`；org key 可访问/创建本组织任意分区。
 * - 端点默认挂在 `/v1/partitions/:partition/...`，`:partition` 支持分区 id 或 slug。
 * - JSON 一律 snake_case。
 * - 错误体沿用旧约定：`{ error: { code, message, details?, requestId } }`，
 *   `x-request-id` 响应头里也有同一个 id。
 *
 * 本插件只负责「分区 + 人 + 记忆 + 简报 / 上下文」这几条链路；所有失败都归一成
 * {@link MnemosApiError}（带 `status` / `code` / `action`），工具层再转成
 * `{ ok:false, error, action }`，`execute()` 永远不抛异常。
 */
import type { MnemosConfig, PersonType } from './config.js';
/** 记忆可见范围（v5 语义：person=仅该人、partition=分区共享、session=仅当前会话）。 */
export type MemoryScope = 'person' | 'partition' | 'session';
/** 单次 HTTP 请求缺省超时（毫秒）。 */
export declare const DEFAULT_TIMEOUT_MS = 15000;
/** 检索缺省条数（服务端上限 50）。 */
export declare const DEFAULT_TOP_K = 8;
/** 记忆条数上限（服务端 top_k 上限）。 */
export declare const MAX_TOP_K = 50;
/** 一条记忆（v5 读视图；同时容忍旧 camelCase 字段，渲染层两者都认）。 */
export interface MnemosMemory {
    id?: string;
    /** 旧 v1 读视图字段。 */
    memory?: string;
    /** 创建响应 / v5 字段。 */
    content?: string;
    person_id?: string | null;
    personId?: string | null;
    person_external_id?: string | null;
    personExternalId?: string | null;
    actor_person_id?: string | null;
    session_id?: string | null;
    sessionId?: string | null;
    scope?: MemoryScope;
    category?: string;
    importance?: number;
    confidence?: number;
    source?: string;
    status?: string;
    tags?: string[];
    metadata?: Record<string, unknown> | null;
    created_at?: string;
    createdAt?: string;
    updated_at?: string;
    updatedAt?: string;
    last_accessed_at?: string | null;
    access_count?: number;
    accessCount?: number;
    /** 仅搜索结果带：融合分与逐信号分解。 */
    score?: number;
    signals?: Record<string, number>;
    matched_on?: string[];
    [key: string]: unknown;
}
/** 一条记忆（v5「人」）。 */
export interface MnemosPerson {
    id?: string;
    external_id?: string;
    externalId?: string;
    type?: string;
    display_name?: string;
    displayName?: string;
    status?: string;
    attributes?: Record<string, unknown>;
    first_seen_at?: string;
    last_seen_at?: string;
    created_at?: string;
    updated_at?: string;
    stats?: {
        memories?: number;
        shared_memories?: number;
        sharedMemories?: number;
        sessions?: number;
        last_memory_at?: string;
        lastMemoryAt?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
/** 分区（v5；存储上仍是旧 projects 表）。 */
export interface MnemosPartition {
    id?: string;
    partition_id?: string;
    project_id?: string;
    slug?: string;
    name?: string;
    description?: string;
    [key: string]: unknown;
}
/** 人的简报（`GET /v1/partitions/:p/persons/:person/brief`）。 */
export interface MnemosBrief {
    person_id?: string;
    personId?: string;
    text?: string;
    max_chars?: number;
    maxChars?: number;
    count?: number;
    model?: string;
    cached?: boolean;
    generated_at?: string;
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
    tokenEstimate?: number;
    citations?: string[];
    built_at?: string;
    [key: string]: unknown;
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
/** 写记忆的请求体（由工具层组装；只发显式给出的字段）。 */
export interface AddMemoryBody {
    text?: string;
    messages?: Array<{
        role: string;
        content: string;
    }>;
    person_id?: string;
    person_external_id?: string;
    scope?: MemoryScope;
    session_id?: string;
    category?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    infer?: boolean;
}
/** 检索的请求体。 */
export interface SearchMemoriesBody {
    query: string;
    person_id?: string;
    scope?: MemoryScope;
    category?: string;
    top_k?: number;
}
/** 从 `{ partition }` / 裸分区对象提取分区视图。 */
export declare function extractPartition(payload: unknown, fallbackSlug: string, fallbackName?: string): PartitionInfo;
/** 从 `{ person }` / 裸人对象提取人的视图。 */
export declare function extractPerson(payload: unknown, fallbackExternalId: string): PersonInfo;
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
    /** `${分区 slug}\0${externalId}` → 人视图（首次 PUT 成功后缓存）。 */
    private readonly personCache;
    constructor(config: () => MnemosConfig, options?: MnemosClientOptions);
    /** 配置里的服务地址（规范化去尾斜杠，不校验可用性；状态自检用）。 */
    resolvedBaseUrl(): string;
    /** 当前是否配置了 org API Key（只报布尔，绝不返回密钥）。 */
    isApiKeyConfigured(): boolean;
    /** 生效超时（毫秒）。 */
    getTimeoutMs(): number;
    /** 分区路径前缀：`/v1/partitions/:partition`。 */
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
    /** `GET /v1/partitions/:partition` —— 分区信息。 */
    getPartition(partitionRef: string): Promise<unknown>;
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
    /** `GET /v1/partitions/:p/persons/:person` —— 人详情 + 统计。 */
    getPerson(partitionRef: string, personRef: string): Promise<unknown>;
    /** `GET /v1/partitions/:p/persons` —— 人列表（type / status / q / 分页）。 */
    listPersons(partitionRef: string, query?: {
        type?: string;
        status?: string;
        q?: string;
        page?: number;
        page_size?: number;
    }): Promise<unknown>;
    /** `GET /v1/partitions/:p/persons/:person/brief` —— 人的简报。 */
    getPersonBrief(partitionRef: string, personRef: string): Promise<unknown>;
    /** `POST /v1/partitions/:p/persons/:person/context` —— 人的上下文（含可直接注入的 prompt）。 */
    getPersonContext(partitionRef: string, personRef: string, body?: Record<string, unknown>): Promise<unknown>;
    /** `POST /v1/partitions/:p/memories` —— 写记忆。 */
    addMemory(partitionRef: string, body: AddMemoryBody): Promise<unknown>;
    /** `POST /v1/partitions/:p/memories/search` —— 检索。 */
    searchMemories(partitionRef: string, body: SearchMemoriesBody): Promise<unknown>;
    /** `GET /v1/partitions/:p/memories` —— 列表（person / scope / category / 分页）。 */
    listMemories(partitionRef: string, query?: {
        person_id?: string;
        scope?: string;
        category?: string;
        page?: number;
        page_size?: number;
    }): Promise<unknown>;
    /** `GET /v1/partitions/:p/memories/:id` —— 记忆详情。 */
    getMemory(partitionRef: string, id: string): Promise<unknown>;
}
