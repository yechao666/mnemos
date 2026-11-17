# Mnemos API 参考

两个命名空间：

| 命名空间 | 鉴权方式 | 命名风格 | 用途 |
| --- | --- | --- | --- |
| `/v1/*` | `Authorization: Bearer mnemos_live_*`（API Key：`project` 绑定分区 / `org` 组织级） | snake_case | 面向 Agent / SDK 的稳定接口（v5 中立面见第 11 节） |
| `/api/*` | `Authorization: Bearer <session>`（控制台会话） | camelCase | 控制台内部接口 |

通用约定：

- 请求/响应均为 JSON，`content-type: application/json`；请求体上限 1 MB。
- 每个响应带 `x-request-id`，错误响应体统一为：

```json
{ "error": { "code": "FORBIDDEN", "message": "当前密钥缺少 memories:write 作用域", "requestId": "req_..." } }
```

- 时间均为 ISO 8601 UTC 字符串。
- 分页参数：`page`（从 1 开始）、`page_size`（默认 20，最大 100）。

---

## 1. 认证与密钥

API Key 在控制台「项目 · 密钥」创建，明文只展示一次。作用域：

| 作用域 | 允许的操作 |
| --- | --- |
| `memories:read` | 搜索、列表、详情、历史 |
| `memories:write` | 写入、更新、删除 |
| `graph:read` | 图谱查询 |
| `admin` | 统计与项目级信息 |

### 1.1 密钥类型：project / org

v5 中立记忆服务引入组织级 API Key（`kind=org`），两类密钥的能力边界：

| kind | 绑定 | 能力 | 典型用途 |
| --- | --- | --- | --- |
| `project`（默认） | 单个分区 | 只能访问自身分区；中立端点 `:partition` 必须等于自身 | 业务后端、控制台演示 |
| `org` | 组织 | 可访问 / `POST /v1/partitions` 创建本组织任意分区 | DSH 插件按工作区建分区、SaaS 多租户接入 |

- 中立 `/v1/partitions/*` 端点同时接受两种 key；旧 `/v1/memories`、`/v1/context` 等仍只接受 `project` key（org key 走分区端点）。
- org key 的明文只在创建响应出现一次，之后只能看到 `prefix`。

### 1.2 org key 管理（控制台 API，仅组织 owner）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/org/keys` | 创建：`{name, scopes, partitionId?, rateLimitPerMin?, expiresAt?, allowedIps?}` → `201` + 一次性 `secret` |
| `GET` | `/api/org/keys` | 列表（**不含**明文 secret） |
| `DELETE` | `/api/org/keys/{keyId}` | 吊销（软删，立即失效） |

```bash
# 1) 登录演示账号拿控制台会话令牌
SESSION=$(curl -s -X POST $BASE/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"lin.wei@mnemos.dev","password":"mnemos-demo"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

# 2) 创建 org key（需要组织 owner；锚点分区缺省取组织最早创建的分区）
curl -X POST $BASE/api/org/keys \
  -H "Authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"name":"DSH 工作区","scopes":["memories:read","memories:write","admin"],"rateLimitPerMin":600}'
```

响应（`secret` 仅此一次；`kind=org`、`orgId` 标识组织级密钥）：

```json
{
  "id": "key_…",
  "projectId": "prj_orion_python",
  "kind": "org",
  "orgId": "org_yunshu",
  "name": "DSH 工作区",
  "prefix": "mnemos_live_ab12cd34",
  "scopes": ["memories:read", "memories:write", "admin"],
  "rateLimitPerMin": 600,
  "allowedIps": [],
  "expiresAt": null,
  "createdAt": "2026-11-05T10:00:00.000Z",
  "secret": "mnemos_live_…"
}
```

> org key 必须绑定一个**锚点分区**（`api_keys.project_id NOT NULL`），仅用于审计与用量兜底；
> 锚点缺省取组织最早创建的分区，显式传 `partitionId` 时校验分区属于本组织。组织下还没有
> 任何分区时返回 `409 CONFLICT`（先创建至少一个项目/分区）。

演示密钥（seed 生成）：`mnemos_live_demo_aurora_console`（项目 `aurora-support`）。

---

## 2. 写入记忆（旧 v1，v5 保留）

`POST /v1/memories`

> v5 起推荐使用中立分区端点 `POST /v1/partitions/:p/memories`（支持人级 `person_id` / `scope` /
> `session_id`，见第 11 节）；本节接口保持兼容。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messages` | array | 二选一 | `[{role: user\|assistant\|system\|tool, content}]` |
| `text` | string | 二选一 | 纯文本 |
| `user_id` | string | 否 | 记忆归属用户 |
| `agent_id` | string | 否 | 记忆归属 Agent |
| `run_id` | string | 否 | 单次运行作用域 |
| `app_id` | string | 否 | 应用作用域 |
| `task_id` | string | 否 | 所属任务会话（Agent 原生） |
| `visibility` | string | 否 | `project`（默认，项目共享）/ `agent`（仅该 Agent）/ `task`（仅该任务） |
| `metadata` | object | 否 | 自定义元数据 |
| `infer` | boolean | 否 | 默认 `false`（原文入库）；`true` 走事实抽取 |
| `mode` | string | 否 | `additive`（默认）或 `consolidate`（高相似去重） |

```bash
curl -X POST http://127.0.0.1:4380/v1/memories \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "messages": [
      { "role": "user", "content": "我是张倩，偏好企业微信联系，上午 9 点到 11 点回复最快。" }
    ],
    "user_id": "cust-1042",
    "agent_id": "agent-support-l1",
    "infer": true
  }'
