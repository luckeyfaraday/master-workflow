export const meta = {
  name: 'run-lines',
  description: 'Drive every line of a build to its bar: fresh worker, fresh reviewer with a findings ledger, keep the best round, rethink then stop for your decision on stalls, merge one at a time, playtest after each wave',
  whenToUse: 'A master-workflow build with several lines of work (tracks, assets, features), each in its own git worktree; args come from lines.mjs args',
  phases: [
    { title: 'Work', detail: 'fresh worker per round: starts from the best round, merges main, fixes the open findings' },
    { title: 'Review', detail: 'fresh reviewer: settles every open finding, compares with the best round, at most 3 new blocking findings' },
    { title: 'Rethink', detail: 'after two rounds without improvement: an experiment on a scratch branch and a new plan' },
    { title: 'Merge', detail: 'passed or accepted lines (and asset lines whenever they get better) merge into main one at a time' },
    { title: 'Decide', detail: 'a stopped line waits for the user\'s decision while the other lines go on' },
    { title: 'Playtest', detail: 'when a wave is merged: checks main and gets it ready for the user to play' },
  ],
}

// args (from lines.mjs args): { kit, project, limit, limitWhy, done: [line ids already merged], lines: [{ ...line, state }],
//   wave, playtest: { wave } when this run finishes a wave that ends in a playtest }
const P = args.project
const KIT = args.kit
const LIMIT = Math.max(1, args.limit || 1)
const MAIN = P.main || 'main'
const DONE = new Set(args.done || [])
const WAIT_HOURS = P.decisionWaitHours === undefined ? 8 : P.decisionWaitHours

// ---- state machine (lines.mjs evaluates this block to replay the log: keep it free of workflow globals) ----
const STALL_RETHINK = 2 // rounds without a better result before a rethink
const STALL_PAUSE = 3   // rounds without a better result before the line stops for the user's decision

function initState(s) {
  s = s || {}
  return {
    round: s.round || 0, head: s.head || null, best: s.best || null, mergedCommit: s.mergedCommit || null,
    ledger: s.ledger || [], nextId: s.nextId || 1, minor: s.minor || [], rules: s.rules || [],
    stall: s.stall || 0, strategy: s.strategy || '', history: s.history || [],
    pending: s.pending || null, restart: s.restart || null,
    status: s.status || 'active', heldFrom: s.heldFrom || null, next: s.next || (s.pending ? 'review' : 'work'),
  }
}

// A worker round committed: it waits for review.
function applyWork(st, work) {
  return { ...st, pending: { commit: work.commit, summary: work.summary || '', disputes: work.disputes || [], openIssues: work.openIssues || [] }, restart: null, next: 'review' }
}

// One review settles the open findings by id, adds the new blocking ones, and moves the best round.
// A line passes when no hard rule fails, no finding is open and every criterion (C1..Cn) is met.
// baseline: the line improves something main already has (an asset over its stand-in), so even its first round is
// compared with main, and only a better round becomes its best.
function applyReview(st, review, round, commit, lineId, criteria, baseline) {
  const s = { ...st, ledger: [], history: st.history.slice() }
  const said = new Map((review.previous || []).map(p => [p.id, p]))
  for (const f of st.ledger) {
    const p = said.get(f.id)
    if (p && (p.status === 'fixed' || p.status === 'dropped')) continue
    s.ledger.push({ ...f, status: p ? p.status : 'unchecked', evidence: p ? p.evidence || '' : '' })
  }
  let nextId = st.nextId
  for (const f of review.newBlocking || []) s.ledger.push({ id: `${lineId}-${nextId++}`, criterion: f.criterion || '', finding: f.finding || '', done: f.done || '', round, status: 'open' })
  s.nextId = nextId
  s.minor = (review.newMinor || []).slice()
  s.rules = (review.ruleFailures || []).slice()
  const met = new Set((review.checklist || []).filter(c => c.met).map(c => (String(c.criterion).match(/C\d+/) || [''])[0]))
  const unmet = (criteria || []).map((_, i) => 'C' + (i + 1)).filter(l => !met.has(l))
  const passed = s.rules.length === 0 && s.ledger.length === 0 && unmet.length === 0
  const said3 = ['better', 'same', 'worse'].includes(review.compare) ? review.compare : 'same'
  const compare = !st.best && !baseline ? 'first' : said3
  s.round = round
  s.head = commit
  s.pending = null
  s.history.push({ round, commit, score: review.score, compare, open: s.ledger.length, verdict: review.verdict || '' })
  if (passed || compare === 'first' || compare === 'better') {
    s.best = { round, commit, score: review.score, evidence: review.evidenceDir || '' }
    s.stall = 0
    s.restart = null
  } else {
    s.stall = st.stall + 1
    s.restart = compare === 'worse' && s.best ? s.best.commit : null // the next worker starts from the best round again
  }
  s.next = passed ? 'merge' : s.stall >= STALL_PAUSE ? 'pause' : s.stall === STALL_RETHINK ? 'rethink' : 'work'
  s.status = passed ? 'passed' : s.next === 'pause' ? 'paused' : 'active'
  return { state: s, passed, unmet }
}

