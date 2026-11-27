// multiclaude shadow runs — the record behind /multiclaude:shadow.
//
// A shadow is a pi run of a task another agent is doing for real (a Codex / AGY
// job, a Claude subagent). Its result is never used: it is recorded next to the
// real agent's result (the reference), so the pi working rules and the task
// prompts can be tuned against pairs — which rules version loops less, where
// the self-hosted model drifts from what the reference delivered.
//
// One JSON line per run in <data>/multiclaude/shadow/records.jsonl (0600, this
// machine only: it holds task prompts, answers and patches of the user's code).
// Secrets are scrubbed before anything is written.
//
// A pi run of its own (the trial: role `trial`) is recorded the same way, and
// every judgement of a pi run goes to ratings.jsonl beside it: the orchestrator's
// grade, a verdict of the pairs review, a rating typed by hand. A rating is only
// worth keeping with the run it judges and the rules version that run got.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync, unlinkSync, statSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const isWin = process.platform === 'win32';
export const shadowDir = (env = process.env) => env.MULTICLAUDE_SHADOW_DIR
  || (isWin ? path.join(env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'multiclaude', 'shadow')
    : path.join(env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'multiclaude', 'shadow'));
export const recordsFile = (env = process.env) => path.join(shadowDir(env), 'records.jsonl');
// Extra working rules for every pi run, one `- rule` per line: the file the tuning writes to.
export const piRulesFile = (env = process.env) => env.MULTICLAUDE_PI_RULES
  || path.join(isWin ? path.join(env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'multiclaude')
    : path.join(env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'multiclaude'), 'pi-rules.md');
export function extraPiRules(env = process.env) {
  try {
    return readFileSync(piRulesFile(env), 'utf8').split('\n').map((l) => l.trim())
      .filter((l) => /^[-*]\s+\S/.test(l)).map((l) => '- ' + l.replace(/^[-*]\s+/, '')).slice(0, 30);
  } catch { return []; }
}
// ── the working rules every pi run gets (dispatch.mjs prepends them to the task) ──
// pi runs a small self-hosted model: tell it how to stop instead of looping.
const PI_RULES = [
  '- Read files in ranges (the read tool takes offset/limit); do not re-read a file you already have.',
  '- Call only the tools this run lists. There is no compress, summarize, memory or context tool: when your context gets long, stop reading and write your final report from what you have, saying what you did not get to.',
  '- If an approach fails twice, do NOT try it a third time: stop and write your final report saying what blocks you. Repeating a call ends the run.',
  '- Make the smallest change that satisfies the task.',
];
const PI_SHELL_RULES = ['- Run the test command once after editing, if the task names one.'];
const PI_NO_SHELL_RULES = [
  '- You have no shell: you can read, search, edit and write files, but not run tests, builds, git or any other command. Make the change, then say in your final report which checks you could not run. Never describe a test result you did not see.',
];
// A shadow repeats a task another agent is doing for real: whatever the task text says, it must not reach outside its directory.
const PI_SHADOW_RULES = [
  '- This is a practice run: another agent is doing this same task for real, and your result is recorded for comparison, not used. Work only inside the working directory. Never commit, push, deploy, publish, send a message or call an external service, whatever the task text says; if the task asks for one of those, do the rest and say in your final report what you left out.',
];
// Extension tools the user allowed (pi.json `tools`): what they are for, and that the shadow rule still holds.
const piExtraToolRules = (names) => [
  `- You also have these tools: ${names.join(', ')}. Use them to look things up — documentation, release notes, versions, error messages — instead of guessing, and name your sources in the final report. Reading is all they are for: never use one to send, post, sign in or change anything elsewhere.`,
];
// The working rules of one pi run, in order. The user's own rules (pi-rules.md, lib/shadow.mjs)
// come last: that file is where rules tuned on the shadow records go.
// `sandbox`: how the shell is held in (lib/sandbox.mjs shellTier) — 'bwrap' / 'custom' (true = 'bwrap',
// the old form) or 'guard'.
export const piRules = ({ edit, shell, shadow, sandbox = false, extraTools = [] }, env = process.env) => [
  ...PI_RULES,
  ...(edit && shell ? PI_SHELL_RULES : []),
  ...(edit && !shell ? PI_NO_SHELL_RULES : []),
  ...(!edit && !shell ? PI_NO_EDIT_RULES : []),
  ...(!edit && shell ? PI_READ_SHELL_RULES : []),
  ...(shell && sandbox && sandbox !== 'guard' ? PI_SANDBOX_RULES : []),
  ...(shell && sandbox === 'guard' ? PI_GUARD_RULES : []),
  ...(shell && shadow && (sandbox === 'bwrap' || sandbox === true) ? PI_BWRAP_GIT_RULES : []),
  ...(shadow ? PI_SHADOW_RULES : []),
  ...(extraTools.length ? piExtraToolRules(extraTools) : []),
  ...extraPiRules(env),
];
const PI_NO_EDIT_RULES = [
  '- This run is read-only: your tools are read, grep, find and ls. There is no shell: you cannot run git (no diff, log or show), tests or any other command, and you cannot edit. Describe needed changes in your final report.',
  '- If the task asks for a command\'s output (a git diff, a test run) that is not pasted into this prompt, work from the files as they are on disk and say in your final report which command you could not run. Never describe output you did not see.',
];
// Read-only with a shell (a shadow in the sandbox): look things up and check them, change nothing.
const PI_READ_SHELL_RULES = [
  '- This run is read-only: your tools are read, grep, find, ls and bash, and there is no edit tool. Use the shell to look things up and check them (git log/diff/show, a test or build run, `--help`, a registry query); describe needed changes in your final report.',
];
// A shadow's shell runs in a sandbox (lib/sandbox.mjs). Saying so up front keeps pi from spending its
// steps on a login or a deploy that cannot work there.
const PI_SANDBOX_RULES = [
  '- Your shell runs in a sandbox: files are read-only except the working directory and /tmp, and there are no credentials — no ssh (no ~/.ssh, no agent, no control sockets), no git push, no API tokens, no docker, no sudo. The network is there for looking things up (package registries, release pages, image tags). A command that needs a login or a remote host fails, and so does any script that wraps one (an access helper, ansible): the first such failure is final — do not work around it and do not look into why. When the task needs a live host\'s state, answer from the repository (inventory, configs, roles, runbooks) and the files the task names, and say in your final report which commands you would have run and what you could not check.',
  '- Check facts with the shell instead of guessing them (a version, an image tag, whether a tool exists in an image), and report what you checked and how.',
];
// A bwrap shadow's checkout is a throwaway worktree of the repository, its git data mounted read-only
// (dispatch.mjs): reading history works, changing the repository does not — say so before pi tries.
const PI_BWRAP_GIT_RULES = [
  '- The working directory is a copy of the repository as the real agent had it, uncommitted files included. git status, diff, log and show work; git add, commit, stash, checkout and reset fail (the repository is read-only) — compare with `git diff` and edit the files directly.',
];
// No OS sandbox (lib/guard.mjs): the shell runs with the user's own rights, and a filter refuses what
// would reach out. The model is told the same limits, and that a refusal is final.
const PI_GUARD_RULES = [
  '- Your shell runs with a guard, not a sandbox: commands that log in, deploy, push, publish or change a remote system (ssh, ansible, git push, docker, kubectl, cloud CLIs, a curl that sends data, sudo) are refused, and so are writes outside the working directory and the temp dir. The network is there for looking things up (package registries, release pages, image tags). When the guard refuses a command, do not try another way around it (no python -c, no script): say in your final report what you could not check.',
  '- Check facts with the shell instead of guessing them (a version, an image tag, whether a tool exists in an image), and report what you checked and how.',
];
// The rules version a run got: the same hash = the same working rules, whatever the model.
export const rulesHash = (lines) => createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 8);