```

响应：

```json
{
  "results": [
    {
      "id": "mem_…", "projectId": "prj_aurora_support",
      "userId": "cust-1042", "agentId": "agent-support-l1",
      "content": "张倩偏好通过企业微信联系，上午 9 点至 11 点回复最快。",
      "category": "preference", "importance": 0.74, "confidence": 0.86,
      "source": "api", "status": "active", "tags": [],
      "metadata": {}, "createdAt": "2026-11-05T14:20:00.000Z",
      "updatedAt": "2026-11-05T14:20:00.000Z", "accessCount": 0
    }
  ],
  "events": [{ "type": "ADD", "memoryId": "mem_…", "content": "…", "at": "…" }],
  "tookMs": 4,
  "extracted": 1,
  "merged": 0,
  "skipped": 0
}
```

---

## 3. 搜索记忆（旧 v1，v5 保留）

`POST /v1/memories/search`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `query` | string | 自然语言查询 |
| `user_id` / `run_id` | string | 作用域过滤（精确匹配） |
| `agent_id` | string | **调用方 Agent 身份**：决定可见性（项目共享 + 自身私有 + 当前任务），不会过滤掉其他 Agent 的共享记忆 |
| `written_by_agent_id` | string | 归属过滤：只看该 Agent 写入的记忆 |
| `task_id` | string | 任务上下文：既作为可见性依据，也只返回该任务写入的记忆 |
| `visibility` | string | 仅检索指定可见性 |
| `include_private` | boolean | 默认 false；控制台/审计可设为 true 查看所有 Agent 私有记忆 |

> 关键语义：Agent 带自己的 `agent_id` 检索时，**仍然能看到项目内其他 Agent 写入的共享记忆**；只有 `visibility=agent` 的私有记忆按写入者隔离。
| `top_k` | number | 默认取项目设置（8），最大 50 |
| `threshold` | number | 0–1，最低融合分 |
| `filters` | object | `status` / `category` / `tags` / `created_after` / `created_before` / `min_importance` / `metadata` |

响应包含逐命中信号分解：

```json
{
  "results": [
    {
      "id": "mem_…", "memory": "张倩偏好通过企业微信联系…",
      "score": 0.73,
      "signals": { "semantic": 0.68, "keyword": 0.52, "entity": 0.4, "recency": 0.81, "importance": 0.74 },
      "matchedOn": ["semantic", "keyword", "entity"],
      "entities": ["张倩", "企业微信"]
    }
  ],
  "total": 1, "took_ms": 6, "signals": ["semantic", "keyword", "entity", "recency", "importance"]
}
```

融合公式（权重来自项目设置）：

```
score = w_semantic·cos + w_keyword·BM25' + w_entity·overlap + w_recency·recency + 0.15·importance
```

---

## 4. 记忆管理（旧 v1，v5 保留）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/memories?user_id=&agent_id=&page=&page_size=` | 分页列表 |
| `GET` | `/v1/memories/{id}` | 详情（含实体与历史） |
| `PUT` | `/v1/memories/{id}` | 更新正文 `{"text": "…"}` |
| `DELETE` | `/v1/memories/{id}` | 软删除（写历史） |
| `DELETE` | `/v1/memories?user_id=…&confirm=true` | 批量删除（必须带 confirm） |
| `GET` | `/v1/memories/{id}/history` | 变更历史 |
| `POST` | `/v1/memories/{id}/feedback` | `{"helpful": true}` 调整重要度 |

`category` 枚举新增 `insight`、`source` 枚举新增 `dream`：`GET /v1/memories?category=insight` 可读取做梦生成的洞见，`PUT /v1/memories/{id}` 也可把分类更新为 `insight`。

---

## 5. 图谱与统计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/graph?user_id=&limit=120` | 实体节点与关系边 |
| `GET` | `/v1/stats` | 项目指标：记忆数、检索量、p50/p95、命中率等 |
| `GET` | `/v1/health` | 健康检查 |

---

## 6. Agent 原生 API（v4 兼容层）

> 设计说明见 [`agent-memory-model.md`](agent-memory-model.md)。所有 `/v1` 接口的项目由 API Key 决定。
>
> **v5 起推荐使用第 11 节的「分区 + 人」中立接口**；本节接口全部保留（只增不改），
> 内部已映射为 `person` / `scope`：`agent_id` → `person(type=agent)`、`user_id` → `person(type=human)`、
> `visibility` ↔ `scope`（project↔partition、agent↔person、task↔session）。

### 6.1 Agent 注册表

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/agents` | 项目内 Agent 列表（含角色、能力、记忆/任务统计） |
| `POST` | `/v1/agents` | 注册 Agent：`{name, role?, model?, description?, capabilities?}` |

### 6.2 任务会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/tasks?status=&agent_id=` | 任务列表（按开始时间倒序） |
| `POST` | `/v1/tasks` | 开始任务：`{title, goal?, owner_agent_id?, branch?}` |
| `GET` | `/v1/tasks/{id}` | 任务详情 |
| `POST` | `/v1/tasks/{id}/finish` | 结束任务：`{status?, summary?, decisions?, lessons?, notes?, agent_id?}` |

`finish` 会把 `decisions[]`（→`fact`）、`lessons[]`（→`constraint`）、`notes[]`（→`event`）自动写成**项目共享记忆**，并关联到该 `task_id`：

```bash
curl -X POST $BASE/v1/tasks/task_orion_split_query/finish \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "summary": "查询服务拆分完成首期",
    "decisions": ["查询走 read replica，按 order_id 分片"],
    "lessons": ["拆分前必须补齐双写对账，上次漏了退款单"],
    "agent_id": "agent-coder"
  }'
```

### 6.3 任务简报（上下文注入）

`POST /v1/context`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `agent_id` | string | 调用方 Agent（决定可见的私有记忆） |
| `task_id` | string | 当前任务（决定任务内记忆与默认检索词） |
| `query` | string | 覆盖默认检索词 |
| `budget_tokens` | number | 默认 1200，按重要度/时效截断 |

响应：

