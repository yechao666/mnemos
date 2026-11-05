/**
 * dsh-mnemos：把 Mnemos 记忆系统接入 dsh 的宿主侧 cordis 插件。
 *
 * 做三件事：
 * 1. 注册 10 个 `mnemos_*` Agent 工具（读写本机 Mnemos 的 `/v1` REST 接口）；
 * 2. 在系统提示里插一段说明，告诉 Agent 什么时候该用简报 / 检索 / 写入 / 任务；
 * 3. 把配置页挂进 dsh 设置（导出 `Config` + `.volatile()` 字段，dsh 自动生成表单）。
 *
 * 只有主机半边（没有 `dsh.client` 声明）：本插件不需要自定义浏览器 UI。
 * 不改 dsh 源码，通过 `dsh plugin --profile <name> add link:<path>` 热插拔。
 */

import type { Context, SettingsService } from './dsh-types.js'
import { Config, MNEMOS_SETTINGS_NAMESPACE, resolveConfig, type MnemosConfig, type RawMnemosConfig } from './config.js'
import { MnemosClient } from './mnemos-client.js'
import { createMnemosTools } from './tools.js'

/** cordis 插件名（与 package.json 的 name、cordis.patch.yml 的行 id 保持一致）。 */
export const name = 'dsh-mnemos'

/** 依赖的服务：工具注册表与系统提示。缺任何一个插件都不会激活。 */
export const inject = ['tools', 'systemPrompt']

/**
 * 设置命名空间：dsh 0.2 起它等于插件行的 id，
 * 也是 `settings/document-updated` 事件里用于识别的字符串。
 */
export { MNEMOS_SETTINGS_NAMESPACE } from './config.js'

/**
 * 配置 schema。dsh 0.2 的 SettingsForms 直接读 `fiber.runtime.Config` 生成设置表单，
 * 所以必须从这里导出；`.volatile()` 字段才会出现在面板里。
 */
export { Config } from './config.js'

/** 提示段在工具指引带里的顺序（越靠后越靠下）。 */
const SECTION_ORDER = 155

/**
 * 面向模型的系统提示说明（中文）。
 *
 * 只讲「什么时候用哪个工具」和硬性限制，不复述每个参数 —— 参数在工具 schema 里，
 * 重复会白烧 token。
 */
export const MNEMOS_GUIDANCE =
  '本机已接入 Mnemos 记忆系统（dsh-mnemos 插件）：项目级共享记忆 + 任务会话，数据按项目隔离，项目由 API Key 决定。\n' +
  '使用时机：\n' +
  '- 开始一个任务前，先调 mnemos_context 取任务简报（项目背景 / 规范约束 / 历史决策 / 相关经验 / 事故记录 / 进行中任务），' +
  '返回的 prompt 是可直接阅读的中文 Markdown；这比逐条检索更省 token。\n' +
  '- 需要「以前怎么做的 / 有没有踩过坑 / 相关约定」时，用 mnemos_search 做混合检索；agent_id 传自己的 Agent 身份，' +
  '即可同时看到项目共享记忆与自己的私有记忆。\n' +
  '- 得出了值得沉淀的结论、决策、约束或踩坑经验时，用 mnemos_add 写入（默认原文入库；visibility 默认 project 表示项目共享）。\n' +
  '- 开始 / 结束任务用 mnemos_task：start 建任务会话（拿到 task_id 后可关联写入），' +
  'finish 会把 decisions / lessons / notes 自动写成项目共享记忆，是团队经验沉淀的主入口。\n' +
  '- 管理用 mnemos_get / mnemos_history / mnemos_update / mnemos_delete，健康检查用 mnemos_status。\n' +
  '硬性限制：删除必须先展示目标记忆并取得用户确认，再用 confirm: true 调用；' +
  'readOnly 模式（设置 → 插件 → dsh-mnemos）会拦截写入 / 任务变更 / Agent 注册 / 删除；' +
  'apiKey 不要出现在回复里，也不要写进记忆内容。\n' +
  '用户说「记忆 / 记住 / 搜索记忆 / 任务简报 / 沉淀经验」时，指的就是本插件，请据此协作。'

/**
 * 挂载客户端、工具与提示段。
 *
 * @param ctx 宿主上下文（至少提供 tools 与 systemPrompt）。
 * @param config 原始插件配置：每个 `.volatile()` 字段都是 `Volatile<T>` 引用（不是裸值），
 *   由 `resolveConfig` 解包；手搭的测试上下文也可能直接传裸值。
 */
export function apply(ctx: Context, config?: RawMnemosConfig): void {
  // 配置来源：初始取装配时传入的对象。`.volatile()` 字段是活引用（get() 返回当前值），
  // 因此设置页保存后不需要重新装配，下一次工具调用就能读到新值。
  const current = (): RawMnemosConfig => config ?? {}
  const resolve = (): MnemosConfig => resolveConfig(current())

  // 客户端每次请求都读活配置，设置改动即时生效（无需重建客户端或重挂工具）。
  const client = new MnemosClient(resolve)
  const tools = createMnemosTools(client, resolve)

  let disposeSection: (() => void) | undefined
  let disposeTools: (() => void) | undefined

  /** 依据当前配置重新注册（或撤下）提示段与工具。 */
  const sync = (): void => {
    disposeSection?.()
    disposeSection = undefined
    disposeTools?.()
    disposeTools = undefined

    const value = resolve()
    if (!value.enabled) return

    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-mnemos',
        order: SECTION_ORDER,
        text: MNEMOS_GUIDANCE,
      })
    }

    disposeTools = ctx.effect(() => {
      const disposers = tools.map((tool) => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-mnemos: tools')
  }

  // 设置页：dsh 0.2 用「插件行 id 作为命名空间 + 导出 Config」的方式生成自动表单，
  // 插件这边只需要声明页面策略（auto: true）并订阅配置变更事件做 re-sync。
  // `settings` 不在本插件的 inject 列表里（避免无 settings 的宿主启动失败），
  // 所以用 scoped inject + 宽松 get，并整体 try/catch 兜底。
  ctx.inject(['settings'], (sctx) => {
    try {
      // 宽松 get：早期激活时服务可能还没 ACTIVE；未声明在 inject 里的服务也不能用属性访问。
      const settings = sctx.get('settings', false) as Partial<SettingsService> | undefined
      if (settings === undefined || typeof settings.configure !== 'function') return
      // 必须显式传插件自己的 fiber：configure 的 owner 默认是 settings 服务自己的 fiber，
      // 省略会把页面策略挂错，`describe()` 按 entry.fiber 查不到。
      const configure = settings.configure.bind(settings)
      sctx.effect(() => configure({ auto: true }, ctx.fiber), 'dsh-mnemos: settings form')
      sctx.effect(
        () =>
          sctx.on('settings/document-updated', (namespace: unknown) => {
            // 只对属于自己的命名空间 re-sync；别的插件的保存不改我们的工具。
            if (String(namespace) === MNEMOS_SETTINGS_NAMESPACE) sync()
          }),
        'dsh-mnemos: settings subscription',
      )
    } catch {
      // 没有 settings 服务（headless / CLI 挂载）：工具与提示段照常工作，只是没有设置页。
    }
  })

  // 初始注册：覆盖没有 settings 服务、也就不会有 document-updated 事件的部署。
  sync()
}
