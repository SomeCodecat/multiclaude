// multiclaude Claude accounts: several Claude Code logins that count as ONE
// Claude wallet. The design follows claude-swap (MIT, (c) 2026 Onur Cetinkol,
// https://github.com/realiti4/claude-swap), rewritten in pure Node with a
// smaller scope: add/list/switch, per-account usage, auto-switch, and
// per-terminal session profiles. See THIRD_PARTY_NOTICES.md.
//
// Rules this module follows:
//  * Each refresh token has ONE owner at a time, and nothing else refreshes it.
//    The live login (~/.claude/.credentials.json) owns the active account, a
//    running session profile owns its account, and the backup in our store
//    owns every other account. A rotated token is adopted back into the backup
//    when its owner lets go (on a switch-away or when a session ends).
//  * Changes to Claude Code's files are made under Claude Code's own
//    proper-lockfile directory locks (credential refresh + global config), so a
//    swap never lands in the middle of one of its token refreshes. The network
//    is never used while those locks are held.
//  * Every write is atomic (temp file + rename) with mode 0600. A live
//    credential the store does not manage is stashed before it is overwritten.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync, statSync, lstatSync,
  utimesSync, existsSync, readdirSync, realpathSync, chmodSync, symlinkSync, copyFileSync, cpSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── paths ────────────────────────────────────────────────────────────────────
export const STORE = process.env.MULTICLAUDE_ACCOUNTS_DIR || (isWin
  ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'multiclaude', 'accounts')
  : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'multiclaude', 'accounts'));
const P = {
  index: path.join(STORE, 'accounts.json'),
  config: path.join(STORE, 'config.json'),
  usage: path.join(STORE, 'usage.json'),
  creds: (n) => path.join(STORE, 'creds', `${n}.json`),
  oauth: (n) => path.join(STORE, 'oauth', `${n}.json`),
  stash: path.join(STORE, 'stash'),
  sessions: path.join(STORE, 'sessions'),
  session: (n) => path.join(STORE, 'sessions', String(n)),
  lock: path.join(STORE, '.lock'),
  switches: path.join(STORE, 'switches.jsonl'),
};

// The DEFAULT Claude profile: the one every terminal and the IDE use. When we
// run inside one of our own session profiles, CLAUDE_CONFIG_DIR points there;
// the default profile is still the target.
function claudeHome() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && !path.resolve(env).startsWith(path.resolve(P.sessions))) return env;
  return path.join(HOME, '.claude');
}
function claudeHomeIsDefault() { return claudeHome() === path.join(HOME, '.claude'); }
const credsPath = () => path.join(claudeHome(), '.credentials.json');
// Claude Code reads <home>/.config.json when it is a non-empty regular file
// (or an empty, writable one with no .claude.json), else (CLAUDE_CONFIG_DIR || $HOME)/.claude.json.
function globalConfigPath() {
  const home = claudeHome();
  const legacy = path.join(home, '.config.json');
  const global = path.join(claudeHomeIsDefault() ? HOME : home, '.claude.json');
  try {
    const st = statSync(legacy);
    if (st.isFile() && (st.size > 0 || ((st.mode & 0o222) && !existsSync(global)))) return legacy;
  } catch { /* absent */ }
  return global;
}

