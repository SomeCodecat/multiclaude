// Where Claude Code keeps a profile's OAuth login, and how to read / write it.
//
//  * Linux, and Windows until the switch below is on: <config dir>/.credentials.json.
//  * Windows with Credential Manager on: Claude Code (Bun.secrets) keeps it as a
//    GENERIC credential, target "<service>/claude-code-user", UserName
//    "claude-code-user", the value as raw UTF-8, persist ENTERPRISE. The file is
//    then only a fallback: Claude Code reads Credential Manager first, and its
//    first write there deletes the file.
//      - on when CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1, or the profile's global
//        config has cachedGrowthBookFeatures.tengu_windows_credman === true
//        (a server-side flag Claude Code caches; it can turn on by itself).
//      - service: "Claude Code-credentials", plus "-<first 8 hex of
//        sha256(config dir)>" when that Claude Code runs with CLAUDE_CONFIG_DIR
//        (CLAUDE_SECURESTORAGE_CONFIG_DIR overrides both).
//      - a value over 2400 UTF-8 bytes is stored base64 in 2400-char chunks
//        "#0".."#n-1" with "#m" = {"n":n,"l":length}; "#p" marks a write in
//        progress. Same layout as Claude Code 2.1.318, so either side reads the
//        other's writes.
//    Node has no Credential Manager API, so this goes through one PowerShell
//    call per batch (advapi32 CredReadW / CredWriteW / CredDeleteW via Add-Type).
//
// MULTICLAUDE_CREDMAN_FAKE=<file.json> swaps the Windows backend for a JSON
// file on any platform (tests and dry runs off Windows).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const FAKE = process.env.MULTICLAUDE_CREDMAN_FAKE || '';
const isWin = process.platform === 'win32';
const ACCOUNT = 'claude-code-user';
const CHUNK = 2400, MAX_CHUNKS = 256;

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// Claude Code's own rule for its global config: <dir>/.config.json when non-empty, else
// (CLAUDE_CONFIG_DIR || home)/.claude.json. `cfgPath` is passed in when the caller knows it.
export function credmanOn({ cfgPath } = {}) {
  if (!isWin && !FAKE) return false;
  if (process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === '1') return true;
  const t = cfgPath ? readText(cfgPath) : null;
  if (!t) return false;
  try { return JSON.parse(t)?.cachedGrowthBookFeatures?.tengu_windows_credman === true; } catch { return false; }
}

// `viaEnv`: that Claude Code runs with CLAUDE_CONFIG_DIR set to `dir` (session
// profiles always; the default login only when the env var is set).
export function credService(dir, { viaEnv }) {
  const sec = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const hashed = sec !== undefined ? !!sec : viaEnv;
  const base = sec !== undefined && sec ? sec : dir;
  const suffix = hashed ? '-' + createHash('sha256').update(String(base).normalize('NFC')).digest('hex').slice(0, 8) : '';
  return `Claude Code-credentials${suffix}`;
}

