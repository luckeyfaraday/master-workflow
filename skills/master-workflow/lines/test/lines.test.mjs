// Runs run-lines.js under a mock of the Workflow runtime (agent, parallel, log) and checks the loop's decisions,
// then checks that lines.mjs replays a log to the same state. Run: node --test skills/master-workflow/lines/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject, replay, buildArgs, stateMachine, readLog } from '../lines.mjs';
import { machineLimit } from '../limits.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(KIT, 'run-lines.js');
const AsyncFunction = (async () => {}).constructor;

async function runScript(args, handler) {
  const src = fs.readFileSync(RUN, 'utf8').replace(/^export const meta/m, 'const meta');
  const calls = [], logs = [];
  let active = 0, peak = 0, merging = 0, mergePeak = 0;
  const agent = async (prompt, opts) => {
    active++; peak = Math.max(peak, active);
    const merge = opts.phase === 'Merge';
    if (merge) { merging++; mergePeak = Math.max(mergePeak, merging); }
    calls.push({ label: opts.label, phase: opts.phase, prompt });
    try { await new Promise(r => setTimeout(r, 5)); return await handler(opts.label, prompt); } finally { active--; if (merge) merging--; }
  };
  const parallel = thunks => Promise.all(thunks.map(t => t().catch(() => null)));
  const result = await new AsyncFunction('args', 'agent', 'log', 'phase', 'parallel', src)(args, agent, m => logs.push(m), () => {}, parallel);
  return { result, calls, logs, peak, mergePeak };
}

const project = {
  name: 'Toy', about: 'a toy build', root: '/repo', main: 'main', briefs: ['BRIEF.md'], trailer: 'Co-Authored-By: Test <t@t>',
  threshold: 9, tagPrefix: 'mw', evidenceDir: 'shots', mergePort: 9000, hardRules: ['the tests pass'], rules: ['stay in your worktree'],
  checks: { worker: ['npm test -- --port {port}'], review: ['npm test -- --port {port+1}'], merge: ['npm test -- --port {port}'] },
  log: { entries: '/repo/entries', add: 'node log.mjs {entry}' },
};
const line = (id, extra = {}) => ({ id, name: `Line ${id}`, cwd: `/wt/${id}`, branch: `line/${id}`, port: 7000, criteria: ['It works', 'It is fast'], logFields: {}, after: [], ...extra });
const args = (lines, extra = {}) => ({ kit: KIT, project, limit: 4, limitWhy: 'test', done: [], lines, ...extra });
const met = (...unmet) => ['C1', 'C2'].map(c => ({ criterion: c, met: !unmet.includes(c), evidence: '' }));
const review = o => ({ score: 7, verdict: 'v', compare: 'same', compareNotes: '', previous: [], newBlocking: [], newMinor: [], checklist: met(), ruleFailures: [], strengths: [], evidenceDir: 'ev', ...o });
const work = (id, round) => ({ commit: `${id}${round}`, summary: `round ${round}`, verified: 'ran it', disputes: [], openIssues: [] });
const merged = { commit: 'm1', summary: 'merged', checks: 'all pass', ok: true };
const roundOf = label => +(label.match(/r(\d+)$/) || [])[1];

test('a line that fixes its finding passes on round 2 and merges once', async () => {
  const { result, calls } = await runScript(args([line('a')]), label => {
    const r = roundOf(label);
    if (label.includes('work')) return work('a', r);
    if (label.includes('review')) return r === 1
      ? review({ compare: 'first', newBlocking: [{ criterion: 'C2', finding: 'it is slow', done: 'under 1 s' }], checklist: met('C2') })
      : review({ score: 9, compare: 'better', previous: [{ id: 'a-1', status: 'fixed', evidence: '0.4 s' }] });
    if (label.includes('merge')) return merged;
  });
  assert.equal(result.lines[0].status, 'merged');
  assert.deepEqual(calls.map(c => c.label), ['a work r1', 'a review r1', 'a work r2', 'a review r2', 'a merge']);
  assert.match(calls[2].prompt, /a-1 \[C2\] it is slow Done looks like: under 1 s/);
  assert.match(calls[3].prompt, /Settle every one by id/);
  assert.match(calls[4].prompt, /merge --no-ff a2/);
  assert.match(calls[0].prompt, /ports 7000 to 7004/);
  assert.match(calls[1].prompt, /npm test -- --port 7006/);
});

