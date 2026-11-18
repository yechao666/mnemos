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
import { MNEMOS_SETTINGS_NAMESPACE, resolveConfig, } from './config.js';
import { MnemosClient } from './mnemos-client.js';
import { createMnemosTools } from './tools.js';
import { resolveAgentWorkspacePath, workspaceSlug, } from './workspace.js';
/** cordis 插件名（与 package.json 的 name、cordis.patch.yml 的行 id 保持一致）。 */
export const name = 'dsh-mnemos-personal';
/** 依赖的服务：工具注册表与系统提示。缺任何一个插件都不会激活。 */
export const inject = ['tools', 'systemPrompt'];
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
/** 提示段在工具指引带里的顺序（越靠后越靠下；与旧插件同档）。 */
const SECTION_ORDER = 155;
/** 系统提示段名（插件内唯一；设置变更时会先撤下再重新挂上）。 */
const SECTION_NAME = 'plugin:dsh-mnemos-personal';
/** `workingDirectory` 服务的最小守卫：只有带 get(session) 的对象才当服务用。 */
function getWorkingDirectoryService(ctx) {
    const service = ctx.get('workingDirectory', false);
    if (service === undefined || service === null || typeof service !== 'object')
        return undefined;
    const candidate = service;
    if (typeof candidate.get !== 'function')
        return undefined;
    return service;
}
/**
 * 面向模型的系统提示说明。
 *
 * 首句是硬绑定信息：本工作区对应的分区 slug + 默认人，便于 Agent 知道「记忆存在哪里、以谁为主体」。
 * 只讲「什么时候用哪个工具」和硬性限制，不复述每个参数 —— 参数在工具 schema 里，重复会白烧 token。
 *
 * @param config 当前解析后的配置。
 * @param workspacePath 当前会话工作区路径（fixed 模式可省略）。
 */
export function buildSystemPromptText(config, workspacePath) {
    let slug;
    if (config.partitionMode === 'fixed') {
        const fixed = (config.fixedPartition ?? '').trim();
        slug = fixed === '' ? '(fixed 模式未配置 fixedPartition)' : fixed;
    }
    else if (workspacePath !== undefined) {
        try {
            slug = workspaceSlug(workspacePath);
        }
        catch {
            slug = '(工作区路径无效)';
        }
    }
    else {
        slug = '(当前会话没有工作区路径)';
    }
    return (`Mnemos 记忆系统（dsh-mnemos-personal）：本工作区已绑定分区 ${slug}，记忆按人组织；默认人 ${config.personId}（type=${config.personType}）。\n` +
        '使用时机：\n' +
        '- 开始任务前先调 mnemos_context 取默认人的上下文（资料 + 简报 + 高相关记忆 + 分区共享知识），返回的 prompt 可直接阅读 / 注入，比逐条检索省 token。\n' +
        '- 想快速了解「关于这个人已知什么」用 mnemos_brief；需要具体旧事 / 约定 / 踩坑记录用 mnemos_search；读一条详情或用游标翻页列表用 mnemos_get（把响应里的 next_cursor 传给 cursor）。\n' +
        '- 想了解「这个人的资料被结构化成了哪些事实」用 mnemos_profile（facts + 摘要，force 可强制重算）；看一条记忆的变更时间线用 mnemos_history（event/actor/old→new）。\n' +
        '- 检索结果有用 / 没用时用 mnemos_feedback 记一次（服务端据此升降 confidence）；需要修正记忆正文 / 重要度 / 标签 / 元数据用 mnemos_update（readOnly 会拦）。\n' +
        '- 得出了值得沉淀的结论、决策、约束、踩坑经验时用 mnemos_add（scope=partition 表示分区共享，同分区其他人也能检索；缺省沿用分区设置）。\n' +
        '- 写记忆遇到隐私值（手机号 / 邮箱 / 身份证 / 银行卡等）时用 placeholders 抽离：真实值放映射，正文只写 {{key}} 占位符（key 为 [A-Za-z0-9_-]{3,64}），例如 text: "手机号是 {{phone_a1b2}}", placeholders: {"phone_a1b2":"18334423321"}；正文只落 token，mnemos_brief / mnemos_context 会由服务端自动还原。\n' +
        '- 换人读写时显式传 person_id（缺省 / self = 默认人）；人不是登录账号，human 是 App 用户 / 员工，agent 是智能体。\n' +
        '- 管理用 mnemos_person（list / get / upsert）；不确定分区或连接状态时用 mnemos_workspace / mnemos_status。\n' +
        '硬性限制：readOnly 模式（设置 → 插件 → dsh-mnemos-personal）会拦截记忆写入与人变更；orgApiKey 不要出现在回复里，也不要写进记忆内容。\n' +
        '鉴权与免密：orgApiKey 留空时是本地免密模式——请求不带 Authorization；此时 Mnemos 需以 MNEMOS_DEV_NO_API_KEY=1 启动，否则返回 401（调 mnemos_status 自检，action 会提示配置 orgApiKey 或开启本地免密）。\n' +
        '用户说「记忆 / 记住 / 搜索记忆 / 人物上下文 / 沉淀经验」时，指的就是本插件，请据此协作。');
}
/**
 * 挂载客户端、工具与提示段。
 *
 * @param ctx 宿主上下文（至少提供 tools 与 systemPrompt）。
 * @param config 原始插件配置：每个 `.volatile()` 字段都是 `Volatile<T>` 引用（不是裸值），
 *   由 `resolveConfig` 解包；手搭的测试上下文也可能直接传裸值。
 */