// ── fs helpers ───────────────────────────────────────────────────────────────
function ensureDir(d) { mkdirSync(d, { recursive: true, mode: 0o700 }); }
function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p, dflt = null) { const t = readText(p); if (t == null) return dflt; try { return JSON.parse(t); } catch { return dflt; } }
// Atomic write that follows a symlinked target (Claude Code writes through a
// symlinked ~/.claude.json, so must we) and keeps the target's mode.
function atomicWrite(p, text, { keepMode = false } = {}) {
  let target = p;
  try { target = realpathSync(p); } catch { /* new file */ }
  ensureDir(path.dirname(target));
  let m = 0o600;   // credentials and our store: always owner-only
  if (keepMode) { try { m = statSync(target).mode & 0o777; } catch { /* new file */ } }
  const tmp = `${target}.mc-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, text, { mode: m });
  try { if (!isWin) chmodSync(tmp, m); renameSync(tmp, target); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
}
const writeJson = (p, v) => atomicWrite(p, JSON.stringify(v, null, 2) + '\n');

// ── locks (npm proper-lockfile protocol: the lock is a directory) ────────────
// Claude Code's credential locks are stale after 60 s, its config lock after 10 s;
// a live holder touches the dir every 5 s. Takeovers of a dead holder's lock are
// serialized through a sibling <lock>.takeover dir.
async function acquireDir(dir, { stale, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { mkdirSync(dir); break; }
    catch (e) {
      if (e.code === 'ENOENT') { ensureDir(path.dirname(dir)); continue; }
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - statSync(dir).mtimeMs; } catch { continue; }
      if (age > stale) {
        const tk = dir + '.takeover';
        try {
          mkdirSync(tk);
          try { if (Date.now() - statSync(dir).mtimeMs > stale) rmdirSync(dir); } catch { /* gone or retaken */ }
          finally { try { rmdirSync(tk); } catch { /* ignore */ } }
          continue;
        } catch {
          try { if (Date.now() - statSync(tk).mtimeMs > 5000) rmdirSync(tk); } catch { /* ignore */ }
        }
      }
      if (Date.now() > deadline) throw new Error(`lock busy: ${dir} (held by another process; retry in a moment)`);
      await sleep(150 + Math.random() * 250);
    }
  }
  const touch = setInterval(() => { try { const t = new Date(); utimesSync(dir, t, t); } catch { /* ignore */ } }, 3000);
  touch.unref?.();
  return () => { clearInterval(touch); try { rmdirSync(dir); } catch { /* ignore */ } };
}
// Hold every lock in `specs` (in order) for fn(); release in reverse.
async function withLocks(specs, fn) {
  const held = [];
  try {
    for (const s of specs) held.push(await acquireDir(s.dir, s));
    return await fn();
  } finally { for (const r of held.reverse()) r(); }
}
const STORE_LOCK = () => ({ dir: P.lock, stale: 120_000, timeoutMs: 30_000 });
const CLAUDE_LOCKS = () => {
  const home = claudeHome();
  const cfg = globalConfigPath();
  return [
    { dir: path.join(home, '.oauth_refresh.lock'), stale: 60_000, timeoutMs: 9000 },
    { dir: path.join(path.dirname(home), path.basename(home) + '.lock'), stale: 60_000, timeoutMs: 9000 },
    { dir: cfg + '.lock', stale: 10_000, timeoutMs: 9000 },
  ];
};

// ── store ────────────────────────────────────────────────────────────────────
export const DEFAULT_CONFIG = {
  auto: {
    enabled: false,       // opt-in (onboarding): the module's tick runs `auto --once` only when on and ≥2 accounts are usable
    threshold: 90,        // switch-away line for the 5h window (and the weekly one, if weeklyThreshold is null)
    weeklyThreshold: null,
    strategy: 'best',     // best | consume-first
    cooldownSec: 300,
    margin: 5,            // a proactive switch needs this many points more room than the active account
    model: null,          // fold a per-model weekly window into the decision, e.g. "Opus"
  },
  run: { shareHistory: false },
};
export function loadConfig() {
  const c = readJson(P.config, {});
  return { auto: { ...DEFAULT_CONFIG.auto, ...(c.auto || {}) }, run: { ...DEFAULT_CONFIG.run, ...(c.run || {}) } };
}
export function setConfig(key, raw) {
  const c = readJson(P.config, {});
  const [sec, k] = key.split('.');
  if (!DEFAULT_CONFIG[sec] || !(k in DEFAULT_CONFIG[sec])) throw new Error(`unknown setting ${key} (known: ${Object.entries(DEFAULT_CONFIG).flatMap(([s, o]) => Object.keys(o).map((x) => `${s}.${x}`)).join(', ')})`);
  let v = raw;
  if (raw === 'null' || raw === '') v = null;
  else if (raw === 'true' || raw === 'false') v = raw === 'true';
  else if (/^-?\d+(\.\d+)?$/.test(raw)) v = Number(raw);
  if (k === 'strategy' && !['best', 'consume-first'].includes(v)) throw new Error('auto.strategy is best | consume-first');
  if (/threshold$/i.test(k) && v != null && !(v >= 50 && v <= 100)) throw new Error(`${key} must be 50–100`);
  c[sec] = { ...(c[sec] || {}), [k]: v };
  ensureDir(STORE);
  writeJson(P.config, c);
  return loadConfig();
}

function loadIndex() { return readJson(P.index, null) || { version: 1, accounts: {}, lastSwitchAt: 0 }; }
function saveIndex(ix) { ensureDir(STORE); writeJson(P.index, ix); }
const nums = (ix) => Object.keys(ix.accounts).map(Number).sort((a, b) => a - b).map(String);

// ── credential helpers ───────────────────────────────────────────────────────
function oauthOf(text) { try { return JSON.parse(text).claudeAiOauth || null; } catch { return null; } }
const expiresAt = (text) => oauthOf(text)?.expiresAt || 0;
function liveIdentity() {
  const o = readJson(globalConfigPath(), {})?.oauthAccount;
  if (!o || !o.emailAddress) return null;
  return { email: o.emailAddress, orgUuid: o.organizationUuid || '', accountUuid: o.accountUuid || '', oauthAccount: o };
}
const sameIdent = (a, b) => !!a && !!b && a.email.toLowerCase() === b.email.toLowerCase() && (a.orgUuid || '') === (b.orgUuid || '');
function slotOf(ix, ident) { return ident ? nums(ix).find((n) => sameIdent(ix.accounts[n], ident)) || null : null; }
export function activeSlot(ix = loadIndex()) { return slotOf(ix, liveIdentity()); }

export function resolve(ix, id) {
  if (id == null || id === '') throw new Error('which account? give a number, email or alias');
  const s = String(id);
  if (ix.accounts[s]) return s;
  const hit = nums(ix).find((n) => ix.accounts[n].email.toLowerCase() === s.toLowerCase() || (ix.accounts[n].alias && ix.accounts[n].alias === s));
  if (!hit) throw new Error(`no account "${s}" — see: accounts list`);
  return hit;
}

function stash(text, reason) {
  ensureDir(P.stash);
  const f = path.join(P.stash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}.json`);
  atomicWrite(f, text);
  return f;
}