function applyRethink(st, plan) {
  return { ...st, strategy: plan || st.strategy, next: st.pending ? 'review' : 'work' }
}

// A merge into main: final ends the line; otherwise (a line that merges whenever it gets better) it goes on.
function applyMerge(st, commit, final) {
  return final ? { ...st, mergedCommit: commit, status: 'merged', next: 'done' } : { ...st, mergedCommit: commit }
}

// The user's decisions (lines.mjs decide).
function applyDecision(st, decision, note) {
  const next = st.pending ? 'review' : 'work'
  if (decision === 'continue') return { ...st, status: 'active', stall: 0, next, strategy: note ? `The user looked at the stalled line and decided to continue: ${note}` : st.strategy }
  if (decision === 'reopen') return { ...st, status: 'active', stall: 0, next, strategy: note ? `The user reopened this line after playing the build: ${note}` : st.strategy }
  if (decision === 'accept') return st.best ? { ...st, status: 'accepted', next: 'merge' } : st
  if (decision === 'drop') return { ...st, status: 'dropped', next: 'done' }
  if (decision === 'hold') return st.status === 'held' ? st : { ...st, heldFrom: st.status, status: 'held' }
  if (decision === 'release') return st.status === 'held' ? { ...st, status: st.heldFrom || 'active', heldFrom: null } : st
  if (decision === 'merged') return applyMerge(st, st.best ? st.best.commit : st.mergedCommit, true)
  return st
}
// ---- end state machine ----

const WORK = { type: 'object', properties: {
  commit: { type: 'string' }, summary: { type: 'string' }, verified: { type: 'string' },
  disputes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'evidence'] } },
  openIssues: { type: 'array', items: { type: 'string' } },
}, required: ['commit', 'summary', 'verified', 'disputes', 'openIssues'] }

const REVIEW = { type: 'object', properties: {
  score: { type: 'integer', minimum: 1, maximum: 10 },
  verdict: { type: 'string' },
  compare: { type: 'string', enum: ['first', 'better', 'same', 'worse'] },
  compareNotes: { type: 'string' },
  previous: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'open', 'worse', 'dropped'] }, evidence: { type: 'string' },
  }, required: ['id', 'status', 'evidence'] } },
  newBlocking: { type: 'array', maxItems: 3, items: { type: 'object', properties: {
    criterion: { type: 'string' }, finding: { type: 'string' }, done: { type: 'string' },
  }, required: ['criterion', 'finding', 'done'] } },
  newMinor: { type: 'array', items: { type: 'string' } },
  checklist: { type: 'array', items: { type: 'object', properties: {
    criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' },
  }, required: ['criterion', 'met', 'evidence'] } },
  ruleFailures: { type: 'array', items: { type: 'string' } },
  strengths: { type: 'array', items: { type: 'string' } },
  evidenceDir: { type: 'string' },
}, required: ['score', 'verdict', 'compare', 'compareNotes', 'previous', 'newBlocking', 'newMinor', 'checklist', 'ruleFailures', 'strengths', 'evidenceDir'] }

const RETHINK = { type: 'object', properties: {
  diagnosis: { type: 'string' }, tried: { type: 'string' }, branch: { type: 'string' }, commit: { type: 'string' },
  result: { type: 'string' }, plan: { type: 'string' },
}, required: ['diagnosis', 'tried', 'branch', 'commit', 'result', 'plan'] }

