#!/usr/bin/env node
// multiclaude:usage — external-wallet + orchestrator usage at a glance.
//   CODEX  : rate_limits from newest ~/.codex/sessions/**/*.jsonl   (real, local)
//   CLAUDE : active 5h block via ccusage over ~/.claude/projects    (real, needs net)
//   AGY    : two reactive pools (Gemini + Claude) — status derived from logged 429s
// Every wallet renders the SAME skeleton (label · bar · pct · status + detail) so
// they read alike. Pure Node, cross-platform, no python3.
import { bar, fmtDur, barLine, dateStamp, nfmt, EMPTY, FULL } from '../../scripts/lib/mc.mjs';
import { codexUsage, claudeUsage, agyUsage, agyTiers } from '../../scripts/lib/wallets.mjs';

const RULE = '═'.repeat(56);
const out = [];
const p = (s = '') => out.push(s);

p(RULE);
p(`  multiclaude usage · ${dateStamp()}`);
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
p(); p('▌ CLAUDE  (orchestrator — this wallet, active 5h block)');
const cl = claudeUsage();
if (!cl.ok) {
  p(barLine('5h block', EMPTY, 'n/a', cl.msg));
} else {
  // No fixed quota %; the bar tracks elapsed time through the 5h (300-min) block.
  if (cl.remainingMin != null) {
    const elapsed = Math.max(0, 300 - cl.remainingMin);
    const pct = Math.max(0, Math.min(100, (elapsed / 300) * 100));
    p(barLine('5h block', bar(pct), `${Math.round(pct)}%`, `${fmtDur(cl.remainingMin * 60)} left in block`));
  } else {
    p(barLine('5h block', EMPTY, 'n/a', 'block window unknown'));
  }
  p(`    cost $${cl.costUSD.toFixed(2)}  · proj $${Math.round(cl.projCost)} by block end`);
  p(`    tokens ${nfmt(cl.tokens)}  · proj ${nfmt(cl.projTokens)}` + (cl.tokensPerMin ? `  · ${nfmt(cl.tokensPerMin)} tok/min` : ''));
  if (cl.models.length) p(`    models ${cl.models.join(', ')}`);
}

// ── AGY ──
p(); p('▌ AGY  (Antigravity — Gemini + Claude pools, separate wallet)');
const ag = agyUsage();
if (!ag.haveLogs) {
  p(barLine('gemini', EMPTY, 'n/a', ag.msg));
  p(barLine('claude', EMPTY, 'n/a', ag.msg));
} else {
  for (const pool of ['gemini', 'claude']) {
    const s = ag.pools[pool];
    if (s.exhausted) p(barLine(pool, FULL, '100%', `exhausted · resets in ${fmtDur(s.resetSec)}`));
    else p(barLine(pool, EMPTY, 'n/a', 'available · no active 429'));
  }
  if (ag.email) p(`    account ${ag.email}`);
}
const tiers = agyTiers();
if (tiers.length) { p('    tiers:'); for (const t of tiers.slice(0, 12)) p('      ' + t); }
else p('    tiers: agy CLI not found or not authenticated');
p("    note: AGY exposes no usage %; status is derived from the reactive 429");
p("          in its logs — 'available' ≠ headroom guaranteed (see orchestrate §5).");

console.log(out.join('\n'));
