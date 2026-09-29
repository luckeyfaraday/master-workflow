#!/usr/bin/env node
// The command line of a lines build (see README.md). Every line's state is replayed from the project's progress
// log with the state machine in run-lines.js itself, so a resumed build continues exactly where the log stops.
//   node lines.mjs args <project.json> [line ...]    args for the run-lines workflow: the unfinished lines of the
//                                                    current wave (or the ones named), their state, the agent limit
//   node lines.mjs status <project.json> [--hook]    where every line stands; --hook is the SessionStart hook: it
//                                                    reads the event on stdin and prints only when something waits
//   node lines.mjs decide <project.json> <line|all> <accept|continue|reopen|drop|hold|release> [note]
//                                                    records the user's decision on a line
//   node lines.mjs playtest <project.json> <wave> [notes]
//                                                    records that the user played the build after a wave; the next
//                                                    wave can start
//   node lines.mjs wait <project.json> [--kinds pause,playtest-ready] [--line id] [--after-last kind] [--minutes N] [--every S]
//                                                    blocks until the log gets a matching entry, prints it as JSON
//                                                    and exits 0 (or prints TIMEOUT and exits 3)
//   node lines.mjs calibrate <project.json> <line> <score>=<image> [...] [--note text]
//   node lines.mjs calibrate <project.json> <line> --candidates
//                                                    the user's reference images for a line judged by its looks
//   node lines.mjs check <project.json>              checks the config: ports, worktrees, branches, waves, criteria
//   node lines.mjs limits <project.json>             how many agents this machine can run at once now, and why
//   node lines.mjs log <project.json> <entry.json>   the default logger, for projects without log.add
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { machineLimit } from './limits.mjs';

