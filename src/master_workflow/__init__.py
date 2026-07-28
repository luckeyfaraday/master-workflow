"""master-workflow — orchestrator -> worker -> critical reviewer, until it scores.

One harness drives Codex, Grok, OpenCode, Claude, and Kimi through a single
worker contract, and a *different* model reviews the resulting diff and scores it
0-10. The loop runs until the score clears the threshold or the budget does.
"""

from .models import Brief, ReviewResult, RunState, WorkerResult

__version__ = "0.1.0"
__all__ = ["Brief", "RunState", "WorkerResult", "ReviewResult", "__version__"]
