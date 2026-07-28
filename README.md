# master-workflow

**An orchestrator, a worker, and a critical reviewer that will not let the work
pass until it scores 9 out of 10.**

You tell your agent what to build, which backend to send it to, and what "done"
means. It writes a self-contained brief, spawns a worker — **Codex**, **Grok**,
**OpenCode**, **Claude**, or **Kimi** — captures the real diff from git, then
hands that diff to a *different model* running read-only, which scores it 0–10
against your acceptance criteria. Below threshold, the findings become the next
brief and a **fresh** worker tries again. The loop is deterministic code, not a
prompt that promises to loop.

Ships as an **MCP server** and an **agent skill**, plus a plain CLI.

```
                    ┌──────────────── harness (deterministic) ────────────────┐
you ─▶ orchestrator ─▶ brief ─▶ worker CLI ─▶ git diff ─▶ reviewer ─▶ score ≥ 9?
       (your agent)     ▲       fresh ctx     (not the    (other model,   │ no
                        │                      summary)    read-only)     │
                        └──────── findings folded into a new brief ◀───────┘
```

## Why it is shaped like this

**The reviewer is never the worker.** A model grading its own diff scores it far
too generously, and your orchestrator's context already wants the task to be
finished. The reviewer runs on a different backend, in a clean context, with
writes disabled. It is the only thing that can end the loop.

**The reviewer reads the diff, never the summary.** A worker's final message is
the least reliable artifact it produces. The harness takes the diff from git
itself and puts *that* in front of the reviewer.

**Every iteration spawns a fresh worker.** A context that already argued for a
failed attempt tends to defend it; a clean one reads the reviewer's findings as
requirements. Everything the worker needs travels in the brief, which is why the
brief is the thing worth designing. (`carry_session: true` opts out.)

**Verify, don't trust.** Grok's `--sandbox` silently does nothing when there is
no TTY — the Landlock profile fails to apply, the run continues unconfined, and
the command still exits `0`. The vendored wrapper supplies a PTY and then
*verifies* enforcement after the fact, reporting `NOT ENFORCED` rather than
letting an unconfined run pass as a sandboxed one.

## Install

Requires Python 3.10+ and at least two agent CLIs (one to work, one to review).

```bash
git clone https://github.com/luckeyfaraday/master-workflow
cd master-workflow
python3 -m venv .venv && .venv/bin/pip install -e ".[mcp]"
.venv/bin/master-workflow status
```

```
backend    installed  review-sandbox  version
codex      yes        os-enforced     codex-cli 0.145.0
grok       yes        os-enforced     grok 0.2.112
claude     yes        tool-denied     2.1.220 (Claude Code)
opencode   yes        none            0.0.0-dev
kimi       yes        none            kimi, version 1.49.0
```

`review-sandbox` is how a reviewer's writes are suppressed. **os-enforced**
means the sandbox blocks them (`codex -s read-only`, `grok --sandbox
read-only`) while the reviewer can still run the tests — the best kind.
**tool-denied** means the editing tools are denied by name but nothing stops a
shell command; Claude Code's `--allowedTools` is additive, not exclusive, so it
cannot be used to lock a reviewer down. **none** means don't review with it. The
harness prefers `os-enforced` reviewers automatically.

### As an MCP server

```bash
claude mcp add --scope user master-workflow -- /path/to/master-workflow/.venv/bin/master-workflow-mcp
```

### As a skill

```bash
ln -s "$PWD/skills/master-workflow" ~/.claude/skills/master-workflow
```

Then just talk to your agent:

> Use master-workflow to add rate limiting to the API. Send it to Codex, have
> Claude review it, and don't stop until it's a 9.

## Which backend for what

Suggestions, not rules — your explicit choice always wins.

| Backend | Route it here | Models |
|---|---|---|
| **codex** | Backend, APIs, databases, migrations, auth, infra, security, deep reasoning over a large codebase. The strongest reviewer. | `gpt-5.6-sol` (hard), `gpt-5.6-terra` (default), `gpt-5.6-luna` (bounded, fast) |
| **grok** | Speed on mechanical volume: sweeping refactors, bulk migrations, forty similar test failures, boilerplate, CI config. | `grok-build-0.1`, `grok-4.3` |
| **claude** | Frontend, UI, visual and rendering work — anything a human will look at. Also a good reviewer. | `opus`, `sonnet`, `haiku` |
| **opencode** | The escape hatch: any model on OpenRouter and every other configured provider. Reach a model the others can't, or A/B two models on one brief. | any `provider/model` |
| **kimi** | Frontend and components; a second opinion against Claude on UI. | provider default |

