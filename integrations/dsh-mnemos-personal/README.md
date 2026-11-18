# dsh-mnemos-personal

把本仓库的 **Mnemos v6（中立记忆服务）** 接入 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)：
**以工作区作为分区（Partition）**、**记忆按人（Person）组织**，人 / 记忆列表使用 v6 游标分页。

- **host-only**：没有浏览器半端，设置页用 dsh 的自动表单（导出 `Config` + `.volatile()` 字段）。
- **12 个 Agent 工具**：工作区绑定、写入、检索、读取、简报、人物上下文、人管理、画像、历史、反馈、更新、自检。
- **免密可用**：`orgApiKey` 可留空（本地免密，请求不带 `Authorization`，服务端以 `MNEMOS_DEV_NO_API_KEY=1` 启动）。
- **零 harness 依赖**：运行时只依赖 `@deepseek-ai/schemastery`（表单 schema），不 import `cordis` / `dsh-tools` / `dsh-system-prompt` / `dsh-llm`（避免两份模块 Symbol 冲突，见 `src/dsh-types.d.ts`）。
- **热插拔**：`dsh plugin --profile <name> add link:<本目录>`，不改 dsh 源码。
- **旧插件不动**：`integrations/dsh-mnemos`（项目级共享记忆 + 任务）保持可用，两者可同时安装（行 id 不同：`dsh-mnemos` / `dsh-mnemos-personal`）。

> 契约来源：`docs/v6-architecture.md` 第 3 节（v6 API）与第 6 节（DSH 插件）。
> 旧领域（agents / tasks / 任务简报 / 项目记录 / 复盘 / 报告 / webhooks / 图谱）在 v6 已删除，本插件不再调用。

---

## 1. 核心模型

### 1.1 分区 = 工作区

| 模式 | 分区 slug | 说明 |
| --- | --- | --- |
| `workspace`（默认） | `ws-<basename 小写、去非法字符>-<sha1(规范化绝对路径) 前 8 位>` | 例：`/work/demo` → `ws-demo-<hash8>`。哈希段保证两个同名目录不会撞分区；不同工作区**硬隔离**，互不可见。 |
| `fixed` | 配置的 `fixedPartition`（原样使用） | 多工作区共享一个分区（同一项目 / 团队知识库）时用。 |

- 工作区解析优先级：会话头 `header.cwd`（创建会话时的原始项目目录，回放稳定、不随 `cd` 漂移）→ `workingDirectory` 服务的当前目录 → 进程启动目录。
- 首次调用会 `POST /v1/partitions {slug, name}` **幂等建分区**；客户端进程内缓存分区 id，并发调用只发一次 POST；服务端返回 409 时退化为 `GET /v1/partitions/:slug`。
- 所有 `/v1/partitions/:partition/...` 调用都接受**分区 id 或 slug**（客户端原样使用，服务端两者都支持）。
- `readOnly=true` 时**不**自动建分区，直接按 slug 直连（读接口仍可用）。

### 1.2 人 = 记忆主体

- 默认人由配置 `personId`（默认 `dsh-agent`）+ `personType`（默认 `agent`）决定；工具可显式传 `person_id` 读写其他人（App 用户 `human`、智能体 `agent`、服务 `service`）。
- 写路径（`mnemos_add` / `mnemos_workspace` / `mnemos_person action=upsert`）会先 `PUT /v1/partitions/:p/persons/:externalId` 建档（服务端 lazy upsert）；读路径不产生写副作用。
- 写记忆走 v6 人级端点 `POST /v1/partitions/:p/persons/:person/memories`，路径里的人优先用**内部 id**（服务端支持 id 或 external），避免同一 external_id 在不同 type 下的歧义。
- `scope` 语义：`person`=仅该人；`partition`=分区共享（协作知识）；`session`=仅当前会话（必须带 `session_id`，缺省用当前 DSH 会话 id）。
- 计数读 **persons 行上的反规范化字段**（`memory_count` / `shared_memory_count` / `session_count` / `last_memory_at`），不逐行查 stats、不做 `COUNT(*)`。

---

