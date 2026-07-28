"""Context supply: pull prior decisions out of your own agent history.

A worker starts with a clean context by design, which is exactly why the *brief*
has to carry everything. When the goal depends on something already decided in a
past session --- with any agent, not just this one --- the orchestrator searches
for it and folds the result into `context` before the first worker ever spawns.

Wraps `sessions-search` (Claude Code / Codex / opencode / Hermes) if it is on
PATH. Optional: everything else works without it.
"""

from __future__ import annotations

import json
import shutil
import subprocess

AGENTS = ("claude", "codex", "opencode", "hermes")


def available() -> bool:
    return shutil.which("sessions-search") is not None


def _run(args: list[str], timeout: int = 60) -> tuple[int, str, str]:
    try:
        p = subprocess.run(
            ["sessions-search", *args], capture_output=True, text=True, timeout=timeout
        )
        return p.returncode, p.stdout, p.stderr
    except (OSError, subprocess.SubprocessError) as e:
        return 1, "", str(e)


def search(query: str, *, agent: str | None = None, limit: int = 10) -> dict:
    """Ranked sessions across every agent that mention ``query``."""
    if not available():
        return {
            "available": False,
            "error": "sessions-search is not on PATH. Install it from "
            "github.com/luckeyfaraday/sessions-search to search prior sessions.",
            "results": [],
        }
    args: list[str] = []
    if agent:
        if agent not in AGENTS:
            return {"available": True, "error": f"unknown agent {agent!r}", "results": []}
        args += ["--agent", agent]
    args += ["search", query, "--json"]

    code, out, err = _run(args)
    if code != 0:
        return {"available": True, "error": err.strip() or f"exit {code}", "results": []}
    try:
        results = json.loads(out or "[]")
    except json.JSONDecodeError:
        return {"available": True, "error": "could not parse sessions-search output", "results": []}

    trimmed = [
        {
            "agent": r.get("agent"),
            "title": r.get("title"),
            "project": r.get("project"),
            "source_id": r.get("source_id"),
            "match_count": r.get("match_count"),
            "snippet": r.get("snippet"),
        }
        for r in results[:limit]
    ]
    return {"available": True, "query": query, "count": len(trimmed), "results": trimmed}


def show(agent: str, source_id: str, *, max_chars: int = 40_000) -> dict:
    """Full transcript of one session, truncated to something briefable."""
    if not available():
        return {"available": False, "error": "sessions-search is not on PATH", "transcript": ""}
    code, out, err = _run(["show", agent, source_id], timeout=120)
    if code != 0:
        return {"available": True, "error": err.strip() or f"exit {code}", "transcript": ""}
    truncated = len(out) > max_chars
    return {
        "available": True,
        "agent": agent,
        "source_id": source_id,
        "truncated": truncated,
        "transcript": out[:max_chars],
    }


def stats() -> dict:
    if not available():
        return {"available": False}
    code, out, _ = _run(["stats"])
    return {"available": True, "ok": code == 0, "output": out.strip()}
