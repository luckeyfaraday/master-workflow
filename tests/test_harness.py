"""Unit tests for the parts that must not silently misbehave.

No agent CLI is invoked here --- these cover brief rendering, review parsing,
reviewer selection, fatal-error classification, and diff capture.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from master_workflow import adapters, rundir
from master_workflow.adapters.base import Adapter, is_fatal
from master_workflow.models import Brief, RunState, WorkerResult
from master_workflow.review import build_review_brief, parse_review


# --- briefs -----------------------------------------------------------------


def test_brief_is_self_contained():
    b = Brief(
        task="Add a /health endpoint",
        acceptance_criteria="Returns 200 with {status}",
        file_scope=["api/health.py"],
        constraints=["no new dependencies"],
    )
    text = b.render()
    assert "Add a /health endpoint" in text
    assert "Returns 200" in text
    assert "api/health.py" in text
    assert "no new dependencies" in text
    assert "Do not ask questions" in text


def test_brief_carries_prior_findings_as_requirements():
    b = Brief(
        task="t",
        acceptance_criteria="c",
        prior_findings=["bare except at parser.py:88 swallows the error"],
        iteration=2,
    )
    text = b.render()
    assert "iteration 1" in text
    assert "parser.py:88" in text
    assert "additional acceptance criteria" in text


def test_brief_omits_empty_sections():
    text = Brief(task="t", acceptance_criteria="c").render()
    assert "## File scope" not in text
    assert "## Constraints" not in text
    assert "Reviewer findings" not in text


# --- review parsing ---------------------------------------------------------


def _parse(text: str):
    return parse_review(text, backend="codex", model=None, run_dir="/tmp/x")


def test_parses_fenced_json_verdict():
    r = _parse(
        'Some prose.\n\n```json\n{"score": 9, "verdict": "good", '
        '"findings": [], "strengths": ["clear"]}\n```'
    )
    assert r.score == 9.0
    assert r.verdict == "good"
    assert r.strengths == ["clear"]
    assert r.parse_ok


def test_uses_the_last_json_block_when_several_appear():
    r = _parse(
        '```json\n{"score": 3, "verdict": "draft"}\n```\n'
        'Revised:\n```json\n{"score": 7, "verdict": "final"}\n```'
    )
    assert r.score == 7.0
    assert r.verdict == "final"


def test_parses_bare_json_without_a_fence():
    r = _parse('Verdict below.\n{"score": 6.5, "verdict": "partial", "findings": ["x"]}')
    assert r.score == 6.5
    assert r.findings == ["x"]


def test_unstructured_review_cannot_reach_the_threshold():
    # A reviewer that ignores the output contract must never be able to end the
    # loop on its own, however enthusiastic its prose.
    r = _parse("This is excellent work. I'd score it 10 out of 10, ship it.")
    assert not r.parse_ok
    assert r.score < 9.0


def test_review_with_no_score_at_all_is_zero():
    r = _parse("I could not review this.")
    assert r.score == 0.0
    assert not r.parse_ok


def test_score_is_clamped_to_the_rubric_range():
    assert _parse('```json\n{"score": 47}\n```').score == 10.0
    assert _parse('```json\n{"score": -3}\n```').score == 0.0


def test_non_numeric_score_does_not_crash():
    r = _parse('```json\n{"score": "excellent", "verdict": "v"}\n```')
    assert r.score == 0.0


def test_findings_given_as_a_string_are_normalised():
    r = _parse('```json\n{"score": 5, "findings": "just one thing"}\n```')
    assert r.findings == ["just one thing"]


# --- reviewer selection -----------------------------------------------------


def test_reviewer_is_never_the_worker(monkeypatch):
    for backend in adapters.REGISTRY:
        monkeypatch.setattr(
            type(adapters.REGISTRY[backend]), "available", lambda self: True, raising=False
        )
    for worker in adapters.REGISTRY:
        assert adapters.pick_reviewer(worker) != worker


def test_reviewer_prefers_an_os_enforced_sandbox(monkeypatch):
    for ad in adapters.REGISTRY.values():
        monkeypatch.setattr(type(ad), "available", lambda self: True, raising=False)
    # codex is enforced; with grok as the worker it should win over claude.
    assert adapters.pick_reviewer("grok") == "codex"
    # With codex as the worker, grok is the other enforced option.
    assert adapters.pick_reviewer("codex") == "grok"


def test_explicit_reviewer_always_wins():
    assert adapters.pick_reviewer("codex", "codex") == "codex"


def test_no_reviewer_when_nothing_else_is_installed(monkeypatch):
    for name, ad in adapters.REGISTRY.items():
        monkeypatch.setattr(
            type(ad), "available", lambda self, n=name: n == "codex", raising=False
        )
    assert adapters.pick_reviewer("codex") is None


def test_unknown_backend_is_rejected():
    with pytest.raises(ValueError, match="unknown backend"):
        adapters.get("gpt9")


# --- fatal classification ---------------------------------------------------


@pytest.mark.parametrize(
    "msg",
    [
        "You've hit your usage limit. Upgrade to Pro",
        "Error: not authenticated, please run codex login",
        "429 rate limit exceeded",
        "Your credit balance is too low",
    ],
)
def test_provider_failures_are_fatal(msg):
    assert is_fatal(msg)


@pytest.mark.parametrize("msg", ["tests failed", "connection reset by peer", None, ""])
def test_ordinary_failures_are_retryable(msg):
    assert is_fatal(msg) is None


# --- exit codes are not trusted on their own --------------------------------


class _Echo(Adapter):
    """Replays a canned event stream and exit code through the real driver."""

    name = "echo"
    binary = "sh"

    def __init__(self, lines, code=0):
        self.lines, self.code = lines, code

    def _argv(self, *, prompt_file, prompt, cwd, out_dir, model, read_only, resume, session_id):
        body = "".join(f"printf '%s\\n' {json.dumps(line)}; " for line in self.lines)
        return ["sh", "-c", f"{body}exit {self.code}"]


# Copied from a real failing run. The message is two levels below `error`, not
# on it --- an earlier version of this test invented a flattened shape and so
# passed against a stream opencode never emits.
OPENCODE_401 = json.dumps(
    {
        "type": "error",
        "sessionID": "ses_1",
        "error": {
            "name": "APIError",
            "data": {
                "message": "No payment method. Add a payment method here: https://opencode.ai/billing",
                "statusCode": 401,
                "isRetryable": False,
                "responseBody": '{"type":"error","error":{"type":"CreditsError"}}',
            },
        },
    }
)
CODEX_WARNING = json.dumps(
    {
        "type": "item.completed",
        "item": {"id": "i0", "type": "error", "message": "Skill descriptions were shortened"},
    }
)


def test_exit_zero_with_a_fatal_stream_error_is_still_a_failure(tmp_path):
    # opencode returns 0 on a 401 CreditsError. Trusting the exit code there
    # produces a "successful" run that changed nothing.
    r = _Echo([OPENCODE_401], code=0).run(prompt="p", cwd=tmp_path, out_dir=tmp_path / "o")
    assert r.exit_code == 0
    assert not r.ok
    assert "payment method" in r.error


def test_exit_zero_with_a_routine_warning_still_succeeds(tmp_path):
    # CLIs emit ordinary warnings as error-typed events; those must not fail a run.
    r = _Echo([CODEX_WARNING, '{"type":"turn.completed"}'], code=0).run(
        prompt="p", cwd=tmp_path, out_dir=tmp_path / "o"
    )
    assert r.ok
    assert r.error is None


def test_nested_provider_error_beats_a_bare_exit_code(tmp_path):
    # The real regression: exit 1 with an empty stderr used to report "exit 1"
    # and be classified retryable, so the loop iterated against a dead account.
    r = _Echo([OPENCODE_401], code=1).run(prompt="p", cwd=tmp_path, out_dir=tmp_path / "o")
    assert r.error != "exit 1"
    assert "payment method" in r.error
    assert is_fatal(r.error)


def test_nonzero_exit_reports_the_stream_error_not_just_the_code(tmp_path):
    quota = json.dumps({"type": "error", "message": "You've hit your usage limit."})
    r = _Echo([CODEX_WARNING, quota], code=1).run(
        prompt="p", cwd=tmp_path, out_dir=tmp_path / "o"
    )
    assert not r.ok
    assert "usage limit" in r.error  # the fatal message wins over the warning


def test_missing_binary_is_reported_not_raised(tmp_path):
    class Missing(Adapter):
        name, binary = "missing", "definitely-not-a-real-binary-xyz"

    r = Missing().run(prompt="p", cwd=tmp_path, out_dir=tmp_path / "o")
    assert r.exit_code == 127
    assert "not found" in r.error


# --- review brief -----------------------------------------------------------


def test_review_brief_shows_the_diff_not_the_summary():
    state = RunState(
        run_id="r", goal="g", success_criteria="c", cwd="/tmp", file_scope=["a.py"]
    )
    worker = WorkerResult(
        backend="grok",
        model="grok-build-0.1",
        exit_code=0,
        session_id="s",
        run_dir="/tmp/w",
        last_message="I did a perfect job and everything passes!",
        files_changed=["a.py"],
    )
    text = build_review_brief(
        state=state, worker=worker, diff="--- a/a.py\n+++ b/a.py\n+x = 1", iteration=1
    )
    assert "+x = 1" in text
    assert "I did a perfect job" not in text  # the summary must never leak in
    assert "grok" in text
    assert "read-only" in text


def test_review_brief_flags_an_empty_diff_as_failing():
    state = RunState(run_id="r", goal="g", success_criteria="c", cwd="/tmp")
    worker = WorkerResult(
        backend="codex", model=None, exit_code=0, session_id=None, run_dir="/tmp/w",
        last_message="done!",
    )
    assert "No diff was produced" in build_review_brief(
        state=state, worker=worker, diff="", iteration=1
    )


# --- run directory + diff capture ------------------------------------------


def test_state_round_trips(tmp_path, monkeypatch):
    monkeypatch.setenv("MASTER_WORKFLOW_HOME", str(tmp_path))
    state = RunState(run_id="rt", goal="g", success_criteria="c", cwd=str(tmp_path))
    rundir.write_state(state)
    assert rundir.read_state("rt").goal == "g"
    assert any(r["run_id"] == "rt" for r in rundir.list_runs())


def test_ledger_appends_and_survives_bad_lines(tmp_path, monkeypatch):
    monkeypatch.setenv("MASTER_WORKFLOW_HOME", str(tmp_path))
    rundir.ledger("lg", "worker.start", iteration=1)
    rundir.ledger("lg", "review.done", score=7.5)
    (rundir.run_path("lg") / "ledger.jsonl").open("a").write("not json\n")
    events = rundir.read_ledger("lg")
    assert [e["event"] for e in events] == ["worker.start", "review.done"]
    assert events[1]["score"] == 7.5


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_capture_diff_sees_edits_and_new_files(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    (repo / "a.py").write_text("old = 1\n")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init")

    snap = rundir.snapshot(repo)
    (repo / "a.py").write_text("new = 2\n")
    (repo / "b.py").write_text("added = 3\n")
    diff, files = rundir.capture_diff(repo, snap)

    assert "new = 2" in diff
    assert "added = 3" in diff  # untracked files must show up too
    assert set(files) == {"a.py", "b.py"}


def test_build_artifacts_do_not_count_as_work(tmp_path):
    # A worker that died on a 401 still left a .pyc behind from the test run.
    # If that counts as a changed file, the "changed nothing" check never fires.
    repo = tmp_path / "repo"
    (repo / "__pycache__").mkdir(parents=True)
    _git(repo, "init", "-q")
    (repo / "a.py").write_text("x = 1\n")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init")

    snap = rundir.snapshot(repo)
    (repo / "__pycache__" / "a.cpython-312.pyc").write_bytes(b"\x00compiled")
    (repo / ".pytest_cache").mkdir()
    (repo / ".pytest_cache" / "lastfailed").write_text("{}")
    diff, files = rundir.capture_diff(repo, snap)

    assert files == []
    assert diff.strip() == ""


def test_capture_diff_is_empty_when_nothing_changed(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    (repo / "a.py").write_text("x = 1\n")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init")

    diff, files = rundir.capture_diff(repo, rundir.snapshot(repo))
    assert diff.strip() == ""
    assert files == []


def test_non_git_directory_degrades_quietly(tmp_path):
    assert not rundir.is_git_repo(tmp_path)
    assert rundir.capture_diff(tmp_path, rundir.snapshot(tmp_path)) == ("", [])


def test_run_id_is_filesystem_safe():
    rid = rundir.new_run_id("Fix the /api/v2 endpoint!! (urgent)")
    assert "/" not in rid and " " not in rid
    assert rid.startswith("20")
