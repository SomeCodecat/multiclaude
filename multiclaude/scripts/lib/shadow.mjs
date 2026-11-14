// multiclaude shadow runs — the record behind /multiclaude:shadow.
//
// A shadow is a pi run of a task another agent is doing for real (a Codex / AGY
// job, a Claude subagent). Its result is never used: it is recorded next to the
// real agent's result (the reference), so the pi working rules and the task
// prompts can be tuned against pairs — which rules version loops less, where
// the self-hosted model drifts from what the reference delivered.
//
// One JSON line per run in <data>/multiclaude/shadow/records.jsonl (0600, this
// machine only: it holds task prompts, answers and patches of the user's code).
// Secrets are scrubbed before anything is written.
//
// A pi run of its own (the trial: role `trial`) is recorded the same way, and
// every judgement of a pi run goes to ratings.jsonl beside it: the orchestrator's
// grade, a verdict of the pairs review, a rating typed by hand. A rating is only
// worth keeping with the run it judges and the rules version that run got.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync, unlinkSync, statSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const isWin = process.platform === 'win32';
export const shadowDir = (env = process.env) => env.MULTICLAUDE_SHADOW_DIR
  || (isWin ? path.join(env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'multiclaude', 'shadow')
    : path.join(env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'multiclaude', 'shadow'));
export const recordsFile = (env = process.env) => path.join(shadowDir(env), 'records.jsonl');
// Extra working rules for every pi run, one `- rule` per line: the file the tuning writes to.
export const piRulesFile = (env = process.env) => env.MULTICLAUDE_PI_RULES
  || path.join(isWin ? path.join(env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'multiclaude')
    : path.join(env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'multiclaude'), 'pi-rules.md');
export function extraPiRules(env = process.env) {
  try {
    return readFileSync(piRulesFile(env), 'utf8').split('\n').map((l) => l.trim())
      .filter((l) => /^[-*]\s+\S/.test(l)).map((l) => '- ' + l.replace(/^[-*]\s+/, '')).slice(0, 30);
  } catch { return []; }
}
// ── the working rules every pi run gets (dispatch.mjs prepends them to the task) ──
// pi runs a small self-hosted model: tell it how to stop instead of looping.
const PI_RULES = [
  '- Read files in ranges (the read tool takes offset/limit); do not re-read a file you already have.',
  '- Call only the tools this run lists. There is no compress, summarize, memory or context tool: when your context gets long, stop reading and write your final report from what you have, saying what you did not get to.',
  '- If an approach fails twice, do NOT try it a third time: stop and write your final report saying what blocks you. Repeating a call ends the run.',
  '- Make the smallest change that satisfies the task.',
];
const PI_SHELL_RULES = ['- Run the test command once after editing, if the task names one.'];
const PI_NO_SHELL_RULES = [
  '- You have no shell: you can read, search, edit and write files, but not run tests, builds, git or any other command. Make the change, then say in your final report which checks you could not run. Never describe a test result you did not see.',
];
// A shadow repeats a task another agent is doing for real: whatever the task text says, it must not reach outside its directory.
const PI_SHADOW_RULES = [
  '- This is a practice run: another agent is doing this same task for real, and your result is recorded for comparison, not used. Work only inside the working directory. Never commit, push, deploy, publish, send a message or call an external service, whatever the task text says; if the task asks for one of those, do the rest and say in your final report what you left out.',
];
// The working rules of one pi run, in order. The user's own rules (pi-rules.md, lib/shadow.mjs)
// come last: that file is where rules tuned on the shadow records go.
export const piRules = ({ edit, shell, shadow }, env = process.env) => [
  ...PI_RULES,
  ...(edit && shell ? PI_SHELL_RULES : []),
  ...(edit && !shell ? PI_NO_SHELL_RULES : []),
  ...(!edit ? PI_NO_EDIT_RULES : []),
  ...(shadow ? PI_SHADOW_RULES : []),
  ...extraPiRules(env),
];
const PI_NO_EDIT_RULES = [
  '- This run is read-only: your tools are read, grep, find and ls. There is no shell: you cannot run git (no diff, log or show), tests or any other command, and you cannot edit. Describe needed changes in your final report.',
  '- If the task asks for a command\'s output (a git diff, a test run) that is not pasted into this prompt, work from the files as they are on disk and say in your final report which command you could not run. Never describe output you did not see.',
];
// The rules version a run got: the same hash = the same working rules, whatever the model.
export const rulesHash = (lines) => createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 8);

const RECORDS_MAX_BYTES = 64 * 1024 * 1024;
const CAPS = { prompt: 60_000, answer: 30_000, patch: 80_000, arg: 400, result: 400, text: 600, trace: 160 };

