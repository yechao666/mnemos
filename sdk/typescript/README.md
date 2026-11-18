# `@mnemos/sdk`（TypeScript）

Mnemos v6.1 官方 TypeScript SDK：**分区（Partition）+ 人（Person）+ 记忆（Memory）** 的中立记忆服务客户端。

- 面向 `/v1/partitions/:partition/...` 公开 API（API Key 鉴权）；
- 人 / 记忆列表统一**游标分页**（`{ items, next_cursor, partition_stats }`，不返回 total）；
- **混合检索**：`memories.search` 返回 `hits`（`score` / `signals` / `matched_on`）、`took_ms`、`mode`、`strategy`；
  `results` 是 v6 兼容别名；
- **记忆演化**：写入支持 `supersedesId` / `factKey` / `validFrom`；`history` 时间线、`feedback` 反馈调权；
- **画像与生命周期**：`persons.profile` / `listFacts` / `upsertFact(s)` / `removeFact` / `merge` / `archive` / `export` / `remove`；
- **图与多模态**：`graph` / `entities`；写记忆可带 `attachments`（图片 / 音频 / 视频 / 文件）；
- 零运行时依赖，Node ≥18（全局 `fetch`）与现代浏览器通用，ESM；
- 入参接受 **camelCase 与 snake_case**，统一序列化为 snake_case；响应归一化为 snake_case；
- 429 / 502 / 503 / 504 与网络错误指数退避重试，尊重 `Retry-After`；写请求带 `idempotencyKey` 时
  可安全重试（服务端 24h 幂等回放）。

> v6 删除了 v5 的 Agent / 任务 / 任务简报 / Webhook 等领域，SDK 不再提供对应方法。

---

## 1. 安装

```bash
pnpm add @mnemos/sdk      # 发布后
# 或
pnpm add ./sdk/typescript # 仓库内
```

默认服务地址 `http://127.0.0.1:4380`。

## 2. 快速开始

```ts
import { MnemosClient } from '@mnemos/sdk';

const client = new MnemosClient({
  apiKey: process.env.MNEMOS_API_KEY!, // mnemos_live_…
  baseUrl: 'http://127.0.0.1:4380',
});

// 1) 建 / 幂等 upsert 分区（需要 org key + admin 权限）
const partition = await client.partitions.create({
  slug: 'ws-demo',
  name: '演示分区',
  settings: {
    defaultScope: 'partition',
    retrievalMode: 'hybrid',
    retrievalWeights: { vector: 0.45, keyword: 0.3, recency: 0.15, importance: 0.1 },
  },
});

// 2) 建档一个人（App 用户 / 员工 / 智能体都是「人」）
const person = await client.persons.upsert(partition.slug, 'user-1', {
  type: 'human',
  displayName: '周野',
  attributes: { team: 'core' },
  consent: { memory: true, marketing: false },
});

// 3) 写一条记忆（person 必填；带 factKey 时同槽位新记忆自动取代旧事实）
const { memory, event } = await client.memories.add(
  partition.slug,
  person.external_id,
  {
    text: '周野偏好用中文写评审意见。',
    scope: 'partition',
    category: 'preference',
    factKey: 'preference.language',
    attachments: [{ kind: 'image', url: 'https://example.com/board.png', caption: '评审白板' }],
  },
  { idempotencyKey: 'write-user-1-preference-language' },
);
console.log(event); // ADD / MERGE / NOOP / SUPERSEDE

// 3b) 隐私值走占位符协议：正文只存 {{key}} token，真实值放 placeholders（服务端加密保存，不落正文）
const privateWrite = await client.memories.add(partition.slug, person.external_id, {
  content: '张三的手机号是 {{phone_a1b2}}，邮箱是 {{mail_c3d4}}。',
  placeholders: {
    phone_a1b2: '18334423321',
    mail_c3d4: 'zhangsan@example.com',
  },
  scope: 'person',
});
console.log(privateWrite.memory.content); // 只含 {{phone_a1b2}} / {{mail_c3d4}}

// 4) 混合检索：hits 带信号分解
const search = await client.memories.search(partition.slug, {
  query: '评审偏好',
  personId: person.id,
  mode: 'hybrid',
  topK: 5,
});
for (const hit of search.hits) {
  console.log(hit.score, hit.signals, hit.matched_on, hit.content);
}
console.log(search.took_ms, search.mode, search.strategy);

// 5) 历史 / 反馈
const history = await client.memories.history(partition.slug, memory.id);
const feedback = await client.memories.feedback(partition.slug, memory.id, {
  helpful: true,
  query: '评审偏好',
});

// 6) 画像 / facts
const profile = await client.persons.profile(partition.slug, person.external_id);
await client.persons.upsertFact(partition.slug, person.external_id, {
  key: 'identity.job',
  value: '产品经理',
  confidence: 0.9,
});

// 7) 上下文（资料 + 简报 + 相关记忆 + 分区共享知识，附可注入 prompt）
const context = await client.personContext(partition.slug, person.external_id, {
  query: '评审关注点',
  budgetTokens: 800,
});
console.log(context.prompt);

// 8) 图谱 / 实体
const graph = await client.graph(partition.slug, { limit: 100 });
const entities = await client.entities(partition.slug, { q: '评审', limit: 50 });
```