`master-workflow suggest "<task>"` scores a task against these and explains the
route it picks.

## Use it from the CLI

```bash
master-workflow run \
  --goal "Add a /health endpoint that reports DB connectivity" \
  --criteria "Returns 200 with {status,db} when reachable, 503 when not. Has a test. Existing tests still pass." \
  --cwd ~/code/api \
  --backend codex --reviewer claude \
  --threshold 9 --max-iterations 4
```

```
run_id=20260728-141902-add-a-health-endpoint
worker=codex reviewer=claude threshold=9.0

iteration 1  worker=codex  reviewer=claude  score=6.0/9.0
verdict: Endpoint works but the failure path is untested and swallows the error.
  - `except Exception: return {"db": "down"}` at health.py:24 hides the real error
  - No test covers the 503 branch
-> continue: score 6.0 < 9.0; 2 findings to fix

iteration 2  worker=codex  reviewer=claude  score=9.0/9.0
verdict: Meets every criterion; failure path tested and the error is surfaced.
-> stop: score 9.0 >= 9.0

status=passed best_score=9.0 — score 9.0 >= 9.0
```

Other commands: `status`, `suggest`, `iterate <run_id>`, `list`, `show <run_id>`,
`ledger <run_id>`, `search <query>`.

## MCP tools

| Tool | Purpose |
|---|---|
| `worker_status` | What's installed, what each backend is good at, who can review |
| `suggest_backend` | Advisory route for a task description |
| `search_sessions` / `show_session` | Full-text search across Claude Code, Codex, opencode, and Hermes history |
| `workflow_create` | Register goal + criteria + routing; returns a `run_id` |
| `workflow_iterate` | One worker → reviewer cycle, blocking. The primary driver |
| `workflow_run_background` | Hand the whole loop off; poll `workflow_status` |
| `workflow_status` / `workflow_list` / `workflow_ledger` | Progress and audit |
| `workflow_diff` | The actual diff, so the orchestrator can review it too |
| `workflow_abort` | Stop a run |
| `delegate` | One-shot worker run, no loop, for bounded errands |

## Context from your own history

Workers start clean, so anything they need has to travel in the brief. When the
goal depends on a decision made in an earlier session — with *any* agent —
`search_sessions` finds it and the orchestrator folds it into `context_notes`
before the first worker spawns.

```bash
master-workflow search "why we dropped the redis cache" --agent codex
```

Requires [`sessions-search`](https://github.com/luckeyfaraday/sessions-search) on
PATH. Optional — everything else works without it.

## Run artifacts

Everything writes to one layout, so resume works uniformly and the audit log is
just the filesystem:

```
~/.master-workflow/runs/<run_id>/
    run.json                  full state, rewritten on every transition
    ledger.jsonl              append-only event log
    iterations/01/worker/     brief.md prompt.md events.jsonl last_message.txt
                              session_id diff.patch sandbox stderr.log
    iterations/01/review/     brief.md last_message.txt review.json
```

Override the root with `MASTER_WORKFLOW_HOME`.

## Scoring rubric

The reviewer is calibrated to be hard to please:

| Score | Means |
|---|---|
| 0–3 | Doesn't do the task, or is broken |
| 4–6 | Partial, defective, or no evidence it was verified |
| 7–8 | Works, but has real problems a careful engineer would fix first |
| **9** | Meets every criterion, verified, nothing worth blocking on |
| 10 | As above, and the approach itself is right |

A review that fails to emit its JSON verdict is capped below threshold — an
unparsed review can never end the loop on its own.

## Credits

Consolidates ideas from [codex-router](https://github.com/luckeyfaraday/codex-router),
[delegate-to-grok](https://github.com/luckeyfaraday/delegate-to-grok),
[delegate-to-opencode](https://github.com/luckeyfaraday/delegate-to-opencode),
[frontier-orchestrator](https://github.com/luckeyfaraday/frontier-orchestrator),
[athena-loops](https://github.com/luckeyfaraday/athena-loops),
[athena-graphs](https://github.com/luckeyfaraday/athena-graphs),
[multi-loops](https://github.com/luckeyfaraday/multi-loops), and
[sessions-search](https://github.com/luckeyfaraday/sessions-search). The Grok PTY
sandbox wrapper is vendored from `delegate-to-grok`.

## License

MIT
