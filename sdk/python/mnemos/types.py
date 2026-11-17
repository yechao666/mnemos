"""Mnemos v6.1 Python SDK 数据类型（snake_case，零第三方依赖）。

所有模型都是普通的 :class:`dataclasses.dataclass`：

- 字段名与服务端公开 ``/v1`` 契约一致（``snake_case``）；
- 每个模型都有 :meth:`Model.from_dict`，宽容未知字段、缺失字段回落到默认值，
  便于服务端新增字段时 SDK 不崩溃；
- 游标分页统一为 :class:`CursorPage`：``{items, next_cursor, partition_stats}``，
  SDK **不返回 total**。

典型用法::

    from mnemos.types import Memory, Person

    person = Person.from_dict(payload)
    print(person.external_id, person.memory_count)
"""

from __future__ import annotations

from collections.abc import Mapping as _Mapping
from dataclasses import dataclass, field, fields
from typing import Any, ClassVar, Dict, Generic, List, Mapping, Optional, Type, TypeVar

JSON = Dict[str, Any]
"""服务端返回的原始 JSON 对象。"""

T = TypeVar("T")

MEMORY_SCOPES = ("person", "partition", "session")
MEMORY_CATEGORIES = (
    "preference",
    "identity",
    "fact",
    "plan",
    "relationship",
    "event",
    "skill",
    "constraint",
    "context",
    "insight",
    "decision",
    "progress",
    "lesson",
    "risk",
    "change",
    "acceptance",
    "assumption",
    "dependency",
)
MEMORY_SOURCES = ("api", "conversation", "agent", "import", "playground", "dream")
MEMORY_STATUSES = ("active", "archived", "deleted")
MEMORY_SEARCH_MODES = ("hybrid", "keyword", "vector")
MEMORY_HISTORY_EVENTS = (
    "ADD",
    "UPDATE",
    "MERGE",
    "SUPERSEDE",
    "DELETE",
    "NOOP",
    "FEEDBACK",
    "RESTORE",
)
PERSON_TYPES = ("human", "agent", "service", "other")
PERSON_STATUSES = ("active", "archived", "deleted")
PERSON_SORTS = ("recent", "new", "name")
PARTITION_STATUSES = ("active", "paused", "archived")


def _float(value: Any, default: float = 0.0) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return default


def _int(value: Any, default: int = 0) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _bool(value: Any, default: bool = False) -> bool:
    return value if isinstance(value, bool) else default


