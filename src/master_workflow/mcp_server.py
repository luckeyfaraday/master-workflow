"""MCP server exposing the worker seam and the review loop.

Tool surface, in the order an orchestrator normally uses it:

    worker_status          what is installed, what each backend is good at
    suggest_backend        advisory route for a task description
    search_sessions/show   pull prior decisions out of past agent sessions
    workflow_create        register a goal + criteria + routing
    workflow_iterate       one worker -> reviewer cycle (the primary driver)
    workflow_run_background  hand the whole loop off and poll
    workflow_status/ledger/list/abort
    delegate               one-shot worker run, no loop, for bounded errands
"""

from __future__ import annotations

import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any

from . import adapters, context, loop, routing, rundir
from .models import Brief

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as e:  # pragma: no cover
    raise SystemExit(
        "The MCP server needs the `mcp` package:\n"
        "    pip install 'master-workflow[mcp]'\n"
        "or run it with: uvx --from . --with mcp master-workflow-mcp"
    ) from e

mcp = FastMCP("master-workflow")

_threads: dict[str, threading.Thread] = {}


# --- discovery --------------------------------------------------------------


@mcp.tool()
def worker_status() -> dict:
    """Which agent backends are installed, and what each is good at.

    Call this before proposing a route so the suggestion reflects what is
    actually on this machine.
    """
    table = routing.routing_table()
    return {
        "backends": table,
        "installed": [b["backend"] for b in table if b["available"]],
        "can_review": [b["backend"] for b in table if b["available"] and b["can_review"]],
        "sessions_search": context.available(),
        "runs_dir": str(rundir.runs_root()),
        "note": (
            "Reviewer is chosen automatically as a backend different from the "
            "worker. Cross-model review is deliberate: a model grading its own "
            "diff scores it far too generously."
        ),
    }


@mcp.tool()
def suggest_backend(task: str) -> dict:
    """Recommend a worker backend for a task description. Advisory only.

    The user's explicit choice always wins. Use this when they say "you pick".
    """
    return routing.suggest(task)


# --- context ----------------------------------------------------------------


@mcp.tool()
def search_sessions(query: str, agent: str | None = None, limit: int = 10) -> dict:
    """Full-text search across Claude Code, Codex, opencode, and Hermes sessions.

    Use before writing a brief when the goal depends on a decision made in an
    earlier session. Workers start with a clean context, so anything they need
    has to travel in the brief --- this is how you find it.

    Args:
        query: Words to search for. Quote a phrase for an exact match.
        agent: Restrict to one of claude, codex, opencode, hermes.
        limit: Maximum sessions to return.
    """
    return context.search(query, agent=agent, limit=limit)


@mcp.tool()
def show_session(agent: str, source_id: str) -> dict:
    """Print one full session transcript, found via search_sessions."""
    return context.show(agent, source_id)


# --- the loop ---------------------------------------------------------------


@mcp.tool()
def workflow_create(
    goal: str,
    success_criteria: str,
    cwd: str,
    worker_backend: str = "codex",
    worker_model: str | None = None,
    reviewer_backend: str | None = None,
    reviewer_model: str | None = None,
    threshold: float = 9.0,
    max_iterations: int = 5,
    file_scope: list[str] | None = None,
    constraints: list[str] | None = None,
    context_notes: str = "",
) -> dict:
    """Register a goal and its routing. Returns a run_id; runs nothing yet.

    Args:
        goal: What must be built or fixed, in full. This becomes the worker's task.
        success_criteria: How the reviewer decides it is done. Be concrete and
            checkable --- these are the only thing the score is measured against.
        cwd: Repository the workers run in. A git repo, so diffs can be captured.
        worker_backend: codex | grok | opencode | claude | kimi.
        worker_model: Optional model override, e.g. gpt-5.6-sol, grok-build-0.1,
            or a provider/model string for opencode.
        reviewer_backend: Leave null to auto-pick a backend different from the
            worker. Set it to pin a specific reviewer.
        threshold: Score the reviewer must give to stop. Default 9.0 of 10.
        max_iterations: Hard budget on worker -> review cycles.
        file_scope: Paths the worker may edit. Editing outside them fails review.
        constraints: Extra rules for the worker (e.g. "no new dependencies").
        context_notes: Background to put in the brief --- prior decisions, links,
            findings from search_sessions.
    """
    state = loop.create_run(
        goal=goal,
        success_criteria=success_criteria,
        cwd=cwd,
        worker_backend=worker_backend,
        worker_model=worker_model,
        reviewer_backend=reviewer_backend,
        reviewer_model=reviewer_model,
        threshold=threshold,
        max_iterations=max_iterations,
        file_scope=file_scope,
        constraints=constraints,
        context=context_notes,
    )
    reviewer = adapters.pick_reviewer(worker_backend, reviewer_backend)
    return {
        "run_id": state.run_id,
        "run_dir": str(rundir.run_path(state.run_id)),
        "worker": {"backend": worker_backend, "model": worker_model},
        "reviewer": {"backend": reviewer, "model": reviewer_model, "auto": reviewer_backend is None},
        "threshold": threshold,
        "max_iterations": max_iterations,
        "git": rundir.is_git_repo(Path(state.cwd)),
        "next": "Call workflow_iterate(run_id) to run the first worker -> review cycle.",
    }


