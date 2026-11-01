#!/usr/bin/env node
// multiclaude:quota — external-wallet + orchestrator usage at a glance.
//   CODEX  : rate_limits from recent ~/.codex/sessions/**/*.jsonl  (real, local)
//   CLAUDE : official 5h/weekly % (same endpoint as /usage) + ccusage block detail
//   AGY    : `agy -p /usage` — real per-pool 5h + weekly % (gemini / claude / argon)
// Every wallet renders the SAME skeleton (label · bar · pct · status + detail) so
// they read alike. Pure Node, cross-platform, no python3.
import { bar, fmtDur, barLine, dateStamp, nfmt, EMPTY, FULL } from '../../scripts/lib/mc.mjs';
import { codexUsage, claudeUsage, claudeLimits, agyUsage, agyPoolState } from '../../scripts/lib/wallets.mjs';
import { codexCatalog, resolveCodexBands, agyModels, resolveAgyTiers } from '../../scripts/lib/models.mjs';

const RULE = '═'.repeat(56);
const out = [];
const p = (s = '') => out.push(s);
const rs = (sec) => (sec == null ? 'no reset info' : sec < 0 ? 'resets now' : `resets in ${fmtDur(sec)}`);

p(RULE);
p(`  multiclaude quota · ${dateStamp()}`);
p(RULE);

// ── CODEX ──
p(); p('▌ CODEX  (ChatGPT — separate wallet)');
const cx = codexUsage();
if (!cx.ok) {
  p(barLine('limits', EMPTY, 'n/a', cx.msg));
} else {
  if (!cx.windows.length) p(barLine('limits', EMPTY, 'n/a', 'no window snapshot yet'));
  for (const w of cx.windows) {
    const lab = w.label === '5h' ? '5h block' : w.label === 'wk' ? 'weekly' : w.label;
    p(barLine(lab, bar(w.pct), `${w.pct.toFixed(1)}%`, rs(w.resetSec)));
  }
  const det = [];
  if (cx.plan) det.push(`plan ${cx.plan}`);
  if (cx.sessionTokens != null) det.push(`session ${nfmt(cx.sessionTokens)} tok`);
  if (cx.credits && cx.credits.has_credits) det.push(`credits ${cx.credits.unlimited ? 'unlimited' : cx.credits.balance}`);
  if (det.length) p('    ' + det.join('  · '));
}
const cb = resolveCodexBands(codexCatalog());
if (cb.ok) {
  p('    bands (by role off the live catalog — see probe.mjs):');
  for (const k of ['mech', 'std', 'hard', 'max']) if (cb[k]) p(`      ${k.padEnd(4)} ${cb[k].model} @ ${cb[k].effort}`);
}

// ── CLAUDE (orchestrator) ──
// Bars are the OFFICIAL utilization % (same source as Claude Code's /usage):
// 5-hour + weekly used%. ccusage adds cost/tokens/burn as detail. If the limits
// endpoint is unavailable, fall back to the elapsed-time proxy (clearly labelled).
p(); p('▌ CLAUDE  (orchestrator — this wallet)');
const cl = claudeUsage();
const lim = await claudeLimits();
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
// Proactive since agy 1.4: `agy -p /usage --output-format json` returns each
// pool's weekly + 5-hour remaining fraction at zero token cost. Pools: gemini
// (Flash + Pro), claude (Claude Opus/Sonnet + GPT-OSS), argon (Gemini 4 Argon —
// its own bucket on paid plans). Falls back to the reactive 429-log scan.
p(); p('▌ AGY  (Antigravity — gemini / claude / argon pools, separate wallet)');
const ag = agyUsage();
if (ag.proactive) {
  const show = (k, short) => {
    const pl = ag.pools[k]; if (!pl) return;
    for (const [w, wl] of [[pl.fiveHour, `${short} 5h`], [pl.weekly, `${short} wk`]]) {
      if (!w || w.pct == null) continue;
      const st = agyPoolState({ fiveHour: w });
      p(barLine(wl, st.exhausted ? FULL : bar(w.pct), `${Math.round(w.pct)}%`, (st.exhausted ? 'EXHAUSTED · ' : '') + rs(w.resetSec)));
    }
  };
  show('gemini', 'gemini'); show('claude', 'claude'); show('argon', 'argon');
  for (const k of Object.keys(ag.pools)) if (!['gemini', 'claude', 'argon'].includes(k)) show(k, k.slice(0, 6));
  const notes = [];
  if (ag.pools.gemini) notes.push(`gemini = ${ag.pools.gemini.note.replace(/^Models within this group:\s*/i, '')}`);
  if (ag.pools.claude) notes.push(`claude = ${ag.pools.claude.note.replace(/^Models within this group:\s*/i, '')}`);
  if (ag.pools.argon) notes.push('argon = Gemini 4 Argon (separate bucket on paid plans)');
  for (const n of notes) p(`    ${n}`);
} else {
  const poolLine = (name) => {
    if (!ag.haveLogs) { p(barLine(name, EMPTY, 'n/a', ag.msg)); return; }
    const s = ag.pools[name];
    if (s.exhausted) p(barLine(name, FULL, '100%', `exhausted · resets in ${fmtDur(s.resetSec)}`));
    else p(barLine(name, EMPTY, 'n/a', 'available · no active 429'));
  };
  poolLine('gemini'); poolLine('claude');
  p(`    reactive fallback — agy /usage unavailable: ${ag.msg}`);
}
if (ag.email) p(`    account ${ag.email}`);
const tiers = resolveAgyTiers(agyModels());
if (tiers.ok) {
  p('    tiers (bare ID → --model; see probe.mjs):');
  for (const [k, lab] of [['opus', 'opus'], ['sonnet', 'sonnet'], ['gemtop', 'gem-top'], ['gemhi', 'gem-hi'], ['gemmed', 'gem-med'], ['gemlo', 'gem-lo'], ['prohi', 'pro-hi']]) {
    if (tiers[k]) p(`      ${lab.padEnd(7)} ${tiers[k]}`);
  }
} else p('    tiers: agy CLI not found or not authenticated');

console.log(out.join('\n'));
