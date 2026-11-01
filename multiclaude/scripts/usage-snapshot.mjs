#!/usr/bin/env node
// multiclaude:usage-snapshot — compact, CACHED wallet-headroom line for the hooks
// (SessionStart + PreToolUse on Agent|Task|Workflow). Never blocks a dispatch on
// the network: serves whatever is cached IMMEDIATELY and kicks off a detached
// background refresh when stale. The slow reads are ccusage (Claude block, needs
// network) and `agy -p /usage` (a few seconds); Codex is an instant local file.
// Pure Node, cross-platform, no python3.
//
//   plain text by default;  --hook <EVENT>  wraps the line as additionalContext
//   JSON for that hook event;  --refresh  is the internal background worker.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { stamp, fmtDur } from './lib/mc.mjs';
import { codexUsage, claudeUsage, claudeLimits, agyUsage, agyPoolState } from './lib/wallets.mjs';

const TTL = +(process.env.MULTICLAUDE_USAGE_TTL || 300);
const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'multiclaude');
const cacheFile = path.join(cacheDir, 'usage.txt');
const lockDir = path.join(cacheDir, 'refresh.lock');
try { mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }

const args = process.argv.slice(2);
const hi = args.indexOf('--hook');
const hookEvent = hi >= 0 ? (args[hi + 1] || '') : '';
const isRefresh = args.includes('--refresh');

const reset = (sec) => (sec == null ? '' : sec < 0 ? ' (reset now)' : ` (reset ${fmtDur(sec)})`);

// ── compact one-liners ──────────────────────────────────
// Windows are labelled by their real length (5h / wk) — the CLI logs whichever
// window(s) the plan has, and a Plus plan may show only the weekly one.
function codexCompact() {
  const c = codexUsage();
  if (!c.ok) return `CODEX ${c.msg}`;
  const parts = c.windows.map((w) => `${w.label} ${Math.round(w.pct)}%${reset(w.resetSec)}`);
  let s = 'CODEX ' + (parts.join(' / ') || 'no limits');
  if (c.plan) s += ` / ${c.plan}`;
  return s;
}
// Lead with the OFFICIAL utilization % (the headroom signal that matters for
// routing), same source as /usage; ccusage adds cost/burn detail when available.
async function claudeCompact() {
  const lim = await claudeLimits();
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
async function generate(mode) {
  const c = codexCompact();
  const a = mode === 'full' ? agyCompact() : 'AGY refreshing';
  const cl = mode === 'full' ? await claudeCompact() : 'CLAUDE refreshing';
  return `[multiclaude wallets @ ${stamp()}] ${c} | ${cl} | ${a}. `
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

// ── internal background worker ──────────────────────────
if (isRefresh) {
  try { writeFileSync(cacheFile, (await generate('full')) + '\n'); } catch { /* ignore */ }
  try { rmdirSync(lockDir); } catch { /* ignore */ }
  process.exit(0);
}

// single-flight detached refresh (clear a stale lock first)
function startRefresh() {
  if (existsSync(lockDir) && (Date.now() - mtime(lockDir)) / 1000 > 180) {
    try { rmdirSync(lockDir); } catch { /* ignore */ }
  }
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
if (existsSync(cacheFile) && age <= TTL) {
  emit(readFileSync(cacheFile, 'utf8').trim());            // fresh — nothing slow
} else if (existsSync(cacheFile)) {
  emit(readFileSync(cacheFile, 'utf8').trim() + ' [refreshing]'); // stale — show it, refresh below
  startRefresh();
} else {
  emit(await generate('fast'));                            // cold — Codex now, Claude + AGY next time
  startRefresh();
}