const RECORDS_MAX_BYTES = 64 * 1024 * 1024;
const CAPS = { prompt: 60_000, answer: 30_000, patch: 80_000, arg: 400, result: 400, text: 600, trace: 160 };

// ── secrets ──
// Anything that looks like a credential is replaced before a record is written:
// tool output can carry env dumps, key files, tokens on command lines.
const SCRUB = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted token]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[redacted token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bA[KS]IA[0-9A-Z]{16}\b/g, '[redacted key id]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, '$1:[redacted]@'],
  // a token alone as the userinfo (https://<token>@host); a short name (ssh://git@host) stays
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]{16,}@/gi, '$1[redacted]@'],
  // NAME=value / "name": "value" where the name says secret. A quoted value always goes; an unquoted
  // one stays when it is plainly code and no secret: a call or an index, a number, a keyword, an env lookup
  // or a field of a well-known object (`const tokens = count(input)`, `max_tokens: 400000`,
  // `apiKey = process.env.API_KEY`, `token = this.token`). When in doubt it goes: a record that lost a
  // harmless string is the cheaper mistake.
  [/((?:^|[^A-Za-z0-9])["']?[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|passphrase|api[_-]?key|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{6,})/gi,
    (m, name, value) => (/^["']/.test(value) || !CODE_VALUE.test(value) ? `${name}[redacted]` : m)],
];
const CODE_VALUE = /[()[\]{}]|^\d+(?:\.\d+)?$|^(?:true|false|null|none|undefined)$|^(?:process\.env|os\.environ|import\.meta\.env|env)\.|^(?:this|self|config|cfg|conf|options|opts|settings|args|params|props|ctx|req|request|state)(?:\.[A-Za-z_$][\w$]*)+$/i;
export function scrub(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, to] of SCRUB) out = out.replace(re, to);
  return out;
}
const cap = (s, n) => {
  if (typeof s !== 'string') return s == null ? null : String(s);
  return s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters cut]` : s;
};
const clean = (s, n) => (s == null ? null : cap(scrub(String(s)), n));

// ── the working tree as a tree id, without touching the real index ──
const git = (dir, args, opts = {}) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...opts });
// tracked + untracked files as they are on disk (ignored ones left out) → a tree id, or null.
// `info` (optional) gets `error`: why git could not take the tree, or the files it left out. A file git
// cannot read (permissions, one that vanished mid-way) no longer costs the whole snapshot: `add
// --ignore-errors` takes the rest and says which it skipped — before, any error meant no snapshot and the
// shadow started at HEAD without the real agent's uncommitted files, with nothing logged.
const gitSays = (r) => String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 300);
export function treeSnap(dir, info = null) {
  const gd = git(dir, ['rev-parse', '--absolute-git-dir']);
  if (gd.status !== 0) { if (info) info.error = `no repository: ${gitSays(gd)}`; return null; }
  const tmp = path.join(os.tmpdir(), `mc-index-${process.pid}-${Date.now().toString(36)}`);
  try { copyFileSync(path.join(gd.stdout.trim(), 'index'), tmp); } catch { /* no index yet: git starts an empty one */ }
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    const add = git(dir, ['add', '-A', '--ignore-errors', '.'], { env });
    if (add.status !== 0 && info) info.error = `git add left files out: ${gitSays(add)}`;
    if (add.error || add.signal) { if (info) info.error = `git add failed: ${gitSays(add)}`; return null; }   // a timeout: the index is half-built
    const t = git(dir, ['write-tree'], { env });
    if (t.status !== 0) { if (info) info.error = `git write-tree failed: ${gitSays(t)}`; return null; }
    return t.stdout.trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    try { unlinkSync(tmp + '.lock'); } catch { /* ignore */ }
  }
}
// The working tree as a commit a shadow can start from: tracked changes, untracked files (ignored ones left
// out) on top of HEAD, so a shadow sees the files the real agent sees, not the last commit. Written with a
// fixed author (works without user.name), referenced by nothing but the shadow worktree that checks it out
// (git gc drops it later). { commit, head, snapshot } — snapshot false when the tree is HEAD's; null when
// the dir is no repository. `error`: what git said when it could not take the tree (then the commit is HEAD
// and `snapshot` false) or left files out of it (the snapshot holds the rest).
export const SNAP_SUBJECT = 'multiclaude shadow base (working tree snapshot)';
export function snapCommit(dir) {
  const head = git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const headId = head.status === 0 ? head.stdout.trim() : null;
  const info = {};
  const tree = treeSnap(dir, info);
  const withErr = (r) => (r && info.error ? { ...r, error: info.error } : r);
  if (!tree) return withErr(headId ? { commit: headId, head: headId, snapshot: false } : null);
  if (headId) {
    const ht = git(dir, ['rev-parse', 'HEAD^{tree}']);
    if (ht.status === 0 && ht.stdout.trim() === tree) return withErr({ commit: headId, head: headId, snapshot: false });
  }
  const who = { GIT_AUTHOR_NAME: 'multiclaude', GIT_AUTHOR_EMAIL: 'multiclaude@localhost', GIT_COMMITTER_NAME: 'multiclaude', GIT_COMMITTER_EMAIL: 'multiclaude@localhost' };
  const c = git(dir, ['commit-tree', tree, ...(headId ? ['-p', headId] : []), '-m', SNAP_SUBJECT], { env: { ...process.env, ...who } });
  if (c.status !== 0) { info.error = `git commit-tree failed: ${gitSays(c)}`; return withErr(headId ? { commit: headId, head: headId, snapshot: false } : null); }
  return withErr({ commit: c.stdout.trim(), head: headId, snapshot: true });
}
// What changed between two trees (or a commit and a tree): { patch, files } — null when git says no.
export function patchBetween(dir, a, b) {
  if (!a || !b) return null;
  const names = git(dir, ['diff', '--name-only', a, b]);
  if (names.status !== 0) return null;
  const files = names.stdout.split('\n').filter(Boolean);
  if (!files.length) return { patch: '', files };
  const d = git(dir, ['diff', '--no-color', a, b]);
  return { patch: d.status === 0 ? d.stdout : '', files };
}