```json
{
  "project": { "id": "prj_orion_python", "name": "Orion 订单服务 · Python", "description": "..." },
  "agent": { "id": "agent-coder", "name": "开发 Agent" },
  "task": { "id": "task_orion_split_query", "title": "拆分订单查询服务" },
  "sections": [
    { "key": "project", "title": "项目背景", "description": "…", "hits": [] },
    { "key": "conventions", "title": "规范与约束", "hits": [] },
    { "key": "decisions", "title": "历史决策", "hits": [] },
    { "key": "experience", "title": "相关经验", "hits": [] },
    { "key": "incidents", "title": "事故与告警", "hits": [] },
    { "key": "agent_notes", "title": "我的私有笔记", "hits": [] },
    { "key": "open_tasks", "title": "进行中的任务", "hits": [] }
  ],
  "prompt": "# 项目简报：Orion 订单服务 · Python\n- 生成时间：…\n\n## 记忆简报（最近记忆与洞见）\n- [约束] 库存扣减统一走 deduct_stock 服务方法…\n\n## 项目背景\n- [mem_…] …\n…",
  "token_estimate": 986,
  "citations": ["mem_…"],
  "built_at": "2026-11-05T15:20:00.000Z",
  "took_ms": 12,
  "brief": {
    "text": "# 记忆简报（最近记忆与洞见）\n- [约束] 库存扣减统一走 deduct_stock 服务方法…\n- [事实] 支付回调必须绑定业务单号做幂等…",
    "maxChars": 500,
    "count": 9
  }
}
```

`prompt` 是可直接拼进 system prompt 的中文 Markdown，每条记忆带 `[id]` 与 `from: agent/task/date`。

**记忆简报注入（brief）**：项目 `briefEnabled !== false` 且简报非空（`count > 0`）时，响应额外带 `brief: {text, maxChars, count}`，并在 `prompt` 的「项目简报」元信息之后、各分区之前插入「记忆简报」段落；`briefEnabled=false` 或 `count=0` 时不注入、响应不带该字段。简报按调用方 `agent_id` 生成（项目共享记忆 + 该 Agent 私有记忆），字数上限取项目 `briefMaxChars`（默认 500）。字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `brief.text` | string | 简报正文；无可用记忆时为空串 |
| `brief.maxChars` | number | 本次生成的字符上限（项目 `briefMaxChars`） |
| `brief.count` | number | 纳入简报的记忆条数 |

---

## 7. 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` / `BAD_REQUEST` / `INVALID_JSON` | 参数不合法（`VALIDATION_ERROR` 附带 `details`）、请求体不是合法 JSON |
| 401 | `UNAUTHORIZED` / `INVALID_API_KEY` / `API_KEY_REVOKED` | 缺少或无效凭证；API Key 无效/已吊销 |
| 403 | `FORBIDDEN` | 作用域/角色不足 |
| 404 | `NOT_FOUND` | 资源不存在或不属于该项目 |
| 405 | `METHOD_NOT_ALLOWED` | 路径不支持该 HTTP 方法 |
| 409 | `CONFLICT` | 唯一约束或并发冲突（例如同一项目正在做梦） |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 1 MB |
| 422 | `UNPROCESSABLE_ENTITY` | JSON 形状合法但语义不合法（如缺少必需上下文、参数越界） |
| 429 | `RATE_LIMITED` / `quota_exceeded` / `login_rate_limited` | 密钥限流 / 月度配额耗尽 / 登录尝试过频 |
| 500 | `INTERNAL_ERROR` / `ENGINE_ERROR` | 未预期的服务端异常 / 记忆引擎处理失败 |
| 503 | `SERVICE_UNAVAILABLE` | 服务暂不可用 |

---

## 8. 控制台 API（`/api`，会话鉴权）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | `{email, password}` → `{token, user, org}` |
| `GET` | `/api/auth/me` | 当前用户、组织与可见项目 |
| `POST` | `/api/auth/logout` | 注销会话 |
| `GET` | `/api/dashboard` | 组织级聚合 |
| `GET` | `/api/projects` | 项目列表（含统计） |
| `POST` | `/api/projects` | 创建项目 |
| `PATCH` | `/api/projects/{id}` | 更新项目 |
| `DELETE` | `/api/projects/{id}` | 归档项目 |
| `GET` | `/api/projects/{id}/overview` | 项目概览 |
| `GET` | `/api/projects/{id}/usage?days=30` | 用量分析 |
| `GET` | `/api/projects/{id}/audit` | 审计日志（分页/筛选） |
| `GET`/`POST` | `/api/projects/{id}/members` | 成员列表/新增 |
| `PATCH`/`DELETE` | `/api/projects/{id}/members/{userId}` | 修改角色/移除 |
| `GET`/`POST` | `/api/projects/{id}/keys` | 密钥列表/创建 |
| `DELETE` | `/api/projects/{id}/keys/{keyId}` | 吊销密钥 |
| `GET`/`POST` | `/api/org/keys` | 组织级（org）密钥列表 / 创建（仅组织 owner，明文一次） |
| `DELETE` | `/api/org/keys/{keyId}` | 吊销 org 密钥 |
| `GET` | `/api/projects/{id}/persons` | 人列表（`type` / `status` / `q` / 分页 / 排序） |
| `GET` | `/api/projects/{id}/persons/{personRef}` | 人详情 + 统计（`memories` / `sharedMemories` / `sessions` / `lastMemoryAt`） |
| `PUT` | `/api/projects/{id}/persons/{externalId}` | 建档 / 更新人（lazy upsert） |
| `PATCH` | `/api/projects/{id}/persons/{personRef}` | 更新显示名 / attributes / status |
| `GET` | `/api/projects/{id}/persons/{personRef}/brief` | 人的简报 |
| `POST` | `/api/projects/{id}/persons/{personRef}/context` | 人的上下文（资料 + 简报 + 记忆 + prompt） |
| `GET` | `/api/projects/{id}/persons/{personRef}/dream` | 人级做梦状态 |
| `POST` | `/api/projects/{id}/persons/{personRef}/dream/run` | 手动触发人级做梦 |
| `PATCH` | `/api/projects/{id}/settings` | 更新项目设置（含 `briefMaxChars` / `briefEnabled` / `dreamEnabled` / `dreamIntervalMinutes`） |
| `GET` | `/api/projects/{id}/memory/brief` | 记忆简报：读取（`force` / `agentId` / `maxChars`） |
| `PATCH` | `/api/projects/{id}/memory/brief` | 记忆简报：更新字符上限并重新生成 |
| `GET` | `/api/projects/{id}/memory/dream` | 做梦状态：设置、待整理数、最近运行记录 |
| `PATCH` | `/api/projects/{id}/memory/dream` | 做梦设置：开关与周期 |
| `POST` | `/api/projects/{id}/memory/dream/run` | 手动触发一次增量做梦（运行中返回 409） |
| `GET` | `/api/projects/{id}/memories` | 记忆列表（`q` 走混合检索） |
| `GET`/`PATCH`/`DELETE` | `/api/memories/{id}` | 记忆详情/更新/删除 |
| `POST` | `/api/memories/bulk` | 批量删除/归档/恢复 |
| `GET` | `/api/memories/{id}/history` | 历史 |
| `POST` | `/api/memories/{id}/feedback` | 反馈 |
| `GET`/`POST` | `/api/projects/{id}/agents` | Agent 列表/注册 |
| `PATCH` | `/api/projects/{id}/agents/{agentId}` | 更新 Agent |
| `GET`/`POST` | `/api/projects/{id}/tasks` | 任务列表/创建 |
| `GET`/`PATCH` | `/api/tasks/{id}` | 任务详情/更新 |
| `POST` | `/api/tasks/{id}/finish` | 结束任务并沉淀经验 |
| `GET` | `/api/projects/{id}/briefing` | 简报预览 |
| `GET` | `/api/projects/{id}/graph` | 图谱 |
| `POST` | `/api/projects/{id}/playground/add` | 演练场写入 |
| `POST` | `/api/projects/{id}/playground/search` | 演练场检索 |
| `GET` | `/api/events?token=` | SSE 实时事件流 |
| `GET` | `/api/health` | 健康检查 |