const MERGE = { type: 'object', properties: {
  commit: { type: 'string' }, summary: { type: 'string' }, checks: { type: 'string' }, ok: { type: 'boolean' },
}, required: ['commit', 'summary', 'checks', 'ok'] }

const DECISION = { type: 'object', properties: {
  decision: { type: 'string', enum: ['continue', 'accept', 'drop', 'hold', 'reopen', 'none'] }, note: { type: 'string' },
}, required: ['decision', 'note'] }

const PLAYTEST = { type: 'object', properties: {
  ok: { type: 'boolean' }, commit: { type: 'string' }, summary: { type: 'string' }, checks: { type: 'string' },
}, required: ['ok', 'commit', 'summary', 'checks'] }

// ---- prompts ----

// {name} and {name+N} placeholders in the project's commands and rules
function fill(text, ctx) {
  return String(text).replace(/\{(\w+)(?:\+(\d+))?\}/g, (m, k, n) => ctx[k] === undefined ? m : n ? String(+ctx[k] + +n) : String(ctx[k]))
}
const bullets = (xs, ctx) => (xs || []).filter(Boolean).map(x => '- ' + fill(x, ctx)).join('\n')
const numbered = (xs, p) => (xs || []).map((x, i) => `${p}${i + 1}. ${x}`).join('\n')
const hist = h => h.length ? h.map(x => `- round ${x.round}: ${x.score}/10, ${x.compare}, ${x.open} open, at ${x.commit}. ${x.verdict}`).join('\n') : '- none yet'
const evidenceDir = (L, round) => `${L.cwd}/${P.evidenceDir}/${L.id}-review-r${round}`
const ctxFor = (L, round, extra) => ({ cwd: L.cwd, port: L.port, line: L.id, round, root: P.root, branch: L.branch, main: MAIN, kit: KIT, evidence: evidenceDir(L, round), ...extra })
const addCmd = entry => fill(P.log.add, { entry: `"${entry}"` })

function logStep(L, round, kind, fields, ctx) {
  const entry = `${P.log.entries}/${L.id}-r${round}-${kind}.json`
  const base = JSON.stringify({ line: L.id, round, kind, ...(L.logFields || {}) })
  return `Log it: write ${entry} as ${base.slice(0, -1)}, ${fill(fields, ctx)}} and run: ${addCmd(entry)}`
}

function about(L, role) {
  return `You are ${role} for line ${L.id}, "${L.name}", of ${P.about}.`
}

function shared(L, ctx) {
  return [
    `Read ${(P.briefs || []).join(' and ') || 'the project brief'} first.${P.context ? ' ' + fill(P.context, ctx) : ''}`,
    `This line's criteria (a finding names the one it is about):\n${numbered(L.criteria, 'C')}`,
    P.hardRules && P.hardRules.length ? `Hard rules for every line (a failure caps the score at 6):\n${numbered(P.hardRules.map(r => fill(r, ctx)), 'H')}` : '',
    L.notes ? `Line notes:\n${fill(L.notes, ctx)}` : '',
    L.evidence ? `How this line is judged: ${fill(L.evidence, ctx)}` : '',
  ].filter(Boolean).join('\n\n')
}