def _list_of_str(value: Any) -> List[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [item for item in value if isinstance(item, str)]


def _dict(value: Any) -> JSON:
    return dict(value) if isinstance(value, _Mapping) else {}


class Model:
    """dataclass 模型的宽容反序列化基类。

    子类通过 ``_nested`` / ``_lists`` 声明嵌套模型，例如::

        @dataclass
        class Detail(Model):
            memory: Memory = field(default_factory=Memory)
            _nested: ClassVar[Dict[str, type]] = {"memory": Memory}
    """

    _nested: ClassVar[Dict[str, type]] = {}
    _lists: ClassVar[Dict[str, type]] = {}

    @classmethod
    def from_dict(cls, data: Optional[Mapping[str, Any]]) -> "Model":
        """从服务端 JSON 构造模型；未知字段忽略，``None`` 保持 ``None``。"""
        raw: Mapping[str, Any] = data if isinstance(data, _Mapping) else {}
        nested = getattr(cls, "_nested", {}) or {}
        lists = getattr(cls, "_lists", {}) or {}
        kwargs: Dict[str, Any] = {}
        for field_info in fields(cls):  # type: ignore[arg-type]
            name = field_info.name
            if name not in raw:
                continue
            value = raw[name]
            if value is None:
                kwargs[name] = None
            elif name in nested and isinstance(value, _Mapping):
                kwargs[name] = nested[name].from_dict(value)
            elif name in lists and isinstance(value, (list, tuple)):
                item_cls = lists[name]
                kwargs[name] = [
                    item_cls.from_dict(item) if isinstance(item, _Mapping) else item
                    for item in value
                ]
            else:
                # 逐字段做轻量类型收敛，避免服务端 null/类型漂移导致后续计算异常。
                kwargs[name] = _coerce(name, value, field_info)
        return cls(**kwargs)  # type: ignore[return-value]


_SCALAR_OVERRIDES = {
    "importance": _float,
    "confidence": _float,
    "score": _float,
    "took_ms": _int,
    "max_chars": _int,
    "count": _int,
    "token_estimate": _int,
    "memory_count": _int,
    "shared_memory_count": _int,
    "session_count": _int,
    "persons_total": _int,
    "persons_human": _int,
    "persons_agent": _int,
    "persons_service": _int,
    "memories_total": _int,
    "shared_total": _int,
    "sessions_total": _int,
    "input_count": _int,
    "insight_count": _int,
    "pending_count": _int,
    "interval_minutes": _int,
    "brief_max_chars": _int,
    "dream_interval_minutes": _int,
    "retention_days": _int,
    "monthly_quota": _int,
    "merge_threshold": _float,
    "dedupe_threshold": _float,
    "feedback_up": _int,
    "feedback_down": _int,
    "attachment_count": _int,
    "budget_tokens": _int,
    "limit": _int,
    "cached": _bool,
    "force": _bool,
    "helpful": _bool,
    "include_partition": _bool,
    "include_superseded": _bool,
    "include_private": _bool,
    "person_auto_create": _bool,
    "brief_enabled": _bool,
    "dream_enabled": _bool,
    "auto_extract_entities": _bool,
    "moved_memories": _int,
    "moved_facts": _int,
    "version": _int,
}

_LIST_OVERRIDES = {
    "tags": _list_of_str,
    "citations": _list_of_str,
    "matched_on": _list_of_str,
}

_DICT_OVERRIDES = {
    "attributes": _dict,
    "metadata": _dict,
    "consent": _dict,
    "meta": _dict,
    "retrieval_weights": _dict,
    "settings": _dict,
    "partition_stats": _dict,
}


def _coerce(name: str, value: Any, field_info: Any) -> Any:
    if name in _SCALAR_OVERRIDES:
        try:
            return _SCALAR_OVERRIDES[name](value)
        except Exception:  # pragma: no cover - 防御性兜底
            return value
    if name in _LIST_OVERRIDES:
        return _LIST_OVERRIDES[name](value)
    if name in _DICT_OVERRIDES and value is not None and not isinstance(value, _Mapping):
        return {}
    return value


@dataclass
class PartitionSettings(Model):
    """分区设置（v1 snake_case）。"""

    default_scope: str = "partition"
    brief_max_chars: int = 1200
    brief_enabled: bool = True
    dream_enabled: bool = True
    dream_interval_minutes: int = 1440
    retention_days: int = 0
    monthly_quota: int = 0
    person_auto_create: bool = True
    locale: str = "zh-CN"
    # v6.1
    retrieval_mode: str = "hybrid"
    retrieval_weights: JSON = field(default_factory=dict)
    embedding_model: str = "mnemos-hash-384"
    merge_threshold: float = 0.95
    dedupe_threshold: float = 0.99
    auto_extract_entities: bool = True

    _nested: ClassVar[Dict[str, type]] = {}


@dataclass
class PartitionStats(Model):
    partition_id: str = ""
    persons_total: int = 0
    persons_human: int = 0
    persons_agent: int = 0
    persons_service: int = 0
    memories_total: int = 0
    shared_total: int = 0
    sessions_total: int = 0
    updated_at: str = ""


@dataclass
class Partition(Model):
    id: str = ""
    org_id: str = ""
    slug: str = ""
    name: str = ""
    description: str = ""
    status: str = "active"
    settings: PartitionSettings = field(default_factory=PartitionSettings)
    created_at: str = ""
    updated_at: str = ""
    archived_at: Optional[str] = None
    stats: Optional[PartitionStats] = None

    _nested: ClassVar[Dict[str, type]] = {
        "settings": PartitionSettings,
        "stats": PartitionStats,
    }


@dataclass
class Person(Model):
    id: str = ""
    partition_id: str = ""
    external_id: str = ""
    type: str = "human"
    display_name: str = ""
    attributes: JSON = field(default_factory=dict)
    status: str = "active"
    memory_count: int = 0
    shared_memory_count: int = 0
    session_count: int = 0
    last_memory_at: Optional[str] = None
    first_seen_at: str = ""
    last_seen_at: str = ""
    created_at: str = ""
    updated_at: str = ""
    merged_into: Optional[str] = None
    consent: JSON = field(default_factory=dict)
    deleted_at: Optional[str] = None


@dataclass
class PersonFact(Model):
    """v6.1 P1：结构化画像槽位（当前有效 = ``valid_to is None``）。"""

    id: str = ""
    partition_id: str = ""
    person_id: str = ""
    key: str = ""
    value: str = ""
    confidence: float = 0.7
    valid_from: str = ""
    valid_to: Optional[str] = None
    source_memory_id: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class PersonProfile(Model):
    """v6.1 P1：人的结构化画像（facts + 摘要）。"""

    person: Person = field(default_factory=Person)
    facts: List[PersonFact] = field(default_factory=list)
    summary: str = ""
    generated_at: Optional[str] = None
    cached: Optional[bool] = None

    _nested: ClassVar[Dict[str, type]] = {"person": Person}
    _lists: ClassVar[Dict[str, type]] = {"facts": PersonFact}


@dataclass
class PersonMergeResult(Model):
    """v6.1 P1：人合并结果。"""

    person: Person = field(default_factory=Person)
    merged_from: Optional[Person] = None
    moved_memories: int = 0
    moved_facts: int = 0

    _nested: ClassVar[Dict[str, type]] = {
        "person": Person,
        "merged_from": Person,
    }


@dataclass
class PersonExport(Model):
    """v6.1 P1：合规导出（人 + 事实 + 记忆）。"""

    person: Person = field(default_factory=Person)
    facts: List[PersonFact] = field(default_factory=list)
    memories: List["Memory"] = field(default_factory=list)
    exported_at: str = ""
    truncated: bool = False

    _nested: ClassVar[Dict[str, type]] = {"person": Person}
    _lists: ClassVar[Dict[str, type]] = {"facts": PersonFact}


@dataclass
class Memory(Model):
    id: str = ""
    partition_id: str = ""
    person_id: str = ""
    person_external_id: Optional[str] = None
    actor_person_id: Optional[str] = None
    scope: str = "partition"
    session_id: Optional[str] = None
    category: str = "fact"
    content: str = ""
    importance: float = 0.5
    confidence: float = 0.8
    source: str = "api"
    status: str = "active"
    tags: List[str] = field(default_factory=list)
    metadata: JSON = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""
    expires_at: Optional[str] = None
    dreamed_at: Optional[str] = None
    # v6.1 时序与演化
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    superseded_by: Optional[str] = None
    supersedes: Optional[str] = None
    fact_key: Optional[str] = None
    feedback_up: int = 0
    feedback_down: int = 0
    attachment_count: int = 0


@dataclass
class MemoryDetail(Model):
    memory: Memory = field(default_factory=Memory)
    person: Optional[Person] = None

    _nested: ClassVar[Dict[str, type]] = {
        "memory": Memory,
        "person": Person,
    }


@dataclass
class MemorySearchSignals(Model):
    """混合检索的可解释信号（0–1）。"""

    vector: float = 0.0
    keyword: float = 0.0
    recency: float = 0.0
    importance: float = 0.0
    entity: float = 0.0


@dataclass
class MemorySearchHit(Memory):
    """检索命中：在 Memory 之上带 ``score`` / ``signals`` / ``matched_on``。"""

    score: float = 0.0
    signals: MemorySearchSignals = field(default_factory=MemorySearchSignals)
    matched_on: List[str] = field(default_factory=list)

    _nested: ClassVar[Dict[str, type]] = {"signals": MemorySearchSignals}


@dataclass
class MemorySearchResponse(Model):
    hits: List[MemorySearchHit] = field(default_factory=list)
    # v6 兼容字段：与 hits 同内容（不含 score/signals）。
    results: List[Memory] = field(default_factory=list)
    took_ms: int = 0
    mode: str = "hybrid"
    strategy: str = ""
    partition_stats: Optional[PartitionStats] = None

    _nested: ClassVar[Dict[str, type]] = {"partition_stats": PartitionStats}
    _lists: ClassVar[Dict[str, type]] = {
        "hits": MemorySearchHit,
        "results": Memory,
    }


@dataclass
class MemoryAddResult(Model):
    """写入结果：``event`` 说明 ADD / MERGE / NOOP / SUPERSEDE。"""

    memory: Memory = field(default_factory=Memory)
    event: str = "ADD"
    superseded_id: Optional[str] = None
    events: List[JSON] = field(default_factory=list)

    _nested: ClassVar[Dict[str, type]] = {"memory": Memory}


@dataclass
class MemoryHistoryEntry(Model):
    id: str = ""
    partition_id: str = ""
    memory_id: str = ""
    person_id: Optional[str] = None
    event: str = ""
    old_content: Optional[str] = None
    new_content: Optional[str] = None
    actor: Optional[str] = None
    reason: Optional[str] = None
    meta: JSON = field(default_factory=dict)
    created_at: str = ""


@dataclass
class BriefItem(Model):
    id: str = ""
    content: str = ""
    category: str = "fact"
    importance: float = 0.0
    scope: str = "person"
    updated_at: str = ""
    person_id: str = ""
    person_external_id: Optional[str] = None


@dataclass
class MemoryBrief(Model):
    """记忆简报：可直接注入提示词的 ``text``。"""

    partition_id: str = ""
    person_id: Optional[str] = None
    scope_key: str = ""
    text: str = ""
    max_chars: int = 0
    count: int = 0
    model: str = ""
    cached: bool = False
    source_hash: str = ""
    generated_at: str = ""
    recent: List[BriefItem] = field(default_factory=list)

    _lists: ClassVar[Dict[str, type]] = {"recent": BriefItem}


@dataclass
class PersonContext(Model):
    """人的上下文：资料 + 简报 + 相关记忆 + 分区共享知识（附 ``prompt``）。"""

    person: Person = field(default_factory=Person)
    brief: MemoryBrief = field(default_factory=MemoryBrief)
    memories: List[Memory] = field(default_factory=list)
    shared: List[Memory] = field(default_factory=list)
    prompt: str = ""
    token_estimate: int = 0
    citations: List[str] = field(default_factory=list)
    built_at: str = ""

    _nested: ClassVar[Dict[str, type]] = {
        "person": Person,
        "brief": MemoryBrief,
    }
    _lists: ClassVar[Dict[str, type]] = {
        "memories": Memory,
        "shared": Memory,
    }


@dataclass
class DreamSettings(Model):
    enabled: bool = True
    interval_minutes: int = 1440
    last_at: Optional[str] = None


@dataclass
class DreamRun(Model):
    id: str = ""
    partition_id: str = ""
    person_id: Optional[str] = None
    trigger: str = "manual"
    status: str = "completed"
    input_count: int = 0
    insight_count: int = 0
    summary: Optional[str] = None
    error: Optional[str] = None
    started_at: str = ""
    finished_at: Optional[str] = None


@dataclass
class DreamStatus(Model):
    settings: DreamSettings = field(default_factory=DreamSettings)
    person_id: Optional[str] = None
    pending_count: int = 0
    last_run: Optional[DreamRun] = None
    runs: List[DreamRun] = field(default_factory=list)

    _nested: ClassVar[Dict[str, type]] = {
        "settings": DreamSettings,
        "last_run": DreamRun,
    }
    _lists: ClassVar[Dict[str, type]] = {"runs": DreamRun}


@dataclass
class DreamResult(Model):
    run: Optional[DreamRun] = None
    status: DreamStatus = field(default_factory=DreamStatus)

    _nested: ClassVar[Dict[str, type]] = {
        "run": DreamRun,
        "status": DreamStatus,
    }


@dataclass
class CursorPage(Generic[T]):
    """统一游标分页：``{items, next_cursor, partition_stats}``，没有 total。"""

    items: List[T] = field(default_factory=list)
    next_cursor: Optional[str] = None
    partition_stats: Optional[PartitionStats] = None

    @classmethod
    def from_dict(cls, data: Optional[Mapping[str, Any]], item_type: Type[T]) -> "CursorPage[T]":
        raw: Mapping[str, Any] = data if isinstance(data, _Mapping) else {}
        raw_items = raw.get("items")
        items: List[T] = []
        if isinstance(raw_items, (list, tuple)):
            for item in raw_items:
                if isinstance(item, _Mapping):
                    items.append(item_type.from_dict(item))  # type: ignore[attr-defined]
                else:
                    items.append(item)  # type: ignore[arg-type]
        raw_stats = raw.get("partition_stats")
        stats = PartitionStats.from_dict(raw_stats) if isinstance(raw_stats, _Mapping) else None
        cursor = raw.get("next_cursor")
        return cls(
            items=items,
            next_cursor=cursor if isinstance(cursor, str) else None,
            partition_stats=stats,
        )


# ---------------------------------------------------------------------------
# 兼容：PersonExport 前向引用（Memory 定义在 PersonExport 之后）。
# ---------------------------------------------------------------------------

PersonExport._lists = {"facts": PersonFact, "memories": Memory}

__all__ = [
    "JSON",
    "Model",
    "PartitionSettings",
    "PartitionStats",
    "Partition",
    "Person",
    "PersonFact",
    "PersonProfile",
    "PersonMergeResult",
    "PersonExport",
    "Memory",
    "MemoryDetail",
    "MemorySearchSignals",
    "MemorySearchHit",
    "MemorySearchResponse",
    "MemoryAddResult",
    "MemoryHistoryEntry",
    "BriefItem",
    "MemoryBrief",
    "PersonContext",
    "DreamSettings",
    "DreamRun",
    "DreamStatus",
    "DreamResult",
    "CursorPage",
    "MEMORY_SCOPES",
    "MEMORY_CATEGORIES",
    "MEMORY_SOURCES",
    "MEMORY_STATUSES",
    "MEMORY_SEARCH_MODES",
    "MEMORY_HISTORY_EVENTS",
    "PERSON_TYPES",
    "PERSON_STATUSES",
    "PERSON_SORTS",
    "PARTITION_STATUSES",
]