// ── session profiles: liveness + adopting their rotated token ────────────────
function sessionPids(n) {
  const d = path.join(P.session(n), '.mc-pids');
  let names = [];
  try { names = readdirSync(d); } catch { return []; }
  const live = [];
  for (const nm of names) {
    const pid = Number(nm);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) live.push(pid); else { try { rmSync(path.join(d, nm), { force: true }); } catch { /* ignore */ } }
  }
  return live;
}
export const hasLiveSession = (n) => sessionPids(n).length > 0;
// A quiescent profile whose token rotated past the backup: copy it back.
function adoptProfileLocked(n) {
  if (hasLiveSession(n)) return false;
  const prof = readText(path.join(P.session(n), '.credentials.json'));
  const back = readText(P.creds(n));
  if (!prof || !oauthOf(prof)?.refreshToken || prof === back) return false;
  if (expiresAt(prof) <= expiresAt(back || '')) return false;
  atomicWrite(P.creds(n), prof);
  return true;
}

// ── add / remove / meta ──────────────────────────────────────────────────────
export async function addAccount({ slot, alias } = {}) {
  ensureDir(STORE);
  return withLocks([STORE_LOCK(), ...CLAUDE_LOCKS()], async () => {
    const text = readText(credsPath());
    const ident = liveIdentity();
    if (!ident) throw new Error(`no logged-in Claude account found in ${globalConfigPath()} — log in with \`claude\` (/login) first`);
    if (!text || !oauthOf(text)?.refreshToken) throw new Error(`no OAuth credential in ${credsPath()} (API-key logins and the macOS Keychain are not supported)`);
    const ix = loadIndex();
    let n = slotOf(ix, ident);
    const existed = !!n;
    if (!n) {
      n = slot ? String(slot) : String(Math.max(0, ...nums(ix).map(Number)) + 1);
      if (ix.accounts[n]) throw new Error(`slot ${n} holds ${ix.accounts[n].email}; remove it first or pick another --slot`);
    }
    if (alias && nums(ix).some((m) => m !== n && ix.accounts[m].alias === alias)) throw new Error(`alias "${alias}" is taken`);
    const prev = ix.accounts[n] || {};
    ix.accounts[n] = {
      email: ident.email, orgUuid: ident.orgUuid, accountUuid: ident.accountUuid,
      orgName: ident.oauthAccount.organizationName || '', plan: oauthOf(text).subscriptionType || prev.plan || '',
      alias: alias || prev.alias || '', disabled: prev.disabled || false, threshold: prev.threshold ?? null,
      addedAt: prev.addedAt || Date.now(), dead: false,
    };
    atomicWrite(P.creds(n), text);
    writeJson(P.oauth(n), ident.oauthAccount);
    saveIndex(ix);
    return { slot: n, email: ident.email, updated: existed };
  });
}

