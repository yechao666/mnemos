# `@mnemos/sdk` — Mnemos TypeScript SDK

Mnemos 官方 TypeScript 客户端：记忆写入、混合检索、Agent 注册表、任务会话与任务简报、记忆简报 / 做梦、图谱 / 统计、导入导出，以及 Webhook（beta）。

- **零运行时依赖**：只用全局 `fetch`、`URL`、`AbortSignal`；
- **Node ≥18 与浏览器通用**（依赖全局 `fetch`）；
- **TypeScript 优先**：类型手写在 `src/types.ts`，`dist/` 带 `.d.ts`；
- 面向 `/v1/*` 公开 API（API Key 鉴权、snake_case 线上契约）；记忆简报 / 做梦 5 个方法走控制台 `/api/*`（会话令牌），入参为 camelCase、出参仍按 SDK 惯例归一化为 snake_case。

## 安装

```bash
# 发布后
pnpm add @mnemos/sdk
# 或 npm install @mnemos/sdk

# 仓库内（SDK 不在 pnpm workspace 中，需要独立安装/链接）
pnpm add ./sdk/typescript
```

要求 Node ≥18。

## 快速开始

```ts
import { MnemosApiError, MnemosClient } from '@mnemos/sdk';

const client = new MnemosClient({
  apiKey: 'mnemos_live_demo_atlas_ci', // 演示项目 Atlas
  baseUrl: 'http://127.0.0.1:4380',    // 默认值
});

// 1. 写入记忆
const added = await client.memories.add({
  messages: [{ role: 'user', content: '我是张倩，偏好企业微信联系。' }],
  userId: 'cust-1042',
  agentId: 'agent-support-l1',
  infer: true,
});

// 2. 混合检索
const hits = await client.memories.search({
  query: '张倩的联系偏好',
  userId: 'cust-1042',
  topK: 5,
  threshold: 0.2,
});
for (const hit of hits.results) {
  console.log(hit.score, hit.content); // content 与 memory 是同一个正文
}

// 3. 任务简报（可直接拼进 system prompt）
const briefing = await client.context.build({
  agentId: 'agent-support-l1',
  query: '客户联系方式偏好',
  budgetTokens: 800,
});
console.log(briefing.prompt);
```

仓库内可运行示例：

```bash
node sdk/typescript/examples/basic.ts
# 可选：MNEMOS_API_KEY=... MNEMOS_BASE_URL=... node sdk/typescript/examples/basic.ts
```

> 示例直接运行 `src/**/*.ts` 源码，需要 Node 24+ 的原生 TypeScript 支持；
> Node 18–22 请先 `pnpm exec tsc -p sdk/typescript/tsconfig.json`，再运行 `dist/` 中的 JS。

## 客户端配置

```ts
const client = new MnemosClient({
  apiKey: 'mnemos_live_xxx', // 必填，非空
  baseUrl: 'https://mnemos.example.com', // 默认 http://127.0.0.1:4380
  timeoutMs: 30_000,         // 单次尝试超时，默认 30s
  maxRetries: 2,             // 默认 2
  fetchImpl: fetch,          // 测试/特殊运行时注入
});
```

`baseUrl` 允许带路径前缀（如 `https://host/mnemos`），SDK 保留前缀。

## API 一览

| 资源 | 方法 |
| --- | --- |
| `client.memories` | `add` / `search` / `list` / `get` / `update` / `delete` / `history` / `feedback` |
| `client.agents` | `list` / `create` |
| `client.tasks` | `list` / `create` / `get` / `finish` |
| `client.context` | `build` |
| `client` | `graph(limit?)` / `stats()` / `health()` / `export()` / `import(doc)` / `brief(projectId, params?)` / `updateBriefSettings(projectId, maxChars)` / `dream(projectId)` / `updateDreamSettings(projectId, input)` / `runDream(projectId)` |
| `client.webhooks` | `list` / `create` / `update` / `delete` / `rotateSecret` / `deliveries` / `replay`（**beta**） |

写请求可传第二个参数：

```ts
await client.memories.add(
  { text: '必须保留的决策', user_id: 'u-1' },
  { idempotencyKey: 'memory-add-20261105-0001' },
);
```

单个请求还可传 `signal`（外部取消）、`timeoutMs`（覆盖超时）、`headers`。

### 命名约定