可运行示例：

```bash
MNEMOS_API_KEY=mnemos_live_… node examples/basic.ts
```

## 3. 核心模型

```text
Partition（App / 项目 / 租户 / 工作区）
  └── Person（human | agent | service | other）
        ├── Memory（person_id NOT NULL；scope=person | partition | session）
        │     ├── 演化：valid_from / valid_to / supersedes / superseded_by / fact_key
        │     ├── 附件：attachments（URL + caption）
        │     └── 历史：memory_history（ADD/UPDATE/MERGE/SUPERSEDE/DELETE/NOOP/FEEDBACK）
        ├── PersonFact / PersonProfile（结构化画像）
        ├── Session（可选分组）
        └── Brief / Dream（人级）
  Partition 级：实体关系图、统计、密钥、用量、审计、异步任务
```

- **记忆永远属于一个人**：写入时 `personId` / `personRef` 必填，没有「无人记忆」。
- **共享由记忆级 `scope` 决定**：`partition` 分区共享、`person` 仅本人、`session` 仅该会话。
- **事实会演化**：`factKey` 相同的新写入会自动把旧记忆 `valid_to` 置为当前时间并写 `SUPERSEDE` 历史；
  默认检索排除已失效记忆，`asOf` 可回看历史时间点。
- 人列表的计数已反规范化在 `persons` 行上（`memory_count` / `shared_memory_count` / `session_count`）。

## 4. 客户端选项

```ts
const client = new MnemosClient({
  apiKey: 'mnemos_live_…',      // 公开 v1：API Key；keys.*：控制台会话 token
  baseUrl: 'http://127.0.0.1:4380',
  timeoutMs: 30_000,             // 单次尝试超时
  maxRetries: 2,                 // 429/5xx/网络错误的最大重试次数
  fetchImpl: customFetch,        // 可选：测试或特殊运行时
});
```

## 5. API 一览

### 分区

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `partitions.list()` | `GET /v1/partitions` | 本组织分区（需 org key） |
| `partitions.create(input)` | `POST /v1/partitions` | 建 / 幂等 upsert（org key + admin） |
| `partitions.get(ref)` | `GET /v1/partitions/:p` | 分区信息 + settings |
| `partitions.update(ref, input)` | `PATCH /v1/partitions/:p` | 名称 / 描述 / 状态 / 设置 |
| `partitions.stats(ref)` | `GET /v1/partitions/:p/stats` | 统计（直接读 `partition_stats`，O(1)） |

`:p` 支持内部 id 或 slug。

`settings` 可读写（camelCase 入参 / snake_case 响应）：

