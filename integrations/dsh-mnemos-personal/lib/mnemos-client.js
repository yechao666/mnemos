/**
 * Mnemos v6 中立 REST 客户端（`/v1/partitions/:partition/...`，org key 鉴权，snake_case 入参）。
 *
 * 契约来源：本仓库 `docs/v6-architecture.md` 第 3 节「API（v6，干净面）」：
 * - 鉴权：`Authorization: Bearer mnemos_live_*`；org key 可访问/创建本组织任意分区。
 *   本地免密：`orgApiKey` 留空时请求**不带 Authorization**，服务端以 `MNEMOS_DEV_NO_API_KEY=1`
 *   启动时跳过 key 校验；服务端仍返回 401 / 403 时，错误 `action` 会提示
 *   「配置 orgApiKey，或本地以 MNEMOS_DEV_NO_API_KEY=1 启动 Mnemos」。
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
/** 单次 HTTP 请求缺省超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** 检索缺省条数（服务端上限 50）。 */
export const DEFAULT_TOP_K = 8;
/** 检索条数上限（服务端 top_k 上限）。 */
export const MAX_TOP_K = 50;
/** 列表缺省条数（v6 游标分页：默认 50）。 */
export const DEFAULT_LIST_LIMIT = 50;
/** 列表条数上限（v6 游标分页：最大 200）。 */
export const MAX_LIST_LIMIT = 200;
/** 请求失败（非 2xx、网络错误、配置缺失）。 */
export class MnemosApiError extends Error {
    status;
    code;
    action;
    requestId;
    details;
    method;
    path;
    constructor(init) {
        super(init.message);
        this.name = 'MnemosApiError';
        this.status = init.status;
        this.code = init.code ?? 'unknown_error';
        this.action = init.action ?? '检查 Mnemos 配置（baseUrl / orgApiKey）后重试。';
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
            message: `Mnemos ${method} ${path} 请求超时（${timeoutMs}ms）。`,
            code: 'timeout',
            action: '确认 Mnemos 服务已启动并能在该时间内响应；检查 baseUrl 是否指向正确的服务。',
            method,
            path,
        });
        this.name = 'MnemosTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}
/** 把「下一步该做什么」写进错误里：模型读完就知道怎么修。 */
function actionFor(status, code) {
    const normalized = code.toUpperCase();
    if (status === 401 || normalized === 'INVALID_API_KEY' || normalized === 'UNAUTHORIZED' || normalized === 'API_KEY_REVOKED') {
        return 'orgApiKey 无效或已失效：在「设置 → 插件 → dsh-mnemos-personal」检查 orgApiKey（控制台「密钥」里 kind=org 的 Key）。';
    }
    if (status === 403 || normalized === 'FORBIDDEN') {
        return 'org key 作用域不足：读需要 memories:read，写需要 memories:write，按工作区自动建分区还需要 admin。';
    }
    if (status === 404 || normalized === 'NOT_FOUND') {
        return '目标不存在：先调 mnemos_workspace 确保分区与默认人存在，再检查 person_id / 记忆 id / 分区名。';
    }
    if (status === 409 || normalized === 'CONFLICT') {
        return '资源状态冲突：用 mnemos_workspace / mnemos_person action=get 查看分区与人的现状后重试。';
    }
    if (status === 429 || normalized === 'RATE_LIMITED' || normalized === 'QUOTA_EXCEEDED') {
        return '触发限流或配额：稍后重试，或换一个 org key。';
    }
    if (status === 400 || normalized === 'VALIDATION_ERROR' || normalized === 'BAD_REQUEST') {
        return '参数被服务端拒绝：检查 scope（session scope 必须带 session_id）、top_k（≤ 50）、limit（≤ 200）、person_id 与分区 slug 的格式。';
    }
    if (status === 503 || status === 504) {
        return 'Mnemos 服务暂时不可用：确认服务已启动后重试。';
    }
    return '检查 baseUrl / orgApiKey 与 Mnemos 服务日志后重试。';
}
/**
 * 未配置 orgApiKey（免密模式）时服务端仍要求鉴权的提示。
 *
 * 本地开发：以 `MNEMOS_DEV_NO_API_KEY=1` 启动 Mnemos 即可不校验 key；
 * 否则在设置页填 orgApiKey。这段文案同时被 status 工具复用。
 */
