"""Mnemos × LangChain：``BaseStore`` 兼容的持久化键值存储。

设计目标：

- **可选依赖**：未安装 ``langchain-core`` 时仍可 ``import mnemos_langchain`` 并使用
  :class:`MnemosStore`（退化为普通类，方法签名与 BaseStore 一致）；
- **命名空间 → 分区/人**：LangChain 的 ``namespace``（tuple[str, ...]）映射到
  Mnemos 的 ``(partition, person)``；``(partition, person)``、``(partition,)``、
  ``None``/``()``（用构造默认值）以及 dict 形式都支持；
- **值原样往返**：``set`` 把 value 的 JSON 塞进记忆 ``metadata["lc_value"]``，
  ``get`` 原样返回；同时把 ``metadata["lc_key"]`` 作为持久 key；
- **不依赖 langchain 也能测试**：测试注入 fake client，不需要真实 Mnemos。

典型用法::

    from mnemos_langchain import MnemosStore

    store = MnemosStore(
        base_url="http://127.0.0.1:4380",
        api_key="mnemos_live_…",
        namespace=("ws-demo", "dsh-agent"),
    )
    store.set(("ws-demo", "dsh-agent"), "doc-1", {"content": "评审必须覆盖回滚方案"})
    value = store.get(("ws-demo", "dsh-agent"), "doc-1")
    hits = store.search(("ws-demo", "dsh-agent"), "回滚", limit=5)
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator, Mapping, Sequence
from typing import Any, Dict, List, Optional, Tuple

try:  # 可选依赖：未安装 langchain-core 也可导入本模块
    from langchain_core.stores import BaseStore as _LangChainBaseStore

    LANGCHAIN_AVAILABLE = True
except Exception:  # pragma: no cover - 取决于运行环境
    _LangChainBaseStore = object  # type: ignore[assignment,misc]
    LANGCHAIN_AVAILABLE = False


JSON = Dict[str, Any]
Namespace = Any  # tuple[str, ...] | str | Mapping[str, str] | None
_INDEX_KEY = Tuple[str, str, str]


def _json_safe(value: Any) -> Any:
    """把 value 变成可 JSON 化的结构（不可序列化对象退化为字符串）。"""
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return {"value": str(value)}


def _content_of(value: Any) -> str:
    """抽取用于写入记忆正文的文本。"""
    if isinstance(value, Mapping):
        for key in ("content", "text", "page_content"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                return candidate
        return json.dumps(_json_safe(value), ensure_ascii=False)
    if isinstance(value, str):
        return value
    return json.dumps(_json_safe(value), ensure_ascii=False)


def _value_of(memory: Any) -> JSON:
    """从 Memory（对象或 dict）还原存进去的 value。"""
    metadata = memory.get("metadata") if isinstance(memory, Mapping) else getattr(memory, "metadata", None)
    if not isinstance(metadata, Mapping):
        metadata = {}
    stored = metadata.get("lc_value")
    if isinstance(stored, Mapping):
        return dict(stored)
    content = memory.get("content") if isinstance(memory, Mapping) else getattr(memory, "content", "")
    return {"content": content}


def _memory_id(memory: Any) -> str:
    return str(memory.get("id") if isinstance(memory, Mapping) else getattr(memory, "id", ""))


def _memory_metadata(memory: Any) -> JSON:
    metadata = memory.get("metadata") if isinstance(memory, Mapping) else getattr(memory, "metadata", None)
    return dict(metadata) if isinstance(metadata, Mapping) else {}


class MnemosStore(_LangChainBaseStore):  # type: ignore[misc,valid-type]
    """LangChain ``BaseStore`` 兼容实现（命名空间映射到 Mnemos 分区/人）。

    参数
    ----
    client:
        可选的现成客户端（需提供 ``memories`` / ``persons`` 资源；默认使用
        ``mnemos.MnemosClient``）。测试或复用已有连接时注入。
    base_url / api_key:
        创建默认客户端时使用；缺省读 ``MNEMOS_BASE_URL`` / ``MNEMOS_API_KEY``。
    partition / person:
        默认命名空间（``namespace`` 参数缺省时使用）。``person`` 默认
        ``MNEMOS_PERSON`` 或 ``dsh-agent``。
    namespace:
        默认 namespace，等价于每次调用都传它。
    scope:
        写入记忆的 scope，默认 ``person``（仅该人可见，符合 key-value 语义）。
    """

    def __init__(
        self,
        client: Any = None,
        *,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        partition: Optional[str] = None,
        person: Optional[str] = None,
        namespace: Optional[Namespace] = None,
        scope: str = "person",
        env: Optional[Mapping[str, str]] = None,
    ) -> None:
        env_map = os.environ if env is None else env
        self._client = client
        self._base_url = base_url or env_map.get("MNEMOS_BASE_URL")
        self._api_key = api_key or env_map.get("MNEMOS_API_KEY")
        self._partition = partition
        self._person = person or env_map.get("MNEMOS_PERSON") or "dsh-agent"
        self._default_namespace = namespace
        self._scope = scope
        # 进程内 key → memory_id 缓存：避免每次 get 都扫描列表。
        self._index: Dict[_INDEX_KEY, str] = {}

    # ------------------------------------------------------------------
    # 客户端 / 命名空间
    # ------------------------------------------------------------------

    @property
    def client(self) -> Any:
        """懒创建 Mnemos 客户端；未安装 SDK 时给出明确 ImportError。"""
        if self._client is None:
            try:
                from mnemos import MnemosClient
            except ImportError as exc:  # pragma: no cover - 取决于安装方式
                raise ImportError(
                    "未找到 mnemos SDK：请 `pip install ./sdk/python`，"
                    "或把 `sdk/python` 加入 PYTHONPATH，或向 MnemosStore(client=…) 注入客户端"
                ) from exc
            self._client = MnemosClient(
                self._api_key,
                self._base_url,
                partition=self._partition,
                person=self._person,
            )
        return self._client

    def _resolve_namespace(self, namespace: Optional[Namespace]) -> Tuple[str, str, Tuple[str, ...]]:
        raw = namespace if namespace is not None else self._default_namespace
        if raw is None:
            parts: Tuple[str, ...] = ()
        elif isinstance(raw, str):
            parts = (raw,)
        elif isinstance(raw, Mapping):
            partition = raw.get("partition") or self._partition
            person = raw.get("person") or self._person
            if not partition:
                raise ValueError("namespace 缺少 partition：请传 (partition, person) 或构造参数 partition=…")
            return str(partition), str(person), (str(partition), str(person))
        elif isinstance(raw, (tuple, list)):
            parts = tuple(str(part) for part in raw if part is not None)
        else:
            raise TypeError(f"namespace 需要 tuple/list/str/dict，收到 {type(raw)!r}")

        partition = parts[0] if len(parts) >= 1 and parts[0] else self._partition
        person = parts[1] if len(parts) >= 2 and parts[1] else self._person
        if not partition:
            raise ValueError(
                "namespace 缺少分区：请传 (partition, person)、构造参数 partition=… 或 namespace=['<partition>']"
            )
        if not person:
            raise ValueError("namespace 缺少人：请传 (partition, person) 或构造参数 person=…")
        return str(partition), str(person), parts

    def _index_key(self, partition: str, person: str, key: str) -> _INDEX_KEY:
        return partition, person, key

    # ------------------------------------------------------------------
    # BaseStore 接口
    # ------------------------------------------------------------------

    def get(self, namespace: Optional[Namespace], key: str) -> Optional[JSON]:
        partition, person, _ = self._resolve_namespace(namespace)
        memory_id = self._find_memory_id(partition, person, str(key))
        if not memory_id:
            return None
        try:
            detail = self.client.memories.get(memory_id, partition=partition)
        except Exception as exc:
            if getattr(exc, "status", None) != 404:
                raise
            self._index.pop(self._index_key(partition, person, str(key)), None)
            return None
        memory = getattr(detail, "memory", detail)
        if not memory:
            return None
        return _value_of(memory)

    def mget(self, keys: Sequence[str]) -> List[Optional[JSON]]:
        values: List[Optional[JSON]] = []
        for key in keys:
            values.append(self.get(self._default_namespace, key))
        return values

    def set(self, namespace: Optional[Namespace], key: str, value: JSON) -> None:
        partition, person, parts = self._resolve_namespace(namespace)
        key = str(key)
        metadata = {
            "lc_key": key,
            "lc_value": _json_safe(value),
            "lc_namespace": list(parts),
        }
        content = _content_of(value)
        existing = self._find_memory_id(partition, person, key)
        if existing:
            try:
                self.client.memories.update(
                    existing,
                    content=content,
                    metadata=metadata,
                    partition=partition,
                )
                self._index[self._index_key(partition, person, key)] = existing
                return
            except Exception as exc:
                # 记忆已被删除（404）时退化为新建；网络/权限错误照常抛出。
                if getattr(exc, "status", None) != 404:
                    raise
                self._index.pop(self._index_key(partition, person, key), None)

        result = self.client.memories.add(
            person,
            text=content,
            metadata=metadata,
            scope=self._scope,
            tags=["langchain"],
            partition=partition,
        )
        memory = getattr(result, "memory", result)
        memory_id = _memory_id(memory)
        stored_key = _memory_metadata(memory).get("lc_key")
        if stored_key and stored_key != key:
            # 服务端按内容去重（NOOP/MERGE）把另一条 key 的记忆返回了；
            # 继续写入会让 get(key) 读到别的 value，宁可明确失败。
            raise ValueError(
                "Mnemos 按内容去重：相同正文已属于 key="
                f"{stored_key!r}；请让不同 key 的 value 正文不同，或使用不同的 namespace"
            )
        if memory_id:
            self._index[self._index_key(partition, person, key)] = memory_id

    def mset(self, key_value_pairs: Sequence[Tuple[str, JSON]]) -> None:
        for key, value in key_value_pairs:
            self.set(self._default_namespace, key, value)

    def delete(self, namespace: Optional[Namespace], key: str) -> None:
        partition, person, _ = self._resolve_namespace(namespace)
        key = str(key)
        memory_id = self._find_memory_id(partition, person, key)
        if not memory_id:
            return
        try:
            self.client.memories.delete(memory_id, partition=partition)
        except Exception as exc:
            if getattr(exc, "status", None) != 404:
                raise
        finally:
            self._index.pop(self._index_key(partition, person, key), None)

    def mdelete(self, keys: Sequence[str]) -> None:
        for key in keys:
            self.delete(self._default_namespace, key)

    def yield_keys(
        self,
        prefix: Optional[str] = None,
        namespace: Optional[Namespace] = None,
    ) -> Iterator[str]:
        partition, person, _ = self._resolve_namespace(namespace)
        cursor: Optional[str] = None
        while True:
            page = self.client.memories.list(
                partition=partition,
                person_external_id=person,
                limit=200,
                cursor=cursor,
            )
            items = getattr(page, "items", None) or []
            for memory in items:
                metadata = _memory_metadata(memory)
                key = metadata.get("lc_key")
                if not isinstance(key, str):
                    continue
                if prefix and not key.startswith(prefix):
                    continue
                self._index[self._index_key(partition, person, key)] = _memory_id(memory)
                yield key
            cursor = getattr(page, "next_cursor", None)
            if not cursor:
                break

    def search(
        self,
        namespace: Optional[Namespace],
        query: Optional[str] = None,
        *,
        limit: int = 10,
        **kwargs: Any,
    ) -> List[Tuple[str, JSON, float]]:
        """检索当前 namespace 下的 key-value。

        有 ``query`` 时走 Mnemos 混合检索并按 ``lc_key`` 还原 key；无 ``query`` 时
        按最近记忆列表返回。
        """
        partition, person, _ = self._resolve_namespace(namespace)
        limit = max(1, int(limit))
        results: List[Tuple[str, JSON, float]] = []

        if query:
            response = self.client.memories.search(
                str(query),
                partition=partition,
                person_external_id=person,
                top_k=limit,
            )
            hits = getattr(response, "hits", None)
            if hits is None:
                hits = getattr(response, "results", None) or []
            for hit in hits:
                metadata = _memory_metadata(hit)
                key = metadata.get("lc_key")
                if not isinstance(key, str):
                    continue
                score = float(getattr(hit, "score", 0.0) or 0.0)
                self._index[self._index_key(partition, person, key)] = _memory_id(hit)
                results.append((key, _value_of(hit), score))
            return results[:limit]

        page = self.client.memories.list(
            partition=partition,
            person_external_id=person,
            limit=limit,
        )
        items = getattr(page, "items", None) or []
        for memory in items:
            metadata = _memory_metadata(memory)
            key = metadata.get("lc_key")
            if not isinstance(key, str):
                continue
            self._index[self._index_key(partition, person, key)] = _memory_id(memory)
            results.append((key, _value_of(memory), 0.0))
        return results[:limit]

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    def _find_memory_id(self, partition: str, person: str, key: str) -> Optional[str]:
        cached = self._index.get(self._index_key(partition, person, key))
        if cached:
            return cached
        # 进程内没缓存：按人翻列表，按 metadata.lc_key 匹配（跨进程/重启后的兜底）。
        cursor: Optional[str] = None
        while True:
            page = self.client.memories.list(
                partition=partition,
                person_external_id=person,
                limit=200,
                cursor=cursor,
            )
            for memory in getattr(page, "items", None) or []:
                metadata = _memory_metadata(memory)
                if metadata.get("lc_key") == key:
                    memory_id = _memory_id(memory)
                    if memory_id:
                        self._index[self._index_key(partition, person, key)] = memory_id
                    return memory_id or None
            cursor = getattr(page, "next_cursor", None)
            if not cursor:
                return None


__all__ = ["MnemosStore", "LANGCHAIN_AVAILABLE"]