test('a worse round sends the next worker back to the best commit', async () => {
  const { result, calls } = await runScript(args([line('b')]), label => {
    const r = roundOf(label);
    if (label.includes('work')) return work('b', r);
    if (label.includes('merge')) return merged;
    if (r === 1) return review({ compare: 'first', newBlocking: [{ criterion: 'C1', finding: 'crashes', done: 'no crash' }], checklist: met('C1') });
    if (r === 2) return review({ score: 5, compare: 'worse', previous: [{ id: 'b-1', status: 'open', evidence: 'still' }], checklist: met('C1') });
    return review({ score: 9, compare: 'better', previous: [{ id: 'b-1', status: 'fixed', evidence: 'ok' }] });
  });
  const w3 = calls.find(c => c.label === 'b work r3').prompt;
  assert.match(w3, /git tag mw\/b-r2-worse HEAD && git reset --hard b1/);
  assert.doesNotMatch(calls.find(c => c.label === 'b work r2').prompt, /reset --hard/);
  assert.equal(result.lines[0].status, 'merged');
  assert.equal(result.lines[0].best.commit, 'b3');
});

test('two rounds without improvement bring a rethink, a third stops the line for a decision', async () => {
  const { result, calls } = await runScript(args([line('c')]), label => {
    const r = roundOf(label);
    if (label.includes('work')) return work('c', r);
    if (label.includes('rethink')) return { diagnosis: 'wrong approach', tried: 'a shader', branch: 'line/c-rethink-r3', commit: 'x1', result: 'twice as fast', plan: 'use the shader' };
    if (label.includes('pause')) return 'ok';
    if (r === 1) return review({ compare: 'first', newBlocking: [{ criterion: 'C2', finding: 'slow', done: 'fast' }], checklist: met('C2') });
    return review({ compare: 'same', previous: [{ id: 'c-1', status: 'open', evidence: 'still slow' }], checklist: met('C2') });
  });
  assert.deepEqual(calls.map(c => c.label), ['c work r1', 'c review r1', 'c work r2', 'c review r2', 'c work r3', 'c review r3',
    'c rethink r3', 'c work r4', 'c review r4', 'c pause']);
  assert.match(calls.find(c => c.label === 'c work r4').prompt, /diagnosis of why this line stalled[\s\S]*use the shader/);
  assert.match(calls.find(c => c.label === 'c pause').prompt, /"kind":"pause"/);
  assert.equal(result.lines[0].status, 'needs-decision');
  assert.deepEqual(result.needsDecision, ['c']);
  assert.ok(!calls.some(c => c.phase === 'Merge'));
});

test('the agent limit holds across lines and merges run one at a time', async () => {
  const ids = ['d', 'e', 'f', 'g', 'h'];
  const { result, peak, mergePeak } = await runScript(args(ids.map(id => line(id)), { limit: 2 }), label => {
    if (label.includes('work')) return work(label[0], 1);
    if (label.includes('review')) return review({ score: 9, compare: 'first' });
    return merged;
  });
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.equal(mergePeak, 1);
  assert.deepEqual(result.merged.sort(), ids);
});

test('a line waits for the lines it needs and is blocked when one of them stops', async () => {
  const { result, calls } = await runScript(args([line('x'), line('y', { after: ['x'] }), line('z', { after: ['done-already'] })], { done: ['done-already'] }), label => {
    const r = roundOf(label), id = label[0];
    if (label.includes('pause')) return 'ok';
    if (label.includes('rethink')) return { diagnosis: 'd', tried: 't', branch: 'b', commit: 'c', result: 'r', plan: 'p' };
    if (label.includes('work')) return work(id, r);
    if (label.includes('merge')) return merged;
    if (id === 'z') return review({ score: 9, compare: 'first' });
    return r === 1 ? review({ compare: 'first', newBlocking: [{ criterion: 'C1', finding: 'broken', done: 'works' }], checklist: met('C1') })
      : review({ previous: [{ id: 'x-1', status: 'open', evidence: '' }], checklist: met('C1') });
  });
  const by = Object.fromEntries(result.lines.map(r => [r.id, r]));
  assert.equal(by.x.status, 'needs-decision');
  assert.equal(by.y.status, 'blocked');
  assert.equal(by.z.status, 'merged');
  assert.ok(!calls.some(c => c.label.startsWith('y ')));
});