| v1 字段 | 默认 | 说明 |
| --- | --- | --- |
| `default_scope` | `partition` | 新记忆缺省 scope |
| `brief_max_chars` / `brief_enabled` | 1200 / true | 简报 |
| `dream_enabled` / `dream_interval_minutes` | true / 1440 | 做梦调度 |
| `retention_days` / `monthly_quota` | 0 / 0 | 保留期 / 月配额 |
| `person_auto_create` / `locale` | true / zh-CN | 建档 / 语言 |
| `retrieval_mode` | `hybrid` | `hybrid` / `keyword` / `vector` |
| `retrieval_weights` | `0.45/0.3/0.15/0.1/0` | `vector` / `keyword` / `recency` / `importance` / `entity` |
| `embedding_model` | `mnemos-hash-384` | 本地模型或外部模型名 |
| `merge_threshold` / `dedupe_threshold` | 0.95 / 0.98 | 合并 / 去重阈值 |
| `auto_extract_entities` | true | 写入后异步抽取实体 |
| `pii_redaction` | `off` | `basic` 时写入脱敏手机号 / 邮箱 / 身份证 / 银行卡（保留后四位） |

### 人

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `persons.list(p, query?)` | `GET .../persons` | 游标分页：`cursor` / `limit` / `q` / `type` / `status` / `sort` / `includeMerged` |
| `persons.get(p, personRef)` | `GET .../persons/:person` | 详情（内部 id 或 external id） |
| `persons.upsert(p, externalId, input?)` | `PUT .../persons/:externalId` | 建档 / 更新（含 `consent`） |
| `persons.update(p, personRef, input)` | `PATCH .../persons/:person` | 展示名 / attributes / status / consent |
| `persons.profile(p, personRef, query?)` | `GET .../persons/:person/profile` | 画像：资料 + 当前 facts + 摘要（`force` / `refresh`） |
| `persons.listFacts(p, personRef)` | `GET .../persons/:person/facts` | 当前有效 facts |
| `persons.upsertFact(p, personRef, input)` | `PUT .../persons/:person/facts` | 写单条 fact（同 key 版本化） |
| `persons.upsertFacts(p, personRef, facts)` | `PUT .../persons/:person/facts` | 批量写（≤100） |
| `persons.removeFact(p, personRef, factId)` | `DELETE .../facts/:factId` | 软关闭 fact（保留历史版本） |
| `persons.merge(p, personRef, input)` | `POST .../persons/:person/merge` | 合并到目标人（迁移 memories/facts/feedback） |
| `persons.archive(p, personRef)` | `POST .../persons/:person/archive` | 归档（数据保留可读） |
| `persons.export(p, personRef)` | `GET .../persons/:person/export` | 合规导出（person + facts + ≤10000 条记忆） |
| `persons.remove(p, personRef, { hard? })` | `DELETE .../persons/:person` | 默认软删；`hard: true` 物理级联删除 |

### 记忆

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `memories.list(p, query?)` | `GET .../memories` | 分区全局列表：`person_id` / `person_external_id` / scope / category / status / q / cursor / limit |
| `memories.listByPerson(p, personRef, query?)` | `GET .../persons/:person/memories` | 某人的记忆 |
| `memories.add(p, personRef, input, options?)` | `POST .../persons/:person/memories` | 写入；返回 `{ memory, event, superseded_id, events }`；隐私值用 `input.placeholders` |
| `memories.search(p, input)` | `POST .../memories/search` | 混合检索：`hits` / `signals` / `mode` / `strategy` |
| `memories.get(p, id)` | `GET .../memories/:id` | 详情（含 `person` 与附件明细） |
| `memories.update(p, id, input)` | `PATCH .../memories/:id` | 更新，返回 `{ memory }` |
| `memories.history(p, id)` | `GET .../memories/:id/history` | 变更历史时间线 |
| `memories.feedback(p, id, input)` | `POST .../memories/:id/feedback` | `{helpful, query?, reason?}`，±0.05 调 confidence |
| `memories.delete(p, id)` | `DELETE .../memories/:id` | 删除（204） |

