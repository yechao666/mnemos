# dsh-mnemos

把本仓库的 **Mnemos 记忆系统**接入 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)：给 Agent 装上
「项目级共享记忆 + 任务会话」的读写工具，并在 dsh 设置页生成配置表单。

- **host-only**：没有浏览器半端，设置页用 dsh 的自动表单（导出 `Config` + `.volatile()` 字段）。
- **10 个 Agent 工具**：检索、写入、任务简报、任务会话、记忆管理、Agent 注册表、自检。
- **零 harness 依赖**：运行时只依赖 `@deepseek-ai/schemastery`（表单 schema），不 import `cordis` / `dsh-tools` / `dsh-system-prompt` / `dsh-llm`。
- **热插拔**：`dsh plugin --profile <name> add link:<本目录>`，不改 dsh 源码。

---

## 1. 功能

| 能力 | 说明 |
| --- | --- |
| 记忆检索 | `mnemos_search`：语义 + 关键词 + 实体 + 时效 + 重要度混合打分，带逐信号分数 |
| 记忆写入 | `mnemos_add`：默认原文入库；`infer=true` 走事实抽取；`visibility` 控制项目共享 / Agent 私有 / 任务内 |
| **任务简报** | `mnemos_context`：开始任务时一次拿到项目背景、规范约束、历史决策、相关经验、事故记录、私有笔记、进行中任务，返回可直接阅读的中文 Markdown |
| 任务会话 | `mnemos_task`：`start` 建档 → `finish` 结束，`decisions / lessons / notes` 自动写成项目共享记忆并关联任务 |
| 记忆管理 | `mnemos_get` / `mnemos_update` / `mnemos_delete` / `mnemos_history` |
| Agent 注册表 | `mnemos_agent`：列出项目内 Agent、注册新 Agent |
| 自检 | `mnemos_status`：服务可达性、baseUrl、apiKey 是否配置、项目统计（需 admin 作用域） |
| 只读模式 | `readOnly=true` 时拦截写入 / 任务变更 / Agent 注册 / 删除 |
| 系统提示 | 默认向 Agent 注入一段中文使用说明（可关） |

### 工具清单

| 工具 | 作用 | 关键参数 | 会写入？ |
| --- | --- | --- | --- |
| `mnemos_search` | 混合检索项目记忆 | `query`、`top_k`、`threshold`、`user_id`、`agent_id`、`task_id`、`visibility`、`category` | 否 |
| `mnemos_add` | 写入记忆 | `messages` 或 `text`、`user_id`、`agent_id`、`task_id`、`visibility`、`infer`、`mode`、`tags`、`metadata` | 是 |
| `mnemos_context` | 任务简报（核心） | `agent_id`、`task_id`、`query`、`budget_tokens` | 否 |
| `mnemos_task` | 任务 `start` / `finish` / `list` / `get` | `task_id`、`title`、`status`、`decisions[]`、`lessons[]`、`notes[]` | start / finish 是 |
| `mnemos_get` | 按 id 读详情，或分页列表 | `id`、`user_id`、`agent_id`、`task_id`、`category`、`status`、`page`、`page_size`、`sort` | 否 |
| `mnemos_update` | 更新正文 / 分类 / 重要度 | `id`、`content`、`category`、`importance`（`status`/`tags`/`metadata` 当前服务端忽略） | 是 |
| `mnemos_delete` | 删除（软删除） | `id`、`confirm`（必须 `true`） | 是 |
| `mnemos_history` | 记忆变更历史 | `id` | 否 |
| `mnemos_agent` | `list` / `register` | `action`、`name`、`role`、`model`、`capabilities` | register 是 |
| `mnemos_status` | 连接与配置自检 | 无 | 否 |

> 所有工具的 `execute()` 都不抛异常：失败返回 `{ ok: false, error }`，错误信息里带下一步动作
> （检查 Key / 作用域、注册 Agent、放宽 threshold 等）。

---

## 2. 安装

### 2.1 先构建（link 挂载加载的是 `lib/`）

```bash
cd /Volumes/wd2025/devel/aiworker/mnemos/integrations/dsh-mnemos
pnpm install --ignore-workspace   # 独立安装：本目录不在仓库根 pnpm-workspace 里
pnpm build                        # 产出 lib/ + 类型检查
```

