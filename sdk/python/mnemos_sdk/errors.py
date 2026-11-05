"""错误类型。"""

from __future__ import annotations

from typing import Any, Optional


class MnemosApiError(Exception):
    """Mnemos API 错误。

    - 服务端返回非 2xx：``status`` 为 HTTP 状态，``code`` 为错误体里的稳定标识；
    - 网络错误：``status = 0``、``code = "network_error"``；
    - 超时：``status = 0``、``code = "timeout"``。
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: str,
        request_id: Optional[str] = None,
        details: Any = None,
        retry_after_ms: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.request_id = request_id
        self.details = details
        self.retry_after_ms = retry_after_ms

    def __repr__(self) -> str:
        return (
            "MnemosApiError("
            f"status={self.status!r}, code={self.code!r}, "
            f"message={self.message!r}, request_id={self.request_id!r})"
        )
