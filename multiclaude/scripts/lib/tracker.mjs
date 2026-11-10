// multiclaude usage tracker — tokens and ≈ API spend per wallet, account and model.
//
// It does not count on its own: it reads what each CLI already records, so the
// history that was spent before the tracker existed is in it from the first scan.
//   CLAUDE  <claude home>/projects/**/*.jsonl  (assistant messages: model + usage;
//           subagent transcripts included) and each `accounts run` profile's own
//           projects dir. Account: the profile's slot; for the default profile the
//           account active at that time, from the switch log (switches.jsonl, the
//           last switch in accounts.json, and the active login at every scan).
//           Default-profile history from before any of those points is "unattributed".
//   CODEX   <codex home>/sessions/**/*.jsonl and archived_sessions (token_count
//           events: cumulative totals, counted as deltas; model from turn_context).
//   AGY     the runner's job files (proof line: in/out/think/cached). AGY runs made
//           outside dispatch.mjs are not seen (agy keeps no readable token log).
// Scans are incremental (byte offset per file) and aggregate into day buckets in
// <cache>/multiclaude/tracker.json, so totals outlive the CLIs' own retention.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, statSync, openSync, readSync, closeSync, renameSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { activeSlot, paths as acctPaths } from './accounts.mjs';
import { loadPrices, costOf } from './prices.mjs';

const HOME = os.homedir();
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'multiclaude');
export const STATE = path.join(CACHE_DIR, 'tracker.json');
const LOCK = STATE + '.lock';
const JOBS_DIR = path.join(CACHE_DIR, 'jobs');
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const DEDUPE_KEEP = 300;
// 'cost' = USD the provider itself reported for the run (pi jobs), kept beside the tokens.
const FIELDS = ['in', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'out', 'reasoning', 'calls', 'cost'];

const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const dayOf = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const emptyState = () => ({ version: 1, startedAt: Date.now(), scannedAt: 0, files: {}, jobs: {}, anchors: [], days: {} });

function add(state, ts, wallet, account, model, u) {
  const day = dayOf(ts);
  if (!day) return;
  const key = `${wallet}\t${account}\t${model || '?'}`;
  const b = ((state.days[day] ||= {})[key] ||= {});
  for (const f of FIELDS) if (u[f]) b[f] = (b[f] || 0) + u[f];
}

// All *.jsonl under root (real dirs only below the root; symlinked history is counted at its source).
function jsonlFiles(root, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) jsonlFiles(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// New complete lines of a file since its last scan; resets when the file shrank.
function newLines(state, file) {
  let st;
  try { st = statSync(file); } catch { return null; }
  const rec = (state.files[file] ||= { off: 0 });
  if (st.size < rec.off) { state.files[file] = { off: 0 }; return newLines(state, file); }
  if (st.size === rec.off) return null;
  const len = st.size - rec.off;
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, rec.off); } finally { closeSync(fd); }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return null;
  rec.off += lastNl + 1;
  return { rec, lines: buf.subarray(0, lastNl).toString('utf8').split('\n') };
}

// ── Claude ──
function claudeRoots() {
  const roots = [{ dir: path.join(acctPaths.claudeHome(), 'projects'), slot: null }];
  try {
    for (const n of readdirSync(acctPaths.sessions)) {
      const dir = path.join(acctPaths.sessions, n, 'projects');
      try { if (lstatSync(dir).isDirectory()) roots.push({ dir, slot: n }); } catch { /* none or symlinked to the default */ }
    }
  } catch { /* no profiles */ }
  return roots;
}
function slotTimeline(state) {
  const pts = [...state.anchors];
  for (const line of (existsSync(acctPaths.switches) ? readFileSync(acctPaths.switches, 'utf8') : '').split('\n')) {
    try { const s = JSON.parse(line); if (s && s.at && s.to != null) pts.push({ at: s.at, slot: String(s.to) }); } catch { /* skip */ }
  }
  const last = readJson(path.join(acctPaths.store, 'accounts.json'))?.lastSwitch;
  if (last?.at && last.to != null) pts.push({ at: last.at, slot: String(last.to) });
  return pts.sort((a, b) => a.at - b.at);
}
function scanClaude(state) {
  // the active login now is a known point; the switch log fills in the rest
  let active = null;
  try { active = activeSlot(); } catch { /* no store */ }
  if (active != null && state.anchors[state.anchors.length - 1]?.slot !== String(active)) state.anchors.push({ at: Date.now(), slot: String(active) });
  const pts = slotTimeline(state);
  const slotAt = (ts) => { let s = '?'; for (const p of pts) { if (p.at <= ts) s = p.slot; else break; } return s; };
  let n = 0;
  for (const root of claudeRoots()) {
    for (const file of jsonlFiles(root.dir)) {
      const got = newLines(state, file);
      if (!got) continue;
      const seen = new Set(got.rec.seen || []);
      for (const line of got.lines) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const m = d?.message;
        if (d?.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') continue;
        const key = `${m.id || ''}:${d.requestId || ''}`;
        if (key !== ':' && seen.has(key)) continue;   // one message is written once per content block
        seen.add(key);
        const u = m.usage;
        const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
        const ts = Date.parse(d.timestamp) || Date.now();
        add(state, ts, 'claude', root.slot ?? slotAt(ts), m.model, {
          in: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: Math.max(0, (u.cache_creation_input_tokens || 0) - w1h), cacheWrite1h: w1h,
          out: u.output_tokens || 0, reasoning: u.output_tokens_details?.thinking_tokens || 0, calls: 1,
        });
        n++;
      }
      got.rec.seen = [...seen].slice(-DEDUPE_KEEP);
    }
  }
  return n;
}

