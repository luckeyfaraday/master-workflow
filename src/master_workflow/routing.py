"""Backend suggestion.

Advisory only. The user's explicit choice always wins --- this exists so the
orchestrator has something defensible to *recommend* when the user says "you
pick", and so the reasoning behind a route is written to the ledger instead of
living in a model's head.
"""

from __future__ import annotations

import re

from . import adapters

SIGNALS: dict[str, tuple[tuple[str, int], ...]] = {
    "codex": (
        (r"\b(backend|server[- ]side|api|endpoint|route handler)\b", 3),
        (r"\b(database|db|sql|postgres|sqlite|mysql|schema|migration)\b", 3),
        (r"\b(auth|authn|authz|oauth|jwt|session|token|password|crypto|security)\b", 3),
        (r"\b(infra|infrastructure|terraform|kubernetes|docker|deploy)\b", 2),
        (r"\b(race condition|concurrency|deadlock|memory leak|performance)\b", 2),
        (r"\b(root cause|investigate|debug|why is|intermittent|flaky)\b", 2),
        (r"\b(architecture|design the|protocol|state machine|algorithm)\b", 2),
    ),
    "grok": (
        (r"\b(refactor|rename|migrate|bulk|sweep|across (all|every)|codemod)\b", 3),
        (r"\b(boilerplate|scaffold|generate|stub out|repetitive)\b", 3),
        (r"\b(lint|format|type errors|test failures|fix all|cleanup)\b", 2),
        (r"\b(ci|github actions|workflow file|build config|dependency upgrade)\b", 2),
        (r"\b(fast|quick|quickly|throughput|many files)\b", 2),
    ),
    "claude": (
        (r"\b(ui|ux|frontend|front[- ]end|component|layout|css|tailwind|styling)\b", 3),
        (r"\b(design|visual|animation|render|canvas|webgl|shader|svg)\b", 3),
        (r"\b(accessibility|a11y|responsive|dark mode|typography)\b", 2),
        (r"\b(copy|wording|docs|readme|write[- ]up|explain)\b", 2),
    ),
    "kimi": (
        (r"\b(react|vue|svelte|next\.js|component library|storybook)\b", 2),
    ),
    "opencode": (
        (r"\b(openrouter|open router|specific model|try (a|another) model|compare models)\b", 4),
        (r"\b(cheap|cheaply|local model|ollama|deepseek|qwen|glm|minimax)\b", 3),
    ),
}


def suggest(task: str, *, only_available: bool = True) -> dict:
    """Score the task against each backend's signals and recommend one."""
    text = task.lower()
    avail = adapters.available()
    scores: dict[str, int] = {}
    hits: dict[str, list[str]] = {}

    for backend, patterns in SIGNALS.items():
        if only_available and not avail[backend]["available"]:
            continue
        total = 0
        matched: list[str] = []
        for pattern, weight in patterns:
            m = re.search(pattern, text)
            if m:
                total += weight
                matched.append(m.group(0))
        scores[backend] = total
        hits[backend] = matched

    if not scores:
        return {
            "recommended": None,
            "reason": "No supported agent CLI is installed.",
            "scores": {},
            "alternatives": [],
        }

    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    top, top_score = ranked[0]

    if top_score == 0:
        # Nothing matched. Default to the strongest general implementer that is
        # installed rather than inventing a justification.
        for name in ("codex", "claude", "grok", "opencode", "kimi"):
            if avail[name]["available"]:
                return {
                    "recommended": name,
                    "reason": (
                        "No strong domain signal in the task description; defaulting to "
                        f"{name}. Say which backend you want if this is wrong."
                    ),
                    "scores": scores,
                    "alternatives": [n for n, _ in ranked[1:3]],
                    "confidence": "low",
                }

    return {
        "recommended": top,
        "reason": (
            f"Task mentions {', '.join(repr(h) for h in hits[top][:4])} — "
            f"{adapters.REGISTRY[top].strengths.split('.')[0].lower()}."
        ),
        "scores": scores,
        "alternatives": [n for n, s in ranked[1:3] if s > 0],
        "confidence": "high" if top_score >= 5 else "medium",
    }


def routing_table() -> list[dict]:
    """The suggestion cheat-sheet the orchestrator shows the user."""
    avail = adapters.available()
    return [
        {
            "backend": name,
            "available": avail[name]["available"],
            "version": avail[name]["version"],
            "good_for": adapters.REGISTRY[name].strengths,
            "known_models": list(adapters.REGISTRY[name].known_models),
            "can_review": avail[name]["supports_read_only"],
            "review_sandbox": "os-enforced"
            if avail[name]["read_only_enforced"]
            else ("tool-denied" if avail[name]["supports_read_only"] else "none"),
        }
        for name in ("codex", "grok", "claude", "opencode", "kimi")
    ]
