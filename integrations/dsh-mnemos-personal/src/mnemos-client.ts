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

import type { MnemosConfig, PersonType } from './config.js'

/** 记忆可见范围（v5 语义：person=仅该人、partition=分区共享、session=仅当前会话）。 */
export type MemoryScope = 'person' | 'partition' | 'session'

/** 单次 HTTP 请求缺省超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 检索缺省条数（服务端上限 50）。 */
export const DEFAULT_TOP_K = 8

/** 记忆条数上限（服务端 top_k 上限）。 */
export const MAX_TOP_K = 50

/** 一条记忆（v5 读视图；同时容忍旧 camelCase 字段，渲染层两者都认）。 */
export interface MnemosMemory {
  id?: string
  /** 旧 v1 读视图字段。 */
  memory?: string
  /** 创建响应 / v5 字段。 */
  content?: string
  person_id?: string | null
  personId?: string | null
  person_external_id?: string | null
  personExternalId?: string | null
  actor_person_id?: string | null
  session_id?: string | null
  sessionId?: string | null
  scope?: MemoryScope
  category?: string
  importance?: number
  confidence?: number
  source?: string
  status?: string
  tags?: string[]
  metadata?: Record<string, unknown> | null
  created_at?: string
  createdAt?: string
  updated_at?: string
  updatedAt?: string
  last_accessed_at?: string | null
  access_count?: number
  accessCount?: number
  /** 仅搜索结果带：融合分与逐信号分解。 */
  score?: number
  signals?: Record<string, number>
  matched_on?: string[]
  [key: string]: unknown
}

