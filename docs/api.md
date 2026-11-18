# Mnemos v6.2 API 参考

> 契约：[`v6-architecture.md`](v6-architecture.md) + [`roadmap-v6.1.md`](roadmap-v6.1.md) +
> [`privacy-rules.md`](privacy-rules.md)（v6.2 隐私规则域）。
> 本文以 v6.2 契约为准；v6.2 新增「隐私规则域」（第 6 节）与写入占位符协议，其余端点沿用 v6.1。
>
> 两套 JSON 命名约定，**不是两套能力**：
>
> | 入口 | 前缀 | 鉴权 | 命名 |
> | --- | --- | --- | --- |
> | 公开 API | `/v1/partitions/:partition/...` | `Authorization: Bearer mnemos_live_…`（API Key） | `snake_case` |
> | 控制台 API | `/api/...` | `Authorization: Bearer <登录会话令牌>` | `camelCase` |
>
> v6 **不保留** `/v1/memories`、`/v1/memories/search`、`/v1/context`、`/v1/projects`、`/v1/agents`、
> `/v1/tasks`、`/v1/graph` 等旧端点；旧调用方需要迁移到分区 + 人模型（见[第 10 节](#10-与-v5-的差异)）。

---

## 1. 通用约定

- **Base URL**：默认 `http://127.0.0.1:4380`；不带尾斜杠。
- **请求体**：`content-type: application/json; charset=utf-8`；未知字段默认忽略（部分 schema 严格校验）。
- **响应体**：JSON；成功直接返回资源对象或 `{ items, next_cursor, partition_stats }`。
- **时间**：ISO 8601 UTC 字符串（如 `2026-11-17T16:00:44.852Z`）。
- **请求 ID**：每个响应带 `x-request-id`；错误体里也有 `requestId`，可与日志关联。
- **大小/超时**：请求体至少 1MB（`MNEMOS_BODY_LIMIT_BYTES` 可调大），请求超时默认 30s。
- **探针**：`GET /health`、`GET /api/health`、`GET /healthz`、`GET /readyz`、`GET /metrics`（详见第 9 节）。
- **幂等键**（v6.1，写接口）：请求头 `Idempotency-Key: <8–128 字符>`。服务端在
  `idempotency_keys` 表保留 **24 小时**：相同 key + 相同方法/路径/请求体直接回放首次响应
  （含状态码与响应体）；同一 key 用于不同方法/路径或不同 body 返回 `409 CONFLICT`。
- **检索信号**（v6.1）：`POST .../memories/search` 返回 `hits[]`，每项带
  `score`、`signals {vector, keyword, recency, importance, entity}`、`matched_on[]`，
  顶层带 `mode` / `strategy` / `took_ms`；`results` 保留为 v6 兼容别名。

### 错误体

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "分区不存在",
    "requestId": "req_e1860a48ce054010"
  }
}
```

- `message` 为可直接展示的中文；`code` 为稳定英文标识（判断逻辑用它，不要匹配 message）。
- 部分错误带 `details`（如 zod 校验详情、登录剩余尝试次数、配额重试秒数）。

---

## 2. 鉴权与密钥

### 2.1 三类凭据

| 凭据 | Header | 可访问范围 | 用途 |
| --- | --- | --- | --- |
| 控制台会话 | `Bearer <session token>` | 本组织及其分区（按组织角色） | 控制台 `/api` |
| 分区 API Key（`kind=partition`） | `Bearer mnemos_live_…` | **只能**访问自身分区 | 业务后端 / 单个分区集成 |
| 组织 API Key（`kind=org`） | `Bearer mnemos_live_…` | 本组织**任意分区** + `POST /v1/partitions` | DSH 插件按工作区建分区、SaaS 多租户 |

- `:partition` 路径参数支持**内部 id 或 slug**；两种 key 都支持。
- API Key 作用域：`memories:read`、`memories:write`、`admin`；`admin` 隐含读/写。
  缺少作用域返回 `403 FORBIDDEN`。
- Key 可设置 `rateLimitPerMin`（默认 600）、`expiresAt`、`allowedIps`（IPv4/CIDR）；
  只存 SHA-256，明文 `secret` 只在创建/轮换响应中出现一次。
- 限流是固定窗口（每分钟），响应头：`X-RateLimit-Limit`、`X-RateLimit-Remaining`、
  `X-RateLimit-Reset`（epoch 秒）；超限 `429 RATE_LIMITED` + `Retry-After`。
- 分区 key 访问别的分区统一 `404 NOT_FOUND`（不泄露存在性）；用分区 key 调
  `POST /v1/partitions` 或需要 `admin` 的接口返回 `403 FORBIDDEN`。

### 2.2 创建组织级 API Key（控制台，仅组织 owner）

```bash
BASE=http://127.0.0.1:4380

# 1) 登录拿控制台会话令牌
SESSION=$(curl -s -X POST "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@mnemos.dev","password":"Demo123456"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

# 2) 创建 org key（secret 只返回这一次）
curl -s -X POST "$BASE/api/org/keys" \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"name":"DSH 工作区","scopes":["memories:read","memories:write","admin"]}'
```

响应（节选）：

```json
{
  "id": "key_d7cfa499e85242cf",
  "orgId": "org_2a3c939fc3904cf6",
  "kind": "org",
  "name": "DSH 工作区",
  "prefix": "mnemos_live_9LSQr7",
  "scopes": ["memories:read", "memories:write", "admin"],
  "createdBy": "usr_3df6cf54dba0455a",
  "createdAt": "2026-11-17T16:00:56.981Z",
  "allowedIps": [],
  "rateLimitPerMin": 600,
  "secret": "mnemos_live_…（仅此一次）"
}
```

- 组织 key 只有组织 **owner** 能创建/吊销；分区 key 由分区 `admin` 在控制台创建。
- 轮换接口的 `graceHours` 仅写入审计：**v6 轮换会立即吊销旧 key**，避免新旧并存窗口。

---

## 3. 游标分页协议

所有人 / 记忆列表统一使用 **keyset 游标**，响应固定为：

```json
{
  "items": [ { "id": "prs_…", "external_id": "…" } ],
  "next_cursor": "eyJ2IjoiMjAyNi0xMS0xN1QxNjowMDo0NC44NTBaIiwiaWQiOiJwcnNfOTMyNDE3ZTM1NGZhNGQ3MiIsInMiOiJyZWNlbnQifQ",
  "partition_stats": {
    "partition_id": "ptn_2c3dcb0f511c4c81",
    "persons_total": 4,
    "persons_human": 0,
    "persons_agent": 3,
    "persons_service": 1,
    "memories_total": 12,
    "shared_total": 12,
    "sessions_total": 0,
    "updated_at": "2026-11-17T16:00:44.852Z"
  }
}
```

规则：

- `limit`：默认 **50**，最大 **200**；超过 200 会被夹到 200。
- **不返回 `total`**；头部统计读 `partition_stats`（每个列表响应自带，控制台页面不再单独请求）。
- `next_cursor = null` 表示没有下一页；否则把该字符串原样传给下一次请求的 `cursor`。
- 游标是 `base64url(JSON {v,id,s})`：`v` = 排序值、`id` = 破平键、`s` = 排序方式。
  - **换排序必须丢弃旧游标**，否则返回 `400 INVALID_CURSOR`（游标与排序不匹配）。
- 人列表 `sort`：`recent`（默认，最近活跃）、`new`（最新建档）、`name`（显示名升序）。
- 搜索参数 `q`：FTS5 前缀匹配（`q*`，最多 8 个词 AND）；含中文时退化为子串匹配；
  长度 < 3 的拉丁查询退化为 `LIKE 'q%'`。`q` 为空时按索引排序。
- 记忆列表固定按 `created_at DESC, id DESC`；`q` 搜正文。

示例（人列表第 2 页）：

```bash
CURSOR=$(curl -s "$BASE/v1/partitions/mnemos-dev/persons?limit=3" -H "authorization: Bearer $KEY" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).next_cursor')

curl -s "$BASE/v1/partitions/mnemos-dev/persons?limit=3&cursor=$CURSOR" \
  -H "authorization: Bearer $KEY"
