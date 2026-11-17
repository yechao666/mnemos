"""Mnemos Python SDK 错误类型。

服务端错误统一形如::

    {"error": {"code": "NOT_FOUND", "message": "人不存在", "requestId": "req_…"}}

SDK 把它映射为 :class:`MnemosApiError`（保留 HTTP 状态码、稳定 ``code``、
``request_id`` 与 ``details``）。网络/超时错误分别映射为
:class:`MnemosNetworkError` / :class:`MnemosTimeoutError`。

判断逻辑请用 ``code``（稳定英文标识），不要匹配 ``message``。
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional


class MnemosError(Exception):
    """SDK 所有错误的基类。"""


class MnemosNetworkError(MnemosError):
    """连接失败、DNS 失败、连接被重置等传输层错误。"""

    def __init__(self, message: str, *, url: Optional[str] = None, cause: Optional[BaseException] = None) -> None:
        super().__init__(message)
        self.url = url
        self.cause = cause


class MnemosTimeoutError(MnemosNetworkError):
    """请求超时（``socket.timeout`` / ``TimeoutError``）。"""


class MnemosApiError(MnemosError):
    """服务端返回的非 2xx 响应。

    属性
    ----
    status:
        HTTP 状态码（网络错误时为 ``None``）。
    code:
        稳定错误码，如 ``NOT_FOUND`` / ``VALIDATION`` / ``RATE_LIMITED``。
    message:
        可直接展示的中文消息。
    request_id:
        服务端 ``x-request-id`` / 错误体 ``requestId``，用于查日志。
    details:
        可选的结构化细节（zod 校验详情、配额重试秒数等）。
    retry_after:
        429/503 的 ``Retry-After``（秒）。
    payload:
        原始错误响应体。
    """

    def __init__(
        self,
        status: Optional[int],
        code: str = "HTTP_ERROR",
        message: str = "",
        *,
        request_id: Optional[str] = None,
        details: Any = None,
        retry_after: Optional[float] = None,
        payload: Optional[Mapping[str, Any]] = None,
        cause: Optional[BaseException] = None,
    ) -> None:
        text = message or code
        super().__init__(text)
        self.status = status
        self.code = code
        self.message = text
        self.request_id = request_id
        self.details = details
        self.retry_after = retry_after
        self.payload: Dict[str, Any] = dict(payload) if isinstance(payload, Mapping) else {}
        self.cause = cause

    # --- 常用分类，便于调用方按类别处理 -------------------------------

    @property
    def is_not_found(self) -> bool:
        return self.status == 404 or self.code == "NOT_FOUND"

    @property
    def is_auth_error(self) -> bool:
        return self.status in (401, 403) or self.code in {
            "UNAUTHORIZED",
            "INVALID_API_KEY",
            "API_KEY_REVOKED",
            "KEY_EXPIRED",
            "FORBIDDEN",
            "IP_NOT_ALLOWED",
        }

    @property
    def is_rate_limited(self) -> bool:
        return self.status == 429 or self.code == "RATE_LIMITED"

    @property
    def is_retryable(self) -> bool:
        return self.status in {429, 500, 502, 503, 504}

    @classmethod
    def from_payload(
        cls,
        status: Optional[int],
        payload: Any,
        *,
        request_id: Optional[str] = None,
        retry_after: Optional[float] = None,
        fallback_message: str = "",
    ) -> "MnemosApiError":
        """从 ``{"error": {...}}`` 响应体构造异常（兼容非标准体）。"""
        raw: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}
        error = raw.get("error") if isinstance(raw.get("error"), Mapping) else raw
        code = error.get("code") if isinstance(error, Mapping) else None
        message = error.get("message") if isinstance(error, Mapping) else None
        req = error.get("requestId") if isinstance(error, Mapping) else None
        details = error.get("details") if isinstance(error, Mapping) else None
        return cls(
            status,
            code=code if isinstance(code, str) and code else f"HTTP_{status or 'ERROR'}",
            message=message if isinstance(message, str) and message else fallback_message,
            request_id=(req if isinstance(req, str) else None) or request_id,
            details=details,
            retry_after=retry_after,
            payload=raw,
        )

    def __str__(self) -> str:
        prefix = f"{self.status} " if self.status is not None else ""
        suffix = f" (request_id={self.request_id})" if self.request_id else ""
        return f"{prefix}{self.code}: {self.message}{suffix}"


__all__ = [
    "MnemosError",
    "MnemosApiError",
    "MnemosNetworkError",
    "MnemosTimeoutError",
]
