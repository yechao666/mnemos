# Mnemos SDK

Mnemos v6 官方 SDK：**分区（Partition）+ 人（Person）+ 记忆（Memory）** 的中立记忆服务客户端。

| SDK | 包名 | 语言要求 | 依赖 | 说明 |
| --- | --- | --- | --- | --- |
| TypeScript | [`@mnemos/sdk`](typescript/README.md) | Node ≥18 / 现代浏览器 | 零运行时依赖 | v6；全局 `fetch`，原生 TS 可直接被 Node 24+ 运行 |
| Python | [`mnemos-sdk`](python/README.md) | Python ≥3.9 | 零第三方依赖 | v5 历史版本，尚未随 v6 重建 |

`sdk/` 自成体系，**不加入根 pnpm workspace**，也不需要改动服务端。

---

## 1. 安装

### TypeScript

```bash
pnpm add @mnemos/sdk      # 发布后
# 或
pnpm add ./sdk/typescript # 仓库内
```

### Python（v5）

```bash
pip install mnemos-sdk      # 发布后
# 或
pip install ./sdk/python    # 仓库内
```

默认服务地址是 `http://127.0.0.1:4380`。

---

## 2. 快速开始（TypeScript / v6）

```ts
import { MnemosClient } from '@mnemos/sdk';

const client = new MnemosClient({
  apiKey: process.env.MNEMOS_API_KEY!, // mnemos_live_…
  baseUrl: 'http://127.0.0.1:4380',
});

// 建 / 幂等 upsert 分区（org key + admin）
const partition = await client.partitions.create({ slug: 'ws-demo', name: '演示分区' });

// 建档一个人（真人 / 智能体都是「人」）
const person = await client.persons.upsert(partition.slug, 'user-1', {
  type: 'human',
  displayName: '周野',
});

// 写记忆 + 人级上下文
await client.memories.add(partition.slug, person.external_id, {
  text: '周野偏好用中文写评审意见',
  scope: 'partition',
  category: 'preference',
});
const context = await client.personContext(partition.slug, person.external_id, {
  query: '评审关注点',
  budgetTokens: 800,
});
console.log(context.prompt);
```

可运行示例：

```bash
node sdk/typescript/examples/basic.ts     # 需要 Node 24+ 原生 TS；否则先构建 dist
```

Key 与地址可用 `MNEMOS_API_KEY` / `MNEMOS_BASE_URL` 覆盖。详细方法、游标分页、
错误与重试说明见 [`typescript/README.md`](typescript/README.md)。

---

## 3. 接口覆盖（v6 TypeScript）

| 能力 | TypeScript |
| --- | --- |
| 分区 | `client.partitions.list/create/get/update/stats` |
| 人 | `client.persons.list/get/upsert/update` |
| 记忆 | `client.memories.list/listByPerson/add/search/get/update/delete` |
| 人级简报 / 上下文 | `client.personBrief` / `client.personContext` |
| 人级做梦 | `client.personDream` / `client.personDreamRun` |
| API Key（控制台） | `client.keys.*` / `client.keys.org.*` |
| 健康检查 | `client.health()` |

人 / 记忆列表统一**游标分页**：`{ items, next_cursor, partition_stats }`，不返回 total。

### 命名约定

- 线上契约使用 **snake_case**；
- **TypeScript 入参**同时接受 camelCase（`displayName`、`sessionId`）与 snake_case（`display_name`、`session_id`），统一序列化为 snake_case；
- **Python** 全部使用 snake_case 关键字参数；
- **出参**统一归一化为 snake_case（控制台 camelCase 响应也会被归一化）；
- 记忆正文响应字段为 `content`。

---

## 4. 错误处理

两个 SDK 都抛出统一的 API 错误类型：

| SDK | 类型 | 字段 |
| --- | --- | --- |
| TypeScript | `MnemosApiError extends Error` | `status` / `code` / `requestId` / `details` / `retryAfterMs` |
| Python | `MnemosApiError(Exception)` | `status` / `code` / `request_id` / `details` / `retry_after_ms` |

```ts
try {
  await client.memories.get('ws-demo', memoryId);
} catch (error) {
  if (error instanceof MnemosApiError) {
    console.error(error.status, error.code, error.message, error.requestId);
  }
}
```

错误响应体固定为：

```json
{ "error": { "code": "NOT_FOUND", "message": "记忆不存在", "requestId": "req_..." } }
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` / `VALIDATION_ERROR` | 参数不合法（`details` 带字段明细） |
| 401 | `UNAUTHORIZED` / `INVALID_API_KEY` | 缺少或无效凭证 |
| 403 | `FORBIDDEN` / `QUOTA_EXCEEDED` | 作用域 / 角色不足 / 配额超限 |
| 404 | `NOT_FOUND` | 资源不存在或不属于该分区 |
| 429 | `RATE_LIMITED` | 超出限流 |
| 500 | `INTERNAL_ERROR` | 未预期的服务端异常 |
| 503 | `SERVICE_UNAVAILABLE` | 服务暂不可用 |

网络与超时也使用同一错误类型，`status = 0`：`network_error` / `timeout`（TS 另有 `aborted`）。

---

## 5. 重试语义（TypeScript）

- 默认 `maxRetries = 2`（最多 3 次尝试）；
- **重试**：`429`、`502`、`503`、`504`、网络错误、超时（GET / 只读检索 POST / PUT / PATCH / DELETE）；
- 尊重 `Retry-After`（秒数或 HTTP 日期），否则指数退避 + 抖动；
- **非只读 POST 不自动重试**（写记忆 / 做梦 / 建密钥），避免重复写入；v6 服务端不持久化幂等记录。

```bash
cd sdk/typescript
npx tsc -p tsconfig.json
node --test test/*.test.ts
```