function workerPrompt(L, st) {
  const round = st.round + 1, ctx = ctxFor(L, round)
  const tag = `${P.tagPrefix}/${L.id}-r${st.round}-worse`
  const start = L.onMain ? `You work directly on ${MAIN} in ${L.cwd}.`
    : st.restart ? `Start from the best round. Round ${st.round} was judged worse than round ${st.best.round}, so this round goes back to ${st.restart}: unless the tag ${tag} already exists (an earlier try of this round did it), run git tag ${tag} HEAD && git reset --hard ${st.restart}. That reset is the only history change you may make. Then run git merge ${MAIN} (resolve conflicts keeping both sides' intent and commit the merge).`
    : `Start the round with git merge ${MAIN} (${MAIN} collects everything that has passed; resolve conflicts keeping both sides' intent and commit the merge).`
  const open = st.ledger.length ? `Open findings, by id. Fix every one, or dispute it in disputes (its id and your evidence) if you are sure it is wrong; the next reviewer settles each one by id:\n${st.ledger.map(f => `- ${f.id} [${f.criterion}] ${f.finding}${f.done ? ` Done looks like: ${f.done}` : ''}${f.status === 'worse' ? ' (it got worse last round)' : ''}`).join('\n')}` : ''
  const rules = st.rules.length ? `Hard rules that failed in the last review (fix these first):\n${st.rules.map(r => '- ' + r).join('\n')}` : ''
  const merged = L.merge === 'on-better' && st.mergedCommit ? `Round ${st.best.round} is already in ${MAIN} (this line merges whenever a round is better than what ${MAIN} has); build on it.` : ''
  return `${about(L, 'the worker')} Work only in ${L.cwd} (branch ${L.branch}); cd there for every command. Other lines work in their own worktrees at the same time: never change anything outside ${L.cwd}.

${shared(L, ctx)}

${start}

This is round ${round}. Previous rounds:
${hist(st.history)}
${st.best ? `The best round so far is round ${st.best.round} at ${st.best.commit} (${st.best.score}/10). ${merged}` : ''}
${[open, rules].filter(Boolean).join('\n\n')}
${st.strategy ? `\nA diagnosis of why this line stalled produced this plan. Follow it unless you find it is wrong:\n${st.strategy}\n` : ''}
Rules:
- If git status shows uncommitted changes (after the start step above), they are from an earlier worker that was interrupted. Inspect them, keep and finish what is good, and discard what is not.
- Files you may change: ${fill(L.scope || 'the files this line needs', ctx)}. Never rewrite git history except the reset above.
${bullets([...(P.rules || []), ...(P.workerRules || [])], ctx)}
- Check your work before you commit; anything you run uses ports {port} to {port+4}:
${bullets(L.checks && L.checks.worker || P.checks.worker, ctx).replace(/^- /gm, '  - ')}
- Commit on ${L.branch} with a clear message${P.trailer ? ` ending with the line: ${P.trailer}` : ''}
- ${logStep(L, round, 'work', `"summary": "...", "commit": "<hash>"${P.log.workFields ? ', ' + P.log.workFields : ''}`, ctx)}

Return your final commit hash (HEAD of ${L.branch}), what you changed, how you verified it (with the numbers), your disputes, and anything still open.`.replace(/\{port(\+\d+)?\}/g, m => fill(m, ctx))
}

