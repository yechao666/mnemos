# Mnemos v6.4 架构

> 契约：[`v6-architecture.md`](v6-architecture.md) + [`roadmap-v6.1.md`](roadmap-v6.1.md) +
> [`llm-settings.md`](llm-settings.md)（大模型设置 / schema v10）。
> 本文描述 v6.4 的实现结构：分层、schema v10 表与索引、FTS 与触发器、计数维护、
> 混合检索与融合、写入/异步任务管线、画像与生命周期、图/附件/PII/加密、
> LLM 供应商与阶段路由、鉴权隔离、控制台与百万级列表的性能预算。
>
> v6 是**干净重建**：核心只有 **分区（Partition）+ 人（Person）+ 记忆（Memory）**。
> 旧领域（agents / tasks / 任务简报 / 项目记录 / 复盘 / 报告 / webhooks）在 v6 的代码、
> 表、路由与文档中均已删除，不做兼容层；v5 留在 `v5` 分支。v6.1 以**新的**
> entities / relations / memory_attachments 表重新提供实体图与多模态（不是 v5 的兼容层）。

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
│  retrieval（混合检索） · embed（hash-384） · history · jobs      │
│  profile（facts/画像） · graph · attachments · pii/crypto        │
│  cursor（keyset） · rows（映射/设置归一化） · llm（协议/路由）    │
│  llm-settings（供应商/阶段/用量/测试连接）                       │
└───────────────┬──────────────────────────────────────────────────┘
                │ node:sqlite（内置，无第三方驱动）
┌───────────────▼──────────────────────────────────────────────────┐
│ SQLite（WAL，schema v10）                                         │
│  partitions · persons(+fts) · memories(+fts) · sessions           │
│  partition_stats（触发器维护） · memory_briefs · dream_runs      │
│  memory_history · memory_feedback · memory_jobs                   │
│  person_facts · person_profiles · memory_attachments              │
│  entities · memory_entities · relations · idempotency_keys        │
│  privacy_rules · privacy_rule_groups · memory_placeholders        │
│  llm_providers · llm_stage_configs · llm_calls（v6.4）            │
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
| `meta` | schema 版本等元数据 | `schema_version = 10` |
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
| `memory_history` | 逐条记忆的变更历史 | `event`：ADD/UPDATE/MERGE/SUPERSEDE/DELETE/NOOP/FEEDBACK/RESTORE；`meta` JSON |
| `memory_feedback` | 检索反馈 | `helpful` 0/1、`query`、`actor` |
| `memory_jobs` | 异步写管线任务 | `type`：embed/extract/profile/consolidate/summarize；`status`/`attempts`/`run_after`/`locked_at` |
| `person_facts` | 结构化画像事实槽位 | 同 key 版本化：`valid_to IS NULL` 为当前；`UNIQUE` 由代码保证 |
| `person_profiles` | 画像摘要缓存 | `PRIMARY KEY(partition_id, person_id)`；`source_hash` |
| `memory_attachments` | 多模态附件（URL/元数据/caption） | `kind`：image/audio/video/file；配置密钥时 `url` 加密 |
| `idempotency_keys` | 写请求幂等（24h） | `key` 主键；`method`/`path`/`status`/`body`/`expires_at` |
| `entities` | 实体（图节点） | `UNIQUE(partition_id, normalized, type)`；`mention_count` |
| `memory_entities` | 记忆↔实体 | `PRIMARY KEY(memory_id, entity_id)`；`salience` |
| `relations` | 实体关系（图边） | `UNIQUE(partition_id, source, target, relation)`；`co_occurs` |
| `privacy_rule_groups` | 隐私规则库分组（v6.3，18 组） | `key` 主键；`sort_order`；启动时按 catalog 幂等 upsert |
| `privacy_rules` | 隐私规则（global + 分区覆盖） | `UNIQUE(scope, partition_id, code)`；v9 列 `group_key` / `validator` / `context_keywords` / `case_sensitive` / `region` / `severity` |
| `memory_placeholders` | 记忆占位符映射（v6.2） | `UNIQUE(memory_id, placeholder)`；值 `value_cipher` + `encrypted`（AES-256-GCM，可选） |
| `llm_providers` | LLM 供应商（v6.4） | `name UNIQUE`；`protocol`；`base_url`；`api_key_cipher` + `api_key_encrypted`；`input_price/output_price`（$/1M） |
| `llm_stage_configs` | 按阶段的模型分配（v6.4） | `stage` 主键（brief/dream/profile/privacy/extract）；`provider_id`/`model`/`temperature`/`max_tokens`/`timeout_ms`/`system_prompt`/`enabled` |
| `llm_calls` | LLM 调用流水（v6.4） | 只记录元数据（stage/provider/model/protocol/tokens/duration/status/error），**不记录 prompt/响应** |

