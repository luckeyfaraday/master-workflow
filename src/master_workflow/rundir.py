"""One run-directory layout for every worker, reviewer, loop, and mission.

This is the integration point of the whole system. If everything writes here in
the same shape, resume works uniformly, the ledger is just the filesystem, and
any dashboard or session indexer can read it without a bespoke adapter.

    $MASTER_WORKFLOW_HOME/runs/<run_id>/
        run.json                  RunState, rewritten on every transition
        ledger.jsonl              append-only event log
        iterations/01/worker/     prompt.md events.jsonl last_message.txt
                                  session_id stderr.log meta.json diff.patch
        iterations/01/review/     prompt.md last_message.txt review.json
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

_SLUG = re.compile(r"[^a-z0-9]+")


def home() -> Path:
    root = os.environ.get("MASTER_WORKFLOW_HOME")
    if root:
        return Path(root).expanduser()
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg).expanduser() / "master-workflow"
    return Path.home() / ".master-workflow"


def runs_root() -> Path:
    p = home() / "runs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def slugify(text: str, maxlen: int = 32) -> str:
    s = _SLUG.sub("-", text.lower()).strip("-")
    return (s[:maxlen].rstrip("-") or "run")


def new_run_id(goal: str) -> str:
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{slugify(goal)}"


def run_path(run_id: str) -> Path:
    return runs_root() / run_id


def iteration_dir(run_id: str, n: int, role: str) -> Path:
    """Where one role's artifacts live. Does not create it --- use this to look
    at an iteration that may not have started yet."""
    return run_path(run_id) / "iterations" / f"{n:02d}" / role


def iteration_path(run_id: str, n: int, role: str) -> Path:
    p = iteration_dir(run_id, n, role)
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_state(state: Any) -> None:
    p = run_path(state.run_id)
    p.mkdir(parents=True, exist_ok=True)
    state.updated_at = time.time()
    (p / "run.json").write_text(state.to_json())


def read_state(run_id: str):
    from .models import RunState

    f = run_path(run_id) / "run.json"
    if not f.exists():
        raise FileNotFoundError(f"no such run: {run_id}")
    return RunState.from_dict(json.loads(f.read_text()))


def list_runs(limit: int = 25) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for d in sorted(runs_root().iterdir(), reverse=True):
        f = d / "run.json"
        if not f.is_file():
            continue
        try:
            s = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        out.append(
            {
                "run_id": s.get("run_id", d.name),
                "goal": s.get("goal", ""),
                "status": s.get("status"),
                "best_score": s.get("best_score"),
                "iterations": len(s.get("iterations", [])),
                "updated_at": s.get("updated_at"),
            }
        )
        if len(out) >= limit:
            break
    return out


def ledger(run_id: str, event: str, **fields: Any) -> None:
    """Append one line to the run's audit log. Never raises."""
    rec = {"ts": time.time(), "event": event, **fields}
    try:
        p = run_path(run_id)
        p.mkdir(parents=True, exist_ok=True)
        with (p / "ledger.jsonl").open("a") as fh:
            fh.write(json.dumps(rec, default=str) + "\n")
    except OSError:
        pass


def read_ledger(run_id: str) -> list[dict[str, Any]]:
    f = run_path(run_id) / "ledger.jsonl"
    if not f.exists():
        return []
    out = []
    for line in f.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


# --- liveness ---------------------------------------------------------------
#
# Because a worker streams into raw.log as it goes, anyone can tell how far
# along it is without waiting for it to exit. This is what the MCP layer turns
# into progress notifications, and what a `tail -f` would show you directly.


def tail(path: Path, limit: int = 4096) -> str:
    """The last ``limit`` bytes of a file that may still be being written."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > limit:
                fh.seek(size - limit)
            return fh.read().decode(errors="replace")
    except OSError:
        return ""


def _event_label(obj: dict[str, Any]) -> str | None:
    """A short name for what the agent was last doing."""
    typ = obj.get("type")
    if not isinstance(typ, str):
        return None
    item = obj.get("item")
    if isinstance(item, dict) and isinstance(item.get("type"), str):
        return f"{typ}:{item['type']}"
    return typ


def log_progress(out_dir: Path) -> dict[str, Any]:
    """How much a running worker has produced, and what it last did.

    Only the tail of the log is read, so this stays cheap when polled --- the
    point is a liveness signal, not a transcript.
    """
    raw = Path(out_dir) / "raw.log"
    try:
        size = raw.stat().st_size
    except OSError:
        return {}
    label: str | None = None
    # The final line is often a partial write; walk backwards to the last one
    # that actually parses.
    for line in reversed(tail(raw).splitlines()):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            label = _event_label(obj)
            if label:
                break
    return {"bytes": size, "last_event": label}


# --- diff capture -----------------------------------------------------------
#
# The reviewer scores the actual diff, never the worker's summary. That rule is
# only enforceable if we can produce a diff the worker did not author, so we
# take it from git ourselves.


def _git(cwd: Path, *args: str, timeout: int = 30) -> tuple[int, str]:
    try:
        r = subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return r.returncode, r.stdout
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def is_git_repo(cwd: Path) -> bool:
    code, out = _git(cwd, "rev-parse", "--is-inside-work-tree")
    return code == 0 and out.strip() == "true"


def snapshot(cwd: Path) -> dict[str, Any]:
    """Record enough state before a worker runs to diff against afterwards."""
    cwd = Path(cwd)
    if not is_git_repo(cwd):
        return {"git": False}
    _, head = _git(cwd, "rev-parse", "HEAD")
    # Stage-intent on untracked files so `git diff` sees new files too, without
    # actually staging content or disturbing an existing index.
    _git(cwd, "add", "-AN", ".")
    _, base = _git(cwd, "stash", "create")
    return {"git": True, "head": head.strip(), "base": base.strip()}


#: Merely running the code produces these. Counting them as work makes an agent
#: that did nothing look productive --- which is exactly how a worker that died
#: on a 401 slipped past the "changed no files" check and got sent to a reviewer.
_NOISE = (
    ":!*__pycache__/*",
    ":!*.pyc",
    ":!*.pyo",
    ":!*.pytest_cache/*",
    ":!*.mypy_cache/*",
    ":!*.ruff_cache/*",
    ":!*node_modules/*",
    ":!*.egg-info/*",
    ":!*.DS_Store",
)


def capture_diff(cwd: Path, snap: dict[str, Any], max_bytes: int = 400_000) -> tuple[str, list[str]]:
    """Return (unified diff, changed files) produced since ``snap``.

    Build artifacts are excluded: the diff is evidence of work, and a reviewer
    should never be handed a recompiled ``.pyc`` as if it were a change.
    """
    cwd = Path(cwd)
    if not snap.get("git"):
        return ("", [])
    _git(cwd, "add", "-AN", ".")
    base = snap.get("base") or snap.get("head") or "HEAD"
    _, diff = _git(cwd, "diff", base, "--", ".", *_NOISE, timeout=60)
    if not diff.strip():
        _, diff = _git(cwd, "diff", "HEAD", "--", ".", *_NOISE, timeout=60)
    _, names = _git(cwd, "diff", "--name-only", base, "--", ".", *_NOISE)
    files = [f for f in names.splitlines() if f.strip()]
    if len(diff) > max_bytes:
        diff = (
            diff[:max_bytes]
            + f"\n\n[... diff truncated at {max_bytes} bytes; "
            f"{len(files)} files changed. Read the files directly to review the rest.]\n"
        )
    return (diff, files)