- **入参**：以 camelCase 为主（`userId`、`topK`、`includePrivate`），同时接受 snake_case 别名（`user_id`、`top_k`、`include_private`），统一序列化为 snake_case 发送；
- **出参**：统一归一化为 snake_case（`user_id`、`created_at`、`matched_on`），即使服务端个别接口返回 camelCase；
- 记忆正文同时暴露 `content` 与 `memory`（服务端列表/检索接口字段名为 `memory`）；
- 任务简报的 `agent` / `task` 可能为 `null`（未指定时）。

## 错误处理

所有失败都抛 `MnemosApiError`：

```ts
try {
  await client.memories.get('mem_missing');
} catch (error) {
  if (error instanceof MnemosApiError) {
    console.error(error.status);    // HTTP 状态；网络/超时为 0
    console.error(error.code);      // 稳定错误码，比较时建议忽略大小写
    console.error(error.message);   // 可直接展示的中文文案
    console.error(error.requestId); // 服务端请求 ID，便于排查
    console.error(error.details);   // 校验明细等
  }
}
```

常见错误码（`docs/api.md`）：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `validation_error` | 参数不合法（`details` 带字段明细） |
| 401 | `unauthorized` | 缺少/无效 API Key |
| 403 | `forbidden` | 作用域不足（如缺 `memories:write`） |
| 404 | `not_found` | 资源不存在或不属于该项目 |
| 409 | `conflict` | 唯一约束 / 幂等键冲突 |
| 413 | `payload_too_large` | 请求体超过 1 MB |
| 422 | `unprocessable` | 语义校验失败 |
| 429 | `rate_limited` | 超出限流或配额 |
| 500 | `internal_error` | 服务端异常 |

> 当前服务端实现返回大写错误码（如 `VALIDATION_ERROR`），SDK 原样透传；建议用 `error.code.toLowerCase()` 比较。

网络错误与超时也使用 `MnemosApiError`：

| 场景 | `status` | `code` |
| --- | --- | --- |
| DNS / 连接失败 | `0` | `network_error` |
| 超时 | `0` | `timeout` |
| 调用方取消 | `0` | `aborted` |

## 重试语义

默认 `maxRetries = 2`（即最多 3 次尝试）：

- **会重试**：`429`、`502`、`503`、`504`、网络错误与超时；
- **不会重试**：`400/401/403/404/409/413/422/500` 等确定性错误；
- 退避：`200ms × 2^attempt` + 最多 50% 抖动；
- 若响应带 `Retry-After`（秒数或 HTTP 日期），优先按它等待；
- **非幂等 POST** 只有传入 `idempotencyKey` 才重试；`POST /v1/memories/search` 是只读接口，可安全重试；
- `GET` / `PUT` / `PATCH` / `DELETE` 默认允许重试；
- 超时按**单次尝试**计算，重试会重新计时；总耗时最坏约为 `timeoutMs × (maxRetries + 1)` + 退避。

## 幂等键

- 通过 `{ idempotencyKey }` 显式传入，SDK **不会自动生成**（避免无意义的重放语义）；
- 服务端要求 8–128 字符；相同 key + 相同请求体在 24h 内回放首次响应（带 `x-idempotent-replayed: true`），请求体不同返回 `409 idempotency_conflict`；
- 重试时复用同一个 key，因此带 key 的写请求是安全的；
- 适用接口：`POST /v1/memories`、`POST /v1/tasks`、`POST /v1/tasks/{id}/finish` 等写接口。

```ts
const key = `add-${userId}-${Date.now()}`;
await client.memories.add({ text: '要落库的事实' }, { idempotencyKey: key });
// 网络抖动重试 / 人工重放都使用同一个 key
```

## 可见性参数

记忆支持三档可见性：

| `visibility` | 谁能看到 |
| --- | --- |
| `project`（默认） | 项目内所有 Agent（共享） |
| `agent` | 仅写入该记忆的 Agent（`agent_id`） |
| `task` | 仅当前任务（`task_id`） |

检索时的 `agentId` 是**调用方身份**：它决定能看到哪些私有记忆，但不会过滤掉其他 Agent 写入的项目共享记忆。需要看所有 Agent 私有记忆（控制台/审计）时传 `includePrivate: true`（需服务端支持）。
`writtenByAgentId` 才是“只看某 Agent 写入”的归属过滤。

## 导入 / 导出

```ts
const document = await client.export();   // mnemos-export/v1，已归一化为 SDK 模型
await client.import(document);            // 自动转回服务端导入格式；≤1000 条/次
```

