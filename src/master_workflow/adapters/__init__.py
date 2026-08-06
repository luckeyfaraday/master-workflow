"""Backend registry and reviewer selection."""

from __future__ import annotations

from .base import Adapter
from .claude_code import ClaudeAdapter
from .codex import CodexAdapter
from .grok import GrokAdapter, OpenCodeAdapter
from .kimi import KimiAdapter

REGISTRY: dict[str, Adapter] = {
    a.name: a
    for a in (
        CodexAdapter(),
        GrokAdapter(),
        OpenCodeAdapter(),
        ClaudeAdapter(),
        KimiAdapter(),
    )
}

#: Preference order when the harness picks a reviewer on its own. Ordered by how
#: good each backend is at finding real defects in someone else's diff.
REVIEWER_PREFERENCE = ("codex", "claude", "grok", "opencode", "kimi")


def get(name: str) -> Adapter:
    try:
        return REGISTRY[name]
    except KeyError:
        raise ValueError(
            f"unknown backend {name!r}; known backends: {', '.join(REGISTRY)}"
        ) from None


def available() -> dict[str, dict]:
    out = {}
    for name, ad in REGISTRY.items():
        ok = ad.available()
        out[name] = {
            "available": ok,
            "version": ad.version() if ok else None,
            "strengths": ad.strengths,
            "known_models": list(ad.known_models),
            "supports_variants": ad.supports_variants,
            "known_variants": list(ad.known_variants),
            "supports_read_only": ad.supports_read_only,
            "read_only_enforced": ad.read_only_enforced,
        }
    return out


def pick_reviewer(worker_backend: str, explicit: str | None = None) -> str | None:
    """Choose a reviewer that is not the agent that wrote the code.

    Cross-model review is the point: a model grading its own diff rates it far
    too generously, and the orchestrator's own context already wants the task to
    be finished. An explicit choice always wins, even a same-backend one --- the
    user is allowed to override, and the harness records that they did.
    """
    if explicit:
        return explicit

    def candidates(predicate) -> str | None:
        for name in REVIEWER_PREFERENCE:
            if name == worker_backend:
                continue
            ad = REGISTRY[name]
            if ad.available() and predicate(ad):
                return name
        return None

    # Prefer a reviewer whose read-only mode the OS enforces, then one that
    # merely has editing tools denied, and only then anything else --- but never
    # the worker itself.
    return (
        candidates(lambda a: a.supports_read_only and a.read_only_enforced)
        or candidates(lambda a: a.supports_read_only)
        or candidates(lambda a: True)
    )


__all__ = ["Adapter", "REGISTRY", "get", "available", "pick_reviewer"]
