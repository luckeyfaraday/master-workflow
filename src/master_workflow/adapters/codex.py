from __future__ import annotations

from pathlib import Path

from .base import Adapter


class CodexAdapter(Adapter):
    name = "codex"
    binary = "codex"
    strengths = (
        "Backend and systems work: APIs, databases, migrations, auth, infrastructure, "
        "security-sensitive changes, and anything needing deep multi-step reasoning "
        "over a large codebase. The strongest reviewer of the set. Slower per task."
    )
    known_models = ("gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna")
    supports_variants = True
    known_variants = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
    supports_read_only = True
    read_only_enforced = True  # -s read-only is an OS sandbox

    def _argv(
        self, *, prompt_file, prompt, cwd, out_dir, model, variant, read_only, resume, session_id
    ):
        argv = [
            "codex",
            "exec",
            "--json",
            "--skip-git-repo-check",
            "-C",
            str(cwd),
            "-s",
            "read-only" if read_only else "workspace-write",
            "-o",
            str(Path(out_dir) / "last_message.txt"),
            "-c",
            'approval_policy="never"',
        ]
        if model:
            argv += ["-m", model]
        if variant:
            argv += ["-c", f'model_reasoning_effort="{variant}"']
        if resume:
            argv += ["resume", resume]
        argv.append("-")  # read the brief from stdin
        return argv

    def _stdin(self, prompt: str) -> str:
        return prompt

    def _sandbox_state(self, out_dir, read_only):
        return "read-only" if read_only else "workspace-write"
