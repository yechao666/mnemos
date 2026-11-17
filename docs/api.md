# Mnemos v6 API 参考

> 契约：[`v6-architecture.md`](v6-architecture.md)。本文以 v6 代码为准
> （`server/src/http/routes/*.ts`、`server/src/http/serialize.ts`、`server/src/http/schemas.ts`）。
>
> 两套 JSON 命名约定，**不是两套能力**：
>
> | 入口 | 前缀 | 鉴权 | 命名 |
> | --- | --- | --- | --- |
> | 公开 API | `/v1/partitions/:partition/...` | `Authorization: Bearer mnemos_live_…`（API Key） | `snake_case` |
> | 控制台 API | `/api/...` | `Authorization: Bearer <登录会话令牌>` | `camelCase` |
>
> v6 **不保留** `/v1/memories`、`/v1/memories/search`、`/v1/context`、`/v1/projects`、`/v1/agents`、
> `/v1/tasks`、`/v1/graph` 等旧端点；旧调用方需要迁移到分区 + 人模型（见[第 9 节](#9-与-v5-的差异)）。

---

## 1. 通用约定

- **Base URL**：默认 `http://127.0.0.1:4380`；不带尾斜杠。
- **请求体**：`content-type: application/json; charset=utf-8`；未知字段默认忽略（部分 schema 严格校验）。
- **响应体**：JSON；成功直接返回资源对象或 `{ items, next_cursor, partition_stats }`。
- **时间**：ISO 8601 UTC 字符串（如 `2026-11-17T16:00:44.852Z`）。
- **请求 ID**：每个响应带 `x-request-id`；错误体里也有 `requestId`，可与日志关联。
- **大小/超时**：请求体至少 1MB（`MNEMOS_BODY_LIMIT_BYTES` 可调大），请求超时默认 30s。
- **探针**：`GET /health`、`GET /api/health`、`GET /healthz`、`GET /readyz`、`GET /metrics`（详见第 8 节）。

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
    "locale": "zh-CN"
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
  "updated_at": "2026-11-17T16:01:05.801Z"
}
```

- `type`：`human` / `agent` / `service` / `other`；`status`：`active` / `archived` / `deleted`。
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
  "dreamed_at": null
}
```

- `scope`：`person`（仅本人）/ `partition`（分区共享）/ `session`（仅该会话）。
- `category`（18 种）：`preference`、`identity`、`fact`、`plan`、`relationship`、`event`、`skill`、
  `constraint`、`context`、`insight`、`decision`、`progress`、`lesson`、`risk`、`change`、
  `acceptance`、`assumption`、`dependency`。
- `source`：`api` / `conversation` / `agent` / `import` / `playground` / `dream`。
- `status`：`active` / `archived` / `deleted`；`importance`、`confidence` 为 0–1。
- `person_id` 是**归属人**，`actor_person_id` 是**写入者**（可与人不同）。
- v6 不做事实抽取：原文入库；`infer` / `mode` 字段被接受但忽略。

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
| `PATCH` | `/v1/partitions/:p/persons/:person` | `memories:write` | 更新 display_name/attributes/status/type |
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

### 5.3 记忆列表 / 详情 / 管理

| 方法 | 路径 | 作用域 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/partitions/:p/memories` | `memories:read` | 分区记忆列表；`person_id`/`person_external_id`/`scope`/`category`/`status`/`q`/`cursor`/`limit` |
| `POST` | `/v1/partitions/:p/memories/search` | `memories:read` | 兼容检索端点（body：`query`、`person_id`、`scope`、`category`、`top_k`） |
| `GET` | `/v1/partitions/:p/memories/:id` | `memories:read` | 详情：`{ memory, person }` |
| `PATCH` | `/v1/partitions/:p/memories/:id` | `memories:write` | 更新 content/category/importance/confidence/status/tags/metadata/expires_at |
| `DELETE` | `/v1/partitions/:p/memories/:id` | `memories:write` | 删除，返回 `204`（无响应体） |

检索（兼容端点）：

```bash
curl -s -X POST "$BASE/v1/partitions/mnemos-dev/memories/search" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"query":"data-v6","top_k":3}'
```

```json
{
  "results": [
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
      "status": "active"
    }
  ],
  "took_ms": 0,
  "next_cursor": null,
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

- `query` 必填（1–2000 字符）；`top_k` 1–50，默认 8；`person_id` 是**作者过滤**。
- 语义等价于 `GET /memories?q=…&limit=top_k`，只是响应包成 `{ results, took_ms }`（DSH 插件兼容）。

### 5.4 写入记忆

`POST /v1/partitions/:partition/persons/:person/memories`，`person` 支持内部 id 或 external_id。
**路径上的人必须已存在**：v1 不会在写记忆时自动建人，未知人返回 `404 NOT_FOUND`；
请先 `PUT /v1/partitions/:p/persons/:externalId` 建档（或由人的同步流程建档）。

```bash
curl -s -X POST "$BASE/v1/partitions/zhiwu-app/persons/user-123/memories" \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"用户 123 喜欢黑咖啡，不加糖","scope":"person","category":"preference","importance":0.8,"tags":["drink"]}'
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
| `expires_at` | ISO/null | 过期时间 |
| `infer` / `mode` | — | **接受但忽略**（v6 不做事实抽取） |

响应 `201`：

```json
{
  "memory": { "…": "Memory" },
  "events": [{ "type": "ADD", "memory_id": "mem_3238ae7e145445c0", "at": "2026-11-17T16:01:05.801Z" }]
}
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

---

## 6. 控制台 API（`/api`，会话鉴权）

与 v1 同构，camelCase。权限沿用组织角色：viewer 读、developer 写、admin 管理密钥/设置、
owner 管理组织与组织级 Key。

