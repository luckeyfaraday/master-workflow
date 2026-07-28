from __future__ import annotations

import json
from pathlib import Path

from .base import Adapter


class ClaudeAdapter(Adapter):
    name = "claude"
    binary = "claude"
    strengths = (
        "Frontend, UI, visual and rendering work, and anything needing taste rather "
        "than throughput. Also a good reviewer. Prefer it whenever the output is "
        "something a human will look at."
    )
    known_models = ("opus", "sonnet", "haiku")
    supports_read_only = True
    read_only_enforced = False  # edit tools denied by name, not sandboxed

    def _argv(self, *, prompt_file, prompt, cwd, out_dir, model, read_only, resume, session_id):
        argv = ["claude", "-p", "--output-format", "json"]
        if model:
            argv += ["--model", model]
        if resume:
            argv += ["--resume", resume]
        else:
            argv += ["--session-id", session_id]
        if read_only:
            # Claude Code's --allowedTools is additive (it whitelists tools past
            # the permission prompt), not exclusive, so it cannot be used to lock
            # a reviewer down --- the user's own settings allowlist still applies.
            # Deny the editing tools by name instead. The reviewer keeps Bash on
            # purpose: a reviewer that can actually run the tests finds real
            # defects instead of guessing from the diff.
            #
            # This is a tool restriction, not an OS sandbox. For hard enforcement
            # use codex (-s read-only) or grok (--sandbox read-only) as reviewer.
            argv += [
                "--disallowed-tools",
                "Write",
                "Edit",
                "MultiEdit",
                "NotebookEdit",
                "--permission-mode",
                "acceptEdits",
            ]
        else:
            argv += ["--dangerously-skip-permissions"]
        argv += ["--", prompt]
        return argv

    def _finalize(self, out_dir: Path, raw: str) -> None:
        out_dir = Path(out_dir)
        (out_dir / "events.jsonl").write_text(raw if raw.startswith("{") else "")
        text = raw.strip()
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                text = obj.get("result") or obj.get("text") or text
                sid = obj.get("session_id")
                if isinstance(sid, str) and sid:
                    (out_dir / "session_id").write_text(sid + "\n")
        except json.JSONDecodeError:
            pass
        (out_dir / "last_message.txt").write_text(text)

    def _sandbox_state(self, out_dir, read_only):
        return "edit-tools denied (not OS-enforced)" if read_only else "workspace-write"
