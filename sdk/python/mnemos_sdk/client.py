"""Mnemos 官方 Python SDK 客户端（零第三方依赖，Python >= 3.9）。

用法::

    from mnemos_sdk import MnemosClient

    client = MnemosClient("mnemos_live_demo_atlas_ci")
    client.memories.add(text="周野偏好中文评审", user_id="u-1")
    hits = client.memories.search("评审偏好", user_id="u-1")
"""

from __future__ import annotations

import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping as ABCMapping
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

from .errors import MnemosApiError
from .types import (
    AddMemoryResponse,
    Agent,
    AgentListResponse,
    Briefing,
    GraphData,
    HealthResponse,
    ImportResult,
    Memory,
    MemoryDetail,
    MemoryHistoryResponse,
    MemoryListResponse,
    MutationResult,
    ProjectExport,
    SearchResponse,
    StatsResponse,
    Task,
    TaskFinishResponse,
    TaskListResponse,
    Webhook,
    WebhookDelivery,
    WebhookDeliveryListResponse,
    WebhookListResponse,
)

SDK_VERSION = "1.0.0"
DEFAULT_BASE_URL = "http://127.0.0.1:4380"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 2

RETRYABLE_STATUS = frozenset({429, 502, 503, 504})
RETRY_BASE_DELAY_MS = 200


JSONBody = Dict[str, Any]
Query = Dict[str, Any]


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


def _compact(data: Mapping[str, Any]) -> JSONBody:
    """去掉 None 字段。"""
    return {key: value for key, value in data.items() if value is not None}


def _query(data: Mapping[str, Any]) -> Query:
    return {key: value for key, value in data.items() if value is not None}


