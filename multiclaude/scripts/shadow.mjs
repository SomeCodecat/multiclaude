#!/usr/bin/env node
// multiclaude shadow runs — /multiclaude:shadow.
//
// With Delegates setting 8 on, every agent that starts (a Codex / AGY dispatch, a
// Claude subagent) gets a pi run of the same task beside it: the shadow. Its
// result is never used. Both ends are recorded as a pair (lib/shadow.mjs), so
// the working rules pi gets and the way tasks are written for it can be tuned:
// which rules version gets stuck less, where the self-hosted model spends its
// steps, how far it lands from what the real agent delivered.
//
//   shadow.mjs [7d|24h|30d|all] [N] [--json]   figures per pi model × rules version + the newest N pairs
//   shadow.mjs pair <id>                       one pair: both answers and the shadow's steps
//   shadow.mjs rate <id> <pass|rework|fail> [--cause c] [--kind k] [--note t] [--gates t] [--by who]   one rating of a recorded pi run (pair or job id)
//   shadow.mjs rate --from <file> [--by who]   the `VERDICT <pair> <grade> [cause] [kind] — why` lines of a review answer → ratings
//   shadow.mjs auto [--min N] [--every M] [--n N] [--dry] [--force] [--claude M[,F]|off]   rate the unrated pairs with one AGY job when due
//                                     (the module, hourly); no answer from AGY → one headless Claude call (haiku, sonnet if busy)
//   shadow.mjs rules                           the working rules a shadow gets today + where to add your own
//   shadow.mjs review-prompt [7d|…] [--n N]    a prompt that asks for rule changes from the newest pairs
//   shadow.mjs ready                           exit 0 when pi is installed and lists a model
//   shadow.mjs record                          stdin JSON → one reference record (the hooks module, for a Claude subagent)
//   shadow.mjs claim --jobs-dir D [--session S] [--max N]   take the shadow requests runner jobs left (see below)
//   shadow.mjs slots [N] [--json]              pi runs at once on this machine (every chat, shadows and jobs): show / set
//   shadow.mjs snap [--cwd D]                  the working tree (uncommitted + untracked) as a commit a shadow starts from (JSON)
//   shadow.mjs judge on|off|status             the time judge of a shadow (on by default)
//   shadow.mjs judge --stdin                   stdin JSON (the runner, at 80% of a shadow's limit) → { verdict, cause, why, model, via }
import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { which, nfmt } from './lib/mc.mjs';
import { piModels, resolvePiBands } from './lib/models.mjs';
import { slotLimit, setSlotLimit, readSlots, MAX_LIMIT } from './lib/pislots.mjs';
import { loadPrices, costOf } from './lib/prices.mjs';
import { readRecords, recordsFile, writeRecord, summarize, pairUp, reviewPrompt, traceLines, piRules, piRulesFile, extraPiRules, rulesHash, readRatings, writeRating, ratingsFile, parseVerdicts, GRADES, CAUSES, KINDS, causeOf, kindOf, shadowDir, autoReviewPlan, autoReviewFile, snapCommit, judgeOn, judgeFlag, judgeCeiling, judgePrompt, parseJudge } from './lib/shadow.mjs';

const argv = process.argv.slice(2);
const cmd = ['pair', 'rules', 'review-prompt', 'ready', 'record', 'rate', 'claim', 'slots', 'auto', 'snap', 'judge'].includes(argv[0]) ? argv.shift() : 'summary';
const USAGE = 'usage: shadow.mjs [7d|24h|30d|all] [N] [--json] | pair <id> | rate <id> <pass|rework|fail> [--cause c] [--kind k] [--note t] [--gates t] [--by who] | rate --from <file> [--by who] | auto [--min N] [--every M] [--n N] [--dry] [--force] [--claude M[,F]|off] | rules | review-prompt [--n N] | ready | record | claim --jobs-dir D [--session S] [--max N] | slots [N] [--json] | snap [--cwd D] | judge on|off|status | judge --stdin';

