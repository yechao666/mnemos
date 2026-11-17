# dsh-mnemos-personal

把本仓库的**新版 Mnemos（中立记忆服务 v5）**接入 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)：
**以工作区作为分区（Partition）**、**记忆按人（Person）组织**。

- **host-only**：没有浏览器半端，设置页用 dsh 的自动表单（导出 `Config` + `.volatile()` 字段）。
- **8 个 Agent 工具**：工作区绑定、写入、检索、读取、简报、人物上下文、人管理、自检。
- **零 harness 依赖**：运行时只依赖 `@deepseek-ai/schemastery`（表单 schema），不 import `cordis` / `dsh-tools` / `dsh-system-prompt` / `dsh-llm`（避免两份模块 Symbol 冲突，见 `src/dsh-types.d.ts`）。
- **热插拔**：`dsh plugin --profile <name> add link:<本目录>`，不改 dsh 源码。
- **旧插件不动**：`integrations/dsh-mnemos`（项目级共享记忆 + 任务）保持可用，两者可同时安装（行 id 不同：`dsh-mnemos` / `dsh-mnemos-personal`）。

> 契约来源：`docs/neutral-memory-model.md` 第 5 节（v1 中立 API）、第 8 节（DSH 插件）。

---

## 1. 核心模型

### 1.1 分区 = 工作区

| 模式 | 分区 slug | 说明 |
| --- | --- | --- |
| `workspace`（默认） | `ws-<basename 小写、去非法字符>-<sha1(规范化绝对路径) 前 8 位>` | 例：`/work/demo` → `ws-demo-<hash8>`。哈希段保证两个同名目录不会撞分区；不同工作区**硬隔离**，互不可见。 |
| `fixed` | 配置的 `fixedPartition`（原样使用） | 多工作区共享一个分区（同一项目 / 团队知识库）时用。 |

- 工作区解析优先级：会话头 `header.cwd`（创建会话时的原始项目目录，回放稳定、不随 `cd` 漂移）→ `workingDirectory` 服务的当前目录 → 进程启动目录。
- 首次调用会 `POST /v1/partitions {slug, name}` **幂等建分区**；客户端进程内缓存分区 id，并发调用只发一次 POST；服务端返回 409 时退化为 `GET /v1/partitions/:slug`。
- `readOnly=true` 时**不**自动建分区，直接按 slug 直连（读接口仍可用）。

### 1.2 人 = 记忆主体

- 默认人由配置 `personId`（默认 `dsh-agent`）+ `personType`（默认 `agent`）决定；工具可显式传 `person_id` 读写其他人（App 用户 `human`、智能体 `agent`、服务 `service`）。
- 写路径（`mnemos_add` / `mnemos_workspace` / `mnemos_person action=upsert`）会先 `PUT /v1/partitions/:p/persons/:externalId` 建档（服务端 lazy upsert）；读路径不产生写副作用。
- 记忆的 `person_id` 优先写人的**内部 id**（服务端返回 `prs_*`），避免同一 external_id 在不同 type 下的歧义。
- `scope` 语义：`person`=仅该人；`partition`=分区共享（协作知识）；`session`=仅当前会话（必须带 `session_id`，缺省用当前 DSH 会话 id）。

---

## 2. 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:4380` | Mnemos 服务地址（不带尾斜杠、不带 `/v1`）。 |
| `orgApiKey` | `''` | **org key**（`mnemos_live_*`，控制台「密钥」里 kind=org）。按工作区自动建分区需要 admin 作用域；读写需要 `memories:read` / `memories:write`。 |
| `personId` | `dsh-agent` | 默认人的 external_id。 |
| `personType` | `agent` | 默认人的类型：`human` / `agent` / `service`。 |
| `partitionMode` | `workspace` | `workspace`（按工作区派生）或 `fixed`（用 `fixedPartition`）。 |
| `fixedPartition` | `''` | fixed 模式的分区 slug（或分区 id）。 |
| `readOnly` | `false` | 只读模式：拦截 `mnemos_add` / `mnemos_person action=upsert`，也不自动建分区 / 建人。 |
| `systemPrompt` | `true` | 向 Agent 注入「本工作区已绑定分区 X，记忆按人组织；默认人 Y」+ 使用时机。 |

