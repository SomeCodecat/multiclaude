#!/usr/bin/env node
// multiclaude:probe — does all of orchestrate §0 (session setup) MECHANICALLY and
// emits one block the orchestrator reads, instead of the model running a handful
// of availability/tier/health commands and interpreting them itself.
//
//   0.1 opt-out      — 'orchestrate: off' in the project CLAUDE.md
//   0.2 availability — codex / agy CLIs + superpowers / claude-mem plugins
//   0.3 AGY tiers    — resolve Opus / Sonnet / Gemini-high / Gemini-medium by
//                      PATTERN off `agy models` (names drift — never hardcode)
//   0.2 health       — round-trip each CLI; ONLY with --smoke (costs a little
//                      external quota, so off by default)
//
// Pure Node, cross-platform, no python3. Re-run per session; cache in context.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HOME, which, run, stamp } from './lib/mc.mjs';
import { agyTiers, resolveTiers } from './lib/wallets.mjs';

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
  p('  orchestrate: OFF — project opted out via CLAUDE.md; tell the user once, work normally (skip §1–§8).');
  done();
}
p('  orchestrate: ON');

// ── 0.2 availability (CLIs + plugins) ──
const codexOk = !!which('codex');
const agyOk = !!which('agy');
p(codexOk ? '  codex: present'
  : '  codex: MISSING — install: curl -fsSL https://chatgpt.com/codex/install.sh | sh   then: codex login');
p(agyOk ? '  agy:   present'
  : '  agy:   MISSING — install: curl -fsSL https://antigravity.google/cli/install.sh | bash   then authenticate');

let sp = 'MISSING (run: multiclaude setup apply)';
let cm = 'MISSING (run: multiclaude setup apply)';
try {
  const s = readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8');
  if (s.includes('superpowers@')) sp = 'enabled';
  if (s.includes('claude-mem@')) cm = 'enabled';
} catch { /* ignore */ }
p(`  plugins: superpowers=${sp} · claude-mem=${cm}`);

// ── 0.3 AGY tier resolution (by pattern, never hardcoded) ──
let tiers = {};
if (agyOk) {
  const models = agyTiers();
  if (models.length) {
    tiers = resolveTiers(models);
    p('  agy tiers (use these names verbatim):');
    p(`    opus    = ${tiers.opus || '— none (step down to sonnet)'}`);
    p(`    sonnet  = ${tiers.sonnet || '— none (step down to gemini-high)'}`);
    p(`    gem-hi  = ${tiers.gemhi || '— none (step down to gemini-medium)'}`);
    p(`    gem-med = ${tiers.gemmed || '— none'}`);
  } else {
    p("  agy tiers: 'agy models' returned nothing — not authenticated or offline; treat AGY as unavailable this session");
  }
}

// ── 0.2 health smoke test (opt-in: --smoke) ──
// install ≠ authenticated ≠ working: a CLI can pass the availability check and
// still hang on a real call. The round-trip catches that — but it spends a little
// external quota, so it only runs when asked.
if (smoke) {
  let sc = 'skipped', sa = 'skipped';
  const healthy = (r) => (r.ok && /\bOK\b/.test(r.stdout) ? 'HEALTHY' : 'DEGRADED — route around it this session');
  if (codexOk) {
    sc = healthy(run('codex', ['exec', 'reply with exactly: OK'], { timeout: 60000 }));
  }
  const tier = tiers.gemmed || tiers.gemhi || tiers.sonnet || tiers.opus;
  if (agyOk && tier) {
    // read-only round-trip — no --dangerously-skip-permissions needed
    sa = healthy(run('agy', ['--print', '--model', tier], { timeout: 60000, input: 'reply with exactly: OK\n' }));
  }
  p(`  health: codex=${sc} · agy=${sa}`);
} else {
  p('  health: not run — pass --smoke to round-trip each CLI (catches auth/backend breakage; costs a little external quota)');
}

done();