export async function removeAccount(id) {
  return withLocks([STORE_LOCK()], async () => {
    const ix = loadIndex();
    const n = resolve(ix, id);
    if (hasLiveSession(n)) throw new Error(`account ${n} has a running session (PID ${sessionPids(n).join(', ')}); exit it first`);
    const email = ix.accounts[n].email;
    delete ix.accounts[n];
    for (const f of [P.creds(n), P.oauth(n)]) rmSync(f, { force: true });
    rmSync(P.session(n), { recursive: true, force: true });
    const u = readJson(P.usage, {}); delete u[n]; writeJson(P.usage, u);
    saveIndex(ix);
    return { slot: n, email };
  });
}

export async function setMeta(id, patch) {
  return withLocks([STORE_LOCK()], async () => {
    const ix = loadIndex();
    const n = resolve(ix, id);
    if (patch.alias && nums(ix).some((m) => m !== n && ix.accounts[m].alias === patch.alias)) throw new Error(`alias "${patch.alias}" is taken`);
    if ('threshold' in patch && patch.threshold != null && !(patch.threshold >= 50 && patch.threshold <= 100)) throw new Error('threshold must be 50–100');
    Object.assign(ix.accounts[n], patch);
    saveIndex(ix);
    return { slot: n, ...ix.accounts[n] };
  });
}

// ── switch ───────────────────────────────────────────────────────────────────
// Capture the live credential into its slot (it may have rotated since we
// stored it), then activate the target's credential and identity. Local I/O
// only while Claude Code's locks are held.
export async function switchTo(id, { reason = 'manual', force = false } = {}) {
  return withLocks([STORE_LOCK()], async () => {
    let ix = loadIndex();
    const n = resolve(ix, id);
    const acct = ix.accounts[n];
    if (acct.dead && !force) throw new Error(`account ${n} (${acct.email}) has a dead refresh token — log in with it and run: accounts add`);
    if (hasLiveSession(n)) throw new Error(`account ${n} has a running session profile (PID ${sessionPids(n).join(', ')}); using it as the default login too would make one copy's token go stale. Exit that session first.`);
    adoptProfileLocked(n);
    const targetCreds = readText(P.creds(n));
    const targetOauth = readJson(P.oauth(n));
    if (!targetCreds || !targetOauth) throw new Error(`account ${n} has no stored credential — log in with it and run: accounts add`);

    return withLocks(CLAUDE_LOCKS(), async () => {
      ix = loadIndex();
      const ident = liveIdentity();
      const from = slotOf(ix, ident);
      if (from === n) return { from, to: n, email: acct.email, noop: true };
      // Every open Claude session runs the auto tick; the first to switch wins.
      if (reason.startsWith('auto') && Date.now() - (ix.lastSwitchAt || 0) < 60_000) return { from, to: from, email: acct.email, noop: true, raced: true };
      const liveText = readText(credsPath());
      const cfgPath = globalConfigPath();
      const cfgText = readText(cfgPath);
      if (from && liveText && oauthOf(liveText)) {
        atomicWrite(P.creds(from), liveText);
        writeJson(P.oauth(from), ident.oauthAccount);
      } else if (liveText && liveText !== targetCreds) {
        stash(liveText, 'displaced-live-login');
      }
      let cfg = {};
      if (cfgText) { try { cfg = JSON.parse(cfgText); } catch { throw new Error(`${cfgPath} is not valid JSON — not touching it`); } }
      try {
        atomicWrite(credsPath(), targetCreds);
        cfg.oauthAccount = targetOauth;
        atomicWrite(cfgPath, JSON.stringify(cfg, null, 2), { keepMode: true });
      } catch (e) {
        if (liveText != null) { try { atomicWrite(credsPath(), liveText); } catch { /* best effort */ } }
        if (cfgText != null) { try { atomicWrite(cfgPath, cfgText, { keepMode: true }); } catch { /* best effort */ } }
        throw new Error(`switch failed and was rolled back: ${e.message}`);
      }
      ix.lastSwitchAt = Date.now();
      ix.lastSwitch = { from, to: n, reason, at: ix.lastSwitchAt };
      saveIndex(ix);
      // The usage tracker attributes the default profile's transcripts to accounts by this log.
      try { appendFileSync(P.switches, JSON.stringify(ix.lastSwitch) + '\n', { mode: 0o600 }); } catch { /* best effort */ }
      return { from, to: n, email: acct.email, noop: false };
    });
  });
}