### 8.1 记忆简报与做梦

均为控制台会话鉴权，`{id}` 为项目 id（如 `prj_orion_python`）。读取（`GET`）需要项目 `viewer` 及以上，修改（`PATCH` / `POST`）需要 `admin` 及以上。相关项目设置项：`briefMaxChars`（100–5000，默认 500）、`briefEnabled`（默认 `true`）、`dreamEnabled`（默认 `true`）、`dreamIntervalMinutes`（1–43200，默认 1440），可通过 `PATCH /api/projects/{id}/settings` 修改。

#### 读取记忆简报

`GET /api/projects/{id}/memory/brief`

| 查询参数 | 类型 | 说明 |
| --- | --- | --- |
| `force` | boolean | `true`/`1` 忽略缓存重新生成；默认 `false` |
| `agentId` | string | 不传 = 控制台审计全量视角（含所有私有/任务记忆）；传 = 按该 Agent 视角生成（项目共享 + 该 Agent 私有，不含其他 Agent 私有） |
| `maxChars` | integer | 临时覆盖项目 `briefMaxChars`（服务端 clamp 到 100–5000，不落库） |

不传 `agentId` 时是审计视角，包含项目内所有记忆；传 `agentId` 时预览该 Agent 实际能拿到的简报（项目共享 + 其私有）。简报按「记忆集合 + 字符上限 + 视角」计算 `source_hash` 缓存，记忆变化或上限调整后自动失效。

响应 `MemoryBrief`：

```json
{
  "projectId": "prj_orion_python",
  "text": "# 记忆简报（最近记忆与洞见）\n- [约束] 库存扣减统一走 deduct_stock 服务方法…\n- [事实] 支付回调必须绑定业务单号做幂等…",
  "maxChars": 800,
  "count": 12,
  "model": "mnemos-condense",
  "cached": false,
  "generatedAt": "2026-11-05T15:40:00.000Z",
  "recent": [
    {
      "id": "mem_…",
      "content": "支付回调幂等键必须绑定业务单号。",
      "category": "constraint",
      "importance": 0.82,
      "updatedAt": "2026-11-05T14:02:00.000Z",
      "taskId": "task_orion_payment_idempotency",
      "agentId": "agent-reviewer"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` | string | 简报正文；暂无可用记忆时为空串 |
| `maxChars` | number | 本次生成的字符上限 |
| `count` | number | 纳入简报的记忆条数 |
| `model` | string | `mnemos-condense`（确定性压缩）或实际调用的 LLM 模型名 |
| `cached` | boolean | 是否命中 `memory_briefs` 缓存 |
| `generatedAt` | string | 生成时间 |
| `recent[]` | array | 参与简报的记忆摘要（`id` / `content` / `category` / `importance` / `updatedAt` / 可选 `taskId`、`agentId`） |

#### 更新简报字符上限

`PATCH /api/projects/{id}/memory/brief`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `maxChars` | integer | 是 | 100–5000，写入项目设置并强制重新生成 |

```bash
curl -X PATCH "$BASE/api/projects/$PROJECT/memory/brief" \
  -H "Authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"maxChars":1200}'
```

返回更新后的 `MemoryBrief`（字段同上）。

#### 读取做梦状态

`GET /api/projects/{id}/memory/dream` → `MemoryDreamStatus`