// One pi run's rating with the run's figures copied in (the rating outlives the record's 64 MB cap).
const putRating = (p, { grade, by, note = null, gates = null, cause = null, kind = null }) => {
  const r = p.shadow;
  return writeRating({ job: r.job, pair: p.pair, delegate: 'pi', model: r.model, rules: r.rules, grade, by, note, gates, cause, kind, label: r.label, task: r.task, status: r.status, tokens: r.tokens, dur: r.dur, steps: r.steps, cost: r.cost });
};
// The VERDICT lines of a review answer → ratings by `by`; a pair it already rated keeps the first verdict.
function rateFromText(text, by) {
  const pairs = pairUp(readRecords(), { ratings: readRatings() });
  const res = { done: 0, unknown: 0, had: 0, pairs: [] };
  for (const v of parseVerdicts(text)) {
    const p = pairs.find((x) => x.pair === v.pair || x.shadow.job === v.pair);
    if (!p) res.unknown++;
    else if ((p.ratings || []).some((r) => r.by === by)) res.had++;
    else if (putRating(p, { grade: v.grade, by, note: v.note, cause: v.cause, kind: v.kind })) { res.done++; res.pairs.push(p.pair); }
  }
  return res;
}
const rateLine = (r, by) => `${r.done} verdict${r.done === 1 ? '' : 's'} recorded as rating${r.done === 1 ? '' : 's'} by ${by}${r.had ? ` · ${r.had} already rated by it` : ''}${r.unknown ? ` · ${r.unknown} named no recorded pair` : ''}`;