function reviewerPrompt(L, st) {
  const round = st.round + 1, ev = evidenceDir(L, round), ctx = ctxFor(L, round, { port: L.port + 5 })
  const work = st.pending, prev = st.head || MAIN
  const disputes = new Map((work.disputes || []).map(d => [d.id, d.evidence]))
  const ledger = st.ledger.length
    ? `Open findings from earlier reviews. Settle every one by id in previous: fixed, open, worse, or dropped (only when it was wrong or conflicts with the criteria; say why). Judge from your own evidence, not the worker's word:\n${st.ledger.map(f => `- ${f.id} [${f.criterion}] ${f.finding}${f.done ? ` Done looks like: ${f.done}` : ''}${disputes.has(f.id) ? `\n  The worker disputes it: ${disputes.get(f.id)}` : ''}`).join('\n')}`
    : 'There are no open findings from earlier reviews: previous is empty.'
  const compare = st.best
    ? `The best round so far is round ${st.best.round} at ${st.best.commit} (${st.best.score}/10)${st.best.evidence ? `; its review evidence is in ${st.best.evidence}` : ''}. Build your evidence with the same seeds, views and runs, and judge this round against it criterion by criterion. compare is "better" when this round is better overall and no criterion got worse, "worse" when it is worse overall, and "same" otherwise; explain it in compareNotes. Earlier reviews:\n${hist(st.history)}`
    : L.merge === 'on-better'
      ? `This line improves something ${MAIN} already has (a stand-in or an earlier version). Build the same evidence on ${MAIN} (for example from ${P.root}) and judge this round against it: compare is "better" when this round is better overall, "worse" when it is worse, and "same" otherwise; explain it in compareNotes. A better round is merged into ${MAIN} at once.`
      : 'This is the first review of this line: set compare to "first".'
  const anchors = (L.anchors || []).length
    ? `The user's calibration for this line: open these images before you score. ${L.anchors.map(a => `${a.path} is a ${a.score}/10${a.note ? ` (${a.note})` : ''}`).join('; ')}. Score on that scale.`
    : ''
  const threshold = L.threshold || P.threshold
  return `${about(L, 'an independent reviewer')} The work is in ${L.cwd} (branch ${L.branch}) at commit ${work.commit}. You did not write it and owe it nothing. Judge only what is in the repo and what running it shows, never anyone's description of it.

${shared(L, ctx)}

1. The whole line is git -C ${L.cwd} diff ${MAIN}...${work.commit}; this round's change is git -C ${L.cwd} diff ${prev}..${work.commit}. Read the code that matters.
2. Build your own evidence in ${ev}/ (create it). Run these yourself (ports {port} to {port+4}), and add runs of your own design (other seeds, places, angles, scenarios) so you are not judging only the cases the worker picked:
${bullets(L.checks && L.checks.review || P.checks.review, ctx).replace(/^- /gm, '   - ')}
3. ${ledger}
4. ${compare}
5. checklist: for every criterion C1..C${(L.criteria || []).length}, met true or false with the evidence.
6. newBlocking: at most 3 new findings that block the line, each naming the criterion (C#) or hard rule (H#) it breaks, what is wrong and where (file, tool output or image), and what done looks like. Anything that does not block goes in newMinor. Do not re-raise a finding that is already open.
7. ruleFailures: every hard rule that fails, with the evidence.

Rules:
${bullets([...(P.rules || []), ...(P.reviewerRules || [])], ctx)}
- Do not modify, create or delete any tracked file, and do not commit.

Scoring: score 1-10 for the history. A score below ${threshold} needs at least one finding that is still open or new; if nothing blocks, the score is at least ${threshold}. A hard-rule failure caps the score at 6. Be strict, and be consistent with the best round's review.${anchors ? '\n' + anchors : ''}
If compare is "first" or "better", create an empty file named BEST in ${ev}.

${logStep(L, round, 'review', `"score": N, "verdict": "...", "compare": "...", "compareNotes": "...", "previous": [...], "newBlocking": [...], "newMinor": [...], "checklist": [...], "ruleFailures": [...], "strengths": [...], "findings": ["<id or new>: <text> for every finding still open after your review"], "commit": "${work.commit}", "evidenceDir": "${ev}"${P.log.reviewFields ? ', ' + P.log.reviewFields : ''}`, ctx)}

Return the score, a one-line verdict, compare and compareNotes, previous, newBlocking, newMinor, checklist, ruleFailures, strengths, and evidenceDir (${ev}).`.replace(/\{port(\+\d+)?\}/g, m => fill(m, ctx))
}

function rethinkPrompt(L, st) {
  const ctx = ctxFor(L, st.round), scratch = `${L.branch}-rethink-r${st.round}`
  const best = st.best ? `the best is still round ${st.best.round} at ${st.best.commit} (${st.best.score}/10)` : `no round has beaten what ${MAIN} has yet`
  return `Line ${L.id}, "${L.name}", of ${P.about} has not improved for ${st.stall} rounds: ${best}. Worktree ${L.cwd}, branch ${L.branch}. Other lines work in their own worktrees: change nothing outside ${L.cwd}.

${shared(L, ctx)}

History:
${hist(st.history)}
Open findings:
${st.ledger.map(f => `- ${f.id} [${f.criterion}] ${f.finding} (${f.status})`).join('\n') || '- none'}
${st.rules.length ? `Hard rules failing:\n${st.rules.map(r => '- ' + r).join('\n')}` : ''}
Plan already tried: ${st.strategy || 'none'}

Find out why the rounds are not converging (the wrong approach, a technical limit, findings that conflict, a criterion misread), then test the most promising fix before you recommend it:
1. In ${L.cwd}, git switch -c ${scratch} from ${L.branch}'s HEAD, make the change, commit it, and run the checks that show whether it works (ports {port} to {port+4}). Keep what it shows in ${L.cwd}/${P.evidenceDir}/${L.id}-rethink-r${st.round}/.
2. Switch the worktree back to ${L.branch} and leave it clean. Do not change ${L.branch} itself.
3. Write the plan for the next worker as one self-contained text: what to do, whether to merge ${scratch} (branch and commit), and what your experiment showed, with numbers or image paths. The next worker sees only this plan.

Rules:
${bullets(P.rules, ctx)}
- ${logStep(L, st.round, 'rethink', `"diagnosis": "...", "plan": "...", "branch": "${scratch}", "commit": "<hash>"`, ctx)}

Return the diagnosis, what you tried, the branch and commit, what it showed, and the plan.`.replace(/\{port(\+\d+)?\}/g, m => fill(m, ctx))
}