写记忆可选字段：`supersedesId`、`factKey`、`validFrom`、`attachments[]`、`placeholders`（隐私占位符映射：
正文写 `{{key}}`，真实值放映射；key 为 `[A-Za-z0-9_-]{3,64}`；列表/搜索只返回计数，详情 `?reveal=placeholders`
才解密，`brief/context` 自动还原）。
（每记忆 ≤10，`kind` = image/audio/video/file，`url` ≤2000，`caption` ≤1000）。

### 图 / 实体

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `graph(p, query?)` | `GET /v1/partitions/:p/graph` | 实体关系图：`nodes` / `edges` / `stats`（`personId` / `limit` ≤500） |
| `entities(p, query?)` | `GET /v1/partitions/:p/entities` | 实体列表：`q` 子串 / `personId` / `limit` ≤200 |

### 简报 / 上下文 / 做梦（人级）

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `personBrief(p, personRef, query?)` | `GET .../persons/:person/brief` | 人级简报（`force` / `maxChars`） |
| `personContext(p, personRef, input?)` | `POST .../persons/:person/context` | 资料 + 简报 + 记忆 + 共享知识 + prompt |
| `personDream(p, personRef)` | `GET .../persons/:person/dream` | 做梦状态（设置 / 待整理数 / 最近运行） |
| `personDreamRun(p, personRef, input?)` | `POST .../persons/:person/dream/run` | 手动触发一次增量做梦 |

### 密钥 / 健康检查

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `keys.list(p)` / `keys.create(p, input)` | `/api/partitions/:p/keys` | 分区 key 列表 / 创建 |
| `keys.rotate(p, keyId, input?)` / `keys.revoke(p, keyId)` | `/api/partitions/:p/keys/:id` | 轮换（旧 key 立即吊销）/ 吊销 |
| `keys.org.list()` / `keys.org.create(input)` / `keys.org.revoke(id)` | `/api/org/keys` | 组织级 key（仅 owner） |
| `health()` | `GET /health` | 健康检查（无需鉴权） |

> `keys.*` 走控制台 `/api`，需要把 **控制台会话 token** 作为 `apiKey`；
> 公开 v1 的分区 / 人 / 记忆 / 简报 / 做梦 / graph / health 才使用 `mnemos_live_*` API Key。
> 创建 / 轮换响应里的 `secret` 只出现一次，请立即保存。

## 6. 游标分页

```ts
let cursor: string | undefined;
do {
  const page = await client.persons.list('ws-demo', {
    type: 'human',
    status: 'active',
    sort: 'recent', // recent=最近活跃 / new=最近新建 / name=显示名
    limit: 50,
    cursor,
  });
  for (const person of page.items) console.log(person.display_name, person.memory_count);
  console.log('分区统计', page.partition_stats);
  cursor = page.next_cursor ?? undefined;
} while (cursor);
```

- `limit` 默认 50、最大 200；`next_cursor=null` 表示没有更多。
- 列表**不返回 total**，头部统计用 `partition_stats`（来自 `partition_stats` 表，不做 `COUNT(*)`）。
- `q` 走 FTS5 前缀搜索；空串按索引排序。换 `sort` 必须丢弃旧游标（服务端返回 `400 INVALID_CURSOR`）。

## 7. 请求约定

- **入参命名**：camelCase 为主（`displayName`、`sessionId`、`maxChars`），同时接受 snake_case；客户端统一发 snake_case。
- **响应命名**：统一归一化为 snake_case（`created_at`、`memory_count`、`next_cursor`、`valid_to`、`matched_on`），控制台 camelCase 响应也一样。
- **`scope`**：`person` 仅本人 / `partition` 分区共享 / `session` 仅会话（需 `sessionId`）。
- **重试**：GET、只读检索 POST、PUT/PATCH/DELETE 可安全重试；写记忆 / 做梦 / 建密钥等非只读 POST
  只有携带 `idempotencyKey` 时才自动重试。