// ── auto: the automatic review. The hooks module asks every ~10 min while shadows are on; it runs one AGY
// job (the runner's default band, the AGY wallet) only when autoReviewPlan() says one is due, and records
// the verdicts — grade, cause, kind — as ratings by review:<model>. One at a time on this machine (a lock).
// The automatic review's fallback: one headless Claude Code call, no tools, no settings (so no plugin,
// hook or CLAUDE.md is loaded — this plugin's module would otherwise start inside it), run from the
// shadow dir. Spends the Claude wallet of the login that is active now. `spec`: `model[,fallback]` —
// the second is Claude Code's --fallback-model, taken when the first is overloaded — or `off`.
function claudeReview(prompt, spec, { timeoutMs = 10 * 60_000 } = {}) {
  if (!spec || /^(off|none|0|false)$/i.test(spec)) return { error: 'off' };
  const bin = which('claude');
  if (!bin) return { error: 'claude not found' };
  const [m, f] = String(spec).split(',').map((x) => x.trim()).filter(Boolean);
  const env = { ...process.env };
  // herdr would take a nested chat for this terminal's own (mascot, inbox card); the parent's Claude
  // Code variables would make it a child session.
  for (const k of Object.keys(env)) if (/^(HC_|MC_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_PROJECT_DIR$|CLAUDE_PLUGIN_)/.test(k)) delete env[k];
  const args = ['-p', '--model', m, ...(f && f !== m ? ['--fallback-model', f] : []), '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--output-format', 'json'];
  mkdirSync(shadowDir(), { recursive: true });
  const r = spawnSync(bin, args, { input: prompt, cwd: shadowDir(), env, encoding: 'utf8', maxBuffer: 16 << 20, timeout: timeoutMs, windowsHide: true });
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { /* not JSON */ }
  if (!j) return { error: r.error ? r.error.message : (String(r.stderr || r.stdout || '').trim().split('\n').pop() || `exit ${r.status}`).slice(0, 200) };
  if (j.is_error || !j.result) return { error: String(j.result || j.subtype || 'no answer').slice(0, 200) };
  const used = Object.entries(j.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
  return { answer: String(j.result), model: used.length ? used[0][0] : m, usd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null };
}

if (cmd === 'auto') {
  // The Claude fallback when AGY gives no answer: model[,its overload fallback] or off.
  const opt = { min: 6, every: 60, n: 10, dry: false, force: false, claude: process.env.MULTICLAUDE_REVIEW_CLAUDE || 'haiku,sonnet' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') opt.dry = true;
    else if (a === '--claude' && argv[i + 1]) opt.claude = argv[++i];
    else if (a === '--force') opt.force = true;
    else if (['--min', '--every', '--n'].includes(a) && /^\d+$/.test(argv[i + 1] || '')) opt[a.slice(2)] = +argv[++i];
    else { process.stderr.write(USAGE + '\n'); process.exit(2); }
  }
  const stateFile = autoReviewFile(), lockFile = path.join(shadowDir(), 'auto-review.lock');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) || {}; } catch { /* first run */ }
  const records = readRecords(), ratings = readRatings();
  const MAX_TRIES = 2;
  const plan = autoReviewPlan(pairUp(records, { ratings }), state, Date.now(), { min: opt.min, everyMin: opt.every, force: opt.force, maxTries: MAX_TRIES });
  const tag = '[multiclaude shadow auto-review]';
  if (!plan.due || opt.dry) {
    process.stdout.write(`${tag} ${plan.due ? 'due' : 'not due'}: ${plan.why}${plan.skipped ? ` · ${plan.skipped} left out after ${MAX_TRIES} reviews without a verdict` : ''}${opt.dry && plan.due ? ' (dry run: nothing started)' : ''}\n`);
    process.exit(0);
  }
  mkdirSync(shadowDir(), { recursive: true });
  let fd;
  try { fd = openSync(lockFile, 'wx'); }
  catch {
    let stale = false;
    try { stale = Date.now() - statSync(lockFile).mtimeMs > 40 * 60_000; } catch { /* gone meanwhile */ }
    if (!stale) { process.stdout.write(`${tag} another review is running\n`); process.exit(0); }
    try { unlinkSync(lockFile); fd = openSync(lockFile, 'wx'); } catch { process.stdout.write(`${tag} another review is running\n`); process.exit(0); }
  }
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  // process.exit() skips a finally block: every way out goes through done(), which drops the lock first
  const done = (code, line) => { try { unlinkSync(lockFile); } catch { /* gone */ } process.stdout.write(`${tag} ${line}\n`); process.exit(code); };
  const save = (x) => { state = { ...state, ...x }; try { writeFileSync(stateFile, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 }); } catch { /* no state: it runs again next time */ } };
  try {
    const exclude = new Set(Object.entries(state.tried || {}).filter(([, k]) => k >= MAX_TRIES).map(([pr]) => pr));
    const prompt = reviewPrompt(records, { n: opt.n, ratings, unratedOnly: true, verdictsOnly: true, exclude, maxChars: 100_000 });
    if (!prompt) { save({ lastAt: new Date().toISOString(), ok: true, rated: 0, error: null }); done(0, 'nothing to send'); }
    const sent = plan.pairs.filter((pr) => prompt.includes(`pair id ${pr}`));
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(shadowDir(), 'reviews', `${ts}.md`);
    const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dispatch.mjs');
    const r = spawnSync(process.execPath, [runner, 'agy', '--job', 'auto', '--label', 'shadow auto-review', '--background', 'shadow-review', '--no-shadow-request', '--timeout', '600', '--out', out],
      { input: prompt, encoding: 'utf8', maxBuffer: 16 << 20, timeout: 25 * 60_000 });
    const proof = String(r.stderr || '').split('\n').reverse().find((l) => l.startsWith('[dispatch ')) || '';
    let answer = '';
    try { answer = readFileSync(out, 'utf8'); } catch { /* failed run: no answer file */ }
    // A run that did not answer (no quota, provider down, signed out, timed out) says nothing about the
    // pairs: they are not counted as tried and wait for the next round (at most hourly).
    let model = (/^\[dispatch \S+ model=([^\s@\]]+)/.exec(proof) || [])[1] || 'agy';
    let via = 'agy', fellBack = '';
    if (r.status !== 0 || !answer) {
      const why = (/status=(\S+)/.exec(proof) || [])[1] || (r.error ? 'not started' : `exit ${r.status}`);
      const agyErr = proof || String(r.error?.message || `exit ${r.status}`);
      // No AGY model to answer (spent pool, provider busy, signed out, not installed …): the same prompt
      // goes to Claude once, headless, on this machine's Claude login.
      const c = claudeReview(prompt, opt.claude);
      if (!c.answer) {
        save({ lastAt: new Date().toISOString(), ok: false, rated: 0, pairs: sent.length, file: null, error: agyErr + (c.error && c.error !== 'off' ? ` · claude: ${c.error}` : '') });
        done(1, `${why === 'QUOTA' ? 'no AGY quota' : `the AGY review job failed (${why})`}${c.error && c.error !== 'off' ? ` and the Claude fallback did not answer (${c.error})` : ''} — the pairs wait for the next round · ${agyErr}`);
      }
      answer = c.answer; model = c.model; via = 'claude'; fellBack = ` · AGY ${why}, reviewed by ${c.model} instead${c.usd != null ? ` (≈ $${c.usd.toFixed(3)} at list price)` : ''}`;
      try { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, answer, { mode: 0o600 }); } catch { /* the ratings still get written */ }
    }
    // Only an answer that left a pair out counts as a try for it: twice, and the pair is left out.
    const tried = { ...(state.tried || {}) };
    for (const pr of sent) tried[pr] = (tried[pr] || 0) + 1;
    const by = `review:${model}`;
    const res = rateFromText(answer, by);
    for (const pr of res.pairs) delete tried[pr];
    save({ lastAt: new Date().toISOString(), ok: true, rated: res.done, pairs: sent.length, file: out, error: null, tried, via });
    done(0, `${sent.length} pair${sent.length === 1 ? '' : 's'} sent · ${rateLine(res, by)}${fellBack} · answer ${out}`);
  } catch (e) { done(1, `failed — ${e && e.message ? e.message : e}`); }
}

