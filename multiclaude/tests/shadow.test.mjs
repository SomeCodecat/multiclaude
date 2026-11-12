// node --test tests/shadow.test.mjs — shadow runs: the record library (scripts/lib/shadow.mjs),
// the runner flags behind them (scripts/dispatch.mjs --shadow-of / --reference / --band, with a
// fake `pi` on PATH) and the reader (scripts/shadow.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { scrub, buildRecord, pairUp, summarize, reviewPrompt, treeSnap, patchBetween, piRules, rulesHash, extraPiRules, writeRating, readRatings, ratingsFile, parseVerdicts } from '../scripts/lib/shadow.mjs';

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
  assert.deepEqual(v, [{ pair: 'agent-42', grade: 'pass', note: 'on second thought' }, { pair: 'live1ref', grade: 'pass', note: 'same findings' }]);
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
if (process.env.FAKE_PI_ARGV) fs.writeFileSync(process.env.FAKE_PI_ARGV, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const out = (o) => console.log(JSON.stringify(o));
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
  } else if (mode === 'escape') {
    say('', 'toolUse'); tool('write', { path: process.env.FAKE_PI_TARGET });
    await new Promise((r) => setTimeout(r, 60000));
  } else {
    say('', 'toolUse'); tool('read', { path: 'a.txt' });
    say('a.txt says one.', 'stop');
  }
  out({ type: 'agent_settled', aborted: false });
  process.exit(0);
});
`;

function sandbox(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mc-shadow-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'), work = path.join(home, 'work');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'pi'), FAKE);
  chmodSync(path.join(bin, 'pi'), 0o755);
  const env = (mode, more = {}) => ({
    ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    PATH: bin + path.delimiter + process.env.PATH, FAKE_PI: mode, MULTICLAUDE_PRICES: 'off',
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
  return { home, work, env, run, records, lines, seen, stdin };
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
  if (unix) assert.equal(statSync(path.join(s.home, 'data', 'multiclaude', 'shadow', 'records.jsonl')).mode & 0o777, 0o600);
});