```

---

## 4. 资源模型

### 4.1 Partition

```json
{
  "id": "ptn_2c3dcb0f511c4c81",
  "org_id": "org_2a3c939fc3904cf6",
  "slug": "mnemos-dev",
  "name": "Mnemos 研发",
  "description": "研发协作：人=agent，共享约定与决策",
  "status": "active",
  "settings": {
    "default_scope": "partition",
    "brief_max_chars": 1500,
    "brief_enabled": true,
    "dream_enabled": true,
    "dream_interval_minutes": 1440,
    "retention_days": 365,
    "monthly_quota": 0,
    "person_auto_create": true,
    "locale": "zh-CN",
    "retrieval_mode": "hybrid",
    "retrieval_weights": { "vector": 0.45, "keyword": 0.3, "recency": 0.15, "importance": 0.1, "entity": 0 },
    "embedding_model": "mnemos-hash-384",
    "merge_threshold": 0.95,
    "dedupe_threshold": 0.98,
    "auto_extract_entities": true,
    "pii_redaction": "off",
    "privacy_llm_enabled": false
  },
  "created_at": "2026-11-17T16:00:44.840Z",
  "updated_at": "2026-11-17T16:00:44.840Z",
  "archived_at": null
}
```

> 分区列表 / `POST` / `PATCH /v1/partitions`、控制台详情会额外返回 `stats`（结构见 4.2）；
> 单个 `GET /v1/partitions/:partition` 不返回 `stats`（需要时单独调 `/stats`）。

- `slug`：`^[a-z0-9][a-z0-9-]{0,47}$`，组织内唯一；`POST /v1/partitions` 按 slug 幂等
  upsert（已存在则更新 name/description/status/settings）。
- `status`：`active` / `paused` / `archived`；归档分区拒绝所有写入
  （`403 PARTITION_ARCHIVED`），读取仍可用。
- `settings`（v1 snake_case ↔ 控制台 camelCase）：

| v1 | 控制台 | 默认 | 说明 |
| --- | --- | --- | --- |
| `default_scope` | `defaultScope` | `partition` | 新记忆缺省 scope（`person` / `partition` / `session`） |
| `brief_max_chars` | `briefMaxChars` | 1200 | 简报字符上限（100–5000） |
| `brief_enabled` | `briefEnabled` | true | 只存储/返回；v6 的 brief 接口不因 false 拒绝生成 |
| `dream_enabled` | `dreamEnabled` | true | 关闭后**定时调度器**跳过该分区；手动 `dream/run` 仍可执行 |
| `dream_interval_minutes` | `dreamIntervalMinutes` | 1440 | 调度间隔（1–43200） |
| `retention_days` | `retentionDays` | 0（不限） | 维护任务归档超过该天数的 active 记忆（0–3650） |
| `monthly_quota` | `monthlyQuota` | 0（不限） | 分区月度记忆 token 配额；超限写入 429 `QUOTA_EXCEEDED` |
| `person_auto_create` | `personAutoCreate` | true | 仅影响引擎按 `person_external_id` 写入；v1 的人级写路径仍要求人已存在 |
| `locale` | `locale` | `zh-CN` | 展示语言 |
| `retrieval_mode` | `retrievalMode` | `hybrid` | 检索模式：`hybrid` / `keyword` / `vector` |
| `retrieval_weights` | `retrievalWeights` | `0.45/0.3/0.15/0.1/0` | 融合权重：`vector` / `keyword` / `recency` / `importance` / `entity`（0–1） |
| `embedding_model` | `embeddingModel` | `mnemos-hash-384` | 本地 hash-384 或外部模型名；外部失败回退本地 |
| `merge_threshold` | `mergeThreshold` | 0.95 | 余弦 ≥ 该值时新写入 MERGE 进已有记忆（0–1） |
| `dedupe_threshold` | `dedupeThreshold` | 0.98 | 余弦 ≥ 该值时视为重复，返回 NOOP（0–1） |
| `auto_extract_entities` | `autoExtractEntities` | true | 写入后异步 `extract` 实体（图谱依赖） |
| `pii_redaction` | `piiRedaction` | `off` | `basic`：写入时执行隐私规则域的正则规则，脱敏手机号 / 邮箱 / 身份证 / 银行卡等（见第 6 节）；`metadata.piiRedacted=true` 并写审计 |
| `privacy_llm_enabled` | `privacyLlmEnabled` | false | **v6.2** 是否执行 `kind=prompt` 的隐私规则（需配置 LLM；失败静默回退正则规则） |

### 4.2 PartitionStats

| 字段 | 含义 |
| --- | --- |
| `partition_id` | 分区 id |
| `persons_total` / `persons_human` / `persons_agent` / `persons_service` | 人数与类型分布（`other` 只计入 total） |
| `memories_total` | 记忆总数 |
| `shared_total` | `scope=partition` 的记忆数 |
| `sessions_total` | 会话数 |
| `updated_at` | 最近一次计数变更时间 |

由触发器维护；手工导入后可用控制台 `POST /api/partitions/:partition/reconcile` 校准。

### 4.3 Person

```json
{
  "id": "prs_5ed57a3928ec4518",
  "partition_id": "ptn_2c3dcb0f511c4c81",
  "external_id": "docs-user",
  "type": "human",
  "display_name": "文档校验用户",
  "attributes": { "from": "docs" },
  "status": "active",
  "memory_count": 1,
  "shared_memory_count": 0,
  "session_count": 0,
  "last_memory_at": "2026-11-17T16:01:05.801Z",
  "first_seen_at": "2026-11-17T16:01:02.397Z",
  "last_seen_at": "2026-11-17T16:01:05.801Z",
  "created_at": "2026-11-17T16:01:02.397Z",
  "updated_at": "2026-11-17T16:01:05.801Z",
  "merged_into": null,
  "consent": { "memory": true, "marketing": false },
  "deleted_at": null
}
```

- `type`：`human` / `agent` / `service` / `other`；`status`：`active` / `archived` / `deleted`。
- `merged_into`：合并后被指向的 canonical 人内部 id；引用已合并人时服务端会**自动跟随**到 canonical。
- `consent`：同意/合规标记（自由 JSON，整体覆盖）；随导出返回，PATCH 写入审计 `person.consent`。
- `deleted_at`：软删除时间；默认列表排除 `deleted` 与已合并的人（`include_merged=true` 可包含已合并）。
- 唯一键是 `(partition_id, type, external_id)`：同 `external_id` 允许不同 `type` 各建一个人。
- 按 `:person` 引用时支持**内部 id 或 external_id**；external_id 跨 type 重复时取最早创建的一条。
- `memory_count` = 本人 `scope=person/session` 记忆数；`shared_memory_count` = 本人写的
  `scope=partition` 记忆数；均在 `persons` 行上，列表页直接用。

### 4.4 Memory

```json
{
  "id": "mem_3238ae7e145445c0",
  "partition_id": "ptn_2c3dcb0f511c4c81",
  "person_id": "prs_5ed57a3928ec4518",
  "person_external_id": "docs-user",
  "actor_person_id": "prs_5ed57a3928ec4518",
  "scope": "person",
  "session_id": null,
  "category": "preference",
  "content": "文档校验：用户喜欢先看结论再看细节",
  "importance": 0.8,
  "confidence": 0.8,
  "source": "api",
  "status": "active",
  "tags": ["docs"],
  "metadata": {},
  "created_at": "2026-11-17T16:01:05.801Z",
  "updated_at": "2026-11-17T16:01:05.801Z",
  "expires_at": null,
  "dreamed_at": null,
  "valid_from": "2026-11-17T16:01:05.801Z",
  "valid_to": null,
  "superseded_by": null,
  "supersedes": null,
  "fact_key": "preference.language",
  "feedback_up": 2,
  "feedback_down": 0,
  "attachment_count": 1,
  "placeholder_count": 0,
  "attachments": [
    {
      "id": "att_9a1c2f3d4e5b6a7c",
      "memory_id": "mem_3238ae7e145445c0",
      "kind": "image",
      "url": "https://cdn.example.com/board.png",
      "mime": "image/png",
      "size": 20480,
      "caption": "评审白板照片",
      "created_at": "2026-11-17T16:01:05.801Z"
    }
  ]
}
```

- `scope`：`person`（仅本人）/ `partition`（分区共享）/ `session`（仅该会话）。
- `category`（18 种）：`preference`、`identity`、`fact`、`plan`、`relationship`、`event`、`skill`、
  `constraint`、`context`、`insight`、`decision`、`progress`、`lesson`、`risk`、`change`、
  `acceptance`、`assumption`、`dependency`。
- `source`：`api` / `conversation` / `agent` / `import` / `playground` / `dream`。
- `status`：`active` / `archived` / `deleted`；`importance`、`confidence` 为 0–1。
- `person_id` 是**归属人**，`actor_person_id` 是**写入者**（可与人不同）。
- v6.1 原文入库（不做 LLM 事实抽取），但会做**确定性演化**：
  - `normalized_hash` 完全重复 → `NOOP`；
  - 余弦 ≥ `dedupe_threshold` → `NOOP`（近重复）；
  - 余弦 ≥ `merge_threshold` → `MERGE`（更新内容/重要度/标签/metadata）；
  - 显式 `supersedes_id` 或相同 `fact_key` → 旧记忆 `valid_to=now / superseded_by=新 id`，新记忆 `supersedes=旧 id`。
- `valid_from` / `valid_to`：事实生效/失效时间；默认检索只返回 `valid_to IS NULL` 的记忆，
  `as_of` 可回看某个时间点有效的事实，`include_superseded=true` 包含历史版本。
- `fact_key`：槽位键（如 `preference.language`）；同 key 新写入自动取代旧事实。
- `feedback_up/down`：检索反馈计数；帮助度会按 ±0.05 微调 `confidence`（夹在 0.05–1）。
- `attachment_count`：列表页只给数量；`attachments` 明细只在**详情 / 写入响应 / 导出**返回。
- `placeholder_count`（v6.2）：正文中 `{{key}}` 占位符数量；列表 / 搜索 **不返回明文**，
  详情默认只给占位符 key，`reveal` 才解密（见 [6.3](#63-占位符协议写入抽离)）。
- `infer` / `mode` 字段被接受但忽略。

### 4.5 MemoryBrief / PersonContext / Dream

Brief（节选：`recent` 只列 1 条，实际最多 100 条）：

```json
{
  "partition_id": "ptn_2c3dcb0f511c4c81",
  "person_id": "prs_5ed57a3928ec4518",
  "scope_key": "person:prs_5ed57a3928ec4518",
  "text": "- [偏好] 文档校验：用户喜欢先看结论再看细节\n- [约束] …",
  "max_chars": 400,
  "count": 2,
  "model": "mnemos-condense",
  "cached": false,
  "source_hash": "f94caff3…",
  "generated_at": "2026-11-17T16:01:08.954Z",
  "recent": [
    {
      "id": "mem_3238ae7e145445c0",
      "content": "文档校验：用户喜欢先看结论再看细节",
      "category": "preference",
      "importance": 0.9,
      "scope": "person",
      "updated_at": "2026-11-17T16:01:05.925Z",
      "person_id": "prs_5ed57a3928ec4518",
      "person_external_id": "docs-user"
    }
  ]
}
```

- 人级 `scope_key = person:<内部 person_id>`；分区级为 `partition`。
- `text` 是按 `max_chars` 截断的要点列表，可直接注入提示词；`model` 目前是
  `mnemos-condense`（确定性压缩，HTTP 入口不调用 LLM）。
- 缓存按 `source_hash`（来源记忆 id+updatedAt + maxChars + 模型）命中；`force=true` 跳过缓存。
- `recent` 是参与压缩的最近记忆条目（前端展示/引用用）。

`PersonContext`：

```json
{
  "person": { "id": "prs_5ed57a3928ec4518", "external_id": "docs-user", "type": "human", "display_name": "文档校验用户" },
  "brief": { "text": "- [偏好] 用户喜欢先看结论再看细节", "count": 1, "model": "mnemos-condense" },
  "memories": [ { "id": "mem_3238ae7e145445c0", "scope": "person", "content": "文档校验：用户喜欢先看结论再看细节" } ],
  "shared": [ { "id": "mem_16f8a40505fe4924", "scope": "partition", "content": "记忆必须属于一个人（person_id NOT NULL）" } ],
  "prompt": "## 人物资料\n…\n## 记忆简报\n…\n## 相关记忆\n…\n## 分区共享知识\n…",
  "token_estimate": 318,
  "citations": ["mem_…"],
  "built_at": "2026-11-17T16:01:08.967Z"
}
```

`DreamStatus` / `DreamRun`：

```json
{
  "settings": { "enabled": true, "interval_minutes": 1440, "last_at": "2026-11-17T16:01:08.987Z" },
  "person_id": "prs_5ed57a3928ec4518",
  "pending_count": 0,
  "last_run": {
    "id": "drm_70d96dc203fb4ef6",
    "partition_id": "ptn_2c3dcb0f511c4c81",
    "person_id": "prs_5ed57a3928ec4518",
    "trigger": "manual",
    "status": "completed",
    "input_count": 1,
    "insight_count": 1,
    "summary": "已巩固 1 条记忆并生成 1 条洞见",
    "error": null,
    "started_at": "2026-11-17T16:01:08.986Z",
    "finished_at": "2026-11-17T16:01:08.987Z"
  },
  "runs": [
    { "id": "drm_70d96dc203fb4ef6", "status": "completed", "input_count": 1, "insight_count": 1 }
  ]
}
```

`trigger`：`manual` / `schedule`；`status`：`running` / `completed` / `skipped` / `failed`。

### 4.6 检索命中与信号（v6.1）

`POST /v1/partitions/:p/memories/search` 返回：

```json
{
  "hits": [
    {
      "id": "mem_3238ae7e145445c0",
      "content": "文档校验：用户喜欢先看结论再看细节",
      "scope": "person",
      "category": "preference",
      "importance": 0.9,
      "confidence": 0.85,
      "valid_from": "2026-11-17T16:01:05.801Z",
      "valid_to": null,
      "fact_key": "preference.tone",
      "score": 0.834,
      "signals": { "vector": 0.81, "keyword": 1, "recency": 0.66, "importance": 0.9, "entity": 0 },
      "matched_on": ["keyword", "vector"]
    }
  ],
  "took_ms": 4,
  "mode": "hybrid",
  "strategy": "hybrid:weighted",
  "results": [ { "id": "mem_3238ae7e145445c0", "content": "…" } ],
  "partition_stats": { "partition_id": "ptn_…", "memories_total": 14, "…": "…" }
}
```

| 字段 | 含义 |
| --- | --- |
| `hits[]` | v6.1 契约命中；每项是 `Memory` + `score` / `signals` / `matched_on` |
| `score` | 融合分 `Σ w_i * normalized(signal_i)`，0–1 |
| `signals.vector` | 与 query embedding 的余弦（候选未落 embedding 时为 0） |
| `signals.keyword` | 关键词相关度：整句子串命中=1；否则 CJK 二元组/单字覆盖 + 英文词命中 |
| `signals.recency` | 时效分（越新越高，按分区记忆时间分布归一化） |
| `signals.importance` | 记忆重要度 |
| `signals.entity` | 实体命中（P2；权重默认 0，可在 settings 调高） |
| `matched_on` | 实际命中的信号/字段，如 `keyword` / `vector` / `caption` |
| `mode` | 实际检索模式：`hybrid` / `keyword` / `vector` |
| `strategy` | 服务端策略说明（便于排障与 A/B） |
| `results` | **v6 兼容别名**，等价于 `hits` 去掉信号；旧客户端可继续使用 |

- 候选集上限：FTS 前缀 **300** + 该人最近 **200** + 同分区 `scope=partition` 最近 **200**，
  按 id 去重后做内存 cosine 重排（详见 [架构](architecture.md#42-检索v61)）。
- 请求参数：`query`、`person_id` / `person_external_id`、`scope`、`category`、`mode`、
  `top_k`（1–50，默认 8）、`as_of`（ISO）、`include_superseded`、`include_private`。
- `as_of`：只看该时间点有效的事实（`valid_from <= as_of AND (valid_to IS NULL OR valid_to > as_of)`）。
- `include_superseded=true`：把已失效/被取代的记忆也纳入候选（结果带 `valid_to` / `superseded_by`）。

### 4.7 记忆历史与反馈（v6.1）

历史 `GET /v1/partitions/:p/memories/:id/history`：

```json
{
  "items": [
    {
      "id": "hist_8f2c…",
      "partition_id": "ptn_2c3dcb0f511c4c81",
      "memory_id": "mem_3238ae7e145445c0",
      "person_id": "prs_5ed57a3928ec4518",
      "event": "SUPERSEDE",
      "old_content": "用户喜欢先看细节",
      "new_content": "用户喜欢先看结论再看细节",
      "actor": "user:usr_3df6cf54dba0455a",
      "reason": "superseded",
      "meta": { "supersededBy": "mem_3238ae7e145445c0" },
      "created_at": "2026-11-17T16:01:05.925Z"
    }
  ]
}
```

- `event`：`ADD` / `UPDATE` / `MERGE` / `SUPERSEDE` / `DELETE` / `NOOP` / `FEEDBACK` / `RESTORE`。
- 控制台 `GET /api/partitions/:p/memories/:id/history` 直接返回数组（无 `items` 包装）。

反馈 `POST /v1/partitions/:p/memories/:id/feedback`：

```bash
curl -s -X POST "$BASE/v1/partitions/mnemos-dev/memories/mem_3238ae7e145445c0/feedback" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"helpful":true,"query":"评审偏好","reason":"命中正确"}'
```

```json
{
  "memory": {
    "id": "mem_3238ae7e145445c0",
    "confidence": 0.85,
    "feedback_up": 3,
    "feedback_down": 0,
    "…": "…"
  }
}
```

- `helpful=true`：`feedback_up+1`、`confidence+0.05`；`false`：`feedback_down+1`、`confidence-0.05`；
  夹在 0.05–1，并写一条 `FEEDBACK` 历史。
- 反馈会改变后续检索排序中的 `importance/confidence` 信号。

### 4.8 结构化画像（v6.1 P1）

`GET /v1/partitions/:p/persons/:person/profile`（`?force=true` / `?refresh=true` 跳过缓存）：

```json
{
  "person": { "id": "prs_5ed57a3928ec4518", "external_id": "docs-user", "display_name": "文档校验用户" },
  "facts": [
    {
      "id": "fact_1a2b…",
      "partition_id": "ptn_2c3dcb0f511c4c81",
      "person_id": "prs_5ed57a3928ec4518",
      "key": "identity.job",
      "value": "产品经理",
      "confidence": 0.9,
      "valid_from": "2026-11-17T16:01:05.801Z",
      "valid_to": null,
      "source_memory_id": "mem_3238ae7e145445c0",
      "created_at": "2026-11-17T16:01:05.801Z",
      "updated_at": "2026-11-17T16:01:05.801Z"
    }
  ],
  "summary": "产品经理；偏好先看结论；关注评审。",
  "generated_at": "2026-11-17T16:01:08.954Z",
  "cached": false
}
```

- `facts` 为**当前有效**版本（`valid_to IS NULL`）；同 `key` 写入新值会关闭旧版本（保留历史）。
- 记忆 `metadata.factKey` 会被 profile 任务/画像读取自动沉淀为 fact（同值幂等，新值版本化）。
- `summary` 默认确定性拼接（≤800 字）；配置 `MNEMOS_LLM_*` 时优先 LLM，失败自动回退。

facts 维护：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `.../persons/:person/facts` | `{ items: PersonFact[] }`（当前有效） |
| `PUT` | `.../persons/:person/facts` | 单条 `{key,value,confidence?,source_memory_id?}` → `{fact}`；或 `{facts:[…]}`（≤100）→ `{items}` |
| `DELETE` | `.../persons/:person/facts/:factId` | 软关闭（`valid_to=now`，保留历史），204 |

### 4.9 实体关系图（v6.1 P2）

`GET /v1/partitions/:p/graph?person_id=&limit=100`：

```json
{
  "nodes": [
    { "id": "ent_1", "label": "Mnemos", "type": "project", "weight": 3, "memories": 2 },
    { "id": "ent_2", "label": "SQLite", "type": "tech", "weight": 1, "memories": 1 }
  ],
  "edges": [
    { "id": "rel_1", "source": "ent_1", "target": "ent_2", "relation": "co_occurs", "weight": 1 }
  ],
  "stats": {
    "nodes": 2,
    "edges": 1,
    "top_types": [{ "type": "project", "count": 1 }],
    "topTypes": [{ "type": "project", "count": 1 }]
  }
}
```

- 数据来自异步 `extract` 任务：规则抽取实体写 `entities` / `memory_entities`，
  同一记忆内的实体两两写 `relations(relation='co_occurs')`。
- `limit` 默认 100、最大 500；边只保留两端都在节点集内的关系。
- `topTypes` 是 `top_types` 的兼容别名（控制台使用）。

`GET /v1/partitions/:p/entities?q=&person_id=&limit=50`：

```json
{
  "items": [
    {
      "id": "ent_1",
      "name": "Mnemos",
      "type": "project",
      "mention_count": 3,
      "memories": 2,
      "created_at": "2026-11-17T16:01:05.801Z"
    }
  ],
  "next_cursor": null
}
```

- `q` 为子串匹配；`person_id` 过滤该人关联的实体；`limit` 默认 50、最大 200。

### 4.10 生命周期：合并 / 归档 / 导出 / 删除（v6.1 P1）

| 方法 | 路径 | 权限（v1） | 说明 |
| --- | --- | --- | --- |
| `POST` | `.../persons/:person/merge` | `admin` | body `{target_id}` 或 `{target_external_id}` |
| `POST` | `.../persons/:person/archive` | `memories:write` | 归档（`status=archived`，数据保留） |
| `GET` | `.../persons/:person/export` | `memories:read` | 合规导出 JSON |
| `DELETE` | `.../persons/:person?hard=true` | `admin` | 默认软删；`hard=true` 物理级联删除 |

合并响应：

```json
{
  "person": { "id": "prs_target", "external_id": "user-2", "…": "…" },
  "merged_from": { "id": "prs_source", "external_id": "user-1", "merged_into": "prs_target", "status": "archived", "…": "…" },
  "moved_memories": 12,
  "moved_facts": 3
}
```

- 合并迁移 `memories` / `person_facts` / `memory_feedback` / `memory_history` / `sessions`；
  同 `fact_key` 的重复当前事实只保留最新一条；源人 `status=archived` + `merged_into=target`。
- 之后用源人 id / external_id 读写会自动跟随到 canonical 人。
- 默认人列表排除已合并/已删除的人；`include_merged=true` 可包含已合并。

导出响应：

```json
{
  "person": { "…": "…", "consent": { "memory": true } },
  "facts": [ { "key": "identity.job", "value": "产品经理", "valid_to": null } ],
  "memories": [ { "id": "mem_…", "content": "…" } ],
  "exported_at": "2026-11-17T16:02:00.000Z",
  "truncated": false
}
```

- facts 含**历史版本**；memories 最多 **10000** 条，超出时 `truncated=true`。
- 软删：`status=deleted` + `deleted_at=now`，记忆/facts 保留（仍可导出/审计）。
- 硬删：级联删除该人的 memories（含 FTS/实体/历史/反馈）、facts、profile、sessions，再删人；
  控制台要求 owner，v1 要求 `admin` 作用域 key。

---

## 5. 公开 v1 API（API Key）

所有路径前缀：`/v1/partitions/:partition`。下表「作用域」是该路由要求的 API Key 作用域。

### 5.1 分区

| 方法 | 路径 | 作用域 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/v1/partitions` | `admin` + **org key** | 按 slug 幂等 upsert；返回分区（含 `stats`） |
| `GET` | `/v1/partitions` | `memories:read` + **org key** | 本组织分区列表（每个带 `stats`） |
| `GET` | `/v1/partitions/:partition` | `memories:read` | 分区信息（**不含** `stats`） |
| `PATCH` | `/v1/partitions/:partition` | `admin` | 更新 name/description/status/settings |
| `GET` | `/v1/partitions/:partition/stats` | `memories:read` | 分区统计（单行主键查询） |

