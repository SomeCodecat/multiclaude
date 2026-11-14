// node --test tests/pi.test.mjs — scripts/dispatch.mjs with a fake `pi` on PATH: the trial
// delegate's loop guard, checkpoints, error handling (pi exits 0 on a failed model call), the
// cost on the proof line (reported by pi, else the tokens at list price, else none), the
// runs.jsonl line the scorecard reads, and a cancelled run — the runner killed, or asked through
// `--cancel <id>` (what dispatch_cancel does for a runner it did not start) — recorded as CANCELLED.
// Also the effort: `pi --thinking <level>` for a model whose id names none, nothing for an id that does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const RUNNER = fileURLToPath(new URL('../scripts/dispatch.mjs', import.meta.url));
const unix = process.platform !== 'win32';   // the fake CLI is a shebang script

// The fake speaks pi's `--mode json` event stream; FAKE_PI picks the scenario.
const FAKE = `#!/usr/bin/env node
const mode = process.env.FAKE_PI || 'ok';
if (process.argv.includes('--list-models')) {
  console.log('provider  model  context  max-out  thinking  images');
  console.log('local  fake-coder-low  262144  16384  yes  no');
  console.log('local  fake-coder-medium  262144  16384  yes  no');
  console.log('local  solo-coder  262144  16384  yes  no');     // one id, the effort per run
  console.log('local  plain-coder  262144  16384  no  no');     // no thinking levels at all
  process.exit(0);
}
if (process.env.FAKE_PI_ARGV) require('node:fs').writeFileSync(process.env.FAKE_PI_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_PI_PID) require('node:fs').writeFileSync(process.env.FAKE_PI_PID, String(process.pid));
const out = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (toolName, args, isError, text) => {
  out({ type: 'tool_execution_start', toolName, args });
  out({ type: 'tool_execution_end', toolName, isError: !!isError, result: { content: [{ type: 'text', text: text || (isError ? 'ENOENT' : 'ok') }] } });
};
const say = (text, stopReason, extra) => out({ type: 'message_end', message: { role: 'assistant', stopReason, content: text ? [{ type: 'text', text }] : [], usage: { input: 100, output: 20, totalTokens: 120, ...(process.env.FAKE_PI_USAGE ? JSON.parse(process.env.FAKE_PI_USAGE) : {}), ...(process.env.FAKE_PI_NOCOST ? {} : { cost: { total: 0.0125 } }) }, ...extra } });
process.stdin.resume();
process.stdin.on('end', async () => {
  if (mode === 'ok') {
    say('', 'toolUse'); tool('read', { path: 'a.txt' }); tool('edit', { path: 'a.txt' });
    say('Done: a.txt now says hello.', 'stop');
  } else if (mode === 'loop') {
    for (let i = 0; i < 6; i++) { say('', 'toolUse'); tool('read', { path: 'same.txt' }); await sleep(20); }
    await sleep(60000);   // a real loop never ends by itself: the runner has to stop it
  } else if (mode === 'reread') {   // the same read, but the file changed each time: someone else is editing it
    for (let i = 0; i < 5; i++) { say('', 'toolUse'); tool('read', { path: 'same.txt' }, false, 'version ' + i); }
    say('Read it five times, it kept changing.', 'stop');
  } else if (mode === 'context') {   // a read-heavy task: every call re-sends a large, cached context
    for (let i = 0; i < 10; i++) { say('', 'toolUse'); tool('read', { path: 'f' + i + '.txt' }); }
    say('Read all ten.', 'stop');
  } else if (mode === 'steps') {
    const n = Number(process.env.FAKE_PI_STEPS || 17);
    for (let i = 0; i < n; i++) { say('', 'toolUse'); tool('read', { path: 'f' + i + '.txt' }); }
    say('Done after ' + n + ' reads.', 'stop');
  } else if (mode === 'error') {
    out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: process.env.FAKE_PI_ERROR || 'connection refused by upstream', content: [] } });
  } else if (mode === 'hang') {
    say('Working on it.', 'toolUse'); tool('read', { path: 'a.txt' });
    await sleep(60000);
  }
  out({ type: 'agent_settled', aborted: false });
  process.exit(0);   // like pi: 0 whatever happened
});
`;

