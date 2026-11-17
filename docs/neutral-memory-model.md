# 中立记忆服务模型（v5）

> 目标：把 Mnemos 从「项目 / Agent / 任务为中心」改造成**中立记忆服务**：
> **记忆以「人（Person）」组织，以「分区（Partition）」隔离**。服务只认「分区 + 人」两个键，
> 不预设业务形态（App 用户、研发智能体、客服、租户都能用）。
>
> 本文件是 v5 的**唯一契约**。实现、控制台、SDK、DSH 插件、文档均以此为准。
>
> **状态：已定稿并实现**（P1 数据层/引擎 + P2 中立 v1 API / org key / 兼容映射完成）。
> 实现参考：`server/src/engine/persons.ts`、`server/src/engine/service.ts`、
> `server/src/http/routes/partitions.ts`、`server/src/http/routes/persons.ts`、
> `server/src/http/v1-mappers.ts`、`server/src/db/index.ts`（v5 迁移）。
> 使用文档：[`agent-memory-model.md`](agent-memory-model.md)、[`api.md`](api.md) 第 11 节、
> [`migration-v4-v5.md`](migration-v4-v5.md)。

## 1. 术语

| 术语 | 含义 | 存储对应 |
| --- | --- | --- |
| 分区 Partition | 隔离边界：项目 / 应用 / 租户 / 工作区；分区之间硬隔离 | `projects`（表名保留，对外叫 partition，`project_id` 列名保留） |
| 人 Person | 记忆的主体。`type = human`（App 用户、员工）或 `agent`（智能体）或 `service` | `persons`（新表） |
| 记忆 Memory | 一条事实/决策/经验等，归属某个人（可空 = 分区共享知识） | `memories` |
| 会话 Session | 一次对话 / 一次任务，用于把同一串交互归组 | `memories.session_id`（兼容 `task_id`/`run_id`） |
| 分区成员 | 控制台登录账号（组织用户），**不是**「人」 | `project_members` / `users` |

两个基准例子：

- **知物感恩 App**：分区 = `zhiwu-app`；人 = App 的 `user_id`（`type=human`）。每个用户的记忆彼此不可见（默认 `scope=person`）。
- **mnemos 代码项目**：分区 = `mnemos`；人 = 开发智能体 A（`type=agent`，`external_id=agent-a`）。A 写的决策/约定可设为 `scope=partition`，智能体 B、C 也能检索；A 的私有笔记保持 `scope=person`。

## 2. 领域模型

```
Partition（分区：项目/应用/租户）
 ├── Person（人：human | agent | service）
 │     └── Memory（person_id 归属，scope 决定可见范围）
 ├── 分区共享记忆（person_id = NULL 或 scope = partition）
 └── 简报 / 做梦 / 报告 / 密钥 / 用量 / 审计
```

**人不是登录账号**：`users` / `project_members` 是控制台操作者；`persons` 是记忆数据主体。一个登录账号可以查看/管理很多「人」，一个「人」也可以由后端服务（API Key）代为写入。

## 3. 存储契约（schema v5）

### 3.1 新表 `persons`

```sql
CREATE TABLE IF NOT EXISTS persons (
  id            TEXT PRIMARY KEY,              -- prs_xxx
  project_id    TEXT NOT NULL,                 -- 分区（沿用 projects.id）
  external_id   TEXT NOT NULL,                 -- 调用方的人 ID（App user_id / agent id）
  type          TEXT NOT NULL DEFAULT 'human', -- human | agent | service | other
  display_name  TEXT NOT NULL DEFAULT '',
  attributes    TEXT NOT NULL DEFAULT '{}',    -- 角色、模型、标签、画像等自由字段
  status        TEXT NOT NULL DEFAULT 'active',-- active | archived | deleted
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_persons_partition ON persons(project_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_persons_external ON persons(project_id, external_id);
```

### 3.2 `memories` 增量

```sql
ALTER TABLE memories ADD COLUMN person_id TEXT;        -- 记忆主体（归属人）；NULL = 分区共享知识
ALTER TABLE memories ADD COLUMN actor_person_id TEXT;  -- 写入者（可与人不同）
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'partition'; -- person | partition | session
ALTER TABLE memories ADD COLUMN session_id TEXT;       -- 会话（task_id/run_id 的泛化）
CREATE INDEX idx_memories_person ON memories(project_id, person_id, status, updated_at DESC);
CREATE INDEX idx_memories_scope ON memories(project_id, scope, updated_at DESC);
```

- `person_id` = **这条记忆是谁的 / 关于谁**；`actor_person_id` = **谁写的**。
- `scope`：
  - `person`：仅该人（及其授权的控制台/审计视角）可见 → 兼容旧 `visibility=agent`。
  - `partition`：分区内共享（协作项目知识、团队约定）→ 兼容旧 `visibility=project`。
  - `session`：仅该会话可见 → 兼容旧 `visibility=task`。
