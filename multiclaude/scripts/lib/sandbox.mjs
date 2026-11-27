// The sandbox a shadow's shell runs in (Linux, bubblewrap).
//
// A shadow repeats, unattended, a task another agent is doing for real — and those tasks include
// deploys, pushes and API calls. With a shell, the task text alone would decide what runs. So the
// whole pi process runs inside bwrap:
//   - the filesystem is read-only; writable are only the shadow's worktree (+ its git dir), a private
//     /tmp and pi's own agent dir (its login rotates there);
//   - $HOME is an empty tmpfs with an allowlist bound back read-only (projects, tool installs, git
//     config, CA certs) — no ~/.ssh, no CLI logins (tea, gh, gcloud, azure, incus, govc, docker,
//     Claude, Codex, Bitwarden …), no ansible galaxy token;
//   - /run/user/<uid> (ssh agent, herdr, session sockets) is empty, the docker / containerd
//     sockets are masked, the environment is an allowlist (no SSH_AUTH_SOCK, no tokens);
//   - no_new_privs (bwrap always sets it): sudo and other setuid helpers do not work;
//   - the network stays: pi talks to its model server through it, and research (npm view,
//     docker manifest inspect, curl of a release page) is what the shell is for. Without
//     credentials a command can read the network, not act on anything that needs a login.
// Without bwrap (Windows, macOS, a Linux that forbids user namespaces) a shadow's shell runs in the
// user's own sandbox command or under the guard — see shellTier() below. MULTICLAUDE_SHADOW_SHELL=off
// keeps shadows shell-less; MULTICLAUDE_SANDBOX_RO (paths joined by ':') binds more paths read-only.
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { which } from './mc.mjs';
import { guardEnv } from './guard.mjs';

// $HOME entries bound back read-only, when they exist. Everything else in $HOME is hidden.
export const HOME_READ = [
  'dev', '.pi', '.local/bin', '.local/share/certs', '.local/share/pki', '.local/share/pnpm', '.local/share/uv',
  '.local/share/pipx', '.local/share/billion-context', '.config/billion-context', '.bun', '.yarn', '.dotnet',
  '.gitconfig', '.config/git', '.ansible/collections', '.pki/nssdb',
];
// Entries bound back writable.
export const HOME_WRITE = ['.pi/agent', '.local/share/billion-context'];
// Sockets that would hand out more than a shell should have.
const MASK = ['/run/docker.sock', '/var/run/docker.sock', '/run/containerd/containerd.sock', '/run/podman/podman.sock',
  '/var/lib/incus/unix.socket', '/var/snap/lxd/common/lxd/unix.socket', '/run/libvirt/libvirt-sock'];
// Environment of a shadow run with a shell, in every tier: the guard's allowlist (lib/guard.mjs — no
// agent sockets, no tokens) plus what pi itself needs to reach its model: its own variables and the
// provider settings (`*_API_KEY`, `*_API_BASE`, `*_BASE_URL`), and the names in MULTICLAUDE_SANDBOX_ENV
// (joined by ','). The shell commands pi starts get only the guard's list (pi-guard.ts).
const ENV_PREFIX = ['PI_', 'LITELLM_', 'BILI_', 'ACP_', 'MC_'];
const PROVIDER = /_(API_KEY|API_BASE|BASE_URL)$/i;

