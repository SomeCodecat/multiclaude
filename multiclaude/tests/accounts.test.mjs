// Auto-switch decisions (scripts/lib/accounts.mjs): the weekly pace of an account and the
// `balance` strategy that spreads the work over the accounts' weeks. `decide()` is pure —
// it gets a snapshot — so nothing here touches a login.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MULTICLAUDE_ACCOUNTS_DIR = mkdtempSync(path.join(os.tmpdir(), 'mc-acct-'));
after(() => rmSync(process.env.MULTICLAUDE_ACCOUNTS_DIR, { recursive: true, force: true }));
const A = await import('../scripts/lib/accounts.mjs');

const NOW = Date.UTC(2026, 0, 15, 12);
const H = 3600_000, D = 24 * H;
// One account: 5h used %, weekly used %, time until the weekly reset.
const acct = (slot, { active = false, five = 10, week = 0, resetIn = 7 * D, scoped = [], ...rest } = {}) => ({
  slot, email: `a${slot}@example.test`, active, disabled: false, dead: false, session: [],
  usage: { fetchedAt: NOW, fiveHour: { pct: five, resetsAt: NOW + 2 * H }, sevenDay: { pct: week, resetsAt: resetIn == null ? null : NOW + resetIn }, scoped },
  ...rest,
});
const snap = (accounts, auto = {}) => ({ accounts, unmanagedLive: null, config: { auto: { ...A.DEFAULT_CONFIG.auto, ...auto } } });
const decide = (accounts, auto) => A.decide(snap(accounts, auto), {}, NOW);

test('weeklyPace: used % against the share of the week that has gone by', () => {
  const p = A.weeklyPace({ sevenDay: { pct: 24, resetsAt: NOW + 0.7 * D } }, { now: NOW });
  assert.equal(Math.round(p.gone), 90);
  assert.equal(Math.round(p.ahead), -66);
  // A week that has not begun: nothing gone, so the usage itself is the lead.
  assert.deepEqual(A.weeklyPace({ sevenDay: { pct: 5, resetsAt: null } }, { now: NOW }), { used: 5, gone: 0, ahead: 5, resetsAt: null });
  assert.equal(A.weeklyPace({}, { now: NOW }), null);
  // With a model, its weekly window counts too and the one further ahead decides.
  const u = { sevenDay: { pct: 30, resetsAt: NOW + 3.5 * D }, scoped: [{ name: 'Opus', pct: 80, resetsAt: NOW + 3.5 * D }] };
  assert.equal(Math.round(A.weeklyPace(u, { now: NOW }).ahead), -20);
  assert.equal(Math.round(A.weeklyPace(u, { model: 'opus', now: NOW }).ahead), 30);
});

test('balance is the default strategy; auto-switch itself stays off by default', () => {
  assert.equal(A.DEFAULT_CONFIG.auto.strategy, 'balance');
  assert.equal(A.DEFAULT_CONFIG.auto.enabled, false);
});

