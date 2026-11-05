/**
 * Agent 工具集合（10 个 `mnemos_*`）。
 *
 * 设计约束（与 dsh-mem0 保持一致，原因见 `src/dsh-types.d.ts`）：
 * - 参数与输出都是**手写原始 JSON Schema**，不在运行时 import `@deepseek-ai/dsh-tools`；
 * - `execute()` 永远不抛异常，失败返回 `{ ok: false, error }`，让模型能读到可操作的原因；
 * - `output.render()` 返回 `[{ type: 'text', text }]`，是用户/模型真正看到的内容。
 *
 * 输出 schema 统一带 `additionalProperties: true`：服务端随时可能加字段，
 * 严格 schema 会让读路径被 harness 的输出校验整条拦死。
 */
import type { ToolDefinition } from './dsh-types.js';
import type { MnemosConfig } from './config.js';
import { type MnemosAgent, type MnemosBriefing, type MnemosCategory, MnemosClient, type MnemosHistoryEntry, type MnemosMemory, type MnemosMemoryEvent, type MnemosStatus, type MnemosTask, type MnemosTaskStatus, type MnemosVisibility } from './mnemos-client.js';
/** 读取活配置的回调（每次工具调用都重新解析，设置改动即时生效）。 */
type ConfigSource = () => MnemosConfig;
interface SearchArgs {
    query: string;
    top_k?: number;
    threshold?: number;
    user_id?: string;
    agent_id?: string;
    task_id?: string;
    visibility?: MnemosVisibility;
    category?: MnemosCategory;
}
interface SearchResult {
    ok: boolean;
    count: number;
    tookMs?: number;
    results?: MnemosMemory[];
    error?: string;
}
/** 语义 + 关键词 + 实体混合检索。 */
export declare function mnemosSearchTool(client: MnemosClient, config: ConfigSource): ToolDefinition<SearchArgs, SearchResult>;
interface AddArgs {
    messages?: string | Array<{
        role: string;
        content: string;
    }>;
    text?: string;
    user_id?: string;
    agent_id?: string;
    task_id?: string;
    visibility?: MnemosVisibility;
    infer?: boolean;
    mode?: 'additive' | 'consolidate';
    tags?: string[];
    metadata?: Record<string, unknown>;
}
interface AddResult {
    ok: boolean;
    results: MnemosMemory[];
    events: MnemosMemoryEvent[];
    error?: string;
}
/** 写入记忆。 */
export declare function mnemosAddTool(client: MnemosClient, config: ConfigSource): ToolDefinition<AddArgs, AddResult>;
interface ContextArgs {
    agent_id?: string;
    task_id?: string;
    query?: string;
    budget_tokens?: number;
}
interface ContextResult {
    ok: boolean;
    prompt?: string;
    token_estimate?: number;
    citations?: string[];
    sections?: MnemosBriefing['sections'];
    project?: MnemosBriefing['project'] | null;
    agent?: {
        id?: string;
        name?: string;
        role?: string;
    } | null;
    task?: {
        id?: string;
        title?: string;
        status?: string;
    } | null;
    error?: string;
}
/** 任务简报：开始任务时先取这个。 */
export declare function mnemosContextTool(client: MnemosClient, config: ConfigSource): ToolDefinition<ContextArgs, ContextResult>;
interface TaskArgs {
    action: 'start' | 'finish' | 'list' | 'get';
    title?: string;
    goal?: string;
    owner_agent_id?: string;
    branch?: string;
    task_id?: string;
    status?: MnemosTaskStatus;
    summary?: string;
    decisions?: string[];
    lessons?: string[];
    notes?: string[];
    agent_id?: string;
    limit?: number;
}
interface TaskResult {
    ok: boolean;
    action: 'start' | 'finish' | 'list' | 'get';
    task?: MnemosTask;
    tasks?: MnemosTask[];
    count?: number;
    memories?: MnemosMemory[];
    error?: string;
}
/** 任务会话：开始 / 结束 / 列表 / 详情。 */
export declare function mnemosTaskTool(client: MnemosClient, config: ConfigSource): ToolDefinition<TaskArgs, TaskResult>;
interface GetArgs {
    id?: string;
    user_id?: string;
    agent_id?: string;
    task_id?: string;
    category?: MnemosCategory;
    status?: MnemosStatus;
    page?: number;
    page_size?: number;
    sort?: 'recent' | 'importance' | 'accessed';
}
interface GetResult {
    ok: boolean;
    memory?: MnemosMemory;
    count?: number;
    total?: number;
    page?: number;
    page_size?: number;
    results?: MnemosMemory[];
    error?: string;
}
/** 读取记忆：按 id 取详情，或按条件列列表。 */
export declare function mnemosGetTool(client: MnemosClient, config: ConfigSource): ToolDefinition<GetArgs, GetResult>;
interface UpdateArgs {
    id: string;
    content?: string;
    category?: MnemosCategory;
    importance?: number;
    status?: MnemosStatus;
    tags?: string[];
    metadata?: Record<string, unknown>;
}
interface UpdateResult {
    ok: boolean;
    id?: string;
    applied?: string[];
    ignored?: string[];
    message?: string;
    error?: string;
}
/** 更新记忆。 */
export declare function mnemosUpdateTool(client: MnemosClient, config: ConfigSource): ToolDefinition<UpdateArgs, UpdateResult>;
interface DeleteArgs {
    id: string;
    confirm?: boolean;
}
interface DeleteResult {
    ok: boolean;
    id?: string;
    message?: string;
    error?: string;
}
/** 删除记忆（必须 confirm: true）。 */
export declare function mnemosDeleteTool(client: MnemosClient, config: ConfigSource): ToolDefinition<DeleteArgs, DeleteResult>;
interface HistoryArgs {
    id: string;
}
interface HistoryResult {
    ok: boolean;
    id?: string;
    history?: MnemosHistoryEntry[];
    error?: string;
}
/** 记忆变更历史。 */
export declare function mnemosHistoryTool(client: MnemosClient): ToolDefinition<HistoryArgs, HistoryResult>;
interface AgentArgs {
    action: 'list' | 'register';
    name?: string;
    role?: string;
    model?: string;
    capabilities?: string[];
}
interface AgentResult {
    ok: boolean;
    action: 'list' | 'register';
    agent?: MnemosAgent;
    agents?: MnemosAgent[];
    count?: number;
    error?: string;
}
/** Agent 注册表：列出 / 注册。 */
export declare function mnemosAgentTool(client: MnemosClient, config: ConfigSource): ToolDefinition<AgentArgs, AgentResult>;
interface StatusArgs {
    /** 无参数，保留空对象便于未来扩展。 */
    [key: string]: unknown;
}
interface StatusResult {
    ok: boolean;
    reachable: boolean;
    baseUrl: string;
    apiKeyConfigured: boolean;
    version?: string;
    uptimeMs?: number;
    stats?: Record<string, number | string | null>;
    statsError?: string;
    error?: string;
}
/** 连接与配置自检。 */
export declare function mnemosStatusTool(client: MnemosClient, config: ConfigSource): ToolDefinition<StatusArgs, StatusResult>;
/** 本插件的全部工具（顺序即注册顺序，也是 Agent 看到的大致顺序）。 */
export declare function createMnemosTools(client: MnemosClient, config: ConfigSource): Array<ToolDefinition<any, any>>;
export {};
