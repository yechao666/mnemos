/**
 * 分区 = 工作区：把 DSH 会话工作区绝对路径规范化成稳定的 Mnemos 分区 slug。
 *
 * 规则（docs/v6-architecture.md §6）：
 *   slug = `ws-<basename 小写、去非法字符>-<sha1(规范化绝对路径).slice(0, 8)>`
 *
 * - basename 只用于人可读与调试；唯一性由路径哈希保证（两个同名目录不会撞分区）。
 * - 哈希输入是规范化后的绝对路径，所以同一路径每次得到同一 slug（幂等建分区的前提）。
 * - `fixed` 模式跳过派生，直接用配置里的 `fixedPartition`。
 */

import { createHash } from 'node:crypto'
import { basename, resolve as resolvePath } from 'node:path'

/** slug 前缀：明确标识「由工作区派生」，与服务端手工创建的分区区分开。 */
export const WORKSPACE_SLUG_PREFIX = 'ws-'

/**
 * basename 允许出现在 slug 里的最大长度（哈希已保证唯一性，名字只求可读）。
 *
 * 取 36 是为了让 `ws-<segment>-<hash8>` 不超过 v6 的 slug 上限 48 字符
 * （3 + 36 + 1 + 8 = 48）；basename 更长的目录只是少显示几个字符，哈希仍唯一。
 */
const MAX_NAME_LENGTH = 36

/** 规范化失败 / 配置缺失时的可操作错误（工具层会转成 `{ ok:false, error, action }`）。 */
export class WorkspacePathError extends Error {
  /** 本地错误码（与 MnemosApiError 的小写错误码风格一致）。 */
  readonly code: string
  /** 建议的下一步动作，直接展示给模型 / 用户。 */
  readonly action: string

  constructor(message: string, code: string, action: string) {
    super(message)
    this.name = 'WorkspacePathError'
    this.code = code
    this.action = action
  }
}

/**
 * 把工作区路径规范化为绝对路径（去尾分隔符、消解 `.` / `..`）。
 *
 * 服务端从不接触 DSH 的路径，这里只要求「同一输入 → 同一输出」，
 * 因此不做 realpath / 大小写折叠等可能因机器而异的操作。
 *
 * @param input 会话工作区路径（DSH 保证是绝对路径；手搭测试可传相对路径）。
 * @returns 规范化后的绝对路径。
 * @throws {WorkspacePathError} 输入为空。
 */
export function normalizeWorkspacePath(input: string): string {
  const value = typeof input === 'string' ? input.trim() : ''
  if (value === '') {
    throw new WorkspacePathError(
      '当前会话没有工作区路径，无法派生 Mnemos 分区。',
      'workspace_path_missing',
      '在 DSH 工作区内打开会话；或在「设置 → 插件 → dsh-mnemos-personal」把 partitionMode 改成 fixed 并填写 fixedPartition。',
    )
  }
  // resolve 会补成绝对路径并去掉尾部 `/`（根路径除外），跨平台一致。
  return resolvePath(value)
}

/** 工作区的显示名：路径最后一段（根路径回退为完整路径）。 */
export function workspaceName(input: string): string {
  const normalized = normalizeWorkspacePath(input)
  const name = basename(normalized)
  return name === '' ? normalized : name
}

/** 把任意 basename 清洗成 slug 合法的中间段：小写、非法字符折叠成 `-`、去首尾符号。 */
function slugNameSegment(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[._-]+$/g, '')
  return cleaned === '' ? 'workspace' : cleaned
}

/**
 * 由工作区路径派生稳定的分区 slug。
 *
 * @param input 会话工作区绝对路径。
 * @returns `ws-<basename>-<sha1(path) 前 8 位>`。
 * @throws {WorkspacePathError} 输入为空。
 */
export function workspaceSlug(input: string): string {
  const normalized = normalizeWorkspacePath(input)
  const segment = slugNameSegment(basename(normalized))
  const digest = createHash('sha1').update(normalized).digest('hex').slice(0, 8)
  return `${WORKSPACE_SLUG_PREFIX}${segment}-${digest}`
}

/** 一个分区：slug 是服务端幂等键，name 是展示名。 */
export interface PartitionIdentity {
  slug: string
  name: string
}