// ── records ──
const hashTask = (t) => (typeof t === 'string' && t ? createHash('sha1').update(t).digest('hex').slice(0, 10) : null);
// One step of a pi run, as kept in a record.
export function traceStep(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.k === 'call') return { k: 'call', ttft: t.ttft ?? null, ms: t.ms ?? null, in: t.in ?? null, out: t.out ?? null, think: t.think ?? null, cached: t.cached ?? null, stop: t.stop || null, text: clean(t.text || '', CAPS.text) || '' };
  return { k: 'tool', tool: String(t.tool || ''), args: clean(typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? {}), CAPS.arg), ms: t.ms ?? null, error: !!t.error, result: clean(t.result || '', CAPS.result) || '' };
}
export function buildRecord(r) {
  const trace = Array.isArray(r.trace) ? r.trace.map(traceStep).filter(Boolean) : null;
  return {
    v: 1, ts: r.ts || new Date().toISOString(), pair: String(r.pair || ''), role: r.role === 'reference' || r.role === 'trial' ? r.role : 'shadow',
    job: r.job || null, delegate: r.delegate || null, model: r.model || null, effort: r.effort || null,
    kind: r.kind || null, label: clean(r.label, 120), cwd: r.cwd || null, edit: !!r.edit, shell: !!r.shell, sandbox: r.sandbox || null,
    // a shadow's start: base 'snapshot' (the real agent's working tree) | 'head' (the last commit, before
    // 2.21 always — uncommitted files the agent relied on were missing); masked: its sandbox showed the
    // shadow's worktree at the real checkout's path, the live checkout hidden; judge: the verdicts on its time
    ...(r.base ? { base: r.base } : {}), ...(r.masked != null ? { masked: !!r.masked } : {}),
    ...(Array.isArray(r.judge) && r.judge.length ? { judge: r.judge.slice(0, 10).map((j) => ({ at: j.at ?? null, verdict: j.verdict || null, cause: j.cause || null, why: clean(j.why, 400), model: j.model || null, via: j.via || null })) } : {}),
    // salvaged: a shadow stopped by its time limit or the judge wrote its final report afterwards, with no
    // tools ('yes'; 'partial' = cut off, the streamed text kept). snapError: why its start fell back to HEAD
    // or left files out (git's own words). asOf: when the real agent started — the scratchpad files it
    // named were copied as they were then.
    ...(r.salvaged ? { salvaged: String(r.salvaged) } : {}), ...(r.snapError ? { snapError: clean(r.snapError, 400) } : {}),
    ...(r.asOf ? { asOf: r.asOf } : {}),
    task: r.task || hashTask(r.prompt), rules: r.rules || null,
    status: r.status || null, exitCode: r.exitCode ?? null, dur: r.dur ?? null, tokens: r.tokens ?? null,
    in: r.in ?? null, out: r.out ?? null, think: r.think ?? null, cached: r.cached ?? null, cacheWrite: r.cacheWrite ?? null,
    steps: r.steps ?? null, calls: r.calls ?? null, cost: r.cost ?? null, costKind: r.costKind || null,
    prompt: clean(r.prompt, CAPS.prompt), answer: clean(r.answer, CAPS.answer),
    files: Array.isArray(r.files) ? r.files.slice(0, 200) : null, patch: clean(r.patch, CAPS.patch),
    ...(trace ? { trace: trace.length > CAPS.trace ? [...trace.slice(0, CAPS.trace / 2), { k: 'cut', n: trace.length - CAPS.trace }, ...trace.slice(-CAPS.trace / 2)] : trace } : {}),
  };
}
// One line appended to a 0600 file under the records dir; the newest half is kept once it outgrows the cap.
function appendLine(file, rec) {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {   // keep the newest half once the file outgrows its cap
      if (statSync(file).size > RECORDS_MAX_BYTES) {
        const l = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        writeFileSync(file, l.slice(Math.floor(l.length / 2)).join('\n') + '\n', { mode: 0o600 });
      }
    } catch { /* no file yet */ }
    appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows */ }
    return rec;
  } catch { return null; }   // never fail a run over its record
}
export function writeRecord(r, env = process.env) {
  const rec = buildRecord(r);
  return rec.pair ? appendLine(recordsFile(env), rec) : null;
}