创建/更新分区：

```bash
curl -s -X POST "$BASE/v1/partitions" \
  -H "authorization: Bearer $ORG_KEY" -H 'content-type: application/json' \
  -d '{"slug":"zhiwu-app","name":"知物感恩 App","settings":{"default_scope":"person","brief_max_chars":800}}'
```

- `settings` 只传要改的字段（部分更新）；未传字段保留原值/默认值。
- 分区 key 调用 `POST /v1/partitions` → `403`（需要 org key）。

### 5.2 人

| 方法 | 路径 | 作用域 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/partitions/:p/persons` | `memories:read` | 游标列表；`cursor/limit/q/type/status/sort` |
| `PUT` | `/v1/partitions/:p/persons/:externalId` | `memories:write` | 按 `(type, external_id)` 幂等建档/更新 |
| `GET` | `/v1/partitions/:p/persons/:person` | `memories:read` | 详情；`person` = 内部 id 或 external_id |
| `PATCH` | `/v1/partitions/:p/persons/:person` | `memories:write` | 更新 display_name/attributes/status/type/consent |
| `GET` | `/v1/partitions/:p/persons/:person/profile` | `memories:read` | 画像 + 当前 facts + 摘要（`force` / `refresh`） |
| `GET` | `/v1/partitions/:p/persons/:person/facts` | `memories:read` | 当前有效 facts |
| `PUT` | `/v1/partitions/:p/persons/:person/facts` | `memories:write` | 单条或批量写 facts（版本化） |
| `DELETE` | `/v1/partitions/:p/persons/:person/facts/:factId` | `memories:write` | 软关闭 fact（204） |
| `POST` | `/v1/partitions/:p/persons/:person/merge` | `admin` | 合并到目标人（迁移 memories/facts/feedback） |
| `POST` | `/v1/partitions/:p/persons/:person/archive` | `memories:write` | 归档（数据保留可读） |
| `GET` | `/v1/partitions/:p/persons/:person/export` | `memories:read` | 合规导出（person + facts + ≤10000 记忆） |
| `DELETE` | `/v1/partitions/:p/persons/:person` | `admin` | 默认软删；`?hard=true` 物理级联删除（204） |
| `GET` | `/v1/partitions/:p/persons/:person/memories` | `memories:read` | 该人记忆：游标 + `scope/category/status/q` |
| `POST` | `/v1/partitions/:p/persons/:person/memories` | `memories:write` | 写记忆（见 5.4） |
| `GET` | `/v1/partitions/:p/persons/:person/brief` | `memories:read` | 人级简报（见 5.5） |
| `POST` | `/v1/partitions/:p/persons/:person/context` | `memories:read` | 人级上下文（见 5.5） |
| `GET` | `/v1/partitions/:p/persons/:person/dream` | `memories:read` | 人级做梦状态 |
| `POST` | `/v1/partitions/:p/persons/:person/dream/run` | `memories:write` | 手动触发人级做梦 |

建设/更新人：

```bash
curl -s -X PUT "$BASE/v1/partitions/zhiwu-app/persons/user-123" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"human","display_name":"用户 123","attributes":{"channel":"ios"}}'
```

- 路径上的 `externalId` 优先；body 里 `external_id` 可省略。
- `type` 默认 `human`；已存在同 `(type, external_id)` 时更新展示名/属性/状态并刷新 `last_seen_at`。
- `PATCH` 允许改 `type`；改成已存在的 `(type, external_id)` 组合返回 `409 CONFLICT`。
- v6.1：`PUT` / `PATCH` 均可写 `consent`（整体覆盖，写审计 `person.consent`）；列表查询新增
  `include_merged=true`（默认排除已合并/已删除的人）。

### 5.3 记忆列表 / 详情 / 管理

| 方法 | 路径 | 作用域 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/partitions/:p/memories` | `memories:read` | 分区记忆列表；`person_id`/`person_external_id`/`scope`/`category`/`status`/`q`/`cursor`/`limit` |
| `POST` | `/v1/partitions/:p/memories/search` | `memories:read` | v6.1 混合检索（`hits`/`signals`/`mode`/`strategy`；`results` 兼容） |
| `GET` | `/v1/partitions/:p/memories/:id/history` | `memories:read` | 变更历史时间线 |
| `POST` | `/v1/partitions/:p/memories/:id/feedback` | `memories:write` | 检索反馈（`helpful`） |
| `GET` | `/v1/partitions/:p/memories/:id` | `memories:read` | 详情：`{ memory, person }`（含附件明细）；`?reveal=placeholders`（或 `reveal=true`）返回解密占位符 |
| `PATCH` | `/v1/partitions/:p/memories/:id` | `memories:write` | 更新 content/category/importance/confidence/status/tags/metadata/expires_at |
| `DELETE` | `/v1/partitions/:p/memories/:id` | `memories:write` | 删除，返回 `204`（无响应体） |