// ── usage ────────────────────────────────────────────────────────────────────
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TTL_ACTIVE = 60_000, TTL_OTHER = 300_000;

async function refreshGrant(text) {
  const o = oauthOf(text);
  if (!o?.refreshToken) return { error: 'no-refresh-token', dead: true };
  let res;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-cli' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: OAUTH_CLIENT_ID }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { return { error: 'network' }; }
  let body = {}; try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    // Permanent only on an explicit RFC 6749 verdict; anything else is retried later.
    const dead = [400, 401, 403].includes(res.status) && body?.error === 'invalid_grant';
    return { error: dead ? 'invalid_grant' : `http-${res.status}`, dead };
  }
  const d = JSON.parse(text);
  d.claudeAiOauth = { ...o, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}), ...(body.scope ? { scopes: body.scope.split(' ') } : {}) };
  return { text: JSON.stringify(d) };
}

function parseUsage(d) {
  const win = (w) => (w && typeof w.utilization === 'number' ? { pct: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null } : null);
  const scoped = [];
  for (const lim of Array.isArray(d.limits) ? d.limits : []) {
    const name = lim?.scope?.model?.display_name;
    if (name && typeof lim.percent === 'number') scoped.push({ name, pct: lim.percent, resetsAt: lim.resets_at ? Date.parse(lim.resets_at) : null });
  }
  for (const [k, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]) {
    const w = win(d[k]);
    if (w && !scoped.some((s) => s.name.toLowerCase() === name.toLowerCase())) scoped.push({ name, ...w });
  }
  return { fiveHour: win(d.five_hour), sevenDay: win(d.seven_day), scoped };
}

async function getUsage(accessToken) {
  let res;
  try {
    res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli' }, signal: AbortSignal.timeout(8000) });
  } catch { return { error: 'network' }; }
  if (!res.ok) return { error: `http-${res.status}`, retryAfter: Number(res.headers.get('retry-after')) || null };
  try { return { usage: parseUsage(await res.json()) }; } catch { return { error: 'bad-response' }; }
}

// Read one account's usage with the credential its current OWNER holds.
async function fetchOne(n, ix, active) {
  const live = hasLiveSession(n);
  let text, owner;
  if (n === active) { text = readText(credsPath()); owner = 'live'; }
  else if (live) { text = readText(path.join(P.session(n), '.credentials.json')); owner = 'session'; }
  else { text = readText(P.creds(n)); owner = 'backup'; }
  const o = oauthOf(text || '');
  if (!o?.accessToken) return { error: 'no-credential' };
  if ((o.expiresAt || 0) > Date.now() + 60_000) return getUsage(o.accessToken);
  // Expired. Only the backup's owner (us) may refresh it; the live login and a
  // session refresh on their next request.
  if (owner !== 'backup') return { error: 'token-expired (refreshes on next use)' };
  return withLocks([STORE_LOCK()], async () => {
    if (activeSlot(loadIndex()) === n || hasLiveSession(n)) return { error: 'owner changed; retry' };
    const cur = readText(P.creds(n));
    if (cur !== text) { const oc = oauthOf(cur || ''); return oc?.accessToken && oc.expiresAt > Date.now() + 60_000 ? getUsage(oc.accessToken) : { error: 'credential changed; retry' }; }
    const r = await refreshGrant(cur);
    if (r.text) { atomicWrite(P.creds(n), r.text); return getUsage(oauthOf(r.text).accessToken); }
    if (r.dead) { const ix2 = loadIndex(); if (ix2.accounts[n]) { ix2.accounts[n].dead = true; saveIndex(ix2); } }
    return { error: r.error, dead: r.dead };
  });
}

