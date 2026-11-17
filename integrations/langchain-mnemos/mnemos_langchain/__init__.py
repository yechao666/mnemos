"""Mnemos × LangChain：可选依赖的 ``BaseStore`` 兼容适配器。"""

from .store import LANGCHAIN_AVAILABLE, MnemosStore

__version__ = "1.0.0"

__all__ = ["MnemosStore", "LANGCHAIN_AVAILABLE", "__version__"]
