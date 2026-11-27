// node --test tests/shadow.test.mjs — shadow runs: the record library (scripts/lib/shadow.mjs),
// the runner flags behind them (scripts/dispatch.mjs --shadow-of / --reference / --band, with a
// fake `pi` on PATH) and the reader (scripts/shadow.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { sandboxReady, sandboxArgs, sandboxEnv, scratchPaths, freezeScratch } from '../scripts/lib/sandbox.mjs';
import { scrub, buildRecord, pairUp, summarize, reviewPrompt, treeSnap, patchBetween, piRules, rulesHash, extraPiRules, writeRating, readRatings, ratingsFile, parseVerdicts, CAUSES, KINDS, causeOf, kindOf, autoReviewPlan, NOT_MODEL, snapCommit, SNAP_SUBJECT, parseJudge, judgePrompt, judgeOn, judgeCeiling, JUDGE_STOP_CAUSES } from '../scripts/lib/shadow.mjs';

const RUNNER = fileURLToPath(new URL('../scripts/dispatch.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/shadow.mjs', import.meta.url));
const unix = process.platform !== 'win32';   // the fake CLI is a shebang script

// ── the library ──
test('scrub: keys, tokens, URL credentials and NAME=value secrets are replaced; code stays', () => {
  const s = scrub([
    'API_KEY=abcdef0123456789', 'export GITHUB_TOKEN="ghp_0123456789abcdefghijABCDEFGHIJ"', 'curl -H "Authorization: Bearer abcdefghijklmnop.qrstuv"',
    'git clone https://bot:hunter2secret@example.com/r.git', '"password": "correct horse battery"', 'key sk-proj_0123456789abcdefghij',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----', 'const tokens = count(input);', 'return a + b;',
  ].join('\n'));
  for (const leak of ['abcdef0123456789', 'ghp_0123456789', 'abcdefghijklmnop.qrstuv', 'hunter2secret', 'correct horse battery', 'sk-proj_0123456789', 'AAAA']) assert.ok(!s.includes(leak), `${leak} is still in:\n${s}`);
  assert.match(s, /const tokens = count\(input\);/);
  assert.match(s, /return a \+ b;/);
  assert.match(s, /https:\/\/bot:\[redacted\]@example\.com/);
});

test('a record is capped and scrubbed; a long trace keeps both ends', () => {
  const trace = Array.from({ length: 300 }, (_, i) => ({ k: 'tool', tool: 'read', args: { path: `f${i}` }, ms: 5, result: 'SECRET_TOKEN=abcdef0123456' }));
  const r = buildRecord({ pair: 'p1', role: 'shadow', prompt: 'x'.repeat(70_000), answer: 'TOKEN=abcdef0123456', trace });
  assert.ok(r.prompt.length < 61_000 && /more characters cut/.test(r.prompt));
  assert.equal(r.answer, 'TOKEN=[redacted]');
  assert.equal(r.trace.length, 161);
  assert.deepEqual(r.trace[80], { k: 'cut', n: 140 });
  assert.equal(r.trace[0].result, 'SECRET_TOKEN=[redacted]');
  assert.match(r.task, /^[0-9a-f]{10}$/);
});

const rec = (o) => ({ v: 1, ts: new Date().toISOString(), role: 'shadow', delegate: 'pi', model: 'm-low', rules: 'aaaa1111', status: 'SUCCESS', edit: true, ...o });
test('pairs and figures: one row per pi model × rules version; infra runs count for nobody', () => {
  const records = [
    rec({ pair: 'a', dur: 100, tokens: 4000, steps: 10, in: 500, cached: 500, files: ['x.js', 'y.js'], trace: [{ k: 'call', ttft: 800 }, { k: 'call', ttft: 1200 }] }),
    rec({ pair: 'a', role: 'reference', delegate: 'codex', model: 'ref', dur: 20, tokens: 1000, files: ['x.js'] }),
    rec({ pair: 'b', status: 'LOOP', dur: 300, tokens: 9000, steps: 25 }),
    rec({ pair: 'c', status: 'QUOTA' }),
    rec({ pair: 'd', rules: 'bbbb2222', dur: 50, tokens: 2000, steps: 4 }),
    rec({ pair: 'e', role: 'reference', delegate: 'claude', model: 'ref' }),   // a reference with no shadow is no pair
  ];
  const s = summarize(records);
  assert.equal(s.total, 4);
  assert.equal(s.paired, 1);
  const a = s.rows.find((r) => r.rules === 'aaaa1111');
  assert.deepEqual([a.runs, a.ok, a.stuck, a.infra, a.failed, a.paired], [3, 1, 1, 1, 0, 1]);
  assert.equal(a.okRate, 0.5);
  assert.equal(a.durRatio, 5);
  assert.equal(a.tokenRatio, 4);
  assert.equal(a.sameFiles, 0.5);
  assert.equal(a.cachedShare, 0.5);
  assert.equal(a.ttft, 1000);
  assert.equal(s.rows.find((r) => r.rules === 'bbbb2222').runs, 1);
  assert.deepEqual(pairUp(records).map((p) => p.pair).sort(), ['a', 'b', 'c', 'd']);
});

test('scrub: keys with an underscore, temporary key ids, a token as the userinfo; fields of known objects stay', () => {
  const s = scrub([
    'stripe sk_live_abcdefghij0123456789',
    'sts ASIAIOSFODNN7EXAMPLE',
    'git clone https://abcdefghij0123456789abcd@example.com/x.git',
    'git clone ssh://git@example.com/x.git',
    'const apiKey = config.apiKey;',
    'token = this.session.token',
    'token = abcdef.ghijkl',
  ].join('\n'));
  assert.ok(!/sk_live_abc/.test(s) && !/ASIAIOSFODNN7EXAMPLE/.test(s) && !/abcdefghij0123456789abcd@/.test(s), s);
  assert.match(s, /ssh:\/\/git@example\.com/);
  assert.match(s, /apiKey = config\.apiKey/);
  assert.match(s, /token = this\.session\.token/);
  assert.match(s, /token = \[redacted\]/);
});

test('pairUp: the newest record of a role wins whatever the order; the period cuts pairs, not sides', () => {
  const r = (o) => ({ pair: 'p', role: 'shadow', ts: '2026-11-11T12:00:00.000Z', ...o });
  const two = [r({ status: 'SUCCESS' }), r({ ts: '2026-11-11T10:00:00.000Z', status: 'FAILED' })];
  assert.equal(pairUp(two)[0].shadow.status, 'SUCCESS');
  assert.equal(pairUp([...two].reverse())[0].shadow.status, 'SUCCESS');
  const cut = Date.parse('2026-11-11T11:00:00.000Z');
  const split = [r({ role: 'reference', ts: '2026-11-11T10:59:00.000Z', job: 'ref' }), r({ ts: '2026-11-11T11:05:00.000Z' })];
  assert.equal(pairUp(split, { sinceMs: cut })[0].reference.job, 'ref');
  assert.equal(pairUp([r({ ts: '2026-11-11T09:00:00.000Z' })], { sinceMs: cut }).length, 0);
  assert.equal(pairUp([{ role: 'shadow', ts: '2026-11-11T12:00:00.000Z' }, null]).length, 0);
});

test('the review prompt carries the task, both answers, the steps and the rules; no pairs → null', () => {
  assert.equal(reviewPrompt([rec({ pair: 'solo' })]), null);
  const p = reviewPrompt([
    rec({ pair: 'a', prompt: 'Rename foo to bar in util.js', answer: 'I renamed it.', steps: 3, trace: [{ k: 'tool', tool: 'read', args: '{"path":"util.js"}' }, { k: 'tool', tool: 'edit', args: '{"path":"util.js"}', error: true, result: 'no match' }] }),
    rec({ pair: 'a', role: 'reference', delegate: 'codex', model: 'ref', answer: 'Renamed foo → bar, tests 3/3.' }),
  ], { rules: ['- Make the smallest change that satisfies the task.'] });
  assert.match(p, /^You are tuning the working rules/);
  for (const part of ['Rename foo to bar in util.js', 'I renamed it.', 'Renamed foo → bar, tests 3/3.', '✗ edit', 'no match', '- Make the smallest change', 'VERDICT <pair id> <pass|rework|fail>']) assert.ok(p.includes(part), part);
});

test('ratings: written 0600 beside the records, scrubbed; they join the pi run they judge, not its reference', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-rate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { MULTICLAUDE_SHADOW_DIR: dir };
  assert.equal(writeRating({ job: 'j1', grade: 'great' }, env), null);          // not a grade
  assert.equal(writeRating({ grade: 'pass' }, env), null);                       // names no run
  const w = writeRating({ job: 'sh1', pair: 'a', model: 'pi-m', rules: 'aaaa1111', grade: 'rework', by: 'orchestrator', note: 'left TOKEN=abcdef0123456 in the log', gates: 'npm test: 1 failed' }, env);
  assert.equal(w.note, 'left TOKEN=[redacted] in the log');
  writeRating({ job: 'ref1', pair: 'a', delegate: 'codex', grade: 'pass', ts: '2026-01-01T00:00:02.000Z' }, env);   // the reference's own grade
  writeRating({ pair: 'a', grade: 'fail', by: 'user', ts: '2026-01-01T00:00:01.000Z' }, env);                       // no job: the pair, so the pi run — it is the only run a pair id rates
  writeRating({ job: 't1', pair: 't1', grade: 'pass', by: 'review:m', ts: '2026-01-01T00:00:03.000Z' }, env);
  if (unix) assert.equal(statSync(ratingsFile(env)).mode & 0o777, 0o600);
  const ratings = readRatings(env);
  assert.equal(ratings.length, 4);
  const records = [
    rec({ pair: 'a', job: 'sh1' }), rec({ pair: 'a', role: 'reference', job: 'ref1', delegate: 'codex', model: 'ref' }),
    rec({ pair: 't1', job: 't1', role: 'trial', answer: 'Added the flag.' }), rec({ pair: 'u', job: 'sh2' }),
  ];
  assert.equal(buildRecord({ pair: 't1', role: 'trial' }).role, 'trial');
  const by = Object.fromEntries(pairUp(records, { ratings }).map((p) => [p.pair, p]));
  assert.deepEqual(by.a.ratings.map((r) => `${r.grade}/${r.by}`), ['fail/user', 'rework/orchestrator']);   // oldest first, the reference's pass is not here
  assert.equal(by.a.rating.grade, 'rework');
  assert.deepEqual([by.t1.trial, by.t1.rating.grade, by.u.rating], [true, 'pass', null]);
  const s = summarize(records, { ratings });
  assert.deepEqual([s.total, s.shadows, s.trials, s.paired, s.rated], [3, 2, 1, 1, 2]);
  assert.deepEqual([s.rows[0].runs, s.rows[0].trial, s.rows[0].rated, s.rows[0].ratedPass, s.rows[0].ratedRework, s.rows[0].ratedFail], [3, 1, 2, 1, 1, 0]);
  // the review: a rated run needs no reference; a rating is shown as given and gets no second verdict
  const p = reviewPrompt(records, { ratings });
  assert.match(p, /pair id t1[\s\S]*REFERENCE — none[\s\S]*RATING — pass, by review:m/);
  assert.match(p, /RATING — rework, by orchestrator · checked: npm test: 1 failed · left TOKEN=\[redacted\] in the log/);
  assert.ok(!/pair id u\b/.test(p));   // nothing to hold it against
});

