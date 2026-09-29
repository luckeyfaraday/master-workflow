# Lines builds

A lines build drives several lines of work (tracks, assets, features), each in its own git worktree, to their bar
at once, on Claude Code's Workflow tool. It is the master-workflow loop (fresh worker, then a fresh reviewer, until
the bar is met) made to survive a long build on one machine. It came out of a two-day game build with 34 lines and
450 agents, where most lines stalled at 7-8/10, a crash stopped every loop for 12 hours, the user's first playtest
came after 46 hours, and the machine, not the model, set the pace.

| file | what it is |
|---|---|
| `run-lines.js` | the workflow script: every line's rounds, the machine-wide agent limit, merges one at a time, playtest stops |
| `lines.mjs` | the command line: workflow args from the progress log, status, the session-start hook, the user's decisions and playtests, waiting, calibration, config checks |
| `limits.mjs` | how many agents this machine can run at once now, from free memory (commit headroom on Windows) and disk |
| `slot.mjs` | a machine-wide queue for heavy commands (Blender, browsers, renders), with caps a watcher can set |
| `example/` | a small `project.json` and `lines.json` |
| `test/` | `node --test skills/master-workflow/lines/test/lines.test.mjs` runs the loop under a mock of the Workflow runtime |

## What a round does

1. **Work.** A fresh worker starts from the line's best round (after a round judged worse it resets to it; the
   worse commit keeps a `<tagPrefix>/<line>-r<N>-worse` tag), merges main, and fixes the open findings by id, or
   disputes one with evidence.
2. **Review.** A fresh, read-only reviewer builds its own evidence and:
   - settles every open finding by id: fixed, open, worse, or dropped (only when it was wrong, with the reason);
   - compares the round with the best round so far, on the same seeds and views: better, same or worse;
   - checks every criterion (C1..Cn) and hard rule (H1..Hn);
   - adds at most 3 new blocking findings, each naming the criterion or hard rule it breaks. Anything else is minor
     and is logged, not sent to the worker;
   - scores on the user's calibration images, when the line has them.

   A line passes when no hard rule fails, no finding is open, and every criterion is met. The findings list is why
   the bar cannot move between rounds: a new reviewer cannot bring a fresh set of complaints, only settle the old
   ones and add up to three that point at the brief.
3. **Stalls.** A round that is not better than the best counts as a stall. After 2 stalls a rethink agent works out
   why and tests its idea on a scratch branch (`<branch>-rethink-r<N>`) before writing the next worker's plan. After
   3 the line stops, logs a `pause`, and waits (without holding an agent slot, up to `decisionWaitHours`) for the
   user: accept the best round, continue with a direction, or drop the line. The decision takes effect in the same
   run; the other lines keep going.
4. **Merge.** A passed or accepted line merges its best commit into main, one line at a time, and runs the merge
   checks. A line with `"merge": "on-better"` (an asset replacing a stand-in, anything that improves what main
   already has) is compared with main from its first round and merges every better round at once, so everything
   else builds on it; it keeps going until it passes or stops.

## Waves and playtests

Lines carry a `wave` (default 1). A run takes the lowest wave with unfinished lines. With a `playtest` section in
the project, the run that merges the last line of a wave checks main, tags it `<tagPrefix>/playtest-w<N>`, logs a
`playtest-ready` entry with the command to play it, and returns. The next wave starts only after the user played it:
`lines.mjs playtest <project> <wave> "<their notes>"`. Turn each note into a criterion of the line it is about (or
a new line) first, and reopen merged lines that need work with `decide <line> reopen "<note>"`.

Put the setup in wave 1 (the foundation and stand-ins for every asset, so no track waits for an asset), and the
first playtest comes within hours, not days.

## Surviving a long build

- **One workflow for every line.** The agent limit is shared, so lines cannot overload the machine between them.
  `lines.mjs args` sets it from what is free now (`limits.mjs`). A free slot goes to the line most other lines wait
  on (`after`), and merges go first.
- **Heavy tools queue.** Wrap a heavy command with `node slot.mjs --pool blender --max 2 -- <command>`, or call
  `acquire(pool, max)` from `slot.mjs` in the project's own tools. `setCap(pool, n)` lowers a pool for new starts
  (a `.cap` file in the pool), so a watcher can slow the build down when memory or disk runs low without killing
  anything, and `setCap(pool, null)` lifts it.
- **State lives in the log, not the session.** Every work round, review, rethink, stop, decision, merge and playtest
  is an entry in the project's log. `lines.mjs` replays it with the state machine block of `run-lines.js` itself, so
  a relaunched build continues exactly where the log stops. Reviews logged before the findings list existed replay
  by score.
- **Restarts.** Install `lines.mjs status --hook` as a SessionStart hook in the project's `.claude/settings.json`
  (matcher `startup|resume|compact|clear`). When a session starts, resumes or compacts with something waiting, it
  says which lines are interrupted, which need a decision, whether a build is ready to play, and the exact commands.
- **Nobody babysits.** Run `lines.mjs wait <project>` in the background after launching: it exits, and so wakes the
  session, only when a line stops for a decision or a build is ready to play.

## Running a build

