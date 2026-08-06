"""The harness: orchestrator -> worker -> critical reviewer, until the score holds.

The control flow lives here, in deterministic code, because a prompt can
*describe* "loop until a reviewer scores it 9" but cannot *guarantee* it. The
model-facing judgement --- how to brief, how to score --- lives in swappable
prompts.

One iteration:

    brief (fresh context) -> worker CLI -> capture diff from git
                          -> cross-model reviewer, read-only, sees only the diff
                          -> score >= threshold ? stop : fold findings into the
                             next brief and spawn a *new* worker

Each iteration spawns a clean worker rather than continuing the previous
session. A context already carrying a failed attempt tends to defend it; a fresh
one reads the findings as requirements. Set ``carry_session=True`` to continue
the same session instead when the task is genuinely incremental.
"""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from . import adapters, rundir
from .adapters.base import is_fatal as adapters_is_fatal
from .models import Brief, RunState, WorkerResult
from .review import run_review


def create_run(
    *,
    goal: str,
    success_criteria: str,
    cwd: str,
    worker_backend: str = "codex",
    worker_model: str | None = None,
    worker_variant: str | None = None,
    reviewer_backend: str | None = None,
    reviewer_model: str | None = None,
    threshold: float = 9.0,
    max_iterations: int = 5,
    file_scope: list[str] | None = None,
    constraints: list[str] | None = None,
    context: str = "",
) -> RunState:
    worker_adapter = adapters.get(worker_backend)  # fail fast on a typo'd backend
    worker_adapter.validate_variant(worker_variant)
    if reviewer_backend:
        adapters.get(reviewer_backend)
    cwd_path = Path(cwd).expanduser().resolve()
    if not cwd_path.is_dir():
        raise ValueError(f"cwd does not exist: {cwd_path}")

    state = RunState(
        run_id=rundir.new_run_id(goal),
        goal=goal,
        success_criteria=success_criteria,
        cwd=str(cwd_path),
        threshold=threshold,
        max_iterations=max_iterations,
        worker_backend=worker_backend,
        worker_model=worker_model,
        worker_variant=worker_variant,
        reviewer_backend=reviewer_backend,
        reviewer_model=reviewer_model,
        file_scope=file_scope or [],
        constraints=constraints or [],
        context=context,
    )
    rundir.write_state(state)
    rundir.ledger(
        state.run_id,
        "run.created",
        goal=goal,
        cwd=str(cwd_path),
        worker=worker_backend,
        model=worker_model,
        variant=worker_variant,
        reviewer=reviewer_backend or "auto",
        threshold=threshold,
    )
    if not rundir.is_git_repo(cwd_path):
        rundir.ledger(
            state.run_id,
            "warning",
            message="cwd is not a git repository; no diff can be captured and the "
            "reviewer will have to read files directly.",
        )
    return state


def _prior_findings(state: RunState) -> list[str]:
    for it in reversed(state.iterations):
        rev = it.get("review")
        if rev and rev.get("findings"):
            return list(rev["findings"])
    return []


def _last_session(state: RunState) -> str | None:
    for it in reversed(state.iterations):
        w = it.get("worker")
        if w and w.get("session_id"):
            return w["session_id"]
    return None


