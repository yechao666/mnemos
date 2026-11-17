# Mnemos v6 架构

> 契约：[`v6-architecture.md`](v6-architecture.md)。本文描述 v6 的实现结构：分层、表与索引、
> FTS 与触发器、计数维护、读写路径、鉴权隔离、控制台与百万级列表的性能预算。
>
> v6 是**干净重建**：核心只有 **分区（Partition）+ 人（Person）+ 记忆（Memory）**。
> 旧领域（agents / tasks / 任务简报 / 项目记录 / 复盘 / 报告 / webhooks / 图谱 / entities / relations）
> 在 v6 的代码、表、路由与文档中均已删除，不做兼容层；v5 留在 `v5` 分支。

---

## 1. 分层

```
┌──────────────────────────────────────────────────────────────────┐
│ 客户端                                                           │
│  控制台（React 19 + Vite，web/src）  公开 API（curl/SDK/DSH 插件）│
└───────────────┬──────────────────────────────────────────────────┘
                │ HTTP（同源，反代终止 TLS）
┌───────────────▼──────────────────────────────────────────────────┐
│ server/src/http —— 传输层                                        │
│  安全头 / CORS / 请求 ID / 超时 / body 上限 / 静态资源（web/dist）│
│  Router（node:http，无框架） → 认证（Bearer session / API Key）  │
│  routes：auth · console /api · org /api/org · ops /api/ops        │
│          health /health /healthz /readyz /metrics · v1 /v1/...    │
└───────────────┬──────────────────────────────────────────────────┘
                │ 领域方法（同步 SQLite；brief/context/dream 可 await LLM）
┌───────────────▼──────────────────────────────────────────────────┐
│ server/src/engine —— 领域引擎（无 HTTP 依赖）                    │
│  partitions · persons · memories · brief · context · dream       │
│  cursor（keyset） · rows（映射/设置归一化） · llm（可选）        │
└───────────────┬──────────────────────────────────────────────────┘
                │ node:sqlite（内置，无第三方驱动）
┌───────────────▼──────────────────────────────────────────────────┐
│ SQLite（WAL）                                                     │
│  partitions · persons(+fts) · memories(+fts) · sessions           │
│  partition_stats（触发器维护） · memory_briefs · dream_runs      │
│  api_keys · audit_logs · usage_events · maintenance_runs          │
│  orgs · users · user_sessions（仅控制台登录/权限）                │
└──────────────────────────────────────────────────────────────────┘
```

- **单进程、单写者**：SQLite 通过 `node:sqlite` 直接使用，不引入 ORM/数据库服务。
- **控制台与 API 同源**：`/api`（camelCase，控制台会话）与 `/v1`（snake_case，API Key）同构，
  共用引擎与游标协议。
- **平台能力**：`server/src/platform/` 提供日志、指标、配额、备份、维护调度；
  `server/src/observability/` 提供可选 OTel trace。

---

## 2. 核心模型

```
Partition（App / 项目 / 租户 / DSH 工作区）
  └── Person（human | agent | service | other，external_id 由调用方定义）
        ├── Memory（person_id NOT NULL；scope = person | partition | session）
        └── Session（可选分组：一次对话 / 任务）
  Partition 级：共享简报、分区统计、密钥、用量、审计、做梦
```

- **记忆永远属于一个人**：`memories.person_id NOT NULL`。App 用户、员工、智能体都是「人」；
  控制台账号（`users`）只是操作者，与「人」无关。
- **共享由 scope 表达**：`partition` 分区共享；`person` 仅本人；`session` 仅该会话。
- **作者与归属可不同**：`person_id` 是记忆主体，`actor_person_id` 是写入者。
- **人不是账号**：一个 API Key / 控制台账号可以管理很多人；人不需要登录。

---

## 3. 表、索引与状态

### 3.1 表清单（`server/src/db/schema.sql`）

