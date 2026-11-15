// The guard: the WEAKER shell fallback for a shadow where no OS sandbox runs (Windows, macOS, a Linux
// without bubblewrap). It is not a sandbox — the shell runs with the user's own rights — only a
// filter in front of it, loaded into pi as an extension (scripts/pi-guard.mjs):
//   - every shell command gets an environment allowlist (no agent sockets, no tokens, no cloud keys);
//   - commands that log in, deploy, push, publish or change a remote system are refused before they
//     run (ssh, ansible, tea / gh, kubectl, docker, cloud CLIs, git push, npm publish, a curl /
//     Invoke-WebRequest that sends data, sudo …), also inside `bash -c` / `pwsh -Command` / `eval` /
//     `find -exec`;
//   - edit / write, and shell redirects / tee to an absolute or ~ path, only inside the writable roots.
// What it cannot see: a program that does those things itself (`python -c`, `node -e`, a script in
// the repo), files the user's rights can read (~/.ssh is readable). The record of each shadow names
// its tier, so guard runs can be told apart from sandboxed ones.
import path from 'node:path';
import os from 'node:os';

// Command names refused outright (basename, lowercase, without .exe / .cmd / .bat / .ps1).
const DENY = new Set(`
ssh scp sftp rsync sshpass mosh telnet ftp lftp nc ncat socat smbclient
ansible ansible-playbook ansible-pull ansible-vault ansible-galaxy ansible-console ansible-inventory
tea gh glab hub kubectl helm k9s oc kubectx terraform tofu pulumi packer vagrant nomad consul
incus lxc lxd virsh qm pct govc vmrun
az aws gcloud gsutil bq doctl hcloud linode-cli flyctl fly vercel netlify heroku wrangler firebase
vault bw op pass gpg gpg2 secret-tool security keyring cmdkey
sudo su doas pkexec runas gsudo
systemctl service shutdown reboot poweroff halt crontab at launchctl schtasks sc mount umount
psql mysql mariadb mongosh mongo redis-cli sqlcmd
enter-pssession new-pssession invoke-command restart-computer stop-computer set-service stop-service
start-service restart-service new-service remove-service set-executionpolicy
`.trim().split(/\s+/));
// Prefix words that run the command after them.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'timeout', 'xargs', 'watch', 'builtin',
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '(', 'call', '&', '.']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']);

const base = (w) => path.basename(String(w).replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, '');

// Shell words grouped into simple commands. Quotes are kept together; ; & | && || newlines, $( ),
// backticks, ( ) and { } separate. Good enough to find the command word, not a full parser.
export function segments(cmd) {
  const out = [];
  let cur = [], w = '', q = null, quoted = false;
  const endWord = () => { if (w || quoted) cur.push(w); w = ''; quoted = false; };
  const endSeg = () => { endWord(); if (cur.length) out.push(cur); cur = []; };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (q === '"' && (c === '`' || (c === '$' && s[i + 1] === '('))) { endSeg(); if (c === '$') i++; continue; }
      w += c; continue;
    }
    if (c === "'" || c === '"') { q = c; quoted = true; continue; }
    // A backslash escapes only a character the shell would act on; before anything else it stays, so a
    // Windows path (C:\Windows\…\ssh.exe, for PowerShell) keeps its separators.
    if (c === '\\' && i + 1 < s.length && s[i + 1] !== '\n') { if (' \t"\'$`\\;&|()<>{}'.includes(s[i + 1])) w += s[++i]; else w += c; continue; }
    if (c === '$' && s[i + 1] === '(') { endSeg(); i++; continue; }
    if (';&|\n`(){}'.includes(c)) { endSeg(); continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    w += c;
  }
  endSeg();
  return out;
}

