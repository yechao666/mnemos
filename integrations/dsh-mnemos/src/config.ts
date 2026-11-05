/**
 * 插件配置：设置页自动表单的表单源（schemastery `Config`），以及工具 / REST 客户端
 * 每次调用时解析出的运行时配置。
 *
 * 配置本身由 dsh 的 settings 提供者持久化，插件不需要自己写存储文件。
 */

import z from '@deepseek-ai/schemastery'

/**
 * 设置命名空间：必须与插件行的 `id`（cordis.patch.yml）一致。
 * dsh 0.2 起命名空间就是插件行的 id，不再有 branded 构造函数。
 */
export const MNEMOS_SETTINGS_NAMESPACE = 'dsh-mnemos'

/**
 * 解析后的运行时配置（裸值、默认值已填好）。
 *
 * 注意与 `RawMnemosConfig` 的区别：`apply(ctx, config)` 实收的对象里，每个
 * `.volatile()` 字段都是 `Volatile<T>` 引用（`{ get() }`），不是裸值。
 * 两者必须分开建模，否则 `tsc` 抓不到「把引用当字符串用」这类错误。
 */
export interface MnemosConfig {
  /** Mnemos 服务地址（不带尾斜杠，不带 /v1）。 */
  baseUrl: string
  /** Mnemos API Key（`mnemos_live_*`），绑定项目。 */
  apiKey: string
  /** 写入 / 任务简报默认使用的 Agent 身份。 */
  defaultAgentId: string
  /** 可选默认 user_id；留空表示写入时不带用户标识。 */
  defaultUserId: string
  /** 可选默认 task_id；任务简报未显式指定时使用。 */
  defaultTaskId: string
  /** 检索默认条数。 */
  defaultTopK: number
  /** 只读模式：拦截写入 / 任务变更 / Agent 注册 / 删除。 */
  readOnly: boolean
  /** 是否向 Agent 注入系统提示说明。 */
  announceToAgent: boolean
  /** 总开关：关闭后不注册任何工具与提示段。 */
  enabled: boolean
  /** 单次 HTTP 请求超时（毫秒）。 */
  timeoutMs: number
}

/**
 * schemastery schema：dsh 0.2 的 SettingsForms 直接读 `fiber.runtime.Config` 生成表单，
 * 只有标了 `.volatile()` 的字段才会进入表单（并可热更新，无需重挂插件）。
 *
 * 不给 `z<MnemosConfig>` 标注：`.volatile()` 会把字段输出类型拓宽成 `Volatile<T>`，
 * 无法满足 `MnemosConfig`；由 `resolveConfig` 负责归一化。
 */
export const Config = z.object({
  // `.volatile()`：字段可热更新，且只有它会被投影到设置表单。
  baseUrl: z.string().default('http://127.0.0.1:4380').volatile(),
  // `role('secret')`：走脱敏通道，密钥字面量不下发浏览器、不进日志。
  apiKey: z.string().role('secret').default('').volatile(),
  defaultAgentId: z.string().default('dsh-agent').volatile(),
  defaultUserId: z.string().default('').volatile(),
  defaultTaskId: z.string().default('').volatile(),
  defaultTopK: z.number().default(8).volatile(),
  readOnly: z.boolean().default(false).volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
  enabled: z.boolean().default(true).volatile(),
  timeoutMs: z.number().default(15000).volatile(),
})

/** 默认值（手搭测试上下文时使用；正常装配由 settings 提供者填）。 */
export const DEFAULT_CONFIG: MnemosConfig = {
  baseUrl: 'http://127.0.0.1:4380',
  apiKey: '',
  defaultAgentId: 'dsh-agent',
  defaultUserId: '',
  defaultTaskId: '',
  defaultTopK: 8,
  readOnly: false,
  announceToAgent: true,
  enabled: true,
  timeoutMs: 15000,
}

/** schemastery `Volatile<T>` 的结构替身（该类型定义在 cosmokit，属 harness bundle 行，不能依赖）。 */
interface VolatileLike<T> {
  get(): T
}

/**
 * `apply` 实收的配置形状：每个字段可能是裸值，也可能是 `Volatile` 引用。
 * 手搭的测试上下文传裸值，正常装配传引用 —— 两种都得能跑。
 */
export type RawMnemosConfig = {
  [K in keyof MnemosConfig]?: MnemosConfig[K] | VolatileLike<MnemosConfig[K]>
}

/**
 * 解包一个 volatile 字段。
 *
 * `.volatile()` 字段不会把裸值交给 `apply`，而是一个稳定的引用对象，必须 `.get()`；
 * 直接当字符串/数字用会在每次工具调用时抛 "xxx is not a function"，
 * 而插件加载、设置页、冒烟测试全都正常，极难定位（dsh-mem0 的踩坑记录）。
 * 裸值原样透传。
 */
function unwrap<T>(field: T | VolatileLike<T> | undefined): T | undefined {
  if (field === undefined || field === null) return undefined
  const ref = field as VolatileLike<T>
  if (typeof ref.get === 'function') {
    const value = ref.get()
    return value === null ? undefined : value
  }
  return field as T
}

/** 归一化：解包 volatile 引用，缺省值回落默认。 */
export function resolveConfig(input: RawMnemosConfig | undefined): MnemosConfig {
  const value = (input ?? {}) as RawMnemosConfig
  return {
    baseUrl: unwrap(value.baseUrl) ?? DEFAULT_CONFIG.baseUrl,
    apiKey: unwrap(value.apiKey) ?? DEFAULT_CONFIG.apiKey,
    defaultAgentId: unwrap(value.defaultAgentId) ?? DEFAULT_CONFIG.defaultAgentId,
    defaultUserId: unwrap(value.defaultUserId) ?? DEFAULT_CONFIG.defaultUserId,
    defaultTaskId: unwrap(value.defaultTaskId) ?? DEFAULT_CONFIG.defaultTaskId,
    defaultTopK: unwrap(value.defaultTopK) ?? DEFAULT_CONFIG.defaultTopK,
    readOnly: unwrap(value.readOnly) ?? DEFAULT_CONFIG.readOnly,
    announceToAgent: unwrap(value.announceToAgent) ?? DEFAULT_CONFIG.announceToAgent,
    enabled: unwrap(value.enabled) ?? DEFAULT_CONFIG.enabled,
    timeoutMs: unwrap(value.timeoutMs) ?? DEFAULT_CONFIG.timeoutMs,
  }
}