> 为什么要 `--ignore-workspace`：仓库根的 `pnpm-workspace.yaml` 只包含 `server` / `web`，
> 直接 `pnpm install` 会被识别成「根 workspace 的安装」，本包依赖不会落地。
> `--ignore-workspace` 会让它生成自己的 `node_modules/` 与 `pnpm-lock.yaml`，不接管根 workspace。

### 2.2 挂到 dsh

```bash
dsh plugin --profile desktop add link:/Volumes/wd2025/devel/aiworker/mnemos/integrations/dsh-mnemos
# 重启 DSH，然后：设置 → 插件 → dsh-mnemos 行 → 配置
#   填 baseUrl（默认 http://127.0.0.1:4380）与 apiKey（mnemos_live_*）
```

- `link:` **不复制源码**：profile 里只记录一个指向本目录的链接，加载的是 `lib/`。
  所以改了 `src/**` 之后必须重新 `pnpm build`，并且**重启 DSH**（宿主代码在启动时加载）。
- 用你实际在跑的那个 profile —— 桌面 GUI 跑的是 `desktop`。
- 卸载：`dsh plugin --profile desktop remove dsh-mnemos`。

### 2.3 从 npm / git 安装（发布后）

```bash
# npm（需要已发布）
dsh plugin --profile desktop add dsh-mnemos@0.1.0

# git（仓库里必须已提交 lib/，或提供 prepare 构建脚本）
dsh plugin --profile desktop add github:<org>/<repo>#v0.1.0
```

`package.json` 里已声明 `dsh.bundle.patch` → `cordis.patch.yml`，安装时会把插件行
（`id: dsh-mnemos`）插入 profile 清单。

---

## 3. 配置项