def _quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _as_message_dicts(messages: Optional[Sequence[Mapping[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    if messages is None:
        return None
    return [dict(message) for message in messages]


def _as_str_list(values: Optional[Sequence[str]]) -> Optional[List[str]]:
    if values is None:
        return None
    return [str(value) for value in values]


# ---------------------------------------------------------------------------
# 资源
# ---------------------------------------------------------------------------


class MemoriesResource:
    """记忆：写入 / 检索 / 列表 / 详情 / 更新 / 删除 / 历史 / 反馈。"""

    def __init__(self, client: "MnemosClient") -> None:
        self._client = client

    def add(
        self,
        *,
        messages: Optional[Sequence[Mapping[str, Any]]] = None,
        text: Optional[str] = None,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        run_id: Optional[str] = None,
        app_id: Optional[str] = None,
        task_id: Optional[str] = None,
        visibility: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        infer: Optional[bool] = None,
        mode: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> AddMemoryResponse:
        """写入记忆（``messages`` 与 ``text`` 至少一个）。"""
        if not text and not messages:
            raise ValueError("memories.add: messages 与 text 至少提供一个")
        body = _compact(
            {
                "messages": _as_message_dicts(messages),
                "text": text,
                "user_id": user_id,
                "agent_id": agent_id,
                "run_id": run_id,
                "app_id": app_id,
                "task_id": task_id,
                "visibility": visibility,
                "metadata": dict(metadata) if metadata is not None else None,
                "infer": infer,
                "mode": mode,
            }
        )
        raw = self._client._request("POST", "/v1/memories", body=body, idempotency_key=idempotency_key)
        return AddMemoryResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def search(
        self,
        query: str,
        *,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        run_id: Optional[str] = None,
        app_id: Optional[str] = None,
        written_by_agent_id: Optional[str] = None,
        visibility: Optional[str] = None,
        top_k: Optional[int] = None,
        threshold: Optional[float] = None,
        include_private: Optional[bool] = None,
        filters: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> SearchResponse:
        """混合检索记忆。"""
        body = _compact(
            {
                "query": query,
                "user_id": user_id,
                "agent_id": agent_id,
                "task_id": task_id,
                "run_id": run_id,
                "app_id": app_id,
                "written_by_agent_id": written_by_agent_id,
                "visibility": visibility,
                "top_k": top_k,
                "threshold": threshold,
                "include_private": include_private,
                "filters": self._filters_body(filters),
            }
        )
        raw = self._client._request("POST", "/v1/memories/search", body=body, idempotency_key=idempotency_key)
        return SearchResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    @staticmethod
    def _filters_body(filters: Optional[Mapping[str, Any]]) -> Optional[JSONBody]:
        if filters is None:
            return None

        def pick(*keys: str) -> Any:
            for key in keys:
                value = filters.get(key)
                if value is not None:
                    return value
            return None

        body = _compact(
            {
                "status": filters.get("status"),
                "category": filters.get("category"),
                "tags": _as_str_list(filters.get("tags")),
                "created_after": pick("created_after", "createdAfter"),
                "created_before": pick("created_before", "createdBefore"),
                "min_importance": pick("min_importance", "minImportance"),
                "metadata": filters.get("metadata"),
                "user_id": pick("user_id", "userId"),
                "agent_id": pick("agent_id", "agentId"),
                "run_id": pick("run_id", "runId"),
            }
        )
        return body or None

    def list(
        self,
        *,
        user_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        run_id: Optional[str] = None,
        app_id: Optional[str] = None,
        task_id: Optional[str] = None,
        visibility: Optional[str] = None,
        category: Optional[str] = None,
        page: Optional[int] = None,
        page_size: Optional[int] = None,
    ) -> MemoryListResponse:
        """分页列出记忆。"""
        query = _query(
            {
                "user_id": user_id,
                "agent_id": agent_id,
                "run_id": run_id,
                "app_id": app_id,
                "task_id": task_id,
                "visibility": visibility,
                "category": category,
                "page": page,
                "page_size": page_size,
            }
        )
        raw = self._client._request("GET", "/v1/memories", query=query)
        return MemoryListResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def get(self, memory_id: str) -> MemoryDetail:
        """记忆详情（含历史、实体、关系）。"""
        raw = self._client._request("GET", f"/v1/memories/{_quote(memory_id)}")
        return MemoryDetail.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def update(
        self,
        memory_id: str,
        *,
        text: Optional[str] = None,
        content: Optional[str] = None,
        category: Optional[str] = None,
        importance: Optional[float] = None,
        idempotency_key: Optional[str] = None,
    ) -> MutationResult:
        """更新记忆正文 / 分类 / 重要度。"""
        if not text and not content:
            raise ValueError("memories.update: text 与 content 至少提供一个")
        body = _compact(
            {"text": text, "content": content, "category": category, "importance": importance}
        )
        raw = self._client._request(
            "PUT", f"/v1/memories/{_quote(memory_id)}", body=body, idempotency_key=idempotency_key
        )
        return MutationResult.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def delete(self, memory_id: str, *, idempotency_key: Optional[str] = None) -> MutationResult:
        """软删除单条记忆。"""
        raw = self._client._request(
            "DELETE", f"/v1/memories/{_quote(memory_id)}", idempotency_key=idempotency_key
        )
        return MutationResult.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def history(self, memory_id: str) -> MemoryHistoryResponse:
        """记忆变更历史。"""
        raw = self._client._request("GET", f"/v1/memories/{_quote(memory_id)}/history")
        return MemoryHistoryResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def feedback(
        self, memory_id: str, helpful: bool, *, query: Optional[str] = None, idempotency_key: Optional[str] = None
    ) -> Memory:
        """反馈（调整重要度）。"""
        raw = self._client._request(
            "POST",
            f"/v1/memories/{_quote(memory_id)}/feedback",
            body=_compact({"helpful": helpful, "query": query}),
            idempotency_key=idempotency_key,
        )
        return Memory.from_dict(raw if isinstance(raw, ABCMapping) else {})


class AgentsResource:
    """Agent 注册表。"""

    def __init__(self, client: "MnemosClient") -> None:
        self._client = client

    def list(self) -> AgentListResponse:
        raw = self._client._request("GET", "/v1/agents")
        return AgentListResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def create(
        self,
        name: str,
        *,
        role: Optional[str] = None,
        model: Optional[str] = None,
        description: Optional[str] = None,
        capabilities: Optional[Sequence[str]] = None,
        status: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Agent:
        body = _compact(
            {
                "name": name,
                "role": role,
                "model": model,
                "description": description,
                "capabilities": _as_str_list(capabilities),
                "status": status,
                "metadata": dict(metadata) if metadata is not None else None,
            }
        )
        raw = self._client._request("POST", "/v1/agents", body=body, idempotency_key=idempotency_key)
        return Agent.from_dict(raw if isinstance(raw, ABCMapping) else {})


class TasksResource:
    """任务会话。"""

    def __init__(self, client: "MnemosClient") -> None:
        self._client = client

    def list(
        self,
        *,
        status: Optional[str] = None,
        agent_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> TaskListResponse:
        query = _query({"status": status, "agent_id": agent_id, "limit": limit})
        raw = self._client._request("GET", "/v1/tasks", query=query)
        return TaskListResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def create(
        self,
        title: str,
        *,
        goal: Optional[str] = None,
        owner_agent_id: Optional[str] = None,
        branch: Optional[str] = None,
        status: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Task:
        body = _compact(
            {
                "title": title,
                "goal": goal,
                "owner_agent_id": owner_agent_id,
                "branch": branch,
                "status": status,
            }
        )
        raw = self._client._request("POST", "/v1/tasks", body=body, idempotency_key=idempotency_key)
        return Task.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def get(self, task_id: str) -> Task:
        raw = self._client._request("GET", f"/v1/tasks/{_quote(task_id)}")
        return Task.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def finish(
        self,
        task_id: str,
        *,
        status: Optional[str] = None,
        summary: Optional[str] = None,
        decisions: Optional[Sequence[str]] = None,
        lessons: Optional[Sequence[str]] = None,
        notes: Optional[Sequence[str]] = None,
        agent_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> TaskFinishResponse:
        """结束任务并沉淀决策 / 经验 / 备注。"""
        body = _compact(
            {
                "status": status,
                "summary": summary,
                "decisions": _as_str_list(decisions),
                "lessons": _as_str_list(lessons),
                "notes": _as_str_list(notes),
                "agent_id": agent_id,
            }
        )
        raw = self._client._request(
            "POST", f"/v1/tasks/{_quote(task_id)}/finish", body=body, idempotency_key=idempotency_key
        )
        return TaskFinishResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})


class ContextResource:
    """任务简报。"""

    def __init__(self, client: "MnemosClient") -> None:
        self._client = client

    def build(
        self,
        *,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        query: Optional[str] = None,
        budget_tokens: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Briefing:
        """构建可直接注入 system prompt 的任务简报。"""
        body = _compact(
            {
                "agent_id": agent_id,
                "task_id": task_id,
                "query": query,
                "budget_tokens": budget_tokens,
            }
        )
        raw = self._client._request("POST", "/v1/context", body=body, idempotency_key=idempotency_key)
        return Briefing.from_dict(raw if isinstance(raw, ABCMapping) else {})


class WebhooksResource:
    """Webhook 资源（**beta**：服务端已实现，端点与字段仍可能调整）。"""

    def __init__(self, client: "MnemosClient") -> None:
        self._client = client

    def list(self) -> WebhookListResponse:
        raw = self._client._request("GET", "/v1/webhooks")
        # 服务端 v1 直接返回数组；兼容旧版 {results} 包装。
        if isinstance(raw, list):
            results = [Webhook.from_dict(item) for item in raw if isinstance(item, ABCMapping)]
            return WebhookListResponse(results=results, count=len(results))
        return WebhookListResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def create(
        self,
        name: str,
        url: str,
        *,
        event_types: Optional[Sequence[str]] = None,
        enabled: Optional[bool] = None,
        description: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Webhook:
        body = _compact(
            {
                "name": name,
                "url": url,
                "event_types": _as_str_list(event_types),
                "enabled": enabled,
                "description": description,
            }
        )
        raw = self._client._request("POST", "/v1/webhooks", body=body, idempotency_key=idempotency_key)
        return Webhook.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def update(
        self,
        webhook_id: str,
        *,
        name: Optional[str] = None,
        url: Optional[str] = None,
        event_types: Optional[Sequence[str]] = None,
        enabled: Optional[bool] = None,
        description: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Webhook:
        body = _compact(
            {
                "name": name,
                "url": url,
                "event_types": _as_str_list(event_types),
                "enabled": enabled,
                "description": description,
            }
        )
        raw = self._client._request(
            "PATCH", f"/v1/webhooks/{_quote(webhook_id)}", body=body, idempotency_key=idempotency_key
        )
        return Webhook.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def delete(self, webhook_id: str, *, idempotency_key: Optional[str] = None) -> MutationResult:
        raw = self._client._request(
            "DELETE", f"/v1/webhooks/{_quote(webhook_id)}", idempotency_key=idempotency_key
        )
        return MutationResult.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def rotate_secret(self, webhook_id: str, *, idempotency_key: Optional[str] = None) -> Webhook:
        """轮换签名密钥，返回带明文 ``secret`` 的 Webhook。"""
        raw = self._client._request(
            "POST",
            f"/v1/webhooks/{_quote(webhook_id)}/rotate-secret",
            body={},
            idempotency_key=idempotency_key,
        )
        return Webhook.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def deliveries(
        self,
        webhook_id: str,
        *,
        page: Optional[int] = None,
        page_size: Optional[int] = None,
        limit: Optional[int] = None,
        status: Optional[str] = None,
    ) -> WebhookDeliveryListResponse:
        raw = self._client._request(
            "GET",
            f"/v1/webhooks/{_quote(webhook_id)}/deliveries",
            query=_query(
                {
                    "page": page,
                    "page_size": page_size if page_size is not None else limit,
                    "status": status,
                }
            ),
        )
        return WebhookDeliveryListResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def replay(
        self,
        delivery_id: str,
        legacy_delivery_id: Optional[str] = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> WebhookDelivery:
        """重放一次投递。

        服务端端点为 ``POST /v1/webhook-deliveries/{delivery_id}/replay``，只需要投递 ID；
        为兼容早期签名，也接受 ``replay(webhook_id, delivery_id)``（取第二个参数）。
        """
        target = legacy_delivery_id if legacy_delivery_id is not None else delivery_id
        raw = self._client._request(
            "POST",
            f"/v1/webhook-deliveries/{_quote(target)}/replay",
            body={},
            idempotency_key=idempotency_key,
        )
        return WebhookDelivery.from_dict(raw if isinstance(raw, ABCMapping) else {})


# ---------------------------------------------------------------------------
# 客户端
# ---------------------------------------------------------------------------


class MnemosClient:
    """Mnemos Python 客户端（同步）。"""

    memories: MemoriesResource
    agents: AgentsResource
    tasks: TasksResource
    context: ContextResource
    webhooks: WebhooksResource

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("MnemosClient: api_key 不能为空")
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(f"MnemosClient: base_url 不是合法 URL：{base_url}")
        if timeout <= 0:
            raise ValueError("MnemosClient: timeout 必须为正数")
        if max_retries < 0:
            raise ValueError("MnemosClient: max_retries 必须为非负整数")

        self._api_key = api_key.strip()
        self._base_url = base_url.rstrip("/")
        self._timeout = float(timeout)
        self._max_retries = int(max_retries)

        self.memories = MemoriesResource(self)
        self.agents = AgentsResource(self)
        self.tasks = TasksResource(self)
        self.context = ContextResource(self)
        self.webhooks = WebhooksResource(self)

    # -- 传输层 ---------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Any] = None,
        query: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        url = self._build_url(path, query)
        headers: Dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "X-Mnemos-SDK": f"python/{SDK_VERSION}",
        }
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        can_retry = self._can_retry(method, path, idempotency_key)
        last_error: Optional[MnemosApiError] = None

        for attempt in range(self._max_retries + 1):
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            retryable = False
            delay_ms: Optional[int] = None

            try:
                with urllib.request.urlopen(request, timeout=self._timeout) as response:
                    return self._decode_success(response.read(), getattr(response, "status", 200))
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                last_error = self._decode_error(exc.code, raw, exc.headers)
                retryable = exc.code in RETRYABLE_STATUS
                delay_ms = last_error.retry_after_ms
            except (TimeoutError, socket.timeout) as exc:
                last_error = MnemosApiError(
                    f"请求超时（>{self._timeout:g}s）",
                    status=0,
                    code="timeout",
                    details={"name": type(exc).__name__},
                )
                retryable = True
            except urllib.error.URLError as exc:
                reason = exc.reason
                if isinstance(reason, (TimeoutError, socket.timeout)):
                    last_error = MnemosApiError(
                        f"请求超时（>{self._timeout:g}s）",
                        status=0,
                        code="timeout",
                        details={"name": type(reason).__name__},
                    )
                else:
                    last_error = MnemosApiError(
                        "网络请求失败", status=0, code="network_error", details={"reason": str(reason)}
                    )
                retryable = True
            except OSError as exc:
                last_error = MnemosApiError(
                    "网络请求失败", status=0, code="network_error", details={"name": type(exc).__name__}
                )
                retryable = True

            if not retryable or not can_retry or attempt >= self._max_retries:
                if last_error is not None:
                    raise last_error
                raise MnemosApiError("请求失败", status=0, code="unknown_error")

            wait_ms = delay_ms if delay_ms is not None else self._backoff_delay_ms(attempt)
            time.sleep(wait_ms / 1000.0)

        if last_error is not None:
            raise last_error
        raise MnemosApiError("请求失败", status=0, code="unknown_error")

    def _build_url(self, path: str, query: Optional[Mapping[str, Any]]) -> str:
        suffix = path if path.startswith("/") else f"/{path}"
        url = f"{self._base_url}{suffix}"
        if not query:
            return url
        filtered = [(key, value) for key, value in query.items() if value is not None]
        if not filtered:
            return url
        return f"{url}?{urllib.parse.urlencode(filtered, doseq=True)}"

    def _decode_success(self, raw: bytes, status: int) -> Any:
        text = raw.decode("utf-8", errors="replace")
        if not text.strip():
            raise MnemosApiError("响应为空，期望 JSON", status=status, code="invalid_response")
        try:
            return json.loads(text)
        except ValueError:
            raise MnemosApiError(
                "响应不是合法 JSON",
                status=status,
                code="invalid_response",
                details={"body": text[:200]},
            )

    def _decode_error(self, status: int, raw: bytes, headers: Any) -> MnemosApiError:
        payload: Any = {}
        text = raw.decode("utf-8", errors="replace")
        if text.strip():
            try:
                payload = json.loads(text)
            except ValueError:
                payload = {}
        error = payload.get("error") if isinstance(payload, ABCMapping) else None
        if not isinstance(error, ABCMapping):
            error = {}

        request_id = error.get("requestId") or error.get("request_id")
        if not isinstance(request_id, str):
            request_id = headers.get("x-request-id") if headers is not None else None
        if not isinstance(request_id, str):
            request_id = None

        code = error.get("code")
        if not isinstance(code, str) or not code:
            code = f"http_{status}"
        message = error.get("message")
        if not isinstance(message, str) or not message:
            message = f"Mnemos API 请求失败（HTTP {status}）"

        retry_after = headers.get("Retry-After") if headers is not None else None
        return MnemosApiError(
            message,
            status=status,
            code=code,
            request_id=request_id,
            details=error.get("details"),
            retry_after_ms=self._parse_retry_after(retry_after),
        )

    @staticmethod
    def _parse_retry_after(value: Optional[str]) -> Optional[int]:
        if not value:
            return None
        text = value.strip()
        if not text:
            return None
        try:
            seconds = float(text)
            return max(0, int(seconds * 1000))
        except ValueError:
            pass
        try:
            parsed = parsedate_to_datetime(text)
        except (TypeError, ValueError, OverflowError):
            return None
        if parsed is None:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        delta = (parsed - datetime.now(timezone.utc)).total_seconds()
        return max(0, int(delta * 1000))

    @staticmethod
    def _backoff_delay_ms(attempt: int) -> float:
        base = RETRY_BASE_DELAY_MS * (2**attempt)
        return base * (1 + random.random() * 0.5)

    @staticmethod
    def _can_retry(method: str, path: str, idempotency_key: Optional[str]) -> bool:
        if method == "GET":
            return True
        if method == "POST":
            return bool(idempotency_key) or path == "/v1/memories/search"
        return method in ("PUT", "PATCH", "DELETE")

    # -- 顶层接口 -------------------------------------------------------

    def graph(self, limit: Optional[int] = 120, *, user_id: Optional[str] = None) -> GraphData:
        """实体关系图谱。"""
        raw = self._request("GET", "/v1/graph", query=_query({"limit": limit, "user_id": user_id}))
        return GraphData.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def stats(self) -> StatsResponse:
        """项目指标。"""
        raw = self._request("GET", "/v1/stats")
        return StatsResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def health(self) -> HealthResponse:
        """健康检查（无需 API Key）。"""
        raw = self._request("GET", "/v1/health")
        return HealthResponse.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def export(self) -> ProjectExport:
        """导出项目（``mnemos-export/v1``，已归一化为 snake_case 模型）。"""
        raw = self._request("GET", "/v1/export")
        return ProjectExport.from_dict(raw if isinstance(raw, ABCMapping) else {})

    def import_memories(self, document: Union[ProjectExport, Mapping[str, Any]]) -> ImportResult:
        """导入记忆（≤1000 条/次）。

        入参可以是 :meth:`export` 返回的文档，也可以是 ``{"memories": [...]}``；
        前者会自动转换回服务端导入格式。
        """
        if isinstance(document, ProjectExport):
            body: Dict[str, Any] = {
                "format": document.format,
                "memories": [self._export_memory_item(memory) for memory in document.memories],
            }
        elif isinstance(document, ABCMapping):
            body = dict(document)
        else:
            raise TypeError("import_memories: 需要 ProjectExport 或 {memories: [...]} 字典")

        raw = self._request("POST", "/v1/import", body=body)
        return ImportResult.from_dict(raw if isinstance(raw, ABCMapping) else {})

    # ``import`` 是 Python 关键字，提供 ``import_`` 别名。
    import_ = import_memories

    @staticmethod
    def _export_memory_item(memory: Memory) -> Dict[str, Any]:
        item: Dict[str, Any] = {
            "content": memory.content,
            "visibility": memory.visibility,
            "tags": list(memory.tags),
            "metadata": dict(memory.metadata),
        }
        if memory.user_id:
            item["userId"] = memory.user_id
        if memory.agent_id:
            item["agentId"] = memory.agent_id
        if memory.run_id:
            item["runId"] = memory.run_id
        if memory.app_id:
            item["appId"] = memory.app_id
        if memory.task_id:
            item["taskId"] = memory.task_id
        return item