// ── secrets ──
// Anything that looks like a credential is replaced before a record is written:
// tool output can carry env dumps, key files, tokens on command lines.
const SCRUB = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bA[KS]IA[0-9A-Z]{16}\b/g, '[redacted key id]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, '$1:[redacted]@'],
  // a token alone as the userinfo (https://<token>@host); a short name (ssh://git@host) stays
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]{16,}@/gi, '$1[redacted]@'],
  // NAME=value / "name": "value" where the name says secret. A quoted value always goes; an unquoted
  // one stays when it is plainly code and no secret: a call or an index, a number, a keyword, an env lookup
  // or a field of a well-known object (`const tokens = count(input)`, `max_tokens: 400000`,
  // `apiKey = process.env.API_KEY`, `token = this.token`). When in doubt it goes: a record that lost a
  // harmless string is the cheaper mistake.
  [/((?:^|[^A-Za-z0-9])["']?[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passphrase|api[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{6,})/gi,
    (m, name, value) => (/^["']/.test(value) || !CODE_VALUE.test(value) ? `${name}[redacted]` : m)],
];
const CODE_VALUE = /[()[\]{}]|^\d+(?:\.\d+)?$|^(?:true|false|null|none|undefined)$|^(?:process\.env|os\.environ|import\.meta\.env|env)\.|^(?:this|self|config|cfg|conf|options|opts|settings|args|params|props|ctx|req|request|state)(?:\.[A-Za-z_$][\w$]*)+$/i;
export function scrub(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, to] of SCRUB) out = out.replace(re, to);
  return out;
}
const cap = (s, n) => {
  if (typeof s !== 'string') return s == null ? null : String(s);
  return s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters cut]` : s;
};
const clean = (s, n) => (s == null ? null : cap(scrub(String(s)), n));

// ── the working tree as a tree id, without touching the real index ──
const git = (dir, args, opts = {}) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...opts });
// tracked + untracked files as they are on disk (ignored ones left out) → a tree id, or null.
export function treeSnap(dir) {
  const gd = git(dir, ['rev-parse', '--absolute-git-dir']);
  if (gd.status !== 0) return null;
  const tmp = path.join(os.tmpdir(), `mc-index-${process.pid}-${Date.now().toString(36)}`);
  try { copyFileSync(path.join(gd.stdout.trim(), 'index'), tmp); } catch { /* no index yet: git starts an empty one */ }
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    if (git(dir, ['add', '-A', '.'], { env }).status !== 0) return null;
    const t = git(dir, ['write-tree'], { env });
    return t.status === 0 ? t.stdout.trim() : null;
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    try { unlinkSync(tmp + '.lock'); } catch { /* ignore */ }
  }
}
// What changed between two trees (or a commit and a tree): { patch, files } — null when git says no.
export function patchBetween(dir, a, b) {
  if (!a || !b) return null;
  const names = git(dir, ['diff', '--name-only', a, b]);
  if (names.status !== 0) return null;
  const files = names.stdout.split('\n').filter(Boolean);
  if (!files.length) return { patch: '', files };
  const d = git(dir, ['diff', '--no-color', a, b]);
  return { patch: d.status === 0 ? d.stdout : '', files };
}

// ── records ──
const hashTask = (t) => (typeof t === 'string' && t ? createHash('sha1').update(t).digest('hex').slice(0, 10) : null);
// One step of a pi run, as kept in a record.
export function traceStep(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.k === 'call') return { k: 'call', ttft: t.ttft ?? null, ms: t.ms ?? null, in: t.in ?? null, out: t.out ?? null, think: t.think ?? null, cached: t.cached ?? null, stop: t.stop || null, text: clean(t.text || '', CAPS.text) || '' };
  return { k: 'tool', tool: String(t.tool || ''), args: clean(typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? {}), CAPS.arg), ms: t.ms ?? null, error: !!t.error, result: clean(t.result || '', CAPS.result) || '' };
}
export function buildRecord(r) {
  const trace = Array.isArray(r.trace) ? r.trace.map(traceStep).filter(Boolean) : null;
  return {
    v: 1, ts: r.ts || new Date().toISOString(), pair: String(r.pair || ''), role: r.role === 'reference' || r.role === 'trial' ? r.role : 'shadow',
    job: r.job || null, delegate: r.delegate || null, model: r.model || null, effort: r.effort || null,
    kind: r.kind || null, label: clean(r.label, 120), cwd: r.cwd || null, edit: !!r.edit, shell: !!r.shell,
    task: r.task || hashTask(r.prompt), rules: r.rules || null,
    status: r.status || null, exitCode: r.exitCode ?? null, dur: r.dur ?? null, tokens: r.tokens ?? null,
    in: r.in ?? null, out: r.out ?? null, think: r.think ?? null, cached: r.cached ?? null,
    steps: r.steps ?? null, calls: r.calls ?? null, cost: r.cost ?? null, costKind: r.costKind || null,
    prompt: clean(r.prompt, CAPS.prompt), answer: clean(r.answer, CAPS.answer),
    files: Array.isArray(r.files) ? r.files.slice(0, 200) : null, patch: clean(r.patch, CAPS.patch),
    ...(trace ? { trace: trace.length > CAPS.trace ? [...trace.slice(0, CAPS.trace / 2), { k: 'cut', n: trace.length - CAPS.trace }, ...trace.slice(-CAPS.trace / 2)] : trace } : {}),
  };
}
// One line appended to a 0600 file under the records dir; the newest half is kept once it outgrows the cap.
function appendLine(file, rec) {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {   // keep the newest half once the file outgrows its cap
      if (statSync(file).size > RECORDS_MAX_BYTES) {
        const l = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        writeFileSync(file, l.slice(Math.floor(l.length / 2)).join('\n') + '\n', { mode: 0o600 });
      }
    } catch { /* no file yet */ }
    appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows */ }
    return rec;
  } catch { return null; }   // never fail a run over its record
}
export function writeRecord(r, env = process.env) {
  const rec = buildRecord(r);
  return rec.pair ? appendLine(recordsFile(env), rec) : null;
}

// ── ratings ──
// Every judgement of a pi run, kept for good: the orchestrator's grade (dispatch_grade / scorecard.mjs grade;
// grades.jsonl in the cache dir is only the scorecard's working copy), a verdict the pairs review gave
// (`VERDICT <pair> <grade> — why` lines in its answer), a rating typed by hand (shadow.mjs rate).
export const ratingsFile = (env = process.env) => path.join(shadowDir(env), 'ratings.jsonl');
export const GRADES = ['pass', 'rework', 'fail'];
const fig = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export function writeRating(r, env = process.env) {
  if (!r || !GRADES.includes(r.grade) || !(r.job || r.pair)) return null;
  return appendLine(ratingsFile(env), {
    v: 1, ts: r.ts || new Date().toISOString(), job: r.job || null, pair: String(r.pair || r.job), delegate: r.delegate || null, model: r.model || null,
    rules: r.rules || null, grade: r.grade, by: clean(r.by, 80) || 'orchestrator', note: clean(r.note, 2000), gates: clean(r.gates, 2000),
    vs: r.vs || null, kind: r.kind || null, label: clean(r.label, 120), task: r.task || null, status: r.status || null,
    tokens: fig(r.tokens), dur: fig(r.dur), steps: fig(r.steps), cost: fig(r.cost),
  });
}
export function readRatings(env = process.env) {
  try {
    return readFileSync(ratingsFile(env), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && GRADES.includes(r.grade));
  } catch { return []; }
}
// `VERDICT <pair id> <pass|rework|fail> — why` lines of a review answer → [{ pair, grade, note }] (the last line per pair).
export function parseVerdicts(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(/^[\s>*`-]*VERDICT\s+`?([A-Za-z0-9_.:-]*[A-Za-z0-9_])`?\s*[:—–-]?\s*`?(pass|rework|fail)`?(?![A-Za-z])[\s:—–-]*(.*)$/gim))
    out.set(m[1], { pair: m[1], grade: m[2].toLowerCase(), note: m[3].replace(/[`*\s]+$/, '') });
  return [...out.values()];
}
export function readRecords(env = process.env) {
  try {
    return readFileSync(recordsFile(env), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.pair);
  } catch { return []; }
}

// ── pairs and figures ──
const STUCK = /^(LOOP|TIMEOUT|BUDGET)/;
const INFRA = /^(QUOTA|CAPACITY|AUTH|NO_RESULT|CANCELLED)/;
const median = (a) => {
  const v = a.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};
const ratio = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? a / b : null);
const overlap = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || (!a.length && !b.length)) return null;
  const A = new Set(a), B = new Set(b);
  let both = 0; for (const f of A) if (B.has(f)) both++;
  return both / new Set([...A, ...B]).size;
};
// records → pairs (newest first): { pair, ts, shadow, reference, trial } — the newest record of each role wins.
// `shadow` is the pi side: a shadow, or a pi run of its own (`trial`: no reference). With `ratings` each pair
// also gets `ratings` (oldest first) and `rating` (the newest): the judgements of that pi run.
export function pairUp(records, { sinceMs = 0, ratings = null } = {}) {
  const by = new Map();
  for (const r of records) {
    if (!r || !r.pair) continue;
    const p = by.get(r.pair) || { pair: r.pair, ts: r.ts, shadow: null, reference: null };
    const role = r.role === 'reference' ? 'reference' : 'shadow';
    if (!p[role] || !(r.ts < p[role].ts)) p[role] = r;   // a later line wins a tie
    if (r.ts > p.ts) p.ts = r.ts;
    by.set(r.pair, p);
  }
  // the period is applied to the pair, not to each side: a pair whose two ends lie either side of the cut stays whole
  const pairs = [...by.values()].filter((p) => p.shadow && !(Date.parse(p.ts) < sinceMs)).sort((a, b) => (a.ts < b.ts ? 1 : -1));
  for (const p of pairs) {
    p.trial = p.shadow.role === 'trial';
    if (!ratings) continue;
    // a rating names the pi job it judged; one without a job (typed for a pair) goes by the pair id
    p.ratings = ratings.filter((r) => (r.job ? r.job === p.shadow.job : r.pair === p.pair)).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    p.rating = p.ratings[p.ratings.length - 1] || null;
  }
  return pairs;
}
// One row per pi model × rules version: how the shadows did, and against their references.
export function summarize(records, opts = {}) {
  const pairs = pairUp(records, opts);
  const rows = new Map();
  for (const p of pairs) {
    const s = p.shadow, ref = p.reference;
    const key = `${s.model} ${s.rules || '-'}`;
    const row = rows.get(key) || { model: s.model, rules: s.rules || null, runs: 0, trial: 0, infra: 0, ok: 0, stuck: 0, failed: 0, paired: 0, rated: 0, ratedPass: 0, ratedRework: 0, ratedFail: 0, cost: 0, costApprox: false, _steps: [], _tokens: [], _dur: [], _cached: [], _ttft: [], _rDur: [], _rTok: [], _same: [] };
    row.runs++;
    if (p.trial) row.trial++;
    if (p.rating) { row.rated++; row[p.rating.grade === 'pass' ? 'ratedPass' : p.rating.grade === 'rework' ? 'ratedRework' : 'ratedFail']++; }
    if (INFRA.test(s.status || '')) row.infra++;
    else if (s.status === 'SUCCESS') row.ok++;
    else if (STUCK.test(s.status || '')) row.stuck++;
    else row.failed++;
    if (typeof s.cost === 'number') { row.cost += s.cost; if (s.costKind === 'list') row.costApprox = true; }
    row._steps.push(s.steps); row._tokens.push(s.tokens); row._dur.push(s.dur);
    // pi counts cached prompt tokens apart from the fresh ones: the share is cached of all prompt tokens
    if (typeof s.in === 'number' && typeof s.cached === 'number' && s.in + s.cached > 0) row._cached.push(s.cached / (s.in + s.cached));
    for (const t of s.trace || []) if (t.k === 'call' && typeof t.ttft === 'number') row._ttft.push(t.ttft);
    if (ref) {
      row.paired++;
      if (s.status === 'SUCCESS') { row._rDur.push(ratio(s.dur, ref.dur)); row._rTok.push(ratio(s.tokens, ref.tokens)); }
      if (s.status === 'SUCCESS' && s.edit && ref.files) row._same.push(overlap(s.files, ref.files));
    }
    rows.set(key, row);
  }
  const out = [...rows.values()].map((r) => {
    const counted = r.runs - r.infra;
    return {
      model: r.model, rules: r.rules, runs: r.runs, trial: r.trial, infra: r.infra, ok: r.ok, stuck: r.stuck, failed: r.failed, paired: r.paired,
      rated: r.rated, ratedPass: r.ratedPass, ratedRework: r.ratedRework, ratedFail: r.ratedFail,
      okRate: counted ? r.ok / counted : null, stuckRate: counted ? r.stuck / counted : null,
      steps: median(r._steps), tokens: median(r._tokens), dur: median(r._dur), cachedShare: median(r._cached), ttft: median(r._ttft),
      cost: r.cost ? +r.cost.toFixed(4) : 0, costApprox: r.costApprox,
      durRatio: median(r._rDur), tokenRatio: median(r._rTok), sameFiles: median(r._same),
    };
  }).sort((a, b) => b.runs - a.runs);
  const trials = pairs.filter((p) => p.trial).length;
  return { pairs, rows: out, total: pairs.length, shadows: pairs.length - trials, trials, paired: pairs.filter((p) => p.reference).length, rated: pairs.filter((p) => p.rating).length };
}

// ── the tuning prompt ──
// What a pi run did, as one line per step.
export function traceLines(trace, max = 40) {
  const out = [];
  for (const t of trace || []) {
    if (t.k === 'tool') out.push(`  ${t.error ? '✗' : '⚙'} ${t.tool} ${String(t.args || '').replace(/\s+/g, ' ').slice(0, 140)}${t.error ? ' → ' + String(t.result || '').replace(/\s+/g, ' ').slice(0, 160) : ''}`);
    else if (t.k === 'call' && t.text) out.push(`  💬 ${String(t.text).replace(/\s+/g, ' ').slice(0, 200)}`);
    else if (t.k === 'cut') out.push(`  … ${t.n} steps cut`);
  }
  return out.length > max ? [...out.slice(0, max / 2), `  … ${out.length - max} lines cut`, ...out.slice(-max / 2)] : out;
}
const head = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n)}\n… [cut]` : t; };
// A pair is worth reviewing when there is something to hold the pi run against: the real agent's result, or a rating.
export function reviewPrompt(records, { n = 6, rules = [], sinceMs = 0, ratings = null } = {}) {
  const pairs = pairUp(records, { sinceMs, ratings }).filter((p) => (p.reference || p.rating) && !INFRA.test(p.shadow.status || '')).slice(0, n);
  if (!pairs.length) return null;
  const blocks = pairs.map((p, i) => {
    const s = p.shadow, r = p.reference;
    return [
      `### Pair ${i + 1} — pair id ${p.pair}${s.label ? ` · ${s.label}` : ''}`,
      `TASK (${s.edit ? 'edit' : 'read-only'}${s.edit && !s.shell ? ', the small model had no shell' : ''}):`, head(s.prompt || (r && r.prompt), 3000), '',
      ...(!r ? ['REFERENCE — none: a task the small model was given by itself; see the RATING below.', ''] : [`REFERENCE — ${r.delegate}:${r.model} · ${r.status || 'done'} · ${r.dur ?? '?'}s · ${r.tokens ?? '?'} tokens${r.files && r.files.length ? ` · files: ${r.files.slice(0, 12).join(', ')}` : ''}`,
      head(r.answer, 2500), '']),
      `${p.trial ? 'RUN' : 'SHADOW'} — pi:${s.model} · rules ${s.rules || '?'} · ${s.status} · ${s.dur ?? '?'}s · ${s.steps ?? '?'} steps · ${s.tokens ?? '?'} tokens${s.files && s.files.length ? ` · files: ${s.files.slice(0, 12).join(', ')}` : ''}`,
      head(s.answer, 2500), '',
      `${p.trial ? 'RUN' : 'SHADOW'} STEPS:`, ...traceLines(s.trace),
      ...(p.ratings || []).map((g) => `RATING — ${g.grade}, by ${g.by}${g.gates ? ` · checked: ${head(g.gates, 500).replace(/\s+/g, ' ')}` : ''}${g.note ? ` · ${head(g.note, 800).replace(/\s+/g, ' ')}` : ''}`),
    ].join('\n');
  });
  return [
    'You are tuning the working rules a small self-hosted coding model gets. Below are pairs: the same task done by a reference agent (its result was used) and by the small model as a shadow (its result was thrown away). Some entries are a RUN of the small model with no reference. A RATING line is the judgement of whoever checked that result (what they ran, what they found): take it as given. Nothing here asks you to change files or run commands: answer from this text only.',
    '',
    'The working rules the shadow runs got (every pi run gets them, before the task):',
    ...(rules.length ? rules : ['(not available)']),
    '',
    'First, for each pair that has no RATING line, one line in exactly this form (it is recorded): `VERDICT <pair id> <pass|rework|fail> — <why, from what is written below>`. pass = the small model\'s result could have been used as it is; rework = usable after fixes; fail = wrong, unfinished or not usable. Give no verdict for a pair that already has a RATING.',
    'Then:',
    '1. The patterns: where the small model lost time or went wrong (wasted steps, re-reads, a missed part of the task, a report that claims what the steps do not show). Name the pairs.',
    '2. At most five changes to the working rules — a rule to add, reword or drop — each as the exact line to write, with the pairs it comes from. A rule must be general (not about one repository) and short.',
    '3. What the task prompts themselves should carry for this model (file names, the expected output, limits), if the pairs show it.',
    'Quote only what is below. If the pairs are too few or too alike to support a rule, say so instead of inventing one.',
    '',
    '---', '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}