// ── the Credential Manager bridge ────────────────────────────────────────────
// ops: [{op:'read', target}] → {ok, b64|null}; [{op:'write', target, user, b64}];
// [{op:'delete', target}] → {ok, deleted}. One process per batch; ops run in order.
const PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class McCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", SetLastError = false)]
  static extern void CredFree(IntPtr p);
  const int NOT_FOUND = 1168;
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == NOT_FOUND) return null;
      throw new System.ComponentModel.Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      if (b.Length > 0) Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Convert.ToBase64String(b);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string user, string b64) {
    byte[] b = Convert.FromBase64String(b64);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 3;
    c.CredentialBlobSize = (uint)b.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(b.Length, 1));
    try {
      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
      if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int i = 0; i < b.Length; i++) Marshal.WriteByte(c.CredentialBlob, i, 0);
      Marshal.FreeHGlobal(c.CredentialBlob);
    }
  }
  public static bool Delete(string target) {
    if (CredDelete(target, 1, 0)) return true;
    int e = Marshal.GetLastWin32Error();
    if (e == NOT_FOUND) return false;
    throw new System.ComponentModel.Win32Exception(e);
  }
}
'@
$ops = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = New-Object System.Collections.ArrayList
foreach ($o in $ops) {
  try {
    switch ($o.op) {
      'read'   { [void]$out.Add(@{ ok = $true; b64 = [McCred]::Read($o.target) }) }
      'write'  { [McCred]::Write($o.target, $o.user, $o.b64); [void]$out.Add(@{ ok = $true }) }
      'delete' { [void]$out.Add(@{ ok = $true; deleted = [McCred]::Delete($o.target) }) }
      default  { [void]$out.Add(@{ ok = $false; err = "unknown op $($o.op)" }) }
    }
  } catch { [void]$out.Add(@{ ok = $false; err = $_.Exception.Message }) }
}
[Console]::Out.Write((ConvertTo-Json -InputObject $out.ToArray() -Compress -Depth 3))
`;

function fakeRun(ops) {
  let db = {};
  try { db = JSON.parse(readFileSync(FAKE, 'utf8')); } catch { /* new */ }
  const out = ops.map((o) => {
    if (o.op === 'read') return { ok: true, b64: o.target in db ? db[o.target].b64 : null };
    if (o.op === 'write') { db[o.target] = { user: o.user, b64: o.b64 }; return { ok: true }; }
    if (o.op === 'delete') { const had = o.target in db; delete db[o.target]; return { ok: true, deleted: had }; }
    return { ok: false, err: `unknown op ${o.op}` };
  });
  mkdirSync(path.dirname(FAKE), { recursive: true });
  writeFileSync(FAKE + '.tmp', JSON.stringify(db, null, 2), { mode: 0o600 });
  renameSync(FAKE + '.tmp', FAKE);
  return out;
}

function credman(ops) {
  if (!ops.length) return [];
  if (FAKE) return fakeRun(ops);
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(existsSync(exe) ? exe : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')],
    { input: JSON.stringify(ops), encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 16 << 20 });
  if (r.error) throw new Error(`Windows Credential Manager: could not run PowerShell (${r.error.message})`);
  let out;
  try { out = JSON.parse(String(r.stdout).trim()); } catch {
    throw new Error(`Windows Credential Manager: PowerShell failed (exit ${r.status}): ${String(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' ')}`);
  }
  out = Array.isArray(out) ? out : [out];
  const bad = out.find((x) => !x.ok);
  if (bad) throw new Error(`Windows Credential Manager: ${bad.err}`);
  return out;
}

const target = (service, name) => `${service}/${name}`;
const nameOf = (i) => `${ACCOUNT}#${i}`;
const utf8 = (b64) => (b64 == null ? null : Buffer.from(b64, 'base64').toString('utf8'));
function metaOf(text) {
  try {
    const { n, l } = JSON.parse(text);
    if (Number.isInteger(n) && Number.isInteger(l) && n > 0 && n <= MAX_CHUNKS && l > 0 && l <= n * CHUNK) return { n, l };
  } catch { /* not meta */ }
  return null;
}

// Mirror of Claude Code's chunked read: "#m" first, else the plain entry.
export function credmanRead(service) {
  const [plain, m] = credman([{ op: 'read', target: target(service, ACCOUNT) }, { op: 'read', target: target(service, nameOf('m')) }]);
  const meta = m.b64 == null ? null : metaOf(utf8(m.b64));
  if (!meta) return utf8(plain.b64);
  const parts = credman(Array.from({ length: meta.n }, (_, i) => ({ op: 'read', target: target(service, nameOf(i)) })));
  if (parts.some((p) => p.b64 == null)) throw new Error('Windows Credential Manager: chunked login is missing a part');
  const joined = parts.map((p) => utf8(p.b64)).join('');
  if (joined.length !== meta.l) throw new Error(`Windows Credential Manager: chunked login is inconsistent (${joined.length} of ${meta.l})`);
  return Buffer.from(joined, 'base64').toString('utf8');
}

