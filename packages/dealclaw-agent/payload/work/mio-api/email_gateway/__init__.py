"""DealClaw multi-account email gateway.

The package deliberately keeps transport code deterministic so it can run from
an OpenClaw command cron without starting a model-backed agent turn.
"""

from .providers import PROVIDERS, ProviderConfig, get_provider
from .store import EmailStore

__all__ = ["EmailStore", "PROVIDERS", "ProviderConfig", "get_provider"]
