#!/usr/bin/env node
// multiclaude:usage-snapshot — compact, CACHED wallet-headroom line for the hooks
// (SessionStart + PreToolUse on Agent|Task|Workflow|mcp__multiclaude__dispatch). Never blocks a dispatch on
// the network: serves whatever is cached IMMEDIATELY and kicks off a detached
// background refresh when stale. The slow reads are ccusage (Claude block, needs
// network) and `agy -p /usage` (a few seconds); Codex is an instant local file.
// Pure Node, cross-platform, no python3.
//
//   plain text by default;  --hook <EVENT>  wraps the line as additionalContext
//   JSON for that hook event;  --statusline  prints the wallet rows for a status
//   line (usage bars stretched to the terminal width: Claude on row 1, Codex + AGY
//   on row 2, or on rows 2 and 3 when the terminal is narrow; --row N prints one
//   row, for a ccstatusline custom-command widget per line; --session puts the
//   session line Model | Ctx | branch | changes on top, from the statusLine JSON
//   on stdin);  --refresh  is the internal background worker.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { stamp, fmtDur, inHerdr } from './lib/mc.mjs';
import { codexUsage, codexState, claudeUsage, claudeLimits, agyUsage, agyPoolState, piUsage, usdShort } from './lib/wallets.mjs';
import { refreshPrices } from './lib/prices.mjs';
import { refreshUsage as accountsRefresh, snapshot as accountsSnapshot } from './lib/accounts.mjs';

const TTL = +(process.env.MULTICLAUDE_USAGE_TTL || 300);
const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'multiclaude');
const cacheFile = path.join(cacheDir, 'usage.txt');
const lockDir = path.join(cacheDir, 'refresh.lock');
const factsFile = path.join(cacheDir, 'usage.json');   // raw figures for --statusline
const rowsOffFile = path.join(cacheDir, 'statusline.off');   // present = the wallet rows are switched off (/delegates settings 7)
const facts = {};
try { mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }

const args = process.argv.slice(2);
const hi = args.indexOf('--hook');
const hookEvent = hi >= 0 ? (args[hi + 1] || '') : '';
const isRefresh = args.includes('--refresh');
const isStatusline = args.includes('--statusline');
const isJson = args.includes('--json');   // raw cached figures for the Wallets pane
const isForce = args.includes('--force');   // with --json: refresh NOW and print the new figures (a pane's Refresh)

// --herdr: prints `herdr` when running inside herdr, else `no` (the hooks module asks at session.start).
if (args.includes('--herdr')) { console.log(inHerdr() ? 'herdr' : 'no'); process.exit(0); }

// --wallet-rows on|off: the Delegates settings toggle. Off writes a flag the status-line
// modes honour (the rows print nothing; a --session line still shows); on removes it.
const wr = args.indexOf('--wallet-rows');
if (wr >= 0) {
  const on = args[wr + 1] !== 'off';
  try { if (on) rmSync(rowsOffFile, { force: true }); else writeFileSync(rowsOffFile, new Date().toISOString() + '\n'); } catch { /* ignore */ }
  console.log(on ? 'wallet rows on' : 'wallet rows off');
  process.exit(0);
}

const reset = (sec) => (sec == null ? '' : sec < 0 ? ' (reset now)' : ` (reset ${fmtDur(sec)})`);

