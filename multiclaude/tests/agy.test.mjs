// The AGY side of the runner with a fake `agy` on PATH: a signed-out CLI ends the run as AUTH at
// once (no wait for the timeout), and every job file names the project it was dispatched from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const RUNNER = fileURLToPath(new URL('../scripts/dispatch.mjs', import.meta.url));
const SHADOW_CLI = fileURLToPath(new URL('../scripts/shadow.mjs', import.meta.url));
const unix = process.platform !== 'win32';

// FAKE_AGY: signedout = `agy models` refuses with the CLI's sign-in text;
//           login = the catalog lists, but a run asks for a login and waits.
const FAKE = `#!/usr/bin/env node
const require = (await import('node:module')).createRequire(import.meta.url);
const mode = process.env.FAKE_AGY;
if (process.argv[2] === 'models') {
  if (mode === 'signedout') { console.error('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.'); process.exit(1); }
  if (mode === 'review' || mode === 'quota') for (const e of ['low', 'medium', 'high']) console.log('gemini-3.8-flash-' + e + '\\tGemini Flash ' + e);
  else console.log('fake-gem-flash\\tFake Gem Flash');
  process.exit(0);
}
if (mode === 'review') {   // the automatic shadow review: a verdict for every pair id in the prompt
  const prompt = (process.argv.find((a) => a.startsWith('--print=')) || '').slice(8);
  if (!prompt) process.exit(0);   // the pool preflight (agy -p /usage): no figures
  const ids = [...prompt.matchAll(/pair id (\\S+)/g)].map((m) => m[1]);
  const response = ids.map((id) => \`VERDICT \${id} fail loop ops — re-ran the same check\`).join('\\n');
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response, usage: { total_tokens: 42 } } }));
  process.exit(0);
}
if (mode === 'quota') {   // the pool is spent: the run is refused before any work
  const prompt = (process.argv.find((a) => a.startsWith('--print=')) || '').slice(8);
  if (!prompt) process.exit(0);
  console.log(JSON.stringify({ event: 'result', result: { status: 'FAILED', error: 'RESOURCE_EXHAUSTED: quota exceeded for this model', response: '' } }));
  process.exit(0);
}
if (mode === 'claimed') {   // the chat's module takes the shadow request while the run is going (shadow.mjs claim)
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [process.env.SHADOW_CLI, 'claim', '--jobs-dir', process.env.JOBS, '--session', 'sess-1'], { stdio: 'ignore' });
}
console.error('Authentication required. Open the link below to sign in.');
console.error('Waiting for authentication...');
setTimeout(() => process.exit(0), 60_000);
`;

function sandbox(t, mode) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mc-agy-'));
  // retried: the runner's background wallet refresh may still be writing into it
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const bin = path.join(home, 'bin'), work = path.join(home, 'work'), project = path.join(home, 'project');
  mkdirSync(bin); mkdirSync(work); mkdirSync(project);
  writeFileSync(path.join(bin, 'agy'), FAKE);
  chmodSync(path.join(bin, 'agy'), 0o755);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'),
    PATH: bin + path.delimiter + process.env.PATH, FAKE_AGY: mode, MULTICLAUDE_PRICES: 'off', MULTICLAUDE_WALLET_REFRESH: 'off', MC_PROJECT_DIR: project, MC_SESSION_ID: 'sess-1',
    MULTICLAUDE_SHADOW_DIR: path.join(home, 'shadow'), SHADOW_CLI, JOBS: path.join(home, 'cache', 'multiclaude', 'jobs'),
  };
  const go = (...args) => spawnSync(process.execPath, [RUNNER, 'agy', ...args, '--job', 'auto', '--cd', work, '--no-preflight', '--timeout', '50'],
    { env, input: 'Review a.txt.', encoding: 'utf8', timeout: 45_000 });
  const job = (r) => {
    const id = /dispatch: job id (\S+)/.exec(r.stderr)?.[1];
    assert.ok(id, r.stderr);
    return JSON.parse(readFileSync(path.join(home, 'cache', 'multiclaude', 'jobs', id + '.json'), 'utf8'));
  };
  return { go, job, work, project, home };
}
const proofOf = (r) => (r.stderr.split('\n').filter((l) => l.startsWith('[dispatch ')).pop() || '');