```json
{
  "settings": { "enabled": true, "intervalMinutes": 1440, "lastAt": "2026-11-05T15:42:00.000Z" },
  "pendingCount": 7,
  "lastRun": {
    "id": "dream_…",
    "projectId": "prj_orion_python",
    "trigger": "schedule",
    "status": "completed",
    "inputCount": 8,
    "insightCount": 2,
    "summary": "归纳出并发扣减与回调幂等两条可复用约束",
    "startedAt": "2026-11-05T15:42:00.000Z",
    "finishedAt": "2026-11-05T15:42:02.000Z"
  },
  "runs": []
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `settings.enabled` | boolean | 是否参与定时做梦 |
| `settings.intervalMinutes` | number | 做梦周期（分钟，1–43200） |
| `settings.lastAt` | string? | 上次做梦时间（取最近一次运行的 `startedAt`） |
| `pendingCount` | number | `dreamed_at` 为空、`visibility='project'`、正文 ≥10 字的活跃记忆数（不含 `insight` 洞见自身） |
| `lastRun` | object? | 最近一次运行记录；无记录时省略 |
| `runs[]` | array | 最近 10 次运行记录（新 → 旧），字段同 `lastRun` |

运行记录 `MemoryDreamRun`：`trigger`（`schedule` / `manual`）、`status`（`running` / `completed` / `skipped` / `failed`）、`inputCount`（本次处理的新记忆数）、`insightCount`（写入的洞见数）、`summary` / `error`（可选）、`startedAt` / `finishedAt`。

#### 更新做梦设置

`PATCH /api/projects/{id}/memory/dream`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | 二选一 | 是否参与定时做梦 |
| `intervalMinutes` | integer | 二选一 | 1–43200 分钟；`enabled` 与 `intervalMinutes` 至少提供一个 |

```bash
curl -X PATCH "$BASE/api/projects/$PROJECT/memory/dream" \
  -H "Authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"enabled":true,"intervalMinutes":720}'
