/**
 * 本地最小化的 DSH 宿主类型声明。
 *
 * 为什么不用 `@deepseek-ai/cordis` / `dsh-tools` / `dsh-system-prompt` / `dsh-llm`：
 * 这几个包都随 harness 的 bundle 行一起下发，一旦声明成依赖就会被 hoist 进 profile，
 * 遮蔽 harness 自带的副本；两份模块 = 两个模块级 Symbol（如 TOOL_RUNTIME_SCHEDULER），
 * 每次工具调用都会报 "Cannot read properties of undefined (reading 'prepare')"
 * （参考 dsh-mem0 的 AGENTS.md「可安装性规则」）。本文件只声明插件真正用到的形状，
 * 全部是 `import type`，零运行时成本、零依赖冲突。
 */

/** 一段文本内容块（本插件的工具只产出文本）。 */
export interface ContentBlock {
  type: 'text'
  text: string
}

/**
 * JSON Schema 节点。dsh-tools 接受原始 JSON Schema（等价于它自己 DSL 编译出来的结果），
 * 因此工具定义里直接手写对象即可，不需要运行时导入。
 */
export type JsonSchemaNode = { readonly [key: string]: unknown }

/** 工具定义：与 `ctx.tools.register(def)` 的入参同构。 */
export interface ToolDefinition<Args = any, Result = any> {
  name: string
  description: string
  parameters: JsonSchemaNode
  output: {
    schema: JsonSchemaNode
    render(args: Args, value: Result): ContentBlock[]
  }
  execute(args: Args): Promise<Result>
}

/** 工具服务：注册成功后返回释放函数。 */
export interface ToolsService {
  register(definition: ToolDefinition<any, any>): () => void
}

/** 系统提示服务：插入一段面向模型的说明。 */
export interface SystemPromptService {
  section(options: { name: string; order?: number; text: string }): () => void
}

/**
 * settings 服务（dsh 0.2+）。`configure` 把本插件的设置页策略挂到指定 fiber：
 * `{ auto: true }` 表示由 SettingsForms 依据导出的 `Config` 自动生成表单。
 * 方法可选 —— 更老/更瘦的宿主里可能整块没有。
 */
export interface SettingsService {
  configure?(policy: { auto?: boolean }, owner?: unknown): () => void
}

/** 注入作用域内的上下文（服务已 ACTIVE，但仍用宽松 get 兜底）。 */
export interface ScopedContext extends Context {
  get(name: string, strict?: boolean): unknown
}

/** 宿主插件上下文：只声明本插件用到的部分。 */
export interface Context {
  tools: ToolsService
  systemPrompt: SystemPromptService
  /** 插件自己的 fiber（settings.configure 的 owner 必须显式传它）。 */
  fiber: unknown
  /** 取服务；`strict=false` 时服务缺席返回 undefined 而不是抛错。 */
  get(name: string, strict?: boolean): unknown
  /** 监听宿主事件，返回取消订阅函数。 */
  on(event: string, listener: (...args: any[]) => void): () => void
  /** 可逆副作用：回调返回释放函数，插件卸载时自动执行。 */
  effect(fn: () => (() => void) | void, label?: string): () => void
  /** 等服务就绪后再执行回调（服务缺席则永不执行）。 */
  inject(names: readonly string[], callback: (ctx: ScopedContext) => void): () => void
}
