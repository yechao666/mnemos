"""Mnemos v6.1 Python SDK 公共入口。

::

    from mnemos import MnemosClient, MnemosApiError

    client = MnemosClient(api_key="mnemos_live_…", base_url="http://127.0.0.1:4380")
"""

from .client import (
    DEFAULT_BASE_URL,
    SDK_VERSION,
    MemoriesResource,
    MnemosClient,
    PartitionsResource,
    PersonsResource,
)
from .errors import MnemosApiError, MnemosError, MnemosNetworkError, MnemosTimeoutError
from .types import (
    BriefItem,
    CursorPage,
    DreamResult,
    DreamRun,
    DreamSettings,
    DreamStatus,
    Memory,
    MemoryAddResult,
    MemoryBrief,
    MemoryDetail,
    MemoryHistoryEntry,
    MemorySearchHit,
    MemorySearchResponse,
    MemorySearchSignals,
    Partition,
    PartitionSettings,
    PartitionStats,
    Person,
    PersonContext,
    PersonExport,
    PersonFact,
    PersonMergeResult,
    PersonProfile,
)

__version__ = SDK_VERSION

__all__ = [
    "__version__",
    "SDK_VERSION",
    "DEFAULT_BASE_URL",
    "MnemosClient",
    "PartitionsResource",
    "PersonsResource",
    "MemoriesResource",
    "MnemosError",
    "MnemosApiError",
    "MnemosNetworkError",
    "MnemosTimeoutError",
    "CursorPage",
    "Partition",
    "PartitionSettings",
    "PartitionStats",
    "Person",
    "PersonFact",
    "PersonProfile",
    "PersonMergeResult",
    "PersonExport",
    "PersonContext",
    "Memory",
    "MemoryDetail",
    "MemoryAddResult",
    "MemoryBrief",
    "BriefItem",
    "MemorySearchResponse",
    "MemorySearchHit",
    "MemorySearchSignals",
    "MemoryHistoryEntry",
    "DreamSettings",
    "DreamRun",
    "DreamStatus",
    "DreamResult",
]