- `scope=partition` 的记忆仍可带 `person_id`（例如团队共享的「客户 X 的合同条款」），是否带取决于调用方。
- 旧列 `user_id` / `agent_id` / `task_id` / `run_id` / `visibility` **保留**并继续双写，供旧 API 兼容。

### 3.3 简报 / 做梦

```sql
ALTER TABLE memory_briefs ADD COLUMN person_id TEXT;    -- NULL = 分区简报
ALTER TABLE memory_dream_runs ADD COLUMN person_id TEXT;-- NULL = 分区级巩固
```

- 缓存键仍用 `(project_id, scope)`；人级缓存用 `scope = 'person:<person_id>'`。
- 人级做梦只巩固该人 `scope=person` 的新记忆；分区级做梦巩固 `scope=partition` 的新记忆（现有行为）。

### 3.4 API Key 扩展（中立服务必需）

```sql
ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'; -- project | org
ALTER TABLE api_keys ADD COLUMN org_id TEXT;                          -- org key 的组织
```

- `project` key：沿用现在行为，只能访问所属 partition。
- `org` key：属于组织，可访问/创建该组织下**任意 partition**。插件按工作区自动建分区必须用它。
- 控制台仅组织 owner 可创建 org key；密钥列表展示 kind。作用域仍用 `memories:read` / `memories:write` / `graph:read` / `admin`。

## 4. 语义

### 4.1 写入

- 新中立 API 必须显式给 `person`（`external_id` 或内部 id）；首次写入自动建档（`personAutoCreate=true` 时），也可先 `PUT persons` 建档。
- `scope` 缺省取分区设置 `defaultScope`：消费类 App 默认 `person`，协作项目默认 `partition`。
- `session` scope 必须带 `session_id`（或旧 `task_id`）。
- `infer=true` 时照旧做事实抽取，抽取出的每条记忆继承人的归属与 scope。

### 4.2 读取

- 控制台/审计视角：可看全部（含私有），按人筛选。
- Agent / 调用方视角：`scope=partition` + `scope=session`（本会话）+ `scope=person`（本人）。
- 按人检索 = `person_id` 精确命中 + 该分区的共享记忆（可选）。

### 4.3 简报与上下文

- 人的简报：该人最近 `scope=person` 记忆 + 与其相关的 `scope=partition` 记忆；字数上限沿用 `briefMaxChars`。
- 分区简报：`scope=partition` 的共享记忆（管理/协作视角）。
- 人的上下文（`/v1/partitions/:p/persons/:person/context`）：人资料 + 人的简报 + 高相关记忆 +（可选）分区共享知识；返回可直接注入提示词的 `prompt`。
- 旧 `/v1/context`（分区任务简报）保留，内部升级为「分区简报 + 与 agent 关联的人」。

### 4.4 做梦

- `personId` 缺省 = 分区级（现有行为，只处理 `scope=partition` 且 `dreamed_at IS NULL` 的记忆）。
- 指定 `personId` = 只处理该人 `scope=person` 的新记忆，产出 `scope=person` 的洞见（归属该人）。
- 洞见的 `actor_person_id` = 做梦系统 actor；`source=dream`、`category=insight` 不变。

## 5. API（v1 中立面）

所有端点默认挂在 `/v1/partitions/:partition/...`，`:partition` 支持分区 `id` 或 `slug`。
鉴权：`project` key 的 `:partition` 必须等于自身；`org` key 可指定任意本组织分区。JSON 一律 snake_case（与现有 v1 一致）。

| 方法 | 路径 | 作用 | 作用域 |
| --- | --- | --- | --- |
| POST | `/v1/partitions` | 建分区（按 slug 幂等 upsert） | admin（org key） |
| GET | `/v1/partitions/:partition` | 分区信息（不含敏感设置） | memories:read |
| PUT | `/v1/partitions/:p/persons/:externalId` | 建人/更新人（lazy upsert） | memories:write |
| GET | `/v1/partitions/:p/persons` | 人列表（type/status/q/分页） | memories:read |
| GET | `/v1/partitions/:p/persons/:person` | 人详情 + 统计 | memories:read |
| PATCH | `/v1/partitions/:p/persons/:person` | 更新显示名/attributes/status | memories:write |
| POST | `/v1/partitions/:p/memories` | 写记忆（person + scope + session） | memories:write |
| GET | `/v1/partitions/:p/memories` | 列表（person/scope/category/q/分页） | memories:read |
| POST | `/v1/partitions/:p/memories/search` | 检索（person/scope 过滤） | memories:read |
| GET | `/v1/partitions/:p/memories/:id` | 详情 | memories:read |
| PATCH/DELETE | `/v1/partitions/:p/memories/:id` | 更新/删除 | memories:write |
| GET | `/v1/partitions/:p/persons/:person/brief` | 人的简报 | memories:read |
| POST | `/v1/partitions/:p/persons/:person/context` | 人的上下文（资料+简报+记忆+prompt） | memories:read |
| POST | `/v1/partitions/:p/dream/run` | 做梦（body 可选 person） | memories:write |
| GET | `/v1/partitions/:p/dream` | 做梦状态 | memories:read |