function sandbox(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mc-pi-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin'), work = path.join(home, 'work');
  mkdirSync(bin); mkdirSync(work);
  writeFileSync(path.join(bin, 'pi'), FAKE);
  chmodSync(path.join(bin, 'pi'), 0o755);
  const env = (mode, more = {}) => ({
    ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'), MULTICLAUDE_SHADOW_DIR: path.join(home, 'shadow'),
    PATH: bin + path.delimiter + process.env.PATH, FAKE_PI: mode, MULTICLAUDE_PRICES: 'off',   // no price-table fetch from a test
    PI_CODING_AGENT_DIR: path.join(home, 'pi-agent'), FAKE_PI_ARGV: path.join(home, 'pi-argv.json'), ...more,
  });
  // What the fake pi was started with; `defaultModel` = pi's own default, which anchors the bands.
  const piArgv = () => JSON.parse(readFileSync(path.join(home, 'pi-argv.json'), 'utf8'));
  const piDefault = (id) => { mkdirSync(path.join(home, 'pi-agent'), { recursive: true }); writeFileSync(path.join(home, 'pi-agent', 'settings.json'), JSON.stringify({ defaultProvider: 'local', defaultModel: id })); };
  const argv = (...extra) => [RUNNER, 'pi', '--model', 'fake-coder-low', '--job', 'auto', '--cd', work, '--no-preflight', ...extra];
  const runs = () => {
    const f = path.join(home, 'cache', 'multiclaude', 'runs.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const job = (id) => JSON.parse(readFileSync(path.join(home, 'cache', 'multiclaude', 'jobs', id + '.json'), 'utf8'));
  const records = () => {
    const f = path.join(home, 'shadow', 'records.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { home, env, argv, runs, job, records, piArgv, piDefault, work };
}
const run = (s, mode, ...extra) => spawnSync(process.execPath, s.argv(...extra), { env: s.env(mode), input: 'Make a.txt say hello.', encoding: 'utf8', timeout: 60_000 });
const proofOf = (r) => (r.stderr.split('\n').filter((l) => l.startsWith('[dispatch ')).pop() || '');

test('a pi run that finishes: SUCCESS, cost on the proof line, one runs.jsonl line', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'ok', '--edit');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Done: a\.txt now says hello\./);
  const proof = proofOf(r);
  assert.match(proof, /^\[dispatch pi model=fake-coder-low status=SUCCESS /);
  assert.match(proof, /steps=2 calls=2/);
  assert.match(proof, /cost=\$0\.03 /);   // 2 × 0.0125, two decimals from one cent up
  const [line, ...rest] = s.runs();
  assert.equal(rest.length, 0);
  assert.equal(line.delegate, 'pi');
  assert.equal(line.model, 'fake-coder-low');
  assert.equal(line.status, 'SUCCESS');
  assert.equal(line.tokens, 240);
  assert.equal(line.cost, 0.025);
  assert.equal(line.costKind, 'reported');   // what pi's provider billed
  assert.match(line.task, /^[0-9a-f]{10}$/, 'the task hash that pairs bake-off runs');
  assert.ok(line.job, 'the job id dispatch_grade takes');
  const j = s.job(line.job);
  assert.equal(j.cost, 0.025);
  assert.equal(j.costKind, 'reported');
});

test('no cost reported: the run is priced at list price (cost≈$…, costKind list)', { skip: !unix }, (t) => {
  const s = sandbox(t);
  mkdirSync(path.join(s.home, 'config', 'multiclaude'), { recursive: true });
  writeFileSync(path.join(s.home, 'config', 'multiclaude', 'prices.json'), JSON.stringify({ 'fake-coder-low': { in: 5, out: 25 } }));   // USD per million
  const r = spawnSync(process.execPath, s.argv('--edit'), { env: s.env('ok', { FAKE_PI_NOCOST: '1' }), input: 'Make a.txt say hello.', encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(proofOf(r), /cost≈\$0\.0020 /);   // 200 in × $5/M + 40 out × $25/M
  const [line] = s.runs();
  assert.equal(line.cost, 0.002);
  assert.equal(line.costKind, 'list');
  const j = s.job(line.job);
  assert.equal(j.cost, 0.002);
  assert.equal(j.costKind, 'list');
});

test('no cost reported and no price known: no figure anywhere', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = spawnSync(process.execPath, s.argv('--edit'), { env: s.env('ok', { FAKE_PI_NOCOST: '1' }), input: 'Make a.txt say hello.', encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(proofOf(r), /cost/);
  const [line] = s.runs();
  assert.equal(line.cost, null);
  assert.equal(line.costKind, null);
  const j = s.job(line.job);
  assert.equal('cost' in j, false);
  assert.equal('costKind' in j, false);
});

test('the loop guard stops a run that repeats one tool call', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'loop');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /✗ loop guard: same call 3× — read same\.txt/);
  assert.match(proofOf(r), /status=LOOP .*loop="same call 3×/);
  assert.equal(s.runs()[0].status, 'LOOP');
});

test('the same call with a different result each time is not a loop', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'reread');
  assert.equal(r.status, 0, r.stderr);
  assert.match(proofOf(r), /status=SUCCESS .*steps=5/);
});

test('a pi run of its own is recorded as a trial run with its rules version; MULTICLAUDE_PI_RECORD=off keeps it out', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'ok');
  assert.equal(r.status, 0, r.stderr);
  const [line] = s.runs();
  const [rec] = s.records();
  assert.deepEqual([rec.role, rec.pair, rec.job, rec.delegate, rec.status], ['trial', line.job, line.job, 'pi', 'SUCCESS']);
  assert.match(rec.rules, /^[0-9a-f]{8}$/);
  assert.equal(line.rules, rec.rules);
  assert.equal(s.job(line.job).rules, rec.rules);
  assert.match(rec.prompt, /Make a\.txt say hello\./);
  assert.ok(rec.answer && Array.isArray(rec.trace) && rec.trace.length > 0);
  const off = spawnSync(process.execPath, s.argv(), { env: s.env('ok', { MULTICLAUDE_PI_RECORD: 'off' }), input: 'Make a.txt say hello.', encoding: 'utf8', timeout: 60_000 });
  assert.equal(off.status, 0, off.stderr);
  assert.equal(s.records().length, 1);
});

