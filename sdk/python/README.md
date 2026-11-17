# `mnemos-sdk` — Mnemos v6.1 Python SDK

Mnemos 官方 Python 客户端（同步）：**分区（Partition）+ 人（Person）+ 记忆（Memory）**。
面向 `/v1/partitions/:partition/...` 公开 API（API Key 鉴权、`snake_case` 契约）。

- **零第三方依赖**：只用标准库 `urllib` / `json` / `dataclasses` / `typing`；
- **Python ≥ 3.9**，带 `py.typed`（PEP 561）；
- 人 / 记忆列表统一**游标分页**：`{ items, next_cursor, partition_stats }`，**不返回 total**；
- v6.1：混合检索信号（`score` / `signals` / `matched_on`）、记忆历史、检索反馈、
  时效字段（`valid_from` / `valid_to` / `superseded_by` / `supersedes` / `fact_key`）；
- 可选 P1 接口（画像 / facts / merge / archive / export / delete）按契约提供，
  服务端端点上线后可直接使用。

> 旧的 v5 SDK（`mnemos_sdk` 包，Agent / 任务 / Webhook 模型）已随 v6 重建移除；
> v6.1 把「记忆永远属于一个人」作为唯一写入路径。

---

## 安装

```bash
# 仓库内（推荐先建虚拟环境）
pip install ./sdk/python

# 或直接设置 PYTHONPATH（不安装）
export PYTHONPATH="$PWD/sdk/python:$PYTHONPATH"
```

发布后：`pip install mnemos-sdk`。

## 快速开始

```python
from mnemos import MnemosClient

client = MnemosClient(
    api_key="mnemos_live_…",                 # 也可用 MNEMOS_API_KEY
    base_url="http://127.0.0.1:4380",        # 默认值，也可用 MNEMOS_BASE_URL
    partition="ws-demo",                     # 可选默认分区（id 或 slug）
)

# 1) 建 / 幂等 upsert 人（App 用户、员工、智能体都是「人」）
person = client.persons.upsert(
    "user-1",
    type="human",
    display_name="周野",
    attributes={"team": "core"},
)

# 2) 写记忆（person 必填；scope 缺省取分区设置）
result = client.memories.add(
    "user-1",
    text="周野偏好中文评审意见，先看结论。",
    scope="partition",          # person=仅本人 / partition=分区共享 / session=仅会话
    category="preference",
    importance=0.8,
    tags=["偏好"],
)
print(result.event, result.memory.id)   # ADD / MERGE / NOOP / SUPERSEDE

# 3) 混合检索（默认 hybrid），信号可解释
response = client.memories.search("评审偏好", top_k=5)
for hit in response.hits:
    print(hit.score, hit.signals.keyword, hit.signals.vector, hit.content)

# 4) 人的上下文 / 简报（可直接注入提示词）
ctx = client.context("user-1", query="评审关注点", budget_tokens=800)
print(ctx.prompt)
brief = client.brief("user-1", max_chars=400)
print(brief.text)
```

可运行示例：

```bash
MNEMOS_API_KEY=mnemos_live_… \
MNEMOS_BASE_URL=http://127.0.0.1:4380 \
MNEMOS_PARTITION=ws-demo \
python3 sdk/python/examples/basic.py
```

## 客户端配置

```python
client = MnemosClient(
    api_key="mnemos_live_…",
    base_url="http://127.0.0.1:4380",
    partition="ws-demo",       # 可选默认分区
    person="user-1",           # 可选默认人
    timeout=30.0,              # 单次请求超时（秒）
    max_retries=2,             # GET / 幂等写 / 检索的重试次数
    retry_base_delay=0.2,      # 指数退避基数（秒）
)
```

- `base_url` 允许带路径前缀，尾斜杠自动去掉；
- `MnemosClient("http://host", "mnemos_live_…")` 这种反序参数也会被自动纠正；
- 未传 `api_key` / `base_url` 时读 `MNEMOS_API_KEY` / `MNEMOS_BASE_URL`；
- 也支持 `with MnemosClient(...) as client:`（`close()` 是空操作，urllib 每请求独立连接）。

## API 一览

