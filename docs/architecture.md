# Mnemos 架构设计

## 1. 目标

为多业务线的 AI 应用提供**一处可信、可隔离、可解释、可治理**的长期记忆：

1. **多项目**：一个组织内多个业务项目，数据、配额、密钥、成员、审计完全隔离。
2. **记忆正确性**：写入可追溯（历史）、可去重（consolidate）、可反馈（feedback）。
3. **检索可解释**：每次命中给出 5 个信号分量与融合权重，便于调参与排障。
4. **离线可用**：不依赖外部模型服务，默认本地确定性嵌入 + 规则抽取。
5. **企业治理**：RBAC、API Key 作用域、限流、审计、用量、保留期。

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
| `projects` | 项目（租户） | `settings`（JSON：检索权重/阈值/配额/保留期/图谱开关） |
| `project_members` | 项目级成员角色 | 组织 owner/admin 可跨项目，developer/viewer 需显式成员 |
| `api_keys` | 项目密钥 | `prefix` 可见、`key_hash` 存储、`scopes`、`rate_limit_per_min` |
| `agents` | Agent 注册表 | 角色/模型/能力/状态/最近活跃，stats 由记忆与任务派生 |
| `tasks` | 任务会话 | 目标、负责人（Agent）、分支、时间范围、结论摘要 |
| `memories` | 记忆主体 | 作用域 + `task_id` + `visibility`（project/agent/task）+ `content` + `embedding` BLOB |
| `memory_terms` | BM25 倒排 | `(memory_id, term) → tf`，索引 `(project_id, term)` |
| `entities` / `memory_entities` | 实体与提及 | `(project_id, normalized, type)` 唯一 |
| `relations` | 实体关系边 | `(project_id, source, target, relation)` 唯一，`weight` 共现强度 |
| `memory_history` | 变更历史 | `event`（ADD/UPDATE/DELETE/MERGE/NOOP）、old/new、actor |
| `audit_logs` | 操作审计 | actor（user/api_key/system）、action、resource、IP、UA |
| `usage_events` | 用量事件 | channel、operation、status、latency_ms、memory_tokens |

设计取舍：

- **一个 SQLite 文件承载全部数据**：单机事务保证「记忆 + 词项 + 实体 + 历史」一致，避免跨库双写。
- **向量以 Float32 BLOB 存储**：384 维 × 4B = 1.5KB/条；万级规模内存中暴力余弦足够快。
- **倒排表独立**：BM25 的 `df` 可用 `COUNT(DISTINCT memory_id)` 实时统计，无需物化。
- **项目隔离靠查询条件**：所有 SQL 都带 `project_id`；外键级联删除保证清理。

## 3.5 Agent 原生模型

在「项目」之下增加两个维度：`agent_id`（谁在记）与 `task_id`（为何时、何事而记）。

- **可见性三档**：`project` 项目共享（默认）、`agent` 仅写入者可见、`task` 仅该任务可见。检索在 SQL 层按三档并集裁剪，控制台用 `includePrivate` 观测全部。
- **Agent 注册表**：角色、模型、能力标签与活跃时间，用于控制台观测与统计；知识本身仍在记忆里。
- **任务会话**：一个任务可以被多个 Agent、多次运行共同推进；记忆通过 `task_id` 归因，任务结束自动把 `decisions/lessons/notes` 写成项目共享记忆。
- **任务简报**：`briefing()` 按 section（背景/规范/决策/经验/事故/私有笔记/进行中任务）组装检索结果，按 token 预算截断，输出可直接注入 system prompt 的 Markdown 与引用 id。

详见 [`agent-memory-model.md`](agent-memory-model.md)。

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

- `additive`（默认）只增不改，符合 mem0 2026 的 ADD-only 思路；`consolidate` 适合偏好类会变更的场景（如客服）。
- 历史与嵌入都在同一事务内，失败即回滚，不会出现「有记忆无向量」。

## 5. 检索

候选集：SQL 预筛（项目 + 作用域 + 状态 + 时间 + 分类），上限 4000 条。

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
| 读取项目（记忆/图谱/用量） | 项目成员（或组织 owner/admin） |
| 写入/更新/删除记忆、创建密钥 | developer+ |
| 成员管理、密钥吊销、项目设置、审计 | admin+ |
| 归档项目 | owner |
| `/v1` 接口 | API Key 作用域：read / write / graph:read / admin |

API Key 只存 SHA-256，创建响应返回一次明文；吊销立即生效；限流按分钟窗口。

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