test('--max-steps ends a long run as LOOP; checkpoints are printed on the way', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'steps', '--max-steps', '12', '--checkpoint', '5');
  assert.equal(r.status, 1, r.stderr);
  const cps = r.stderr.split('\n').filter((l) => l.includes('⏸ checkpoint:'));
  assert.deepEqual(cps.map((l) => /checkpoint: (\d+) steps/.exec(l)[1]), ['5', '10']);
  assert.match(proofOf(r), /status=LOOP .*13 tool steps > --max-steps 12/);
});

test('no step cap by default: a long run that keeps making progress is bounded by its time limit only', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = spawnSync(process.execPath, s.argv('--checkpoint', '0'), { env: s.env('steps', { FAKE_PI_STEPS: '75' }), input: 'Read them all.', encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /· no step cap ·/);
  assert.match(proofOf(r), /status=SUCCESS .*steps=75/);
});

test('a run inside the limits passes every checkpoint and succeeds', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'steps');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.split('\n').filter((l) => l.includes('⏸ checkpoint:')).length, 2);   // 8 and 16
  assert.match(proofOf(r), /status=SUCCESS .*steps=17/);
});

test('a failed model call is FAILED although pi exits 0', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'error');
  assert.equal(r.status, 1, r.stderr);
  assert.match(proofOf(r), /status=FAILED .*error="connection refused by upstream"/);
  assert.equal(s.runs()[0].status, 'FAILED');
});

test('a gateway that is down is CAPACITY, not a failure of the model', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = spawnSync(process.execPath, s.argv(), { env: { ...s.env('error'), FAKE_PI_ERROR: '502 Bad Gateway' }, input: 'Make a.txt say hello.', encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(proofOf(r), /status=CAPACITY .*hint=other-model-or-retry .*error="502 Bad Gateway"/);
  assert.equal(s.runs()[0].status, 'CAPACITY');
});

test('an unknown pi model is refused before anything runs (exit 2, no run line)', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = spawnSync(process.execPath, [RUNNER, 'pi', '--model', 'nope', '--job', 'auto', '--no-preflight'], { env: s.env('ok'), input: 'x', encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown pi model 'nope'/);
  assert.equal(s.runs().length, 0);
});

test('killing the runner stops pi and records the run as CANCELLED (exit 130)', { skip: !unix }, async (t) => {
  const s = sandbox(t);
  const pidFile = path.join(s.home, 'pi.pid');
  const child = spawn(process.execPath, s.argv('--edit'), { env: s.env('hang', { FAKE_PI_PID: pidFile }), stdio: ['pipe', 'pipe', 'pipe'] });
  let errText = '';
  child.stderr.on('data', (d) => { errText += d; });
  child.stdin.end('Make a.txt say hello.');
  const started = Date.now();
  while (!/⚙ read a\.txt/.test(errText)) {
    if (Date.now() - started > 30_000) { child.kill('SIGKILL'); assert.fail('the fake pi never started:\n' + errText); }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 130, errText);
  assert.match(errText, /status=CANCELLED/);
  const [line] = s.runs();
  assert.equal(line.status, 'CANCELLED');
  assert.equal(line.exitCode, 130);
  const pid = +readFileSync(pidFile, 'utf8');
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), 'the delegate is gone too');
  assert.equal(existsSync(path.join(s.home, 'cache', 'multiclaude', 'failures.jsonl')), false, 'a cancel is not a failure');
});

