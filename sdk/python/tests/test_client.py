"""Python SDK 测试：本地 http.server mock（随机端口）。

运行：python3 -m unittest discover -s sdk/python/tests -v
覆盖：鉴权头、请求体、查询参数、错误映射、幂等键、429/5xx 重试、
       Retry-After、超时、非幂等 POST 不重试、导出/导入、webhook（beta）。
"""

from __future__ import annotations

import json
import sys
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mnemos_sdk import MnemosApiError, MnemosClient

HandlerFunc = Callable[[Dict[str, Any], BaseHTTPRequestHandler], None]


class MockHandler(BaseHTTPRequestHandler):
    """记录请求并交给测试注册的 handler。"""

    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # 覆盖基类签名，保持测试输出干净
        return

    def _dispatch(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        record = {
            "method": self.command,
            "path": self.path,
            "headers": {key: value for key, value in self.headers.items()},
            "body": raw.decode("utf-8"),
        }
        server = self.server
        requests: List[Dict[str, Any]] = server.requests
        requests.append(record)
        handler: HandlerFunc = server.handler
        handler(record, self)

    do_GET = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_PATCH = _dispatch
    do_DELETE = _dispatch


def send_json(
    handler: BaseHTTPRequestHandler,
    status: int,
    payload: Any,
    headers: Optional[Dict[str, str]] = None,
) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass


class MockServer:
    """随机端口的 mock 服务。"""

    def __init__(self, handler: HandlerFunc) -> None:
        self.requests: List[Dict[str, Any]] = []
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        self._httpd.daemon_threads = True
        self._httpd.requests = self.requests
        self._httpd.handler = handler
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "MockServer":
        self._thread.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2)


MEMORY_FIXTURE: Dict[str, Any] = {
    "id": "mem_1",
    "projectId": "prj_atlas",
    "userId": "u-1",
    "agentId": "agent-1",
    "taskId": None,
    "visibility": "project",
    "content": "周野偏好用中文写评审意见。",
    "category": "preference",
    "importance": 0.7,
    "confidence": 0.9,
    "source": "api",
    "status": "active",
    "tags": ["偏好"],
    "metadata": {"channel": "test"},
    "createdAt": "2026-11-05T10:00:00.000Z",
    "updatedAt": "2026-11-05T10:00:00.000Z",
    "accessCount": 2,
}


def make_client(server: MockServer, **overrides: Any) -> MnemosClient:
    params: Dict[str, Any] = {
        "api_key": "mnemos_live_demo_atlas_ci",
        "base_url": server.base_url,
    }
    params.update(overrides)
    return MnemosClient(**params)