function mergePrompt(L, st, final) {
  const ctx = ctxFor(L, st.round, { cwd: P.root, port: P.mergePort || L.port })
  const how = !final ? `better than what ${MAIN} has (round ${st.best.round}, ${st.best.score}/10); the line keeps improving after this merge`
    : st.status === 'accepted' ? `accepted by the user at ${st.best.score}/10` : `passed review at ${st.best.score}/10`
  return `In ${P.root} (branch ${MAIN}), merge line ${L.id}, "${L.name}", of ${P.about}: commit ${st.best.commit}, round ${st.best.round}, ${how}. Run git -C ${P.root} merge --no-ff ${st.best.commit} with a message like "Merge line ${L.id}, ${L.name} (round ${st.best.round}, ${st.best.score}/10)"${P.trailer ? ` ending with the line: ${P.trailer}` : ''}.
If there are conflicts, resolve them keeping both sides' intent (${MAIN} holds other passed work). Then check ${MAIN} in ${P.root}:
${bullets(P.checks.merge, ctx)}
If a check fails because of the merge, fix it in a follow-up commit on ${MAIN}.
${bullets(P.rules, ctx)}
- ${logStep(L, st.round, 'merge', `"commit": "<merge commit>", "merged": "${st.best.commit}", "final": ${final}, "summary": "..."`, ctx)}

Return the merge commit, what you resolved, the check results, and ok: true only when every check passes.`
}

// Logs the stop, then waits for the user's decision (lines.mjs decide), so the line can go on in this same run.
function stopPrompt(L, st) {
  const entry = `${P.log.entries}/${L.id}-r${st.round}-pause.json`
  const best = st.best ? `The best is round ${st.best.round} at ${st.best.score}/10.` : `No round has beaten what ${MAIN} has yet.`
  const json = JSON.stringify({ line: L.id, round: st.round, kind: 'pause', ...(L.logFields || {}),
    summary: `Stopped after ${st.stall} rounds without improvement. ${best} It needs the user's decision: accept the best round, continue with a new direction, or drop the line.`,
    commit: st.best ? st.best.commit : undefined, findings: st.ledger.map(f => `${f.id}: ${f.finding}`) })
  const wait = `node "${KIT}/lines.mjs" wait "${P.file}" --line ${L.id} --kinds decision --after-last pause --minutes 9`
  const tries = Math.max(1, Math.ceil(WAIT_HOURS * 60 / 9))
  if (!WAIT_HOURS) return `Write this JSON, exactly as given, to ${entry}, then run: ${addCmd(entry)}
${json}
Change nothing else, and return decision "none" with an empty note.`
  return `1. Write this JSON, exactly as given, to ${entry}, then run: ${addCmd(entry)}
${json}
2. Then wait for the user's decision on line ${L.id}: run ${wait}
It prints the decision as JSON when the user makes it, or TIMEOUT after 9 minutes. On TIMEOUT run it again, up to ${tries} times in all.
3. Change nothing else. Return the decision and its note as printed, or decision "none" if every try timed out.`
}

function playtestPrompt(wave, merged) {
  const pt = P.playtest, ctx = { root: P.root, main: MAIN, wave, port: pt.port || 8080 }
  const entry = `${P.log.entries}/playtest-w${wave}-ready.json`
  return `Wave ${wave} of ${P.about} is merged into ${MAIN}: ${merged.map(r => `${r.id} (${r.name}, round ${r.best ? r.best.round : '-'}, ${r.best ? r.best.score : '-'}/10)`).join(', ')}. Get ${MAIN} ready for the user to play:
1. In ${P.root} on ${MAIN}, run these checks:
${bullets(pt.checks || P.checks.merge, ctx)}
If a check fails, fix it in a commit on ${MAIN}.
2. Tag the build: git -C ${P.root} tag -f ${P.tagPrefix}/playtest-w${wave} ${MAIN}
3. Do not start the game for the user; the session does that when they are ready to play.
${bullets(P.rules, ctx)}
4. Log it: write ${entry} as ${JSON.stringify({ line: 'playtest', kind: 'playtest-ready', wave, ...(pt.logFields || {}) }).slice(0, -1)}, "summary": "<what this build adds for the player to try, in plain words, and how the checks went>", "command": "${fill(pt.serve || '', ctx)}", "commit": "<${MAIN}'s commit>"} and run: ${addCmd(entry)}

Return ok (every check passed), ${MAIN}'s commit, the summary and the check results.`
}