## 2. 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:4380` | Mnemos 服务地址（不带尾斜杠、不带 `/v1`）。 |
| `orgApiKey` | `''` | **org key**（`mnemos_live_*`，控制台「密钥」里 kind=org）。按工作区自动建分区需要 admin 作用域；读写需要 `memories:read` / `memories:write`。**可留空**：留空时请求不带 Authorization，走本地免密（见 2.1）。 |
| `personId` | `dsh-agent` | 默认人的 external_id。 |
| `personType` | `agent` | 默认人的类型：`human` / `agent` / `service`。 |
| `partitionMode` | `workspace` | `workspace`（按工作区派生）或 `fixed`（用 `fixedPartition`）。 |
| `fixedPartition` | `''` | fixed 模式的分区 slug（或分区 id）。 |
| `readOnly` | `false` | 只读模式：拦截 `mnemos_add` / `mnemos_update` / `mnemos_person action=upsert`，也不自动建分区 / 建人。 |
| `systemPrompt` | `true` | 向 Agent 注入「本工作区已绑定分区 X，记忆按人组织；默认人 Y」+ 使用时机 + 免密说明。 |

所有字段都是 `.volatile()`：设置页保存后无需重挂插件，下一次工具调用即生效。

### 2.1 本地免密（`orgApiKey` 留空）

`orgApiKey` 留空时插件进入**本地免密模式**：所有请求不再带 `Authorization` 头，也**不会**在本地报
`missing_api_key` 短路。服务端需以 `MNEMOS_DEV_NO_API_KEY=1` 启动（生产环境启动会拒绝该开关）：

```bash
MNEMOS_DEV_NO_API_KEY=1 pnpm --dir server start
```

- 服务端未开启免密时，v1 仍会返回 `401`；插件把 `action` 归一成
  「配置 orgApiKey，或本地以 MNEMOS_DEV_NO_API_KEY=1 启动 Mnemos 后重试」。
- `mnemos_status` 在免密模式下照常探测分区 / 默认人，返回 `authMode='none'`（有 key 时 `'orgKey'`）
  与 `apiKeyConfigured=false`；无 key 且 401 时 `reachable=false` 并给出同上 action。
- 免密只建议本地开发使用；远程 / 生产部署请填 org key（控制台「密钥」创建，自动建分区建议带 admin）。

---

## 3. 工具

| 工具 | 作用 | 关键参数 | 会写入？ |
| --- | --- | --- | --- |
| `mnemos_workspace` | 确保分区 + 默认人存在，返回分区 / 人 / `partition_stats` | 无 | 首次会（建分区 / 建档） |
| `mnemos_add` | 给默认人（或指定人）写记忆（v6 按原文入库，不做事实抽取） | `text`（或 `content` 别名）或 `messages`、`placeholders`（隐私占位符映射）、`person_id`（默认 self）、`scope`、`session_id`、`category`、`tags`、`metadata` | 是 |
| `mnemos_search` | 检索（默认按人；`scope=partition` 只看分区共享），返回带分数结果 | `query`、`person_id`、`scope`、`category`、`top_k` | 否 |
| `mnemos_get` | 传 `id` 取详情；否则按人 / scope / category 用**游标**列记忆 | `id`、`person_id`、`scope`、`category`、`cursor`、`limit` | 否 |
| `mnemos_brief` | 人的简报（v6 人级；最近 person 记忆 + 相关分区共享，压缩文本） | `person_id`（默认 self） | 否 |
| `mnemos_context` | 人的上下文（资料 + 简报 + 相关记忆 + 共享知识），返回可直接注入的 `prompt` | `person_id`（默认 self）、`query` | 否 |
| `mnemos_person` | `list`（**游标**分页）/ `get` / `upsert` 人 | `action`、`person_id`、`type`、`display_name`、`attributes`、`status`、`q`、`cursor`、`limit` | upsert 是 |
| `mnemos_profile` | 人物画像：结构化 facts + 服务端摘要（`force=true` 强制重算，默认用缓存） | `person_id`（默认 self）、`force` | 否（force 时服务端重算画像） |
| `mnemos_history` | 一条记忆的变更时间线（ADD / UPDATE / MERGE / SUPERSEDE / FEEDBACK / PRIVACY；含 event / actor / created_at / old→new） | `id`（`mem_*`） | 否 |
| `mnemos_feedback` | 给一条记忆记反馈（有用 / 没用），服务端据此升降 `confidence` 并计数 | `id`、`helpful`、`query` | 是（写 feedback + history） |
| `mnemos_update` | 更新记忆正文 / 重要度 / 标签 / 元数据（PATCH，返回更新后摘要并进历史） | `id`、`content`、`importance`、`tags`、`metadata` | 是（readOnly 拦截） |
| `mnemos_status` | 连接自检：可达性、鉴权模式（`orgKey` / `none`）、分区是否存在、默认人是否存在（不打印密钥） | 无 | 否 |