检索（v6.1 混合检索）：

```bash
curl -s -X POST "$BASE/v1/partitions/mnemos-dev/memories/search" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"data-v6","mode":"hybrid","top_k":3,"as_of":"2026-11-17T00:00:00.000Z"}'
```

```json
{
  "hits": [
    {
      "id": "mem_4b40fcd0833b4b63",
      "partition_id": "ptn_2c3dcb0f511c4c81",
      "person_id": "prs_099a48a45bc84924",
      "person_external_id": "mnemos-team",
      "scope": "partition",
      "category": "fact",
      "content": "v6 使用 data-v6/ 作为数据目录，旧 data/ 不迁移。",
      "importance": 0.9,
      "source": "import",
      "status": "active",
      "valid_from": "2026-11-17T16:01:05.801Z",
      "valid_to": null,
      "fact_key": null,
      "score": 0.87,
      "signals": { "vector": 0.8, "keyword": 1, "recency": 0.4, "importance": 0.9, "entity": 0 },
      "matched_on": ["keyword", "vector"]
    }
  ],
  "took_ms": 4,
  "mode": "hybrid",
  "strategy": "hybrid:weighted",
  "results": [ { "id": "mem_4b40fcd0833b4b63", "content": "v6 使用 data-v6/ 作为数据目录，旧 data/ 不迁移。" } ],
  "partition_stats": {
    "partition_id": "ptn_2c3dcb0f511c4c81",
    "persons_total": 5,
    "persons_human": 1,
    "persons_agent": 3,
    "persons_service": 1,
    "memories_total": 14,
    "shared_total": 12,
    "sessions_total": 0,
    "updated_at": "2026-11-17T16:01:08.986Z"
  }
}
```