const posix = p => p.replace(/\\/g, '/');
export const KIT = posix(path.dirname(fileURLToPath(import.meta.url)));
const RUN_LINES = path.join(KIT, 'run-lines.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The state machine block of run-lines.js, evaluated here: one implementation for the live loop and the replay.
export function stateMachine(src = fs.readFileSync(RUN_LINES, 'utf8')) {
  const a = src.indexOf('// ---- state machine'), b = src.indexOf('// ---- end state machine ----');
  if (a < 0 || b < a) throw new Error(`${RUN_LINES} has no state machine block`);
  return new Function(`${src.slice(a, b)}\nreturn { initState, applyWork, applyReview, applyRethink, applyMerge, applyDecision, STALL_RETHINK, STALL_PAUSE }`)();
}

export function loadProject(file) {
  const abs = path.resolve(file), dir = path.dirname(abs);
  const p = JSON.parse(fs.readFileSync(abs, 'utf8'));
  p.file = posix(abs);
  p.root = posix(path.resolve(dir, p.root || '.'));
  p.main = p.main || 'main';
  p.threshold = p.threshold || 9;
  p.tagPrefix = p.tagPrefix || 'mw';
  p.evidenceDir = p.evidenceDir || '.master-workflow/evidence';
  p.anchorsDir = posix(path.resolve(p.root, p.anchorsDir || '.master-workflow/anchors'));
  p.trailer = p.trailer || '';
  p.decisionWaitHours = p.decisionWaitHours ?? 8;
  p.checks = { worker: [], review: [], merge: [], ...p.checks };
  if (p.playtest) p.playtest = { logFields: {}, ...p.playtest };
  const log = { file: '.master-workflow/log.json', entries: '.master-workflow/entries', ...p.log };
  log.file = posix(path.resolve(p.root, log.file));
  log.entries = posix(path.resolve(p.root, log.entries));
  log.add = log.add || `node "${KIT}/lines.mjs" log "${p.file}" {entry}`;
  p.log = log;
  const lines = typeof p.lines === 'string' ? JSON.parse(fs.readFileSync(path.resolve(dir, p.lines), 'utf8')) : p.lines || [];
  p.lines = lines.map(L => ({ logFields: {}, criteria: [], after: [], wave: 1, merge: 'on-pass', ...L, cwd: posix(path.resolve(p.root, L.cwd || '.')) }));
  const ids = new Set();
  for (const L of p.lines) {
    if (!L.id || ids.has(L.id) || L.id === 'playtest') throw new Error(`every line needs a unique id other than "playtest" (${L.id || 'missing'})`);
    if (!L.onMain && (!L.branch || !Number.isInteger(L.port))) throw new Error(`line ${L.id} needs a branch and a port`);
    ids.add(L.id);
  }
  return p;
}

export function readLog(p) {
  if (!fs.existsSync(p.log.file)) return [];
  const text = fs.readFileSync(p.log.file, 'utf8').trim();
  if (!text) return [];
  return text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
}

// A line's entries: the ones tagged with its id, plus older untagged ones that match line.match
// (a null in match means the field must be absent).
export function entriesFor(log, L) {
  return log.filter(e => e.line === L.id || (e.line === undefined && L.match &&
    Object.entries(L.match).every(([k, v]) => v === null ? e[k] == null : e[k] === v)));
}

// A review logged before the ledger existed: its findings become the open ledger, and compare comes from the score.
function legacyReview(st, e, threshold) {
  const passed = e.score >= threshold && !(e.ruleFailures || []).length;
  return {
    score: e.score, verdict: e.verdict || '', evidenceDir: '',
    compare: !st.best ? 'first' : e.score > st.best.score ? 'better' : e.score < st.best.score ? 'worse' : 'same',
    previous: st.ledger.map(f => ({ id: f.id, status: 'dropped', evidence: 'superseded by the next review (logged before the findings ledger)' })),
    newBlocking: passed ? [] : (e.findings || []).map(f => ({ criterion: 'earlier review', finding: String(f), done: '' })),
    newMinor: passed ? (e.findings || []).map(String) : [],
    checklist: [], ruleFailures: e.ruleFailures || [],
  };
}

export function replay(p, L, log, SM = stateMachine()) {
  let st = SM.initState();
  const entries = entriesFor(log, L);
  for (const e of entries) {
    if (e.kind === 'work' && e.commit) st = SM.applyWork(st, e);
    else if (e.kind === 'review' && e.score != null) {
      const legacy = e.compare === undefined;
      const rv = legacy ? legacyReview(st, e, L.threshold || p.threshold) : e;
      const commit = e.commit || (st.pending && st.pending.commit);
      st = SM.applyReview(st, rv, e.round ?? st.round + 1, commit, L.id, legacy ? [] : L.criteria, !legacy && L.merge === 'on-better').state;
    } else if (e.kind === 'rethink') st = SM.applyRethink(st, e.plan);
    else if (e.kind === 'decision') st = SM.applyDecision(st, e.decision, e.note);
    else if (e.kind === 'merge') st = SM.applyMerge(st, e.merged || (st.best && st.best.commit), e.final !== false);
  }
  // passed or accepted work that is already in main (merged by hand, or before the merge entry was logged)
  if ((st.status === 'passed' || st.status === 'accepted') && st.best && isAncestor(p, st.best.commit)) st = SM.applyMerge(st, st.best.commit, true);
  const last = entries.length ? Date.parse(entries[entries.length - 1].at) : NaN;
  return { state: st, entries: entries.length, lastAt: Number.isFinite(last) ? last : null };
}

function git(p, ...a) { return spawnSync('git', ['-C', p.root, ...a], { encoding: 'utf8' }); }
function isAncestor(p, commit) { return !!commit && git(p, 'merge-base', '--is-ancestor', commit, p.main).status === 0; }

const FINISHED = new Set(['merged', 'dropped']);

// Where the build stands: every line's state, the current wave (the lowest one with unfinished lines), whether a
// playtest has to happen before it can start, and which lines a run launches now.
export function plan(p, log = readLog(p), SM = stateMachine()) {
  const rows = p.lines.map(L => ({ L, ...replay(p, L, log, SM) }));
  const open = rows.filter(r => !FINISHED.has(r.state.status));
  const wave = open.length ? Math.min(...open.map(r => r.L.wave)) : null;
  const played = new Set(log.filter(e => e.kind === 'playtest').map(e => e.wave));
  const ready = new Map(log.filter(e => e.kind === 'playtest-ready').map(e => [e.wave, e]));
  // before a wave starts, the user plays the build of the wave before it (when the project has playtests)
  const before = p.playtest && wave ? Math.max(0, ...p.lines.filter(L => L.wave < wave).map(L => L.wave)) : 0;
  const waitingPlaytest = before && !played.has(before) ? { wave: before, ready: ready.get(before) || null } : null;
  const launch = [], skipped = [];
  for (const r of open) {
    const s = r.state.status, mergeOnly = s === 'accepted' || s === 'passed'; // a merge never waits for a wave
    if (!mergeOnly && (r.L.wave !== wave || waitingPlaytest)) continue;
    if (s === 'held' || s === 'paused') { skipped.push({ id: r.L.id, status: s }); continue; }
    launch.push(r);
  }
  const summary = r => ({ id: r.L.id, name: r.L.name, status: r.state.status, best: r.state.best });
  let playtest = null;
  if (p.playtest && waitingPlaytest && !waitingPlaytest.ready) // the wave is merged but its build was never readied
    playtest = { wave: waitingPlaytest.wave, lines: rows.filter(r => r.L.wave === waitingPlaytest.wave).map(summary) };
  else if (p.playtest && wave && !waitingPlaytest && open.filter(r => r.L.wave === wave).every(r => launch.includes(r)))
    playtest = { wave, lines: rows.filter(r => r.L.wave === wave).map(summary) }; // this run can finish the wave
  return { rows, wave, waitingPlaytest, launch, skipped, playtest };
}

function anchorsFor(p, L) {
  const file = path.join(p.anchorsDir, L.id, 'anchors.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')).map(a => ({ ...a, path: posix(path.join(p.anchorsDir, L.id, a.file)) }));
}