test('--cancel <id> stops a running job from another process: the runner ends it as CANCELLED', { skip: !unix }, async (t) => {
  const s = sandbox(t);
  const pidFile = path.join(s.home, 'pi.pid');
  const child = spawn(process.execPath, s.argv(), { env: s.env('hang', { FAKE_PI_PID: pidFile }), stdio: ['pipe', 'pipe', 'pipe'] });
  let errText = '';
  child.stderr.on('data', (d) => { errText += d; });
  child.stdin.end('Review a.txt.');
  const started = Date.now();
  while (!/⚙ read a\.txt/.test(errText)) {
    if (Date.now() - started > 30_000) { child.kill('SIGKILL'); assert.fail('the fake pi never started:\n' + errText); }
    await new Promise((r) => setTimeout(r, 50));
  }
  const id = /dispatch: job id (\S+)/.exec(errText)?.[1];
  assert.ok(id, 'the runner names its job id on stderr');
  // what dispatch_cancel does for a runner it did not start (it writes the same <id>.cancel file)
  const c = spawnSync(process.execPath, [RUNNER, '--cancel', id], { env: s.env('ok'), encoding: 'utf8', timeout: 30_000 });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, new RegExp(`job ${id}: cancel requested`));
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 130, errText);
  assert.match(errText, /✗ cancelled \(request\)/);
  assert.match(errText, /status=CANCELLED/);
  assert.equal(s.job(id).status, 'cancelled');
  assert.equal(existsSync(path.join(s.home, 'cache', 'multiclaude', 'jobs', id + '.cancel')), false, 'the request file is consumed');
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(+readFileSync(pidFile, 'utf8'), 0), 'the delegate is gone too');
  // a finished job: nothing to cancel; an unknown one: exit 1
  const again = spawnSync(process.execPath, [RUNNER, '--cancel', id], { env: s.env('ok'), encoding: 'utf8', timeout: 30_000 });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /is cancelled — nothing to cancel/);
  assert.equal(spawnSync(process.execPath, [RUNNER, '--cancel', 'nope'], { env: s.env('ok'), encoding: 'utf8', timeout: 30_000 }).status, 1);
});

// ── the effort: part of the id, or `pi --thinking` ──
const M = await import('../scripts/lib/models.mjs');
const rows = (...ids) => ids.map(([id, thinking]) => ({ provider: 'local', id, thinking }));

test('bands: ids that carry the effort are the bands; one thinking id is the three bands at three levels', () => {
  const tiers = M.resolvePiBands(rows(['coder-none', false], ['coder-low', false], ['coder-medium', false], ['coder-xhigh', false]), { provider: 'local', id: 'coder-medium' });
  assert.deepEqual([tiers.lo, tiers.med, tiers.hi, tiers.efforts], ['coder-low', 'coder-medium', 'coder-xhigh', null]);
  const one = M.resolvePiBands(rows(['coder', true]), null);
  assert.deepEqual([one.lo, one.med, one.hi], ['coder', 'coder', 'coder']);
  assert.deepEqual(one.efforts, { lo: 'low', med: 'medium', hi: 'xhigh' });
  // One id pi does not list as a thinking model: nothing to set.
  assert.equal(M.resolvePiBands(rows(['coder', false]), null).efforts, null);
  // Effort ids that pi also lists as thinking models: the id decides, no level on top.
  assert.equal(M.resolvePiBands(rows(['coder-low', true], ['coder-xhigh', true]), null).efforts, null);
  assert.equal(M.piTakesEffort({ id: 'coder-low', thinking: true }), false);
  assert.deepEqual(['low', 'ultra', 'none', 'off', 'XHIGH', 'bogus'].map(M.piThinking), ['low', 'max', 'off', 'off', 'xhigh', null]);
});

const runModel = (s, model, ...extra) => spawnSync(process.execPath, [RUNNER, 'pi', '--model', model, '--job', 'auto', '--cd', s.work, '--no-preflight', ...extra], { env: s.env('ok'), input: 'Make a.txt say hello.', encoding: 'utf8', timeout: 60_000 });
const thinkingOf = (argv) => (argv.includes('--thinking') ? argv[argv.indexOf('--thinking') + 1] : null);