- `query` 必填（1–2000 字符）；`top_k` 1–50，默认 8。
- `person_id` / `person_external_id` 是**作者过滤**；`as_of` 做时序回看；`include_superseded`
  控制是否包含已失效记忆；`include_private` 为人级视角（本人 + 分区共享）。
- `results` 是 v6 兼容字段（DSH 插件旧版使用）；新代码请读 `hits`。

### 5.4 写入记忆

`POST /v1/partitions/:partition/persons/:person/memories`，`person` 支持内部 id 或 external_id。
**路径上的人必须已存在**：v1 不会在写记忆时自动建人，未知人返回 `404 NOT_FOUND`；
请先 `PUT /v1/partitions/:p/persons/:externalId` 建档（或由人的同步流程建档）。

```bash
curl -s -X POST "$BASE/v1/partitions/zhiwu-app/persons/user-123/memories" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"用户 123 喜欢黑咖啡，不加糖","scope":"person","category":"preference","importance":0.8,"tags":["drink"]}'
```

隐私占位符（v6.2）：正文只写 `{{key}}`，真实值放 `placeholders`：

```bash
curl -s -X POST "$BASE/v1/partitions/zhiwu-app/persons/user-123/memories" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "content": "张三的手机号是 {{phone_a1b2}}，邮箱是 {{mail_c3d4}}。",
    "placeholders": {
      "phone_a1b2": "18334423321",
      "mail_c3d4": "zhangsan@example.com"
    },
    "scope": "person"
  }'
```

请求体：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` / `content` | string(1–20000) | 二选一；`messages` 与二者至少给一个 |
| `messages` | `[{role, content}]` | 最多 50 条；`system` 消息会被忽略，其余按行拼接 |
| `scope` | `person`/`partition`/`session` | 缺省取分区 `default_scope` |
| `session_id` | string(≤128) | `scope=session` 时必填；全局唯一，跨分区/跨人复用返回 409 |
| `session_title` | string(≤200) | 首次创建会话时的标题 |
| `category` | 枚举 | 默认 `fact` |
| `importance` / `confidence` | number 0–1 | 默认 0.5 / 0.8 |
| `source` | 枚举 | 默认 `api` |
| `tags` | string[]（≤20，每个≤64） | 默认 `[]` |
| `metadata` | object | 默认 `{}` |
| `placeholders` | object | **v6.2** 隐私占位符映射：正文写 `{{key}}`（key 为 `[A-Za-z0-9_-]{3,64}`），真实值放这里；正文只存 token，映射加密保存（见 6.3） |
| `expires_at` | ISO/null | 过期时间 |
| `supersedes_id` | string(≤128) | **v6.1** 显式取代某条记忆（旧记忆 `valid_to=now`） |
| `fact_key` | string(≤120) | **v6.1** 事实槽位键；同 key 新写入自动取代旧事实 |
| `valid_from` | ISO | **v6.1** 事实生效时间（缺省=now） |
| `attachments` | `[{kind,url,mime?,size?,caption?}]` | **v6.1 P2** 多模态附件（≤10；`url` ≤2000；`caption` ≤1000） |
| `infer` / `mode` | — | **接受但忽略**（不做 LLM 事实抽取） |

写接口支持 `Idempotency-Key` 请求头（24h 幂等回放，见第 1 节）。同一 key 重放返回首次状态码；
若首次是 `ADD`（201），重放仍是 201；`MERGE` / `NOOP` / `SUPERSEDE` 返回 200。

响应 `ADD`（201）：

```json
{
  "memory": { "…": "Memory" },
  "event": "ADD",
  "superseded_id": null,
  "events": [{ "type": "ADD", "memory_id": "mem_3238ae7e145445c0", "at": "2026-11-17T16:01:05.801Z" }]
}
```

响应 `SUPERSEDE` / `MERGE` / `NOOP`（200）：

```json
{
  "memory": { "id": "mem_new", "…": "Memory", "supersedes": "mem_old", "fact_key": "preference.tone" },
  "event": "SUPERSEDE",
  "superseded_id": "mem_old",
  "events": [{ "type": "SUPERSEDE", "memory_id": "mem_new", "at": "2026-11-17T16:01:05.801Z" }]
}
```

- `NOOP`：完全重复（`normalized_hash` 相同）或余弦 ≥ `dedupe_threshold`；返回已有记忆，不新增。
- `MERGE`：余弦 ≥ `merge_threshold`；更新已有记忆的内容/重要度/标签/metadata，返回合并后的记忆。
- `SUPERSEDE`：显式 `supersedes_id` 或相同 `fact_key`；旧记忆被关闭，新记忆记录 `supersedes`。
- PII / 隐私规则（v6.2）：`settings.pii_redaction=basic` 时写入执行规则域的正则规则（落库前脱敏）；
  `settings.privacy_llm_enabled=true` 时另外异步执行 `kind=prompt` 规则。主动抽离时传 `placeholders`，
  正文只落 `{{key}}` token；详情需 `?reveal=placeholders` 才解密。详见[第 6 节](#6-隐私规则域v62)。

带附件与演化字段的写入示例：

```bash
curl -s -X POST "$BASE/v1/partitions/zhiwu-app/persons/user-123/memories" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H "Idempotency-Key: write-user-123-language-1" \
  -d '{"text":"用户 123 偏好简洁的中文评审意见","scope":"person","category":"preference","fact_key":"preference.language","attachments":[{"kind":"image","url":"https://cdn.example.com/board.png","caption":"评审白板"}]}'
