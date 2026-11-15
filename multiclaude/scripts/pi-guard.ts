// pi extension (TypeScript only so that pi's loader maps the import of its own package): the guard of a shadow's shell (rules in lib/guard.mjs). The runner loads it with
// `pi -e <this file>` and passes its settings in MC_GUARD (JSON):
//   { writable: [paths], commands: true|false, env: [extra names a command may see] }
// - bash / powershell are registered again with a spawn hook that gives each command the guard's
//   environment allowlist;
// - `commands: true` (the guard tier — no OS sandbox) also refuses logins, deploys, pushes and
//   remote changes, and redirects outside the writable roots;
// - edit / write outside the writable roots are refused in every tier.
// Fail closed: a handler that throws blocks the call (pi's rule), and when pi's tool factories cannot
// be loaded every shell call is refused.
import os from 'node:os';
import { blockedCommand, writableAt, writeOutside, guardEnv } from './lib/guard.mjs';

export default async function guard(pi: any) {
  let cfg: any = {};
  try { cfg = JSON.parse(process.env.MC_GUARD || '{}') || {}; } catch {}
  const roots = Array.isArray(cfg.writable) ? cfg.writable : [];
  const extra = Array.isArray(cfg.env) ? cfg.env : [];
  const cwd = process.cwd();
  let lib: any = null;
  // Literal specifiers: pi's loader (jiti) maps them onto the running pi's own package.
  try { lib = await import('@earendil-works/pi-coding-agent'); } catch {
    try { lib = await import('@mariozechner/pi-coding-agent'); } catch {}
  }
  const hook = ({ command, cwd: at, env }: any) => ({ command, cwd: at, env: guardEnv(env, extra) });
  const shells = new Set(['bash', 'powershell']);
  if (lib && lib.createBashTool) {
    const wrap = (t: any) => ({ ...t, execute: (id: any, p: any, s: any, u: any) => t.execute(id, p, s, u) });
    pi.registerTool(wrap(lib.createBashTool(cwd, { spawnHook: hook })));
    if (lib.createPowerShellTool) pi.registerTool(wrap(lib.createPowerShellTool(cwd, { spawnHook: hook })));
    else shells.delete('powershell');
  }
  pi.on('tool_call', async (event: any) => {
    const name = event.toolName;
    const input = event.input || {};
    if (name === 'edit' || name === 'write') {
      if (!input.path || !writableAt(input.path, cwd, roots)) return { block: true, reason: `guard: ${input.path} is outside the shadow's worktree — write only there` };
      return undefined;
    }
    if (name === 'bash' || name === 'powershell') {
      if (!lib || !shells.has(name)) return { block: true, reason: 'guard: the shell is off — the guard could not load pi\'s shell tools' };
      if (!cfg.commands) return undefined;
      const cmd = String(input.command || '');
      const why = blockedCommand(cmd);
      if (why) return { block: true, reason: `guard: ${why}` };
      const out = writeOutside(cmd, cwd, [...roots, os.tmpdir()]);
      if (out) return { block: true, reason: `guard: writing to ${out} is not allowed — only the worktree and the temp dir` };
    }
    return undefined;
  });
}