v6.1 **仍不创建**的旧表：`projects`、`agents`、`tasks`、`task_briefs`、`memory_terms`、
`webhooks`、`webhook_deliveries`、`reports`、`records`、`retrospectives`、`project_members` 等。
启动时若检测到 v5 schema（`schema_version > 0 && < 6`），`migrate()` 直接报错并提示使用新的
数据目录（默认 `data-v6/`），**不迁移 v5 数据**；v6 库（`schema_version=6`）会**幂等升级**到 v7：
补列、建新表、回填 `normalized_hash` 与 `valid_from`（embedding 由异步/回填脚本补）。

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

v6.1/v6.2/v6.3/v6.4 新增（schema v7/v8/v9/v10）索引与隐私/LLM 表：

```sql
idx_memories_valid  (partition_id, person_id, valid_to, created_at DESC)  -- 默认列表 + 时序
idx_memories_fact   (partition_id, person_id, fact_key, valid_to)          -- 同槽位取代
idx_memories_hash   (partition_id, person_id, normalized_hash)             -- 精确去重
idx_history_memory      (memory_id, created_at DESC)
idx_history_partition   (partition_id, created_at DESC)
idx_feedback_memory     (memory_id, created_at DESC)
idx_jobs_due            (status, run_after)                                -- worker 取任务
idx_jobs_partition      (partition_id, created_at DESC)
idx_facts_person        (partition_id, person_id, valid_to)
idx_attachments_memory  (memory_id)
idx_idempotency_expiry  (expires_at)
idx_entities_partition  (partition_id, mention_count DESC)
idx_memory_entities_entity (entity_id)
idx_relations_partition (partition_id, weight DESC)
idx_privacy_rules_group (scope, partition_id, group_key)   -- v9 按组过滤
idx_llm_calls_stage     (stage, created_at DESC)           -- v10 usage 按阶段聚合
idx_llm_calls_created   (created_at DESC)                  -- v10 时间窗
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

### 4.1 写入记忆与演化管线（v6.1）

`POST .../persons/:person/memories`（v1/控制台同构）：

1. 解析分区（id 或 slug），归档分区拒绝写入（`403 PARTITION_ARCHIVED`）。
2. 解析人：HTTP 人级路径要求人已存在（未知人 404）；引擎按 `person_external_id + person_type`
   写入且 `settings.personAutoCreate=true` 时才自动建档。
3. `scope` 缺省取 `settings.defaultScope`；`scope=session` 必须提供 `session_id`。
4. 内容取 `text` / `content` / `messages`（忽略 system），最长 20,000 字符；PII `basic` 时先按隐私规则库脱敏（见 4.8）。
5. **归一化 + 去重/合并/取代**（同一事务）：
   - `normalized_hash = sha256(normalize(content))`；
   - 同人同分区 hash 完全相同 → `NOOP`（返回已有记忆，写 `memory_history(NOOP)`）；
   - 同人最近 200 条有效记忆中余弦 ≥ `dedupeThreshold` → `NOOP`（近重复）；
   - 余弦 ≥ `mergeThreshold` → `MERGE`（更新内容/重要度/标签/metadata，写 `history(MERGE)`）；
   - 显式 `supersedes_id` 或相同 `fact_key` → 旧记忆 `valid_to=now / superseded_by=新id`，
     新记忆 `supersedes=旧id`（写 `history(SUPERSEDE)`）。
6. 计算 embedding（本地 `mnemos-hash-384`，CJK 感知、确定性；外部模型失败回退本地）并落
   `embedding / embedding_model / dim`；写入 `valid_from`（缺省=now）。
7. 同事务插入附件（`memory_attachments`，≤10）；FTS/计数触发器同步。
8. 同事务 **enqueue** 异步任务：缺 embedding → `embed`；`autoExtractEntities` → `extract`；
   有 `fact_key` → `profile`。`Idempotency-Key` 的响应捕获在 HTTP 层完成（24h）。

`NOOP` / `MERGE` / `SUPERSEDE` 都返回 200；`ADD` 返回 201；响应带 `event` 与 `superseded_id`。

### 4.2 检索（v6.1）

`POST .../memories/search` 的候选集与融合：

```
candidate = FTS 前缀 top 300
          ∪ 该人最近 200
          ∪ 同分区 scope=partition 最近 200     （按 id 去重，上限 700）

