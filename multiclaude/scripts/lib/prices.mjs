// multiclaude model prices — API list prices per token, for the usage tracker's
// "≈ API $" column. Source: LiteLLM's public price table (the one ccusage uses),
// fetched at most once a day and cached trimmed to the four rates we read.
// Overrides: <config>/multiclaude/prices.json, USD per MILLION tokens:
//   { "gpt-6-astra": { "in": 10, "out": 50, "cacheRead": 1 }, "my-model-prefix*": { … } }
// A key ending in * matches by prefix. Overrides win over LiteLLM.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'multiclaude', 'prices.json');
export const OVERRIDES = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'multiclaude', 'prices.json');
const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_AGE = 24 * 3600_000;

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const ageOf = (f) => { try { return Date.now() - statSync(f).mtimeMs; } catch { return Infinity; } };

// LiteLLM row → { in, out, cacheRead, cacheWrite, cacheWrite1h } in USD per token.
function trim(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (!v || typeof v !== 'object' || !(v.input_cost_per_token > 0 || v.output_cost_per_token > 0)) continue;
    out[k] = {
      in: v.input_cost_per_token || 0,
      out: v.output_cost_per_token || 0,
      ...(v.cache_read_input_token_cost != null ? { cacheRead: v.cache_read_input_token_cost } : {}),
      ...(v.cache_creation_input_token_cost != null ? { cacheWrite: v.cache_creation_input_token_cost } : {}),
      ...(v.cache_creation_input_token_cost_above_1hr != null ? { cacheWrite1h: v.cache_creation_input_token_cost_above_1hr } : {}),
    };
  }
  return out;
}

// Refresh the cached table when it is older than a day (or `force`). Network; never throws.
// MULTICLAUDE_PRICES=off keeps it off the network (air-gapped hosts, tests): the cached
// table and the overrides file still price what they know.
export async function refreshPrices({ force = false, timeoutMs = 20_000 } = {}) {
  if (/^(off|0|no)$/i.test(process.env.MULTICLAUDE_PRICES || '')) return { ok: false, msg: 'price table: off (MULTICLAUDE_PRICES)' };
  if (!force && ageOf(CACHE) < MAX_AGE) return { ok: true, cached: true };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(SOURCE, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, msg: `price table: HTTP ${r.status}` };
    const table = trim(await r.json());
    if (Object.keys(table).length < 50) return { ok: false, msg: 'price table: unexpectedly small' };
    mkdirSync(path.dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ fetchedAt: Date.now(), source: SOURCE, table }));
    return { ok: true, cached: false };
  } catch (e) {
    return { ok: false, msg: `price table: ${e.name === 'AbortError' ? 'timeout' : e.message}` };
  }
}

// A price lookup over the cached table + overrides. Model ids are matched loosely:
// lower case, an AGY effort suffix (-low/-medium/-high/…) dropped, then the bare id,
// the provider-prefixed ids, and finally any key ending in /<id> or .<id>.
export function loadPrices() {
  const cache = readJson(CACHE);
  const table = cache?.table || {};
  const perM = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, v / 1e6]));
  const over = Object.entries(readJson(OVERRIDES) || {}).map(([k, v]) => [k.toLowerCase(), perM(v)]);
  const keys = Object.keys(table);
  const memo = new Map();
  const find = (id) => {
    if (table[id]) return table[id];
    for (const p of ['anthropic/', 'openai/', 'gemini/', 'vertex_ai/', 'azure/', 'azure_ai/']) if (table[p + id]) return table[p + id];
    const tail = keys.filter(k => k.endsWith('/' + id) || k.endsWith('.' + id));
    return tail.length ? table[tail.sort((a, b) => a.length - b.length)[0]] : null;
  };
  const lookup = (model) => {
    const m = String(model || '').toLowerCase().trim();
    if (!m) return null;
    if (memo.has(m)) return memo.get(m);
    let hit = null;
    for (const [k, v] of over) if (k.endsWith('*') ? m.startsWith(k.slice(0, -1)) : m === k) { hit = v; break; }
    if (!hit) {
      const bare = m.replace(/\[[^\]]*\]$/, '').replace(/@.*$/, '');
      const candidates = [bare, bare.replace(/-(minimal|low|medium|high|xhigh|max|thinking)$/, ''), bare.replace(/-\d{8}$/, '')];
      for (const c of candidates) { hit = find(c); if (hit) break; }
    }
    memo.set(m, hit);
    return hit;
  };
  return { lookup, fetchedAt: cache?.fetchedAt ?? null, overrides: over.length };
}

// USD for one usage bucket { in, cacheRead, cacheWrite, cacheWrite1h, out } (in = uncached input).
// Missing cache rates fall back to the usual multiples of the input rate.
export function costOf(price, u) {
  if (!price) return null;
  const pin = price.in || 0;
  return (u.in || 0) * pin
    + (u.cacheRead || 0) * (price.cacheRead ?? pin * 0.1)
    + (u.cacheWrite || 0) * (price.cacheWrite ?? pin * 1.25)
    + (u.cacheWrite1h || 0) * (price.cacheWrite1h ?? pin * 2)
    + (u.out || 0) * (price.out || 0);
}

// ≈ USD at list price for one runner job, from the usage its CLI reported
// ({ input_tokens, output_tokens, cache_read_tokens | cached_input_tokens }). Codex counts
// cached input inside input_tokens (the OpenAI convention); agy and pi report it apart.
// A pi id may be `provider/id`. null = no price known for the model, or no usage.
export function runCost(prices, delegate, model, usage) {
  if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) return null;
  const id = String(model || '');
  const price = prices.lookup(id) || (id.includes('/') ? prices.lookup(id.slice(id.indexOf('/') + 1)) : null);
  if (!price) return null;
  const cached = usage.cache_read_tokens ?? usage.cached_input_tokens ?? 0;
  const fresh = Math.max(0, (usage.input_tokens || 0) - (delegate === 'codex' ? cached : 0));
  return costOf(price, { in: fresh, cacheRead: cached, out: usage.output_tokens || 0 });
}
