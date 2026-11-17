# Mnemos SDK

Mnemos 官方 SDK，面向 `/v1/*` 公开 API（API Key 鉴权、snake_case 契约）。

| SDK | 包名 | 语言要求 | 依赖 | 说明 |
| --- | --- | --- | --- | --- |
| TypeScript | [`@mnemos/sdk`](typescript/README.md) | Node ≥18 / 现代浏览器 | 零运行时依赖 | 全局 `fetch`，原生 TS 可直接被 Node 24+ 运行 |
| Python | [`mnemos-sdk`](python/README.md) | Python ≥3.9 | 零第三方依赖 | 同步客户端，标准库 `urllib` |

两个 SDK 的方法、参数语义与重试策略保持一致；`sdk/` 自成体系，**不加入根 pnpm workspace**，也不需要改动服务端。

---

## 1. 安装

### TypeScript

```bash
pnpm add @mnemos/sdk      # 发布后
# 或
pnpm add ./sdk/typescript # 仓库内
```

### Python

```bash
pip install mnemos-sdk      # 发布后
# 或
pip install ./sdk/python    # 仓库内
```

默认服务地址是 `http://127.0.0.1:4380`；仓库演示项目 Atlas 的 API Key 为
`mnemos_live_demo_atlas_ci`（Key 由服务端 seed 生成，仅用于本地演示）。

---

## 2. 快速开始

### TypeScript

```ts
import { MnemosClient } from '@mnemos/sdk';

const client = new MnemosClient({ apiKey: 'mnemos_live_demo_atlas_ci' });

const added = await client.memories.add({
  text: '周野偏好用中文写评审意见',
  userId: 'dev-zhouye',
  metadata: { channel: 'sdk' },
});

const hits = await client.memories.search({ query: '评审偏好', userId: 'dev-zhouye', topK: 5 });
const briefing = await client.context.build({ query: '评审关注点', budgetTokens: 800 });
console.log(briefing.prompt);
```

### Python

```python
from mnemos_sdk import MnemosClient

client = MnemosClient("mnemos_live_demo_atlas_ci")

added = client.memories.add(
    text="周野偏好用中文写评审意见",
    user_id="dev-zhouye",
    metadata={"channel": "sdk"},
)

hits = client.memories.search("评审偏好", user_id="dev-zhouye", top_k=5)
briefing = client.context.build(query="评审关注点", budget_tokens=800)
print(briefing.prompt)
```

可运行示例：

```bash
node sdk/typescript/examples/basic.ts     # 需要 Node 24+ 原生 TS；否则先构建 dist
python3 sdk/python/examples/basic.py
```

示例按「写入 → 任务简报 → 混合检索」演示完整链路，Key 与地址可用
`MNEMOS_API_KEY` / `MNEMOS_BASE_URL` 覆盖。

---

## 3. 接口覆盖

| 能力 | TypeScript | Python |
| --- | --- | --- |
| 写入记忆 | `client.memories.add` | `client.memories.add` |
| 分区 / 人（中立 v5） | `client.partitions.*` / `client.persons.*` / `client.personBrief/personContext/personDream/personDreamRun` | 暂未覆盖（走 HTTP） |
| 人级记忆路由 | `client.memories.*({ partition, personId, scope, sessionId })` | 暂未覆盖 |
| 混合检索 | `client.memories.search` | `client.memories.search` |
| 列表 / 详情 | `list` / `get` | `list` / `get` |
| 更新 / 删除 | `update` / `delete` | `update` / `delete` |
| 历史 / 反馈 | `history` / `feedback` | `history` / `feedback` |
| Agent 注册表 | `client.agents.list/create` | `client.agents.list/create` |
| 任务会话 | `client.tasks.list/create/get/finish` | `client.tasks.list/create/get/finish` |
| 任务简报 | `client.context.build` | `client.context.build` |
| 图谱 / 统计 | `client.graph()` / `client.stats()` | `client.graph()` / `client.stats()` |
| 健康检查 | `client.health()` | `client.health()` |
| 导出 / 导入 | `client.export()` / `client.import(doc)` | `client.export()` / `client.import_memories(doc)` |
| Webhook（**beta**） | `client.webhooks.*` | `client.webhooks.*` |
| 记忆简报 / 做梦（控制台） | `client.brief()` / `updateBriefSettings()` / `dream()` / `updateDreamSettings()` / `runDream()` | 暂未覆盖 |