score = w_vector * cosine(q, memory.embedding)
      + w_keyword * keywordScore(q, content + 附件 caption)
      + w_recency * normalized(recency)
      + w_importance * importance
      + w_entity * entitySignal
```

- 默认权重：`vector=0.45 / keyword=0.3 / recency=0.15 / importance=0.1 / entity=0`
  （`settings.retrievalWeights` 可覆盖；未列出的信号按 0）。
- `mode=keyword` 只走 FTS/CJK 子串 + keyword 信号；`mode=vector` 做候选 cosine 重排
  （候选不足时补最近记忆）；`mode=hybrid` 默认融合，候选都没有 embedding 时退化为 keyword。
- 默认 `valid_to IS NULL`；`as_of` 使用 `valid_from <= as_of AND (valid_to IS NULL OR valid_to > as_of)`；
  `include_superseded=true` 把已失效版本纳入候选。
- 返回 `hits`（`score` / `signals` / `matched_on`）、`took_ms`、`mode`、`strategy`；
  `results` 为 v6 兼容别名。`top_k` 默认 8、最大 50。
- 附件 `caption` 参与关键词候选与信号（`matched_on` 含 `caption`），不单独占权重。

### 4.3 列表（所有人 / 记忆列表）

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

### 4.4 简报 / 上下文 / 做梦

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

### 4.5 异步任务（memory_jobs）

写入事务内 enqueue；`server/src/main.ts` 启动同进程 worker：

- 默认每 **1s** tick，每批 **10** 条；`run_after <= now AND status='pending'`。
- 领取时 `status='running'` + `locked_at`；成功后 `done`；失败 `attempts+1`，按指数退避
  更新 `run_after`，超过 `MAX_JOB_ATTEMPTS=5` 落 `failed`。
- 进程崩溃遗留的 `running` 超过 `STALE_LOCK_MS=5min` 会被重新入队，重启不丢任务。
- 任务类型：`embed`（补 embedding/hash）、`extract`（实体 + co_occurs 关系）、
  `profile`（factKey 沉淀 + 画像缓存）、`consolidate` / `summarize`（预留）。
- 手动触发：`POST /api/ops/jobs/tick {limit?}`（admin）；也可用于排障时即时看图/画像数据。

### 4.6 画像与生命周期（v6.1 P1）

- **person_facts**：同 `person + key` 写入新值 → 旧版本 `valid_to=now`，插入新版本；
  同 key+同 value 幂等，不刷版本。`memory.metadata.factKey` 由 profile 任务与画像读取自动沉淀
  （取同 key 最新有效记忆，confidence 继承）；已删除的 fact 不会被同一条旧记忆复活。
- **person_profiles**：`source_hash = hash(facts + 有效记忆 updated_at)`；命中缓存直接返回。
  摘要优先 LLM（≤800 字），失败/未配置回退确定性拼接。
- **merge**：memories / person_facts / memory_feedback / memory_history / sessions 迁移到目标；
  同 fact_key 的当前事实只保留最新一条；源人 `status=archived` + `merged_into=target`；
  计数通过 `reconcileCounts` 重算（`person_id` 变更不命中触发器）。
- **archive**：`status=archived`，数据保留可读。
- **delete**：默认软删（`status=deleted` + `deleted_at`）；`hard=true` 物理删除该人的
  memories（含 FTS/实体/历史/反馈）、facts、profile、sessions，再删人，并清理悬空 `merged_into`。
- **export**：canonical person + 全部 facts（含历史版本）+ 最近 10,000 条 memories；
  超出 `truncated=true`。引用已合并人时自动跟随 `merged_into`。
- **resolve**：所有按 `:person` 的读写先解析 id/external_id，再跟随 `merged_into` 到 canonical。

### 4.7 图 / 附件 / PII / 加密（v6.1 P2）

- **实体图**：`extract` 任务用规则（CJK 词典 + 英文词 + 引号实体）抽取实体，写 `entities` +
  `memory_entities`；同一记忆内实体两两写 `relations(relation='co_occurs')`，`UNIQUE` 保证幂等。
  `entityGraph` 只读聚合：节点按关联记忆数排序（默认 100、最大 500），边只保留两端在节点集内。
  检索的 `entity` 信号可读该命中（默认权重 0）。
- **附件**：`memory_attachments` 只存 URL/元数据/caption；写入 ≤10、`url` ≤2000、`caption` ≤1000。
  详情/写入/导出返回附件数组，列表只批量统计 `attachmentCount`（避免 N+1）；caption 参与检索。
- **PII**：`settings.piiRedaction='basic'` 时按隐私规则库执行脱敏（默认 4 条：邮箱 / 身份证 /
  手机号 / 银行卡，保留后四位；其余规则按分组启用，见 4.8），`metadata.piiRedacted=true`，
  写审计 `memory.pii_redacted`。
- **字段加密**：配置 `MNEMOS_ENCRYPTION_KEY` 后，`memory_attachments.url` 落库前用
  AES-256-GCM 加密（`v1:<iv>:<tag>:<cipher>`，随机 IV）；读取时按前缀识别并解密。
  历史明文原样可读；密钥不匹配/密文损坏抛错而不是静默返回密文。只加密附件 URL，
  不加密 `memories.content`（避免破坏 FTS / embedding / 去重哈希）。

### 4.8 隐私扫描（v6.3 规则库）

- **规则来源**：`privacy_rule_groups`（18 组，启动时从 `server/src/db/privacy-catalog.ts`
  幂等 upsert）+ `privacy_rules` 中 `scope='global', builtin=1` 的 85 条目录规则。
  默认只启用 `email` / `id_card` / `phone` / `bank_card`；其余按分组启用。
- **合并**：`listPrivacyRules(partitionId)` 取 global 规则，用同 `code` 的分区规则覆盖
  （pattern / instruction / action / enabled / validator / context 等全部可覆盖），按
  `priority ASC, code` 排序。
- **分组覆盖语义**：`applyPrivacyGroup(partitionId, key, enabled)` 对组内每条 global 规则
  upsert 分区覆盖并设置 `enabled`；停用只写 `enabled=0` 不删除行。组计数
  `enabledCount` / `appliedCount` 由「合并后的生效规则」实时计算，不落缓存。
- **单条扫描流水线**（对合并后每条规则）：
  1. `enabled=true` 且 `kind` 满足（regex 有 pattern；prompt 需 `privacyLlmEnabled` + LLM）；
  2. 正则匹配（`caseSensitive=false` 时补 `i`，与 `flags` 合并去重）；
  3. `validator !== 'none'` → `validateValue(validator, hit)`；不通过 **跳过该命中**；
  4. `contextKeywords`：命中值前后 32 字符窗口内需出现其一（大小写不敏感）；
  5. 按 `priority` 升序替换；已替换片段（`*` / `{{token}}`）不会被后续规则重复命中；
  6. `action=mask` 按 maskMode 打码；`action=placeholder` 生成/复用 `{{token}}` 并写
     `memory_placeholders`。
- **prompt 规则**：LLM 返回 `{entities:[{code,value}]}`，服务端校验 value 确实出现在原文中
  （防幻觉）；失败静默回退，不影响写入。
- **异步与重扫**：写/更新入队 `privacy` job（worker tick）；`dream` 对输入记忆同步扫描；
  `memories.privacy_scanned_at` 防重复；规则/分组变更后 `POST .../privacy/rescan` 回扫历史。
- `region` / `severity` 仅元数据（UI 排序/告警），不参与过滤；是否扫描只由 `enabled` 决定。

---

### 4.9 大模型路由与调用（v6.4）

- **三张表的分工**：
  - `llm_providers`：供应商（协议、baseUrl、默认模型、加密后的 Key、单价、启停）；
  - `llm_stage_configs`：五阶段（brief/dream/profile/privacy/extract）的模型分配与采样参数；
  - `llm_calls`：每次实际请求的元数据流水（tokens/耗时/状态），usage 与成本由它聚合。
- **解析流程**（`createLlmRouter(db, fallbackLlm)`，每次调用按阶段解析）：

```
callLlm(stage, input)
  │
  ├─ 有 llm_stage_configs[stage] 行？
  │    ├─ enabled=false ────────────────→ ''（不发请求）
  │    └─ 解析 providerId → llm_providers
  │         ├─ provider 不存在 ───────────→ 回退 env（视为配置未完成）
  │         ├─ provider.enabled=false ───→ ''（不发请求）
  │         ├─ 无 key / 无 model ────────→ 回退 env（视为配置未完成）
  │         └─ model = stage.model || provider.defaultModel
  │              └─ protocol = provider.protocol，apiKey 解密后发请求
  │
  └─ 无阶段行（或配置未完成）
       └─ env fallback：MNEMOS_LLM_BASE_URL + MNEMOS_LLM_API_KEY
            └─ 有 → openai 协议、MNEMOS_LLM_MODEL（默认 gpt-4o-mini）
            └─ 无 → ''（调用方走确定性逻辑）
