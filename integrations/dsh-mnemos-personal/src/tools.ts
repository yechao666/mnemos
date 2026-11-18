/**
 * Agent 工具集合（12 个 `mnemos_*`，Mnemos v6）。
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
 * - v6.5 补齐：人物画像（profile）、记忆历史（history）、反馈（feedback）、更新（update）。
 *
 * 鉴权：配置了 orgApiKey 就带 Bearer；留空 = 本地免密模式（请求不带 Authorization，
 * 服务端以 `MNEMOS_DEV_NO_API_KEY=1` 启动）。status 工具照常探测，不用 key 也能自检。
 */

import type { ContentBlock, ToolDefinition, ToolRunContextLike } from './dsh-types.js'
import type { MnemosConfig, PersonType } from './config.js'
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_TOP_K,
  MAX_LIST_LIMIT,
  MAX_TOP_K,
  MnemosApiError,
  MnemosClient,
  type MnemosBrief,
  type MnemosMemory,
  type MnemosMemoryHistoryEntry,
  type MnemosPersonContext,
  type MnemosPersonFact,
  type PartitionInfo,
} from './mnemos-client.js'
import {
  WorkspacePathError,
  agentSessionId,
  resolvePartitionIdentity,
  type PartitionIdentity,
  type WorkspacePathResolver,
} from './workspace.js'

/** 读取活配置的回调（每次工具调用都重新解析，设置改动即时生效）。 */
type ConfigSource = () => MnemosConfig

/* ------------------------------------------------------------------ */
/* 通用助手                                                            */
/* ------------------------------------------------------------------ */

/** 一段文本内容块。 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** 失败结果的公共形状。 */
export interface ToolFailure {
  ok: false
  error: string
  action: string
}

/**
 * 统一失败结果：把错误消息与「下一步该做什么」都带上，模型读完就能修正。
 * `extra` 用于补齐本工具输出里的固定字段（例如 count: 0），不覆盖错误字段。
 */
function failResult(error: unknown): ToolFailure {
  if (error instanceof WorkspacePathError) {
    return { ok: false, error: error.message, action: error.action }
  }
  if (error instanceof MnemosApiError) {
    return { ok: false, error: error.message, action: error.action }
  }
  return {
    ok: false,
    error: messageOf(error),
    action: '检查 Mnemos 配置（baseUrl / orgApiKey）与工作区后重试；若持续失败，把错误信息反馈给用户。',
  }
}

/** readOnly 模式的统一提示。 */
const READ_ONLY_ERROR = 'readOnly 模式已开启，已拦截记忆写入 / 人变更。'
const READ_ONLY_ACTION = '在「设置 → 插件 → dsh-mnemos-personal」把 readOnly 改成 false 后重试。'

function readOnlyResult(): ToolFailure {
  return { ok: false, error: READ_ONLY_ERROR, action: READ_ONLY_ACTION }
}

/** 记忆容器的 JSON Schema：宽容，允许服务端新增字段。 */
const OBJECT_SCHEMA = { type: 'object', additionalProperties: true }
const OBJECT_ARRAY_SCHEMA = { type: 'array', items: OBJECT_SCHEMA }

/** 通用输出 schema 片段：ok / error / action / warning。 */
const BASE_PROPERTIES = {
  ok: { type: 'boolean' },
  error: { type: 'string' },
  action: { type: 'string' },
  warning: { type: 'string' },
}

/** 统一渲染失败信息。 */
function renderFailure(toolName: string, value: { error?: string; action?: string }): string {
  const action = value.action === undefined || value.action === '' ? '' : `\n下一步：${value.action}`
  return `${toolName} 失败：${value.error ?? '未知错误'}${action}`
}

/** 记忆正文：v6 用 `content`（旧 v1 读视图的 `memory` 仍兼容）。 */
function memoryContent(memory: MnemosMemory | undefined): string {
  const value = memory?.content ?? memory?.memory
  return typeof value === 'string' && value !== '' ? value : '(空内容)'
}

function memoryPerson(memory: MnemosMemory | undefined): string {
  const value =
    memory?.person_external_id ??
    memory?.personExternalId ??
    memory?.person_id ??
    memory?.personId
  return typeof value === 'string' && value !== '' ? value : '-'
}

/** 一条记忆的多行渲染：scope/分类/归属、内容、id。 */
function renderMemory(memory: MnemosMemory | undefined, index: number): string {
  if (memory === undefined) return `${index + 1}. (无效记忆)`
  const score = typeof memory.score === 'number' ? ` [${memory.score.toFixed(3)}]` : ''
  const meta = `${memory.scope ?? '-'}/${memory.category ?? '未分类'} · person=${memoryPerson(memory)}`
  const matched = Array.isArray(memory.matched_on) && memory.matched_on.length > 0 ? `（命中：${memory.matched_on.join('/')}）` : ''
  return `${index + 1}.${score} ${meta}${matched}\n   ${memoryContent(memory)}\n   id：${memory.id ?? '(未知)'}`
}

/** 记忆列表渲染。 */
function renderMemoryList(memories: MnemosMemory[]): string {
  return memories.map((memory, index) => renderMemory(memory, index)).join('\n')
}