兼容层：旧 `/v1/memories`、`/v1/memories/search`、`/v1/context`、`/v1/agents`、`/v1/tasks` 全部保留；
- `user_id` → `person(type=human)`，`agent_id` → `person(type=agent)`；
- 旧 `visibility` ↔ 新 `scope` 互转（project↔partition、agent↔person、task↔session）；
- 旧 `/v1/projects/:id` 作为 `/v1/partitions/:partition` 的别名。

## 6. 迁移（v5，幂等）

1. 建 `persons`、加列/索引、`api_keys` 扩展。
2. 回填 person：
   - 遍历 `memories` 中 distinct `(project_id, agent_id)` → 建 `person(type=agent, external_id=agent_id, display_name=agents.name)`。
   - 再遍历 distinct `(project_id, user_id)`（排除已有 agent 同名）→ `person(type=human)`。
   - `memory.person_id` = 对应 person id；`actor_person_id` 同。
3. 回填 `scope`：project→partition、agent→person、task→session；`session_id = COALESCE(task_id, run_id)`。
4. `api_keys.org_id` 回填为所属 project 的 org_id，`kind='project'`。
5. 旧数据 `person_id` 为空且 scope=partition 的记忆视为分区共享，不凭空造人。
6. 规范化：`external_id` trim、大小写不强制（保留原样），迁移报告输出「同分区同类型重复人」清单，供人工合并（合并 API 后续版本提供）。

## 7. 控制台

- 分区（原项目）列表 / 概览保留；文案「项目」→「分区」，副标题注明可为项目/应用/租户。
- 新增「人」页签：人列表（真人/智能体筛选、搜索、状态）→ 人详情（资料、统计、记忆时间线、简报、会话、洞察、做梦状态、合并/归档入口后续）。
- 记忆页：增加「人」列与筛选、scope 筛选；写入时可选人。
- 简报/做梦：人级 + 分区级两个入口；人的简报可复制、展开。
- 密钥页：区分 project / org key，新增 org key 创建（仅 owner）。
- 其余页（记录、复盘、图谱、Agent、任务、订阅、演练场、用量、审计、设置、API 文档）保留，逐步适配「分区」词汇与人维度。

## 8. DSH 插件（新版）

新插件包：`integrations/dsh-mnemos-personal`（旧 `integrations/dsh-mnemos` 保留不动）。

- **分区 = 工作区**：取 DSH 会话工作区绝对路径，规范化为 slug（`ws-<basename>-<sha1(path).slice(0,8)>`），首次调用 `POST /v1/partitions` 幂等建分区。
- **人 = DSH 主体**：默认人由配置 `personId`（默认 `dsh-agent`，`type=agent`）指定；工具可显式传 `person_id` 读写其他人。
- 工具：
  - `mnemos_workspace`：确保分区/人存在，返回分区/人/统计。
  - `mnemos_add`：写记忆（默认 person=self，scope 默认分区设置）。
  - `mnemos_search` / `mnemos_get`：按人/分区检索与读取。
  - `mnemos_brief`：人的简报（可传 person_id）。
  - `mnemos_context`：人的上下文（资料+简报+相关记忆），任务开始注入。
  - `mnemos_person`：list/get/upsert 人。
  - `mnemos_status`：连接自检。
- 配置：`baseUrl`、`orgApiKey`、`personId`、`personType`、`partitionMode`（workspace | fixed）、`fixedPartition`、`readOnly`、`systemPrompt`。
- 系统提示注入：告诉 Agent「本工作区已绑定分区 X，记忆按人组织」。
- 验收：在测试 profile 安装 → 在工作区 A/B 各写记忆 → 分区不同、互不可见；同一分区内换人写 → 人隔离正确。

## 9. 兼容与验收

- 旧接口、旧 SDK、旧控制台路径保持可用（legacy）；新增能力只增不改。
- 两组基准用例端到端通过：
  1. 知物感恩 App：分区 `zhiwu-app`，人 `user-123` / `user-456`，默认 `scope=person`，互相检索不到；`/persons/user-123/brief` 只含该人记忆。
  2. mnemos 代码项目：分区 `mnemos`，人 `agent-a` / `agent-b`；A 写 `scope=partition` 决策，B 能检索；A 写 `scope=person` 私有笔记，B 检索不到；人的简报与上下文正确。
- `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿；控制台可截图验证；插件测试通过。

## 10. 分阶段

- **P0**：契约（本文件）。
- **P1**：persons 表 + memories 增量 + v5 迁移回填 + 引擎/服务方法 + 单测。
- **P2**：中立 v1 API + org key + 兼容映射 + OpenAPI + 测试。
- **P3**：控制台「人」维度 + 简报/做梦人级化 + 密钥 kind。
- **P4**：DSH 插件新版 + 联调安装 + 测试。
- **P5**：文档 / SDK / 演示数据 / 迁移指南。
