"""Mnemos 官方 Python SDK。

零第三方依赖（标准库 ``urllib`` + ``json`` + ``dataclasses``），Python >= 3.9。

快速开始::

    from mnemos_sdk import MnemosClient

    client = MnemosClient("mnemos_live_demo_atlas_ci")
    added = client.memories.add(
        text="周野偏好用中文写评审意见",
        user_id="dev-zhouye",
        metadata={"channel": "sdk-python"},
    )
    hits = client.memories.search("评审偏好", user_id="dev-zhouye", top_k=5)
"""

from .client import (
    DEFAULT_BASE_URL,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT,
    SDK_VERSION,
    AgentsResource,
    ContextResource,
    MemoriesResource,
    MnemosClient,
    TasksResource,
    WebhooksResource,
)
from .errors import MnemosApiError
from .types import (
    AddMemoryResponse,
    Agent,
    AgentListResponse,
    AgentStats,
    Briefing,
    BriefingSection,
    EntityRef,
    GraphData,
    GraphEdge,
    GraphNode,
    HealthResponse,
    ImportErrorItem,
    ImportResult,
    Memory,
    MemoryDetail,
    MemoryEvent,
    MemoryHistoryEntry,
    MemoryHistoryResponse,
    MemoryListResponse,
    MutationResult,
    ProjectExport,
    ProjectMetrics,
    Relation,
    SearchHit,
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

__version__ = SDK_VERSION

__all__ = [
    # 客户端与错误
    "MnemosClient",
    "MnemosApiError",
    "MemoriesResource",
    "AgentsResource",
    "TasksResource",
    "ContextResource",
    "WebhooksResource",
    "DEFAULT_BASE_URL",
    "DEFAULT_MAX_RETRIES",
    "DEFAULT_TIMEOUT",
    "SDK_VERSION",
    "__version__",
    # 模型
    "Memory",
    "MemoryDetail",
    "MemoryEvent",
    "MemoryHistoryEntry",
    "MemoryHistoryResponse",
    "MemoryListResponse",
    "SearchHit",
    "SearchResponse",
    "AddMemoryResponse",
    "Agent",
    "AgentStats",
    "AgentListResponse",
    "Task",
    "TaskListResponse",
    "TaskFinishResponse",
    "Briefing",
    "BriefingSection",
    "EntityRef",
    "Relation",
    "GraphData",
    "GraphNode",
    "GraphEdge",
    "ProjectMetrics",
    "StatsResponse",
    "HealthResponse",
    "Webhook",
    "WebhookDelivery",
    "WebhookListResponse",
    "WebhookDeliveryListResponse",
    "ProjectExport",
    "ImportResult",
    "ImportErrorItem",
    "MutationResult",
]