// ── snap: the working tree as a commit (lib/shadow.mjs snapCommit) — the base a shadow's worktree checks
// out, so it starts where the real agent started, uncommitted and untracked files included. The module
// asks it when it queues a shadow; the commit object is loose and unreferenced (git gc drops it in time).
if (cmd === 'snap') {
  let dir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd' && argv[i + 1]) dir = argv[++i];
    else { process.stderr.write(USAGE + '\n'); process.exit(2); }
  }
  const sc = snapCommit(dir);
  process.stdout.write(JSON.stringify(sc || { commit: null }) + '\n');
  process.exit(sc ? 0 : 1);
}

// ── judge: whether a shadow at 80% of its limit gets more time. The runner sends what the run did so far
// (stdin JSON, lib/shadow.mjs judgePrompt); one short AGY job answers (default band, background
// `shadow-judge`), else one headless Claude call (the review's fallback). Prints one JSON line.
if (cmd === 'judge') {
  const sub = argv[0];
  if (sub === 'on' || sub === 'off') {
    mkdirSync(shadowDir(), { recursive: true });
    if (sub === 'off') writeFileSync(judgeFlag(), new Date().toISOString() + '\n');
    else { try { unlinkSync(judgeFlag()); } catch { /* already on */ } }
  }
  if (sub === 'on' || sub === 'off' || sub === 'status' || sub == null) {
    const env = process.env.MULTICLAUDE_SHADOW_JUDGE;
    const on = judgeOn();
    process.stdout.write(`[multiclaude shadow judge] ${on ? 'on' : 'off'}${env && !on ? ' (MULTICLAUDE_SHADOW_JUDGE)' : ''} · ceiling ${judgeCeiling()} s — at 80% of a shadow's limit, once its automatic extensions are used, AGY (Claude when AGY gives no answer) reads the steps and extends it by up to 600 s or stops it with a cause (a fail rating).\n`);
    process.exit(0);
  }
  if (sub !== '--stdin') { process.stderr.write(USAGE + '\n'); process.exit(2); }
  const say = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(o.verdict ? 0 : 1); };
  let ctx;
  try { ctx = JSON.parse(readFileSync(0, 'utf8')); } catch (e) { say({ error: `bad input: ${e.message}` }); }
  const prompt = judgePrompt(ctx);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(shadowDir(), 'judge', `${ts}-${String(ctx.job || 'run').replace(/[^A-Za-z0-9_.-]+/g, '_')}.md`);
  mkdirSync(path.dirname(out), { recursive: true });
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dispatch.mjs');
  const r = spawnSync(process.execPath, [runner, 'agy', '--job', 'auto', '--label', 'shadow judge', '--background', 'shadow-judge', '--no-shadow-request', '--no-auto-extend', '--timeout', '150', '--out', out],
    { input: prompt, encoding: 'utf8', maxBuffer: 16 << 20, timeout: 200_000 });
  const proof = String(r.stderr || '').split('\n').reverse().find((l) => l.startsWith('[dispatch ')) || '';
  let answer = '';
  try { answer = readFileSync(out, 'utf8'); } catch { /* no answer file */ }
  let v = parseJudge(answer);
  if (v) say({ ...v, model: (/^\[dispatch \S+ model=([^\s@\]]+)/.exec(proof) || [])[1] || 'agy', via: 'agy', file: out });
  const why = (/status=(\S+)/.exec(proof) || [])[1] || (answer ? 'no verdict line' : r.error ? 'not started' : `exit ${r.status}`);
  const c = claudeReview(prompt, process.env.MULTICLAUDE_REVIEW_CLAUDE || 'haiku,sonnet', { timeoutMs: 100_000 });
  v = c.answer ? parseJudge(c.answer) : null;
  if (!v) say({ error: `AGY: ${why}; Claude: ${c.error || 'no verdict line'}` });
  try { writeFileSync(out, c.answer, { mode: 0o600 }); } catch { /* the verdict still counts */ }
  say({ ...v, model: c.model, via: 'claude', usd: c.usd, agy: why, file: out });
}