```

- **协议**：
  - `openai`：`POST {baseUrl}/chat/completions`（已以 `/chat/completions` 结尾则原样），
    `Authorization: Bearer`，读 `choices[0].message.content` 与 `usage.prompt_tokens/completion_tokens`；
  - `anthropic`：`POST {baseUrl}/v1/messages`（baseUrl 已含 `/v1` 时拼 `/messages`，
    已含 `/v1/messages` 时原样），`x-api-key` + `anthropic-version: 2023-06-01`，
    读 `content[].text` 与 `usage.input_tokens/output_tokens`。
- **密钥**：`api_key_cipher` 用 `lib/crypto` 的 AES-256-GCM（`MNEMOS_ENCRYPTION_KEY` 派生）；
  未配置密钥时明文 + `api_key_encrypted=0`。API 只返回 `hasApiKey` / `apiKeyMasked`，永不出明文。
  更新时省略 `apiKey` 保持不变，`clearApiKey=true` 清除。
- **失败**：超时/非 2xx/结构异常一律返回 `''`，写 `llm_calls(status='error'|'timeout')` 后由调用方
  回退确定性实现；**不发请求**的路径（阶段/供应商禁用、无配置）不写流水。失败不影响写入、检索、
  简报接口的成功响应。不记录 prompt 与响应正文。
- **调用点**（均把原来的 `llmText` 换成 `callLlm(stage, …)`）：
  - `brief`：`engine/brief.ts` 的人级/分区级简报润色（确定性摘要始终先生成，LLM 只改写）；
  - `dream`：`engine/dream.ts` 的洞见归并润色；
  - `profile`：`engine/profile.ts` 的画像摘要（≤800 字）；
  - `privacy`：`engine/privacy.ts` 的 prompt 规则抽取（JSON entities，服务端校验 value 出现在原文）。
  - `extract`：预留，v6.4 无调用点。
- **用量**：`llm_calls` 按 `(stage, created_at)` 与 `created_at` 建索引；`GET /api/llm/usage`
  时间窗聚合 calls/tokens，并按供应商单价估算成本（`prompt/1e6×input + completion/1e6×output`）。
  测试连接不写 `llm_calls`，避免污染业务用量。
- **配置读取**：router 每次调用实时读 DB（SQLite 单进程，开销可忽略）；控制台修改后下一次调用
  即生效，无需重启；env fallback 在启动时由 `loadEnv` 读取，修改需重启。

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
/org                                组织设置（账号、组织级 API Key、模型设置）
/org/models                         模型设置（供应商 / 阶段分配 / 测试连接 / 用量）
```

