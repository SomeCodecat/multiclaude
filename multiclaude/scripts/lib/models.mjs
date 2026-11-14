// multiclaude model catalogs — ONE place that knows what the delegate CLIs can
// run right now, resolved from the live catalogs instead of slugs hardcoded in
// prose (slugs drift: gpt-5.6-* → gpt-6-* → gpt-6.1-*, Gemini 3.8 Flash →
// Gemini 4 Argon, Claude 4.6 → Claude 5.5 — every one of those broke a routing
// table that named versions).
//
//   Codex : ~/.codex/models_cache.json  (slug, description, priority, efforts)
//   AGY   : `agy models`                (id<TAB>Display Name), cached ~1h
//   pi    : `pi --list-models`          (provider, model, context, max-out …), cached ~1h
//
// Bands (what the orchestrate skill routes by) are resolved from ROLE, not name:
//   codex:mech  "fast / affordable / easier"   @ medium   boilerplate, renames
//   codex:std   "workhorse"                    @ high     everyday implementation
//   codex:hard  "frontier / most demanding"    @ xhigh    hard refactors, tricky bugs
//   codex:max   = hard model at its top effort            escalation only
//   agy:gemmed/gemhi/gemlo   newest Gemini *Flash* family @ medium/high/low
//   agy:gemtop               newest Gemini family of any kind @ high (today Argon —
//                            note it has its OWN quota bucket on paid plans)
//   agy:prohi                newest Gemini Pro family @ high (none today)
//   agy:sonnet / agy:opus    newest Claude Sonnet / Opus @ high
//   pi:lo/med/hi             the pi default model's family (settings.json) by its
//                            effort suffix (-none/-low → lo, -medium → med,
//                            -high/-xhigh/-max → hi); pi is a TRIAL delegate
// Pure Node, cross-platform.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOME, run } from './mc.mjs';

export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'multiclaude');

// ═══════════════════════════════════════════════════════════ Codex ══
export function codexCatalog() {
  const f = path.join(HOME, '.codex', 'models_cache.json');
  let raw;
  try { raw = JSON.parse(readFileSync(f, 'utf8')); }
  catch { return { ok: false, msg: 'no Codex model catalog yet (run codex once)', models: [] }; }
  const models = (raw.models || []).filter((m) => m && m.slug).map((m) => ({
    slug: m.slug,
    name: m.display_name || m.slug,
    description: m.description || '',
    priority: typeof m.priority === 'number' ? m.priority : 999,
    visible: m.visibility === 'list',
    deprecated: !!m.upgrade,
    defaultEffort: m.default_reasoning_level || null,
    efforts: (m.supported_reasoning_levels || []).map((x) => (typeof x === 'string' ? x : x && x.effort)).filter(Boolean),
  }));
  return { ok: true, models, clientVersion: raw.client_version || null, fetchedAt: raw.fetched_at || null };
}

function codexGen(slug) { const m = /^gpt-(\d+(?:\.\d+)?)/.exec(slug); return m ? parseFloat(m[1]) : 0; }
const ROLES = [
  ['hard', /frontier|most demanding|most capable|smartest|deepest/i],
  ['std', /workhorse/i],
  ['mech', /\bfast\b|affordable|easier|efficient|cheap|light/i],
];
const STALE = /previous generation|older|legacy|deprecated/i;
// Role is read off the server's own description — "Latest workhorse model",
// "Frontier intelligence for the most demanding work", "Fast and affordable
// model for easier tasks" — so a renamed generation lands in the right band
// without a doc edit. `priority` is the picker's LIST ORDER (default first),
// NOT a capability rank: today's catalog lists the workhorse (priority 1) above
// the frontier model (priority 2), which is why the band logic reads roles.
export function codexRole(m) {
  if (STALE.test(m.description)) return 'stale';
  for (const [r, re] of ROLES) if (re.test(m.description)) return r;
  return null;
}
export function clampEffort(m, want) {
  const have = (m.efforts || []).filter((e) => EFFORT_ORDER.includes(e)).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (!have.length) return want;
  if (have.includes(want)) return want;
  const wi = EFFORT_ORDER.indexOf(want);
  const below = have.filter((e) => EFFORT_ORDER.indexOf(e) < wi);
  return below.length ? below[below.length - 1] : have[0];
}
export function topEffort(m) {
  const have = (m.efforts || []).filter((e) => EFFORT_ORDER.includes(e)).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return have.length ? have[have.length - 1] : (m.defaultEffort || 'high');
}

