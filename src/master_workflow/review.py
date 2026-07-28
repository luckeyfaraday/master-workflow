"""The critical reviewer: a fresh, adversarial, cross-model scoring pass.

Two rules make the score mean something:

1. The reviewer runs on a different backend than the worker, in a clean
   context, with writes disabled.
2. It is shown the **actual diff**, never the worker's own summary of it. A
   worker's final message is the least reliable artifact it produces.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import adapters
from .models import ReviewResult, RunState, WorkerResult

_JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.S)
_BARE_JSON = re.compile(r"(\{[^{}]*\"score\"\s*:.*?\})", re.S)
_LOOSE_SCORE = re.compile(r"\bscore\D{0,12}?(\d{1,2}(?:\.\d)?)\s*(?:/\s*10)?", re.I)

RUBRIC = """\
Score 0-10 on whether the diff actually satisfies the acceptance criteria:

- 0-3   Does not do the task, or is broken.
- 4-6   Partially does it, or does it with defects, missing edge cases, or no
        evidence it was verified.
- 7-8   Does the task, but has real problems a careful engineer would fix first:
        silent failure paths, untested branches, dead or duplicated code,
        misleading names, scope creep outside the stated files.
- 9     Meets every acceptance criterion, is verified, and has no defect worth
        blocking on. Minor taste notes may remain.
- 10    As above, and the approach itself is right --- nothing you would redo.

Calibrate honestly. Most first attempts are a 5-7. Do not award 9 to be
agreeable: a 9 is a claim that you found nothing worth fixing, and the loop
stops when you say so. Equally, do not withhold a 9 over pure preference --- if
the criteria are met and verified, say so.\
"""


def build_review_brief(
    *,
    state: RunState,
    worker: WorkerResult,
    diff: str,
    iteration: int,
) -> str:
    files = "\n".join(f"- `{f}`" for f in worker.files_changed) or "- (none detected)"
    diff_section = (
        diff.strip()
        if diff.strip()
        else "(No diff was produced. If the task required code changes, that alone "
        "is a failing result.)"
    )
    scope = (
        "\n".join(f"- `{p}`" for p in state.file_scope)
        if state.file_scope
        else "- (no explicit scope was set)"
    )
    return f"""\
# Critical review

You are an independent reviewer. You did not write this code and you have no
stake in it passing. Another agent (`{worker.backend}`{f", model {worker.model}" if worker.model else ""}) produced the diff below on
iteration {iteration}. Your job is to find what is wrong with it and score it.

You are running read-only. Do not modify anything. You may read files in the
repository to check the diff in context.

## The goal this work serves

{state.goal.strip()}

## Acceptance criteria

{state.success_criteria.strip()}

## Declared file scope

{scope}

## Files the diff touched

{files}

## The diff

```diff
{diff_section}
```

## Rubric

{RUBRIC}

## What to check

1. Does the diff meet **each** acceptance criterion? Name any it misses.
2. Is there evidence the change actually works, or only a claim that it does?
3. Silent failures: swallowed exceptions, bare excepts, fallbacks that hide a
   real error, results discarded, errors logged and then ignored.
4. Correctness under edge cases the happy path skips.
5. Did it edit outside the declared file scope?
6. Does it fit the surrounding code, or is it a foreign body?

Judge the diff, not the author's description of it. If something looks fine but
you cannot verify it from the diff, say so rather than assuming.

## Required output

End your response with exactly one fenced JSON block, and nothing after it:

```json
{{
  "score": <number 0-10>,
  "verdict": "<one sentence: what would have to change to reach 9>",
  "findings": ["<specific, actionable defect>", "..."],
  "strengths": ["<what is genuinely right>", "..."]
}}
```