test('parseVerdicts reads the VERDICT lines of a review answer, however they are decorated', () => {
  const v = parseVerdicts(['Here is my review.', 'VERDICT agent-42 rework — missed the empty case', '- **VERDICT** jabc123: fail', '> VERDICT `live1ref` pass - same findings',
    'VERDICT agent-42 pass — on second thought', 'VERDICT x maybe — no', 'the VERDICT y pass is not at the line start', 'VERDICT z passable'].join('\n'));
  assert.deepEqual(v, [{ pair: 'agent-42', grade: 'pass', cause: null, kind: null, note: 'on second thought' }, { pair: 'live1ref', grade: 'pass', cause: null, kind: null, note: 'same findings' }]);
});

test('parseVerdicts: cause and kind words before the separator, either order; a word in the reason is no cause', () => {
  const v = parseVerdicts(['VERDICT a fail loop ops — re-ran the playbook check 9 times', 'VERDICT b rework `bugfix` `misread` — wrong file',
    'VERDICT c fail - none of it worked', 'VERDICT d pass none review', 'VERDICT e fail false-claim: said tests passed, ran none', 'VERDICT f rework broke frobnicate — no'].join('\n'));
  const by = Object.fromEntries(v.map((x) => [x.pair, x]));
  assert.deepEqual([by.a.cause, by.a.kind, by.a.note], ['loop', 'ops', 're-ran the playbook check 9 times']);
  assert.deepEqual([by.b.cause, by.b.kind, by.b.note], ['misread', 'bugfix', 'wrong file']);
  assert.deepEqual([by.c.cause, by.c.kind, by.c.note], [null, null, 'none of it worked']);
  assert.deepEqual([by.d.cause, by.d.kind], ['none', 'review']);
  assert.deepEqual([by.e.cause, by.e.note], ['false-claim', 'said tests passed, ran none']);
  assert.deepEqual([by.f.cause, by.f.kind, by.f.note], ['broke', null, 'frobnicate — no']);   // an unknown word ends the words
  assert.deepEqual([causeOf(' Loop '), causeOf('lazy'), kindOf('OPS'), kindOf('trial')], ['loop', null, 'ops', null]);
});

test('summarize: where pi falls short — causes of the non-passes, grades per task kind, the unrated pairs', () => {
  const records = [
    rec({ pair: 'a', job: 'a' }), rec({ pair: 'a', role: 'reference', delegate: 'codex', model: 'ref' }),
    rec({ pair: 'b', job: 'b' }), rec({ pair: 'b', role: 'reference', delegate: 'codex', model: 'ref' }),
    rec({ pair: 'c', job: 'c' }), rec({ pair: 'c', role: 'reference', delegate: 'codex', model: 'ref' }),
    rec({ pair: 'd', job: 'd' }), rec({ pair: 'd', role: 'reference', delegate: 'codex', model: 'ref' }),   // unrated
    rec({ pair: 'e', job: 'e', status: 'QUOTA' }), rec({ pair: 'e', role: 'reference', delegate: 'codex', model: 'ref' }),   // infra: not reviewable
    rec({ pair: 'f', job: 'f' }),   // no reference, no rating: nothing to hold it against
  ];
  const ratings = [
    { job: 'a', grade: 'fail', cause: 'loop', kind: 'ops', ts: '2026-01-01T00:00:00Z' },
    { job: 'a', grade: 'fail', cause: 'knowledge', kind: 'ops', ts: '2026-01-02T00:00:00Z' },   // the newest counts
    { job: 'b', grade: 'pass', cause: 'none', kind: 'bugfix', ts: '2026-01-01T00:00:00Z' },
    { job: 'c', grade: 'rework', kind: 'trial', ts: '2026-01-01T00:00:00Z' },   // an old kind word, no cause
  ];
  const s = summarize(records, { ratings });
  assert.deepEqual(s.causes, { knowledge: 1, '?': 1 });
  assert.deepEqual(s.kinds, { ops: { rated: 1, pass: 0, rework: 0, fail: 1 }, bugfix: { rated: 1, pass: 1, rework: 0, fail: 0 }, '?': { rated: 1, pass: 0, rework: 1, fail: 0 } });
  assert.equal(s.unrated, 1);
  assert.deepEqual(s.rows[0].causes, { knowledge: 1, '?': 1 });
});

test('summarize: a rework / fail that is not the model\'s (infra, env) counts for nobody; a pass stays a pass', () => {
  const records = ['a', 'b', 'c', 'd'].flatMap((x) => [rec({ pair: x, job: x }), rec({ pair: x, role: 'reference', delegate: 'codex', model: 'ref' })]);
  const ratings = [
    { job: 'a', grade: 'fail', cause: 'env', kind: 'ops', ts: '2026-01-01T00:00:00Z' },
    { job: 'b', grade: 'rework', cause: 'infra', kind: 'research', ts: '2026-01-01T00:00:00Z' },
    { job: 'c', grade: 'fail', cause: 'broke', kind: 'ops', ts: '2026-01-01T00:00:00Z' },
    { job: 'd', grade: 'pass', cause: 'env', kind: 'review', ts: '2026-01-01T00:00:00Z' },
  ];
  const s = summarize(records, { ratings });
  assert.deepEqual(s.causes, { broke: 1 });
  assert.deepEqual(s.notModel, { env: 1, infra: 1 });
  assert.deepEqual(s.kinds, { ops: { rated: 1, pass: 0, rework: 0, fail: 1 }, review: { rated: 1, pass: 1, rework: 0, fail: 0 } });
  const r = s.rows[0];
  assert.deepEqual([r.rated, r.ratedPass, r.ratedRework, r.ratedFail, r.notModel], [4, 1, 0, 1, 2]);
  assert.ok(NOT_MODEL.has('env') && NOT_MODEL.has('infra') && !NOT_MODEL.has('knowledge'));
});

test('the automatic review: due at min unrated pairs, at most every N minutes, or when one waited a day; a pair skipped twice is left out', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600_000).toISOString();
  const pair = (id, o = {}) => ({ pair: id, ts: ago(1), shadow: { status: 'SUCCESS' }, reference: { status: 'SUCCESS' }, rating: null, ...o });
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => pair(id));
  let r = autoReviewPlan(five, {}, now);
  assert.deepEqual([r.due, r.unrated], [false, 5]);
  assert.match(r.why, /5 unrated pairs, waiting for 6/);
  r = autoReviewPlan([...five, pair('f')], {}, now);
  assert.deepEqual([r.due, r.unrated, r.pairs.length], [true, 6, 6]);
  r = autoReviewPlan([...five, pair('f')], { lastAt: ago(0.5) }, now);
  assert.equal(r.due, false);
  assert.match(r.why, /30 min ago/);
  assert.equal(autoReviewPlan([pair('old', { ts: ago(25) })], {}, now).due, true);   // waited longer than a day
  assert.equal(autoReviewPlan([pair('x')], {}, now, { force: true }).due, true);
  // rated, infra and reference-less pairs are not counted; tried twice → skipped
  r = autoReviewPlan([pair('r', { rating: { grade: 'pass' } }), pair('q', { shadow: { status: 'QUOTA' } }), pair('n', { reference: null }), pair('t'), ...five],
    { tried: { t: 2, a: 1 } }, now);
  assert.deepEqual([r.unrated, r.skipped, r.pairs.includes('t'), r.pairs.includes('a')], [5, 1, false, true]);
  assert.equal(autoReviewPlan([pair('r', { rating: { grade: 'pass' } })], {}, now, { force: true }).due, false);
});