/** 文本截断：超过 max 字符时保留前 max-1 个字符 + `…`（工具输出里避免刷屏）。 */
function truncateText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1))}…`
}

/** 渲染时把「空 / null / undefined」统一显示成 `-`。 */
function displayText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

/**
 * 单条记忆的摘要（更新 / 反馈结果用）：只留模型判断需要的字段，正文截断。
 * 返回的对象直接进工具输出，字段用 snake_case 与服务端一致。
 */
function summarizeMemory(memory: MnemosMemory | undefined, contentLimit = 500): Record<string, unknown> {
  if (memory === undefined) return {}
  const summary: Record<string, unknown> = {
    id: memory.id ?? null,
    content: truncateText(memoryContent(memory), contentLimit),
    scope: memory.scope ?? null,
    category: memory.category ?? null,
    person: memoryPerson(memory),
    importance: memory.importance ?? null,
    confidence: memory.confidence ?? null,
    status: memory.status ?? null,
    tags: Array.isArray(memory.tags) ? memory.tags : [],
    updated_at: memory.updated_at ?? memory.updatedAt ?? null,
  }
  const metadata = asRecord(memory.metadata)
  if (metadata !== undefined) summary.metadata = metadata
  return summary
}

/** 分区摘要（喂给工具结果 / 渲染）。 */
function summarizePartition(payload: unknown, fallback: PartitionInfo): Record<string, unknown> {
  const root = asRecord(payload)
  const node = asRecord(root?.partition) ?? root ?? {}
  const summary: Record<string, unknown> = {
    slug: stringField(node, 'slug') ?? fallback.slug,
    name: stringField(node, 'name') ?? fallback.name,
  }
  const id = stringField(node, 'id', 'partition_id') ?? fallback.id
  if (id !== undefined) summary.id = id
  const description = stringField(node, 'description')
  if (description !== undefined) summary.description = description
  const status = stringField(node, 'status')
  if (status !== undefined) summary.status = status
  const settings = asRecord(node.settings)
  if (settings !== undefined) summary.settings = settings
  return summary
}

/** 人摘要（喂给工具结果 / 渲染）：v6 计数在 persons 行上（memory_count 等）。 */
function summarizePerson(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload) ?? {}
  const node = asRecord(root.person) ?? root
  const summary: Record<string, unknown> = {}
  const id = stringField(node, 'id')
  if (id !== undefined) summary.id = id
  const externalId = stringField(node, 'external_id', 'externalId')
  if (externalId !== undefined) summary.external_id = externalId
  const type = stringField(node, 'type')
  if (type !== undefined) summary.type = type
  const displayName = stringField(node, 'display_name', 'displayName')
  if (displayName !== undefined) summary.display_name = displayName
  const status = stringField(node, 'status')
  if (status !== undefined) summary.status = status
  const attributes = asRecord(node.attributes)
  if (attributes !== undefined) summary.attributes = attributes
  // v6 反规范化计数（列表页不再逐行查 stats）。
  for (const key of [
    'memory_count',
    'shared_memory_count',
    'session_count',
    'first_seen_at',
    'last_seen_at',
    'last_memory_at',
    'created_at',
    'updated_at',
  ]) {
    const value = node[key]
    if (value !== undefined) summary[key] = value
  }
  // 兼容：旧版把计数放在 stats 里。
  const stats = asRecord(node.stats) ?? asRecord(root.stats)
  if (stats !== undefined) summary.stats = stats
  return summary
}

/** 人的记忆数 / 共享数（v6 字段优先，旧 stats 兜底）。 */
function personCount(person: Record<string, unknown>, key: 'memories' | 'shared_memories' | 'sessions'): number | undefined {
  const stats = asRecord(person.stats)
  const map = {
    memories: ['memory_count', 'memories'],
    shared_memories: ['shared_memory_count', 'shared_memories', 'sharedMemories'],
    sessions: ['session_count', 'sessions'],
  } as const
  for (const field of map[key]) {
    const direct = person[field]
    if (typeof direct === 'number') return direct
    const fallback = stats?.[field]
    if (typeof fallback === 'number') return fallback
  }
  return undefined
}

/** `person_id` 归一：空 / `self` → 配置里的默认人；其它原样。 */
function resolvePersonId(value: unknown, config: MnemosConfig): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '' || trimmed === 'self') return config.personId
  return trimmed
}

/** 推导本次调用的分区（workspace 派生 / fixed 配置）。 */
function partitionFor(
  config: MnemosConfig,
  resolveWorkspacePath: WorkspacePathResolver,
  exec: ToolRunContextLike | undefined,
): PartitionIdentity {
  return resolvePartitionIdentity(config.partitionMode, config.fixedPartition, resolveWorkspacePath(exec))
}

/** ensure 分区后的本地视图 + 降级警告。 */
interface EnsuredPartition {
  identity: PartitionIdentity
  info: PartitionInfo
  warning?: string
}

/**
 * 确保分区存在：首次 POST 幂等建分区（客户端缓存）。
 *
 * 降级：org key 没有 admin 作用域时 POST 会 403；此时若分区已由他人建好，读接口仍可用，
 * 所以退回「按 slug 直连」并记录 warning。写工具真正需要分区时会由后续请求报出准确错误。
 */
async function ensurePartition(
  client: MnemosClient,
  config: MnemosConfig,
  resolveWorkspacePath: WorkspacePathResolver,
  exec: ToolRunContextLike | undefined,
): Promise<EnsuredPartition> {
  const identity = partitionFor(config, resolveWorkspacePath, exec)
  // readOnly：连建分区这种写副作用也不做，直接按 slug 直连；分区不存在时由读请求报 404。
  if (config.readOnly) {
    return { identity, info: { slug: identity.slug, name: identity.name } }
  }
  try {
    const info = await client.ensurePartition(identity.slug, identity.name)
    return { identity, info }
  } catch (error) {
    if (error instanceof MnemosApiError && (error.status === 403 || error.status === 404)) {
      return {
        identity,
        info: { slug: identity.slug, name: identity.name },
        warning: `无法自动创建分区（${error.status} ${error.code}），已按 slug 直连；若分区不存在请用带 admin 的 org key。`,
      }
    }
    throw error
  }
}

/** 把 top_k 限制在服务端允许范围。 */
function clampTopK(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_TOP_K
  if (number < 1) return DEFAULT_TOP_K
  return Math.min(number, MAX_TOP_K)
}

/** 把 limit 限制在 v6 游标分页允许范围（默认 50，最大 200）。 */
function clampLimit(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_LIST_LIMIT
  if (number < 1) return DEFAULT_LIST_LIMIT
  return Math.min(number, MAX_LIST_LIMIT)
}

/** 游标参数归一：空串视为未传。 */
function cursorOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 规整 messages：允许字符串或 [{ role, content }]，空内容丢弃。 */
function normalizeMessages(value: unknown): Array<{ role: string; content: string }> | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : [{ role: 'user', content: value }]
  }
  if (!Array.isArray(value)) return undefined
  const messages: Array<{ role: string; content: string }> = []
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim() !== '') messages.push({ role: 'user', content: item })
      continue
    }
    const record = asRecord(item)
    if (record === undefined) continue
    const content = typeof record.content === 'string' ? record.content : ''
    if (content.trim() === '') continue
    const role = typeof record.role === 'string' && record.role !== '' ? record.role : 'user'
    messages.push({ role, content })
  }
  return messages.length > 0 ? messages : undefined
}

/** 占位符 key 契约（与服务端一致）：`[A-Za-z0-9_-]{3,64}`。 */
const PLACEHOLDER_KEY = /^[A-Za-z0-9_-]{3,64}$/

/**
 * 规整 placeholders 映射：只接受 `{ key: 非空 string }`，key 必须匹配 `[A-Za-z0-9_-]{3,64}`。
 *
 * 返回 `{ value }`（空映射视为未传）或 `{ error }`；错误由调用方拼进 `{ ok:false, error, action }`，
 * 这样模型能直接看到「哪个 key / 哪个值不合法」并修正，而不是等服务端 400。
 */
function normalizePlaceholders(value: unknown): { value?: Record<string, string>; error?: string } {
  if (value === undefined) return {}
  const record = asRecord(value)
  if (record === undefined) {
    return { error: 'placeholders 必须是对象映射，例如 {"phone_a1b2":"18334423321"}。' }
  }
  const placeholders: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (!PLACEHOLDER_KEY.test(key)) {
      return { error: `placeholders 的 key 必须匹配 [A-Za-z0-9_-]{3,64}，收到 ${JSON.stringify(key)}。` }
    }
    if (typeof raw !== 'string' || raw === '') {
      return { error: `placeholders.${key} 必须是非空字符串（真实值）。` }
    }
    placeholders[key] = raw
  }
  return Object.keys(placeholders).length > 0 ? { value: placeholders } : {}
}

/* ------------------------------------------------------------------ */
/* 1. mnemos_workspace                                                 */
/* ------------------------------------------------------------------ */

interface WorkspaceResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  partition?: Record<string, unknown>
  person?: Record<string, unknown>
  stats?: Record<string, unknown>
}

/** 确保分区与默认人存在，返回分区 / 人 / 统计。 */
export function mnemosWorkspaceTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<Record<string, never>, WorkspaceResult> {
  return {
    name: 'mnemos_workspace',
    description:
      '确保当前工作区对应的 Mnemos 分区与默认人存在（首次调用才建，幂等），并返回分区、人和统计。' +
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
        const settings = config()
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        // 分区详情：读接口失败就是真失败（ensure 的 fallback 不保证分区存在）。
        const partitionPayload = await client.getPartition(ensured.info.slug)
        const partition = summarizePartition(partitionPayload, ensured.info)

        const personId = resolvePersonId(undefined, settings)
        let warning = ensured.warning
        let personPayload: unknown
        if (settings.readOnly) {
          // readOnly：不建档，只读已有的人；不存在时仍返回分区信息 + 提示。
          try {
            personPayload = await client.getPerson(ensured.info.slug, personId)
          } catch (error) {
            if (!(error instanceof MnemosApiError) || error.status !== 404) throw error
            warning = warning === undefined ? 'readOnly 模式不会自动建默认人；关闭 readOnly 后重试可自动建档。' : warning
          }
        } else {
          try {
            await client.ensurePerson(ensured.info.slug, personId, { type: settings.personType })
          } catch (error) {
            // 只读 key：人可能已存在，GET 得通就照常返回。
            if (!(error instanceof MnemosApiError) || (error.status !== 403 && error.status !== 404)) throw error
            warning = warning === undefined ? `默认人无法 upsert（${error.status} ${error.code}），按已有档案读取。` : warning
          }
          personPayload = await client.getPerson(ensured.info.slug, personId)
        }
        const person = personPayload === undefined ? { external_id: personId } : summarizePerson(personPayload)
        // v6 分区统计直接读 partition_stats（O(1)）；老服务没有该端点时降级为「暂无统计」。
        let stats: Record<string, unknown> = {}
        try {
          stats = await client.getPartitionStats(ensured.info.slug)
        } catch (error) {
          if (!(error instanceof MnemosApiError) || (error.status !== 404 && error.status !== 405)) throw error
          warning = warning ?? '分区统计接口不可用（404/405）：确认 Mnemos 已升级到 v6。'
        }
        const result: WorkspaceResult = { ok: true, partition, person, stats }
        if (warning !== undefined) result.warning = warning
        return result
      } catch (error) {
        return failResult(error)
      }
    },
  }
}

function renderWorkspace(value: WorkspaceResult): string {
  const partition = value.partition ?? {}
  const person = value.person ?? {}
  const stats = value.stats ?? {}
  const lines = [
    `Mnemos 分区已就绪：${partition.slug ?? '(未知 slug)'}（${partition.name ?? '-'}${partition.id ? `，id=${partition.id}` : ''}）`,
    `默认人：${person.external_id ?? person.display_name ?? '-'}（type=${person.type ?? '-'}${person.id ? `，id=${person.id}` : ''}）`,
  ]
  const people = typeof stats.persons_total === 'number' ? `人 ${stats.persons_total}` : ''
  const breakdown = [
    typeof stats.persons_human === 'number' ? `human ${stats.persons_human}` : '',
    typeof stats.persons_agent === 'number' ? `agent ${stats.persons_agent}` : '',
    typeof stats.persons_service === 'number' ? `service ${stats.persons_service}` : '',
  ]
    .filter(Boolean)
    .join('/')
  const parts = [
    people === '' ? '' : `${people}${breakdown === '' ? '' : `（${breakdown}）`}`,
    typeof stats.memories_total === 'number' ? `记忆 ${stats.memories_total}` : '',
    typeof stats.shared_total === 'number' ? `分区共享 ${stats.shared_total}` : '',
    typeof stats.sessions_total === 'number' ? `会话 ${stats.sessions_total}` : '',
  ].filter(Boolean)
  lines.push(parts.length > 0 ? `统计：${parts.join(' · ')}` : '统计：暂无')
  const own = personCount(person, 'memories')
  const shared = personCount(person, 'shared_memories')
  const sessions = personCount(person, 'sessions')
  const personParts = [
    own === undefined ? '' : `记忆 ${own}`,
    shared === undefined ? '' : `分区共享 ${shared}`,
    sessions === undefined ? '' : `会话 ${sessions}`,
  ].filter(Boolean)
  if (personParts.length > 0) lines.push(`默认人计数：${personParts.join(' · ')}`)
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 2. mnemos_add                                                       */
/* ------------------------------------------------------------------ */

interface AddArgs {
  text?: string
  /** 记忆正文别名：与 text 二选一；占位符协议示例用 content。 */
  content?: string
  messages?: string | Array<{ role: string; content: string }>
  person_id?: string
  scope?: 'person' | 'partition' | 'session'
  session_id?: string
  category?: string
  tags?: string[]
  metadata?: Record<string, unknown>
  /** 隐私占位符映射：正文写 `{{key}}`，真实值只放这里。 */
  placeholders?: Record<string, string>
}

interface AddResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  added?: number
  results?: MnemosMemory[]
  events?: unknown[]
}

const SCOPES = ['person', 'partition', 'session'] as const

/** 写一条记忆（默认归属默认人；scope 缺省由服务端分区设置决定）。 */
export function mnemosAddTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<AddArgs, AddResult> {
  return {
    name: 'mnemos_add',
    description:
      '把值得沉淀的结论 / 决策 / 约束 / 踩坑经验写进 Mnemos（v6 按原文入库，不做事实抽取）。' +
      'text 与 messages 二选一（content 是 text 的别名）；person_id 缺省为默认人（self）。' +
      '隐私值不要直接写进正文：手机号 / 邮箱 / 身份证 / 银行卡等真实值放进 placeholders 映射，正文只写 {{key}} 占位符' +
      '（key 为 [A-Za-z0-9_-]{3,64}）。示例：text: "张三的手机号是 {{phone_a1b2}}，邮箱是 {{mail_c3d4}}。", ' +
      'placeholders: {"phone_a1b2":"18334423321","mail_c3d4":"zhangsan@example.com"}。' +
      '正文只落 token（映射由服务端加密保存）；详情默认只给占位符 key，reveal 才返回真实值；' +
      'mnemos_brief / mnemos_context 由服务端自动还原真实值。' +
      'scope：person=仅该人可见，partition=分区共享（协作知识），session=仅当前会话（必须带 session_id，缺省用当前会话）。' +
      '触发词：记住 / 记下来 / 写入记忆 / 沉淀结论 / save to memory / remember this.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入的记忆正文（最长 20000 字符）；隐私值用 {{key}} 占位符，不写明文。' },
        content: { type: 'string', description: '记忆正文别名（与 text 二选一）；隐私值用 {{key}} 占位符，不写明文。' },
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
        placeholders: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            '隐私占位符映射：{"key":"真实值"}，正文对应位置写 {{key}}（key 为 [A-Za-z0-9_-]{3,64}）。' +
            '真实值不落正文，由服务端加密保存；brief / context 自动还原，详情需 reveal。',
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
          description: '记忆分类，如 fact / preference / identity / constraint / skill / plan / event / insight / decision / context。',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，便于后续过滤。' },
        metadata: { type: 'object', additionalProperties: true, description: '自由元数据（来源、分支、工单号等）。' },
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
        const settings = config()
        if (settings.readOnly) return readOnlyResult()

        const messages = normalizeMessages(args.messages)
        const textArg = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : undefined
        const contentArg = typeof args.content === 'string' && args.content.trim() !== '' ? args.content : undefined
        const textValue = textArg ?? contentArg
        if (textValue === undefined && messages === undefined) {
          return {
            ok: false,
            error: 'mnemos_add 需要 text / content 或 messages 之一。',
            action: '把要沉淀的内容放进 text（content 是别名），或按 [{role, content}] 传 messages。',
          }
        }

        const placeholders = normalizePlaceholders(args.placeholders)
        if (placeholders.error !== undefined) {
          return {
            ok: false,
            error: `mnemos_add：${placeholders.error}`,
            action:
              '按 {"phone_a1b2":"18334423321"} 的映射传 placeholders，正文写 {{phone_a1b2}}；key 为 3–64 位字母 / 数字 / 下划线 / 连字符。',
          }
        }

        let scope: (typeof SCOPES)[number] | undefined
        if (args.scope !== undefined) {
          if (!SCOPES.includes(args.scope)) {
            return {
              ok: false,
              error: `scope 只能是 person / partition / session，收到 ${String(args.scope)}。`,
              action: '按记忆可见范围传 scope：person（仅该人）/ partition（分区共享）/ session（仅当前会话）。',
            }
          }
          scope = args.scope
        }

        let sessionId = typeof args.session_id === 'string' && args.session_id.trim() !== '' ? args.session_id.trim() : undefined
        if (scope === 'session' && sessionId === undefined) sessionId = agentSessionId(exec?.agent)
        if (scope === 'session' && sessionId === undefined) {
          return {
            ok: false,
            error: 'scope=session 但没有可用的 session_id：当前调用拿不到会话 id，也没有显式传入。',
            action: '显式传 session_id，或改用 scope=person / partition。',
          }
        }

        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        const personId = resolvePersonId(args.person_id, settings)
        const person = await client.ensurePerson(ensured.info.slug, personId, {
          type: personId === settings.personId ? settings.personType : undefined,
        })

        // v6：写记忆走人级端点 `POST /persons/:person/memories`，person 在路径里。
        // 路径优先用内部 id（服务端支持 id 或 external），避免同 external_id 多 type 的歧义。
        const body: Parameters<MnemosClient['addMemory']>[2] = {}
        if (textValue !== undefined && messages === undefined) body.text = textValue
        if (messages !== undefined) body.messages = messages
        if (placeholders.value !== undefined) body.placeholders = placeholders.value
        if (scope !== undefined) body.scope = scope
        if (sessionId !== undefined) body.session_id = sessionId
        if (typeof args.category === 'string' && args.category !== '') body.category = args.category
        if (Array.isArray(args.tags) && args.tags.length > 0) body.tags = args.tags
        if (args.metadata !== undefined && asRecord(args.metadata) !== undefined) body.metadata = args.metadata

        const written = await client.addMemory(ensured.info.slug, person.id ?? person.externalId, body)
        const results = written.memories
        const events = written.events
        const result: AddResult = { ok: true, added: results.length > 0 ? results.length : events.length, results, events }
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return { ...failResult(error), added: 0, results: [], events: [] }
      }
    },
  }
}

function renderAdd(value: AddResult): string {
  const results = value.results ?? []
  const added = typeof value.added === 'number' ? value.added : results.length
  const head = `已写入 Mnemos：${added} 条（person=${results.length > 0 ? memoryPerson(results[0]) : '默认人'}）`
  const lines = [head]
  if (results.length > 0) lines.push(renderMemoryList(results))
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 3. mnemos_search                                                    */
/* ------------------------------------------------------------------ */

interface SearchArgs {
  query: string
  person_id?: string
  scope?: 'person' | 'partition' | 'session'
  category?: string
  top_k?: number
}

interface SearchResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  count?: number
  took_ms?: number
  results?: MnemosMemory[]
}

/** 按人 / 分区检索记忆（语义 + 关键词混合检索）。 */
export function mnemosSearchTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<SearchArgs, SearchResult> {
  return {
    name: 'mnemos_search',
    description:
      '在当前工作区的 Mnemos 分区里检索记忆（混合检索，返回带相关度分数的结果）。' +
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
        const settings = config()
        if (typeof args.query !== 'string' || args.query.trim() === '') {
          return { ok: false, error: 'mnemos_search 需要非空 query。', action: '传 query（自然语言）后重试。' }
        }
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        const body: Parameters<MnemosClient['searchMemories']>[1] = {
          query: args.query,
          top_k: clampTopK(args.top_k),
        }
        if (args.scope !== undefined) body.scope = args.scope
        if (args.scope !== 'partition') body.person_id = resolvePersonId(args.person_id, settings)
        if (typeof args.category === 'string' && args.category !== '') body.category = args.category

        const payload = await client.searchMemories(ensured.info.slug, body)
        const results = payload.results
        const result: SearchResult = { ok: true, count: results.length, results }
        if (payload.took_ms !== undefined) result.took_ms = payload.took_ms
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return { ...failResult(error), count: 0, results: [] }
      }
    },
  }
}

function renderSearch(query: string, value: SearchResult): string {
  const results = value.results ?? []
  const took = typeof value.took_ms === 'number' ? `，耗时 ${Math.round(value.took_ms)}ms` : ''
  const head = `Mnemos 搜索「${query}」→ ${value.count ?? results.length} 条${took}`
  if (results.length === 0) {
    return `${head}\n（没有命中：换更宽泛的关键词、放宽 category/scope，或确认 person_id 与工作区是否绑定到该分区）`
  }
  const lines = [head, renderMemoryList(results)]
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 4. mnemos_get                                                       */
/* ------------------------------------------------------------------ */

interface GetArgs {
  id?: string
  person_id?: string
  scope?: 'person' | 'partition' | 'session'
  category?: string
  cursor?: string
  limit?: number
}

interface GetResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  memory?: MnemosMemory
  results?: MnemosMemory[]
  count?: number
  next_cursor?: string
  partition_stats?: Record<string, unknown>
}

/** 读一条记忆详情，或按人 / 范围用游标列出记忆。 */
export function mnemosGetTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<GetArgs, GetResult> {
  return {
    name: 'mnemos_get',
    description:
      '读取 Mnemos 记忆：传 id 取一条详情；不传 id 则按人 / 可见范围 / 分类用游标分页列出（v6 游标分页）。' +
      '列表默认按默认人（self）过滤；scope=partition 时列分区共享记忆（不按人过滤）。' +
      '响应里的 next_cursor 传给下一页的 cursor 参数即可继续翻页。',
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
        cursor: { type: 'string', description: '游标：传上一页响应里的 next_cursor，缺省从第一页开始。' },
        limit: { type: 'integer', description: `每页条数，默认 ${DEFAULT_LIST_LIMIT}，最大 ${MAX_LIST_LIMIT}。` },
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
          next_cursor: { type: 'string' },
          partition_stats: OBJECT_SCHEMA,
        },
        required: ['ok'],
      },
      render: (_args, value) => text(value.ok ? renderGet(value) : renderFailure('mnemos_get', value)),
    },
    async execute(args, exec) {
      try {
        const settings = config()
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)

        if (typeof args.id === 'string' && args.id.trim() !== '') {
          const payload = await client.getMemory(ensured.info.slug, args.id.trim())
          const record = asRecord(payload)
          const memory = (asRecord(record?.memory) ?? asRecord(record?.result) ?? record) as MnemosMemory | undefined
          const result: GetResult = { ok: true }
          if (memory !== undefined) result.memory = memory
          if (ensured.warning !== undefined) result.warning = ensured.warning
          return result
        }

        const cursor = cursorOf(args.cursor)
        const limit = clampLimit(args.limit)
        const category = typeof args.category === 'string' && args.category !== '' ? args.category : undefined
        // v6：按人列出走 `GET .../persons/:person/memories`；scope=partition 走分区级记忆列表。
        const page =
          args.scope === 'partition'
            ? await client.listMemories(ensured.info.slug, { scope: 'partition', category, cursor, limit })
            : await client.listPersonMemories(ensured.info.slug, resolvePersonId(args.person_id, settings), {
                scope: args.scope,
                category,
                cursor,
                limit,
              })

        const result: GetResult = { ok: true, results: page.items, count: page.items.length }
        if (page.next_cursor !== undefined) result.next_cursor = page.next_cursor
        if (page.partition_stats !== undefined) result.partition_stats = page.partition_stats
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return { ...failResult(error), results: [], count: 0 }
      }
    },
  }
}

function renderGet(value: GetResult): string {
  if (value.memory !== undefined) {
    const memory = value.memory
    const lines = [
      memoryContent(memory),
      `id：${memory.id ?? '(未知)'} · 分类：${memory.category ?? '-'} · scope：${memory.scope ?? '-'}`,
      `person：${memoryPerson(memory)} · session：${memory.session_id ?? memory.sessionId ?? '-'}`,
      `状态：${memory.status ?? '-'} · 更新：${memory.updated_at ?? memory.updatedAt ?? '-'}`,
    ]
    return lines.join('\n')
  }
  const results = value.results ?? []
  const more = value.next_cursor !== undefined ? '，还有下一页（把 next_cursor 传给 cursor 继续）' : ''
  const head = `Mnemos 记忆列表（${value.count ?? results.length} 条${more}）`
  if (results.length === 0) return `${head}\n（没有记忆：先 mnemos_add 写入，或换 person_id / scope / category）`
  const lines = [head, renderMemoryList(results)]
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 5. mnemos_brief                                                     */
/* ------------------------------------------------------------------ */

interface BriefArgs {
  person_id?: string
}

interface BriefResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  person_id?: string
  text?: string
  count?: number
  model?: string
  cached?: boolean
}

/** 人的简报：该人最近记忆 + 与其相关的分区共享记忆，压缩成可直接读的文本。 */
export function mnemosBriefTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<BriefArgs, BriefResult> {
  return {
    name: 'mnemos_brief',
    description:
      '读取某个人的 Mnemos 简报（该人最近记忆 + 与其相关的分区共享记忆，压缩成有字数上限的文本）。' +
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
        const settings = config()
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        const personId = resolvePersonId(args.person_id, settings)
        const payload = await client.getPersonBrief(ensured.info.slug, personId)
        const record = asRecord(payload)
        const brief = (asRecord(record?.brief) ?? record ?? {}) as MnemosBrief
        const briefText = typeof brief.text === 'string' ? brief.text : ''
        const result: BriefResult = { ok: true, person_id: personId, text: briefText }
        if (typeof brief.count === 'number') result.count = brief.count
        if (typeof brief.model === 'string') result.model = brief.model
        if (typeof brief.cached === 'boolean') result.cached = brief.cached
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return failResult(error)
      }
    },
  }
}

function renderBrief(value: BriefResult): string {
  const head = `Mnemos 简报（person=${value.person_id ?? '默认人'}）`
  const lines = [head]
  const briefText = (value.text ?? '').trim()
  if (briefText === '') {
    lines.push('（该人暂无简报：先用 mnemos_add 写入一些记忆，或确认 person_id / 分区是否正确）')
  } else {
    lines.push(briefText)
  }
  const meta = [
    typeof value.count === 'number' ? `纳入 ${value.count} 条记忆` : '',
    value.model !== undefined ? `模型 ${value.model}` : '',
    value.cached === true ? '命中缓存' : '',
  ].filter(Boolean)
  if (meta.length > 0) lines.push(meta.join(' · '))
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 6. mnemos_context                                                   */
/* ------------------------------------------------------------------ */

interface ContextArgs {
  person_id?: string
  query?: string
}

interface ContextResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  person_id?: string
  prompt?: string
  token_estimate?: number
  person?: Record<string, unknown>
  memory_count?: number
  shared_count?: number
}

/** 人的上下文：资料 + 简报 + 高相关记忆 +（可选）分区共享知识，返回可直接注入的 prompt。 */
export function mnemosContextTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<ContextArgs, ContextResult> {
  return {
    name: 'mnemos_context',
    description:
      '取某个人的 Mnemos 上下文（资料 + 简报 + 高相关记忆 + 分区共享知识），返回可直接阅读 / 注入提示词的 prompt。' +
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
        const settings = config()
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        const personId = resolvePersonId(args.person_id, settings)
        const body: Record<string, unknown> = {}
        if (typeof args.query === 'string' && args.query.trim() !== '') body.query = args.query.trim()
        const payload = await client.getPersonContext(ensured.info.slug, personId, body)
        const record = asRecord(payload)
        const context = (asRecord(record?.context) ?? record ?? {}) as MnemosPersonContext
        const prompt =
          typeof context.prompt === 'string'
            ? context.prompt
            : typeof record?.prompt === 'string'
              ? record.prompt
              : ''
        const result: ContextResult = { ok: true, person_id: personId, prompt }
        if (typeof context.token_estimate === 'number') result.token_estimate = context.token_estimate
        else if (typeof context.tokenEstimate === 'number') result.token_estimate = context.tokenEstimate
        const person = summarizePerson(payload)
        if (Object.keys(person).length > 0) result.person = person
        const memories = Array.isArray(context.memories) ? context.memories : []
        const shared = Array.isArray(context.shared) ? context.shared : []
        result.memory_count = memories.length
        result.shared_count = shared.length
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return failResult(error)
      }
    },
  }
}

function renderContext(value: ContextResult): string {
  const prompt = (value.prompt ?? '').trim()
  const head = `Mnemos 人物上下文（person=${value.person_id ?? '默认人'}${
    typeof value.memory_count === 'number' ? `，记忆 ${value.memory_count} 条` : ''
  }${typeof value.shared_count === 'number' ? `，共享 ${value.shared_count} 条` : ''}${
    typeof value.token_estimate === 'number' ? `，约 ${value.token_estimate} token` : ''
  }）`
  const lines = [head]
  lines.push(
    prompt === ''
      ? '（服务端没有返回 prompt：确认 person_id / 分区是否正确，或先用 mnemos_add 写入记忆）'
      : prompt,
  )
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 7. mnemos_person                                                    */
/* ------------------------------------------------------------------ */

interface PersonArgs {
  action: 'list' | 'get' | 'upsert'
  person_id?: string
  type?: 'human' | 'agent' | 'service'
  display_name?: string
  attributes?: Record<string, unknown>
  status?: string
  q?: string
  cursor?: string
  limit?: number
}

interface PersonResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  action_name?: string
  person?: Record<string, unknown>
  people?: Record<string, unknown>[]
  count?: number
  next_cursor?: string
  partition_stats?: Record<string, unknown>
}

/** 人管理：list（游标列表）/ get（详情）/ upsert（建档或更新资料）。 */
export function mnemosPersonTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<PersonArgs, PersonResult> {
  return {
    name: 'mnemos_person',
    description:
      '管理 Mnemos 里的「人」：action=list 用游标列人（按 type / status / q 筛选，v6 游标分页），action=get 取人详情，' +
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
        q: { type: 'string', description: 'list：按 external_id / 展示名全文搜索（FTS 前缀匹配）。' },
        cursor: { type: 'string', description: 'list：游标，传上一页响应里的 next_cursor；缺省从第一页开始。' },
        limit: { type: 'integer', description: `list：每页条数，默认 ${DEFAULT_LIST_LIMIT}，最大 ${MAX_LIST_LIMIT}。` },
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
          next_cursor: { type: 'string' },
          partition_stats: OBJECT_SCHEMA,
        },
        required: ['ok'],
      },
      render: (_args, value) => text(value.ok ? renderPerson(value) : renderFailure('mnemos_person', value)),
    },
    async execute(args, exec) {
      try {
        const settings = config()
        const action = args.action
        if (action !== 'list' && action !== 'get' && action !== 'upsert') {
          return {
            ok: false,
            error: `mnemos_person 的 action 只能是 list / get / upsert，收到 ${String(action)}。`,
            action: '传 action=list、get 或 upsert 后重试。',
          }
        }

        if (action === 'upsert' && settings.readOnly) return readOnlyResult()
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)

        if (action === 'list') {
          // v6：游标分页，响应带 next_cursor 与 partition_stats（头部统计不用 COUNT(*)）。
          const page = await client.listPersons(ensured.info.slug, {
            type: args.type,
            status: typeof args.status === 'string' && args.status !== '' ? args.status : undefined,
            q: typeof args.q === 'string' && args.q !== '' ? args.q : undefined,
            cursor: cursorOf(args.cursor),
            limit: clampLimit(args.limit),
          })
          const result: PersonResult = {
            ok: true,
            action_name: 'list',
            people: page.items.map((item) => summarizePerson(item)),
            count: page.items.length,
          }
          if (page.next_cursor !== undefined) result.next_cursor = page.next_cursor
          if (page.partition_stats !== undefined) result.partition_stats = page.partition_stats
          if (ensured.warning !== undefined) result.warning = ensured.warning
          return result
        }

        const personId = resolvePersonId(args.person_id, settings)
        if (action === 'get') {
          const payload = await client.getPerson(ensured.info.slug, personId)
          const result: PersonResult = { ok: true, action_name: 'get', person: summarizePerson(payload) }
          if (ensured.warning !== undefined) result.warning = ensured.warning
          return result
        }

        // upsert
        if (personId.startsWith('prs_')) {
          return {
            ok: false,
            error: `upsert 需要 external_id，不能传内部 id（${personId}）。`,
            action: '改用人的 external_id（App user_id / agent id）调用 upsert；只按内部 id 查询时用 action=get。',
          }
        }
        const type: PersonType | undefined =
          args.type ?? (personId === settings.personId ? settings.personType : undefined)
        const person = await client.ensurePerson(ensured.info.slug, personId, {
          type,
          displayName: typeof args.display_name === 'string' && args.display_name !== '' ? args.display_name : undefined,
          attributes: asRecord(args.attributes),
        })
        const payload = await client.getPerson(ensured.info.slug, personId)
        const summary = summarizePerson(payload)
        summary.external_id = person.externalId
        if (person.id !== undefined) summary.id = person.id
        const result: PersonResult = { ok: true, action_name: 'upsert', person: summary }
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return failResult(error)
      }
    },
  }
}

function renderPerson(value: PersonResult): string {
  if (value.action_name === 'list') {
    const people = value.people ?? []
    const more = value.next_cursor !== undefined ? '，还有下一页（把 next_cursor 传给 cursor 继续）' : ''
    const head = `Mnemos 人列表（${value.count ?? people.length} 人${more}）`
    if (people.length === 0) return `${head}\n（没有匹配的人：先 mnemos_add / mnemos_workspace 建档，或放宽 type / q）`
    const lines = people.map((person, index) => {
      const externalId = person.external_id ?? '(未知 external_id)'
      const name = person.display_name !== undefined ? ` · ${String(person.display_name)}` : ''
      const memoriesValue = personCount(person, 'memories')
      const memories = memoriesValue === undefined ? '' : ` · 记忆 ${memoriesValue}`
      return `${index + 1}. ${externalId}（type=${String(person.type ?? '-')}${name}${memories}）${person.id ? ` id=${String(person.id)}` : ''}`
    })
    return [head, ...lines, ...(value.warning !== undefined ? [`注意：${value.warning}`] : [])].join('\n')
  }
  const person = value.person ?? {}
  const lines = [
    `Mnemos 人：${person.external_id ?? person.display_name ?? '-'}（type=${person.type ?? '-'}${person.id ? `，id=${person.id}` : ''}）`,
    `展示名：${person.display_name ?? '-'} · 状态：${person.status ?? '-'}`,
  ]
  const parts = [
    personCount(person, 'memories') === undefined ? '' : `记忆 ${personCount(person, 'memories')}`,
    personCount(person, 'shared_memories') === undefined ? '' : `分区共享 ${personCount(person, 'shared_memories')}`,
    personCount(person, 'sessions') === undefined ? '' : `会话 ${personCount(person, 'sessions')}`,
  ].filter(Boolean)
  if (parts.length > 0) lines.push(`统计：${parts.join(' · ')}`)
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 8. mnemos_profile                                                   */
/* ------------------------------------------------------------------ */

interface ProfileArgs {
  person_id?: string
  force?: boolean
}

interface ProfileResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  person_id?: string
  person?: Record<string, unknown>
  facts?: MnemosPersonFact[]
  fact_count?: number
  summary?: string
  generated_at?: string
  cached?: boolean
}

/** 人的画像：v6.1 结构化 facts + 服务端摘要（force=true 强制重新生成）。 */
export function mnemosProfileTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<ProfileArgs, ProfileResult> {
  return {
    name: 'mnemos_profile',
    description:
      '读取某个人的 Mnemos 画像（v6.1：结构化 facts + 服务端摘要）。person_id 缺省为默认人（self）。' +
      'force=true 时请求 ?force=1 强制重新生成；默认用缓存（省 LLM 调用）。' +
      '想了解「这个人的资料被结构化成了哪些事实」时用它；最近记忆摘要用 mnemos_brief。',
    parameters: {
      type: 'object',
      properties: {
        person_id: { type: 'string', description: '人的 external_id（或 self / 省略 = 默认人）。' },
        force: { type: 'boolean', description: 'true = 强制重新生成画像（?force=1）；默认用缓存。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...BASE_PROPERTIES,
          person_id: { type: 'string' },
          person: OBJECT_SCHEMA,
          facts: OBJECT_ARRAY_SCHEMA,
          fact_count: { type: 'integer' },
          summary: { type: 'string' },
          generated_at: { type: 'string' },
          cached: { type: 'boolean' },
        },
        required: ['ok'],
      },
      render: (_args, value) => text(value.ok ? renderProfile(value) : renderFailure('mnemos_profile', value)),
    },
    async execute(args, exec) {
      try {
        const settings = config()
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        const personId = resolvePersonId(args.person_id, settings)
        const profile = await client.getPersonProfile(ensured.info.slug, personId, { force: args.force === true })
        const facts = profile.facts ?? []
        const result: ProfileResult = { ok: true, person_id: personId, facts, fact_count: facts.length }
        const person = summarizePerson(profile.person)
        if (Object.keys(person).length > 0) result.person = person
        if (typeof profile.summary === 'string') result.summary = profile.summary
        if (typeof profile.generated_at === 'string') result.generated_at = profile.generated_at
        if (typeof profile.cached === 'boolean') result.cached = profile.cached
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return { ...failResult(error), fact_count: 0, facts: [] }
      }
    },
  }
}

function renderProfile(value: ProfileResult): string {
  const facts = value.facts ?? []
  const meta = [
    typeof value.fact_count === 'number' ? `${value.fact_count} 条事实` : '',
    value.cached === true ? '命中缓存' : value.cached === false ? '已重新生成' : '',
    value.generated_at !== undefined ? `生成于 ${value.generated_at}` : '',
  ].filter(Boolean)
  const lines = [`Mnemos 画像（person=${value.person_id ?? '默认人'}${meta.length > 0 ? `，${meta.join(' · ')}` : ''}）`]
  if (facts.length === 0) {
    lines.push('（暂无结构化事实：先用 mnemos_add 写入记忆，或 force=true 重新生成画像）')
  } else {
    facts.forEach((fact, index) => {
      const confidence = typeof fact.confidence === 'number' ? `（confidence ${fact.confidence}）` : ''
      lines.push(`${index + 1}. ${displayText(fact.key)}: ${truncateText(displayText(fact.value), 200)}${confidence}`)
    })
  }
  const summary = (value.summary ?? '').trim()
  lines.push(`摘要：${summary === '' ? '（暂无摘要）' : truncateText(summary, 500)}`)
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 9. mnemos_history                                                   */
/* ------------------------------------------------------------------ */

interface HistoryArgs {
  id: string
}

interface HistoryResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  id?: string
  count?: number
  items?: MnemosMemoryHistoryEntry[]
}

/** 记忆变更历史：ADD / UPDATE / MERGE / SUPERSEDE / FEEDBACK … 的事件时间线。 */
export function mnemosHistoryTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<HistoryArgs, HistoryResult> {
  return {
    name: 'mnemos_history',
    description:
      '读取一条 Mnemos 记忆的变更历史（v6.1 事件时间线：ADD / UPDATE / MERGE / SUPERSEDE / FEEDBACK / PRIVACY 等，新→旧），' +
      '每条含 event / actor / created_at / old→new 摘要。需要 id（mnemos_get / mnemos_search 结果里的 mem_*）。' +
      '想确认「这条记忆为什么变成现在这样 / 被谁改过」时用它。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（mem_*）。' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...BASE_PROPERTIES,
          id: { type: 'string' },
          count: { type: 'integer' },
          items: OBJECT_ARRAY_SCHEMA,
        },
        required: ['ok'],
      },
      render: (_args, value) => text(value.ok ? renderHistory(value) : renderFailure('mnemos_history', value)),
    },
    async execute(args, exec) {
      try {
        const settings = config()
        if (typeof args.id !== 'string' || args.id.trim() === '') {
          return {
            ok: false,
            error: 'mnemos_history 需要记忆 id。',
            action: '先 mnemos_search / mnemos_get 拿到 mem_* 开头的记忆 id，再传 id。',
          }
        }
        const id = args.id.trim()
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        const items = await client.getMemoryHistory(ensured.info.slug, id)
        const result: HistoryResult = { ok: true, id, count: items.length, items }
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return { ...failResult(error), count: 0, items: [] }
      }
    },
  }
}

function renderHistory(value: HistoryResult): string {
  const items = value.items ?? []
  const head = `Mnemos 记忆历史：${value.id ?? '(未知 id)'}（${value.count ?? items.length} 个事件，新→旧）`
  if (items.length === 0) {
    return `${head}\n（没有历史记录：确认记忆 id 是否属于当前分区，或服务端尚未记录该记忆的变更）`
  }
  const lines = [head]
  items.forEach((item, index) => {
    const event = displayText(item.event)
    const actor = displayText(item.actor)
    const at = displayText(item.created_at)
    const before = item.old_content
    const after = item.new_content
    let change: string
    if (before == null && after == null) change = '内容未变'
    else if (before == null) change = `新：${truncateText(String(after ?? ''), 160)}`
    else if (after == null) change = `旧：${truncateText(String(before), 160)}`
    else if (before === after) change = `内容未变：${truncateText(String(after), 160)}`
    else change = `旧：${truncateText(String(before), 160)} → 新：${truncateText(String(after), 160)}`
    const reason = typeof item.reason === 'string' && item.reason !== '' ? ` · ${truncateText(item.reason, 80)}` : ''
    lines.push(`${index + 1}. ${event} · ${at} · actor=${actor}${reason}`)
    lines.push(`   ${change}`)
  })
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 10. mnemos_feedback                                                 */
/* ------------------------------------------------------------------ */

interface FeedbackArgs {
  id: string
  helpful: boolean
  query?: string
}

interface FeedbackResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  id?: string
  confidence?: number
  feedback_up?: number
  feedback_down?: number
  status?: string
}

/** 记忆反馈：标记某条检索结果有用 / 没用（服务端升降 confidence 并计数）。 */
export function mnemosFeedbackTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<FeedbackArgs, FeedbackResult> {
  return {
    name: 'mnemos_feedback',
    description:
      '对一条 Mnemos 记忆记反馈（v6.1：helpful=true 有用 / false 没用），服务端据此升降 confidence 并累计 feedback_up / feedback_down。' +
      'id 必填，query 可选（触发本次检索的原问题，便于归因）。通常用在 mnemos_search 之后。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（mem_*）。' },
        helpful: { type: 'boolean', description: 'true = 有用；false = 没用。' },
        query: { type: 'string', description: '可选：本次检索的原问题（最长 2000 字）。' },
      },
      required: ['id', 'helpful'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...BASE_PROPERTIES,
          id: { type: 'string' },
          confidence: { type: 'number' },
          feedback_up: { type: 'integer' },
          feedback_down: { type: 'integer' },
          status: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => text(value.ok ? renderFeedback(value) : renderFailure('mnemos_feedback', value)),
    },
    async execute(args, exec) {
      try {
        const settings = config()
        if (typeof args.id !== 'string' || args.id.trim() === '') {
          return {
            ok: false,
            error: 'mnemos_feedback 需要记忆 id。',
            action: '先 mnemos_search 拿到命中的 mem_* 记忆 id，再传 id 与 helpful。',
          }
        }
        if (typeof args.helpful !== 'boolean') {
          return {
            ok: false,
            error: `mnemos_feedback 的 helpful 必须是布尔值（true / false），收到 ${String(args.helpful)}。`,
            action: '有用传 helpful=true，没用传 helpful=false。',
          }
        }
        const id = args.id.trim()
        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        const body: Parameters<MnemosClient['feedbackMemory']>[2] = { helpful: args.helpful }
        if (typeof args.query === 'string' && args.query.trim() !== '') body.query = args.query.trim().slice(0, 2000)
        const mutation = await client.feedbackMemory(ensured.info.slug, id, body)
        const memory = mutation.memory
        const result: FeedbackResult = { ok: true, id }
        if (typeof memory?.confidence === 'number') result.confidence = memory.confidence
        if (typeof memory?.feedback_up === 'number') result.feedback_up = memory.feedback_up
        if (typeof memory?.feedback_down === 'number') result.feedback_down = memory.feedback_down
        if (typeof memory?.status === 'string') result.status = memory.status
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return failResult(error)
      }
    },
  }
}

function renderFeedback(value: FeedbackResult): string {
  const lines = [`Mnemos 记忆反馈已记录：${value.id ?? '(未知 id)'}`]
  const parts = [
    typeof value.confidence === 'number' ? `信心 ${value.confidence}` : '',
    typeof value.feedback_up === 'number' ? `有用 ${value.feedback_up}` : '',
    typeof value.feedback_down === 'number' ? `无用 ${value.feedback_down}` : '',
    value.status !== undefined ? `状态 ${value.status}` : '',
  ].filter(Boolean)
  if (parts.length > 0) lines.push(parts.join(' · '))
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 11. mnemos_update                                                   */
/* ------------------------------------------------------------------ */

interface UpdateArgs {
  id: string
  content?: string
  importance?: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

interface UpdateResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  memory?: Record<string, unknown>
}

/** 更新一条记忆：正文 / 重要度 / 标签 / 元数据（PATCH；readOnly 拦截）。 */
export function mnemosUpdateTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<UpdateArgs, UpdateResult> {
  return {
    name: 'mnemos_update',
    description:
      '更新一条 Mnemos 记忆（v6.1 PATCH）：可改 content（正文）/ importance（0–1）/ tags / metadata，只发显式给出的字段，至少给一个。' +
      'id 必填；返回更新后的记忆摘要，变更会进 mnemos_history。readOnly 模式会拦截。' +
      '要删除记忆请用控制台或 DELETE /v1/partitions/:p/memories/:id（本插件不暴露删除）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（mem_*）。' },
        content: { type: 'string', description: '新的记忆正文（非空；隐私值仍用 {{key}} 占位符）。' },
        importance: { type: 'number', description: '重要度，0–1（服务端按该值参与检索排序）。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（整体替换；最多 20 个，每个 ≤ 64 字符）。' },
        metadata: { type: 'object', additionalProperties: true, description: '自由元数据（整体替换）。' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...BASE_PROPERTIES,
          memory: OBJECT_SCHEMA,
        },
        required: ['ok'],
      },
      render: (_args, value) => text(value.ok ? renderUpdate(value) : renderFailure('mnemos_update', value)),
    },
    async execute(args, exec) {
      try {
        const settings = config()
        if (settings.readOnly) return readOnlyResult()
        if (typeof args.id !== 'string' || args.id.trim() === '') {
          return {
            ok: false,
            error: 'mnemos_update 需要记忆 id。',
            action: '先 mnemos_search / mnemos_get 拿到 mem_* 记忆 id，再传 id 与要更新的字段。',
          }
        }

        const body: Parameters<MnemosClient['updateMemory']>[2] = {}
        if (args.content !== undefined) {
          if (typeof args.content !== 'string' || args.content.trim() === '') {
            return {
              ok: false,
              error: 'content 必须是非空字符串。',
              action: '要改正文就传非空 content；只改重要度 / 标签 / 元数据时不要传 content。',
            }
          }
          body.content = args.content
        }
        if (args.importance !== undefined) {
          if (typeof args.importance !== 'number' || !Number.isFinite(args.importance) || args.importance < 0 || args.importance > 1) {
            return {
              ok: false,
              error: `importance 必须是 0–1 之间的数字，收到 ${String(args.importance)}。`,
              action: '把 importance 改成 0 到 1 之间的数（例如 0.8）。',
            }
          }
          body.importance = args.importance
        }
        if (args.tags !== undefined) {
          if (!Array.isArray(args.tags) || args.tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
            return {
              ok: false,
              error: 'tags 必须是字符串数组（元素非空）。',
              action: '按 ["tag-a","tag-b"] 传 tags；清空标签传空数组 []。',
            }
          }
          body.tags = args.tags.map((tag) => tag.trim()).slice(0, 20)
        }
        if (args.metadata !== undefined) {
          const metadata = asRecord(args.metadata)
          if (metadata === undefined) {
            return {
              ok: false,
              error: 'metadata 必须是对象。',
              action: '按 {"source":"...","ticket":"..."} 传 metadata。',
            }
          }
          body.metadata = metadata
        }
        if (Object.keys(body).length === 0) {
          return {
            ok: false,
            error: 'mnemos_update 至少需要 content / importance / tags / metadata 之一。',
            action: '显式给出要更新的字段后重试；只读一条记忆用 mnemos_get。',
          }
        }

        const ensured = await ensurePartition(client, settings, resolveWorkspacePath, exec)
        const mutation = await client.updateMemory(ensured.info.slug, args.id.trim(), body)
        const result: UpdateResult = { ok: true, memory: summarizeMemory(mutation.memory) }
        if (ensured.warning !== undefined) result.warning = ensured.warning
        return result
      } catch (error) {
        return failResult(error)
      }
    },
  }
}

function renderUpdate(value: UpdateResult): string {
  const memory = value.memory ?? {}
  const head = `已更新 Mnemos 记忆：${displayText(memory.id)}`
  const lines = [head]
  if (memory.content !== undefined) lines.push(`内容：${String(memory.content)}`)
  const meta = [
    memory.category !== undefined && memory.category !== null ? `分类 ${String(memory.category)}` : '',
    memory.importance !== undefined && memory.importance !== null ? `重要度 ${String(memory.importance)}` : '',
    memory.confidence !== undefined && memory.confidence !== null ? `信心 ${String(memory.confidence)}` : '',
    memory.status !== undefined && memory.status !== null ? `状态 ${String(memory.status)}` : '',
    memory.updated_at !== undefined && memory.updated_at !== null ? `更新 ${String(memory.updated_at)}` : '',
  ].filter(Boolean)
  if (meta.length > 0) lines.push(meta.join(' · '))
  if (Array.isArray(memory.tags) && memory.tags.length > 0) lines.push(`标签：${memory.tags.join(', ')}`)
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 12. mnemos_status                                                   */
/* ------------------------------------------------------------------ */

interface StatusResult {
  ok: boolean
  error?: string
  action?: string
  warning?: string
  reachable: boolean
  baseUrl: string
  apiKeyConfigured: boolean
  /** 鉴权模式：orgKey=已配置 orgApiKey；none=本地免密（请求不带 Authorization）。 */
  authMode: 'orgKey' | 'none'
  partitionSlug?: string
  partitionExists?: boolean
  personId?: string
  personType?: string
  personExists?: boolean
}

/**
 * 连接自检：服务可达性、鉴权模式、分区是否可达、默认人是否存在（不打印密钥）。
 *
 * 免密模式（orgApiKey 为空）不再提前返回：照常 GET 分区 / 人，
 * 服务端以 `MNEMOS_DEV_NO_API_KEY=1` 启动时能通过；仍返回 401 / 403 时
 * `reachable=false` 并给出「配置 orgApiKey，或本地以 MNEMOS_DEV_NO_API_KEY=1 启动 Mnemos」。
 */
export function mnemosStatusTool(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): ToolDefinition<Record<string, never>, StatusResult> {
  return {
    name: 'mnemos_status',
    description:
      '检查 Mnemos 连接与绑定：baseUrl、鉴权模式（orgKey / 本地免密）、当前工作区分区是否可达、默认人是否存在。' +
      '只做读检查（不会自动建分区 / 建人），API Key 永远不会被打印。' +
      '未配置 orgApiKey 时按免密模式照常探测；401 会提示配置 key 或本地以 MNEMOS_DEV_NO_API_KEY=1 启动。' +
      '触发词：mnemos 状态 / 检查记忆服务 / check mnemos / health.',
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
          authMode: { type: 'string', enum: ['orgKey', 'none'] },
          partitionSlug: { type: 'string' },
          partitionExists: { type: 'boolean' },
          personId: { type: 'string' },
          personType: { type: 'string' },
          personExists: { type: 'boolean' },
        },
        required: ['ok', 'reachable', 'baseUrl', 'apiKeyConfigured', 'authMode'],
      },
      render: (_args, value) => text(renderStatus(value)),
    },
    async execute(_args, exec) {
      const settings = config()
      const baseUrl = client.resolvedBaseUrl()
      const apiKeyConfigured = client.isApiKeyConfigured()
      const authMode = client.authMode()
      const base: StatusResult = {
        ok: false,
        reachable: false,
        baseUrl,
        apiKeyConfigured,
        authMode,
        personId: settings.personId,
        personType: settings.personType,
      }

      let identity: PartitionIdentity
      try {
        identity = partitionFor(settings, resolveWorkspacePath, exec)
      } catch (error) {
        return { ...base, ...failResult(error) }
      }
      base.partitionSlug = identity.slug

      try {
        // 只确认分区可达；不把分区大对象塞进状态结果。免密模式同样照常探测。
        await client.getPartition(identity.slug)
        let personExists = false
        try {
          await client.getPerson(identity.slug, settings.personId)
          personExists = true
        } catch (error) {
          if (!(error instanceof MnemosApiError) || error.status !== 404) throw error
        }
        const result: StatusResult = {
          ...base,
          ok: true,
          reachable: true,
          partitionExists: true,
          personExists,
        }
        if (!personExists) {
          result.warning = '分区可达，但默认人还不存在：调 mnemos_add / mnemos_workspace 会自动建档。'
        }
        return result
      } catch (error) {
        if (error instanceof MnemosApiError && (error.status === 401 || error.status === 403)) {
          // 鉴权失败：服务可能可达，但当前凭据不被接受；action 已按免密 / orgKey 区分。
          return { ...base, reachable: false, error: error.message, action: error.action }
        }
        if (error instanceof MnemosApiError && error.status === 404) {
          return {
            ...base,
            reachable: true,
            partitionExists: false,
            error: error.message,
            action: '分区尚不存在：调 mnemos_workspace 以当前工作区创建分区（需要带 admin 的 org key）。',
          }
        }
        return { ...base, ...failResult(error) }
      }
    },
  }
}

function renderStatus(value: StatusResult): string {
  const auth =
    value.authMode === 'none'
      ? '免密模式（未配置 orgApiKey，请求不带 Authorization；本地需以 MNEMOS_DEV_NO_API_KEY=1 启动 Mnemos）'
      : 'orgApiKey 已配置（Bearer）'
  const lines = [
    `Mnemos 连接：${value.reachable ? '服务可达' : '不可达'}`,
    `地址：${value.baseUrl || '(未配置)'}`,
    `鉴权：${auth}`,
  ]
  if (value.partitionSlug !== undefined) {
    lines.push(
      `分区：${value.partitionSlug}（${
        value.partitionExists === true ? '存在' : value.partitionExists === false ? '不存在，需 mnemos_workspace 创建' : '未知'
      }）`,
    )
  }
  lines.push(
    `默认人：${value.personId ?? '-'}（type=${value.personType ?? '-'}，${
      value.personExists === true ? '存在' : value.personExists === false ? '不存在' : '未知'
    }）`,
  )
  if (value.ok !== true) lines.push(`原因：${value.error ?? '未知错误'}`)
  if (value.action !== undefined && value.action !== '') lines.push(`下一步：${value.action}`)
  if (value.warning !== undefined) lines.push(`注意：${value.warning}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 工具集合                                                            */
