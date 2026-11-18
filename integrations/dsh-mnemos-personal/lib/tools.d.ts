/**
 * Agent 工具集合（8 个 `mnemos_*`，Mnemos v6）。
 *
 * 设计约束（与旧插件 dsh-mnemos 保持一致，原因见 `src/dsh-types.d.ts`）：
 * - 参数与输出都是**手写原始 JSON Schema**，不在运行时 import `@deepseek-ai/dsh-tools`；
 * - `execute()` 永远不抛异常，失败返回 `{ ok: false, error, action }`，让模型能读到可操作的原因；
 * - `output.render()` 返回 `[{ type: 'text', text }]`，是用户/模型真正看到的内容；
 * - 输出 schema 统一带 `additionalProperties: true`，只把 `ok` 设为必需：服务端随时可能加字段，
 *   严格 schema 会让读路径被 harness 的输出校验整条拦死。
 *
 * 分区 = 工作区：每次调用现算 slug（workspace 路径 → 稳定 slug，或 fixed 模式配置值），
 * 首次调用 `POST /v1/partitions` 幂等建分区（客户端内缓存分区 id，进程内只建一次）。
 * 人 = 记忆主体：`person_id` 缺省 / `self` 表示配置里的默认人；写路径会先 `PUT persons/:externalId`
 * 建档（服务端 lazy upsert），读路径只传人标识、不产生写副作用。
 *
 * v6 变化：
 * - 人 / 记忆列表改为**游标分页**（`cursor` / `limit`，响应 `{ items, next_cursor, partition_stats }`），
 *   工具参数与输出里的 `page` 换成 `cursor` / `next_cursor`；
 * - 写记忆走人级端点 `POST /v1/partitions/:p/persons/:person/memories`；
 * - 分区统计读 `GET /v1/partitions/:p/stats`（partition_stats），人的计数读 persons 行上的
 *   `memory_count / shared_memory_count / session_count`，不做 COUNT(*)。
 */