`export()` 返回 `ProjectExport`（`memories` / `agents` / `tasks` / `project`），
`import()` 也接受 `{ memories: [...] }` 形式；导入去重计入 `skipped`。

## Webhook（beta）

服务端 `/v1/webhooks` 已实现，SDK 覆盖完整生命周期（标记 **beta**，字段可能调整）：

```ts
const hooks = await client.webhooks.list();        // → { results, count }（服务端返回数组）
const hook = await client.webhooks.create({
  name: 'CI 回调',
  url: 'https://ci.example.com/hook',
  eventTypes: ['memory.created'],                  // 至少订阅一个事件
});                                               // 响应含一次性明文 secret
await client.webhooks.update(hook.id, { enabled: false });
await client.webhooks.delete(hook.id);            // → { message: 'ok', ok: true }

const deliveries = await client.webhooks.deliveries(hook.id, {
  page: 1,
  pageSize: 20,
  status: 'failed',
});                                               // → { items, page, page_size, total, total_pages }

await client.webhooks.replay('del_xxx');           // POST /v1/webhook-deliveries/{id}/replay
```

作用域：列表与投递记录需要 `memories:read`；创建 / 更新 / 删除 / 轮换需要 `admin`。
事件类型：`memory.created`、`memory.updated`、`memory.deleted`、`task.finished`、
`agent.registered`、`key.created`、`key.revoked`、`quota.exceeded`。

## 记忆简报与做梦（控制台 API）

这 5 个方法对应控制台接口 `/api/projects/{id}/memory/*`，用**控制台会话令牌**鉴权（登录 `/api/auth/login` 拿 `token`），而不是 `mnemos_live_*` API Key；构造客户端时把会话令牌传给 `apiKey` 即可。入参按控制台接口使用 camelCase，响应统一归一化为 snake_case。

```ts
const consoleClient = new MnemosClient({
  apiKey: sessionToken, // 控制台会话 token
  baseUrl: 'http://127.0.0.1:4380',
});
const projectId = 'prj_orion_python';

// 读取简报（可临时覆盖字数、跳过缓存）
const brief = await consoleClient.brief(projectId, { maxChars: 800, force: true });
console.log(brief.count, brief.max_chars, brief.text);

// 不传 agentId = 审计全量视角（含所有 Agent 私有）；
// 传 agentId = 该 Agent 实际看到的简报（项目共享 + 其私有，排除其他 Agent 私有）
const agentBrief = await consoleClient.brief(projectId, { agentId: 'agent-coder' });

// 更新项目简报字符上限（100–5000），返回更新后的简报
await consoleClient.updateBriefSettings(projectId, 1200);

// 做梦状态 / 设置 / 手动触发
const status = await consoleClient.dream(projectId);
console.log(status.pending_count, status.settings.interval_minutes);
await consoleClient.updateDreamSettings(projectId, { enabled: true, intervalMinutes: 720 });
const result = await consoleClient.runDream(projectId);
// 项目正在做梦时返回 409，SDK 返回 { run: null, status }（status 为回读的当前状态）
if (result.run) console.log(result.run.input_count, result.run.insight_count);
```

对应的服务端契约、`MemoryBrief` / `MemoryDreamStatus` 字段与 409 说明见 [`docs/api.md`](../../docs/api.md) 的「8.1 记忆简报与做梦」。

## 构建与测试

从仓库根目录执行：

```bash
pnpm exec tsc -p sdk/typescript/tsconfig.json   # 构建到 sdk/typescript/dist
node --test sdk/typescript/test/*.test.ts       # 本地 mock server 测试
```

测试使用随机端口的 `node:http` mock，覆盖鉴权头、请求体、查询参数、错误映射、幂等键、
429 / 5xx 重试、`Retry-After`、超时、webhook 路径，以及记忆简报 / 做梦的控制台端点，共 16 个用例。

## 版本兼容

- SDK `1.x` 对应 **Mnemos API v1**（`/v1/*`）；
- 同一大版本内只做向后兼容增量（新增可选字段/方法），不会移除已有字段；
- 服务端新增字段会被忽略，旧字段缺失时提供空值/默认值；
- `@beta` 标注的 Webhook API 不在兼容性承诺内。

## 目录

```
sdk/typescript
├── src/index.ts     # 客户端、传输层、重试与归一化
├── src/types.ts     # 手写类型（Memory/Agent/Task/Briefing/SearchHit/Webhook…）
├── test/client.test.ts
├── examples/basic.ts
├── tsconfig.json
└── package.json
```