// ── ratings ──
// Every judgement of a pi run, kept for good: the orchestrator's grade (dispatch_grade / scorecard.mjs grade;
// grades.jsonl in the cache dir is only the scorecard's working copy), a verdict the pairs review gave
// (`VERDICT <pair> <grade> — why` lines in its answer), a rating typed by hand (shadow.mjs rate).
export const ratingsFile = (env = process.env) => path.join(shadowDir(env), 'ratings.jsonl');
export const GRADES = ['pass', 'rework', 'fail'];
// Why a pi run fell short and what kind of task it was, in fixed words: free-text notes do not add up,
// these do — "where pi lacks" per cause and per task kind (shadow.mjs summary), later the topics of skills.
export const CAUSES = {
  none: 'nothing went wrong (a pass)',
  loop: 'went round in circles: re-read, re-ran, ran out of steps or time',
  misread: 'misread the task, or worked in the wrong place',
  knowledge: 'lacked knowledge of the repository, a tool or the domain (conventions, commands, APIs)',
  broke: 'the change is wrong or breaks something',
  unfinished: 'left part of the task undone',
  'false-claim': 'the report claims what the steps do not show',
  'gave-up': 'stopped, refused or asked instead of doing the task',
  tooling: 'misused its tools (failed edits, wrong arguments, tool errors)',
  infra: 'the provider or gateway failed, not the model',
  env: 'the shadow lacked a file, tool, login or access the real agent had, not the model',
};
// Causes that are not the model's: such a rework / fail counts for nobody — not in the grades, the causes
// or the task kinds of "where pi falls short" (shadow.mjs summary; scorecard.mjs treats a grade alike).
export const NOT_MODEL = new Set(['infra', 'env']);
export const notModel = (g) => !!g && g.grade !== 'pass' && NOT_MODEL.has(causeOf(g.cause));
export const KINDS = ['review', 'bugfix', 'feature', 'refactor', 'tests', 'docs', 'ops', 'research', 'other'];
const word = (x) => String(x ?? '').trim().toLowerCase();
export const causeOf = (x) => (Object.hasOwn(CAUSES, word(x)) ? word(x) : null);
export const kindOf = (x) => (KINDS.includes(word(x)) ? word(x) : null);
const fig = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export function writeRating(r, env = process.env) {
  if (!r || !GRADES.includes(r.grade) || !(r.job || r.pair)) return null;
  return appendLine(ratingsFile(env), {
    v: 1, ts: r.ts || new Date().toISOString(), job: r.job || null, pair: String(r.pair || r.job), delegate: r.delegate || null, model: r.model || null,
    rules: r.rules || null, grade: r.grade, by: clean(r.by, 80) || 'orchestrator', note: clean(r.note, 2000), gates: clean(r.gates, 2000),
    vs: r.vs || null, kind: kindOf(r.kind) || clean(r.kind, 40), cause: causeOf(r.cause), label: clean(r.label, 120), task: r.task || null, status: r.status || null,
    tokens: fig(r.tokens), dur: fig(r.dur), steps: fig(r.steps), cost: fig(r.cost),
  });
}
export function readRatings(env = process.env) {
  try {
    return readFileSync(ratingsFile(env), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && GRADES.includes(r.grade));
  } catch { return []; }
}
// `VERDICT <pair id> <pass|rework|fail> [cause] [kind] — why` lines of a review answer → [{ pair, grade, cause, kind, note }]
// (the last line per pair). The cause and kind words are read only before the separator, in either order.
export function parseVerdicts(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(/^[\s>*`-]*VERDICT\s+`?([A-Za-z0-9_.:-]*[A-Za-z0-9_])`?\s*[:—–-]?\s*`?(pass|rework|fail)`?(?![A-Za-z])(.*)$/gim)) {
    let rest = m[3], cause = null, kind = null;
    for (let t; (t = /^[\s`*,|/]+([A-Za-z][A-Za-z-]*)`?/.exec(rest));) {
      if (!cause && causeOf(t[1])) cause = causeOf(t[1]);
      else if (!kind && kindOf(t[1])) kind = kindOf(t[1]);
      else break;
      rest = rest.slice(t[0].length);
    }
    out.set(m[1], { pair: m[1], grade: m[2].toLowerCase(), cause, kind, note: rest.replace(/^[\s:—–-]+/, '').replace(/[`*\s]+$/, '') });
  }
  return [...out.values()];
}
export function readRecords(env = process.env) {
  try {
    return readFileSync(recordsFile(env), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.pair);
  } catch { return []; }
}

