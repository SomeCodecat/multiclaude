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
//   setup.mjs apply --ccstatusline       … with ccstatusline on top (its configurable
//                                        session line; our wallet rows under it)
//   setup.mjs apply --companions         + enable the optional companion plugins
//                                        (superpowers, claude-mem, codex, agy) and
//                                        their marketplaces; nothing here needs them
//   setup.mjs apply --preferences        + setup/preferences.json (env,
//                                        theme, effort …) — only keys you lack
//   setup.mjs apply --full               --companions + --preferences
//   setup.mjs companions [--json]        the companions and their state (the menu's data)
//   setup.mjs companions add <name>      install + enable one (claude plugin install;
//                                        ccstatusline: apply --ccstatusline)
//   setup.mjs companions remove <name>   uninstall one (claude plugin uninstall;
//                                        ccstatusline: our status line back)
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
let MODE = 'check', COMPANIONS = false, PREFS = false, DRYRUN = false, STATUSLINE = true, CCSTATUSLINE = false;
let COMP_ACTION = '', COMP_NAME = '', JSON_OUT = false;   // companions [add|remove <name>] [--json]
let TEMPLATE = path.join(ROOT, 'setup', 'settings.json');
const PREFERENCES = path.join(ROOT, 'setup', 'preferences.json');
const SETS = [];
const argv = process.argv.slice(2);
function usageAndExit(code = 0) {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 37);
  console.log(src.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(code);
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === 'check' || a === 'apply') MODE = a;
  else if (a === 'companions') MODE = a;
  else if (MODE === 'companions' && (a === 'add' || a === 'remove') && !COMP_ACTION) { COMP_ACTION = a; COMP_NAME = argv[++i] || ''; }
  else if (a === '--json') JSON_OUT = true;
  else if (a === '--full') { COMPANIONS = true; PREFS = true; }
  else if (a === '--companions') COMPANIONS = true;
  else if (a === '--preferences') PREFS = true;
  else if (a === '--dry-run' || a === '-n') DRYRUN = true;
  else if (a === '--no-statusline') STATUSLINE = false;
  else if (a === '--ccstatusline') { CCSTATUSLINE = true; STATUSLINE = true; }
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
// As Claude Code's own statusLine the launcher draws the session line too (--session);
// under ccstatusline each wallet row is its own custom-command widget (--row N).
const STATUSLINE_CMD = `node "${fwd(LAUNCHER)}" --session`;
const STATUSLINE_SETTING = { type: 'command', command: STATUSLINE_CMD, padding: 0, refreshInterval: 10 };
const WIDGET_CMD = `node "${fwd(LAUNCHER)}"`;
const launcherSource = () => [
  '#!/usr/bin/env node',
  '// multiclaude status line — written by `/multiclaude:setup apply`; re-run it to refresh.',
  '// Finds the current multiclaude install (plugin updates move it) and prints its',
  '// wallet rows: usage-snapshot.mjs --statusline (cached figures, never the network),',
  '// with any arguments passed on (--session for the session line, --row N for one row).',
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
  "process.argv = [process.argv[0], script(root), '--statusline', ...process.argv.slice(2)];",
  'await import(pathToFileURL(script(root)).href);',
  '',
].join('\n');
const isOurStatusLine = (sl) => /multiclaude[\\/]statusline\.mjs|usage-snapshot\.mjs/.test(String(sl?.command || ''));

