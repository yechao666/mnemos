/**
 * Agent 工具集合（8 个 `mnemos_*`，新版中立记忆服务 v5）。
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
 */
import { DEFAULT_TOP_K, MAX_TOP_K, MnemosApiError, } from './mnemos-client.js';
import { WorkspacePathError, agentSessionId, resolvePartitionIdentity, } from './workspace.js';
/* ------------------------------------------------------------------ */
/* 通用助手                                                            */
/* ------------------------------------------------------------------ */
/** 一段文本内容块。 */
function text(value) {
    return [{ type: 'text', text: value }];
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
function stringField(record, ...keys) {
    if (record === undefined)
        return undefined;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value !== '')
            return value;
    }
    return undefined;
}
/**
 * 统一失败结果：把错误消息与「下一步该做什么」都带上，模型读完就能修正。
 * `extra` 用于补齐本工具输出里的固定字段（例如 count: 0），不覆盖错误字段。
 */
function failResult(error) {
    if (error instanceof WorkspacePathError) {
        return { ok: false, error: error.message, action: error.action };
    }
    if (error instanceof MnemosApiError) {
        return { ok: false, error: error.message, action: error.action };
    }
    return {
        ok: false,
        error: messageOf(error),
        action: '检查 Mnemos 配置（baseUrl / orgApiKey）与工作区后重试；若持续失败，把错误信息反馈给用户。',
    };
}
/** readOnly 模式的统一提示。 */
const READ_ONLY_ERROR = 'readOnly 模式已开启，已拦截记忆写入 / 人变更。';
const READ_ONLY_ACTION = '在「设置 → 插件 → dsh-mnemos-personal」把 readOnly 改成 false 后重试。';
function readOnlyResult() {
    return { ok: false, error: READ_ONLY_ERROR, action: READ_ONLY_ACTION };
}
/** 记忆容器的 JSON Schema：宽容，允许服务端新增字段。 */
const OBJECT_SCHEMA = { type: 'object', additionalProperties: true };
const OBJECT_ARRAY_SCHEMA = { type: 'array', items: OBJECT_SCHEMA };
/** 通用输出 schema 片段：ok / error / action / warning。 */
const BASE_PROPERTIES = {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    action: { type: 'string' },
    warning: { type: 'string' },
};
/** 统一渲染失败信息。 */
function renderFailure(toolName, value) {
    const action = value.action === undefined || value.action === '' ? '' : `\n下一步：${value.action}`;
    return `${toolName} 失败：${value.error ?? '未知错误'}${action}`;
}
/** 从响应里取数组：容忍 `results` / `memories` / `people` / 裸数组。 */
function listFrom(payload, ...keys) {
    const record = asRecord(payload);
    if (record !== undefined) {
        for (const key of keys) {
            const value = record[key];
            if (Array.isArray(value))
                return value;
        }
    }
    return Array.isArray(payload) ? payload : [];
}
/** 记忆正文：v5 用 `content`，旧 v1 读视图用 `memory`。 */
function memoryContent(memory) {
    const value = memory?.content ?? memory?.memory;
    return typeof value === 'string' && value !== '' ? value : '(空内容)';
}
function memoryPerson(memory) {
    const value = memory?.person_external_id ??
        memory?.personExternalId ??
        memory?.person_id ??
        memory?.personId;
    return typeof value === 'string' && value !== '' ? value : '-';
}
/** 一条记忆的多行渲染：scope/分类/归属、内容、id。 */
function renderMemory(memory, index) {
    if (memory === undefined)
        return `${index + 1}. (无效记忆)`;
    const score = typeof memory.score === 'number' ? ` [${memory.score.toFixed(3)}]` : '';
    const meta = `${memory.scope ?? '-'}/${memory.category ?? '未分类'} · person=${memoryPerson(memory)}`;
    const matched = Array.isArray(memory.matched_on) && memory.matched_on.length > 0 ? `（命中：${memory.matched_on.join('/')}）` : '';
    return `${index + 1}.${score} ${meta}${matched}\n   ${memoryContent(memory)}\n   id：${memory.id ?? '(未知)'}`;
}
/** 记忆列表渲染。 */
function renderMemoryList(memories) {
    return memories.map((memory, index) => renderMemory(memory, index)).join('\n');
}
/** 分区摘要（喂给工具结果 / 渲染）。 */
function summarizePartition(payload, fallback) {
    const root = asRecord(payload);
    const node = asRecord(root?.partition) ?? asRecord(root?.project) ?? root ?? {};
    const summary = {
        slug: stringField(node, 'slug') ?? fallback.slug,
        name: stringField(node, 'name') ?? fallback.name,
    };
    const id = stringField(node, 'id', 'partition_id', 'project_id') ?? fallback.id;
    if (id !== undefined)
        summary.id = id;
    const description = stringField(node, 'description');
    if (description !== undefined)
        summary.description = description;
    return summary;
}
/** 人摘要（喂给工具结果 / 渲染）：详情接口可能把 stats 放在 `{ person, stats }` 外层。 */
function summarizePerson(payload) {
    const root = asRecord(payload) ?? {};
    const node = asRecord(root.person) ?? root;
    const summary = {};
    const id = stringField(node, 'id');
    if (id !== undefined)
        summary.id = id;
    const externalId = stringField(node, 'external_id', 'externalId');
    if (externalId !== undefined)
        summary.external_id = externalId;
    const type = stringField(node, 'type');
    if (type !== undefined)
        summary.type = type;
    const displayName = stringField(node, 'display_name', 'displayName');
    if (displayName !== undefined)
        summary.display_name = displayName;
    const status = stringField(node, 'status');
    if (status !== undefined)
        summary.status = status;
    const stats = asRecord(node.stats) ?? asRecord(root.stats);
    if (stats !== undefined)
        summary.stats = stats;
    const attributes = asRecord(node.attributes);
    if (attributes !== undefined)
        summary.attributes = attributes;
    return summary;
}
/** `person_id` 归一：空 / `self` → 配置里的默认人；其它原样。 */
function resolvePersonId(value, config) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed === '' || trimmed === 'self')
        return config.personId;
    return trimmed;
}
/** 推导本次调用的分区（workspace 派生 / fixed 配置）。 */
function partitionFor(config, resolveWorkspacePath, exec) {
    return resolvePartitionIdentity(config.partitionMode, config.fixedPartition, resolveWorkspacePath(exec));
}
/**
 * 确保分区存在：首次 POST 幂等建分区（客户端缓存）。
 *
 * 降级：org key 没有 admin 作用域时 POST 会 403；此时若分区已由他人建好，读接口仍可用，
 * 所以退回「按 slug 直连」并记录 warning。写工具真正需要分区时会由后续请求报出准确错误。
 */