export function buildArgs(p, only = [], limit = machineLimit(p.machine, p.root)) {
  const pl = plan(p);
  const done = pl.rows.filter(r => FINISHED.has(r.state.status)).map(r => r.L.id);
  const lines = pl.launch.filter(r => !only.length || only.includes(r.L.id)).map(r => {
    const { match, ...line } = r.L;
    return { ...line, anchors: anchorsFor(p, r.L), state: r.state };
  });
  const project = {};
  for (const k of ['name', 'about', 'file', 'root', 'main', 'briefs', 'trailer', 'threshold', 'tagPrefix', 'evidenceDir', 'mergePort',
    'decisionWaitHours', 'playtest', 'context', 'hardRules', 'rules', 'workerRules', 'reviewerRules', 'checks']) if (p[k] !== undefined) project[k] = p[k];
  project.log = { entries: p.log.entries, add: p.log.add, workFields: p.log.workFields, reviewFields: p.log.reviewFields };
  let waiting = '';
  if (pl.waitingPlaytest && pl.waitingPlaytest.ready) waiting = `wave ${pl.wave} waits for the user to play the build of wave ${pl.waitingPlaytest.wave} (${pl.waitingPlaytest.ready.command || 'see its playtest-ready entry'}); record it with lines.mjs playtest`;
  else if (!lines.length && pl.skipped.length) waiting = `nothing to run: ${pl.skipped.map(s => `${s.id} is ${s.status === 'held' ? 'held by the user' : 'waiting for the user\'s decision'}`).join(', ')}`;
  return { kit: KIT, project, limit: limit.limit, limitWhy: limit.why, wave: pl.wave, done, lines, skipped: pl.skipped,
    playtest: only.length ? null : pl.playtest, waiting };
}

