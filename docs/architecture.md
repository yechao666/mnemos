# Mnemos 架构设计

## 1. 目标

为多业务线的 AI 应用提供**一处可信、可隔离、可解释、可治理**的长期记忆：

1. **多项目**：一个组织内多个业务项目，数据、配额、密钥、成员、审计完全隔离。
2. **中立记忆服务**（v5）：记忆以**人（Person）**组织、以**分区（Partition）**隔离；
   同一套 API 同时服务 App 真人用户、研发智能体、客服与服务账号。
3. **记忆正确性**：写入可追溯（历史）、可去重（consolidate）、可反馈（feedback）。
4. **检索可解释**：每次命中给出 5 个信号分量与融合权重，便于调参与排障。
5. **离线可用**：不依赖外部模型服务，默认本地确定性嵌入 + 规则抽取。
6. **企业治理**：RBAC、API Key 作用域（project / org）、限流、审计、用量、保留期。

非目标（当前版本）：分布式部署、PB 级向量检索、多模态记忆。

## 2. 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 控制台（web/）                                                │
│  React 19 · React Router · 手写设计系统 · SSE 实时事件         │
└───────────────▲──────────────────────────────────────────────┘
                │ /api (session) + /v1 (api key)
┌───────────────┴──────────────────────────────────────────────┐
│ 传输层 http/                                                  │
│  路由 router.ts · zod 校验 schemas.ts · 鉴权 auth middleware   │
│  SSO? 后续 · 审计 audit · 用量 usage · SSE live · 静态资源      │
└───────────────▲──────────────────────────────────────────────┘
                │ AppContext { db, engine, env, bus }
┌───────────────┴──────────────────────────────────────────────┐
│ 引擎层 engine/                                                │
│  tokenize 分词 · embed 嵌入 · extract 抽取 · retrieve 检索      │
│  graph 实体图 · service 记忆服务（MemoryService 实现）          │
└───────────────▲──────────────────────────────────────────────┘
                │ prepared statements / transactions