/** 会话头（只声明本插件用到的字段）：`cwd` 是创建会话时的原始项目目录，回放稳定。 */
export interface SessionLike {
  /** 会话 id（作为 scope=session 记忆的缺省 session_id）。 */
  id?: string
  header?: {
    /** 创建会话时的绝对工作目录（不可变）。 */
    cwd?: string
  }
}

/** Agent（只声明本插件用到的字段）。 */
export interface AgentLike {
  session?: SessionLike
}

/**
 * 工作目录服务的最小形状（`@deepseek-ai/dsh-working-directory` 的 `ctx.workingDirectory`）。
 * 服务存在时提供「会话当前目录」（用户 cd 过之后的值），否则回落到会话头 cwd。
 */
export interface WorkingDirectoryLike {
  get(session: unknown): string
}

/** 解析会话工作区路径时的环境依赖（手搭测试可完全省略）。 */
export interface WorkspacePathOptions {
  /** 生效中的 `workingDirectory` 服务；没有则只用会话头 cwd。 */
  workingDirectory?: WorkingDirectoryLike
  /** 会话既无 cwd 也无 workingDirectory 服务时的兜底目录（通常是 process.cwd()）。 */
  fallbackDirectory?: string
}

/**
 * 解析出「本会话的工作区」。
 *
 * 优先用会话头 `header.cwd`（原始项目目录，回放稳定，不随 cd 漂移）；
 * 没有时退到 `workingDirectory` 服务的当前目录，最后用调用方给的兜底目录。
 *
 * @param agent 工具执行上下文里的 Agent（可能缺席：PTC 嵌套调用 / 测试）。
 * @param options 可选的服务与兜底目录。
 * @returns 绝对路径字符串；全都拿不到时 `undefined`。
 */
export function resolveAgentWorkspacePath(
  agent: AgentLike | undefined,
  options: WorkspacePathOptions = {},
): string | undefined {
  const session = agent?.session
  const headerCwd = session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd.trim() !== '') return headerCwd

  const service = options.workingDirectory
  if (session !== undefined && service !== undefined && typeof service.get === 'function') {
    try {
      const value = service.get(session)
      if (typeof value === 'string' && value.trim() !== '') return value
    } catch {
      // 服务已 dispose / 目录不可用：继续走兜底，不让提示段与工具因取目录失败而崩溃。
    }
  }
  return options.fallbackDirectory
}

/** 工具执行上下文的最小形状（`execute(args, exec)` 的第二个参数）。 */
export interface ToolRunContextLike {
  agent?: AgentLike
}

/** 工具层用的工作区解析器：每次调用现算，设置 / 会话变化即时生效。 */
export type WorkspacePathResolver = (exec?: ToolRunContextLike) => string | undefined

/** 会话 id（scope=session 记忆缺省使用；拿不到则不缺省）。 */
export function agentSessionId(agent: AgentLike | undefined): string | undefined {
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 推导本次调用使用的分区。
 *
 * - `workspace` 模式：用工作区路径派生 slug，展示名用目录名；
 * - `fixed` 模式：直接用 `fixedPartition`，展示名同 slug。
 *
 * @param mode 配置里的 partitionMode。
 * @param fixedPartition fixed 模式的分区 slug（workspace 模式忽略）。
 * @param workspacePath 当前工作区路径（workspace 模式必填）。
 * @returns 分区 slug 与展示名。
 * @throws {WorkspacePathError} workspace 模式缺路径，或 fixed 模式没填 fixedPartition。
 */
export function resolvePartitionIdentity(
  mode: 'workspace' | 'fixed',
  fixedPartition: string,
  workspacePath: string | undefined,
): PartitionIdentity {
  if (mode === 'fixed') {
    const slug = (fixedPartition ?? '').trim()
    if (slug === '') {
      throw new WorkspacePathError(
        'partitionMode=fixed 但没有配置 fixedPartition。',
        'fixed_partition_missing',
        '在「设置 → 插件 → dsh-mnemos-personal」填写 fixedPartition（分区 slug 或 id），或把 partitionMode 改回 workspace。',
      )
    }
    return { slug, name: slug }
  }
  if (workspacePath === undefined) {
    throw new WorkspacePathError(
      '当前会话没有工作区路径，无法派生 Mnemos 分区。',
      'workspace_path_missing',
      '在 DSH 工作区内打开会话；或把 partitionMode 改成 fixed 并填写 fixedPartition。',
    )
  }
  return { slug: workspaceSlug(workspacePath), name: workspaceName(workspacePath) }
}