const ago = t => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} days ago`;
};

function describe(p, r) {
  const s = r.state;
  if (FINISHED.has(s.status)) return s.status;
  if (!r.entries) return 'not started';
  const next = { work: 'next: a work round', review: `next: review of ${s.pending ? s.pending.commit : 'the last commit'}`, rethink: 'next: a rethink',
    merge: 'next: merge into ' + p.main, pause: 'stopped: needs the user\'s decision' }[s.next] || s.next;
  return [s.status === 'held' ? 'held by the user' : s.status, `round ${s.round}`,
    s.best ? `best round ${s.best.round} at ${s.best.score}/10${s.mergedCommit && s.mergedCommit === s.best.commit ? ' (in main)' : ''}` : 'no best round yet',
    `${s.ledger.length} open finding${s.ledger.length === 1 ? '' : 's'}`,
    s.stall ? `${s.stall} round${s.stall === 1 ? '' : 's'} without improvement` : '', next, `last activity ${ago(r.lastAt)}`].filter(Boolean).join(', ');
}

function status(p, hook) {
  const pl = plan(p);
  const waves = new Set(p.lines.map(L => L.wave)).size > 1;
  const lines = pl.rows.map(r => `  ${r.L.id.padEnd(8)} ${waves ? `w${r.L.wave} ` : ''}${r.L.name}: ${describe(p, r)}`);
  const pt = pl.waitingPlaytest;
  const ptLine = pt ? (pt.ready ? `The build of wave ${pt.wave} is ready to play (${pt.ready.command || 'see its playtest-ready entry'}): ${pt.ready.summary || ''}`
    : `Wave ${pt.wave} is merged, but its playtest build is not ready yet: the next run readies it.`) : '';
  if (!hook) {
    const lim = machineLimit(p.machine, p.root);
    console.log(`${p.name} (${p.root}): ${pl.rows.length} lines${pl.wave ? `, wave ${pl.wave}` : ', all finished'}\n${lines.join('\n')}${ptLine ? '\n' + ptLine : ''}\nMachine: ${lim.why}`);
    return;
  }
  const started = new Set(pl.rows.filter(r => r.entries).map(r => r.L.id));
  const resumable = pl.launch.filter(r => started.has(r.L.id) || r.L.wave > 1);
  const paused = pl.skipped.filter(s => s.status === 'paused');
  if (!resumable.length && !paused.length && !(pt && pt.ready)) return; // nothing waits, or the user holds all of it
  let source = '';
  if (!process.stdin.isTTY) try { source = JSON.parse(fs.readFileSync(0, 'utf8') || '{}').source || ''; } catch { /* no event */ }
  const args = posix(path.join(os.tmpdir(), `lines-args-${(p.name || 'build').replace(/\W+/g, '-').toLowerCase()}.json`));
  const out = [`[master-workflow] ${p.name} has a lines build that is not finished (project ${p.file}):`, ...lines, ''];
  if (resumable.length) {
    const ids = resumable.map(r => r.L.id).join(', ');
    out.push(source === 'compact' || source === 'clear'
      ? `If the run-lines workflow you launched earlier in this session is still running, leave it. Otherwise resume ${ids}.`
      : `Workflows do not survive a restart, so ${ids} ${resumable.length === 1 ? 'is' : 'are'} not running now. Resume before anything else, unless the user's message asks for something else or to hold the build; then say in one line what is waiting.`);
    out.push(`To resume: node "${KIT}/lines.mjs" args "${p.file}" > "${args}", then Workflow({ scriptPath: "${KIT}/run-lines.js", args: <the JSON in that file> }). Use one workflow for every line, so they share the machine's limit. Then run node "${KIT}/lines.mjs" wait "${p.file}" in the background: it exits when a line stops for the user's decision or a build is ready to play.`);
  }
  if (paused.length) out.push(`Stopped for the user's decision: ${paused.map(s => s.id).join(', ')}. Show the user the best round's evidence and ask: accept the best round, continue with a new direction, or drop it. Record it with node "${KIT}/lines.mjs" decide "${p.file}" <line> accept|continue|drop "<the user's words>".`);
  if (pt && pt.ready) out.push(`${ptLine} Start it for the user when they want to play, ask for their notes, turn each note into a criterion of the line it is about (or a new line) in the lines file, reopen merged lines that need work (decide <line> reopen "<note>"), then record it: node "${KIT}/lines.mjs" playtest "${p.file}" ${pt.wave} "<their notes>".`);
  const held = pl.skipped.filter(s => s.status === 'held');
  if (held.length) out.push(`Held by the user: ${held.map(s => s.id).join(', ')}. Do not resume these until the user says so (decide <line> release).`);
  console.log(out.join('\n'));
}

function writeEntry(p, entry) {
  fs.mkdirSync(p.log.entries, { recursive: true });
  const file = posix(path.join(p.log.entries, `${entry.line}-r${entry.round ?? entry.wave ?? 0}-${entry.kind}${entry.decision ? '-' + entry.decision : ''}-${Date.now()}.json`));
  fs.writeFileSync(file, JSON.stringify(entry, null, 1));
  execSync(p.log.add.replaceAll('{entry}', `"${file}"`), { stdio: 'inherit', cwd: p.root });
}

const DECISIONS = ['accept', 'continue', 'reopen', 'drop', 'hold', 'release'];
function decide(p, which, decision, note) {
  if (!DECISIONS.includes(decision)) throw new Error(`decision must be one of ${DECISIONS.join(', ')}`);
  const rows = plan(p).rows.filter(r => which === 'all' ? !FINISHED.has(r.state.status) : r.L.id === which);
  if (!rows.length) throw new Error(which === 'all' ? 'no unfinished lines' : `no line ${which}`);
  for (const r of rows) {
    const s = r.state;
    if (decision === 'accept' && !s.best) { console.error(`${r.L.id}: nothing reviewed yet, so there is no best round to accept`); continue; }
    writeEntry(p, { line: r.L.id, round: s.round, kind: 'decision', decision, note: note || '', ...r.L.logFields,
      commit: s.best ? s.best.commit : undefined,
      summary: `The user's decision: ${decision}${note ? `: ${note}` : ''}${decision === 'accept' && s.best ? ` (round ${s.best.round}, ${s.best.score}/10)` : ''}` });
  }
}

