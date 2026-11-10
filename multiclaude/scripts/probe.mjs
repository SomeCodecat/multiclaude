#!/usr/bin/env node
// multiclaude:probe — does all of orchestrate §0 (session setup) MECHANICALLY and
// emits one block the orchestrator reads, instead of the model running a handful
// of availability/tier/health commands and interpreting them itself.
//
//   0.1 opt-out      — 'orchestrate: off' in the project CLAUDE.md
//   0.2 availability — codex / agy CLIs (+ the optional companion plugins)
//   0.3 bands        — Codex bands (mech/std/hard/max) resolved by ROLE off the
//                      live catalog; AGY tiers resolved by family + version +
//                      effort off `agy models`. Bare ids only — a display name
//                      (or a whole `id<TAB>name` row) passed to `agy --model`
//                      makes agy print its picker and exit 0 WITHOUT running.
//   0.2 health       — round-trip each CLI through dispatch.mjs; ONLY with
//                      --smoke (costs a little external quota, so off by default)
//
// Pure Node, cross-platform, no python3. Re-run per session; cache in context.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, which, run, stamp } from './lib/mc.mjs';
import { codexCatalog, resolveCodexBands, agyModels, resolveAgyTiers, piModels, resolvePiBands } from './lib/models.mjs';
import { summarize } from './scorecard.mjs';
import { codexState } from './lib/wallets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.slice(2).includes('--smoke');
const out = [];
const p = (s) => out.push(s);
const done = () => { console.log(out.join('\n')); process.exit(0); };

p(`[multiclaude probe @ ${stamp()}]`);

// ── 0.1 per-project opt-out ──
let optout = false;
const candidates = [path.join(process.cwd(), 'CLAUDE.md')];
if (process.env.CLAUDE_PROJECT_DIR) candidates.push(path.join(process.env.CLAUDE_PROJECT_DIR, 'CLAUDE.md'));
for (const f of candidates) {
  try { if (/^\s*orchestrate:\s*off(\s|$)/im.test(readFileSync(f, 'utf8'))) optout = true; } catch { /* ignore */ }
}
if (optout) {
  p('  orchestrate: OFF — project opted out via CLAUDE.md; tell the user once, work normally (skip §1–§10).');
  done();
}
p('  orchestrate: ON');

// ── 0.2 availability (CLIs + plugins) ──
const codexOk = !!which('codex');
const agyOk = !!which('agy');
// A present Codex whose plan is shut fails every run in ~2 s with QUOTA — the
// orchestrator must not pick it at all (dispatch.mjs refuses it too).
let codexOut = null;
if (codexOk) { try { const st = codexState(); if (st.out) codexOut = st; } catch { /* no data */ } }
const untilTxt = (t) => (t ? ` until ${new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '');
p(codexOk ? (codexOut ? `  codex: present — QUOTA EXHAUSTED (${codexOut.why}${untilTxt(codexOut.until)}) — do NOT dispatch Codex; route Codex-shaped work to AGY (§5)` : '  codex: present')
  : '  codex: MISSING — install: curl -fsSL https://chatgpt.com/codex/install.sh | sh   then: codex login');
p(agyOk ? '  agy:   present'
  : '  agy:   MISSING — install: curl -fsSL https://antigravity.google/cli/install.sh | bash   then authenticate');
// pi is optional (a self-hosted model through the pi harness): shown only when installed.
const piOk = !!which('pi');
if (piOk) p('  pi:    present — TRIAL delegate (self-hosted model; coding tasks only, every run judged and graded: orchestrate §10)');

let sp = 'off';
let cm = 'off';
try {
  const s = readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8');
  if (s.includes('superpowers@')) sp = 'enabled';
  if (s.includes('claude-mem@')) cm = 'enabled';
} catch { /* ignore */ }
p(`  companions (optional): superpowers=${sp} · claude-mem=${cm}`);

// ── 0.3 Codex bands (by ROLE off the live catalog — never hardcoded) ──
let cb = { ok: false };
if (codexOk) {
  cb = resolveCodexBands(codexCatalog());
  if (!cb.ok) {
    p(`  codex bands: ${cb.msg} — dispatch with no --model (CLI default) this session`);
  } else {
    p('  codex bands — dispatch: node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" codex --model <id> --effort <e>');
    const row = (k, lab, note) => { const b = cb[k]; p(`    ${lab} = ${b ? `${b.model} @ ${b.effort}   // ${b.why}` : '— none'}${note ? '   ' + note : ''}`); };
    row('mech', 'mech', '(boilerplate, renames, config/doc edits, small clearly-specced fixes)');
    row('std', 'std ', '(features, ordinary bug fixes, refactors, tests — the default)');
    row('hard', 'hard', '(complex refactors, tricky bugs, architecture, security-sensitive)');
    row('max', 'max ', '(escalation ONLY: a hard-band task that failed a §3 gate)');
    if (cb.hardFallback && cb.hard && cb.hardFallback.model !== cb.hard.model) p(`    hard-fallback = ${cb.hardFallback.model} @ ${cb.hardFallback.effort}   (if the hard model is rejected: account gating / old CLI)`);
    if (cb.unbanded.length) p(`    unbanded: ${cb.unbanded.map((m) => `${m.slug} ("${m.why}")`).join('; ')} — no role in the catalog text; leave unused`);
    if (cb.stale.length) p(`    stale (skip): ${cb.stale.join(', ')}`);
    const v = (run('codex', ['--version'], { timeout: 15000 }).stdout || '').match(/\d+\.\d+\.\d+/);
    if (v && cb.clientVersion && v[0] !== cb.clientVersion) p(`    note: codex CLI ${v[0]} vs catalog client ${cb.clientVersion} — run \`codex update\` if a band model is rejected`);
  }
}