let probed = null;
// bwrap on PATH and able to make a user namespace here (not on Windows / macOS, not in a container
// that forbids it). Asked once per process.
export function sandboxReady(env = process.env) {
  if (env.MULTICLAUDE_SHADOW_SHELL === 'off' || process.platform !== 'linux') return null;
  if (probed !== null) return probed || null;
  const bin = which('bwrap');
  probed = false;
  if (bin) {
    const r = spawnSync(bin, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', '--share-net', '--die-with-parent', 'true'], { timeout: 10000 });
    if (r.status === 0) probed = bin;
  }
  return probed || null;
}

// A socket this user may not open needs no mask (and bwrap could not mount over it).
const usable = (p) => { try { accessSync(p, constants.R_OK | constants.W_OK); return true; } catch { return false; } };
const exists = (p) => { try { return existsSync(p); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');

// bwrap argv (no command) for a run in `cwd`. `writable`: paths bound read-write (the worktree, its
// git dir). `readable`: more paths bound read-only (a cwd outside the allowlist). `mounts`: `{ src, dst,
// rw }` binds to another path, in order, after everything else — a later mount covers an earlier one.
// The runner uses them to show a shadow's worktree AT the real checkout's path, which hides the live
// checkout (the real agent's files as they change, its .venv's writes) behind the shadow's own copy.
export function sandboxArgs({ cwd, writable = [], readable = [], mounts = [], env = process.env, home = os.homedir(), uid = process.getuid?.() ?? 1000 }) {
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session'];
  a.push('--tmpfs', `/run/user/${uid}`);
  for (const m of MASK) if (usable(m)) a.push('--ro-bind', '/dev/null', m);
  a.push('--tmpfs', home);
  const extra = String(env.MULTICLAUDE_SANDBOX_RO || '').split(':').filter((p) => p && path.isAbsolute(p));
  const ro = [...HOME_READ.map((p) => path.join(home, p)), ...extra, ...readable];
  for (const p of ro) if (exists(p)) a.push('--ro-bind', p, p);
  // The certificate pi needs to reach its model server may live outside the allowlist.
  if (env.NODE_EXTRA_CA_CERTS && exists(env.NODE_EXTRA_CA_CERTS)) a.push('--ro-bind', env.NODE_EXTRA_CA_CERTS, env.NODE_EXTRA_CA_CERTS);
  for (const p of [...HOME_WRITE.map((p) => path.join(home, p)), ...writable]) if (exists(p)) a.push('--bind', p, p);
  for (const m of mounts) if (m && m.src && m.dst && exists(m.src)) a.push(m.rw ? '--bind' : '--ro-bind', m.src, m.dst);
  // A cwd no bind above covers (a scratchpad under /tmp, a checkout outside ~/dev) is bound read-only.
  const covered = mounts.some((m) => m && m.dst && isDir(m.src) && under(cwd, m.dst))
    || [...ro, ...writable, ...HOME_WRITE.map((p) => path.join(home, p))].some((p) => isDir(p) && under(cwd, p));
  if (!covered && cwd !== '/' && exists(cwd)) a.push('--ro-bind', cwd, cwd);
  a.push('--chdir', cwd, '--setenv', 'TMPDIR', '/tmp');
  return a;
}

// The Claude Code scratchpad paths a task names, to bind read-only into a shadow's sandbox. The real
// agent's task often points at a file it wrote to its session scratchpad (`/tmp/claude-<uid>/<project>/
// <session>/scratchpad/…`); behind the private /tmp a shadow found none of them (seen: six shadows
// failed on a missing scenario file). Only paths the task names and that exist now, at least two levels
// below the root (project / session) — never the root or a project's folder, which would show every
// session's scratchpad — at most `max` of them.
export function scratchPaths(task, { uid = process.getuid?.() ?? 1000, tmp = os.tmpdir(), max = 20 } = {}) {
  const roots = [...new Set(['/tmp', tmp].map((t) => path.join(t, `claude-${uid}`)))];
  const out = [];
  for (const root of roots) {
    const re = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s'"\`<>|*?]+`, 'g');
    for (const m of String(task || '').matchAll(re)) {
      let p = m[0].replace(/[.,;:!?)\]}]+$/, '');
      // `…/scratchpad/plan-clones/` and `…/notes.md:12` name the same thing as without the tail.
      p = p.replace(/:\d+(:\d+)?$/, '');
      p = path.normalize(p).replace(/\/+$/, '');
      if (!under(p, root) || p.split('/').length - root.split('/').length < 2) continue;
      if (!exists(p) || out.includes(p) || out.some((q) => isDir(q) && under(p, q))) continue;
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}

// Copies of the scratchpad paths a task names (scratchPaths above) as they were when the real agent got
// the task (`asOf`, ms), for the runner to bind at the real paths. The real agent goes on writing its
// scratchpad, and a shadow can start hours later (seen: one queued 4 h behind read the results the real
// agent had written since and reported them as its own findings). A file changed after `asOf` is left
// out — a newer copy would give the answer away, and the older one is gone; a dir is copied with the
// files it held then; symlinks and anything not a regular file are left out. Caps: `maxFiles` files and
// `maxBytes` in all, the rest left out. → { mounts: [{ src, dst }], copied, skipped }.
export function freezeScratch(paths, { asOf, dest, maxFiles = 2000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const out = { mounts: [], copied: 0, skipped: 0 };
  if (!asOf || !dest || !Array.isArray(paths)) return out;
  let bytes = 0;
  const copy = (src, to) => {
    const st = lstatSync(src);
    if (!st.isFile() || st.mtimeMs > asOf || out.copied >= maxFiles || bytes + st.size > maxBytes) { out.skipped++; return false; }
    mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(src, to);   // the mode comes along: a helper script stays executable
    try { utimesSync(to, st.atime, st.mtime); } catch { /* the time is a detail */ }
    bytes += st.size; out.copied++;
    return true;
  };
  const walk = (src, to) => {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const a = path.join(src, e.name), b = path.join(to, e.name);
      try { if (e.isDirectory()) walk(a, b); else copy(a, b); } catch { out.skipped++; }
    }
  };
  paths.forEach((p, i) => {
    const to = path.join(dest, String(i), path.basename(p) || 'root');
    try {
      if (lstatSync(p).isDirectory()) { walk(p, to); out.mounts.push({ src: to, dst: p }); }
      else if (copy(p, to)) out.mounts.push({ src: to, dst: p });
    } catch { out.skipped++; }
  });
  return out;
}

export function sandboxEnv(env = process.env) {
  const extra = String(env.MULTICLAUDE_SANDBOX_ENV || '').split(',').map((x) => x.trim()).filter(Boolean);
  const out = guardEnv(env, extra);
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (ENV_PREFIX.some((p) => k.toUpperCase().startsWith(p)) || PROVIDER.test(k)) out[k] = v;
  }
  return out;
}

// How a shadow's shell is held in (the user's `shadowShell` setting, lib/piconfig.mjs):
//   'bwrap'  — the bubblewrap sandbox above (Linux);
//   'custom' — the user's own pi command, declared `sandboxed` in pi.json;
//   'guard'  — no OS sandbox: the pi-guard extension filters the commands (the weaker fallback);
//   null     — no shell.
// auto: bwrap, else the user's sandbox, else the guard · sandbox: bwrap or the user's, never the
// guard · guard: always the guard · off: none. The user's own sandbox goes before bwrap: they chose it.
export function shellTier(cfg, env = process.env) {
  const mode = (cfg && cfg.shadowShell) || 'auto';
  if (mode === 'off') return null;
  if (mode === 'guard') return 'guard';
  if (cfg && cfg.sandboxed) return 'custom';
  if (sandboxReady(env)) return 'bwrap';
  return mode === 'auto' ? 'guard' : null;
}