```

返回更新后的 `MemoryDreamStatus`。

#### 手动触发做梦

`POST /api/projects/{id}/memory/dream/run` → `MemoryDreamResult`

```json
{
  "run": {
    "id": "dream_…",
    "projectId": "prj_orion_python",
    "trigger": "manual",
    "status": "completed",
    "inputCount": 8,
    "insightCount": 2,
    "startedAt": "2026-11-05T15:42:00.000Z",
    "finishedAt": "2026-11-05T15:42:02.000Z"
  },
  "status": { "settings": {}, "pendingCount": 0, "runs": [] }
}
```

- 只处理 `dreamed_at IS NULL`、`visibility='project'` 且非 `insight` 的活跃记忆（正文 ≥10 字），处理完写入 `dreamed_at` 作为增量水位，不重放旧记忆。
- 隐私边界：`visibility='agent'`（Agent 私有）与 `visibility='task'`（任务）记忆不参与做梦、不会被写进项目洞见；洞见固定 `visibility='project'`。
- 洞见写入为 `category=insight`、`source=dream` 的记忆（项目共享），`metadata` 含 `dreamRunId` 与 `sourceMemoryIds`；相同内容不重复写入。
- 同一项目同时只允许一次做梦：并发触发返回 `409 CONFLICT`（`{"error":{"code":"CONFLICT","message":"该项目正在做梦，请稍后再试","requestId":"…"}}`），不会重复执行。
- 没有待整理的新记忆时本次运行记为 `skipped`（`inputCount=0`）；有输入但未形成有效洞见时记为 `completed`（`insightCount=0`，`summary` 为「本批没有形成有效洞见」），不会生成空洞见。

---

## 9. 生产运维接口

### 9.1 探针与指标（无需鉴权，建议仅内网暴露）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 存活探针（进程可响应） |
| `GET` | `/readyz` | 就绪探针：数据库、schema 版本、引擎；失败 503 |
| `GET` | `/metrics` | Prometheus 文本指标（请求量/延迟/错误/SSE/限流/登录失败/版本） |

### 9.2 运维管理（`/api/ops/*`，admin+）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/ops/status` | 运行状态、表计数、项目配额、保留期、备份、维护历史、指标快照 |
| `POST` | `/api/ops/maintenance` | `{dryRun?, vacuum?}`：TTL/保留期归档、软删清理、幂等键/会话清理、WAL checkpoint |
| `GET` | `/api/ops/maintenance?limit=` | 维护历史 |
| `POST` | `/api/ops/backup` | 创建 SQLite 一致性备份（`VACUUM INTO`），保留最近 14 份 |
| `GET` | `/api/ops/backups` | 备份列表 |
| `GET` | `/api/ops/backups/{file}` | 下载备份（仅允许文件名，防路径穿越） |

### 9.3 组织成员与安全

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET`/`POST` | `/api/org/users` | 成员列表 / 创建（返回一次性临时密码） |
| `PATCH` | `/api/org/users/{id}` | 角色、状态、姓名、标题 |
| `POST` | `/api/org/users/{id}/reset-password` | 重置密码（返回一次性临时密码并踢下线） |
| `PATCH` | `/api/auth/password` | 自助改密（校验旧密码、删除其他会话） |
| `POST` | `/api/projects/{id}/keys/{keyId}/rotate` | 轮换密钥：`{graceHours}`，旧密钥宽限期后失效 |

登录安全：连续失败 `MNEMOS_LOGIN_MAX_ATTEMPTS`（默认 5）次后锁定 `MNEMOS_LOGIN_LOCK_MINUTES`（默认 15）分钟，返回 `423 account_locked`；同一 IP 每分钟 >30 次登录尝试返回 `429 login_rate_limited`；禁用账号 `403 account_disabled`。

### 9.4 幂等与限流

- 写接口支持 `Idempotency-Key` 请求头（8–128 字符）：相同 key + 相同请求体在 24h 内返回首次结果，并带 `x-idempotent-replayed: true`；请求体不同返回 `409 idempotency_conflict`。
- API Key 响应包含 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`；超限 `429 rate_limited` + `Retry-After`。
- 超出项目月度配额时写接口返回 `429 quota_exceeded`，`details` 含 `used/limit/resetAt`，并附 `Retry-After`。

### 9.5 导入导出与 OpenAPI

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/projects/{id}/export` | 导出项目（格式 `mnemos-export/v1`） |
| `GET` | `/v1/export` | 导出当前 Key 所属项目 |
| `POST` | `/v1/import` | 导入记忆（≤1000 条/次，去重计入 skipped） |
| `GET` | `/openapi.json`、`/api/openapi.json` | OpenAPI 3.1 文档 |

安全响应头（全局）：`Content-Security-Policy`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`Permissions-Policy`，可选 HSTS（`MNEMOS_HSTS=1`）。

---

## 10. 事件订阅（Webhook）

### 10.1 控制台 API（会话鉴权）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET`/`POST` | `/api/projects/{id}/webhooks` | 列表 / 创建（创建返回一次性 `secret`） |
| `PATCH`/`DELETE` | `/api/webhooks/{id}` | 更新 / 删除 |
| `POST` | `/api/webhooks/{id}/rotate-secret` | 轮换签名密钥（返回一次性 `secret`） |
| `POST` | `/api/webhooks/{id}/test` | 发送测试事件（不进入重试队列） |
| `GET` | `/api/webhooks/{id}/deliveries?status=&page=&pageSize=` | 投递记录分页 |
| `GET` | `/api/webhooks/deliveries/{deliveryId}` | 投递详情 |
| `POST` | `/api/webhooks/deliveries/{deliveryId}/replay` | 重放 |
| `GET` | `/api/projects/{id}/webhooks/stats` | 投递统计（成功率、平均延迟、近 24h） |
| `GET` | `/api/webhooks/event-types` | 可订阅事件清单 |

### 10.2 公开 API（API Key）

`GET/POST /v1/webhooks`、`PATCH/DELETE /v1/webhooks/{id}`、`POST /v1/webhooks/{id}/rotate-secret`、
`GET /v1/webhooks/{id}/deliveries`、`POST /v1/webhook-deliveries/{id}/replay`（snake_case）。

### 10.3 投递协议

```
POST <url>
content-type: application/json
user-agent: Mnemos-Webhook/1.0
x-mnemos-event: memory.created
x-mnemos-delivery: whd_...
x-mnemos-project: prj_...
x-mnemos-timestamp: 1712345678
x-mnemos-signature: t=1712345678,v1=<hex hmac_sha256(secret, "<t>.<rawBody>")>
```

- 事件：`memory.created` / `memory.updated` / `memory.deleted` / `task.finished` / `agent.registered` / `key.created` / `key.revoked` / `quota.exceeded`
- 重试：5s → 30s → 2m → 10m → 1h → 6h（最多 6 次），耗尽转死信；连续失败 10 次自动暂停
- 校验要求：时间戳容差 5 分钟，常量时间比较；用 `x-mnemos-delivery` 做去重
- SSRF 防护：仅 http/https；DNS 解析后拒绝回环/私网/链路本地/云元数据（`MNEMOS_WEBHOOK_ALLOW_PRIVATE=1` 仅供本地测试）

### 10.4 官方 SDK

- TypeScript：`sdk/typescript`（`@mnemos/sdk`，零依赖，支持重试/幂等键）
- Python：`sdk/python`（`mnemos-sdk`，零依赖，`urllib`）

```ts
import { MnemosClient } from '@mnemos/sdk';
const client = new MnemosClient({ apiKey: process.env.MNEMOS_API_KEY!, baseUrl: 'http://127.0.0.1:4380' });
const brief = await client.context.build({ agentId: 'agent-coder', taskId: 'task_orion_split_query' });
```

### 10.5 链路追踪

开启 `MNEMOS_OTEL_ENABLED=1` 后，每个请求返回 `x-trace-id`（同时写入访问日志 `traceId`），
span 通过 OTLP/HTTP 导出到 `MNEMOS_OTEL_ENDPOINT`（默认 `http://127.0.0.1:4318/v1/traces`）。

---

## 11. 中立记忆服务 v5（分区 + 人）

> 契约：[`neutral-memory-model.md`](neutral-memory-model.md)。模型说明：
> [`agent-memory-model.md`](agent-memory-model.md)。旧接口迁移：
> [`migration-v4-v5.md`](migration-v4-v5.md)。

所有中立端点挂在 `/v1/partitions/:partition/...`，`/v1/projects/:partition/...` 是**全量别名**。

- `:partition` 支持分区内部 id（`prj_…`）或 slug（如 `zhiwu-app`）；
- JSON 一律 snake_case；
- `project` key：`:partition` 必须等于自身分区；`org` key：可指定本组织任意分区；
- 记忆按「人（person）」组织，`scope` ∈ `person` / `partition` / `session`；
- 旧 `user_id` / `agent_id` / `visibility` 字段继续透传，并映射为 person/scope。

### 11.1 分区

#### `POST /v1/partitions`（org key + `admin`）

按 `slug` 幂等 upsert：已存在时只补全显式提供的展示字段（`name` / `description` / `region` / `env`），
不会覆盖已有设置。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `slug` | string | 是 | `^[a-z0-9][a-z0-9-]{0,47}$`，小写字母/数字/连字符 |
| `name` | string | 否 | 展示名，缺省 = slug |
| `description` | string | 否 | 描述（≤500） |
| `region` | string | 否 | 区域，缺省 `cn-shanghai` |
| `env` | string | 否 | `production` / `staging` / `development` 等 |

```bash
curl -X POST $BASE/v1/partitions \
  -H "Authorization: Bearer $ORG_KEY" -H 'content-type: application/json' \
  -d '{"slug":"zhiwu-app","name":"知物感恩 App","description":"消费类记忆场景"}'
```

```json
{
  "partition": {
    "id": "prj_zhiwu_app",
    "partition_id": "prj_zhiwu_app",
    "project_id": "prj_zhiwu_app",
    "org_id": "org_yunshu",
    "slug": "zhiwu-app",
    "name": "知物感恩 App",
    "description": "消费类记忆场景",
    "status": "active",
    "region": "cn-shanghai",
    "env": "production",
    "created_at": "2026-11-05T10:00:00.000Z",
    "updated_at": "2026-11-05T10:00:00.000Z",
    "archived_at": null
  },
  "created": true
}
```

新建返回 `201`；命中已有分区返回 `200` + `created=false`。project key 调用返回 `403 FORBIDDEN`。

#### `GET /v1/partitions/:partition`（`memories:read`）

返回 `{ "partition": { …同上… } }`（不含 `settings` 等敏感配置）。

### 11.2 人（Person）

#### `PUT /v1/partitions/:p/persons/:externalId`（`memories:write`）

建人 / 更新人，按 `(partition, type, external_id)` 幂等 upsert。`externalId` 由调用方定义
（App 的 `user_id`、Agent 的 id/name）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | `human`（默认）/ `agent` / `service` / `other` |
| `display_name` | string | 显示名，缺省 = externalId |
| `attributes` | object | 自由字段（角色、模型、画像、标签等），传入时整体替换 |
| `status` | string | `active`（默认）/ `archived` / `deleted` |

```bash
curl -X PUT $BASE/v1/partitions/zhiwu-app/persons/user-123 \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"human","display_name":"用户 123","attributes":{"tier":"pro"}}'
```

```json
{
  "person": {
    "id": "prs_…",
    "partition_id": "prj_zhiwu_app",
    "project_id": "prj_zhiwu_app",
    "external_id": "user-123",
    "type": "human",
    "display_name": "用户 123",
    "attributes": { "tier": "pro" },
    "status": "active",
    "first_seen_at": "2026-11-05T10:00:00.000Z",
    "last_seen_at": "2026-11-05T10:00:00.000Z",
    "created_at": "2026-11-05T10:00:00.000Z",
    "updated_at": "2026-11-05T10:00:00.000Z"
  }
}
```

#### `GET /v1/partitions/:p/persons`（`memories:read`）

| 查询参数 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | `human` / `agent` / `service` / `other` |
| `status` | string | `active` / `archived` / `deleted` |
| `q` | string | 按 `display_name` / `external_id` 模糊搜索 |
| `page` / `page_size` | number | 分页（默认 1 / 20，最大 100） |
| `sort` | string | `recent`（默认）/ `name` / `memories` |

响应（`results` 与 `items` 同内容）：

```json
{
  "results": [
    {
      "id": "prs_…", "partition_id": "prj_zhiwu_app", "external_id": "user-123",
      "type": "human", "display_name": "用户 123", "status": "active",
      "attributes": {}, "last_seen_at": "2026-11-05T10:00:00.000Z",
      "stats": { "memories": 5, "shared_memories": 0, "sessions": 2, "last_memory_at": "2026-11-04T12:00:00.000Z" }
    }
  ],
  "items": [ …同 results… ],
  "count": 1, "total": 1, "page": 1, "page_size": 20, "total_pages": 1
}
```

#### `GET /v1/partitions/:p/persons/:person`（`memories:read`）

`:person` 支持内部 `prs_…` id 或 `external_id`；同一 external_id 同时命中 human/agent 多类型时
会 404，请改用内部 id。响应 `{ "person": { …, "stats": {…} } }`。

#### `PATCH /v1/partitions/:p/persons/:person`（`memories:write`）

只更新显式提供的 `display_name` / `attributes` / `status`（`type` 与 `external_id` 不可改）；
至少提供一个字段，否则 400。

### 11.3 记忆（人级 / 分区共享）

#### `POST /v1/partitions/:p/memories`（`memories:write`）

在旧写入字段基础上新增（全部可选）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `text` / `messages` | — | 二选一 |
| `person_id` | string | 记忆主体：内部 id 或 external id |
| `person_external_id` | string | 记忆主体 external id（与 `person_id` 二选一） |
| `actor_person_id` | string | 写入者（缺省 = person） |
| `scope` | string | `person` / `partition` / `session`；缺省取分区 `defaultScope` |
| `session_id` | string | 会话；`scope=session` 时必填（旧 `task_id` 亦可） |
| `category` | string | 记忆分类；显式提供时默认原文入库（`infer=false`） |
| `tags` | string[] | 标签 |
| 旧字段 | — | `user_id` / `agent_id` / `run_id` / `app_id` / `task_id` / `visibility` 继续可用 |

```bash
curl -X POST $BASE/v1/partitions/zhiwu-app/memories \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"用户 123 喜欢黑咖啡，不加糖","person_id":"user-123","scope":"person","infer":false}'
```

响应与旧写入一致：`{results, events, extracted, merged, skipped, took_ms}`，`results[]` 带
`person_id` / `person_external_id` / `scope` / `session_id` 等新字段。

语义校验：`scope=person` 必须能解析到人（person 不存在且分区 `personAutoCreate=false` 时 404）；
`scope=session` 缺 `session_id` 返回 422；`infer=true` 抽取出的每条记忆继承人的归属与 scope。

#### `GET /v1/partitions/:p/memories`（`memories:read`）

| 查询参数 | 说明 |
| --- | --- |
| `person_id` / `person` | 按记忆主体过滤（内部 id 或 external id） |
| `scope` | `person` / `partition` / `session` |
| `category` / `status` | 分类 / 状态 |
| `q` | 关键词（走服务端混合检索） |
| `sort` | `recent` / `importance` / `accessed` |
| `include_private` | 默认 false：调用方视角只看分区共享 + 本人私有；审计传 true |
| `page` / `page_size` | 分页 |

响应：`{results, items, count, total, page, page_size, total_pages}`。

#### `POST /v1/partitions/:p/memories/search`（`memories:read`）

请求：`{query, person_id?, person?, scope?, category?, top_k?, threshold?, include_private?}`。
响应与旧检索一致，额外支持按人/scope 过滤：

```json
{
  "results": [{ "id": "mem_…", "person_id": "prs_…", "person_external_id": "user-123",
                "scope": "person", "session_id": null, "memory": "…", "score": 0.73, "signals": {…} }],
  "count": 1, "total": 1, "took_ms": 6,
  "signals": { "weights": {…}, "strategy": "hybrid", "query_terms": ["牛奶"] }
}
```

#### `GET` / `PATCH` / `DELETE /v1/partitions/:p/memories/:id`（`memories:read` / `memories:write`）

- `GET`：详情（含 `history` / `entities` / `relations` / `neighbors`）。
- `PATCH`：`{content?, category?, importance?, status?, tags?, metadata?, expires_at?}`，返回更新后的记忆本体（snake_case）。
- `DELETE`：软删除，返回 `{ "message": "deleted", "ok": true }`。

### 11.4 人的简报 / 上下文 / 做梦

#### `GET /v1/partitions/:p/persons/:person/brief`（`memories:read`）

| 查询参数 | 说明 |
| --- | --- |
| `force` | `true` 忽略缓存重新生成 |
| `max_chars` | 临时覆盖分区 `briefMaxChars`（服务端 clamp 100–5000） |

返回 `MemoryBrief`（v5 平铺带 `person_id`）：

```json
{
  "project_id": "prj_zhiwu_app", "partition_id": "prj_zhiwu_app", "person_id": "prs_…",
  "text": "# 人的简报\n- [偏好] 用户 123 喜欢黑咖啡…",
  "max_chars": 500, "count": 4, "model": "mnemos-condense", "cached": false,
  "generated_at": "2026-11-05T10:00:00.000Z",
  "recent": [{ "id": "mem_…", "content": "…", "category": "preference", "importance": 0.7,
               "updated_at": "…", "person_id": "prs_…", "person_external_id": "user-123", "scope": "person" }]
}
```

组成：该人 `scope=person` 记忆 + 与其相关的 `scope=partition` 记忆。

#### `POST /v1/partitions/:p/persons/:person/context`（`memories:read`）

请求：`{query?, budget_tokens?, include_partition?}`（`budget_tokens` 默认 1200，范围 60–32000）。

响应：

```json
{
  "person": { "id": "prs_…", "external_id": "user-123", "display_name": "用户 123", "stats": {…} },
  "brief": { "text": "…", "max_chars": 500, "count": 4, "person_id": "prs_…" },
  "memories": [ …与该人相关、按 query 排序的记忆… ],
  "shared": [ …分区共享知识（scope=partition）… ],
  "prompt": "# 人的上下文…\n可直接拼进 system prompt 的中文 Markdown",
  "token_estimate": 603,
  "citations": ["mem_…"],
  "built_at": "2026-11-05T10:00:00.000Z"
}
```

#### 做梦

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/partitions/:p/dream` | 分区级做梦状态（`scope=partition`） |
| `POST` | `/v1/partitions/:p/dream/run` | 分区级手动做梦：`{person_id?, batch_size?}` |
| `GET` | `/v1/partitions/:p/persons/:person/dream` | 人级做梦状态（`person_id` 为该人） |
| `POST` | `/v1/partitions/:p/persons/:person/dream/run` | 人级手动做梦：`{batch_size?}` |

响应统一为 `{run, status}`（`GET` 只返回 `status`）：

```json
{
  "run": { "id": "dream_…", "partition_id": "prj_zhiwu_app", "person_id": "prs_…",
           "trigger": "manual", "status": "completed", "input_count": 3, "insight_count": 1,
           "started_at": "…", "finished_at": "…" },
  "status": { "person_id": "prs_…", "settings": { "enabled": true, "interval_minutes": 1440 },
              "pending_count": 0, "runs": [ …最近 10 次… ] }
}
```

同一人（或分区）正在做梦时返回 `409 CONFLICT`。

### 11.5 旧 → 新映射与兼容

| 旧 | 新 | 说明 |
| --- | --- | --- |
| `user_id` | `person_id`（type=human） | 写入时自动建档（`personAutoCreate`） |
| `agent_id` | `person_id`（type=agent） | agent 注册表名作为 display_name |
| `visibility=project` | `scope=partition` | 双写旧列 |
| `visibility=agent` | `scope=person` | 双写旧列 |
| `visibility=task` | `scope=session` | `session_id = COALESCE(task_id, run_id)` |
| `GET /v1/memories?user_id=` | `GET /v1/partitions/:p/memories?person_id=` | 旧端点保留（不新增 person 筛选） |
| `POST /v1/context` | `POST /v1/partitions/:p/persons/:person/context` | 旧接口保留 |
| `/v1/projects/:id/...` | `/v1/partitions/:id/...` | 全量别名，行为一致 |

兼容承诺：v5 只增不改——旧端点、旧字段、旧 SDK 调用继续可用；新字段（`person_id` / `scope` /
`session_id` / `partition_id`）在响应中增量出现。

### 11.6 SDK（TypeScript）

```ts
import { MnemosClient } from '@mnemos/sdk';

const client = new MnemosClient({ apiKey: process.env.MNEMOS_ORG_KEY! }); // org key

const { partition } = await client.partitions.create({ slug: 'zhiwu-app', name: '知物感恩 App' });
await client.persons.upsert(partition.slug, 'user-123', { type: 'human', displayName: '用户 123' });
await client.memories.add({
  partition: partition.slug,
  text: '用户 123 喜欢黑咖啡，不加糖',
  personId: 'user-123',
  scope: 'person',
});
const brief = await client.personBrief(partition.slug, 'user-123', { maxChars: 400 });
const context = await client.personContext(partition.slug, 'user-123', { query: '咖啡偏好', budgetTokens: 800 });
console.log(brief.text, context.prompt);
```

> `memories.get/update/delete` 传 `{ partition }` 走中立分区端点；不传则保持旧 `/v1/memories` 行为。
> 提供 `personId` / `scope` / `sessionId` 等字段时**必须**同时提供 `partition`，否则 SDK 直接抛
> `TypeError`（避免旧端点静默忽略）。
