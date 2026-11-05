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
/** 统一失败结果。 */
function fail(error) {
    return { ok: false, error: messageOf(error) };
}
/** readOnly 模式的统一提示。 */
const READ_ONLY_ERROR = 'readOnly 模式已开启（设置 → 插件 → dsh-mnemos → readOnly=false 可关闭），已拦截写入 / 任务变更 / Agent 注册 / 删除操作。';
/** 记忆对象的 JSON Schema：宽容，允许服务端新增字段。 */
const MEMORY_SCHEMA = { type: 'object', additionalProperties: true };
/** 记忆数组的 JSON Schema。 */
const MEMORY_ARRAY_SCHEMA = { type: 'array', items: MEMORY_SCHEMA };
/** 通用输出 schema 片段：ok / error。 */
const OK_ERROR_PROPERTIES = {
    ok: { type: 'boolean' },
    error: { type: 'string' },
};
function fmtNumber(value, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}
/** 记忆正文：v1 读视图用 `memory`，创建响应用 `content`。 */
function memoryContent(memory) {
    const value = memory?.memory ?? memory?.content;
    return typeof value === 'string' && value !== '' ? value : '(空内容)';
}
function memoryAgent(memory) {
    const value = memory.agent_id ?? memory.agentId;
    return typeof value === 'string' && value !== '' ? value : '-';
}
function memoryTask(memory) {
    const value = memory.task_id ?? memory.taskId;
    return typeof value === 'string' && value !== '' ? value : '-';
}
function memoryUser(memory) {
    const value = memory.user_id ?? memory.userId;
    return typeof value === 'string' && value !== '' ? value : '-';
}
function memoryTime(memory) {
    return memory.created_at ?? memory.createdAt ?? '-';
}
/**
 * 解析归属标识。
 *
 * - `user_id`：显式传的优先，否则用 `defaultUserId`（留空表示不带）。
 * - `agent_id`：只有 add / context / task 这些「以 Agent 身份做事」的调用才回落默认值；
 *   检索类调用必须显式传，否则会改变服务端的可见性判定。
 * - `task_id`：同理，只有写入与简报回落 `defaultTaskId`。
 */