// Mirror of Claude Code's chunked write, in one batch.
export function credmanWrite(service, text) {
  const [m] = credman([{ op: 'read', target: target(service, nameOf('m')) }]);
  const prev = m.b64 == null ? null : metaOf(utf8(m.b64));
  const w = (name, value) => ({ op: 'write', target: target(service, name), user: name, b64: Buffer.from(String(value), 'utf8').toString('base64') });
  const del = (name) => ({ op: 'delete', target: target(service, name) });
  const ops = [];
  if (Buffer.byteLength(text, 'utf8') <= CHUNK) {
    ops.push(w(ACCOUNT, text));
    if (prev) {
      ops.push(w(nameOf('p'), String(prev.n)), del(nameOf('m')));
      for (let i = 0; i < prev.n; i++) ops.push(del(nameOf(i)));
      ops.push(del(nameOf('p')));
    }
  } else {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const n = Math.ceil(b64.length / CHUNK);
    if (n > MAX_CHUNKS) throw new Error(`login too large for Windows Credential Manager (${b64.length} B)`);
    ops.push(w(nameOf('p'), String(Math.max(prev?.n ?? 0, n))));
    for (let i = 0; i < n; i++) ops.push(w(nameOf(i), b64.slice(i * CHUNK, (i + 1) * CHUNK)));
    ops.push(w(nameOf('m'), JSON.stringify({ n, l: b64.length })), del(ACCOUNT));
    for (let i = n; i < (prev?.n ?? 0); i++) ops.push(del(nameOf(i)));
    ops.push(del(nameOf('p')));
  }
  credman(ops);
}

// ── a login the host hands in ────────────────────────────────────────────────
// The Claude desktop app (and SDK hosts) start Claude Code with the login in
// the environment — a token, a file descriptor or a host-auth hand-off — and
// Claude Code stores nothing: no .credentials.json, no Credential Manager
// entry. There is no refresh token to store or swap, so accounts cannot manage
// that session's login; the host's own sign-in decides the account.
// Claude Code strips those variables from every process it spawns (plugin
// scripts included), so usually only CLAUDE_CODE_ENTRYPOINT gets through:
// 'claude-desktop' with no stored login means the app holds it.
// Returns the variable NAMES that are set (never their values).
const HOST_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export function hostLogin(env = process.env) {
  const vars = HOST_VARS.filter((k) => (env[k] || '').trim() !== '');
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT || null;
  return { entrypoint, vars, desktop: entrypoint === 'claude-desktop' };
}
// Only call this when no stored login was found.
// The desktop app's own sign-in is a claude.ai web session in the app's
// encrypted browser profile (Windows: %LOCALAPPDATA%\Claude-Data\<package>),
// not an OAuth refresh token — nothing accounts could store or swap either.
export const POOL_HINT = 'To pool several accounts (switch, auto-switch), run `claude` in a terminal or the VS Code extension, where Claude Code stores its own login: /login there, then `accounts add`';
export function hostLoginNote(h = hostLogin()) {
  if (h.vars.length) return `this Claude Code session gets its login from its host${h.entrypoint ? ` (${h.entrypoint})` : ''} via ${h.vars.join(', ')}, and Claude Code stores none, so there is nothing to store or switch here — the host's own sign-in decides the account. ${POOL_HINT}`;
  if (h.desktop) return `this session runs in the Claude desktop app. The app signs Claude Code in with its own login and Claude Code stores none; the app keeps that sign-in as a claude.ai web session in its own encrypted profile, not as a token accounts could store or switch. Change the account in the app with its own sign-out / sign-in. ${POOL_HINT}`;
  return '';
}

// ── the login of one Claude config dir ───────────────────────────────────────
// opts: { cfgPath, viaEnv }. Returns { text, where } — where is a human label.
export function loginStore(dir, opts) {
  const file = path.join(dir, '.credentials.json');
  if (credmanOn(opts)) {
    const service = credService(dir, opts);
    return {
      kind: 'credman', service, file,
      where: `Windows Credential Manager (${target(service, ACCOUNT)})`,
      // Claude Code reads Credential Manager first and falls back to the file.
      read() { return credmanRead(service) ?? readText(file); },
      write(text) { credmanWrite(service, text); },
    };
  }
  // Credential Manager can hold the login while the cached flag reads off (it
  // is server-side and may lag); look there before calling the login missing.
  if ((isWin || FAKE) && !/claudeAiOauth/.test(readText(file) || '')) {
    const service = credService(dir, opts);
    let found = null;
    try { found = credmanRead(service); } catch { /* PowerShell unavailable: stay on the file */ }
    if (found) return {
      kind: 'credman', service, file,
      where: `Windows Credential Manager (${target(service, ACCOUNT)})`,
      read() { return credmanRead(service) ?? readText(file); },
      write(text) { credmanWrite(service, text); },
    };
  }
  return {
    kind: 'file', file, where: file,
    read() { return readText(file); },
    write(text, atomicWrite) { atomicWrite(file, text); },
  };
}