function playtest(p, wave, notes) {
  if (!p.playtest) throw new Error('the project has no playtest section');
  if (!Number.isInteger(wave)) throw new Error('usage: lines.mjs playtest <project.json> <wave> [notes]');
  writeEntry(p, { line: 'playtest', wave, kind: 'playtest', notes: notes || '', ...p.playtest.logFields,
    summary: `The user played the build of wave ${wave}${notes ? `: ${notes}` : ''}` });
}

// Waits for the next entry of the given kinds (after the last entry of --after-last, or after everything logged now).
async function wait(p, o) {
  const kinds = (o.kinds || 'pause,playtest-ready').split(',');
  const match = e => kinds.includes(e.kind) && (!o.line || e.line === o.line);
  const log0 = readLog(p);
  let from = log0.length;
  if (o['after-last']) { from = 0; log0.forEach((e, i) => { if (e.kind === o['after-last'] && (!o.line || e.line === o.line)) from = i + 1; }); }
  const until = o.minutes ? Date.now() + +o.minutes * 60000 : Infinity;
  for (;;) {
    const hit = readLog(p).slice(from).find(match);
    if (hit) {
      const { line, kind, wave, decision, note, summary, command, round, commit } = hit;
      console.log(JSON.stringify({ kind, line, round, wave, decision, note, summary, command, commit }));
      return 0;
    }
    if (Date.now() > until) { console.log('TIMEOUT'); return 3; }
    await sleep((+o.every || 10) * 1000);
  }
}

function calibrate(p, id, rest, o) {
  const L = p.lines.find(l => l.id === id);
  if (!L) throw new Error(`no line ${id}`);
  if (o.candidates) {
    const reviews = entriesFor(readLog(p), L).filter(e => e.kind === 'review' && (e.shots || []).length);
    for (const e of reviews.slice(-6)) for (const s of e.shots.slice(0, 4))
      console.log(`round ${e.round} (${e.score}/10)  ${posix(path.resolve(p.root, s.path))}  ${s.caption || ''}`);
    if (!reviews.length) console.log(`no logged review shots for ${id} yet; use the evidence folders under ${L.cwd}/${p.evidenceDir}/`);
    return;
  }
  const picks = rest.map(a => a.match(/^(\d+)=(.+)$/)).filter(Boolean).map(m => ({ score: +m[1], src: path.resolve(m[2]) }));
  if (!picks.length) throw new Error('usage: lines.mjs calibrate <project.json> <line> <score>=<image> [...] [--note text]');
  const dir = path.join(p.anchorsDir, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const anchors = picks.sort((a, b) => a.score - b.score).map(({ score, src }) => {
    if (!fs.existsSync(src)) throw new Error(`no image ${src}`);
    const file = `${score}-${path.basename(src)}`;
    fs.copyFileSync(src, path.join(dir, file));
    return { score, file, note: o.note || '' };
  });
  fs.writeFileSync(path.join(dir, 'anchors.json'), JSON.stringify(anchors, null, 1));
  console.log(`${id}: ${anchors.map(a => `${a.score}/10 = ${a.file}`).join(', ')} in ${posix(dir)}; every reviewer of ${id} gets them`);
}

// A criterion is measurable when a stranger could check it with a number, a test or a tool's exit code.
const MEASURABLE = /\d|\bpass(es)?\b|\bexits?\b|\bfails?\b|\bzero\b|\bno (page )?errors?\b|\bat (most|least)\b|\bunder\b|\bbelow\b|\babove\b|\bwithin\b|%|\bms\b|\bfps\b|\bdB|\bLU\b|\bLUFS\b/i;

export function check(p) {
  const problems = [], warn = m => problems.push(['WARN', m]), err = m => problems.push(['ERROR', m]);
  const ids = new Set(p.lines.map(L => L.id));
  const ranges = p.lines.filter(L => !L.onMain).map(L => ({ id: L.id, lo: L.port, hi: L.port + 9 }));
  if (p.mergePort) ranges.push({ id: 'merges', lo: p.mergePort, hi: p.mergePort + 9 });
  for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++)
    if (ranges[i].lo <= ranges[j].hi && ranges[j].lo <= ranges[i].hi) err(`${ranges[i].id} and ${ranges[j].id} share ports (each takes port..port+9)`);
  for (const b of p.briefs || []) if (!fs.existsSync(path.resolve(p.root, b))) err(`brief ${b} is missing`);
  if (git(p, 'rev-parse', '--verify', '--quiet', `refs/heads/${p.main}`).status !== 0) err(`${p.root} has no branch ${p.main}`);
  for (const L of p.lines) {
    if (!L.criteria.length) err(`${L.id} has no criteria`);
    else if (!L.criteria.some(c => MEASURABLE.test(c))) warn(`${L.id} has no measurable criterion (a number, a test, an exit code): lines judged only by their looks stall`);
    if ((L.threshold || p.threshold) < 9 && !anchorsFor(p, L).length) warn(`${L.id} passes below 9 but has no calibration images (lines.mjs calibrate)`);
    for (const d of L.after) {
      const D = p.lines.find(x => x.id === d);
      if (!D) warn(`${L.id} waits for ${d}, which is not a line here (fine only if it is already merged)`);
      else if (D.wave > L.wave) err(`${L.id} (wave ${L.wave}) waits for ${d}, which is in the later wave ${D.wave}`);
    }
    if (L.onMain) continue;
    if (!fs.existsSync(L.cwd)) { warn(`${L.id}: the worktree ${L.cwd} does not exist yet (git worktree add ${L.cwd} -b ${L.branch})`); continue; }
    const head = spawnSync('git', ['-C', L.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0) err(`${L.id}: ${L.cwd} is not a git worktree`);
    else if (head.stdout.trim() !== L.branch) warn(`${L.id}: ${L.cwd} is on ${head.stdout.trim()}, not ${L.branch}`);
  }
  // a cycle in after would leave every line in it blocked
  const state = {};
  const visit = id => { if (state[id] === 1) return true; if (state[id] === 2 || !ids.has(id)) return false; state[id] = 1;
    const cyc = p.lines.find(L => L.id === id).after.some(visit); state[id] = 2; return cyc; };
  for (const L of p.lines) if (visit(L.id)) { err(`the after lists form a cycle through ${L.id}`); break; }
  return problems;
}

// default logger: appends to log.file (a JSON array) under a lock, since parallel lines log at the same time
function logEntry(p, file) {
  const e = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lock = p.log.file + '.lock', until = Date.now() + 30000;
  fs.mkdirSync(path.dirname(p.log.file), { recursive: true });
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch {
      if (Date.now() > until) { fs.rmSync(lock, { force: true }); continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    const log = readLog(p);
    e.at = new Date().toISOString();
    e.id = log.length + 1;
    log.push(e);
    fs.writeFileSync(p.log.file, JSON.stringify(log, null, 1));
    console.log(`logged #${e.id} ${e.line || ''} round ${e.round ?? '-'} ${e.kind}${e.score != null ? ' ' + e.score + '/10' : ''}`);
  } finally { fs.rmSync(lock, { force: true }); }
}

function options(rest) {
  const o = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2), n = rest[i + 1];
    if (n !== undefined && !n.startsWith('--')) { o[k] = n; i++; } else o[k] = true;
  }
  return { o, pos };
}