### 分区 `client.partitions`

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `list()` | `GET /v1/partitions` | 本组织分区（需 org key，每项带 `stats`） |
| `create(slug, name=…, description=…, status=…, settings=…)` | `POST /v1/partitions` | 按 slug 幂等 upsert（org key + admin） |
| `get(ref=None)` | `GET /v1/partitions/:p` | 分区信息（不含 stats） |
| `update(ref=None, …)` | `PATCH /v1/partitions/:p` | 名称 / 描述 / 状态 / 设置 |
| `stats(ref=None)` | `GET /v1/partitions/:p/stats` | 统计（读 `partition_stats`，O(1)） |

`client.stats()` 是 `client.partitions.stats()` 的便捷入口。

### 人 `client.persons`

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `list(partition=None, type=…, status=…, q=…, sort=…, cursor=…, limit=…)` | `GET .../persons` | 游标分页；`sort` = `recent` / `new` / `name` |
| `get(person=None, partition=None)` | `GET .../persons/:person` | 内部 id 或 external_id |
| `upsert(external_id, type=…, display_name=…, attributes=…, status=…)` | `PUT .../persons/:externalId` | 建档 / 更新 |
| `update(person=None, type=…, display_name=…, attributes=…, status=…)` | `PATCH .../persons/:person` | 部分更新 |
| `memories(person=None, scope=…, category=…, status=…, q=…, cursor=…, limit=…)` | `GET .../persons/:person/memories` | 某人的记忆 |

### 记忆 `client.memories`

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `add(person=None, text=… / content=… / messages=…, …)` | `POST .../persons/:person/memories` | 写入；返回 `{memory, event, superseded_id}` |
| `list(partition=None, person_id=…, person_external_id=…, scope=…, category=…, status=…, q=…, cursor=…, limit=…)` | `GET .../memories` | 分区记忆列表 |
| `list_by_person(person=None, …)` | `GET .../persons/:person/memories` | 等价 `persons.memories` |
| `search(query, top_k=…, mode=…, as_of=…, include_superseded=…)` | `POST .../memories/search` | 混合检索；返回 `hits` + `signals` |
| `get(memory_id)` | `GET .../memories/:id` | `{memory, person}` |
| `update(memory_id, content=…, …)` | `PATCH .../memories/:id` | 部分更新 |
| `delete(memory_id)` | `DELETE .../memories/:id` | 204 |
| `history(memory_id)` | `GET .../memories/:id/history` | ADD/UPDATE/MERGE/SUPERSEDE/DELETE/NOOP/FEEDBACK |
| `feedback(memory_id, helpful, query=…, reason=…)` | `POST .../memories/:id/feedback` | 检索反馈（调 confidence） |

### 简报 / 上下文 / 做梦 `client.*`

| 方法 | 端点 | 说明 |
| --- | --- | --- |
| `brief(person=None, max_chars=…, force=…)` | `GET .../persons/:person/brief` | 可注入提示词的 `text` |
| `context(person=None, query=…, budget_tokens=…, include_partition=…)` | `POST .../persons/:person/context` | 资料 + 简报 + 记忆 + 共享知识 + `prompt` |
| `dream_status(person=None)` | `GET .../persons/:person/dream` 或分区级 | 做梦设置 / 待巩固数 / 最近运行 |
| `dream_run(person=None, batch_size=…)` | `POST .../persons/:person/dream/run` | 手动触发一次做梦 |
| `dream(person=None, run=False, batch_size=…)` | — | `run=False` 状态 / `run=True` 触发 |
| `health()` | `GET /health` | 无需鉴权 |

### v6.1 P1：画像 / 生命周期（可选，端点上线后可用）

| 方法 | 约定端点 | 说明 |
| --- | --- | --- |
| `persons.profile(person=None, force=…)` | `GET .../persons/:person/profile` | `PersonProfile`（当前 facts + summary；`force` 跳过缓存） |
| `persons.facts(person=None)` | `GET .../persons/:person/facts` | 当前有效事实槽位 |
| `persons.upsert_fact(person=None, key=…, value=…)` | `PUT .../persons/:person/facts` | 显式维护单个槽位（响应 `{fact}` 自动解包） |
| `persons.upsert_facts(person=None, facts=[…])` | `PUT .../persons/:person/facts` | 批量维护槽位（body `{facts}`，响应 `{items}`） |
| `persons.remove_fact(person=None, fact_id=…)` | `DELETE .../persons/:person/facts/:factId` | 删除槽位 |
| `persons.merge(person=None, target=…)` | `POST .../persons/:person/merge` body `{target_id}` | 合并到 canonical 人 |
| `persons.archive(person=None)` | `POST .../persons/:person/archive` | 归档 |
| `persons.export(person=None)` | `GET .../persons/:person/export` | 合规导出（含 `truncated` 标记） |
| `persons.delete(person=None, hard=False)` | `DELETE .../persons/:person?hard=true` | 软删 / 硬删 |