class TestMemories(unittest.TestCase):
    """写入 / 列表 / 检索 / 错误 / 幂等 / 重试 / 超时。"""

    def test_add_sends_bearer_and_normalizes_camel_case(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            send_json(
                response,
                200,
                {
                    "results": [MEMORY_FIXTURE],
                    "events": [
                        {
                            "type": "ADD",
                            "memoryId": "mem_1",
                            "content": MEMORY_FIXTURE["content"],
                            "at": "2026-11-05T10:00:00.000Z",
                        }
                    ],
                    "tookMs": 3,
                },
            )

        with MockServer(handler) as server:
            client = make_client(server)
            result = client.memories.add(
                text=MEMORY_FIXTURE["content"],
                user_id="u-1",
                agent_id="agent-1",
                metadata={"channel": "test"},
                infer=False,
            )

            self.assertEqual(len(server.requests), 1)
            request = server.requests[0]
            self.assertEqual(request["method"], "POST")
            self.assertEqual(request["path"], "/v1/memories")
            self.assertEqual(request["headers"].get("Authorization"), "Bearer mnemos_live_demo_atlas_ci")
            self.assertIn("application/json", request["headers"].get("Content-Type", ""))
            self.assertEqual(
                json.loads(request["body"]),
                {
                    "text": MEMORY_FIXTURE["content"],
                    "user_id": "u-1",
                    "agent_id": "agent-1",
                    "metadata": {"channel": "test"},
                    "infer": False,
                },
            )

            self.assertEqual(result.took_ms, 3.0)
            self.assertEqual(result.results[0].id, "mem_1")
            self.assertEqual(result.results[0].content, MEMORY_FIXTURE["content"])
            self.assertEqual(result.results[0].memory, MEMORY_FIXTURE["content"])
            self.assertEqual(result.results[0].user_id, "u-1")
            self.assertEqual(result.results[0].created_at, MEMORY_FIXTURE["createdAt"])
            self.assertEqual(result.results[0].access_count, 2)
            self.assertEqual(result.events[0].memory_id, "mem_1")

    def test_list_builds_query_parameters(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            send_json(response, 200, {"results": [MEMORY_FIXTURE], "count": 1, "page": 2, "page_size": 50})

        with MockServer(handler) as server:
            client = make_client(server)
            result = client.memories.list(user_id="用户 1", page=2, page_size=50, visibility="project")

            parsed = urllib.parse.urlparse(server.requests[0]["path"])
            query = urllib.parse.parse_qs(parsed.query)
            self.assertEqual(parsed.path, "/v1/memories")
            self.assertEqual(query["user_id"], ["用户 1"])
            self.assertEqual(query["page"], ["2"])
            self.assertEqual(query["page_size"], ["50"])
            self.assertEqual(query["visibility"], ["project"])
            self.assertNotIn("agent_id", query)
            self.assertEqual(result.count, 1)
            self.assertEqual(result.page_size, 50)

    def test_search_body_and_hit_normalization(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            hit = dict(MEMORY_FIXTURE)
            hit.pop("content")
            hit.update(
                {
                    "memory": MEMORY_FIXTURE["content"],
                    "score": 0.73,
                    "signals": {
                        "semantic": 0.68,
                        "keyword": 0.52,
                        "entity": 0.4,
                        "recency": 0.81,
                        "importance": 0.74,
                    },
                    "matched_on": ["semantic", "keyword"],
                    "entities": ["周野"],
                }
            )
            send_json(
                response,
                200,
                {"results": [hit], "total": 1, "took_ms": 6, "signals": {"strategy": "hybrid"}},
            )

        with MockServer(handler) as server:
            client = make_client(server)
            result = client.memories.search(
                "评审偏好",
                agent_id="agent-1",
                task_id="task-1",
                top_k=5,
                threshold=0.2,
                include_private=False,
                filters={"category": "preference", "createdAfter": "2026-01-01T00:00:00.000Z", "minImportance": 0.3},
            )

            body = json.loads(server.requests[0]["body"])
            self.assertEqual(
                body,
                {
                    "query": "评审偏好",
                    "agent_id": "agent-1",
                    "task_id": "task-1",
                    "top_k": 5,
                    "threshold": 0.2,
                    "include_private": False,
                    "filters": {
                        "category": "preference",
                        "created_after": "2026-01-01T00:00:00.000Z",
                        "min_importance": 0.3,
                    },
                },
            )
            self.assertEqual(result.results[0].content, MEMORY_FIXTURE["content"])
            self.assertEqual(result.results[0].score, 0.73)
            self.assertEqual(result.results[0].matched_on, ["semantic", "keyword"])
            self.assertEqual(result.results[0].signals["keyword"], 0.52)
            self.assertEqual(result.took_ms, 6.0)

    def test_error_mapping_and_request_id_fallback(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            if record["path"].endswith("/bad"):
                send_json(
                    response,
                    400,
                    {
                        "error": {
                            "code": "validation_error",
                            "message": "参数不合法",
                            "details": [{"path": "query", "message": "不能为空"}],
                            "requestId": "req_body",
                        }
                    },
                )
                return
            send_json(
                response,
                404,
                {"error": {"code": "not_found", "message": "记忆不存在"}},
                {"x-request-id": "req_header"},
            )

        with MockServer(handler) as server:
            client = make_client(server)
            with self.assertRaises(MnemosApiError) as ctx:
                client.memories.get("bad")
            error = ctx.exception
            self.assertEqual(error.status, 400)
            self.assertEqual(error.code, "validation_error")
            self.assertEqual(error.message, "参数不合法")
            self.assertEqual(error.request_id, "req_body")
            self.assertEqual(error.details, [{"path": "query", "message": "不能为空"}])

            with self.assertRaises(MnemosApiError) as ctx2:
                client.memories.get("missing")
            self.assertEqual(ctx2.exception.status, 404)
            self.assertEqual(ctx2.exception.request_id, "req_header")

    def test_idempotency_key_is_explicit(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            send_json(response, 200, {"results": [MEMORY_FIXTURE], "events": [], "tookMs": 1})

        with MockServer(handler) as server:
            client = make_client(server)
            client.memories.add(text="有幂等键", idempotency_key="idem-key-12345678")
            client.memories.add(text="无幂等键")

            self.assertEqual(server.requests[0]["headers"].get("Idempotency-Key"), "idem-key-12345678")
            self.assertNotIn("Idempotency-Key", server.requests[1]["headers"])

    def test_429_retry_respects_retry_after(self) -> None:
        attempts = {"count": 0}

        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            attempts["count"] += 1
            if attempts["count"] == 1:
                send_json(
                    response,
                    429,
                    {"error": {"code": "rate_limited", "message": "请求过于频繁"}},
                    {"Retry-After": "1"},
                )
                return
            send_json(response, 200, {"results": [MEMORY_FIXTURE], "count": 1, "page": 1, "page_size": 20})

        with MockServer(handler) as server:
            client = make_client(server, max_retries=2)
            with mock.patch("time.sleep") as sleeper:
                result = client.memories.list()

            self.assertEqual(attempts["count"], 2)
            sleeper.assert_called_once()
            self.assertAlmostEqual(float(sleeper.call_args[0][0]), 1.0, places=3)
            self.assertEqual(result.results[0].id, "mem_1")

    def test_get_retries_on_503_then_succeeds(self) -> None:
        attempts = {"count": 0}

        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            attempts["count"] += 1
            if attempts["count"] == 1:
                send_json(response, 503, {"error": {"code": "service_unavailable", "message": "稍后重试"}})
                return
            send_json(response, 200, {"metrics": {"total_memories": 3}})

        with MockServer(handler) as server:
            client = make_client(server, max_retries=1)
            with mock.patch("time.sleep") as sleeper:
                stats = client.stats()

            self.assertEqual(attempts["count"], 2)
            sleeper.assert_called_once()
            self.assertGreater(float(sleeper.call_args[0][0]), 0.0)
            self.assertEqual(stats.metrics.total_memories, 3)

    def test_non_idempotent_post_not_retried_without_key(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            send_json(response, 503, {"error": {"code": "service_unavailable", "message": "稍后重试"}})

        with MockServer(handler) as server:
            client = make_client(server, max_retries=2)
            with mock.patch("time.sleep"):
                with self.assertRaises(MnemosApiError) as ctx:
                    client.tasks.create("拆分查询服务")
                self.assertEqual(ctx.exception.status, 503)
                self.assertEqual(len(server.requests), 1, "无幂等键的 POST 不应重试")

                with self.assertRaises(MnemosApiError):
                    client.tasks.create("拆分查询服务", idempotency_key="idem-task-0001")

            retried = server.requests[1:]
            self.assertEqual(len(retried), 3, "带幂等键应重试到 max_retries")
            for request in retried:
                self.assertEqual(request["headers"].get("Idempotency-Key"), "idem-task-0001")

    def test_timeout_raises_code_timeout(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            time.sleep(0.3)
            if response.wfile is not None:
                send_json(response, 200, {"results": [], "count": 0, "page": 1, "page_size": 20})

        with MockServer(handler) as server:
            client = make_client(server, timeout=0.05, max_retries=0)
            with self.assertRaises(MnemosApiError) as ctx:
                client.memories.list()

            self.assertEqual(ctx.exception.status, 0)
            self.assertEqual(ctx.exception.code, "timeout")


class TestAgentNative(unittest.TestCase):
    """任务结束 / 简报 / 导出导入 / webhook。"""

    def test_task_finish_and_context_build(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            if record["path"] == "/v1/tasks/task-1/finish":
                send_json(
                    response,
                    200,
                    {
                        "task": {
                            "id": "task-1",
                            "project_id": "prj_atlas",
                            "title": "拆分查询服务",
                            "goal": "完成首期",
                            "status": "done",
                            "metadata": {},
                            "created_at": "2026-11-05T09:00:00.000Z",
                            "started_at": "2026-11-05T09:00:00.000Z",
                            "memory_count": 2,
                            "agent_count": 1,
                        },
                        "memories": [
                            {
                                "id": "mem_2",
                                "memory": "查询走只读副本。",
                                "visibility": "project",
                                "category": "fact",
                                "importance": 0.8,
                                "confidence": 0.9,
                                "source": "agent",
                                "status": "active",
                                "tags": [],
                                "metadata": {},
                                "created_at": "2026-11-05T10:00:00.000Z",
                                "updated_at": "2026-11-05T10:00:00.000Z",
                                "access_count": 0,
                            }
                        ],
                    },
                )
                return
            send_json(
                response,
                200,
                {
                    "project": {"id": "prj_atlas", "name": "Atlas", "description": "研发助手"},
                    "agent": None,
                    "task": None,
                    "sections": [{"key": "project", "title": "项目背景", "description": "项目描述", "hits": []}],
                    "prompt": "# 项目背景\n",
                    "tokenEstimate": 128,
                    "citations": ["mem_2"],
                    "builtAt": "2026-11-05T10:00:00.000Z",
                    "tookMs": 12,
                },
            )

        with MockServer(handler) as server:
            client = make_client(server)
            finished = client.tasks.finish(
                "task-1",
                summary="完成首期",
                decisions=["查询走只读副本"],
                agent_id="agent-1",
                idempotency_key="idem-finish-0001",
            )
            self.assertEqual(
                json.loads(server.requests[0]["body"]),
                {"summary": "完成首期", "decisions": ["查询走只读副本"], "agent_id": "agent-1"},
            )
            self.assertEqual(finished.task.status, "done")
            self.assertEqual(finished.task.memory_count, 2)
            self.assertEqual(finished.memories[0].content, "查询走只读副本。")

            briefing = client.context.build(agent_id="agent-1", task_id="task-1", budget_tokens=500)
            self.assertEqual(
                json.loads(server.requests[1]["body"]),
                {"agent_id": "agent-1", "task_id": "task-1", "budget_tokens": 500},
            )
            self.assertEqual(briefing.token_estimate, 128)
            self.assertEqual(briefing.built_at, "2026-11-05T10:00:00.000Z")
            self.assertEqual(briefing.sections[0].key, "project")
            self.assertIsNone(briefing.agent)

    def test_export_import_roundtrip(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            if record["method"] == "GET" and record["path"] == "/v1/export":
                send_json(
                    response,
                    200,
                    {
                        "format": "mnemos-export/v1",
                        "exportedAt": "2026-11-05T10:00:00.000Z",
                        "project": {"id": "prj_atlas", "slug": "atlas-copilot", "name": "Atlas"},
                        "agents": [],
                        "tasks": [],
                        "memories": [MEMORY_FIXTURE],
                    },
                )
                return
            send_json(response, 200, {"imported": 1, "skipped": 0, "failed": 0, "errors": []})

        with MockServer(handler) as server:
            client = make_client(server)
            document = client.export()
            self.assertEqual(document.exported_at, "2026-11-05T10:00:00.000Z")
            self.assertEqual(document.memories[0].content, MEMORY_FIXTURE["content"])

            result = client.import_memories(document)
            self.assertEqual(result.imported, 1)
            body = json.loads(server.requests[1]["body"])
            self.assertEqual(body["format"], "mnemos-export/v1")
            self.assertEqual(
                body["memories"],
                [
                    {
                        "content": MEMORY_FIXTURE["content"],
                        "visibility": "project",
                        "tags": ["偏好"],
                        "metadata": {"channel": "test"},
                        "userId": "u-1",
                        "agentId": "agent-1",
                    }
                ],
            )

    def test_webhook_beta_paths(self) -> None:
        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            if record["method"] == "GET" and record["path"] == "/v1/webhooks":
                send_json(
                    response,
                    200,
                    [
                        {
                            "id": "wh_1",
                            "project_id": "prj_atlas",
                            "name": "CI 回调",
                            "url": "https://ci.example.com/hook",
                            "event_types": ["memory.created"],
                            "enabled": True,
                            "description": "",
                            "created_by": None,
                            "created_at": "2026-11-05T10:00:00.000Z",
                            "updated_at": "2026-11-05T10:00:00.000Z",
                            "last_delivery_at": None,
                            "last_status": None,
                            "failure_count": 0,
                            "disabled_at": None,
                        }
                    ],
                )
                return
            if record["path"] == "/v1/webhooks/wh_1/rotate-secret":
                send_json(
                    response,
                    200,
                    {
                        "id": "wh_1",
                        "project_id": "prj_atlas",
                        "name": "CI 回调",
                        "url": "https://ci.example.com/hook",
                        "secret": "whsec_rotated",
                        "event_types": ["memory.created"],
                        "enabled": True,
                        "description": "",
                        "created_by": None,
                        "created_at": "2026-11-05T10:00:00.000Z",
                        "updated_at": "2026-11-05T11:00:00.000Z",
                        "last_delivery_at": None,
                        "last_status": None,
                        "failure_count": 0,
                        "disabled_at": None,
                    },
                )
                return
            if record["path"] == "/v1/webhook-deliveries/del_1/replay":
                send_json(
                    response,
                    200,
                    {
                        "id": "del_1",
                        "webhook_id": "wh_1",
                        "project_id": "prj_atlas",
                        "event_type": "memory.created",
                        "event_id": "evt_1",
                        "status": "pending",
                        "attempts": 0,
                        "max_attempts": 6,
                        "next_attempt_at": None,
                        "response_status": None,
                        "response_body": None,
                        "latency_ms": None,
                        "error": None,
                        "created_at": "2026-11-05T10:00:00.000Z",
                        "delivered_at": None,
                    },
                )
                return
            send_json(
                response,
                200,
                {
                    "items": [
                        {
                            "id": "del_1",
                            "webhook_id": "wh_1",
                            "project_id": "prj_atlas",
                            "event_type": "memory.created",
                            "event_id": "evt_1",
                            "status": "failed",
                            "attempts": 3,
                            "max_attempts": 6,
                            "next_attempt_at": None,
                            "response_status": 500,
                            "response_body": "boom",
                            "latency_ms": 120,
                            "error": "HTTP 500",
                            "created_at": "2026-11-05T10:00:00.000Z",
                            "delivered_at": None,
                        }
                    ],
                    "page": 1,
                    "page_size": 5,
                    "total": 1,
                    "total_pages": 1,
                },
            )

        with MockServer(handler) as server:
            client = make_client(server)
            listed = client.webhooks.list()
            self.assertEqual(listed.count, 1)
            self.assertEqual(listed.results[0].event_types, ["memory.created"])

            rotated = client.webhooks.rotate_secret("wh_1")
            self.assertEqual(rotated.secret, "whsec_rotated")
            self.assertEqual(server.requests[1]["method"], "POST")
            self.assertEqual(server.requests[1]["path"], "/v1/webhooks/wh_1/rotate-secret")

            deliveries = client.webhooks.deliveries("wh_1", page=1, page_size=5, status="failed")
            self.assertEqual(deliveries.items[0].status, "failed")
            self.assertEqual(deliveries.items[0].attempts, 3)
            self.assertEqual(deliveries.items[0].max_attempts, 6)
            self.assertEqual(deliveries.items[0].response_status, 500)
            self.assertEqual(deliveries.total_pages, 1)
            parsed = urllib.parse.urlparse(server.requests[2]["path"])
            self.assertEqual(urllib.parse.parse_qs(parsed.query)["page_size"], ["5"])

            replayed = client.webhooks.replay("del_1")
            self.assertEqual(replayed.status, "pending")
            self.assertEqual(server.requests[3]["path"], "/v1/webhook-deliveries/del_1/replay")


if __name__ == "__main__":
    unittest.main()


class TestDetailsAndAgents(unittest.TestCase):
    """详情 / 历史 / 反馈与 Agent 注册表。"""

    def test_memory_detail_history_feedback_and_agents(self) -> None:
        agent_fixture = {
            "id": "agent-1",
            "project_id": "prj_atlas",
            "name": "开发 Agent",
            "role": "assistant",
            "model": "deepseek-chat",
            "description": "",
            "capabilities": ["code-review"],
            "status": "active",
            "metadata": {},
            "created_at": "2026-06-20T00:00:00.000Z",
            "last_active_at": None,
            "stats": {"memories": 2, "private_memories": 1, "tasks": 1, "last_task_at": None},
        }

        def handler(record: Dict[str, Any], response: BaseHTTPRequestHandler) -> None:
            path = record["path"]
            if path == "/v1/memories/mem_1":
                detail = dict(MEMORY_FIXTURE)
                detail.pop("content")
                detail.update(
                    {
                        "memory": MEMORY_FIXTURE["content"],
                        "history": [
                            {
                                "id": "hist_1",
                                "memory_id": "mem_1",
                                "event": "UPDATE",
                                "old_memory": "旧正文",
                                "new_memory": MEMORY_FIXTURE["content"],
                                "actor": "api_key:key_1",
                                "reason": None,
                                "created_at": "2026-11-05T10:00:00.000Z",
                                "meta": {},
                            }
                        ],
                        "entities": [{"id": "ent_1", "name": "周野", "type": "person", "mention_count": 3}],
                        "relations": [],
                        "neighbors": [],
                    }
                )
                send_json(response, 200, detail)
                return
            if path == "/v1/memories/mem_1/history":
                send_json(
                    response,
                    200,
                    {
                        "results": [
                            {
                                "id": "hist_2",
                                "memory_id": "mem_1",
                                "event": "ADD",
                                "old_memory": None,
                                "new_memory": "初始正文",
                                "actor": "system",
                                "reason": "seed",
                                "created_at": "2026-11-04T10:00:00.000Z",
                                "meta": {"channel": "seed"},
                            }
                        ]
                    },
                )
                return
            if path == "/v1/memories/mem_1/feedback":
                send_json(response, 200, {**MEMORY_FIXTURE, "importance": 0.9})
                return
            if path == "/v1/agents" and record["method"] == "GET":
                send_json(response, 200, {"results": [agent_fixture], "count": 1})
                return
            if path == "/v1/agents" and record["method"] == "POST":
                send_json(response, 200, agent_fixture)
                return
            send_json(response, 404, {"error": {"code": "not_found", "message": "未实现"}})

        with MockServer(handler) as server:
            client = make_client(server)

            detail = client.memories.get("mem_1")
            self.assertEqual(detail.content, MEMORY_FIXTURE["content"])
            self.assertEqual(detail.history[0].old_content, "旧正文")
            self.assertEqual(detail.history[0].new_content, MEMORY_FIXTURE["content"])
            self.assertEqual(detail.entities[0].mention_count, 3)

            history = client.memories.history("mem_1")
            self.assertEqual(history.results[0].event, "ADD")
            self.assertEqual(history.results[0].new_content, "初始正文")
            self.assertEqual(history.results[0].reason, "seed")

            feedback = client.memories.feedback("mem_1", helpful=True, query="评审")
            self.assertEqual(feedback.importance, 0.9)
            self.assertEqual(json.loads(server.requests[2]["body"]), {"helpful": True, "query": "评审"})

            agents = client.agents.list()
            self.assertEqual(agents.count, 1)
            self.assertEqual(agents.results[0].stats.private_memories, 1)
            self.assertEqual(agents.results[0].capabilities, ["code-review"])

            created = client.agents.create("开发 Agent", capabilities=["code-review"])
            self.assertEqual(created.id, "agent-1")
            self.assertEqual(
                json.loads(server.requests[4]["body"]),
                {"name": "开发 Agent", "capabilities": ["code-review"]},
            )
