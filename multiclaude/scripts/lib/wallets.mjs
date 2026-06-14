// multiclaude wallet readers — one source of truth for each wallet's data, shared
// by the full usage report and the compact hook snapshot. Each returns plain data;
// the callers format it. Cross-platform, no python3.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { HOME, run, newestFile, mtimeMs } from './mc.mjs';

// ── CODEX — newest ~/.codex/sessions/**/*.jsonl rate_limits snapshot (local) ──
export function codexUsage() {
  const sess = newestFile(path.join(HOME, '.codex', 'sessions'), (n) => n.endsWith('.jsonl'));
  if (!sess) return { ok: false, msg: 'no Codex session yet (run codex once)' };
  let data;
  try { data = readFileSync(sess, 'utf8'); } catch { return { ok: false, msg: 'cannot read Codex session' }; }
  let rl = null, tu = null;
  for (const ln of data.split('\n')) {
    if (!ln.includes('"rate_limits"') && !ln.includes('"total_token_usage"')) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const st = [o];
    while (st.length) {
      const c = st.pop();
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        if (c.rate_limits && typeof c.rate_limits === 'object') rl = c.rate_limits;
        if (c.total_token_usage && typeof c.total_token_usage === 'object') tu = c.total_token_usage;
        st.push(...Object.values(c));
      } else if (Array.isArray(c)) st.push(...c);
    }
  }
  if (!rl) return { ok: false, msg: 'no rate-limit snapshot in latest session' };
  const now = Date.now() / 1000;
  const mk = (b) => (b ? { pct: b.used_percent || 0, resetSec: b.resets_at ? Math.round(b.resets_at - now) : null } : null);
  return {
    ok: true,
    primary: mk(rl.primary),
    secondary: mk(rl.secondary),
    plan: rl.plan_type || null,
    sessionTokens: tu ? (tu.total_tokens || 0) : null,
  };
}

// ── CLAUDE — active 5h block via ccusage (needs network; bunx then npx) ──
export function claudeUsage() {
  let r = run('bunx', ['ccusage@latest', 'blocks', '--active', '--json'], { timeout: 90000 });
  if (!r.ok || !r.stdout.trim()) r = run('npx', ['-y', 'ccusage@latest', 'blocks', '--active', '--json'], { timeout: 90000 });
  if (!r.ok || !r.stdout.trim()) return { ok: false, msg: 'ccusage unavailable (needs network for bunx/npx)' };
  let d; try { d = JSON.parse(r.stdout); } catch { return { ok: false, msg: 'ccusage returned no parseable data' }; }
  const bl = (d.blocks || []).filter((b) => b.isActive);
  if (!bl.length) return { ok: false, msg: 'no active block — idle' };
  const b = bl[0], tc = b.tokenCounts || {}, pr = b.projection || {}, br = b.burnRate || {};
  const tokens = Object.values(tc).filter((v) => typeof v === 'number').reduce((a, c) => a + c, 0);
  return {
    ok: true,
    costUSD: b.costUSD || 0,
    tokens,
    projCost: pr.totalCost || 0,
    projTokens: pr.totalTokens || 0,
    tokensPerMin: br.tokensPerMinute || null,
    remainingMin: pr.remainingMinutes != null ? pr.remainingMinutes : null,
    models: b.models || [],
  };
}