**v6 分页协议**：人 / 记忆列表返回 `{ items, next_cursor, partition_stats }`；工具输出里对应
`results` / `people`、`count`、`next_cursor`、`partition_stats`。要翻页时把上一页的
`next_cursor` 原样传给下一次调用的 `cursor`；`limit` 默认 50、最大 200。服务端不返回 total
（百万级不 `COUNT(*)`），头部统计从 `partition_stats` 读。

所有工具的 `execute()` 都**不抛异常**：失败返回 `{ ok: false, error, action }`，`action` 是可直接照着做的下一步
（检查 orgApiKey / 作用域、先 `mnemos_workspace`、换 `person_id` 等）。

### 3.1 隐私占位符写入协议（推荐）

写记忆遇到手机号 / 邮箱 / 身份证 / 银行卡等隐私值时，**不要把真实值直接写进正文**：
把真实值放进 `placeholders` 映射，正文只写 `{{key}}` 占位符。

```json
{
  "text": "张三的手机号是 {{phone_a1b2}}，邮箱是 {{mail_c3d4}}。",
  "placeholders": {
    "phone_a1b2": "18334423321",
    "mail_c3d4": "zhangsan@example.com"
  }
}
```

- key 规则：`[A-Za-z0-9_-]{3,64}`；正文里的每个 token 都必须在映射里（映射里多出来的 key 会被忽略）。
- **正文只存 token**（不落明文）；真实值存 `memory_placeholders`，服务端用 AES-256-GCM 加密
  （`MNEMOS_ENCRYPTION_KEY`；未配置时明文并标 `encrypted=0`）。
- 列表 / 搜索只返回 `placeholder_count`；详情默认只给占位符 key
  （`placeholders: [{placeholder, kind, encrypted}]`），`?reveal=placeholders`（或 `reveal=true`）
  才解密真实值，需 `memories:read`。
- `mnemos_brief` / `mnemos_context` 会在服务端把 token 还原成真实值后再生成提示词，否则 LLM 无法使用。
- 显式传 `placeholders` 时，即使分区 `pii_redaction=off` 也保存（调用方主动抽离）；
  服务端规则扫描（regex / 提示词 LLM）作为兜底，见 [`docs/privacy-rules.md`](../../docs/privacy-rules.md)。
- 插件当前 `mnemos_get` 未透出 `reveal` 参数：需要解密真实值时用 `mnemos_brief` / `mnemos_context`，
  或直接调 `GET /v1/partitions/:p/memories/:id?reveal=placeholders`。

---

## 4. 系统提示（默认开启）

```
Mnemos 记忆系统（dsh-mnemos-personal）：本工作区已绑定分区 ws-demo-1a2b3c4d，记忆按人组织；默认人 dsh-agent（type=agent）。
使用时机：
- 开始任务前先调 mnemos_context 取默认人的上下文……
- 想快速了解「关于这个人已知什么」用 mnemos_brief；……用游标翻页列表用 mnemos_get……
- 想了解「这个人的资料被结构化成了哪些事实」用 mnemos_profile（facts + 摘要，force 可强制重算）；
  看一条记忆的变更时间线用 mnemos_history（event/actor/old→new）。
- 检索结果有用 / 没用时用 mnemos_feedback 记一次；需要修正记忆正文 / 重要度 / 标签 / 元数据用 mnemos_update（readOnly 会拦）。
- 写记忆遇到隐私值（手机号 / 邮箱 / 身份证 / 银行卡等）时用 placeholders 抽离：真实值放映射，
  正文只写 {{key}} 占位符（如 text: "手机号是 {{phone_a1b2}}", placeholders: {"phone_a1b2":"18334423321"}）；
  正文只落 token，mnemos_brief / mnemos_context 会由服务端自动还原。
硬性限制：readOnly 模式会拦截记忆写入与人变更；orgApiKey 不要出现在回复里……
鉴权与免密：orgApiKey 留空时是本地免密模式——请求不带 Authorization；此时 Mnemos 需以
MNEMOS_DEV_NO_API_KEY=1 启动，否则返回 401（调 mnemos_status 自检，action 会提示配置 orgApiKey 或开启本地免密）。
```

提示段是**动态求值**的：每个会话按自己的工作区 / fixed 配置算分区 slug。
`systemPrompt=false`（或卸载插件）即撤下。

---

## 5. 构建、测试、安装

### 5.1 构建与测试

