"""Python SDK 测试：本地 ``http.server`` fake（随机端口，无外部依赖）。

运行::

    cd sdk/python && python3 -m unittest discover -s tests -v

覆盖：鉴权头 / 请求体 snake_case / 查询参数 / 游标分页 / 检索信号 /
历史与反馈 / 简报 / 上下文 / 做梦 / 统计 / 错误映射 / 429 重试 / 网络错误 /
204 删除 / dataclass 宽容解析 / 可选 P1 画像接口。
"""

from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mnemos import (  # noqa: E402
    MnemosApiError,
    MnemosClient,
    MnemosNetworkError,
    Memory,
    PartitionStats,
)
from mnemos.errors import MnemosTimeoutError  # noqa: E402

RouteKey = Tuple[str, str]


class _FakeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # 保持测试输出干净
        return

    def _dispatch(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        server: "_FakeServer" = self.server  # type: ignore[assignment]
        record = {
            "method": self.command,
            "path": parsed.path,
            "query": urllib.parse.parse_qs(parsed.query),
            "headers": {key.lower(): value for key, value in self.headers.items()},
            "body": raw.decode("utf-8") if raw else "",
        }
        server.requests.append(record)

        responses: Optional[Deque[Dict[str, Any]]] = server.routes.get((self.command, parsed.path))
        if not responses:
            self._send(404, {"error": {"code": "NOT_FOUND", "message": "未注册的 fake 路由"}})
            return
        response = responses.popleft() if len(responses) > 1 else responses[0]
        self._send(
            response.get("status", 200),
            response.get("body"),
            response.get("headers") or {},
        )

    def _send(self, status: int, body: Any, headers: Optional[Dict[str, str]] = None) -> None:
        raw = b""
        if body is not None and status != 204:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        if raw:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if raw:
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

    do_GET = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_PATCH = _dispatch
    do_DELETE = _dispatch


class _FakeServer:
    def __init__(self) -> None:
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _FakeHandler)
        self.httpd.daemon_threads = True
        self.routes: Dict[RouteKey, Deque[Dict[str, Any]]] = {}
        self.requests: List[Dict[str, Any]] = []
        # handler 通过 self.server 访问共享状态
        self.httpd.routes = self.routes  # type: ignore[attr-defined]
        self.httpd.requests = self.requests  # type: ignore[attr-defined]
        self.thread = threading.Thread(
            target=lambda: self.httpd.serve_forever(poll_interval=0.01), daemon=True
        )
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"

    def route(self, method: str, path: str, *responses: Dict[str, Any]) -> None:
        self.routes[(method.upper(), path)] = deque(responses)

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class SdkTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = _FakeServer()
        self.addCleanup(self.fake.close)
        self.client = MnemosClient(
            "mnemos_live_test_key",
            self.fake.base_url,
            partition="ws-demo",
            person="user-1",
            max_retries=0,
            retry_base_delay=0.0,
        )

    # --- 分区 / 人 ----------------------------------------------------

    def test_persons_cursor_and_request_contract(self) -> None:
        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/persons",
            {
                "body": {
                    "items": [
                        {
                            "id": "prs_1",
                            "partition_id": "ptn_1",
                            "external_id": "user-1",
                            "type": "human",
                            "display_name": "周野",
                            "memory_count": 3,
                        }
                    ],
                    "next_cursor": "cursor-2",
                    "partition_stats": {
                        "partition_id": "ptn_1",
                        "persons_total": 4,
                        "memories_total": 12,
                    },
                }
            },
        )
        page = self.client.persons.list(limit=3, cursor="cursor-1", sort="recent", type="human")
        self.assertEqual(len(page.items), 1)
        self.assertEqual(page.items[0].external_id, "user-1")
        self.assertEqual(page.items[0].display_name, "周野")
        self.assertEqual(page.next_cursor, "cursor-2")
        self.assertIsNotNone(page.partition_stats)
        self.assertEqual(page.partition_stats.persons_total, 4)

        request = self.fake.requests[-1]
        self.assertEqual(request["method"], "GET")
        self.assertEqual(request["path"], "/v1/partitions/ws-demo/persons")
        self.assertEqual(request["query"]["limit"], ["3"])
        self.assertEqual(request["query"]["cursor"], ["cursor-1"])
        self.assertEqual(request["query"]["sort"], ["recent"])
        self.assertEqual(request["query"]["type"], ["human"])
        self.assertEqual(request["headers"]["authorization"], "Bearer mnemos_live_test_key")
        self.assertIn("mnemos-python-sdk", request["headers"]["user-agent"])

    def test_person_upsert_and_stats(self) -> None:
        self.fake.route(
            "PUT",
            "/v1/partitions/ws-demo/persons/user-1",
            {"body": {"id": "prs_1", "external_id": "user-1", "type": "human"}},
        )
        person = self.client.persons.upsert(
            "user-1", type="human", display_name="周野", attributes={"team": "core"}
        )
        self.assertEqual(person.id, "prs_1")
        body = json.loads(self.fake.requests[-1]["body"])
        self.assertEqual(body["display_name"], "周野")
        self.assertEqual(body["attributes"], {"team": "core"})
        self.assertNotIn("status", body)  # None 字段不发送

        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/stats",
            {"body": {"partition_id": "ptn_1", "memories_total": 12, "shared_total": 9}},
        )
        stats = self.client.stats()
        self.assertIsInstance(stats, PartitionStats)
        self.assertEqual(stats.memories_total, 12)
        self.assertEqual(stats.shared_total, 9)

    # --- 记忆 ----------------------------------------------------------

    def test_memory_add_result_snake_case_and_idempotency(self) -> None:
        self.fake.route(
            "POST",
            "/v1/partitions/ws-demo/persons/user-1/memories",
            {
                "status": 200,
                "body": {
                    "memory": {
                        "id": "mem_1",
                        "partition_id": "ptn_1",
                        "person_id": "prs_1",
                        "content": "旧内容",
                        "valid_to": "2026-11-18T00:00:00.000Z",
                        "superseded_by": "mem_2",
                        "feedback_up": 2,
                    },
                    "event": "SUPERSEDE",
                    "superseded_id": "mem_0",
                    "events": [{"type": "SUPERSEDE", "memory_id": "mem_1"}],
                },
            },
        )
        result = self.client.memories.add(
            "user-1",
            text="新内容",
            category="preference",
            importance=0.8,
            scope="partition",
            tags=["偏好"],
            metadata={"from": "test"},
            placeholders={"phone_a1b2": "18334423321"},
            supersedes_id="mem_0",
            fact_key="preference.language",
            idempotency_key="idem-1",
        )
        self.assertEqual(result.event, "SUPERSEDE")
        self.assertEqual(result.superseded_id, "mem_0")
        self.assertEqual(result.memory.id, "mem_1")
        self.assertEqual(result.memory.superseded_by, "mem_2")
        self.assertEqual(result.memory.feedback_up, 2)

        request = self.fake.requests[-1]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["headers"]["idempotency-key"], "idem-1")
        body = json.loads(request["body"])
        self.assertEqual(body["text"], "新内容")
        self.assertEqual(body["supersedes_id"], "mem_0")
        self.assertEqual(body["fact_key"], "preference.language")
        self.assertEqual(body["tags"], ["偏好"])
        self.assertEqual(body["placeholders"], {"phone_a1b2": "18334423321"})
        self.assertNotIn("content", body)
        self.assertNotIn("expires_at", body)

    def test_memory_search_signals_and_mode(self) -> None:
        self.fake.route(
            "POST",
            "/v1/partitions/ws-demo/memories/search",
            {
                "body": {
                    "hits": [
                        {
                            "id": "mem_1",
                            "content": "周野偏好中文评审",
                            "score": 0.87,
                            "signals": {
                                "vector": 0.9,
                                "keyword": 0.7,
                                "recency": 0.5,
                                "importance": 0.8,
                                "entity": 0.2,
                            },
                            "matched_on": ["content", "tags"],
                        }
                    ],
                    "results": [{"id": "mem_1", "content": "周野偏好中文评审"}],
                    "took_ms": 4,
                    "mode": "hybrid",
                    "strategy": "vector+keyword",
                    "partition_stats": {"partition_id": "ptn_1", "memories_total": 1},
                }
            },
        )
        response = self.client.memories.search(
            "评审偏好", top_k=5, mode="hybrid", include_superseded=True
        )
        self.assertEqual(response.mode, "hybrid")
        self.assertEqual(response.took_ms, 4)
        self.assertEqual(response.strategy, "vector+keyword")
        self.assertEqual(len(response.hits), 1)
        hit = response.hits[0]
        self.assertAlmostEqual(hit.score, 0.87)
        self.assertAlmostEqual(hit.signals.keyword, 0.7)
        self.assertEqual(hit.matched_on, ["content", "tags"])
        self.assertEqual(response.results[0].content, "周野偏好中文评审")

        body = json.loads(self.fake.requests[-1]["body"])
        self.assertEqual(body["query"], "评审偏好")
        self.assertEqual(body["top_k"], 5)
        self.assertIs(body["include_superseded"], True)

    def test_history_and_feedback(self) -> None:
        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/memories/mem_1/history",
            {
                "body": {
                    "items": [
                        {"id": "h1", "memory_id": "mem_1", "event": "ADD", "new_content": "x"},
                        {"id": "h2", "memory_id": "mem_1", "event": "FEEDBACK", "reason": "有用"},
                    ]
                }
            },
        )
        history = self.client.memories.history("mem_1")
        self.assertEqual([entry.event for entry in history], ["ADD", "FEEDBACK"])
        self.assertEqual(history[1].reason, "有用")

        self.fake.route(
            "POST",
            "/v1/partitions/ws-demo/memories/mem_1/feedback",
            {"body": {"memory": {"id": "mem_1", "feedback_up": 1, "confidence": 0.85}}},
        )
        memory = self.client.memories.feedback("mem_1", True, query="评审")
        self.assertEqual(memory.feedback_up, 1)
        body = json.loads(self.fake.requests[-1]["body"])
        self.assertIs(body["helpful"], True)
        self.assertEqual(body["query"], "评审")

    # --- 简报 / 上下文 / 做梦 -----------------------------------------

    def test_brief_context_dream_and_delete(self) -> None:
        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/persons/user-1/brief",
            {
                "body": {
                    "partition_id": "ptn_1",
                    "person_id": "prs_1",
                    "text": "- [偏好] 喜欢先看结论",
                    "count": 1,
                    "max_chars": 400,
                    "model": "mnemos-condense",
                    "cached": False,
                    "recent": [{"id": "mem_1", "content": "喜欢先看结论", "importance": 0.9}],
                }
            },
        )
        brief = self.client.brief(max_chars=400, force=True)
        self.assertIn("先看结论", brief.text)
        self.assertEqual(brief.recent[0].id, "mem_1")
        query = self.fake.requests[-1]["query"]
        self.assertEqual(query["max_chars"], ["400"])
        self.assertEqual(query["force"], ["true"])

        self.fake.route(
            "POST",
            "/v1/partitions/ws-demo/persons/user-1/context",
            {
                "body": {
                    "person": {"id": "prs_1", "external_id": "user-1"},
                    "brief": {"text": "简报"},
                    "memories": [{"id": "mem_1", "content": "相关记忆"}],
                    "shared": [{"id": "mem_2", "content": "共享知识"}],
                    "prompt": "## 人物资料\n…",
                    "token_estimate": 318,
                    "citations": ["mem_1", "mem_2"],
                }
            },
        )
        context = self.client.context(query="评审", budget_tokens=800, include_partition=True)
        self.assertIn("人物资料", context.prompt)
        self.assertEqual(context.person.external_id, "user-1")
        self.assertEqual(context.memories[0].content, "相关记忆")
        self.assertEqual(context.shared[0].content, "共享知识")
        self.assertEqual(context.token_estimate, 318)
        body = json.loads(self.fake.requests[-1]["body"])
        self.assertEqual(body["budget_tokens"], 800)
        self.assertIs(body["include_partition"], True)

        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/persons/user-1/dream",
            {
                "body": {
                    "settings": {"enabled": True, "interval_minutes": 1440},
                    "person_id": "prs_1",
                    "pending_count": 2,
                    "runs": [{"id": "drm_1", "status": "completed", "input_count": 2}],
                }
            },
        )
        status = self.client.dream_status()
        self.assertEqual(status.pending_count, 2)
        self.assertEqual(status.runs[0].id, "drm_1")
        self.assertEqual(status.settings.interval_minutes, 1440)

        self.fake.route(
            "POST",
            "/v1/partitions/ws-demo/persons/user-1/dream/run",
            {
                "body": {
                    "run": {"id": "drm_2", "status": "completed", "input_count": 2},
                    "status": {"person_id": "prs_1", "pending_count": 0},
                }
            },
        )
        result = self.client.dream_run(batch_size=10)
        self.assertEqual(result.run.id, "drm_2")
        self.assertEqual(result.status.pending_count, 0)
        self.assertEqual(json.loads(self.fake.requests[-1]["body"]), {"batch_size": 10})

        self.fake.route("DELETE", "/v1/partitions/ws-demo/memories/mem_1", {"status": 204})
        self.assertIsNone(self.client.memories.delete("mem_1"))
        self.assertEqual(self.fake.requests[-1]["method"], "DELETE")

    # --- 可选 P1：画像 / 合并 ------------------------------------------

    def test_optional_profile_and_merge_contract(self) -> None:
        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/persons/user-1/profile",
            {
                "body": {
                    "person": {"id": "prs_1", "external_id": "user-1"},
                    "facts": [
                        {"id": "fact_1", "key": "preference.language", "value": "zh-CN", "confidence": 0.9}
                    ],
                    "summary": "偏好中文",
                    "cached": True,
                }
            },
        )
        profile = self.client.persons.profile("user-1", force=True)
        self.assertEqual(profile.person.id, "prs_1")
        self.assertEqual(profile.facts[0].key, "preference.language")
        self.assertEqual(profile.summary, "偏好中文")
        self.assertIs(profile.cached, True)
        self.assertEqual(self.fake.requests[-1]["query"]["force"], ["true"])

        self.fake.route(
            "PUT",
            "/v1/partitions/ws-demo/persons/user-1/facts",
            {"body": {"fact": {"id": "fact_2", "key": "plan.next", "value": "发布", "confidence": 0.8}}},
        )
        fact = self.client.persons.upsert_fact("user-1", key="plan.next", value="发布", confidence=0.8)
        self.assertEqual(fact.id, "fact_2")
        self.assertEqual(fact.key, "plan.next")
        self.assertEqual(
            json.loads(self.fake.requests[-1]["body"]),
            {"key": "plan.next", "value": "发布", "confidence": 0.8},
        )

        self.fake.route(
            "PUT",
            "/v1/partitions/ws-demo/persons/user-1/facts",
            {"body": {"items": [{"id": "fact_3", "key": "a", "value": "1"}, {"id": "fact_4", "key": "b", "value": "2"}]}},
        )
        facts = self.client.persons.upsert_facts("user-1", [{"key": "a", "value": "1"}, {"key": "b", "value": "2"}])
        self.assertEqual([item.id for item in facts], ["fact_3", "fact_4"])
        self.assertEqual(len(json.loads(self.fake.requests[-1]["body"])["facts"]), 2)

        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/persons/user-1/export",
            {
                "body": {
                    "person": {"id": "prs_1", "external_id": "user-1"},
                    "facts": [{"id": "fact_1", "key": "a", "value": "1"}],
                    "memories": [{"id": "mem_1", "content": "正文"}],
                    "exported_at": "2026-11-18T00:00:00.000Z",
                    "truncated": True,
                }
            },
        )
        exported = self.client.persons.export("user-1")
        self.assertTrue(exported.truncated)
        self.assertEqual(exported.memories[0].content, "正文")

        self.fake.route(
            "POST",
            "/v1/partitions/ws-demo/persons/user-1/merge",
            {
                "body": {
                    "person": {"id": "prs_2"},
                    "merged_from": {"id": "prs_1"},
                    "moved_memories": 3,
                    "moved_facts": 1,
                }
            },
        )
        merged = self.client.persons.merge("user-1", "prs_2")
        self.assertEqual(merged.person.id, "prs_2")
        self.assertEqual(merged.moved_memories, 3)
        self.assertEqual(json.loads(self.fake.requests[-1]["body"]), {"target_id": "prs_2"})

    # --- 错误 / 重试 / 网络 --------------------------------------------

    def test_error_mapping(self) -> None:
        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/persons/nobody",
            {
                "status": 404,
                "headers": {"x-request-id": "req_123"},
                "body": {
                    "error": {
                        "code": "NOT_FOUND",
                        "message": "人不存在",
                        "requestId": "req_123",
                    }
                },
            },
        )
        with self.assertRaises(MnemosApiError) as ctx:
            self.client.persons.get("nobody")
        error = ctx.exception
        self.assertEqual(error.status, 404)
        self.assertEqual(error.code, "NOT_FOUND")
        self.assertEqual(error.message, "人不存在")
        self.assertEqual(error.request_id, "req_123")
        self.assertTrue(error.is_not_found)
        self.assertFalse(error.is_retryable)
        self.assertIn("NOT_FOUND", str(error))

    def test_retry_429_then_success(self) -> None:
        client = MnemosClient(
            "mnemos_live_test_key",
            self.fake.base_url,
            partition="ws-demo",
            max_retries=1,
            retry_base_delay=0.0,
        )
        self.fake.route(
            "GET",
            "/v1/partitions/ws-demo/stats",
            {
                "status": 429,
                "headers": {"Retry-After": "0"},
                "body": {"error": {"code": "RATE_LIMITED", "message": "太快了"}},
            },
            {"body": {"partition_id": "ptn_1", "memories_total": 2}},
        )
        stats = client.stats()
        self.assertEqual(stats.memories_total, 2)
        self.assertEqual(len(self.fake.requests), 2)

    def test_network_error_mapped(self) -> None:
        client = MnemosClient(
            "k",
            "http://127.0.0.1:1",
            partition="ws-demo",
            max_retries=0,
            timeout=1.0,
        )
        with self.assertRaises(MnemosNetworkError) as ctx:
            client.stats()
        self.assertNotIsInstance(ctx.exception, MnemosTimeoutError)

    def test_missing_partition_raises_value_error(self) -> None:
        client = MnemosClient("k", self.fake.base_url)
        with self.assertRaises(ValueError):
            client.stats()

    # --- dataclass -----------------------------------------------------

    def test_model_tolerates_unknown_and_missing_fields(self) -> None:
        memory = Memory.from_dict(
            {
                "id": "mem_x",
                "content": "正文",
                "unknown_field": {"a": 1},
                "importance": "0.7",
                "tags": ["a", 1],
                "valid_from": "2026-11-01T00:00:00.000Z",
                "supersedes": "mem_old",
            }
        )
        self.assertEqual(memory.id, "mem_x")
        self.assertEqual(memory.importance, 0.7)
        self.assertEqual(memory.tags, ["a"])
        self.assertEqual(memory.supersedes, "mem_old")
        self.assertEqual(memory.feedback_up, 0)
        self.assertIsNone(memory.valid_to)

        sparse = Memory.from_dict({})
        self.assertEqual(sparse.id, "")
        self.assertEqual(sparse.tags, [])


if __name__ == "__main__":
    unittest.main()