test('agy signed out, no model given: the error says so, not "--model is required"', { skip: !unix }, (t) => {
  const r = sandbox(t, 'signedout').go();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /AGY is not signed in .*Please sign in/);
  assert.doesNotMatch(r.stderr, /--model <id> is required/);
});

test('agy signed out, model given: AUTH at once; the job file names project and cwd apart', { skip: !unix }, (t) => {
  const s = sandbox(t, 'signedout');
  const r = s.go('--model', 'fake-gem-flash');
  assert.equal(r.status, 1, r.stderr);
  assert.match(proofOf(r), /status=AUTH .*hint=sign-in-with-agy/);
  const j = s.job(r);
  assert.equal(j.session, 'sess-1');
  assert.equal(j.project, s.project);
  assert.equal(j.cwd, s.work);
});

test('agy asking for a login mid-run is stopped as AUTH, not left to the timeout', { skip: !unix }, (t) => {
  const t0 = Date.now();
  const r = sandbox(t, 'login').go('--model', 'fake-gem-flash');
  assert.match(proofOf(r), /status=AUTH /, r.stderr);
  assert.match(r.stderr, /agy is waiting for a login/);
  assert.ok(Date.now() - t0 < 30_000, 'stopped long before the 50 s timeout');
});

// A Gemini generation with several families: gem-top is the one that goes highest, the rest gem-alt.
// Synthetic ids — the shape the catalog uses, not a list of what exists today.
test('resolveAgyTiers: gem-top by effort ceiling, the other families of that generation as gem-alt', async () => {
  const { resolveAgyTiers } = await import('../scripts/lib/models.mjs');
  const row = (id) => ({ id, name: id });
  const fam = (base, efforts) => efforts.map((e) => row(`${base}-${e}`));
  const rows = [
    ...fam('gemini-3.8-flash', ['low', 'medium', 'high']),
    ...fam('gemini-4-argon', ['low', 'medium', 'high']),
    ...fam('gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh']),
    ...fam('gemini-4-carbon', ['low', 'medium', 'high']),
    ...fam('claude-opus-5-5', ['low', 'medium', 'high']),
  ];
  const t = resolveAgyTiers(rows);
  assert.equal(t.gemtop, 'gemini-4-hydrogen-high');
  assert.deepEqual(t.gemtopEfforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(t.gemalt.map((a) => a.id), ['gemini-4-argon-high', 'gemini-4-carbon-high']);
  assert.equal(t.gemhi, 'gemini-3.8-flash-high');

  // equal ceilings keep catalog order; one family alone has no alternates
  assert.equal(resolveAgyTiers([...fam('gemini-3.8-flash', ['high']), ...fam('gemini-4-carbon', ['high']), ...fam('gemini-4-argon', ['high'])]).gemtop, 'gemini-4-carbon-high');
  // two families reach xhigh: the first listed wins; the orchestrator ids are no Gemini family
  const two = resolveAgyTiers([...fam('gemini-3.8-flash', ['high']), ...fam('gemini-4-neon', ['low', 'medium', 'high', 'xhigh']),
    ...fam('gemini-4-argon', ['low', 'medium', 'high']), ...fam('gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh']),
    row('gemini-pro-orchestrator-neon'), row('gemini-pro-orchestrator-g1-pro')]);
  assert.equal(two.gemtop, 'gemini-4-neon-high');
  assert.deepEqual(two.gemalt.map((a) => a.id), ['gemini-4-hydrogen-high', 'gemini-4-argon-high']);
  assert.equal(two.prohi, null);
  const solo = resolveAgyTiers([...fam('gemini-3.8-flash', ['high']), ...fam('gemini-4-argon', ['medium', 'high'])]);
  assert.equal(solo.gemtop, 'gemini-4-argon-high');
  assert.deepEqual(solo.gemalt, []);
  // no generation above Flash: no gem-top
  assert.equal(resolveAgyTiers(fam('gemini-3.8-flash', ['high'])).gemtop, null);
});

