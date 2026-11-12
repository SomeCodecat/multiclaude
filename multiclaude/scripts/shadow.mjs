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
//   shadow.mjs rate <id> <pass|rework|fail> [--note t] [--gates t] [--by who]   one rating of a recorded pi run (pair or job id)
//   shadow.mjs rate --from <file> [--by who]   the `VERDICT <pair> <grade> — why` lines of a review answer → ratings
//   shadow.mjs rules                           the working rules a shadow gets today + where to add your own
//   shadow.mjs review-prompt [7d|…] [--n N]    a prompt that asks for rule changes from the newest pairs
//   shadow.mjs ready                           exit 0 when pi is installed and lists a model
//   shadow.mjs record                          stdin JSON → one reference record (the hooks module, for a Claude subagent)
import { readFileSync } from 'node:fs';
import { which, nfmt } from './lib/mc.mjs';
import { piModels, resolvePiBands } from './lib/models.mjs';
import { readRecords, recordsFile, writeRecord, summarize, pairUp, reviewPrompt, traceLines, piRules, piRulesFile, extraPiRules, rulesHash, readRatings, writeRating, ratingsFile, parseVerdicts, GRADES } from './lib/shadow.mjs';

const argv = process.argv.slice(2);
const cmd = ['pair', 'rules', 'review-prompt', 'ready', 'record', 'rate'].includes(argv[0]) ? argv.shift() : 'summary';
const USAGE = 'usage: shadow.mjs [7d|24h|30d|all] [N] [--json] | pair <id> | rate <id> <pass|rework|fail> [--note t] [--gates t] [--by who] | rate --from <file> [--by who] | rules | review-prompt [--n N] | ready | record';

// ── rate: one judgement of a recorded pi run, kept in ratings.jsonl ──
if (cmd === 'rate') {
  const opt = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (['--note', '--gates', '--by', '--from'].includes(argv[i])) opt[argv[i].slice(2)] = argv[++i] ?? '';
    else pos.push(argv[i]);
  }
  const pairs = pairUp(readRecords(), { ratings: readRatings() });
  const find = (x) => pairs.find((p) => p.pair === x || p.shadow.job === x);
  const put = (p, grade, by, note, gates) => { const r = p.shadow; return writeRating({ job: r.job, pair: p.pair, delegate: 'pi', model: r.model, rules: r.rules, grade, by, note, gates, kind: p.trial ? 'trial' : 'shadow', label: r.label, task: r.task, status: r.status, tokens: r.tokens, dur: r.dur, steps: r.steps, cost: r.cost }); };
  if (opt.from != null) {
    let text;
    try { text = readFileSync(opt.from, 'utf8'); } catch (e) { process.stderr.write(`shadow rate: cannot read ${opt.from}: ${e.message}\n`); process.exit(2); }
    const by = opt.by || 'review';
    let done = 0, unknown = 0, had = 0;
    for (const v of parseVerdicts(text)) {
      const p = find(v.pair);
      if (!p) unknown++;
      else if ((p.ratings || []).some((r) => r.by === by)) had++;   // the same reviewer twice: the first verdict stands
      else if (put(p, v.grade, by, v.note, null)) done++;
    }
    process.stdout.write(`${done} verdict${done === 1 ? '' : 's'} recorded as rating${done === 1 ? '' : 's'} by ${by}${had ? ` · ${had} already rated by it` : ''}${unknown ? ` · ${unknown} named no recorded pair` : ''}\n`);
    process.exit(0);
  }
  if (pos.length !== 2 || !GRADES.includes(pos[1])) { process.stderr.write(USAGE + '\n'); process.exit(2); }
  const p = find(pos[0]);
  if (!p) { process.stdout.write(`No recorded pi run ${pos[0]} in ${recordsFile()} (a pair id or the pi job id; /multiclaude:shadow lists them).\n`); process.exit(1); }
  const w = put(p, pos[1], opt.by || 'user', opt.note || null, opt.gates || null);
  process.stdout.write(w ? `rated ${p.pair} (pi ${p.shadow.model} · rules ${p.shadow.rules || '?'}): ${w.grade} by ${w.by} — kept in ${ratingsFile()}\n` : 'not recorded\n');
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
  if (p.ratings.length) { say(''); say('RATINGS'); for (const g of p.ratings) say(`  ${when(g.ts)}  ${g.grade} by ${g.by}${g.note ? ` — ${one(g.note, 400)}` : ''}${g.gates ? `\n      checked: ${one(g.gates, 400)}` : ''}`); }
  else { say(''); say(`Not rated. /multiclaude:shadow rate ${p.pair} <pass|rework|fail> --note "…" records your judgement.`); }
  process.exit(0);
}

const sum = summarize(records, { sinceMs, ratings });
if (json) { say(JSON.stringify({ since, file: recordsFile(), ratings: ratingsFile(), total: sum.total, shadows: sum.shadows, trials: sum.trials, paired: sum.paired, rated: sum.rated, rows: sum.rows, pairs: sum.pairs.slice(0, limit).map((p) => ({ pair: p.pair, ts: p.ts, label: p.shadow.label, trial: p.trial, shadow: slim(p.shadow), reference: p.reference ? slim(p.reference) : null, rating: p.rating ? { grade: p.rating.grade, by: p.rating.by, note: p.rating.note, ts: p.rating.ts } : null })) })); process.exit(0); }
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
  if (r.rated) say(`      rated ${r.rated}: ${r.ratedPass} pass · ${r.ratedRework} rework · ${r.ratedFail} fail`);
  if (r.paired) say(`      vs ref: ${times(r.durRatio)} the time · ${times(r.tokenRatio)} the tokens${r.sameFiles == null ? '' : ` · ${pct(r.sameFiles)} of the touched files in common`}`);
}
say('');
say(`Newest pairs (${Math.min(limit, sum.pairs.length)} of ${sum.pairs.length}):`);
for (const p of sum.pairs.slice(0, limit)) {
  const s = p.shadow, r = p.reference;
  say(`  ${when(p.ts)}  ${one(s.label || '', 34).padEnd(34)}  pi ${s.status} ${num(s.dur, 's')} ${num(s.steps)} steps  ·  ${p.trial ? 'trial run' : r ? `${r.delegate}:${one(r.model, 24)} ${r.status || 'done'} ${num(r.dur, 's')}` : 'reference not recorded'}${p.rating ? `  ·  rated ${p.rating.grade} (${one(p.rating.by, 24)})` : ''}  [${p.pair}]`);
}
say('');
say('ok / stuck say what the runner saw; a rating says whether the result was right. `/multiclaude:shadow pair <id>` shows both answers, the steps and the ratings,');
say('`/multiclaude:shadow rate <id> <pass|rework|fail> --note "…"` records yours, `/multiclaude:shadow review` asks AGY for verdicts and rule changes, `/multiclaude:shadow rules` shows the rules.');