| 表 | 用途 | 关键约束/字段 |
| --- | --- | --- |
| `meta` | schema 版本等元数据 | `schema_version = 6` |
| `orgs` | 组织 | `slug UNIQUE` |
| `users` | 控制台账号（登录/角色） | `email UNIQUE`，`failed_login_attempts`、`locked_until` |
| `user_sessions` | 控制台会话 | 只存 `sha256(token)`，`expires_at` |
| `partitions` | 分区（取代 v5 `projects`） | `UNIQUE(org_id, slug)`；`settings` JSON |
| `persons` | 人（记忆主体） | `UNIQUE(partition_id, type, external_id)`；反规范化计数 |
| `persons_fts` | FTS5 外部内容表 | 内容列 `external_id, display_name`，`content='persons'` |
| `sessions` | 可选会话分组 | `person_id`、`started_at/ended_at` |
| `memories` | 记忆 | `person_id NOT NULL`，`scope`、`category`、`content` 等 |
| `memories_fts` | FTS5 外部内容表 | 内容列 `content`，`content='memories'` |
| `memory_briefs` | 简报缓存 | `PRIMARY KEY(partition_id, scope_key)` |
| `dream_runs` | 做梦运行记录 | 人级 `person_id` 可空（空=分区级） |
| `api_keys` | 分区/组织密钥 | 只存 `sha256(secret)`；`kind = partition \| org` |
| `partition_stats` | 分区头部聚合 | 每分区一行；触发器维护 |
| `audit_logs` | 审计 | actor/action/resource/detail/ip/ua |
| `usage_events` | 用量 | 操作、通道、状态、延迟、token |
| `maintenance_runs` | 维护运行历史 | `status/summary/error` |

v6 **不创建**的表：`projects`、`agents`、`tasks`、`task_briefs`、`memory_entities`、`memory_terms`、
`entities`、`relations`、`webhooks`、`webhook_deliveries`、`reports`、`records`、`retrospectives`、
`idempotency_keys`、`project_members` 等。启动时若检测到旧 schema（`schema_version < 6`），
`migrate()` 直接报错并提示使用新的数据目录（默认 `data-v6/`），**不迁移 v5 数据**。

### 3.2 人与记忆的列表索引

`persons` 上每种排序都准备「带状态过滤」与「不带状态过滤」两套索引，`recent/new/name` 均可走索引排序：

```sql
-- 人列表（partition_id 前缀 + 排序键 + id 兜底）
idx_persons_recent      (partition_id, status, last_seen_at DESC, id DESC)
idx_persons_new         (partition_id, status, created_at DESC, id DESC)
idx_persons_name        (partition_id, status, display_name, id)
idx_persons_recent_all  (partition_id, last_seen_at DESC, id DESC)
idx_persons_new_all     (partition_id, created_at DESC, id DESC)
idx_persons_name_all    (partition_id, display_name, id)
idx_persons_type_recent (partition_id, type, last_seen_at DESC, id DESC)
idx_persons_ext         (partition_id, external_id)      -- PUT/详情按 external_id 解析
```

`memories` 的排序键放在 `status` 之前，保证默认列表（不带 status 过滤）能直接走索引：

```sql
idx_memories_person   (partition_id, person_id, created_at DESC, id DESC)
idx_memories_scope    (partition_id, scope, created_at DESC, id DESC)
idx_memories_category (partition_id, category, created_at DESC, id DESC)
idx_memories_status   (partition_id, status, created_at DESC, id DESC)
idx_memories_recent   (partition_id, created_at DESC, id DESC)
idx_memories_session  (partition_id, session_id)
```

其余索引：`idx_partitions_org`、`idx_sessions_person`、`idx_dream_runs_partition/person`、
`idx_keys_partition/org`、`idx_audit_partition/org`、`idx_usage_partition/org`、`idx_maintenance_started`。

### 3.3 FTS5：前缀检索，不建自维护词项表

```sql
CREATE VIRTUAL TABLE persons_fts USING fts5(
  external_id, display_name, content='persons', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, content='memories', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2');
```

- 外部内容表 + `AFTER INSERT/UPDATE/DELETE` 触发器同步；`UPDATE` 时先 `delete` 旧行再插入新行
  （FTS5 external content 的固定写法）。
- 检索语义是**前缀匹配**：查询按非字母数字切词，最多 8 个词，每个词 `"term"*` 后用 AND 连接。
- 中文（CJK）查询退化为 `LIKE '%q%'`：`unicode61` 把连续 CJK 当一个 token，前缀搜索无法命中词中段。
- 长度 < 3 的拉丁查询同样退化为 `LIKE 'q%'`（走 `external_id` / `display_name` 索引）。
- 记忆搜索命中 `memories_fts` 后回表按 `created_at DESC, id DESC` 排序；`q` 为空时直接走覆盖索引。

### 3.4 计数：反规范化 + 触发器

列表页**绝不 `COUNT(*)`**，头部统计直接读 `partition_stats`，每行计数直接读 `persons`：