```

校验失败示例（`scope=session` 缺 `session_id`，引擎错误码是 `VALIDATION`）：

```json
{ "error": { "code": "VALIDATION", "message": "scope=session 时必须提供 session_id", "requestId": "req_…" } }
```

### 5.5 人级简报 / 上下文 / 做梦

**简报** `GET .../persons/:person/brief?max_chars=400&force=true`

- `max_chars` 100–5000，缺省取分区 `brief_max_chars`；`force=true` 跳过缓存重算。
- 来源：本人 `person/session` 记忆 + 相关分区共享记忆，按 importance/时间取最近 100 条。
- 响应：`MemoryBrief`（见 4.5）。

**上下文** `POST .../persons/:person/context`

```bash
curl -s -X POST "$BASE/v1/partitions/zhiwu-app/persons/user-123/context" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"咖啡","budget_tokens":800,"include_partition":true}'
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `query` | 空 | 用 FTS 缩小相关记忆（≤2000 字符） |
| `budget_tokens` | 2000 | 60–32000；内部按 `tokens × 4` 截断字符 |
| `include_partition` | true | 是否带分区共享知识 |

**做梦**：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `.../persons/:person/dream` | 状态：设置、待巩固数、最近 10 次运行 |
| `POST` | `.../persons/:person/dream/run` | body `{"batch_size":50}`（1–200，默认 50） |
| `GET` | `/v1/partitions/:p/dream` | 分区级状态 |
| `POST` | `/v1/partitions/:p/dream/run` | 分区级手动做梦 |

- 同一 `partition + person` 同时只允许一次做梦，重复触发返回 `409 DREAM_RUNNING`。
- 没有待巩固记忆时返回 `status = "skipped"`，不产生洞见。
- 分区级洞见归属系统人 `mnemos-dream`（`type=service`，不存在时自动创建）。

### 5.6 实体 / 关系图（v6.1 P2）

| 方法 | 路径 | 作用域 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/partitions/:p/graph` | `memories:read` | `person_id`（可选）、`limit`（1–500，默认 100） |
| `GET` | `/v1/partitions/:p/entities` | `memories:read` | `person_id`、`q`、`limit`（1–200，默认 50） |

```bash
curl -s "$BASE/v1/partitions/mnemos-dev/graph?limit=20" -H "authorization: Bearer $KEY"
curl -s "$BASE/v1/partitions/mnemos-dev/entities?q=SQLite&limit=20" -H "authorization: Bearer $KEY"
```

- 数据由写入后的异步 `extract` 任务生成（`settings.auto_extract_entities` 开启时）；
  刚写入的记忆可能短暂没有图数据，可等 1s worker tick 或 `POST /api/ops/jobs/tick`。
- 响应形状与含义见 [4.9](#49-实体关系图v61-p2)。

---

## 6. 隐私规则域（v6.2）

> 契约：[`privacy-rules.md`](privacy-rules.md)。把 PII 脱敏从写死的 `basic` 逻辑升级为可维护的规则域：
> **全局规则 + 分区规则**，每类规则支持 **正则（直接扫描）** 与 **提示词（LLM 抽取）**；
> 写入支持**占位符 + 映射表**的隐私抽离协议；记忆整理（dream）同时执行规则与 LLM 隐私抽取。
>
> 实现状态：schema v8 `privacy_rules` / `memory_placeholders` 已上线，HTTP 端点已实现（规则 CRUD、preview、rescan、reveal）。
> 请求 / 响应形状以 `privacy-rules.md` 与 `shared/src/types.ts` 为准，联调后如有调整会同步本文。

### 6.1 PrivacyRule 字段

`/api` 返回 camelCase（下表）；`/v1` 返回 snake_case（`partition_id`、`entity_type`、`mask_mode`、
`mask_keep_last`、`mask_keep_first`、`created_at`、`updated_at`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 规则 id |
| `scope` | `global` / `partition` | 全局规则 / 分区规则 |
| `partitionId` | string? | `scope=partition` 时必填；`global` 为空 |
| `code` | string | 规则编码：`email` / `phone` / `id_card` / `bank_card` / `name` / `address` / `credential` / `medical` / 自定义 |
| `name` | string | 展示名 |
| `kind` | `regex` / `prompt` | 正则扫描 / 提示词 LLM 抽取 |
| `pattern` | string? | `kind=regex` 的正则源码 |
| `flags` | string | 正则 flags，默认 `g` |
| `instruction` | string? | `kind=prompt` 时告诉 LLM 抽取什么 |
| `entityType` | string | 实体类型（`email` / `phone` / `name` / …） |
| `action` | `mask` / `placeholder` | 命中后打码 / 生成占位符并记录映射 |
| `maskMode` | `email` / `keepFirstLast` / `keepLast` / `full` | 打码方式（`action=mask`） |
| `maskKeepFirst` / `maskKeepLast` | number | `keepFirstLast` 保留位数（默认 0 / 4） |
| `enabled` | boolean | 是否启用 |
| `priority` | number | 执行顺序，小者先（默认 100） |
| `builtin` | boolean | 全局内置规则（不可删除，可覆盖 / 禁用） |
| `createdAt` / `updatedAt` | ISO | 时间 |

- 生效规则 = `global` 规则 + 该分区 `partition` 规则；同 `code` 时分区规则覆盖全局规则；
  按 `priority` 升序执行，同 code 只保留一条。
- 全局内置 regex：`email / id_card / phone / bank_card`（默认启用）；
  全局内置 prompt：`name / address / credential / medical`（默认禁用，分区按需开启并需配置 LLM）。
- 写入 / 更新入参（`PrivacyRuleInput`）：`code?`、`name`、`kind`、`pattern?`、`flags?`、
  `instruction?`、`entityType?`、`action?`、`maskMode?`、`maskKeepLast?`、`maskKeepFirst?`、`enabled?`、`priority?`。

### 6.2 开关与扫描

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `piiRedaction`（`pii_redaction`） | `off` | 总开关；`basic` 时执行规则（regex + 已启用的 prompt 规则） |
| `privacyLlmEnabled`（`privacy_llm_enabled`） | `false` | 是否执行 `kind=prompt` 规则；需可用 LLM，失败静默回退 regex |

- 显式提交 `placeholders` 时，即使总开关 `off` 也保存（调用方主动抽离）。
- 写入 / 更新后异步入队 `privacy` job；`dream` 整理时同步扫描输入记忆；
  `memories.privacy_scanned_at` 防重复扫描；规则变更后可调 rescan 重扫。
- regex 规则按 `priority` 执行，已替换片段（`*` 或 `{{token}}`）不会被后续规则重复命中；
  prompt 规则由 LLM 返回 `{entities:[{code,value}]}`，服务端校验 value 确实出现在原文中（防幻觉）。

### 6.3 占位符协议（写入抽离）

```json
{
  "content": "张三的手机号是 {{phone_a1b2}}，邮箱是 {{mail_c3d4}}。",
  "placeholders": {
    "phone_a1b2": "18334423321",
    "mail_c3d4": "zhangsan@example.com"
  },
  "scope": "person"
}
```

- token 格式 `{{key}}`；key 为 `[A-Za-z0-9_-]{3,64}`。
- 正文里的每个 token 都必须有映射；映射中存在但正文未使用 → 忽略。
- 值存入 `memory_placeholders`（AES-256-GCM，密钥 `MNEMOS_ENCRYPTION_KEY`；未配置时明文并标
  `encrypted=0`）；记忆正文**只保存 token**（不落明文），`metadata.placeholderCount` 为数量。
- 读取：
  - 列表 / 搜索只返回 `placeholder_count` / `metadata.placeholderCount`；
  - 详情默认返回占位符 keys：`placeholders: [{placeholder, kind, encrypted}]`；
  - `?reveal=placeholders`（或 `reveal=true`）返回解密值，需 `memories:read`；
  - `brief` / `context` 在服务端把 token 替换为真实值后再生成提示词（否则 LLM 无法使用）。
- 工具 / SDK 文档：DSH 插件与 MCP 的 `mnemos_add`、TS `MemoryInput.placeholders`、
  Python `memories.add(placeholders=...)` 均声明该协议（隐私值放映射，正文只写占位符）。

### 6.4 端点

隐私规则（控制台 `/api`，会话鉴权）：

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/privacy/rules?scope=global\|partition&partition_id=` | viewer+ | 读规则；global 需 org 成员，partition 需分区可见 |
| `POST` | `/api/privacy/rules` | global=owner / partition=admin | 新建规则 |
| `PATCH` | `/api/privacy/rules/:id` | 同上 | 部分更新（`pattern` / `instruction` / `action` / `enabled` / `priority` …） |
| `DELETE` | `/api/privacy/rules/:id` | 同上 | 删除；`builtin` 不可删（可禁用 / 覆盖） |
| `POST` | `/api/privacy/preview` | 分区 viewer+ | 试跑规则，不落库：`{partitionId, text}` → `PrivacyScanResult` |
| `POST` | `/api/partitions/:p/privacy/rescan` | 分区 admin | 重扫已有记忆：`{personId?, limit?}` |