```bash
cd /Volumes/wd2025/devel/aiworker/mnemos/integrations/dsh-mnemos-personal
pnpm install --ignore-workspace   # 独立安装：本目录不在仓库根 pnpm-workspace 里
pnpm build                        # tsc 产出 lib/ + 类型检查
node --test test/*.test.mjs       # 或 pnpm test（= build + 测试）
```

- `pnpm build`：`tsc -p tsconfig.build.json` 产出 `lib/`，再 `tsc -p tsconfig.json --noEmit` 类型检查。
- 测试：`node --test` + 本地 `http.createServer` **假 Mnemos v6**（实现 partitions / stats / persons 游标列表 / 人级 memories / brief / context / dream / 全局 memories / search / profile / history / feedback / PATCH memory），**不依赖真实后端**。
- 测试覆盖（当前 94 个用例）：slug 稳定性与不同路径隔离、fixed 模式、默认人、按人隔离、v6 游标分页（persons / memories）、人级写入路径、占位符写入（正文只存 token / 映射透传 / 非法 key 报错）、分区 id 作为引用、检索主路径与 `GET memories?q=` 退化、`scope=session` 缺省会话 id、readOnly 拦截（含 `mnemos_update`）、错误归一、brief / context prompt、画像 / 历史 / 反馈 / 更新、免密模式（无 key 不带 Authorization / 401 提示 / status authMode）、系统提示文案、设置热更新。

### 5.2 安装到 dsh profile

> 本轮只交付插件包；**尚未安装到 desktop**（统一重装 / 重载由 lead 执行）。

```bash
dsh plugin --profile desktop add link:/Volumes/wd2025/devel/aiworker/mnemos/integrations/dsh-mnemos-personal
```

安装后到「设置 → 插件 → dsh-mnemos-personal」填 `baseUrl`（`orgApiKey` 可留空：本地以
`MNEMOS_DEV_NO_API_KEY=1` 启动 Mnemos 即免密；远程 / 生产请填 org key），然后在任意工作区开新会话，
调 `mnemos_workspace` / `mnemos_status` 自检。卸载：

```bash
dsh plugin --profile desktop remove dsh-mnemos-personal
```

**重载**：本插件是 host-only；重装 / 更新 `lib/` 后在 dsh 里停用再启用该插件（或重启应用）即生效，
不需要刷新浏览器页面。

---

## 6. 与 v6 契约的对齐与兼容点

已按 `docs/v6-architecture.md` 实现：

- 端点：`POST /v1/partitions`（幂等 upsert）、`GET /v1/partitions/:p`、`GET /v1/partitions/:p/stats`、
  `GET /v1/partitions/:p/persons`（`cursor/limit/q/type/status/sort`）、`PUT/GET/PATCH .../persons/:person`、
  `GET .../persons/:person/profile`（v6.1 画像，`force=1` 强制重算）、
  `GET/POST .../persons/:person/memories`、`GET .../persons/:person/brief`、`POST .../persons/:person/context`、
  `GET/POST .../persons/:person/dream[/run]`、`GET/POST/GET-by-id .../memories`、`POST .../memories/search`、
  `GET .../memories/:id/history`、`POST .../memories/:id/feedback`、`PATCH .../memories/:id`（v6.1）。
- 分页协议：所有人 / 记忆列表按 `{ items, next_cursor, partition_stats }` 解析；`limit` 默认 50、上限 200。
- 计数：分区统计读 `partition_stats`（`/stats`）；人的计数读 persons 行的 `memory_count` 等。
- 分区引用：`:partition` 支持内部 id 或 slug（客户端原样拼路径）。
- 鉴权 / 参数：有 `orgApiKey` 时 `Authorization: Bearer <orgApiKey>`；留空时**不带** Authorization（本地免密，服务端 `MNEMOS_DEV_NO_API_KEY=1`）。JSON snake_case；错误体 `{ error: { code, message } }`。

**兼容 / 容错点**（对照 v6 后端的 `serialize.ts` / `routes/v1.ts` 实现，两侧都容错）：

1. **响应形状**：v6 的 partition / person / stats / brief / context / dream 都是裸 snake_case 对象；
   人级写记忆是 `{ memory, events }`，记忆详情是 `{ memory, person }`，检索是
   `{ results, took_ms, next_cursor, partition_stats }`。插件同时容忍 `{ partition }` / `{ person }` /
   `{ items }` / `{ memory }` / `{ stats }` 等包装，并兼容 `next_cursor: null`。