// ── Codex ──
function scanCodex(state) {
  let n = 0;
  for (const dir of ['sessions', 'archived_sessions']) {
    for (const file of jsonlFiles(path.join(CODEX_HOME, dir))) {
      const got = newLines(state, file);
      if (!got) continue;
      const rec = got.rec;
      for (const line of got.lines) {
        const isCtx = line.includes('"turn_context"'), isTok = line.includes('"token_count"');
        if (!isCtx && !isTok) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const p = d?.payload;
        if (d?.type === 'turn_context' && p?.model) { rec.model = p.model; continue; }
        const t = p?.type === 'token_count' ? p.info?.total_token_usage : null;
        if (!t) continue;
        const cur = { i: t.input_tokens || 0, c: t.cached_input_tokens || 0, o: t.output_tokens || 0, r: t.reasoning_output_tokens || 0 };
        const prev = rec.tot || { i: 0, c: 0, o: 0, r: 0 };
        const restarted = cur.i < prev.i || cur.o < prev.o;
        const base = restarted ? { i: 0, c: 0, o: 0, r: 0 } : prev;
        const di = cur.i - base.i, dc = Math.max(0, cur.c - base.c), dout = cur.o - base.o, dr = Math.max(0, cur.r - base.r);
        rec.tot = cur;
        if (di <= 0 && dout <= 0) continue;   // a repeated snapshot
        add(state, Date.parse(d.timestamp) || Date.now(), 'codex', 'codex', rec.model || '?', {
          in: Math.max(0, di - dc), cacheRead: dc, out: Math.max(0, dout), reasoning: dr, calls: 1,
        });
        n++;
      }
    }
  }
  return n;
}

// ── AGY and pi (runner job files) ──
const num = (s) => Number(String(s ?? '').replace(/,/g, '')) || 0;
const poolOf = (model) => (/argon/i.test(model) ? 'argon' : /^(claude|gpt)/i.test(model) ? 'claude' : 'gemini');
function scanAgy(state) {
  let n = 0, entries = [];
  try { entries = readdirSync(JOBS_DIR).filter(f => f.endsWith('.json')); } catch { return 0; }
  for (const f of entries) {
    const id = f.slice(0, -5);
    if (state.jobs[id]) continue;
    const m = readJson(path.join(JOBS_DIR, f));
    if (!m || m.status === 'running' || m.status === 'queued') continue;
    const at = m.endedAt || m.updatedAt || m.startedAt || Date.now();
    state.jobs[id] = at;
    if ((m.delegate !== 'agy' && m.delegate !== 'pi') || !m.proof) continue;
    const model = /\bmodel=([^\s@\]]+)/.exec(m.proof)?.[1] || m.model || '?';
    const t = /\(in ([\d,]+)\/out ([\d,]+)(?:\/think ([\d,]+))?(?:\/cached ([\d,]+))?\)/.exec(m.proof);
    if (!t) continue;
    const u = { in: num(t[1]), out: num(t[2]), reasoning: num(t[3]), cacheRead: num(t[4]), calls: 1 };
    if (m.delegate === 'pi') add(state, at, 'pi', 'pi', model, { ...u, cost: +m.cost || 0 });
    else add(state, at, 'agy', poolOf(model), model, u);
    n++;
  }
  // forget job ids past the runner's 14-day retention
  const cut = Date.now() - 30 * 86400_000;
  for (const [id, at] of Object.entries(state.jobs)) if (at < cut) delete state.jobs[id];
  return n;
}