### 6.1 登录 / 会话

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

### 6.2 分区 / 人 / 记忆

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
| `PATCH` | `/api/partitions/:partition/persons/:person` | developer | 更新 `displayName/attributes/status`（**不能改 type/externalId**） |
| `GET` | `/api/partitions/:partition/persons/:person/memories` | viewer | 该人记忆（游标 + scope/category/q） |
| `POST` | `/api/partitions/:partition/persons/:person/memories` | developer | 写记忆，返回 `{ memory }`（无 events） |
| `GET` | `/api/partitions/:partition/memories` | viewer | 分区记忆（`personId`/`scope`/`category`/`q`/游标） |
| `GET` | `/api/partitions/:partition/memories/:id` | viewer | `{ memory, person }` |
| `PATCH` | `/api/partitions/:partition/memories/:id` | developer | `{ memory }` |
| `DELETE` | `/api/partitions/:partition/memories/:id` | developer | 204 |

`GET /api/partitions/:partition` **带 `stats`**（v1 的同一路径不带），这是两套入口唯一的形状差异之一。

### 6.3 人级简报 / 上下文 / 做梦（控制台）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/partitions/:p/persons/:person/brief` | viewer | query：`force`、`maxChars` |
| `POST` | `/api/partitions/:p/persons/:person/context` | viewer | body：`query`、`budgetTokens`、`includePartition` |
| `GET` | `/api/partitions/:p/persons/:person/dream` | viewer | 状态 |
| `POST` | `/api/partitions/:p/persons/:person/dream/run` | developer | body：`batchSize` |
| `GET` | `/api/partitions/:p/dream` | viewer | 分区级状态 |
| `POST` | `/api/partitions/:p/dream/run` | developer | 分区级手动做梦 |

### 6.4 用量 / 审计 / 密钥（分区）

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/partitions/:p/usage?days=30` | viewer | `days` 1–90；返回 points/byOperation/byChannel/byKey/latency/totals |
| `GET` | `/api/partitions/:p/audit` | viewer | 游标列表（`cursor/limit`） |
| `GET` | `/api/partitions/:p/keys` | admin | 分区 key 列表（不含 secret） |
| `POST` | `/api/partitions/:p/keys` | admin | 创建；`{name,scopes,rateLimitPerMin?,expiresAt?,allowedIps?}`；响应含一次性 `secret` |
| `POST` | `/api/partitions/:p/keys/:id/rotate` | admin | `{graceHours}`（0–168，仅审计）；**旧 key 立即吊销** |
| `DELETE` | `/api/partitions/:p/keys/:id` | admin | 吊销，204 |

### 6.5 组织 / 组织级密钥 / 运维

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
| `POST` | `/api/ops/backup` | admin | 立即在线备份（`VACUUM INTO`） |
| `GET` | `/api/ops/backups` | admin | 备份列表 |
| `GET` | `/api/ops/backups/:file` | admin | 下载备份（文件名白名单） |

> 组织级 key 的创建 body 与分区 key 相同（`name/scopes/rateLimitPerMin/expiresAt/allowedIps`），
> 不绑定分区。

---

## 7. 健康检查与运维端点

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/health` | 无 | 详细健康：`{ok,version,uptimeMs,schemaVersion,db,node}`；DB 异常 503 |
| `GET` | `/api/health` | 无 | 同上（控制台用） |
| `GET` | `/healthz` | 无 | 存活探针：`{ok:true}` |
| `GET` | `/readyz` | 无 | 就绪探针：DB 可查询 → 200；否则 503 `{ok:false}` |
| `GET` | `/metrics` | 无（内网） | Prometheus 文本；`MNEMOS_METRICS_ENABLED=0` 时 404 |

探针不要暴露公网；`/metrics` 未鉴权，建议只在内网抓取。

---

## 8. 错误码

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
| 409 | `CONFLICT` | 唯一键冲突（如人的 type/external_id、session 跨分区） |
| 409 | `DREAM_RUNNING` | 同一分区/人正在做梦 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过上限 |
| 423 | `account_locked` | 登录失败次数过多（带 `details.retryAfter`） |
| 429 | `RATE_LIMITED` | API Key 每分钟限流 |
| 429 | `QUOTA_EXCEEDED` | 分区月配额超限（带 `details` 与 `retry-after`） |
| 429 | `login_rate_limited` | 登录接口 IP 限流 |
| 500 | `INTERNAL_ERROR` | 未预期异常 |
| 503 | `SERVICE_UNAVAILABLE` | 服务未就绪（如鉴权关闭但库中无用户） |

---

## 9. 与 v5 的差异

v6 是干净重建，**不兼容 v5 的端点与数据**：

| v5 | v6 |
| --- | --- |
| `/v1/projects/...`、`/v1/agents/...`、`/v1/tasks/...` | 全部删除；统一 `/v1/partitions/:p/...` |
| `/v1/memories`、`/v1/memories/search`、`/v1/context` | 删除；改用分区 + 人级端点 |
| `POST /v1/partitions/:p/memories`（顶层写记忆） | 人级 `POST .../persons/:person/memories`（人必填） |
| 分页 `page/page_size` + `total` | 游标 `cursor/limit` + `next_cursor`，无 total |
| `visibility`（project/agent/task） | `scope`（partition/person/session） |
| 记忆向量/图谱/实体/词项/任务简报 | v6 不提供 |
| 数据目录 `data/`（v5） | `data-v6/`（v5 数据不迁移，保留在 `v5` 分支） |

更完整的迁移说明见 [`v6-architecture.md`](v6-architecture.md)；v5 文档可从 `v5` 分支获取。