2. **检索语义**：v6 的检索 = 记忆列表 + `q`（FTS 前缀），其中 `person_id` 是**作者过滤**；
   `POST .../memories/search` 是 v6 提供的兼容端点，语义相同。因此默认检索（未指定 scope）会查两次
   —— 本人记忆 + 分区共享 —— 再按 id 去重；`scope=partition` / `scope=person|session` 时单查该范围。
   专用端点不存在（404 / 405）时自动退化为 `GET .../memories?q=`，两条路径都有测试。
3. **分页**：`cursor` / `limit`（默认 50、最大 200）与 `sort=recent|new|name` 跟 v6 一致；
   `next_cursor` 为 null 时不输出，工具只在还有下一页时提示继续翻页。
4. **分区引用**：`:partition` 支持内部 id 或 slug（客户端原样拼路径，测试覆盖 id）。
5. **写入人标识**：人级写记忆路径优先用内部 id，服务端同时支持 id 或 external。
6. **分区统计降级**：`GET /stats` 若 404 / 405（旧服务），`mnemos_workspace` 仍返回分区 / 人并带 warning。
7. **slug 长度**：v6 slug 上限 48 字符，`ws-<basename>-<hash8>` 的 basename 截断到 36（哈希仍唯一）。
8. **v6.1 四类端点**：画像（`/profile`）、历史（`/history`）、反馈（`/feedback`）、更新（`PATCH /memories/:id`）
   在旧服务上可能 404；工具会返回 `{ ok:false, error, action }`，不影响其它工具。历史里的 `actor` 是服务端
   归一过的可读字符串（如 `api_key:xxx`），插件原样渲染。

**待真实 v6 后端联调确认**（本轮用假 v6 服务 + 对照 v6 后端实现验证，但没有连真实服务）：

1. 部署后的 v6 服务版本是否已包含 `GET /stats`、人级 memories、`POST .../memories/search` 兼容端点。
2. org key 是否带 admin（自动建分区）；非 admin 时插件按 slug 直连并带 warning。
3. 人级 brief 的 `brief_enabled` 设置 / LLM 润色是否可用（插件只读结果，不影响调用）。
4. `MNEMOS_DEV_NO_API_KEY=1` 免密部署是否已上线；未上线时无 key 的 `mnemos_status` 会报 401 并提示配置 key。

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
│   ├── mnemos-client.ts  # v6 `/v1/partitions/...` 客户端（游标分页、画像 / 历史 / 反馈 / PATCH、超时、错误归一、分区/人缓存）
│   ├── tools.ts          # 12 个工具（execute 不抛，{ ok, error, action }）
│   ├── index.ts          # apply：工具 + 动态系统提示 + 设置页
│   └── dsh-types.d.ts    # 本地最小化 dsh 宿主类型（零 harness 运行时依赖）
├── lib/                  # pnpm build 产物（d.ts 声明 + js）
└── test/                 # node --test（helpers.mjs 起假 Mnemos v6 服务）
```

## 8. 已知限制

- 只支持「一个插件实例 = 一个默认人」；同一会话要读写多个人时显式传 `person_id`（不支持按会话自动切人）。
- 分区 slug 由路径哈希决定，工作区目录**改名 / 移动**会得到新分区（旧分区数据不迁移）；需要稳定身份时用 `fixed` 模式。
- 中文目录名的 basename 会被清洗成 `workspace` 兜底段（哈希仍唯一），slug 里看不到中文。
- 工具已暴露 `mnemos_update`（PATCH 正文 / 重要度 / 标签 / 元数据）与 `mnemos_feedback`（反馈），
  但**不暴露删除**（`DELETE /memories/:id` 留给控制台或后续版本）；`mnemos_person` 也暂不暴露 `update` 动作，
  但客户端已实现 `PATCH persons/:person`，后续加动作即可。
- `readOnly` 只拦截 `mnemos_add` / `mnemos_update` / `mnemos_person action=upsert` 与自动建分区 / 建档；
  `mnemos_feedback` 仍可写反馈（它只调整 `confidence` / 计数，不改记忆正文）。
- `mnemos_get` 暂不透出占位符 `reveal` 参数：需要解密真实值时走 `mnemos_brief` / `mnemos_context`
  或 `GET /v1/partitions/:p/memories/:id?reveal=placeholders`。
- v6 不再做事实抽取：`mnemos_add` 的 `infer` 参数已移除，记忆按原文入库（仍可用 `messages` 多轮内容）。
- 系统提示段按会话工作区动态求值，会随工作区不同而不同；单会话内 `cd` 不会改变分区（用会话头 cwd）。