test('balance: quota that expires soon is used first — the account behind its weekly pace gets the login', () => {
  // Active: 69 % used, 2 days left (71 % of the week gone). Other: 24 % used, 5 h left.
  const d = decide([acct(1, { week: 24, resetIn: 5 * H }), acct(2, { active: true, week: 69, resetIn: 2 * D })]);
  assert.equal(d.action, 'switch');
  assert.equal(d.to, 1);
  assert.match(d.reason, /^balance: #1 24% used with 97% of its week gone, active #2 69% used with 71% of its week gone — 71 points apart$/);
});

test('balance: same reset day → the weekly usage itself is evened out, in steps of the gap', () => {
  assert.equal(decide([acct(1, { active: true, week: 60 }), acct(2, { week: 30 })]).to, 2);
  const held = decide([acct(1, { active: true, week: 38 }), acct(2, { week: 30 })]);
  assert.equal(held.action, 'hold');
  assert.match(held.reason, /^balanced: .* 8 points apart, a switch needs 10$/);
  assert.equal(decide([acct(1, { active: true, week: 38 }), acct(2, { week: 30 })], { balanceGap: 5 }).action, 'switch');
  // The account that is behind never gets left for one that is ahead.
  assert.equal(decide([acct(1, { active: true, week: 20 }), acct(2, { week: 70 })]).action, 'hold');
});

test('balance: no move to an account whose 5h window is about to fill, or that is over its weekly line', () => {
  assert.equal(decide([acct(1, { active: true, week: 60 }), acct(2, { week: 10, five: 88 })]).action, 'hold');
  assert.equal(decide([acct(1, { active: true, week: 99, resetIn: 6 * D, threshold: 100 }), acct(2, { week: 91, resetIn: 1 * H })]).action, 'hold');
});

test('balance keeps both weeks alive: neither account is used up while the other sits unused', () => {
  // The active account gains a weekly point per step; the login follows every decision.
  const run = (strategy) => {
    const w = { 1: 0, 2: 0 };
    let active = 1, apart = 0, switches = 0;
    for (let i = 0; i < 120; i++) {
      w[active] += 1;
      const d = decide([acct(1, { active: active === 1, week: w[1] }), acct(2, { active: active === 2, week: w[2] })], { strategy });
      if (d.action === 'switch') { active = d.to; switches++; }
      apart = Math.max(apart, Math.abs(w[1] - w[2]));
    }
    return { w, apart, switches };
  };
  const bal = run('balance');
  assert.ok(bal.apart <= 10, `never more than the gap apart, was ${bal.apart}`);
  assert.deepEqual(bal.w, { 1: 60, 2: 60 });
  assert.ok(bal.switches <= 12, `a switch per ${10} points, not a flutter: ${bal.switches}`);
  // `best` (the old default) drains one account to its line before it touches the other.
  const best = run('best');
  assert.equal(best.apart, 90);
});

test('at the 5h line, balance goes to the account furthest behind its week; best to the one with the most room', () => {
  const accounts = [
    acct(1, { active: true, five: 93, week: 40 }),
    acct(2, { five: 5, week: 30 }),   // most room under its lines
    acct(3, { five: 50, week: 20 }),  // furthest behind its week
  ];
  assert.equal(decide(accounts).to, 3);
  assert.equal(decide(accounts, { strategy: 'best' }).to, 2);
});

test('best still holds under the line, however far the other account is behind', () => {
  const d = decide([acct(1, { week: 24, resetIn: 5 * H }), acct(2, { active: true, week: 69, resetIn: 2 * D })], { strategy: 'best' });
  assert.equal(d.action, 'hold');
  assert.match(d.reason, /under its line/);
});

test('config: strategy and balanceGap are checked', () => {
  assert.equal(A.setConfig('auto.strategy', 'balance').auto.strategy, 'balance');
  assert.equal(A.setConfig('auto.balanceGap', '15').auto.balanceGap, 15);
  assert.throws(() => A.setConfig('auto.strategy', 'even'), /balance \| best \| consume-first/);
  assert.throws(() => A.setConfig('auto.balanceGap', '0'), /1–50/);
});

// Models with a weekly window of their own (the usage API's scoped limits, e.g. Fable):
// the case seen 2026-11-27 — #1 Fable 81 % (week just begun), #2 Fable 100 % but far behind
// its overall weekly pace. Balance kept moving a Fable chat from #1 back to #2.
const fableCase = (active) => [
  acct(1, { active: active === 1, five: 9, week: 52, resetIn: 6.2 * D, scoped: [{ name: 'Fable', pct: 81, resetsAt: NOW + 6.2 * D }] }),
  acct(2, { active: active === 2, five: 2, week: 55, resetIn: 1 * D, scoped: [{ name: 'Fable', pct: 100, resetsAt: NOW + 1 * D }] }),
];
const decideUsing = (accounts, inUse, auto = {}) => A.decide({ ...snap(accounts, auto), inUse }, {}, NOW);

test('modelFamily: ids, display names and bare names reduce to one word', () => {
  assert.equal(A.modelFamily('claude-fable-5-2'), 'fable');
  assert.equal(A.modelFamily('claude-opus-5-5[1m]'), 'opus');
  assert.equal(A.modelFamily('Fable 5.2'), 'fable');
  assert.equal(A.modelFamily('claude-3-5-sonnet-20241022'), 'sonnet');
  assert.equal(A.modelFamily(''), null);
});

test('a model in use whose window is full on an account keeps the login off that account', () => {
  // Without Fable in use: the old behaviour, balance moves to #2 (behind its weekly pace).
  assert.equal(decideUsing(fableCase(1), []).to, 2);
  // A chat on Fable: #2's Fable window is full, so it is no candidate.
  const d = decideUsing(fableCase(1), ['fable']);
  assert.equal(d.action, 'hold');
  assert.match(d.reason, /#2 Fable 100%/);
  // Opus in use: no account has an Opus window of its own, so nothing changes.
  assert.equal(decideUsing(fableCase(1), ['opus']).to, 2);
  // auto.model set by hand still works the same way.
  assert.equal(decideUsing(fableCase(1), [], { model: 'Fable' }).action, 'hold');
});

test('a model in use moves the login to the account that still has that model', () => {
  // Active #2 with Fable full: its Fable window is past the line, #1 has room.
  const d = decideUsing(fableCase(2), ['fable']);
  assert.equal(d.action, 'switch');
  assert.equal(d.to, 1);
});

test('models in use are remembered for IN_USE_MS', () => {
  A.noteModelsInUse(['claude-fable-5-2', 'Opus 5.5'], NOW);
  assert.deepEqual(A.modelsInUse(NOW + 60_000), ['fable', 'opus']);
  assert.deepEqual(A.modelsInUse(NOW + A.IN_USE_MS + 1), []);
  assert.deepEqual(A.guardedModels({}, ['fable', 'opus'], fableCase(1)), ['fable']);
});