const SEND = /^(-d|--data|--data-.*|-F|--form|--form-.*|-T|--upload-file|--json|-u|--user|--post.*|--body.*|--method|-b|--cookie)$/;
// The reason a command is refused, or null.
export function blockedCommand(cmd, depth = 0) {
  if (depth > 4) return 'nested too deep to check';
  for (let words of segments(cmd)) {
    // Skip prefixes: assignments, wrappers and their options (`timeout 30`, `nice -n 5`, `env -u X`).
    let i = 0;
    for (; i < words.length; i++) {
      const w = words[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
      if (WRAPPERS.has(base(w))) {
        while (i + 1 < words.length && (/^-/.test(words[i + 1]) || /^\d+[smhd]?$/.test(words[i + 1]))) {
          i++;
          if (/^-(n|u|s|k|c|-signal|-kill-after)$/.test(words[i]) && i + 1 < words.length) i++;
        }
        continue;
      }
      break;
    }
    words = words.slice(i);
    if (!words.length) continue;
    const name = base(words[0]);
    const rest = words.slice(1);
    const lower = rest.map((x) => x.toLowerCase());
    if (DENY.has(name)) return `${name} is not allowed in a shadow (no logins, deploys or remote changes)`;
    if (name === 'eval' || name === 'iex' || name === 'invoke-expression') {
      const r = blockedCommand(rest.join(' '), depth + 1); if (r) return r;
    }
    if (SHELLS.has(name)) {
      const k = lower.findIndex((x) => ['-c', '-command', '/c', '/k', '-encodedcommand', '-e', '-ec'].includes(x));
      if (k >= 0) {
        if (lower[k].startsWith('-e')) return 'an encoded PowerShell command cannot be checked';
        const r = blockedCommand(rest.slice(k + 1).join(' '), depth + 1); if (r) return r;
      }
    }
    const ex = lower.findIndex((x) => ['-exec', '-execdir', '-ok', '-okdir'].includes(x));
    if (name === 'find' && ex >= 0) { const r = blockedCommand(rest.slice(ex + 1).filter((x) => x !== '{}' && x !== '+').join(' '), depth + 1); if (r) return r; }
    if (name === 'git') {
      let j = 0;
      while (j < rest.length && /^-/.test(rest[j])) j += /^-(C|c)$/.test(rest[j]) ? 2 : 1;
      const sub = lower[j];
      if (['push', 'send-email', 'credential', 'credential-store', 'credential-cache', 'remote', 'svn', 'p4'].includes(sub)) return `git ${sub} is not allowed in a shadow`;
      if (sub === 'config' && lower.some((x) => x === '--global' || x === '--system')) return 'git config --global is not allowed in a shadow';
    }
    if (['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'gem', 'twine', 'poetry', 'dotnet', 'nuget', 'mvn', 'gradle'].includes(name)) {
      const bad = lower.find((x) => ['publish', 'unpublish', 'login', 'logout', 'adduser', 'owner', 'deprecate', 'token', 'upload', 'push', 'deploy', 'yank', 'dist-tag'].includes(x));
      if (bad) return `${name} ${bad} is not allowed in a shadow`;
    }
    if (['docker', 'podman', 'nerdctl', 'buildah'].includes(name)) {
      const inspect = (lower[0] === 'manifest' && lower[1] === 'inspect') || (lower[0] === 'buildx' && lower[1] === 'imagetools' && lower[2] === 'inspect')
        || ['version', '--version', 'search'].includes(lower[0]);
      if (!inspect) return `${name} is not allowed in a shadow (except manifest inspect / imagetools inspect / search)`;
    }
    if (name === 'skopeo' && !['inspect', 'list-tags', '--version'].includes(lower[0])) return `skopeo ${lower[0] || ''} is not allowed in a shadow`;
    if (name === 'curl' || name === 'wget') {
      const m = lower.findIndex((x) => x === '-x' || x === '--request' || x === '--method');
      const method = m >= 0 ? (lower[m + 1] || '') : '';
      if ((method && !['get', 'head', 'options'].includes(method)) || lower.some((x) => SEND.test(x) && x !== '-x' && !/^--(request|method)$/.test(x)))
        return `${name} that sends data or credentials is not allowed in a shadow (GET only)`;
      if (rest.some((x) => /^authorization:/i.test(x))) return `${name} with an Authorization header is not allowed in a shadow`;
    }
    if (['invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm'].includes(name)) {
      const m = lower.findIndex((x) => x === '-method');
      const method = m >= 0 ? (lower[m + 1] || '') : '';
      if ((method && !['get', 'head', 'options'].includes(method)) || lower.some((x) => ['-body', '-infile', '-credential', '-form', '-token', '-authentication'].includes(x))
        || rest.some((x) => /authorization/i.test(x))) return `${name} that sends data or credentials is not allowed in a shadow (GET only)`;
    }
    if (name === 'start-process' && lower.includes('runas')) return 'Start-Process -Verb RunAs is not allowed in a shadow';
  }
  return null;
}

const under = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };
// ~ and the home / temp variables become paths; any other variable at the start is unknown, so it
// counts as outside (the caller refuses it).
const expand = (p, home = os.homedir()) => String(p)
  .replace(/^~(?=$|[\\/])/, home)
  .replace(/^(\$HOME|\$\{HOME\}|\$env:(HOME|USERPROFILE)|%USERPROFILE%)(?=$|[\\/])/i, home)
  .replace(/^(\$TMPDIR|\$\{TMPDIR\}|\$env:(TEMP|TMP)|%TEMP%|%TMP%)(?=$|[\\/])/i, os.tmpdir())
  .replace(/^(\$|%)/, '/\0unknown-variable/');
// A write to `p` (relative to cwd) lands inside one of `roots`.
export function writableAt(p, cwd, roots) {
  const abs = path.resolve(cwd, expand(p));
  return roots.some((r) => under(abs, path.resolve(r)));
}
// Commands that change the files named in their arguments: all of them (rm, mv …), only the last
// one (cp, ln, install), or only after the script (sed -i).
const MUTATE_ALL = new Set(['rm', 'rmdir', 'mv', 'unlink', 'shred', 'truncate', 'touch', 'mkdir', 'chmod', 'chown', 'chgrp', 'setfacl',
  'remove-item', 'del', 'erase', 'rd', 'move-item', 'rename-item', 'new-item', 'set-content', 'add-content', 'out-file',
  'clear-content', 'set-itemproperty', 'move', 'ren']);
const MUTATE_LAST = new Set(['cp', 'ln', 'install', 'copy-item', 'copy', 'xcopy', 'robocopy']);
// The first path a command would write outside `roots` — redirects, tee, file-changing commands,
// `dd of=`, `tar -C` / `unzip -d` — or null. Absolute, ~ and ../ paths are resolved against the
// command's directory (a `cd` earlier in the line moves it); a relative path stays in cwd, which is
// the shadow's throwaway worktree.
export function writeOutside(cmd, cwd, roots) {
  let dir = cwd;
  const bad = (t) => t && !/^&?\d$/.test(t) && !/^\/dev\/(null|stdout|stderr|tty)$/.test(t) && !/^\$null$/i.test(t) && !/^nul$/i.test(t)
    && !writableAt(t, dir, roots);
  for (const words of segments(cmd)) {
    let k = 0;
    while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]) || WRAPPERS.has(base(words[k])))) k++;
    const name = base(words[k] || '');
    const args = words.slice(k + 1);
    if ((name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'sl') && args.length) {
      dir = path.resolve(dir, expand(args.filter((x) => !x.startsWith('-'))[0] || '~'));
      continue;
    }
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const m = w.match(/^\d?>>?(.+)$/) || w.match(/^&>>?(.+)$/);
      const t = m ? m[1] : (/^\d?>>?$/.test(w) || /^&>>?$/.test(w)) ? words[i + 1] : null;
      if (bad(t)) return t;
    }
    const plain = args.filter((x, i) => !x.startsWith('-') && !/^\d?>/.test(x) && !/^&>/.test(x) && !/^\d?>>?$/.test(args[i - 1] || ''));
    let targets = [];
    if (name === 'tee' || MUTATE_ALL.has(name)) targets = plain;
    else if (MUTATE_LAST.has(name)) targets = plain.slice(-1);
    else if (name === 'sed' && args.some((x) => /^-i|^--in-place/.test(x) || /^-[a-z]*i/.test(x))) targets = args.some((x) => x === '-e' || x === '-f') ? plain : plain.slice(1);
    else if (name === 'dd') targets = args.filter((x) => x.startsWith('of=')).map((x) => x.slice(3));
    else if (name === 'tar' || name === 'unzip') {
      const j = args.findIndex((x) => x === '-C' || x === '--directory' || x === '-d');
      if (j >= 0) targets = [args[j + 1]];
    } else if (name === 'git') {
      const j = args.findIndex((x) => x === '-C');
      if (j >= 0 && args.slice(j + 2).some((x) => /^(add|commit|checkout|switch|reset|clean|rm|mv|restore|stash|merge|rebase|cherry-pick|apply|am|pull|fetch|tag|branch|worktree)$/.test(x))) targets = [args[j + 1]];
    }
    for (const t of targets) if (bad(t)) return t;
  }
  return null;
}

// The environment a guarded shell command gets (exact names, then prefixes). Windows names are
// matched without regard to case.
const KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'COREPACK_ENABLE_AUTO_PIN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'MC_MODEL_ID',
  // Windows
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'SYSTEMDRIVE', 'HOMEDRIVE', 'HOMEPATH',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PSMODULEPATH', 'PUBLIC', 'ALLUSERSPROFILE'];
const KEEP_PREFIX = ['LC_', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];
export function guardEnv(env, extra = []) {
  const keep = new Set([...KEEP, ...extra.map((x) => String(x).toUpperCase())]);
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v == null) continue;
    const K = k.toUpperCase();
    if (keep.has(K) || KEEP_PREFIX.some((p) => K.startsWith(p))) out[k] = v;
  }
  return out;
}