@mcp.tool()
def workflow_iterate(
    run_id: str,
    carry_session: bool = False,
    worker_timeout: int = 1800,
    review_timeout: int = 1200,
) -> dict:
    """Run exactly one worker -> critical-reviewer cycle. Blocks until scored.

    This is the primary driver: call it, read the score and findings, tell the
    user, call it again. Findings from the last review are folded into the next
    brief automatically.

    Args:
        run_id: From workflow_create.
        carry_session: Continue the previous worker session instead of spawning a
            fresh one. Default false --- a clean context reads reviewer findings as
            requirements, while a context that already argued for the failed
            attempt tends to defend it.
        worker_timeout: Seconds before the worker is killed.
        review_timeout: Seconds before the reviewer is killed.
    """
    return loop.iterate(
        run_id,
        carry_session=carry_session,
        worker_timeout=worker_timeout,
        review_timeout=review_timeout,
    )


@mcp.tool()
def workflow_run_background(
    run_id: str,
    max_iterations: int | None = None,
    carry_session: bool = False,
) -> dict:
    """Run the full loop to threshold in the background. Returns immediately.

    Poll workflow_status(run_id) for progress. Use this for long grinds; use
    workflow_iterate when you want to inspect each round yourself.
    """
    if run_id in _threads and _threads[run_id].is_alive():
        return {"run_id": run_id, "started": False, "reason": "already running"}

    def _work() -> None:
        try:
            loop.run_loop(run_id, max_iterations=max_iterations, carry_session=carry_session)
        except Exception as e:  # noqa: BLE001 - record, never crash the server
            rundir.ledger(run_id, "error", message=str(e))
            try:
                st = rundir.read_state(run_id)
                st.status, st.stop_reason = "failed", str(e)
                rundir.write_state(st)
            except (OSError, FileNotFoundError):
                pass

    t = threading.Thread(target=_work, name=f"mw-{run_id}", daemon=True)
    _threads[run_id] = t
    t.start()
    return {
        "run_id": run_id,
        "started": True,
        "poll": "workflow_status(run_id)",
    }


@mcp.tool()
def workflow_status(run_id: str) -> dict:
    """Current state of a run: status, best score, and every iteration's verdict."""
    state = rundir.read_state(run_id)
    return {
        "run_id": state.run_id,
        "goal": state.goal,
        "status": state.status,
        "stop_reason": state.stop_reason,
        "best_score": state.best_score,
        "threshold": state.threshold,
        "iterations_run": len(state.iterations),
        "max_iterations": state.max_iterations,
        "running": bool(_threads.get(run_id) and _threads[run_id].is_alive()),
        "history": [
            {
                "n": it["n"],
                "score": (it.get("review") or {}).get("score"),
                "reviewer": (it.get("review") or {}).get("reviewer_backend"),
                "verdict": (it.get("review") or {}).get("verdict"),
                "findings": (it.get("review") or {}).get("findings", []),
                "files_changed": (it.get("worker") or {}).get("files_changed", []),
                "worker_exit": (it.get("worker") or {}).get("exit_code"),
            }
            for it in state.iterations
        ],
        "run_dir": str(rundir.run_path(run_id)),
    }


