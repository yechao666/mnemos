# 人（Person）记忆模型（中立记忆服务 v5）

> Mnemos v5 起，记忆服务的**使用者不再只有 Agent**：App 的真人用户、研发智能体、客服机器人、
> 服务账号都可以是记忆主体。服务只认两个键——**分区（Partition）** 与 **人（Person）**，
> 不预设业务形态。Agent / 任务维度作为**兼容层**继续保留（旧接口、旧 SDK 不受影响）。
>
> 契约原文见 [`neutral-memory-model.md`](neutral-memory-model.md)；旧接口迁移见
> [`migration-v4-v5.md`](migration-v4-v5.md)。

## 1. 三个维度

```
分区（Partition）—— 隔离边界：项目 / 应用 / 租户 / 工作区，分区之间硬隔离
  ├── 人（Person）—— 记忆主体：type = human（App 用户 / 员工）/ agent（智能体）/ service
  │     └── 记忆（memory）—— person_id 归属 + scope 决定可见范围
  ├── 分区共享记忆（scope=partition）—— 团队约定、跨人知识
  └── 简报 / 做梦 / 报告 / 密钥 / 用量 / 审计
```

| 术语 | 含义 | 对应存储 |
| --- | --- | --- |
| 分区 Partition | 隔离边界；对外叫 partition，存储沿用 `projects` | `projects`（`project_id` 列名保留） |
| 人 Person | 记忆主体，与登录账号无关 | `persons`（新表） |
| 记忆 Memory | 一条事实/决策/经验；归属某个人，或为分区共享 | `memories` |
| 会话 Session | 一次对话 / 一次任务 | `memories.session_id`（兼容 `task_id` / `run_id`） |
| 分区成员 | 控制台登录账号（组织用户），**不是**「人」 | `project_members` / `users` |

两个基准例子：

- **知物感恩 App**：分区 = `zhiwu-app`；人 = App 的 `user_id`（`type=human`）。每个用户的记忆
  默认 `scope=person`，互相不可见；人级简报只包含该人记忆。
- **mnemos 代码项目**：分区 = `mnemos`；人 = 开发智能体 A（`type=agent`，`external_id=agent-a`）。
  A 写的架构决策设为 `scope=partition`，智能体 B、C 也能检索；A 的私有笔记保持 `scope=person`。

## 2. 可见性：scope 三档

| scope | 谁可读 | 典型内容 | 旧 `visibility` |
| --- | --- | --- | --- |
| `person` | 仅该人（及其授权的控制台/审计视角） | App 用户偏好、智能体私有草稿、敏感约束 | `agent` |
| `partition`（默认） | 分区内所有调用方 | ADR、团队约定、事故复盘、环境事实 | `project` |
| `session` | 仅同一会话（`session_id`） | 本次任务的临时上下文、中间产物 | `task` |

检索语义（调用方带人身份时）：

```sql
WHERE project_id = :partition
  AND (scope = 'partition'
       OR (scope = 'person' AND person_id = :caller_person_id)
       OR (scope = 'session' AND session_id = :session_id))
```

- 控制台 / 审计视角可传 `include_private=true` 查看全部（含他人私有），并可按人筛选。
- `person_id` = 这条记忆**关于谁 / 属于谁**；`actor_person_id` = **谁写的**（可与人不同，
  例如分区共享记忆由某个 Agent 写入）。
- `scope=partition` 的记忆**仍可带** `person_id`（如「客户 X 的合同条款」团队共享）；
  `person_id=NULL` 表示纯分区知识。
- `scope=session` 必须带 `session_id`（旧 `task_id` 会映射为 session）。

## 3. 生命周期：建档 → 上下文 → 工作 → 沉淀

```
PUT /v1/partitions/:p/persons/:externalId     建档 / 更新人（lazy upsert）
   │   type=human|agent|service、display_name、attributes
   ▼
POST /persons/:person/context                  ← 关键：人资料 + 人简报 + 相关记忆 + prompt
   │   或 GET /persons/:person/brief           只取人的简报
   ▼
写入记忆（POST /v1/partitions/:p/memories）
   │   person_id / scope / session_id / category / tags
   │   首次写入可自动建档（分区设置 personAutoCreate=true）
   ▼
人级做梦（POST /persons/:person/dream/run）    ← 只巩固该人 scope=person 的新记忆
   ▼
下一次上下文 / 简报自动带上该人的洞见
```

要点：

