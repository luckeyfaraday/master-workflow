"""End-to-end loop behaviour, driven by stub backends.

No real CLI runs here. These cover the decisions the harness makes on its own:
when to iterate, when to stop, and when a failure is the backend's fault rather
than the code's.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from master_workflow import adapters, loop, rundir
from master_workflow.adapters.base import Adapter
from master_workflow.models import WorkerResult


class StubWorker(Adapter):
    """A worker that writes whatever it is told to, on a schedule."""

    name = "stubworker"
    binary = "true"

    def __init__(self, scripted):
        self.scripted = list(scripted)  # one entry per iteration
        self.calls = []

    def available(self):
        return True

    def run(
        self,
        *,
        prompt,
        cwd,
        out_dir,
        model=None,
        variant=None,
        read_only=False,
        resume=None,
        timeout=0,
    ):
        self.calls.append({"prompt": prompt, "resume": resume, "variant": variant})
        step = self.scripted.pop(0) if self.scripted else {}
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        for name, content in (step.get("writes") or {}).items():
            (Path(cwd) / name).write_text(content)
        return WorkerResult(
            backend=self.name,
            model=model,
            variant=variant,
            exit_code=step.get("exit_code", 0),
            session_id=step.get("session_id", "sess-1"),
            run_dir=str(out_dir),
            last_message=step.get("message", "done"),
            error=step.get("error"),
        )


class StubReviewer(Adapter):
    """A reviewer that returns a scripted sequence of scores."""

    name = "stubreviewer"
    binary = "true"
    supports_read_only = True
    read_only_enforced = True

    def __init__(self, scores, fail=False):
        self.scores = list(scores)
        self.fail = fail
        self.seen_diffs = []

    def available(self):
        return True

    def run(
        self,
        *,
        prompt,
        cwd,
        out_dir,
        model=None,
        variant=None,
        read_only=False,
        resume=None,
        timeout=0,
    ):
        self.seen_diffs.append(prompt)
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        if self.fail:
            return WorkerResult(
                backend=self.name, model=model, exit_code=1, session_id=None,
                run_dir=str(out_dir), last_message="", error="usage limit reached",
            )
        score = self.scores.pop(0) if self.scores else 9
        body = json.dumps(
            {
                "score": score,
                "verdict": f"scored {score}",
                "findings": [] if score >= 9 else [f"fix thing {score}"],
                "strengths": [],
            }
        )
        return WorkerResult(
            backend=self.name, model=model, exit_code=0, session_id="rev-1",
            run_dir=str(out_dir), last_message=f"prose\n```json\n{body}\n```",
        )


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=r, check=True)
    (r / "a.py").write_text("x = 1\n")
    subprocess.run(["git", "add", "-A"], cwd=r, check=True, capture_output=True)
    subprocess.run(
        ["git", "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"],
        cwd=r, check=True, capture_output=True,
    )
    return r


@pytest.fixture
def wire(monkeypatch, tmp_path):
    monkeypatch.setenv("MASTER_WORKFLOW_HOME", str(tmp_path / "mw"))

    def _wire(worker, reviewer):
        monkeypatch.setitem(adapters.REGISTRY, worker.name, worker)
        monkeypatch.setitem(adapters.REGISTRY, reviewer.name, reviewer)

    return _wire


def _run(repo, worker, reviewer, **kw):
    state = loop.create_run(
        goal="make it good",
        success_criteria="a.py contains DONE",
        cwd=str(repo),
        worker_backend=worker.name,
        reviewer_backend=reviewer.name,
        **kw,
    )
    return state.run_id


def test_passes_on_the_first_try_when_the_score_clears(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "DONE\n"}}])
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    run_id = _run(repo, worker, reviewer)
    res = loop.iterate(run_id)

    assert res["decision"] == "stop"
    assert res["score"] == 9.0
    assert rundir.read_state(run_id).status == "passed"
    assert len(worker.calls) == 1


def test_iterates_until_the_score_clears(repo, wire):
    worker = StubWorker([{"writes": {"a.py": f"try{i}\n"}} for i in range(3)])
    reviewer = StubReviewer([5, 7, 9])
    wire(worker, reviewer)

    run_id = _run(repo, worker, reviewer, max_iterations=5)
    out = loop.run_loop(run_id)

    assert out["status"] == "passed"
    assert out["iterations"] == 3
    assert out["best_score"] == 9.0


def test_reviewer_findings_are_carried_into_the_next_brief(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "1\n"}}, {"writes": {"a.py": "2\n"}}])
    reviewer = StubReviewer([6, 9])
    wire(worker, reviewer)

    run_id = _run(repo, worker, reviewer)
    loop.run_loop(run_id)

    assert "fix thing 6" in worker.calls[1]["prompt"]
    assert "fix thing 6" not in worker.calls[0]["prompt"]


def test_each_iteration_spawns_a_fresh_worker_by_default(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "1\n"}}, {"writes": {"a.py": "2\n"}}])
    reviewer = StubReviewer([6, 9])
    wire(worker, reviewer)

    loop.run_loop(_run(repo, worker, reviewer))

    assert [c["resume"] for c in worker.calls] == [None, None]


def test_carry_session_continues_the_previous_worker(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "1\n"}}, {"writes": {"a.py": "2\n"}}])
    reviewer = StubReviewer([6, 9])
    wire(worker, reviewer)

    loop.run_loop(_run(repo, worker, reviewer), carry_session=True)

    assert worker.calls[0]["resume"] is None
    assert worker.calls[1]["resume"] == "sess-1"


def test_worker_variant_is_persisted_logged_and_forwarded(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "DONE\n"}}])
    worker.supports_variants = True
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    run_id = _run(repo, worker, reviewer, worker_variant="high")
    loop.iterate(run_id)

    assert worker.calls[0]["variant"] == "high"
    assert rundir.read_state(run_id).worker_variant == "high"
    start = next(e for e in rundir.read_ledger(run_id) if e["event"] == "worker.start")
    assert start["variant"] == "high"


def test_worker_variant_is_rejected_when_backend_does_not_support_it(repo, wire):
    worker = StubWorker([])
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    with pytest.raises(ValueError, match="does not support model variants"):
        _run(repo, worker, reviewer, worker_variant="high")


def test_reviewer_sees_the_diff_not_the_worker_message(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "MARKER\n"}, "message": "LIES: I did nothing"}])
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    loop.iterate(_run(repo, worker, reviewer))

    brief = reviewer.seen_diffs[0]
    assert "MARKER" in brief
    assert "LIES" not in brief


def test_budget_exhaustion_stops_without_passing(repo, wire):
    worker = StubWorker([{"writes": {"a.py": f"{i}\n"}} for i in range(4)])
    reviewer = StubReviewer([4, 5])
    wire(worker, reviewer)

    out = loop.run_loop(_run(repo, worker, reviewer, max_iterations=2))

    assert out["status"] == "exhausted"
    assert out["iterations"] == 2
    assert out["best_score"] == 5.0


def test_fatal_worker_error_stops_immediately_without_reviewing(repo, wire):
    worker = StubWorker([{"exit_code": 1, "error": "You've hit your usage limit."}])
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    res = loop.iterate(_run(repo, worker, reviewer, max_iterations=5))

    assert res["decision"] == "stop"
    assert res["status"] == "failed"
    assert res["fatal"] is True
    assert "usage limit" in res["worker_error"]
    assert reviewer.seen_diffs == []  # no point scoring a run that never happened


def test_worker_that_changes_nothing_is_an_infra_failure_not_a_low_score(repo, wire):
    worker = StubWorker([{"exit_code": 1, "error": "segfault"}])
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    res = loop.iterate(_run(repo, worker, reviewer))

    assert res["status"] == "failed"
    assert res["fatal"] is False
    assert reviewer.seen_diffs == []


def test_reviewer_failure_stops_rather_than_scoring_zero(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "DONE\n"}}])
    reviewer = StubReviewer([], fail=True)
    wire(worker, reviewer)

    res = loop.iterate(_run(repo, worker, reviewer, max_iterations=5))

    assert res["decision"] == "stop"
    assert res["status"] == "failed"
    assert "usage limit" in res["reviewer_error"]
    assert len(worker.calls) == 1  # the worker is not re-run against a fake score


def test_a_high_score_from_a_failed_worker_still_does_not_pass(repo, wire):
    # exit != 0 but files did change, so it is reviewed; a 9 must not pass while
    # the worker itself reported failure.
    worker = StubWorker([{"writes": {"a.py": "DONE\n"}, "exit_code": 1, "error": "tests failed"}])
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    res = loop.iterate(_run(repo, worker, reviewer, max_iterations=3))

    assert res["decision"] == "continue"
    assert rundir.read_state(res["run_id"]).status != "passed"


def test_ledger_records_the_whole_arc(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "1\n"}}, {"writes": {"a.py": "2\n"}}])
    reviewer = StubReviewer([6, 9])
    wire(worker, reviewer)

    run_id = _run(repo, worker, reviewer)
    loop.run_loop(run_id)

    events = [e["event"] for e in rundir.read_ledger(run_id)]
    assert events.count("worker.start") == 2
    assert events.count("review.done") == 2
    assert events[0] == "run.created"
    assert events[-1] == "iteration.end"


def test_artifacts_land_in_the_documented_layout(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "DONE\n"}}])
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    run_id = _run(repo, worker, reviewer)
    loop.iterate(run_id)

    base = rundir.run_path(run_id)
    assert (base / "run.json").is_file()
    assert (base / "ledger.jsonl").is_file()
    assert (base / "iterations/01/worker/brief.md").is_file()
    assert (base / "iterations/01/worker/diff.patch").is_file()
    assert (base / "iterations/01/review/review.json").is_file()
    assert "DONE" in (base / "iterations/01/worker/diff.patch").read_text()


def test_aborted_run_will_not_iterate(repo, wire):
    worker = StubWorker([{"writes": {"a.py": "1\n"}}])
    reviewer = StubReviewer([9])
    wire(worker, reviewer)

    run_id = _run(repo, worker, reviewer)
    state = rundir.read_state(run_id)
    state.status = "aborted"
    rundir.write_state(state)

    res = loop.iterate(run_id)
    assert res["decision"] == "stop"
    assert worker.calls == []


def test_create_run_rejects_a_missing_cwd(tmp_path, monkeypatch):
    monkeypatch.setenv("MASTER_WORKFLOW_HOME", str(tmp_path / "mw"))
    with pytest.raises(ValueError, match="cwd does not exist"):
        loop.create_run(goal="g", success_criteria="c", cwd=str(tmp_path / "nope"))