export function resolveCodexBands(cat) {
  if (!cat || !cat.ok || !cat.models.length) return { ok: false, msg: (cat && cat.msg) || 'empty Codex catalog' };
  const cands = cat.models.filter((m) => m.visible && !m.deprecated);
  let live = cands.filter((m) => codexRole(m) !== 'stale');
  if (!live.length) live = cands;                 // only "older generation" models left: better than nothing
  if (!live.length) return { ok: false, msg: 'Codex catalog lists no usable (visible, non-deprecated) model' };
  const byPri = (a, b) => a.priority - b.priority;
  const newest = (list) => list.slice().sort((a, b) => (codexGen(b.slug) - codexGen(a.slug)) || byPri(a, b))[0] || null;
  const ofRole = (r) => newest(live.filter((m) => codexRole(m) === r));
  let hard = ofRole('hard'), std = ofRole('std'), mech = ofRole('mech');
  const sorted = live.slice().sort(byPri);
  if (!hard) hard = sorted[0] || null;
  if (!std) std = sorted.find((m) => m !== hard) || hard;
  if (!mech) mech = sorted.slice().reverse().find((m) => m !== hard && m !== std) || std;
  const hardFallback = sorted.find((m) => m !== hard && codexRole(m) !== 'mech') || std;
  const band = (m, eff) => (m ? { model: m.slug, effort: clampEffort(m, eff), name: m.name, why: m.description } : null);
  return {
    ok: true,
    mech: band(mech, 'medium'),
    std: band(std, 'high'),
    hard: band(hard, 'xhigh'),
    max: hard ? { model: hard.slug, effort: topEffort(hard), name: hard.name, why: hard.description } : null,
    hardFallback: band(hardFallback, 'xhigh'),
    unbanded: live.filter((m) => m !== hard && m !== std && m !== mech).map((m) => ({ slug: m.slug, priority: m.priority, why: m.description })),
    stale: cands.filter((m) => codexRole(m) === 'stale').map((m) => m.slug),
    clientVersion: cat.clientVersion,
  };
}
export function isCodexModel(cat, slug) {
  return !!(cat && cat.ok && cat.models.some((m) => m.slug === slug));
}

// ═════════════════════════════════════════════════════════════ AGY ══
// `agy models` prints a "Fetching available models..." line, then `id<TAB>name`
// rows. Only the bare id may go to `agy --model`; a display name or a whole row
// makes agy print its picker and exit 0 without running the prompt.
// Why the last `agyModels()` call came back empty: the CLI's own first line, and whether it says
// "not signed in". null after a call that listed models.
let agyFail = null;
const AGY_SIGNED_OUT = /\bsign(?:ed)?[ -]?in\b|\blog(?:ged)?[ -]?in\b|authenticat|unauthori[sz]ed/i;
export const agyModelsFailure = () => agyFail;
// One line for whoever reads the refusal: what is wrong and who can fix it.
export const agyDownText = (fail = agyFail) => (fail && fail.auth
  ? `AGY is not signed in (\`agy models\`: ${fail.text}) — the person signs in by running \`agy\` in a terminal; until then AGY is unavailable, route the job to another delegate`
  : `\`agy models\` returned nothing${fail ? ` (${fail.text})` : ''} — AGY is offline or not set up; treat it as unavailable`);
export function agyModels({ cache = true, ttlSec = 3600 } = {}) {
  agyFail = null;
  const cf = path.join(CACHE_DIR, 'agy-models.json');
  if (cache) {
    try {
      if ((Date.now() - statSync(cf).mtimeMs) / 1000 <= ttlSec) {
        const rows = JSON.parse(readFileSync(cf, 'utf8'));
        if (Array.isArray(rows) && rows.length) return rows;
      }
    } catch { /* cold */ }
  }
  const r = run('agy', ['models'], { timeout: 30000 });
  if (!r.ok || !r.stdout.trim()) {
    const line = (r.stderr || r.stdout || '').split('\n').map((l) => l.trim()).find(Boolean) || (r.code == null ? 'no answer from the CLI' : `exit ${r.code}`);
    agyFail = { text: line.slice(0, 200), auth: AGY_SIGNED_OUT.test(line) };
    return [];
  }
  const rows = r.stdout.split('\n')
    .map((ln) => ln.split('\t'))
    .filter((parts) => parts.length >= 2 && parts[0].trim() && parts[1].trim())
    .map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
  if (rows.length) {
    try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cf, JSON.stringify(rows)); } catch { /* ignore */ }
  }
  return rows;
}