- `web/src/lib/api.ts` 统一封装 `/api`，做 camelCase/snake_case 归一化；
  列表统一 `CursorPage { items, nextCursor, partitionStats }`。
- 人列表：服务端游标分页（每页 50）+ FTS 前缀搜索（300ms 防抖）+ 类型/状态/排序筛选；
  筛选条件写入 URL query；自实现窗口化列表（`components/virtual/WindowedList.tsx`，
  固定行高 56px，只渲染可视窗口 + overscan），滚动到底自动加载下一页，DOM 行数恒定。
- 人详情/记忆页都按游标加载更多，不一次性拉全量；不做「全选全部」这类百万级操作。

---

## 7. 迁移与版本

- 空库启动自动执行 `schema.sql`，写入 `meta.schema_version = 10`；`CREATE ... IF NOT EXISTS`
  可重复执行，缺失的索引/触发器会补齐。
- v6 库（`schema_version=6`）启动时**幂等升级到 v7**：`ensureColumns` 补 `memories` / `persons`
  新列，`backfillV7` 回填 `normalized_hash` 与 `valid_from`；新表由 `schema.sql` 的
  `IF NOT EXISTS` 建好。embedding 不在迁移里同步计算，由 worker / `pnpm backfill:embeddings` 补齐。
- v9 库（`schema_version=9`）启动时**幂等升级到 v10**：`schema.sql` 的 `IF NOT EXISTS` 建
  `llm_providers` / `llm_stage_configs` / `llm_calls` 与两个索引；纯新增，不改既有表与数据；
  默认仍走 v6.3 行为（阶段表为空 → env → 确定性）。