公开 v1：

| 方法 | 路径 | 作用域 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/partitions/:p/privacy/rules` | `memories:read` | 读该分区生效规则（global + 分区合并结果） |
| `GET` | `/v1/partitions/:p/memories/:id?reveal=placeholders` | `memories:read` | 记忆详情 + 解密后的占位符值 |

新建一条分区 regex 规则（控制台）：

```bash
curl -s -X POST "$BASE/api/privacy/rules" \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{
    "scope": "partition",
    "partitionId": "ptn_2c3dcb0f511c4c81",
    "code": "employee_id",
    "name": "工号",
    "kind": "regex",
    "pattern": "EMP-\\d{6}",
    "entityType": "employee_id",
    "action": "mask",
    "maskMode": "keepLast",
    "maskKeepLast": 4,
    "enabled": true,
    "priority": 50
  }'
```

响应（`PrivacyRule`，节选；camelCase）：

```json
{
  "id": "prv_…",
  "scope": "partition",
  "partitionId": "ptn_2c3dcb0f511c4c81",
  "code": "employee_id",
  "name": "工号",
  "kind": "regex",
  "pattern": "EMP-\\d{6}",
  "flags": "g",
  "entityType": "employee_id",
  "action": "mask",
  "maskMode": "keepLast",
  "maskKeepLast": 4,
  "maskKeepFirst": 0,
  "enabled": true,
  "priority": 50,
  "builtin": false,
  "createdAt": "2026-11-18T10:00:00.000Z",
  "updatedAt": "2026-11-18T10:00:00.000Z"
}
```

试跑（`POST /api/privacy/preview`，不落库）：

```bash
curl -s -X POST "$BASE/api/privacy/preview" \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"partitionId":"ptn_2c3dcb0f511c4c81","text":"联系 13800138000 或 zhangsan@example.com"}'
```

响应 `PrivacyScanResult`（示例，`start/end` 偏移以实际文本为准）：

```json
{
  "text": "联系 138****8000 或 z***@example.com",
  "redacted": true,
  "hits": [
    { "code": "phone", "entityType": "phone", "value": "13800138000", "start": 3, "end": 14, "action": "mask" },
    { "code": "email", "entityType": "email", "value": "zhangsan@example.com", "start": 18, "end": 38, "action": "mask" }
  ],
  "placeholders": {}
}
```

读取占位符映射（详情默认不含 `value`，`reveal` 才解密）：

```bash
curl -s "$BASE/v1/partitions/zhiwu-app/memories/mem_3238ae7e145445c0?reveal=placeholders" \
  -H "authorization: Bearer $KEY"
```

```json
{
  "memory": {
    "id": "mem_3238ae7e145445c0",
    "content": "张三的手机号是 {{phone_a1b2}}，邮箱是 {{mail_c3d4}}。",
    "placeholder_count": 2
  },
  "person": { "id": "prs_…", "external_id": "user-123" },
  "placeholders": [
    { "placeholder": "phone_a1b2", "kind": "phone", "encrypted": true, "value": "18334423321" },
    { "placeholder": "mail_c3d4", "kind": "email", "encrypted": true, "value": "zhangsan@example.com" }
  ]
}
```

重扫历史记忆（规则变更后；也可用 `POST /api/ops/jobs/tick` 触发 `privacy` job）：

```bash
curl -s -X POST "$BASE/api/partitions/ptn_2c3dcb0f511c4c81/privacy/rescan" \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"personId":"prs_5ed57a3928ec4518","limit":100}'
```

响应返回本次扫描 / 变更计数（示例：`{ "scanned": 100, "changed": 3, "placeholders": 4 }`，字段以实现为准）。

### 6.5 限制与实现说明

- **加密可选**：未配置 `MNEMOS_ENCRYPTION_KEY` 时占位符值明文存储（`encrypted=false`），仅适合本地开发；
  生产必须配置。记忆正文本身不入加密（保护 FTS），靠「正文只存 token」隔离。
- **prompt 规则依赖 LLM**：LLM 不可用 / 超时静默跳过，不阻塞写入；结果会校验 value 确实出现在原文中。
- **异步扫描有延迟**：写入后由 worker tick 执行；刚写入的记忆可能尚未脱敏，规则变更后需 rescan 覆盖历史。
- **规则隔离**：global 规则跨分区生效但仅 owner 可写；分区规则只影响本分区，不能读取其它分区。
- **明文永不进列表 / 搜索**：`reveal` 需 `memories:read`；列表 / 搜索 / 导出只返回 token 或计数。
- **与旧 `basic` 兼容**：`pii_redaction=basic` 继续生效，规则域可覆盖 / 禁用内置规则。

---

## 7. 控制台 API（`/api`，会话鉴权）

与 v1 同构，camelCase。权限沿用组织角色：viewer 读、developer 写、admin 管理密钥/设置、
owner 管理组织与组织级 Key。

### 7.1 登录 / 会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | `{email,password}` → `{token,user,org}` |
| `PATCH` | `/api/auth/password` | `{currentPassword,newPassword}`；新密码 ≥10 位且含字母+数字 |
| `POST` | `/api/auth/logout` | 删除当前会话 |
| `GET` | `/api/auth/me` | `{user, org, partitions}` |
| `GET` | `/api/auth/demo-accounts` | 演示账号列表（仅 `MNEMOS_DEMO=1`，否则 `[]`；含明文密码，供登录页一键填充） |
| `GET` | `/api/auth/wecom/mock` | 企业微信 Mock 配置（仅开发/测试；未启用返回 404） |
| `POST` | `/api/auth/wecom/mock/login` | 企业微信 Mock 一键登录 → `{token,user,org}`（以 `admin@mnemos.dev` 演示管理员身份，写审计 `auth.login.wecom_mock`） |

登录失败/锁定：

- 连续 `MNEMOS_LOGIN_MAX_ATTEMPTS`（默认 5）次密码错误后账号被锁定 15 分钟：第 5 次仍返回
  **401**（`details.locked=true`），**之后的尝试**返回 **423**，`code = account_locked`，带 `details.retryAfter`。
- 登录接口另有 30 次/分钟/IP 限流，超限 **429**，`code = login_rate_limited`。
- 账号禁用返回 **403**，`code = account_disabled`。
- 会话令牌只存 SHA-256；默认有效期 `MNEMOS_SESSION_TTL_HOURS`（72h）。

### 7.2 分区 / 人 / 记忆

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/partitions` | viewer | 分区列表（带 `stats`） |
| `POST` | `/api/partitions` | admin | 建分区（201） |
| `GET` | `/api/partitions/:partition` | viewer | 分区详情（带 `stats`） |
| `PATCH` | `/api/partitions/:partition` | admin | 更新分区（带 `stats` 返回） |
| `GET` | `/api/partitions/:partition/stats` | viewer | 统计 |
| `POST` | `/api/partitions/:partition/reconcile` | admin | 重算计数（批量导入后） |
| `GET` | `/api/partitions/:partition/persons` | viewer | 人列表（游标，`q/type/status/sort`） |
| `PUT` | `/api/partitions/:partition/persons/:externalId` | developer | 建档/更新人 |
| `GET` | `/api/partitions/:partition/persons/:person` | viewer | 人详情 |
| `PATCH` | `/api/partitions/:partition/persons/:person` | developer | 更新 `displayName/attributes/status/consent`（**不能改 type/externalId**） |
| `GET` | `/api/partitions/:p/persons/:person/profile` | viewer | 画像 + facts + 摘要（`force`/`refresh`） |
| `GET` | `/api/partitions/:p/persons/:person/facts` | viewer | 当前有效 facts |
| `PUT` | `/api/partitions/:p/persons/:person/facts` | developer | 单条 / 批量写 facts |
| `DELETE` | `/api/partitions/:p/persons/:person/facts/:factId` | developer | 软关闭 fact（204） |
| `POST` | `/api/partitions/:p/persons/:person/merge` | admin | 合并到目标人（body `targetId` / `targetExternalId`） |
| `POST` | `/api/partitions/:p/persons/:person/archive` | developer | 归档 |
| `GET` | `/api/partitions/:p/persons/:person/export` | viewer | 导出 JSON（含 facts 历史 + `truncated`） |
| `DELETE` | `/api/partitions/:p/persons/:person` | admin（`hard=true` 需 owner） | 软删 / 硬删（204） |
| `GET` | `/api/partitions/:p/graph` | viewer | 实体关系图（`personId`/`limit`） |
| `GET` | `/api/partitions/:p/entities` | viewer | 实体列表（`personId`/`q`/`limit`） |
| `GET` | `/api/partitions/:partition/persons/:person/memories` | viewer | 该人记忆（游标 + scope/category/q） |
| `POST` | `/api/partitions/:partition/persons/:person/memories` | developer | 写记忆，返回 `{ memory }`（无 events）；隐私值用 body `placeholders` |
| `GET` | `/api/partitions/:partition/memories` | viewer | 分区记忆（`personId`/`scope`/`category`/`q`/游标） |
| `POST` | `/api/partitions/:p/memories/search` | viewer | v6.1 检索：返回 `{hits,took_ms,mode,strategy,took_ms}`（camelCase 响应） |
| `GET` | `/api/partitions/:p/memories/:id/history` | viewer | 历史数组（camelCase） |
| `POST` | `/api/partitions/:p/memories/:id/feedback` | developer | `{helpful,query?,reason?}` → `{memory}` |
| `GET` | `/api/partitions/:partition/memories/:id` | viewer | `{ memory, person }`（含附件明细） |
| `PATCH` | `/api/partitions/:partition/memories/:id` | developer | `{ memory }` |
| `DELETE` | `/api/partitions/:partition/memories/:id` | developer | 204 |