// Refresh the usage cache. TTL-gated per account (60 s active, 5 min others,
// longer after a 429) unless `force`. Returns the merged cache.
export async function refreshUsage({ force = false, only = null } = {}) {
  const ix = loadIndex();
  const active = activeSlot(ix);
  const cache = readJson(P.usage, {});
  const now = Date.now();
  const due = nums(ix).filter((n) => {
    if (only && !only.includes(n)) return false;
    const c = cache[n];
    if (!c) return true;
    if (c.backoffUntil && now < c.backoffUntil && !force) return false;
    return force || now - (c.fetchedAt || 0) > (n === active ? TTL_ACTIVE : TTL_OTHER);
  });
  const results = await Promise.all(due.map(async (n) => [n, await fetchOne(n, ix, active).catch((e) => ({ error: e.message }))]));
  if (!results.length) return cache;
  return withLocks([STORE_LOCK()], async () => {
    const c2 = readJson(P.usage, {});
    for (const [n, r] of results) {
      const prev = c2[n] || {};
      if (r.usage) c2[n] = { ...r.usage, fetchedAt: now, error: null, backoffUntil: 0 };
      else c2[n] = { ...prev, error: r.error, errorAt: now,
        backoffUntil: r.error === 'http-429' ? now + Math.max(300, r.retryAfter || 0) * 1000 : now + 30_000 };
    }
    writeJson(P.usage, c2);
    return c2;
  });
}

// ── snapshot: accounts + usage + pool aggregate ──────────────────────────────
export function snapshot() {
  const ix = loadIndex();
  const cfg = loadConfig();
  const cache = readJson(P.usage, {});
  const active = activeSlot(ix);
  const ident = liveIdentity();
  const accounts = nums(ix).map((n) => {
    const a = ix.accounts[n];
    return { slot: n, ...a, active: n === active, session: sessionPids(n), usage: cache[n] || null };
  });
  return { store: STORE, accounts, active, unmanagedLive: ident && !active ? ident.email : null,
    lastSwitch: ix.lastSwitch || null, config: cfg, pool: pool(accounts) };
}