test('--effort on a one-id thinking model becomes pi --thinking, and is the effort on record', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = runModel(s, 'solo-coder', '--effort', 'xhigh');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(thinkingOf(s.piArgv()), 'xhigh');
  assert.match(proofOf(r), /^\[dispatch pi model=solo-coder@xhigh status=SUCCESS /);
  const [line] = s.runs();
  assert.equal(line.effort, 'xhigh');
  assert.equal(s.job(line.job).effort, 'xhigh');
  assert.equal(s.records()[0].effort, 'xhigh', 'the trial record keeps it too');
});

test('no --effort on such a model: medium, not whatever pi is set to; ultra and none are mapped', { skip: !unix }, (t) => {
  const s = sandbox(t);
  assert.equal(runModel(s, 'solo-coder').status, 0);
  assert.equal(thinkingOf(s.piArgv()), 'medium');
  assert.match(proofOf(runModel(s, 'solo-coder', '--effort', 'ultra')), /model=solo-coder@max /);
  assert.equal(thinkingOf(s.piArgv()), 'max');
  assert.match(proofOf(runModel(s, 'solo-coder', '--effort', 'none')), /model=solo-coder@off /);
  const bad = runModel(s, 'solo-coder', '--effort', 'bogus');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--effort must be one of /);
});

test('an id that carries its effort, or a model without thinking levels, gets no --thinking; a given --effort is dropped with a note', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = runModel(s, 'fake-coder-low', '--effort', 'high');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(thinkingOf(s.piArgv()), null);
  assert.match(r.stderr, /--effort is ignored for fake-coder-low/);
  assert.match(proofOf(r), /model=fake-coder-low status=SUCCESS /);
  assert.equal(s.runs()[0].effort, null);
  assert.equal(runModel(s, 'plain-coder').status, 0);
  assert.equal(thinkingOf(s.piArgv()), null);
  assert.equal(s.runs()[1].effort, null);
});

test('--band on a one-id family: the same id at the band\'s level', { skip: !unix }, (t) => {
  const s = sandbox(t);
  s.piDefault('solo-coder');
  const band = (b) => spawnSync(process.execPath, [RUNNER, 'pi', '--band', b, '--job', 'auto', '--cd', s.work, '--no-preflight'], { env: s.env('ok'), input: 'Make a.txt say hello.', encoding: 'utf8', timeout: 60_000 });
  assert.match(proofOf(band('hi')), /model=solo-coder@xhigh status=SUCCESS /);
  assert.equal(thinkingOf(s.piArgv()), 'xhigh');
  assert.match(proofOf(band('lo')), /model=solo-coder@low /);
  assert.equal(thinkingOf(s.piArgv()), 'low');
});

test('--band on a family of effort ids: the band is an id, no level', { skip: !unix }, (t) => {
  const s = sandbox(t);
  s.piDefault('fake-coder-medium');
  const r = spawnSync(process.execPath, [RUNNER, 'pi', '--band', 'lo', '--job', 'auto', '--cd', s.work, '--no-preflight'], { env: s.env('ok'), input: 'x', encoding: 'utf8', timeout: 60_000 });
  assert.match(proofOf(r), /model=fake-coder-low status=SUCCESS /);
  assert.equal(thinkingOf(s.piArgv()), null);
});

test('--max-tokens counts cached input at a tenth: a long read is not a loop, a costly one still stops', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const usage = JSON.stringify({ input: 2000, output: 100, cacheRead: 40000, totalTokens: 42100 });
  // 11 calls ≈ 463k tokens in all, ≈ 67k of them weighed: under a 400k cap
  const ok = spawnSync(process.execPath, s.argv('--max-tokens', '400000'), { env: s.env('context', { FAKE_PI_USAGE: usage }), input: 'Read the files.', encoding: 'utf8', timeout: 60_000 });
  assert.match(proofOf(ok), /status=SUCCESS tokens=463,100/);
  const stop = spawnSync(process.execPath, s.argv('--max-tokens', '30000'), { env: s.env('context', { FAKE_PI_USAGE: usage }), input: 'Read the files.', encoding: 'utf8', timeout: 60_000 });
  assert.match(proofOf(stop), /status=LOOP .*loop="[\d,]+ tokens \(cached input counted at 1\/10\) > --max-tokens 30,000"/);
});