- **人不是登录账号**：`users` / `project_members` 是控制台操作者；`persons` 是记忆数据主体。
  一个登录账号可以管理很多「人」，一个「人」也可以由后端服务（API Key）代为写入。
- **写入时确定 scope**：显式 `scope` > 旧 `visibility` 映射 > 分区设置 `defaultScope`
  （消费类 App 建议 `person`，协作项目默认 `partition`）。
- **简报与上下文是人级的**：`/persons/:person/brief` 只包含该人 `scope=person` 记忆 +
  与其相关的分区共享记忆；`/persons/:person/context` 追加资料、高相关记忆与可直接注入的 `prompt`。

## 4. 人级简报与做梦

### 4.1 人级简报（brief）

- 入口：`GET /v1/partitions/:p/persons/:person/brief?force=&max_chars=`（`memories:read`）。
- 组成：该人最近的 `scope=person` 记忆 + 与其相关的 `scope=partition` 记忆，按重要度/时效压缩到
  分区 `briefMaxChars`（默认 500 字，范围 100–5000）。
- 缓存：写入 `memory_briefs`，人级缓存键 `(project_id, scope='person:<person_id>')`；
  `force=true` 跳过缓存。
- 旧的分区简报 `GET /api/projects/:id/memory/brief` 保留，仍取 `scope=partition` 共享记忆。

### 4.2 人级做梦（dream）

- 入口：`GET /v1/partitions/:p/persons/:person/dream`（状态）、
  `POST .../persons/:person/dream/run`（手动触发）。
- 增量水位：只处理该人 `scope=person`、`dreamed_at IS NULL` 的新记忆；处理完置 `dreamed_at`，
  不重放旧记忆。
- 产物：`category=insight`、`source=dream`、`scope=person` 的洞见，归属该人；
  `metadata` 记录 `dreamRunId` 与 `sourceMemoryIds`。
- `actor_person_id` = 做梦系统 actor（`type=service`），因此「谁写的」与「属于谁」可区分。
- 分区级做梦（`/v1/partitions/:p/dream`、`/dream/run`）保留：只巩固 `scope=partition` 的共享新记忆。

### 4.3 简报 / 做梦与可见性的关系

| 维度 | 人级 | 分区级 |
| --- | --- | --- |
| 简报 | 人的 `scope=person` + 相关共享记忆 | `scope=partition` 共享记忆 |
| 做梦输入 | 该人 `scope=person` 的新记忆 | `scope=partition` 的新记忆 |
| 做梦产物 | `scope=person` 洞见（归属该人） | `scope=partition` 洞见 |
| 典型入口 | `/persons/:person/brief`、`/persons/:person/dream` | `/api/projects/:id/memory/brief`、`/dream` |

> 隐私边界：人级做梦不会读取其他人的私有记忆；分区级做梦不会读取任何 `scope=person`
> 或 `scope=session` 的记忆。洞见只是新增记忆，原记忆与历史保持可追溯。

## 5. 两个基准场景

### 5.1 知物感恩 App（消费类）

| 要素 | 值 |
| --- | --- |
| 分区 | `zhiwu-app`（org key 创建，可重复创建同 slug 幂等） |
| 人 | `user-123`、`user-456`（`type=human`） |
| 默认 scope | `person`（分区设置 `defaultScope=person`） |
| 读取 | 人级简报 / 上下文 / 检索都带 `person_id`；互相检索不到 |

```bash
KEY=$ORG_KEY                       # org key（kind=org，admin 作用域）
BASE=http://127.0.0.1:4380

curl -X POST $BASE/v1/partitions -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"slug":"zhiwu-app","name":"知物感恩 App"}'

curl -X PUT $BASE/v1/partitions/zhiwu-app/persons/user-123 \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"human","display_name":"用户 123"}'

curl -X POST $BASE/v1/partitions/zhiwu-app/memories \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"用户 123 喜欢黑咖啡，不加糖","person_id":"user-123","scope":"person","infer":false}'

# 只查用户 123 自己的记忆
curl "$BASE/v1/partitions/zhiwu-app/memories?person_id=user-123&include_private=true" \
  -H "Authorization: Bearer $KEY"

# 人的简报（只含 user-123 的私有记忆 + 相关共享知识）
curl "$BASE/v1/partitions/zhiwu-app/persons/user-123/brief?max_chars=400" \
  -H "Authorization: Bearer $KEY"
```

### 5.2 mnemos 代码项目（Agent 协作）