async function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error('usage: node lines.mjs args|status|decide|playtest|wait|calibrate|check|limits|log <project.json> ...');
    process.exit(2);
  }
  const p = loadProject(file), { o, pos } = options(rest);
  if (cmd === 'args') process.stdout.write(JSON.stringify(buildArgs(p, pos), null, 1) + '\n');
  else if (cmd === 'status') status(p, !!o.hook);
  else if (cmd === 'decide') decide(p, pos[0], pos[1], pos.slice(2).join(' '));
  else if (cmd === 'playtest') playtest(p, +pos[0], pos.slice(1).join(' '));
  else if (cmd === 'wait') process.exitCode = await wait(p, o);
  else if (cmd === 'calibrate') calibrate(p, pos[0], pos.slice(1), o);
  else if (cmd === 'check') {
    const problems = check(p);
    for (const [level, m] of problems) console.log(`${level}  ${m}`);
    console.log(problems.length ? `${problems.filter(x => x[0] === 'ERROR').length} errors, ${problems.filter(x => x[0] === 'WARN').length} warnings` : 'OK');
    if (problems.some(x => x[0] === 'ERROR')) process.exitCode = 1;
  }
  else if (cmd === 'limits') console.log(machineLimit(p.machine, p.root).why);
  else if (cmd === 'log') logEntry(p, pos[0]);
  else { console.error(`unknown command ${cmd}`); process.exit(2); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // a SessionStart hook must never get in the way of a session: in --hook mode, errors stay quiet
  main().catch(e => { if (process.argv.includes('--hook')) process.exit(0); console.error(e.message); process.exit(1); });
}
