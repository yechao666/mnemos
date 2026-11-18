"""Mnemos v6.1 Python 客户端（标准库 ``urllib`` 实现，零第三方依赖）。

服务端契约：``/v1/partitions/:partition/...``，API Key 鉴权（``Bearer mnemos_live_…``），
入参/出参统一 ``snake_case``；人 / 记忆列表使用游标分页（无 total）。

快速开始::

    from mnemos import MnemosClient

    client = MnemosClient(api_key="mnemos_live_…", base_url="http://127.0.0.1:4380")
    client.persons.upsert("ws-demo", "user-1", type="human", display_name="周野")
    result = client.memories.add(
        "user-1",
        text="周野偏好中文评审意见",
        category="preference",
        scope="partition",
        partition="ws-demo",
    )
    hits = client.memories.search("评审偏好", partition="ws-demo", top_k=5)
    for hit in hits.hits:
        print(hit.score, hit.signals.keyword, hit.content)

所有非 2xx 响应抛 :class:`mnemos.errors.MnemosApiError`；网络/超时分别抛
:class:`MnemosNetworkError` / :class:`MnemosTimeoutError`。
"""

from __future__ import annotations

import json
import logging
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping as _Mapping
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Type, TypeVar, Union

from .errors import MnemosApiError, MnemosNetworkError, MnemosTimeoutError
from .types import (
    CursorPage,
    DreamResult,
    DreamStatus,
    Memory,
    MemoryAddResult,
    MemoryBrief,
    MemoryDetail,
    MemoryHistoryEntry,
    MemorySearchResponse,
    Partition,
    PartitionStats,
    Person,
    PersonContext,
    PersonExport,
    PersonFact,
    PersonMergeResult,
    PersonProfile,
)

__all__ = [
    "DEFAULT_BASE_URL",
    "SDK_VERSION",
    "MnemosClient",
    "PartitionsResource",
    "PersonsResource",
    "MemoriesResource",
]

SDK_VERSION = "2.0.0"
DEFAULT_BASE_URL = "http://127.0.0.1:4380"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 2
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})
# 可安全重试的方法：GET / 幂等写 / 删除；只读检索 POST 单独判断。
SAFE_RETRY_METHODS = frozenset({"GET", "PUT", "PATCH", "DELETE"})
RETRY_AFTER_CAP_SECONDS = 60.0

T = TypeVar("T")
JSON = Dict[str, Any]

logger = logging.getLogger("mnemos")


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


def _seg(value: Any) -> str:
    """URL 路径段编码（分区/人/记忆 id 原样传递）。"""
    return urllib.parse.quote(str(value), safe="")


def _compact(data: Mapping[str, Any]) -> JSON:
    """去掉 ``None`` 字段，保留 ``False`` / ``0`` / 空串等有效值。"""
    return {key: value for key, value in data.items() if value is not None}


def _encode_query(query: Optional[Mapping[str, Any]]) -> str:
    if not query:
        return ""
    pairs: List[Tuple[str, str]] = []
    for key, value in query.items():
        if value is None:
            continue
        if isinstance(value, bool):
            pairs.append((key, "true" if value else "false"))
        elif isinstance(value, (list, tuple)):
            for item in value:
                if item is not None:
                    pairs.append((key, str(item)))
        else:
            pairs.append((key, str(value)))
    return urllib.parse.urlencode(pairs)


def _retry_after_seconds(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        try:
            moment = parsedate_to_datetime(value)
        except (TypeError, ValueError, IndexError):
            return None
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return max(0.0, (moment - datetime.now(timezone.utc)).total_seconds())
    return max(0.0, seconds)


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, _Mapping) else {}


def _model(cls: Type[T], payload: Any) -> T:
    return cls.from_dict(_as_mapping(payload))  # type: ignore[attr-defined,no-any-return]


# ---------------------------------------------------------------------------
# 资源：分区
# ---------------------------------------------------------------------------