```sh
K=~/.claude/skills/master-workflow/lines
node $K/lines.mjs check path/to/project.json                   # ports, worktrees, branches, waves, measurable criteria
node $K/lines.mjs limits path/to/project.json                  # how many agents at once now, and why
node $K/lines.mjs args path/to/project.json > args.json        # the current wave's unfinished lines, with their state
#   then: Workflow({ scriptPath: "<K>/run-lines.js", args: <the JSON in args.json> })
node $K/lines.mjs wait path/to/project.json                    # in the background: exits when the user is needed
node $K/lines.mjs status path/to/project.json                  # where every line stands
node $K/lines.mjs decide path/to/project.json <line|all> accept|continue|reopen|drop|hold|release ["the user's words"]
node $K/lines.mjs playtest path/to/project.json <wave> ["the user's notes"]
node $K/lines.mjs calibrate path/to/project.json <line> --candidates        # images to show the user
node $K/lines.mjs calibrate path/to/project.json <line> 6=a.jpg 8=b.jpg 9=c.jpg [--note "..."]
```

The workflow returns every line's status (`merged`, `needs-decision`, `blocked`, `failed`, `merge-failed`) with its
best round, open findings and history, and `playtest` when it readied a build.

## project.json

```jsonc
{
  "name": "Toy",                          // short name
  "about": "Toy, a browser game",         // how prompts name the project
  "root": ".",                            // the main checkout, relative to this file
  "main": "main",                         // the branch passed work merges into
  "briefs": ["docs/BRIEF.md"],            // read first, by every agent
  "trailer": "Co-Authored-By: ...",       // last line of every commit message
  "threshold": 9,                         // the score a line with nothing blocking must get
  "tagPrefix": "mw",                      // tags for rounds a reset left behind, and for playtest builds
  "evidenceDir": "shots",                 // reviewers' evidence goes in <line cwd>/<evidenceDir>/<line>-review-r<N>/
  "anchorsDir": "design/anchors",         // the user's calibration images, per line (lines.mjs calibrate)
  "mergePort": 7990,                      // {port} for the merge checks
  "decisionWaitHours": 8,                 // how long a stopped line waits for the user within a run (0: return at once)
  "playtest": {                           // optional: stop after each wave for the user to play the build
    "serve": "npm run play -- --port 8080",   // how the user plays main
    "checks": ["npm test"],               // run on main before it is handed over (default: the merge checks)
    "logFields": {}                       // extra fields on playtest log entries
  },
  "lines": "lines.json",                  // a file next to this one, or an inline array
  "log": {
    "file": ".master-workflow/log.json",  // the progress log (a JSON array, or JSON lines)
    "entries": ".master-workflow/entries",// where agents write entries before logging them
    "add": "node my-logger.mjs add {entry}", // optional: your own logger; default: lines.mjs log
    "workFields": "...",                  // optional extra fields asked of work entries (e.g. screenshots)
    "reviewFields": "..."                 // optional extra fields asked of review entries
  },
  "context": "shared background every prompt carries",
  "hardRules": ["the test suite passes", "..."],       // H1..Hn; a failure caps the score at 6
  "rules": ["how to behave on this machine", "..."],   // every role
  "workerRules": ["..."], "reviewerRules": ["..."],
  "checks": {                             // commands or instructions; {port}, {port+N}, {cwd}, {line}, {evidence}, {root}
    "worker": ["npm test -- --port {port}"],
    "review": ["npm test -- --port {port}", "..."],
    "merge": ["npm test -- --port {port}"]
  },
  "machine": { "maxLines": 4, "perLineGB": 2.5, "reserveGB": 4, "diskPerLineGB": 1, "diskReserveGB": 2, "disk": "C:/" }
}
```

## lines.json

```jsonc
[{
  "id": "t3",                              // unique; findings are numbered t3-1, t3-2, ...
  "name": "Nature",
  "cwd": "../wt/track-3",                  // its worktree (relative to root); "onMain": true works on main instead
  "branch": "track/3",
  "port": 7830,                            // the worker uses port..port+4, the reviewer port+5..port+9
  "scope": "src/world/, tools/ and the docs",
  "criteria": ["checkable statement", "..."], // C1..Cn: what the reviewer checks off; make each one checkable
  "notes": "what to build and how",
  "evidence": "how this line is judged (filmstrips, numbers, renders)",
  "wave": 1,                               // optional: lines of a later wave start after the user played this one
  "merge": "on-pass",                      // or "on-better": merge every round that beats what main has
  "threshold": 9,                          // optional, overrides the project's (pair a lower one with calibration)
  "after": ["t0"],                         // lines that must merge first (same or earlier wave)
  "checks": { "review": ["..."] },         // optional, override the project's checks (for example only the views of an asset)
  "logFields": { "track": 3 },             // extra fields on every log entry of this line
  "match": { "track": 3, "item": null }    // optional: claim older log entries without a "line" field
}]
```

Write criteria a stranger could check. Lines judged by measurable criteria (loudness targets, per-frame numbers,
test results) pass in a few rounds; lines judged by "looks like the reference" stall, so give every line at least
one measurable check (`lines.mjs check` warns about a line with none), and calibrate the ones judged by their looks.
