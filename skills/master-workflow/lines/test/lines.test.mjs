// Runs run-lines.js under a mock of the Workflow runtime (agent, parallel, log) and checks the loop's decisions,
// then checks that lines.mjs replays a log to the same state. Run: node --test skills/master-workflow/lines/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject, replay, buildArgs, stateMachine, readLog, plan, check } from '../lines.mjs';
import { machineLimit } from '../limits.mjs';
import { setCap } from '../slot.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(KIT, 'run-lines.js');
const AsyncFunction = (async () => {}).constructor;

async function runScript(args, handler) {
  const src = fs.readFileSync(RUN, 'utf8').replace(/^export const meta/m, 'const meta');
  const calls = [], logs = [];
  let active = 0, peak = 0, merging = 0, mergePeak = 0;
  const agent = async (prompt, opts) => {
    const counted = opts.phase !== 'Decide'; // the decision wait takes no agent slot
    if (counted) { active++; peak = Math.max(peak, active); }
    const merge = opts.phase === 'Merge';
    if (merge) { merging++; mergePeak = Math.max(mergePeak, merging); }
    calls.push({ label: opts.label, phase: opts.phase, prompt });
    try { await new Promise(r => setTimeout(r, 5)); return await handler(opts.label, prompt); } finally { if (counted) active--; if (merge) merging--; }
  };
  const parallel = thunks => Promise.all(thunks.map(t => t().catch(() => null)));
  const result = await new AsyncFunction('args', 'agent', 'log', 'phase', 'parallel', src)(args, agent, m => logs.push(m), () => {}, parallel);
  return { result, calls, logs, peak, mergePeak };
}

