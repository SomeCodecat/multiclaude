#!/usr/bin/env node
// multiclaude:setup — idempotent, re-runnable setup. Pure Node, cross-platform,
// no python3 / no shell. Two modes:
//
//   check   (default)  verify everything orchestrate + usage need; CHANGE NOTHING;
//                      print the exact fix for anything missing.
//   apply              ADD what multiclaude needs to ~/.claude/settings.json,
//                      never change what is already there:
//                        • add-only: a key you already set is KEPT (reported as
//                          "kept yours"), never overwritten; a marketplace entry
//                          or statusLine is kept whole, never mixed with ours
//                        • timestamped backup before every write
//                        • the multiclaude status line (wallet headroom), via a
//                          stable launcher that follows plugin updates — added
//                          only if you have no statusLine yet
//                        • warm the ccusage cache
//                      then run the same verification and report.
//
//   setup.mjs                            check only — the onboarding report
//   setup.mjs apply --dry-run            show exactly what WOULD be added / kept
//   setup.mjs apply                      add the multiclaude plugin wiring + status line
//   setup.mjs apply --no-statusline      … without the status line
//   setup.mjs apply --companions         + enable superpowers, claude-mem, codex,
//                                        agy plugins (and their marketplaces)
//   setup.mjs apply --preferences        + setup/preferences.json (env,
//                                        theme, effort …) — only keys you lack
//   setup.mjs apply --full               --companions + --preferences
//   setup.mjs apply --set k=v            explicitly SET a dotted key (the only way
//                                        apply overwrites a value of yours)
// Never touched: permissions, model, any key not in the selected template.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, which, run, dateStamp } from './lib/mc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);                       // the plugin root
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

// ── args ────────────────────────────────────────────────
let MODE = 'check', COMPANIONS = false, PREFS = false, DRYRUN = false, STATUSLINE = true;
let TEMPLATE = path.join(ROOT, 'setup', 'settings.json');
const PREFERENCES = path.join(ROOT, 'setup', 'preferences.json');
const SETS = [];
const argv = process.argv.slice(2);
function usageAndExit(code = 0) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30);
  console.log(src.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(code);
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === 'check' || a === 'apply') MODE = a;
  else if (a === '--full') { COMPANIONS = true; PREFS = true; }
  else if (a === '--companions') COMPANIONS = true;
  else if (a === '--preferences') PREFS = true;
  else if (a === '--dry-run' || a === '-n') DRYRUN = true;
  else if (a === '--no-statusline') STATUSLINE = false;
  else if (a === '--template') TEMPLATE = argv[++i] || TEMPLATE;
  else if (a === '--set') { if (argv[i + 1]) SETS.push(argv[++i]); else { console.error('setup: --set needs KEY=VALUE'); process.exit(2); } }
  else if (a === '--ttl') { if (argv[i + 1]) SETS.push(`env.MULTICLAUDE_USAGE_TTL=${argv[++i]}`); else { console.error('setup: --ttl needs seconds'); process.exit(2); } }
  else if (a === '--model') { if (argv[i + 1]) SETS.push(`model=${argv[++i]}`); else { console.error('setup: --model needs a name'); process.exit(2); } }
  else if (a === '-h' || a === '--help') usageAndExit(0);
  else { console.error(`setup: unknown argument '${a}' (try --help)`); process.exit(2); }
}

// ── status line ─────────────────────────────────────────
// The plugin's install folder moves with every update (…/cache/multiclaude/
// multiclaude/<version>), so settings.json points at a launcher in our data dir
// instead. The launcher looks up the current install in installed_plugins.json
// and runs its usage-snapshot.mjs --statusline (cache only, never the network).
const DATA_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'multiclaude')
  : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'multiclaude');
