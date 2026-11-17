# `mnemos-langchain` — Mnemos v6.1 的 LangChain `BaseStore` 适配器

把 Mnemos 记忆服务当作 LangChain 的**持久化 key-value store**：
LangChain 的 `namespace` 映射到 Mnemos 的 `(partition, person)`，key 持久化在
记忆 `metadata.lc_key`，value 原样保存在 `metadata.lc_value`，
检索走 Mnemos 的混合检索（关键词 + 向量 + 时效 + 重要度）。

- **可选依赖**：`langchain-core` 未安装时仍可 `from mnemos_langchain import MnemosStore`
  （退化为普通类，方法签名与 `BaseStore` 一致）；
- **零外部服务**：测试用 fake client；生产才连 Mnemos；
- **懒加载 SDK**：构造时不 import `mnemos`，首次访问 `.client` 才按需导入；
- 支持 `get` / `mget` / `set` / `mset` / `delete` / `mdelete` / `search` / `yield_keys`。

> 与 Mnemos 记忆语义的关系：每个 store 条目就是一条 Mnemos 记忆（scope 默认
> `person`），因此它同时能被 `mnemos_search` / `mnemos_context` 等工具检索到。

---

## 1. 安装

```bash
# 1) 先安装/可用 Mnemos Python SDK（仓库内）
pip install ./sdk/python
# 或：export PYTHONPATH="$PWD/sdk/python:$PYTHONPATH"

# 2) 安装适配器（可选安装 langchain-core）
pip install ./integrations/langchain-mnemos
pip install "langchain-core>=0.2"     # 需要作为 BaseStore 使用时
```

仓库内直接运行（不安装）：

```bash
export PYTHONPATH="$PWD/sdk/python:$PWD/integrations/langchain-mnemos:$PYTHONPATH"
```

## 2. 快速开始

```python
from mnemos_langchain import MnemosStore

store = MnemosStore(
    base_url="http://127.0.0.1:4380",
    api_key="mnemos_live_…",
    namespace=("ws-demo", "dsh-agent"),   # (partition, person)
)

namespace = ("ws-demo", "dsh-agent")

# set / get
store.set(namespace, "review-policy", {
    "content": "评审必须覆盖回滚方案与监控指标",
    "metadata": {"owner": "platform"},
})
assert store.get(namespace, "review-policy")["metadata"]["owner"] == "platform"

# 批量
store.mset([
    ("doc-1", {"content": "v6 使用 data-v6/ 作为数据目录"}),
    ("doc-2", {"content": "记忆永远属于一个人"}),
])
store.mget(["doc-1", "doc-2"])

# 检索（走 Mnemos hybrid 检索，返回 [(key, value, score)]）
for key, value, score in store.search(namespace, "回滚", limit=5):
    print(score, key, value["content"])

# 遍历 / 删除
keys = list(store.yield_keys(prefix="doc-"))
store.mdelete(keys)
```

在 LangChain 中使用时它就是 `BaseStore`：

```python
from langchain_core.stores import BaseStore
from mnemos_langchain import MnemosStore

store: BaseStore = MnemosStore(
    base_url="http://127.0.0.1:4380",
    api_key="mnemos_live_…",
    namespace=("ws-demo", "dsh-agent"),
)
```

> 安装 `langchain-core` 后 `MnemosStore` 会直接继承 `langchain_core.stores.BaseStore`
> （同时实现 `mget/mset/mdelete/yield_keys/search`）；未安装时是一个鸭子类型兼容类。

## 3. 命名空间 → 分区 / 人

| namespace | 解析结果 |
| --- | --- |
| `("ws-demo", "dsh-agent")` | partition=`ws-demo`，person=`dsh-agent` |
| `("ws-demo",)` | partition=`ws-demo`，person=构造参数 `person`（默认 `dsh-agent`） |
| `None` / `()` | 构造参数 `namespace` → `partition` / `person` |
| `{"partition": "ws-demo", "person": "user-1"}` | 显式映射 |

- `person` 使用 **external_id**（App 的 user_id、Agent 的 id），不是内部 `prs_*`。
- 缺少分区或人时抛 `ValueError`，不会静默写入错误位置。
- `namespace` 的原始片段会存进 `metadata.lc_namespace`，便于排查。

## 4. 行为细节

### 写入

- content 取 value 的 `content` / `text` / `page_content`，否则 JSON 序列化整个 value；
- 记忆 `metadata`：`{"lc_key": key, "lc_value": value, "lc_namespace": [...]}`，
  `tags` 附加 `"langchain"`，`scope` 默认 `person`；
- 同一个 key 再次 `set` 走 `PATCH /memories/:id`（更新，不新增）；
- 进程内维护 `key → memory_id` 缓存；跨进程/重启后首次 `get` 会按人翻记忆列表，
  用 `metadata.lc_key` 找回（命中后写回缓存）。

### 检索

- 有 `query`：`POST /v1/partitions/:p/memories/search`，按 `metadata.lc_key` 还原
  key，返回 `(key, value, score)`；
- 无 `query`：`GET /v1/partitions/:p/memories?person_external_id=…` 按最近记忆返回，
  score 为 `0.0`。

### 删除

- `delete` / `mdelete` 删除对应记忆（服务端 204）；不存在时静默返回（幂等）。

### 已知限制

- Mnemos 按**内容哈希**去重：两个不同 key 写入**完全相同正文**时，服务端会返回
  `NOOP`/`MERGE` 并带回另一条 key 的记忆。适配器检测到这种冲突会抛
  `ValueError`（避免 `get(key)` 读到错误 value）；请让不同 key 的正文不同。
- 跨进程 key 查找依赖扫描该人的记忆列表（最多 200 条/页），只在缓存未命中时发生。
- `yield_keys` 的 `prefix` 是 key 前缀（客户端过滤），不是服务端索引。

## 5. 测试

测试使用 fake client，不依赖 `langchain-core`、不依赖真实 Mnemos：

```bash
cd integrations/langchain-mnemos
python3 -m unittest discover -s tests -v
```

覆盖：set/get 往返、同 key 更新、批量 mget/mset/mdelete、search（有/无 query）、
yield_keys 前缀、namespace 映射（tuple/单元素/dict/默认）、跨进程恢复（列表扫描）、
内容去重冲突、无 langchain 也可导入。

## 6. 目录结构

```text
integrations/langchain-mnemos/
├── mnemos_langchain/
│   ├── __init__.py
│   └── store.py      # MnemosStore
├── tests/test_store.py
├── pyproject.toml
└── README.md
```