test('a runner job started outside the tool asks for a shadow; the claimed one writes its reference record', { skip: !unix }, (t) => {
  const records = (home) => { try { return readFileSync(path.join(home, 'shadow', 'records.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // nobody claims it: the request stays for the module's next scan, no record
  const a = sandbox(t, 'login');
  const ra = a.go('--model', 'fake-gem-flash');
  const ja = a.job(ra);
  const req = JSON.parse(readFileSync(path.join(a.home, 'cache', 'multiclaude', 'jobs', ja.id + '.shadow-request'), 'utf8'));
  assert.deepEqual([req.of, req.session, req.delegate, req.cwd, req.prompt], [ja.id, 'sess-1', 'agy', a.work, 'Review a.txt.']);
  assert.equal(records(a.home).length, 0);
  // claimed mid-run: the run is the reference of the pair
  const b = sandbox(t, 'claimed');
  const rb = b.go('--model', 'fake-gem-flash');
  const jb = b.job(rb);
  const recs = records(b.home);
  assert.deepEqual(recs.map((r) => [r.pair, r.role, r.delegate]), [[jb.id, 'reference', 'agy']], rb.stderr);
  // the module's own jobs pass --no-shadow-request
  const c = sandbox(t, 'login');
  const jc = c.job(c.go('--model', 'fake-gem-flash', '--no-shadow-request'));
  assert.throws(() => readFileSync(path.join(c.home, 'cache', 'multiclaude', 'jobs', jc.id + '.shadow-request')));
});

test('shadow.mjs auto: the unrated pairs go to one AGY job, its verdicts become ratings, the lock is dropped', { skip: !unix }, (t) => {
  const { home } = sandbox(t, 'review');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'),
    PATH: path.join(home, 'bin') + path.delimiter + process.env.PATH, FAKE_AGY: 'review', MULTICLAUDE_PRICES: 'off', MULTICLAUDE_WALLET_REFRESH: 'off',
    MULTICLAUDE_SHADOW_DIR: path.join(home, 'shadow'),
  };
  const dir = env.MULTICLAUDE_SHADOW_DIR;
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const rec = (o) => JSON.stringify({ v: 1, ts, delegate: 'pi', model: 'pi-m', rules: 'aaaa1111', status: 'SUCCESS', edit: true, prompt: 'Fix the check.', answer: 'Done.', ...o });
  writeFileSync(path.join(dir, 'records.jsonl'), [
    rec({ pair: 'p1', job: 'p1', role: 'shadow' }), rec({ pair: 'p1', role: 'reference', delegate: 'codex', model: 'ref', answer: 'Fixed.' }),
    rec({ pair: 'p2', job: 'p2', role: 'shadow' }),   // no reference: not sent
  ].join('\n') + '\n');
  const cli = (...a) => spawnSync(process.execPath, [SHADOW_CLI, 'auto', ...a], { env, encoding: 'utf8', timeout: 60_000 });
  assert.match(cli().stdout, /not due: 1 unrated pair, waiting for 6/);
  const r = cli('--force');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /1 pair sent · 1 verdict recorded as rating by review:gemini-3\.8-flash-medium · answer /);
  const ratings = readFileSync(path.join(dir, 'ratings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ratings.map((x) => [x.job, x.grade, x.cause, x.kind, x.by]), [['p1', 'fail', 'loop', 'ops', 'review:gemini-3.8-flash-medium']]);
  assert.ok(!existsSync(path.join(dir, 'auto-review.lock')), 'the lock is dropped on the way out');
  const state = JSON.parse(readFileSync(path.join(dir, 'auto-review.json'), 'utf8'));
  assert.deepEqual([state.ok, state.rated, state.pairs, state.tried], [true, 1, 1, {}]);
  // the job file marks it as background work for a viewer (docs/herdr-mascots.md)
  const jobsDir = path.join(home, 'cache', 'multiclaude', 'jobs');
  const job = JSON.parse(readFileSync(path.join(jobsDir, readdirSync(jobsDir).find((f) => /^[^.]+\.json$/.test(f))), 'utf8'));
  assert.equal(job.background, 'shadow-review');
  assert.equal(job.label, 'shadow auto-review');
  assert.match(cli('--force').stdout, /not due: no unrated pair with a reference/);
});

// A fake `claude -p --output-format json`: a verdict per pair id on stdin; argv and the herdr variable it
// saw go to claude-args.json beside it.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
let input = ''; process.stdin.on('data', (d) => input += d).on('end', () => {
  fs.writeFileSync(path.join(__dirname, 'claude-args.json'), JSON.stringify({ argv: process.argv.slice(2), hc: process.env.HC_TERMINAL_ID || null, cwd: process.cwd() }));
  const ids = [...input.matchAll(/pair id (\\S+)/g)].map((m) => m[1]);
  const result = ids.map((id) => 'VERDICT ' + id + ' rework unfinished bugfix — left the second check').join('\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.0123,
    modelUsage: { 'claude-haiku-5-5': { inputTokens: 900, outputTokens: 40 } } }));
});
`;

function quotaReview(t, claude) {
  const { home } = sandbox(t, 'quota');
  if (claude) { writeFileSync(path.join(home, 'bin', 'claude'), FAKE_CLAUDE); chmodSync(path.join(home, 'bin', 'claude'), 0o755); }
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'),
    PATH: path.join(home, 'bin') + path.delimiter + process.env.PATH, FAKE_AGY: 'quota', MULTICLAUDE_PRICES: 'off', MULTICLAUDE_WALLET_REFRESH: 'off',
    MULTICLAUDE_SHADOW_DIR: path.join(home, 'shadow'), HC_TERMINAL_ID: 'term-9',
    MULTICLAUDE_REVIEW_CLAUDE: claude ? '' : 'off',
  };
  if (claude) delete env.MULTICLAUDE_REVIEW_CLAUDE;
  const dir = env.MULTICLAUDE_SHADOW_DIR;
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const rec = (o) => JSON.stringify({ v: 1, ts, delegate: 'pi', model: 'pi-m', rules: 'aaaa1111', status: 'SUCCESS', edit: true, prompt: 'Fix the check.', answer: 'Done.', ...o });
  writeFileSync(path.join(dir, 'records.jsonl'), [
    rec({ pair: 'p1', job: 'p1', role: 'shadow' }), rec({ pair: 'p1', role: 'reference', delegate: 'codex', model: 'ref', answer: 'Fixed.' }),
  ].join('\n') + '\n');
  const cli = (...a) => spawnSync(process.execPath, [SHADOW_CLI, 'auto', ...a], { env, encoding: 'utf8', timeout: 60_000 });
  return { home, dir, cli };
}

test('shadow.mjs auto: with the Claude fallback off, a review the AGY pool refuses leaves the pairs untried', { skip: !unix }, (t) => {
  const { dir, cli } = quotaReview(t, false);
  for (let i = 0; i < 3; i++) {   // more rounds than MAX_TRIES: a refusal is never a try
    const r = cli('--force');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /no AGY quota — the pairs wait for the next round/);
    const state = JSON.parse(readFileSync(path.join(dir, 'auto-review.json'), 'utf8'));
    assert.equal(state.ok, false);
    assert.deepEqual(state.tried || {}, {});
    assert.match(state.error, /status=QUOTA/);
  }
  assert.ok(!existsSync(path.join(dir, 'auto-review.lock')));
  assert.ok(!existsSync(path.join(dir, 'ratings.jsonl')));
});

test('shadow.mjs auto: no AGY quota → one headless Claude call (haiku, sonnet when busy) rates the pairs', { skip: !unix }, (t) => {
  const { home, dir, cli } = quotaReview(t, true);
  const r = cli('--force');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 verdict recorded as rating by review:claude-haiku-5-5 · AGY QUOTA, reviewed by claude-haiku-5-5 instead \(≈ \$0\.012 at list price\)/);
  const ratings = readFileSync(path.join(dir, 'ratings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ratings.map((x) => [x.job, x.grade, x.cause, x.kind, x.by]), [['p1', 'rework', 'unfinished', 'bugfix', 'review:claude-haiku-5-5']]);
  const state = JSON.parse(readFileSync(path.join(dir, 'auto-review.json'), 'utf8'));
  assert.deepEqual([state.ok, state.via, state.rated, state.tried], [true, 'claude', 1, {}]);
  assert.match(readFileSync(state.file, 'utf8'), /^VERDICT p1 rework/);
  // no settings (so no plugin, hook or CLAUDE.md), no tools, run from the shadow dir, herdr's variables gone
  const seen = JSON.parse(readFileSync(path.join(home, 'bin', 'claude-args.json'), 'utf8'));
  assert.deepEqual(seen.argv, ['-p', '--model', 'haiku', '--fallback-model', 'sonnet', '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--output-format', 'json']);
  assert.equal(seen.hc, null);
  assert.equal(seen.cwd, dir);
  assert.ok(!existsSync(path.join(dir, 'auto-review.lock')));
});
