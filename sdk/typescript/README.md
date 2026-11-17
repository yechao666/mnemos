# `@mnemos/sdk`（TypeScript）

Mnemos v6 官方 TypeScript SDK：**分区（Partition）+ 人（Person）+ 记忆（Memory）** 的中立记忆服务客户端。

- 面向 `/v1/partitions/:partition/...` 公开 API（API Key 鉴权）；
- 人 / 记忆列表统一**游标分页**（`{ items, next_cursor, partition_stats }`，不返回 total）；
- 零运行时依赖，Node ≥18（全局 `fetch`）与现代浏览器通用，ESM；
- 入参接受 **camelCase 与 snake_case**，统一序列化为 snake_case；响应归一化为 snake_case；
- 429 / 502 / 503 / 504 与网络错误指数退避重试，尊重 `Retry-After`。

> v6 删除了 v5 的 Agent / 任务 / 任务简报 / Webhook / 图谱等领域，SDK 不再提供对应方法。

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
  settings: { defaultScope: 'partition' }, // 也接受 default_scope
});

// 2) 建档一个人（App 用户 / 员工 / 智能体都是「人」）
const person = await client.persons.upsert(partition.slug, 'user-1', {
  type: 'human',
  displayName: '周野',
  attributes: { team: 'core' },
});

// 3) 写一条记忆（person 必填；scope 缺省取分区设置）
const { memory } = await client.memories.add(partition.slug, person.external_id, {
  text: '周野偏好用中文写评审意见。',
  scope: 'partition', // person=仅本人 / partition=分区共享 / session=仅会话
  category: 'preference',
  tags: ['偏好'],
});

// 4) 取人的上下文（资料 + 简报 + 相关记忆 + 分区共享知识，附可注入 prompt）
const context = await client.personContext(partition.slug, person.external_id, {
  query: '评审关注点',
  budgetTokens: 800,
});
console.log(context.prompt);

// 5) 检索
const hits = await client.memories.search(partition.slug, {
  query: '评审偏好',
  personId: person.id,
  topK: 5,
});
console.log(hits.results.map((item) => item.content));
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
        ├── Session（可选分组）
        └── Brief / Dream（人级）
Partition 级：统计、密钥、用量、审计
```

- **记忆永远属于一个人**：写入时 `personId` / `personRef` 必填，没有「无人记忆」。
- **共享由记忆级 `scope` 决定**：`partition` 分区共享、`person` 仅本人、`session` 仅该会话。
- **人不是登录账号**：`external_id` 由调用方定义（App 的 user_id、Agent 的 id/name）。
- 人群列表的计数已反规范化在 `persons` 行上（`memory_count` / `shared_memory_count` / `session_count`），列表页不逐条查统计。

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

### 人

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `persons.list(p, query?)` | `GET .../persons` | 游标分页：`cursor` / `limit` / `q` / `type` / `status` / `sort` |
| `persons.get(p, personRef)` | `GET .../persons/:person` | 详情（内部 id 或 external id） |
| `persons.upsert(p, externalId, input?)` | `PUT .../persons/:externalId` | 建档 / 更新 |
| `persons.update(p, personRef, input)` | `PATCH .../persons/:person` | 展示名 / attributes / status |

### 记忆

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `memories.list(p, query?)` | `GET .../memories` | 分区全局列表：`person_id` / `person_external_id` / scope / category / status / q / cursor / limit |
| `memories.listByPerson(p, personRef, query?)` | `GET .../persons/:person/memories` | 某人的记忆 |
| `memories.add(p, personRef, input)` | `POST .../persons/:person/memories` | 写入记忆，返回 `{ memory, events }` |
| `memories.search(p, input)` | `POST .../memories/search` | FTS5 前缀检索，返回 `{ results, took_ms, next_cursor }` |
| `memories.get(p, id)` | `GET .../memories/:id` | 详情（含 `person`） |
| `memories.update(p, id, input)` | `PATCH .../memories/:id` | 更新，返回 `{ memory }` |
| `memories.delete(p, id)` | `DELETE .../memories/:id` | 删除（204） |

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
> 公开 v1 的分区 / 人 / 记忆 / 简报 / 做梦 / health 才使用 `mnemos_live_*` API Key。
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
- `q` 走 FTS5 前缀搜索；空串按索引排序。

## 7. 请求约定

- **入参命名**：camelCase 为主（`displayName`、`sessionId`、`maxChars`），同时接受 snake_case（`display_name`、`session_id`、`max_chars`）；客户端统一发 snake_case。
- **响应命名**：统一归一化为 snake_case（`created_at`、`memory_count`、`next_cursor`），控制台 camelCase 响应也一样。
- **`scope`**：`person` 仅本人 / `partition` 分区共享 / `session` 仅会话（需 `sessionId`）。
- **重试**：GET、只读检索 POST、PUT/PATCH/DELETE 可安全重试；写记忆 / 做梦 / 建密钥等非只读 POST 不自动重试，避免重复写入。
- **幂等键**：写请求可传 `{ idempotencyKey }`，每次尝试都会携带同一个 `Idempotency-Key` 头；v6 服务端不持久化幂等记录，请勿依赖它做服务端去重。
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

- 服务端错误：`status` 为 HTTP 状态，`code` 为稳定英文标识（如 `VALIDATION_ERROR`、`NOT_FOUND`、`RATE_LIMITED`）；
- 网络错误：`status=0`、`code="network_error"`；
- 超时：`status=0`、`code="timeout"`；
- 主动取消：`status=0`、`code="aborted"`。

## 9. 主要类型

`Partition` / `PartitionInput` / `PartitionStats` / `PartitionSettings`、
`Person` / `PersonInput` / `PersonListQuery`、`PersonBrief` / `PersonContext`、
`Memory` / `MemoryInput` / `MemoryListQuery` / `MemorySearchInput` / `MemoryDetail`、
`MemoryScope` / `MemoryCategory` / `MemoryStatus`、`CursorPage<T>`、
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
| `client.graph()` / `client.stats()` / `client.export()` | 删除（图谱 / 项目统计 / 导出不在 v6） |
| `client.webhooks.*` | 删除 |
| 页码分页（`page` / `pageSize` / `total`） | 游标分页（`cursor` / `limit` / `next_cursor`） |

## 11. 开发与测试

```bash
cd sdk/typescript
npx tsc -p tsconfig.json      # 构建 dist
node --test test/*.test.ts    # mock fetch，无需启动服务
```

测试覆盖：v6 端点路径、camelCase→snake_case 请求体、游标查询、响应归一化、
错误映射、429/5xx 重试、非幂等 POST 不重试、超时与取消。