function resolveIds(args, config, options = {}) {
    const ids = {};
    const user = args.user_id ?? config.defaultUserId;
    if (user)
        ids.user_id = user;
    const agent = args.agent_id ?? (options.fallbackAgent === true ? config.defaultAgentId : '');
    if (agent)
        ids.agent_id = agent;
    const task = args.task_id ?? (options.fallbackTask === true ? config.defaultTaskId : '');
    if (task)
        ids.task_id = task;
    return ids;
}
/** 一条检索命中的多行渲染：分数、分类/可见性/归属、内容、id。 */
function renderHit(hit, index) {
    const score = typeof hit.score === 'number' ? `[${hit.score.toFixed(3)}] ` : '';
    const meta = [
        hit.category ?? '未分类',
        hit.visibility ?? '-',
        `agent=${memoryAgent(hit)}`,
        `task=${memoryTask(hit)}`,
    ].join(' · ');
    const matched = Array.isArray(hit.matched_on) && hit.matched_on.length > 0 ? `（命中：${hit.matched_on.join('/')}）` : '';
    return `${index + 1}. ${score}${meta}${matched}\n   ${memoryContent(hit)}\n   id：${hit.id ?? '(未知)'}`;
}
/** 记忆列表渲染（无 id 时的列表路径）。 */
function renderMemoryList(memories) {
    return memories.map((memory, index) => renderHit(memory, index)).join('\n');
}
/** 一条记忆的详情渲染（按 id 读取）。 */
function renderMemoryDetail(memory) {
    const tags = Array.isArray(memory.tags) && memory.tags.length > 0 ? memory.tags.join(', ') : '-';
    const lines = [
        memoryContent(memory),
        `id：${memory.id ?? '(未知)'}`,
        `分类：${memory.category ?? '-'} · 重要度：${fmtNumber(memory.importance)} · 置信度：${fmtNumber(memory.confidence)}`,
        `状态：${memory.status ?? '-'} · 可见性：${memory.visibility ?? '-'} · user：${memoryUser(memory)} · agent：${memoryAgent(memory)} · task：${memoryTask(memory)}`,
        `标签：${tags}`,
        `创建：${memoryTime(memory)} · 更新：${memory.updated_at ?? memory.updatedAt ?? '-'} · 访问次数：${memory.access_count ?? memory.accessCount ?? '-'}`,
    ];
    if (typeof memory.score === 'number')
        lines.push(`检索分：${memory.score.toFixed(3)}`);
    if (Array.isArray(memory.history))
        lines.push(`历史：${memory.history.length} 条`);
    if (Array.isArray(memory.entities) && memory.entities.length > 0) {
        lines.push(`实体：${memory.entities.map((entity) => `${entity.name ?? '?'}(${entity.type ?? '?'})`).join(', ')}`);
    }
    return lines.join('\n');
}
/** 任务的一行摘要。 */
function renderTaskLine(task, index) {
    const prefix = index !== undefined ? `${index + 1}. ` : '';
    const owner = task.owner_agent_name ?? task.owner_agent_id ?? '-';
    const memories = typeof task.memory_count === 'number' ? ` · 记忆 ${task.memory_count}` : '';
    return `${prefix}${task.id ?? '(未知 id)'} · ${task.title ?? '(无标题)'} · ${task.status ?? '-'}（owner：${owner}${memories}）`;
}
/** 新增 / 合并 / 跳过 的计数（服务端在 events 里逐个事件给）。 */
function summarizeEvents(events, results) {
    if (events.length === 0)
        return { added: results.length, merged: 0, skipped: 0 };
    let added = 0;
    let merged = 0;
    let skipped = 0;
    for (const event of events) {
        if (event.type === 'ADD')
            added += 1;
        else if (event.type === 'MERGE' || event.type === 'UPDATE')
            merged += 1;
        else if (event.type === 'NOOP')
            skipped += 1;
    }
    return { added, merged, skipped };
}
/** 语义 + 关键词 + 实体混合检索。 */
export function mnemosSearchTool(client, config) {
    return {
        name: 'mnemos_search',
        description: '在 Mnemos 记忆系统里做混合检索（语义 + 关键词 + 实体 + 时效 + 重要度），返回带相关度分数的项目记忆。' +
            'agent_id 传调用方 Agent 身份：既能看项目共享记忆，也能看自己的私有记忆（不会过滤掉其他 Agent 的共享记忆）；' +
            '不传 agent_id 时只返回项目共享记忆。结果按项目隔离（项目由 API Key 决定）。' +
            '触发词：搜索记忆 / 查一下我记住的 / 找经验 / 以前怎么做的 / search memory / recall。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '自然语言查询（最长 2000 字）。' },
                top_k: { type: 'integer', description: '返回条数，默认取插件配置 defaultTopK（服务端上限 50）。' },
                threshold: { type: 'number', description: '最低融合分（0–1），低于它的结果不返回。' },
                user_id: { type: 'string', description: '按用户精确过滤。' },
                agent_id: { type: 'string', description: '调用方 Agent 身份，决定可见性；建议显式传自己的 Agent id。' },
                task_id: { type: 'string', description: '任务上下文：作为可见性依据，并且只返回该任务写入的记忆。' },
                visibility: {
                    type: 'string',
                    enum: ['project', 'agent', 'task'],
                    description: '只检索指定可见性的记忆。',
                },
                category: {
                    type: 'string',
                    enum: ['preference', 'identity', 'fact', 'plan', 'relationship', 'event', 'skill', 'constraint', 'context'],
                    description: '只检索指定分类。',
                },
            },
            required: ['query'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    count: { type: 'integer' },
                    tookMs: { type: 'number' },
                    results: MEMORY_ARRAY_SCHEMA,
                },
                required: ['ok', 'count'],
            },
            render: (args, value) => text(value.ok
                ? renderSearch(args.query, value)
                : `mnemos_search 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            try {
                const settings = config();
                const response = await client.search({
                    query: args.query,
                    user_id: args.user_id,
                    agent_id: args.agent_id,
                    task_id: args.task_id,
                    visibility: args.visibility,
                    category: args.category,
                    top_k: args.top_k ?? settings.defaultTopK,
                    threshold: args.threshold,
                });
                const results = response.results ?? [];
                return { ok: true, count: results.length, tookMs: response.took_ms, results };
            }
            catch (error) {
                return { ...fail(error), count: 0 };
            }
        },
    };
}
function renderSearch(query, value) {
    const results = value.results ?? [];
    const took = typeof value.tookMs === 'number' ? `，耗时 ${Math.round(value.tookMs)}ms` : '';
    const head = `Mnemos 搜索「${query}」→ ${value.count ?? results.length} 条${took}`;
    if (results.length === 0) {
        return `${head}\n（没有命中：可放宽 threshold、换更宽泛的关键词，或确认 agent_id 与项目是否正确）`;
    }
    return [head, renderMemoryList(results)].join('\n');
}
/** 写入记忆。 */
export function mnemosAddTool(client, config) {
    return {
        name: 'mnemos_add',
        description: '把值得沉淀的结论写进 Mnemos 记忆系统（默认原文入库，infer=true 才走事实抽取）。' +
            'messages 可传字符串（按 user 角色写入）或 [{role, content}] 数组；也可以直接传 text。' +
            '默认 visibility=project（项目共享，其他 Agent 也能检索到）；想只给某个 Agent 看用 agent（需 agent_id），' +
            '想只给某个任务用 task（需 task_id）。' +
            '触发词：记住 / 记下来 / 写入记忆 / 沉淀结论 / save to memory / remember this.',
        parameters: {
            type: 'object',
            properties: {
                messages: {
                    oneOf: [
                        { type: 'string', description: '一条消息内容（角色默认 user）。' },
                        {
                            type: 'array',
                            description: '对话式消息数组，服务端会按需抽取事实。',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
                                    content: { type: 'string' },
                                },
                                required: ['role', 'content'],
                            },
                        },
                    ],
                    description: '要记住的内容：字符串，或 [{role, content}] 数组（与 text 二选一）。',
                },
                text: { type: 'string', description: '纯文本记忆（与 messages 二选一，最长 20000 字）。' },
                user_id: { type: 'string', description: '记忆归属用户；默认取插件配置 defaultUserId（留空则不传）。' },
                agent_id: { type: 'string', description: '记忆归属 Agent；默认取插件配置 defaultAgentId。' },
                task_id: { type: 'string', description: '归属任务；默认取插件配置 defaultTaskId（留空则不传）。' },
                visibility: {
                    type: 'string',
                    enum: ['project', 'agent', 'task'],
                    description: 'project（默认，项目共享）/ agent（仅该 Agent）/ task（仅该任务）。',
                },
                infer: { type: 'boolean', description: 'true 时由服务端抽取事实（可能改写原文）；默认 false 原文入库。' },
                mode: {
                    type: 'string',
                    enum: ['additive', 'consolidate'],
                    description: 'additive（默认，直接追加）/ consolidate（高相似去重合并）。',
                },
                tags: { type: 'array', items: { type: 'string' }, description: '标签（服务端 /v1 版本较老时可能忽略）。' },
                metadata: { type: 'object', additionalProperties: true, description: '自定义元数据。' },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    results: MEMORY_ARRAY_SCHEMA,
                    events: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok ? renderAdd(value) : `mnemos_add 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            const settings = config();
            if (settings.readOnly)
                return { ok: false, error: READ_ONLY_ERROR, results: [], events: [] };
            const messages = typeof args.messages === 'string' ? [{ role: 'user', content: args.messages }] : args.messages;
            if (!args.text && (!messages || messages.length === 0)) {
                return {
                    ok: false,
                    error: '需要 messages 或 text 之一：messages 可以是字符串（按 user 角色写入）或 [{role, content}] 数组。',
                    results: [],
                    events: [],
                };
            }
            try {
                const response = await client.add({
                    ...(args.text ? { text: args.text } : { messages }),
                    ...resolveIds(args, settings, { fallbackAgent: true, fallbackTask: true }),
                    ...(args.visibility ? { visibility: args.visibility } : {}),
                    ...(args.metadata ? { metadata: args.metadata } : {}),
                    ...(args.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
                    ...(args.infer !== undefined ? { infer: args.infer } : {}),
                    ...(args.mode ? { mode: args.mode } : {}),
                });
                return { ok: true, results: response.results ?? [], events: response.events ?? [] };
            }
            catch (error) {
                return { ...fail(error), results: [], events: [] };
            }
        },
    };
}
function renderAdd(value) {
    const results = value.results ?? [];
    const { added, merged, skipped } = summarizeEvents(value.events ?? [], results);
    const head = `Mnemos 写入完成：新增 ${added} 条，合并 ${merged} 条` +
        (skipped > 0 ? `，跳过 ${skipped} 条（判定重复）` : '') +
        (results.length === 0 && merged === 0 ? '\n（没有产生新记忆：内容可能与既有记忆重复，或未抽取到事实）' : '');
    if (results.length === 0)
        return head;
    return [head, ...results.map((memory, index) => `${index + 1}. ${memoryContent(memory)}\n   id：${memory.id ?? '(未知)'}`)].join('\n');
}
/** 任务简报：开始任务时先取这个。 */
export function mnemosContextTool(client, config) {
    return {
        name: 'mnemos_context',
        description: '获取 Mnemos 任务简报（项目背景 / 规范约束 / 历史决策 / 相关经验 / 事故记录 / 私有笔记 / 进行中任务），' +
            '返回的 prompt 是可直接拼进 system prompt 的中文 Markdown。**开始一个任务时先调用它**，' +
            '比逐条 mnemos_search 更省 token 且更完整。task_id 决定任务上下文与默认检索词；agent_id 决定能看到哪些私有记忆。',
        parameters: {
            type: 'object',
            properties: {
                agent_id: { type: 'string', description: '调用方 Agent；默认取插件配置 defaultAgentId。' },
                task_id: { type: 'string', description: '当前任务；默认取插件配置 defaultTaskId。' },
                query: { type: 'string', description: '覆盖默认检索词（不传时按任务标题/目标检索）。' },
                budget_tokens: {
                    type: 'integer',
                    description: '简报 token 预算（服务端默认 1200，范围 60–8000），按重要度/时效截断。',
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    prompt: { type: 'string' },
                    token_estimate: { type: 'integer' },
                    citations: { type: 'array', items: { type: 'string' } },
                    sections: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    project: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
                    agent: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
                    task: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok ? renderContext(value) : `mnemos_context 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            try {
                const settings = config();
                const briefing = await client.context({
                    ...resolveIds(args, settings, { fallbackAgent: true, fallbackTask: true }),
                    query: args.query,
                    budget_tokens: args.budget_tokens,
                });
                const agent = briefing.agent
                    ? { id: briefing.agent.id, name: briefing.agent.name, role: briefing.agent.role }
                    : null;
                const task = briefing.task ? { id: briefing.task.id, title: briefing.task.title, status: briefing.task.status } : null;
                return {
                    ok: true,
                    prompt: briefing.prompt ?? '',
                    token_estimate: briefing.token_estimate,
                    citations: briefing.citations ?? [],
                    sections: briefing.sections ?? [],
                    project: briefing.project,
                    agent,
                    task,
                };
            }
            catch (error) {
                return fail(error);
            }
        },
    };
}
function renderContext(value) {
    const head = [
        'Mnemos 任务简报',
        value.project?.name ? `项目：${value.project.name}` : '',
        value.agent?.name ? `Agent：${value.agent.name}${value.agent.role ? `（${value.agent.role}）` : ''}` : '',
        value.task?.title ? `任务：${value.task.title}${value.task.id ? `（${value.task.id}）` : ''}` : '',
        typeof value.token_estimate === 'number' ? `约 ${value.token_estimate} tokens` : '',
        Array.isArray(value.citations) ? `${value.citations.length} 条引用` : '',
    ]
        .filter(Boolean)
        .join(' · ');
    const prompt = value.prompt ?? '';
    const body = prompt.trim() === '' ? '（服务端没有返回 prompt：检查 agent_id / task_id 是否属于当前项目，或项目里是否已有记忆）' : prompt;
    return `${head}\n${'-'.repeat(48)}\n${body}`;
}
/** 任务会话：开始 / 结束 / 列表 / 详情。 */
export function mnemosTaskTool(client, config) {
    return {
        name: 'mnemos_task',
        description: '管理 Mnemos 任务会话。action=start 开始任务（title 必填，可选 goal/branch/owner_agent_id）；' +
            'action=finish 结束任务（task_id 必填，decisions[] / lessons[] / notes[] 会被自动写成**项目共享记忆**并关联该任务，' +
            '这是把一次工作沉淀成团队经验的主要入口）；action=list 列出任务；action=get 查看单个任务。' +
            '推荐节奏：开始前 mnemos_context 取简报 → 干活 → mnemos_task finish 沉淀结论。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['start', 'finish', 'list', 'get'], description: '要执行的任务操作。' },
                title: { type: 'string', description: 'start：任务标题（必填）。' },
                goal: { type: 'string', description: 'start：任务目标。' },
                owner_agent_id: { type: 'string', description: 'start：任务归属 Agent；默认取 defaultAgentId。' },
                branch: { type: 'string', description: 'start：关联分支（如 feat/xxx）。' },
                task_id: { type: 'string', description: 'finish / get：任务 id（必填）。' },
                status: {
                    type: 'string',
                    enum: ['open', 'active', 'done', 'abandoned'],
                    description: 'finish 只接受 done / abandoned（默认 done）；list 可按状态过滤。',
                },
                summary: { type: 'string', description: 'finish：任务总结。' },
                decisions: { type: 'array', items: { type: 'string' }, description: 'finish：关键决策（写成 fact 类共享记忆）。' },
                lessons: { type: 'array', items: { type: 'string' }, description: 'finish：经验教训（写成 constraint 类共享记忆）。' },
                notes: { type: 'array', items: { type: 'string' }, description: 'finish：备注事件（写成 event 类共享记忆）。' },
                agent_id: { type: 'string', description: 'finish：执行结束动作的 Agent；默认取 defaultAgentId。' },
                limit: { type: 'integer', description: 'list：最多返回多少条（服务端上限 200）。' },
            },
            required: ['action'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    action: { type: 'string', enum: ['start', 'finish', 'list', 'get'] },
                    task: { type: 'object', additionalProperties: true },
                    tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    count: { type: 'integer' },
                    memories: MEMORY_ARRAY_SCHEMA,
                },
                required: ['ok', 'action'],
            },
            render: (_args, value) => text(value.ok ? renderTask(value) : `mnemos_task(${value.action}) 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            const settings = config();
            try {
                if (args.action === 'start') {
                    if (settings.readOnly)
                        return { ok: false, action: 'start', error: READ_ONLY_ERROR };
                    if (!args.title)
                        return { ok: false, action: 'start', error: '开始任务需要 title（一句话说明这次要做什么）。' };
                    const task = await client.createTask({
                        title: args.title,
                        goal: args.goal,
                        owner_agent_id: args.owner_agent_id ?? settings.defaultAgentId,
                        branch: args.branch,
                    });
                    return { ok: true, action: 'start', task };
                }
                if (args.action === 'finish') {
                    if (settings.readOnly)
                        return { ok: false, action: 'finish', error: READ_ONLY_ERROR };
                    if (!args.task_id)
                        return { ok: false, action: 'finish', error: '结束任务需要 task_id。' };
                    const status = args.status ?? 'done';
                    if (status !== 'done' && status !== 'abandoned') {
                        return { ok: false, action: 'finish', error: 'finish 的 status 只能是 done 或 abandoned。' };
                    }
                    const response = await client.finishTask(args.task_id, {
                        status,
                        summary: args.summary,
                        decisions: args.decisions,
                        lessons: args.lessons,
                        notes: args.notes,
                        agent_id: args.agent_id ?? settings.defaultAgentId,
                    });
                    return { ok: true, action: 'finish', task: response.task, memories: response.memories ?? [] };
                }
                if (args.action === 'list') {
                    const response = await client.listTasks({
                        status: args.status,
                        agent_id: args.agent_id,
                        limit: args.limit,
                    });
                    const tasks = response.results ?? [];
                    return { ok: true, action: 'list', tasks, count: response.count ?? tasks.length };
                }
                if (!args.task_id)
                    return { ok: false, action: 'get', error: '查看任务需要 task_id。' };
                const task = await client.getTask(args.task_id);
                return { ok: true, action: 'get', task };
            }
            catch (error) {
                return { ...fail(error), action: args.action };
            }
        },
    };
}
function renderTask(value) {
    if (value.action === 'start') {
        return value.task ? `Mnemos 任务已开始：\n${renderTaskLine(value.task)}` : 'Mnemos 任务已开始（服务端未返回任务详情）';
    }
    if (value.action === 'finish') {
        const task = value.task;
        const memories = value.memories ?? [];
        const head = task
            ? `Mnemos 任务已结束：\n${renderTaskLine(task)}`
            : 'Mnemos 任务已结束（服务端未返回任务详情）';
        if (memories.length === 0)
            return `${head}\n（没有沉淀新记忆：decisions / lessons / notes 为空，或内容与既有记忆重复）`;
        const lines = memories.map((memory, index) => `  ${index + 1}. [${memory.category ?? '-'}] ${memoryContent(memory)}`);
        return `${head}\n已沉淀 ${memories.length} 条项目共享记忆：\n${lines.join('\n')}`;
    }
    if (value.action === 'list') {
        const tasks = value.tasks ?? [];
        if (tasks.length === 0)
            return 'Mnemos 任务列表：当前没有任务（可用 action=start 开始一个）。';
        return [`Mnemos 任务列表（${value.count ?? tasks.length} 条）：`, ...tasks.map((task, index) => renderTaskLine(task, index))].join('\n');
    }
    const task = value.task;
    if (!task)
        return 'Mnemos 任务详情：服务端未返回任务。';
    const lines = [
        `${task.title ?? '(无标题)'}（${task.id ?? '(未知 id)'}）`,
        `状态：${task.status ?? '-'} · 分支：${task.branch ?? '-'} · owner：${task.owner_agent_name ?? task.owner_agent_id ?? '-'}`,
        task.goal ? `目标：${task.goal}` : '',
        task.summary ? `总结：${task.summary}` : '',
        `记忆：${task.memory_count ?? 0} 条 · 参与 Agent：${task.agent_count ?? 0}`,
        `创建：${task.created_at ?? '-'} · 结束：${task.ended_at ?? '进行中'}`,
    ].filter(Boolean);
    return lines.join('\n');
}
/** 读取记忆：按 id 取详情，或按条件列列表。 */
export function mnemosGetTool(client, config) {
    return {
        name: 'mnemos_get',
        description: '读取 Mnemos 记忆。传 id 返回该条详情（含历史、实体、关系）；不传 id 则分页列出记忆，可按 user_id / agent_id / task_id / category / status 过滤。' +
            '注意 status 与 sort 在插件侧本地过滤/排序（服务端列表接口只返回 active）。' +
            '触发词：读取记忆 / 查看记忆 / 列出记忆 / get memory / list memories.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '记忆 id（来自 mnemos_search 的结果）。' },
                user_id: { type: 'string', description: '按用户过滤。' },
                agent_id: { type: 'string', description: '按写入 Agent 过滤（恰好只看该 Agent 写的记忆）。' },
                task_id: { type: 'string', description: '按任务过滤。' },
                category: {
                    type: 'string',
                    enum: ['preference', 'identity', 'fact', 'plan', 'relationship', 'event', 'skill', 'constraint', 'context'],
                    description: '按分类过滤。',
                },
                status: { type: 'string', enum: ['active', 'archived', 'deleted'], description: '本地按状态过滤（默认 active）。' },
                page: { type: 'integer', description: '页码，从 1 开始。' },
                page_size: { type: 'integer', description: '每页条数（默认 20，上限 100）。' },
                sort: {
                    type: 'string',
                    enum: ['recent', 'importance', 'accessed'],
                    description: '本地排序：最近创建 / 重要度 / 最近访问。',
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    memory: MEMORY_SCHEMA,
                    count: { type: 'integer' },
                    total: { type: 'integer' },
                    page: { type: 'integer' },
                    page_size: { type: 'integer' },
                    results: MEMORY_ARRAY_SCHEMA,
                },
                required: ['ok'],
            },
            render: (_args, value) => text(value.ok
                ? value.memory
                    ? renderMemoryDetail(value.memory)
                    : renderGetList(value)
                : `mnemos_get 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            try {
                if (args.id) {
                    const memory = await client.getMemory(args.id);
                    return { ok: true, memory };
                }
                const response = await client.listMemories({
                    user_id: args.user_id,
                    agent_id: args.agent_id,
                    task_id: args.task_id,
                    category: args.category,
                    status: args.status,
                    sort: args.sort,
                    page: args.page,
                    page_size: args.page_size,
                });
                let results = response.results ?? [];
                const total = response.count ?? results.length;
                // 服务端列表固定按 active 取；status / sort 在插件侧再收一次，保证过滤语义一致。
                if (args.status)
                    results = results.filter((memory) => memory.status === args.status);
                results = sortMemories(results, args.sort);
                return {
                    ok: true,
                    count: results.length,
                    total,
                    page: response.page,
                    page_size: response.page_size,
                    results,
                };
            }
            catch (error) {
                return fail(error);
            }
        },
    };
}
function sortMemories(memories, sort) {
    if (!sort || sort === 'recent')
        return memories;
    const copy = [...memories];
    if (sort === 'importance')
        copy.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    else
        copy.sort((a, b) => (b.access_count ?? b.accessCount ?? 0) - (a.access_count ?? a.accessCount ?? 0));
    return copy;
}
function renderGetList(value) {
    const results = value.results ?? [];
    const pageInfo = value.page !== undefined ? `第 ${value.page} 页` : '';
    const sizeInfo = value.page_size !== undefined ? `每页 ${value.page_size}` : '';
    const head = `Mnemos 记忆列表：${value.count ?? results.length} 条（项目共 ${value.total ?? value.count ?? 0} 条${pageInfo ? `，${pageInfo}` : ''}${sizeInfo ? `，${sizeInfo}` : ''}）`;
    if (results.length === 0) {
        return (`${head}\n（没有符合条件的记忆。注意 /v1 列表接口只返回 active 记忆 —— ` +
            '按 archived / deleted 状态列举会一律为空，需要时请在控制台查看。）');
    }
    return [head, renderMemoryList(results)].join('\n');
}
/** `/v1` 更新接口当前只应用这三个字段（见 docs/api.md §4 与 server 的 v1UpdateSchema）。 */
const UPDATE_SUPPORTED = ['content', 'category', 'importance'];
/** 更新记忆。 */
export function mnemosUpdateTool(client, config) {
    return {
        name: 'mnemos_update',
        description: '更新一条 Mnemos 记忆（先用 mnemos_search / mnemos_get 拿到 id）。' +
            '当前 Mnemos /v1 更新接口只应用 content（正文）、category（分类）、importance（重要度）；' +
            'status / tags / metadata 会随请求发出但服务端可能忽略，返回值里的 ignored 会标出来。' +
            '触发词：更新记忆 / 修改记忆 / update memory / edit memory.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '要更新的记忆 id（必填）。' },
                content: { type: 'string', description: '新的正文。' },
                category: {
                    type: 'string',
                    enum: ['preference', 'identity', 'fact', 'plan', 'relationship', 'event', 'skill', 'constraint', 'context'],
                    description: '新的分类。',
                },
                importance: { type: 'number', description: '新的重要度（0–1）。' },
                status: { type: 'string', enum: ['active', 'archived', 'deleted'], description: '目标状态（当前 /v1 可能忽略）。' },
                tags: { type: 'array', items: { type: 'string' }, description: '标签（当前 /v1 可能忽略）。' },
                metadata: { type: 'object', additionalProperties: true, description: '元数据（当前 /v1 可能忽略）。' },
            },
            required: ['id'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    id: { type: 'string' },
                    applied: { type: 'array', items: { type: 'string' } },
                    ignored: { type: 'array', items: { type: 'string' } },
                    message: { type: 'string' },
                },
                required: ['ok'],
            },
            render: (args, value) => text(value.ok ? renderUpdate(args.id, value) : `mnemos_update 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            const settings = config();
            if (settings.readOnly)
                return { ok: false, id: args.id, error: READ_ONLY_ERROR };
            if (!args.id)
                return { ok: false, error: '更新记忆需要 id。' };
            const applied = UPDATE_SUPPORTED.filter((field) => {
                if (field === 'content')
                    return args.content !== undefined;
                if (field === 'category')
                    return args.category !== undefined;
                return args.importance !== undefined;
            });
            const ignored = ['status', 'tags', 'metadata'].filter((field) => args[field] !== undefined);
            if (applied.length === 0) {
                if (ignored.length === 0) {
                    return { ok: false, id: args.id, error: '请至少提供 content / category / importance 之一。' };
                }
                return {
                    ok: false,
                    id: args.id,
                    ignored: [...ignored],
                    error: `当前 Mnemos /v1 更新接口只支持 content / category / importance，无法只改 ${ignored.join(' / ')}；请改用控制台或等接口支持。`,
                };
            }
            try {
                const response = await client.updateMemory(args.id, {
                    content: args.content,
                    category: args.category,
                    importance: args.importance,
                });
                return {
                    ok: true,
                    id: args.id,
                    applied: [...applied],
                    ...(ignored.length > 0 ? { ignored: [...ignored] } : {}),
                    message: response?.message ?? '',
                };
            }
            catch (error) {
                return { ...fail(error), id: args.id };
            }
        },
    };
}
function renderUpdate(id, value) {
    const head = `Mnemos 已更新 memory ${id}：${(value.applied ?? []).join(', ')}`;
    const ignored = value.ignored ?? [];
    if (ignored.length === 0)
        return head;
    return `${head}\n注意：${ignored.join(' / ')} 当前 /v1 更新接口不支持，未应用（服务端会忽略）。`;
}
/** 删除记忆（必须 confirm: true）。 */
export function mnemosDeleteTool(client, config) {
    return {
        name: 'mnemos_delete',
        description: '删除一条 Mnemos 记忆（软删除，会写历史）。破坏性操作：必须先向用户展示目标记忆，再以 confirm: true 调用。' +
            '触发词：删除记忆 / delete memory / remove memory.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '要删除的记忆 id（必填）。' },
                confirm: { type: 'boolean', description: '必须显式传 true 才会执行删除。' },
            },
            required: ['id'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: { ...OK_ERROR_PROPERTIES, id: { type: 'string' }, message: { type: 'string' } },
                required: ['ok'],
            },
            render: (args, value) => text(value.ok ? `Mnemos 已删除 memory ${args.id}（软删除）：${value.message ?? 'ok'}` : `mnemos_delete 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            const settings = config();
            if (settings.readOnly)
                return { ok: false, id: args.id, error: READ_ONLY_ERROR };
            if (!args.id)
                return { ok: false, error: '删除记忆需要 id。' };
            if (args.confirm !== true) {
                return {
                    ok: false,
                    id: args.id,
                    error: '删除需要显式确认：先展示目标记忆（mnemos_get），用户同意后再以 confirm: true 调用。',
                };
            }
            try {
                const response = await client.deleteMemory(args.id);
                return { ok: true, id: args.id, message: response?.message ?? '' };
            }
            catch (error) {
                return { ...fail(error), id: args.id };
            }
        },
    };
}
/** 记忆变更历史。 */
export function mnemosHistoryTool(client) {
    return {
        name: 'mnemos_history',
        description: '查看一条 Mnemos 记忆的完整变更历史（新增 / 更新 / 删除 / 合并事件、旧值与新值、操作者、时间）。' +
            '先用 mnemos_search 或 mnemos_get 拿到 id。触发词：记忆历史 / history of memory.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '要查看历史的记忆 id（必填）。' },
            },
            required: ['id'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    id: { type: 'string' },
                    history: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
                required: ['ok'],
            },
            render: (args, value) => text(value.ok ? renderHistory(args.id, value.history ?? []) : `mnemos_history 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            try {
                if (!args.id)
                    return { ok: false, error: '查看历史需要 id。' };
                const history = await client.history(args.id);
                return { ok: true, id: args.id, history };
            }
            catch (error) {
                return fail(error);
            }
        },
    };
}
function renderHistory(id, history) {
    if (history.length === 0)
        return `memory ${id} 没有历史记录。`;
    const lines = history.map((entry, index) => {
        const change = entry.old_memory === null || entry.old_memory === undefined
            ? `→ ${entry.new_memory ?? '(空)'}`
            : `${entry.old_memory} → ${entry.new_memory ?? '(空)'}`;
        const actor = entry.actor ? ` · ${entry.actor}` : '';
        return `${index + 1}. [${entry.event ?? '?'}] ${entry.created_at ?? ''}${actor}\n   ${change}`;
    });
    return [`memory ${id} 的历史（${history.length} 条）：`, ...lines].join('\n');
}
/** Agent 注册表：列出 / 注册。 */
export function mnemosAgentTool(client, config) {
    return {
        name: 'mnemos_agent',
        description: 'Mnemos Agent 注册表。action=list 列出项目内 Agent（角色、模型、记忆/任务统计）；' +
            'action=register 注册一个新 Agent（name 必填，可选 role / model / capabilities）。' +
            '注册后该 Agent 的 id 可用来做写入归属（agent_id）与检索可见性判定。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'register'], description: '列出现有 Agent 或注册新 Agent。' },
                name: { type: 'string', description: 'register：Agent 名称（必填）。' },
                role: { type: 'string', description: 'register：角色，如 coder / reviewer / oncall。' },
                model: { type: 'string', description: 'register：使用的模型。' },
                capabilities: { type: 'array', items: { type: 'string' }, description: 'register：能力标签。' },
            },
            required: ['action'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    action: { type: 'string', enum: ['list', 'register'] },
                    agent: { type: 'object', additionalProperties: true },
                    agents: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    count: { type: 'integer' },
                },
                required: ['ok', 'action'],
            },
            render: (_args, value) => text(value.ok ? renderAgent(value) : `mnemos_agent(${value.action}) 失败：${value.error ?? '未知错误'}`),
        },
        async execute(args) {
            const settings = config();
            try {
                if (args.action === 'list') {
                    const response = await client.listAgents();
                    const agents = response.results ?? [];
                    return { ok: true, action: 'list', agents, count: response.count ?? agents.length };
                }
                if (settings.readOnly)
                    return { ok: false, action: 'register', error: READ_ONLY_ERROR };
                if (!args.name)
                    return { ok: false, action: 'register', error: '注册 Agent 需要 name。' };
                const agent = await client.createAgent({
                    name: args.name,
                    role: args.role,
                    model: args.model,
                    capabilities: args.capabilities,
                });
                return { ok: true, action: 'register', agent };
            }
            catch (error) {
                return { ...fail(error), action: args.action };
            }
        },
    };
}
function renderAgent(value) {
    if (value.action === 'register') {
        const agent = value.agent;
        if (!agent)
            return 'Mnemos 已注册 Agent（服务端未返回详情）。';
        return `Mnemos 已注册 Agent：${agent.name ?? '(无名)'}（${agent.id ?? '未知 id'}）· role：${agent.role ?? '-'} · model：${agent.model ?? '-'} · 能力：${(agent.capabilities ?? []).join(', ') || '-'}`;
    }
    const agents = value.agents ?? [];
    if (agents.length === 0)
        return 'Mnemos Agent 列表：当前项目还没有注册 Agent（可用 action=register 注册一个）。';
    const lines = agents.map((agent, index) => {
        const stats = agent.stats;
        const statText = stats
            ? ` · 记忆 ${stats.memories ?? 0}（私有 ${stats.private_memories ?? 0}）· 任务 ${stats.tasks ?? 0}`
            : '';
        return `${index + 1}. ${agent.name ?? '(无名)'}（${agent.id ?? '?'}）· ${agent.role ?? '-'} · ${agent.model ?? '-'}${statText}`;
    });
    return [`Mnemos Agent 列表（${value.count ?? agents.length} 个）：`, ...lines].join('\n');
}
/** 连接与配置自检。 */
export function mnemosStatusTool(client, config) {
    return {
        name: 'mnemos_status',
        description: '检查 Mnemos 连接：服务是否可达（/v1/health）、当前 baseUrl、apiKey 是否已配置，并在密钥有 admin 作用域时附带项目统计。' +
            'API Key 永远不会被打印出来。触发词：mnemos 状态 / 检查记忆服务 / check mnemos / health.',
        parameters: {
            type: 'object',
            properties: {},
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    ...OK_ERROR_PROPERTIES,
                    reachable: { type: 'boolean' },
                    baseUrl: { type: 'string' },
                    apiKeyConfigured: { type: 'boolean' },
                    version: { type: 'string' },
                    uptimeMs: { type: 'number' },
                    stats: { type: 'object', additionalProperties: true },
                    statsError: { type: 'string' },
                },
                required: ['ok', 'reachable', 'baseUrl', 'apiKeyConfigured'],
            },
            render: (_args, value) => text(renderStatus(value)),
        },
        async execute() {
            const settings = config();
            const baseUrl = (settings.baseUrl ?? '').trim().replace(/\/+$/, '');
            const apiKeyConfigured = client.isApiKeyConfigured();
            try {
                const health = await client.health();
                const result = {
                    ok: true,
                    reachable: true,
                    baseUrl,
                    apiKeyConfigured,
                    version: typeof health.version === 'string' ? health.version : undefined,
                    uptimeMs: typeof health.uptime_ms === 'number' ? health.uptime_ms : undefined,
                };
                // /v1/stats 需要 admin 作用域；日常 Agent 用的只读 Key 会 403，降级为「只报 health」。
                try {
                    const stats = await client.stats();
                    result.stats = stats.metrics;
                }
                catch (error) {
                    result.statsError = messageOf(error);
                }
                return result;
            }
            catch (error) {
                return { ...fail(error), reachable: false, baseUrl, apiKeyConfigured };
            }
        },
    };
}
function renderStatus(value) {
    if (!value.ok) {
        return [
            'Mnemos 服务不可达',
            `地址：${value.baseUrl || '(未配置)'}`,
            `原因：${value.error ?? '未知错误'}`,
        ].join('\n');
    }
    const lines = [
        `Mnemos 服务可达${value.version ? ` · 版本 ${value.version}` : ''}${typeof value.uptimeMs === 'number' ? ` · 已运行 ${(value.uptimeMs / 1000 / 60).toFixed(0)} 分钟` : ''}`,
        `地址：${value.baseUrl || '(未配置)'}`,
        `鉴权：${value.apiKeyConfigured ? 'apiKey 已配置' : '未配置 apiKey（除健康检查外都会失败）'}`,
    ];
    if (value.stats) {
        const stats = value.stats;
        const parts = [
            typeof stats.total_memories === 'number' ? `记忆 ${stats.total_memories}` : '',
            typeof stats.agents === 'number' ? `Agent ${stats.agents}` : '',
            typeof stats.searches_7d === 'number' ? `近 7 天检索 ${stats.searches_7d} 次` : '',
            typeof stats.hit_rate === 'number' ? `命中率 ${(stats.hit_rate * 100).toFixed(1)}%` : '',
            typeof stats.recall_p95_ms === 'number' ? `召回 p95 ${stats.recall_p95_ms}ms` : '',
        ].filter(Boolean);
        if (parts.length > 0)
            lines.push(`统计：${parts.join(' · ')}`);
    }
    if (value.statsError)
        lines.push(`统计不可用（需 admin 作用域）：${value.statsError}`);
    return lines.join('\n');
}
/* ------------------------------------------------------------------ */
/* 工具集合                                                            */
/* ------------------------------------------------------------------ */
/** 本插件的全部工具（顺序即注册顺序，也是 Agent 看到的大致顺序）。 */
export function createMnemosTools(client, config) {
    return [
        mnemosSearchTool(client, config),
        mnemosAddTool(client, config),
        mnemosContextTool(client, config),
        mnemosTaskTool(client, config),
        mnemosGetTool(client, config),
        mnemosUpdateTool(client, config),
        mnemosDeleteTool(client, config),
        mnemosHistoryTool(client),
        mnemosAgentTool(client, config),
        mnemosStatusTool(client, config),
    ];
}