`GET /api/partitions/:partition` **带 `stats`**（v1 的同一路径不带），这是两套入口唯一的形状差异之一。
隐私规则读写、`preview`、`rescan` 见 [6.4](#64-端点)。

### 7.3 人级简报 / 上下文 / 做梦（控制台）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/partitions/:p/persons/:person/brief` | viewer | query：`force`、`maxChars` |
| `POST` | `/api/partitions/:p/persons/:person/context` | viewer | body：`query`、`budgetTokens`、`includePartition` |
| `GET` | `/api/partitions/:p/persons/:person/dream` | viewer | 状态 |
| `POST` | `/api/partitions/:p/persons/:person/dream/run` | developer | body：`batchSize` |
| `GET` | `/api/partitions/:p/dream` | viewer | 分区级状态 |
| `POST` | `/api/partitions/:p/dream/run` | developer | 分区级手动做梦 |

### 7.4 用量 / 审计 / 密钥（分区）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/partitions/:p/usage?days=30` | viewer | `days` 1–90；返回 points/byOperation/byChannel/byKey/latency/totals |
| `GET` | `/api/partitions/:p/audit` | viewer | 游标列表（`cursor/limit`） |
| `GET` | `/api/partitions/:p/keys` | admin | 分区 key 列表（不含 secret） |
| `POST` | `/api/partitions/:p/keys` | admin | 创建；`{name,scopes,rateLimitPerMin?,expiresAt?,allowedIps?}`；响应含一次性 `secret` |
| `POST` | `/api/partitions/:p/keys/:id/rotate` | admin | `{graceHours}`（0–168，仅审计）；**旧 key 立即吊销** |
| `DELETE` | `/api/partitions/:p/keys/:id` | admin | 吊销，204 |

### 7.5 组织 / 组织级密钥 / 运维

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/org` | viewer | `{ org, counts: { users, partitions } }` |
| `GET` | `/api/org/users` | admin | 账号列表（含 `activeSessions`） |
| `POST` | `/api/org/users` | admin | `{email,name,role,title?,password?}` → `{user,temporaryPassword}` |
| `PATCH` | `/api/org/users/:id` | admin | 改 role/status/name/title；不能禁用自己 |
| `POST` | `/api/org/users/:id/reset-password` | admin | 返回一次性临时密码，并清理该用户全部会话 |
| `GET` | `/api/org/keys` | owner | 组织级 key 列表 |
| `POST` | `/api/org/keys` | owner | 创建组织级 key；响应含一次性 `secret` |
| `DELETE` | `/api/org/keys/:id` | owner | 吊销，204 |
| `GET` | `/api/ops/status` | admin | 运行状态（版本/uptime/DB 文件与 WAL/schema/计数/配额/保留期/备份/维护/指标） |
| `GET` | `/api/ops/maintenance` | admin | 维护历史 `?limit=20` |
| `POST` | `/api/ops/maintenance` | admin | `{dryRun?,vacuum?}` |
| `POST` | `/api/ops/jobs/tick` | admin | 手动跑一批异步任务 `{limit?}`（默认 10），返回 `{claimed,done,failed,at}` |
| `POST` | `/api/ops/backup` | admin | 立即在线备份（`VACUUM INTO`） |
| `GET` | `/api/ops/backups` | admin | 备份列表 |
| `GET` | `/api/ops/backups/:file` | admin | 下载备份（文件名白名单） |

> 组织级 key 的创建 body 与分区 key 相同（`name/scopes/rateLimitPerMin/expiresAt/allowedIps`），
> 不绑定分区。

---

## 8. 健康检查与运维端点

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/health` | 无 | 详细健康：`{ok,version,uptimeMs,schemaVersion,db,node}`；DB 异常 503 |
| `GET` | `/api/health` | 无 | 同上（控制台用） |
| `GET` | `/healthz` | 无 | 存活探针：`{ok:true}` |
| `GET` | `/readyz` | 无 | 就绪探针：DB 可查询 → 200；否则 503 `{ok:false}` |
| `GET` | `/metrics` | 无（内网） | Prometheus 文本；`MNEMOS_METRICS_ENABLED=0` 时 404 |

探针不要暴露公网；`/metrics` 未鉴权，建议只在内网抓取。

---

## 9. 错误码

`code` 为稳定标识；同一 HTTP 状态可能对应多个 code。

| HTTP | code | 典型场景 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 缺路径参数、请求不合法 |
| 400 | `VALIDATION_ERROR` | zod 形状/范围校验失败（HTTP 层） |
| 400 | `VALIDATION` | 引擎业务校验（如 `scope=session` 缺 `session_id`） |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 400 | `INVALID_CURSOR` | 游标非法/过期，或与当前 `sort` 不匹配 |
| 401 | `UNAUTHORIZED` | 缺会话/令牌、会话过期、密码错误 |
| 401 | `INVALID_API_KEY` | 缺 API Key、格式不对、Key 不存在 |
| 401 | `API_KEY_REVOKED` | Key 已被吊销 |
| 401 | `KEY_EXPIRED` | Key 已过期 |
| 401 | `ACCOUNT_DISABLED` | 会话鉴权时账号已被禁用 |
| 403 | `account_disabled` | 登录时账号已被禁用（带 `details`） |
| 403 | `FORBIDDEN` | 缺作用域/角色、分区归档、分区 key 越权建分区 |
| 403 | `IP_NOT_ALLOWED` | 来源 IP 不在 Key 白名单 |
| 403 | `PARTITION_ARCHIVED` | 向已归档分区写入 |
| 404 | `NOT_FOUND` | 分区/人/记忆不存在（跨组织统一 404） |
| 405 | `METHOD_NOT_ALLOWED` | 路径存在但不支持该 HTTP 方法 |
| 409 | `CONFLICT` | 唯一键冲突（如人的 type/external_id、session 跨分区）；也用于 `Idempotency-Key` 复用到不同方法/路径/请求体 |
| 409 | `DREAM_RUNNING` | 同一分区/人正在做梦 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过上限 |
| 423 | `account_locked` | 登录失败次数过多（带 `details.retryAfter`） |
| 429 | `RATE_LIMITED` | API Key 每分钟限流 |
| 429 | `QUOTA_EXCEEDED` | 分区月配额超限（带 `details` 与 `retry-after`） |
| 429 | `login_rate_limited` | 登录接口 IP 限流 |
| 500 | `INTERNAL_ERROR` | 未预期异常 |
| 503 | `SERVICE_UNAVAILABLE` | 服务未就绪（如鉴权关闭但库中无用户） |

---

## 10. 与 v5 的差异

v6 是干净重建，**不兼容 v5 的端点与数据**：

| v5 | v6 |
| --- | --- |
| `/v1/projects/...`、`/v1/agents/...`、`/v1/tasks/...` | 全部删除；统一 `/v1/partitions/:p/...` |
| `/v1/memories`、`/v1/memories/search`、`/v1/context` | 删除；改用分区 + 人级端点 |
| `POST /v1/partitions/:p/memories`（顶层写记忆） | 人级 `POST .../persons/:person/memories`（人必填） |
| 分页 `page/page_size` + `total` | 游标 `cursor/limit` + `next_cursor`，无 total |
| `visibility`（project/agent/task） | `scope`（partition/person/session） |
| 记忆向量/图谱/实体/词项/任务简报 | v6 不提供；**v6.1 重新以混合检索 / 实体图 / 画像提供**（详见第 4–5 节） |
| 无历史 / 反馈 / 生命周期 | v6.1 新增 `history` / `feedback` / `profile` / `facts` / `merge` / `archive` / `export` / `delete` / `graph` / `entities` / `attachments` |
| 数据目录 `data/`（v5） | `data-v6/`（v5 数据不迁移，保留在 `v5` 分支） |

更完整的迁移说明见 [`v6-architecture.md`](v6-architecture.md)；v5 文档可从 `v5` 分支获取。