class PartitionsResource:
    """分区（App / 项目 / 租户 / 工作区）。"""

    def __init__(self, client: "MnemosClient") -> None:
        self._client = client

    def list(self) -> List[Partition]:
        """本组织分区列表（需要 org key）；每项带 ``stats``。"""
        payload = self._client._request("GET", "/v1/partitions")
        if not isinstance(payload, list):
            return []
        return [Partition.from_dict(item) if isinstance(item, _Mapping) else Partition() for item in payload]

    def create(
        self,
        slug: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        status: Optional[str] = None,
        settings: Optional[Mapping[str, Any]] = None,
    ) -> Partition:
        """按 slug 幂等 upsert（需要 org key + ``admin`` 作用域）。"""
        body = _compact(
            {
                "slug": slug,
                "name": name,
                "description": description,
                "status": status,
                "settings": dict(settings) if settings is not None else None,
            }
        )
        payload = self._client._request("POST", "/v1/partitions", body=body)
        return _model(Partition, payload)

    def get(self, partition: Optional[str] = None) -> Partition:
        """分区详情（不含 ``stats``；需要统计用 :meth:`stats`）。"""
        ref = self._client._partition(partition)
        payload = self._client._request("GET", f"/v1/partitions/{_seg(ref)}")
        return _model(Partition, payload)

    def update(
        self,
        partition: Optional[str] = None,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        status: Optional[str] = None,
        settings: Optional[Mapping[str, Any]] = None,
    ) -> Partition:
        """更新名称 / 描述 / 状态 / 设置（部分更新）。"""
        ref = self._client._partition(partition)
        body = _compact(
            {
                "name": name,
                "description": description,
                "status": status,
                "settings": dict(settings) if settings is not None else None,
            }
        )
        if not body:
            raise ValueError("partitions.update: 至少提供一个待更新字段")
        payload = self._client._request("PATCH", f"/v1/partitions/{_seg(ref)}", body=body)
        return _model(Partition, payload)

    def stats(self, partition: Optional[str] = None) -> PartitionStats:
        """分区统计（读 ``partition_stats`` 单行，O(1)）。"""
        ref = self._client._partition(partition)
        payload = self._client._request("GET", f"/v1/partitions/{_seg(ref)}/stats")
        return _model(PartitionStats, payload)


# ---------------------------------------------------------------------------
# 资源：人
# ---------------------------------------------------------------------------


