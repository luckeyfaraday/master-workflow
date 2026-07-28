from __future__ import annotations

from pathlib import Path

from .base import Adapter, script_path


class GrokAdapter(Adapter):
    name = "grok"
    binary = "grok"
    strengths = (
        "Speed on mechanical volume: sweeping refactors, bulk migrations, forty "
        "similar test failures, boilerplate from a spec, CI and build config. Route "
        "here for throughput on domain-neutral work, not for design judgement."
    )
    known_models = ("grok-build-0.1", "grok-4.3")
    supports_read_only = True
    read_only_enforced = True  # --sandbox read-only, verified after the run

    def _argv(self, *, prompt_file, prompt, cwd, out_dir, model, read_only, resume, session_id):
        # Goes through the vendored wrapper because grok's --sandbox is applied
        # via Landlock, which needs a TTY. Headless, the profile silently fails
        # to apply and grok runs unconfined while still exiting 0. The wrapper
        # supplies a PTY and verifies enforcement after the fact.
        argv = [
            "bash",
            str(script_path("run-grok.sh")),
            "-C",
            str(cwd),
            "--run-dir",
            str(out_dir),
            "-s",
            "read-only" if read_only else "workspace",
            "-l",
            "review" if read_only else "work",
        ]
        if model:
            argv += ["-m", model]
        if resume:
            argv += ["--resume", resume]
        argv.append("-")
        return argv

    def _stdin(self, prompt: str) -> str:
        return prompt

    def _finalize(self, out_dir: Path, raw: str) -> None:
        # The wrapper already wrote events.jsonl / last_message.txt / session_id.
        out_dir = Path(out_dir)
        if not (out_dir / "last_message.txt").exists():
            (out_dir / "last_message.txt").write_text(raw.strip())

    def _sandbox_state(self, out_dir, read_only):
        f = Path(out_dir) / "sandbox"
        if f.exists():
            return f.read_text().strip() or "unknown"
        return "unknown"


class OpenCodeAdapter(Adapter):
    name = "opencode"
    binary = "opencode"
    strengths = (
        "The escape hatch: runs any model on OpenRouter and every other configured "
        "provider. Use it to reach a model the other backends cannot, to A/B two "
        "models on the same brief, or for cheap high-volume work. Pass an explicit "
        "provider/model — run `opencode models` to see what is authenticated."
    )
    known_models = ()
    supports_read_only = False  # no enforced read-only mode; reviewers use others

    def _argv(self, *, prompt_file, prompt, cwd, out_dir, model, read_only, resume, session_id):
        argv = [
            "bash",
            str(script_path("run-opencode.sh")),
            "-C",
            str(cwd),
            "--run-dir",
            str(out_dir),
            "-l",
            "review" if read_only else "work",
        ]
        if model:
            argv += ["-m", model]
        if resume:
            argv += ["--resume", resume]
        argv.append("-")
        return argv

    def _stdin(self, prompt: str) -> str:
        return prompt

    def _finalize(self, out_dir: Path, raw: str) -> None:
        out_dir = Path(out_dir)
        if not (out_dir / "last_message.txt").exists():
            (out_dir / "last_message.txt").write_text(raw.strip())

    def _sandbox_state(self, out_dir, read_only):
        return "none (opencode has no enforced sandbox)"
