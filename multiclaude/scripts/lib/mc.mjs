// multiclaude shared helpers — pure Node, cross-platform (Windows / macOS / Linux),
// no shell and no python3 dependency. Imported by setup/probe/usage/usage-snapshot.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = os.homedir();
export const isWin = process.platform === 'win32';

// herdr (a terminal workspace that draws its own agent, job and wallet panels) exports
// HC_TERMINAL_SOCKET (…/herdr-core/….sock) into every pane it runs. Inside it multiclaude
// steps aside: no wallet rows in the status line, no pane that opens by itself.
// MULTICLAUDE_HERDR=1|0 forces the check on / off.
export function inHerdr(env = process.env) {
  const f = String(env.MULTICLAUDE_HERDR || '').toLowerCase();
  if (/^(1|on|true|yes)$/.test(f)) return true;
  if (/^(0|off|false|no)$/.test(f)) return false;
  return /herdr/i.test(env.HC_TERMINAL_SOCKET || env.HC_SOCKET || '');
}

// herdr on Windows + Claude Code in WSL: a herdr pane that starts `wsl.exe … claude` passes
// on only the variables WSLENV names, so without HC_TERMINAL_SOCKET/u:HC_TERMINAL_ID/u:HC_SCOPE/u
// there inHerdr() is false inside WSL. setup check flags it; setup apply (Windows) adds them to
// the user's WSLENV. Inside WSL the socket is then a Windows named pipe (\\.\pipe\herdr-core-…),
// reachable only through hc.exe (WSL interop), never a Linux hc.
export const WSLENV_HC = ['HC_TERMINAL_SOCKET/u', 'HC_TERMINAL_ID/u', 'HC_SCOPE/u'];
export function isWsl(env = process.env) {
  if (isWin) return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}
export const herdrPipe = (env = process.env) => /^\\\\[.?]\\pipe\\/i.test(env.HC_TERMINAL_SOCKET || env.HC_SOCKET || '');
/** The WSLENV_HC entries a WSLENV value lacks (by variable name; any /flags count). */
export function wslenvMissing(value = process.env.WSLENV || '') {
  const have = new Set(String(value).split(':').map((e) => e.split('/')[0]).filter(Boolean));
  return WSLENV_HC.filter((e) => !have.has(e.split('/')[0]));
}

// The herdr-mascots companion (docs/herdr-mascots.md) is on while this flag file exists:
// <config>/multiclaude/herdr-mascots.on — XDG_CONFIG_HOME or ~/.config, %APPDATA% on Windows.
// scripts/herdr-activity.mjs enable|disable writes / removes it (setup companions add|remove).
export function herdrMascotsFlag(env = process.env) {
  const dir = isWin
    ? path.join(env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'multiclaude')
    : path.join(env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'multiclaude');
  return path.join(dir, 'herdr-mascots.on');
}

// Cross-platform `command -v`: search PATH, then the folders CLIs install to that a minimal
// hook PATH may miss, honoring PATHEXT on Windows. Returns absolute path or null.
// A Claude Code started before a CLI was installed keeps the PATH it started with: on Windows
// a miss also searches the user's and the machine's PATH as saved now (registry, read once).
export function which(name) {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const find = (dirs) => {
    for (const dir of dirs) {
      if (!dir) continue;
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* ignore */ }
      }
    }
    return null;
  };
  return find([...(process.env.PATH || '').split(path.delimiter), ...cliDirs()]) || (isWin ? find(savedPath()) : null);
}
// Where the CLIs multiclaude runs put themselves: ~/.local/bin (agy and claude's installers on
// Linux / macOS), Homebrew, and agy's installer on Windows (%LOCALAPPDATA%\agy\bin).
function cliDirs(env = process.env) {
  const dirs = [path.join(HOME, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  if (isWin) dirs.push(path.join(env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'agy', 'bin'));
  return dirs;
}
let saved = null;
function savedPath(env = process.env) {
  if (saved) return saved;
  saved = [];
  const reg = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const expand = (d) => d.replace(/%([^%]+)%/g, (all, v) => env[v] ?? env[Object.keys(env).find((k) => k.toUpperCase() === v.toUpperCase())] ?? all);
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const r = spawnSync(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(r.stdout || '');
      if (m) saved.push(...m[1].trim().split(';').map(expand));
    } catch { /* ignore */ }
  }
  return saved;
}

// Run a command WITHOUT a POSIX shell (so it works where /bin/sh is absent).
// On Windows, .cmd/.bat shims (npx/bunx) need the cmd shell, so we build a quoted
// line and run it through ComSpec; everywhere else we spawn the resolved binary
// directly with an argv array (spaces in args are safe — no quoting needed).
export function run(cmd, args = [], { timeout = 30000, input } = {}) {
  const resolved = path.isAbsolute(cmd) ? cmd : (which(cmd) || cmd);
  const opts = { timeout, input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  let r;
  if (isWin && /\.(cmd|bat)$/i.test(resolved)) {
    const q = (s) => (/[\s"]/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s));
    r = spawnSync([resolved, ...args].map(q).join(' '), { ...opts, shell: true });
  } else {
    r = spawnSync(resolved, args, opts);
  }
  return {
    code: r.status,
    ok: !r.error && r.status === 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error,
  };
}

export function mtimeMs(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

// Newest file under root (recursive) whose basename passes `pred`. Pure JS walk,
// so no GNU `find -printf` dependency.
export function newestFile(root, pred) {
  let best = null, bestM = -1;
  const stack = [root];
  while (stack.length) {
    let ents;
    const d = stack.pop();
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && pred(e.name)) {
        const m = mtimeMs(p);
        if (m > bestM) { bestM = m; best = p; }
      }
    }
  }
  return best;
}

// Humanized duration: minutes-only < 1h, h+m < 1d, d+h ≥ 1d (matches the usage display).
export function fmtDur(sec) {
  sec = Math.floor(sec);
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(sec / 86400)}d${String(Math.floor((sec % 86400) / 3600)).padStart(2, '0')}h`;
}

// 10-cell progress bar.
export function bar(pct) {
  const n = Math.max(0, Math.min(10, Math.round((pct || 0) / 10)));
  return '█'.repeat(n) + '░'.repeat(10 - n);
}
export const EMPTY = '░'.repeat(10);
export const FULL = '█'.repeat(10);

// One shared bar-line layout used by every wallet section so they align.
export function barLine(label, b, pct, status) {
  return `  ${String(label).padEnd(8)} ${b}  ${String(pct).padStart(6)}  · ${status}`;
}

export function nfmt(n) { return Math.round(n).toLocaleString('en-US'); }

function tzAbbr(d) {
  try {
    return Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(d).find((x) => x.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}
export function stamp() {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getHours())}:${z(d.getMinutes())} ${tzAbbr(d)}`;
}
export function dateStamp() {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())} ${tzAbbr(d)}`;
}