// ── pairs and figures ──
const STUCK = /^(LOOP|TIMEOUT|BUDGET)/;
const INFRA = /^(QUOTA|CAPACITY|AUTH|NO_RESULT|CANCELLED)/;
const median = (a) => {
  const v = a.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};
const ratio = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? a / b : null);
const overlap = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || (!a.length && !b.length)) return null;
  const A = new Set(a), B = new Set(b);
  let both = 0; for (const f of A) if (B.has(f)) both++;
  return both / new Set([...A, ...B]).size;
};
// records → pairs (newest first): { pair, ts, shadow, reference, trial } — the newest record of each role wins.
// `shadow` is the pi side: a shadow, or a pi run of its own (`trial`: no reference). With `ratings` each pair
// also gets `ratings` (oldest first) and `rating` (the newest): the judgements of that pi run.
export function pairUp(records, { sinceMs = 0, ratings = null } = {}) {
  const by = new Map();
  for (const r of records) {
    if (!r || !r.pair) continue;
    const p = by.get(r.pair) || { pair: r.pair, ts: r.ts, shadow: null, reference: null };
    const role = r.role === 'reference' ? 'reference' : 'shadow';
    if (!p[role] || !(r.ts < p[role].ts)) p[role] = r;   // a later line wins a tie
    if (r.ts > p.ts) p.ts = r.ts;
    by.set(r.pair, p);
  }
  // the period is applied to the pair, not to each side: a pair whose two ends lie either side of the cut stays whole
  const pairs = [...by.values()].filter((p) => p.shadow && !(Date.parse(p.ts) < sinceMs)).sort((a, b) => (a.ts < b.ts ? 1 : -1));
  for (const p of pairs) {
    p.trial = p.shadow.role === 'trial';
    if (!ratings) continue;
    // a rating names the pi job it judged; one without a job (typed for a pair) goes by the pair id
    p.ratings = ratings.filter((r) => (r.job ? r.job === p.shadow.job : r.pair === p.pair)).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    p.rating = p.ratings[p.ratings.length - 1] || null;
  }
  return pairs;
}
// One row per pi model × rules version: how the shadows did, and against their references.
export function summarize(records, opts = {}) {
  const pairs = pairUp(records, opts);
  const rows = new Map();
  for (const p of pairs) {
    const s = p.shadow, ref = p.reference;
    const key = `${s.model} ${s.rules || '-'}`;
    const row = rows.get(key) || { model: s.model, rules: s.rules || null, runs: 0, trial: 0, infra: 0, ok: 0, stuck: 0, failed: 0, paired: 0, rated: 0, ratedPass: 0, ratedRework: 0, ratedFail: 0, notModel: 0, causes: {}, cost: 0, costApprox: false, _steps: [], _tokens: [], _dur: [], _cached: [], _ttft: [], _rDur: [], _rTok: [], _same: [] };
    row.runs++;
    if (p.trial) row.trial++;
    if (p.rating) {
      row.rated++;
      if (notModel(p.rating)) row.notModel++;
      else {
        row[p.rating.grade === 'pass' ? 'ratedPass' : p.rating.grade === 'rework' ? 'ratedRework' : 'ratedFail']++;
        if (p.rating.grade !== 'pass') { const c = causeOf(p.rating.cause) || '?'; row.causes[c] = (row.causes[c] || 0) + 1; }
      }
    }
    if (INFRA.test(s.status || '')) row.infra++;
    else if (s.status === 'SUCCESS') row.ok++;
    else if (STUCK.test(s.status || '')) row.stuck++;
    else row.failed++;
    if (typeof s.cost === 'number') { row.cost += s.cost; if (s.costKind === 'list') row.costApprox = true; }
    row._steps.push(s.steps); row._tokens.push(s.tokens); row._dur.push(s.dur);
    // pi counts cached prompt tokens apart from the fresh ones: the share is cached of all prompt tokens
    if (typeof s.in === 'number' && typeof s.cached === 'number' && s.in + s.cached > 0) row._cached.push(s.cached / (s.in + s.cached));
    for (const t of s.trace || []) if (t.k === 'call' && typeof t.ttft === 'number') row._ttft.push(t.ttft);
    if (ref) {
      row.paired++;
      if (s.status === 'SUCCESS') { row._rDur.push(ratio(s.dur, ref.dur)); row._rTok.push(ratio(s.tokens, ref.tokens)); }
      if (s.status === 'SUCCESS' && s.edit && ref.files) row._same.push(overlap(s.files, ref.files));
    }
    rows.set(key, row);
  }
  const out = [...rows.values()].map((r) => {
    const counted = r.runs - r.infra;
    return {
      model: r.model, rules: r.rules, runs: r.runs, trial: r.trial, infra: r.infra, ok: r.ok, stuck: r.stuck, failed: r.failed, paired: r.paired,
      rated: r.rated, ratedPass: r.ratedPass, ratedRework: r.ratedRework, ratedFail: r.ratedFail, notModel: r.notModel, causes: r.causes,
      okRate: counted ? r.ok / counted : null, stuckRate: counted ? r.stuck / counted : null,
      steps: median(r._steps), tokens: median(r._tokens), dur: median(r._dur), cachedShare: median(r._cached), ttft: median(r._ttft),
      cost: r.cost ? +r.cost.toFixed(4) : 0, costApprox: r.costApprox,
      durRatio: median(r._rDur), tokenRatio: median(r._rTok), sameFiles: median(r._same),
    };
  }).sort((a, b) => b.runs - a.runs);
  const trials = pairs.filter((p) => p.trial).length;
  // Where pi falls short: the newest rating of each run — its cause when it was not a pass ('?' = none given),
  // and the grades per task kind ('?' = no kind given). A rating whose cause is not the model's (NOT_MODEL)
  // is counted apart, in `notModel`, per cause.
  const causes = {}, kinds = {}, notModelBy = {};
  for (const p of pairs) {
    const g = p.rating;
    if (!g) continue;
    if (notModel(g)) { const c = causeOf(g.cause); notModelBy[c] = (notModelBy[c] || 0) + 1; continue; }
    if (g.grade !== 'pass') { const c = causeOf(g.cause) || '?'; causes[c] = (causes[c] || 0) + 1; }
    const k = kindOf(g.kind) || '?';
    const K = kinds[k] || (kinds[k] = { rated: 0, pass: 0, rework: 0, fail: 0 });
    K.rated++; K[g.grade]++;
  }
  const unrated = pairs.filter((p) => reviewable(p) && !p.rating).length;
  return { pairs, rows: out, causes, kinds, notModel: notModelBy, unrated, total: pairs.length, shadows: pairs.length - trials, trials, paired: pairs.filter((p) => p.reference).length, rated: pairs.filter((p) => p.rating).length };
}

