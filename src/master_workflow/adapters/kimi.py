from __future__ import annotations

from .base import Adapter


class KimiAdapter(Adapter):
    name = "kimi"
    binary = "kimi"
    strengths = (
        "Frontend, components, styling, and design-leaning implementation. A useful "
        "second opinion against Claude on UI work."
    )
    known_models = ()
    #: --plan blocks edits but is not a hard sandbox; keep it out of the
    #: automatic reviewer rotation unless the user names it.
    supports_read_only = False

    def _argv(self, *, prompt_file, prompt, cwd, out_dir, model, read_only, resume, session_id):
        argv = [
            "kimi",
            "--print",
            "--output-format",
            "stream-json",
            "-w",
            str(cwd),
        ]
        if model:
            argv += ["-m", model]
        if resume:
            argv += ["--session", resume]
        if read_only:
            argv += ["--plan"]
        else:
            argv += ["--yolo"]
        argv += ["--afk", "--prompt", prompt]
        return argv

    def _sandbox_state(self, out_dir, read_only):
        return "plan mode (no edits)" if read_only else "workspace-write"
