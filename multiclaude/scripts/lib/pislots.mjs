// Machine-wide limit on pi runs at once. Every chat's runner talks to the same model server; several
// long-context runs side by side ended in "502 Bad Gateway" from the proxy (2026-11-14, four shadows of
// four chats at 13:52). So every pi run — a job of its own, a trial, a shadow — takes a slot first.
//
// No lock: each runner writes its own entry, <cache>/multiclaude/pi-slots/<pid>-<job>.json
// { pid, job, shadow, ts, state: waiting|running }, then reads the directory. Entries whose process is
// gone, or that were not touched for STALE_MS (the holder touches its entry every HEARTBEAT_MS), are
// removed. A waiter starts when fewer than `limit` entries run and it is first in line among the waiters
// (a real job before a shadow, then the order they came in) — every runner sorts the same entries the
// same way, and each writes its entry before it reads, so two waiters never both take the last slot.
import { readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWin = process.platform === 'win32';
export const DEFAULT_LIMIT = 2;
export const MAX_LIMIT = 16;
const HEARTBEAT_MS = 20_000;
const STALE_MS = 90_000;

export const slotsDir = (env = process.env) =>
  path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'multiclaude', 'pi-slots');
export const configFile = (env = process.env) => path.join(isWin
  ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'multiclaude')
  : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'multiclaude'), 'pi.json');

const clamp = (n) => Math.min(MAX_LIMIT, Math.max(1, Math.round(n)));

// MULTICLAUDE_PI_PARALLEL wins over <config>/multiclaude/pi.json { "parallel": N }; default 2.
export function slotLimit(env = process.env) {
  const e = +env.MULTICLAUDE_PI_PARALLEL;
  if (e > 0) return { limit: clamp(e), from: 'MULTICLAUDE_PI_PARALLEL' };
  try {
    const n = +JSON.parse(readFileSync(configFile(env), 'utf8')).parallel;
    if (n > 0) return { limit: clamp(n), from: configFile(env) };
  } catch { /* none */ }
  return { limit: DEFAULT_LIMIT, from: 'default' };
}

export function setSlotLimit(n, env = process.env) {
  const f = configFile(env);
  let cur = {};
  try { cur = JSON.parse(readFileSync(f, 'utf8')) || {}; } catch { /* new */ }
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ ...cur, parallel: clamp(n) }, null, 2) + '\n');
  return clamp(n);
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// The live entries, oldest first; dead or stale ones are removed on the way.
export function readSlots({ dir = slotsDir(), now = Date.now(), isAlive = alive } = {}) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const f = path.join(dir, n);
    let e = null, mtime = 0;
    try { e = JSON.parse(readFileSync(f, 'utf8')); mtime = statSync(f).mtimeMs; } catch { continue; }   // mid-write or gone
    if (!e || !e.pid || !isAlive(e.pid) || now - mtime > STALE_MS) { try { unlinkSync(f); } catch { /* gone */ } continue; }
    out.push({ ...e, file: f });
  }
  return out.sort((a, b) => a.ts - b.ts || a.pid - b.pid);
}

// May `me` (an entry already written) start now?
export function mayStart(entries, me, limit) {
  const running = entries.filter((e) => e.state === 'running' && e.file !== me.file).length;
  if (running >= limit) return false;
  const waiting = entries.filter((e) => e.state !== 'running')
    .sort((a, b) => (a.shadow ? 1 : 0) - (b.shadow ? 1 : 0) || a.ts - b.ts || a.pid - b.pid);
  const rank = waiting.findIndex((e) => e.file === me.file);
  return rank >= 0 && rank < limit - running;
}

const writeEntry = (file, e) => {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(e));
  renameSync(tmp, file);
};

// Wait for a slot. Resolves { release, waited, slot } once this run may start; `null` when `cancelled()`
// turns true or `maxWaitMs` runs out. `onWait(info)` is called on the first wait and on every change of
// what it is waiting behind ({ running, ahead, limit }).
export async function acquireSlot({ job = 'nojob', shadow = false, maxWaitMs = 30 * 60_000, pollMs = 2000,
  onWait = () => {}, cancelled = () => false, dir = slotsDir(), limit = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const me = { pid: process.pid, job, shadow: !!shadow, ts: Date.now(), state: 'waiting' };
  me.file = path.join(dir, `${process.pid}-${String(job).replace(/[^\w.-]/g, '_')}.json`);
  const { file, ...body } = me;
  writeEntry(file, body);
  const t0 = Date.now();
  let lastSeen = '', lastTouch = Date.now();
  const drop = () => { try { unlinkSync(file); } catch { /* gone */ } };
  for (;;) {
    if (cancelled()) { drop(); return null; }
    const lim = limit || slotLimit().limit;
    const entries = readSlots({ dir });
    if (!entries.some((e) => e.file === file)) writeEntry(file, body);   // removed as stale (a sleep, a stall): back in line
    else if (mayStart(entries, me, lim)) break;
    if (Date.now() - t0 >= maxWaitMs) { drop(); return null; }
    const running = entries.filter((e) => e.state === 'running').length;
    const ahead = entries.filter((e) => e.state !== 'running' && e.file !== file
      && ((e.shadow ? 1 : 0) - (me.shadow ? 1 : 0) || e.ts - me.ts || e.pid - me.pid) < 0).length;
    const seen = `${running}/${lim}/${ahead}`;
    if (seen !== lastSeen) { lastSeen = seen; onWait({ running, ahead, limit: lim }); }
    if (Date.now() - lastTouch > HEARTBEAT_MS) { try { utimesSync(file, new Date(), new Date()); } catch { /* re-written next round */ } lastTouch = Date.now(); }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  writeEntry(file, { ...body, state: 'running', startedAt: Date.now() });
  const beat = setInterval(() => {
    try { utimesSync(file, new Date(), new Date()); } catch { writeEntry(file, { ...body, state: 'running' }); }
  }, HEARTBEAT_MS);
  beat.unref();
  let released = false;
  const release = () => { if (released) return; released = true; clearInterval(beat); drop(); };
  process.on('exit', release);
  return { release, waited: Date.now() - t0 };
}