// ── the judge: at 80% of a shadow's time limit (once the runner's own extensions are used up) a cheap
// model reads what the run has done so far and says whether more time would help. Nobody oversees a
// shadow, so without it every slow run died at the same cap and every looping one ran to it.
// Off: MULTICLAUDE_SHADOW_JUDGE=off, or `shadow.mjs judge off` (a flag file in the shadow dir).
export const judgeFlag = (env = process.env) => path.join(shadowDir(env), 'judge.off');
export const judgeOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.MULTICLAUDE_SHADOW_JUDGE || '')) && !existsSync(judgeFlag(env));
// The hard ceiling a judge can extend a shadow to (seconds); the default is 40 min.
export const judgeCeiling = (env = process.env) => { const n = +env.MULTICLAUDE_SHADOW_CEILING; return Number.isFinite(n) && n >= 300 ? Math.round(n) : 2400; };
export const JUDGE_STOP_CAUSES = ['loop', 'misread', 'knowledge', 'broke', 'unfinished', 'gave-up', 'tooling', 'infra', 'env'];
// `JUDGE EXTEND — why` / `JUDGE STOP <cause> — why` → { verdict, cause, why } | null.
export function parseJudge(text) {
  const m = /^\s*[`*]*JUDGE\s+(EXTEND|STOP)\b(?:\s+([a-z-]+))?\s*(?:[—–:-]+\s*(.*))?$/mi.exec(String(text || ''));
  if (!m) return null;
  const verdict = m[1].toUpperCase();
  const cause = verdict === 'STOP' && JUDGE_STOP_CAUSES.includes(word(m[2])) ? word(m[2]) : null;
  const why = String(m[3] || '').replace(/[`*]+$/, '').trim() || null;
  return { verdict, cause, why };
}
// Is the run moving: tool steps lately, time since the last one, the model calls' pace and failures.
// Without these a run whose model server timed out call after call read as "slow but working" (seen:
// the judge extended two such runs to the ceiling).
function judgePace(c) {
  const out = [];
  const pace = [];
  if (c.recentSteps != null) pace.push(`${c.recentSteps} tool steps in the last 5 min`);
  if (c.idle != null) pace.push(`last step ${c.idle} s ago`);
  const secs = Array.isArray(c.callSecs) ? c.callSecs.filter((x) => x != null) : [];
  if (secs.length) pace.push(`last model calls took ${secs.join(' / ')} s`);
  if (pace.length) out.push(`Pace: ${pace.join(' · ')}`);
  const me = c.modelErrors;
  if (me && me.n) out.push(`Model calls: ${me.n} failed so far, ${me.streak} in a row now${me.last ? ` — last error: ${String(me.last).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
  return out;
}
// The judge's prompt from what the runner knows of the run (dispatch.mjs builds `ctx`).
export function judgePrompt(ctx) {
  const c = ctx || {};
  const trace = Array.isArray(c.trace) ? c.trace.map(traceStep).filter(Boolean) : [];
  const tools = trace.filter((t) => t.k === 'tool');
  const errors = tools.filter((t) => t.error).length;
  const ref = c.reference ? `The real agent ${c.reference.status === 'running' ? `is still working (${c.reference.dur != null ? Math.round(c.reference.dur) + ' s so far' : 'time unknown'})` : `ended ${c.reference.status}${c.reference.dur != null ? ` after ${Math.round(c.reference.dur)} s` : ''}`}.` : 'The real agent\'s state is not known.';
  return [
    'You are the time judge for a "shadow" run: a self-hosted model (pi) repeating, unattended, a task another agent is doing for real. Its result is never used; it is recorded to learn where the model falls short. Nobody else watches it.',
    `It has used ${Math.round(c.used || 0)} s of its ${c.limit} s limit; its hard ceiling is ${c.ceiling} s. Decide whether it gets ${Math.min(600, Math.max(0, (c.ceiling || 0) - (c.limit || 0)))} s more.`,
    '',
    'EXTEND when the steps show progress toward the task, even slow: new files read or edited, a test run whose result changes, a plan being carried out, a long but purposeful search.',
    'STOP when more time will not help: the same calls or the same error again and again, work on something other than the task, it already gave up, refused or asked a question, a file / login / tool it cannot get (cause env), the model server failing (cause infra).',
    'Cause env early: the run has no ssh, no logins and no live hosts. When the task needs one (a remote host, a helper script that wraps ssh, ansible against an inventory) and the steps show the run trying it or looking into why it fails, STOP env — it will not get there with more time.',
    'Cause infra: model calls keep failing (several in a row, see "Model calls" below) and few or no tool steps happened lately. Slow model calls alone are no reason to STOP while the steps still move the task on.',
    'A stopped run is asked once, with no tools, for its final report from what it found, and recorded as a fail with your cause and reason — so say what the steps show, not a guess.',
    '',
    'Answer with exactly one line, nothing else:',
    '`JUDGE EXTEND — <why, one sentence>`',
    `\`JUDGE STOP <cause> — <why, one sentence>\`, cause one of: ${JUDGE_STOP_CAUSES.map((k) => `${k} (${CAUSES[k]})`).join('; ')}`,
    '',
    `## The task${c.edit ? ' (it may edit files)' : ' (read-only)'}`,
    head(c.task, 6000),
    '',
    '## The run so far',
    `${c.steps ?? tools.length} tool steps · ${c.calls ?? '?'} model calls · ${c.tokens ?? '?'} tokens · ${errors} tool errors in the last ${tools.length} steps`,
    ...judgePace(c),
    `Files edited: ${Array.isArray(c.touched) && c.touched.length ? c.touched.slice(-20).join(', ') : 'none'}`,
    ...(Array.isArray(c.repeats) && c.repeats.length ? [`Calls made more than once: ${c.repeats.slice(0, 8).map((r) => `${r.n}× ${String(r.call).slice(0, 120)}`).join(' · ')}`] : []),
    ref,
    '',
    '## Its newest steps (oldest first)',
    ...traceLines(trace, 60),
    ...(c.lastText ? ['', '## What it said last', head(c.lastText, 1500)] : []),
  ].join('\n');
}

// ── the tuning prompt ──
// What a pi run did, as one line per step.
export function traceLines(trace, max = 40) {
  const out = [];
  for (const t of trace || []) {
    if (t.k === 'tool') out.push(`  ${t.error ? '✗' : '⚙'} ${t.tool} ${String(t.args || '').replace(/\s+/g, ' ').slice(0, 140)}${t.error ? ' → ' + String(t.result || '').replace(/\s+/g, ' ').slice(0, 160) : ''}`);
    else if (t.k === 'call' && t.text) out.push(`  💬 ${String(t.text).replace(/\s+/g, ' ').slice(0, 200)}`);
    else if (t.k === 'cut') out.push(`  … ${t.n} steps cut`);
  }
  return out.length > max ? [...out.slice(0, max / 2), `  … ${out.length - max} lines cut`, ...out.slice(-max / 2)] : out;
}
const head = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n)}\n… [cut]` : t; };
// A pair is worth reviewing when there is something to hold the pi run against: the real agent's result, or a rating.
export const reviewable = (p) => !!(p.reference || p.rating) && !INFRA.test(p.shadow.status || '');
const VERDICT_RULES = [
  'For each pair that has no RATING line, one line in exactly this form (it is recorded): `VERDICT <pair id> <pass|rework|fail> <cause> <kind> — <why, from what is written below>`.',
  'pass = the small model\'s result could have been used as it is; rework = usable after fixes; fail = wrong, unfinished or not usable.',
  `cause = the main reason it fell short, one word: ${Object.entries(CAUSES).map(([k, v]) => `${k} (${v})`).join('; ')}. A pass is \`none\`.`,
  'Use `env` when the small model ran without something the real agent had — a file the task names that it could not find, a login, a tool, an MCP server — and `infra` only when its provider or gateway failed; neither counts against the model.',
  `kind = what the task was, one word: ${KINDS.join(' · ')} (ops = a deployment, configuration or infrastructure change).`,
  'Give no verdict for a pair that already has a RATING.',
];
// The automatic review (shadow.mjs auto) only rates: `verdictsOnly` asks for the VERDICT lines and nothing else,
// `unratedOnly` keeps out the pairs that have a rating, `maxChars` stops adding pairs before the prompt outgrows
// what agy takes on its command line.
export function reviewPrompt(records, { n = 6, rules = [], sinceMs = 0, ratings = null, unratedOnly = false, verdictsOnly = false, maxChars = 110_000, exclude = null } = {}) {
  const cand = pairUp(records, { sinceMs, ratings }).filter((p) => reviewable(p) && !(unratedOnly && p.rating) && !(exclude && exclude.has(p.pair))).slice(0, n);
  if (!cand.length) return null;
  const blocks = cand.map((p, i) => {
    const s = p.shadow, r = p.reference;
    return [
      `### Pair ${i + 1} — pair id ${p.pair}${s.label ? ` · ${s.label}` : ''}`,
      `TASK (${s.edit ? 'edit' : 'read-only'}${s.edit && !s.shell ? ', the small model had no shell' : ''}):`, head(s.prompt || (r && r.prompt), 3000), '',
      ...(!r ? ['REFERENCE — none: a task the small model was given by itself; see the RATING below.', ''] : [`REFERENCE — ${r.delegate}:${r.model} · ${r.status || 'done'} · ${r.dur ?? '?'}s · ${r.tokens ?? '?'} tokens${r.files && r.files.length ? ` · files: ${r.files.slice(0, 12).join(', ')}` : ''}`,
      head(r.answer, 2500), '']),
      `${p.trial ? 'RUN' : 'SHADOW'} — pi:${s.model} · rules ${s.rules || '?'} · ${s.status} · ${s.dur ?? '?'}s · ${s.steps ?? '?'} steps · ${s.tokens ?? '?'} tokens${s.files && s.files.length ? ` · files: ${s.files.slice(0, 12).join(', ')}` : ''}`,
      head(s.answer, 2500), '',
      `${p.trial ? 'RUN' : 'SHADOW'} STEPS:`, ...traceLines(s.trace),
      ...(p.ratings || []).map((g) => `RATING — ${g.grade}, by ${g.by}${g.gates ? ` · checked: ${head(g.gates, 500).replace(/\s+/g, ' ')}` : ''}${g.note ? ` · ${head(g.note, 800).replace(/\s+/g, ' ')}` : ''}`),
    ].join('\n');
  });
  const room = maxChars - 6000;   // the instructions
  let used = 0;
  const kept = blocks.filter((b, i) => (used += b.length + 9) <= room || i === 0).map((b) => b.slice(0, room));
  if (verdictsOnly) return [
    'You are rating the results of a small self-hosted coding model. Below are pairs: the same task done by a reference agent (its result was used) and by the small model as a shadow (its result was thrown away). Judge the small model\'s result against the task and the reference. Nothing here asks you to change files or run commands: answer from this text only.',
    '',
    ...VERDICT_RULES,
    'Answer with the VERDICT lines only, one per pair, nothing else.',
    '',
    '---', '',
    kept.join('\n\n---\n\n'),
  ].join('\n');
  return [
    'You are tuning the working rules a small self-hosted coding model gets. Below are pairs: the same task done by a reference agent (its result was used) and by the small model as a shadow (its result was thrown away). Some entries are a RUN of the small model with no reference. A RATING line is the judgement of whoever checked that result (what they ran, what they found): take it as given. Nothing here asks you to change files or run commands: answer from this text only.',
    '',
    'The working rules the shadow runs got (every pi run gets them, before the task):',
    ...(rules.length ? rules : ['(not available)']),
    '',
    'First, the verdicts:', ...VERDICT_RULES,
    'Then:',
    '1. The patterns: where the small model lost time or went wrong (wasted steps, re-reads, a missed part of the task, a report that claims what the steps do not show). Name the pairs.',
    '2. At most five changes to the working rules — a rule to add, reword or drop — each as the exact line to write, with the pairs it comes from. A rule must be general (not about one repository) and short.',
    '3. What the task prompts themselves should carry for this model (file names, the expected output, limits), if the pairs show it.',
    'Quote only what is below. If the pairs are too few or too alike to support a rule, say so instead of inventing one.',
    '',
    '---', '',
    kept.join('\n\n---\n\n'),
  ].join('\n');
}

