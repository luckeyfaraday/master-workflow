#!/usr/bin/env node
// The command line of a lines build (see README.md). Every line's state is replayed from the project's progress
// log with the state machine in run-lines.js itself, so a resumed build continues exactly where the log stops.
//   node lines.mjs args <project.json> [line ...]    args for the run-lines workflow: every unfinished line (or the
//                                                    ones named), its state, and the agent limit for this machine
//   node lines.mjs status <project.json> [--hook]    where every line stands; --hook is the SessionStart hook: it
//                                                    reads the event on stdin and prints only when a build is unfinished
//   node lines.mjs decide <project.json> <line|all> <accept|continue|drop|hold|release> [note]
//                                                    records the user's decision on a stopped (or any) line
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

// The state machine block of run-lines.js, evaluated here: one implementation for the live loop and the replay.
export function stateMachine(src = fs.readFileSync(RUN_LINES, 'utf8')) {
  const a = src.indexOf('// ---- state machine'), b = src.indexOf('// ---- end state machine ----');
  if (a < 0 || b < a) throw new Error(`${RUN_LINES} has no state machine block`);
  return new Function(`${src.slice(a, b)}\nreturn { initState, applyWork, applyReview, applyRethink, applyDecision, STALL_RETHINK, STALL_PAUSE }`)();
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
  p.trailer = p.trailer || '';
  p.checks = { worker: [], review: [], merge: [], ...p.checks };
  const log = { file: '.master-workflow/log.json', entries: '.master-workflow/entries', ...p.log };
  log.file = posix(path.resolve(p.root, log.file));
  log.entries = posix(path.resolve(p.root, log.entries));
  log.add = log.add || `node "${KIT}/lines.mjs" log "${p.file}" {entry}`;
  p.log = log;
  const lines = typeof p.lines === 'string' ? JSON.parse(fs.readFileSync(path.resolve(dir, p.lines), 'utf8')) : p.lines || [];
  p.lines = lines.map(L => ({ logFields: {}, criteria: [], after: [], ...L, cwd: posix(path.resolve(p.root, L.cwd || '.')) }));
  const ids = new Set();
  for (const L of p.lines) {
    if (!L.id || ids.has(L.id)) throw new Error(`every line needs a unique id (${L.id || 'missing'})`);
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
      st = SM.applyReview(st, rv, e.round ?? st.round + 1, commit, L.id, legacy ? [] : L.criteria).state;
    } else if (e.kind === 'rethink') st = SM.applyRethink(st, e.plan);
    else if (e.kind === 'decision') st = SM.applyDecision(st, e.decision, e.note);
    else if (e.kind === 'merge') st = SM.applyDecision(st, 'merged');
  }
  // passed or accepted work that is already in main (merged by hand, or before the merge entry was logged)
  if ((st.status === 'passed' || st.status === 'accepted') && st.best && isAncestor(p, st.best.commit)) st = SM.applyDecision(st, 'merged');
  const last = entries.length ? Date.parse(entries[entries.length - 1].at) : NaN;
  return { state: st, entries: entries.length, lastAt: Number.isFinite(last) ? last : null };
}

function isAncestor(p, commit) {
  if (!commit) return false;
  return spawnSync('git', ['-C', p.root, 'merge-base', '--is-ancestor', commit, p.main], { stdio: 'ignore' }).status === 0;
}

const FINISHED = new Set(['merged', 'dropped']);

export function buildArgs(p, only = [], limit = machineLimit(p.machine, p.root)) {
  const log = readLog(p), SM = stateMachine();
  const done = [], lines = [], skipped = [];
  for (const L of p.lines) {
    const { state } = replay(p, L, log, SM);
    if (FINISHED.has(state.status)) { done.push(L.id); continue; }
    if (only.length && !only.includes(L.id)) continue;
    if (state.status === 'held' || state.status === 'paused') { skipped.push({ id: L.id, status: state.status }); continue; }
    const { match, ...line } = L;
    lines.push({ ...line, state });
  }
  const project = {};
  for (const k of ['name', 'about', 'root', 'main', 'briefs', 'trailer', 'threshold', 'tagPrefix', 'evidenceDir', 'mergePort',
    'context', 'hardRules', 'rules', 'workerRules', 'reviewerRules', 'checks']) if (p[k] !== undefined) project[k] = p[k];
  project.log = { entries: p.log.entries, add: p.log.add, workFields: p.log.workFields, reviewFields: p.log.reviewFields };
  return { kit: KIT, project, limit: limit.limit, limitWhy: limit.why, done, lines, skipped };
}

