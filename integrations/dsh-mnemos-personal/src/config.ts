/**
 * 插件配置：设置页自动表单的表单源（schemastery `Config`），以及工具 / REST 客户端
 * 每次调用时解析出的运行时配置。
 *
 * 配置本身由 dsh 的 settings 提供者持久化，插件不需要自己写存储文件。
 *
 * Mnemos v6 只认「分区 + 人」两个键（契约：docs/v6-architecture.md）：
 * - 分区由 `partitionMode` 决定：`workspace`（默认，DSH 会话工作区规范化成 slug）或 `fixed`；
 * - 人由 `personId` / `personType` 决定，默认 `dsh-agent`（type=agent）。
 */

import z from '@deepseek-ai/schemastery'

/**
 * 设置命名空间：必须与插件行的 `id`（cordis.patch.yml）一致。
 * dsh 0.2 起命名空间就是插件行的 id，不再有 branded 构造函数。
 */
export const MNEMOS_SETTINGS_NAMESPACE = 'dsh-mnemos-personal'

/** 分区来源：按工作区自动派生，或固定用 `fixedPartition`。 */
export type PartitionMode = 'workspace' | 'fixed'

/** 人的类型（与服务端 persons.type 对齐；`other` 保留给服务端，工具侧不暴露）。 */
export type PersonType = 'human' | 'agent' | 'service'

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
  /** 组织级 API Key（`mnemos_live_*` 的 org key）：可访问/创建本组织任意分区；留空 = 本地免密（请求不带 Authorization）。 */
  orgApiKey: string
  /** 默认人（记忆主体）的 external_id；工具可显式传 person_id 读写其他人。 */
  personId: string
  /** 默认人的类型（human | agent | service）。 */
  personType: PersonType
  /** 分区来源：workspace（按工作区自动派生）| fixed（固定 fixedPartition）。 */
  partitionMode: PartitionMode
  /** fixed 模式下的分区 slug（或分区 id）；workspace 模式忽略。 */
  fixedPartition: string
  /** 只读模式：拦截记忆写入与人变更。 */
  readOnly: boolean
  /** 是否向 Agent 注入系统提示说明（含本工作区绑定的分区 slug 与默认人）。 */
  systemPrompt: boolean
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
  // 可留空：本地免密模式（请求不带 Authorization，服务端以 MNEMOS_DEV_NO_API_KEY=1 启动）。
  orgApiKey: z
    .string()
    .role('secret')
    .default('')
    .description(
      '可留空（本地免密）：留空时请求不带 Authorization，需本地以 MNEMOS_DEV_NO_API_KEY=1 启动 Mnemos；' +
        '填写时用控制台「密钥」创建的 kind=org Key（自动建分区需要 admin）。',
    )
    .volatile(),
  personId: z.string().default('dsh-agent').volatile(),
  personType: z
    .union([z.const('human'), z.const('agent'), z.const('service')])
    .default('agent')
    .volatile(),
  partitionMode: z
    .union([z.const('workspace'), z.const('fixed')])
    .default('workspace')
    .volatile(),
  fixedPartition: z.string().default('').volatile(),
  readOnly: z.boolean().default(false).volatile(),
  systemPrompt: z.boolean().default(true).volatile(),
})

/** 默认值（手搭测试上下文时使用；正常装配由 settings 提供者填）。 */
export const DEFAULT_CONFIG: MnemosConfig = {
  baseUrl: 'http://127.0.0.1:4380',
  orgApiKey: '',
  personId: 'dsh-agent',
  personType: 'agent',
  partitionMode: 'workspace',
  fixedPartition: '',
  readOnly: false,
  systemPrompt: true,
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

/** 归一化：解包 volatile 引用，缺省值回落默认，枚举值非法时也回落默认。 */
export function resolveConfig(input: RawMnemosConfig | undefined): MnemosConfig {
  const value = (input ?? {}) as RawMnemosConfig
  const personType = unwrap(value.personType)
  const partitionMode = unwrap(value.partitionMode)
  return {
    baseUrl: unwrap(value.baseUrl) ?? DEFAULT_CONFIG.baseUrl,
    orgApiKey: unwrap(value.orgApiKey) ?? DEFAULT_CONFIG.orgApiKey,
    personId: unwrap(value.personId) ?? DEFAULT_CONFIG.personId,
    personType:
      personType === 'human' || personType === 'agent' || personType === 'service'
        ? personType
        : DEFAULT_CONFIG.personType,
    partitionMode: partitionMode === 'fixed' ? 'fixed' : 'workspace',
    fixedPartition: unwrap(value.fixedPartition) ?? DEFAULT_CONFIG.fixedPartition,
    readOnly: unwrap(value.readOnly) ?? DEFAULT_CONFIG.readOnly,
    systemPrompt: unwrap(value.systemPrompt) ?? DEFAULT_CONFIG.systemPrompt,
  }
}
