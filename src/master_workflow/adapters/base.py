"""The worker seam: one contract every backend CLI collapses to.

Adding a backend means implementing ``_argv`` and, if its event stream is
unusual, ``_finalize``. Everything else --- artifacts, timeouts, session ids,
uniform ``WorkerResult`` --- is handled here once.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from ..models import WorkerResult

DEFAULT_TIMEOUT = 1800

# Keys different CLIs use for the same idea: "which session was this".
_SESSION_KEYS = (
    "session_id",
    "sessionID",
    "sessionId",
    "thread_id",
    "threadId",
    "conversation_id",
)


class Adapter:
    """Base class for a worker backend."""

    name: str = "base"
    binary: str = ""
    #: What this backend is genuinely good at, surfaced to the orchestrator.
    strengths: str = ""
    #: Models worth naming explicitly. First entry is the adapter default.
    known_models: tuple[str, ...] = ()
    #: Can this backend run a review pass with editing suppressed?
    supports_read_only: bool = True
    #: Is that suppression enforced by the OS/sandbox rather than by asking the
    #: model nicely or denying tools by name? Enforced reviewers are preferred.
    read_only_enforced: bool = False

    # -- discovery ----------------------------------------------------------

    def available(self) -> bool:
        return shutil.which(self.binary) is not None

    def version(self) -> str | None:
        if not self.available():
            return None
        try:
            r = subprocess.run(
                [self.binary, "--version"], capture_output=True, text=True, timeout=20
            )
            return (r.stdout or r.stderr).strip().splitlines()[0] if (r.stdout or r.stderr) else None
        except (OSError, subprocess.SubprocessError, IndexError):
            return None

    # -- the one method backends customise ----------------------------------

    def _argv(
        self,
        *,
        prompt_file: Path,
        prompt: str,
        cwd: Path,
        out_dir: Path,
        model: str | None,
        read_only: bool,
        resume: str | None,
        session_id: str,
    ) -> list[str]:
        raise NotImplementedError

    def _stdin(self, prompt: str) -> str | None:
        """Return text to pipe on stdin, or None if the prompt rides in argv."""
        return None

    def _finalize(self, out_dir: Path, raw: str) -> None:
        """Turn raw stdout into events.jsonl + last_message.txt."""
        events = [ln for ln in raw.splitlines() if ln.startswith("{")]
        (out_dir / "events.jsonl").write_text("\n".join(events) + ("\n" if events else ""))
        if not (out_dir / "last_message.txt").exists():
            (out_dir / "last_message.txt").write_text(_last_text(events) or raw.strip())

    def _extract_session(self, out_dir: Path, fallback: str) -> str:
        f = out_dir / "session_id"
        if f.exists() and f.read_text().strip() not in ("", "unknown"):
            return f.read_text().strip()
        ev = out_dir / "events.jsonl"
        if ev.exists():
            for line in ev.read_text().splitlines():
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for key in _SESSION_KEYS:
                    val = obj.get(key)
                    if isinstance(val, str) and val:
                        return val
        return fallback

    # -- the shared driver ---------------------------------------------------

    def run(
        self,
        *,
        prompt: str,
        cwd: Path,
        out_dir: Path,
        model: str | None = None,
        read_only: bool = False,
        resume: str | None = None,
        timeout: int = DEFAULT_TIMEOUT,
    ) -> WorkerResult:
        cwd = Path(cwd)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        if not self.available():
            return WorkerResult(
                backend=self.name,
                model=model,
                exit_code=127,
                session_id=None,
                run_dir=str(out_dir),
                last_message="",
                error=f"{self.binary} not found on PATH",
            )

        prompt_file = out_dir / "prompt.md"
        prompt_file.write_text(prompt)
        session_id = resume or str(uuid.uuid4())

        argv = self._argv(
            prompt_file=prompt_file,
            prompt=prompt,
            cwd=cwd,
            out_dir=out_dir,
            model=model,
            read_only=read_only,
            resume=resume,
            session_id=session_id,
        )
        (out_dir / "argv.json").write_text(json.dumps(argv, indent=2))

        env = {**os.environ, "MASTER_WORKFLOW_RUN": "1"}
        started = time.time()
        timed_out = False
        raw, err, code = "", "", 1
        try:
            proc = subprocess.run(
                argv,
                cwd=str(cwd),
                input=self._stdin(prompt),
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
            raw, err, code = proc.stdout or "", proc.stderr or "", proc.returncode
        except subprocess.TimeoutExpired as e:
            timed_out = True
            raw = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            err = (e.stderr or b"").decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
            code = 124
        except OSError as e:
            err, code = str(e), 126

        duration = time.time() - started
        (out_dir / "raw.log").write_text(raw)
        (out_dir / "stderr.log").write_text(err)
        try:
            self._finalize(out_dir, raw)
        except (OSError, ValueError) as e:  # never lose a run to a parse bug
            (out_dir / "last_message.txt").write_text(raw.strip())
            (out_dir / "parse_error.txt").write_text(str(e))

        sid = self._extract_session(out_dir, session_id)
        (out_dir / "session_id").write_text(sid + "\n")
        last = (out_dir / "last_message.txt").read_text() if (out_dir / "last_message.txt").exists() else ""

        # A CLI that fails for provider reasons (quota, auth, no payment method)
        # usually reports it in its event stream and leaves stderr empty --- and
        # some exit 0 while doing it. opencode returns 0 on a 401 CreditsError;
        # trusting the exit code there produces a "successful" run that changed
        # nothing. So the stream is checked either way, and on a clean exit only
        # an unambiguously fatal message is allowed to overturn it (CLIs also
        # emit routine warnings as error-typed events).
        stream_err = _stream_error(out_dir)
        error: str | None = None
        if timed_out:
            error = f"timed out after {timeout}s"
        elif code != 0:
            error = stream_err or err.strip()[-2000:] or f"exit {code}"
        elif is_fatal(stream_err):
            error = stream_err

        return WorkerResult(
            backend=self.name,
            model=model,
            exit_code=code,
            session_id=sid,
            run_dir=str(out_dir),
            last_message=last.strip(),
            sandbox=self._sandbox_state(out_dir, read_only),
            duration_s=round(duration, 2),
            timed_out=timed_out,
            error=error,
        )

    def _sandbox_state(self, out_dir: Path, read_only: bool) -> str:
        return "read-only" if read_only else "workspace-write"


#: Failures that no amount of iterating will fix. Matched against whatever the
#: CLI reported so the loop can stop and say the real reason instead of burning
#: the budget on empty diffs.
FATAL_PATTERNS = (
    "usage limit",
    "rate limit",
    "quota",
    "insufficient_quota",
    "not authenticated",
    "please log in",
    "please run `codex login`",
    "unauthorized",
    "invalid api key",
    "authentication",
    "credit balance",
    "payment required",
    "payment method",
    "creditserror",
    "balance exhausted",
    "billing",
)


def is_fatal(message: str | None) -> str | None:
    """Return the matched fatal pattern, or None if the error looks retryable."""
    if not message:
        return None
    low = message.lower()
    for pat in FATAL_PATTERNS:
        if pat in low:
            return pat
    return None


def _stream_error(out_dir: Path) -> str | None:
    """Pull the last real error message out of a JSONL event stream."""
    ev = out_dir / "events.jsonl"
    if not ev.exists():
        return None
    found: str | None = None
    for line in ev.read_text().splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        typ = obj.get("type")
        msg: str | None = None
        if typ in ("error", "turn.failed", "failed"):
            # Provider errors arrive at wildly different depths: codex puts the
            # text at .message, opencode buries it at .error.data.message under
            # an APIError wrapper. Search the whole event rather than guessing.
            msg = _deep_message(obj)
        elif typ == "item.completed" and isinstance(obj.get("item"), dict):
            item = obj["item"]
            if item.get("type") == "error":
                msg = item.get("message")
        elif obj.get("is_error") or obj.get("subtype") == "error":
            msg = obj.get("result") or obj.get("message")
        if isinstance(msg, str) and msg.strip():
            # Prefer a fatal message over an incidental warning.
            if is_fatal(msg) or found is None:
                found = msg.strip()
    return found[:2000] if found else None


def _deep_message(obj: Any, depth: int = 0) -> str | None:
    """Find the most informative ``message`` string anywhere inside an event.

    Prefers a fatal one, then the deepest --- outer wrappers say "APIError"
    while the layer that actually explains the failure sits underneath.
    """
    if depth > 6 or not isinstance(obj, (dict, list)):
        return None
    best: str | None = None
    values = obj.values() if isinstance(obj, dict) else obj
    if isinstance(obj, dict):
        for key in ("message", "error_message", "detail"):
            val = obj.get(key)
            if isinstance(val, str) and val.strip():
                best = val.strip()
                break
    for val in values:
        inner = _deep_message(val, depth + 1)
        if inner and (best is None or is_fatal(inner) or not is_fatal(best)):
            best = inner
    return best


def _last_text(events: list[str]) -> str:
    """Best-effort reconstruction of the final assistant message from JSONL."""
    chunks: list[str] = []
    final: str | None = None
    for line in events:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        typ = obj.get("type") or obj.get("msg", {}).get("type") if isinstance(obj.get("msg"), dict) else obj.get("type")
        if typ in ("result", "turn.completed", "end", "done"):
            for key in ("result", "last_agent_message", "text", "message"):
                val = obj.get(key)
                if isinstance(val, str) and val.strip():
                    final = val
        if typ in ("text", "agent_message_delta", "item.delta"):
            for key in ("data", "text", "delta", "content"):
                val = obj.get(key)
                if isinstance(val, str):
                    chunks.append(val)
        if typ in ("item.completed", "agent_message"):
            item = obj.get("item") or obj
            if isinstance(item, dict):
                val = item.get("text") or item.get("message")
                if isinstance(val, str) and val.strip():
                    final = val
    return (final or "".join(chunks)).strip()


def script_path(name: str) -> Path:
    """Locate a vendored shell wrapper that ships inside the package."""
    return Path(__file__).resolve().parent.parent / "scripts" / name
