// The AGY side of the runner with a fake `agy` on PATH: a signed-out CLI ends the run as AUTH at
// once (no wait for the timeout), and every job file names the project it was dispatched from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const RUNNER = fileURLToPath(new URL('../scripts/dispatch.mjs', import.meta.url));
const unix = process.platform !== 'win32';

// FAKE_AGY: signedout = `agy models` refuses with the CLI's sign-in text;
//           login = the catalog lists, but a run asks for a login and waits.
const FAKE = `#!/usr/bin/env node
const mode = process.env.FAKE_AGY;
if (process.argv[2] === 'models') {
  if (mode === 'signedout') { console.error('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.'); process.exit(1); }
  console.log('fake-gem-flash\\tFake Gem Flash');
  process.exit(0);
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
    PATH: bin + path.delimiter + process.env.PATH, FAKE_AGY: mode, MULTICLAUDE_PRICES: 'off', MC_PROJECT_DIR: project, MC_SESSION_ID: 'sess-1',
  };
  const go = (...args) => spawnSync(process.execPath, [RUNNER, 'agy', ...args, '--job', 'auto', '--cd', work, '--no-preflight', '--timeout', '50'],
    { env, input: 'Review a.txt.', encoding: 'utf8', timeout: 45_000 });
  const job = (r) => {
    const id = /dispatch: job id (\S+)/.exec(r.stderr)?.[1];
    assert.ok(id, r.stderr);
    return JSON.parse(readFileSync(path.join(home, 'cache', 'multiclaude', 'jobs', id + '.json'), 'utf8'));
  };
  return { go, job, work, project };
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
  const solo = resolveAgyTiers([...fam('gemini-3.8-flash', ['high']), ...fam('gemini-4-argon', ['medium', 'high'])]);
  assert.equal(solo.gemtop, 'gemini-4-argon-high');
  assert.deepEqual(solo.gemalt, []);
  // no generation above Flash: no gem-top
  assert.equal(resolveAgyTiers(fam('gemini-3.8-flash', ['high'])).gemtop, null);
});
