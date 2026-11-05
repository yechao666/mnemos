# `mnemos-sdk` — Mnemos Python SDK

Mnemos 官方 Python 客户端（同步）：记忆写入、混合检索、Agent 注册表、任务会话与任务简报、图谱 / 统计、导入导出，以及 Webhook（beta）。

- **零第三方依赖**：只用标准库 `urllib` / `json` / `dataclasses` / `typing`；
- **Python ≥ 3.9**；
- 面向 `/v1/*` 公开 API（API Key 鉴权、snake_case 契约），带 `py.typed` 类型标记。

## 安装

```bash
# 发布后
pip install mnemos-sdk

# 仓库内
pip install ./sdk/python
```

要求 Python ≥ 3.9。

## 快速开始

```python
from mnemos_sdk import MnemosApiError, MnemosClient

client = MnemosClient(
    "mnemos_live_demo_atlas_ci",          # 演示项目 Atlas
    base_url="http://127.0.0.1:4380",     # 默认值
)

# 1. 写入记忆
added = client.memories.add(
    messages=[{"role": "user", "content": "我是张倩，偏好企业微信联系。"}],
    user_id="cust-1042",
    agent_id="agent-support-l1",
    infer=True,
)

# 2. 混合检索
hits = client.memories.search(
    "张倩的联系偏好",
    user_id="cust-1042",
    top_k=5,
    threshold=0.2,
)
for hit in hits.results:
    print(hit.score, hit.content)  # content 与 memory 是同一个正文

# 3. 任务简报（可直接拼进 system prompt）
briefing = client.context.build(
    agent_id="agent-support-l1",
    query="客户联系方式偏好",
    budget_tokens=800,
)
print(briefing.prompt)
```

仓库内可运行示例：

```bash
python3 sdk/python/examples/basic.py
# 可选：MNEMOS_API_KEY=... MNEMOS_BASE_URL=... python3 sdk/python/examples/basic.py
```

## 客户端配置

```python
client = MnemosClient(
    "mnemos_live_xxx",
    base_url="https://mnemos.example.com",  # 默认 http://127.0.0.1:4380
    timeout=30.0,                          # 单次尝试超时（秒），默认 30
    max_retries=2,                         # 默认 2
)
```

`base_url` 允许带路径前缀，SDK 会保留。

## API 一览

| 资源 | 方法 |
| --- | --- |
| `client.memories` | `add` / `search` / `list` / `get` / `update` / `delete` / `history` / `feedback` |
| `client.agents` | `list` / `create` |
| `client.tasks` | `list` / `create` / `get` / `finish` |
| `client.context` | `build` |
| `client` | `graph(limit=120)` / `stats()` / `health()` / `export()` / `import_memories(doc)` |
| `client.webhooks` | `list` / `create` / `update` / `delete` / `rotate_secret` / `deliveries` / `replay`（**beta**） |

> `import` 是 Python 关键字，因此导入方法是 `client.import_memories(...)`，并提供 `client.import_(...)` 别名。

写请求通过 `idempotency_key` 传入幂等键：

```python
client.memories.add(
    text="必须保留的决策",
    user_id="u-1",
    idempotency_key="memory-add-20261105-0001",
)
```

### 命名约定

- 全部使用 **snake_case**（`user_id`、`top_k`、`include_private`、`created_at`、`matched_on`）；
- 模型类的 `from_dict` 同时兼容服务端个别接口返回的 camelCase（例如写入接口的 `createdAt`）；
- 记忆正文同时暴露 `content` 与 `memory` 属性（`memory` 是只读别名）；
- 任务简报的 `agent` / `task` 可能为 `None`（未指定时）。

## 错误处理

所有失败都抛 `MnemosApiError`（`mnemos_sdk.MnemosApiError`）：