- **幂等键**：写请求可传 `{ idempotencyKey }`（8–128 字符）。v6.1 服务端持久化 24h：
  相同 key + 相同方法/路径/请求体回放首次响应；不同 body / 路径返回 `409 CONFLICT`。
- **`DELETE`**：成功返回 `204`，方法返回 `void`。

## 8. 错误处理

```ts
import { MnemosApiError } from '@mnemos/sdk';

try {
  await client.memories.add('ws-demo', 'user-1', { text: '…' });
} catch (error) {
  if (error instanceof MnemosApiError) {
    console.error(error.status, error.code, error.message);
    if (error.requestId) console.error('requestId:', error.requestId);
    if (error.details) console.error('details:', error.details);
  }
}
```

- 服务端错误：`status` 为 HTTP 状态，`code` 为稳定英文标识（如 `VALIDATION_ERROR`、`NOT_FOUND`、`CONFLICT`、`RATE_LIMITED`）；
- 网络错误：`status=0`、`code="network_error"`；
- 超时：`status=0`、`code="timeout"`；
- 主动取消：`status=0`、`code="aborted"`。

## 9. 主要类型

`Partition` / `PartitionInput` / `PartitionStats` / `PartitionSettings` / `RetrievalWeights`、
`Person` / `PersonInput` / `PersonListQuery` / `PersonFact` / `PersonProfile` / `PersonMergeResult` / `PersonExport`、
`Memory` / `MemoryInput` / `MemoryAttachment` / `MemorySearchInput` / `MemorySearchHit` / `MemorySearchSignals` /
`MemoryHistoryEntry` / `MemoryFeedbackInput`、`EntityGraph` / `EntitySummary`、
`PersonBrief` / `PersonContext`、`CursorPage<T>`、
`DreamRun` / `DreamStatus` / `DreamResult`、`ApiKey`（别名 `Key`）、
`Usage` / `Audit` / `HealthResponse`、`MnemosApiError`。

`DreamRun` 是 `MemoryDreamRun` 的别名，`DreamResult` 是 `MemoryDreamResult` 的别名。

## 10. 从 v5 迁移

| v5 | v6 |
| --- | --- |
| `client.memories.add({ user_id })` | `client.memories.add(partition, personRef, input)` |
| `client.memories.list({ personId })` | `client.memories.list(partition, { personId })` 或 `listByPerson` |
| `client.agents.*` / `client.tasks.*` | 删除（v6 无 Agent / 任务领域） |
| `client.context.build()` / `client.brief()` | `client.personContext()` / `client.personBrief()` |
| `client.webhooks.*` | 删除 |
| 页码分页（`page` / `pageSize` / `total`） | 游标分页（`cursor` / `limit` / `next_cursor`） |
| 无历史 / 反馈 / 画像 / 图谱 | `memories.history` / `feedback`、`persons.profile` / `facts`、`graph` / `entities` |

## 11. 开发与测试

```bash
cd sdk/typescript
npx tsc -p tsconfig.json      # 构建 dist
node --test test/*.test.ts    # mock fetch，无需启动服务
```

测试覆盖：v6 / v6.1 端点路径、camelCase→snake_case 请求体、游标查询、检索信号、
写管线字段与附件、历史/反馈、画像/facts/生命周期、图谱/实体、响应归一化、错误映射、
429/5xx 重试、幂等键语义、超时与取消。

## 12. 相关 SDK 与集成

| 项目 | 说明 |
| --- | --- |
| [`sdk/python`](../python/README.md) | Python SDK（零第三方依赖，`urllib`） |
| [`integrations/mcp-mnemos`](../../integrations/mcp-mnemos/README.md) | MCP server（stdio，DSH / Claude 客户端） |
| [`integrations/langchain-mnemos`](../../integrations/langchain-mnemos/README.md) | LangChain `BaseStore` 适配器 |