// ── 0.3 AGY tiers (family + version + effort aware — never hardcoded) ──
let tiers = { ok: false };
if (agyOk) {
  const rows = agyModels({ cache: false });
  if (rows.length) {
    tiers = resolveAgyTiers(rows);
    p('  agy tiers — dispatch: node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" agy --model <id> [--edit]');
    p('  (bare ID verbatim; the name after // is for attribution only)');
    const row = (label, key, fallback, note) => {
      const id = tiers[key];
      if (!id) return p(`    ${label} = — none${fallback ? ' (step down to ' + fallback + ')' : ''}`);
      p(`    ${label} = ${id}${tiers.names[key] && tiers.names[key] !== id ? '   // ' + tiers.names[key] : ''}${note ? '   ' + note : ''}`);
    };
    row('opus   ', 'opus', 'sonnet', '(hardest reasoning — would use own Opus)');
    row('sonnet ', 'sonnet', 'gem-hi', '(heavy reasoning — would use own Sonnet)');
    row('gem-top', 'gemtop', 'gem-hi', '(newest Gemini family; separate quota bucket on paid plans)');
    row('gem-hi ', 'gemhi', 'gem-med', '(hard review / research / architecture)');
    row('gem-med', 'gemmed', 'gem-lo', '(review, research, analysis, docs — the default)');
    row('gem-lo ', 'gemlo', '', '(mechanical scans, summaries)');
    if (tiers.prohi) row('pro-hi ', 'prohi', '', '');
  } else {
    p("  agy tiers: 'agy models' returned nothing — not authenticated or offline; treat AGY as unavailable this session");
  }
}

// ── 0.3 pi bands (the effort variants of pi's default model — never hardcoded) ──
let pb = { ok: false };
if (piOk) {
  const rows = piModels({ cache: false });
  pb = resolvePiBands(rows);
  if (!pb.ok) {
    p("  pi bands: 'pi --list-models' returned nothing — not logged in or offline; treat pi as unavailable this session");
  } else {
    p('  pi bands — dispatch({ delegate: "pi", model: <id>, edit: true })   (no effort: it is part of the id)');
    const same = pb.lo === pb.med && pb.med === pb.hi;
    if (same) p(`    lo = med = hi = ${pb.med}   (one model, no effort variants)`);
    else {
      p(`    lo  = ${pb.lo}   (mechanical edits, renames, small clearly-specced fixes)`);
      p(`    med = ${pb.med}   (one-file features and bug fixes with a test to run — the default)`);
      p(`    hi  = ${pb.hi}   (the same model at its highest effort; slower)`);
    }
    if (pb.others.length) p(`    other ids (unbanded): ${pb.others.join(', ')}`);
    try {
      const sc = summarize({ delegate: 'pi' });
      for (const x of sc.rows) p(`    scorecard ${x.model}: ${x.runs} run(s) · ${x.pass} pass / ${x.rework} rework / ${x.fail} fail → ${x.verdict} (${x.why})`);
      if (!sc.rows.length) p('    scorecard: no runs yet');
      if (sc.ungraded.length) p(`    ungraded pi runs: ${sc.ungraded.slice(-6).map((u) => u.job).join(', ')} — grade them (dispatch_grade)`);
    } catch { /* no scorecard data */ }
  }
}

// ── 0.2 health smoke test (opt-in: --smoke) ──
// install ≠ authenticated ≠ working: a CLI can pass the availability check and
// still hang on a real call. The round-trip goes through dispatch.mjs so it
// exercises the exact path a real dispatch takes (model validation, JSON
// envelope, proof line). Spends a little external quota, so only when asked.
if (smoke) {
  const dispatch = path.join(HERE, 'dispatch.mjs');
  const healthy = (r) => (r.ok && /\bOK\b/.test(r.stdout) ? 'HEALTHY' : `DEGRADED — ${(r.stderr || '').trim().split('\n').pop() || 'no output'} — route around it this session`);
  let sc = 'skipped', sa = 'skipped';
  if (codexOut) sc = `QUOTA EXHAUSTED${untilTxt(codexOut.until)} — not called`;
  else if (codexOk && cb.ok && cb.mech) {
    sc = healthy(run(process.execPath, [dispatch, 'codex', '--model', cb.mech.model, '--effort', 'low', '--sandbox', 'read-only', '--timeout', '120', '--quiet', '--', 'reply with exactly: OK'], { timeout: 130000 }));
  }
  const tier = tiers.gemlo || tiers.gemmed || tiers.gemhi || tiers.sonnet || tiers.opus;
  if (agyOk && tier) {
    sa = healthy(run(process.execPath, [dispatch, 'agy', '--model', tier, '--timeout', '120', '--quiet', '--', 'reply with exactly: OK'], { timeout: 130000 }));
  }
  let spi = '';
  if (piOk && pb.ok) spi = ` · pi=${healthy(run(process.execPath, [dispatch, 'pi', '--model', pb.lo, '--timeout', '120', '--quiet', '--', 'reply with exactly: OK'], { timeout: 130000 }))}`;
  p(`  health: codex=${sc} · agy=${sa}${spi}`);
} else {
  p('  health: not run — pass --smoke to round-trip each CLI through dispatch.mjs (catches auth/backend breakage; costs a little external quota)');
}

done();