// gemini-4-argon-medium → {vendor gemini, kind argon, version [4], effort medium}
// gemini-3.8-flash-high → {gemini, flash, [3,8], high}
// claude-opus-5-5-low   → {claude, opus, [5,5], low}
// claude-sonnet-4-6     → {claude, sonnet, [4,6], null}   (older, effort-less ids)
export function parseAgyId(id) {
  let effort = null, family = id;
  const em = /-(low|medium|high|xhigh|max|ultra)$/.exec(id);
  if (em) { effort = em[1]; family = id.slice(0, -em[0].length); }
  let vendor = 'other', kind = family, version = [], m;
  if ((m = /^gemini-(\d+(?:\.\d+)?)-(.+)$/.exec(family))) { vendor = 'gemini'; version = m[1].split('.').map(Number); kind = m[2]; }
  else if ((m = /^claude-(opus|sonnet|haiku)-(.+)$/.exec(family))) { vendor = 'claude'; kind = m[1]; version = (m[2].match(/\d+/g) || []).map(Number); family = family.replace(/-thinking$/, ''); }
  else if (/^gpt/.test(family)) { vendor = 'gpt'; }
  return { id, family, effort, vendor, kind, version };
}
function cmpVerDesc(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (b[i] || 0) - (a[i] || 0); if (d) return d; }
  return 0;
}
export function agyFamilies(rows) {
  const fam = new Map();
  for (const r of rows || []) {
    const p = parseAgyId(typeof r === 'string' ? r : r.id);
    p.name = typeof r === 'string' ? r : r.name;
    if (!fam.has(p.family)) fam.set(p.family, { family: p.family, vendor: p.vendor, kind: p.kind, version: p.version, variants: [] });
    fam.get(p.family).variants.push(p);
  }
  return [...fam.values()];
}
export function resolveAgyTiers(rows) {
  const fams = agyFamilies(rows);
  const newest = (pred) => fams.filter(pred).sort((a, b) => cmpVerDesc(a.version, b.version))[0] || null;
  const pick = (f, eff) => {
    if (!f) return null;
    const v = f.variants.find((x) => x.effort === eff) || f.variants.find((x) => !x.effort)
      || f.variants.find((x) => x.effort === 'medium') || f.variants[0];
    return v ? { id: v.id, name: v.name || v.id } : null;
  };
  const gemAny = newest((f) => f.vendor === 'gemini');
  const flash = newest((f) => f.vendor === 'gemini' && /flash/i.test(f.kind)) || gemAny;
  const pro = newest((f) => f.vendor === 'gemini' && /pro/i.test(f.kind));
  const opus = newest((f) => f.vendor === 'claude' && f.kind === 'opus');
  const sonnet = newest((f) => f.vendor === 'claude' && f.kind === 'sonnet');
  const t = {
    opus: pick(opus, 'high'), sonnet: pick(sonnet, 'high'),
    gemhi: pick(flash, 'high'), gemmed: pick(flash, 'medium'), gemlo: pick(flash, 'low'),
    gemtop: gemAny && gemAny !== flash ? pick(gemAny, 'high') : null,
    prohi: pick(pro, 'high'),
  };
  const out = { ok: fams.length > 0, names: {}, families: fams.map((f) => ({ family: f.family, vendor: f.vendor, ids: f.variants.map((v) => v.id) })) };
  for (const [k, v] of Object.entries(t)) { out[k] = v ? v.id : null; if (v) out.names[k] = v.name; }
  return out;
}
// Exact id, or a family prefix (agy accepts `--model gemini-4-argon --effort high`).
export function isAgyModel(rows, id) {
  if (!rows || !rows.length) return null;   // unknown — catalog unavailable
  if (rows.some((r) => r.id === id)) return true;
  return agyFamilies(rows).some((f) => f.family === id);
}