const project = {
  name: 'Toy', about: 'a toy build', file: '/repo/project.json', root: '/repo', main: 'main', briefs: ['BRIEF.md'], trailer: 'Co-Authored-By: Test <t@t>',
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
const none = { decision: 'none', note: '' };
const rethought = { diagnosis: 'd', tried: 't', branch: 'b', commit: 'c', result: 'r', plan: 'p' };
const stalling = id => label => { // first review finds a problem, every later one says nothing changed
  const r = roundOf(label);
  if (label.includes('waits for your decision')) return none;
  if (label.includes('rethink')) return rethought;
  if (label.includes('work')) return work(id, r);
  if (label.includes('merge')) return merged;
  return r === 1 ? review({ compare: 'first', newBlocking: [{ criterion: 'C1', finding: 'broken', done: 'works' }], checklist: met('C1') })
    : review({ previous: [{ id: `${id}-1`, status: 'open', evidence: '' }], checklist: met('C1') });
};

test('a line that fixes its finding passes on round 2 and merges once', async () => {
  const { result, calls } = await runScript(args([line('a')]), label => {
    const r = roundOf(label);
    if (label.includes('work')) return work('a', r);
    if (label.includes('merge')) return merged;
    return r === 1
      ? review({ compare: 'first', newBlocking: [{ criterion: 'C2', finding: 'it is slow', done: 'under 1 s' }], checklist: met('C2') })
      : review({ score: 9, compare: 'better', previous: [{ id: 'a-1', status: 'fixed', evidence: '0.4 s' }] });
  });
  assert.equal(result.lines[0].status, 'merged');
  assert.deepEqual(calls.map(c => c.label), ['a work r1', 'a review r1', 'a work r2', 'a review r2', 'a merge r2']);
  assert.match(calls[2].prompt, /a-1 \[C2\] it is slow Done looks like: under 1 s/);
  assert.match(calls[3].prompt, /Settle every one by id/);
  assert.match(calls[4].prompt, /merge --no-ff a2/);
  assert.match(calls[4].prompt, /"final": true/);
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

test('two stalls bring a rethink, a third stops the line and waits for the user without taking a slot', async () => {
  const { result, calls, peak } = await runScript(args([line('c')], { limit: 1 }), label => {
    if (label.includes('rethink')) return { ...rethought, plan: 'use the shader' };
    return stalling('c')(label);
  });
  assert.deepEqual(calls.map(c => c.label), ['c work r1', 'c review r1', 'c work r2', 'c review r2', 'c work r3', 'c review r3',
    'c rethink r3', 'c work r4', 'c review r4', 'c waits for your decision']);
  assert.match(calls.find(c => c.label === 'c work r4').prompt, /diagnosis of why this line stalled[\s\S]*use the shader/);
  const stop = calls.find(c => c.label === 'c waits for your decision').prompt;
  assert.match(stop, /"kind":"pause"/);
  assert.match(stop, /lines\.mjs" wait "\/repo\/project\.json" --line c --kinds decision --after-last pause --minutes 9/);
  assert.match(stop, /up to 54 times/); // 8 hours of 9-minute waits
  assert.equal(result.lines[0].status, 'needs-decision');
  assert.deepEqual(result.needsDecision, ['c']);
  assert.ok(!calls.some(c => c.phase === 'Merge'));
  assert.equal(peak, 1);
});

test('the user\'s decision arrives during the run and the line goes on', async () => {
  let decided = false;
  const { result, calls } = await runScript(args([line('k')]), label => {
    const r = roundOf(label);
    if (label.includes('waits for your decision')) { decided = true; return { decision: 'continue', note: 'try a lookup table' }; }
    if (decided && label.includes('review')) return review({ score: 9, compare: 'better', previous: [{ id: 'k-1', status: 'fixed', evidence: '' }] });
    return stalling('k')(label);
  });
  assert.equal(result.lines[0].status, 'merged');
  assert.match(calls.find(c => c.label === 'k work r5').prompt, /decided to continue: try a lookup table/);
});

test('the agent limit holds across lines, merges run one at a time, and a free slot goes to the line others wait on', async () => {
  const ids = ['d', 'e', 'f', 'g', 'h'];
  const { result, peak, mergePeak } = await runScript(args(ids.map(id => line(id)), { limit: 2 }), label => {
    if (label.includes('work')) return work(label[0], 1);
    if (label.includes('review')) return review({ score: 9, compare: 'first' });
    return merged;
  });
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.equal(mergePeak, 1);
  assert.deepEqual(result.merged.sort(), ids);
  const pr = await runScript(args(['p', 'q', 'r', 's', 't'].map(id => line(id, id === 't' ? { after: ['s'] } : {})), { limit: 1 }), label => {
    if (label.includes('work')) return work(label[0], 1);
    if (label.includes('review')) return review({ score: 9, compare: 'first' });
    return merged;
  });
  assert.deepEqual(pr.calls.slice(0, 2).map(c => c.label), ['p work r1', 's work r1'], 's has a line waiting on it, so it goes before q and r');
});

test('a line waits for the lines it needs and is blocked when one of them stops', async () => {
  const { result, calls } = await runScript(args([line('x'), line('y', { after: ['x'] }), line('z', { after: ['done-already'] })], { done: ['done-already'] }), label => {
    if (label.startsWith('z ')) return label.includes('work') ? work('z', 1) : label.includes('merge') ? merged : review({ score: 9, compare: 'first' });
    return stalling('x')(label);
  });
  const by = Object.fromEntries(result.lines.map(r => [r.id, r]));
  assert.equal(by.x.status, 'needs-decision');
  assert.equal(by.y.status, 'blocked');
  assert.equal(by.z.status, 'merged');
  assert.ok(!calls.some(c => c.label.startsWith('y ')));
});

test('a line that improves what main has merges every better round and keeps going', async () => {
  const { result, calls } = await runScript(args([line('m', { merge: 'on-better' })]), label => {
    const r = roundOf(label);
    if (label.includes('work')) return work('m', r);
    if (label.includes('merge')) return merged;
    if (r === 1) return review({ score: 7, compare: 'better', newBlocking: [{ criterion: 'C1', finding: 'flat', done: 'shaded' }], checklist: met('C1') });
    if (r === 2) return review({ score: 7, compare: 'same', previous: [{ id: 'm-1', status: 'open', evidence: '' }], checklist: met('C1') });
    return review({ score: 9, compare: 'better', previous: [{ id: 'm-1', status: 'fixed', evidence: '' }] });
  });
  assert.deepEqual(calls.map(c => c.label), ['m work r1', 'm review r1', 'm merge r1', 'm work r2', 'm review r2', 'm work r3', 'm review r3', 'm merge r3']);
  assert.match(calls[1].prompt, /improves something main already has/);
  assert.match(calls[2].prompt, /"final": false/);
  assert.match(calls[3].prompt, /Round 1 is already in main/);
  assert.match(calls[7].prompt, /"final": true/);
  assert.equal(result.lines[0].status, 'merged');
});

test('a resumed line picks up at its next step: review, rethink or merge', async () => {
  const SM = stateMachine();
  const base = id => SM.applyReview(SM.initState(), review({ compare: 'first', newBlocking: [{ criterion: 'C1', finding: 'f', done: 'd' }] }), 1, id + '1', id, ['a', 'b']).state;
  const pending = SM.applyWork(base('p'), work('p', 2));
  const stalled = { ...base('q'), stall: 2, next: 'rethink' };
  const accepted = SM.applyDecision(base('r'), 'accept');
  const { calls } = await runScript(args([line('p', { state: pending }), line('q', { state: stalled }), line('r', { state: accepted })]), label => {
    if (label === 'p review r2') return review({ score: 9, compare: 'better', previous: [{ id: 'p-1', status: 'fixed', evidence: '' }] });
    if (label.includes('rethink')) return rethought;
    if (label.includes('work')) return work(label[0], roundOf(label));
    if (label.includes('review')) return review({ score: 9, compare: 'better', previous: [{ id: 'q-1', status: 'fixed', evidence: '' }] });
    return merged;
  });
  const first = id => calls.find(c => c.label.startsWith(id + ' ')).label;
  assert.equal(first('p'), 'p review r2');
  assert.equal(first('q'), 'q rethink r1');
  assert.equal(first('r'), 'r merge r1');
  assert.match(calls.find(c => c.label === 'r merge r1').prompt, /accepted by the user/);
});

test('a reviewer that dies is replaced on the same commit, without another work round', async () => {
  let died = false;
  const { calls, result } = await runScript(args([line('s')]), label => {
    if (label.includes('work')) return work('s', roundOf(label));
    if (label.includes('review')) { if (!died) { died = true; return null; } return review({ score: 9, compare: 'first' }); }
    return merged;
  });
  assert.deepEqual(calls.map(c => c.label), ['s work r1', 's review r1', 's review r1', 's merge r1']);
  assert.equal(result.lines[0].status, 'merged');
});

test('when the run finishes a wave, main is readied for the user to play', async () => {
  const pt = { serve: 'npm run play -- --port 8080', checks: ['npm run smoke'] };
  const earlier = { id: 'old', name: 'Old line', status: 'merged', best: { round: 2, score: 9 } };
  const { result, calls } = await runScript(args([line('w')], { project: { ...project, playtest: pt }, playtest: { wave: 1, lines: [earlier] } }), label => {
    if (label.startsWith('playtest')) return { ok: true, commit: 'abc', summary: 'towns and sound', checks: 'pass' };
    if (label.includes('work')) return work('w', 1);
    if (label.includes('merge')) return merged;
    return review({ score: 9, compare: 'first' });
  });
  const p = calls.find(c => c.phase === 'Playtest').prompt;
  assert.match(p, /old \(Old line, round 2, 9\/10\), w \(Line w, round 1, 9\/10\)/);
  assert.match(p, /npm run smoke/);
  assert.match(p, /tag -f mw\/playtest-w1 main/);
  assert.deepEqual(result.playtest, { wave: 1, ready: true, commit: 'abc', summary: 'towns and sound', command: 'npm run play -- --port 8080' });
  const stopped = await runScript(args([line('v')], { project: { ...project, playtest: pt }, playtest: { wave: 1, lines: [] } }), stalling('v'));
  assert.equal(stopped.result.playtest, null, 'no playtest while a line of the wave waits for a decision');
});

test('the reviewer gets the user\'s calibration images', async () => {
  const anchors = [{ score: 6, path: '/a/6.jpg', note: '' }, { score: 9, path: '/a/9.jpg', note: 'this is the bar' }];
  const { calls } = await runScript(args([line('n', { anchors, threshold: 8 })]), label => {
    if (label.includes('work')) return work('n', 1);
    if (label.includes('merge')) return merged;
    return review({ score: 8, compare: 'first' });
  });
  const rv = calls.find(c => c.phase === 'Review').prompt;
  assert.match(rv, /\/a\/6\.jpg is a 6\/10; \/a\/9\.jpg is a 9\/10 \(this is the bar\)\. Score on that scale\./);
  assert.match(rv, /A score below 8 needs/);
});

// ---- lines.mjs ----

function tempProject(lines, log = [], extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-test-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: 'Toy', about: 'a toy build', root: '.', lines, machine: { maxLines: 3 }, ...extra }));
  fs.mkdirSync(path.join(dir, '.master-workflow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.master-workflow', 'log.json'), JSON.stringify(log));
  return path.join(dir, 'project.json');
}
const cli = (file, ...a) => spawnSync(process.execPath, [path.join(KIT, 'lines.mjs'), ...a.slice(0, 1), file, ...a.slice(1)], { encoding: 'utf8' });
const at = new Date().toISOString();

test('replaying the log gives the state the live loop reached', async () => {
  const reviews = {}, commits = {};
  const L = line('c');
  const { result } = await runScript(args([L]), label => {
    const r = roundOf(label);
    if (label.includes('work')) return (commits[r] = work('c', r));
    if (label.includes('rethink')) return { ...rethought, plan: 'the plan' };
    if (label.includes('waits for your decision')) return none;
    reviews[r] = r === 1 ? review({ compare: 'first', newBlocking: [{ criterion: 'C2', finding: 'slow', done: 'fast' }], checklist: met('C2') })
      : review({ compare: 'same', previous: [{ id: 'c-1', status: 'open', evidence: '' }], newBlocking: r === 2 ? [{ criterion: 'C1', finding: 'ugly', done: 'nice' }] : [], checklist: met('C1', 'C2') });
    return reviews[r];
  });
  const log = [];
  for (const r of [1, 2, 3, 4]) {
    log.push({ line: 'c', round: r, kind: 'work', commit: commits[r].commit, at });
    log.push({ line: 'c', round: r, kind: 'review', commit: commits[r].commit, ...reviews[r], at });
    if (r === 3) log.push({ line: 'c', round: 3, kind: 'rethink', plan: 'the plan', at });
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

test('a line that merges when better replays its merges and keeps going', () => {
  const log = [
    { line: 'm', round: 1, kind: 'work', commit: 'm1', at },
    { line: 'm', round: 1, kind: 'review', commit: 'm1', ...review({ compare: 'better', newBlocking: [{ criterion: 'C1', finding: 'flat', done: '' }], checklist: met('C1') }), at },
    { line: 'm', round: 1, kind: 'merge', commit: 'x9', merged: 'm1', final: false, at },
  ];
  const p = loadProject(tempProject([line('m', { cwd: '.', merge: 'on-better' })], log));
  const { state } = replay(p, p.lines[0], readLog(p));
  assert.equal(state.mergedCommit, 'm1');
  assert.equal(state.status, 'active');
  assert.equal(state.next, 'work');
});

test('reviews logged before the ledger replay by score: best round, stall and open findings', () => {
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

test('waves: the next wave starts only after the user played the last one, and a playtest note can reopen a line', () => {
  const log = [
    { line: 'a', round: 1, kind: 'work', commit: 'a1', at },
    { line: 'a', round: 1, kind: 'review', commit: 'a1', ...review({ score: 9, compare: 'first' }), at },
    { line: 'a', round: 1, kind: 'merge', commit: 'x1', merged: 'a1', final: true, at },
  ];
  const file = tempProject([line('a', { cwd: '.' }), line('b', { cwd: '.', wave: 2 })], log, { playtest: { serve: 'npm run play' } });
  const lim = { limit: 2, why: '' };
  let a = buildArgs(loadProject(file), [], lim);
  assert.deepEqual([a.wave, a.lines.length, a.playtest && a.playtest.wave], [2, 0, 1], 'wave 1 is merged but its build was never readied');
  const logged = readLog(loadProject(file));
  logged.push({ line: 'playtest', kind: 'playtest-ready', wave: 1, command: 'npm run play', summary: 'a', at });
  fs.writeFileSync(loadProject(file).log.file, JSON.stringify(logged));
  a = buildArgs(loadProject(file), [], lim);
  assert.deepEqual([a.lines.length, a.playtest], [0, null]);
  assert.match(a.waiting, /waits for the user to play the build of wave 1 \(npm run play\)/);
  const hook = spawnSync(process.execPath, [path.join(KIT, 'lines.mjs'), 'status', file, '--hook'], { input: '{"source":"startup"}', encoding: 'utf8' }).stdout;
  assert.match(hook, /ready to play \(npm run play\)[\s\S]*lines\.mjs" playtest/);
  assert.equal(cli(file, 'playtest', '1', 'the', 'menu', 'is', 'slow').status, 0);
  a = buildArgs(loadProject(file), [], lim);
  assert.deepEqual([a.lines.map(l => l.id), a.playtest && a.playtest.wave], [['b'], 2]);
  assert.equal(cli(file, 'decide', 'a', 'reopen', 'the menu is slow').status, 0);
  a = buildArgs(loadProject(file), [], lim);
  assert.deepEqual([a.wave, a.lines.map(l => [l.id, l.state.next])], [1, [['a', 'work']]]);
  assert.match(a.lines[0].state.strategy, /reopened this line after playing the build: the menu is slow/);
});

test('wait blocks until the entry it waits for is logged', async () => {
  const file = tempProject([line('a', { cwd: '.' })], [{ line: 'a', round: 3, kind: 'pause', at }]);
  const waiter = spawn(process.execPath, [path.join(KIT, 'lines.mjs'), 'wait', file, '--line', 'a', '--kinds', 'decision', '--after-last', 'pause', '--every', '0.2']);
  let out = '';
  waiter.stdout.on('data', d => { out += d; });
  const exited = new Promise(r => waiter.on('exit', r));
  await new Promise(r => setTimeout(r, 600));
  assert.equal(out, '', 'nothing yet');
  assert.equal(cli(file, 'decide', 'a', 'continue', 'go on').status, 0);
  assert.equal(await exited, 0);
  assert.deepEqual((({ kind, line: l, decision, note }) => ({ kind, line: l, decision, note }))(JSON.parse(out)), { kind: 'decision', line: 'a', decision: 'continue', note: 'go on' });
  const timeout = cli(file, 'wait', '--kinds', 'merge', '--minutes', '0.01', '--every', '0.2');
  assert.deepEqual([timeout.status, timeout.stdout.trim()], [3, 'TIMEOUT']);
});

test('calibrate stores the user\'s reference images and args hands them to the reviewer', () => {
  const file = tempProject([line('a', { cwd: '.', threshold: 8 })]);
  const dir = path.dirname(file);
  for (const n of ['six.jpg', 'nine.jpg']) fs.writeFileSync(path.join(dir, n), 'x');
  assert.equal(cli(file, 'calibrate', 'a', `6=${path.join(dir, 'six.jpg')}`, `9=${path.join(dir, 'nine.jpg')}`, '--note', 'from round 3').status, 0);
  const [L] = buildArgs(loadProject(file), [], { limit: 1, why: '' }).lines;
  assert.deepEqual(L.anchors.map(x => [x.score, path.basename(x.path), x.note]), [[6, '6-six.jpg', 'from round 3'], [9, '9-nine.jpg', 'from round 3']]);
  assert.ok(fs.existsSync(L.anchors[1].path));
});

test('check finds shared ports, cycles, waves out of order and lines with nothing measurable', () => {
  const file = tempProject([
    line('a', { cwd: '.', port: 7000, criteria: ['It looks nice'] }),
    line('b', { cwd: '.', port: 7005, after: ['c'] }),
    line('c', { cwd: '.', port: 7100, after: ['b'], wave: 2, criteria: ['The tests pass'] }),
  ], [], { briefs: ['NOPE.md'] });
  const problems = check(loadProject(file)).map(([level, m]) => `${level} ${m}`).join('\n');
  assert.match(problems, /ERROR a and b share ports/);
  assert.match(problems, /ERROR brief NOPE\.md is missing/);
  assert.match(problems, /WARN a has no measurable criterion/);
  assert.match(problems, /ERROR b \(wave 1\) waits for c, which is in the later wave 2/);
  assert.match(problems, /ERROR the after lists form a cycle/);
  assert.doesNotMatch(problems, /c has no measurable/);
});

test('the session-start hook speaks only when a build is unfinished', () => {
  const hook = (file, source) => spawnSync(process.execPath, [path.join(KIT, 'lines.mjs'), 'status', file, '--hook'], { input: JSON.stringify({ source }), encoding: 'utf8' });
  const idle = tempProject([line('a', { cwd: '.' })]);
  assert.equal(hook(idle, 'startup').stdout, '');
  const busy = tempProject([line('a', { cwd: '.' })], [{ line: 'a', round: 1, kind: 'work', commit: 'a1', at }]);
  const out = hook(busy, 'startup').stdout;
  assert.match(out, /a is not running now/);
  assert.match(out, /run-lines\.js/);
  assert.match(out, /lines\.mjs" wait/);
  assert.match(hook(busy, 'compact').stdout, /still running, leave it/);
  assert.equal(hook(path.join(os.tmpdir(), 'no-such-project.json'), 'startup').status, 0);
  assert.equal(cli(busy, 'decide', 'all', 'hold').status, 0);
  assert.equal(hook(busy, 'startup').stdout, '', 'a build the user holds stays quiet');
});

async function slotSpans(pool, max, n) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-test-'));
  const job = i => new Promise(res => {
    const code = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(out, 's' + i))},String(Date.now()));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(path.join(out, 'e' + i))},String(Date.now()))},400)`;
    spawn(process.execPath, [path.join(KIT, 'slot.mjs'), '--pool', pool, '--max', String(max), '--', process.execPath, '-e', code], { stdio: 'ignore' }).on('exit', res);
  });
  const codes = await Promise.all([...Array(n).keys()].map(job));
  assert.deepEqual(codes, Array(n).fill(0));
  const span = [...Array(n).keys()].map(i => [+fs.readFileSync(path.join(out, 's' + i)), +fs.readFileSync(path.join(out, 'e' + i))]);
  return Math.max(...span.map(([s]) => span.filter(([a, b]) => a <= s && s < b).length));
}

test('slot.mjs runs at most --max commands of a pool at once, and a cap throttles it', async () => {
  assert.ok(await slotSpans(`test-${process.pid}`, 2, 5) <= 2);
  const capped = `test-cap-${process.pid}`;
  setCap(capped, 1);
  try { assert.equal(await slotSpans(capped, 3, 3), 1); } finally { setCap(capped, null); }
});

test('machineLimit gives at least one agent and says why', () => {
  const m = machineLimit({ maxLines: 3 }, os.tmpdir());
  assert.ok(m.limit >= 1 && m.limit <= 3);
  assert.match(m.why, /memory: .* disk: .* cap 3/);
});

test('plan puts accepted lines in any run, since a merge never waits for a wave', () => {
  const log = [
    { line: 'a', round: 1, kind: 'work', commit: 'a1', at },
    { line: 'a', round: 1, kind: 'review', commit: 'a1', ...review({ compare: 'first', newBlocking: [{ criterion: 'C1', finding: 'f', done: '' }] }), at },
    { line: 'a', round: 1, kind: 'decision', decision: 'accept', at },
  ];
  const p = loadProject(tempProject([line('z', { cwd: '.' }), line('a', { cwd: '.', wave: 2 })], log));
  assert.deepEqual(plan(p).launch.map(r => r.L.id), ['z', 'a']);
});