// ── compact one-liners ──────────────────────────────────
// Windows are labelled by their real length (5h / wk) — the CLI logs whichever
// window(s) the plan has, and a Plus plan may show only the weekly one.
function codexCompact() {
  const c = codexUsage();
  const st = codexState(c);
  facts.codex = c.ok || st.out ? { windows: (c.windows || []).map((w) => ({ label: w.label, pct: w.pct, reset: w.resetSec != null ? Date.now() + w.resetSec * 1000 : null })), exhausted: st.out, until: st.until } : null;
  // Out of quota: say so first — a refused run logs no new window %, so the figures alone would read as headroom.
  const out = st.out ? `EXHAUSTED${st.until ? reset(Math.round((st.until - Date.now()) / 1000)) : ''}` : '';
  if (!c.ok) return `CODEX ${out ? out + ' — do not dispatch Codex' : c.msg}`;
  const parts = c.windows.map((w) => `${w.label} ${Math.round(w.pct)}%${reset(w.resetSec)}`);
  let s = 'CODEX ' + (out || parts.join(' / ') || 'no limits');
  if (c.plan) s += ` / ${c.plan}`;
  if (out) s += ' — do not dispatch Codex';
  return s;
}
// Lead with the OFFICIAL utilization % (the headroom signal that matters for
// routing), same source as /usage; ccusage adds cost/burn detail when available.
// Several stored Claude accounts are ONE wallet (scripts/lib/accounts.mjs): the
// line shows the pool's mean used % per window, plus the active account, since
// auto-switch moves work between accounts before any one of them hits its line.
async function claudePoolCompact() {
  let s;
  try { await accountsRefresh(); s = accountsSnapshot(); } catch { return null; }
  if (!s || s.accounts.length < 2 || !s.pool) return null;
  const p = s.pool, a = s.accounts.find((x) => x.active);
  facts.claude = { pool: p.accounts, fiveHour: p.fiveHour, sevenDay: p.sevenDay, fiveHourReset: p.fiveHourReset, sevenDayReset: p.sevenDayReset, active: a ? a.slot : null, auto: !!s.config.auto.enabled };
  const r5 = p.fiveHourReset ? reset(Math.round((p.fiveHourReset - Date.now()) / 1000)) : '';
  const act = a && a.usage ? ` · active #${a.slot} 5h ${Math.round(a.usage.fiveHour?.pct ?? 0)}%/wk ${Math.round(a.usage.sevenDay?.pct ?? 0)}%` : '';
  return `CLAUDE pool of ${p.accounts} acct 5h ${Math.round(p.fiveHour ?? 0)}%${r5} / wk ${Math.round(p.sevenDay ?? 0)}%${act}${s.config.auto.enabled ? ' · auto-switch on' : ''}`;
}
async function claudeCompact() {
  const pooled = await claudePoolCompact();
  if (pooled) return pooled;
  const lim = await claudeLimits();
  if (lim.ok) facts.claude = { pool: 1, fiveHour: lim.fiveHour?.pct, sevenDay: lim.sevenDay?.pct, fiveHourReset: lim.fiveHour?.resetSec != null ? Date.now() + lim.fiveHour.resetSec * 1000 : null, sevenDayReset: lim.sevenDay?.resetSec != null ? Date.now() + lim.sevenDay.resetSec * 1000 : null };
  const c = claudeUsage();
  const parts = [];
  if (lim.ok) {
    if (lim.fiveHour) parts.push(`5h ${Math.round(lim.fiveHour.pct)}%${reset(lim.fiveHour.resetSec)}`);
    if (lim.sevenDay) parts.push(`wk ${Math.round(lim.sevenDay.pct)}%`);
    const pm = [];
    if (lim.sevenDayOpus) pm.push(`opus ${Math.round(lim.sevenDayOpus.pct)}%`);
    if (lim.sevenDaySonnet) pm.push(`sonnet ${Math.round(lim.sevenDaySonnet.pct)}%`);
    if (pm.length) parts.push(`wk by model ${pm.join('/')}`);
  }
  if (c.ok) {
    parts.push(`blk $${c.costUSD.toFixed(2)}`);
    if (c.tokensPerMin) parts.push(c.tokensPerMin >= 1000 ? `${Math.round(c.tokensPerMin / 1000)}k tok/min` : `${Math.round(c.tokensPerMin)} tok/min`);
  }
  if (!parts.length) return `CLAUDE ${lim.ok ? 'no limit data' : (c.ok ? 'ok' : c.msg)}`;
  return 'CLAUDE ' + parts.join(' / ');
}
// AGY — PROACTIVE since agy 1.4: `agy -p /usage` reports each pool's 5h + weekly
// used %. Three pools: gemini (Flash + Pro), claude (Claude Opus/Sonnet + GPT-OSS)
// and, on paid plans, a separate argon bucket (Gemini 4 Argon). Falls back to the
// reactive 429-log status when the CLI is offline / not logged in.
function agyCompact() {
  const a = agyUsage();
  const at = (w) => (w && w.resetSec != null ? Date.now() + w.resetSec * 1000 : null);
  facts.agy = a.proactive ? Object.fromEntries(Object.entries(a.pools).map(([k, p]) => [k, { fiveHour: p.fiveHour?.pct ?? null, weekly: p.weekly?.pct ?? null, fiveHourReset: at(p.fiveHour), weeklyReset: at(p.weekly), exhausted: agyPoolState(p).exhausted }])) : null;
  if (!a.proactive) {
    if (!a.haveLogs) return `AGY ${a.msg || 'no data'} (reactive)`;
    const pool = (name) => { const s = a.pools[name]; return s.exhausted ? `${name} EXHAUSTED${reset(s.resetSec)}` : `${name} avail`; };
    return `AGY ${pool('gemini')} · ${pool('claude')} (reactive — /usage unavailable: ${a.msg})`;
  }
  const seg = (k) => {
    const p = a.pools[k]; if (!p) return null;
    const parts = [];
    if (p.fiveHour && p.fiveHour.pct != null) parts.push(`5h ${Math.round(p.fiveHour.pct)}%`);
    if (p.weekly && p.weekly.pct != null) parts.push(`wk ${Math.round(p.weekly.pct)}%`);
    const st = agyPoolState(p);
    return `${k} ${parts.join('/') || 'n/a'}${st.exhausted ? ` EXHAUSTED${reset(st.resetSec)}` : ''}`;
  };
  return 'AGY ' + [seg('gemini'), seg('claude'), seg('argon')].filter(Boolean).join(' · ');
}
// pi: no quota to show — an unlimited wallet with its spend. Only when pi is installed or
// has run this week; the line says trial, so "headroom" never routes work to it (§10).
function piCompact() {
  const p = piUsage();
  facts.pi = p;
  if (!p.installed && !p.d7.runs) return '';
  return ` | PI no quota · ${usdShort(p.today)} today / ${usdShort(p.d7)} 7d (${p.d7.runs} run${p.d7.runs === 1 ? '' : 's'}) — trial, orchestrate §10 only: unlimited is not a reason to route there`;
}
async function generate(mode) {
  const c = codexCompact();
  const pi = piCompact();
  const a = mode === 'full' ? agyCompact() : 'AGY refreshing';
  const cl = mode === 'full' ? await claudeCompact() : 'CLAUDE refreshing';
  // Every % on the line is USED (agy's own /usage prints REMAINING — opposite).
  return `[multiclaude wallets @ ${stamp()} · all % = USED] ${c} | ${cl} | ${a}${pi}. `
    + 'Bias dispatch to the wallet with headroom; do not start work a 5h or weekly '
    + 'window cannot finish before its reset (orchestrate §5).';
}