这些端点由 P1 后端提供（v6.1 已实现 v1 路由）；SDK 已按同一契约实现路径与字段，
未部署 P1 的旧服务会返回 `404 NOT_FOUND`。

## 游标分页

```python
cursor = None
while True:
    page = client.memories.list(partition="ws-demo", limit=100, cursor=cursor)
    for memory in page.items:
        print(memory.id, memory.content)
    print("分区统计：", page.partition_stats.memories_total if page.partition_stats else None)
    cursor = page.next_cursor
    if not cursor:
        break
```

- `limit` 默认 50、最大 200（服务端夹取）；`next_cursor is None` 表示没有下一页；
- **换 `sort` 必须丢弃旧游标**，否则服务端返回 `400 INVALID_CURSOR`；
- 列表不返回 `total`，头部统计用响应里的 `partition_stats`。

## 检索信号

```python
response = client.memories.search(
    "评审偏好",
    top_k=8,
    mode="hybrid",              # hybrid | keyword | vector
    as_of="2026-10-01T00:00:00Z",  # 回看当时有效的事实（P1）
    include_superseded=False,
)
print(response.mode, response.strategy, response.took_ms)
for hit in response.hits:
    print(hit.score, hit.signals.vector, hit.signals.keyword,
          hit.signals.recency, hit.signals.importance, hit.signals.entity,
          hit.matched_on)
```

`signals` 权重来自分区 `settings.retrieval_weights`，默认
`vector 0.45 / keyword 0.30 / recency 0.15 / importance 0.10 / entity 0`。

## 写入去重 / 合并 / 取代

```python
# 完全重复 → NOOP（不新增，返回已有记忆）
# 余弦 ≥ mergeThreshold → MERGE
# 显式 supersedes_id 或同 fact_key → 旧记忆 valid_to=now，新记忆 supersedes=旧
result = client.memories.add(
    "user-1",
    text="用户偏好英文回复",
    fact_key="preference.language",
    supersedes_id="mem_old",
    idempotency_key="req-20261118-1",   # POST 写请求幂等键
)
```

- `idempotency_key` 会以 `Idempotency-Key` 头发送，24h 内相同 key+body 返回首次响应；
- 写记忆这类非幂等 POST **不会自动重试**，避免重复写入；
- GET / PUT / PATCH / DELETE 与 `memories.search` 在 429/5xx/网络错误时指数退避重试，
  并尊重 `Retry-After`。

## 错误处理

```python
from mnemos import MnemosApiError, MnemosNetworkError, MnemosError

try:
    client.persons.get("nobody")
except MnemosApiError as error:
    print(error.status, error.code, error.message, error.request_id)
    if error.code == "NOT_FOUND":
        ...
    elif error.is_rate_limited:
        ...
except MnemosNetworkError as error:
    print("网络/超时：", error)
```

- 服务端错误体 `{"error": {"code", "message", "requestId", "details"}}` 被映射为
  `MnemosApiError`（属性：`status` / `code` / `message` / `request_id` / `details` /
  `retry_after` / `payload`）；
- 判断逻辑用稳定 `code`（如 `NOT_FOUND`、`VALIDATION`、`RATE_LIMITED`、
  `QUOTA_EXCEEDED`、`PARTITION_ARCHIVED`），不要匹配中文 `message`；
- 网络失败 / 超时分别抛 `MnemosNetworkError` / `MnemosTimeoutError`（均继承 `MnemosError`）。

## 测试

测试使用本地 `http.server` fake（随机端口，无外部服务），覆盖签名、游标、检索信号与错误映射：

```bash
cd sdk/python
python3 -m unittest discover -s tests -v
```

## 目录结构

```text
sdk/python/
├── mnemos/
│   ├── __init__.py     # 公共入口
│   ├── client.py       # MnemosClient + partitions/persons/memories 资源
│   ├── errors.py       # 错误类型
│   ├── types.py        # dataclass 模型（from_dict 宽容解析）
│   └── py.typed
├── examples/basic.py
├── tests/test_client.py
├── pyproject.toml
└── README.md
```
