/**
 * dsh-mnemos-personal：把 Mnemos v6（中立记忆服务）接入 dsh 的宿主侧 cordis 插件。
 *
 * 做四件事：
 * 1. 注册 12 个 `mnemos_*` Agent 工具（分区 = 工作区、记忆按人组织，写 `/v1/partitions/:p/...`，
 *    人 / 记忆列表用 v6 游标分页；含画像 / 历史 / 反馈 / 更新）；
 * 2. 在系统提示里插一段说明，告诉 Agent「本工作区已绑定分区 <slug>，记忆按人组织；默认人 <personId>」；
 * 3. 把配置页挂进 dsh 设置（导出 `Config` + `.volatile()` 字段，dsh 自动生成表单）；
 * 4. 每次调用现读活配置 / 现算工作区，设置与会话变化即时生效。
 *
 * 只有主机半边（没有 `dsh.client` 声明）：本插件不需要自定义浏览器 UI。
 * 不改 dsh 源码，通过 `dsh plugin --profile <name> add link:<path>` 热插拔。
 * 旧插件 `integrations/dsh-mnemos`（项目级共享记忆 + 任务）保持不动，两者可同时安装。
 */
import type { Context } from './dsh-types.js';
import { type MnemosConfig, type RawMnemosConfig } from './config.js';
/** cordis 插件名（与 package.json 的 name、cordis.patch.yml 的行 id 保持一致）。 */
export declare const name = "dsh-mnemos-personal";
/** 依赖的服务：工具注册表与系统提示。缺任何一个插件都不会激活。 */
export declare const inject: string[];
/**
 * 设置命名空间：dsh 0.2 起它等于插件行的 id，
 * 也是 `settings/document-updated` 事件里用于识别的字符串。
 */
export { MNEMOS_SETTINGS_NAMESPACE } from './config.js';
/**
 * 配置 schema。dsh 0.2 的 SettingsForms 直接读 `fiber.runtime.Config` 生成设置表单，
 * 所以必须从这里导出；`.volatile()` 字段才会出现在面板里。
 */
export { Config } from './config.js';
/**
 * 面向模型的系统提示说明。
 *
 * 首句是硬绑定信息：本工作区对应的分区 slug + 默认人，便于 Agent 知道「记忆存在哪里、以谁为主体」。
 * 只讲「什么时候用哪个工具」和硬性限制，不复述每个参数 —— 参数在工具 schema 里，重复会白烧 token。
 *
 * @param config 当前解析后的配置。
 * @param workspacePath 当前会话工作区路径（fixed 模式可省略）。
 */
export declare function buildSystemPromptText(config: MnemosConfig, workspacePath: string | undefined): string;
/**
 * 挂载客户端、工具与提示段。
 *
 * @param ctx 宿主上下文（至少提供 tools 与 systemPrompt）。
 * @param config 原始插件配置：每个 `.volatile()` 字段都是 `Volatile<T>` 引用（不是裸值），
 *   由 `resolveConfig` 解包；手搭的测试上下文也可能直接传裸值。
 */
export declare function apply(ctx: Context, config?: RawMnemosConfig): void;