// ---- scheduling ----

// how many lines wait on each line, directly or through others: a free agent slot goes to the line most wait on
const PRIO = {}
function dependents(id, seen = new Set()) {
  for (const L of args.lines) if ((L.after || []).includes(id) && !seen.has(L.id)) { seen.add(L.id); dependents(L.id, seen) }
  return seen
}
for (const L of args.lines) PRIO[L.id] = dependents(L.id).size

// at most LIMIT agents at once across every line (lines.mjs sets it from the machine's free memory and disk)
let active = 0, ticket = 0
const waiting = []
async function run(prompt, opts, prio = 0) {
  if (active >= LIMIT) await new Promise(r => waiting.push({ r, prio, n: ticket++ })); else active++
  try { return await agent(prompt, opts) } finally {
    waiting.sort((a, b) => b.prio - a.prio || a.n - b.n)
    const w = waiting.shift()
    if (w) w.r(); else active--
  }
}

// merges into main one at a time
let mergeQueue = Promise.resolve()
function serially(fn) { const p = mergeQueue.then(fn); mergeQueue = p.then(() => {}, () => {}); return p }

const gate = {}
for (const L of args.lines) { let res; const promise = new Promise(r => { res = r }); gate[L.id] = { promise, res } }

function finish(L, st, status, note) {
  const r = { id: L.id, name: L.name, status, note: note || '', round: st.round, best: st.best, stall: st.stall,
    open: st.ledger.map(f => `${f.id}: ${f.finding}`), history: st.history }
  gate[L.id].res(r)
  return r
}

async function mergeBest(L, st, final, prio) {
  const m = await serially(() => run(mergePrompt(L, st, final), { label: `${L.id} merge r${st.best.round}`, phase: 'Merge', schema: MERGE, effort: 'high' }, prio + 100))
  if (m && m.ok) log(`${L.id}: round ${st.best.round} merged into ${MAIN} at ${m.commit}${final ? '' : ' (the line goes on)'}`)
  return m && m.ok ? m : null
}

