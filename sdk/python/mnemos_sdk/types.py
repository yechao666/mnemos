"""Mnemos 官方 Python SDK 数据类型。

字段使用 snake_case，与服务端 `/v1/*` 契约一致；`from_dict` 同时兼容服务端
部分接口返回的 camelCase 字段（例如写入接口的 `createdAt`），调用方无需关心差异。
"""

from __future__ import annotations

from collections.abc import Mapping as ABCMapping
from dataclasses import dataclass, field, fields
from typing import Any, Dict, List, Mapping, Optional

JSON = Dict[str, Any]

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
)
VISIBILITIES = ("project", "agent", "task")
MEMORY_STATUSES = ("active", "archived", "deleted")
MEMORY_SOURCES = ("conversation", "api", "agent", "import", "playground")
MEMORY_EVENT_TYPES = ("ADD", "UPDATE", "DELETE", "MERGE", "NOOP")
AGENT_STATUSES = ("active", "idle", "retired")
TASK_STATUSES = ("open", "active", "done", "abandoned")
SECTION_KEYS = (
    "project",
    "conventions",
    "decisions",
    "experience",
    "incidents",
    "agent_notes",
    "open_tasks",
)


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------


def _as_str(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _as_opt_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def _as_float(value: Any, default: float = 0.0) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return default


def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return default


def _as_bool(value: Any, default: bool = False) -> bool:
    return value if isinstance(value, bool) else default


def _as_str_list(value: Any) -> List[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [item for item in value if isinstance(item, str)]


def _as_dict(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, ABCMapping) else {}


def _pick(data: Mapping[str, Any], *keys: str) -> Any:
    """按顺序取第一个非 None 的字段。"""
    for key in keys:
        value = data.get(key)
        if value is not None:
            return value
    return None


def _choice(value: Any, allowed: tuple, default: str) -> str:
    return value if isinstance(value, str) and value in allowed else default


def _opt_num(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


# ---------------------------------------------------------------------------
# 记忆
# ---------------------------------------------------------------------------


@dataclass
class Memory:
    """一条记忆。"""

    id: str
    content: str
    project_id: Optional[str] = None
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    app_id: Optional[str] = None
    task_id: Optional[str] = None
    visibility: str = "project"
    category: str = "fact"
    importance: float = 0.0
    confidence: float = 0.0
    source: str = "api"
    status: str = "active"
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""
    last_accessed_at: Optional[str] = None
    access_count: int = 0
    expires_at: Optional[str] = None

    @property
    def memory(self) -> str:
        """正文别名（服务端列表/检索接口的字段名是 `memory`）。"""
        return self.content

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Memory":
        content = _as_str(_pick(data, "content", "memory") or "")
        return cls(
            id=_as_str(data.get("id")),
            content=content,
            project_id=_as_opt_str(_pick(data, "project_id", "projectId")),
            user_id=_as_opt_str(_pick(data, "user_id", "userId")),
            agent_id=_as_opt_str(_pick(data, "agent_id", "agentId")),
            run_id=_as_opt_str(_pick(data, "run_id", "runId")),
            app_id=_as_opt_str(_pick(data, "app_id", "appId")),
            task_id=_as_opt_str(_pick(data, "task_id", "taskId")),
            visibility=_choice(data.get("visibility"), VISIBILITIES, "project"),
            category=_choice(data.get("category"), MEMORY_CATEGORIES, "fact"),
            importance=_as_float(data.get("importance")),
            confidence=_as_float(data.get("confidence")),
            source=_choice(data.get("source"), MEMORY_SOURCES, "api"),
            status=_choice(data.get("status"), MEMORY_STATUSES, "active"),
            tags=_as_str_list(data.get("tags")),
            metadata=_as_dict(data.get("metadata")),
            created_at=_as_str(_pick(data, "created_at", "createdAt") or ""),
            updated_at=_as_str(_pick(data, "updated_at", "updatedAt") or ""),
            last_accessed_at=_as_opt_str(_pick(data, "last_accessed_at", "lastAccessedAt")),
            access_count=_as_int(_pick(data, "access_count", "accessCount"), 0),
            expires_at=_as_opt_str(_pick(data, "expires_at", "expiresAt")),
        )


@dataclass
class SearchHit(Memory):
    """检索命中：记忆 + 融合分 + 信号分解。"""

    score: float = 0.0
    signals: Dict[str, float] = field(default_factory=dict)
    matched_on: List[str] = field(default_factory=list)
    entities: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "SearchHit":
        base = Memory.from_dict(data)
        return cls(
            **{item.name: getattr(base, item.name) for item in fields(Memory)},
            score=_as_float(data.get("score")),
            signals={
                key: _as_float(value)
                for key, value in _as_dict(data.get("signals")).items()
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            },
            matched_on=_as_str_list(_pick(data, "matched_on", "matchedOn")),
            entities=_as_str_list(data.get("entities")),
        )


@dataclass
class MemoryHistoryEntry:
    """记忆变更历史。"""

    id: str
    memory_id: str
    event: str
    old_content: Optional[str] = None
    new_content: Optional[str] = None
    actor: str = ""
    reason: Optional[str] = None
    created_at: str = ""
    meta: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "MemoryHistoryEntry":
        return cls(
            id=_as_str(data.get("id")),
            memory_id=_as_str(_pick(data, "memory_id", "memoryId") or ""),
            event=_choice(data.get("event"), MEMORY_EVENT_TYPES, "UPDATE"),
            old_content=_as_opt_str(_pick(data, "old_content", "old_memory", "oldContent")),
            new_content=_as_opt_str(_pick(data, "new_content", "new_memory", "newContent")),
            actor=_as_str(data.get("actor")),
            reason=_as_opt_str(data.get("reason")),
            created_at=_as_str(_pick(data, "created_at", "createdAt") or ""),
            meta=_as_dict(data.get("meta")),
        )


@dataclass
class MemoryEvent:
    """写入记忆产生的引擎事件。"""

    type: str
    memory_id: Optional[str]
    content: str
    at: str
    reason: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "MemoryEvent":
        return cls(
            type=_choice(data.get("type"), MEMORY_EVENT_TYPES, "ADD"),
            memory_id=_as_opt_str(_pick(data, "memory_id", "memoryId")),
            content=_as_str(data.get("content")),
            at=_as_str(data.get("at")),
            reason=_as_opt_str(data.get("reason")),
        )


@dataclass
class EntityRef:
    id: str
    name: str
    type: str
    mention_count: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "EntityRef":
        return cls(
            id=_as_str(data.get("id")),
            name=_as_str(data.get("name")),
            type=_as_str(data.get("type")),
            mention_count=_as_int(_pick(data, "mention_count", "mentionCount"), 0),
        )


@dataclass
class Relation:
    id: str
    source_entity_id: str
    target_entity_id: str
    relation: str
    weight: float = 0.0
    memory_id: Optional[str] = None
    created_at: str = ""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Relation":
        return cls(
            id=_as_str(data.get("id")),
            source_entity_id=_as_str(_pick(data, "source_entity_id", "sourceEntityId") or ""),
            target_entity_id=_as_str(_pick(data, "target_entity_id", "targetEntityId") or ""),
            relation=_as_str(data.get("relation")),
            weight=_as_float(data.get("weight")),
            memory_id=_as_opt_str(_pick(data, "memory_id", "memoryId")),
            created_at=_as_str(_pick(data, "created_at", "createdAt") or ""),
        )


@dataclass
class MemoryDetail(Memory):
    """记忆详情：正文 + 历史 + 实体 + 关系。"""

    history: List[MemoryHistoryEntry] = field(default_factory=list)
    entities: List[EntityRef] = field(default_factory=list)
    relations: List[Relation] = field(default_factory=list)
    neighbors: List[EntityRef] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "MemoryDetail":
        base = Memory.from_dict(data)
        return cls(
            **{item.name: getattr(base, item.name) for item in fields(Memory)},
            history=[MemoryHistoryEntry.from_dict(item) for item in data.get("history") or []],
            entities=[EntityRef.from_dict(item) for item in data.get("entities") or []],
            relations=[Relation.from_dict(item) for item in data.get("relations") or []],
            neighbors=[EntityRef.from_dict(item) for item in data.get("neighbors") or []],
        )


# ---------------------------------------------------------------------------
# Agent / 任务 / 简报
# ---------------------------------------------------------------------------


@dataclass
class AgentStats:
    memories: int = 0
    private_memories: int = 0
    tasks: int = 0
    last_task_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentStats":
        return cls(
            memories=_as_int(data.get("memories"), 0),
            private_memories=_as_int(_pick(data, "private_memories", "privateMemories"), 0),
            tasks=_as_int(data.get("tasks"), 0),
            last_task_at=_as_opt_str(_pick(data, "last_task_at", "lastTaskAt")),
        )


@dataclass
class Agent:
    id: str
    name: str
    project_id: Optional[str] = None
    role: str = ""
    model: str = ""
    description: str = ""
    capabilities: List[str] = field(default_factory=list)
    status: str = "active"
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    last_active_at: Optional[str] = None
    stats: AgentStats = field(default_factory=AgentStats)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Agent":
        return cls(
            id=_as_str(data.get("id")),
            name=_as_str(data.get("name")),
            project_id=_as_opt_str(_pick(data, "project_id", "projectId")),
            role=_as_str(data.get("role")),
            model=_as_str(data.get("model")),
            description=_as_str(data.get("description")),
            capabilities=_as_str_list(data.get("capabilities")),
            status=_choice(data.get("status"), AGENT_STATUSES, "active"),
            metadata=_as_dict(data.get("metadata")),
            created_at=_as_str(_pick(data, "created_at", "createdAt") or ""),
            last_active_at=_as_opt_str(_pick(data, "last_active_at", "lastActiveAt")),
            stats=AgentStats.from_dict(_as_dict(data.get("stats"))),
        )


@dataclass
class Task:
    id: str
    title: str
    project_id: Optional[str] = None
    goal: str = ""
    status: str = "open"
    owner_agent_id: Optional[str] = None
    owner_agent_name: Optional[str] = None
    branch: Optional[str] = None
    summary: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    started_at: str = ""
    ended_at: Optional[str] = None
    memory_count: int = 0
    agent_count: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Task":
        return cls(
            id=_as_str(data.get("id")),
            title=_as_str(data.get("title")),
            project_id=_as_opt_str(_pick(data, "project_id", "projectId")),
            goal=_as_str(data.get("goal")),
            status=_choice(data.get("status"), TASK_STATUSES, "open"),
            owner_agent_id=_as_opt_str(_pick(data, "owner_agent_id", "ownerAgentId")),
            owner_agent_name=_as_opt_str(_pick(data, "owner_agent_name", "ownerAgentName")),
            branch=_as_opt_str(data.get("branch")),
            summary=_as_opt_str(data.get("summary")),
            metadata=_as_dict(data.get("metadata")),
            created_at=_as_str(_pick(data, "created_at", "createdAt") or ""),
            started_at=_as_str(_pick(data, "started_at", "startedAt") or ""),
            ended_at=_as_opt_str(_pick(data, "ended_at", "endedAt")),
            memory_count=_as_int(_pick(data, "memory_count", "memoryCount"), 0),
            agent_count=_as_int(_pick(data, "agent_count", "agentCount"), 0),
        )


@dataclass
class BriefingSection:
    key: str
    title: str
    description: str = ""
    hits: List[SearchHit] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "BriefingSection":
        return cls(
            key=_choice(data.get("key"), SECTION_KEYS, "project"),
            title=_as_str(data.get("title")),
            description=_as_str(data.get("description")),
            hits=[SearchHit.from_dict(item) for item in data.get("hits") or []],
        )


@dataclass
class Briefing:
    """任务简报：`prompt` 可直接拼进 system prompt。"""

    project: Dict[str, str] = field(default_factory=dict)
    sections: List[BriefingSection] = field(default_factory=list)
    prompt: str = ""
    token_estimate: int = 0
    citations: List[str] = field(default_factory=list)
    built_at: str = ""
    took_ms: float = 0.0
    agent: Optional[Agent] = None
    task: Optional[Task] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Briefing":
        project_raw = _as_dict(data.get("project"))
        return cls(
            project={
                "id": _as_str(project_raw.get("id")),
                "name": _as_str(project_raw.get("name")),
                "description": _as_str(project_raw.get("description")),
            },
            sections=[BriefingSection.from_dict(item) for item in data.get("sections") or []],
            prompt=_as_str(data.get("prompt")),
            token_estimate=_as_int(_pick(data, "token_estimate", "tokenEstimate"), 0),
            citations=_as_str_list(data.get("citations")),
            built_at=_as_str(_pick(data, "built_at", "builtAt") or ""),
            took_ms=_as_float(_pick(data, "took_ms", "tookMs")),
            agent=Agent.from_dict(data["agent"]) if isinstance(data.get("agent"), ABCMapping) else None,
            task=Task.from_dict(data["task"]) if isinstance(data.get("task"), ABCMapping) else None,
        )


# ---------------------------------------------------------------------------
# 图谱 / 统计 / 健康
# ---------------------------------------------------------------------------


@dataclass
class GraphNode:
    id: str
    label: str
    type: str
    weight: float = 0.0
    memories: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "GraphNode":
        return cls(
            id=_as_str(data.get("id")),
            label=_as_str(data.get("label")),
            type=_as_str(data.get("type")),
            weight=_as_float(data.get("weight")),
            memories=_as_int(data.get("memories"), 0),
        )


@dataclass
class GraphEdge:
    id: str
    source: str
    target: str
    relation: str
    weight: float = 0.0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "GraphEdge":
        return cls(
            id=_as_str(data.get("id")),
            source=_as_str(data.get("source")),
            target=_as_str(data.get("target")),
            relation=_as_str(data.get("relation")),
            weight=_as_float(data.get("weight")),
        )


@dataclass
class GraphData:
    nodes: List[GraphNode] = field(default_factory=list)
    edges: List[GraphEdge] = field(default_factory=list)
    stats: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "GraphData":
        return cls(
            nodes=[GraphNode.from_dict(item) for item in data.get("nodes") or []],
            edges=[GraphEdge.from_dict(item) for item in data.get("edges") or []],
            stats=_as_dict(data.get("stats")),
        )


@dataclass
class ProjectMetrics:
    total_memories: int = 0
    users: int = 0
    agents: int = 0
    entities: int = 0
    relations: int = 0
    searches_7d: int = 0
    adds_7d: int = 0
    tokens_saved: int = 0
    storage_bytes: int = 0
    quota_used_pct: float = 0.0
    recall_p50_ms: float = 0.0
    recall_p95_ms: float = 0.0
    hit_rate: float = 0.0
    growth_pct: float = 0.0
    last_activity_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ProjectMetrics":
        return cls(
            total_memories=_as_int(_pick(data, "total_memories", "totalMemories"), 0),
            users=_as_int(data.get("users"), 0),
            agents=_as_int(data.get("agents"), 0),
            entities=_as_int(data.get("entities"), 0),
            relations=_as_int(data.get("relations"), 0),
            searches_7d=_as_int(_pick(data, "searches_7d", "searches7d"), 0),
            adds_7d=_as_int(_pick(data, "adds_7d", "adds7d"), 0),
            tokens_saved=_as_int(_pick(data, "tokens_saved", "tokensSaved"), 0),
            storage_bytes=_as_int(_pick(data, "storage_bytes", "storageBytes"), 0),
            quota_used_pct=_as_float(_pick(data, "quota_used_pct", "quotaUsedPct")),
            recall_p50_ms=_as_float(_pick(data, "recall_p50_ms", "recallP50Ms")),
            recall_p95_ms=_as_float(_pick(data, "recall_p95_ms", "recallP95Ms")),
            hit_rate=_as_float(_pick(data, "hit_rate", "hitRate")),
            growth_pct=_as_float(_pick(data, "growth_pct", "growthPct")),
            last_activity_at=_as_opt_str(_pick(data, "last_activity_at", "lastActivityAt")),
        )


@dataclass
class HealthResponse:
    ok: bool = False
    version: str = ""
    uptime_ms: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "HealthResponse":
        return cls(
            ok=_as_bool(data.get("ok")),
            version=_as_str(data.get("version")),
            uptime_ms=_as_int(_pick(data, "uptime_ms", "uptimeMs"), 0),
        )


# ---------------------------------------------------------------------------
# Webhook（beta）
# ---------------------------------------------------------------------------


@dataclass
class Webhook:
    """Webhook 订阅（**beta**）。"""

    id: str
    name: str
    url: str
    project_id: Optional[str] = None
    secret: Optional[str] = None
    event_types: List[str] = field(default_factory=list)
    enabled: bool = True
    description: str = ""
    created_by: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    last_delivery_at: Optional[str] = None
    last_status: Optional[int] = None
    failure_count: int = 0
    disabled_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Webhook":
        last_status = _pick(data, "last_status", "lastStatus")
        return cls(
            id=_as_str(data.get("id")),
            name=_as_str(data.get("name")),
            url=_as_str(data.get("url")),
            project_id=_as_opt_str(_pick(data, "project_id", "projectId")),
            secret=_as_opt_str(data.get("secret")),
            event_types=_as_str_list(_pick(data, "event_types", "eventTypes")),
            enabled=_as_bool(data.get("enabled"), True),
            description=_as_str(data.get("description")),
            created_by=_as_opt_str(_pick(data, "created_by", "createdBy")),
            created_at=_as_str(_pick(data, "created_at", "createdAt") or ""),
            updated_at=_as_str(_pick(data, "updated_at", "updatedAt") or ""),
            last_delivery_at=_as_opt_str(_pick(data, "last_delivery_at", "lastDeliveryAt")),
            last_status=int(last_status) if isinstance(last_status, int) else None,
            failure_count=_as_int(_pick(data, "failure_count", "failureCount"), 0),
            disabled_at=_as_opt_str(_pick(data, "disabled_at", "disabledAt")),
        )


@dataclass
class WebhookDelivery:
    id: str
    webhook_id: str = ""
    project_id: Optional[str] = None
    event_type: str = ""
    event_id: Optional[str] = None
    status: str = ""
    attempts: int = 0
    max_attempts: int = 6
    next_attempt_at: Optional[str] = None
    response_status: Optional[int] = None
    response_body: Optional[str] = None
    latency_ms: Optional[float] = None
    error: Optional[str] = None
    created_at: str = ""
    delivered_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "WebhookDelivery":
        response_status = _pick(data, "response_status", "responseStatus")
        return cls(
            id=_as_str(data.get("id")),
            webhook_id=_as_str(_pick(data, "webhook_id", "webhookId") or ""),
            project_id=_as_opt_str(_pick(data, "project_id", "projectId")),
            event_type=_as_str(_pick(data, "event_type", "eventType") or ""),
            event_id=_as_opt_str(_pick(data, "event_id", "eventId")),
            status=_as_str(data.get("status")),
            attempts=_as_int(data.get("attempts"), 0),
            max_attempts=_as_int(_pick(data, "max_attempts", "maxAttempts"), 6),
            next_attempt_at=_as_opt_str(_pick(data, "next_attempt_at", "nextAttemptAt")),
            response_status=int(response_status) if isinstance(response_status, int) else None,
            response_body=_as_opt_str(_pick(data, "response_body", "responseBody")),
            latency_ms=_opt_num(_pick(data, "latency_ms", "latencyMs")),
            error=_as_opt_str(data.get("error")),
            created_at=_as_str(_pick(data, "created_at", "createdAt") or ""),
            delivered_at=_as_opt_str(_pick(data, "delivered_at", "deliveredAt")),
        )


# ---------------------------------------------------------------------------
# 导出 / 导入
# ---------------------------------------------------------------------------


@dataclass
class ProjectExport:
    """`mnemos-export/v1` 导出文档（已归一化为 snake_case 模型）。"""

    format: str
    exported_at: str
    project: Dict[str, str]
    memories: List[Memory]
    agents: List[Agent] = field(default_factory=list)
    tasks: List[Task] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ProjectExport":
        project = _as_dict(data.get("project"))
        return cls(
            format=_as_str(data.get("format"), "mnemos-export/v1"),
            exported_at=_as_str(_pick(data, "exported_at", "exportedAt") or ""),
            project={
                "id": _as_str(project.get("id")),
                "slug": _as_str(project.get("slug")),
                "name": _as_str(project.get("name")),
            },
            memories=[Memory.from_dict(item) for item in data.get("memories") or []],
            agents=[Agent.from_dict(item) for item in data.get("agents") or []],
            tasks=[Task.from_dict(item) for item in data.get("tasks") or []],
        )


@dataclass
class ImportErrorItem:
    index: int
    message: str

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ImportErrorItem":
        return cls(index=_as_int(data.get("index"), 0), message=_as_str(data.get("message")))


@dataclass
class ImportResult:
    imported: int = 0
    skipped: int = 0
    failed: int = 0
    errors: List[ImportErrorItem] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ImportResult":
        return cls(
            imported=_as_int(data.get("imported"), 0),
            skipped=_as_int(data.get("skipped"), 0),
            failed=_as_int(data.get("failed"), 0),
            errors=[ImportErrorItem.from_dict(item) for item in data.get("errors") or []],
        )


# ---------------------------------------------------------------------------
# 响应容器
# ---------------------------------------------------------------------------


@dataclass
class AddMemoryResponse:
    results: List[Memory] = field(default_factory=list)
    events: List[MemoryEvent] = field(default_factory=list)
    took_ms: float = 0.0
    extracted: int = 0
    merged: int = 0
    skipped: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AddMemoryResponse":
        return cls(
            results=[Memory.from_dict(item) for item in data.get("results") or []],
            events=[MemoryEvent.from_dict(item) for item in data.get("events") or []],
            took_ms=_as_float(_pick(data, "took_ms", "tookMs")),
            extracted=_as_int(data.get("extracted"), 0),
            merged=_as_int(data.get("merged"), 0),
            skipped=_as_int(data.get("skipped"), 0),
        )


@dataclass
class SearchResponse:
    results: List[SearchHit] = field(default_factory=list)
    total: int = 0
    took_ms: float = 0.0
    signals: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "SearchResponse":
        results = [SearchHit.from_dict(item) for item in data.get("results") or []]
        return cls(
            results=results,
            total=_as_int(data.get("total"), len(results)),
            took_ms=_as_float(_pick(data, "took_ms", "tookMs")),
            signals=_as_dict(data.get("signals")),
        )


@dataclass
class MemoryListResponse:
    results: List[Memory] = field(default_factory=list)
    count: int = 0
    page: int = 1
    page_size: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "MemoryListResponse":
        results = [Memory.from_dict(item) for item in data.get("results") or []]
        return cls(
            results=results,
            count=_as_int(data.get("count"), len(results)),
            page=_as_int(data.get("page"), 1),
            page_size=_as_int(_pick(data, "page_size", "pageSize"), len(results)),
        )


@dataclass
class MemoryHistoryResponse:
    results: List[MemoryHistoryEntry] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "MemoryHistoryResponse":
        return cls(results=[MemoryHistoryEntry.from_dict(item) for item in data.get("results") or []])


@dataclass
class AgentListResponse:
    results: List[Agent] = field(default_factory=list)
    count: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AgentListResponse":
        results = [Agent.from_dict(item) for item in data.get("results") or []]
        return cls(results=results, count=_as_int(data.get("count"), len(results)))


@dataclass
class TaskListResponse:
    results: List[Task] = field(default_factory=list)
    count: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "TaskListResponse":
        results = [Task.from_dict(item) for item in data.get("results") or []]
        return cls(results=results, count=_as_int(data.get("count"), len(results)))


@dataclass
class TaskFinishResponse:
    task: Task
    memories: List[Memory] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "TaskFinishResponse":
        return cls(
            task=Task.from_dict(_as_dict(data.get("task"))),
            memories=[Memory.from_dict(item) for item in data.get("memories") or []],
        )


@dataclass
class WebhookListResponse:
    results: List[Webhook] = field(default_factory=list)
    count: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "WebhookListResponse":
        results = [Webhook.from_dict(item) for item in data.get("results") or []]
        return cls(results=results, count=_as_int(data.get("count"), len(results)))


@dataclass
class WebhookDeliveryListResponse:
    items: List[WebhookDelivery] = field(default_factory=list)
    page: int = 1
    page_size: int = 0
    total: int = 0
    total_pages: int = 1

    @property
    def results(self) -> List[WebhookDelivery]:
        """兼容列表风格的别名，等价于 ``items``。"""
        return self.items

    @property
    def count(self) -> int:
        return self.total

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "WebhookDeliveryListResponse":
        raw_items = data.get("items")
        if not isinstance(raw_items, list):
            raw_items = data.get("results") or []
        items = [WebhookDelivery.from_dict(item) for item in raw_items]
        return cls(
            items=items,
            page=_as_int(data.get("page"), 1),
            page_size=_as_int(_pick(data, "page_size", "pageSize"), len(items)),
            total=_as_int(data.get("total"), len(items)),
            total_pages=_as_int(_pick(data, "total_pages", "totalPages"), 1),
        )


@dataclass
class StatsResponse:
    metrics: ProjectMetrics = field(default_factory=ProjectMetrics)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "StatsResponse":
        return cls(metrics=ProjectMetrics.from_dict(_as_dict(data.get("metrics"))))


@dataclass
class MutationResult:
    message: str = "ok"
    ok: Optional[bool] = None
    deleted: Optional[int] = None
    affected: Optional[int] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "MutationResult":
        deleted = data.get("deleted")
        affected = data.get("affected")
        ok = data.get("ok")
        return cls(
            message=_as_str(data.get("message"), "ok"),
            ok=ok if isinstance(ok, bool) else None,
            deleted=int(deleted) if isinstance(deleted, int) else None,
            affected=int(affected) if isinstance(affected, int) else None,
        )
