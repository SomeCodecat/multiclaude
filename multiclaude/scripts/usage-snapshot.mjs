#!/usr/bin/env node
// multiclaude:usage-snapshot — compact, CACHED wallet-headroom line for the hooks
// (SessionStart + PreToolUse on Task|Workflow). Never blocks a dispatch on the
// network: serves whatever is cached IMMEDIATELY and kicks off a detached
// background refresh when stale. The slow read is ccusage (Claude block); Codex
// and AGY are instant local files. Pure Node, cross-platform, no python3.
//
//   plain text by default;  --hook <EVENT>  wraps the line as additionalContext
//   JSON for that hook event;  --refresh  is the internal background worker.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { stamp, fmtDur } from './lib/mc.mjs';
import { codexUsage, claudeUsage, agyUsage } from './lib/wallets.mjs';

const TTL = +(process.env.MULTICLAUDE_USAGE_TTL || 300);
const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'multiclaude');
const cacheFile = path.join(cacheDir, 'usage.txt');
const lockDir = path.join(cacheDir, 'refresh.lock');
try { mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }

const args = process.argv.slice(2);
const hi = args.indexOf('--hook');
const hookEvent = hi >= 0 ? (args[hi + 1] || '') : '';
const isRefresh = args.includes('--refresh');

// ── compact one-liners ──────────────────────────────────
function codexCompact() {
  const c = codexUsage();
  if (!c.ok) return `CODEX ${c.msg}`;
  const parts = [];
  const seg = (b, lab) => {
    if (!b) return;
    const r = b.resetSec != null ? (b.resetSec < 0 ? 'reset now' : `reset ${fmtDur(b.resetSec)}`) : '';
    parts.push(`${lab} ${Math.round(b.pct)}%` + (r ? ` (${r})` : ''));
  };
  seg(c.primary, '5h'); seg(c.secondary, 'wk');
  let s = 'CODEX ' + (parts.join(' / ') || 'no limits');
  if (c.plan) s += ` / ${c.plan}`;
  return s;
}
function claudeCompact() {
  const c = claudeUsage();
  if (!c.ok) return `CLAUDE ${c.msg}`;
  let s = `CLAUDE blk $${c.costUSD.toFixed(2)}`;
  if (c.tokensPerMin) s += c.tokensPerMin >= 1000 ? ` / ${Math.round(c.tokensPerMin / 1000)}k tok/min` : ` / ${Math.round(c.tokensPerMin)} tok/min`;
  if (c.remainingMin != null) s += ` / ${Math.round(c.remainingMin)}m left`;
  if (c.projCost) s += ` / proj $${Math.round(c.projCost)}`;
  return s;
}
// AGY is reactive-only — no usable proactive quota endpoint (see wallets.mjs).
// Status per pool comes from the 429s AGY logs.
function agyCompact() {
  const a = agyUsage();
  if (!a.haveLogs) return 'AGY no logs (reactive)';
  const pool = (name) => {
    const s = a.pools[name];
    return s.exhausted ? `${name} EXHAUSTED (reset ${fmtDur(s.resetSec)})` : `${name} avail`;
  };
  return `AGY ${pool('gemini')} · ${pool('claude')}`;
}
function generate(mode) {
  const c = codexCompact();
  const a = agyCompact();
  const cl = mode === 'full' ? claudeCompact() : 'CLAUDE refreshing';
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
  try { writeFileSync(cacheFile, generate('full') + '\n'); } catch { /* ignore */ }
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
  emit(generate('fast'));                                  // cold — Codex+AGY now, Claude next time
  startRefresh();
}