所有字段都是 `.volatile()`：设置页保存后无需重挂插件，下一次工具调用即生效。

---

## 3. 工具

| 工具 | 作用 | 关键参数 | 会写入？ |
| --- | --- | --- | --- |
| `mnemos_workspace` | 确保分区 + 默认人存在，返回分区 / 人 / 统计 | 无 | 首次会（建分区 / 建档） |
| `mnemos_add` | 写记忆（默认原文入库；`infer=true` 走事实抽取） | `text` 或 `messages`、`person_id`（默认 self）、`scope`、`session_id`、`category`、`tags`、`metadata`、`infer` | 是 |
| `mnemos_search` | 混合检索（默认按人；`scope=partition` 只看分区共享） | `query`、`person_id`、`scope`、`category`、`top_k` | 否 |
| `mnemos_get` | 传 `id` 取详情；否则按人 / scope / category / page 分页列表 | `id`、`person_id`、`scope`、`category`、`page` | 否 |
| `mnemos_brief` | 人的简报（最近 person 记忆 + 相关分区共享，压缩文本） | `person_id`（默认 self） | 否 |
| `mnemos_context` | 人的上下文（资料 + 简报 + 相关记忆 + 共享知识），返回可直接注入的 `prompt` | `person_id`（默认 self）、`query` | 否 |
| `mnemos_person` | `list` / `get` / `upsert` 人 | `action`、`person_id`、`type`、`display_name`、`attributes`、`status`、`q`、`page` | upsert 是 |
| `mnemos_status` | 连接自检：可达性、分区是否存在、默认人是否存在、key 是否配置（不打印密钥） | 无 | 否 |

所有工具的 `execute()` 都**不抛异常**：失败返回 `{ ok: false, error, action }`，`action` 是可直接照着做的下一步
（检查 orgApiKey / 作用域、先 `mnemos_workspace`、换 `person_id` 等）。

---

## 4. 系统提示（默认开启）

```
Mnemos 记忆系统（dsh-mnemos-personal）：本工作区已绑定分区 ws-demo-1a2b3c4d，记忆按人组织；默认人 dsh-agent（type=agent）。
使用时机：
- 开始任务前先调 mnemos_context 取默认人的上下文……
- ……
硬性限制：readOnly 模式会拦截记忆写入与人变更；orgApiKey 不要出现在回复里……
```

提示段是**动态求值**的：每个会话按自己的工作区 / fixed 配置算分区 slug。
`systemPrompt=false`（或卸载插件）即撤下。

---

## 5. 构建、测试、安装

### 5.1 构建与测试

```bash
cd /Volumes/wd2025/devel/aiworker/mnemos/integrations/dsh-mnemos-personal
pnpm install --ignore-workspace   # 独立安装：本目录不在仓库根 pnpm-workspace 里
pnpm test                         # = pnpm build + node --test test/*.test.mjs
```

- `pnpm build`：`tsc -p tsconfig.build.json` 产出 `lib/`，再 `tsc -p tsconfig.json --noEmit` 类型检查。
- `pnpm test`：`node --test` + 本地 `http.createServer` 假 Mnemos（实现 partitions / persons / memories / brief / context 最小响应），**不依赖真实后端**。
- 测试覆盖：slug 稳定性与不同路径隔离、fixed 模式、默认人、按人隔离、`scope=session` 缺省会话 id、readOnly 拦截、错误归一、brief / context prompt、系统提示文案、设置热更新。

### 5.2 安装到 dsh profile

> 本轮只交付插件包，**尚未安装到任何 profile**（联调安装由 lead 下一轮安排）。

```bash
dsh plugin --profile desktop add link:/Volumes/wd2025/devel/aiworker/mnemos/integrations/dsh-mnemos-personal
```

