// node --test tests/cost.test.mjs — a dollar figure for every run: runCost() per delegate
// (Codex counts cached input inside input_tokens, agy and pi apart), price.mjs over Claude
// transcripts, piUsage() (the pi wallet: no quota, spend today / 7 days), and the scorecard
// telling a billed figure from one at list price.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { runCost } from '../scripts/lib/prices.mjs';
import { piUsage, usdShort } from '../scripts/lib/wallets.mjs';
import { build } from '../scripts/scorecard.mjs';

const PRICE = fileURLToPath(new URL('../scripts/price.mjs', import.meta.url));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const table = (known) => ({ lookup: (m) => (known.includes(m) ? { in: 1e-6, out: 2e-6, cacheRead: 1e-7 } : null) });

test('runCost: Codex input includes the cached part, agy and pi report it apart', () => {
  const p = table(['m']);
  near(runCost(p, 'codex', 'm', { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 }), 600e-6 + 400e-7 + 200e-6);
  near(runCost(p, 'agy', 'm', { input_tokens: 1000, cache_read_tokens: 400, output_tokens: 100 }), 1000e-6 + 400e-7 + 200e-6);
  near(runCost(p, 'pi', 'gateway/m', { input_tokens: 1000, output_tokens: 100 }), 1000e-6 + 200e-6);   // provider/id → the bare id
});

test('runCost: null without a price or without usage', () => {
  assert.equal(runCost(table([]), 'agy', 'm', { input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(runCost(table(['m']), 'agy', 'm', null), null);
  assert.equal(runCost(table(['m']), 'agy', 'm', {}), null);
});

function home(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-cost-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('price.mjs: tokens and ≈ USD per transcript; one message is counted once; unpriced models are named', (t) => {
  const dir = home(t);
  mkdirSync(path.join(dir, 'config', 'multiclaude'), { recursive: true });
  writeFileSync(path.join(dir, 'config', 'multiclaude', 'prices.json'), JSON.stringify({ 'test-model': { in: 10, out: 50, cacheRead: 1 } }));
  const msg = (id, model, usage) => JSON.stringify({ type: 'assistant', requestId: 'r-' + id, timestamp: '2026-11-11T08:00:00Z', message: { id, model, usage } });
  const a = msg('m1', 'test-model', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 });
  const file = path.join(dir, 'agent-x.jsonl');
  writeFileSync(file, [JSON.stringify({ type: 'user', message: { content: 'hi' } }), a, a, msg('m2', 'mystery-model', { input_tokens: 70, output_tokens: 30 }), 'not json'].join('\n') + '\n');
  const r = spawnSync(process.execPath, [PRICE, file, path.join(dir, 'missing.jsonl')], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_CONFIG_HOME: path.join(dir, 'config') }, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const [x, missing] = JSON.parse(r.stdout);
  near(x.usd, 0.037);   // 1000 × $10/M + 500 × $50/M + 2000 × $1/M — the repeated line once
  assert.equal(x.calls, 2);
  assert.equal(x.unpriced, 100);
  assert.equal(x.total, 3600);
  assert.equal(x.model, 'test-model');
  assert.deepEqual(x.models.map((m) => [m.model, m.usd]), [['test-model', 0.037], ['mystery-model', null]]);
  assert.equal(missing.error, 'ENOENT');
  assert.equal(spawnSync(process.execPath, [PRICE], { encoding: 'utf8' }).status, 2);
});

test('piUsage: an unlimited wallet with today and 7-day spend off the run log', (t) => {
  const dir = home(t);
  const file = path.join(dir, 'runs.jsonl');
  const now = new Date(2026, 10, 11, 15, 0, 0).getTime();   // local time, like the wallet's "today"
  const at = (daysAgo, h = 9) => new Date(2026, 10, 11 - daysAgo, h, 0, 0).toISOString();
  writeFileSync(file, [
    { ts: at(0), delegate: 'pi', model: 'm', tokens: 1000, cost: 0.2, costKind: 'reported' },
    { ts: at(0, 10), delegate: 'pi', model: 'm', tokens: 500, cost: null, costKind: null },   // no price: tokens only
    { ts: at(1), delegate: 'pi', model: 'm', tokens: 2000, cost: 0.05, costKind: 'list' },
    { ts: at(3), delegate: 'pi', model: 'm', tokens: 100, cost: 0.01 },                       // an older runner: no costKind = reported
    { ts: at(8), delegate: 'pi', model: 'm', tokens: 9000, cost: 5, costKind: 'reported' },  // outside the 7 days
    { ts: at(0), delegate: 'codex', model: 'c', tokens: 7000, cost: 3, costKind: 'list' },   // another wallet
  ].map((l) => JSON.stringify(l)).join('\n') + '\nbroken line "pi"\n');
  const p = piUsage({ now, file });
  assert.equal(p.unlimited, true);
  assert.equal(typeof p.installed, 'boolean');
  assert.deepEqual(p.today, { usd: 0.2, runs: 2, tokens: 1500, approx: false });
  assert.deepEqual(p.d7, { usd: 0.26, runs: 4, tokens: 3600, approx: true });
  assert.equal(usdShort(p.today), '$0.20');
  assert.equal(usdShort(p.d7), '≈$0.26');
  assert.equal(usdShort({ usd: 0.002, approx: true }), '≈$0.0020');
  assert.deepEqual(piUsage({ now, file: path.join(dir, 'none.jsonl') }).d7, { usd: 0, runs: 0, tokens: 0, approx: false });
});

test('scorecard: a row whose cost was priced at list price is marked approximate', () => {
  const ts = new Date().toISOString();
  const r = build([
    { ts, job: 'a', delegate: 'pi', model: 'billed', status: 'SUCCESS', cost: 0.2, costKind: 'reported' },
    { ts, job: 'b', delegate: 'pi', model: 'listed', status: 'SUCCESS', cost: 0.1, costKind: 'list' },
    { ts, job: 'c', delegate: 'pi', model: 'old', status: 'SUCCESS', cost: 0.3 },
  ], []);
  const row = (m) => r.rows.find((x) => x.model === m);
  assert.equal(row('billed').costApprox, false);
  assert.equal(row('listed').costApprox, true);
  assert.equal(row('old').costApprox, false);
});