```python
from mnemos_sdk import MnemosApiError

try:
    client.memories.get("mem_missing")
except MnemosApiError as error:
    print(error.status)      # HTTP 状态；网络/超时为 0
    print(error.code)        # 稳定错误码，比较时建议忽略大小写
    print(error.message)     # 可直接展示的中文文案
    print(error.request_id)  # 服务端请求 ID，便于排查
    print(error.details)     # 校验明细等
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

> 当前服务端实现返回大写错误码（如 `VALIDATION_ERROR`），SDK 原样透传；建议用 `error.code.lower()` 比较。

网络错误与超时也使用 `MnemosApiError`：

| 场景 | `status` | `code` |
| --- | --- | --- |
| DNS / 连接失败 | `0` | `network_error` |
| 超时 | `0` | `timeout` |

## 重试语义

默认 `max_retries = 2`（即最多 3 次尝试）：

- **会重试**：`429`、`502`、`503`、`504`、网络错误与超时；
- **不会重试**：`400/401/403/404/409/413/422/500` 等确定性错误；
- 退避：`200ms × 2^attempt` + 最多 50% 抖动（`time.sleep`）；
- 响应带 `Retry-After`（秒数或 HTTP 日期）时优先按它等待；
- **非幂等 POST** 只有传入 `idempotency_key` 才重试；`POST /v1/memories/search` 是只读接口，可安全重试；
- `GET` / `PUT` / `PATCH` / `DELETE` 默认允许重试；
- 超时按**单次尝试**计算（`urllib` 的 `timeout`），重试会重新计时。

## 幂等键

- 通过 `idempotency_key` 显式传入，SDK **不会自动生成**；
- 服务端要求 8–128 字符；相同 key + 相同请求体在 24h 内回放首次响应，请求体不同返回 `409 idempotency_conflict`；
- 重试时复用同一个 key，因此带 key 的写请求是安全的；
- 适用接口：`POST /v1/memories`、`POST /v1/tasks`、`POST /v1/tasks/{id}/finish` 等写接口。

## 可见性参数

| `visibility` | 谁能看到 |
| --- | --- |
| `project`（默认） | 项目内所有 Agent（共享） |
| `agent` | 仅写入该记忆的 Agent（`agent_id`） |
| `task` | 仅当前任务（`task_id`） |

检索时的 `agent_id` 是**调用方身份**：决定可见的私有记忆，但不会过滤其他 Agent 写入的项目共享记忆。
需要查看所有 Agent 私有记忆（控制台/审计）时传 `include_private=True`（需服务端支持）；
`written_by_agent_id` 才是“只看某 Agent 写入”的归属过滤。

## 导入 / 导出

```python
document = client.export()        # ProjectExport，已归一化为 snake_case 模型
client.import_memories(document)  # 自动转回服务端导入格式；≤1000 条/次
```

`export()` 返回 `ProjectExport`（`memories` / `agents` / `tasks` / `project`），
`import_memories()` 也接受 `{"memories": [...]}` 字典；导入去重计入 `skipped`。

## Webhook（beta）

服务端 `/v1/webhooks` 已实现，SDK 覆盖完整生命周期（标记 **beta**，字段可能调整）：

```python
hooks = client.webhooks.list()            # .results / .count（服务端返回数组）
hook = client.webhooks.create(
    "CI 回调",
    "https://ci.example.com/hook",
    event_types=["memory.created"],       # 至少订阅一个事件
)                                          # 响应含一次性明文 secret
client.webhooks.update(hook.id, enabled=False)
client.webhooks.delete(hook.id)            # MutationResult(message="ok", ok=True)

deliveries = client.webhooks.deliveries(hook.id, page=1, page_size=20, status="failed")
# deliveries.items / page / page_size / total / total_pages
client.webhooks.replay("del_xxx")          # POST /v1/webhook-deliveries/{id}/replay
```

作用域：列表与投递记录需要 `memories:read`；创建 / 更新 / 删除 / 轮换需要 `admin`。
事件类型：`memory.created`、`memory.updated`、`memory.deleted`、`task.finished`、
`agent.registered`、`key.created`、`key.revoked`、`quota.exceeded`。

## 测试

从仓库根目录执行：

```bash
python3 -m unittest discover -s sdk/python/tests -v
```

测试使用随机端口的 `ThreadingHTTPServer` mock，覆盖鉴权头、请求体、查询参数、错误映射、
幂等键、429 / 5xx 重试、`Retry-After`、超时、非幂等 POST 不重试与 webhook 路径，共 13 个用例。

## 版本兼容

- SDK `1.x` 对应 **Mnemos API v1**（`/v1/*`）；
- 同一大版本内只做向后兼容增量（新增可选字段/方法），不会移除已有字段；
- 服务端新增字段会被忽略，旧字段缺失时提供空值/默认值；
- `beta` 标注的 Webhook API 不在兼容性承诺内。

## 目录

```
sdk/python
├── mnemos_sdk/
│   ├── __init__.py   # 公开导出
│   ├── client.py     # 同步客户端、传输层、重试
│   ├── types.py      # dataclass 模型与 from_dict
│   ├── errors.py     # MnemosApiError
│   └── py.typed
├── tests/test_client.py
├── examples/basic.py
└── pyproject.toml
```
