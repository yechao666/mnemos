/**
 * Mnemos REST 客户端（`/v1/*`，API Key 鉴权，snake_case 入参）。
 *
 * 契约来源：本仓库 `docs/api.md` 与 `server/src/http/routes/public.ts`
 * （v1 路由与序列化函数）。要点：
 *
 * - 鉴权：`Authorization: Bearer mnemos_live_*`；项目由 API Key 决定，请求里不传 project_id。
 * - 错误体统一为 `{ error: { code, message, details?, requestId } }`，
 *   `x-request-id` 响应头里也有同一个 id。
 * - `POST /v1/memories` 的 `results` 是 **camelCase** 的 Memory（`content` / `agentId`…），
 *   而 `GET` / `search` 返回的是 **snake_case** 的 v1 视图（`memory` / `agent_id`…）。
 *   两个形状都原样透传给工具层，渲染侧同时兼容。
 * - 读接口（GET / search / context）在「网络错误 / 503 / 504」时重试 1 次；
 *   写接口一律不重试，避免重复写入。
 */
import type { MnemosConfig } from './config.js';
/** 记忆可见性。 */
export type MnemosVisibility = 'project' | 'agent' | 'task';
/** 记忆分类。 */
export type MnemosCategory = 'preference' | 'identity' | 'fact' | 'plan' | 'relationship' | 'event' | 'skill' | 'constraint' | 'context';
/** 记忆状态。 */
export type MnemosStatus = 'active' | 'archived' | 'deleted';
/** 任务状态。 */
export type MnemosTaskStatus = 'open' | 'active' | 'done' | 'abandoned';
/** 一条记忆（同时容忍 v1 读视图与创建响应两种字段命名）。 */
export interface MnemosMemory {
    id?: string;
    /** v1 读视图字段（GET / search）。 */
    memory?: string;
    /** 创建响应字段（POST /v1/memories）。 */
    content?: string;
    user_id?: string | null;
    agent_id?: string | null;
    run_id?: string | null;
    app_id?: string | null;
    task_id?: string | null;
    userId?: string | null;
    agentId?: string | null;
    taskId?: string | null;
    visibility?: MnemosVisibility;
    category?: MnemosCategory;
    importance?: number;
    confidence?: number;
    source?: string;
    status?: MnemosStatus;
    tags?: string[];
    metadata?: Record<string, unknown> | null;
    created_at?: string;
    created_at_iso?: string;
    createdAt?: string;
    updated_at?: string;
    updatedAt?: string;
    last_accessed_at?: string | null;
    access_count?: number;
    accessCount?: number;
    expires_at?: string | null;
    /** 仅搜索结果带：融合分与逐信号分解。 */
    score?: number;
    signals?: Record<string, number>;
    matched_on?: string[];
    /** 仅详情接口带。 */
    history?: MnemosHistoryEntry[];
    entities?: MnemosEntity[];
    relations?: Record<string, unknown>[];
    neighbors?: MnemosEntity[];
    [key: string]: unknown;
}
/** 一条记忆变更历史。 */
export interface MnemosHistoryEntry {
    id?: string;
    memory_id?: string;
    event?: string;
    old_memory?: string | null;
    new_memory?: string | null;
    actor?: string;
    reason?: string | null;
    created_at?: string;
    meta?: Record<string, unknown>;
    [key: string]: unknown;
}
/** 图谱实体（详情接口附带）。 */
export interface MnemosEntity {
    id?: string;
    name?: string;
    type?: string;
    mention_count?: number;
    [key: string]: unknown;
}
/** 任务会话。 */
export interface MnemosTask {
    id?: string;
    project_id?: string;
    title?: string;
    goal?: string;
    status?: MnemosTaskStatus;
    owner_agent_id?: string | null;
    owner_agent_name?: string | null;
    branch?: string | null;
    summary?: string | null;
    metadata?: Record<string, unknown>;
    created_at?: string;
    started_at?: string;
    ended_at?: string | null;
    memory_count?: number;
    agent_count?: number;
    [key: string]: unknown;
}
/** 已注册 Agent。 */
export interface MnemosAgent {
    id?: string;
    project_id?: string;
    name?: string;
    role?: string;
    model?: string;
    description?: string;
    capabilities?: string[];
    status?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    last_active_at?: string | null;
    stats?: {
        memories?: number;
        private_memories?: number;
        tasks?: number;
        last_task_at?: string | null;
    };
    [key: string]: unknown;
}
/** 任务简报的一个分区。 */
export interface MnemosBriefingSection {
    key?: string;
    title?: string;
    description?: string;
    hits?: MnemosMemory[];
    [key: string]: unknown;
}
/** 任务简报（`POST /v1/context`）。 */
export interface MnemosBriefing {
    project?: {
        id?: string;
        name?: string;
        description?: string;
    };
    agent?: MnemosAgent | null;
    task?: MnemosTask | null;
    sections?: MnemosBriefingSection[];
    /** 可直接拼进 system prompt 的中文 Markdown。 */
    prompt?: string;
    token_estimate?: number;
    citations?: string[];
    built_at?: string;
    took_ms?: number;
}
/** 项目统计（`GET /v1/stats`，需要 admin 作用域）。 */
export interface MnemosStats {
    metrics?: Record<string, number | string | null>;
    [key: string]: unknown;
}
/** `POST /v1/memories` 的写入事件。 */
export interface MnemosMemoryEvent {
    type?: 'ADD' | 'UPDATE' | 'DELETE' | 'MERGE' | 'NOOP';
    memoryId?: string;
    content?: string;
    reason?: string;
    at?: string;
    [key: string]: unknown;
}
/** 客户端错误统一形状。 */
export interface MnemosApiErrorInit {
    message: string;
    /** HTTP 状态码；网络层失败时为 undefined。 */
    status?: number;
    /** 服务端 `error.code`，或本地错误码（network_error / timeout / missing_api_key …）。 */
    code?: string;
    requestId?: string;
    details?: unknown;
    method?: string;
    path?: string;
}
/** 请求失败（非 2xx、网络错误、配置缺失）。 */
export declare class MnemosApiError extends Error {
    readonly status?: number;
    readonly code: string;
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
/** 检索参数。 */
export interface MnemosSearchOptions {
    query: string;
    user_id?: string;
    /** 调用方 Agent 身份：决定可见性（项目共享 + 自身私有 + 当前任务）。 */
    agent_id?: string;
    run_id?: string;
    app_id?: string;
    task_id?: string;
    visibility?: MnemosVisibility;
    top_k?: number;
    threshold?: number;
    category?: MnemosCategory;
    status?: MnemosStatus;
    tags?: string[];
    min_importance?: number;
}
/** 写入参数（messages 与 text 二选一）。 */
export interface MnemosAddOptions {
    messages?: Array<{
        role: string;
        content: string;
    }>;
    text?: string;
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    app_id?: string;
    task_id?: string;
    visibility?: MnemosVisibility;
    metadata?: Record<string, unknown>;
    tags?: string[];
    /** 默认 false（原文入库）；true 走事实抽取。 */
    infer?: boolean;
    /** additive（默认）或 consolidate（高相似去重合并）。 */
    mode?: 'additive' | 'consolidate';
}
/** 列表参数。 */
export interface MnemosListOptions {
    user_id?: string;
    agent_id?: string;
    run_id?: string;
    app_id?: string;
    task_id?: string;
    visibility?: MnemosVisibility;
    category?: MnemosCategory;
    status?: MnemosStatus;
    sort?: 'recent' | 'importance' | 'accessed';
    page?: number;
    page_size?: number;
}
/** 更新参数（`/v1` 只认 content / category / importance）。 */
export interface MnemosUpdateOptions {
    content?: string;
    category?: MnemosCategory;
    importance?: number;
}
/** 任务简报参数。 */
export interface MnemosContextOptions {
    agent_id?: string;
    task_id?: string;
    query?: string;
    budget_tokens?: number;
}
/** 任务列表参数。 */
export interface MnemosTaskListOptions {
    status?: MnemosTaskStatus;
    agent_id?: string;
    limit?: number;
}
/** 开始任务参数。 */
export interface MnemosTaskCreateOptions {
    title: string;
    goal?: string;
    owner_agent_id?: string;
    branch?: string;
}
/** 结束任务参数。 */
export interface MnemosTaskFinishOptions {
    status?: 'done' | 'abandoned';
    summary?: string;
    decisions?: string[];
    lessons?: string[];
    notes?: string[];
    agent_id?: string;
}
/** 注册 Agent 参数。 */
export interface MnemosAgentCreateOptions {
    name: string;
    role?: string;
    model?: string;
    capabilities?: string[];
}
/** 健康检查响应。 */
export interface MnemosHealth {
    ok?: boolean;
    version?: string;
    uptime_ms?: number;
    [key: string]: unknown;
}
/**
 * 读取活配置的 Mnemos 客户端：每次请求都重新解析配置，
 * 因此设置页改动（baseUrl / apiKey / timeoutMs）无需重建客户端或重挂工具。
 */
export declare class MnemosClient {
    private readonly config;
    constructor(config: () => MnemosConfig);
    /** 规范化后的服务地址（去掉尾部斜杠）。 */
    private get baseUrl();
    /** 当前是否配置了 API Key（只报布尔，绝不返回密钥）。 */
    isApiKeyConfigured(): boolean;
    /** 是否需要在「网络错误 / 503 / 504」时重试。 */
    private shouldRetry;
    /**
     * 发一个请求，带一次重试（仅读路径、仅网络错误 / 503 / 504）。
     */
    private request;
    /** 单次请求：拼 URL、鉴权、超时、解析错误体。 */
    private once;
    /** `GET /v1/health` —— 存活检查（无需鉴权）。 */
    health(): Promise<MnemosHealth>;
    /** `GET /v1/stats` —— 项目指标（需要 admin 作用域）。 */
    stats(): Promise<MnemosStats>;
    /** `POST /v1/memories/search` —— 混合检索。 */
    search(options: MnemosSearchOptions): Promise<{
        results?: MnemosMemory[];
        took_ms?: number;
        signals?: unknown;
    }>;
    /** `POST /v1/memories` —— 写入记忆（messages 与 text 二选一）。 */
    add(options: MnemosAddOptions): Promise<{
        results?: MnemosMemory[];
        events?: MnemosMemoryEvent[];
        tookMs?: number;
    }>;
    /** `GET /v1/memories` —— 分页列表。 */
    listMemories(options?: MnemosListOptions): Promise<{
        results?: MnemosMemory[];
        count?: number;
        page?: number;
        page_size?: number;
    }>;
    /** `GET /v1/memories/{id}` —— 详情（含历史 / 实体 / 关系）。 */
    getMemory(id: string): Promise<MnemosMemory>;
    /** `PUT /v1/memories/{id}` —— 更新正文 / 分类 / 重要度。 */
    updateMemory(id: string, options: MnemosUpdateOptions): Promise<{
        message?: string;
    }>;
    /** `DELETE /v1/memories/{id}` —— 软删除（写历史）。 */
    deleteMemory(id: string): Promise<{
        message?: string;
    }>;
    /** `GET /v1/memories/{id}/history` —— 变更历史（服务端包了一层 results）。 */
    history(id: string): Promise<MnemosHistoryEntry[]>;
    /** `POST /v1/memories/{id}/feedback` —— 有用/无用反馈，调整重要度。 */
    feedback(id: string, helpful: boolean, query?: string): Promise<MnemosMemory>;
    /** `POST /v1/context` —— 任务简报（可直接拼进 system prompt）。 */
    context(options?: MnemosContextOptions): Promise<MnemosBriefing>;
    /** `GET /v1/tasks` —— 任务列表。 */
    listTasks(options?: MnemosTaskListOptions): Promise<{
        results?: MnemosTask[];
        count?: number;
    }>;
    /** `GET /v1/tasks/{id}` —— 任务详情。 */
    getTask(id: string): Promise<MnemosTask>;
    /** `POST /v1/tasks` —— 开始任务。 */
    createTask(options: MnemosTaskCreateOptions): Promise<MnemosTask>;
    /** `POST /v1/tasks/{id}/finish` —— 结束任务（decisions/lessons/notes 会写成项目共享记忆）。 */
    finishTask(id: string, options?: MnemosTaskFinishOptions): Promise<{
        task?: MnemosTask;
        memories?: MnemosMemory[];
    }>;
    /** `GET /v1/agents` —— 项目内 Agent 注册表。 */
    listAgents(): Promise<{
        results?: MnemosAgent[];
        count?: number;
    }>;
    /** `POST /v1/agents` —— 注册 Agent。 */
    createAgent(options: MnemosAgentCreateOptions): Promise<MnemosAgent>;
}