function emit(text) {
  if (hookEvent) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: hookEvent, additionalContext: text },
      suppressOutput: true,
    }));
  } else {
    console.log(text);
  }
}

function mtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

async function writeSnapshot() {
  try { writeFileSync(cacheFile, (await generate('full')) + '\n'); } catch { /* ignore */ }
  try { writeFileSync(factsFile, JSON.stringify({ at: Date.now(), ...facts }) + '\n'); } catch { /* ignore */ }
}

// ── internal background worker ──────────────────────────
if (isRefresh) {
  await writeSnapshot();
  try { rmdirSync(lockDir); } catch { /* ignore */ }
  // The runner prices a run off the cached list-price table (cost≈$… on the proof line); keep it
  // at most a day old here too, so that works without the usage tracker ever having run.
  try { await refreshPrices(); } catch { /* offline: the old table stays */ }
  process.exit(0);
}

function clearStaleLock() {
  if (existsSync(lockDir) && (Date.now() - mtime(lockDir)) / 1000 > 180) {
    try { rmdirSync(lockDir); } catch { /* ignore */ }
  }
}
// single-flight detached refresh (clear a stale lock first)
function startRefresh() {
  clearStaleLock();
  try { mkdirSync(lockDir); } catch { return; }   // another refresh already running
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch {
    try { rmdirSync(lockDir); } catch { /* ignore */ }
  }
}

