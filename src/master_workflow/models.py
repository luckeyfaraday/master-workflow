"""Typed artifacts that flow through the loop.

Everything the harness writes to disk is one of these. Keeping them as plain
dataclasses (no pydantic) means the package installs with zero dependencies and
the MCP layer stays the only thing that needs an extra.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any


def _now() -> float:
    return time.time()


@dataclass
class Brief:
    """A self-contained work order.

    The brief is the product: a worker gets this and nothing else. It never
    inherits the orchestrator's conversation, which is the whole point --- a
    fresh context outperforms a carried-over one.
    """

    task: str
    acceptance_criteria: str
    context: str = ""
    file_scope: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)
    prior_findings: list[str] = field(default_factory=list)
    iteration: int = 1

    def render(self) -> str:
        parts = [
            "# Work order",
            "",
            "You are a worker agent. This brief is complete: everything you need is "
            "below. Do not ask questions --- make reasonable decisions and note them "
            "in your final message.",
            "",
            "## Task",
            self.task.strip(),
            "",
            "## Acceptance criteria",
            "Your work is judged against exactly these. A critical reviewer on a "
            "different model will score the resulting diff from 0-10 and you do not "
            "get to grade yourself.",
            "",
            self.acceptance_criteria.strip(),
        ]
        if self.context.strip():
            parts += ["", "## Context", self.context.strip()]
        if self.file_scope:
            parts += [
                "",
                "## File scope",
                "Confine your edits to these paths. Touching anything else fails review.",
                "",
                *(f"- `{p}`" for p in self.file_scope),
            ]
        if self.constraints:
            parts += ["", "## Constraints", *(f"- {c}" for c in self.constraints)]
        if self.prior_findings:
            parts += [
                "",
                f"## Reviewer findings from iteration {self.iteration - 1}",
                "A previous attempt was scored and rejected. Fix every item below. "
                "These are the reasons the work did not pass; treat them as "
                "additional acceptance criteria.",
                "",
                *(f"{i}. {f}" for i, f in enumerate(self.prior_findings, 1)),
            ]
        parts += [
            "",
            "## Done means",
            "- The acceptance criteria are met in the code, not in your summary.",
            "- You ran whatever check proves it (tests, build, a real invocation).",
            "- Your final message states what you changed, what you verified, and "
            "how, plus anything you deliberately left out.",
        ]
        return "\n".join(parts) + "\n"


@dataclass
class WorkerResult:
    """What came back from one worker CLI invocation."""

    backend: str
    model: str | None
    exit_code: int
    session_id: str | None
    run_dir: str
    last_message: str
    variant: str | None = None
    diff: str = ""
    files_changed: list[str] = field(default_factory=list)
    sandbox: str = "unknown"
    duration_s: float = 0.0
    timed_out: bool = False
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out and self.error is None


@dataclass
class ReviewResult:
    """A critical reviewer's verdict on a worker's diff."""

    score: float
    verdict: str
    findings: list[str] = field(default_factory=list)
    strengths: list[str] = field(default_factory=list)
    reviewer_backend: str = ""
    reviewer_model: str | None = None
    run_dir: str = ""
    raw: str = ""
    parse_ok: bool = True
    #: Set when the reviewer CLI itself failed to run (quota, auth, crash) ---
    #: distinct from a reviewer that ran and gave the work a low score.
    reviewer_error: str | None = None

    @property
    def passed_at(self) -> float:
        return self.score


@dataclass
class Iteration:
    n: int
    brief: dict[str, Any]
    worker: dict[str, Any] | None = None
    review: dict[str, Any] | None = None
    started_at: float = field(default_factory=_now)
    ended_at: float | None = None


@dataclass
class RunState:
    """The durable record of one goal being driven to a passing score."""

    run_id: str
    goal: str
    success_criteria: str
    cwd: str
    threshold: float = 9.0
    max_iterations: int = 5
    worker_backend: str = "codex"
    worker_model: str | None = None
    worker_variant: str | None = None
    reviewer_backend: str | None = None  # None => auto cross-model
    reviewer_model: str | None = None
    file_scope: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)
    context: str = ""
    status: str = "created"  # created|running|passed|failed|exhausted|aborted
    iterations: list[dict[str, Any]] = field(default_factory=list)
    best_score: float = 0.0
    created_at: float = field(default_factory=_now)
    updated_at: float = field(default_factory=_now)
    stop_reason: str | None = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=False)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RunState:
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})
