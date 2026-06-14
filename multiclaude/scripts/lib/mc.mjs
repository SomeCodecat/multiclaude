// multiclaude shared helpers — pure Node, cross-platform (Windows / macOS / Linux),
// no shell and no python3 dependency. Imported by setup/probe/usage/usage-snapshot.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = os.homedir();
export const isWin = process.platform === 'win32';

// Cross-platform `command -v`: search PATH (+ common CLI dirs that a minimal hook
// PATH may miss) honoring PATHEXT on Windows. Returns absolute path or null.
export function which(name) {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const extra = [path.join(HOME, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  for (const dir of [...dirs, ...extra]) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* ignore */ }
    }
  }
  return null;
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