// ═════════════════════════════════════════════════════════════ pi ══
// `pi --list-models` prints a header row then `provider  model  context  max-out
// thinking  images` (space-aligned). Only the models pi can reach are listed
// (its provider extensions must be loaded — `--no-extensions` empties the list).
// The model goes to `pi --model provider/id`.
export function piModels({ cache = true, ttlSec = 3600 } = {}) {
  const cf = path.join(CACHE_DIR, 'pi-models.json');
  if (cache) {
    try {
      if ((Date.now() - statSync(cf).mtimeMs) / 1000 <= ttlSec) {
        const rows = JSON.parse(readFileSync(cf, 'utf8'));
        if (Array.isArray(rows) && rows.length) return rows;
      }
    } catch { /* cold */ }
  }
  const r = run('pi', ['--list-models'], { timeout: 30000 });
  if (!r.ok || !r.stdout.trim()) return [];
  const rows = parsePiModels(r.stdout);
  if (rows.length) {
    try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cf, JSON.stringify(rows)); } catch { /* ignore */ }
  }
  return rows;
}
export function parsePiModels(text) {
  return String(text).split('\n').map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 2 && c[0] !== 'provider' && /^[\w.-]+$/.test(c[0]) && /^[\w.:-]+$/.test(c[1]))
    .map(([provider, id, context, maxOut, thinking]) => ({ provider, id, context: context || null, maxOut: maxOut || null, thinking: thinking === 'yes' }));
}
// pi's own default (~/.pi/agent/settings.json defaultProvider / defaultModel).
export function piDefault() {
  try {
    const s = JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent'), 'settings.json'), 'utf8'));
    return s.defaultModel ? { provider: s.defaultProvider || null, id: s.defaultModel } : null;
  } catch { return null; }
}
// `id` or `provider/id` → the catalog row, or false (unknown) / null (no catalog).
export function findPiModel(rows, id) {
  if (!rows || !rows.length) return null;
  const [p, m] = id.includes('/') ? id.split(/\/(.*)/s) : [null, id];
  return rows.find((r) => r.id === m && (!p || r.provider === p)) || false;
}
const PI_EFFORT = /-(none|minimal|low|medium|high|xhigh|max)$/;
// The effort of a pi run is either part of the model id (`…-low`, `…-xhigh`: one id per effort) or set
// per run with `pi --thinking <level>`. A model takes it per run when pi lists it as a thinking model
// and its id names no effort; the bands of such a model are that one id at three levels. pi clamps a
// level the model does not have to the nearest one it has.
export const PI_THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const PI_BAND_EFFORT = { lo: 'low', med: 'medium', hi: 'xhigh' };
export const piTakesEffort = (row) => !!row && !!row.thinking && !PI_EFFORT.test(row.id);
// A runner effort name (also Codex's `ultra`, a gateway's `none`) → the pi level, or null.
export function piThinking(effort) {
  const e = String(effort || '').toLowerCase();
  return e === 'none' ? 'off' : e === 'ultra' ? 'max' : PI_THINKING.includes(e) ? e : null;
}
export function resolvePiBands(rows, def = piDefault()) {
  const out = { ok: false, lo: null, med: null, hi: null, def: null, family: null, efforts: null };
  if (!rows || !rows.length) return out;
  const anchor = (def && rows.find((r) => r.id === def.id && (!def.provider || r.provider === def.provider))) || rows[0];
  const family = anchor.id.replace(PI_EFFORT, '');
  const vs = rows.filter((r) => r.provider === anchor.provider && r.id.replace(PI_EFFORT, '') === family);
  const by = (...effs) => { for (const e of effs) { const v = vs.find((r) => (PI_EFFORT.exec(r.id) || [])[1] === e); if (v) return v.id; } return null; };
  const flat = vs.length === 1 || !vs.some((r) => PI_EFFORT.test(r.id));
  out.ok = true; out.family = `${anchor.provider}/${family}`; out.def = anchor.id;
  out.lo = flat ? anchor.id : by('low', 'none', 'minimal', 'medium') || anchor.id;
  out.med = flat ? anchor.id : by('medium', 'low', 'high') || anchor.id;
  out.hi = flat ? anchor.id : by('xhigh', 'high', 'max', 'medium') || anchor.id;
  out.efforts = flat && piTakesEffort(anchor) ? { ...PI_BAND_EFFORT } : null;   // one id: the band is the level
  out.others = rows.filter((r) => !vs.includes(r)).map((r) => `${r.provider}/${r.id}`);
  return out;
}