Each finding must be specific enough that the next worker can fix it without
asking you a question. "Error handling could be better" is useless; "the bare
`except` at parser.py:88 swallows a real config error and returns an empty dict"
is a finding.
"""


def _looks_like_a_verdict(text: str) -> bool:
    """Did the reviewer actually produce a score, however badly formatted?"""
    return bool(text.strip()) and ('"score"' in text or _LOOSE_SCORE.search(text) is not None)


def parse_review(text: str, *, backend: str, model: str | None, run_dir: str) -> ReviewResult:
    """Pull the verdict out of a reviewer's response, tolerating sloppy output."""
    obj: dict | None = None
    for pattern in (_JSON_BLOCK, _BARE_JSON):
        for match in reversed(pattern.findall(text or "")):
            try:
                cand = json.loads(match)
            except json.JSONDecodeError:
                continue
            if isinstance(cand, dict) and "score" in cand:
                obj = cand
                break
        if obj:
            break

    if obj is None:
        # No structured block. Fall back to a loose score so a formatting slip
        # does not stall the loop, but flag it: an unparsed review can never
        # pass on its own.
        m = _LOOSE_SCORE.search(text or "")
        score = float(m.group(1)) if m else 0.0
        return ReviewResult(
            score=min(score, 8.9),
            verdict="Reviewer did not emit the required JSON block; score inferred from prose.",
            findings=["Reviewer output was unstructured — re-run the review or read it manually."],
            reviewer_backend=backend,
            reviewer_model=model,
            run_dir=run_dir,
            raw=text or "",
            parse_ok=False,
        )

    try:
        score = float(obj.get("score", 0))
    except (TypeError, ValueError):
        score = 0.0
    score = max(0.0, min(10.0, score))

    def _strlist(key: str) -> list[str]:
        val = obj.get(key) or []
        if isinstance(val, str):
            return [val]
        return [str(v) for v in val if str(v).strip()]

    return ReviewResult(
        score=score,
        verdict=str(obj.get("verdict", "")).strip(),
        findings=_strlist("findings"),
        strengths=_strlist("strengths"),
        reviewer_backend=backend,
        reviewer_model=model,
        run_dir=run_dir,
        raw=text or "",
        parse_ok=True,
    )


def run_review(
    *,
    state: RunState,
    worker: WorkerResult,
    diff: str,
    iteration: int,
    out_dir: Path,
    timeout: int = 1200,
) -> ReviewResult:
    backend = adapters.pick_reviewer(state.worker_backend, state.reviewer_backend)
    if backend is None:
        return ReviewResult(
            score=0.0,
            verdict="No reviewer backend available.",
            findings=[
                "Install a second agent CLI (codex, claude, grok, or opencode) so "
                "the worker is not the only agent that saw this diff."
            ],
            run_dir=str(out_dir),
            parse_ok=False,
        )

    brief = build_review_brief(state=state, worker=worker, diff=diff, iteration=iteration)
    result = adapters.get(backend).run(
        prompt=brief,
        cwd=Path(state.cwd),
        out_dir=out_dir,
        model=state.reviewer_model,
        read_only=True,
        timeout=timeout,
    )

    # A reviewer that could not run is not a verdict. Distinguish it from a
    # reviewer that ran and scored low, so the loop stops instead of treating an
    # infrastructure failure as a quality signal and iterating against it.
    if not result.ok and not _looks_like_a_verdict(result.last_message):
        return ReviewResult(
            score=0.0,
            verdict=f"Reviewer {backend} failed to run (exit {result.exit_code}).",
            findings=[result.error or "reviewer produced no output"],
            reviewer_backend=backend,
            reviewer_model=state.reviewer_model,
            run_dir=str(out_dir),
            parse_ok=False,
            reviewer_error=result.error or f"exit {result.exit_code}",
        )

    review = parse_review(
        result.last_message,
        backend=backend,
        model=state.reviewer_model,
        run_dir=str(out_dir),
    )
    (out_dir / "review.json").write_text(
        json.dumps(
            {
                "score": review.score,
                "verdict": review.verdict,
                "findings": review.findings,
                "strengths": review.strengths,
                "reviewer_backend": review.reviewer_backend,
                "reviewer_model": review.reviewer_model,
                "parse_ok": review.parse_ok,
            },
            indent=2,
        )
    )
    return review