export const NO_API_KEY_ACTION = '配置 orgApiKey，或本地以 MNEMOS_DEV_NO_API_KEY=1 启动 Mnemos 后重试。';
/** 免密模式下 401 / 403 的错误 action（带「为什么不带 Authorization」的说明）。 */
function noApiKeyAuthAction(status) {
    const suffix = status === 403 ? '（服务端也可能要求 key 的 admin / 分区作用域）' : '';
    return `请求未携带 Authorization（orgApiKey 未配置）：${NO_API_KEY_ACTION}${suffix}`;
}
/** 网络层异常（fetch 直接 reject）统一归一。 */
function isTimeoutError(error) {
    return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
function isRecord(value) {
    return asRecord(value) !== undefined;
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
 * 看起来像分区的内部 id（v6 `ptn_*`；旧 `prj_*`）。
 * 这种引用必须直接 GET，不能拿去 `POST /v1/partitions {slug}` 当成新 slug upsert。
 */
export function looksLikePartitionId(value) {
    return /^(ptn|prj)_[A-Za-z0-9]+$/.test(value);
}
/** 从 `{ partition }` / 裸分区对象提取分区视图。 */
export function extractPartition(payload, fallbackSlug, fallbackName) {
    const root = asRecord(payload);
    const partition = asRecord(root?.partition) ?? root;
    const id = stringField(partition, 'id', 'partition_id');
    const slug = stringField(partition, 'slug') ?? fallbackSlug;
    const name = stringField(partition, 'name') ?? fallbackName ?? slug;
    const info = { slug, name };
    if (id !== undefined)
        info.id = id;
    info.raw = payload;
    return info;
}
/** 从 `{ person }` / 裸人对象提取人的视图。 */
export function extractPerson(payload, fallbackExternalId) {
    const root = asRecord(payload);
    const person = asRecord(root?.person) ?? root;
    const externalId = stringField(person, 'external_id', 'externalId') ?? fallbackExternalId;
    const info = { externalId };
    const id = stringField(person, 'id');
    if (id !== undefined)
        info.id = id;
    const type = stringField(person, 'type');
    if (type !== undefined)
        info.type = type;
    info.raw = payload;
    return info;
}
/**
 * 从列表响应里取数组：容忍 `items`（v6）/ `results` / 裸数组。
 * 单条响应（`{ memory }` / 裸记忆对象）也会被归一成单元素数组。
 */
export function extractMemories(payload) {
    const record = asRecord(payload);
    if (record !== undefined) {
        for (const key of ['items', 'results', 'memories']) {
            const value = record[key];
            if (Array.isArray(value))
                return value.filter(isRecord);
        }
        const single = asRecord(record.memory) ?? asRecord(record.result);
        if (single !== undefined)
            return [single];
        if (typeof record.id === 'string' || typeof record.content === 'string')
            return [record];
    }
    if (Array.isArray(payload))
        return payload.filter(isRecord);
    return [];
}
/** 从响应里取人数组：容忍 `items` / `results` / `persons` / `people` / 裸数组。 */
export function extractPeople(payload) {
    const record = asRecord(payload);
    if (record !== undefined) {
        for (const key of ['items', 'results', 'persons', 'people']) {
            const value = record[key];
            if (Array.isArray(value))
                return value.filter(isRecord);
        }
    }
    if (Array.isArray(payload))
        return payload.filter(isRecord);
    return [];
}
/** 把 v6 列表响应归一成 `{ items, next_cursor, partition_stats }`。 */
export function extractCursorPage(payload, ...itemKeys) {
    const record = asRecord(payload);
    let items = [];
    if (Array.isArray(payload)) {
        items = payload;
    }
    else if (record !== undefined) {
        for (const key of itemKeys) {
            const value = record[key];
            if (Array.isArray(value)) {
                items = value;
                break;
            }
        }
    }
    const page = { items, raw: payload };
    if (record !== undefined) {
        const nextCursor = stringField(record, 'next_cursor', 'nextCursor');
        if (nextCursor !== undefined)
            page.next_cursor = nextCursor;
        const stats = asRecord(record.partition_stats) ?? asRecord(record.partitionStats);
        if (stats !== undefined)
            page.partition_stats = stats;
    }
    return page;
}
/** 分区统计响应：容忍 `{ stats }` / `{ partition_stats }` / 裸对象。 */
export function extractStats(payload) {
    const record = asRecord(payload);
    if (record === undefined)
        return {};
    return (asRecord(record.stats) ??
        asRecord(record.partition_stats) ??
        asRecord(record.partitionStats) ??
        record);
}
/** 检索响应归一：`results` / `items` / 裸数组；带 took_ms / next_cursor。 */
function normalizeSearch(payload) {
    const record = asRecord(payload);
    const result = { results: extractMemories(payload), raw: payload };
    const tookMs = typeof record?.took_ms === 'number' ? record.took_ms : typeof record?.tookMs === 'number' ? record.tookMs : undefined;
    if (tookMs !== undefined)
        result.took_ms = tookMs;
    const nextCursor = stringField(record, 'next_cursor', 'nextCursor');
    if (nextCursor !== undefined)
        result.next_cursor = nextCursor;
    return result;
}
/**
 * 画像响应归一：容忍 `{ profile }` 包装 / 裸对象；facts 容忍 `items` 包装或裸数组。
 * 服务端 v6.1 的响应是 `{ person, facts, summary, generated_at, cached }`。
 */
export function extractPersonProfile(payload) {
    const root = asRecord(payload);
    const node = asRecord(root?.profile) ?? root ?? {};
    const profile = { raw: payload };
    const person = asRecord(node.person);
    if (person !== undefined)
        profile.person = person;
    const factsRaw = Array.isArray(node.facts)
        ? node.facts
        : Array.isArray(asRecord(node.facts)?.items)
            ? asRecord(node.facts)?.items
            : [];
    profile.facts = factsRaw.filter(isRecord);
    const summary = node.summary;
    if (typeof summary === 'string')
        profile.summary = summary;
    const generatedAt = stringField(node, 'generated_at', 'generatedAt');
    if (generatedAt !== undefined)
        profile.generated_at = generatedAt;
    const cached = node.cached;
    if (typeof cached === 'boolean')
        profile.cached = cached;
    return profile;
}
/** 历史响应归一：`{ items }` / `{ history }` / 裸数组。 */
export function extractMemoryHistory(payload) {
    const record = asRecord(payload);
    if (record !== undefined) {
        for (const key of ['items', 'history', 'events']) {
            const value = record[key];
            if (Array.isArray(value))
                return value.filter(isRecord);
        }
    }
    if (Array.isArray(payload))
        return payload.filter(isRecord);
    return [];
}
/** 单条记忆变更响应归一：`{ memory }` / 裸记忆对象。 */
export function extractMemoryMutation(payload) {
    const record = asRecord(payload);
    const memory = (asRecord(record?.memory) ?? asRecord(record?.result) ?? record);
    return { memory, raw: payload };
}
/**
 * 读取活配置的 Mnemos 客户端：每次请求都重新解析配置，
 * 因此设置页改动（baseUrl / orgApiKey / personId …）无需重建客户端或重挂工具。
 */
export class MnemosClient {
    config;
    timeoutMs;
    /** slug → 分区视图（首次 ensure 成功后缓存，进程内不再重复 POST）。 */
    partitionCache = new Map();
    /** slug → 进行中的 ensure（并发工具调用只发一次 POST）。 */
    partitionInflight = new Map();
    /** `${分区引用}\0${externalId}` → 人视图（首次 PUT 成功后缓存）。 */
    personCache = new Map();
    constructor(config, options = {}) {
        this.config = config;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    /** 配置里的服务地址（规范化去尾斜杠，不校验可用性；状态自检用）。 */
    resolvedBaseUrl() {
        return (this.config().baseUrl ?? '').trim().replace(/\/+$/, '');
    }
    /** 当前是否配置了 org API Key（只报布尔，绝不返回密钥）。 */
    isApiKeyConfigured() {
        return Boolean((this.config().orgApiKey ?? '').trim());
    }
    /**
     * 当前鉴权模式：
     * - `orgKey`：配置了 orgApiKey，请求带 `Authorization: Bearer …`；
     * - `none`：留空（本地免密，请求不带 Authorization）。
     */
    authMode() {
        return this.isApiKeyConfigured() ? 'orgKey' : 'none';
    }
    /** 生效超时（毫秒）。 */
    getTimeoutMs() {
        return this.timeoutMs;
    }
    /** 分区路径前缀：`/v1/partitions/:partition`（:partition 支持 id 或 slug）。 */
    partitionPath(partitionRef, suffix = '') {
        return `/v1/partitions/${encodeURIComponent(partitionRef)}${suffix}`;
    }
    /** 发一个请求：拼 URL、鉴权、超时、解析错误体（不重试，写接口幂等性由服务端保证）。 */
    async request(method, path, options = {}) {
        const rawBaseUrl = (this.config().baseUrl ?? '').trim().replace(/\/+$/, '');
        if (rawBaseUrl === '') {
            throw new MnemosApiError({
                message: '未配置 Mnemos 服务地址：baseUrl 为空。',
                code: 'missing_base_url',
                action: '在「设置 → 插件 → dsh-mnemos-personal」填写 baseUrl（默认 http://127.0.0.1:4380）。',
                method,
                path,
            });
        }
        let url;
        try {
            url = new URL(rawBaseUrl + path);
        }
        catch {
            throw new MnemosApiError({
                message: `Mnemos 服务地址不可用：${rawBaseUrl}（应为 http://host:port 形式）。`,
                code: 'invalid_base_url',
                action: '把 baseUrl 改成 http(s)://host:port 形式（不带尾斜杠、不带 /v1）。',
                method,
                path,
            });
        }
        if (options.query) {
            for (const [key, value] of Object.entries(options.query)) {
                if (value !== undefined && value !== null && value !== '')
                    url.searchParams.set(key, String(value));
            }
        }
        // 鉴权：配置了 orgApiKey 就带 Bearer；留空则为「免密模式」，**不发 Authorization**
        //（服务端以 MNEMOS_DEV_NO_API_KEY=1 启动时不校验 key）。不再本地短路：
        // 让请求真正到达服务端，由服务端的 401 / 403 报出可操作的下一步。
        const apiKey = (this.config().orgApiKey ?? '').trim();
        const headers = { Accept: 'application/json' };
        if (apiKey !== '')
            headers.Authorization = `Bearer ${apiKey}`;
        if (options.body !== undefined)
            headers['Content-Type'] = 'application/json';
        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (error) {
            if (isTimeoutError(error))
                throw new MnemosTimeoutError(this.timeoutMs, method, path);
            throw new MnemosApiError({
                message: `Mnemos ${method} ${path} 连接失败：${error instanceof Error ? error.message : String(error)}。`,
                code: 'network_error',
                action: '确认 Mnemos 服务已启动且 baseUrl 正确（默认 http://127.0.0.1:4380）。',
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
            const error = asRecord(asRecord(payload)?.error);
            const code = stringField(error, 'code') ?? `http_${response.status}`;
            const detail = stringField(error, 'message') ?? (typeof payload === 'string' ? payload.slice(0, 500) : response.statusText);
            const requestId = stringField(error, 'requestId', 'request_id') ?? response.headers.get('x-request-id') ?? undefined;
            // 免密模式下的 401 / 403 用专用提示；其余情况沿用按状态码归一的 action。
            const action = apiKey === '' && (response.status === 401 || response.status === 403)
                ? noApiKeyAuthAction(response.status)
                : actionFor(response.status, code);
            throw new MnemosApiError({
                message: `Mnemos ${method} ${path} -> ${response.status} ${code}: ${detail}（${action}）`,
                status: response.status,
                code,
                action,
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
    /* ------------------------------------------------------------------ */
    /* 分区                                                                */
    /* ------------------------------------------------------------------ */
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
    ensurePartition(slug, name) {
        const cached = this.partitionCache.get(slug);
        if (cached !== undefined)
            return Promise.resolve(cached);
        const pending = this.partitionInflight.get(slug);
        if (pending !== undefined)
            return pending;
        const promise = this.doEnsurePartition(slug, name).finally(() => {
            this.partitionInflight.delete(slug);
        });
        this.partitionInflight.set(slug, promise);
        return promise;
    }
    async doEnsurePartition(slug, name) {
        // fixed 模式允许直接填分区 id：按 id 读，不要用 id 当 slug 去 upsert（会建出错误分区）。
        if (looksLikePartitionId(slug)) {
            const info = extractPartition(await this.request('GET', this.partitionPath(slug)), slug, name);
            this.partitionCache.set(slug, info);
            return info;
        }
        let payload;
        try {
            payload = await this.request('POST', '/v1/partitions', { body: { slug, name: name ?? slug } });
        }
        catch (error) {
            // 409 = 已存在（并发 / 上次已建）：退回读接口，不把幂等失败暴露给调用方。
            if (error instanceof MnemosApiError && error.status === 409) {
                payload = await this.request('GET', this.partitionPath(slug));
            }
            else {
                throw error;
            }
        }
        let info = extractPartition(payload, slug, name);
        if (info.id === undefined) {
            try {
                info = extractPartition(await this.request('GET', this.partitionPath(slug)), slug, name);
            }
            catch {
                // GET 失败不影响继续按 slug 调用其它端点。
            }
        }
        this.partitionCache.set(slug, info);
        return info;
    }
    /** `GET /v1/partitions/:partition` —— 分区信息（含 settings）。 */
    getPartition(partitionRef) {
        return this.request('GET', this.partitionPath(partitionRef));
    }
    /** `GET /v1/partitions/:partition/stats` —— 分区统计（直接读 partition_stats）。 */
    async getPartitionStats(partitionRef) {
        return extractStats(await this.request('GET', this.partitionPath(partitionRef, '/stats')));
    }
    /** 清空缓存（测试 / 配置切换后强制重新 ensure）。 */
    clearCache() {
        this.partitionCache.clear();
        this.partitionInflight.clear();
        this.personCache.clear();
    }
    /* ------------------------------------------------------------------ */
    /* 人                                                                  */
    /* ------------------------------------------------------------------ */
    /**
     * 确保人存在（`PUT /v1/partitions/:p/persons/:externalId`，服务端 lazy upsert），并缓存。
     *
     * @param partitionRef 分区 slug 或 id。
     * @param externalId 人的 external_id（App user_id / agent id）。
     * @param options 可选类型 / 展示名 / 属性（只发显式给出的字段，避免覆盖已有资料）。
     * @returns 人视图（至少含 externalId）。
     */
    ensurePerson(partitionRef, externalId, options = {}) {
        const key = `${partitionRef}\u0000${externalId}`;
        const cached = this.personCache.get(key);
        if (cached !== undefined)
            return Promise.resolve(cached);
        const body = {};
        if (options.type !== undefined)
            body.type = options.type;
        if (options.displayName !== undefined && options.displayName !== '')
            body.display_name = options.displayName;
        if (options.attributes !== undefined)
            body.attributes = options.attributes;
        const path = this.partitionPath(partitionRef, `/persons/${encodeURIComponent(externalId)}`);
        return this.request('PUT', path, { body }).then((payload) => {
            const info = extractPerson(payload, externalId);
            this.personCache.set(key, info);
            return info;
        });
    }
    /** `GET /v1/partitions/:p/persons/:person` —— 人详情（计数在 persons 行上）。 */
    getPerson(partitionRef, personRef) {
        return this.request('GET', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}`));
    }
    /** `PATCH /v1/partitions/:p/persons/:person` —— 更新展示名 / 类型 / 属性 / 状态。 */
    updatePerson(partitionRef, personRef, body) {
        return this.request('PATCH', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}`), {
            body,
        });
    }
    /** `GET /v1/partitions/:p/persons` —— 人列表（游标分页 + q / type / status / sort）。 */
    async listPersons(partitionRef, query = {}) {
        const payload = await this.request('GET', this.partitionPath(partitionRef, '/persons'), {
            query: {
                cursor: query.cursor,
                limit: query.limit,
                q: query.q,
                type: query.type,
                status: query.status,
                sort: query.sort,
            },
        });
        return extractCursorPage(payload, 'items', 'results', 'persons', 'people');
    }
    /** `GET /v1/partitions/:p/persons/:person/brief` —— 人的简报。 */
    getPersonBrief(partitionRef, personRef) {
        return this.request('GET', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/brief`));
    }
    /** `POST /v1/partitions/:p/persons/:person/context` —— 人的上下文（含可直接注入的 prompt）。 */
    getPersonContext(partitionRef, personRef, body = {}) {
        return this.request('POST', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/context`), {
            body,
        });
    }
    /** `GET /v1/partitions/:p/persons/:person/profile` —— 人的画像（facts + summary；force=1 强制刷新）。 */
    async getPersonProfile(partitionRef, personRef, options = {}) {
        const payload = await this.request('GET', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/profile`), { query: { force: options.force === true ? '1' : undefined } });
        return extractPersonProfile(payload);
    }
    /** `GET /v1/partitions/:p/persons/:person/dream` —— 人级做梦状态。 */
    getPersonDream(partitionRef, personRef) {
        return this.request('GET', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/dream`));
    }
    /** `POST /v1/partitions/:p/persons/:person/dream/run` —— 触发人级做梦。 */
    runPersonDream(partitionRef, personRef, body = {}) {
        return this.request('POST', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/dream/run`), {
            body,
        });
    }
    /* ------------------------------------------------------------------ */
    /* 记忆                                                                */
    /* ------------------------------------------------------------------ */
    /** `POST /v1/partitions/:p/persons/:person/memories` —— 给该人写记忆（person 在路径里）。 */
    async addMemory(partitionRef, personRef, body) {
        const payload = await this.request('POST', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/memories`), { body });
        const record = asRecord(payload);
        const events = Array.isArray(record?.events) ? record.events : [];
        return { memories: extractMemories(payload), events, raw: payload };
    }
    /** `GET /v1/partitions/:p/persons/:person/memories` —— 该人记忆：游标分页 + scope/category。 */
    async listPersonMemories(partitionRef, personRef, query = {}) {
        const payload = await this.request('GET', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/memories`), {
            query: {
                cursor: query.cursor,
                limit: query.limit,
                scope: query.scope,
                category: query.category,
                q: query.q,
            },
        });
        return extractCursorPage(payload, 'items', 'results', 'memories');
    }
    /** `GET /v1/partitions/:p/memories` —— 记忆全局列表（person_id / scope / category / q，游标分页）。 */
    async listMemories(partitionRef, query = {}) {
        const payload = await this.request('GET', this.partitionPath(partitionRef, '/memories'), {
            query: {
                cursor: query.cursor,
                limit: query.limit,
                person_id: query.person_id,
                scope: query.scope,
                category: query.category,
                q: query.q,
            },
        });
        return extractCursorPage(payload, 'items', 'results', 'memories');
    }
    /**
     * 检索记忆。
     *
     * v6 的检索就是「记忆列表 + `q`」（FTS 前缀），`POST .../memories/search` 是官方兼容端点
     * （v6 后端返回 `{ results, took_ms, next_cursor, partition_stats }`）。注意它的 `person_id`
     * 是**作者过滤**而不是「该人可见」：默认检索（未指定 scope）要取两次 —— 本人记忆 + 分区共享 ——
     * 再按 id 去重，才与工具承诺的「该人可见 + 分区共享知识」一致。
     */
    async searchMemories(partitionRef, body) {
        // scope 明确：单查该范围；没给 person_id：分区级检索。
        if (body.scope !== undefined || body.person_id === undefined) {
            return this.searchOnce(partitionRef, body);
        }
        const [own, shared] = await Promise.all([
            this.searchOnce(partitionRef, body),
            this.searchOnce(partitionRef, {
                query: body.query,
                scope: 'partition',
                category: body.category,
                top_k: body.top_k,
            }),
        ]);
        const limit = body.top_k ?? DEFAULT_TOP_K;
        const seen = new Set();
        const results = [];
        for (const memory of [...own.results, ...shared.results]) {
            const key = memory.id ?? `${memory.content ?? ''}|${memory.created_at ?? ''}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            results.push(memory);
            if (results.length >= limit)
                break;
        }
        const merged = { results, raw: { own: own.raw, shared: shared.raw } };
        if (own.took_ms !== undefined || shared.took_ms !== undefined) {
            merged.took_ms = (own.took_ms ?? 0) + (shared.took_ms ?? 0);
        }
        return merged;
    }
    /** 单次检索：优先 `POST .../memories/search`，端点不存在时退化为 `GET .../memories?q=`。 */
    async searchOnce(partitionRef, body) {
        try {
            const payload = await this.request('POST', this.partitionPath(partitionRef, '/memories/search'), { body });
            return normalizeSearch(payload);
        }
        catch (error) {
            if (!(error instanceof MnemosApiError) || (error.status !== 404 && error.status !== 405))
                throw error;
            const payload = await this.request('GET', this.partitionPath(partitionRef, '/memories'), {
                query: {
                    q: body.query,
                    person_id: body.person_id,
                    scope: body.scope,
                    category: body.category,
                    limit: body.top_k,
                },
            });
            return normalizeSearch(payload);
        }
    }
    /** `GET /v1/partitions/:p/memories/:id` —— 记忆详情。 */
    getMemory(partitionRef, id) {
        return this.request('GET', this.partitionPath(partitionRef, `/memories/${encodeURIComponent(id)}`));
    }
    /** `GET /v1/partitions/:p/memories/:id/history` —— 该记忆的变更历史（新→旧）。 */
    async getMemoryHistory(partitionRef, id) {
        const payload = await this.request('GET', this.partitionPath(partitionRef, `/memories/${encodeURIComponent(id)}/history`));
        return extractMemoryHistory(payload);
    }
    /** `POST /v1/partitions/:p/memories/:id/feedback` —— 记一次有用 / 没用（升降 confidence）。 */
    async feedbackMemory(partitionRef, id, body) {
        const payload = await this.request('POST', this.partitionPath(partitionRef, `/memories/${encodeURIComponent(id)}/feedback`), { body });
        return extractMemoryMutation(payload);
    }
    /** `PATCH /v1/partitions/:p/memories/:id` —— 更新记忆（content / importance / tags / metadata …）。 */
    async updateMemory(partitionRef, id, body) {
        const payload = await this.request('PATCH', this.partitionPath(partitionRef, `/memories/${encodeURIComponent(id)}`), { body });
        return extractMemoryMutation(payload);
    }
}
