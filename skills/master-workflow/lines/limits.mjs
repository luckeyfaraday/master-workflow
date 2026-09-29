// How many agents a lines build can run at once on this machine right now, and why.
// Every line runs one agent at a time, and an agent that runs the project (a browser, Blender, a render) needs
// memory and disk; too many at once exhausts the commit charge, grows the page file into a nearly full disk, and
// takes the session down with every loop in it. So the limit comes from what is free now, not from a guess.
//   machine config (project.json "machine"): maxLines (4), perLineGB (2.5, memory one line's agent and its tools
//   commit), reserveGB (4, left for the OS and the session), diskPerLineGB (1), diskReserveGB (2), disk (root)
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const DEFAULTS = { maxLines: 4, perLineGB: 2.5, reserveGB: 4, diskPerLineGB: 1, diskReserveGB: 2 };

// Windows: commit headroom (commit limit minus committed), which is what runs out when the page file cannot grow.
// Elsewhere: available memory.
export function memoryGB() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        '$m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; "$($m.CommittedBytes) $($m.CommitLimit) $($m.AvailableBytes)"'],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const [committed, limit, available] = out.trim().split(/\s+/).map(Number);
      if (limit > 0) return { headroom: (limit - committed) / 1e9, committed: committed / 1e9, limit: limit / 1e9, available: available / 1e9, source: 'commit charge' };
    } catch { /* fall back to os */ }
  }
  const free = os.freemem() / 1e9;
  return { headroom: free, committed: (os.totalmem() - os.freemem()) / 1e9, limit: os.totalmem() / 1e9, available: free, source: 'free memory' };
}

export function diskGB(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize / 1e9; } catch { return Infinity; }
}

export function machineLimit(machine = {}, root = process.cwd()) {
  const m = { ...DEFAULTS, disk: root, ...machine };
  const mem = memoryGB(), disk = diskGB(m.disk);
  const memSlots = Math.floor((mem.headroom - m.reserveGB) / m.perLineGB);
  const diskSlots = disk === Infinity ? m.maxLines : Math.floor((disk - m.diskReserveGB) / m.diskPerLineGB);
  const limit = Math.max(1, Math.min(m.maxLines, memSlots, diskSlots));
  const parts = [
    `memory: ${mem.headroom.toFixed(1)} GB ${mem.source === 'commit charge' ? 'of commit headroom' : 'free'} allows ${Math.max(0, memSlots)}`,
    `disk: ${disk === Infinity ? 'unknown' : disk.toFixed(1) + ' GB free'} on ${m.disk} allows ${Math.max(0, diskSlots)}`,
    `cap ${m.maxLines}`,
  ];
  const bound = limit === m.maxLines ? 'the cap' : memSlots <= diskSlots ? 'memory' : 'disk';
  const short = Math.min(memSlots, diskSlots) < 1 ? ` (the minimum: there is not room for even one line's tools, so free some ${bound} first)` : '';
  return { limit, bound, why: `${parts.join('; ')}: ${limit} at once, set by ${bound}${short}`, memory: mem, diskFreeGB: disk, memSlots, diskSlots, config: m };
}
