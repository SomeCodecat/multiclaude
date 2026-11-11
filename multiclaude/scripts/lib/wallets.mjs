// multiclaude wallet readers — one source of truth for each wallet's data, shared
// by the full quota report and the compact hook snapshot. Each returns plain data;
// the callers format it. Cross-platform, no python3.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { HOME, run, newestFile, mtimeMs, which } from './mc.mjs';
import { loginStore } from './claudelogin.mjs';
export { agyModels as agyTiers, resolveAgyTiers as resolveTiers } from './models.mjs';

// ── CODEX — newest rate_limits snapshot across recent ~/.codex/sessions/**/*.jsonl ──
// The CLI logs `rate_limits` with a `limit_id` ("codex" = the plan's windows,
// "premium" = credits) and windows carrying `window_minutes` (300 = 5-hour,
// 10080 = weekly). A session may log only one window, and the newest file may be
// a credits-only snapshot — so scan the last few sessions and label each window
// by its real length instead of assuming primary=5h / secondary=weekly.
function recentSessionFiles(root, n) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    let ents; const d = stack.pop();
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ p, m: mtimeMs(p) });
    }
  }
  return files.sort((a, b) => b.m - a.m).slice(0, n).map((f) => f.p);
}
function windowLabel(min) {
  if (!min) return 'win';
  if (min <= 360) return '5h';
  if (min >= 10000 && min <= 10200) return 'wk';
  return min % 1440 === 0 ? `${min / 1440}d` : `${Math.round(min / 60)}h`;
}
// A run refused for quota logs NO new window snapshot — only a premium/credits
// one and a task_complete error "You've hit your usage limit … try again at
// Nov 11th, 2026 1:28 PM" (codex_error_info usage_limit_exceeded). The last
// window % is then stale (it can read 16% while the plan is shut), so the error
// itself is the signal: blocked until that time, unless a later run logged real
// window figures again (credits bought, plan upgraded).
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseRetryAt(msg) {   // the CLI prints local time
  const m = /try again at\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(String(msg || ''));
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  let h = +m[4];
  if (m[6]) { const pm = /p/i.test(m[6]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  const t = new Date(+m[3], mon, +m[2], h, +m[5]).getTime();
  return Number.isFinite(t) ? t : null;
}
const isLimitHit = (c) => c && c.error && typeof c.error === 'object'
  && (c.error.codex_error_info === 'usage_limit_exceeded' || /hit your usage limit/i.test(c.error.message || ''));
const hasWindows = (rl) => !!(rl && (rl.primary || rl.secondary));

export function codexUsage() {
  const files = recentSessionFiles(path.join(HOME, '.codex', 'sessions'), 12);
  if (!files.length) return { ok: false, msg: 'no Codex session yet (run codex once)', blocked: null };
  const now = Date.now() / 1000;
  const byWindow = new Map();   // label → {pct, resetSec, minutes}   newest wins
  let plan = null, sessionTokens = null, credits = null, sawAny = false;
  let hit = null, sawWindows = false;   // newest usage-limit error, counted only if no real window snapshot is newer
  for (const f of files) {                 // newest file first
    let data; try { data = readFileSync(f, 'utf8'); } catch { continue; }
    const lines = data.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {   // newest line first
      const ln = lines[i];
      if (!ln.includes('"rate_limits"') && !ln.includes('"total_token_usage"') && !ln.includes('usage limit') && !ln.includes('usage_limit_exceeded')) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      const st = [o];
      while (st.length) {
        const c = st.pop();
        if (c && typeof c === 'object' && !Array.isArray(c)) {
          if (!hit && !sawWindows && isLimitHit(c)) {
            const ts = Date.parse(o.timestamp) || mtimeMs(f) || Date.now();
            hit = { at: ts, until: parseRetryAt(c.error.message), msg: String(c.error.message || 'usage limit') };
          }
          if (c.rate_limits && typeof c.rate_limits === 'object') {
            const rl = c.rate_limits;
            sawAny = true;
            if (hasWindows(rl)) sawWindows = true;
            if (rl.plan_type && !plan) plan = rl.plan_type;
            if (rl.credits && credits == null) credits = rl.credits;
            for (const w of [rl.primary, rl.secondary]) {
              if (!w || typeof w.used_percent !== 'number') continue;
              const lab = windowLabel(w.window_minutes);
              if (!byWindow.has(lab)) byWindow.set(lab, { label: lab, pct: w.used_percent, resetSec: w.resets_at ? Math.round(w.resets_at - now) : null, minutes: w.window_minutes || null });
            }
          }
          if (c.total_token_usage && typeof c.total_token_usage === 'object' && sessionTokens == null) sessionTokens = c.total_token_usage.total_tokens || 0;
          st.push(...Object.values(c));
        } else if (Array.isArray(c)) st.push(...c);
      }
    }
    if (byWindow.has('5h') && byWindow.has('wk')) break;
  }
  // blocked: the newest limit error has no real window snapshot after it and its
  // retry time (else ~1 h after the error) is still ahead.
  let blocked = null;
  if (hit) {
    const until = hit.until || hit.at + 3600_000;
    if (until > Date.now()) blocked = { until, at: hit.at, msg: hit.msg };
  }
  if (!sawAny) return { ok: false, msg: blocked ? 'usage limit hit' : 'no rate-limit snapshot in recent sessions', blocked };
  const windows = [...byWindow.values()].sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
  if (blocked) {   // the window that resets at the retry time is the one that is spent
    for (const w of windows) if (w.resetSec != null && Math.abs(now + w.resetSec - blocked.until / 1000) < 2 * 3600) { w.pct = 100; w.stale = true; }
  }
  const find = (l) => windows.find((w) => w.label === l) || null;
  return { ok: true, windows, primary: find('5h'), secondary: find('wk'), plan, sessionTokens, credits, blocked };
}

// Codex preflight verdict (dispatch.mjs, probe): out = do not start a run.
export function codexState(c = codexUsage(), cap = 99.5) {
  if (c && c.blocked) return { out: true, until: c.blocked.until, why: 'usage limit hit', msg: c.blocked.msg };
  const full = c && c.ok ? c.windows.find((w) => w.pct >= cap && (w.resetSec == null || w.resetSec > 0)) : null;
  if (full) return { out: true, until: full.resetSec != null ? Date.now() + full.resetSec * 1000 : null, why: `${full.label} window ${Math.round(full.pct)}% used`, msg: null };
  return { out: false, until: null, why: null, msg: null };
}

// ── CLAUDE — active 5h block via ccusage (needs network; bunx then npx) ──
export function claudeUsage() {
  let r = run('bunx', ['ccusage@latest', 'blocks', '--active', '--json'], { timeout: 90000 });
  if (!r.ok || !r.stdout.trim()) r = run('npx', ['-y', 'ccusage@latest', 'blocks', '--active', '--json'], { timeout: 90000 });
  if (!r.ok || !r.stdout.trim()) return { ok: false, msg: 'ccusage unavailable (needs network for bunx/npx)' };
  let d; try { d = JSON.parse(r.stdout); } catch { return { ok: false, msg: 'ccusage returned no parseable data' }; }
  const bl = (d.blocks || []).filter((b) => b.isActive);
  if (!bl.length) return { ok: false, msg: 'no active block — idle' };
  const b = bl[0], tc = b.tokenCounts || {}, pr = b.projection || {}, br = b.burnRate || {};
  const tokens = Object.values(tc).filter((v) => typeof v === 'number').reduce((a, c) => a + c, 0);
  return {
    ok: true,
    costUSD: b.costUSD || 0,
    tokens,
    projCost: pr.totalCost || 0,
    projTokens: pr.totalTokens || 0,
    tokensPerMin: br.tokensPerMinute || null,
    remainingMin: pr.remainingMinutes != null ? pr.remainingMinutes : null,
    models: b.models || [],
  };
}

// ── CLAUDE limits — the OFFICIAL utilization % the `/usage` command shows, read
// from the same first-party endpoint with the OAuth token Claude Code stores at
// ~/.claude/.credentials.json (or Windows Credential Manager). Returns 5-hour + 7-day (and per-model 7-day) used%
// with reset times. The token only goes to api.anthropic.com (same as the app),
// is refreshed whenever Claude Code runs, and the call degrades cleanly (offline,
// expired, or — on macOS — creds kept in the Keychain rather than this file). ──
const CLAUDE_CREDS_FILE = path.join(HOME, '.claude', '.credentials.json');
// The file, or Windows Credential Manager where Claude Code keeps the login there (lib/claudelogin.mjs).
function claudeLoginText() {
  const dir = path.dirname(CLAUDE_CREDS_FILE);
  const legacy = path.join(dir, '.config.json');
  let cfgPath = path.join(HOME, '.claude.json');
  try { if (readFileSync(legacy, 'utf8').trim()) cfgPath = legacy; } catch { /* absent */ }
  return loginStore(dir, { cfgPath, viaEnv: false }).read();
}
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export async function claudeLimits() {
  let cred;
  try { cred = JSON.parse(claudeLoginText()).claudeAiOauth; }
  catch { return { ok: false, reason: 'no-creds' }; }   // e.g. macOS Keychain — caller falls back
  const at = cred && cred.accessToken;
  if (!at) return { ok: false, reason: 'no-creds' };
  if (cred.expiresAt && cred.expiresAt <= Date.now()) return { ok: false, reason: 'expired' };
  let res;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${at}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli' },
      signal: AbortSignal.timeout(8000),
    });
  } catch { return { ok: false, reason: 'network' }; }
  if (res.status === 401) return { ok: false, reason: 'expired' };   // token went stale mid-flight
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  let d; try { d = await res.json(); } catch { return { ok: false, reason: 'parse' }; }
  const now = Date.now() / 1000;
  const win = (w) => (w && typeof w.utilization === 'number'
    ? { pct: w.utilization, resetSec: w.resets_at ? Math.round(new Date(w.resets_at).getTime() / 1000 - now) : null }
    : null);
  const ex = d.extra_usage && d.extra_usage.is_enabled ? d.extra_usage : null;
  return {
    ok: true,
    fiveHour: win(d.five_hour),
    sevenDay: win(d.seven_day),
    sevenDayOpus: win(d.seven_day_opus),
    sevenDaySonnet: win(d.seven_day_sonnet),
    extra: ex ? { used: ex.used_credits, limit: ex.monthly_limit, currency: ex.currency || '' } : null,
    plan: cred.subscriptionType || null,
    tier: cred.rateLimitTier || null,
  };
}

