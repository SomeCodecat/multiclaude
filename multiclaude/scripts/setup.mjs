#!/usr/bin/env node
// multiclaude:setup — idempotent, re-runnable setup. Pure Node, cross-platform,
// no python3 / no shell. Two modes:
//
//   check   (default)  verify everything orchestrate + usage need; CHANGE NOTHING;
//                      print the exact fix for anything missing.
//   apply              converge local config to the desired state, idempotently:
//                        • deep-merge the desired-state template into
//                          ~/.claude/settings.json (backs up first; never clobbers
//                          keys it doesn't manage)
//                        • warm the ccusage cache
//                      then run the same verification and report.
//
// "Change settings at will" — all safe to repeat:
//   setup.mjs apply                      enable the multiclaude plugin wiring
//   setup.mjs apply --full               apply the WHOLE template (model/theme/env/…)
//   setup.mjs apply --set model=opus \
//                   --set env.X=1        set/override any settings.json key (dotted
//                                        path; value parsed as JSON, else string)
//   setup.mjs apply --ttl 600            shortcut for env.MULTICLAUDE_USAGE_TTL
//   setup.mjs apply --model <name>       shortcut for the top-level model key
//   setup.mjs apply --dry-run            show the diff that WOULD be written
// Re-running converges to the same state and reports "no change" once applied.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, which, run, dateStamp } from './lib/mc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);                       // the plugin root
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

// ── args ────────────────────────────────────────────────
let MODE = 'check', FULL = false, DRYRUN = false;
let TEMPLATE = path.join(ROOT, 'setup', 'settings.json');
const SETS = [];
const argv = process.argv.slice(2);
function usageAndExit(code = 0) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26);
  console.log(src.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(code);
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === 'check' || a === 'apply') MODE = a;
  else if (a === '--full') FULL = true;
  else if (a === '--dry-run' || a === '-n') DRYRUN = true;
  else if (a === '--template') TEMPLATE = argv[++i] || TEMPLATE;
  else if (a === '--set') { if (argv[i + 1]) SETS.push(argv[++i]); else { console.error('setup: --set needs KEY=VALUE'); process.exit(2); } }
  else if (a === '--ttl') { if (argv[i + 1]) SETS.push(`env.MULTICLAUDE_USAGE_TTL=${argv[++i]}`); else { console.error('setup: --ttl needs seconds'); process.exit(2); } }
  else if (a === '--model') { if (argv[i + 1]) SETS.push(`model=${argv[++i]}`); else { console.error('setup: --model needs a name'); process.exit(2); } }
  else if (a === '-h' || a === '--help') usageAndExit(0);
  else { console.error(`setup: unknown argument '${a}' (try --help)`); process.exit(2); }
}

// ── report helpers ──────────────────────────────────────
let ok = 0, miss = 0;
const pass = (m) => { console.log(`  ✓ ${m}`); ok++; };
const fail = (m, fix) => { console.log(`  ✗ ${m}\n      fix: ${fix}`); miss++; };
const note = (m) => console.log(`  · ${m}`);

const RULE = '═'.repeat(56);
console.log(RULE);
console.log(`  multiclaude setup (${MODE}) · ${dateStamp()}`);
console.log(RULE);

// Pick the platform package-manager hint for "install node" style fixes.
function pkgHint() {
  if (which('apt-get')) return 'sudo apt-get install -y';
  if (which('brew')) return 'brew install';
  if (which('dnf')) return 'sudo dnf install -y';
  if (which('pacman')) return 'sudo pacman -S';
  if (which('winget')) return 'winget install';
  return '<your package manager> install';
}
const PKG = pkgHint();