const ago = t => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} days ago`;
};

export function report(p) {
  const log = readLog(p), SM = stateMachine();
  return p.lines.map(L => {
    const { state: s, entries, lastAt } = replay(p, L, log, SM);
    let what;
    if (FINISHED.has(s.status)) what = s.status;
    else if (!entries) what = 'not started';
    else {
      const next = { work: 'next: a work round', review: `next: review of ${s.pending ? s.pending.commit : 'the last commit'}`, rethink: 'next: a rethink', merge: 'next: merge into ' + p.main, pause: 'stopped: needs the user\'s decision' }[s.next] || s.next;
      what = [s.status === 'held' ? 'held by the user' : s.status, `round ${s.round}`,
        s.best ? `best round ${s.best.round} at ${s.best.score}/10` : 'no review yet', `${s.ledger.length} open finding${s.ledger.length === 1 ? '' : 's'}`,
        s.stall ? `${s.stall} round${s.stall === 1 ? '' : 's'} without improvement` : '', next, `last activity ${ago(lastAt)}`].filter(Boolean).join(', ');
    }
    return { id: L.id, name: L.name, state: s, entries, lastAt, what };
  });
}

function status(p, hook) {
  const rows = report(p);
  const unfinished = rows.filter(r => r.entries && !FINISHED.has(r.state.status));
  const lines = rows.map(r => `  ${r.id.padEnd(8)} ${r.name}: ${r.what}`);
  if (!hook) {
    const lim = machineLimit(p.machine, p.root);
    console.log(`${p.name} (${p.root}): ${rows.length} lines\n${lines.join('\n')}\nMachine: ${lim.why}`);
    return;
  }
  const paused = unfinished.filter(r => r.state.status === 'paused'), held = unfinished.filter(r => r.state.status === 'held');
  const resumable = unfinished.filter(r => r.state.status !== 'paused' && r.state.status !== 'held');
  if (!resumable.length && !paused.length) return; // nothing unfinished, or the user is holding all of it
  let source = '';
  if (!process.stdin.isTTY) try { source = JSON.parse(fs.readFileSync(0, 'utf8') || '{}').source || ''; } catch { /* no event */ }
  const args = posix(path.join(os.tmpdir(), `lines-args-${(p.name || 'build').replace(/\W+/g, '-').toLowerCase()}.json`));
  const out = [`[master-workflow] ${p.name} has a lines build that is not finished (project ${p.file}):`, ...lines, ''];
  if (resumable.length) {
    out.push(source === 'compact' || source === 'clear'
      ? `If the run-lines workflow you launched earlier in this session is still running, leave it. Otherwise resume ${resumable.map(r => r.id).join(', ')}.`
      : `Workflows do not survive a restart, so ${resumable.map(r => r.id).join(', ')} ${resumable.length === 1 ? 'is' : 'are'} not running now. Resume before anything else, unless the user's message asks for something else or to hold the build; then say in one line what is waiting.`);
    out.push(`To resume: node "${KIT}/lines.mjs" args "${p.file}" > "${args}", then Workflow({ scriptPath: "${KIT}/run-lines.js", args: <the JSON in that file> }). Use one workflow for every line, so they share the machine's limit.`);
  }
  if (paused.length) out.push(`Stopped for the user's decision: ${paused.map(r => r.id).join(', ')}. Show the user the best round's evidence and ask: accept the best round, continue with a new direction, or drop it. Record it with node "${KIT}/lines.mjs" decide "${p.file}" <line> accept|continue|drop "<the user's words>", then resume that line.`);
  if (held.length) out.push(`Held by the user: ${held.map(r => r.id).join(', ')}. Do not resume these until the user says so (decide <line> release).`);
  console.log(out.join('\n'));
}

function writeEntry(p, entry) {
  fs.mkdirSync(p.log.entries, { recursive: true });
  const file = posix(path.join(p.log.entries, `${entry.line}-r${entry.round ?? 0}-${entry.kind}${entry.decision ? '-' + entry.decision : ''}-${Date.now()}.json`));
  fs.writeFileSync(file, JSON.stringify(entry, null, 1));
  execSync(p.log.add.replaceAll('{entry}', `"${file}"`), { stdio: 'inherit', cwd: p.root });
}

function decide(p, which, decision, note) {
  const ok = ['accept', 'continue', 'drop', 'hold', 'release'];
  if (!ok.includes(decision)) throw new Error(`decision must be one of ${ok.join(', ')}`);
  const rows = report(p).filter(r => which === 'all' ? !FINISHED.has(r.state.status) : r.id === which);
  if (!rows.length) throw new Error(which === 'all' ? 'no unfinished lines' : `no line ${which}`);
  for (const r of rows) {
    const L = p.lines.find(l => l.id === r.id);
    if (decision === 'accept' && !r.state.best) { console.error(`${r.id}: nothing reviewed yet, so there is no best round to accept`); continue; }
    writeEntry(p, { line: r.id, round: r.state.round, kind: 'decision', decision, note: note || '', ...L.logFields,
      commit: r.state.best ? r.state.best.commit : undefined,
      summary: `The user's decision: ${decision}${note ? `: ${note}` : ''}${decision === 'accept' && r.state.best ? ` (round ${r.state.best.round}, ${r.state.best.score}/10)` : ''}` });
  }
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

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error('usage: node lines.mjs args|status|decide|limits|log <project.json> ...');
    process.exit(2);
  }
  const p = loadProject(file);
  if (cmd === 'args') process.stdout.write(JSON.stringify(buildArgs(p, rest.filter(a => !a.startsWith('--'))), null, 1) + '\n');
  else if (cmd === 'status') status(p, rest.includes('--hook'));
  else if (cmd === 'decide') decide(p, rest[0], rest[1], rest.slice(2).join(' '));
  else if (cmd === 'limits') console.log(machineLimit(p.machine, p.root).why);
  else if (cmd === 'log') logEntry(p, rest[0]);
  else { console.error(`unknown command ${cmd}`); process.exit(2); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // a SessionStart hook must never get in the way of a session: in --hook mode, errors stay quiet
  try { main(); } catch (e) { if (process.argv.includes('--hook')) process.exit(0); console.error(e.message); process.exit(1); }
}
