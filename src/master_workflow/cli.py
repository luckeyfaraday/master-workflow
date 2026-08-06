"""Plain CLI, so the harness is usable without an MCP host."""

from __future__ import annotations

import argparse
import json
import sys

from . import adapters, context, loop, routing, rundir


def _fmt_status() -> str:
    lines = ["backend    installed  review-sandbox  version"]
    for row in routing.routing_table():
        lines.append(
            f"{row['backend']:<10} {'yes' if row['available'] else 'no':<10} "
            f"{row['review_sandbox']:<15} {row['version'] or '-'}"
        )
    lines.append("")
    lines.append(f"sessions-search: {'available' if context.available() else 'not installed'}")
    lines.append(f"runs dir:        {rundir.runs_root()}")
    return "\n".join(lines)


def _print_iteration(res: dict) -> None:
    if "score" not in res:
        print(json.dumps(res, indent=2, default=str))
        return
    print(
        f"\niteration {res['iteration']}  "
        f"worker={res['worker']['backend']}  "
        f"reviewer={res['reviewer_backend']}  "
        f"score={res['score']}/{res['threshold']}"
    )
    if res.get("verdict"):
        print(f"verdict: {res['verdict']}")
    for f in res.get("findings", []):
        print(f"  - {f}")
    print(f"-> {res['decision']}: {res['reason']}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="master-workflow", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="show installed backends and routing table")

    s = sub.add_parser("suggest", help="recommend a backend for a task")
    s.add_argument("task")

    r = sub.add_parser("run", help="create a run and loop it to threshold")
    r.add_argument("--goal", required=True)
    r.add_argument("--criteria", required=True)
    r.add_argument("--cwd", default=".")
    r.add_argument("--backend", default="codex")
    r.add_argument("--model", default=None)
    r.add_argument(
        "--variant",
        default=None,
        help="backend model variant/reasoning effort (for example xhigh or max)",
    )
    r.add_argument("--reviewer", default=None, help="pin a reviewer backend")
    r.add_argument("--reviewer-model", default=None)
    r.add_argument("--threshold", type=float, default=9.0)
    r.add_argument("--max-iterations", type=int, default=5)
    r.add_argument("--scope", action="append", default=[], help="repeatable file scope")
    r.add_argument("--constraint", action="append", default=[])
    r.add_argument("--carry-session", action="store_true")

    i = sub.add_parser("iterate", help="run one worker -> review cycle on a run")
    i.add_argument("run_id")
    i.add_argument("--carry-session", action="store_true")

    sub.add_parser("list", help="list recent runs")

    sh = sub.add_parser("show", help="show a run's status and history")
    sh.add_argument("run_id")

    lg = sub.add_parser("ledger", help="print a run's audit log")
    lg.add_argument("run_id")

    se = sub.add_parser("search", help="search past agent sessions")
    se.add_argument("query")
    se.add_argument("--agent", default=None, choices=list(context.AGENTS))
    se.add_argument("--limit", type=int, default=10)

    a = p.parse_args(argv)

    if a.cmd == "status":
        print(_fmt_status())
        return 0

    if a.cmd == "suggest":
        print(json.dumps(routing.suggest(a.task), indent=2))
        return 0

    if a.cmd == "run":
        state = loop.create_run(
            goal=a.goal,
            success_criteria=a.criteria,
            cwd=a.cwd,
            worker_backend=a.backend,
            worker_model=a.model,
            worker_variant=a.variant,
            reviewer_backend=a.reviewer,
            reviewer_model=a.reviewer_model,
            threshold=a.threshold,
            max_iterations=a.max_iterations,
            file_scope=a.scope,
            constraints=a.constraint,
        )
        reviewer = adapters.pick_reviewer(a.backend, a.reviewer)
        print(f"run_id={state.run_id}")
        worker_config = " ".join(
            x
            for x in (
                a.backend,
                f"model={a.model}" if a.model else "",
                f"variant={a.variant}" if a.variant else "",
            )
            if x
        )
        print(f"worker={worker_config} reviewer={reviewer} threshold={a.threshold}")
        print(f"run_dir={rundir.run_path(state.run_id)}")
        for _ in range(a.max_iterations):
            res = loop.iterate(state.run_id, carry_session=a.carry_session)
            _print_iteration(res)
            if res.get("decision") == "stop":
                break
        final = rundir.read_state(state.run_id)
        print(f"\nstatus={final.status} best_score={final.best_score} — {final.stop_reason}")
        return 0 if final.status == "passed" else 1

    if a.cmd == "iterate":
        _print_iteration(loop.iterate(a.run_id, carry_session=a.carry_session))
        return 0

    if a.cmd == "list":
        for r_ in rundir.list_runs():
            print(
                f"{r_['run_id']:<50} {str(r_['status']):<10} "
                f"score={r_['best_score']:<5} iters={r_['iterations']}"
            )
        return 0

    if a.cmd == "show":
        st = rundir.read_state(a.run_id)
        print(st.to_json())
        return 0

    if a.cmd == "ledger":
        for ev in rundir.read_ledger(a.run_id):
            print(json.dumps(ev, default=str))
        return 0

    if a.cmd == "search":
        print(json.dumps(context.search(a.query, agent=a.agent, limit=a.limit), indent=2))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