// ── ccstatusline (optional extra) ───────────────────────
// `apply --ccstatusline` puts ccstatusline (sirmalloc/ccstatusline, MIT) on top — its
// configurable session line (bunx ccstatusline opens the editor) — and our wallet rows
// under it, one custom-command widget per row, from setup/ccstatusline.json. ccstatusline
// keeps its config in ~/.config/ccstatusline/settings.json on every platform.
const CCS_TEMPLATE = path.join(ROOT, 'setup', 'ccstatusline.json');
const CCS_CONFIG = path.join(HOME, '.config', 'ccstatusline', 'settings.json');
const CCS_CMD = which('bunx') ? 'bunx -y ccstatusline@latest' : 'npx -y ccstatusline@latest';
const CCS_SETTING = { type: 'command', command: CCS_CMD, padding: 0, refreshInterval: 10 };
const isCcstatusline = (sl) => /ccstatusline/.test(String(sl?.command || ''));
const isOurWidget = (w) => w?.type === 'custom-command' && isOurStatusLine({ command: w.commandPath });
// Our widget lines, with the launcher path filled in: the template's `${MULTICLAUDE_STATUSLINE}`.
function ccsTemplate() {
  const t = JSON.parse(readFileSync(CCS_TEMPLATE, 'utf8').split('${MULTICLAUDE_STATUSLINE}').join(fwd(LAUNCHER)));
  return { all: t, widgetLines: t.lines.filter((l) => l.some(isOurWidget)) };
}
// What the user's ccstatusline config needs: nothing (has our --row widgets), or our widget
// lines added (replacing an older single --statusline widget of ours). null = not parseable.
function ccsPlan(cfg) {
  if (!cfg || !Array.isArray(cfg.lines)) return null;
  const { widgetLines } = ccsTemplate();
  const ours = cfg.lines.flat().filter(isOurWidget);
  if (ours.length && ours.every((w) => /--row \d/.test(w.commandPath))) return { change: false, cfg };
  const next = structuredClone(cfg);
  // take our old widget out (a line that held nothing else goes with it), drop trailing empty lines
  next.lines = next.lines.map((l) => l.filter((w) => !isOurWidget(w))).filter((l, i) => l.length || !cfg.lines[i].some(isOurWidget));
  while (next.lines.length && next.lines[next.lines.length - 1].length === 0) next.lines.pop();
  next.lines.push(...structuredClone(widgetLines));
  return { change: true, cfg: next, replaced: ours.length > 0 };
}

// ── report helpers ──────────────────────────────────────
let ok = 0, miss = 0;
const pass = (m) => { console.log(`  ✓ ${m}`); ok++; };
const fail = (m, fix) => { console.log(`  ✗ ${m}\n      fix: ${fix}`); miss++; };
const note = (m) => console.log(`  · ${m}`);

const RULE = '═'.repeat(56);
if (MODE !== 'companions') {
  console.log(RULE);
  console.log(`  multiclaude setup (${MODE}) · ${dateStamp()}`);
  console.log(RULE);
}

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

