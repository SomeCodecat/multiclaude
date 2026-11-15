// The guard (lib/guard.mjs) — the weaker shadow-shell fallback without an OS sandbox — and the
// user's pi start config (lib/piconfig.mjs) with the tier it picks (lib/sandbox.mjs shellTier).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { blockedCommand, writeOutside, writableAt, guardEnv, segments } from '../scripts/lib/guard.mjs';
import { piConfig } from '../scripts/lib/piconfig.mjs';
import { shellTier, sandboxEnv } from '../scripts/lib/sandbox.mjs';

test('guard: commands that log in, deploy, push or send are refused, also wrapped or nested', () => {
  for (const c of [
    'ssh host', 'FOO=1 ssh -V', 'timeout 30 ansible-playbook site.yml', 'bash -c "tea pr list"', 'git -C /x push origin main',
    'npm publish', 'docker run alpine', 'curl -X POST https://x', 'curl -d a=b https://x', 'curl -H "Authorization: Bearer x" https://x',
    'echo $(gh auth token)', 'find . -exec ssh h \\;', 'pwsh -Command "Enter-PSSession srv"', 'Invoke-RestMethod https://api -Method Post -Body x',
    'git config --global user.name x', 'sudo ls', 'eval "kubectl get pods"', 'env -u X glab mr list', 'ls && scp a b:', 'cat x | ssh h',
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe host', 'powershell -EncodedCommand AAAA', 'terraform apply', 'aws s3 ls', 'git remote add x y',
  ]) assert.ok(blockedCommand(c), `should be refused: ${c}`);
});

test('guard: looking things up passes', () => {
  for (const c of [
    'ls -la', 'git log --oneline', 'git diff HEAD~1', 'git config user.name x', 'npm view react version', 'docker manifest inspect node:22',
    'curl -s https://x/y', 'curl -sI https://x', 'cat a | grep ssh', 'grep -r "ssh" .', 'python3 -c "print(1)"', 'iwr https://x',
    'node --test', 'skopeo inspect docker://alpine', 'echo "git push is blocked"',
  ]) assert.equal(blockedCommand(c), null, c);
});

test('guard: writes outside the writable roots are refused — redirects, tee, rm / mv / cp, sed -i, cd first', () => {
  const R = ['/w', os.tmpdir()];
  const out = (c) => writeOutside(c, '/w', R);
  for (const c of ['echo hi > ~/x', 'ls | tee /etc/a', 'rm -rf ../other', 'cd /etc && rm passwd', 'cp a.txt /home/u/b', 'sed -i s/a/b/ /etc/hosts',
    'mv x ~/y', 'dd if=/dev/zero of=/dev/sda', 'tar xf a.tar -C /opt', 'git -C /home/u/repo reset --hard', 'touch $HOME/x', 'rm -rf $BUILD'])
    assert.ok(out(c), `should be refused: ${c}`);
  for (const c of ['echo hi > out.txt', 'ls 2>/dev/null', `ls | tee ${os.tmpdir()}/a`, 'rm -rf build', 'cd sub && rm x', 'cp /etc/hosts .',
    'sed -n p /etc/hosts', 'mkdir -p /w/a/b', 'git -C /home/u/repo log', 'echo > $TMPDIR/a'])
    assert.equal(out(c), null, c);
  // A read-only shadow's cwd is not a root: a relative write there is outside too.
  assert.equal(writeOutside('echo hi > out.txt', '/r', [os.tmpdir()]), 'out.txt');
  assert.ok(writableAt('a/b.txt', '/w', ['/w']));
  assert.ok(!writableAt('/w2/b.txt', '/w', ['/w']), 'a sibling with the same prefix is not inside');
});

test('guard: segments split on operators and substitutions, quotes stay one word', () => {
  assert.deepEqual(segments('a "b c" | d $(e f) && g`h`'), [['a', 'b c'], ['d'], ['e', 'f'], ['g'], ['h']]);
});

test('guard: a command\'s environment is an allowlist (Windows names without regard to case)', () => {
  const env = guardEnv({ PATH: '/bin', HOME: '/h', SSH_AUTH_SOCK: '/s', GH_TOKEN: 't', OPENAI_API_KEY: 'k', LC_ALL: 'C', SystemRoot: 'C:\\Windows', Path: 'x', MC_MODEL_ID: 'm', PI_X: '1' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LC_ALL', 'MC_MODEL_ID', 'PATH', 'Path', 'SystemRoot']);
  // pi itself keeps its own variables and the provider settings; its commands do not (pi-guard.ts).
  const run = sandboxEnv({ PATH: '/bin', OPENAI_API_KEY: 'k', LITELLM_X: '1', GH_TOKEN: 't', MY_NAME: 'n', MULTICLAUDE_SANDBOX_ENV: 'MY_NAME' });
  assert.deepEqual(Object.keys(run).sort(), ['LITELLM_X', 'MY_NAME', 'OPENAI_API_KEY', 'PATH']);
});

test('piConfig: pi.json, the environment over it, and the tier it picks', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: dir, APPDATA: dir };
  let c = piConfig(env);
  assert.deepEqual([c.command, c.args, c.exclude, c.sandboxed, c.shadowShell], [['pi'], [], [], false, 'auto']);
  mkdirSync(path.join(dir, 'multiclaude'));
  writeFileSync(path.join(dir, 'multiclaude', 'pi.json'), JSON.stringify({ command: ['firejail', '--quiet', 'pi'], args: ['--offline'], exclude: ['billion-context'], sandboxed: true, shadowShell: 'sandbox' }));
  c = piConfig(env);
  assert.deepEqual([c.command, c.args, c.exclude, c.sandboxed, c.shadowShell], [['firejail', '--quiet', 'pi'], ['--offline'], ['billion-context'], true, 'sandbox']);
  assert.equal(shellTier(c), 'custom');
  c = piConfig({ ...env, MULTICLAUDE_PI_COMMAND: '["pi"]', MULTICLAUDE_PI_EXCLUDE: 'none', MULTICLAUDE_SHADOW_SHELL: 'guard', MULTICLAUDE_PI_ARGS: '--a --b' });
  assert.deepEqual([c.command, c.args, c.exclude, c.sandboxed, c.shadowShell], [['pi'], ['--a', '--b'], [], false, 'guard'], '`sandboxed` on plain pi is no sandbox');
  assert.equal(shellTier(c), 'guard');
  assert.deepEqual(piConfig({ ...env, MULTICLAUDE_PI_TOOLS: 'web_search, fetch_content,read,*' }).tools, ['web_search', 'fetch_content']);
  assert.deepEqual(piConfig({ ...env, MULTICLAUDE_PI_TOOLS: 'none' }).tools, []);
  assert.equal(shellTier({ shadowShell: 'off', sandboxed: true }), null);
  // sandbox mode never falls back to the guard; auto does (bwrap first where it works).
  const noBwrap = { MULTICLAUDE_SHADOW_SHELL: 'off' };   // sandboxReady() → null
  assert.equal(shellTier({ shadowShell: 'sandbox' }, noBwrap), null);
  assert.ok(['bwrap', 'guard'].includes(shellTier({ shadowShell: 'auto' })));
});