设置页由 dsh 自动表单生成（`src/config.ts` 的 `Config`，全部字段 `.volatile()`，改完即时生效）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:4380` | Mnemos 服务地址（不带 `/v1`） |
| `apiKey` | `''` | Mnemos API Key（`mnemos_live_*`），标记为 secret：设置页只显示「已配置 / 未配置」 |
| `defaultAgentId` | `dsh-agent` | 写入 / 简报 / 任务默认使用的 Agent 身份 |
| `defaultUserId` | `''` | 可选默认 user_id；留空表示写入不带用户标识 |
| `defaultTaskId` | `''` | 可选默认 task_id；简报未显式指定任务时使用 |
| `defaultTopK` | `8` | 检索默认条数（服务端上限 50） |
| `readOnly` | `false` | 只读模式：拦截写入 / 任务 `start`·`finish` / Agent 注册 / 删除 |
| `announceToAgent` | `true` | 是否向 Agent 注入系统提示说明 |
| `enabled` | `true` | 总开关：关闭后不注册任何工具与提示段 |
| `timeoutMs` | `15000` | 单次请求超时（毫秒） |

> **`defaultAgentId` 必须是项目里已注册的 Agent id。** Mnemos 的任务简报会校验 Agent 是否存在，
> 传入未注册的 id 会返回 `404 Agent 不存在`。首次接入建议：
> 先 `mnemos_agent action=list` 看项目里有哪些 Agent，把 `defaultAgentId` 设成其中一个
> （形如 `prj_orion_python__agent-coder`），或用 `action=register` 注册一个。
> 不想绑定 Agent 时可把 `defaultAgentId` 留空（简报会退化为「项目共享视角」）。

### 获取 Mnemos API Key

1. 打开 Mnemos 控制台 → 进入项目 → **密钥** → 创建密钥（明文只展示一次）。
2. 作用域按需勾选：
   - `memories:read` —— 搜索、列表、详情、历史（只读 Agent 必备）
   - `memories:write` —— 写入、更新、删除、任务、Agent 注册
   - `admin` —— 仅 `/v1/stats` 需要；**日常 Agent 工具不建议用 admin key**
3. 填进插件设置的 `apiKey`。密钥绑定项目：换项目 = 换 Key（或再装一个插件行）。

演示环境（`seed` 生成，勿用于生产）：项目 `orion-python` 的 Key 是
`mnemos_live_demo_orion_python`。

---

## 4. 示例对话

**记住一件事**

> 用户：记住：发布前必须跑全量测试，线上回滚只走 `deploy/rollback.sh`。
>
> Agent：调用 `mnemos_add`（`messages` 或 `text`，`visibility=project`）→ 返回新增记忆的 id 与内容。

**找经验**

> 用户：我们之前订单查询是怎么拆的？
>
> Agent：调用 `mnemos_search`（`query="订单查询拆分"`，`agent_id=<自己的 Agent>`）→ 逐条返回分数、
> 分类、可见性、归属与 id，再据此回答。

**任务简报（开始任务时）**

> 用户：开始一个新任务：给订单服务接入链路追踪。
>
> Agent：先 `mnemos_context`（`task_id` 或 `query`）拿到项目简报，再 `mnemos_task action=start title="…"`
> 建任务会话；干完后 `mnemos_task action=finish` 把 `decisions` / `lessons` / `notes` 沉淀成项目记忆。

**改一条记忆**

> Agent：`mnemos_get id=mem_xxx` 展示目标 → `mnemos_update`（服务端当前只应用 `content` / `category` / `importance`）。

**删除一条记忆**

> Agent：先用 `mnemos_get` 把目标内容完整展示给用户，用户确认后再
> `mnemos_delete id=mem_xxx confirm=true`（软删除，会写历史）。

---

## 5. 安全与限制

- **`readOnly` 是硬开关**：写入 / `task start`·`finish` / `agent register` / 删除全部在插件侧短路，
  连网络请求都不会发。给「只读巡检 Agent」配 `readOnly=true` 很划算。
- **删除必须显式确认**：`mnemos_delete` 要求 `confirm: true`；Agent 的系统提示里也写明了
  「先展示目标，再执行」。删除是**软删除**（`status=deleted` + 写历史），不会物理抹除。
- **密钥不落日志、不进回复**：`apiKey` 标了 `role('secret')`，设置页只回「已配置/未配置」；
  `mnemos_status` 也只输出 `apiKey 已配置 / 未配置`，不会打印密钥字面量。
- **不要用 admin key 做日常 Agent 工具**：`admin` 只影响 `/v1/stats`；日常读写给
  `memories:read` + `memories:write` 就够了，泄露面更小。
- **项目隔离由 Key 决定**：请求里不传 `project_id`，Mnemos 按 Key 归属项目。跨项目 = 换 Key。
- **`/v1` 更新接口的能力边界**：`mnemos_update` 只应用 `content` / `category` / `importance`；
  `status` / `tags` / `metadata` 当前会被服务端忽略，返回值里的 `ignored` 会标出来（不要用它归档记忆）。
- **`tags` 写入同样受版本限制**：老版本 `/v1` 写入会忽略 `tags`，需要标签时可先写进 `metadata`。
- **检索需要范围**：`mnemos_search` 必须落在某个作用域（不传 `agent_id` 时只看项目共享记忆），
  服务端不做「全局无范围搜索」。
- **不包含的能力**：HMAC webhook 订阅、控制台 `/api/*`、图谱接口、批量删除 —— 本插件只做 Agent 日常读写。
- **超时与重试**：读路径（GET / search / context）在「网络错误 / 503 / 504」时自动重试 1 次（200ms）；
  写操作一律不重试，避免重复写入。

---

## 6. 与 dsh-mem0 的差异

| 维度 | dsh-mem0 | dsh-mnemos |
| --- | --- | --- |
| 服务 | 自托管 mem0 OSS（`/memories`、`X-API-Key`） | Mnemos（`/v1/*`、`Authorization: Bearer`、项目由 Key 决定） |
| 多项目 | 靠 `user_id` / `agent_id` 区分 | **项目级隔离**，一个 Key 一个项目；组织/项目/成员在控制台 |
| 检索 | 向量语义检索 | **混合检索**：语义 + 关键词 + 实体 + 时效 + 重要度，返回逐信号分数 |
| 任务简报 | 无 | **`mnemos_context`**：一次生成可拼进 system prompt 的中文简报 |
| 任务会话 | 无 | **`mnemos_task`**：`finish` 自动把决策/教训/备注沉淀为项目共享记忆 |
| 记忆模型 | `memory` 文本 + metadata | 内容 + 分类 + 重要度 + 置信度 + 标签 + **可见性**（project / agent / task）+ 状态 |
| 图谱 | 无 | 服务端有 `/v1/graph`（本插件未暴露） |
| Webhook | 无 | 服务端支持 HMAC 签名 webhook（**本插件未实现订阅**） |
| 浏览器半端 | 有（自定义配置卡片） | 无（dsh 自动表单） |
| 破坏性操作 | `mem0_reset`（清空全部） | 无 reset；只有单条删除（需 `confirm: true`） |

---

## 7. 开发

```
integrations/dsh-mnemos/
├── package.json          # type: module, main: lib/index.js, dsh.bundle.patch
├── tsconfig.json         # 仅类型检查（noEmit）
├── tsconfig.build.json   # 输出 lib/（ESM + declaration）
├── cordis.patch.yml      # 把插件行插进 profile 清单（id: dsh-mnemos）
├── src/
│   ├── index.ts          # cordis 插件入口：name / inject / Config / apply
│   ├── config.ts         # schemastery Config + resolveConfig（解包 Volatile）
│   ├── mnemos-client.ts  # /v1 REST 客户端（超时、重试、错误映射）
│   ├── tools.ts          # 10 个 mnemos_* 工具
│   └── dsh-types.d.ts    # 本地最小宿主类型（不依赖 harness 包）
├── test/
│   ├── client.test.mjs   # 客户端：鉴权头 / 路径 / 请求体 / 错误 / 超时 / 重试
│   ├── tools.test.mjs    # 工具：mock 全覆盖 + 真机只读冒烟（可跳过）
│   └── apply.test.mjs    # 装配：Config 的 Volatile 形状 / 设置页 / re-sync
└── README.md
```

```bash
pnpm typecheck        # tsc --noEmit
pnpm build            # tsc → lib/ + 类型检查
pnpm test             # 先 build，再 node --test test/*.test.mjs

# 真机只读冒烟默认打 http://127.0.0.1:4380（服务不在就自动跳过）
MNEMOS_TEST_URL=http://127.0.0.1:4380 MNEMOS_TEST_API_KEY=mnemos_live_xxx pnpm test

# 可选：真机「写入 → 删除」自清理测试（默认关闭，避免污染演示数据）
MNEMOS_TEST_WRITE=1 pnpm test
```

### 三条硬约定

1. **不 import harness 的 bundle 行包**（`@deepseek-ai/cordis`、`dsh-tools`、`dsh-system-prompt`、`dsh-llm`）。
   它们会被 hoist 进 profile 并遮蔽 harness 自带副本，两份模块 → 两个 Symbol → 每次工具调用
   报 `Cannot read properties of undefined (reading 'prepare')`。类型写在 `src/dsh-types.d.ts`。
2. **工具的 JSON Schema 手写**，不用 `defineTool` DSL；`output.schema` 一律
   `additionalProperties: true`，避免服务端新增字段把读路径卡死。
3. **`.volatile()` 字段不是裸值**，是 `{ get() }` 引用；取值必须走 `resolveConfig`。
   `test/apply.test.mjs` 直接传 `Config({})` 的产物来回归这条。

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 设置页没有 dsh-mnemos 行 | profile 装错（GUI 跑 `desktop`）；或改完代码没重启 DSH |
| 工具有了但设置项不显示 | `Config` 字段漏了 `.volatile()`（只有 volatile 字段进表单） |
| 所有工具都报「未配置 Mnemos API Key」 | 设置页 `apiKey` 为空 |
| `401 INVALID_API_KEY` | Key 写错 / 已吊销；控制台重新创建 |
| `403 FORBIDDEN`（读或写） | Key 缺 `memories:read` / `memories:write`；`/v1/stats` 另需 `admin` |
| `404 Agent 不存在` | `defaultAgentId` 不在项目里：`mnemos_agent action=list` 看看，或 `register` |
| `mnemos_status` 只报 health | Key 没有 `admin` 作用域，拿不到 `/v1/stats`（属预期降级） |
| 请求超时 | 调大 `timeoutMs`；确认 `baseUrl` 上服务在跑（`curl <baseUrl>/v1/health`） |
| 改了 `src/` 不生效 | `link:` 加载的是 `lib/`：`pnpm build` + 重启 DSH |

---

## 9. License

MIT