const LAUNCHER = path.join(DATA_DIR, 'statusline.mjs');
const fwd = (p) => p.split(path.sep).join('/');          // the command runs in bash (Git Bash on Windows)
const STATUSLINE_CMD = `node "${fwd(LAUNCHER)}"`;
const STATUSLINE_SETTING = { type: 'command', command: STATUSLINE_CMD, padding: 0, refreshInterval: 10 };
const launcherSource = () => [
  '#!/usr/bin/env node',
  '// multiclaude status line — written by `/multiclaude:setup apply`; re-run it to refresh.',
  '// Finds the current multiclaude install (plugin updates move it) and prints its',
  '// wallet line: usage-snapshot.mjs --statusline (cached figures, never the network).',
  "import { readFileSync, existsSync } from 'node:fs';",
  "import path from 'node:path';",
  "import os from 'node:os';",
  "import { pathToFileURL } from 'node:url';",
  `const FALLBACK = ${JSON.stringify(ROOT)};`,
  "const script = (root) => path.join(root, 'scripts', 'usage-snapshot.mjs');",
  'function pluginRoot() {',
  "  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean);",
  '  for (const dir of dirs) {',
  '    try {',
  "      const j = JSON.parse(readFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), 'utf8'));",
  "      const hits = Object.entries(j.plugins || {}).filter(([k]) => k.startsWith('multiclaude@')).flatMap(([, v]) => v)",
  '        .filter((e) => e?.installPath && existsSync(script(e.installPath)))',
  "        .sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')));",
  '      if (hits.length) return hits[0].installPath;',
  '    } catch { /* next */ }',
  '  }',
  '  return existsSync(script(FALLBACK)) ? FALLBACK : null;',
  '}',
  'const root = pluginRoot();',
  "if (!root) { console.log('multiclaude status line: plugin not found — /multiclaude:setup'); process.exit(0); }",
  "process.argv = [process.argv[0], script(root), '--statusline'];",
  'await import(pathToFileURL(script(root)).href);',
  '',
].join('\n');
const isOurStatusLine = (sl) => /multiclaude[\\/]statusline\.mjs|usage-snapshot\.mjs/.test(String(sl?.command || ''));

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
// ADD-ONLY merge: a key the user already has is kept, never overwritten. Objects
// recurse, except whole-value settings (a marketplace entry, statusLine), which
// are kept or added whole so ours never mixes into yours.
const WHOLE = (keyPath) => keyPath === 'statusLine' || /^extraKnownMarketplaces\.[^.]+$/.test(keyPath);
function fill(dst, src, report, prefix = '') {
  for (const [k, v] of Object.entries(src)) {
    const kp = prefix ? `${prefix}.${k}` : k;
    if (!(k in dst)) { dst[k] = structuredClone(v); report.added.push(kp); }
    else if (isObj(v) && isObj(dst[k]) && !WHOLE(kp)) fill(dst[k], v, report, kp);
    else if (!eq(dst[k], v)) report.kept.push(`${kp} (yours: ${JSON.stringify(dst[k])})`);
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
    // default scope = multiclaude's own wiring; --companions adds the other plugins
    const own = (o, keep) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => keep(k)));
    const isOurs = (k) => k === 'multiclaude' || k === 'multiclaude@multiclaude';
    const desired = {
      enabledPlugins: own(tmpl.enabledPlugins, (k) => COMPANIONS || isOurs(k)),
      extraKnownMarketplaces: own(tmpl.extraKnownMarketplaces, (k) => COMPANIONS || isOurs(k)),
    };
    // A multiclaude marketplace under ANY name or source (e.g. a local folder) counts as ours.
    const haveOurs = Object.entries(cur.extraKnownMarketplaces || {}).some(([k, m]) => k === 'multiclaude' || /multiclaude/.test(JSON.stringify(m?.source ?? '')));
    if (haveOurs) delete desired.extraKnownMarketplaces.multiclaude;
    if (STATUSLINE) desired.statusLine = STATUSLINE_SETTING;
    const report = { added: [], kept: [], set: [] };
    const next = fill(structuredClone(cur), desired, report);
    if (PREFS) fill(next, loadJson(PREFERENCES, {}), report);
    for (const s of SETS) { const i = s.indexOf('='); if (i > 0) { setVal(next, s.slice(0, i), s.slice(i + 1)); report.set.push(s.slice(0, i)); } }

    for (const k of report.added) console.log(`  + ${DRYRUN ? 'would add' : 'added'}  ${k}`);
    for (const k of report.set) console.log(`  ~ ${DRYRUN ? 'would set' : 'set'}  ${k}   (--set)`);
    for (const k of report.kept) console.log(`  = kept yours  ${k}`);
    if (STATUSLINE && cur.statusLine && !isOurStatusLine(cur.statusLine)) {
      note(`your own statusLine is kept; to show the wallet line too, run  ${STATUSLINE_CMD}  from it (e.g. as a custom-command widget)`);
    }
    if (STATUSLINE) {
      const src = launcherSource();
      let have = ''; try { have = readFileSync(LAUNCHER, 'utf8'); } catch { /* none */ }
      if (have !== src) {
        if (DRYRUN) console.log(`  + would write  ${LAUNCHER}  (status-line launcher)`);
        else {
          mkdirSync(DATA_DIR, { recursive: true });
          writeFileSync(`${LAUNCHER}.tmp`, src); renameSync(`${LAUNCHER}.tmp`, LAUNCHER);
          console.log(`  + wrote  ${LAUNCHER}  (status-line launcher)`);
        }
      }
    }
    if (eq(cur, next)) {
      pass('settings.json already has everything selected — no change');
    } else if (!DRYRUN) {
      mkdirSync(path.dirname(SETTINGS), { recursive: true });
      let bak = '';
      if (existsSync(SETTINGS)) {
        const b = `${SETTINGS}.multiclaude-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}.bak`;
        copyFileSync(SETTINGS, b); bak = ` (backup: ${b})`;
      }
      const tmp = `${SETTINGS}.multiclaude-tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      renameSync(tmp, SETTINGS);
      pass(`settings.json updated${bak}`);
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
for (const s of ['scripts/probe.mjs', 'scripts/dispatch.mjs', 'scripts/usage-snapshot.mjs', 'skills/quota/quota.mjs', 'scripts/lib/mc.mjs', 'scripts/lib/wallets.mjs', 'scripts/lib/models.mjs']) {
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
  const u = run('agy', ['-p', '/usage', '--output-format', 'json'], { timeout: 30000 });
  if (u.ok && u.stdout.includes('remaining_fraction')) pass('agy /usage reports pool quota (proactive AGY headroom)');
  else fail('agy /usage unavailable — AGY headroom falls back to reactive 429 status', 'agy update   (needs agy >= 1.4), then re-run setup');
} else {
  fail('agy CLI', 'curl -fsSL https://antigravity.google/cli/install.sh | bash   (then authenticate)');
}

console.log('\n▌ Companion plugins (orchestrate §0)');
let settingsText = '';
try { settingsText = readFileSync(SETTINGS, 'utf8'); } catch { /* none yet */ }
if (settingsText.includes('superpowers@')) pass('superpowers plugin enabled');
else fail('superpowers plugin', 'setup apply --companions   (adds it; keeps everything you have)');
if (settingsText.includes('claude-mem@')) pass('claude-mem plugin enabled');
else fail('claude-mem plugin', 'setup apply --companions   (adds it; keeps everything you have)');

console.log('\n▌ ccusage — Claude usage backend');
if (which('bunx') || which('npx')) {
  const runner = which('bunx') ? ['bunx', ['ccusage@latest', '--version']] : ['npx', ['-y', 'ccusage@latest', '--version']];
  if (run(runner[0], runner[1], { timeout: 120000 }).ok) pass(`ccusage reachable + cached (${runner[0]})`);
  else fail('ccusage not reachable (needs network)', `check network, then: ${runner[0]} ccusage@latest --version`);
} else {
  note('skipped — needs bunx/npx first');
}

console.log('\n▌ Dispatch runner (orchestrate §2)');
const disp = path.join(ROOT, 'scripts', 'dispatch.mjs');
if (existsSync(disp) && (run(process.execPath, [disp], { timeout: 15000 }).stderr || '').includes('usage: dispatch.mjs')) pass('dispatch.mjs runs (validated, shell-free agy/codex runner)');
else fail('dispatch.mjs not runnable', 'reinstall the multiclaude plugin / check node');

console.log('\n▌ Usage snapshot hook (orchestrate §0/§5)');
if (existsSync(path.join(ROOT, 'hooks', 'hooks.json'))) pass('hooks/hooks.json present (auto-injects wallet headroom)');
else fail('hooks/hooks.json missing', 'reinstall the multiclaude plugin');
const snap = path.join(ROOT, 'scripts', 'usage-snapshot.mjs');
if (existsSync(snap) && (run(process.execPath, [snap], { timeout: 30000 }).stdout || '').includes('multiclaude wallets')) {
  pass('usage-snapshot.mjs runs (warms the headroom cache)');
} else {
  fail('usage-snapshot.mjs not runnable', 'reinstall the multiclaude plugin / check node');
}

console.log('\n▌ Status line (wallet headroom under the prompt)');
{
  let sl; try { sl = JSON.parse(readFileSync(SETTINGS, 'utf8')).statusLine; } catch { /* none */ }
  const viaLauncher = String(sl?.command || '').includes('statusline.mjs');
  if (!sl) {
    fail('no statusLine — the wallet line is not shown', 'setup apply   (adds it; keeps everything you have)');
  } else if (!isOurStatusLine(sl)) {
    note(`statusLine is your own (${String(sl.command || '').slice(0, 60)}) — kept; to add the wallet line run  ${STATUSLINE_CMD}  from it`);
  } else if (viaLauncher && !existsSync(LAUNCHER)) {
    fail(`statusLine points at ${LAUNCHER}, which is missing`, 'setup apply   (rewrites the launcher)');
  } else {
    const r = run(process.execPath, viaLauncher ? [LAUNCHER] : [snap, '--statusline'], { timeout: 15000 });
    const out = (r.stdout || '').trim();
    if (out && !out.includes('plugin not found')) {
      pass('statusLine shows the multiclaude wallet line');
      if (viaLauncher && readFileSync(LAUNCHER, 'utf8') !== launcherSource()) note('the status-line launcher is from another multiclaude copy — setup apply refreshes it');
    } else fail('the status-line command prints nothing', 'setup apply   (rewrites the launcher), then check node is on PATH');
  }
}

console.log('\n' + RULE);
if (miss === 0) {
  console.log(`  ✓ all set — ${ok} checks passed.`);
  console.log('    /multiclaude:orchestrate and /multiclaude:quota are ready.');
} else if (MODE === 'check') {
  console.log(`  ${ok} ok · ${miss} to fix.`);
  console.log('    config gaps: setup apply --dry-run shows what would be ADDED (it never changes a value you set).');
  console.log("    CLI gaps:    run the 'fix:' commands above, then re-run setup.");
} else {
  console.log(`  ${ok} ok · ${miss} still need YOU (CLI installs/logins can't be automated).`);
  console.log("    run the 'fix:' commands above, then re-run  multiclaude setup.");
}
console.log(RULE);
process.exit(miss === 0 ? 0 : 1);