| 字段 | 维护方式 |
| --- | --- |
| `partition_stats.persons_total/human/agent/service` | `persons` 的 INSERT/DELETE/UPDATE(type) 触发器 |
| `partition_stats.memories_total` | `memories` 的 INSERT/DELETE 触发器 |
| `partition_stats.shared_total` | `memories.scope = 'partition'` 的增删与 scope 变更触发器 |
| `partition_stats.sessions_total` | `sessions` 的 INSERT/DELETE 触发器 |
| `persons.memory_count` | 该人 `scope IN ('person','session')` 的记忆数 |
| `persons.shared_memory_count` | 该人 `scope = 'partition'` 的记忆数 |
| `persons.session_count` | 该人的会话数 |
| `persons.last_memory_at / last_seen_at` | 写入记忆时取最大值更新 |

触发器只做 `UPDATE ... WHERE partition_id = ?` / `WHERE id = ?`，全部走主键/唯一索引。
批量导入、数据修复或手工 SQL 之后执行一次校准：

```
POST /api/partitions/:partition/reconcile        # 控制台 admin+
```

`reconcileCounts` 会重算该分区的 `partition_stats` 与所有 `persons` 的计数（全表聚合，低频操作）。

---

## 4. 读写路径

### 4.1 写入记忆（`POST .../persons/:person/memories`）

1. 解析分区（id 或 slug），归档分区拒绝写入（`403 PARTITION_ARCHIVED`）。
2. 解析人：HTTP 入口（人级路径）要求人已存在，未知人返回 404；引擎在按
   `person_external_id + person_type` 写入且分区 `settings.personAutoCreate=true` 时才自动建档
   （DSH 插件等客户端会先 `PUT` 建档，避免隐式写）。
3. `scope` 缺省取分区 `settings.defaultScope`；`scope=session` 必须提供 `session_id`
   （会话不存在时按首次写入自动创建；已存在但跨分区/跨人则 `409 CONFLICT`）。
4. 内容取 `text` / `content` / `messages`（忽略 system 消息，其余按行拼接）；最长 20,000 字符。
5. 单条 INSERT；FTS 与计数触发器在同一事务内完成同步。
6. v6 **不做事实抽取**：`infer` / `mode` 字段被接受但忽略，记忆按原文入库。

### 4.2 列表（所有人 / 记忆列表）

```
GET /v1/partitions/:p/persons?cursor=...&limit=50&q=...&type=...&status=...&sort=recent
GET /v1/partitions/:p/memories?cursor=...&limit=50&person_id=...&scope=...&category=...&q=...
```

- `limit` 默认 50、最大 200；服务端查 `limit + 1` 判断是否还有下一页。
- **keyset 游标**：`cursor = base64url(JSON {v, id, s})`，`v` 是排序值、`id` 破平、`s` 是排序方式。
  - `recent` / `new`：`WHERE (v, id) < (?, ?)`，`ORDER BY v DESC, id DESC`
  - `name`：`WHERE (v, id) > (?, ?)`，`ORDER BY display_name ASC, id ASC`
  - 记忆固定按 `created_at DESC, id DESC`，`s = "recent"`。
- 游标与当前排序不匹配 → `400 INVALID_CURSOR`；游标非法/解码失败同样 400。
- 响应 `{ items, next_cursor, partition_stats }`：`next_cursor` 为 `null` 表示到底；
  **不返回 total**；`partition_stats` 随每个列表响应返回，页面头部无需额外请求。
- 人列表按 `q` 搜索时走 FTS5；每个响应都从 `partition_stats` 取头部统计，不逐行查 stats。

### 4.3 简报 / 上下文 / 做梦

- **brief（人级/分区级）**：取最近活跃记忆（人级 = 本人 person/session + 相关 partition 共享，
  按 `importance DESC, created_at DESC`，最多 100 条），确定性压缩成不超过 `maxChars` 的文本；
  以 `source_hash`（来源 id+updatedAt、maxChars、模型名）缓存到 `memory_briefs`，
  `force=true` 或来源变化时重算。HTTP 入口固定使用确定性压缩（`mnemos-condense`），
  不额外调用 LLM。`scope_key = person:<personId>` 或 `partition`。
- **context（人级）**：人资料 + 人级简报 + 相关记忆（person/session，最多 20 条）+
  分区共享知识（最多 10 条，`includePartition` 默认 true），按 `budgetTokens`（默认 2000，
  60–32000）截断并拼成可直接注入的 `prompt`；返回 `memories/shared/citations/token_estimate`。
- **dream（人级/分区级）**：只处理 `dreamed_at IS NULL` 的活跃记忆（人级看该人 person/session；
  分区级看 scope=partition），单批默认 50、最大 200；产出一条 `category=insight,
  source=dream` 的洞见记忆（洞见归属该人或分区系统人 `mnemos-dream`），输入记忆与洞见都写
  `dreamed_at`，避免重复巩固；同一 `partition+person` 进程内互斥，重复触发返回 `409 DREAM_RUNNING`。
  分区级调度器默认每 60s 检查一次，按分区 `dreamEnabled` / `dreamIntervalMinutes` 触发。

