"""MnemosStore 测试：fake client，不依赖 langchain / 真实 Mnemos。

运行::

    cd integrations/langchain-mnemos && python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mnemos_langchain import LANGCHAIN_AVAILABLE, MnemosStore  # noqa: E402


class FakeMemories:
    """内存版记忆资源，签名对齐 sdk/python 的 MemoriesResource。"""

    def __init__(self) -> None:
        self.items: List[Dict[str, Any]] = []
        self.calls: List[Dict[str, Any]] = []
        self.sequence = 0
        self.force_noop_key: Optional[str] = None

    def _record(self, op: str, **kwargs: Any) -> None:
        self.calls.append({"op": op, **kwargs})

    def add(
        self,
        person: str,
        *,
        text: Optional[str] = None,
        content: Optional[str] = None,
        messages: Any = None,
        metadata: Optional[Dict[str, Any]] = None,
        scope: Optional[str] = None,
        tags: Optional[List[str]] = None,
        partition: Optional[str] = None,
        **kwargs: Any,
    ) -> Any:
        self._record(
            "add",
            person=person,
            text=text,
            metadata=dict(metadata or {}),
            scope=scope,
            tags=tags,
            partition=partition,
        )
        if self.force_noop_key is not None:
            memory = {
                "id": "mem_noop",
                "partition_id": partition,
                "person_id": person,
                "person_external_id": person,
                "content": text,
                "metadata": {"lc_key": self.force_noop_key},
                "scope": scope,
            }
            return SimpleNamespace(memory=SimpleNamespace(**memory), event="NOOP")

        self.sequence += 1
        memory = {
            "id": f"mem_{self.sequence}",
            "partition_id": partition,
            "person_id": person,
            "person_external_id": person,
            "content": text or content or "",
            "metadata": dict(metadata or {}),
            "scope": scope,
            "tags": list(tags or []),
        }
        self.items.append(memory)
        return SimpleNamespace(memory=SimpleNamespace(**memory), event="ADD")

    def update(
        self,
        memory_id: str,
        *,
        content: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        partition: Optional[str] = None,
        **kwargs: Any,
    ) -> Any:
        self._record("update", memory_id=memory_id, content=content, metadata=metadata, partition=partition)
        memory = self._get(memory_id)
        if content is not None:
            memory["content"] = content
        if metadata is not None:
            memory["metadata"] = dict(metadata)
        return SimpleNamespace(**memory)

    def get(self, memory_id: str, *, partition: Optional[str] = None) -> Any:
        self._record("get", memory_id=memory_id, partition=partition)
        return SimpleNamespace(memory=SimpleNamespace(**self._get(memory_id)))

    def delete(self, memory_id: str, *, partition: Optional[str] = None) -> None:
        self._record("delete", memory_id=memory_id, partition=partition)
        self.items = [item for item in self.items if item["id"] != memory_id]

    def list(
        self,
        partition: Optional[str] = None,
        *,
        person_id: Optional[str] = None,
        person_external_id: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        **kwargs: Any,
    ) -> Any:
        self._record("list", partition=partition, person_id=person_id, person_external_id=person_external_id)
        items = list(self.items)
        if person_id:
            items = [item for item in items if item["person_id"] == person_id]
        if person_external_id:
            items = [item for item in items if item["person_external_id"] == person_external_id]
        if limit:
            items = items[:limit]
        return SimpleNamespace(items=[SimpleNamespace(**item) for item in items], next_cursor=None)

    def search(
        self,
        query: str,
        *,
        partition: Optional[str] = None,
        person_external_id: Optional[str] = None,
        top_k: Optional[int] = None,
        **kwargs: Any,
    ) -> Any:
        self._record("search", query=query, partition=partition, person_external_id=person_external_id, top_k=top_k)
        hits = [item for item in self.items if query in item["content"]]
        if person_external_id:
            hits = [item for item in hits if item["person_external_id"] == person_external_id]
        hits = hits[: top_k or 8]
        return SimpleNamespace(
            hits=[SimpleNamespace(**item, score=0.9) for item in hits],
            results=[],
            mode="hybrid",
            strategy="fake",
        )

    def _get(self, memory_id: str) -> Dict[str, Any]:
        for item in self.items:
            if item["id"] == memory_id:
                return item
        raise KeyError(memory_id)


class FakeClient:
    def __init__(self) -> None:
        self.memories = FakeMemories()


class MnemosStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = FakeClient()
        self.store = MnemosStore(
            client=self.client,
            partition="ws-demo",
            person="user-1",
        )
        self.namespace = ("ws-demo", "user-1")

    # --- 基本读写 ------------------------------------------------------

    def test_set_get_roundtrip(self) -> None:
        value = {"content": "评审必须覆盖回滚方案", "metadata": {"source": "test"}}
        self.store.set(self.namespace, "doc-1", value)

        self.assertEqual(len(self.client.memories.items), 1)
        memory = self.client.memories.items[0]
        self.assertEqual(memory["content"], "评审必须覆盖回滚方案")
        self.assertEqual(memory["metadata"]["lc_key"], "doc-1")
        self.assertEqual(memory["metadata"]["lc_value"], value)
        self.assertEqual(memory["metadata"]["lc_namespace"], ["ws-demo", "user-1"])
        self.assertEqual(memory["scope"], "person")
        self.assertIn("langchain", memory["tags"])

        self.assertEqual(self.store.get(self.namespace, "doc-1"), value)
        self.assertIsNone(self.store.get(self.namespace, "missing"))

    def test_set_same_key_updates_in_place(self) -> None:
        self.store.set(self.namespace, "doc-1", {"content": "第一版"})
        self.store.set(self.namespace, "doc-1", {"content": "第二版", "extra": 2})

        self.assertEqual(len(self.client.memories.items), 1)
        self.assertEqual(self.client.memories.items[0]["content"], "第二版")
        self.assertEqual(
            self.store.get(self.namespace, "doc-1"),
            {"content": "第二版", "extra": 2},
        )
        self.assertIn("update", [call["op"] for call in self.client.memories.calls])

    def test_plain_string_value(self) -> None:
        self.store.set(self.namespace, "raw", "纯文本")
        self.assertEqual(self.store.get(self.namespace, "raw"), {"content": "纯文本"})

    def test_mget_mset_mdelete(self) -> None:
        self.store.mset([("a", {"content": "A"}), ("b", {"content": "B"})])
        self.assertEqual(self.store.mget(["a", "b", "c"]), [{"content": "A"}, {"content": "B"}, None])

        self.store.mdelete(["a"])
        self.assertIsNone(self.store.get(self.namespace, "a"))
        self.assertEqual(self.store.get(self.namespace, "b"), {"content": "B"})

    def test_delete_is_idempotent(self) -> None:
        self.store.set(self.namespace, "doc-1", {"content": "删除我"})
        self.store.delete(self.namespace, "doc-1")
        self.assertIsNone(self.store.get(self.namespace, "doc-1"))
        self.store.delete(self.namespace, "doc-1")  # 不抛异常

    # --- 检索 / 遍历 ---------------------------------------------------

    def test_search_with_query_returns_key_value_score(self) -> None:
        self.store.set(self.namespace, "doc-1", {"content": "评审必须覆盖回滚方案"})
        self.store.set(self.namespace, "doc-2", {"content": "评审需要两人复核"})

        results = self.store.search(self.namespace, "回滚", limit=5)
        self.assertEqual(len(results), 1)
        key, value, score = results[0]
        self.assertEqual(key, "doc-1")
        self.assertEqual(value, {"content": "评审必须覆盖回滚方案"})
        self.assertAlmostEqual(score, 0.9)
        self.assertEqual(
            self.client.memories.calls[-1],
            {
                "op": "search",
                "query": "回滚",
                "partition": "ws-demo",
                "person_external_id": "user-1",
                "top_k": 5,
            },
        )

    def test_search_without_query_lists_recent(self) -> None:
        self.store.set(self.namespace, "doc-1", {"content": "A"})
        self.store.set(self.namespace, "doc-2", {"content": "B"})
        results = self.store.search(self.namespace, limit=10)
        self.assertEqual([key for key, _, score in results], ["doc-1", "doc-2"])
        self.assertTrue(all(score == 0.0 for _, _, score in results))

    def test_yield_keys_with_prefix(self) -> None:
        for key in ("doc-1", "doc-2", "other"):
            self.store.set(self.namespace, key, {"content": f"内容 {key}"})
        self.assertEqual(sorted(self.store.yield_keys(prefix="doc-")), ["doc-1", "doc-2"])

    # --- 命名空间映射 --------------------------------------------------

    def test_namespace_mapping_variants(self) -> None:
        self.store.set(("other-partition",), "k", {"content": "x"})
        self.assertEqual(self.client.memories.items[-1]["partition_id"], "other-partition")
        self.assertEqual(self.client.memories.items[-1]["person_external_id"], "user-1")

        self.store.set(("p2", "u2"), "k2", {"content": "y"})
        self.assertEqual(self.client.memories.items[-1]["partition_id"], "p2")
        self.assertEqual(self.client.memories.items[-1]["person_external_id"], "u2")

        self.store.set({"partition": "p3", "person": "u3"}, "k3", {"content": "z"})
        self.assertEqual(self.client.memories.items[-1]["partition_id"], "p3")
        self.assertEqual(self.client.memories.items[-1]["person_external_id"], "u3")

        empty = MnemosStore(client=self.client)
        with self.assertRaises(ValueError):
            empty.set(None, "k", {"content": "no namespace"})

    def test_default_namespace(self) -> None:
        store = MnemosStore(client=self.client, namespace=("ws-demo", "dsh-agent"))
        store.set(None, "k", {"content": "默认命名空间"})
        self.assertEqual(self.client.memories.items[-1]["person_external_id"], "dsh-agent")
        self.assertEqual(store.get(None, "k"), {"content": "默认命名空间"})

    def test_person_namespace_uses_external_id_filter(self) -> None:
        self.store.set(self.namespace, "doc-1", {"content": "A"})
        self.client.memories.calls.clear()
        self.assertIsNotNone(self.store.get(self.namespace, "doc-1"))
        # 缓存命中时不应扫描；换个新 store 模拟跨进程恢复。
        fresh = MnemosStore(client=self.client, partition="ws-demo", person="user-1")
        self.assertEqual(fresh.get(self.namespace, "doc-1"), {"content": "A"})
        list_calls = [call for call in self.client.memories.calls if call["op"] == "list"]
        self.assertTrue(list_calls)
        self.assertEqual(list_calls[0]["person_external_id"], "user-1")

    # --- 去重冲突 ------------------------------------------------------

    def test_content_dedupe_collision_raises_clear_error(self) -> None:
        self.client.memories.force_noop_key = "another-key"
        with self.assertRaisesRegex(ValueError, "按内容去重"):
            self.store.set(self.namespace, "doc-1", {"content": "相同正文"})

    # --- 导入 / 可选依赖 ----------------------------------------------

    def test_importable_with_optional_langchain(self) -> None:
        # 未安装 langchain-core 时 LANGCHAIN_AVAILABLE=False，但类仍可用。
        self.assertIn(LANGCHAIN_AVAILABLE, (True, False))
        self.assertTrue(callable(getattr(MnemosStore, "get", None)))
        self.assertTrue(callable(getattr(MnemosStore, "search", None)))


if __name__ == "__main__":
    unittest.main()
