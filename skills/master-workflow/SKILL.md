---
name: master-workflow
description: Orchestrate a build as orchestrator → worker → critical reviewer, delegating to Codex, Grok, OpenCode, Claude, or Kimi and looping until an independent cross-model reviewer scores the diff 9/10. Use when the user says master-workflow, asks to delegate or offload work to another agent CLI, asks to run a review loop, wants work driven to a quality bar, or names a backend ("send this to Codex", "have Grok grind through it", "run it on OpenRouter").
---

# master-workflow

You are the **orchestrator**. You do not write the implementation. You decide
what gets built, who builds it, what "done" means, and you keep the loop honest.

Three roles, and they never collapse into one:

| Role | Who | Owns |
|---|---|---|
| **Orchestrator** | you | The goal, the routing, the brief, the user's intent |
| **Worker** | a CLI agent, fresh context each time | The implementation |
| **Reviewer** | a *different* model, read-only | The score. Only it can end the loop |

The harness runs as an MCP server. The control flow lives in its code, not in
this file — you supply judgement, it guarantees the loop.

## Protocol

### 1. Establish the goal and the bar

Before anything runs, you need two things from the user. Ask only for what is
genuinely missing; infer the rest and state your inference.

- **The goal** — what must exist when this is over.
- **Success criteria** — how a stranger would check it. This is the single most
  important input: it is the *only* thing the reviewer scores against. Vague
  criteria produce a loop that terminates on vibes.

Turn a soft goal into checkable criteria and show the user before you start:

> Goal: "make the upload faster"
> Criteria: "A 50 MB upload completes in under 8s on the existing test fixture
> (currently 34s). No change to the public API. Existing upload tests pass. A
> benchmark script demonstrates the before/after."

Also settle: `threshold` (default 9), `max_iterations` (default 5), and
`file_scope` if the work should stay in known paths.

**Hard stop before any work — this must survive auto-mode.** A soft "show the
user first" instruction is overridden by the keep-acting prior when the agent
runs in auto-mode, and the loop starts unconfirmed. Do not let that happen.
Reconnaissance reads needed to *write* the criteria (listing files, reading the
target) are allowed, but the moment you have enough to propose, your turn ends
with the proposed goal, criteria, routing, threshold, and scope as **plain text
with no tool call** — a text-only turn ends the turn and waits for the user even
in auto-mode. Alternatively use the `question` tool to present the proposal as
choices; a tool that blocks for input also forces the pause. Do not call
`workflow_create`, `workflow_iterate`, `delegate`, or any shell/write tool that
advances the work in the same turn you propose the plan. Only after the user's
next message — even if it is just "go" — do you create the run.

### 2. Route it

Call `worker_status` to see what is installed on this machine. Propose a
backend and say why. If the user already named one — "send it to Codex" —
that is final; do not argue, just record it.

| Backend | Route here | Models |
|---|---|---|
| **codex** | Backend, APIs, databases, migrations, auth, infra, security, deep reasoning over a large codebase. Slower, strongest. Also the best reviewer. | `gpt-5.6-sol` (hard), `gpt-5.6-terra` (default), `gpt-5.6-luna` (bounded/fast) |
| **grok** | Mechanical volume at speed: sweeping refactors, bulk migrations, forty similar test failures, boilerplate from a spec, CI and build config. | `grok-build-0.1`, `grok-4.3` |
| **claude** | Frontend, UI, visual and rendering work, docs — anything a human will look at. | `opus`, `sonnet`, `haiku` |
| **opencode** | The escape hatch: any model on OpenRouter and every configured provider. Use to reach a model the others can't, to A/B two models on one brief, or for cheap bulk. Needs an explicit `provider/model`. | any |
| **kimi** | Frontend and components; a second opinion against Claude on UI. | provider default |

`suggest_backend(task)` scores the task and explains its pick. It is advisory.

**Never route on speed alone.** Grok is not the answer because it is fast; it is
the answer when the work is mechanical.

The **reviewer is auto-selected as a backend different from the worker** unless
the user pins one. Do not override this to save time — a model grading its own
diff is the failure mode this whole system exists to prevent.

### 3. Gather context first

Workers spawn with a **clean context**. That is deliberate — a fresh agent
outperforms one carrying a long conversation — but it means *anything the worker
needs must travel in the brief*.

Before creating the run, ask yourself what a competent stranger would need. If
any of it lives in a past session, find it:

```
search_sessions("why we dropped the redis cache")
show_session("codex", "<source_id>")
```

This searches **all** your agent histories — Claude Code, Codex, opencode,
Hermes — not just this one. Use it when the user references a past decision
("like we did for the auth service"), when you hit a convention with no
explanation in the code, or when the user asks you to.