def iterate(
    run_id: str,
    *,
    worker_timeout: int = 1800,
    review_timeout: int = 1200,
    carry_session: bool = False,
    on_event: Callable[[str, dict], None] | None = None,
) -> dict[str, Any]:
    """Run exactly one worker -> review cycle. Returns the decision."""
    state = rundir.read_state(run_id)
    emit = on_event or (lambda *_a, **_k: None)

    if state.status in ("passed", "aborted"):
        return {"decision": "stop", "reason": f"run already {state.status}", "state": asdict(state)}
    if len(state.iterations) >= state.max_iterations:
        state.status, state.stop_reason = "exhausted", "max_iterations reached"
        rundir.write_state(state)
        return {"decision": "stop", "reason": state.stop_reason, "state": asdict(state)}

    n = len(state.iterations) + 1
    state.status = "running"
    rundir.write_state(state)

    findings = _prior_findings(state)
    brief = Brief(
        task=state.goal,
        acceptance_criteria=state.success_criteria,
        context=state.context,
        file_scope=state.file_scope,
        constraints=state.constraints,
        prior_findings=findings,
        iteration=n,
    )

    # --- worker ------------------------------------------------------------
    worker_dir = rundir.iteration_path(run_id, n, "worker")
    (worker_dir / "brief.md").write_text(brief.render())
    cwd = Path(state.cwd)
    snap = rundir.snapshot(cwd)

    resume = _last_session(state) if carry_session else None
    rundir.ledger(
        run_id,
        "worker.start",
        iteration=n,
        backend=state.worker_backend,
        model=state.worker_model,
        variant=state.worker_variant,
        resumed=bool(resume),
        carried_findings=len(findings),
    )
    emit("worker.start", {"iteration": n, "backend": state.worker_backend})

    worker: WorkerResult = adapters.get(state.worker_backend).run(
        prompt=brief.render(),
        cwd=cwd,
        out_dir=worker_dir,
        model=state.worker_model,
        variant=state.worker_variant,
        read_only=False,
        resume=resume,
        timeout=worker_timeout,
    )
    diff, files = rundir.capture_diff(cwd, snap)
    worker.diff, worker.files_changed = diff, files
    (worker_dir / "diff.patch").write_text(diff)

    rundir.ledger(
        run_id,
        "worker.done",
        iteration=n,
        exit_code=worker.exit_code,
        files_changed=len(files),
        sandbox=worker.sandbox,
        duration_s=worker.duration_s,
        timed_out=worker.timed_out,
    )
    emit("worker.done", {"iteration": n, "exit_code": worker.exit_code, "files": len(files)})

    if worker.sandbox == "NOT ENFORCED":
        rundir.ledger(
            run_id,
            "warning",
            iteration=n,
            message="worker ran without sandbox enforcement; its writes were not "
            "confined to the workspace",
        )

    # --- fail fast ---------------------------------------------------------
    #
    # A worker that could not run at all (quota exhausted, not logged in,
    # crashed before doing anything) is an infrastructure failure, not a quality
    # failure. Reviewing an empty diff and iterating would burn the whole budget
    # scoring zeros and bury the real reason.
    fatal = adapters_is_fatal(worker.error)
    infra_failure = (not worker.ok) and not files
    if fatal or infra_failure:
        state.status = "failed"
        state.stop_reason = (
            f"{state.worker_backend} could not complete the run: "
            f"{worker.error or f'exit {worker.exit_code}'}"
        )
        state.iterations.append(
            {"n": n, "brief": asdict(brief), "worker": asdict(worker), "review": None}
        )
        rundir.write_state(state)
        rundir.ledger(
            run_id,
            "worker.failed",
            iteration=n,
            fatal=fatal,
            exit_code=worker.exit_code,
            error=worker.error,
        )
        emit("worker.failed", {"iteration": n, "error": worker.error})
        return {
            "decision": "stop",
            "reason": state.stop_reason,
            "iteration": n,
            "status": "failed",
            "run_id": run_id,
            "worker_error": worker.error,
            "fatal": bool(fatal),
            "remedy": (
                f"This is a {state.worker_backend} problem, not a code problem — "
                "no review was run. Switch worker_backend to another installed "
                "agent and create a new run, or resolve the CLI issue above."
                if fatal
                else "The worker exited without changing any files. Check its "
                f"last message and stderr in {worker.run_dir}."
            ),
            "worker": {
                "backend": worker.backend,
                "model": worker.model,
                "variant": worker.variant,
                "exit_code": worker.exit_code,
                "last_message": worker.last_message[-2000:],
                "run_dir": worker.run_dir,
            },
        }

    # --- review ------------------------------------------------------------
    review_dir = rundir.iteration_path(run_id, n, "review")
    rundir.ledger(run_id, "review.start", iteration=n)
    emit("review.start", {"iteration": n})

    review = run_review(
        state=state,
        worker=worker,
        diff=diff,
        iteration=n,
        out_dir=review_dir,
        timeout=review_timeout,
    )
    (review_dir / "brief.md").write_text(
        (review_dir / "prompt.md").read_text() if (review_dir / "prompt.md").exists() else ""
    )

    rundir.ledger(
        run_id,
        "review.done",
        iteration=n,
        score=review.score,
        reviewer=review.reviewer_backend,
        findings=len(review.findings),
        parse_ok=review.parse_ok,
        reviewer_error=review.reviewer_error,
    )
    emit("review.done", {"iteration": n, "score": review.score})

    if review.reviewer_error:
        # The work was done but nothing graded it. Iterating would re-run the
        # worker against a score that means nothing.
        state.status = "failed"
        state.stop_reason = (
            f"reviewer {review.reviewer_backend or '(none)'} could not run: "
            f"{review.reviewer_error}"
        )
        state.iterations.append(
            {"n": n, "brief": asdict(brief), "worker": asdict(worker), "review": asdict(review)}
        )
        rundir.write_state(state)
        rundir.ledger(run_id, "reviewer.failed", iteration=n, error=review.reviewer_error)
        return {
            "decision": "stop",
            "reason": state.stop_reason,
            "iteration": n,
            "status": "failed",
            "run_id": run_id,
            "reviewer_error": review.reviewer_error,
            "remedy": (
                "The worker's diff is intact but unscored. Pin a different "
                "reviewer_backend and create a new run, or review the diff "
                f"yourself: {worker.run_dir}/diff.patch"
            ),
            "worker": {
                "backend": worker.backend,
                "files_changed": worker.files_changed,
                "run_dir": worker.run_dir,
            },
        }

    # --- decide ------------------------------------------------------------
    state.iterations.append(
        {
            "n": n,
            "brief": asdict(brief),
            "worker": asdict(worker),
            "review": asdict(review),
        }
    )
    state.best_score = max(state.best_score, review.score)

    passed = review.score >= state.threshold and review.parse_ok and worker.ok
    if passed:
        state.status, state.stop_reason = "passed", f"score {review.score} >= {state.threshold}"
        decision, reason = "stop", state.stop_reason
    elif n >= state.max_iterations:
        state.status = "exhausted"
        state.stop_reason = (
            f"max_iterations ({state.max_iterations}) reached at best score {state.best_score}"
        )
        decision, reason = "stop", state.stop_reason
    else:
        state.status = "running"
        decision = "continue"
        reason = f"score {review.score} < {state.threshold}; {len(review.findings)} findings to fix"

    rundir.write_state(state)
    rundir.ledger(run_id, "iteration.end", iteration=n, decision=decision, reason=reason)

    return {
        "decision": decision,
        "reason": reason,
        "iteration": n,
        "score": review.score,
        "threshold": state.threshold,
        "verdict": review.verdict,
        "findings": review.findings,
        "strengths": review.strengths,
        "reviewer_backend": review.reviewer_backend,
        "worker": {
            "backend": worker.backend,
            "model": worker.model,
            "variant": worker.variant,
            "exit_code": worker.exit_code,
            "session_id": worker.session_id,
            "files_changed": worker.files_changed,
            "sandbox": worker.sandbox,
            "duration_s": worker.duration_s,
            "last_message": worker.last_message[-4000:],
            "run_dir": worker.run_dir,
        },
        "status": state.status,
        "run_id": run_id,
    }


def run_loop(
    run_id: str,
    *,
    max_iterations: int | None = None,
    worker_timeout: int = 1800,
    review_timeout: int = 1200,
    carry_session: bool = False,
    on_event: Callable[[str, dict], None] | None = None,
) -> dict[str, Any]:
    """Iterate until the reviewer clears the threshold or the budget runs out."""
    state = rundir.read_state(run_id)
    budget = max_iterations if max_iterations is not None else state.max_iterations
    last: dict[str, Any] = {}
    while len(rundir.read_state(run_id).iterations) < budget:
        last = iterate(
            run_id,
            worker_timeout=worker_timeout,
            review_timeout=review_timeout,
            carry_session=carry_session,
            on_event=on_event,
        )
        if last.get("decision") == "stop":
            break
    final = rundir.read_state(run_id)
    return {
        "run_id": run_id,
        "status": final.status,
        "stop_reason": final.stop_reason,
        "best_score": final.best_score,
        "iterations": len(final.iterations),
        "last": last,
    }
