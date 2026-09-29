#!/usr/bin/env node
// Machine-wide slots for heavy commands (Blender, browsers, renders): at most --max of a pool run at once across
// every agent and workflow on this machine, and the rest wait their turn, first come first served.
//   node slot.mjs --pool blender --max 2 -- <command> [args...]
// --max falls back to MW_SLOTS_<POOL> (for example MW_SLOTS_BLENDER=1), then 2.
// A pool is a folder of tickets (one file per waiting or running process, named by its pid) in the temp dir; the
// oldest --max tickets run. A ticket whose process has died is removed at the next check, so a killed agent
// never holds a slot. Projects can queue on the same pool from their own code with acquire() below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const slotDir = pool => path.join(os.tmpdir(), 'master-workflow-slots', pool);

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tickets(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const pid = +name;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const file = path.join(dir, name);
    if (pid !== process.pid && !alive(pid)) { fs.rmSync(file, { force: true }); continue; }
    let t = Infinity;
    try { t = +fs.readFileSync(file, 'utf8') || Infinity; } catch { continue; }
    out.push({ pid, t });
  }
  return out.sort((a, b) => a.t - b.t || a.pid - b.pid);
}

// Waits for a slot in `pool` and resolves to a release function. onWait(ahead) is called about every 30 s.
export async function acquire(pool, max = 2, { onWait, poll = 1000 } = {}) {
  const dir = slotDir(pool);
  fs.mkdirSync(dir, { recursive: true });
  const mine = path.join(dir, String(process.pid));
  fs.writeFileSync(mine, String(Date.now()));
  const release = () => fs.rmSync(mine, { force: true });
  for (let i = 0; ; i++) {
    const queue = tickets(dir);
    const at = queue.findIndex(q => q.pid === process.pid);
    if (at < 0) fs.writeFileSync(mine, String(Date.now())); // someone removed our ticket: take a new place
    else if (at < max) return release;
    if (onWait && i % Math.max(1, Math.round(30000 / poll)) === 0) onWait(at - max + 1, queue.length);
    await sleep(poll);
  }
}

async function main() {
  const argv = process.argv.slice(2), dash = argv.indexOf('--');
  const opts = dash < 0 ? argv : argv.slice(0, dash), cmd = dash < 0 ? [] : argv.slice(dash + 1);
  const opt = k => { const i = opts.indexOf('--' + k); return i < 0 ? undefined : opts[i + 1]; };
  const pool = opt('pool');
  if (!pool || !cmd.length) {
    console.error('usage: node slot.mjs --pool <name> [--max N] -- <command> [args...]');
    process.exit(2);
  }
  const max = +opt('max') || +process.env[`MW_SLOTS_${pool.toUpperCase().replace(/\W/g, '_')}`] || 2;
  const release = await acquire(pool, max, {
    onWait: (ahead, n) => console.error(`[slot] waiting for a ${pool} slot: ${ahead} ahead, ${n} in the queue, ${max} run at once`),
  });
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd[0]) });
  const stop = sig => { try { child.kill(sig); } catch { /* already gone */ } };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', e => { release(); console.error(`[slot] ${e.message}`); process.exit(127); });
  child.on('exit', (code, signal) => { release(); process.exit(code ?? (signal ? 1 : 0)); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