// ── AGY — no usage % exists; derive a reactive per-pool status from the 429s it
// logs (~/.gemini/antigravity-cli/log), attributed to the Gemini/Claude pool by
// the active model label that precedes each one. Local files only. ──
const TS = /^[EWIF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const LAB = /label="([^"]+)"/;
const RST = /Resets in ([0-9hms]+)/;
function parseReset(s) {
  let sec = 0;
  for (const m of s.matchAll(/(\d+)([hms])/g)) sec += (+m[1]) * ({ h: 3600, m: 60, s: 1 }[m[2]]);
  return sec;
}
export function agyUsage() {
  const logdir = path.join(HOME, '.gemini', 'antigravity-cli', 'log');
  let files;
  try { files = readdirSync(logdir).filter((f) => f.endsWith('.log')).map((f) => path.join(logdir, f)); }
  catch { return { ok: false, haveLogs: false, msg: 'no AGY logs yet (run agy / log in)' }; }
  if (!files.length) return { ok: false, haveLogs: false, msg: 'no AGY logs yet (run agy / log in)' };
  files = files.map((p) => ({ p, m: mtimeMs(p) })).sort((a, b) => a.m - b.m).slice(-40).map((x) => x.p);

  const now = Date.now() / 1000, yr = new Date().getFullYear();
  const reset = { gemini: 0, claude: 0 };
  let email = null, loggedIn = false;
  for (const fp of files) {
    let cur = 'gemini', data;
    try { data = readFileSync(fp, 'utf8'); } catch { continue; }
    for (const ln of data.split('\n')) {
      if (ln.includes('authenticated successfully as')) {
        loggedIn = true;
        const m = ln.match(/as (\S+@\S+)/); if (m) email = m[1].replace(/\.$/, '');
      } else if (ln.includes('Propagating selected model override')) {
        const m = ln.match(LAB); if (m) cur = /claude/i.test(m[1]) ? 'claude' : 'gemini';
      } else if (ln.includes('RESOURCE_EXHAUSTED') && ln.includes('Resets in')) {
        const tm = ln.match(TS), rm = ln.match(RST);
        if (tm && rm) {
          const [, mo, da, hh, mi, ss] = tm;
          let t = new Date(yr, +mo - 1, +da, +hh, +mi, +ss).getTime() / 1000;
          if (t > now + 86400) t = new Date(yr - 1, +mo - 1, +da, +hh, +mi, +ss).getTime() / 1000; // year-boundary
          const rep = t + parseReset(rm[1]);
          if (rep > reset[cur]) reset[cur] = rep;
        }
      }
    }
  }
  const pool = (k) => (reset[k] > now ? { exhausted: true, resetSec: Math.round(reset[k] - now) } : { exhausted: false, resetSec: null });
  return { ok: true, haveLogs: true, loggedIn, email, pools: { gemini: pool('gemini'), claude: pool('claude') } };
}

// NOTE — there is no usable proactive AGY quota endpoint for this reader.
//   • POST …/v1internal:retrieveUserQuota returns 200 but reports the LEGACY
//     Gemini Code Assist buckets (gemini-2.5-flash / -flash-lite / -pro /
//     3.1-flash-lite), all permanently at remainingFraction:1 — AGY's real pooled
//     quota (Gemini 3.5 Flash, 3.1 Pro, Claude 4.6, GPT-OSS 120B) never draws from
//     them, so the numbers are wrong and always read 100%.
//   • POST …/v1internal:retrieveUserQuotaSummary returns AGY's real pool grouping
//     but 403s for a direct consumer token — it only answers over the Antigravity
//     Language Server (Connect RPC on a random localhost port, CSRF token in
//     /proc/<pid>/environ), which exists only during a live interactive session
//     and is Linux-only. Not viable for a background, cross-platform usage hook.
// So AGY status stays reactive-only (agyUsage() above): honest pool-level state
// from the 429s it logs, never a misleading proactive %.

// AGY model tiers (`agy models`) + pattern resolution. Names drift, so resolve by
// regex rather than hardcoding.
export function agyTiers() {
  const r = run('agy', ['models'], { timeout: 30000 });
  if (!r.ok || !r.stdout.trim()) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}
export function resolveTiers(models) {
  const find = (re) => models.find((m) => re.test(m)) || null;
  return {
    opus: find(/Claude.*Opus/i),
    sonnet: find(/Claude.*Sonnet/i),
    gemhi: find(/Gemini.*Flash.*High/i),
    gemmed: find(/Gemini.*Flash.*Medium/i),
  };
}
