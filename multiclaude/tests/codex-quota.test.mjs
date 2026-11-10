// node --test tests/codex-quota.test.mjs — scripts/lib/wallets.mjs: a Codex run refused for its
// usage limit logs no fresh window %, only the error; codexUsage()/codexState() must read that
// error as "exhausted until the retry time" (dispatch.mjs preflight, probe, headroom line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseRetryAt } from '../scripts/lib/wallets.mjs';

const WALLETS = fileURLToPath(new URL('../scripts/lib/wallets.mjs', import.meta.url));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const retryText = (t) => {   // the CLI's wording, local time
  const d = new Date(t), h = d.getHours();
  return `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${MON[d.getMonth()]} ${d.getDate()}th, ${d.getFullYear()} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}.`;
};
const windowsLine = (ts, pct, resetsAt) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: null, secondary: { used_percent: pct, window_minutes: 10080, resets_at: Math.round(resetsAt / 1000) }, plan_type: 'plus' } } });
const premiumLine = (ts) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'premium', primary: null, secondary: null, credits: { has_credits: false, balance: '0' } } } });
const errorLine = (ts, msg) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null, error: { message: msg, codex_error_info: 'usage_limit_exceeded' } } });

// Each file = one Codex session; later in the list = newer (mtime).
function usageFor(t, sessions) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mc-codex-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '10');
  mkdirSync(dir, { recursive: true });
  const base = Date.now() / 1000 - 3600;
  sessions.forEach((lines, i) => {
    const f = path.join(dir, `rollout-${i}.jsonl`);
    writeFileSync(f, lines.join('\n') + '\n');
    utimesSync(f, base + i * 60, base + i * 60);
  });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const w = await import(${JSON.stringify('file://' + WALLETS)}); const c = w.codexUsage(); console.log(JSON.stringify({ c, s: w.codexState(c) }))`],
  { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const now = Date.now();
const retry = Math.floor((now + 20 * 3600_000) / 60_000) * 60_000;   // whole minutes, as the CLI prints

test('parseRetryAt reads the CLI wording as local time', () => {
  assert.equal(parseRetryAt('… or try again at Nov 11th, 2026 1:28 PM.'), new Date(2026, 10, 11, 13, 28).getTime());
  assert.equal(parseRetryAt('try again at Dec 1st, 2026 12:05 AM'), new Date(2026, 11, 1, 0, 5).getTime());
  assert.equal(parseRetryAt('try again at Jan 2nd, 2027 12:30 PM'), new Date(2027, 0, 2, 12, 30).getTime());
  assert.equal(parseRetryAt('rate limited, slow down'), null);
});

test('a usage-limit refusal after a stale 16% snapshot reads as exhausted until the retry time', (t) => {
  const { c, s } = usageFor(t, [
    [windowsLine(now - 6 * 86400_000, 16, retry)],
    [premiumLine(now - 60_000), errorLine(now - 50_000, retryText(retry))],
  ]);
  assert.equal(c.blocked.until, retry);
  assert.equal(c.secondary.pct, 100, 'the window that resets at the retry time is marked spent');
  assert.equal(s.out, true);
  assert.equal(s.until, retry);
});

test('a window snapshot newer than the refusal clears it (credits bought, plan upgraded)', (t) => {
  const { c, s } = usageFor(t, [
    [errorLine(now - 3600_000, retryText(retry))],
    [windowsLine(now - 60_000, 40, retry)],
  ]);
  assert.equal(c.blocked, null);
  assert.equal(c.secondary.pct, 40);
  assert.equal(s.out, false);
});

test('a refusal whose retry time has passed no longer blocks', (t) => {
  const past = Math.floor((now - 600_000) / 60_000) * 60_000;
  const { c, s } = usageFor(t, [
    [windowsLine(now - 6 * 86400_000, 16, past)],
    [errorLine(now - 3 * 3600_000, retryText(past))],
  ]);
  assert.equal(c.blocked, null);
  assert.equal(s.out, false);
});

test('a full window with its reset ahead is out even without a logged refusal', (t) => {
  const { s } = usageFor(t, [[windowsLine(now - 60_000, 100, retry)]]);
  assert.equal(s.out, true);
  assert.match(s.why, /wk window 100% used/);
});