- v8 库（`schema_version=8`）启动时**幂等升级到 v9**：`ensureColumns` 给 `privacy_rules` 补
  `group_key` / `validator` / `context_keywords` / `case_sensitive` / `region` / `severity`，
  `schema.sql` 建 `privacy_rule_groups` 与 `idx_privacy_rules_group`；旧内置 code
  `name→person_name`、`medical→diagnosis`；`seedPrivacyRules()` 幂等同步 85 条目录规则。
- 检测到 `schema_version > 0 && < 6` 时**拒绝启动**（v6 是重建，不迁移 v5 数据）。
- v5 数据目录 `data/` 保留在 `v5` 分支；v6/v6.1 默认 `data-v6/`，演示数据由 `pnpm seed` 生成。
- 升级小版本：备份 → 停服 → 部署 → 启动（自动幂等建表/补索引/迁移到 v9）→ `/readyz` 验证；
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
- v6.1 检索只对**有上限的候选集**（≤700 条）做内存 cosine 重排，不做全表扫描；
  人列表 / 统计 / 详情路径未改动，1M 人分区仍走索引 + `partition_stats`，不受检索影响。
  候选上限、检索延迟预算与实测方法见 [`v6-scale.md`](v6-scale.md#3-检索候选与延迟预算)。
- 本机（Apple Silicon，Node 26）实测 `scripts/seed-scale.ts --persons=100000`：
  约 **16s / 10 万人**（约 7.6k 人/秒，含 FTS 与计数触发器）；API 用
  `scripts/perf-persons.ts` 对 10 万人分区实测：列表 p95 **4ms**、`q=user_` 搜索 p95 **13ms**、
  stats p95 **1ms**、人详情 p95 **<1ms**；预算全部达标。
- 100 万人的验收方式、压测步骤与调参见 [`v6-scale.md`](v6-scale.md)。