async function runLine(L) {
  let st = initState(L.state)
  const prio = PRIO[L.id] || 0, onBetter = L.merge === 'on-better'
  for (const d of L.after || []) {
    if (DONE.has(d)) continue
    const r = gate[d] ? await gate[d].promise : null
    if (!r || r.status !== 'merged') return finish(L, st, 'blocked', `waits for ${d}, which ${r ? `ended ${r.status}` : 'is not in this run and not merged'}`)
  }
  let dead = 0
  for (;;) {
    if (['held', 'dropped', 'merged'].includes(st.status)) return finish(L, st, st.status)
    if (st.next === 'pause') {
      log(`${L.id} stopped: ${st.stall} rounds without improvement${st.best ? `, best ${st.best.score}/10 in round ${st.best.round}` : ''}. It needs your decision (lines.mjs decide).`)
      // the wait takes no agent slot: it is a command that sleeps until the log has the decision
      const d = await agent(stopPrompt(L, st), { label: `${L.id} waits for your decision`, phase: 'Decide', schema: DECISION, effort: 'low' })
      if (!d || !WAIT_HOURS || d.decision === 'none') return finish(L, st, 'needs-decision', st.best ? `best round ${st.best.round} at ${st.best.commit}` : 'no round beat main')
      log(`${L.id}: your decision: ${d.decision}${d.note ? ` (${d.note})` : ''}`)
      st = applyDecision(st, d.decision, d.note)
      continue
    }
    if (st.next === 'merge') {
      if (L.onMain) return finish(L, applyMerge(st, st.best.commit, true), 'merged', 'worked on main')
      if (st.mergedCommit && st.mergedCommit === st.best.commit) return finish(L, applyMerge(st, st.best.commit, true), 'merged', `round ${st.best.round} was already merged`)
      const m = await mergeBest(L, st, true, prio)
      if (!m) return finish(L, st, 'merge-failed', 'the merge or its checks failed')
      return finish(L, applyMerge(st, st.best.commit, true), 'merged', m.commit)
    }
    if (st.next === 'rethink') {
      const r = await run(rethinkPrompt(L, st), { label: `${L.id} rethink r${st.round}`, phase: 'Rethink', schema: RETHINK, effort: 'xhigh' }, prio)
      if (r) log(`${L.id} rethink: ${r.diagnosis}`)
      st = applyRethink(st, r ? r.plan : '') // the plan carries what the experiment showed; the log records the same text
      continue
    }
    if (!st.pending) {
      const w = await run(workerPrompt(L, st), { label: `${L.id} work r${st.round + 1}`, phase: 'Work', schema: WORK, effort: 'high' }, prio)
      if (!w) { if (++dead >= 3) return finish(L, st, 'failed', 'three agents in a row died'); continue }
      dead = 0
      st = applyWork(st, w)
    }
    const round = st.round + 1
    const rv = await run(reviewerPrompt(L, st), { label: `${L.id} review r${round}`, phase: 'Review', schema: REVIEW, effort: 'high' }, prio)
    if (!rv) { if (++dead >= 3) return finish(L, st, 'failed', 'three agents in a row died'); continue } // the same commit is reviewed again
    dead = 0
    const out = applyReview(st, { ...rv, newBlocking: (rv.newBlocking || []).slice(0, 3) }, round, st.pending.commit, L.id, L.criteria, onBetter)
    st = out.state
    const h = st.history[st.history.length - 1]
    log(`${L.id} round ${round}: ${rv.score}/10, ${h.compare}, ${st.ledger.length} open${out.unmet.length ? `, ${out.unmet.join(' ')} unmet` : ''}${out.passed ? ', passed' : ''}. ${rv.verdict}`)
    // a line that improves what main has merges every better round at once, so everything else builds on it
    if (onBetter && !out.passed && st.best && st.best.commit !== st.mergedCommit) {
      const m = await mergeBest(L, st, false, prio)
      if (m) st = applyMerge(st, st.best.commit, false)
    }
  }
}

async function guarded(L) {
  try { return await runLine(L) } catch (e) { return finish(L, initState(L.state), 'error', String(e && e.message || e)) }
}

log(`${args.lines.length} line${args.lines.length === 1 ? '' : 's'}${args.wave ? ` of wave ${args.wave}` : ''}, at most ${LIMIT} agent${LIMIT === 1 ? '' : 's'} at once${args.limitWhy ? ` (${args.limitWhy})` : ''}`)
const results = (await parallel(args.lines.map(L => () => guarded(L)))).filter(Boolean)

// a wave that ends in a playtest: once every line of it is merged (or dropped), main is the build the user plays.
// args.playtest.lines lists the whole wave, including lines merged in earlier runs.
let playtest = null
if (P.playtest && args.playtest && results.every(r => r.status === 'merged' || r.status === 'dropped')) {
  const byId = new Map((args.playtest.lines || []).map(l => [l.id, l]))
  for (const r of results) byId.set(r.id, r)
  const merged = [...byId.values()].filter(r => r.status === 'merged')
  const pt = await run(playtestPrompt(args.playtest.wave, merged), { label: `playtest wave ${args.playtest.wave}`, phase: 'Playtest', schema: PLAYTEST, effort: 'high' }, 1000)
  playtest = { wave: args.playtest.wave, ready: !!(pt && pt.ok), commit: pt ? pt.commit : null, summary: pt ? pt.summary : 'the playtest agent died', command: P.playtest.serve || '' }
  log(playtest.ready ? `Wave ${playtest.wave} is ready to play: ${playtest.summary}` : `Wave ${playtest.wave}: the playtest build is not ready (${playtest.summary})`)
}

return {
  lines: results,
  needsDecision: results.filter(r => r.status === 'needs-decision').map(r => r.id),
  merged: results.filter(r => r.status === 'merged').map(r => r.id),
  playtest,
}
