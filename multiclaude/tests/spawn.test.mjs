// node --test tests/spawn.test.mjs — scripts/lib/spawn.mjs: a Windows npm .cmd shim (codex.cmd)
// becomes node + its bin script, because Node refuses to spawn .cmd/.bat without a shell (EINVAL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnable } from '../scripts/lib/spawn.mjs';

// What npm 7+ writes (codex.cmd as installed by `npm i -g @openai/codex`), and an older npm's shim.
const NPM7 = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', '',
].join('\r\n');
const OLD_NPM = [
  '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ') ELSE (', '  @SETLOCAL', '  node  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*', ')', '',
].join('\r\n');

function fixture(t, shim, { script = true, nodeExe = false, name = 'codex.cmd' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, name);
  writeFileSync(bin, shim);
  const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (script) { mkdirSync(path.dirname(js), { recursive: true }); writeFileSync(js, ''); }
  if (nodeExe) writeFileSync(path.join(dir, 'node.exe'), '');
  return { dir, bin, js };
}
const WIN = { win: true, node: '/usr/bin/node' };
const ARGS = ['exec', '--json', '-c', 'model_reasoning_effort="high"', '-'];

test('an npm 7+ shim runs its bin script with node, args untouched', (t) => {
  const { bin, js } = fixture(t, NPM7);
  assert.deepEqual(spawnable(bin, ARGS, WIN), ['/usr/bin/node', [js, ...ARGS]]);
});

test('an older npm shim (%~dp0) and a .bat work the same', (t) => {
  const a = fixture(t, OLD_NPM);
  assert.deepEqual(spawnable(a.bin, ['-'], WIN), ['/usr/bin/node', [a.js, '-']]);
  const b = fixture(t, NPM7, { name: 'codex.BAT' });
  assert.deepEqual(spawnable(b.bin, [], WIN), ['/usr/bin/node', [b.js]]);
});

test('a node.exe beside the shim wins, as in the shim itself', (t) => {
  const { dir, bin, js } = fixture(t, NPM7, { nodeExe: true });
  assert.deepEqual(spawnable(bin, ['-'], WIN), [path.join(dir, 'node.exe'), [js, '-']]);
});

test('everything else passes through unchanged', (t) => {
  const { bin } = fixture(t, NPM7);
  assert.deepEqual(spawnable(bin, ARGS, { win: false }), [bin, ARGS]);                      // not Windows
  assert.deepEqual(spawnable('C:\\x\\agy.exe', ARGS, WIN), ['C:\\x\\agy.exe', ARGS]);       // a real executable
  const odd = fixture(t, '@echo off\r\ncall some-other-launcher %*\r\n');
  assert.deepEqual(spawnable(odd.bin, ARGS, WIN), [odd.bin, ARGS]);                         // not an npm shim
  const gone = fixture(t, NPM7, { script: false });
  assert.deepEqual(spawnable(gone.bin, ARGS, WIN), [gone.bin, ARGS]);                       // its script is missing
  assert.deepEqual(spawnable(path.join(os.tmpdir(), 'nope', 'x.cmd'), [], WIN)[1], []);     // unreadable shim
});