---

## 5. 鉴权与隔离

| 主体 | 凭据 | 能力 |
| --- | --- | --- |
| 控制台用户 | `Bearer <session token>`（`user_sessions`） | 按组织角色 owner/admin/developer/viewer 操作本组织分区 |
| 分区 API Key | `Bearer mnemos_live_…`（`kind=partition`） | 只能访问自身分区；作用域 `memories:read/write/admin` |
| 组织 API Key | `Bearer mnemos_live_…`（`kind=org`） | 可访问/创建本组织任意分区（`POST /v1/partitions` 需 admin 作用域） |

- 所有查询都带 `partition_id` 前缀；跨组织或越权分区统一返回 `404 NOT_FOUND`，不泄露存在性。
- API Key 只存 SHA-256；可设置作用域、每分钟限流、过期时间、IPv4/CIDR 白名单。
- 限流为固定窗口（每分钟），响应带 `X-RateLimit-Limit/Remaining/Reset`，超限 429 + `Retry-After`。
- 控制台登录：连续失败锁定（423），登录接口另有 30 次/分钟/IP 限流（429）；
  密码重置/禁用会清理该用户会话。

---

## 6. 控制台

信息架构：**组织 → 分区 → 人 → 记忆**。

```
/partitions                         分区列表（走 partition_stats）
/partitions/:partitionId            概览（统计卡 / 最近活跃人 / 最近记忆）
  /persons                          人列表（核心，百万级）
  /persons/:personRef               人详情（资料 + 计数 + 最近记忆 + 简报 + 做梦）
  /memories                         记忆列表（person/scope/category 筛选 + FTS）
  /keys /usage /audit /settings /docs
/org                                组织设置（账号、组织级 API Key）
```

- `web/src/lib/api.ts` 统一封装 `/api`，做 camelCase/snake_case 归一化；
  列表统一 `CursorPage { items, nextCursor, partitionStats }`。
- 人列表：服务端游标分页（每页 50）+ FTS 前缀搜索（300ms 防抖）+ 类型/状态/排序筛选；
  筛选条件写入 URL query；自实现窗口化列表（`components/virtual/WindowedList.tsx`，
  固定行高 56px，只渲染可视窗口 + overscan），滚动到底自动加载下一页，DOM 行数恒定。
- 人详情/记忆页都按游标加载更多，不一次性拉全量；不做「全选全部」这类百万级操作。

---

## 7. 迁移与版本

- 空库启动自动执行 `schema.sql`，写入 `meta.schema_version = 6`；`CREATE ... IF NOT EXISTS`
  可重复执行，缺失的索引/触发器会补齐。
- 检测到 `schema_version > 0 && < 6` 时**拒绝启动**（v6 是重建，不迁移 v5 数据）。
- v5 数据目录 `data/` 保留在 `v5` 分支；v6 默认 `data-v6/`，演示数据由 `pnpm seed` 生成。
- 升级 v6 小版本：备份 → 停服 → 部署 → 启动（自动幂等建表/补索引）→ `/readyz` 验证；
  回滚代码前先恢复升级前备份（schema 可能已变化）。

---

## 8. 性能预算（百万级）

契约预算（`GET /v1/partitions/:p/...`，1M 人分区）：

| 场景 | 预算 |
| --- | --- |
| `GET persons?limit=50` p95 | < 100ms |
| `GET persons?q=...` 前缀搜索 p95 | < 300ms |
| `GET stats` | < 10ms |
| 人详情 | < 20ms |
| 记忆列表（每人 1000 条，limit 50）p95 | < 100ms |
| UI 首屏 / 滚动加载 50 行 | < 1s / < 200ms（DOM 行数恒定） |

设计与实测：

- 列表只做一次索引范围扫描（`LIMIT limit+1`），无 `OFFSET`、无 `COUNT(*)`；
  头部统计是单行主键查询。索引与触发器是性能的关键前提。
- 本机（Apple Silicon，Node 26）实测 `scripts/seed-scale.ts --persons=100000`：
  约 **16s / 10 万人**（约 7.6k 人/秒，含 FTS 与计数触发器）；API 用
  `scripts/perf-persons.ts` 对 10 万人分区实测：列表 p95 **4ms**、`q=user_` 搜索 p95 **13ms**、
  stats p95 **1ms**、人详情 p95 **<1ms**；预算全部达标。
- 100 万人的验收方式、压测步骤与调参见 [`v6-scale.md`](v6-scale.md)。