/* ------------------------------------------------------------------ */

/** 本插件的全部工具（顺序即注册顺序，也是 Agent 看到的大致顺序）。 */
export function createMnemosTools(
  client: MnemosClient,
  config: ConfigSource,
  resolveWorkspacePath: WorkspacePathResolver,
): Array<ToolDefinition<any, any>> {
  return [
    mnemosWorkspaceTool(client, config, resolveWorkspacePath),
    mnemosAddTool(client, config, resolveWorkspacePath),
    mnemosSearchTool(client, config, resolveWorkspacePath),
    mnemosGetTool(client, config, resolveWorkspacePath),
    mnemosBriefTool(client, config, resolveWorkspacePath),
    mnemosContextTool(client, config, resolveWorkspacePath),
    mnemosPersonTool(client, config, resolveWorkspacePath),
    mnemosProfileTool(client, config, resolveWorkspacePath),
    mnemosHistoryTool(client, config, resolveWorkspacePath),
    mnemosFeedbackTool(client, config, resolveWorkspacePath),
    mnemosUpdateTool(client, config, resolveWorkspacePath),
    mnemosStatusTool(client, config, resolveWorkspacePath),
  ]
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
  'mnemos_profile',
  'mnemos_history',
  'mnemos_feedback',
  'mnemos_update',
  'mnemos_status',
] as const
