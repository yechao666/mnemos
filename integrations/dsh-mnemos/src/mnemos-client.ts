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

import type { MnemosConfig } from './config.js'

/** 记忆可见性。 */
export type MnemosVisibility = 'project' | 'agent' | 'task'

/** 记忆分类。 */
export type MnemosCategory =
  | 'preference'
  | 'identity'
  | 'fact'
  | 'plan'
  | 'relationship'
  | 'event'
  | 'skill'
  | 'constraint'
  | 'context'

/** 记忆状态。 */
export type MnemosStatus = 'active' | 'archived' | 'deleted'

/** 任务状态。 */
export type MnemosTaskStatus = 'open' | 'active' | 'done' | 'abandoned'

/** 一条记忆（同时容忍 v1 读视图与创建响应两种字段命名）。 */
export interface MnemosMemory {
  id?: string
  /** v1 读视图字段（GET / search）。 */
  memory?: string
  /** 创建响应字段（POST /v1/memories）。 */
  content?: string
  user_id?: string | null
  agent_id?: string | null
  run_id?: string | null
  app_id?: string | null
  task_id?: string | null
  userId?: string | null
  agentId?: string | null
  taskId?: string | null
  visibility?: MnemosVisibility
  category?: MnemosCategory
  importance?: number
  confidence?: number
  source?: string
  status?: MnemosStatus
  tags?: string[]
  metadata?: Record<string, unknown> | null
  created_at?: string
  created_at_iso?: string
  createdAt?: string
  updated_at?: string
  updatedAt?: string
  last_accessed_at?: string | null
  access_count?: number
  accessCount?: number
  expires_at?: string | null
  /** 仅搜索结果带：融合分与逐信号分解。 */
  score?: number
  signals?: Record<string, number>
  matched_on?: string[]
  /** 仅详情接口带。 */
  history?: MnemosHistoryEntry[]
  entities?: MnemosEntity[]
  relations?: Record<string, unknown>[]
  neighbors?: MnemosEntity[]
  [key: string]: unknown
}

/** 一条记忆变更历史。 */
export interface MnemosHistoryEntry {
  id?: string
  memory_id?: string
  event?: string
  old_memory?: string | null
  new_memory?: string | null
  actor?: string
  reason?: string | null
  created_at?: string
  meta?: Record<string, unknown>
  [key: string]: unknown
}

/** 图谱实体（详情接口附带）。 */
export interface MnemosEntity {
  id?: string
  name?: string
  type?: string
  mention_count?: number
  [key: string]: unknown
}

/** 任务会话。 */
export interface MnemosTask {
  id?: string
  project_id?: string
  title?: string
  goal?: string
  status?: MnemosTaskStatus
  owner_agent_id?: string | null
  owner_agent_name?: string | null
  branch?: string | null
  summary?: string | null
  metadata?: Record<string, unknown>
  created_at?: string
  started_at?: string
  ended_at?: string | null
  memory_count?: number
  agent_count?: number
  [key: string]: unknown
}

/** 已注册 Agent。 */
export interface MnemosAgent {
  id?: string
  project_id?: string
  name?: string
  role?: string
  model?: string
  description?: string
  capabilities?: string[]
  status?: string
  metadata?: Record<string, unknown>
  created_at?: string
  last_active_at?: string | null
  stats?: {
    memories?: number
    private_memories?: number
    tasks?: number
    last_task_at?: string | null
  }
  [key: string]: unknown
}

/** 任务简报的一个分区。 */
export interface MnemosBriefingSection {
  key?: string
  title?: string
  description?: string
  hits?: MnemosMemory[]
  [key: string]: unknown
}

/** 任务简报（`POST /v1/context`）。 */
export interface MnemosBriefing {
  project?: { id?: string; name?: string; description?: string }
  agent?: MnemosAgent | null
  task?: MnemosTask | null
  sections?: MnemosBriefingSection[]
  /** 可直接拼进 system prompt 的中文 Markdown。 */
  prompt?: string
  token_estimate?: number
  citations?: string[]
  built_at?: string
  took_ms?: number
}

/** 项目统计（`GET /v1/stats`，需要 admin 作用域）。 */
export interface MnemosStats {
  metrics?: Record<string, number | string | null>
  [key: string]: unknown
}

/** `POST /v1/memories` 的写入事件。 */
export interface MnemosMemoryEvent {
  type?: 'ADD' | 'UPDATE' | 'DELETE' | 'MERGE' | 'NOOP'
  memoryId?: string
  content?: string
  reason?: string
  at?: string
  [key: string]: unknown
}