┌───────────────┴──────────────────────────────────────────────┐
│ 存储层 db/                                                    │
│  node:sqlite（WAL）· schema.sql · migrate · tx                 │
└──────────────────────────────────────────────────────────────┘
```

`shared/src/types.ts` 是**前后端唯一契约**：领域 DTO、请求/响应、`MemoryService` 接口。传输层与引擎层都只依赖它。

## 3. 数据模型

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `orgs` / `users` | 组织与成员 | `role`（owner/admin/developer/viewer）、`password_hash` |
| `sessions` | 控制台会话 | 仅存 `token_hash`，含过期时间 |
| `projects` | 分区（项目/应用/租户） | `slug`、`settings`（JSON：检索权重/阈值/配额/保留期/`defaultScope`/`personAutoCreate`） |
| `project_members` | 分区级成员角色 | 组织 owner/admin 可跨分区，developer/viewer 需显式成员 |
| `api_keys` | 密钥 | `kind`（project/org）、`org_id`、`prefix` 可见、`key_hash` 存储、`scopes`、`rate_limit_per_min` |
| `persons` | 人（记忆主体，v5） | `(project_id, type, external_id)` 唯一、`display_name`、`attributes`、`status`、`first/last_seen_at` |
| `agents` | Agent 注册表（v4 兼容） | 角色/模型/能力/状态/最近活跃，stats 由记忆与任务派生 |
| `tasks` | 任务会话（v4 兼容） | 目标、负责人（Agent）、分支、时间范围、结论摘要 |
| `memories` | 记忆主体 | `person_id` / `actor_person_id` / `scope`(person/partition/session) / `session_id` + 旧 `visibility`、`task_id` + `content` + `embedding` BLOB |
| `memory_terms` | BM25 倒排 | `(memory_id, term) → tf`，索引 `(project_id, term)` |
| `entities` / `memory_entities` | 实体与提及 | `(project_id, normalized, type)` 唯一 |
| `relations` | 实体关系边 | `(project_id, source, target, relation)` 唯一，`weight` 共现强度 |
| `memory_history` | 变更历史 | `event`（ADD/UPDATE/DELETE/MERGE/NOOP）、old/new、actor |
| `memory_briefs` | 简报缓存 | `(project_id, scope)` 缓存键，人级 `scope='person:<person_id>'` |
| `memory_dream_runs` | 做梦运行记录 | `person_id`（NULL = 分区级）、`trigger`、`status`、`input/insight_count` |
| `audit_logs` | 操作审计 | actor（user/api_key/system）、action、resource、IP、UA |
| `usage_events` | 用量事件 | channel、operation、status、latency_ms、memory_tokens |

设计取舍：

- **一个 SQLite 文件承载全部数据**：单机事务保证「记忆 + 词项 + 实体 + 历史」一致，避免跨库双写。
- **向量以 Float32 BLOB 存储**：384 维 × 4B = 1.5KB/条；万级规模内存中暴力余弦足够快。
- **倒排表独立**：BM25 的 `df` 可用 `COUNT(DISTINCT memory_id)` 实时统计，无需物化。
- **项目隔离靠查询条件**：所有 SQL 都带 `project_id`；外键级联删除保证清理。
- **只增不改的 v5 演进**：`persons` 新表 + `memories` 新列 + `api_keys` 新列；旧列
  （`user_id` / `agent_id` / `task_id` / `run_id` / `visibility`）保留并双写，旧接口与旧 SDK 继续可用。

## 3.5 人（Person）与分区（Partition）：v5 中立模型

服务只认两个键：**分区**（隔离边界，存储沿用 `projects`）与**人**（记忆主体，`persons`）。
App 用户、智能体、服务账号都只是 `persons.type` 的不同取值。

- **`persons`**：`(project_id, type, external_id)` 唯一；`external_id` 由调用方定义（App user_id /
  Agent id）。首次写入可懒建档（分区 `personAutoCreate=true`），也可 `PUT .../persons/:externalId` 显式建档。
- **`memories` 增量**：`person_id`（属于谁）、`actor_person_id`（谁写的）、`scope`
  （`person` / `partition` / `session`）、`session_id`（`task_id` / `run_id` 的泛化）。
- **可见性裁剪**：调用方视角 = `scope=partition` ∪ 本人 `scope=person` ∪ 本会话 `scope=session`；
  控制台/审计可 `include_private=true` 看全部。旧 `visibility` 与新 `scope` 一一映射并双写。
- **人级简报与做梦**：`memory_briefs` 的人级缓存键为 `scope='person:<person_id>'`；
  `memory_dream_runs.person_id` 区分人级/分区级做梦。人级做梦只读该人 `scope=person` 的新记忆，
  产出归属该人的 `insight`。
- **人不是登录账号**：`users` / `project_members` 是控制台操作者；一个账号可管理很多「人」。

详见 [`neutral-memory-model.md`](neutral-memory-model.md) 与 [`agent-memory-model.md`](agent-memory-model.md)。

## 3.6 v4 Agent / 任务维度（兼容层）

v4 的 `agent_id`（谁在记）与 `task_id`（何时为何而记）作为兼容层保留：

- **可见性三档**：`visibility` 仍可读写，内部映射 `project↔partition`、`agent↔person`、`task↔session`；
  检索在 SQL 层按 scope 并集裁剪，控制台用 `includePrivate` 观测全部。
- **Agent 注册表 / 任务会话**：`agents` / `tasks` 表保留，旧 `/v1/agents`、`/v1/tasks`、`/v1/context`
  接口保留；`finish` 仍把 `decisions/lessons/notes` 写成**分区共享**记忆（`scope=partition`）。
- **旧接口映射**：`agent_id` → `person(type=agent)`、`user_id` → `person(type=human)`；
  旧列继续双写，保证 v4 客户端与 v5 数据可互读。

## 3.7 v5 迁移与回填（幂等）

`migrate(db)` 在每次启动时执行，顺序：`ensureColumns`（逐列 `ALTER TABLE ADD COLUMN`）→
执行 `schema.sql`（`CREATE TABLE IF NOT EXISTS`）→ 按 `meta.schema_version` 执行未应用的迁移。

v5 迁移 `neutral-person-model` 的回填步骤：

1. 遍历 `memories` 的 distinct `(project_id, agent_id)` → 建 `person(type=agent)`，
   `person_id` / `actor_person_id` 回填；
2. 遍历 distinct `(project_id, user_id)`（排除已有 agent 同名的行）→ 建 `person(type=human)`，回填；
3. `scope` 回填：`project→partition`、`agent→person`、`task→session`；
   `session_id = COALESCE(task_id, run_id)`；
4. `api_keys.org_id` 回填为所属分区的 `org_id`，`kind` 默认 `project`；
5. `person_id` 为空且 `scope=partition` 的存量记忆视为分区共享知识，不凭空造人。

迁移在事务内完成，可重复执行；升级前请备份（详见 [`migration-v4-v5.md`](migration-v4-v5.md)）。

## 4. 写入路径

```
messages/text
  ├─ infer=false → 原文单条记忆
  └─ infer=true  → extract.ts
        ├─ 分句、过滤寒暄/过短
        ├─ 代词归一（我/我们 → 用户标识）
        ├─ 分类（preference/identity/fact/plan/constraint/event/…）
        ├─ importance / confidence 打分
        ├─ 实体：人物/组织/产品/技术/时间/地点
        └─ 关系：共现 + 动词模式（使用/负责/属于/任职于/偏好/相关）
  ↓
consolidate 模式：
  normalized_hash 完全一致 → NOOP
  同作用域内余弦 ≥ dedupeThreshold → 合并（重要度微增，写 MERGE 历史）
  ↓
事务写入：
  memories → embedding → memory_terms → entities → memory_entities
          → relations → memory_history(ADD)