| 要素 | 值 |
| --- | --- |
| 分区 | `mnemos` |
| 人 | `agent-a`、`agent-b`（`type=agent`） |
| 共享 | agent-a 写 `scope=partition` 的 ADR，agent-b 可检索 |
| 私有 | agent-a 写 `scope=person` 的草稿，agent-b 检索不到 |

```bash
# agent-a 写一条分区共享决策（actor=agent-a，person=agent-a）
curl -X POST $BASE/v1/partitions/mnemos/memories \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"所有数据库访问必须经过 repository 层","person_external_id":"agent-a",
       "scope":"partition","infer":false,"category":"constraint"}'

# agent-b 能检索到这条共享决策
curl -X POST $BASE/v1/partitions/mnemos/memories/search \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"repository 分层","person_id":"agent-b","scope":"partition"}'

# agent-a 的私有笔记（其他人检索不到）
curl -X POST $BASE/v1/partitions/mnemos/memories \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"草稿：查询服务先读 read replica 再按 order_id 分片","person_id":"agent-a",
       "scope":"person","infer":false}'
```

## 6. 控制台「人」维度

- 分区（原项目）列表 / 概览保留；文案「项目」→「分区」，副标题注明可为项目/应用/租户。
- 「人」页签：人列表（真人/智能体筛选、搜索、状态、记忆统计）→ 人详情（资料、统计、
  记忆时间线、简报、会话、洞察、做梦状态）。
- 记忆页：增加「人」列与筛选、scope 筛选；写入时可选人。
- 简报/做梦：人级 + 分区级两个入口；人的简报可复制、展开。
- 密钥页：区分 project / org key，新增 org key 创建（仅组织 owner）。

## 7. 接口速览

| 场景 | 接口 |
| --- | --- |
| 建分区（org key） | `POST /v1/partitions`（slug 幂等 upsert） |
| 分区信息 | `GET /v1/partitions/:partition` |
| 建档 / 更新人 | `PUT /v1/partitions/:p/persons/:externalId` |
| 人列表 / 详情 / 更新 | `GET /persons`、`GET /persons/:person`、`PATCH /persons/:person` |
| 写人级 / 共享记忆 | `POST /v1/partitions/:p/memories`（`person_id`、`scope`、`session_id`） |
| 列表 / 检索（按人） | `GET /memories?person_id=&scope=`、`POST /memories/search` |
| 人的简报 | `GET /v1/partitions/:p/persons/:person/brief` |
| 人的上下文（含 prompt） | `POST /v1/partitions/:p/persons/:person/context` |
| 人级做梦 | `GET/POST /v1/partitions/:p/persons/:person/dream[/run]` |
| 旧 Agent 原生接口（兼容） | `/v1/agents`、`/v1/tasks`、`/v1/context`、`/v1/memories?agent_id=` |
| 人类观测 | 控制台「人」「记忆」「简报 / 做梦」「密钥」页签 |

## 8. 与旧模型的兼容映射

| 旧字段 / 接口 | 新语义 |
| --- | --- |
| `user_id` | `person(type=human, external_id=user_id)` |
| `agent_id` | `person(type=agent, external_id=agent_id)` |
| `visibility=project` | `scope=partition` |
| `visibility=agent` | `scope=person` |
| `visibility=task` | `scope=session`（`session_id = task_id`） |
| `task_id` / `run_id` | `session_id`（双写，旧列保留） |
| `/v1/projects/:id/...` | `/v1/partitions/:id/...` 的全量别名 |
| `GET /v1/memories` | 保留；新字段 `person_id` / `scope` 只在中立分区端点筛选 |

## 9. 设计取舍

- **两个键足够**：分区负责隔离与治理（配额/密钥/审计），人负责归属与隐私；业务形态
  （App 用户、Agent、客服、租户）只是人的 `type` 与分区配置的差异。
- **默认共享、显式私有**：`scope` 在写入时确定，避免「经验孤岛」；消费类 App 通过
  分区 `defaultScope=person` 反过来默认私有。
- **人是数据主体，不是账号**：不引入新的登录体系，调用方用任意 `external_id` 定义人；
  同人跨分区不合并（分区是硬边界）。
- **简报是缓存视图，做梦是增量巩固**：两者都不改写历史；人级做梦只读该人私有记忆，
  不会泄漏他人数据。
- **只增不改的兼容层**：旧接口、旧字段、旧列继续可用；新能力以新端点/新字段增量提供。
