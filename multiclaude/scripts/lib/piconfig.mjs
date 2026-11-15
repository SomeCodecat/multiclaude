// How the runner starts pi — the user's own choice, never the plugin's. One file per machine,
// <config>/multiclaude/pi.json (XDG config dir; %APPDATA%\multiclaude on Windows), beside the
// `parallel` key lib/pislots.mjs reads:
//
//   {
//     "command":   ["pi"],              // argv the runner starts pi with: a wrapper (`["mywrap", "pi"]`),
//                                       // or your own sandbox (`["firejail", "--quiet", "pi"]`)
//     "args":      [],                  // added to every runner pi run
//     "exclude":   [],                  // pi packages a runner run leaves out (models.mjs piExtensionArgs)
//     "tools":     [],                  // extension tools a runner run may use beside the core ones, e.g. a
//                                       // web-search package's tools; the run's --tools allowlist keeps
//                                       // every other extension tool out
//     "sandboxed": false,               // true: `command` is a sandbox you trust — a shadow's shell then
//                                       // runs in it, tier `custom`
//     "shadowShell": "auto"             // auto: bwrap, else your sandboxed command, else the guard
//                                       //   (weaker: no OS sandbox) · sandbox: never the guard ·
//                                       //   guard: always the guard · off: no shell
//   }
//
// Environment wins over the file: MULTICLAUDE_PI_COMMAND (a JSON array, or words split on spaces),
// MULTICLAUDE_PI_ARGS (same), MULTICLAUDE_PI_EXCLUDE and MULTICLAUDE_PI_TOOLS (names joined by ','; `none` = none),
// MULTICLAUDE_SHADOW_SHELL (auto | sandbox | guard | off). The catalog reads (`pi --list-models`) keep
// plain `pi`: a wrapper is for the runs.
import { readFileSync } from 'node:fs';
import { configFile } from './pislots.mjs';

export const SHELL_MODES = ['auto', 'sandbox', 'guard', 'off'];
const words = (v) => {
  const s = String(v).trim();
  if (!s) return [];
  if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }
  return s.split(/\s+/);
};
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

export function piConfig(env = process.env) {
  let f = {};
  try { const j = JSON.parse(readFileSync(configFile(env), 'utf8')); if (j && typeof j === 'object') f = j; } catch {}
  let command = env.MULTICLAUDE_PI_COMMAND ? words(env.MULTICLAUDE_PI_COMMAND) : strList(f.command);
  if (!command.length) command = ['pi'];
  const args = env.MULTICLAUDE_PI_ARGS ? words(env.MULTICLAUDE_PI_ARGS) : strList(f.args);
  let exclude = env.MULTICLAUDE_PI_EXCLUDE != null
    ? String(env.MULTICLAUDE_PI_EXCLUDE).split(',').map((x) => x.trim()).filter(Boolean)
    : strList(f.exclude);
  if (exclude.includes('none')) exclude = [];
  const CORE = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'powershell']);
  let tools = env.MULTICLAUDE_PI_TOOLS != null
    ? String(env.MULTICLAUDE_PI_TOOLS).split(/[\s,]+/).filter(Boolean)
    : strList(f.tools);
  // Only names: no patterns, no +/- forms, and never a core tool — which of those a run gets is the runner's call.
  tools = tools.includes('none') ? [] : [...new Set(tools.filter((t) => /^[A-Za-z0-9_.-]+$/.test(t) && !CORE.has(t)))];
  const m = String(env.MULTICLAUDE_SHADOW_SHELL || f.shadowShell || 'auto').toLowerCase();
  const shadowShell = SHELL_MODES.includes(m) ? m : 'auto';
  // A sandbox only counts when the command is more than plain pi.
  const sandboxed = f.sandboxed === true && !(command.length === 1 && /(^|[\\/])pi(\.cmd|\.exe)?$/i.test(command[0]));
  return { command, args, exclude, tools, sandboxed, shadowShell, file: configFile(env) };
}