```

要点：

- **先定人、再定可见范围**：写入时解析 `person_id` / `person_external_id`（其次旧 `user_id` /
  `agent_id`），按「显式 `scope` > 旧 `visibility` 映射 > 分区 `defaultScope`」确定 scope，
  并双写旧 `visibility` 列；`scope=person` 无 person、`scope=session` 无 session 直接拒绝。
- `additive`（默认）只增不改，符合 mem0 2026 的 ADD-only 思路；`consolidate` 适合偏好类会变更的场景（如客服）。
- consolidate 去重按 `(scope, person_id, session_id)` 隔离，不同人的相同内容不会被合并。
- 历史与嵌入都在同一事务内，失败即回滚，不会出现「有记忆无向量」。

## 5. 检索

候选集：SQL 预筛（分区 + `scope`/`person_id` + 状态 + 时间 + 分类），上限 4000 条。

- **按人检索**：`person_id` 精确命中（其 `scope=person` 记忆）+ 分区共享（`scope=partition`）；
  `include_private=false`（默认调用方视角）时排除他人私有与他会话记忆。
- **控制台/审计**：可 `include_private=true` 看全部，按人/scope/分类筛选。

5 个信号：

| 信号 | 计算 | 归一化 |
| --- | --- | --- |
| semantic | 查询与记忆向量的余弦 | clamp 0..1 |
| keyword | BM25(k1=1.2, b=0.75)，N=项目内 active 记忆数 | `bm25 / (bm25 + 6)` |
| entity | 查询实体与记忆实体的 Jaccard/覆盖 | 命中数/查询实体数 |
| recency | 距今衰减 | `exp(-days/30)` |
| importance | 记忆自身重要度 | 已是 0..1 |

融合：

```
score = w_semantic·s_semantic + w_keyword·s_keyword + w_entity·s_entity
      + w_recency·s_recency + 0.15·importance
```

- 权重来自项目 `settings.weights`（四者之和建议为 1，控制台会校验）。
- 查询未识别出实体时，`w_entity` 按 45%/30%/25% 分摊到 semantic/keyword/recency，避免权重真空。
- 命中后更新 `access_count`、`last_accessed_at`；搜索本身写入 `usage_events`（不写记忆历史）。
- 返回 `signals` 与 `matchedOn`，控制台以条形图呈现。

> 为什么用 BM25 而不是纯向量？企业记忆里大量专有名词（合同编号、产品版本、客户名），精确词项命中往往比语义更可靠；两路融合显著改善中文短查询。

## 6. 图谱

- 抽取阶段产出实体与关系；关系权重按共现次数累加。
- `graph(projectId, limit)` 返回按提及热度截断的节点、边与密度统计。
- 控制台以自实现布局渲染（无 d3），支持类型过滤、悬停高亮、节点详情。

## 7. 权限模型

```
组织角色   owner > admin > developer > viewer
项目成员   owner / admin / developer / viewer
```

| 操作 | 要求 |
| --- | --- |
| 读取分区（记忆/图谱/用量） | 分区成员（或组织 owner/admin） |
| 写入/更新/删除记忆、创建密钥 | developer+ |
| 成员管理、密钥吊销、分区设置、审计 | admin+ |
| 归档分区 | owner |
| 创建 org key / 查看 org key 列表 | 组织 owner |
| `/v1` 旧接口 | API Key 作用域：read / write / graph:read / admin（仅 project key） |
| `/v1/partitions/*` 中立接口 | project key（仅自身分区）或 org key（本组织任意分区） |

API Key 只存 SHA-256，创建响应返回一次明文；吊销立即生效；限流按分钟窗口。
org key 额外带 `org_id`，锚点分区（`project_id`）只用于审计与用量兜底。

## 8. 控制台架构

- **设计系统**：`web/src/styles` 定义 token（颜色/圆角/阴影/动效/布局）与组件类；`components/ui` 提供 React 原语，`components/charts` 为手写 SVG 图表。无第三方 UI/图表库。
- **数据层**：`lib/api.ts` 统一 fetch + 401 处理；`lib/auth.tsx` 会话状态；`hooks.ts` 提供 `useAsync/useDebounced/useInterval`。
- **路由**：`app/routes.tsx` 固定结构；`AppShell` 负责导航与命令面板；`ProjectLayout` 通过 `ProjectContext` 向子页面注入项目。
- **实时**：`/api/events` SSE + 进程内 `EventBus`，用于顶栏活动指示与概览信息流。

## 9. 一致性与并发

- `node:sqlite` 同步 API + WAL：单进程内请求串行执行 SQL，天然避免竞态；写操作包事务。
- 索引在启动时幂等创建（`CREATE TABLE IF NOT EXISTS`）。
- 写放大控制：批量导入时按事务提交（seed 使用事务写用量事件）。

## 10. 扩展路径

| 规模/需求 | 演进 |
| --- | --- |
| 记忆 > 10 万 | 引入 sqlite-vss 或外置 Qdrant/Milvus，保留 `MemoryService` 接口 |
| 多副本 | 写主 + 只读副本（WAL 只读），审计外送 |
| 大模型抽取 | 实现 `Extractor` 接口并注入，规则抽取器作为兜底 |
| 多模态 | `memories` 增加 `modality` 与对象存储引用 |
| 多语言分词 | 词典 + 语言检测，倒排按语言分片 |