test('a resumed line picks up at its next step: review, rethink or merge', async () => {
  const SM = stateMachine();
  const base = id => SM.applyReview(SM.initState(), review({ compare: 'first', newBlocking: [{ criterion: 'C1', finding: 'f', done: 'd' }] }), 1, id + '1', id, ['a', 'b']).state;
  const pending = SM.applyWork(base('p'), work('p', 2));
  const stalled = { ...base('q'), stall: 2, next: 'rethink' };
  const accepted = SM.applyDecision(base('r'), 'accept');
  const { calls } = await runScript(args([line('p', { state: pending }), line('q', { state: stalled }), line('r', { state: accepted })]), label => {
    if (label === 'p review r2') return review({ score: 9, compare: 'better', previous: [{ id: 'p-1', status: 'fixed', evidence: '' }] });
    if (label.includes('rethink')) return { diagnosis: 'd', tried: 't', branch: 'b', commit: 'c', result: 'r', plan: 'p' };
    if (label.includes('work')) return work(label[0], roundOf(label));
    if (label.includes('review')) return review({ score: 9, compare: 'better', previous: [{ id: 'q-1', status: 'fixed', evidence: '' }] });
    return merged;
  });
  const first = id => calls.find(c => c.label.startsWith(id + ' ')).label;
  assert.equal(first('p'), 'p review r2');
  assert.equal(first('q'), 'q rethink r1');
  assert.equal(first('r'), 'r merge');
  assert.match(calls.find(c => c.label === 'r merge').prompt, /accepted by the user/);
});

test('a reviewer that dies is replaced on the same commit, without another work round', async () => {
  let died = false;
  const { calls, result } = await runScript(args([line('s')]), label => {
    if (label.includes('work')) return work('s', roundOf(label));
    if (label.includes('review')) { if (!died) { died = true; return null; } return review({ score: 9, compare: 'first' }); }
    return merged;
  });
  assert.deepEqual(calls.map(c => c.label), ['s work r1', 's review r1', 's review r1', 's merge']);
  assert.equal(result.lines[0].status, 'merged');
});

// ---- lines.mjs ----

function tempProject(lines, log = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-test-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: 'Toy', about: 'a toy build', root: '.', lines, machine: { maxLines: 3 } }));
  fs.mkdirSync(path.join(dir, '.master-workflow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.master-workflow', 'log.json'), JSON.stringify(log));
  return path.join(dir, 'project.json');
}
const cli = (file, ...a) => spawnSync(process.execPath, [path.join(KIT, 'lines.mjs'), ...a.slice(0, 1), file, ...a.slice(1)], { encoding: 'utf8' });

test('replaying the log gives the state the live loop reached', async () => {
  const reviews = {}, commits = {};
  const L = line('c');
  const { result } = await runScript(args([L]), label => {
    const r = roundOf(label);
    if (label.includes('work')) return (commits[r] = work('c', r));
    if (label.includes('rethink')) return { diagnosis: 'd', tried: 't', branch: 'b', commit: 'x', result: 'r', plan: 'the plan' };
    if (label.includes('pause')) return 'ok';
    reviews[r] = r === 1 ? review({ compare: 'first', newBlocking: [{ criterion: 'C2', finding: 'slow', done: 'fast' }], checklist: met('C2') })
      : review({ compare: 'same', previous: [{ id: 'c-1', status: 'open', evidence: '' }], newBlocking: r === 2 ? [{ criterion: 'C1', finding: 'ugly', done: 'nice' }] : [], checklist: met('C1', 'C2') });
    return reviews[r];
  });
  const log = [];
  for (const r of [1, 2, 3, 4]) {
    log.push({ line: 'c', round: r, kind: 'work', commit: commits[r].commit, at: new Date().toISOString() });
    log.push({ line: 'c', round: r, kind: 'review', commit: commits[r].commit, ...reviews[r], at: new Date().toISOString() });
    if (r === 3) log.push({ line: 'c', round: 3, kind: 'rethink', plan: 'the plan', at: new Date().toISOString() });
  }
  const file = tempProject([{ ...L, cwd: '.' }], log);
  const p = loadProject(file);
  const { state } = replay(p, p.lines[0], readLog(p));
  const live = result.lines[0];
  assert.equal(state.status, 'paused');
  assert.equal(state.next, 'pause');
  assert.equal(state.stall, live.stall);
  assert.deepEqual(state.best, live.best);
  assert.deepEqual(state.ledger.map(f => `${f.id}: ${f.finding}`), live.open);
  assert.deepEqual(state.history, live.history);
  assert.deepEqual(buildArgs(p, [], { limit: 2, why: 'test' }).skipped, [{ id: 'c', status: 'paused' }]);
});