> Python 的 `import` 是关键字，导入方法命名为 `import_memories`，并提供 `import_` 别名。

### 命名约定

- 线上契约使用 **snake_case**；
- **TypeScript 入参**同时接受 camelCase（`userId`、`topK`）与 snake_case（`user_id`、`top_k`），统一序列化为 snake_case；
- **Python** 全部使用 snake_case 关键字参数；
- **出参**统一归一化为 snake_case；服务端个别接口返回的 camelCase 字段（如写入接口的 `createdAt`）会被自动转换；
- 记忆正文同时提供 `content` 与 `memory`（服务端列表/检索字段名为 `memory`）。

---

## 3.5 中立记忆服务：分区 + 人（v5，TypeScript 已覆盖）

v5 的记忆模型是「分区（Partition）× 人（Person）」：

- `client.partitions.create(input)`：按 `slug` 幂等建分区（**org key** + `admin` 作用域）；
  `client.partitions.get(ref)` 按 id 或 slug 读取分区；
- `client.persons.list/get/upsert/update`：人列表 / 详情 / 建档 / 更新（`partition` + `personRef`）；
- `client.personBrief/personContext/personDream/personDreamRun`：人的简报 / 上下文（含 `prompt`）/
  人级做梦状态与触发；
- `client.memories.*` 传 `partition` 时走 `/v1/partitions/:p/memories*`，并支持
  `personId` / `personExternalId` / `scope`（person / partition / session）/ `sessionId`；
  不传 `partition` 则保持旧 `/v1/memories` 行为。

```ts
const client = new MnemosClient({ apiKey: process.env.MNEMOS_ORG_KEY! });
const { partition } = await client.partitions.create({ slug: 'zhiwu-app', name: '知物感恩 App' });
await client.persons.upsert(partition.slug, 'user-123', { type: 'human', displayName: '用户 123' });
await client.memories.add({ partition: partition.slug, text: '用户 123 喜欢黑咖啡', personId: 'user-123', scope: 'person' });
const brief = await client.personBrief(partition.slug, 'user-123');
```