安装后到「设置 → 插件 → dsh-mnemos-personal」填 `baseUrl` 与 `orgApiKey`，然后在任意工作区开新会话，
调 `mnemos_workspace` / `mnemos_status` 自检。卸载：

```bash
dsh plugin --profile desktop remove dsh-mnemos-personal
```

---

## 6. 与 v5 契约的对齐与未验证项

已按 `docs/neutral-memory-model.md` 实现：

- 端点：`POST /v1/partitions`、`GET /v1/partitions/:p`、`PUT/GET /v1/partitions/:p/persons/:externalId`、`GET /v1/partitions/:p/persons`、`GET .../persons/:person`、`GET .../persons/:person/brief`、`POST .../persons/:person/context`、`POST/GET .../memories`、`POST .../memories/search`、`GET .../memories/:id`。
- 鉴权：`Authorization: Bearer <orgApiKey>`；参数 snake_case；错误体 `{ error: { code, message } }`。
- 分区 slug 规则、幂等建分区、按人组织、scope/session 语义、readOnly、系统提示。

**待真实后端联调确认**（本轮用假服务验证了插件侧行为，但没有跑真实 Mnemos）：

1. `POST /v1/partitions` 是否按 slug 幂等 upsert、是否返回 `{ partition: { id, slug, name } }` 形状；本插件同时容忍裸对象 / `partition` 包装 / `project` 包装，且响应缺 id 时补一次 GET。
2. org key 的权限：建分区需要 admin；若后端对非 admin org key 直接 403，本插件对读工具会「按 slug 直连 + warning」降级，`mnemos_workspace` 则如实报错。
3. `POST /v1/partitions/:p/memories/search` 的过滤字段：本插件按任务契约发顶层 `query / person_id / scope / category / top_k`；若 P2 后端实际用 `filters.category`，需要对齐一处。
4. `POST .../memories` 的 `person_id` 是否同时接受内部 id 与 external_id；本插件写路径优先发内部 id、读路径发 external_id。
5. `brief` / `context` 响应是否包在 `{ brief }` / `{ context }` 里；本插件两者都兼容。
6. 设置页里 `partitionMode` / `personType` 的 union-of-const 是否渲染成下拉（校验已验证；表单外观未在 GUI 确认）。

---

## 7. 文件结构

```
integrations/dsh-mnemos-personal/
├── package.json          # dsh.bundle.patch、依赖 @deepseek-ai/schemastery
├── cordis.patch.yml      # insert 行 id = dsh-mnemos-personal（= 设置命名空间）
├── tsconfig.json
├── tsconfig.build.json
├── README.md
├── src/
│   ├── config.ts         # Config schema + 默认值 + resolveConfig（解包 volatile）
│   ├── workspace.ts      # 工作区路径规范化 / slug / 分区推导 / 会话工作区解析
│   ├── mnemos-client.ts  # /v1/partitions/... 客户端（超时、错误归一、分区/人缓存）
│   ├── tools.ts          # 8 个工具（execute 不抛，{ ok, error, action }）
│   ├── index.ts          # apply：工具 + 动态系统提示 + 设置页
│   └── dsh-types.d.ts    # 本地最小化 dsh 宿主类型（零 harness 运行时依赖）
├── lib/                  # pnpm build 产物（d.ts 声明 + js）
└── test/                 # node --test（helpers.mjs 起假 Mnemos v5 服务）
```

## 8. 已知限制

- 只支持「一个插件实例 = 一个默认人」；同一会话要读写多个人时显式传 `person_id`（不支持按会话自动切人）。
- 分区 slug 由路径哈希决定，工作区目录**改名 / 移动**会得到新分区（旧分区数据不迁移）；需要稳定身份时用 `fixed` 模式。
- 中文目录名的 basename 会被清洗成 `workspace` 兜底段（哈希仍唯一），slug 里看不到中文。
- 不做「记忆更新 / 删除」（本插件只读 + 追加；v5 的 PATCH/DELETE 留给后续版本）。
- 系统提示段按会话工作区动态求值，会随工作区不同而不同；单会话内 `cd` 不会改变分区（用会话头 cwd）。