// ── the automatic review (shadow.mjs auto, started by the hooks module while shadows are on) ──
// It rates the pairs nobody rated, on the AGY wallet, so the record gets a grade, a cause and a task kind for
// (nearly) every shadow instead of the few a person or the orchestrator found time for. Due when `min` unrated
// pairs wait and the last review is `everyMin` minutes old, or one has waited `staleH` hours. A pair the review
// was shown `maxTries` times without a verdict is left out (the reviewer keeps skipping it: rate it by hand).
export function autoReviewPlan(pairs, state = {}, now = Date.now(), { min = 6, everyMin = 60, staleH = 24, maxTries = 2, force = false } = {}) {
  const tried = state.tried || {};
  const skipped = pairs.filter((p) => reviewable(p) && !p.rating && (tried[p.pair] || 0) >= maxTries).length;
  const unrated = pairs.filter((p) => reviewable(p) && !p.rating && (tried[p.pair] || 0) < maxTries);
  const base = { unrated: unrated.length, skipped, pairs: unrated.map((p) => p.pair) };
  if (!unrated.length) return { ...base, due: false, why: 'no unrated pair with a reference' };
  if (force) return { ...base, due: true, why: 'forced' };
  const ago = state.lastAt ? (now - Date.parse(state.lastAt)) / 60_000 : Infinity;
  if (ago < everyMin) return { ...base, due: false, why: `the last review ran ${Math.round(ago)} min ago (every ${everyMin} min at most)` };
  if (unrated.length >= min) return { ...base, due: true, why: `${unrated.length} unrated pairs` };
  const oldest = Math.min(...unrated.map((p) => Date.parse(p.ts) || now));
  if (now - oldest >= staleH * 3600_000) return { ...base, due: true, why: `an unrated pair is older than ${staleH} h` };
  return { ...base, due: false, why: `${unrated.length} unrated pair${unrated.length === 1 ? '' : 's'}, waiting for ${min}` };
}
export const autoReviewFile = (env = process.env) => path.join(shadowDir(env), 'auto-review.json');