test('the verdicts-only review prompt: unrated pairs only, none excluded, cut to fit', () => {
  const recs = [];
  for (const id of ['a', 'b', 'c']) recs.push(rec({ pair: id, job: id, prompt: `task ${id} ` + 'x'.repeat(2500), answer: 'y'.repeat(2400) }), rec({ pair: id, role: 'reference', delegate: 'codex', model: 'ref', answer: 'z'.repeat(2400) }));
  const ratings = [{ job: 'a', grade: 'pass', ts: '2026-01-01T00:00:00Z' }];
  const p = reviewPrompt(recs, { ratings, unratedOnly: true, verdictsOnly: true, exclude: new Set(['c']) });
  assert.match(p, /^You are rating the results/);
  assert.match(p, /Answer with the VERDICT lines only/);
  assert.match(p, /cause = the main reason/);
  assert.ok(p.includes('pair id b') && !p.includes('pair id a') && !p.includes('pair id c'));
  assert.ok(!p.includes('working rules'));
  // maxChars: the first pair always rides (cut), the rest only while they fit
  const small = reviewPrompt(recs, { verdictsOnly: true, unratedOnly: true, maxChars: 9000 });
  assert.ok(small.length <= 9000 + 2000, String(small.length));
  assert.ok(small.includes('pair id') && (small.match(/### Pair/g) || []).length === 1);
  assert.equal(reviewPrompt(recs, { ratings: [...ratings, { job: 'b', grade: 'fail' }, { job: 'c', grade: 'fail' }], unratedOnly: true }), null);
});

test('the rating words of the hooks module are the library\'s', () => {
  const src = readFileSync(fileURLToPath(new URL('../hooks/register.tsx', import.meta.url)), 'utf8');
  const list = (name) => JSON.parse(new RegExp(`export const ${name} = (\\[[^\\]]*\\])`).exec(src)[1].replace(/'/g, '"'));
  assert.deepEqual(list('CAUSES'), Object.keys(CAUSES));
  assert.deepEqual(list('KINDS'), KINDS);
  assert.match(src, /shadowBand = \(n: number\): Band => \(n % 5 === 4 \? 'hi' : 'med'\)/);
});

test('rules: your own lines ride last and change the rules version', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-rules-'));
  try {
    const f = path.join(dir, 'pi-rules.md');
    const env = { MULTICLAUDE_PI_RULES: f };
    const before = piRules({ edit: true, shell: false, shadow: true }, env);
    writeFileSync(f, '# my rules\n- Name the file you will edit before you edit it.\n* Stop after the first passing check.\nnot a rule\n');
    assert.deepEqual(extraPiRules(env), ['- Name the file you will edit before you edit it.', '- Stop after the first passing check.']);
    const after = piRules({ edit: true, shell: false, shadow: true }, env);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after.length, before.length + 2);
    assert.notEqual(rulesHash(after), rulesHash(before));
    assert.ok(before.some((l) => /practice run/.test(l)) && before.some((l) => /no shell/.test(l)));
    assert.ok(!piRules({ edit: true, shell: true, shadow: false }, env).some((l) => /practice run|no shell/.test(l)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
function repo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
}

test('treeSnap reads the tree as it is on disk and leaves the real index alone', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-tree-'));
  try {
    repo(dir);
    const t0 = treeSnap(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    writeFileSync(path.join(dir, 'new.txt'), 'n\n');
    const t1 = treeSnap(dir);
    assert.match(t0, /^[0-9a-f]{40}$/);
    assert.notEqual(t0, t1);
    const d = patchBetween(dir, t0, t1);
    assert.deepEqual(d.files.sort(), ['a.txt', 'new.txt']);
    assert.match(d.patch, /\+two/);
    assert.equal(git(dir, 'diff', '--cached', '--name-only').stdout.trim(), '', 'nothing was staged');
    assert.match(git(dir, 'status', '--short').stdout, /\?\? new\.txt/);
    assert.equal(treeSnap(os.tmpdir()), null);   // not a repository
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('snapCommit: the working tree as a commit on top of HEAD — untracked files in, ignored ones out, the index untouched', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-snap-'));
  try {
    repo(dir);
    const head = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    assert.deepEqual(snapCommit(dir), { commit: head, head, snapshot: false }, 'a clean tree is HEAD itself');
    writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    writeFileSync(path.join(dir, 'wip.txt'), 'w\n');
    writeFileSync(path.join(dir, '.gitignore'), '.venv\n');
    mkdirSync(path.join(dir, '.venv')); writeFileSync(path.join(dir, '.venv', 'big'), 'x');
    const sc = snapCommit(dir);
    assert.equal(sc.snapshot, true);
    assert.equal(sc.head, head);
    assert.equal(git(dir, 'log', '-1', '--format=%s %P', sc.commit).stdout.trim(), `${SNAP_SUBJECT} ${head}`);
    assert.deepEqual(git(dir, 'ls-tree', '--name-only', sc.commit).stdout.trim().split('\n').sort(), ['.gitignore', 'a.txt', 'wip.txt']);
    assert.equal(git(dir, 'show', `${sc.commit}:a.txt`).stdout, 'two\n');
    assert.equal(git(dir, 'diff', '--cached', '--name-only').stdout.trim(), '', 'nothing was staged');
    assert.equal(git(dir, 'rev-parse', 'HEAD').stdout.trim(), head, 'HEAD did not move');
    assert.equal(git(dir, 'branch', '--list').stdout.trim().split('\n').length, 1, 'no branch');
    assert.equal(snapCommit(os.tmpdir()), null);   // not a repository
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('snapCommit: a file git cannot read is left out with the reason — the snapshot of the rest is still made, not HEAD', { skip: (!unix || process.getuid?.() === 0) && 'needs a non-root unix user' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-snap-'));
  try {
    repo(dir);
    const head = git(dir, 'rev-parse', 'HEAD').stdout.trim();
    writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    writeFileSync(path.join(dir, 'locked.txt'), 's\n'); chmodSync(path.join(dir, 'locked.txt'), 0o000);
    const sc = snapCommit(dir);
    assert.equal(sc.snapshot, true, 'the uncommitted change still makes a snapshot');
    assert.notEqual(sc.commit, head);
    assert.match(sc.error, /git add left files out: .*locked\.txt/);
    assert.equal(git(dir, 'show', `${sc.commit}:a.txt`).stdout, 'two\n');
    assert.deepEqual(git(dir, 'ls-tree', '--name-only', sc.commit).stdout.trim().split('\n'), ['a.txt']);
    const info = {};
    assert.match(treeSnap(dir, info), /^[0-9a-f]{40}$/);
    assert.match(info.error, /locked\.txt/);
    assert.equal(git(dir, 'diff', '--cached', '--name-only').stdout.trim(), '', 'nothing was staged');
    chmodSync(path.join(dir, 'locked.txt'), 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('freezeScratch: the scratchpad as of a moment — older files copied with their time, newer ones left out, dirs walked, caps kept', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mc-frz-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const pad = path.join(tmp, 'pad'), dest = path.join(tmp, 'copy');
  mkdirSync(path.join(pad, 'clones', 'deep'), { recursive: true });
  const asOf = Date.now() - 60_000, old = new Date(asOf - 60_000);
  const put = (rel, text, when) => { const f = path.join(pad, rel); writeFileSync(f, text); if (when) utimesSync(f, when, when); return f; };
  const brief = put('brief.md', 'the task\n', old);
  const result = put('result.md', 'what the real agent found\n');   // written after the task began
  put('clones/x.txt', 'x\n', old); put('clones/deep/y.txt', 'y\n', old); put('clones/late.txt', 'late\n');
  const helper = put('run.sh', '#!/bin/sh\n', old); chmodSync(helper, 0o755); utimesSync(helper, old, old);
  const fz = freezeScratch([brief, result, path.join(pad, 'clones'), helper, path.join(pad, 'gone.txt')], { asOf, dest });
  assert.equal(fz.copied, 4);
  assert.equal(fz.skipped, 3, 'result.md, clones/late.txt, gone.txt');
  assert.deepEqual(fz.mounts.map((m) => m.dst), [brief, path.join(pad, 'clones'), helper], 'a newer file gets no mount: the shadow does not see it');
  const m = Object.fromEntries(fz.mounts.map((x) => [path.basename(x.dst), x.src]));
  assert.equal(readFileSync(m['brief.md'], 'utf8'), 'the task\n');
  assert.equal(Math.round(statSync(m['brief.md']).mtimeMs / 1000), Math.round(old.getTime() / 1000), 'the time comes along');
  assert.deepEqual(readdirSync(m.clones).sort(), ['deep', 'x.txt'], 'the newer file in a folder stays out');
  assert.equal(readFileSync(path.join(m.clones, 'deep', 'y.txt'), 'utf8'), 'y\n');
  assert.ok(statSync(m['run.sh']).mode & 0o100, 'a helper stays executable');
  assert.ok(fz.mounts.every((x) => x.src.startsWith(dest + path.sep) && !x.rw), 'copies under dest, read-only');
  const capped = freezeScratch([path.join(pad, 'clones')], { asOf, dest: path.join(tmp, 'c2'), maxFiles: 1 });
  assert.deepEqual([capped.copied, capped.skipped], [1, 2]);
  const small = freezeScratch([brief], { asOf, dest: path.join(tmp, 'c3'), maxBytes: 3 });
  assert.deepEqual([small.copied, small.mounts.length], [0, 0]);
  assert.deepEqual(freezeScratch([brief], { dest }), { mounts: [], copied: 0, skipped: 0 }, 'no moment, no copy');
});

test('the judge: its one line parsed however it is decorated; an unknown cause is no cause', () => {
  assert.deepEqual(parseJudge('JUDGE STOP loop — read the same file six times'), { verdict: 'STOP', cause: 'loop', why: 'read the same file six times' });
  assert.deepEqual(parseJudge('Thinking…\n**JUDGE EXTEND — editing the tests now**'), { verdict: 'EXTEND', cause: null, why: 'editing the tests now' });
  assert.deepEqual(parseJudge('`JUDGE STOP env - the fixture is missing`'), { verdict: 'STOP', cause: 'env', why: 'the fixture is missing' });
  assert.deepEqual(parseJudge('judge stop scope — did more'), { verdict: 'STOP', cause: null, why: 'did more' });
  assert.equal(parseJudge('I would extend it.'), null);
  assert.ok(JUDGE_STOP_CAUSES.every((c) => c in CAUSES), 'every stop cause is a rating cause');
});

test('the judge: its prompt shows the run — repeats, edits, the real agent, the newest steps — and asks for one line', () => {
  const p = judgePrompt({
    used: 960, limit: 1200, ceiling: 2400, task: 'Fix the parser.', edit: true, steps: 40, calls: 22, tokens: 90000,
    touched: ['src/p.js'], repeats: [{ n: 4, call: 'read {"path":"src/p.js"}' }], reference: { status: 'SUCCESS', dur: 300 },
    trace: [{ k: 'tool', tool: 'bash', args: { command: 'npm test' }, error: true, result: 'boom' }, { k: 'call', text: 'Trying again.' }], lastText: 'Trying again.',
  });
  assert.match(p, /960 s of its 1200 s limit; its hard ceiling is 2400 s\. Decide whether it gets 600 s more/);
  assert.match(p, /Fix the parser\. *\n/);
  assert.match(p, /Files edited: src\/p\.js/);
  assert.match(p, /4× read \{"path":"src\/p\.js"\}/);
  assert.match(p, /The real agent ended SUCCESS after 300 s/);
  assert.match(p, /✗ bash \{"command":"npm test"\} → boom/);
  assert.match(p, /JUDGE STOP <cause>/);
  assert.match(judgePrompt({ used: 1, limit: 2000, ceiling: 2400 }), /gets 400 s more/);
  assert.doesNotMatch(p, /^Pace:|^Model calls:/m, 'no figures, no lines');
});

test('the judge: its prompt shows the pace, failed model calls, and says env early, infra for the server', () => {
  const p = judgePrompt({
    used: 960, limit: 1200, ceiling: 2400, task: 'Check the host.', steps: 12, calls: 9,
    recentSteps: 0, idle: 410, callSecs: [95, null, 240], modelErrors: { n: 5, streak: 2, last: 'Request timed out.\n  after 600 s' },
  });
  assert.match(p, /^Pace: 0 tool steps in the last 5 min · last step 410 s ago · last model calls took 95 \/ 240 s$/m);
  assert.match(p, /^Model calls: 5 failed so far, 2 in a row now — last error: Request timed out\. after 600 s$/m);
  assert.match(p, /Cause env early: the run has no ssh, no logins and no live hosts/);
  assert.match(p, /the model server failing \(cause infra\)/);
  assert.doesNotMatch(judgePrompt({ used: 1, limit: 600, ceiling: 2400, modelErrors: { n: 0, streak: 0 } }), /Model calls:/);
});

test('the judge is on unless switched off; its ceiling is 40 min unless set', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-judge-'));
  try {
    const env = { MULTICLAUDE_SHADOW_DIR: dir };
    assert.equal(judgeOn(env), true);
    assert.equal(judgeOn({ ...env, MULTICLAUDE_SHADOW_JUDGE: 'off' }), false);
    writeFileSync(path.join(dir, 'judge.off'), '');
    assert.equal(judgeOn(env), false);
    assert.equal(judgeCeiling({}), 2400);
    assert.equal(judgeCeiling({ MULTICLAUDE_SHADOW_CEILING: '3600' }), 3600);
    assert.equal(judgeCeiling({ MULTICLAUDE_SHADOW_CEILING: '10' }), 2400, 'below 300 s is ignored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a record carries a shadow\'s base, whether it was masked, and the judge\'s verdicts', () => {
  const r = buildRecord({ pair: 'p', role: 'shadow', delegate: 'pi', model: 'm', base: 'snapshot', masked: true, judge: [{ at: 960, verdict: 'STOP', cause: 'loop', why: 'x'.repeat(900), model: 'g', via: 'agy' }] });
  assert.equal(r.base, 'snapshot');
  assert.equal(r.masked, true);
  assert.equal(r.judge[0].verdict, 'STOP');
  assert.match(r.judge[0].why, /^x{400}\s*… \[500 more characters cut\]$/);
  const old = buildRecord({ pair: 'p', role: 'shadow', delegate: 'pi', model: 'm' });
  assert.ok(!('base' in old) && !('masked' in old) && !('judge' in old), 'absent = recorded before the fix');
});

// ── the runner ──
// The fake speaks pi's `--mode json` stream and really writes files, so a patch exists.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const mode = process.env.FAKE_PI || 'edit';
if (process.argv.includes('--list-models')) {
  console.log('provider  model  context  max-out  thinking  images');
  for (const e of ['low', 'medium', 'xhigh']) console.log('local  fake-coder-' + e + '  262144  16384  yes  no');
  process.exit(0);
}
const argv = process.argv.slice(2), opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const out = (o) => console.log(JSON.stringify(o));
// The runner's salvage: the saved session resumed with no tools, the wrap-up on stdin, one text reply.
if (opt('--session') && argv.includes('--no-tools')) {
  let wrap = '';
  process.stdin.on('data', (d) => { wrap += d; }).on('end', () => {
    if (process.env.FAKE_PI_ARGV) fs.writeFileSync(process.env.FAKE_PI_ARGV + '.salvage', JSON.stringify({ argv, wrap, session: fs.existsSync(opt('--session')) }));
    const report = process.env.FAKE_PI_REPORT || 'Final report: read a.txt twice, it says one; the edit is not done.';
    if (report !== 'none') {
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: report } });
      out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: report }], usage: { input: 900, output: 60, totalTokens: 960 } } });
    }
    process.stdout.write('', () => process.exit(0));
  });
  return;
}
if (process.env.FAKE_PI_ARGV) fs.writeFileSync(process.env.FAKE_PI_ARGV, JSON.stringify({ argv, cwd: process.cwd(), guard: process.env.MC_GUARD || null, secret: process.env.SECRET_TOKEN || null }));
// like pi: --session-dir keeps the session as it goes (<time>_<uuid>.jsonl), the header first
if (opt('--session-dir') && !process.env.FAKE_PI_NOSESSION) fs.writeFileSync(path.join(opt('--session-dir'), new Date().toISOString().replace(/[:.]/g, '-') + '_' + process.pid + '.jsonl'), JSON.stringify({ type: 'session', cwd: process.cwd() }) + '\\n');
let n = 0;
const tool = (toolName, args) => {
  const toolCallId = 'c' + (++n);
  out({ type: 'tool_execution_start', toolCallId, toolName, args });
  out({ type: 'tool_execution_end', toolCallId, toolName, isError: false, durationMs: 7, result: { content: [{ type: 'text', text: 'ok' }] } });
};
const say = (text, stopReason) => {
  out({ type: 'turn_start' });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } });
  out({ type: 'message_end', message: { role: 'assistant', stopReason, durationMs: 40, content: text ? [{ type: 'text', text }] : [], usage: { input: 100, output: 20, cacheRead: 30, totalTokens: 120, cost: { total: 0.01 } } } });
};
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', async () => {
  if (process.env.FAKE_PI_STDIN) fs.writeFileSync(process.env.FAKE_PI_STDIN, stdin);
  if (mode === 'edit') {
    say('', 'toolUse'); tool('read', { path: 'a.txt' });
    fs.writeFileSync('a.txt', 'hello\\n'); tool('edit', { path: 'a.txt' });
    say('Done: a.txt now says hello.', 'stop');
  } else if (mode === 'masked') {   // inside bwrap: where am I, what do I see, can I change the repository
    const { execSync } = require('node:child_process');
    const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return 'FAILED'; } };
    say('', 'toolUse'); tool('read', { path: 'wip.txt' });
    const wip = fs.existsSync('wip.txt') ? fs.readFileSync('wip.txt', 'utf8').trim() : 'missing';
    fs.writeFileSync('a.txt', 'hello\\n'); tool('edit', { path: 'a.txt' });
    const status = sh('git status --short').replace(/\\s+/g, ' ');
    const add = sh('git add a.txt');
    const venv = fs.existsSync('.venv/marker') ? 'yes' : 'no';
    let venvRo = 'no'; try { fs.writeFileSync('.venv/x', '1'); } catch { venvRo = 'yes'; }
    say('cwd=' + process.cwd() + ' wip=' + wip + ' status=[' + status + '] add=' + (add === 'FAILED' ? 'refused' : 'ok') + ' venv=' + venv + ' venvRo=' + venvRo, 'stop');
  } else if (mode === 'slow') {   // reads the same file twice, then thinks for FAKE_PI_SLEEP ms
    say('', 'toolUse'); tool('read', { path: 'a.txt' }); tool('read', { path: 'a.txt' });
    await new Promise((r) => setTimeout(r, +process.env.FAKE_PI_SLEEP || 30000));
    say('a.txt says one.', 'stop');
  } else if (mode === 'scratch') {   // inside bwrap: which of the scratchpad paths it was given does it see, and what is in them
    const seen = (process.env.FAKE_PI_SCRATCH || '').split(',').map((p) => {
      let v = 'missing'; try { v = fs.statSync(p).isDirectory() ? 'dir[' + fs.readdirSync(p).sort().join(' ') + ']' : fs.readFileSync(p, 'utf8').trim(); } catch {}
      let ro = 'no'; try { fs.appendFileSync(fs.statSync(p).isDirectory() ? path.join(p, 'w') : p, ''); } catch { ro = 'yes'; }
      return path.basename(p) + '=' + v + ' ro=' + ro;
    });
    say('', 'toolUse'); tool('read', { path: 'notes.md' });
    say(seen.join(' | '), 'stop');
  } else if (mode === 'escape') {
    say('', 'toolUse'); tool('write', { path: process.env.FAKE_PI_TARGET });
    if (process.env.FAKE_PI_GOON) say('Refused, so I left it.', 'stop');
    else await new Promise((r) => setTimeout(r, 60000));
  } else {
    say('', 'toolUse'); tool('read', { path: 'a.txt' });
    say('a.txt says one.', 'stop');
  }
  out({ type: 'agent_settled', aborted: false });
  process.exit(0);
});
`;

// The judge's side: a fake agy (FAKE_JUDGE = the verdict it gives, `quota` = a spent pool; the prompt it got
// goes to FAKE_AGY_PROMPT) and a fake headless claude (FAKE_CLAUDE_JUDGE = its verdict).
const FAKE_AGY = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'models') { for (const e of ['low', 'medium', 'high']) console.log('gemini-3.8-flash-' + e + '\\tGemini Flash ' + e); process.exit(0); }
const prompt = (process.argv.find((a) => a.startsWith('--print=')) || '').slice(8);
if (!prompt) process.exit(0);   // the pool preflight: no figures
if (process.env.FAKE_AGY_PROMPT) fs.writeFileSync(process.env.FAKE_AGY_PROMPT, prompt);
if (process.env.FAKE_JUDGE === 'quota') { console.log(JSON.stringify({ event: 'result', result: { status: 'FAILED', error: 'RESOURCE_EXHAUSTED: quota exceeded', response: '' } })); process.exit(0); }
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'JUDGE ' + process.env.FAKE_JUDGE, usage: { total_tokens: 42 } } }));
`;
const FAKE_CLAUDE = `#!/usr/bin/env node
let input = ''; process.stdin.on('data', (d) => input += d).on('end', () => {
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'JUDGE ' + process.env.FAKE_CLAUDE_JUDGE, total_cost_usd: 0.002, modelUsage: { 'claude-haiku-5-5': { outputTokens: 30 } } }));
});
`;

function sandbox(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mc-shadow-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const bin = path.join(home, 'bin'), work = path.join(home, 'work');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'pi'), FAKE);
  chmodSync(path.join(bin, 'pi'), 0o755);
  for (const [name, body] of [['agy', FAKE_AGY], ['claude', FAKE_CLAUDE]]) { writeFileSync(path.join(bin, name), body); chmodSync(path.join(bin, name), 0o755); }
  const env = (mode, more = {}) => ({
    ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    PATH: bin + path.delimiter + process.env.PATH, FAKE_PI: mode, MULTICLAUDE_PRICES: 'off', MULTICLAUDE_WALLET_REFRESH: 'off',
    // the sandboxed shell has tests of its own below (the fake pi writes beside it, under a /tmp the sandbox hides)
    MULTICLAUDE_SHADOW_SHELL: 'off', MULTICLAUDE_REVIEW_CLAUDE: 'off',
    FAKE_PI_ARGV: path.join(home, 'argv.json'), FAKE_PI_STDIN: path.join(home, 'stdin.txt'), ...more,
  });
  const run = (mode, args, more) => spawnSync(process.execPath, [RUNNER, 'pi', '--job', 'auto', '--cd', work, '--no-preflight', ...args], { env: env(mode, more), input: `Make ${path.join(work, 'a.txt')} say hello.`, encoding: 'utf8', timeout: 60_000 });
  const records = () => {
    const f = path.join(home, 'data', 'multiclaude', 'shadow', 'records.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const lines = (name) => {
    const f = path.join(home, 'cache', 'multiclaude', name);
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const seen = () => JSON.parse(readFileSync(path.join(home, 'argv.json'), 'utf8'));
  const stdin = () => readFileSync(path.join(home, 'stdin.txt'), 'utf8');
  const ratings = () => {
    const f = path.join(home, 'data', 'multiclaude', 'shadow', 'ratings.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const jobs = () => readdirSync(path.join(home, 'cache', 'multiclaude', 'jobs')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(home, 'cache', 'multiclaude', 'jobs', f), 'utf8')));
  return { home, work, env, run, records, lines, seen, stdin, ratings, jobs };
}
const proofOf = (r) => (r.stderr.split('\n').filter((l) => l.startsWith('[dispatch ')).pop() || '');

test('a shadow edits in a throwaway worktree: the real tree is untouched, the patch is in the record', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  const head = git(s.work, 'rev-parse', 'HEAD').stdout.trim();
  const r = s.run('edit', ['--shadow-of', 'jprimary1', '--band', 'hi', '--edit', '--worktree', '--base', head, '--label', 'shadow · rename']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(proofOf(r), /model=fake-coder-xhigh status=SUCCESS .*shadow-of=jprimary1/);
  assert.ok(!/worktree=/.test(proofOf(r)));
  // the real checkout: same file, no branch, no worktree left
  assert.equal(readFileSync(path.join(s.work, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(git(s.work, 'status', '--short').stdout.trim(), '');
  assert.equal(git(s.work, 'branch', '--list', 'mc/*').stdout.trim(), '');
  assert.equal(git(s.work, 'worktree', 'list').stdout.trim().split('\n').length, 1);
  // pi ran inside the worktree, without a shell, with the practice rule, and the task's paths pointed there
  const seen = s.seen();
  assert.ok(seen.cwd.includes(path.join('multiclaude', 'shadow-wt')), seen.cwd);
  assert.equal(seen.argv[seen.argv.indexOf('--tools') + 1], 'read,grep,find,ls,edit,write');
  const prompt = s.stdin();
  assert.match(prompt, /This is a practice run/);
  assert.match(prompt, /You have no shell/);
  assert.ok(prompt.includes(path.join(seen.cwd, 'a.txt')) && !prompt.includes(path.join(s.work, 'a.txt')), 'the task names the worktree copy');
  // the record
  const [rec, ...rest] = s.records();
  assert.equal(rest.length, 0);
  assert.deepEqual([rec.pair, rec.role, rec.delegate, rec.model, rec.status, rec.edit, rec.shell], ['jprimary1', 'shadow', 'pi', 'fake-coder-xhigh', 'SUCCESS', true, false]);
  assert.deepEqual(rec.files, ['a.txt']);
  assert.match(rec.patch, /-one\n\+hello/);
  assert.match(rec.rules, /^[0-9a-f]{8}$/);
  assert.ok(rec.prompt.includes(path.join(s.work, 'a.txt')), 'the record keeps the task as written');
  assert.equal(rec.cwd, s.work);
  assert.deepEqual(rec.trace.map((x) => x.k), ['call', 'tool', 'tool', 'call']);
  assert.equal(rec.trace[1].tool, 'read');
  assert.equal(rec.trace[1].ms, 7);
  assert.equal(typeof rec.trace[0].ttft, 'number');
  assert.equal(rec.trace[0].cached, 30);
  assert.equal(rec.cached, 60);
  // the logs: a run line marked as a shadow, the job file too, nothing in the failure log
  const [line] = s.lines('runs.jsonl');
  assert.equal(line.shadowOf, 'jprimary1');
  const job = JSON.parse(readFileSync(path.join(s.home, 'cache', 'multiclaude', 'jobs', line.job + '.json'), 'utf8'));
  assert.equal(job.shadowOf, 'jprimary1');
  assert.equal(job.delegate, 'pi');
  assert.equal(readdirSync(path.join(s.home, 'cache', 'multiclaude', 'shadow-wt')).length, 0);
});

test('a shadow with no repository, or without --worktree, only reads', { skip: !unix }, (t) => {
  const s = sandbox(t);
  mkdirSync(s.work);
  writeFileSync(path.join(s.work, 'a.txt'), 'one\n');
  const r = s.run('read', ['--shadow-of', 'agent-7', '--edit', '--worktree']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.seen().argv[s.seen().argv.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.equal(s.seen().cwd, s.work);
  const [rec] = s.records();
  assert.deepEqual([rec.pair, rec.edit, rec.shell, rec.files], ['agent-7', false, false, null]);
  assert.equal(readFileSync(path.join(s.work, 'a.txt'), 'utf8'), 'one\n');
});

test('a write outside the shadow worktree stops the run as OUTSIDE and names the file', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  const target = path.join(s.home, 'elsewhere.txt');
  const r = s.run('escape', ['--shadow-of', 'jprimary2', '--edit', '--worktree'], { FAKE_PI_TARGET: target });
  assert.equal(r.status, 1, r.stderr);
  assert.match(proofOf(r), /status=OUTSIDE /);
  assert.ok(proofOf(r).includes(`outside="${target}"`));
  assert.ok(r.stdout.includes(target));
  assert.equal(s.records()[0].status, 'OUTSIDE');
  assert.equal(s.lines('failures.jsonl').length, 0, 'a shadow never lands in the failure log');
  // Behind the guard (a shell tier) the write is refused before it runs: the run goes on, with a note;
  // the temp dir is scratch, as for the shell, and gets no note.
  const keep = { MULTICLAUDE_SANDBOX_ENV: 'FAKE_PI,FAKE_PI_ARGV,FAKE_PI_STDIN,FAKE_PI_TARGET,FAKE_PI_GOON', FAKE_PI_GOON: '1' };
  const far = '/mc-nowhere/elsewhere.txt';   // the fake pi writes nothing; outside the temp dir
  const g = s.run('escape', ['--shadow-of', 'jprimary3', '--edit', '--worktree'], { FAKE_PI_TARGET: far, MULTICLAUDE_SHADOW_SHELL: 'guard', ...keep });
  assert.equal(g.status, 0, g.stderr);
  assert.match(proofOf(g), /status=SUCCESS /);
  assert.ok(g.stderr.includes(`write ${far} — outside the worktree, refused by the guard`), g.stderr);
  const tmp = s.run('escape', ['--shadow-of', 'jprimary4', '--edit', '--worktree'], { FAKE_PI_TARGET: path.join(os.tmpdir(), 'scratch.yml'), MULTICLAUDE_SHADOW_SHELL: 'guard', ...keep });
  assert.match(proofOf(tmp), /status=SUCCESS /);
  assert.ok(!tmp.stderr.includes('refused by the guard'), tmp.stderr);
});

test('--reference records the real run with the patch it made; --shadow-of is refused for other delegates', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  writeFileSync(path.join(s.work, 'wip.txt'), 'someone else\n');   // already in the tree: not the run's doing
  const r = s.run('edit', ['--model', 'fake-coder-low', '--reference', '--edit']);
  assert.equal(r.status, 0, r.stderr);
  const [rec] = s.records();
  const [line] = s.lines('runs.jsonl');
  assert.deepEqual([rec.role, rec.pair, rec.shell], ['reference', line.job, true]);
  assert.deepEqual(rec.files, ['a.txt']);
  assert.equal(line.shadowOf, undefined);
  assert.equal(readFileSync(path.join(s.work, 'a.txt'), 'utf8'), 'hello\n');   // a reference works in the real tree
  const bad = spawnSync(process.execPath, [RUNNER, 'codex', '--shadow-of', 'x', '--model', 'whatever'], { env: s.env('edit'), input: 'x', encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--shadow-of .* is for pi runs/);
});

// ── the reader ──
test('shadow.mjs: record takes a reference on stdin; the summary, a pair and the review prompt read it back', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  assert.equal(s.run('edit', ['--shadow-of', 'agent-42', '--edit', '--worktree', '--label', 'shadow · say hello']).status, 0);
  const cli = (args, input) => spawnSync(process.execPath, [CLI, ...args], { env: s.env('edit'), input: input ?? '', encoding: 'utf8' });
  assert.match(cli(['review-prompt']).stdout, /^NO_PAIRS /);
  const w = cli(['record'], JSON.stringify({ pair: 'agent-42', delegate: 'claude', model: 'ref-model', status: 'SUCCESS', dur: 12, tokens: 900, prompt: 'Make a.txt say hello.', answer: 'a.txt says hello now.', label: 'say hello' }));
  assert.equal(w.status, 0, w.stderr);
  assert.equal(cli(['record'], '{"no":"pair"}').status, 2);
  const sum = cli([]).stdout;
  assert.match(sum, /1 shadow run in the last 30d, 1 with the real agent's result/);
  assert.match(sum, /fake-coder-medium · rules [0-9a-f]{8} — 1 run: ok 1 \(100%\)/);
  assert.match(sum, /claude:ref-model SUCCESS/);
  const j = JSON.parse(cli(['--json']).stdout);
  assert.equal(j.rows[0].paired, 1);
  assert.equal(j.pairs[0].reference.model, 'ref-model');
  const pair = cli(['pair', 'agent-42']).stdout;
  assert.match(pair, /REFERENCE {2}claude:ref-model/);
  assert.match(pair, /⚙ edit/);
  assert.match(cli(['review-prompt']).stdout, /^You are tuning the working rules[\s\S]*a\.txt says hello now\./);
  assert.match(cli(['ready']).stdout, /pi: ready — lo fake-coder-low · med fake-coder-medium · hi fake-coder-xhigh/);
  assert.match(cli(['rules']).stdout, /version [0-9a-f]{8}/);
  // ratings: by hand, and from the VERDICT lines of a review answer
  assert.match(pair, /Not rated\. \/multiclaude:shadow rate agent-42/);
  const rated = cli(['rate', 'agent-42', 'rework', '--note', 'forgot the trailing newline']);
  assert.equal(rated.status, 0, rated.stderr);
  assert.match(rated.stdout, /^rated agent-42 \(pi fake-coder-medium · rules [0-9a-f]{8}\): rework by user/);
  assert.equal(cli(['rate', 'nope', 'pass']).status, 1);
  assert.equal(cli(['rate', 'agent-42', 'great']).status, 2);
  const answer = path.join(s.home, 'review.md');
  writeFileSync(answer, 'VERDICT agent-42 fail — wrong file\nVERDICT ghost pass — no such pair\n');
  assert.match(cli(['rate', '--from', answer, '--by', 'review:gem']).stdout, /^1 verdict recorded as rating by review:gem · 1 named no recorded pair/);
  assert.match(cli(['rate', '--from', answer, '--by', 'review:gem']).stdout, /^0 verdicts recorded as ratings by review:gem · 1 already rated by it · 1 named no recorded pair/);
  const sum2 = cli([]).stdout;
  assert.match(sum2, /1 shadow run in the last 30d, 1 with the real agent's result · 0 pi runs of their own · 1 rated/);
  assert.match(sum2, /rated 1: 0 pass · 0 rework · 1 fail/);
  assert.match(sum2, /rated fail \(review:gem\)/);
  assert.match(cli(['pair', 'agent-42']).stdout, /RATINGS\n.*rework by user — forgot the trailing newline\n.*fail by review:gem — wrong file/);
  assert.equal(JSON.parse(cli(['--json']).stdout).pairs[0].rating.grade, 'fail');
  assert.match(cli(['review-prompt']).stdout, /RATING — rework, by user · forgot the trailing newline/);
  // cause and kind: fixed words, refused otherwise; a pass is cause none
  assert.equal(cli(['rate', 'agent-42', 'fail', '--cause', 'lazy']).status, 2);
  assert.equal(cli(['rate', 'agent-42', 'fail', '--kind', 'chores']).status, 2);
  assert.equal(cli(['rate', 'agent-42', 'fail', '--cause', 'broke', '--kind', 'bugfix', '--note', 'wrong file']).status, 0);
  let j2 = JSON.parse(cli(['--json']).stdout);
  assert.deepEqual([j2.pairs[0].rating.cause, j2.pairs[0].rating.kind, j2.causes, j2.kinds.bugfix.fail, j2.unrated], ['broke', 'bugfix', { broke: 1 }, 1, 0]);
  assert.match(cli([]).stdout, /Where pi fell short [^\n]*broke 1/);
  assert.equal(cli(['rate', 'agent-42', 'pass']).status, 0);
  assert.equal(JSON.parse(cli(['--json']).stdout).pairs[0].rating.cause, 'none');
  // the automatic review: nothing unrated → not due, no job
  const dry = cli(['auto', '--dry']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /not due: no unrated pair/);
  if (unix) assert.equal(statSync(path.join(s.home, 'data', 'multiclaude', 'shadow', 'records.jsonl')).mode & 0o777, 0o600);
});

test('every pi run is told it has no compress tool', () => {
  assert.ok(piRules({ edit: false, shell: false, shadow: true }).some((l) => /no compress, summarize, memory or context tool/.test(l)));
});

test('shadow.mjs claim: this chat\'s fresh requests only, at most --max, each taken once', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (id, session, ageMin = 0) => {
    const p = path.join(dir, id + '.shadow-request');
    writeFileSync(p, JSON.stringify({ v: 1, of: id, session, prompt: 'task ' + id, delegate: 'codex' }));
    if (ageMin) { const t0 = (Date.now() - ageMin * 60_000) / 1000; utimesSync(p, t0, t0); }
  };
  put('j1', 's1'); put('j2', 's2'); put('j3', 's1'); put('j4', 's1'); put('jold', 's1', 20);
  const claim = (...a) => JSON.parse(spawnSync(process.execPath, [CLI, 'claim', '--jobs-dir', dir, ...a], { encoding: 'utf8' }).stdout);
  assert.deepEqual(claim('--session', 's1', '--max', '2').map((r) => r.of), ['j1', 'j3']);
  assert.ok(existsSync(path.join(dir, 'j1.shadowed')) && existsSync(path.join(dir, 'j2.shadow-request')));
  assert.ok(!existsSync(path.join(dir, 'jold.shadow-request')), 'a stale request is dropped');
  assert.deepEqual(claim('--session', 's1').map((r) => r.of), ['j4']);
  assert.deepEqual(claim('--session', 's1'), []);
});

// ── the sandboxed shell (lib/sandbox.mjs) ──
test('sandbox: $HOME is an allowlist, credentials and agent sockets are out, the worktree is the one writable place', () => {
  const home = '/home/u';
  const a = sandboxArgs({ cwd: '/home/u/dev/x', writable: ['/w/tree'], home, uid: 1234, env: {} }).join(' ');
  assert.match(a, /--ro-bind \/ \/ /);
  assert.match(a, /--tmpfs \/home\/u /);
  assert.match(a, /--tmpfs \/run\/user\/1234/);
  assert.match(a, /--unshare-all --share-net --die-with-parent --new-session/);
  assert.match(a, /--chdir \/home\/u\/dev\/x/);
  assert.ok(!/\.ssh|\.config\/tea|\.config\/gh|\.claude|\.codex|galaxy_token/.test(a), a);
  const env = sandboxEnv({ PATH: '/bin', HOME: '/h', SSH_AUTH_SOCK: '/s', GITEA_TOKEN: 't', GH_TOKEN: 't', CLAUDE_CODE_MESSAGING_TOKEN: 't', PI_OFFLINE: '1', LC_ALL: 'C', NODE_EXTRA_CA_CERTS: '/ca.pem' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'PATH', 'PI_OFFLINE']);
  assert.equal(sandboxReady({ MULTICLAUDE_SHADOW_SHELL: 'off' }), null);
});

test('sandbox: mounts put a tree at another path, read-only unless rw; a missing source is skipped', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-mnt-'));
  try {
    const a = sandboxArgs({ cwd: '/home/u/dev/x', writable: [], home: '/home/u', env: {}, mounts: [
      { src: dir, dst: '/home/u/dev/x', rw: true }, { src: path.join(dir, 'gone'), dst: '/nowhere' }, { src: dir, dst: '/home/u/dev/x/.venv' },
    ] }).join(' ');
    assert.ok(a.includes(`--bind ${dir} /home/u/dev/x `), a);
    assert.ok(a.includes(`--ro-bind ${dir} /home/u/dev/x/.venv`), a);
    assert.ok(!a.includes('/nowhere'));
    assert.match(a, /--chdir \/home\/u\/dev\/x/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox: inside it the agent socket is gone, the home and the repository are read-only, /tmp is writable', { skip: !sandboxReady() && 'no usable bwrap here' }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-sbx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), repoDir = path.join(home, 'dev', 'r'), tree = path.join(dir, 'tree');
  mkdirSync(repoDir, { recursive: true }); mkdirSync(tree); mkdirSync(path.join(home, '.ssh'));
  writeFileSync(path.join(home, '.ssh', 'id_x'), 'secret');
  const script = 'echo "agent=[$SSH_AUTH_SOCK]"; ls ~/.ssh 2>/dev/null && echo SSH-VISIBLE; touch r/x 2>/dev/null || echo repo-ro; touch "$T/ok" && echo tree-rw; touch /tmp/t && echo tmp-rw';
  const r = spawnSync(sandboxReady(), [...sandboxArgs({ cwd: path.join(home, 'dev'), writable: [tree], home, env: {} }), 'bash', '-c', script],
    { env: { ...sandboxEnv({ ...process.env, HOME: home, SSH_AUTH_SOCK: '/run/agent.sock' }), T: tree }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agent=\[\]/);
  assert.doesNotMatch(r.stdout, /SSH-VISIBLE/);
  assert.match(r.stdout, /repo-ro/);
  assert.match(r.stdout, /tree-rw/);
  assert.match(r.stdout, /tmp-rw/);
  assert.ok(existsSync(path.join(tree, 'ok')));
});

test('scratchPaths: the scratchpad files a task names, never the root or a project folder; in bwrap read-only, other sessions hidden', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mc-scr-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'claude-4242');
  const pad = path.join(root, '-home-u-dev-x', 'sess1', 'scratchpad');
  const other = path.join(root, '-home-u-dev-x', 'sess2', 'scratchpad');
  mkdirSync(path.join(pad, 'clones'), { recursive: true }); mkdirSync(other, { recursive: true });
  writeFileSync(path.join(pad, 's3.txt'), 'scenario\n'); writeFileSync(path.join(other, 'secret.txt'), 'x');
  const task = `Read ${pad}/s3.txt, then ${pad}/clones/. See \`${pad}/s3.txt:12\` and ${pad}/clones/a/b.md (gone), ` +
    `${root}/-home-u-dev-x and ${root}.`;
  const got = scratchPaths(task, { uid: 4242, tmp });
  assert.deepEqual(got, [path.join(pad, 's3.txt'), path.join(pad, 'clones')]);
  assert.deepEqual(scratchPaths('nothing here', { uid: 4242, tmp }), []);
  assert.equal(scratchPaths(Array.from({ length: 30 }, () => `${pad}/s3.txt ${pad}/clones`).join(' '), { uid: 4242, tmp, max: 1 }).length, 1);
  if (!sandboxReady()) return;
  const script = `cat "${pad}/s3.txt"; ls "${pad}/clones" >/dev/null && echo dir-ok; echo x >> "${pad}/s3.txt" 2>/dev/null || echo pad-ro; ls "${other}" 2>/dev/null && echo OTHER-VISIBLE; true`;
  const r = spawnSync(sandboxReady(), [...sandboxArgs({ cwd: '/usr', readable: got, env: {} }), 'bash', '-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /scenario/);
  assert.match(r.stdout, /dir-ok/);
  assert.match(r.stdout, /pad-ro/);
  assert.doesNotMatch(r.stdout, /OTHER-VISIBLE/);
});

test('a shadow with the sandbox gets bash and the sandbox rules; without it, none', { skip: (!unix || !sandboxReady()) && 'no usable bwrap here' }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  const r = s.run('edit', ['--shadow-of', 'jbox1', '--edit', '--worktree'], { MULTICLAUDE_SHADOW_SHELL: '' });
  assert.match(r.stderr, /sandboxed shell \(bwrap\) · rules [0-9a-f]{8} · tools read,grep,find,ls,edit,write,bash/);
  const [rec] = s.records();
  assert.equal(rec.shell, true);
  assert.equal(rec.sandbox, 'bwrap');
  assert.equal(rec.rules, rulesHash(piRules({ edit: true, shell: true, shadow: true, sandbox: 'bwrap' })));
  assert.equal(rec.rules, rulesHash(piRules({ edit: true, shell: true, shadow: true, sandbox: true })), 'the bwrap rules did not change');
  assert.equal(readFileSync(path.join(s.work, 'a.txt'), 'utf8'), 'one\n');   // the real tree stays as it was
  const off = s.run('edit', ['--shadow-of', 'jbox2', '--edit', '--worktree']);
  assert.match(off.stderr, /· edit · rules [0-9a-f]{8} · tools read,grep,find,ls,edit,write ·/);
});

test('no bwrap: a read-only shadow gets the guarded shell in a throwaway worktree; without a repository, no shell', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  // A shell run's environment is an allowlist: the fake pi's own variables pass only when declared.
  const keep = { MULTICLAUDE_SANDBOX_ENV: 'FAKE_PI,FAKE_PI_ARGV,FAKE_PI_STDIN', SECRET_TOKEN: 'x' };
  const r = s.run('ok', ['--shadow-of', 'jg1'], { MULTICLAUDE_SHADOW_SHELL: 'guard', ...keep });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /running in worktree .*shadow-wt/);
  assert.match(r.stderr, /· no-edit · guarded shell — weaker: no OS sandbox · rules [0-9a-f]{8} · tools read,grep,find,ls,bash ·/);
  const { argv, cwd, guard, secret } = s.seen();
  assert.ok(argv.includes(path.join(path.dirname(RUNNER), 'pi-guard.ts')), argv.join(' '));
  assert.equal(secret, null, 'a token outside the allowlist does not reach pi');
  const g = JSON.parse(guard);
  assert.equal(g.commands, true);
  assert.match(g.writable[0], /shadow-wt/);
  assert.deepEqual(g.env, ['FAKE_PI', 'FAKE_PI_ARGV', 'FAKE_PI_STDIN'], 'MULTICLAUDE_SANDBOX_ENV reaches the commands too');
  assert.match(cwd, /shadow-wt/, 'the commands run in the throwaway worktree, not the real checkout');
  const [rec] = s.records();
  assert.equal(rec.sandbox, 'guard');
  assert.equal(rec.shell, true);
  assert.equal(rec.rules, rulesHash(piRules({ edit: false, shell: true, shadow: true, sandbox: 'guard' })));
  // Not a git repository: no worktree to run in, so no shell at all.
  const plain = sandbox(t);
  mkdirSync(plain.work, { recursive: true });
  const n = plain.run('ok', ['--shadow-of', 'jg2'], { MULTICLAUDE_SHADOW_SHELL: 'guard', ...keep });
  assert.match(n.stderr, /· no-edit · rules [0-9a-f]{8} · tools read,grep,find,ls ·/);
  assert.ok(!plain.seen().argv.some((x) => x.endsWith('pi-guard.ts')));
});

test('pi.json sandboxed: a shadow\'s shell runs in the user\'s own sandbox command', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  const wrap = path.join(s.home, 'bin', 'jail');
  writeFileSync(wrap, '#!/bin/sh\nexec "$@"\n'); chmodSync(wrap, 0o755);
  mkdirSync(path.join(s.home, 'config', 'multiclaude'), { recursive: true });
  writeFileSync(path.join(s.home, 'config', 'multiclaude', 'pi.json'), JSON.stringify({ command: ['jail', 'pi'], sandboxed: true, shadowShell: 'auto' }));
  const r = s.run('ok', ['--shadow-of', 'jc1'], { MULTICLAUDE_SHADOW_SHELL: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /shell in your sandbox command · rules [0-9a-f]{8} · tools read,grep,find,ls,bash ·/);
  assert.equal(s.records()[0].sandbox, 'custom');
  // `sandboxed` on plain pi is no sandbox: ignored (bwrap or the guard instead).
  writeFileSync(path.join(s.home, 'config', 'multiclaude', 'pi.json'), JSON.stringify({ sandboxed: true, shadowShell: 'guard' }));
  assert.match(s.run('ok', ['--shadow-of', 'jc2'], { MULTICLAUDE_SHADOW_SHELL: '' }).stderr, /guarded shell/);
});

test('piRules: a read-only shadow with a sandboxed shell is told what the shell can and cannot do', () => {
  const r = piRules({ edit: false, shell: true, shadow: true, sandbox: true });
  assert.ok(r.some((l) => /tools are read, grep, find, ls and bash/.test(l)));
  assert.ok(r.some((l) => /no credentials — no ssh \(no ~\/\.ssh, no agent, no control sockets\), no git push/.test(l)));
  // a login failure is final: the shadow answers from the repository instead of debugging its sandbox
  assert.ok(r.some((l) => /the first such failure is final — do not work around it and do not look into why/.test(l)));
  assert.ok(r.some((l) => /answer from the repository .* and say in your final report which commands you would have run/.test(l)));
  assert.ok(!r.some((l) => /There is no shell/.test(l)));
  assert.ok(!piRules({ edit: true, shell: true, shadow: false }).some((l) => /sandbox/.test(l)));
});

test('bwrap: the shadow works at the real path on a snapshot of the real tree; the live checkout and the repository stay as they were', { skip: (!unix || !sandboxReady()) && 'no usable bwrap here' }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  writeFileSync(path.join(s.work, 'wip.txt'), 'not committed\n');
  writeFileSync(path.join(s.work, '.gitignore'), '.venv\n');
  mkdirSync(path.join(s.work, '.venv')); writeFileSync(path.join(s.work, '.venv', 'marker'), '1');
  const r = s.run('masked', ['--shadow-of', 'jmask1', '--edit', '--worktree'], { MULTICLAUDE_SHADOW_SHELL: '', MULTICLAUDE_SANDBOX_ENV: 'FAKE_PI' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the shadow worktree \(the real agent's working tree\) at .*work · \.venv read-only/);
  assert.match(r.stdout, new RegExp(`cwd=${s.work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), 'pi saw the real path');
  assert.match(r.stdout, /wip=not committed/, 'the uncommitted file is there');
  assert.match(r.stdout, /status=\[M a\.txt\]/, 'git status works and shows only its own change');
  assert.match(r.stdout, /add=refused/, 'the repository is read-only');
  assert.match(r.stdout, /venv=yes venvRo=yes/);
  // the live checkout: untouched; the repository: no worktree, no branch (the snapshot's loose objects are unreachable; gc takes them)
  assert.equal(readFileSync(path.join(s.work, 'a.txt'), 'utf8'), 'one\n');
  assert.ok(!existsSync(path.join(s.work, '.venv', 'x')));
  assert.equal(git(s.work, 'worktree', 'list').stdout.trim().split('\n').length, 1);
  assert.equal(git(s.work, 'branch', '--list').stdout.trim().split('\n').length, 1);
  assert.equal(git(s.work, 'status', '--short').stdout, '?? .gitignore\n?? wip.txt\n');
  const [rec] = s.records();
  assert.deepEqual([rec.base, rec.masked, rec.files], ['snapshot', true, ['a.txt']], 'the patch is against the snapshot: wip.txt is no change of its own');
  assert.equal(readdirSync(path.join(s.home, 'cache', 'multiclaude', 'shadow-wt')).length, 0, 'worktree and git file removed');
});

test('bwrap: the scratchpad files a task names are bound as they were when the real agent started — its later results stay out', { skip: (!unix || !sandboxReady()) && 'no usable bwrap here' }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  // a scratchpad of a made-up session, where scratchPaths looks for one (/tmp/claude-<uid>/<project>/<session>/…)
  const proj = path.join(os.tmpdir(), `claude-${process.getuid()}`, `-mc-test-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(proj, { recursive: true, force: true }));
  const pad = path.join(proj, 'sess', 'scratchpad');
  mkdirSync(path.join(pad, 'notes'), { recursive: true });
  const asOf = Date.now() - 60_000, old = new Date(asOf - 60_000);
  const put = (rel, text, when) => { const f = path.join(pad, rel); writeFileSync(f, text); if (when) utimesSync(f, when, when); return f; };
  const brief = put('brief.md', 'the brief', old), result = put('result.md', 'the answer');
  put('notes/a.md', 'note a', old); put('notes/b.md', 'note b, later');
  const notes = path.join(pad, 'notes');
  const task = `Read ${brief} and ${notes}/, then write ${result}.`;
  const r = spawnSync(process.execPath, [RUNNER, 'pi', '--job', 'auto', '--cd', s.work, '--no-preflight', '--shadow-of', 'jscr1', '--as-of', String(asOf)], {
    env: s.env('scratch', { MULTICLAUDE_SHADOW_SHELL: '', MULTICLAUDE_SANDBOX_ENV: 'FAKE_PI,FAKE_PI_SCRATCH', FAKE_PI_SCRATCH: [brief, result, notes].join(',') }),
    input: task, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /▸ scratchpad bound read-only as of \d\d:\d\d:\d\d UTC: 2 files, 2 newer or unreadable left out/);
  assert.match(r.stdout, /brief\.md=the brief ro=yes/);
  assert.match(r.stdout, /result\.md=missing ro=yes/, 'what the real agent wrote after it started is not there');
  assert.match(r.stdout, /notes=dir\[a\.md\] ro=yes/);
  const job = s.jobs().find((j) => j.shadowOf === 'jscr1');
  assert.deepEqual([job.scratchAsOf, job.scratchCopied, job.scratchSkipped], [asOf, 2, 2]);
  assert.equal(s.records()[0].asOf, asOf);
  assert.deepEqual(readdirSync(path.join(s.home, 'cache', 'multiclaude', 'shadow-scratch')), [], 'the copies are removed with the run');
  assert.equal(readFileSync(result, 'utf8'), 'the answer', 'the real scratchpad is untouched');
});

test('a read-only shadow in a repository reads a snapshot worktree, not the live checkout', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  writeFileSync(path.join(s.work, 'wip.txt'), 'w\n');
  const r = s.run('read', ['--shadow-of', 'jro1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(s.seen().cwd.includes(path.join('multiclaude', 'shadow-wt')), s.seen().cwd);
  const [rec] = s.records();
  assert.deepEqual([rec.base, rec.masked, rec.edit], ['snapshot', false, false]);
});

test('the judge stops a shadow that is going nowhere: CANCELLED, a fail rating with its cause, nobody woken', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  const prompt = path.join(s.home, 'judge-prompt.txt');
  const r = s.run('slow', ['--shadow-of', 'jjudge1', '--timeout', '5', '--no-auto-extend'], { FAKE_JUDGE: 'STOP loop — read a.txt twice, then nothing', FAKE_AGY_PROMPT: prompt, FAKE_PI_SLEEP: '40000' });
  assert.equal(r.status, 130, r.stderr);
  assert.match(r.stderr, /asking the judge whether more time helps \(ceiling 2400s\)/);
  assert.match(r.stderr, /⚖ judge \(gemini-3\.8-flash-\w+\): stop \(loop\) — read a\.txt twice/);
  assert.match(proofOf(r), /status=CANCELLED .*shadow-of=jjudge1 stopped-by=judge cause=loop/);
  assert.match(readFileSync(prompt, 'utf8'), /Calls made more than once: 2× read \{"path":"a\.txt"\}/);
  const [rec] = s.records();
  assert.equal(rec.status, 'CANCELLED');
  assert.deepEqual(rec.judge.map((j) => [j.verdict, j.cause, j.via]), [['STOP', 'loop', 'agy']]);
  const [rating] = s.ratings();
  assert.deepEqual([rating.pair, rating.grade, rating.cause, rating.status], ['jjudge1', 'fail', 'loop', 'CANCELLED']);
  assert.match(rating.by, /^judge:gemini-3\.8-flash-/);
  const judgeJob = s.jobs().find((j) => j.background === 'shadow-judge');
  assert.ok(judgeJob, 'the judge ran as a background AGY job');
  assert.equal(judgeJob.delegate, 'agy');
  assert.equal(s.lines('failures.jsonl').filter((l) => l.shadowOf === 'jjudge1').length, 0);
  // stopped for a loop, not for the server: its final report is asked for once, with no tools
  assert.match(r.stderr, /↪ stopped by the judge: asking pi for its final report — no tools/);
  assert.match(proofOf(r), /salvaged=yes salvage=\d+s/);
  assert.match(rec.answer, /^\[final report written after the judge stopped the run, with no tools\]\n\nFinal report: read a\.txt twice/);
  assert.equal(rec.salvaged, 'yes');
});

test('a shadow stopped by its time limit writes its final report afterwards from its saved session, with no tools', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  const r = s.run('slow', ['--shadow-of', 'jsalv1', '--timeout', '5', '--no-auto-extend'], { MULTICLAUDE_SHADOW_JUDGE: 'off', FAKE_PI_SLEEP: '40000' });
  assert.equal(r.status, 124, r.stderr);
  assert.match(r.stderr, /↪ time limit reached: asking pi for its final report — no tools, ≤ 240s/);
  assert.match(r.stderr, /↪ final report written \(\d+s\)/);
  assert.match(proofOf(r), /status=TIMEOUT .*salvaged=yes salvage=\d+s/);
  assert.match(r.stdout, /^\[final report written after the time limit stopped the run, with no tools\]\n\nFinal report: read a\.txt twice/);
  const sessions = path.join(s.home, 'cache', 'multiclaude', 'pi-sessions');
  assert.ok(s.seen().argv.includes('--session-dir') && !s.seen().argv.includes('--no-session'), 'a shadow keeps its session');
  const salv = JSON.parse(readFileSync(path.join(s.home, 'argv.json.salvage'), 'utf8'));
  const file = salv.argv[salv.argv.indexOf('--session') + 1];
  assert.ok(file.startsWith(sessions + path.sep) && file.endsWith('.jsonl'), file);
  assert.equal(salv.session, true, 'the session file was there');
  assert.ok(salv.argv.includes('--no-tools') && !salv.argv.includes('--tools'));
  assert.match(salv.wrap, /^Time is up: no more tool calls are possible\. Write your final report now/);
  assert.deepEqual(readdirSync(sessions), [], 'the saved session is removed with the run');
  const [rec] = s.records();
  assert.deepEqual([rec.status, rec.salvaged], ['TIMEOUT', 'yes']);
  assert.match(rec.answer, /Final report: read a\.txt twice/);
  const run = s.lines('runs.jsonl').find((l) => l.shadowOf === 'jsalv1');
  assert.equal(run.tokens, 120 + 960, 'the report\'s tokens count with the run');
});

test('no report: a STOP for the model server asks for none; a report that does not come leaves the narration', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  const r = s.run('slow', ['--shadow-of', 'jsalv2', '--timeout', '5', '--no-auto-extend'], { FAKE_JUDGE: 'STOP infra — every model call times out', FAKE_PI_SLEEP: '40000' });
  assert.equal(r.status, 130, r.stderr);
  assert.doesNotMatch(r.stderr, /asking pi for its final report/);
  assert.doesNotMatch(proofOf(r), /salvaged=/);
  assert.ok(!existsSync(path.join(s.home, 'argv.json.salvage')), 'pi was not asked again');
  assert.deepEqual(s.ratings().map((x) => [x.grade, x.cause]), [['fail', 'infra']]);
  assert.ok(!('salvaged' in s.records()[0]));
  const none = s.run('slow', ['--shadow-of', 'jsalv3', '--timeout', '5', '--no-auto-extend'], { MULTICLAUDE_SHADOW_JUDGE: 'off', FAKE_PI_SLEEP: '40000', FAKE_PI_REPORT: 'none' });
  assert.equal(none.status, 124, none.stderr);
  assert.match(none.stderr, /asking pi for its final report/);
  assert.doesNotMatch(proofOf(none), /salvaged=/);
  assert.doesNotMatch(none.stdout, /final report written after/);
});

test('the judge extends a shadow that is working, up to the ceiling', { skip: !unix }, (t) => {
  const s = sandbox(t);
  repo(s.work);
  const r = s.run('slow', ['--shadow-of', 'jjudge2', '--timeout', '5', '--no-auto-extend'], { FAKE_JUDGE: 'EXTEND — still reading the parser', FAKE_PI_SLEEP: '9000', MULTICLAUDE_SHADOW_CEILING: '300' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /⚖ judge \(gemini-3\.8-flash-\w+\): extend \+295s — now 300s — still reading the parser/);
  assert.match(proofOf(r), /status=SUCCESS/);
  const [rec] = s.records();
  assert.deepEqual(rec.judge.map((j) => j.verdict), ['EXTEND']);
  assert.equal(s.ratings().length, 0);
  assert.equal(s.jobs().find((j) => j.shadowOf === 'jjudge2').timeout, 300);
});

test('shadow.mjs judge: no AGY answer → one headless Claude call; on / off / status', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const env = { ...s.env('read'), FAKE_JUDGE: 'quota', FAKE_CLAUDE_JUDGE: 'STOP env — the fixture it needs is not there' };
  delete env.MULTICLAUDE_REVIEW_CLAUDE;
  const r = spawnSync(process.execPath, [CLI, 'judge', '--stdin'], { env, input: JSON.stringify({ used: 960, limit: 1200, ceiling: 2400, task: 'x', job: 'jz' }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout.trim());
  assert.deepEqual([v.verdict, v.cause, v.via, v.model, v.agy], ['STOP', 'env', 'claude', 'claude-haiku-5-5', 'QUOTA']);
  const none = spawnSync(process.execPath, [CLI, 'judge', '--stdin'], { env: { ...env, MULTICLAUDE_REVIEW_CLAUDE: 'off' }, input: '{}', encoding: 'utf8', timeout: 60_000 });
  assert.equal(none.status, 1);
  assert.match(JSON.parse(none.stdout.trim()).error, /AGY: QUOTA; Claude: off/);
  const cli = (...a) => spawnSync(process.execPath, [CLI, 'judge', ...a], { env, encoding: 'utf8' }).stdout;
  assert.match(cli('off'), /judge\] off/);
  assert.match(cli('status'), /judge\] off/);
  assert.match(cli('on'), /judge\] on · ceiling 2400 s/);
});
