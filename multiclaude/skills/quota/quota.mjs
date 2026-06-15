#!/usr/bin/env node
// multiclaude:quota — external-wallet + orchestrator usage at a glance.
//   CODEX  : rate_limits from newest ~/.codex/sessions/**/*.jsonl   (real, local)
//   CLAUDE : active 5h block via ccusage over ~/.claude/projects    (real, needs net)
//   AGY    : two reactive pools (Gemini + Claude) — status derived from logged 429s
// Every wallet renders the SAME skeleton (label · bar · pct · status + detail) so
// they read alike. Pure Node, cross-platform, no python3.
import { bar, fmtDur, barLine, dateStamp, nfmt, EMPTY, FULL } from '../../scripts/lib/mc.mjs';
import { codexUsage, claudeUsage, claudeLimits, agyUsage, agyTiers } from '../../scripts/lib/wallets.mjs';

const RULE = '═'.repeat(56);
const out = [];
const p = (s = '') => out.push(s);

p(RULE);
p(`  multiclaude quota · ${dateStamp()}`);
p(RULE);

// ── CODEX ──
p(); p('▌ CODEX  (ChatGPT — separate wallet)');
const cx = codexUsage();
if (!cx.ok) {
  p(barLine('5h block', EMPTY, 'n/a', cx.msg));
} else {
  const rs = (sec) => (sec == null ? 'no reset info' : sec < 0 ? 'resets now' : `resets in ${fmtDur(sec)}`);
  for (const [b, lab] of [[cx.primary, '5h block'], [cx.secondary, 'weekly']]) {
    if (!b) { p(barLine(lab, EMPTY, 'n/a', 'no snapshot')); continue; }
    p(barLine(lab, bar(b.pct), `${b.pct.toFixed(1)}%`, rs(b.resetSec)));
  }
  const det = [];
  if (cx.plan) det.push(`plan ${cx.plan}`);
  if (cx.sessionTokens != null) det.push(`session ${nfmt(cx.sessionTokens)} tok`);
  if (det.length) p('    ' + det.join('  · '));
}

// ── CLAUDE (orchestrator) ──
// Bars are the OFFICIAL utilization % (same source as Claude Code's /usage):
// 5-hour + weekly used%. ccusage adds cost/tokens/burn as detail. If the limits
// endpoint is unavailable, fall back to the elapsed-time proxy (clearly labelled).
p(); p('▌ CLAUDE  (orchestrator — this wallet)');
const cl = claudeUsage();
const lim = await claudeLimits();
const rs = (sec) => (sec == null ? 'no reset info' : sec < 0 ? 'resets now' : `resets in ${fmtDur(sec)}`);
if (lim.ok) {
  for (const [w, lab] of [[lim.fiveHour, '5h limit'], [lim.sevenDay, 'weekly']]) {
    if (!w) { p(barLine(lab, EMPTY, 'n/a', 'no data')); continue; }
    p(barLine(lab, bar(w.pct), `${Math.round(w.pct)}%`, rs(w.resetSec)));
  }
  const sub = [];
  if (lim.sevenDayOpus) sub.push(`opus wk ${Math.round(lim.sevenDayOpus.pct)}%`);
  if (lim.sevenDaySonnet) sub.push(`sonnet wk ${Math.round(lim.sevenDaySonnet.pct)}%`);
  if (lim.plan) sub.push(`plan ${lim.plan}`);
  if (lim.extra) sub.push(`extra ${lim.extra.used}/${lim.extra.limit} ${lim.extra.currency}`);
  if (sub.length) p('    ' + sub.join('  · '));
} else if (cl.ok && cl.remainingMin != null) {
  const elapsed = Math.max(0, 300 - cl.remainingMin);
  const pct = Math.max(0, Math.min(100, (elapsed / 300) * 100));
  p(barLine('5h block', bar(pct), `${Math.round(pct)}%`, `${fmtDur(cl.remainingMin * 60)} left — elapsed time, not quota (limits ${lim.reason})`));
} else {
  p(barLine('5h limit', EMPTY, 'n/a', lim.reason === 'no-creds' ? 'creds not in file (macOS Keychain?)' : `limits ${lim.reason}`));
}
if (cl.ok) {
  p(`    cost $${cl.costUSD.toFixed(2)}  · proj $${Math.round(cl.projCost)} by block end`);
  p(`    tokens ${nfmt(cl.tokens)}  · proj ${nfmt(cl.projTokens)}` + (cl.tokensPerMin ? `  · ${nfmt(cl.tokensPerMin)} tok/min` : ''));
  if (cl.models.length) p(`    models ${cl.models.join(', ')}`);
} else {
  p(`    detail: ${cl.msg}`);
}

// ── AGY ──
// Reactive-only: AGY exposes no usable proactive quota (retrieveUserQuota reports
// the wrong/legacy buckets; the lineup-accurate retrieveUserQuotaSummary is
// LS-only / 403). Status is derived from the 429s AGY logs, per pool.
p(); p('▌ AGY  (Antigravity — Gemini + Claude pools, separate wallet)');
const ag = agyUsage();
const poolLine = (name) => {
  if (!ag.haveLogs) { p(barLine(name, EMPTY, 'n/a', ag.msg)); return; }
  const s = ag.pools[name];
  if (s.exhausted) p(barLine(name, FULL, '100%', `exhausted · resets in ${fmtDur(s.resetSec)}`));
  else p(barLine(name, EMPTY, 'n/a', 'available · no active 429'));
};
poolLine('gemini');
poolLine('claude');
if (ag.email) p(`    account ${ag.email}`);
const tiers = agyTiers();
if (tiers.length) { p('    tiers:'); for (const t of tiers.slice(0, 12)) p('      ' + t); }
else p('    tiers: agy CLI not found or not authenticated');
p("    note: AGY exposes no usage %; status is derived from the reactive 429");
p("          in its logs — 'available' ≠ headroom guaranteed (see orchestrate §5).");

console.log(out.join('\n'));