详细示例与 `scope` / `visibility` 映射见 [`typescript/README.md`](typescript/README.md#分区--人中立记忆服务-v5)；
接口契约见 [`docs/api.md`](../docs/api.md) 第 11 节，旧接口迁移见
[`docs/migration-v4-v5.md`](../docs/migration-v4-v5.md)。

---

## 4. 错误处理

两个 SDK 都抛出统一的 API 错误类型：

| SDK | 类型 | 字段 |
| --- | --- | --- |
| TypeScript | `MnemosApiError extends Error` | `status` / `code` / `requestId` / `details` / `retryAfterMs` |
| Python | `MnemosApiError(Exception)` | `status` / `code` / `request_id` / `details` / `retry_after_ms` |

```ts
try {
  await client.memories.get(id);
} catch (error) {
  if (error instanceof MnemosApiError) {
    console.error(error.status, error.code, error.message, error.requestId);
  }
}
```

```python
try:
    client.memories.get(memory_id)
except MnemosApiError as error:
    print(error.status, error.code, error.message, error.request_id)
```

错误响应体固定为：

```json
{ "error": { "code": "forbidden", "message": "当前密钥缺少 memories:write 作用域", "requestId": "req_..." } }
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `validation_error` | 参数不合法（`details` 带字段明细） |
| 401 | `unauthorized` | 缺少或无效凭证 |
| 403 | `forbidden` | 作用域 / 角色不足 |
| 404 | `not_found` | 资源不存在或不属于该项目 |
| 409 | `conflict` | 唯一约束冲突 / 幂等键冲突 |
| 413 | `payload_too_large` | 请求体超过 1 MB |
| 422 | `unprocessable` | 语义校验失败 |
| 429 | `rate_limited` | 超出限流或配额 |
| 500 | `internal_error` | 未预期的服务端异常 |

网络与超时也使用同一错误类型，`status = 0`：`network_error` / `timeout`（TS 另有 `aborted`）。
当前服务端实现返回大写错误码（如 `VALIDATION_ERROR`），SDK 原样透传，比较时建议忽略大小写。

---

## 5. 重试语义

两个 SDK 的策略一致：

- 默认 `maxRetries = 2`（最多 3 次尝试）；
- **重试**：`429`、`502`、`503`、`504`、网络错误、超时；
- **不重试**：`400/401/403/404/409/413/422/500` 等确定性错误；
- 指数退避 + 抖动：`200ms × 2^attempt`，再叠加最多 50% 抖动；
- 响应带 `Retry-After`（秒数或 HTTP 日期）时，优先按它等待；
- **非幂等 POST** 只有传入幂等键才重试；`POST /v1/memories/search` 是只读接口，允许重试；
- `GET` / `PUT` / `PATCH` / `DELETE` 允许重试；
- 超时按**单次尝试**计算：TS 用 `AbortSignal.timeout`（默认 30s），Python 用 `urllib` 的 `timeout`（默认 30s）；
- 重试不会改变请求体，幂等键会复用同一个值。

---

## 6. 幂等键

写接口支持 `Idempotency-Key`（服务端要求 8–128 字符）：

- 相同 key + 相同请求体在 24h 内回放首次响应，并带 `x-idempotent-replayed: true`；
- 相同 key + 不同请求体返回 `409 idempotency_conflict`；
- **SDK 不自动生成 key**，需要显式传入，避免误把两次业务写入当成重试；
- 适用 `POST /v1/memories`、`POST /v1/tasks`、`POST /v1/tasks/{id}/finish`。

```ts
await client.memories.add({ text: '要落库的事实' }, { idempotencyKey: 'add-u1-20261105-0001' });
```

```python
client.memories.add(text="要落库的事实", idempotency_key="add-u1-20261105-0001")
```

---

## 7. 可见性参数

| `visibility` | 可见范围 |
| --- | --- |
| `project`（默认） | 项目内所有 Agent 共享 |
| `agent` | 仅写入者 Agent 私有 |
| `task` | 仅当前任务可见 |

检索时的 `agent_id` 是**调用方身份**：决定能看到哪些 Agent 私有记忆，但**不会**过滤掉其他 Agent 写入的项目共享记忆。
`written_by_agent_id` 才是“只看某 Agent 写入”的归属过滤；`include_private=true`（控制台/审计）用于查看所有 Agent 私有记忆。

---

## 8. 版本兼容

- SDK `1.x` 对应 Mnemos **API v1**；
- 同一大版本内只做向后兼容增量：新增可选字段/方法，不移除已有字段，不改变既有语义；
- 服务端新增字段时 SDK 忽略未知字段；字段缺失时提供默认值（空字符串/`0`/`null`）；
- 响应模型经归一化层处理，服务端 camelCase/snake_case 混用不会破坏调用方代码；
- v5 的「分区 + 人」能力是增量：旧方法/旧端点/旧字段不变，新字段（`person_id` / `scope` /
  `session_id`）在响应中增量出现；
- 标有 **beta** 的 Webhook API 不在兼容性承诺内，服务端就绪前调用可能返回 `404`；
- 服务端 `/api/*`（控制台会话鉴权、camelCase）不在 SDK 范围内。

---

## 9. 开发与验证

从仓库根目录执行：

```bash
# TypeScript：构建 + 测试（Node 原生跑 .ts）
pnpm exec tsc -p sdk/typescript/tsconfig.json
node --test sdk/typescript/test/*.test.ts

# Python：测试
python3 -m unittest discover -s sdk/python/tests -v
```

测试使用随机端口的本地 mock（`node:http` / `ThreadingHTTPServer`），不依赖运行中的服务，也不会与并行开发的服务端口冲突。

```
sdk/
├── README.md
├── typescript/
│   ├── src/index.ts      # 客户端 / 传输 / 重试 / 归一化
│   ├── src/types.ts      # 手写类型
│   ├── test/client.test.ts
│   ├── examples/basic.ts
│   ├── tsconfig.json
│   ├── package.json
│   └── README.md
└── python/
    ├── mnemos_sdk/       # client / types / errors / py.typed
    ├── tests/test_client.py
    ├── examples/basic.py
    ├── pyproject.toml
    └── README.md
```