/** 客户端错误统一形状。 */
export interface MnemosApiErrorInit {
  message: string
  /** HTTP 状态码；网络层失败时为 undefined。 */
  status?: number
  /** 服务端 `error.code`，或本地错误码（network_error / timeout / missing_api_key …）。 */
  code?: string
  requestId?: string
  details?: unknown
  method?: string
  path?: string
}

/** 请求失败（非 2xx、网络错误、配置缺失）。 */
export class MnemosApiError extends Error {
  readonly status?: number
  readonly code: string
  readonly requestId?: string
  readonly details?: unknown
  readonly method?: string
  readonly path?: string

  constructor(init: MnemosApiErrorInit) {
    super(init.message)
    this.name = 'MnemosApiError'
    this.status = init.status
    this.code = init.code ?? 'unknown_error'
    this.requestId = init.requestId
    this.details = init.details
    this.method = init.method
    this.path = init.path
  }
}

/** 请求超时（继承 MnemosApiError，`code === 'timeout'`）。 */
export class MnemosTimeoutError extends MnemosApiError {
  readonly timeoutMs: number

  constructor(timeoutMs: number, method: string, path: string) {
    super({
      message: `Mnemos ${method} ${path} 请求超时（${timeoutMs}ms）。可调大「设置 → 插件 → dsh-mnemos → timeoutMs」，或检查服务是否正常运行。`,
      code: 'timeout',
      method,
      path,
    })
    this.name = 'MnemosTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** 检索参数。 */
export interface MnemosSearchOptions {
  query: string
  user_id?: string
  /** 调用方 Agent 身份：决定可见性（项目共享 + 自身私有 + 当前任务）。 */
  agent_id?: string
  run_id?: string
  app_id?: string
  task_id?: string
  visibility?: MnemosVisibility
  top_k?: number
  threshold?: number
  category?: MnemosCategory
  status?: MnemosStatus
  tags?: string[]
  min_importance?: number
}

/** 写入参数（messages 与 text 二选一）。 */
export interface MnemosAddOptions {
  messages?: Array<{ role: string; content: string }>
  text?: string
  user_id?: string
  agent_id?: string
  run_id?: string
  app_id?: string
  task_id?: string
  visibility?: MnemosVisibility
  metadata?: Record<string, unknown>
  tags?: string[]
  /** 默认 false（原文入库）；true 走事实抽取。 */
  infer?: boolean
  /** additive（默认）或 consolidate（高相似去重合并）。 */
  mode?: 'additive' | 'consolidate'
}

/** 列表参数。 */
export interface MnemosListOptions {
  user_id?: string
  agent_id?: string
  run_id?: string
  app_id?: string
  task_id?: string
  visibility?: MnemosVisibility
  category?: MnemosCategory
  status?: MnemosStatus
  sort?: 'recent' | 'importance' | 'accessed'
  page?: number
  page_size?: number
}

/** 更新参数（`/v1` 只认 content / category / importance）。 */
export interface MnemosUpdateOptions {
  content?: string
  category?: MnemosCategory
  importance?: number
}

/** 任务简报参数。 */
export interface MnemosContextOptions {
  agent_id?: string
  task_id?: string
  query?: string
  budget_tokens?: number
}

/** 任务列表参数。 */
export interface MnemosTaskListOptions {
  status?: MnemosTaskStatus
  agent_id?: string
  limit?: number
}

/** 开始任务参数。 */
export interface MnemosTaskCreateOptions {
  title: string
  goal?: string
  owner_agent_id?: string
  branch?: string
}

/** 结束任务参数。 */
export interface MnemosTaskFinishOptions {
  status?: 'done' | 'abandoned'
  summary?: string
  decisions?: string[]
  lessons?: string[]
  notes?: string[]
  agent_id?: string
}

/** 注册 Agent 参数。 */
export interface MnemosAgentCreateOptions {
  name: string
  role?: string
  model?: string
  capabilities?: string[]
}

/** 健康检查响应。 */
export interface MnemosHealth {
  ok?: boolean
  version?: string
  uptime_ms?: number
  [key: string]: unknown
}

type QueryValue = string | number | boolean | undefined

/** 需要重试的读路径（POST 但语义只读）。 */
const RETRYABLE_PATHS = new Set(['/v1/memories/search', '/v1/context'])

/** 总尝试次数：首次 + 1 次重试。 */
const MAX_ATTEMPTS = 2

/** 重试前的固定退避。 */
const RETRY_DELAY_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 网络层异常（fetch 直接 reject）统一归一。 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/** 组装可执行的错误提示（把「下一步该做什么」写进 message）。 */
function hintFor(status: number | undefined, code: string): string {
  // 服务端的错误码是大写（INVALID_API_KEY / FORBIDDEN / NOT_FOUND …），本地错误码是小写，
  // 统一按大写比较，避免两套命名漏判。
  const normalized = code.toUpperCase()
  if (status === 401 || normalized === 'INVALID_API_KEY' || normalized === 'UNAUTHORIZED' || normalized === 'API_KEY_REVOKED') {
    return 'Key 无效或已失效：请在「设置 → 插件 → dsh-mnemos」检查 apiKey。'
  }
  if (status === 403 || normalized === 'FORBIDDEN') {
    return '当前 Key 作用域不足：/v1 读写需要 memories:read / memories:write，/v1/stats 另需 admin。'
  }
  if (status === 404 || normalized === 'NOT_FOUND') {
    return '目标不存在或不属于当前项目：检查记忆 / 任务 id；若报的是 Agent 不存在，先用 mnemos_agent action=list 查看项目内 Agent，或 action=register 注册后再重试。'
  }
  if (status === 429 || normalized === 'RATE_LIMITED' || normalized === 'QUOTA_EXCEEDED') {
    return '触发限流或月度配额，稍后重试或换 Key。'
  }
  if (status === 400 || normalized === 'VALIDATION_ERROR' || normalized === 'BAD_REQUEST') {
    return '参数被服务端拒绝：检查取值范围（top_k ≤ 50、page_size ≤ 100、budget_tokens 60–8000、finish 的 status 只能是 done / abandoned）。'
  }
  return ''
}

/**
 * 读取活配置的 Mnemos 客户端：每次请求都重新解析配置，
 * 因此设置页改动（baseUrl / apiKey / timeoutMs）无需重建客户端或重挂工具。
 */
export class MnemosClient {
  constructor(private readonly config: () => MnemosConfig) {}

  /** 规范化后的服务地址（去掉尾部斜杠）。 */
  private get baseUrl(): string {
    const raw = (this.config().baseUrl ?? '').trim()
    if (!raw) {
      throw new MnemosApiError({
        message: '未配置 Mnemos 服务地址：请在「设置 → 插件 → dsh-mnemos」填写 baseUrl（默认 http://127.0.0.1:4380）。',
        code: 'missing_base_url',
      })
    }
    return raw.replace(/\/+$/, '')
  }

  /** 当前是否配置了 API Key（只报布尔，绝不返回密钥）。 */
  isApiKeyConfigured(): boolean {
    return Boolean(this.config().apiKey?.trim())
  }

  /** 是否需要在「网络错误 / 503 / 504」时重试。 */
  private shouldRetry(method: string, path: string): boolean {
    return method === 'GET' || RETRYABLE_PATHS.has(path)
  }

  /**
   * 发一个请求，带一次重试（仅读路径、仅网络错误 / 503 / 504）。
   */
  private async request<T>(
    method: string,
    path: string,
    options?: { body?: unknown; query?: Record<string, QueryValue> },
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, path, options)
      } catch (error) {
        // 只有「网络层失败」与 503 / 504 算瞬时故障；超时、鉴权、校验错误不重试。
        const transient =
          error instanceof MnemosApiError &&
          (error.status === 503 || error.status === 504 || error.code === 'network_error')
        if (attempt >= MAX_ATTEMPTS || !this.shouldRetry(method, path) || !transient) throw error
        await sleep(RETRY_DELAY_MS)
      }
    }
  }

  /** 单次请求：拼 URL、鉴权、超时、解析错误体。 */
  private async once<T>(
    method: string,
    path: string,
    options?: { body?: unknown; query?: Record<string, QueryValue> },
  ): Promise<T> {
    let url: URL
    try {
      url = new URL(this.baseUrl + path)
    } catch {
      throw new MnemosApiError({
        message: `Mnemos 服务地址不可用：${this.config().baseUrl || '(空)'}（应为 http://host:port 形式）`,
        code: 'invalid_base_url',
        method,
        path,
      })
    }
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
    }

    const apiKey = (this.config().apiKey ?? '').trim()
    // /v1/health 不需要鉴权；其余接口没有 Key 就没必要打网络。
    if (!apiKey && path !== '/v1/health') {
      throw new MnemosApiError({
        message: '未配置 Mnemos API Key：请在「设置 → 插件 → dsh-mnemos」填写 apiKey（控制台「项目 · 密钥」创建，mnemos_live_*）。',
        code: 'missing_api_key',
        method,
        path,
      })
    }

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    if (options?.body !== undefined) headers['Content-Type'] = 'application/json'

    const timeoutMs = this.config().timeoutMs ?? 15000
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (isTimeoutError(error)) throw new MnemosTimeoutError(timeoutMs, method, path)
      throw new MnemosApiError({
        message: `Mnemos ${method} ${path} 连接失败：${error instanceof Error ? error.message : String(error)}。检查服务是否启动、baseUrl 是否正确。`,
        code: 'network_error',
        method,
        path,
      })
    }

    const raw = await response.text().catch(() => '')
    let payload: unknown = null
    if (raw !== '') {
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = raw
      }
    }

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | null)?.error
      const code = typeof error?.code === 'string' ? error.code : `http_${response.status}`
      const detail = typeof error?.message === 'string' ? error.message : typeof payload === 'string' ? payload.slice(0, 500) : response.statusText
      const requestId = error?.requestId ?? response.headers.get('x-request-id') ?? undefined
      const hint = hintFor(response.status, code)
      throw new MnemosApiError({
        message: `Mnemos ${method} ${path} -> ${response.status} ${code}: ${detail}${hint ? `（${hint}）` : ''}`,
        status: response.status,
        code,
        requestId,
        details: error?.details,
        method,
        path,
      })
    }

    if (response.status === 204) return undefined as T
    return payload as T
  }

  /** `GET /v1/health` —— 存活检查（无需鉴权）。 */
  health(): Promise<MnemosHealth> {
    return this.request<MnemosHealth>('GET', '/v1/health')
  }

  /** `GET /v1/stats` —— 项目指标（需要 admin 作用域）。 */
  stats(): Promise<MnemosStats> {
    return this.request<MnemosStats>('GET', '/v1/stats')
  }

  /** `POST /v1/memories/search` —— 混合检索。 */
  search(options: MnemosSearchOptions): Promise<{ results?: MnemosMemory[]; took_ms?: number; signals?: unknown }> {
    const body: Record<string, unknown> = { query: options.query }
    if (options.user_id) body.user_id = options.user_id
    if (options.agent_id) body.agent_id = options.agent_id
    if (options.run_id) body.run_id = options.run_id
    if (options.app_id) body.app_id = options.app_id
    if (options.task_id) body.task_id = options.task_id
    if (options.visibility) body.visibility = options.visibility
    if (options.top_k !== undefined) body.top_k = options.top_k
    if (options.threshold !== undefined) body.threshold = options.threshold
    const filters: Record<string, unknown> = {}
    if (options.category) filters.category = options.category
    if (options.status) filters.status = options.status
    if (options.tags && options.tags.length > 0) filters.tags = options.tags
    if (options.min_importance !== undefined) filters.min_importance = options.min_importance
    if (Object.keys(filters).length > 0) body.filters = filters
    return this.request('POST', '/v1/memories/search', { body })
  }

  /** `POST /v1/memories` —— 写入记忆（messages 与 text 二选一）。 */
  add(options: MnemosAddOptions): Promise<{
    results?: MnemosMemory[]
    events?: MnemosMemoryEvent[]
    tookMs?: number
  }> {
    const body: Record<string, unknown> = {}
    if (options.messages && options.messages.length > 0) body.messages = options.messages
    if (options.text !== undefined && options.text !== '') body.text = options.text
    if (options.user_id) body.user_id = options.user_id
    if (options.agent_id) body.agent_id = options.agent_id
    if (options.run_id) body.run_id = options.run_id
    if (options.app_id) body.app_id = options.app_id
    if (options.task_id) body.task_id = options.task_id
    if (options.visibility) body.visibility = options.visibility
    if (options.metadata) body.metadata = options.metadata
    if (options.tags && options.tags.length > 0) body.tags = options.tags
    if (options.infer !== undefined) body.infer = options.infer
    if (options.mode) body.mode = options.mode
    return this.request('POST', '/v1/memories', { body })
  }

  /** `GET /v1/memories` —— 分页列表。 */
  listMemories(options: MnemosListOptions = {}): Promise<{
    results?: MnemosMemory[]
    count?: number
    page?: number
    page_size?: number
  }> {
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
    })
  }

  /** `GET /v1/memories/{id}` —— 详情（含历史 / 实体 / 关系）。 */
  getMemory(id: string): Promise<MnemosMemory> {
    return this.request<MnemosMemory>('GET', `/v1/memories/${encodeURIComponent(id)}`)
  }

  /** `PUT /v1/memories/{id}` —— 更新正文 / 分类 / 重要度。 */
  updateMemory(id: string, options: MnemosUpdateOptions): Promise<{ message?: string }> {
    const body: Record<string, unknown> = {}
    if (options.content !== undefined) body.text = options.content
    if (options.category) body.category = options.category
    if (options.importance !== undefined) body.importance = options.importance
    if (Object.keys(body).length === 0) {
      throw new MnemosApiError({
        message: '更新记忆至少需要 content / category / importance 之一。',
        code: 'invalid_request',
        method: 'PUT',
        path: `/v1/memories/${id}`,
      })
    }
    return this.request('PUT', `/v1/memories/${encodeURIComponent(id)}`, { body })
  }

  /** `DELETE /v1/memories/{id}` —— 软删除（写历史）。 */
  deleteMemory(id: string): Promise<{ message?: string }> {
    return this.request('DELETE', `/v1/memories/${encodeURIComponent(id)}`)
  }

  /** `GET /v1/memories/{id}/history` —— 变更历史（服务端包了一层 results）。 */
  async history(id: string): Promise<MnemosHistoryEntry[]> {
    const response = await this.request<{ results?: MnemosHistoryEntry[] }>(
      'GET',
      `/v1/memories/${encodeURIComponent(id)}/history`,
    )
    return response?.results ?? []
  }

  /** `POST /v1/memories/{id}/feedback` —— 有用/无用反馈，调整重要度。 */
  feedback(id: string, helpful: boolean, query?: string): Promise<MnemosMemory> {
    const body: Record<string, unknown> = { helpful }
    if (query) body.query = query
    return this.request('POST', `/v1/memories/${encodeURIComponent(id)}/feedback`, { body })
  }

  /** `POST /v1/context` —— 任务简报（可直接拼进 system prompt）。 */
  context(options: MnemosContextOptions = {}): Promise<MnemosBriefing> {
    const body: Record<string, unknown> = {}
    if (options.agent_id) body.agent_id = options.agent_id
    if (options.task_id) body.task_id = options.task_id
    if (options.query) body.query = options.query
    if (options.budget_tokens !== undefined) body.budget_tokens = options.budget_tokens
    return this.request('POST', '/v1/context', { body })
  }

  /** `GET /v1/tasks` —— 任务列表。 */
  listTasks(options: MnemosTaskListOptions = {}): Promise<{ results?: MnemosTask[]; count?: number }> {
    return this.request('GET', '/v1/tasks', {
      query: { status: options.status, agent_id: options.agent_id, limit: options.limit },
    })
  }

  /** `GET /v1/tasks/{id}` —— 任务详情。 */
  getTask(id: string): Promise<MnemosTask> {
    return this.request<MnemosTask>('GET', `/v1/tasks/${encodeURIComponent(id)}`)
  }

  /** `POST /v1/tasks` —— 开始任务。 */
  createTask(options: MnemosTaskCreateOptions): Promise<MnemosTask> {
    const body: Record<string, unknown> = { title: options.title }
    if (options.goal) body.goal = options.goal
    if (options.owner_agent_id) body.owner_agent_id = options.owner_agent_id
    if (options.branch) body.branch = options.branch
    return this.request('POST', '/v1/tasks', { body })
  }

  /** `POST /v1/tasks/{id}/finish` —— 结束任务（decisions/lessons/notes 会写成项目共享记忆）。 */
  finishTask(
    id: string,
    options: MnemosTaskFinishOptions = {},
  ): Promise<{ task?: MnemosTask; memories?: MnemosMemory[] }> {
    const body: Record<string, unknown> = {}
    if (options.status) body.status = options.status
    if (options.summary) body.summary = options.summary
    if (options.decisions && options.decisions.length > 0) body.decisions = options.decisions
    if (options.lessons && options.lessons.length > 0) body.lessons = options.lessons
    if (options.notes && options.notes.length > 0) body.notes = options.notes
    if (options.agent_id) body.agent_id = options.agent_id
    return this.request('POST', `/v1/tasks/${encodeURIComponent(id)}/finish`, { body })
  }

  /** `GET /v1/agents` —— 项目内 Agent 注册表。 */
  listAgents(): Promise<{ results?: MnemosAgent[]; count?: number }> {
    return this.request('GET', '/v1/agents')
  }

  /** `POST /v1/agents` —— 注册 Agent。 */
  createAgent(options: MnemosAgentCreateOptions): Promise<MnemosAgent> {
    const body: Record<string, unknown> = { name: options.name }
    if (options.role) body.role = options.role
    if (options.model) body.model = options.model
    if (options.capabilities && options.capabilities.length > 0) body.capabilities = options.capabilities
    return this.request('POST', '/v1/agents', { body })
  }
}
