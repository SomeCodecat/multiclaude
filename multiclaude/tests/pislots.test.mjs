// node --test tests/pislots.test.mjs — the machine-wide limit on pi runs at once (lib/pislots.mjs):
// who may start, dead and stale entries, a real job ahead of a shadow, the limit from env / config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mayStart, readSlots, acquireSlot, slotLimit, setSlotLimit, DEFAULT_LIMIT } from '../scripts/lib/pislots.mjs';

const tmp = (t) => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'mc-slots-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const e = (file, state, ts, shadow = false, pid = 1) => ({ file, state, ts, shadow, pid });

test('mayStart: room left, first in line; a real job goes before an older shadow', () => {
  const run = e('r', 'running', 1);
  const sh = e('s', 'waiting', 2, true);
  const job = e('j', 'waiting', 3);
  assert.equal(mayStart([run, sh, job], job, 2), true);    // one free slot: the job, though it came later
  assert.equal(mayStart([run, sh, job], sh, 2), false);
  assert.equal(mayStart([run, sh, job], sh, 3), true);     // two free: both
  assert.equal(mayStart([run, e('r2', 'running', 0), job], job, 2), false);   // full
});

test('readSlots: a dead process or an entry not touched for 90 s is removed', (t) => {
  const dir = tmp(t);
  const put = (n, pid, ago = 0) => {
    const f = path.join(dir, n);
    writeFileSync(f, JSON.stringify({ pid, job: n, ts: Date.now(), state: 'running' }));
    if (ago) utimesSync(f, new Date(Date.now() - ago), new Date(Date.now() - ago));
  };
  put('live.json', process.pid);
  put('dead.json', 999_999_999);
  put('stale.json', process.pid, 120_000);
  assert.deepEqual(readSlots({ dir }).map((x) => x.job), ['live.json']);
  assert.deepEqual(readdirSync(dir).sort(), ['live.json']);
});

test('acquireSlot: waits while the slots are taken, starts when one frees, gives up when cancelled', async (t) => {
  const dir = tmp(t);
  const a = await acquireSlot({ dir, job: 'a', limit: 1, pollMs: 20 });
  assert.ok(a);
  const waits = [];
  let freed = false;
  const bP = acquireSlot({ dir, job: 'b', limit: 1, pollMs: 20, onWait: (w) => waits.push(w) });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(waits[0], { running: 1, ahead: 0, limit: 1 });
  freed = true; a.release();
  const b = await bP;
  assert.ok(b && freed);
  // cancelled while waiting: null, and its entry is gone
  let stop = false;
  const cP = acquireSlot({ dir, job: 'c', limit: 1, pollMs: 20, cancelled: () => stop });
  await new Promise((r) => setTimeout(r, 60));
  stop = true;
  assert.equal(await cP, null);
  assert.deepEqual(readSlots({ dir }).map((x) => x.job), ['b']);
  b.release();
  // a wait that runs out
  const x = await acquireSlot({ dir, job: 'x', limit: 1 });
  assert.equal(await acquireSlot({ dir, job: 'y', limit: 1, pollMs: 10, maxWaitMs: 50 }), null);
  x.release();
});

test('slotLimit: env over config file over the default; clamped', (t) => {
  const cfg = tmp(t);
  const env = { XDG_CONFIG_HOME: cfg, APPDATA: cfg };
  assert.deepEqual(slotLimit(env), { limit: DEFAULT_LIMIT, from: 'default' });
  assert.equal(setSlotLimit(3, env), 3);
  assert.equal(slotLimit(env).limit, 3);
  assert.equal(slotLimit({ ...env, MULTICLAUDE_PI_PARALLEL: '5' }).limit, 5);
  assert.equal(slotLimit({ ...env, MULTICLAUDE_PI_PARALLEL: '99' }).limit, 16);
  mkdirSync(cfg, { recursive: true });
});