async function ensurePartition(client, config, resolveWorkspacePath, exec) {
    const identity = partitionFor(config, resolveWorkspacePath, exec);
    // readOnly：连建分区这种写副作用也不做，直接按 slug 直连；分区不存在时由读请求报 404。
    if (config.readOnly) {
        return { identity, info: { slug: identity.slug, name: identity.name } };
    }
    try {
        const info = await client.ensurePartition(identity.slug, identity.name);
        return { identity, info };
    }
    catch (error) {
        if (error instanceof MnemosApiError && (error.status === 403 || error.status === 404)) {
            return {
                identity,
                info: { slug: identity.slug, name: identity.name },
                warning: `无法自动创建分区（${error.status} ${error.code}），已按 slug 直连；若分区不存在请用带 admin 的 org key。`,
            };
        }
        throw error;
    }
}
/** 把 top_k 限制在服务端允许范围。 */
function clampTopK(value) {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_TOP_K;
    if (number < 1)
        return DEFAULT_TOP_K;
    return Math.min(number, MAX_TOP_K);
}
/** 规整 messages：允许字符串或 [{ role, content }]，空内容丢弃。 */
function normalizeMessages(value) {
    if (value === undefined)
        return undefined;
    if (typeof value === 'string') {
        return value.trim() === '' ? undefined : [{ role: 'user', content: value }];
    }
    if (!Array.isArray(value))
        return undefined;
    const messages = [];
    for (const item of value) {
        if (typeof item === 'string') {
            if (item.trim() !== '')
                messages.push({ role: 'user', content: item });
            continue;
        }
        const record = asRecord(item);
        if (record === undefined)
            continue;
        const content = typeof record.content === 'string' ? record.content : '';
        if (content.trim() === '')
            continue;
        const role = typeof record.role === 'string' && record.role !== '' ? record.role : 'user';
        messages.push({ role, content });
    }
    return messages.length > 0 ? messages : undefined;
}
/** 确保分区与默认人存在，返回分区 / 人 / 统计。 */
export function mnemosWorkspaceTool(client, config, resolveWorkspacePath) {
    return {
        name: 'mnemos_workspace',
        description: '确保当前工作区对应的 Mnemos 分区与默认人存在（首次调用才建，幂等），并返回分区、人和统计。' +
            '分区由 DSH 工作区路径唯一决定（workspace 模式），人由插件配置的 personId 决定。' +
            '不确定「我的记忆存在哪个分区、默认人是谁」时先调它。',
        parameters: { type: 'object', properties: {} },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...BASE_PROPERTIES,
                    partition: OBJECT_SCHEMA,
                    person: OBJECT_SCHEMA,
                    stats: OBJECT_SCHEMA,
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok ? renderWorkspace(value) : renderFailure('mnemos_workspace', value)),
        },
        async execute(_args, exec) {
            try {
                const settings = config();
                const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec);
                // 分区详情：读接口失败就是真失败（ensure 的 fallback 不保证分区存在）。
                const partitionPayload = await client.getPartition(ensured.info.slug);
                const partition = summarizePartition(partitionPayload, ensured.info);
                const personId = resolvePersonId(undefined, settings);
                let warning = ensured.warning;
                let personPayload;
                if (settings.readOnly) {
                    // readOnly：不建档，只读已有的人；不存在时仍返回分区信息 + 提示。
                    try {
                        personPayload = await client.getPerson(ensured.info.slug, personId);
                    }
                    catch (error) {
                        if (!(error instanceof MnemosApiError) || error.status !== 404)
                            throw error;
                        warning = warning === undefined ? 'readOnly 模式不会自动建默认人；关闭 readOnly 后重试可自动建档。' : warning;
                    }
                }
                else {
                    try {
                        await client.ensurePerson(ensured.info.slug, personId, { type: settings.personType });
                    }
                    catch (error) {
                        // 只读 key：人可能已存在，GET 得通就照常返回。
                        if (!(error instanceof MnemosApiError) || (error.status !== 403 && error.status !== 404))
                            throw error;
                        warning = warning === undefined ? `默认人无法 upsert（${error.status} ${error.code}），按已有档案读取。` : warning;
                    }
                    personPayload = await client.getPerson(ensured.info.slug, personId);
                }
                const person = personPayload === undefined ? { external_id: personId } : summarizePerson(personPayload);
                const stats = asRecord(person.stats) ?? {};
                const result = { ok: true, partition, person, stats };
                if (warning !== undefined)
                    result.warning = warning;
                return result;
            }
            catch (error) {
                return failResult(error);
            }
        },
    };
}
function renderWorkspace(value) {
    const partition = value.partition ?? {};
    const person = value.person ?? {};
    const stats = value.stats ?? {};
    const lines = [
        `Mnemos 分区已就绪：${partition.slug ?? '(未知 slug)'}（${partition.name ?? '-'}${partition.id ? `，id=${partition.id}` : ''}）`,
        `默认人：${person.external_id ?? person.display_name ?? '-'}（type=${person.type ?? '-'}${person.id ? `，id=${person.id}` : ''}）`,
    ];
    const parts = [
        typeof stats.memories === 'number' ? `记忆 ${stats.memories}` : '',
        typeof stats.shared_memories === 'number' ? `分区共享 ${stats.shared_memories}` : '',
        typeof stats.sessions === 'number' ? `会话 ${stats.sessions}` : '',
        typeof stats.last_memory_at === 'string' ? `最近写入 ${stats.last_memory_at}` : '',
    ].filter(Boolean);
    lines.push(parts.length > 0 ? `统计：${parts.join(' · ')}` : '统计：暂无');
    if (value.warning !== undefined)
        lines.push(`注意：${value.warning}`);
    return lines.join('\n');
}
const SCOPES = ['person', 'partition', 'session'];
/** 写一条记忆（默认归属默认人；scope 缺省由服务端分区设置决定）。 */
export function mnemosAddTool(client, config, resolveWorkspacePath) {
    return {
        name: 'mnemos_add',
        description: '把值得沉淀的结论 / 决策 / 约束 / 踩坑经验写进 Mnemos（默认原文入库，infer=true 才走事实抽取）。' +
            'text 与 messages 二选一；person_id 缺省为默认人（self）。' +
            'scope：person=仅该人可见，partition=分区共享（协作知识），session=仅当前会话（必须带 session_id，缺省用当前会话）。' +
            '触发词：记住 / 记下来 / 写入记忆 / 沉淀结论 / save to memory / remember this.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '要写入的记忆正文（最长约 8000 字）。' },
                messages: {
                    description: '对话式写入：字符串按 user 角色，或 [{role, content}] 数组。与 text 二选一。',
                    anyOf: [
                        { type: 'string' },
                        {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { role: { type: 'string' }, content: { type: 'string' } },
                                required: ['content'],
                            },
                        },
                    ],
                },
                person_id: {
                    type: 'string',
                    description: '记忆归属人的 external_id（或 self / 省略 = 默认人）。写入不存在的人会先建档。',
                },
                scope: {
                    type: 'string',
                    enum: ['person', 'partition', 'session'],
                    description: '可见范围：person=仅该人；partition=分区共享；session=仅当前会话（需 session_id）。缺省用分区设置。',
                },
                session_id: {
                    type: 'string',
                    description: '会话 id（scope=session 时必需；缺省用当前 DSH 会话 id）。',
                },
                category: {
                    type: 'string',
                    description: '记忆分类，如 fact / preference / identity / constraint / skill / plan / event / insight / context。',
                },
                tags: { type: 'array', items: { type: 'string' }, description: '标签，便于后续过滤。' },
                metadata: { type: 'object', additionalProperties: true, description: '自由元数据（来源、分支、工单号等）。' },
                infer: { type: 'boolean', description: 'true=先做事实抽取再入库；默认 false（原文入库，保真度最高）。' },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...BASE_PROPERTIES,
                    added: { type: 'integer' },
                    results: OBJECT_ARRAY_SCHEMA,
                    events: { type: 'array', items: OBJECT_SCHEMA },
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok ? renderAdd(value) : renderFailure('mnemos_add', value)),
        },
        async execute(args, exec) {
            try {
                const settings = config();
                if (settings.readOnly)
                    return readOnlyResult();
                const messages = normalizeMessages(args.messages);
                const textValue = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : undefined;
                if (textValue === undefined && messages === undefined) {
                    return {
                        ok: false,
                        error: 'mnemos_add 需要 text 或 messages 之一。',
                        action: '把要沉淀的内容放进 text（字符串），或按 [{role, content}] 传 messages。',
                    };
                }
                let scope;
                if (args.scope !== undefined) {
                    if (!SCOPES.includes(args.scope)) {
                        return {
                            ok: false,
                            error: `scope 只能是 person / partition / session，收到 ${String(args.scope)}。`,
                            action: '按记忆可见范围传 scope：person（仅该人）/ partition（分区共享）/ session（仅当前会话）。',
                        };
                    }
                    scope = args.scope;
                }
                let sessionId = typeof args.session_id === 'string' && args.session_id.trim() !== '' ? args.session_id.trim() : undefined;
                if (scope === 'session' && sessionId === undefined)
                    sessionId = agentSessionId(exec?.agent);
                if (scope === 'session' && sessionId === undefined) {
                    return {
                        ok: false,
                        error: 'scope=session 但没有可用的 session_id：当前调用拿不到会话 id，也没有显式传入。',
                        action: '显式传 session_id，或改用 scope=person / partition。',
                    };
                }
                const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec);
                const personId = resolvePersonId(args.person_id, settings);
                const person = await client.ensurePerson(ensured.info.slug, personId, {
                    type: personId === settings.personId ? settings.personType : undefined,
                });
                const body = {};
                if (textValue !== undefined && messages === undefined)
                    body.text = textValue;
                if (messages !== undefined)
                    body.messages = messages;
                body.person_id = person.id ?? person.externalId;
                if (scope !== undefined)
                    body.scope = scope;
                if (sessionId !== undefined)
                    body.session_id = sessionId;
                if (typeof args.category === 'string' && args.category !== '')
                    body.category = args.category;
                if (Array.isArray(args.tags) && args.tags.length > 0)
                    body.tags = args.tags;
                if (args.metadata !== undefined && asRecord(args.metadata) !== undefined)
                    body.metadata = args.metadata;
                if (args.infer !== undefined)
                    body.infer = args.infer;
                const payload = await client.addMemory(ensured.info.slug, body);
                const results = listFrom(payload, 'results', 'memories').filter((item) => asRecord(item) !== undefined);
                const events = listFrom(payload, 'events');
                const result = { ok: true, added: results.length > 0 ? results.length : events.length, results, events };
                if (ensured.warning !== undefined)
                    result.warning = ensured.warning;
                return result;
            }
            catch (error) {
                return { ...failResult(error), added: 0, results: [], events: [] };
            }
        },
    };
}
function renderAdd(value) {
    const results = value.results ?? [];
    const added = typeof value.added === 'number' ? value.added : results.length;
    const head = `已写入 Mnemos：${added} 条（person=${results.length > 0 ? memoryPerson(results[0]) : '默认人'}）`;
    const lines = [head];
    if (results.length > 0)
        lines.push(renderMemoryList(results));
    if (value.warning !== undefined)
        lines.push(`注意：${value.warning}`);
    return lines.join('\n');
}
/** 按人 / 分区检索记忆（语义 + 关键词混合检索）。 */
export function mnemosSearchTool(client, config, resolveWorkspacePath) {
    return {
        name: 'mnemos_search',
        description: '在当前工作区的 Mnemos 分区里检索记忆（混合检索，返回带相关度分数的结果）。' +
            '默认按默认人（self）检索，返回该人可见的记忆与分区共享知识；person_id 可换人，scope=partition 只看分区共享。' +
            '触发词：搜索记忆 / 查一下我记住的 / 找经验 / 以前怎么做的 / search memory / recall.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '自然语言查询（最长 2000 字）。' },
                person_id: { type: 'string', description: '按人检索的 external_id（或 self / 省略 = 默认人）。' },
                scope: {
                    type: 'string',
                    enum: ['person', 'partition', 'session'],
                    description: '只检索指定可见范围；scope=partition 时不按人过滤（分区共享知识）。',
                },
                category: { type: 'string', description: '只检索指定分类（fact / constraint / skill / insight …）。' },
                top_k: { type: 'integer', description: `返回条数，默认 ${DEFAULT_TOP_K}（服务端上限 ${MAX_TOP_K}）。` },
            },
            required: ['query'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...BASE_PROPERTIES,
                    count: { type: 'integer' },
                    took_ms: { type: 'number' },
                    results: OBJECT_ARRAY_SCHEMA,
                },
                required: ['ok'],
            },
            render: (args, value) => text(value.ok ? renderSearch(args.query, value) : renderFailure('mnemos_search', value)),
        },
        async execute(args, exec) {
            try {
                const settings = config();
                if (typeof args.query !== 'string' || args.query.trim() === '') {
                    return { ok: false, error: 'mnemos_search 需要非空 query。', action: '传 query（自然语言）后重试。' };
                }
                const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec);
                const body = {
                    query: args.query,
                    top_k: clampTopK(args.top_k),
                };
                if (args.scope !== undefined)
                    body.scope = args.scope;
                if (args.scope !== 'partition')
                    body.person_id = resolvePersonId(args.person_id, settings);
                if (typeof args.category === 'string' && args.category !== '')
                    body.category = args.category;
                const payload = await client.searchMemories(ensured.info.slug, body);
                const results = listFrom(payload, 'results', 'memories').filter((item) => asRecord(item) !== undefined);
                const record = asRecord(payload);
                const tookMs = typeof record?.took_ms === 'number' ? record.took_ms : typeof record?.tookMs === 'number' ? record.tookMs : undefined;
                const result = { ok: true, count: results.length, results };
                if (tookMs !== undefined)
                    result.took_ms = tookMs;
                if (ensured.warning !== undefined)
                    result.warning = ensured.warning;
                return result;
            }
            catch (error) {
                return { ...failResult(error), count: 0, results: [] };
            }
        },
    };
}
function renderSearch(query, value) {
    const results = value.results ?? [];
    const took = typeof value.took_ms === 'number' ? `，耗时 ${Math.round(value.took_ms)}ms` : '';
    const head = `Mnemos 搜索「${query}」→ ${value.count ?? results.length} 条${took}`;
    if (results.length === 0) {
        return `${head}\n（没有命中：换更宽泛的关键词、放宽 category/scope，或确认 person_id 与工作区是否绑定到该分区）`;
    }
    const lines = [head, renderMemoryList(results)];
    if (value.warning !== undefined)
        lines.push(`注意：${value.warning}`);
    return lines.join('\n');
}
/** 读一条记忆详情，或按人 / 范围分页列出记忆。 */
export function mnemosGetTool(client, config, resolveWorkspacePath) {
    return {
        name: 'mnemos_get',
        description: '读取 Mnemos 记忆：传 id 取一条详情；不传 id 则按人 / 可见范围 / 分类分页列出。' +
            '列表默认按默认人（self）过滤；scope=partition 时列分区共享记忆（不按人过滤）。',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '记忆 id（mem_*）；传了它就不再走列表。' },
                person_id: { type: 'string', description: '列表按人的 external_id 过滤（或 self / 省略 = 默认人）。' },
                scope: {
                    type: 'string',
                    enum: ['person', 'partition', 'session'],
                    description: '列表按可见范围过滤；scope=partition 时不按人过滤。',
                },
                category: { type: 'string', description: '列表按分类过滤。' },
                page: { type: 'integer', description: '分页页码（从 1 开始），默认 1。' },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...BASE_PROPERTIES,
                    memory: OBJECT_SCHEMA,
                    results: OBJECT_ARRAY_SCHEMA,
                    count: { type: 'integer' },
                    page: { type: 'integer' },
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok ? renderGet(value) : renderFailure('mnemos_get', value)),
        },
        async execute(args, exec) {
            try {
                const settings = config();
                const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec);
                if (typeof args.id === 'string' && args.id.trim() !== '') {
                    const payload = await client.getMemory(ensured.info.slug, args.id.trim());
                    const record = asRecord(payload);
                    const memory = (asRecord(record?.memory) ?? asRecord(record?.result) ?? record);
                    const result = { ok: true };
                    if (memory !== undefined)
                        result.memory = memory;
                    if (ensured.warning !== undefined)
                        result.warning = ensured.warning;
                    return result;
                }
                const page = typeof args.page === 'number' && args.page > 0 ? Math.trunc(args.page) : 1;
                const query = { page };
                if (args.scope !== undefined)
                    query.scope = args.scope;
                if (args.scope !== 'partition')
                    query.person_id = resolvePersonId(args.person_id, settings);
                if (typeof args.category === 'string' && args.category !== '')
                    query.category = args.category;
                const payload = await client.listMemories(ensured.info.slug, query);
                const results = listFrom(payload, 'results', 'memories').filter((item) => asRecord(item) !== undefined);
                const record = asRecord(payload);
                const count = typeof record?.count === 'number' ? record.count : results.length;
                const result = { ok: true, results, count, page };
                if (ensured.warning !== undefined)
                    result.warning = ensured.warning;
                return result;
            }
            catch (error) {
                return { ...failResult(error), results: [], count: 0 };
            }
        },
    };
}
function renderGet(value) {
    if (value.memory !== undefined) {
        const memory = value.memory;
        const lines = [
            memoryContent(memory),
            `id：${memory.id ?? '(未知)'} · 分类：${memory.category ?? '-'} · scope：${memory.scope ?? '-'}`,
            `person：${memoryPerson(memory)} · session：${memory.session_id ?? memory.sessionId ?? '-'}`,
            `状态：${memory.status ?? '-'} · 更新：${memory.updated_at ?? memory.updatedAt ?? '-'}`,
        ];
        return lines.join('\n');
    }
    const results = value.results ?? [];
    const head = `Mnemos 记忆列表（第 ${value.page ?? 1} 页，共 ${value.count ?? results.length} 条）`;
    if (results.length === 0)
        return `${head}\n（没有记忆：先 mnemos_add 写入，或换 person_id / scope / category）`;
    const lines = [head, renderMemoryList(results)];
    if (value.warning !== undefined)
        lines.push(`注意：${value.warning}`);
    return lines.join('\n');
}
/** 人的简报：该人最近记忆 + 与其相关的分区共享记忆，压缩成可直接读的文本。 */
export function mnemosBriefTool(client, config, resolveWorkspacePath) {
    return {
        name: 'mnemos_brief',
        description: '读取某个人的 Mnemos 简报（该人最近记忆 + 与其相关的分区共享记忆，压缩成有字数上限的文本）。' +
            'person_id 缺省为默认人（self）。开始任务前想快速了解「关于这个人 / 这个分身已知什么」时用它。',
        parameters: {
            type: 'object',
            properties: {
                person_id: { type: 'string', description: '人的 external_id（或 self / 省略 = 默认人）。' },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...BASE_PROPERTIES,
                    person_id: { type: 'string' },
                    text: { type: 'string' },
                    count: { type: 'integer' },
                    model: { type: 'string' },
                    cached: { type: 'boolean' },
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok ? renderBrief(value) : renderFailure('mnemos_brief', value)),
        },
        async execute(args, exec) {
            try {
                const settings = config();
                const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec);
                const personId = resolvePersonId(args.person_id, settings);
                const payload = await client.getPersonBrief(ensured.info.slug, personId);
                const record = asRecord(payload);
                const brief = (asRecord(record?.brief) ?? record ?? {});
                const briefText = typeof brief.text === 'string' ? brief.text : '';
                const result = { ok: true, person_id: personId, text: briefText };
                if (typeof brief.count === 'number')
                    result.count = brief.count;
                if (typeof brief.model === 'string')
                    result.model = brief.model;
                if (typeof brief.cached === 'boolean')
                    result.cached = brief.cached;
                if (ensured.warning !== undefined)
                    result.warning = ensured.warning;
                return result;
            }
            catch (error) {
                return failResult(error);
            }
        },
    };
}
function renderBrief(value) {
    const head = `Mnemos 简报（person=${value.person_id ?? '默认人'}）`;
    const lines = [head];
    const briefText = (value.text ?? '').trim();
    if (briefText === '') {
        lines.push('（该人暂无简报：先用 mnemos_add 写入一些记忆，或确认 person_id / 分区是否正确）');
    }
    else {
        lines.push(briefText);
    }
    const meta = [
        typeof value.count === 'number' ? `纳入 ${value.count} 条记忆` : '',
        value.model !== undefined ? `模型 ${value.model}` : '',
        value.cached === true ? '命中缓存' : '',
    ].filter(Boolean);
    if (meta.length > 0)
        lines.push(meta.join(' · '));
    if (value.warning !== undefined)
        lines.push(`注意：${value.warning}`);
    return lines.join('\n');
}
/** 人的上下文：资料 + 简报 + 高相关记忆 +（可选）分区共享知识，返回可直接注入的 prompt。 */
export function mnemosContextTool(client, config, resolveWorkspacePath) {
    return {
        name: 'mnemos_context',
        description: '取某个人的 Mnemos 上下文（资料 + 简报 + 高相关记忆 + 分区共享知识），返回可直接阅读 / 注入提示词的 prompt。' +
            'person_id 缺省为默认人（self）；可带 query 让相关记忆更聚焦。开始任务前先调它，比逐条检索更省 token。',
        parameters: {
            type: 'object',
            properties: {
                person_id: { type: 'string', description: '人的 external_id（或 self / 省略 = 默认人）。' },
                query: { type: 'string', description: '可选：当前任务的一句话目标，用于挑选高相关记忆。' },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...BASE_PROPERTIES,
                    person_id: { type: 'string' },
                    prompt: { type: 'string' },
                    token_estimate: { type: 'number' },
                    person: OBJECT_SCHEMA,
                    memory_count: { type: 'integer' },
                    shared_count: { type: 'integer' },
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok ? renderContext(value) : renderFailure('mnemos_context', value)),
        },
        async execute(args, exec) {
            try {
                const settings = config();
                const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec);
                const personId = resolvePersonId(args.person_id, settings);
                const body = {};
                if (typeof args.query === 'string' && args.query.trim() !== '')
                    body.query = args.query.trim();
                const payload = await client.getPersonContext(ensured.info.slug, personId, body);
                const record = asRecord(payload);
                const context = (asRecord(record?.context) ?? record ?? {});
                const prompt = typeof context.prompt === 'string'
                    ? context.prompt
                    : typeof record?.prompt === 'string'
                        ? record.prompt
                        : '';
                const result = { ok: true, person_id: personId, prompt };
                if (typeof context.token_estimate === 'number')
                    result.token_estimate = context.token_estimate;
                else if (typeof context.tokenEstimate === 'number')
                    result.token_estimate = context.tokenEstimate;
                const person = summarizePerson(payload);
                if (Object.keys(person).length > 0)
                    result.person = person;
                const memories = Array.isArray(context.memories) ? context.memories : [];
                const shared = Array.isArray(context.shared) ? context.shared : [];
                result.memory_count = memories.length;
                result.shared_count = shared.length;
                if (ensured.warning !== undefined)
                    result.warning = ensured.warning;
                return result;
            }
            catch (error) {
                return failResult(error);
            }
        },
    };
}
function renderContext(value) {
    const prompt = (value.prompt ?? '').trim();
    const head = `Mnemos 人物上下文（person=${value.person_id ?? '默认人'}${typeof value.memory_count === 'number' ? `，记忆 ${value.memory_count} 条` : ''}${typeof value.shared_count === 'number' ? `，共享 ${value.shared_count} 条` : ''}${typeof value.token_estimate === 'number' ? `，约 ${value.token_estimate} token` : ''}）`;
    const lines = [head];
    lines.push(prompt === ''
        ? '（服务端没有返回 prompt：确认 person_id / 分区是否正确，或先用 mnemos_add 写入记忆）'
        : prompt);
    if (value.warning !== undefined)
        lines.push(`注意：${value.warning}`);
    return lines.join('\n');
}
/** 人管理：list（列表）/ get（详情）/ upsert（建档或更新资料）。 */
export function mnemosPersonTool(client, config, resolveWorkspacePath) {
    return {
        name: 'mnemos_person',
        description: '管理 Mnemos 里的「人」：action=list 列人（按 type / status / q / 分页），action=get 取人详情，' +
            'action=upsert 用 external_id 建档或更新展示名 / 类型 / 属性。' +
            '人不是登录账号：human 是 App 用户 / 员工，agent 是智能体。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'get', 'upsert'], description: '要执行的动作。' },
                person_id: {
                    type: 'string',
                    description: 'get/upsert 用：人的 external_id（或 self / 省略 = 默认人）；upsert 只接受 external_id，不接受 prs_* 内部 id。',
                },
                type: { type: 'string', enum: ['human', 'agent', 'service'], description: 'upsert：人的类型；list：按类型过滤。' },
                display_name: { type: 'string', description: 'upsert：展示名（控制台里看到的名字）。' },
                attributes: { type: 'object', additionalProperties: true, description: 'upsert：角色、模型、标签等自由属性。' },
                status: { type: 'string', description: 'list：按状态过滤（active / archived / deleted）。' },
                q: { type: 'string', description: 'list：按 external_id / 展示名模糊搜索。' },
                page: { type: 'integer', description: 'list：分页页码，从 1 开始。' },
            },
            required: ['action'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...BASE_PROPERTIES,
                    action_name: { type: 'string' },
                    person: OBJECT_SCHEMA,
                    people: OBJECT_ARRAY_SCHEMA,
                    count: { type: 'integer' },
                    page: { type: 'integer' },
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok ? renderPerson(value) : renderFailure('mnemos_person', value)),
        },
        async execute(args, exec) {
            try {
                const settings = config();
                const action = args.action;
                if (action !== 'list' && action !== 'get' && action !== 'upsert') {
                    return {
                        ok: false,
                        error: `mnemos_person 的 action 只能是 list / get / upsert，收到 ${String(action)}。`,
                        action: '传 action=list、get 或 upsert 后重试。',
                    };
                }
                if (action === 'upsert' && settings.readOnly)
                    return readOnlyResult();
                const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec);
                if (action === 'list') {
                    const page = typeof args.page === 'number' && args.page > 0 ? Math.trunc(args.page) : 1;
                    const payload = await client.listPersons(ensured.info.slug, {
                        type: args.type,
                        status: typeof args.status === 'string' && args.status !== '' ? args.status : undefined,
                        q: typeof args.q === 'string' && args.q !== '' ? args.q : undefined,
                        page,
                    });
                    const people = listFrom(payload, 'results', 'persons', 'people')
                        .filter((item) => asRecord(item) !== undefined)
                        .map((item) => summarizePerson(item));
                    const record = asRecord(payload);
                    const count = typeof record?.count === 'number' ? record.count : people.length;
                    const result = { ok: true, action_name: 'list', people, count, page };
                    if (ensured.warning !== undefined)
                        result.warning = ensured.warning;
                    return result;
                }
                const personId = resolvePersonId(args.person_id, settings);
                if (action === 'get') {
                    const payload = await client.getPerson(ensured.info.slug, personId);
                    const result = { ok: true, action_name: 'get', person: summarizePerson(payload) };
                    if (ensured.warning !== undefined)
                        result.warning = ensured.warning;
                    return result;
                }
                // upsert
                if (personId.startsWith('prs_')) {
                    return {
                        ok: false,
                        error: `upsert 需要 external_id，不能传内部 id（${personId}）。`,
                        action: '改用人的 external_id（App user_id / agent id）调用 upsert；只按内部 id 查询时用 action=get。',
                    };
                }
                const type = args.type ?? (personId === settings.personId ? settings.personType : undefined);
                const person = await client.ensurePerson(ensured.info.slug, personId, {
                    type,
                    displayName: typeof args.display_name === 'string' && args.display_name !== '' ? args.display_name : undefined,
                    attributes: asRecord(args.attributes),
                });
                const payload = await client.getPerson(ensured.info.slug, personId);
                const summary = summarizePerson(payload);
                summary.external_id = person.externalId;
                if (person.id !== undefined)
                    summary.id = person.id;
                const result = { ok: true, action_name: 'upsert', person: summary };
                if (ensured.warning !== undefined)
                    result.warning = ensured.warning;
                return result;
            }
            catch (error) {
                return failResult(error);
            }
        },
    };
}
function renderPerson(value) {
    if (value.action_name === 'list') {
        const people = value.people ?? [];
        const head = `Mnemos 人列表（第 ${value.page ?? 1} 页，共 ${value.count ?? people.length} 人）`;
        if (people.length === 0)
            return `${head}\n（没有匹配的人：先 mnemos_add / mnemos_workspace 建档，或放宽 type / q）`;
        const lines = people.map((person, index) => {
            const externalId = person.external_id ?? '(未知 external_id)';
            const name = person.display_name !== undefined ? ` · ${String(person.display_name)}` : '';
            const stats = asRecord(person.stats);
            const memories = typeof stats?.memories === 'number' ? ` · 记忆 ${stats.memories}` : '';
            return `${index + 1}. ${externalId}（type=${String(person.type ?? '-')}${name}${memories}）${person.id ? ` id=${String(person.id)}` : ''}`;
        });
        return [head, ...lines, ...(value.warning !== undefined ? [`注意：${value.warning}`] : [])].join('\n');
    }
    const person = value.person ?? {};
    const stats = asRecord(person.stats) ?? {};
    const lines = [
        `Mnemos 人：${person.external_id ?? person.display_name ?? '-'}（type=${person.type ?? '-'}${person.id ? `，id=${person.id}` : ''}）`,
        `展示名：${person.display_name ?? '-'} · 状态：${person.status ?? '-'}`,
    ];
    const parts = [
        typeof stats.memories === 'number' ? `记忆 ${stats.memories}` : '',
        typeof stats.shared_memories === 'number' ? `分区共享 ${stats.shared_memories}` : '',
        typeof stats.sessions === 'number' ? `会话 ${stats.sessions}` : '',
    ].filter(Boolean);
    if (parts.length > 0)
        lines.push(`统计：${parts.join(' · ')}`);
    if (value.warning !== undefined)
        lines.push(`注意：${value.warning}`);
    return lines.join('\n');
}
/** 连接自检：服务可达性、分区是否可达、默认人是否存在、org key 是否配置（不打印密钥）。 */
export function mnemosStatusTool(client, config, resolveWorkspacePath) {
    return {
        name: 'mnemos_status',
        description: '检查 Mnemos 连接与绑定：baseUrl、orgApiKey 是否配置、当前工作区分区是否可达、默认人是否存在。' +
            '只做读检查（不会自动建分区 / 建人），API Key 永远不会被打印。触发词：mnemos 状态 / 检查记忆服务 / check mnemos / health.',
        parameters: { type: 'object', properties: {} },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...BASE_PROPERTIES,
                    reachable: { type: 'boolean' },
                    baseUrl: { type: 'string' },
                    apiKeyConfigured: { type: 'boolean' },
                    partitionSlug: { type: 'string' },
                    partitionExists: { type: 'boolean' },
                    personId: { type: 'string' },
                    personType: { type: 'string' },
                    personExists: { type: 'boolean' },
                },
                required: ['ok', 'reachable', 'baseUrl', 'apiKeyConfigured'],
            },
            render: (_args, value) => text(renderStatus(value)),
        },
        async execute(_args, exec) {
            const settings = config();
            const baseUrl = client.resolvedBaseUrl();
            const apiKeyConfigured = client.isApiKeyConfigured();
            const base = {
                ok: false,
                reachable: false,
                baseUrl,
                apiKeyConfigured,
                personId: settings.personId,
                personType: settings.personType,
            };
            let identity;
            try {
                identity = partitionFor(settings, resolveWorkspacePath, exec);
            }
            catch (error) {
                return { ...base, ...failResult(error) };
            }
            base.partitionSlug = identity.slug;
            if (!apiKeyConfigured) {
                return {
                    ...base,
                    error: '未配置 Mnemos org API Key（orgApiKey 为空）。',
                    action: '在「设置 → 插件 → dsh-mnemos-personal」填写 orgApiKey（控制台「密钥」创建 kind=org 的 Key）。',
                };
            }
            try {
                // 只确认分区可达；不把分区大对象塞进状态结果。
                await client.getPartition(identity.slug);
                let personExists = false;
                try {
                    await client.getPerson(identity.slug, settings.personId);
                    personExists = true;
                }
                catch (error) {
                    if (!(error instanceof MnemosApiError) || error.status !== 404)
                        throw error;
                }
                const result = {
                    ...base,
                    ok: true,
                    reachable: true,
                    partitionExists: true,
                    personExists,
                };
                if (!personExists) {
                    result.warning = '分区可达，但默认人还不存在：调 mnemos_add / mnemos_workspace 会自动建档。';
                }
                return result;
            }
            catch (error) {
                if (error instanceof MnemosApiError && error.status === 404) {
                    return {
                        ...base,
                        reachable: true,
                        partitionExists: false,
                        error: error.message,
                        action: '分区尚不存在：调 mnemos_workspace 以当前工作区创建分区（需要带 admin 的 org key）。',
                    };
                }
                return { ...base, ...failResult(error) };
            }
        },
    };
}
function renderStatus(value) {
    const lines = [
        `Mnemos 连接：${value.reachable ? '服务可达' : '不可达'}`,
        `地址：${value.baseUrl || '(未配置)'}`,
        `鉴权：${value.apiKeyConfigured ? 'orgApiKey 已配置' : '未配置 orgApiKey'}`,
    ];
    if (value.partitionSlug !== undefined) {
        lines.push(`分区：${value.partitionSlug}（${value.partitionExists === true ? '存在' : value.partitionExists === false ? '不存在，需 mnemos_workspace 创建' : '未知'}）`);
    }
    lines.push(`默认人：${value.personId ?? '-'}（type=${value.personType ?? '-'}，${value.personExists === true ? '存在' : value.personExists === false ? '不存在' : '未知'}）`);
    if (value.ok !== true)
        lines.push(`原因：${value.error ?? '未知错误'}`);
    if (value.action !== undefined && value.action !== '')
        lines.push(`下一步：${value.action}`);
    if (value.warning !== undefined)
        lines.push(`注意：${value.warning}`);
    return lines.join('\n');
}
/* ------------------------------------------------------------------ */
/* 工具集合                                                            */
/* ------------------------------------------------------------------ */
/** 本插件的全部工具（顺序即注册顺序，也是 Agent 看到的大致顺序）。 */
export function createMnemosTools(client, config, resolveWorkspacePath) {
    return [
        mnemosWorkspaceTool(client, config, resolveWorkspacePath),
        mnemosAddTool(client, config, resolveWorkspacePath),
        mnemosSearchTool(client, config, resolveWorkspacePath),
        mnemosGetTool(client, config, resolveWorkspacePath),
        mnemosBriefTool(client, config, resolveWorkspacePath),
        mnemosContextTool(client, config, resolveWorkspacePath),
        mnemosPersonTool(client, config, resolveWorkspacePath),
        mnemosStatusTool(client, config, resolveWorkspacePath),
    ];
}
/** 工具名清单（装配测试 / 文档用）。 */
export const MNEMOS_TOOL_NAMES = [
    'mnemos_workspace',
    'mnemos_add',
    'mnemos_search',
    'mnemos_get',
    'mnemos_brief',
    'mnemos_context',
    'mnemos_person',
    'mnemos_status',
];