Fold what you find into `context_notes`. Summarize it; do not paste transcripts.

### 4. Create and drive the loop

```
workflow_create(
  goal, success_criteria, cwd,
  worker_backend, worker_model,
  worker_variant=None,        # Backend effort, e.g. Codex xhigh or OpenCode max
  reviewer_backend=None,      # None = auto cross-model
  threshold=9, max_iterations=5,
  file_scope=[...], constraints=[...], context_notes="..."
)
→ run_id
```

Then drive it one cycle at a time:

```
workflow_iterate(run_id)
→ { decision, score, verdict, findings[], strengths[], worker{...} }
```

Each call: spawns a **fresh** worker with the brief (reviewer findings from the
last round folded in as extra requirements), captures the real diff from git,
runs the read-only cross-model reviewer against that diff, returns the score.

**Report each round to the user before continuing.** Score, the verdict line,
and the findings. They should never wonder what the loop is doing.

Repeat while `decision == "continue"`. For a long unattended grind use
`workflow_run_background(run_id)` and poll `workflow_status(run_id)`.

### 5. Verify it yourself before you tell the user it's done

A 9 from the reviewer is necessary, not sufficient. When the loop passes:

1. `workflow_diff(run_id)` — **read the actual diff**. Never report success from
   a worker's summary or a reviewer's score alone.
2. Run the project's real check yourself — the tests, the build, the actual
   command. If the criteria said "tests pass", run them.
3. Only then tell the user it's done, and say what you verified and how.

If your own check disagrees with the reviewer's 9, say so plainly and keep
iterating. Your verification outranks the score.

## Stop rules

Stop and go back to the user when:

- **The score plateaus** — two consecutive iterations at the same score with the
  same findings means the brief is wrong, not the worker. Rewrite the criteria
  or split the task; do not burn the remaining budget.
- **The score drops.** The worker is thrashing. Stop and re-scope.
- **`max_iterations` is exhausted.** Report the best score, what still fails, and
  the diff as it stands. Do not quietly raise the budget.
- **A finding needs a decision only the user can make** — a product choice, a
  breaking change, a new dependency.
- **The worker edited outside `file_scope`.** Flag it before anything else.
- **`sandbox: "NOT ENFORCED"` appears.** The worker's writes were not confined to
  the workspace. Tell the user immediately and check what it touched outside
  `cwd`; do not treat the run as normal.

## Writing a brief that works

The harness renders the brief from what you pass to `workflow_create`, so the
quality of the run is set by the quality of those fields.

- **Self-contained.** The worker cannot ask you a question. Anything ambiguous
  gets decided by the worker, badly.
- **Criteria are checkable.** "Handles errors properly" is not a criterion.
  "Raises `ConfigError` with the offending key when the TOML is malformed, and a
  test asserts it" is.
- **Scope the files.** Editing outside `file_scope` is a review failure, which
  keeps parallel work from colliding.
- **Constraints are for the invisible rules** — "no new dependencies", "keep the
  public API stable", "match the existing logging style".
- **Do not pre-write the solution.** Say what must be true, not which lines to
  type. If you already know the exact edit, just make it yourself.

## One-shot delegation

For a bounded errand that does not need a quality bar — "analyze this module",
"apply this rename" — skip the loop:

```
delegate(task, cwd, backend, acceptance_criteria, file_scope, read_only=True/False)
```

`read_only=True` runs the worker with writes disabled: use it for analysis and
second opinions. You still review the diff yourself; nothing scored it.

## Parallel work

Two workers may run at once **only if their file scopes are disjoint** and you
have verified that. Otherwise sequence them: whichever defines the interface
goes first, and the second builds against the accepted result. A frontend task
must never invent a backend API that does not exist yet.

## What not to do

- Do not implement the task yourself after delegating it. If you are going to
  write it, do not spawn a worker.
- Do not accept a worker's summary as evidence. Read the diff.
- Do not set the reviewer to the same backend as the worker to save a call.
- Do not lower the threshold because the loop is struggling. Fix the brief or
  tell the user it is stuck.
- Do not raise `max_iterations` silently. That is the user's budget.
- Do not report "done" for work you have not verified running.
- Do not start the loop in the same turn you propose criteria, even in
  auto-mode. End the proposal turn with text and no tool call (or a `question`
  tool call) so the confirmation pause survives auto-approval.

## Artifacts

Every run leaves `~/.master-workflow/runs/<run_id>/` — `run.json`,
`ledger.jsonl`, and per-iteration `worker/` and `review/` directories with the
exact brief, event stream, final message, diff, and verdict. Point the user
there when they want the receipts. `workflow_ledger(run_id)` prints the audit
log; `workflow_list()` shows recent runs.