export function apply(ctx, config) {
    // 配置来源：初始取装配时传入的对象。`.volatile()` 字段是活引用（get() 返回当前值），
    // 因此设置页保存后不需要重新装配，下一次工具调用就能读到新值。
    const current = () => config ?? {};
    const resolve = () => resolveConfig(current());
    // 工作区解析：会话头 cwd（原始项目目录，回放稳定）优先；必要时退到 workingDirectory 服务，
    // 最后用进程启动目录兜底。每次调用现取服务，避免装配顺序影响。
    const resolveWorkspacePath = (exec) => resolveAgentWorkspacePath(exec?.agent, {
        workingDirectory: getWorkingDirectoryService(ctx),
        fallbackDirectory: process.cwd(),
    });
    // 客户端每次请求都读活配置，设置改动即时生效（无需重建客户端或重挂工具）。
    const client = new MnemosClient(resolve);
    const tools = createMnemosTools(client, resolve, resolveWorkspacePath);
    let disposeSection;
    let disposeTools;
    /** 依据当前配置重新注册（或撤下）提示段与工具。 */
    const sync = () => {
        disposeSection?.();
        disposeSection = undefined;
        disposeTools?.();
        disposeTools = undefined;
        const value = resolve();
        if (value.systemPrompt) {
            disposeSection = ctx.systemPrompt.section({
                name: SECTION_NAME,
                order: SECTION_ORDER,
                // 动态求值：按当前会话的工作区算 slug（同一会话内 cwd 不变时文案稳定）。
                text: (context) => buildSystemPromptText(resolve(), resolveWorkspacePath({ agent: context?.agent })),
            });
        }
        disposeTools = ctx.effect(() => {
            const disposers = tools.map((tool) => ctx.tools.register(tool));
            return () => {
                for (const dispose of disposers)
                    dispose();
            };
        }, 'dsh-mnemos-personal: tools');
    };
    // 设置页：dsh 0.2 用「插件行 id 作为命名空间 + 导出 Config」的方式生成自动表单，
    // 插件这边只需要声明页面策略（auto: true）并订阅配置变更事件做 re-sync。
    // `settings` 不在本插件的 inject 列表里（避免无 settings 的宿主启动失败），
    // 所以用 scoped inject + 宽松 get，并整体 try/catch 兜底。
    ctx.inject(['settings'], (sctx) => {
        try {
            // 宽松 get：早期激活时服务可能还没 ACTIVE；未声明在 inject 里的服务也不能用属性访问。
            const settings = sctx.get('settings', false);
            if (settings === undefined || typeof settings.configure !== 'function')
                return;
            // 必须显式传插件自己的 fiber：configure 的 owner 默认是 settings 服务自己的 fiber，
            // 省略会把页面策略挂错，`describe()` 按 entry.fiber 查不到。
            const configure = settings.configure.bind(settings);
            sctx.effect(() => configure({ auto: true }, ctx.fiber), 'dsh-mnemos-personal: settings form');
            sctx.effect(() => sctx.on('settings/document-updated', (namespace) => {
                // 只对属于自己的命名空间 re-sync；别的插件的保存不改我们的工具。
                if (String(namespace) === MNEMOS_SETTINGS_NAMESPACE)
                    sync();
            }), 'dsh-mnemos-personal: settings subscription');
        }
        catch {
            // 没有 settings 服务（headless / CLI 挂载）：工具与提示段照常工作，只是没有设置页。
        }
    });
    // 初始注册：覆盖没有 settings 服务、也就不会有 document-updated 事件的部署。
    sync();
}