@mcp.tool()
def workflow_list(limit: int = 20) -> dict:
    """List recent runs, newest first."""
    return {"runs": rundir.list_runs(limit)}


@mcp.tool()
def workflow_ledger(run_id: str) -> dict:
    """The append-only audit log for a run: every start, score, warning, decision."""
    return {"run_id": run_id, "events": rundir.read_ledger(run_id)}


@mcp.tool()
def workflow_abort(run_id: str, reason: str = "aborted by user") -> dict:
    """Stop a run. A background loop finishes its current cycle, then stops."""
    state = rundir.read_state(run_id)
    state.status, state.stop_reason = "aborted", reason
    rundir.write_state(state)
    rundir.ledger(run_id, "run.aborted", reason=reason)
    return {"run_id": run_id, "status": "aborted", "reason": reason}


@mcp.tool()
def workflow_diff(run_id: str, iteration: int | None = None, max_chars: int = 60_000) -> dict:
    """The actual diff a worker produced, so you can review it yourself.

    Defaults to the most recent iteration. Read this rather than trusting the
    worker's summary of what it did.
    """
    state = rundir.read_state(run_id)
    if not state.iterations:
        return {"run_id": run_id, "diff": "", "note": "no iterations have run yet"}
    n = iteration or state.iterations[-1]["n"]
    f = rundir.run_path(run_id) / "iterations" / f"{n:02d}" / "worker" / "diff.patch"
    if not f.exists():
        return {"run_id": run_id, "iteration": n, "diff": "", "note": "no diff captured"}
    text = f.read_text()
    return {
        "run_id": run_id,
        "iteration": n,
        "truncated": len(text) > max_chars,
        "diff": text[:max_chars],
    }


# --- the worker seam, without the loop --------------------------------------


@mcp.tool()
def delegate(
    task: str,
    cwd: str,
    backend: str = "codex",
    acceptance_criteria: str = "",
    model: str | None = None,
    file_scope: list[str] | None = None,
    constraints: list[str] | None = None,
    context_notes: str = "",
    read_only: bool = False,
    resume: str | None = None,
    timeout: int = 1800,
) -> dict:
    """Run one worker on a brief. No review loop, no scoring.

    For bounded errands where a full loop is overkill: "analyze this module",
    "apply this rename". You review the diff yourself. For anything that must
    reach a quality bar, use workflow_create + workflow_iterate instead.

    Args:
        read_only: Run with writes disabled --- use for analysis and review tasks.
        resume: Continue a prior session id instead of starting fresh.
    """
    adapter = adapters.get(backend)
    cwd_path = Path(cwd).expanduser().resolve()
    if not cwd_path.is_dir():
        return {"error": f"cwd does not exist: {cwd_path}"}

    run_id = rundir.new_run_id(f"delegate-{backend}-{task}")
    out_dir = rundir.iteration_path(run_id, 1, "worker")
    brief = Brief(
        task=task,
        acceptance_criteria=acceptance_criteria or "Complete the task as described.",
        context=context_notes,
        file_scope=file_scope or [],
        constraints=constraints or [],
    )
    (out_dir / "brief.md").write_text(brief.render())

    snap = rundir.snapshot(cwd_path)
    rundir.ledger(run_id, "delegate.start", backend=backend, model=model, read_only=read_only)
    result = adapter.run(
        prompt=brief.render(),
        cwd=cwd_path,
        out_dir=out_dir,
        model=model,
        read_only=read_only,
        resume=resume,
        timeout=timeout,
    )
    diff, files = rundir.capture_diff(cwd_path, snap)
    (out_dir / "diff.patch").write_text(diff)
    rundir.ledger(
        run_id,
        "delegate.done",
        exit_code=result.exit_code,
        files_changed=len(files),
        sandbox=result.sandbox,
    )

    payload = asdict(result)
    payload["diff"] = diff[:60_000]
    payload["files_changed"] = files
    payload["run_id"] = run_id
    if result.sandbox == "NOT ENFORCED":
        payload["warning"] = (
            "The sandbox did not engage — this worker's writes were NOT confined "
            "to the workspace. Check what it touched outside cwd."
        )
    return payload


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