// The Claude accounts are ONE wallet. Its used % per window is the mean over
// the usable accounts (equal-sized buckets add up), its 5h reset is the soonest.
export function pool(accounts) {
  const fresh = (u) => u && u.fetchedAt && Date.now() - u.fetchedAt < 30 * 60_000;
  const use = accounts.filter((a) => !a.disabled && !a.dead && fresh(a.usage));
  if (!use.length) return null;
  const mean = (k) => { const v = use.map((a) => a.usage[k]?.pct).filter((x) => typeof x === 'number'); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const soon = (k) => { const v = use.map((a) => a.usage[k]?.resetsAt).filter(Boolean); return v.length ? Math.min(...v) : null; };
  return { accounts: use.length, total: accounts.length, fiveHour: mean('fiveHour'), sevenDay: mean('sevenDay'),
    fiveHourReset: soon('fiveHour'), sevenDayReset: soon('sevenDay') };
}

// ── auto-switch decision ─────────────────────────────────────────────────────
function lines(a, cfg) {
  const th5 = a.threshold ?? cfg.threshold;
  const thW = cfg.weeklyThreshold ?? (a.threshold ?? cfg.threshold);
  const u = a.usage || {};
  const w = [];
  if (u.fiveHour) w.push({ name: '5h', pct: u.fiveHour.pct, line: th5 });
  if (u.sevenDay) w.push({ name: '7d', pct: u.sevenDay.pct, line: thW, resetsAt: u.sevenDay.resetsAt });
  if (cfg.model) for (const s of u.scoped || []) if (s.name.toLowerCase() === String(cfg.model).toLowerCase()) w.push({ name: s.name, pct: s.pct, line: thW });
  const room = w.length ? Math.min(...w.map((x) => x.line - x.pct)) : -Infinity;
  const fullest = w.length ? Math.max(...w.map((x) => x.pct)) : 100;
  const tight = w.reduce((m, x) => (!m || x.line - x.pct < m.line - m.pct ? x : m), null);
  return { room, left: 100 - fullest, tight, weeklyReset: u.sevenDay?.resetsAt || null };
}

export function decide(snap, cfgOverride = {}) {
  const cfg = { ...snap.config.auto, ...cfgOverride };
  const fresh = (a) => a.usage?.fetchedAt && Date.now() - a.usage.fetchedAt < 15 * 60_000;
  const cur = snap.accounts.find((a) => a.active);
  if (!cur) return { action: 'hold', reason: snap.unmanagedLive ? `live login ${snap.unmanagedLive} is not managed (accounts add)` : 'no active account' };
  if (!fresh(cur)) return { action: 'hold', reason: `no fresh usage for active #${cur.slot}` };
  const cands = snap.accounts.filter((a) => !a.active && !a.disabled && !a.dead && a.session.length === 0 && fresh(a));
  if (!cands.length) return { action: 'hold', reason: 'no other usable account' };
  const L = lines(cur, cfg);
  const desc = (a, l) => `#${a.slot} ${l.tight ? `${l.tight.name} ${Math.round(l.tight.pct)}%/${l.tight.line}%` : 'n/a'}`;
  const scored = cands.map((a) => ({ a, l: lines(a, cfg) }));
  const under = scored.filter((x) => x.l.room > 0);

  if (cfg.strategy === 'consume-first' && under.length) {
    // Use-it-or-lose-it: sit on the account whose weekly window resets soonest.
    const pick = under.filter((x) => x.l.weeklyReset).sort((p, q) => p.l.weeklyReset - q.l.weeklyReset)[0];
    if (pick && (L.room <= 0 || (L.weeklyReset && pick.l.weeklyReset < L.weeklyReset - 3600_000 && pick.l.room > cfg.margin)))
      return { action: 'switch', to: pick.a.slot, reason: `consume-first: ${desc(pick.a, pick.l)} resets its week sooner than ${desc(cur, L)}` };
  }
  if (L.room > 0) return { action: 'hold', reason: `${desc(cur, L)} under its line` };
  if (under.length) {
    const best = under.sort((p, q) => q.l.room - p.l.room)[0];
    if (best.l.room >= L.room + cfg.margin) return { action: 'switch', to: best.a.slot, reason: `${desc(cur, L)} at its line → ${desc(best.a, best.l)}` };
  }
  // Everything is over its lines: go where the most quota is left, but only for a clear gain.
  const best = scored.sort((p, q) => q.l.left - p.l.left)[0];
  if (best.l.left > L.left && best.l.left >= Math.min(2 * L.left, L.left + 3))
    return { action: 'switch', to: best.a.slot, reason: `all accounts at their lines; #${best.a.slot} has ${Math.round(best.l.left)}% left vs ${Math.round(L.left)}%` };
  return { action: 'blocked', reason: `all accounts at their lines (active #${cur.slot} ${Math.round(L.left)}% left)` };
}

export async function autoOnce({ dryRun = false, cfgOverride = {} } = {}) {
  const cfg = { ...loadConfig().auto, ...cfgOverride };
  const ix = loadIndex();
  const usable = nums(ix).filter((n) => !ix.accounts[n].disabled && !ix.accounts[n].dead);
  if (usable.length < 2) return { action: 'hold', reason: 'fewer than two usable accounts' };
  const since = Date.now() - (ix.lastSwitchAt || 0);
  if (since < cfg.cooldownSec * 1000) return { action: 'hold', reason: `cooldown (${Math.round((cfg.cooldownSec * 1000 - since) / 1000)}s left)` };
  await refreshUsage();
  const d = decide(snapshot(), cfgOverride);
  if (d.action !== 'switch' || dryRun) return { ...d, dryRun: dryRun || undefined };
  const r = await switchTo(d.to, { reason: `auto: ${d.reason}` });
  if (r.raced) return { action: 'hold', reason: 'another session just switched' };
  return { ...d, from: r.from, email: r.email };
}

// ── session profiles (`run`) ─────────────────────────────────────────────────
// Shared from ~/.claude into the profile; account- and instance-scoped state
// (credentials, .claude.json, sessions/, ide/, statsig/) stays per profile.
const SHARED = ['settings.json', 'keybindings.json', 'CLAUDE.md', 'skills', 'commands', 'agents', 'rules', 'output-styles', 'plugins', 'hooks'];
const HISTORY = ['projects', 'history.jsonl'];

function linkInto(src, dst) {
  if (!existsSync(src)) return;
  let st = null; try { st = lstatSync(dst); } catch { /* absent */ }
  if (st && st.isSymbolicLink()) return;
  if (st) return 'exists';
  const isDir = statSync(src).isDirectory();
  if (isWin) { if (isDir) symlinkSync(src, dst, 'junction'); else copyFileSync(src, dst); }
  else symlinkSync(src, dst);
}

export async function prepareSession(id, { shareHistory = false } = {}) {
  const def = path.join(HOME, '.claude');
  return withLocks([STORE_LOCK()], async () => {
    const ix = loadIndex();
    const n = resolve(ix, id);
    if (activeSlot(ix) === n) return { slot: n, plain: true, email: ix.accounts[n].email };
    if (ix.accounts[n].dead) throw new Error(`account ${n} has a dead refresh token — log in with it and run: accounts add`);
    const dir = P.session(n);
    ensureDir(dir);
    if (!isWin) chmodSync(dir, 0o700);
    const busy = hasLiveSession(n);
    // Seed the newest credential generation: the backup unless the profile is ahead.
    const prof = readText(path.join(dir, '.credentials.json'));
    const back = readText(P.creds(n));
    if (!busy) {
      if (!back) throw new Error(`account ${n} has no stored credential`);
      if (!prof || expiresAt(back) > expiresAt(prof)) atomicWrite(path.join(dir, '.credentials.json'), back);
    }
    const pcfgPath = path.join(dir, '.claude.json');
    const pcfg = readJson(pcfgPath, {});
    const dcfg = readJson(path.join(HOME, '.claude.json'), {});
    pcfg.oauthAccount = readJson(P.oauth(n));
    pcfg.hasCompletedOnboarding = true;
    if (!pcfg.theme && dcfg.theme) pcfg.theme = dcfg.theme;
    if (dcfg.mcpServers) pcfg.mcpServers = dcfg.mcpServers;   // user-scope MCP servers follow the session
    writeJson(pcfgPath, pcfg);
    const notes = [];
    for (const it of SHARED) if (linkInto(path.join(def, it), path.join(dir, it)) === 'exists') notes.push(`${it} exists in the profile; not linked`);
    if (shareHistory) {
      if (isWin) notes.push('history sharing is POSIX-only; skipped');
      else for (const it of HISTORY) if (linkInto(path.join(def, it), path.join(dir, it)) === 'exists') notes.push(`${it}: the profile has its own copy; move it into ~/.claude/${it} to share`);
    }
    return { slot: n, dir, email: ix.accounts[n].email, notes, busy };
  });
}
export function markSession(n, pid) { const d = path.join(P.session(n), '.mc-pids'); ensureDir(d); writeFileSync(path.join(d, String(pid)), ''); }
export async function endSession(n, pid) {
  rmSync(path.join(P.session(n), '.mc-pids', String(pid)), { force: true });
  return withLocks([STORE_LOCK()], async () => adoptProfileLocked(n));
}

export const paths = { store: STORE, credsPath, globalConfigPath, claudeHome, switches: P.switches, sessions: P.sessions };