// ── AGY — PROACTIVE quota via the CLI's own `/usage` slash command ──
// `agy -p /usage --output-format json` (agy ≥1.4) returns, at zero token cost,
// the real pooled buckets: per group ("Gemini Models" = Flash + Pro, "Claude and
// GPT models", and on paid plans a separate "Gemini 4 Argon" bucket) a weekly
// and a 5-hour `remaining_fraction` + `reset_time`. This replaces the old
// reactive-only 429 log scan (kept below as a fallback for when the CLI is
// offline / not logged in). The dead-end backend RPCs (retrieveUserQuota
// reports legacy buckets; retrieveUserQuotaSummary 403s) stay dead — the slash
// command is the supported surface.
function agyGroupKey(g) {
  const ids = (g.buckets || []).map((b) => String(b.id || '')).join(' ');
  const nm = String(g.name || '');
  if (/argon/i.test(ids + ' ' + nm)) return 'argon';
  if (/(^|\s)3p-/i.test(ids) || /claude|gpt/i.test(ids + ' ' + nm)) return 'claude';
  if (/gemini/i.test(ids + ' ' + nm)) return 'gemini';
  return nm.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
export function agyUsage({ timeout = 30000 } = {}) {
  const r = run('agy', ['-p', '/usage', '--output-format', 'json'], { timeout });
  let env = null;
  if (r.ok && r.stdout.trim()) {
    const ln = r.stdout.trim().split('\n').find((l) => l.startsWith('{'));
    try { env = ln ? JSON.parse(ln) : null; } catch { env = null; }
  }
  const groups = env && env.command && env.command.data && Array.isArray(env.command.data.groups) ? env.command.data.groups : null;
  if (!groups) {
    const fb = agyUsageFromLogs();
    return { ...fb, proactive: false, msg: fb.msg || ((r.stderr || r.stdout || '').trim().split('\n')[0] || 'agy /usage unavailable') };
  }
  const now = Date.now() / 1000;
  const pools = {};
  for (const g of groups) {
    const key = agyGroupKey(g);
    const pool = { name: g.name, note: g.description || '', fiveHour: null, weekly: null };
    for (const b of g.buckets || []) {
      const rem = typeof b.remaining_fraction === 'number' ? b.remaining_fraction : null;
      const w = {
        id: b.id, pct: rem == null ? null : Math.max(0, Math.min(100, (1 - rem) * 100)),
        resetSec: b.reset_time ? Math.round(new Date(b.reset_time).getTime() / 1000 - now) : null,
      };
      if (/weekly/i.test(b.window || b.id)) pool.weekly = w;
      else if (/5h|five/i.test(b.window || b.id)) pool.fiveHour = w;
      else pool[b.id] = w;
    }
    pools[key] = pool;
  }
  const fb = agyUsageFromLogs();
  return { ok: true, proactive: true, pools, email: fb.email || null, loggedIn: true, haveLogs: fb.haveLogs };
}
// Compact per-pool verdict for routing: "exhausted" when any window is ≥ cap.
export function agyPoolState(pool, cap = 99.5) {
  if (!pool) return { exhausted: false, pct: null, resetSec: null };
  const wins = [pool.fiveHour, pool.weekly].filter((w) => w && w.pct != null);
  const worst = wins.sort((a, b) => b.pct - a.pct)[0] || null;
  return worst ? { exhausted: worst.pct >= cap, pct: worst.pct, resetSec: worst.resetSec } : { exhausted: false, pct: null, resetSec: null };
}

// Fallback: reactive status from the 429s AGY logs (~/.gemini/antigravity-cli/log),
// attributed to the Gemini/Claude pool by the active model label preceding each.
const TS = /^[EWIF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const LAB = /label="([^"]+)"/;
// ── pi: a wallet with no quota ──────────────────────────
// pi runs on whatever provider the person configured (typically self-hosted): there is no
// window to fill, so the wallet reads ∞ and what there is to show is spend — today (local
// day) and the last 7 days (today + 6 back, like the usage tracker), off the runner's run
// log. `usd` adds what each run cost: what pi's provider reported, else the tokens at list
// price (`approx`: at least one run was priced that way); a run with no price adds tokens only.
export function piUsage({ now = Date.now(), file = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'multiclaude', 'runs.jsonl') } = {}) {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const d7 = new Date(d0); d7.setDate(d7.getDate() - 6);
  const mk = () => ({ usd: 0, runs: 0, tokens: 0, approx: false });
  const today = mk(), week = mk();
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* no run yet */ }
  for (const line of text.split('\n')) {
    if (!line.includes('"pi"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(r?.ts);
    if (r?.delegate !== 'pi' || !(ts >= d7.getTime())) continue;
    for (const b of ts >= d0.getTime() ? [today, week] : [week]) {
      b.runs++; b.tokens += +r.tokens || 0; b.usd += +r.cost || 0;
      if (r.cost > 0 && r.costKind === 'list') b.approx = true;
    }
  }
  for (const b of [today, week]) b.usd = +b.usd.toFixed(6);
  return { installed: !!which('pi'), unlimited: true, today, d7: week };
}
// "$0.20" / "≈$0.20" — 4 decimals below one cent, like the proof line.
export const usdShort = (b) => `${b.approx ? '≈' : ''}$${b.usd > 0 && b.usd < 0.01 ? b.usd.toFixed(4) : b.usd.toFixed(2)}`;

const RST = /Resets in ([0-9hms]+)/;
function parseReset(s) {
  let sec = 0;
  for (const m of s.matchAll(/(\d+)([hms])/g)) sec += (+m[1]) * ({ h: 3600, m: 60, s: 1 }[m[2]]);
  return sec;
}
export function agyUsageFromLogs() {
  const logdir = path.join(HOME, '.gemini', 'antigravity-cli', 'log');
  let files;
  try { files = readdirSync(logdir).filter((f) => f.endsWith('.log')).map((f) => path.join(logdir, f)); }
  catch { return { ok: false, haveLogs: false, msg: 'no AGY logs yet (run agy / log in)' }; }
  if (!files.length) return { ok: false, haveLogs: false, msg: 'no AGY logs yet (run agy / log in)' };
  files = files.map((p) => ({ p, m: mtimeMs(p) })).sort((a, b) => a.m - b.m).slice(-40).map((x) => x.p);

  const now = Date.now() / 1000, yr = new Date().getFullYear();
  const reset = { gemini: 0, claude: 0 };
  let email = null, loggedIn = false;
  for (const fp of files) {
    let cur = 'gemini', data;
    try { data = readFileSync(fp, 'utf8'); } catch { continue; }
    for (const ln of data.split('\n')) {
      if (ln.includes('authenticated successfully as')) {
        loggedIn = true;
        const m = ln.match(/as (\S+@\S+)/); if (m) email = m[1].replace(/\.$/, '');
      } else if (ln.includes('Propagating selected model override')) {
        const m = ln.match(LAB); if (m) cur = /claude|gpt/i.test(m[1]) ? 'claude' : 'gemini';
      } else if (ln.includes('RESOURCE_EXHAUSTED') && ln.includes('Resets in')) {
        const tm = ln.match(TS), rm = ln.match(RST);
        if (tm && rm) {
          const [, mo, da, hh, mi, ss] = tm;
          let t = new Date(yr, +mo - 1, +da, +hh, +mi, +ss).getTime() / 1000;
          if (t > now + 86400) t = new Date(yr - 1, +mo - 1, +da, +hh, +mi, +ss).getTime() / 1000; // year-boundary
          const rep = t + parseReset(rm[1]);
          if (rep > reset[cur]) reset[cur] = rep;
        }
      }
    }
  }
  const pool = (k) => (reset[k] > now ? { exhausted: true, resetSec: Math.round(reset[k] - now) } : { exhausted: false, resetSec: null });
  return { ok: true, haveLogs: true, loggedIn, email, pools: { gemini: pool('gemini'), claude: pool('claude') } };
}