test('reviews logged before the ledger replay by score: best round, stall and open findings', () => {
  const at = new Date().toISOString();
  const legacy = [7, 8, 8, 8].flatMap((score, i) => [
    { track: 11, round: i + 1, kind: 'work', commit: `w${i + 1}`, at },
    { track: 11, round: i + 1, kind: 'review', score, verdict: `r${i + 1}`, findings: [`problem ${i + 1}a`, `problem ${i + 1}b`], commit: `w${i + 1}`, at },
  ]);
  legacy.push({ track: 12, item: 'trees', round: 1, kind: 'review', score: 3, at }, { track: 11, round: 5, kind: 'work', commit: 'w5', at });
  const file = tempProject([{ id: 't11', name: 'Camera', branch: 'track/11', port: 7910, match: { track: 11, item: null } }], legacy);
  const p = loadProject(file);
  const { state } = replay(p, p.lines[0], readLog(p));
  assert.equal(state.best.round, 2);
  assert.equal(state.stall, 2);
  assert.equal(state.round, 4);
  assert.deepEqual(state.ledger.map(f => f.finding), ['problem 4a', 'problem 4b']);
  assert.equal(state.pending.commit, 'w5');
  assert.equal(state.next, 'review');
});

test('decide records the user\'s decision, and args follows it', () => {
  const at = new Date().toISOString();
  const log = [
    { line: 'a', round: 1, kind: 'work', commit: 'a1', at },
    { line: 'a', round: 1, kind: 'review', commit: 'a1', ...review({ compare: 'first', newBlocking: [{ criterion: 'C1', finding: 'f', done: 'd' }] }), at },
    { line: 'b', round: 1, kind: 'work', commit: 'b1', at },
  ];
  const file = tempProject([line('a', { cwd: '.' }), line('b', { cwd: '.' }), line('n', { cwd: '.' })], log);
  assert.equal(cli(file, 'decide', 'a', 'accept', 'good', 'enough').status, 0);
  assert.equal(cli(file, 'decide', 'b', 'hold').status, 0);
  const p = loadProject(file);
  const a = buildArgs(p, [], { limit: 2, why: 'test' });
  assert.deepEqual(a.lines.map(l => [l.id, l.state.status, l.state.next]), [['a', 'accepted', 'merge'], ['n', 'active', 'work']]);
  assert.deepEqual(a.skipped, [{ id: 'b', status: 'held' }]);
  assert.equal(readLog(p).find(e => e.kind === 'decision' && e.line === 'a').note, 'good enough');
  assert.equal(cli(file, 'decide', 'b', 'release').status, 0);
  assert.deepEqual(buildArgs(loadProject(file), ['b'], { limit: 1, why: '' }).lines.map(l => l.state.next), ['review']);
});

test('the session-start hook speaks only when a build is unfinished', () => {
  const at = new Date().toISOString();
  const hook = (file, source) => spawnSync(process.execPath, [path.join(KIT, 'lines.mjs'), 'status', file, '--hook'], { input: JSON.stringify({ source }), encoding: 'utf8' });
  const idle = tempProject([line('a', { cwd: '.' })]);
  assert.equal(hook(idle, 'startup').stdout, '');
  const busy = tempProject([line('a', { cwd: '.' })], [{ line: 'a', round: 1, kind: 'work', commit: 'a1', at }]);
  const out = hook(busy, 'startup').stdout;
  assert.match(out, /a is not running now/);
  assert.match(out, /run-lines\.js/);
  assert.match(hook(busy, 'compact').stdout, /still running, leave it/);
  assert.equal(hook(path.join(os.tmpdir(), 'no-such-project.json'), 'startup').status, 0);
  assert.equal(cli(busy, 'decide', 'all', 'hold').status, 0);
  assert.equal(hook(busy, 'startup').stdout, '', 'a build the user holds stays quiet');
});

test('slot.mjs runs at most --max commands of a pool at once', async () => {
  const pool = `test-${process.pid}`, out = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-test-'));
  const job = i => new Promise(res => {
    const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(out, 's' + i))},String(Date.now()));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(path.join(out, 'e' + i))},String(Date.now()))},400)`;
    spawn(process.execPath, [path.join(KIT, 'slot.mjs'), '--pool', pool, '--max', '2', '--', process.execPath, '-e', code], { stdio: 'ignore' }).on('exit', res);
  });
  const codes = await Promise.all([0, 1, 2, 3, 4].map(job));
  assert.deepEqual(codes, [0, 0, 0, 0, 0]);
  const span = [0, 1, 2, 3, 4].map(i => [+fs.readFileSync(path.join(out, 's' + i)), +fs.readFileSync(path.join(out, 'e' + i))]);
  for (const [s] of span) assert.ok(span.filter(([a, b]) => a <= s && s < b).length <= 2, 'more than 2 ran at once');
});

test('machineLimit gives at least one agent and says why', () => {
  const m = machineLimit({ maxLines: 3 }, os.tmpdir());
  assert.ok(m.limit >= 1 && m.limit <= 3);
  assert.match(m.why, /memory: .* disk: .* cap 3/);
});