// ── serve cache, refresh in background ──────────────────
const age = existsSync(cacheFile) ? (Date.now() - mtime(cacheFile)) / 1000 : Infinity;

// Wallets pane: the cached figures as JSON (+ ageSec, ttlSec); never the network,
// a stale cache refreshes in the background.
if (isJson) {
  // --force (a pane's Refresh): plain --json only serves the cache and refreshes it in the
  // background, so the pane kept its old figures until a later poll. Refresh in this process
  // instead; if a refresh is already running, wait for it (up to 120 s) and serve its result.
  if (isForce) {
    clearStaleLock();
    let mine = false;
    try { mkdirSync(lockDir); mine = true; } catch { /* another refresh is running */ }
    if (mine) {
      try { await writeSnapshot(); } finally { try { rmdirSync(lockDir); } catch { /* ignore */ } }
    } else {
      const until = Date.now() + 120_000;
      while (existsSync(lockDir) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    }
  }
  let f = null;
  try { f = JSON.parse(readFileSync(factsFile, 'utf8')); } catch { /* cold */ }
  const fAge = f ? Math.round((Date.now() - f.at) / 1000) : null;
  console.log(JSON.stringify({ ...(f || {}), ageSec: fAge, ttlSec: TTL }));
  if (!isForce && (!f || age > TTL || fAge > TTL)) startRefresh();
  process.exit(0);
}

// Status-line widget (our own; usable as a statusLine command or a custom-command widget): the wallet
// line — one bar per metered window, stretched to the terminal width — from the cache, never the
// network; a stale cache refreshes in the background. The width comes from the statusLine JSON on
// stdin (ccstatusline forwards it to custom-command widgets, with terminal_width), else the tty.
// --session adds the session line above it (the launcher passes it; a widget must not, or the
// ccstatusline line above would be drawn twice).
if (isStatusline) {
  let f = null;
  try { f = JSON.parse(readFileSync(factsFile, 'utf8')); } catch { /* cold */ }
  const fAge = f ? (Date.now() - f.at) / 1000 : Infinity;
  let j = null;
  try { if (!process.stdin.isTTY) j = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no JSON on stdin */ }
  if (!j || typeof j !== 'object') j = null;
  // ccstatusline passes terminal_width and keeps ~6 columns for itself; Claude Code's own statusLine passes none.
  const width = +(j?.terminal_width || process.stdout.columns || process.env.COLUMNS || 120);
  const W = Math.max(24, width - 6);
  // 256-colour palette borrowed from ccstatusline (docs/references.md): provider labels cyan, separators grey,
  // every window / pool name in its own colour, the bar and the % in the usage tone (green → yellow → red).
  const c = (n, t) => `\x1b[38;5;${n}m${t}\x1b[39m`;
  const label = (t) => c(30, t), dim = (t) => c(59, t), sep = dim(' | '), gap = '  ';
  const NAME = { claude: 74, codex: 114, gem: 69, cl: 173, arg: 141, pi: 210 };   // pi: 210 = the 256-colour cell nearest its logo coral #f09082
  const tone = (v) => (v >= 85 ? 167 : v >= 60 ? 178 : 71);
  const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  // Timers, no word: a 5h window counts down (29m); a weekly one names the weekday and hour it resets (Fri 14:00).
  const at = (ms) => { const d = new Date(ms); return `${d.toLocaleDateString('en', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const when = (name, ms) => (!ms || ms <= Date.now() ? '' : dim(' ' + (/h$/.test(name) ? fmtDur((ms - Date.now()) / 1000) : at(ms))));
  // One metric = name + bar + % (+ timer). The bar width is chosen per row so that the row fills W.
  const metric = (bw, color, name, v, { out = false, after = '' } = {}) => {
    if (v == null && !out) return `${c(color, name)} ${dim('–')}${after}`;
    const p = out ? 100 : Math.max(0, Math.min(100, v)), n = Math.round((p / 100) * bw);
    const bar = bw > 0 ? c(color, '█'.repeat(n)) + dim('░'.repeat(bw - n)) + ' ' : '';   // the bar in the name's colour, the % in the usage tone
    return `${c(color, name)} ${bar}${c(tone(p), out ? 'out' : `${Math.round(p)}%`)}${after}`;
  };
  // Each segment: { build(bw) → text, bars } — the bar count sizes the row.
  const segs = {};
  if (f?.claude) {
    const k = f.claude;
    const who = k.pool > 1 ? dim(`${gap}#${k.active ?? '?'}/${k.pool}${k.auto ? ' auto' : ''}`) : '';
    segs.claude = { bars: 2, build: (bw) => `${label('Claude')} ${metric(bw, NAME.claude, '5h', k.fiveHour, { after: when('5h', k.fiveHourReset) })}${gap}${metric(bw, NAME.claude, 'wk', k.sevenDay, { after: when('wk', k.sevenDayReset) })}${who}` };
  }
  if (f?.codex?.windows?.length) {
    const ws = f.codex.windows;
    segs.codex = { bars: ws.length, build: (bw) => `${label('Codex')} ${ws.map((w) => metric(bw, NAME.codex, w.label, w.pct, { out: !!f.codex.exhausted && w.pct >= 99.5, after: when(w.label, w.reset) })).join(gap)}` };
  } else if (f?.codex?.exhausted) {
    segs.codex = { bars: 1, build: (bw) => `${label('Codex')} ${metric(bw, NAME.codex, 'quota', 100, { out: true, after: f.codex.until ? when('wk', f.codex.until) : '' })}` };
  }
  if (f?.agy && Object.keys(f.agy).length) {
    const short = { gemini: 'gem', claude: 'cl', argon: 'arg' };
    const pools = Object.entries(f.agy);
    segs.agy = { bars: pools.length, build: (bw) => `${label('Antigravity')} ${pools.map(([k, p]) => { const n = short[k] || k; const wk = (p.weekly ?? 0) >= (p.fiveHour ?? 0); return metric(bw, NAME[n] || 59, n, Math.max(p.fiveHour ?? 0, p.weekly ?? 0), { out: !!p.exhausted, after: when(wk ? 'wk' : '5h', wk ? p.weeklyReset : p.fiveHourReset) }); }).join(gap)}` };
  }
  // pi has no window, so no bar: ∞ and the spend, longest form that fits (see below).
  const piForms = [];
  if (f?.pi && (f.pi.installed || f.pi.d7?.runs)) {
    const inf = `${label('pi')} ${c(NAME.pi, '∞')}`, t = f.pi.today || { usd: 0 }, w = f.pi.d7 || { usd: 0 };
    piForms.push(`${inf} ${c(NAME.pi, usdShort(t))}${dim(' today · ')}${c(NAME.pi, usdShort(w))}${dim(' 7d')}`, `${inf} ${c(NAME.pi, usdShort(t))}`, inf);
  }
  const join = (...xs) => ({ bars: xs.reduce((n, x) => n + x.bars, 0), build: (bw) => xs.map((x) => x.build(bw)).join(sep) });
  // Stretch a segment to W: every bar adds bw + 1 columns; below 3 cells a bar says nothing, so it goes.
  const fit = (x) => {
    const fixed = visible(x.build(0));
    const bw = x.bars ? Math.min(40, Math.floor((W - fixed) / x.bars) - 1) : 0;
    return x.build(bw >= 3 ? bw : 0);
  };
  const fits = (x, bw) => visible(x.build(0)) + x.bars * (bw + 1) <= W;
  // Rows: Claude + Codex on top, Antigravity on its own row below. When the top row has no
  // room for 3-cell bars Codex takes a row of its own, so a narrow terminal gets one per provider.
  const rows = [];
  // Off when switched off in /delegates settings, or inside herdr (its own panels show the wallets;
  // lib/mc.mjs inHerdr). MULTICLAUDE_WALLET_ROWS=on|off overrides both.
  const force = (process.env.MULTICLAUDE_WALLET_ROWS || '').toLowerCase();
  const rowsOff = force === 'on' ? false : force === 'off' ? true : inHerdr() || existsSync(rowsOffFile);   // no rows, no refresh
  if (rowsOff) { /* nothing */ }
  else {
    const top = [segs.claude, segs.codex].filter(Boolean), specs = [];
    if (top.length === 2 && fits(join(...top), 3)) specs.push(join(...top));
    else specs.push(...top);
    if (segs.agy) specs.push(segs.agy);
    // pi rides at the end of the last row (ccstatusline has a widget per row, three of them): the
    // longest form that leaves the row 8-cell bars, else the longest that leaves it 3-cell ones,
    // or nothing on a terminal too narrow for any.
    if (piForms.length) {
      const last = specs[specs.length - 1], forms = piForms.map((t) => ({ bars: 0, build: () => t }));
      const form = last ? [8, 3].map((bw) => forms.find((x) => fits(join(last, x), bw))).find(Boolean) : forms.find((x) => fits(x, 0));
      if (form) specs.splice(Math.max(0, specs.length - 1), 1, last ? join(last, form) : form);
    }
    rows.push(...specs.map(fit));
    if (!rows.length) rows.push(dim('multiclaude wallets: refreshing…'));
    else if (fAge > TTL) rows[rows.length - 1] += dim(`${gap}${fAge < 5400 ? Math.round(fAge / 60) + 'm' : Math.round(fAge / 3600) + 'h'} old`);
  }
  const ri = args.indexOf('--row'), row = ri >= 0 ? +args[ri + 1] : 0;
  if (row > 0) { if (rows[row - 1]) console.log(rows[row - 1]); }
  else {
    const session = args.includes('--session') && j ? sessionLine(j, sep) : '';
    const lines = session ? [session, ...rows] : rows;
    if (lines.length) console.log(lines.join('\n'));
  }
  if (!rowsOff && (!f || age > TTL || fAge > TTL)) startRefresh();
  process.exit(0);
}
// The session line in ccstatusline's design (docs/references.md), from the statusLine JSON:
// Model: … | Ctx: … | branch | (+ins,-del), its default widget colours, no branch icon.
function sessionLine(j, sep) {
  const a = (n, t) => `\x1b[${n}m${t}\x1b[39m`;   // ccstatusline's widget colours: cyan / brightBlack / magenta / yellow
  const parts = [];
  const model = j.model?.display_name || j.model?.id;
  if (model) parts.push(a(36, `Model: ${model}`));
  const n = j.context_window?.total_input_tokens;
  if (n != null) parts.push(a(90, `Ctx: ${n >= 999950 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)}`));
  const cwd = j.workspace?.current_dir || j.cwd || process.cwd();
  const git = (...args) => {
    try {
      const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500, windowsHide: true });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch { return null; }
  };
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch) {
    parts.push(a(35, branch === 'HEAD' ? (git('rev-parse', '--short', 'HEAD') || 'HEAD') : branch));
    const stat = git('diff', 'HEAD', '--shortstat') || '';
    const ins = +(stat.match(/(\d+) insertion/) || [])[1] || 0, del = +(stat.match(/(\d+) deletion/) || [])[1] || 0;
    parts.push(a(33, `(+${ins},-${del})`));
  }
  return parts.join(sep);
}

if (existsSync(cacheFile) && age <= TTL) {
  emit(readFileSync(cacheFile, 'utf8').trim());            // fresh — nothing slow
} else if (existsSync(cacheFile)) {
  // stale — show it with its age, refresh below
  emit(readFileSync(cacheFile, 'utf8').trim() + ` [snapshot ${age < 5400 ? Math.round(age / 60) + ' min' : Math.round(age / 3600) + ' h'} old — refreshing]`);
  startRefresh();
} else {
  emit(await generate('fast'));                            // cold — Codex now, Claude + AGY next time
  startRefresh();
}