// ── deep-merge engine (replaces the python heredoc) ─────
function loadJson(p, dflt) {
  if (!existsSync(p)) return dflt;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { console.log(`  ✗ cannot parse ${p}: ${e.message}`); process.exit(1); }
}
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v) && isObj(dst[k])) merge(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}
function setVal(d, dotted, raw) {
  let val; try { val = JSON.parse(raw); } catch { val = raw; }   // not JSON → string
  const ks = dotted.split('.');
  for (const k of ks.slice(0, -1)) { if (!isObj(d[k])) d[k] = {}; d = d[k]; }
  d[ks[ks.length - 1]] = val;
}
// structural equality (key order independent) for the "what changed" diff
function eq(a, b) {
  if (a === b) return true;
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => eq(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return false;
}

// ── APPLY: converge local config (idempotent) ───────────
if (MODE === 'apply') {
  console.log(`\n▌ Apply${DRYRUN ? ' (dry-run — no writes)' : ''}`);
  if (!existsSync(TEMPLATE)) {
    fail('desired-state template not found', `expected at ${TEMPLATE}`);
  } else {
    const cur = loadJson(SETTINGS, {});
    const tmpl = loadJson(TEMPLATE, {});
    // default scope = just the plugin wiring; --full = the entire template
    const desired = FULL ? tmpl
      : Object.fromEntries(['enabledPlugins', 'extraKnownMarketplaces'].filter((k) => k in tmpl).map((k) => [k, tmpl[k]]));
    const next = merge(structuredClone(cur), desired);
    for (const s of SETS) { const i = s.indexOf('='); if (i > 0) setVal(next, s.slice(0, i), s.slice(i + 1)); }

    const changed = [...new Set([...Object.keys(cur), ...Object.keys(next)])].filter((k) => !eq(cur[k], next[k])).sort();
    if (!changed.length) {
      pass('settings.json already matches desired state — no change');
    } else if (DRYRUN) {
      console.log(`  ~ would change: ${changed.join(', ')}`);
      console.log('  ---- proposed ~/.claude/settings.json ----');
      for (const ln of JSON.stringify(next, null, 2).split('\n')) console.log('    ' + ln);
    } else {
      mkdirSync(path.dirname(SETTINGS), { recursive: true });
      let bak = '';
      if (existsSync(SETTINGS)) { copyFileSync(SETTINGS, SETTINGS + '.bak'); bak = ` (backup: ${SETTINGS}.bak)`; }
      writeFileSync(SETTINGS, JSON.stringify(next, null, 2) + '\n');
      pass(`settings.json updated${bak}`);
      console.log(`    changed keys: ${changed.join(', ')}`);
    }
  }
  if (DRYRUN) console.log('\n  (dry-run: nothing written — drop --dry-run to apply)');
}

// ── VERIFY (always) ─────────────────────────────────────
console.log('\n▌ Core runtime');
pass(`node (${process.version})`);   // we are running under it
if (which('bunx')) pass('bunx (runs ccusage)');
else if (which('npx')) pass('npx (runs ccusage)');
else fail('bunx/npx (Node tooling) — runs ccusage for Claude usage', `install Node.js: ${PKG} nodejs   (or https://nodejs.org)`);

console.log('\n▌ Plugin scripts');
for (const s of ['scripts/probe.mjs', 'scripts/usage-snapshot.mjs', 'skills/usage/usage.mjs', 'scripts/lib/mc.mjs', 'scripts/lib/wallets.mjs']) {
  if (existsSync(path.join(ROOT, s))) pass(`${s} present`);
  else fail(`${s} missing`, 'reinstall the multiclaude plugin');
}

console.log('\n▌ Codex — edit/implementation tasks');
if (which('codex')) {
  const v = (run('codex', ['--version'], { timeout: 15000 }).stdout || '').split('\n')[0].trim();
  pass(`codex installed${v ? ` (${v})` : ''}`);
  if (run('codex', ['login', 'status'], { timeout: 20000 }).ok) pass('codex logged in');
  else fail('codex not logged in', 'codex login');
} else {
  fail('codex CLI', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh   (then: codex login)');
}

console.log('\n▌ AGY — review/research/reasoning');
if (which('agy')) {
  const v = (run('agy', ['--version'], { timeout: 15000 }).stdout || '').split('\n')[0].trim();
  pass(`agy installed${v ? ` (${v})` : ''}`);
  if (run('agy', ['models'], { timeout: 30000 }).ok) pass('agy authenticated (models reachable)');
  else fail('agy not authenticated / unreachable', "run 'agy' once and complete sign-in");
} else {
  fail('agy CLI', 'curl -fsSL https://antigravity.google/cli/install.sh | bash   (then authenticate)');
}

console.log('\n▌ Companion plugins (orchestrate §0)');
let settingsText = '';
try { settingsText = readFileSync(SETTINGS, 'utf8'); } catch { /* none yet */ }
if (settingsText.includes('superpowers@')) pass('superpowers plugin enabled');
else fail('superpowers plugin', `multiclaude setup apply   (merges it from ${TEMPLATE})`);
if (settingsText.includes('claude-mem@')) pass('claude-mem plugin enabled');
else fail('claude-mem plugin', `multiclaude setup apply   (merges it from ${TEMPLATE})`);

console.log('\n▌ ccusage — Claude usage backend');
if (which('bunx') || which('npx')) {
  const runner = which('bunx') ? ['bunx', ['ccusage@latest', '--version']] : ['npx', ['-y', 'ccusage@latest', '--version']];
  if (run(runner[0], runner[1], { timeout: 120000 }).ok) pass(`ccusage reachable + cached (${runner[0]})`);
  else fail('ccusage not reachable (needs network)', `check network, then: ${runner[0]} ccusage@latest --version`);
} else {
  note('skipped — needs bunx/npx first');
}

console.log('\n▌ Usage snapshot hook (orchestrate §0/§5)');
if (existsSync(path.join(ROOT, 'hooks', 'hooks.json'))) pass('hooks/hooks.json present (auto-injects wallet headroom)');
else fail('hooks/hooks.json missing', 'reinstall the multiclaude plugin');
const snap = path.join(ROOT, 'scripts', 'usage-snapshot.mjs');
if (existsSync(snap) && (run(process.execPath, [snap], { timeout: 30000 }).stdout || '').includes('multiclaude wallets')) {
  pass('usage-snapshot.mjs runs (warms the headroom cache)');
} else {
  fail('usage-snapshot.mjs not runnable', 'reinstall the multiclaude plugin / check node');
}

console.log('\n' + RULE);
if (miss === 0) {
  console.log(`  ✓ all set — ${ok} checks passed.`);
  console.log('    /multiclaude:orchestrate and /multiclaude:usage are ready.');
} else if (MODE === 'check') {
  console.log(`  ${ok} ok · ${miss} to fix.`);
  console.log('    config gaps: run  multiclaude setup apply   (idempotent, backs up settings)');
  console.log("    CLI gaps:    run the 'fix:' commands above, then re-run setup.");
} else {
  console.log(`  ${ok} ok · ${miss} still need YOU (CLI installs/logins can't be automated).`);
  console.log("    run the 'fix:' commands above, then re-run  multiclaude setup.");
}
console.log(RULE);
process.exit(miss === 0 ? 0 : 1);