class PersonsResource:
    """记忆主体「人」：真人 / 智能体 / 服务账号。"""

    def __init__(self, client: "MnemosClient") -> None:
        self._client = client

    def list(
        self,
        partition: Optional[str] = None,
        *,
        type: Optional[str] = None,
        status: Optional[str] = None,
        q: Optional[str] = None,
        sort: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        include_merged: Optional[bool] = None,
    ) -> CursorPage[Person]:
        """游标列表；``sort`` 换序时请丢弃旧 ``cursor``。"""
        ref = self._client._partition(partition)
        query = _compact(
            {
                "type": type,
                "status": status,
                "q": q,
                "sort": sort,
                "cursor": cursor,
                "limit": limit,
                "include_merged": include_merged,
            }
        )
        payload = self._client._request("GET", f"/v1/partitions/{_seg(ref)}/persons", query=query)
        return CursorPage.from_dict(_as_mapping(payload), Person)

    def get(self, person: Optional[str] = None, *, partition: Optional[str] = None) -> Person:
        """人详情；``person`` 支持内部 id 或 external_id。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        payload = self._client._request("GET", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}")
        return _model(Person, payload)

    def upsert(
        self,
        external_id: str,
        *,
        type: Optional[str] = None,
        display_name: Optional[str] = None,
        attributes: Optional[Mapping[str, Any]] = None,
        status: Optional[str] = None,
        partition: Optional[str] = None,
    ) -> Person:
        """按 ``(type, external_id)`` 幂等建档 / 更新，并刷新 ``last_seen_at``。"""
        ref = self._client._partition(partition)
        body = _compact(
            {
                "external_id": external_id,
                "type": type,
                "display_name": display_name,
                "attributes": dict(attributes) if attributes is not None else None,
                "status": status,
            }
        )
        payload = self._client._request(
            "PUT", f"/v1/partitions/{_seg(ref)}/persons/{_seg(external_id)}", body=body
        )
        return _model(Person, payload)

    def update(
        self,
        person: Optional[str] = None,
        *,
        type: Optional[str] = None,
        display_name: Optional[str] = None,
        attributes: Optional[Mapping[str, Any]] = None,
        status: Optional[str] = None,
        partition: Optional[str] = None,
    ) -> Person:
        """更新展示名 / 属性 / 状态 / 类型（部分更新）。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        body = _compact(
            {
                "type": type,
                "display_name": display_name,
                "attributes": dict(attributes) if attributes is not None else None,
                "status": status,
            }
        )
        if not body:
            raise ValueError("persons.update: 至少提供一个待更新字段")
        payload = self._client._request(
            "PATCH", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}", body=body
        )
        return _model(Person, payload)

    def memories(
        self,
        person: Optional[str] = None,
        *,
        partition: Optional[str] = None,
        scope: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
        q: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> CursorPage[Memory]:
        """某人的记忆列表（游标分页）。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        query = _compact(
            {
                "scope": scope,
                "category": category,
                "status": status,
                "q": q,
                "cursor": cursor,
                "limit": limit,
            }
        )
        payload = self._client._request(
            "GET", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/memories", query=query
        )
        return CursorPage.from_dict(_as_mapping(payload), Memory)

    # --- v6.1 P1：画像 / 生命周期（服务端上线后可用，按契约实现） --------

    def profile(
        self,
        person: Optional[str] = None,
        *,
        partition: Optional[str] = None,
        force: Optional[bool] = None,
    ) -> PersonProfile:
        """人的结构化画像：当前 facts + 摘要（P1）；``force`` 跳过缓存重算。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        payload = self._client._request(
            "GET",
            f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/profile",
            query=_compact({"force": force}),
        )
        return _model(PersonProfile, payload)

    def facts(self, person: Optional[str] = None, *, partition: Optional[str] = None) -> List[PersonFact]:
        """人的当前有效事实槽位（P1）。兼容数组与 ``{items}`` 两种响应。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        payload = self._client._request(
            "GET", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/facts"
        )
        items: Any = payload.get("items") if isinstance(payload, _Mapping) else payload
        if not isinstance(items, list):
            return []
        return [PersonFact.from_dict(item) if isinstance(item, _Mapping) else PersonFact() for item in items]

    def upsert_fact(
        self,
        person: Optional[str] = None,
        *,
        key: str,
        value: str,
        confidence: Optional[float] = None,
        source_memory_id: Optional[str] = None,
        partition: Optional[str] = None,
    ) -> PersonFact:
        """显式维护事实槽位（P1）。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        body = _compact(
            {
                "key": key,
                "value": value,
                "confidence": confidence,
                "source_memory_id": source_memory_id,
            }
        )
        payload = self._client._request(
            "PUT", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/facts", body=body
        )
        if isinstance(payload, _Mapping) and isinstance(payload.get("fact"), _Mapping):
            payload = payload["fact"]
        return _model(PersonFact, payload)

    def upsert_facts(
        self,
        person: Optional[str] = None,
        facts: Optional[Sequence[Mapping[str, Any]]] = None,
        *,
        partition: Optional[str] = None,
    ) -> List[PersonFact]:
        """批量维护事实槽位（P1）：body ``{facts: [{key, value, ...}]}``。"""
        if not facts:
            raise ValueError("persons.upsert_facts: facts 不能为空")
        ref = self._client._partition(partition)
        who = self._client._person(person)
        payload = self._client._request(
            "PUT",
            f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/facts",
            body={"facts": [dict(fact) for fact in facts]},
        )
        items: Any = payload.get("items") if isinstance(payload, _Mapping) else payload
        if not isinstance(items, list):
            return []
        return [PersonFact.from_dict(item) if isinstance(item, _Mapping) else PersonFact() for item in items]

    def remove_fact(
        self,
        person: Optional[str] = None,
        fact_id: Optional[str] = None,
        *,
        partition: Optional[str] = None,
    ) -> None:
        """删除一个事实槽位（P1）。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        if not fact_id:
            raise ValueError("persons.remove_fact: 需要 fact_id")
        self._client._request(
            "DELETE", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/facts/{_seg(fact_id)}"
        )

    def merge(
        self,
        person: Optional[str] = None,
        target: Optional[str] = None,
        *,
        partition: Optional[str] = None,
    ) -> PersonMergeResult:
        """把人合并到 canonical person（P1）；源人标记 ``merged_into``。"""
        if not target:
            raise ValueError("persons.merge: 需要目标人 target")
        ref = self._client._partition(partition)
        who = self._client._person(person)
        payload = self._client._request(
            "POST",
            f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/merge",
            body={"target_id": target},
        )
        return _model(PersonMergeResult, payload)

    def archive(self, person: Optional[str] = None, *, partition: Optional[str] = None) -> Person:
        """归档人（P1）。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        payload = self._client._request(
            "POST", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/archive"
        )
        return _model(Person, payload)

    def export(self, person: Optional[str] = None, *, partition: Optional[str] = None) -> PersonExport:
        """合规导出（P1）：人 + facts + memories。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        payload = self._client._request(
            "GET", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/export"
        )
        return _model(PersonExport, payload)

    def delete(
        self,
        person: Optional[str] = None,
        *,
        hard: bool = False,
        partition: Optional[str] = None,
    ) -> None:
        """软删除人（P1）；``hard=True`` 仅 owner 可用。"""
        ref = self._client._partition(partition)
        who = self._client._person(person)
        query = {"hard": True} if hard else None
        self._client._request(
            "DELETE", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}", query=query
        )


# ---------------------------------------------------------------------------
# 资源：记忆
# ---------------------------------------------------------------------------


class MemoriesResource:
    """记忆：写入 / 列表 / 混合检索 / 详情 / 更新 / 历史 / 反馈。"""

    def __init__(self, client: "MnemosClient") -> None:
        self._client = client

    def add(
        self,
        person: Optional[str] = None,
        *,
        text: Optional[str] = None,
        content: Optional[str] = None,
        messages: Optional[Sequence[Mapping[str, Any]]] = None,
        partition: Optional[str] = None,
        scope: Optional[str] = None,
        session_id: Optional[str] = None,
        session_title: Optional[str] = None,
        category: Optional[str] = None,
        importance: Optional[float] = None,
        confidence: Optional[float] = None,
        source: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        placeholders: Optional[Mapping[str, str]] = None,
        expires_at: Optional[str] = None,
        supersedes_id: Optional[str] = None,
        fact_key: Optional[str] = None,
        valid_from: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> MemoryAddResult:
        """写入记忆；返回 ``{memory, event, superseded_id}``。

        ``event`` 为 ``ADD`` / ``MERGE`` / ``NOOP`` / ``SUPERSEDE`` —— 重复写入不会
        新增（``NOOP``），相似写入会合并（``MERGE``），``supersedes_id`` / 同
        ``fact_key`` 会让旧记忆失效（``SUPERSEDE``）。

        隐私占位符：把手机号 / 邮箱等真实值放进 ``placeholders``，正文用
        ``{{key}}`` 占位符（如 ``content="手机 {{phone_a1b2}}"``、
        ``placeholders={"phone_a1b2": "18334423321"}``）。正文只存 token，
        真实值由服务端加密保存；``brief`` / ``context`` 自动还原。
        """
        if not text and not content and not messages:
            raise ValueError("memories.add: text / content / messages 至少提供一个")
        ref = self._client._partition(partition)
        who = self._client._person(person)
        body = _compact(
            {
                "text": text,
                "content": content,
                "messages": [dict(message) for message in messages] if messages is not None else None,
                "scope": scope,
                "session_id": session_id,
                "session_title": session_title,
                "category": category,
                "importance": importance,
                "confidence": confidence,
                "source": source,
                "tags": list(tags) if tags is not None else None,
                "metadata": dict(metadata) if metadata is not None else None,
                "placeholders": dict(placeholders) if placeholders is not None else None,
                "expires_at": expires_at,
                "supersedes_id": supersedes_id,
                "fact_key": fact_key,
                "valid_from": valid_from,
            }
        )
        payload = self._client._request(
            "POST",
            f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/memories",
            body=body,
            idempotency_key=idempotency_key,
        )
        return _model(MemoryAddResult, payload)

    def list(
        self,
        partition: Optional[str] = None,
        *,
        person_id: Optional[str] = None,
        person_external_id: Optional[str] = None,
        scope: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
        q: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> CursorPage[Memory]:
        """分区记忆列表（游标分页）。"""
        ref = self._client._partition(partition)
        query = _compact(
            {
                "person_id": person_id,
                "person_external_id": person_external_id,
                "scope": scope,
                "category": category,
                "status": status,
                "q": q,
                "cursor": cursor,
                "limit": limit,
            }
        )
        payload = self._client._request(
            "GET", f"/v1/partitions/{_seg(ref)}/memories", query=query
        )
        return CursorPage.from_dict(_as_mapping(payload), Memory)

    def list_by_person(
        self,
        person: Optional[str] = None,
        *,
        partition: Optional[str] = None,
        scope: Optional[str] = None,
        category: Optional[str] = None,
        status: Optional[str] = None,
        q: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> CursorPage[Memory]:
        """某人的记忆列表（等价 ``persons.memories``）。"""
        return self._client.persons.memories(
            person,
            partition=partition,
            scope=scope,
            category=category,
            status=status,
            q=q,
            cursor=cursor,
            limit=limit,
        )

    def search(
        self,
        query: str,
        *,
        partition: Optional[str] = None,
        person_id: Optional[str] = None,
        person_external_id: Optional[str] = None,
        scope: Optional[str] = None,
        category: Optional[str] = None,
        mode: Optional[str] = None,
        top_k: Optional[int] = None,
        as_of: Optional[str] = None,
        include_superseded: Optional[bool] = None,
        include_private: Optional[bool] = None,
    ) -> MemorySearchResponse:
        """混合检索（默认 hybrid），返回可解释的 ``signals`` 与 ``score``。"""
        if not isinstance(query, str) or not query.strip():
            raise ValueError("memories.search: query 不能为空")
        ref = self._client._partition(partition)
        body = _compact(
            {
                "query": query,
                "person_id": person_id,
                "person_external_id": person_external_id,
                "scope": scope,
                "category": category,
                "mode": mode,
                "top_k": top_k,
                "as_of": as_of,
                "include_superseded": include_superseded,
                "include_private": include_private,
            }
        )
        payload = self._client._request(
            "POST", f"/v1/partitions/{_seg(ref)}/memories/search", body=body
        )
        return _model(MemorySearchResponse, payload)

    def get(self, memory_id: str, *, partition: Optional[str] = None) -> MemoryDetail:
        """记忆详情：``{memory, person}``。"""
        ref = self._client._partition(partition)
        payload = self._client._request(
            "GET", f"/v1/partitions/{_seg(ref)}/memories/{_seg(memory_id)}"
        )
        return _model(MemoryDetail, payload)

    def update(
        self,
        memory_id: str,
        *,
        partition: Optional[str] = None,
        content: Optional[str] = None,
        category: Optional[str] = None,
        importance: Optional[float] = None,
        confidence: Optional[float] = None,
        status: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
        metadata: Optional[Mapping[str, Any]] = None,
        expires_at: Optional[str] = None,
    ) -> Memory:
        """更新记忆（部分更新），返回最新 Memory。"""
        ref = self._client._partition(partition)
        body = _compact(
            {
                "content": content,
                "category": category,
                "importance": importance,
                "confidence": confidence,
                "status": status,
                "tags": list(tags) if tags is not None else None,
                "metadata": dict(metadata) if metadata is not None else None,
                "expires_at": expires_at,
            }
        )
        if not body:
            raise ValueError("memories.update: 至少提供一个待更新字段")
        payload = self._client._request(
            "PATCH", f"/v1/partitions/{_seg(ref)}/memories/{_seg(memory_id)}", body=body
        )
        return _model(Memory, _as_mapping(payload).get("memory"))

    def delete(self, memory_id: str, *, partition: Optional[str] = None) -> None:
        """删除记忆（服务端返回 204）。"""
        ref = self._client._partition(partition)
        self._client._request(
            "DELETE", f"/v1/partitions/{_seg(ref)}/memories/{_seg(memory_id)}"
        )

    def history(self, memory_id: str, *, partition: Optional[str] = None) -> List[MemoryHistoryEntry]:
        """记忆变更历史（ADD/UPDATE/MERGE/SUPERSEDE/DELETE/NOOP/FEEDBACK）。"""
        ref = self._client._partition(partition)
        payload = self._client._request(
            "GET", f"/v1/partitions/{_seg(ref)}/memories/{_seg(memory_id)}/history"
        )
        items: Any = payload.get("items") if isinstance(payload, _Mapping) else payload
        if not isinstance(items, list):
            return []
        return [
            MemoryHistoryEntry.from_dict(item) if isinstance(item, _Mapping) else MemoryHistoryEntry()
            for item in items
        ]

    def feedback(
        self,
        memory_id: str,
        helpful: bool,
        *,
        partition: Optional[str] = None,
        query: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> Memory:
        """提交检索反馈（更新 feedback_up/down 与 confidence）。"""
        ref = self._client._partition(partition)
        body = _compact({"helpful": bool(helpful), "query": query, "reason": reason})
        payload = self._client._request(
            "POST", f"/v1/partitions/{_seg(ref)}/memories/{_seg(memory_id)}/feedback", body=body
        )
        return _model(Memory, _as_mapping(payload).get("memory"))


# ---------------------------------------------------------------------------
# 客户端
# ---------------------------------------------------------------------------


class MnemosClient:
    """Mnemos 同步客户端。

    参数
    ----
    api_key:
        ``mnemos_live_…`` API Key；也可用环境变量 ``MNEMOS_API_KEY``。
    base_url:
        服务地址，默认 ``http://127.0.0.1:4380``，允许带路径前缀；
        也可用环境变量 ``MNEMOS_BASE_URL``。
    partition:
        可选默认分区（内部 id 或 slug），方法未显式传 ``partition`` 时使用。
    person:
        可选默认人（内部 id 或 external_id），方法未显式传 ``person`` 时使用。
    timeout:
        单次请求超时（秒），默认 30。
    max_retries:
        GET/幂等写/检索的最大重试次数（429/5xx/网络错误），默认 2；写记忆等
        非幂等 POST 不自动重试，避免重复写入。
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        *,
        partition: Optional[str] = None,
        person: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_base_delay: float = 0.2,
        user_agent: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        # 兼容 MnemosClient("http://host", "mnemos_live_…") 的反向参数顺序。
        if (
            isinstance(api_key, str)
            and api_key.startswith(("http://", "https://"))
            and isinstance(base_url, str)
            and not base_url.startswith(("http://", "https://"))
        ):
            api_key, base_url = base_url, api_key

        env_base = os.environ.get("MNEMOS_BASE_URL")
        env_key = os.environ.get("MNEMOS_API_KEY")
        self.base_url = (base_url or env_base or DEFAULT_BASE_URL).strip().rstrip("/")
        if not self.base_url.startswith(("http://", "https://")):
            raise ValueError(f"base_url 必须以 http:// 或 https:// 开头：{self.base_url!r}")
        self.api_key = (api_key or env_key or "").strip()
        self.partition = partition
        self.person = person
        self.timeout = float(timeout)
        self.max_retries = max(0, int(max_retries))
        self.retry_base_delay = max(0.0, float(retry_base_delay))
        self._user_agent = user_agent or f"mnemos-python-sdk/{SDK_VERSION}"
        self._extra_headers = dict(headers or {})

        self.partitions = PartitionsResource(self)
        self.persons = PersonsResource(self)
        self.memories = MemoriesResource(self)

    # --- 生命周期 ------------------------------------------------------

    def close(self) -> None:
        """占位方法：urllib 每请求独立连接，无需关闭。"""

    def __enter__(self) -> "MnemosClient":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def __repr__(self) -> str:
        masked = f"{self.api_key[:12]}…" if self.api_key else "<empty>"
        return f"MnemosClient(base_url={self.base_url!r}, api_key={masked!r})"

    # --- 顶层便捷方法 --------------------------------------------------

    def stats(self, partition: Optional[str] = None) -> PartitionStats:
        """分区统计（等价 ``client.partitions.stats``）。"""
        return self.partitions.stats(partition)

    def brief(
        self,
        person: Optional[str] = None,
        *,
        partition: Optional[str] = None,
        max_chars: Optional[int] = None,
        force: Optional[bool] = None,
    ) -> MemoryBrief:
        """人级记忆简报（可直接注入提示词的 ``text``）。"""
        ref = self._partition(partition)
        who = self._person(person)
        query = _compact({"max_chars": max_chars, "force": force})
        payload = self._request(
            "GET", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/brief", query=query
        )
        return _model(MemoryBrief, payload)

    def context(
        self,
        person: Optional[str] = None,
        *,
        partition: Optional[str] = None,
        query: Optional[str] = None,
        budget_tokens: Optional[int] = None,
        include_partition: Optional[bool] = None,
    ) -> PersonContext:
        """人的上下文：资料 + 简报 + 相关记忆 + 分区共享知识 + ``prompt``。"""
        ref = self._partition(partition)
        who = self._person(person)
        body = _compact(
            {
                "query": query,
                "budget_tokens": budget_tokens,
                "include_partition": include_partition,
            }
        )
        payload = self._request(
            "POST", f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/context", body=body
        )
        return _model(PersonContext, payload)

    def dream_status(
        self, person: Optional[str] = None, *, partition: Optional[str] = None
    ) -> DreamStatus:
        """做梦状态：人级（传 ``person``）或分区级（不传）。"""
        ref = self._partition(partition)
        if person is not None or self.person is not None:
            who = self._person(person)
            path = f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/dream"
        else:
            path = f"/v1/partitions/{_seg(ref)}/dream"
        return _model(DreamStatus, self._request("GET", path))

    def dream_run(
        self,
        person: Optional[str] = None,
        *,
        partition: Optional[str] = None,
        batch_size: Optional[int] = None,
    ) -> DreamResult:
        """手动触发一次增量做梦（人级或分区级）。"""
        ref = self._partition(partition)
        body = _compact({"batch_size": batch_size})
        if person is not None or self.person is not None:
            who = self._person(person)
            path = f"/v1/partitions/{_seg(ref)}/persons/{_seg(who)}/dream/run"
        else:
            path = f"/v1/partitions/{_seg(ref)}/dream/run"
        return _model(DreamResult, self._request("POST", path, body=body))

    def dream(
        self,
        person: Optional[str] = None,
        *,
        partition: Optional[str] = None,
        run: bool = False,
        batch_size: Optional[int] = None,
    ) -> Union[DreamStatus, DreamResult]:
        """便捷入口：``run=False`` 返回状态，``run=True`` 触发一次做梦。"""
        if run:
            return self.dream_run(person, partition=partition, batch_size=batch_size)
        return self.dream_status(person, partition=partition)

    def health(self) -> JSON:
        """健康检查（无需鉴权）。"""
        payload = self._request("GET", "/health", auth=False)
        return dict(payload) if isinstance(payload, _Mapping) else {}

    # --- 内部 ----------------------------------------------------------

    def _partition(self, partition: Optional[str]) -> str:
        ref = partition or self.partition
        if not ref:
            raise ValueError(
                "缺少分区引用：请在构造时传 partition=… 或调用时传 partition=…"
            )
        return str(ref)

    def _person(self, person: Optional[str]) -> str:
        ref = person or self.person
        if not ref:
            raise ValueError("缺少人引用：请在构造时传 person=… 或调用时传 person=…")
        return str(ref)

    def _headers(self, *, auth: bool, has_body: bool) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": self._user_agent,
        }
        if has_body:
            headers["Content-Type"] = "application/json; charset=utf-8"
        if auth and self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self._extra_headers)
        return headers

    def _url(self, path: str, query: Optional[Mapping[str, Any]]) -> str:
        encoded = _encode_query(query)
        url = f"{self.base_url}{path}"
        if encoded:
            url = f"{url}?{encoded}"
        return url

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        auth: bool = True,
    ) -> Any:
        """执行一次 HTTP 请求；自动重试可安全重试的幂等请求。"""
        method = method.upper()
        url = self._url(path, query)
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(_compact(body), ensure_ascii=False).encode("utf-8")
        headers = self._headers(auth=auth, has_body=data is not None)
        if idempotency_key:
            headers["Idempotency-Key"] = str(idempotency_key)

        retryable = method in SAFE_RETRY_METHODS or (
            method == "POST" and path.endswith("/search")
        )
        attempt = 0

        while True:
            request = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read()
                    return self._decode(raw, response.headers, response.status)
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                headers_in = exc.headers
                payload = self._decode_json(raw)
                retry_after = _retry_after_seconds(headers_in.get("Retry-After") if headers_in else None)
                if retryable and exc.code in RETRYABLE_STATUS and attempt < self.max_retries:
                    self._sleep(attempt, retry_after)
                    attempt += 1
                    continue
                fallback = exc.reason if isinstance(exc.reason, str) else str(exc.reason or "")
                raise MnemosApiError.from_payload(
                    exc.code,
                    payload,
                    request_id=(headers_in.get("x-request-id") if headers_in else None),
                    retry_after=retry_after,
                    fallback_message=fallback,
                ) from exc
            except urllib.error.URLError as exc:
                reason = exc.reason
                if retryable and attempt < self.max_retries:
                    self._sleep(attempt, None)
                    attempt += 1
                    continue
                if isinstance(reason, (TimeoutError, socket.timeout)):
                    raise MnemosTimeoutError(
                        f"请求超时：{method} {url}", url=url, cause=exc
                    ) from exc
                raise MnemosNetworkError(
                    f"网络错误：{method} {url}（{reason}）", url=url, cause=exc
                ) from exc
            except (TimeoutError, socket.timeout) as exc:
                if retryable and attempt < self.max_retries:
                    self._sleep(attempt, None)
                    attempt += 1
                    continue
                raise MnemosTimeoutError(
                    f"请求超时：{method} {url}", url=url, cause=exc
                ) from exc
            except OSError as exc:
                if retryable and attempt < self.max_retries:
                    self._sleep(attempt, None)
                    attempt += 1
                    continue
                raise MnemosNetworkError(
                    f"网络错误：{method} {url}（{exc}）", url=url, cause=exc
                ) from exc

    def _decode(self, raw: bytes, headers: Any, status: int) -> Any:
        if status == 204 or not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise MnemosApiError(
                status,
                "INVALID_RESPONSE",
                "服务端返回了非 JSON 响应",
                payload={"body": raw.decode("utf-8", "replace")[:500]},
            )

    @staticmethod
    def _decode_json(raw: bytes) -> Any:
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {"raw": raw.decode("utf-8", "replace")[:500]}

    def _sleep(self, attempt: int, retry_after: Optional[float]) -> None:
        if retry_after is not None:
            delay = min(retry_after, RETRY_AFTER_CAP_SECONDS)
        else:
            delay = self.retry_base_delay * (2 ** attempt)
        if delay > 0:
            logger.debug("Mnemos 请求重试：第 %s 次，等待 %.2fs", attempt + 1, delay)
            time.sleep(delay)