/** 一条记忆（v5「人」）。 */
export interface MnemosPerson {
  id?: string
  external_id?: string
  externalId?: string
  type?: string
  display_name?: string
  displayName?: string
  status?: string
  attributes?: Record<string, unknown>
  first_seen_at?: string
  last_seen_at?: string
  created_at?: string
  updated_at?: string
  stats?: {
    memories?: number
    shared_memories?: number
    sharedMemories?: number
    sessions?: number
    last_memory_at?: string
    lastMemoryAt?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** 分区（v5；存储上仍是旧 projects 表）。 */
export interface MnemosPartition {
  id?: string
  partition_id?: string
  project_id?: string
  slug?: string
  name?: string
  description?: string
  [key: string]: unknown
}

/** 人的简报（`GET /v1/partitions/:p/persons/:person/brief`）。 */
export interface MnemosBrief {
  person_id?: string
  personId?: string
  text?: string
  max_chars?: number
  maxChars?: number
  count?: number
  model?: string
  cached?: boolean
  generated_at?: string
  recent?: MnemosMemory[]
  [key: string]: unknown
}

/** 人的上下文（`POST /v1/partitions/:p/persons/:person/context`）。 */
export interface MnemosPersonContext {
  person?: MnemosPerson
  brief?: MnemosBrief
  memories?: MnemosMemory[]
  shared?: MnemosMemory[]
  /** 可直接注入提示词的中文 Markdown。 */
  prompt?: string
  token_estimate?: number
  tokenEstimate?: number
  citations?: string[]
  built_at?: string
  [key: string]: unknown
}

/** 客户端错误统一形状。 */
export interface MnemosApiErrorInit {
  message: string
  /** HTTP 状态码；网络层失败时为 undefined。 */
  status?: number
  /** 服务端 `error.code`，或本地错误码（network_error / timeout / missing_api_key …）。 */
  code?: string
  /** 建议的下一步动作（工具层原样透传给模型）。 */
  action?: string
  requestId?: string
  details?: unknown
  method?: string
  path?: string
}

/** 请求失败（非 2xx、网络错误、配置缺失）。 */
export class MnemosApiError extends Error {
  readonly status?: number
  readonly code: string
  readonly action: string
  readonly requestId?: string
  readonly details?: unknown
  readonly method?: string
  readonly path?: string

  constructor(init: MnemosApiErrorInit) {
    super(init.message)
    this.name = 'MnemosApiError'
    this.status = init.status
    this.code = init.code ?? 'unknown_error'
    this.action = init.action ?? '检查 Mnemos 配置（baseUrl / orgApiKey）后重试。'
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
      message: `Mnemos ${method} ${path} 请求超时（${timeoutMs}ms）。`,
      code: 'timeout',
      action: '确认 Mnemos 服务已启动并能在该时间内响应；检查 baseUrl 是否指向正确的服务。',
      method,
      path,
    })
    this.name = 'MnemosTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

type QueryValue = string | number | boolean | undefined

/** 分区的本地视图（缓存用）：id 可能未知（服务端未返回时回落到 slug）。 */
export interface PartitionInfo {
  slug: string
  name: string
  id?: string
  raw?: unknown
}

/** 人的本地视图（缓存用）。 */
export interface PersonInfo {
  externalId: string
  id?: string
  type?: string
  raw?: unknown
}

/** 客户端可选项（超时覆盖仅供测试/特殊部署使用）。 */
export interface MnemosClientOptions {
  timeoutMs?: number
}

/** 写记忆的请求体（由工具层组装；只发显式给出的字段）。 */
export interface AddMemoryBody {
  text?: string
  messages?: Array<{ role: string; content: string }>
  person_id?: string
  person_external_id?: string
  scope?: MemoryScope
  session_id?: string
  category?: string
  tags?: string[]
  metadata?: Record<string, unknown>
  infer?: boolean
}

/** 检索的请求体。 */
export interface SearchMemoriesBody {
  query: string
  person_id?: string
  scope?: MemoryScope
  category?: string
  top_k?: number
}

/** 写请求时可选的错误信息。 */
interface RequestOptions {
  body?: unknown
  query?: Record<string, QueryValue>
}

/** 把「下一步该做什么」写进错误里：模型读完就知道怎么修。 */
function actionFor(status: number | undefined, code: string): string {
  const normalized = code.toUpperCase()
  if (status === 401 || normalized === 'INVALID_API_KEY' || normalized === 'UNAUTHORIZED' || normalized === 'API_KEY_REVOKED') {
    return 'orgApiKey 无效或已失效：在「设置 → 插件 → dsh-mnemos-personal」检查 orgApiKey（控制台「密钥」里 kind=org 的 Key）。'
  }
  if (status === 403 || normalized === 'FORBIDDEN') {
    return 'org key 作用域不足：读需要 memories:read，写需要 memories:write，按工作区自动建分区还需要 admin。'
  }
  if (status === 404 || normalized === 'NOT_FOUND') {
    return '目标不存在：先调 mnemos_workspace 确保分区与默认人存在，再检查 person_id / 记忆 id / 分区名。'
  }
  if (status === 409 || normalized === 'CONFLICT') {
    return '资源状态冲突：用 mnemos_workspace / mnemos_person action=get 查看分区与人的现状后重试。'
  }
  if (status === 429 || normalized === 'RATE_LIMITED' || normalized === 'QUOTA_EXCEEDED') {
    return '触发限流或配额：稍后重试，或换一个 org key。'
  }
  if (status === 400 || normalized === 'VALIDATION_ERROR' || normalized === 'BAD_REQUEST') {
    return '参数被服务端拒绝：检查 scope（session scope 必须带 session_id）、top_k（≤ 50）、person_id 与分区 slug 的格式。'
  }
  if (status === 503 || status === 504) {
    return 'Mnemos 服务暂时不可用：确认服务已启动后重试。'
  }
  return '检查 baseUrl / orgApiKey 与 Mnemos 服务日志后重试。'
}

/** 网络层异常（fetch 直接 reject）统一归一。 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** 从 `{ partition }` / 裸分区对象提取分区视图。 */
export function extractPartition(payload: unknown, fallbackSlug: string, fallbackName?: string): PartitionInfo {
  const root = asRecord(payload)
  const partition = asRecord(root?.partition) ?? asRecord(root?.project) ?? root
  const id = stringField(partition, 'id', 'partition_id', 'project_id')
  const slug = stringField(partition, 'slug') ?? fallbackSlug
  const name = stringField(partition, 'name') ?? fallbackName ?? slug
  const info: PartitionInfo = { slug, name }
  if (id !== undefined) info.id = id
  info.raw = payload
  return info
}

/** 从 `{ person }` / 裸人对象提取人的视图。 */
export function extractPerson(payload: unknown, fallbackExternalId: string): PersonInfo {
  const root = asRecord(payload)
  const person = asRecord(root?.person) ?? root
  const externalId =
    stringField(person, 'external_id', 'externalId') ??
    fallbackExternalId
  const info: PersonInfo = { externalId }
  const id = stringField(person, 'id')
  if (id !== undefined) info.id = id
  const type = stringField(person, 'type')
  if (type !== undefined) info.type = type
  info.raw = payload
  return info
}

/**
 * 读取活配置的 Mnemos 客户端：每次请求都重新解析配置，
 * 因此设置页改动（baseUrl / orgApiKey / personId …）无需重建客户端或重挂工具。
 */
export class MnemosClient {
  private readonly timeoutMs: number
  /** slug → 分区视图（首次 ensure 成功后缓存，进程内不再重复 POST）。 */
  private readonly partitionCache = new Map<string, PartitionInfo>()
  /** slug → 进行中的 ensure（并发工具调用只发一次 POST）。 */
  private readonly partitionInflight = new Map<string, Promise<PartitionInfo>>()
  /** `${分区 slug}\0${externalId}` → 人视图（首次 PUT 成功后缓存）。 */
  private readonly personCache = new Map<string, PersonInfo>()

  constructor(
    private readonly config: () => MnemosConfig,
    options: MnemosClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 配置里的服务地址（规范化去尾斜杠，不校验可用性；状态自检用）。 */
  resolvedBaseUrl(): string {
    return (this.config().baseUrl ?? '').trim().replace(/\/+$/, '')
  }

  /** 当前是否配置了 org API Key（只报布尔，绝不返回密钥）。 */
  isApiKeyConfigured(): boolean {
    return Boolean((this.config().orgApiKey ?? '').trim())
  }

  /** 生效超时（毫秒）。 */
  getTimeoutMs(): number {
    return this.timeoutMs
  }

  /** 分区路径前缀：`/v1/partitions/:partition`。 */
  private partitionPath(partitionRef: string, suffix = ''): string {
    return `/v1/partitions/${encodeURIComponent(partitionRef)}${suffix}`
  }

  /** 发一个请求：拼 URL、鉴权、超时、解析错误体（不重试，写接口幂等性由服务端保证）。 */
  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const rawBaseUrl = (this.config().baseUrl ?? '').trim().replace(/\/+$/, '')
    if (rawBaseUrl === '') {
      throw new MnemosApiError({
        message: '未配置 Mnemos 服务地址：baseUrl 为空。',
        code: 'missing_base_url',
        action: '在「设置 → 插件 → dsh-mnemos-personal」填写 baseUrl（默认 http://127.0.0.1:4380）。',
        method,
        path,
      })
    }
    let url: URL
    try {
      url = new URL(rawBaseUrl + path)
    } catch {
      throw new MnemosApiError({
        message: `Mnemos 服务地址不可用：${rawBaseUrl}（应为 http://host:port 形式）。`,
        code: 'invalid_base_url',
        action: '把 baseUrl 改成 http(s)://host:port 形式（不带尾斜杠、不带 /v1）。',
        method,
        path,
      })
    }
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
    }

    const apiKey = (this.config().orgApiKey ?? '').trim()
    if (!apiKey) {
      throw new MnemosApiError({
        message: '未配置 Mnemos org API Key：orgApiKey 为空。',
        code: 'missing_api_key',
        action: '在「设置 → 插件 → dsh-mnemos-personal」填写 orgApiKey（控制台「密钥」创建 kind=org 的 Key，建议带 admin）。',
        method,
        path,
      })
    }

    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      if (isTimeoutError(error)) throw new MnemosTimeoutError(this.timeoutMs, method, path)
      throw new MnemosApiError({
        message: `Mnemos ${method} ${path} 连接失败：${error instanceof Error ? error.message : String(error)}。`,
        code: 'network_error',
        action: '确认 Mnemos 服务已启动且 baseUrl 正确（默认 http://127.0.0.1:4380）。',
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
      const error = asRecord(asRecord(payload)?.error)
      const code = stringField(error, 'code') ?? `http_${response.status}`
      const detail =
        stringField(error, 'message') ?? (typeof payload === 'string' ? payload.slice(0, 500) : response.statusText)
      const requestId =
        stringField(error, 'requestId', 'request_id') ?? response.headers.get('x-request-id') ?? undefined
      const action = actionFor(response.status, code)
      throw new MnemosApiError({
        message: `Mnemos ${method} ${path} -> ${response.status} ${code}: ${detail}（${action}）`,
        status: response.status,
        code,
        action,
        requestId,
        details: error?.details,
        method,
        path,
      })
    }

    if (response.status === 204) return undefined as T
    return payload as T
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
  ensurePartition(slug: string, name?: string): Promise<PartitionInfo> {
    const cached = this.partitionCache.get(slug)
    if (cached !== undefined) return Promise.resolve(cached)
    const pending = this.partitionInflight.get(slug)
    if (pending !== undefined) return pending
    const promise = this.doEnsurePartition(slug, name).finally(() => {
      this.partitionInflight.delete(slug)
    })
    this.partitionInflight.set(slug, promise)
    return promise
  }

  private async doEnsurePartition(slug: string, name?: string): Promise<PartitionInfo> {
    let payload: unknown
    try {
      payload = await this.request('POST', '/v1/partitions', { body: { slug, name: name ?? slug } })
    } catch (error) {
      // 409 = 已存在（并发 / 上次已建）：退回读接口，不把幂等失败暴露给调用方。
      if (error instanceof MnemosApiError && error.status === 409) {
        payload = await this.request('GET', this.partitionPath(slug))
      } else {
        throw error
      }
    }
    let info = extractPartition(payload, slug, name)
    if (info.id === undefined) {
      try {
        info = extractPartition(await this.request('GET', this.partitionPath(slug)), slug, name)
      } catch {
        // GET 失败不影响继续按 slug 调用其它端点。
      }
    }
    this.partitionCache.set(slug, info)
    return info
  }

  /** `GET /v1/partitions/:partition` —— 分区信息。 */
  getPartition(partitionRef: string): Promise<unknown> {
    return this.request('GET', this.partitionPath(partitionRef))
  }

  /** 清空缓存（测试 / 配置切换后强制重新 ensure）。 */
  clearCache(): void {
    this.partitionCache.clear()
    this.partitionInflight.clear()
    this.personCache.clear()
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
  ensurePerson(
    partitionRef: string,
    externalId: string,
    options: { type?: PersonType; displayName?: string; attributes?: Record<string, unknown> } = {},
  ): Promise<PersonInfo> {
    const key = `${partitionRef}\u0000${externalId}`
    const cached = this.personCache.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    const body: Record<string, unknown> = {}
    if (options.type !== undefined) body.type = options.type
    if (options.displayName !== undefined && options.displayName !== '') body.display_name = options.displayName
    if (options.attributes !== undefined) body.attributes = options.attributes
    const path = this.partitionPath(partitionRef, `/persons/${encodeURIComponent(externalId)}`)
    return this.request('PUT', path, { body }).then((payload) => {
      const info = extractPerson(payload, externalId)
      this.personCache.set(key, info)
      return info
    })
  }

  /** `GET /v1/partitions/:p/persons/:person` —— 人详情 + 统计。 */
  getPerson(partitionRef: string, personRef: string): Promise<unknown> {
    return this.request('GET', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}`))
  }

  /** `GET /v1/partitions/:p/persons` —— 人列表（type / status / q / 分页）。 */
  listPersons(
    partitionRef: string,
    query: { type?: string; status?: string; q?: string; page?: number; page_size?: number } = {},
  ): Promise<unknown> {
    return this.request('GET', this.partitionPath(partitionRef, '/persons'), {
      query: {
        type: query.type,
        status: query.status,
        q: query.q,
        page: query.page,
        page_size: query.page_size,
      },
    })
  }

  /** `GET /v1/partitions/:p/persons/:person/brief` —— 人的简报。 */
  getPersonBrief(partitionRef: string, personRef: string): Promise<unknown> {
    return this.request('GET', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/brief`))
  }

  /** `POST /v1/partitions/:p/persons/:person/context` —— 人的上下文（含可直接注入的 prompt）。 */
  getPersonContext(partitionRef: string, personRef: string, body: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('POST', this.partitionPath(partitionRef, `/persons/${encodeURIComponent(personRef)}/context`), {
      body,
    })
  }

  /* ------------------------------------------------------------------ */
  /* 记忆                                                                */
  /* ------------------------------------------------------------------ */

  /** `POST /v1/partitions/:p/memories` —— 写记忆。 */
  addMemory(partitionRef: string, body: AddMemoryBody): Promise<unknown> {
    return this.request('POST', this.partitionPath(partitionRef, '/memories'), { body })
  }

  /** `POST /v1/partitions/:p/memories/search` —— 检索。 */
  searchMemories(partitionRef: string, body: SearchMemoriesBody): Promise<unknown> {
    return this.request('POST', this.partitionPath(partitionRef, '/memories/search'), { body })
  }

  /** `GET /v1/partitions/:p/memories` —— 列表（person / scope / category / 分页）。 */
  listMemories(
    partitionRef: string,
    query: { person_id?: string; scope?: string; category?: string; page?: number; page_size?: number } = {},
  ): Promise<unknown> {
    return this.request('GET', this.partitionPath(partitionRef, '/memories'), {
      query: {
        person_id: query.person_id,
        scope: query.scope,
        category: query.category,
        page: query.page,
        page_size: query.page_size,
      },
    })
  }

  /** `GET /v1/partitions/:p/memories/:id` —— 记忆详情。 */
  getMemory(partitionRef: string, id: string): Promise<unknown> {
    return this.request('GET', this.partitionPath(partitionRef, `/memories/${encodeURIComponent(id)}`))
  }
}