// ── slots: the machine-wide limit on pi runs at once (lib/pislots.mjs) — every chat's runner asks it
// before it starts pi, a job of its own ahead of a shadow.
if (cmd === 'slots') {
  const json = argv.includes('--json');
  const n = argv.find((a) => /^\d+$/.test(a));
  if (argv.some((a) => a !== '--json' && !/^\d+$/.test(a))) { process.stderr.write(USAGE + '\n'); process.exit(2); }
  if (n != null) {
    if (+n < 1 || +n > MAX_LIMIT) { process.stderr.write(`shadow slots: 1–${MAX_LIMIT}\n`); process.exit(2); }
    setSlotLimit(+n);
  }
  const lim = slotLimit();
  const entries = readSlots();
  if (json) { process.stdout.write(JSON.stringify({ ...lim, entries: entries.map(({ file, ...e }) => e) }) + '\n'); process.exit(0); }
  const running = entries.filter((e) => e.state === 'running'), waiting = entries.filter((e) => e.state !== 'running');
  const age = (t) => `${Math.round((Date.now() - t) / 1000)}s`;
  const lines = [`[multiclaude pi slots] ${lim.limit} pi run${lim.limit === 1 ? '' : 's'} at once on this machine${n != null ? ' (set)' : ''} — ${lim.from === 'default' ? 'default' : lim.from}` +
    (lim.from === 'MULTICLAUDE_PI_PARALLEL' && n != null ? ' (the env var wins over what was just saved)' : '')];
  lines.push(`  running ${running.length}: ${running.map((e) => `${e.job}${e.shadow ? ' (shadow)' : ''} ${age(e.startedAt || e.ts)}`).join(' · ') || '—'}`);
  lines.push(`  waiting ${waiting.length}: ${waiting.map((e) => `${e.job}${e.shadow ? ' (shadow)' : ''} ${age(e.ts)}`).join(' · ') || '—'}`);
  lines.push('Every pi run of every chat takes a slot (a job of its own before a shadow); a run waits up to 30 min, then ends CAPACITY. `/multiclaude:shadow slots N` sets it (1–' + MAX_LIMIT + ').');
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

// ── claim: a runner job started outside the dispatch tool (backgrounded Bash, an mc-* forwarder, a
// script) leaves <id>.shadow-request in the jobs dir; the module of the chat that started it takes it
// here and queues the shadow. The rename to <id>.shadowed is the claim: the runner writes its reference
// record only when it finds that file, and two modules never both take one request.
if (cmd === 'claim') {
  const opt = { max: 4 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--jobs-dir') opt.dir = argv[++i];
    else if (argv[i] === '--session') opt.session = argv[++i];
    else if (argv[i] === '--max') opt.max = Math.max(0, parseInt(argv[++i], 10) || 0);
  }
  if (!opt.dir) { process.stderr.write(USAGE + '\n'); process.exit(2); }
  const out = [];
  let names = [];
  try { names = readdirSync(opt.dir).filter((n) => n.endsWith('.shadow-request')).sort(); } catch { /* no jobs dir */ }
  for (const n of names) {
    const p = path.join(opt.dir, n);
    let req;
    try {
      // older than 15 min: its run has moved on too far for a shadow to start from the same place
      if (Date.now() - statSync(p).mtimeMs > 15 * 60_000) { unlinkSync(p); continue; }
      req = JSON.parse(readFileSync(p, 'utf8'));
    } catch { continue; }
    if (!req || !req.of || (opt.session && req.session && req.session !== opt.session)) continue;   // another chat's
    if (out.length >= opt.max) continue;   // full: the rest wait (stale ones above are still dropped)
    try { renameSync(p, path.join(opt.dir, `${req.of}.shadowed`)); } catch { continue; }   // taken already
    out.push(req);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

// ── rate: one judgement of a recorded pi run, kept in ratings.jsonl ──
if (cmd === 'rate') {
  const opt = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (['--note', '--gates', '--by', '--from', '--cause', '--kind'].includes(argv[i])) opt[argv[i].slice(2)] = argv[++i] ?? '';
    else pos.push(argv[i]);
  }
  if (opt.from != null) {
    let text;
    try { text = readFileSync(opt.from, 'utf8'); } catch (e) { process.stderr.write(`shadow rate: cannot read ${opt.from}: ${e.message}\n`); process.exit(2); }
    const by = opt.by || 'review';
    process.stdout.write(rateLine(rateFromText(text, by), by) + '\n');
    process.exit(0);
  }
  if (pos.length !== 2 || !GRADES.includes(pos[1])) { process.stderr.write(USAGE + '\n'); process.exit(2); }
  if (opt.cause != null && !causeOf(opt.cause)) { process.stderr.write(`shadow rate: --cause is one of ${Object.keys(CAUSES).join(', ')}\n`); process.exit(2); }
  if (opt.kind != null && !kindOf(opt.kind)) { process.stderr.write(`shadow rate: --kind is one of ${KINDS.join(', ')}\n`); process.exit(2); }
  const p = pairUp(readRecords(), { ratings: readRatings() }).find((x) => x.pair === pos[0] || x.shadow.job === pos[0]);
  if (!p) { process.stdout.write(`No recorded pi run ${pos[0]} in ${recordsFile()} (a pair id or the pi job id; /multiclaude:shadow lists them).\n`); process.exit(1); }
  const w = putRating(p, { grade: pos[1], by: opt.by || 'user', note: opt.note || null, gates: opt.gates || null, cause: opt.cause ?? (pos[1] === 'pass' ? 'none' : null), kind: opt.kind });
  process.stdout.write(w ? `rated ${p.pair} (pi ${p.shadow.model} · rules ${p.shadow.rules || '?'}): ${w.grade}${w.cause ? ` (${w.cause})` : ''}${w.kind ? ` · ${w.kind}` : ''} by ${w.by} — kept in ${ratingsFile()}\n` : 'not recorded\n');
  process.exit(w ? 0 : 1);
}
let since = '30d', limit = 8, json = false, n = 6, id = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') json = true;
  else if (a === '--n') n = Math.max(1, Math.min(12, +argv[++i] || n));
  else if (/^(\d+[hd]|all)$/.test(a)) since = a;
  else if (cmd === 'pair' && !id) id = a;
  else if (/^\d+$/.test(a)) { limit = +a; n = Math.max(1, Math.min(12, +a)); }
  else { process.stderr.write(`shadow: unknown argument ${a}\n${USAGE}\n`); process.exit(2); }
}
const sinceMs = since === 'all' ? 0 : Date.now() - (+since.slice(0, -1)) * (since.endsWith('h') ? 3600_000 : 86400_000);
const span = since === 'all' ? 'in the whole record' : `in the last ${since}`;
const say = (s) => process.stdout.write(s + '\n');

if (cmd === 'ready') {
  if (!which('pi')) { say('pi: not installed'); process.exit(1); }
  const b = resolvePiBands(piModels());
  if (!b.ok) { say('pi: installed, but `pi --list-models` lists no model'); process.exit(1); }
  say(`pi: ready — lo ${b.lo} · med ${b.med} · hi ${b.hi}`);
  process.exit(0);
}

if (cmd === 'record') {
  let rec;
  try { rec = JSON.parse(readFileSync(0, 'utf8')); } catch { process.stderr.write('shadow record: stdin is not JSON\n'); process.exit(2); }
  if (!rec || typeof rec !== 'object' || !rec.pair) { process.stderr.write('shadow record: a record needs `pair`\n'); process.exit(2); }
  // A Claude subagent's side comes with token counts only: price it here (≈ API list price), so every
  // reference carries a dollar figure beside the pi run's. Cache writes not given = the rest of the total.
  if (rec.cost == null && rec.model && (rec.in != null || rec.out != null)) {
    const n = (x) => (typeof x === 'number' && x > 0 ? x : 0);
    const cacheWrite = rec.cacheWrite ?? (rec.tokens != null ? Math.max(0, rec.tokens - n(rec.in) - n(rec.out) - n(rec.cached)) : 0);
    const usd = costOf(loadPrices().lookup(rec.model), { in: n(rec.in), cacheRead: n(rec.cached), cacheWrite, out: n(rec.out) });
    if (usd != null) Object.assign(rec, { cost: Math.round(usd * 1e5) / 1e5, costKind: 'list', cacheWrite });
  }
  const w = writeRecord({ ...rec, role: 'reference' });
  say(w ? `recorded reference for pair ${w.pair}` : 'not recorded');
  process.exit(w ? 0 : 1);
}

// The rules a shadow gets when it edits (no shell) — the usual case; pi-rules.md rides at the end of every pi run.
const shadowRules = piRules({ edit: true, shell: false, shadow: true });

if (cmd === 'rules') {
  const own = extraPiRules();
  say(`[multiclaude shadow] working rules of an editing shadow run — version ${rulesHash(shadowRules)}`);
  for (const l of shadowRules) say('  ' + l);
  say('');
  say(`Your own rules: ${piRulesFile()} — ${own.length ? `${own.length} line${own.length === 1 ? '' : 's'} in force (the last ${own.length} above)` : 'no file, or no `- rule` line in it'}.`);
  say('One `- rule` per line (30 at most). Every pi run gets them after the built-in ones, and a changed file gives the runs a new rules version to compare.');
  process.exit(0);
}

const records = readRecords(), ratings = readRatings();

if (cmd === 'review-prompt') {
  const p = reviewPrompt(records, { n, rules: shadowRules, sinceMs, ratings });
  say(p || `NO_PAIRS ${span}: a review needs a pi run with something to hold it against — the result of the agent it shadowed, or a rating`);
  process.exit(0);
}

const one = (s, k) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > k ? s.slice(0, k - 1) + '…' : s; };
const when = (ts) => { const d = new Date(ts); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const num = (x, unit = '') => (x == null ? '—' : `${x >= 1000 ? nfmt(x) : Math.round(x * 10) / 10}${unit}`);
const times = (x) => (x == null ? '—' : `${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10}×`);
const tally = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
const usd = (x, approx) => (x ? `${approx ? '≈' : ''}$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}` : '—');

if (cmd === 'pair') {
  const p = id ? pairUp(records, { ratings }).find((x) => x.pair === id || x.shadow.job === id) : null;
  if (!p) { say(`No pair ${id || '(no id given)'} in ${recordsFile()}.`); process.exit(id ? 1 : 2); }
  const s = p.shadow, r = p.reference;
  say(`[multiclaude shadow] pair ${p.pair}${s.label ? ` · ${s.label}` : ''}`);
  say(`  task ${s.task || '?'} · ${s.edit ? `edit${s.shell ? '' : ', no shell'}` : 'read-only'} · ${s.cwd || ''}`);
  say('');
  say(p.trial ? 'REFERENCE  none — a pi run of its own (the trial)' : r ? `REFERENCE  ${r.delegate}:${r.model}${r.effort ? '@' + r.effort : ''}  ${r.status || 'done'}  ${num(r.dur, 's')}  ${num(r.tokens)} tokens${r.cost != null ? '  ' + usd(r.cost, r.costKind === 'list') : ''}${r.files?.length ? `\n  files: ${r.files.slice(0, 20).join(', ')}` : ''}` : 'REFERENCE  not recorded (the agent has not finished, or ended before its record was written)');
  if (r?.answer) say(r.answer.trim().split('\n').slice(0, 40).map((l) => '  ' + l).join('\n'));
  say('');
  say(`${p.trial ? 'PI RUN    ' : 'SHADOW    '} pi:${s.model}  rules ${s.rules || '?'}  ${s.status}  ${num(s.dur, 's')}  ${num(s.steps)} steps  ${num(s.tokens)} tokens (cached ${num(s.cached)})${s.cost != null ? '  ' + usd(s.cost, s.costKind === 'list') : ''}${s.files?.length ? `\n  files: ${s.files.slice(0, 20).join(', ')}` : ''}`);
  if (s.answer) say(s.answer.trim().split('\n').slice(0, 40).map((l) => '  ' + l).join('\n'));
  const tl = traceLines(s.trace, 60);
  if (tl.length) { say(''); say('STEPS'); say(tl.join('\n')); }
  if (p.ratings.length) { say(''); say('RATINGS'); for (const g of p.ratings) say(`  ${when(g.ts)}  ${g.grade}${g.cause ? ` (${g.cause})` : ''}${g.kind && g.kind !== 'trial' && g.kind !== 'shadow' ? ` · ${g.kind}` : ''} by ${g.by}${g.note ? ` — ${one(g.note, 400)}` : ''}${g.gates ? `\n      checked: ${one(g.gates, 400)}` : ''}`); }
  else { say(''); say(`Not rated. /multiclaude:shadow rate ${p.pair} <pass|rework|fail> --note "…" records your judgement.`); }
  process.exit(0);
}

const sum = summarize(records, { sinceMs, ratings });
if (json) { say(JSON.stringify({ since, file: recordsFile(), ratings: ratingsFile(), total: sum.total, shadows: sum.shadows, trials: sum.trials, paired: sum.paired, rated: sum.rated, unrated: sum.unrated, causes: sum.causes, kinds: sum.kinds, notModel: sum.notModel, rows: sum.rows, pairs: sum.pairs.slice(0, limit).map((p) => ({ pair: p.pair, ts: p.ts, label: p.shadow.label, trial: p.trial, shadow: slim(p.shadow), reference: p.reference ? slim(p.reference) : null, rating: p.rating ? { grade: p.rating.grade, cause: p.rating.cause || null, kind: p.rating.kind || null, by: p.rating.by, note: p.rating.note, ts: p.rating.ts } : null })) })); process.exit(0); }
function slim(r) { return { job: r.job, delegate: r.delegate, model: r.model, effort: r.effort, rules: r.rules, status: r.status, dur: r.dur, tokens: r.tokens, cached: r.cached, steps: r.steps, cost: r.cost, costKind: r.costKind, edit: r.edit, files: r.files }; }

say(`[multiclaude shadow] ${sum.shadows} shadow run${sum.shadows === 1 ? '' : 's'} ${span}, ${sum.paired} with the real agent's result · ${sum.trials} pi run${sum.trials === 1 ? '' : 's'} of ${sum.trials === 1 ? 'its' : 'their'} own · ${sum.rated} rated   records: ${recordsFile()}`);
if (!sum.total) {
  say('  nothing recorded. Shadows are off by default: /multiclaude:shadow on (or /delegates settings → 8) starts one pi run beside every agent.');
  process.exit(0);
}
say('');
say('Per pi model × rules version (medians; "vs ref" = the shadow against the agent it ran beside, successful shadows only):');
for (const r of sum.rows) {
  say(`  ${r.model} · rules ${r.rules || '?'} — ${r.runs} run${r.runs === 1 ? '' : 's'}${r.trial ? ` (${r.trial === r.runs ? 'trial' : `${r.trial} trial`})` : ''}: ok ${r.ok} (${pct(r.okRate)}) · stuck ${r.stuck} (${pct(r.stuckRate)}) · failed ${r.failed}${r.infra ? ` · not counted ${r.infra}` : ''}`);
  say(`      ${num(r.steps)} steps · ${num(r.tokens)} tokens · ${num(r.dur, 's')} · first token ${r.ttft == null ? '—' : num(r.ttft / 1000, 's')} · input cached ${pct(r.cachedShare)} · spent ${usd(r.cost, r.costApprox)}`);
  if (r.rated) say(`      rated ${r.rated}: ${r.ratedPass} pass · ${r.ratedRework} rework · ${r.ratedFail} fail${r.notModel ? ` · not the model ${r.notModel}` : ''}${Object.keys(r.causes || {}).length ? ` — ${tally(r.causes)}` : ''}`);
  if (r.paired) say(`      vs ref: ${times(r.durRatio)} the time · ${times(r.tokenRatio)} the tokens${r.sameFiles == null ? '' : ` · ${pct(r.sameFiles)} of the touched files in common`}`);
}
if (sum.rated) {
  say('');
  say(`Where pi fell short (the newest rating of each run that was not a pass; ? = no cause given): ${Object.keys(sum.causes).length ? tally(sum.causes) : 'nothing — every rated run passed'}`);
  if (Object.keys(sum.notModel || {}).length) say(`Not the model's doing, counted for nobody: ${tally(sum.notModel)} (env = the shadow lacked a file, login or tool the real agent had; infra = provider / gateway)`);
  say(`By task kind (? = not given): ${Object.entries(sum.kinds).sort((a, b) => b[1].rated - a[1].rated).map(([k, v]) => `${k} ${v.pass}/${v.rated} pass${v.rework ? ` · ${v.rework} rework` : ''}${v.fail ? ` · ${v.fail} fail` : ''}`).join('  |  ')}`);
}
if (sum.unrated) say(`${sum.unrated} pair${sum.unrated === 1 ? '' : 's'} with a reference not rated yet — the automatic review rates them while shadows are on (\`/multiclaude:shadow auto\`).`);
say('');
say(`Newest pairs (${Math.min(limit, sum.pairs.length)} of ${sum.pairs.length}):`);
for (const p of sum.pairs.slice(0, limit)) {
  const s = p.shadow, r = p.reference;
  say(`  ${when(p.ts)}  ${one(s.label || '', 34).padEnd(34)}  pi ${s.status} ${num(s.dur, 's')} ${num(s.steps)} steps  ·  ${p.trial ? 'trial run' : r ? `${r.delegate}:${one(r.model, 24)} ${r.status || 'done'} ${num(r.dur, 's')}` : 'reference not recorded'}${p.rating ? `  ·  rated ${p.rating.grade}${p.rating.cause && p.rating.grade !== 'pass' ? `/${p.rating.cause}` : ''} (${one(p.rating.by, 24)})` : ''}  [${p.pair}]`);
}
say('');
say('ok / stuck say what the runner saw; a rating says whether the result was right. `/multiclaude:shadow pair <id>` shows both answers, the steps and the ratings,');
say('`/multiclaude:shadow rate <id> <pass|rework|fail> --cause <c> --kind <k> --note "…"` records yours, `/multiclaude:shadow review` asks AGY for verdicts and rule changes, `/multiclaude:shadow rules` shows the rules.');
