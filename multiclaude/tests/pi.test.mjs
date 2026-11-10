// node --test tests/pi.test.mjs — scripts/dispatch.mjs with a fake `pi` on PATH: the trial
// delegate's loop guard, checkpoints, error handling (pi exits 0 on a failed model call), the
// cost on the proof line, the runs.jsonl line the scorecard reads, and a killed runner
// (dispatch_cancel) recorded as CANCELLED.
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
  process.exit(0);
}
if (process.env.FAKE_PI_PID) require('node:fs').writeFileSync(process.env.FAKE_PI_PID, String(process.pid));
const out = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (toolName, args, isError) => {
  out({ type: 'tool_execution_start', toolName, args });
  out({ type: 'tool_execution_end', toolName, isError: !!isError, result: { content: [{ type: 'text', text: isError ? 'ENOENT' : 'ok' }] } });
};
const say = (text, stopReason, extra) => out({ type: 'message_end', message: { role: 'assistant', stopReason, content: text ? [{ type: 'text', text }] : [], usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.0125 } }, ...extra } });
process.stdin.resume();
process.stdin.on('end', async () => {
  if (mode === 'ok') {
    say('', 'toolUse'); tool('read', { path: 'a.txt' }); tool('edit', { path: 'a.txt' });
    say('Done: a.txt now says hello.', 'stop');
  } else if (mode === 'loop') {
    for (let i = 0; i < 6; i++) { say('', 'toolUse'); tool('read', { path: 'same.txt' }); await sleep(20); }
    await sleep(60000);   // a real loop never ends by itself: the runner has to stop it
  } else if (mode === 'steps') {
    for (let i = 0; i < 17; i++) { say('', 'toolUse'); tool('read', { path: 'f' + i + '.txt' }); }
    say('Done after 17 reads.', 'stop');
  } else if (mode === 'error') {
    out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'connection refused by upstream', content: [] } });
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
    ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'),
    PATH: bin + path.delimiter + process.env.PATH, FAKE_PI: mode, ...more,
  });
  const argv = (...extra) => [RUNNER, 'pi', '--model', 'fake-coder-low', '--job', 'auto', '--cd', work, '--no-preflight', ...extra];
  const runs = () => {
    const f = path.join(home, 'cache', 'multiclaude', 'runs.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { home, env, argv, runs };
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
  assert.match(line.task, /^[0-9a-f]{10}$/, 'the task hash that pairs bake-off runs');
  assert.ok(line.job, 'the job id dispatch_grade takes');
});

test('the loop guard stops a run that repeats one tool call', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'loop');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /✗ loop guard: same call 3× — read same\.txt/);
  assert.match(proofOf(r), /status=LOOP .*loop="same call 3×/);
  assert.equal(s.runs()[0].status, 'LOOP');
});

test('--max-steps ends a long run as LOOP; checkpoints are printed on the way', { skip: !unix }, (t) => {
  const s = sandbox(t);
  const r = run(s, 'steps', '--max-steps', '12', '--checkpoint', '5');
  assert.equal(r.status, 1, r.stderr);
  const cps = r.stderr.split('\n').filter((l) => l.includes('⏸ checkpoint:'));
  assert.deepEqual(cps.map((l) => /checkpoint: (\d+) steps/.exec(l)[1]), ['5', '10']);
  assert.match(proofOf(r), /status=LOOP .*13 tool steps > --max-steps 12/);
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