// One incremental scan under a lock (another scan in progress → skip, read the state).
export function scan() {
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    let age = Infinity; try { age = Date.now() - statSync(LOCK).mtimeMs; } catch { /* gone */ }
    if (age < 10 * 60_000) return { skipped: 'another scan is running', state: readJson(STATE) || emptyState() };
    try { rmSync(LOCK); writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); } catch { return { skipped: 'lock', state: readJson(STATE) || emptyState() }; }
  }
  try {
    const state = readJson(STATE) || emptyState();
    const t0 = Date.now();
    const counted = { claude: scanClaude(state), codex: scanCodex(state), agy: scanAgy(state) };
    // drop file records for files that are gone
    for (const f of Object.keys(state.files)) if (!existsSync(f)) delete state.files[f];
    state.scannedAt = Date.now();
    const tmp = STATE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, STATE);
    return { counted, ms: Date.now() - t0, state };
  } finally {
    try { rmSync(LOCK); } catch { /* gone */ }
  }
}
export const readState = () => readJson(STATE) || emptyState();

// ── report ──
export const PERIODS = { today: 0, '7d': 6, '30d': 29, all: null };
const sum = (into, b) => { for (const f of FIELDS) into[f] = (into[f] || 0) + (b[f] || 0); return into; };
export function report(state, { since = '7d' } = {}) {
  const back = PERIODS[since] === undefined ? PERIODS['7d'] : PERIODS[since];
  const from = back == null ? '0000-00-00' : dayOf(Date.now() - back * 86400_000);
  const prices = loadPrices();
  const labels = Object.fromEntries(Object.entries(readJson(path.join(acctPaths.store, 'accounts.json'))?.accounts || {})
    .map(([slot, a]) => [slot, a.alias || a.email || `#${slot}`]));
  const byModel = new Map(), byAccount = new Map(), byWallet = new Map(), byDay = new Map();
  const totals = {};
  for (const [day, buckets] of Object.entries(state.days || {})) {
    if (day < from) continue;
    for (const [key, b] of Object.entries(buckets)) {
      const [wallet, account, model] = key.split('\t');
      // A price (list or the overrides file) wins; a pi model without one shows what its gateway billed.
      const usd = costOf(prices.lookup(model), b) ?? (b.cost > 0 ? b.cost : null);
      const withUsd = (m, k, init) => {
        const r = m.get(k) || { ...init, usd: 0, unpriced: 0 };
        sum(r, b);
        if (usd == null) r.unpriced += (b.in || 0) + (b.out || 0); else r.usd += usd;
        m.set(k, r);
      };
      withUsd(byModel, `${wallet}\t${model}`, { wallet, model, priced: usd != null });
      withUsd(byAccount, `${wallet}\t${account}`, { wallet, account, label: wallet === 'claude' ? (account === '?' ? 'unattributed' : labels[account] || `#${account}`) : account });
      withUsd(byWallet, wallet, { wallet });
      withUsd(byDay, day, { day });
      sum(totals, b);
      totals.usd = (totals.usd || 0) + (usd || 0);
      if (usd == null) totals.unpriced = (totals.unpriced || 0) + (b.in || 0) + (b.out || 0);
    }
  }
  const shape = (r) => ({ ...r, input: (r.in || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.cacheWrite1h || 0), total: (r.in || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.cacheWrite1h || 0) + (r.out || 0) });
  const order = (a, b) => (b.usd - a.usd) || (b.total - a.total);
  const days = Object.keys(state.days || {}).sort();
  return {
    since, from: back == null ? (days[0] || null) : from, scannedAt: state.scannedAt || null, trackingSince: state.startedAt || null,
    firstDay: days[0] || null, pricesAt: prices.fetchedAt,
    totals: shape({ usd: 0, unpriced: 0, ...totals }),
    wallets: [...byWallet.values()].map(shape).sort(order),
    accounts: [...byAccount.values()].map(shape).sort(order),
    models: [...byModel.values()].map(shape).sort(order),
    days: [...byDay.values()].map(shape).sort((a, b) => a.day.localeCompare(b.day)),
  };
}