// ── COMPANIONS: the optional extras, one at a time ──────
// The data behind the Setup pane's companions menu (`companions --json`) and its
// install / remove actions. Plugins go through the claude CLI (`claude plugin
// install|enable|uninstall`), which owns installed_plugins.json and the
// enabledPlugins entry; without a claude on PATH the settings.json entry is
// added (add-only, as apply --companions) or set to false (disabled), with a
// backup. ccstatusline is a status line, not a plugin: add = apply --ccstatusline,
// remove = our own status line back (its config file stays, it is the user's).
const COMPANION_LIST = [
  { name: 'superpowers', id: 'superpowers@superpowers-marketplace', what: 'workflow skills: brainstorming, plans, TDD' },
  { name: 'claude-mem', id: 'claude-mem@thedotmack', what: 'cross-session memory' },
  { name: 'codex', id: 'codex@openai-codex', what: 'the Codex plugin (multiclaude uses the CLI; the plugin is extra)' },
  { name: 'agy', id: 'agy@claude-code-agy', what: 'the Antigravity plugin (multiclaude uses the CLI; the plugin is extra)' },
  { name: 'ccstatusline', what: 'a configurable session line on top of the wallet rows' },
];
if (MODE === 'companions') {
  const cur = loadJson(SETTINGS, {});
  const tmpl = loadJson(TEMPLATE, {});
  let installed = {};
  try { installed = JSON.parse(readFileSync(path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { /* none */ }
  let known = {};
  try { known = JSON.parse(readFileSync(path.join(HOME, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8')) || {}; } catch { /* none */ }
  const cli = which('claude');
  const stateOf = (c) => {
    if (c.name === 'ccstatusline') {
      const inUse = isCcstatusline(cur.statusLine);
      const plan = inUse && existsSync(CCS_TEMPLATE) ? ccsPlan(loadJson(CCS_CONFIG, null)) : null;
      return { ...c, installed: inUse, enabled: inUse, state: !inUse ? 'absent' : plan && !plan.change ? 'enabled' : 'on, wallet rows missing' };
    }
    const enabled = cur.enabledPlugins?.[c.id] === true;
    const isInstalled = !!installed[c.id] || enabled;
    return { ...c, installed: isInstalled, enabled, state: enabled ? 'enabled' : isInstalled ? 'installed, disabled' : 'absent' };
  };
  const backupWrite = (next) => {
    mkdirSync(path.dirname(SETTINGS), { recursive: true });
    let bak = '';
    if (existsSync(SETTINGS)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
      let b = `${SETTINGS}.multiclaude-${stamp}.bak`;
      for (let n = 2; existsSync(b); n++) b = `${SETTINGS}.multiclaude-${stamp}-${n}.bak`;   // two writes in one second keep both
      copyFileSync(SETTINGS, b); bak = ` (backup: ${b})`;
    }
    const tmp = `${SETTINGS}.multiclaude-tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n'); renameSync(tmp, SETTINGS);
    return bak;
  };
  const claude = (...a) => { const r = run(cli, a, { timeout: 180000 }); return { ok: r.ok, text: ((r.stdout || '') + (r.stderr || '')).trim() }; };
  if (!COMP_ACTION) {
    const list = COMPANION_LIST.map(stateOf);
    if (JSON_OUT) console.log(JSON.stringify({ cli: !!cli, companions: list }));
    else {
      console.log('▌ Companions (optional — nothing in multiclaude needs them)');
      for (const c of list) console.log(`  ${c.enabled ? '✓' : '·'} ${c.name.padEnd(13)} ${c.state.padEnd(26)} ${c.what}`);
      console.log('    setup companions add|remove <name>   — or the menu: /multiclaude:setup companions');
    }
    process.exit(0);
  }
  const c = COMPANION_LIST.find((x) => x.name === COMP_NAME);
  if (!c) { console.error(`setup: unknown companion '${COMP_NAME}' — one of ${COMPANION_LIST.map((x) => x.name).join(', ')}`); process.exit(2); }
  if (c.name === 'ccstatusline') {
    if (COMP_ACTION === 'add') {
      const r = run(process.execPath, [fileURLToPath(import.meta.url), 'apply', '--ccstatusline'], { timeout: 180000 });
      process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
      process.exit(r.ok ? 0 : 1);
    }
    if (!isCcstatusline(cur.statusLine)) { console.log('  · ccstatusline is not the status line — nothing to remove'); process.exit(0); }
    const next = structuredClone(cur);
    next.statusLine = structuredClone(STATUSLINE_SETTING);
    const src = launcherSource();
    let have = ''; try { have = readFileSync(LAUNCHER, 'utf8'); } catch { /* none */ }
    if (have !== src) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(`${LAUNCHER}.tmp`, src); renameSync(`${LAUNCHER}.tmp`, LAUNCHER); }
    const bak = backupWrite(next);
    console.log(`  ~ statusLine → multiclaude's own (session line + wallet rows)${bak}`);
    console.log(`  · ${CCS_CONFIG} is kept (ccstatusline's own config) — remove it yourself if you are done with it`);
    process.exit(0);
  }
  const mk = c.id.split('@')[1];
  if (COMP_ACTION === 'add') {
    if (stateOf(c).enabled) { console.log(`  ✓ ${c.name} is already enabled`); process.exit(0); }
    if (cli) {
      if (!known[mk] && !cur.extraKnownMarketplaces?.[mk]) {
        const src = tmpl.extraKnownMarketplaces?.[mk]?.source;
        const ref = src?.repo || src?.url;
        if (!ref) { console.log(`  ✗ no marketplace source for ${mk} in the template`); process.exit(1); }
        const r = claude('plugin', 'marketplace', 'add', ref);
        console.log(`  ${r.ok ? '+' : '✗'} marketplace ${mk}: ${r.text.split('\n').pop() || (r.ok ? 'added' : 'failed')}`);
        if (!r.ok) process.exit(1);
      }
      const r = installed[c.id] ? claude('plugin', 'enable', c.id) : claude('plugin', 'install', c.id);
      console.log(`  ${r.ok ? '+' : '✗'} ${installed[c.id] ? 'enabled' : 'installed'} ${c.id}${r.text ? ': ' + r.text.split('\n').pop() : ''}`);
      if (r.ok) console.log('  · restart Claude Code to load it');
      process.exit(r.ok ? 0 : 1);
    }
    // no claude CLI: the add-only settings.json path, this plugin only
    const desired = { enabledPlugins: { [c.id]: true } };
    if (tmpl.extraKnownMarketplaces?.[mk]) desired.extraKnownMarketplaces = { [mk]: tmpl.extraKnownMarketplaces[mk] };
    const report = { added: [], kept: [], set: [] };
    const next = fill(structuredClone(cur), desired, report);
    if (next.enabledPlugins?.[c.id] !== true) { next.enabledPlugins = { ...(next.enabledPlugins || {}), [c.id]: true }; report.set.push(`enabledPlugins.${c.id}`); }
    const bak = eq(cur, next) ? '' : backupWrite(next);
    for (const k of report.added) console.log(`  + added  ${k}`);
    for (const k of report.set) console.log(`  ~ set  ${k}`);
    console.log(`  · settings.json${bak || ' unchanged'}; Claude Code installs ${c.id} on its next launch (no claude CLI on PATH)`);
    process.exit(0);
  }
  // remove
  if (!stateOf(c).installed) { console.log(`  · ${c.name} is not installed — nothing to remove`); process.exit(0); }
  if (cli) {
    const r = claude('plugin', 'uninstall', c.id);
    console.log(`  ${r.ok ? '-' : '✗'} ${r.ok ? 'uninstalled' : 'uninstall failed'} ${c.id}${r.text ? ': ' + r.text.split('\n').pop() : ''}`);
    if (r.ok) console.log('  · the running session keeps it until Claude Code restarts');
    process.exit(r.ok ? 0 : 1);
  }
  const next = structuredClone(cur);
  next.enabledPlugins = { ...(next.enabledPlugins || {}), [c.id]: false };
  const bak = backupWrite(next);
  console.log(`  ~ set  enabledPlugins.${c.id} = false  (disabled; no claude CLI on PATH to uninstall it)${bak}`);
  process.exit(0);
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
    if (STATUSLINE) desired.statusLine = CCSTATUSLINE ? CCS_SETTING : STATUSLINE_SETTING;
    const report = { added: [], kept: [], set: [] };
    const next = fill(structuredClone(cur), desired, report);
    // --ccstatusline swaps OUR statusLine for ccstatusline (it is ours to replace); any other stays.
    // A statusLine of OURS is ours to refresh: an older launcher command gets today's, --ccstatusline swaps it for ccstatusline.
    if (STATUSLINE && cur.statusLine && isOurStatusLine(cur.statusLine) && !eq(cur.statusLine, desired.statusLine)) {
      next.statusLine = structuredClone(desired.statusLine);
      report.kept = report.kept.filter((k) => !k.startsWith('statusLine '));
      report.set.push(CCSTATUSLINE ? 'statusLine → ccstatusline' : 'statusLine (ours, refreshed)');
    }
    if (PREFS) fill(next, loadJson(PREFERENCES, {}), report);
    for (const s of SETS) { const i = s.indexOf('='); if (i > 0) { setVal(next, s.slice(0, i), s.slice(i + 1)); report.set.push(s.slice(0, i)); } }

    for (const k of report.added) console.log(`  + ${DRYRUN ? 'would add' : 'added'}  ${k}`);
    for (const k of report.set) console.log(`  ~ ${DRYRUN ? 'would set' : 'set'}  ${k}${k.startsWith('statusLine') ? '' : '   (--set)'}`);
    if (!CCSTATUSLINE && isCcstatusline(cur.statusLine)) {
      report.kept = report.kept.filter((k) => !k.startsWith('statusLine '));
      note('statusLine is ccstatusline — kept (setup apply --ccstatusline keeps our wallet rows in its config)');
    }
    for (const k of report.kept) console.log(`  = kept yours  ${k}`);
    if (STATUSLINE && cur.statusLine && !isOurStatusLine(cur.statusLine) && !isCcstatusline(cur.statusLine)) {
      note(`your own statusLine is kept${CCSTATUSLINE ? ' (not swapped for ccstatusline)' : ''}; to show the wallet rows too, run  ${WIDGET_CMD} --row 1  (and --row 2, --row 3) from it, one line each`);
    }
    if (CCSTATUSLINE && (!cur.statusLine || isOurStatusLine(cur.statusLine) || isCcstatusline(cur.statusLine))) {
      // ccstatusline's own config: ours from the template when there is none; otherwise our widget rows added.
      if (!existsSync(CCS_TEMPLATE)) fail('setup/ccstatusline.json not found', 'reinstall the multiclaude plugin');
      else if (!existsSync(CCS_CONFIG)) {
        if (DRYRUN) console.log(`  + would write  ${CCS_CONFIG}  (ccstatusline: session line + wallet rows)`);
        else {
          mkdirSync(path.dirname(CCS_CONFIG), { recursive: true });
          writeFileSync(`${CCS_CONFIG}.tmp`, JSON.stringify(ccsTemplate().all, null, 2) + '\n'); renameSync(`${CCS_CONFIG}.tmp`, CCS_CONFIG);
          console.log(`  + wrote  ${CCS_CONFIG}  (ccstatusline: session line + wallet rows)`);
        }
      } else {
        const plan = ccsPlan(loadJson(CCS_CONFIG, null));
        if (!plan) fail(`${CCS_CONFIG} is not a ccstatusline config`, `move it away, then setup apply --ccstatusline`);
        else if (!plan.change) note(`${CCS_CONFIG} already has the wallet rows — kept`);
        else if (DRYRUN) console.log(`  + would ${plan.replaced ? 'replace the wallet widget in' : 'add the wallet rows to'}  ${CCS_CONFIG}`);
        else {
          const b = `${CCS_CONFIG}.multiclaude-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}.bak`;
          copyFileSync(CCS_CONFIG, b);
          writeFileSync(`${CCS_CONFIG}.tmp`, JSON.stringify(plan.cfg, null, 2) + '\n'); renameSync(`${CCS_CONFIG}.tmp`, CCS_CONFIG);
          console.log(`  + ${plan.replaced ? 'replaced the wallet widget in' : 'added the wallet rows to'}  ${CCS_CONFIG}  (backup: ${b})`);
        }
      }
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

console.log('\n▌ Companion plugins (optional — nothing in multiclaude needs them)');
let settingsText = '';
try { settingsText = readFileSync(SETTINGS, 'utf8'); } catch { /* none yet */ }
if (settingsText.includes('superpowers@')) pass('superpowers plugin enabled (workflow skills)');
else note('superpowers plugin not enabled — optional: setup apply --companions');
if (settingsText.includes('claude-mem@')) pass('claude-mem plugin enabled (cross-session memory)');
else note('claude-mem plugin not enabled — optional: setup apply --companions');
{
  let sl; try { sl = JSON.parse(settingsText).statusLine; } catch { /* none */ }
  if (isCcstatusline(sl)) pass('ccstatusline on top of the status line (configurable session line)');
  else note('ccstatusline not in use — optional: setup apply --ccstatusline   (its session line on top, our wallet rows under it)');
}

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
  if (existsSync(path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'multiclaude', 'statusline.off')))
    note('the wallet rows are switched off (/delegates settings, 7) — the status line shows the session line only');
  const viaLauncher = String(sl?.command || '').includes('statusline.mjs');
  const launcherOk = () => {
    if (!existsSync(LAUNCHER)) { fail(`the status-line launcher ${LAUNCHER} is missing`, 'setup apply   (rewrites the launcher)'); return false; }
    const out = (run(process.execPath, [LAUNCHER, '--row', '1'], { timeout: 15000 }).stdout || '').trim();
    if (!out || out.includes('plugin not found')) { fail('the status-line launcher prints nothing', 'setup apply   (rewrites the launcher), then check node is on PATH'); return false; }
    if (readFileSync(LAUNCHER, 'utf8') !== launcherSource()) note('the status-line launcher is from another multiclaude copy — setup apply refreshes it');
    return true;
  };
  if (!sl) {
    fail('no statusLine — the wallet rows are not shown', 'setup apply   (adds it; keeps everything you have)   or   setup apply --ccstatusline');
  } else if (isCcstatusline(sl)) {
    // the optional extra: ccstatusline on top, our rows as its custom-command widgets
    const plan = existsSync(CCS_TEMPLATE) ? ccsPlan(loadJson(CCS_CONFIG, null)) : null;
    if (!plan) fail(`statusLine is ccstatusline but ${CCS_CONFIG} is missing or not its config`, 'setup apply --ccstatusline   (writes it: session line + wallet rows)');
    else if (plan.change) fail('ccstatusline is set, but its config has no multiclaude wallet rows', 'setup apply --ccstatusline   (adds them; keeps your other widgets)');
    else if (launcherOk()) pass('statusLine is ccstatusline with the multiclaude wallet rows under its session line');
  } else if (!isOurStatusLine(sl)) {
    note(`statusLine is your own (${String(sl.command || '').slice(0, 60)}) — kept; to add the wallet rows run  ${WIDGET_CMD} --row 1  (and --row 2, --row 3) from it`);
  } else if (!viaLauncher) {
    const out = (run(process.execPath, [snap, '--statusline'], { timeout: 15000 }).stdout || '').trim();
    if (out) pass('statusLine shows the multiclaude wallet rows (direct script path — setup apply switches it to the launcher, which follows plugin updates)');
    else fail('the status-line command prints nothing', 'setup apply   (points it at the launcher), then check node is on PATH');
  } else if (launcherOk()) {
    pass('statusLine shows the multiclaude session line and wallet rows');
    if (!/--session/.test(String(sl.command || ''))) note('statusLine runs the launcher without --session (older setup) — setup apply adds the session line');
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
