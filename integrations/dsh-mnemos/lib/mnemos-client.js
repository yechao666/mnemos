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
/** 请求失败（非 2xx、网络错误、配置缺失）。 */
export class MnemosApiError extends Error {
    status;
    code;
    requestId;
    details;
    method;
    path;
    constructor(init) {
        super(init.message);
        this.name = 'MnemosApiError';
        this.status = init.status;
        this.code = init.code ?? 'unknown_error';
        this.requestId = init.requestId;
        this.details = init.details;
        this.method = init.method;
        this.path = init.path;
    }
}
/** 请求超时（继承 MnemosApiError，`code === 'timeout'`）。 */
export class MnemosTimeoutError extends MnemosApiError {
    timeoutMs;
    constructor(timeoutMs, method, path) {
        super({
            message: `Mnemos ${method} ${path} 请求超时（${timeoutMs}ms）。可调大「设置 → 插件 → dsh-mnemos → timeoutMs」，或检查服务是否正常运行。`,
            code: 'timeout',
            method,
            path,
        });
        this.name = 'MnemosTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}
/** 需要重试的读路径（POST 但语义只读）。 */
const RETRYABLE_PATHS = new Set(['/v1/memories/search', '/v1/context']);
/** 总尝试次数：首次 + 1 次重试。 */
const MAX_ATTEMPTS = 2;
/** 重试前的固定退避。 */
const RETRY_DELAY_MS = 200;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 网络层异常（fetch 直接 reject）统一归一。 */
function isTimeoutError(error) {
    return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
/** 组装可执行的错误提示（把「下一步该做什么」写进 message）。 */
function hintFor(status, code) {
    // 服务端的错误码是大写（INVALID_API_KEY / FORBIDDEN / NOT_FOUND …），本地错误码是小写，
    // 统一按大写比较，避免两套命名漏判。
    const normalized = code.toUpperCase();
    if (status === 401 || normalized === 'INVALID_API_KEY' || normalized === 'UNAUTHORIZED' || normalized === 'API_KEY_REVOKED') {
        return 'Key 无效或已失效：请在「设置 → 插件 → dsh-mnemos」检查 apiKey。';
    }
    if (status === 403 || normalized === 'FORBIDDEN') {
        return '当前 Key 作用域不足：/v1 读写需要 memories:read / memories:write，/v1/stats 另需 admin。';
    }
    if (status === 404 || normalized === 'NOT_FOUND') {
        return '目标不存在或不属于当前项目：检查记忆 / 任务 id；若报的是 Agent 不存在，先用 mnemos_agent action=list 查看项目内 Agent，或 action=register 注册后再重试。';
    }
    if (status === 429 || normalized === 'RATE_LIMITED' || normalized === 'QUOTA_EXCEEDED') {
        return '触发限流或月度配额，稍后重试或换 Key。';
    }
    if (status === 400 || normalized === 'VALIDATION_ERROR' || normalized === 'BAD_REQUEST') {
        return '参数被服务端拒绝：检查取值范围（top_k ≤ 50、page_size ≤ 100、budget_tokens 60–8000、finish 的 status 只能是 done / abandoned）。';
    }
    return '';
}
/**
 * 读取活配置的 Mnemos 客户端：每次请求都重新解析配置，
 * 因此设置页改动（baseUrl / apiKey / timeoutMs）无需重建客户端或重挂工具。
 */
export class MnemosClient {
    config;
    constructor(config) {
        this.config = config;
    }
    /** 规范化后的服务地址（去掉尾部斜杠）。 */
    get baseUrl() {
        const raw = (this.config().baseUrl ?? '').trim();
        if (!raw) {
            throw new MnemosApiError({
                message: '未配置 Mnemos 服务地址：请在「设置 → 插件 → dsh-mnemos」填写 baseUrl（默认 http://127.0.0.1:4380）。',
                code: 'missing_base_url',
            });
        }
        return raw.replace(/\/+$/, '');
    }
    /** 当前是否配置了 API Key（只报布尔，绝不返回密钥）。 */
    isApiKeyConfigured() {
        return Boolean(this.config().apiKey?.trim());
    }
    /** 是否需要在「网络错误 / 503 / 504」时重试。 */
    shouldRetry(method, path) {
        return method === 'GET' || RETRYABLE_PATHS.has(path);
    }
    /**
     * 发一个请求，带一次重试（仅读路径、仅网络错误 / 503 / 504）。
     */
    async request(method, path, options) {
        for (let attempt = 1;; attempt++) {
            try {
                return await this.once(method, path, options);
            }
            catch (error) {
                // 只有「网络层失败」与 503 / 504 算瞬时故障；超时、鉴权、校验错误不重试。
                const transient = error instanceof MnemosApiError &&
                    (error.status === 503 || error.status === 504 || error.code === 'network_error');
                if (attempt >= MAX_ATTEMPTS || !this.shouldRetry(method, path) || !transient)
                    throw error;
                await sleep(RETRY_DELAY_MS);
            }
        }
    }
    /** 单次请求：拼 URL、鉴权、超时、解析错误体。 */
    async once(method, path, options) {
        let url;
        try {
            url = new URL(this.baseUrl + path);
        }
        catch {
            throw new MnemosApiError({
                message: `Mnemos 服务地址不可用：${this.config().baseUrl || '(空)'}（应为 http://host:port 形式）`,
                code: 'invalid_base_url',
                method,
                path,
            });
        }
        if (options?.query) {
            for (const [key, value] of Object.entries(options.query)) {
                if (value !== undefined && value !== null && value !== '')
                    url.searchParams.set(key, String(value));
            }
        }
        const apiKey = (this.config().apiKey ?? '').trim();
        // /v1/health 不需要鉴权；其余接口没有 Key 就没必要打网络。
        if (!apiKey && path !== '/v1/health') {
            throw new MnemosApiError({
                message: '未配置 Mnemos API Key：请在「设置 → 插件 → dsh-mnemos」填写 apiKey（控制台「项目 · 密钥」创建，mnemos_live_*）。',
                code: 'missing_api_key',
                method,
                path,
            });
        }
        const headers = { Accept: 'application/json' };
        if (apiKey)
            headers.Authorization = `Bearer ${apiKey}`;
        if (options?.body !== undefined)
            headers['Content-Type'] = 'application/json';
        const timeoutMs = this.config().timeoutMs ?? 15000;
        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: options?.body === undefined ? undefined : JSON.stringify(options.body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (error) {
            if (isTimeoutError(error))
                throw new MnemosTimeoutError(timeoutMs, method, path);
            throw new MnemosApiError({
                message: `Mnemos ${method} ${path} 连接失败：${error instanceof Error ? error.message : String(error)}。检查服务是否启动、baseUrl 是否正确。`,
                code: 'network_error',
                method,
                path,
            });
        }
        const raw = await response.text().catch(() => '');
        let payload = null;
        if (raw !== '') {
            try {
                payload = JSON.parse(raw);
            }
            catch {
                payload = raw;
            }
        }
        if (!response.ok) {
            const error = payload?.error;
            const code = typeof error?.code === 'string' ? error.code : `http_${response.status}`;
            const detail = typeof error?.message === 'string' ? error.message : typeof payload === 'string' ? payload.slice(0, 500) : response.statusText;
            const requestId = error?.requestId ?? response.headers.get('x-request-id') ?? undefined;
            const hint = hintFor(response.status, code);
            throw new MnemosApiError({
                message: `Mnemos ${method} ${path} -> ${response.status} ${code}: ${detail}${hint ? `（${hint}）` : ''}`,
                status: response.status,
                code,
                requestId,
                details: error?.details,
                method,
                path,
            });
        }
        if (response.status === 204)
            return undefined;
        return payload;
    }
    /** `GET /v1/health` —— 存活检查（无需鉴权）。 */
    health() {
        return this.request('GET', '/v1/health');
    }
    /** `GET /v1/stats` —— 项目指标（需要 admin 作用域）。 */
    stats() {
        return this.request('GET', '/v1/stats');
    }
    /** `POST /v1/memories/search` —— 混合检索。 */
    search(options) {
        const body = { query: options.query };
        if (options.user_id)
            body.user_id = options.user_id;
        if (options.agent_id)
            body.agent_id = options.agent_id;
        if (options.run_id)
            body.run_id = options.run_id;
        if (options.app_id)
            body.app_id = options.app_id;
        if (options.task_id)
            body.task_id = options.task_id;
        if (options.visibility)
            body.visibility = options.visibility;
        if (options.top_k !== undefined)
            body.top_k = options.top_k;
        if (options.threshold !== undefined)
            body.threshold = options.threshold;
        const filters = {};
        if (options.category)
            filters.category = options.category;
        if (options.status)
            filters.status = options.status;
        if (options.tags && options.tags.length > 0)
            filters.tags = options.tags;
        if (options.min_importance !== undefined)
            filters.min_importance = options.min_importance;
        if (Object.keys(filters).length > 0)
            body.filters = filters;
        return this.request('POST', '/v1/memories/search', { body });
    }
    /** `POST /v1/memories` —— 写入记忆（messages 与 text 二选一）。 */
    add(options) {
        const body = {};
        if (options.messages && options.messages.length > 0)
            body.messages = options.messages;
        if (options.text !== undefined && options.text !== '')
            body.text = options.text;
        if (options.user_id)
            body.user_id = options.user_id;
        if (options.agent_id)
            body.agent_id = options.agent_id;
        if (options.run_id)
            body.run_id = options.run_id;
        if (options.app_id)
            body.app_id = options.app_id;
        if (options.task_id)
            body.task_id = options.task_id;
        if (options.visibility)
            body.visibility = options.visibility;
        if (options.metadata)
            body.metadata = options.metadata;
        if (options.tags && options.tags.length > 0)
            body.tags = options.tags;
        if (options.infer !== undefined)
            body.infer = options.infer;
        if (options.mode)
            body.mode = options.mode;
        return this.request('POST', '/v1/memories', { body });
    }
    /** `GET /v1/memories` —— 分页列表。 */
    listMemories(options = {}) {
        return this.request('GET', '/v1/memories', {
            query: {
                user_id: options.user_id,
                agent_id: options.agent_id,
                run_id: options.run_id,
                app_id: options.app_id,
                task_id: options.task_id,
                visibility: options.visibility,
                category: options.category,
                status: options.status,
                sort: options.sort,
                page: options.page,
                page_size: options.page_size,
            },
        });
    }
    /** `GET /v1/memories/{id}` —— 详情（含历史 / 实体 / 关系）。 */
    getMemory(id) {
        return this.request('GET', `/v1/memories/${encodeURIComponent(id)}`);
    }
    /** `PUT /v1/memories/{id}` —— 更新正文 / 分类 / 重要度。 */
    updateMemory(id, options) {
        const body = {};
        if (options.content !== undefined)
            body.text = options.content;
        if (options.category)
            body.category = options.category;
        if (options.importance !== undefined)
            body.importance = options.importance;
        if (Object.keys(body).length === 0) {
            throw new MnemosApiError({
                message: '更新记忆至少需要 content / category / importance 之一。',
                code: 'invalid_request',
                method: 'PUT',
                path: `/v1/memories/${id}`,
            });
        }
        return this.request('PUT', `/v1/memories/${encodeURIComponent(id)}`, { body });
    }
    /** `DELETE /v1/memories/{id}` —— 软删除（写历史）。 */
    deleteMemory(id) {
        return this.request('DELETE', `/v1/memories/${encodeURIComponent(id)}`);
    }
    /** `GET /v1/memories/{id}/history` —— 变更历史（服务端包了一层 results）。 */
    async history(id) {
        const response = await this.request('GET', `/v1/memories/${encodeURIComponent(id)}/history`);
        return response?.results ?? [];
    }
    /** `POST /v1/memories/{id}/feedback` —— 有用/无用反馈，调整重要度。 */
    feedback(id, helpful, query) {
        const body = { helpful };
        if (query)
            body.query = query;
        return this.request('POST', `/v1/memories/${encodeURIComponent(id)}/feedback`, { body });
    }
    /** `POST /v1/context` —— 任务简报（可直接拼进 system prompt）。 */
    context(options = {}) {
        const body = {};
        if (options.agent_id)
            body.agent_id = options.agent_id;
        if (options.task_id)
            body.task_id = options.task_id;
        if (options.query)
            body.query = options.query;
        if (options.budget_tokens !== undefined)
            body.budget_tokens = options.budget_tokens;
        return this.request('POST', '/v1/context', { body });
    }
    /** `GET /v1/tasks` —— 任务列表。 */
    listTasks(options = {}) {
        return this.request('GET', '/v1/tasks', {
            query: { status: options.status, agent_id: options.agent_id, limit: options.limit },
        });
    }
    /** `GET /v1/tasks/{id}` —— 任务详情。 */
    getTask(id) {
        return this.request('GET', `/v1/tasks/${encodeURIComponent(id)}`);
    }
    /** `POST /v1/tasks` —— 开始任务。 */
    createTask(options) {
        const body = { title: options.title };
        if (options.goal)
            body.goal = options.goal;
        if (options.owner_agent_id)
            body.owner_agent_id = options.owner_agent_id;
        if (options.branch)
            body.branch = options.branch;
        return this.request('POST', '/v1/tasks', { body });
    }
    /** `POST /v1/tasks/{id}/finish` —— 结束任务（decisions/lessons/notes 会写成项目共享记忆）。 */
    finishTask(id, options = {}) {
        const body = {};
        if (options.status)
            body.status = options.status;
        if (options.summary)
            body.summary = options.summary;
        if (options.decisions && options.decisions.length > 0)
            body.decisions = options.decisions;
        if (options.lessons && options.lessons.length > 0)
            body.lessons = options.lessons;
        if (options.notes && options.notes.length > 0)
            body.notes = options.notes;
        if (options.agent_id)
            body.agent_id = options.agent_id;
        return this.request('POST', `/v1/tasks/${encodeURIComponent(id)}/finish`, { body });
    }
    /** `GET /v1/agents` —— 项目内 Agent 注册表。 */
    listAgents() {
        return this.request('GET', '/v1/agents');
    }
    /** `POST /v1/agents` —— 注册 Agent。 */
    createAgent(options) {
        const body = { name: options.name };
        if (options.role)
            body.role = options.role;
        if (options.model)
            body.model = options.model;
        if (options.capabilities && options.capabilities.length > 0)
            body.capabilities = options.capabilities;
        return this.request('POST', '/v1/agents', { body });
    }
}