import type { ToolDefinition } from './dsh-types.js';
import type { MnemosConfig } from './config.js';
import { MnemosClient, type MnemosMemory } from './mnemos-client.js';
import { type WorkspacePathResolver } from './workspace.js';
/** 读取活配置的回调（每次工具调用都重新解析，设置改动即时生效）。 */
type ConfigSource = () => MnemosConfig;
/** 失败结果的公共形状。 */
export interface ToolFailure {
    ok: false;
    error: string;
    action: string;
}
interface WorkspaceResult {
    ok: boolean;
    error?: string;
    action?: string;
    warning?: string;
    partition?: Record<string, unknown>;
    person?: Record<string, unknown>;
    stats?: Record<string, unknown>;
}
/** 确保分区与默认人存在，返回分区 / 人 / 统计。 */
export declare function mnemosWorkspaceTool(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): ToolDefinition<Record<string, never>, WorkspaceResult>;
interface AddArgs {
    text?: string;
    /** 记忆正文别名：与 text 二选一；占位符协议示例用 content。 */
    content?: string;
    messages?: string | Array<{
        role: string;
        content: string;
    }>;
    person_id?: string;
    scope?: 'person' | 'partition' | 'session';
    session_id?: string;
    category?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    /** 隐私占位符映射：正文写 `{{key}}`，真实值只放这里。 */
    placeholders?: Record<string, string>;
}
interface AddResult {
    ok: boolean;
    error?: string;
    action?: string;
    warning?: string;
    added?: number;
    results?: MnemosMemory[];
    events?: unknown[];
}
/** 写一条记忆（默认归属默认人；scope 缺省由服务端分区设置决定）。 */
export declare function mnemosAddTool(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): ToolDefinition<AddArgs, AddResult>;
interface SearchArgs {
    query: string;
    person_id?: string;
    scope?: 'person' | 'partition' | 'session';
    category?: string;
    top_k?: number;
}
interface SearchResult {
    ok: boolean;
    error?: string;
    action?: string;
    warning?: string;
    count?: number;
    took_ms?: number;
    results?: MnemosMemory[];
}
/** 按人 / 分区检索记忆（语义 + 关键词混合检索）。 */
export declare function mnemosSearchTool(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): ToolDefinition<SearchArgs, SearchResult>;
interface GetArgs {
    id?: string;
    person_id?: string;
    scope?: 'person' | 'partition' | 'session';
    category?: string;
    cursor?: string;
    limit?: number;
}
interface GetResult {
    ok: boolean;
    error?: string;
    action?: string;
    warning?: string;
    memory?: MnemosMemory;
    results?: MnemosMemory[];
    count?: number;
    next_cursor?: string;
    partition_stats?: Record<string, unknown>;
}
/** 读一条记忆详情，或按人 / 范围用游标列出记忆。 */
export declare function mnemosGetTool(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): ToolDefinition<GetArgs, GetResult>;
interface BriefArgs {
    person_id?: string;
}
interface BriefResult {
    ok: boolean;
    error?: string;
    action?: string;
    warning?: string;
    person_id?: string;
    text?: string;
    count?: number;
    model?: string;
    cached?: boolean;
}
/** 人的简报：该人最近记忆 + 与其相关的分区共享记忆，压缩成可直接读的文本。 */
export declare function mnemosBriefTool(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): ToolDefinition<BriefArgs, BriefResult>;
interface ContextArgs {
    person_id?: string;
    query?: string;
}
interface ContextResult {
    ok: boolean;
    error?: string;
    action?: string;
    warning?: string;
    person_id?: string;
    prompt?: string;
    token_estimate?: number;
    person?: Record<string, unknown>;
    memory_count?: number;
    shared_count?: number;
}
/** 人的上下文：资料 + 简报 + 高相关记忆 +（可选）分区共享知识，返回可直接注入的 prompt。 */
export declare function mnemosContextTool(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): ToolDefinition<ContextArgs, ContextResult>;
interface PersonArgs {
    action: 'list' | 'get' | 'upsert';
    person_id?: string;
    type?: 'human' | 'agent' | 'service';
    display_name?: string;
    attributes?: Record<string, unknown>;
    status?: string;
    q?: string;
    cursor?: string;
    limit?: number;
}
interface PersonResult {
    ok: boolean;
    error?: string;
    action?: string;
    warning?: string;
    action_name?: string;
    person?: Record<string, unknown>;
    people?: Record<string, unknown>[];
    count?: number;
    next_cursor?: string;
    partition_stats?: Record<string, unknown>;
}
/** 人管理：list（游标列表）/ get（详情）/ upsert（建档或更新资料）。 */
export declare function mnemosPersonTool(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): ToolDefinition<PersonArgs, PersonResult>;
interface StatusResult {
    ok: boolean;
    error?: string;
    action?: string;
    warning?: string;
    reachable: boolean;
    baseUrl: string;
    apiKeyConfigured: boolean;
    partitionSlug?: string;
    partitionExists?: boolean;
    personId?: string;
    personType?: string;
    personExists?: boolean;
}
/** 连接自检：服务可达性、分区是否可达、默认人是否存在、org key 是否配置（不打印密钥）。 */
export declare function mnemosStatusTool(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): ToolDefinition<Record<string, never>, StatusResult>;
/** 本插件的全部工具（顺序即注册顺序，也是 Agent 看到的大致顺序）。 */
export declare function createMnemosTools(client: MnemosClient, config: ConfigSource, resolveWorkspacePath: WorkspacePathResolver): Array<ToolDefinition<any, any>>;
/** 工具名清单（装配测试 / 文档用）。 */
export declare const MNEMOS_TOOL_NAMES: readonly ["mnemos_workspace", "mnemos_add", "mnemos_search", "mnemos_get", "mnemos_brief", "mnemos_context", "mnemos_person", "mnemos_status"];
export {};
