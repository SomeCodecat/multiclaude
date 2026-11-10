#!/usr/bin/env node
// multiclaude:dispatch — the ONE way to run a delegate CLI. Shell-free (argv
// arrays, prompt on OUR stdin), model-validated against the live catalog, with a
// deterministic success check and a proof line, so a dispatch can never again
// "succeed" by printing a model picker (agy exits 0 on that) or bill the wrong
// wallet silently.
//
//   node dispatch.mjs agy   --model <id> [--effort e] [--edit] [--timeout S] [--out F] [--cd D] [--quiet]
//   node dispatch.mjs codex --model <id> [--effort e] [--sandbox M] [--timeout S] [--out F] [--cd D] [--quiet]
//
//   prompt  : stdin (heredoc / file redirect) — or `--prompt-file F`, or `-- text…`
//   --edit  : agy only — allow file edits + commands (--dangerously-skip-permissions).
//             Without it agy runs read-only-ish: headless mode auto-DENIES every
//             command except a read-only allowlist (AGY_READ_CMDS: git status/
//             log/diff…, ls, grep, sed -n …, passed via --settings), and a
//             denial ends the run: exit 3 + the denied actions so you can
//             re-dispatch.
//   --max-tokens N : agy only — stop the run cleanly (status=BUDGET) once the
//             model calls have used N tokens. Default 350k on the small AGY
//             claude pool (Claude / GPT models), none on Gemini; 0 disables.
//   --fallback ID : agy only — if the preflight finds the model's pool
//             exhausted, run on this model instead (nothing spent yet).
//   --no-preflight : skip the quota check (AGY pool via `agy /usage`, cached 60 s;
//                    Codex: a usage-limit refusal / full window in its session logs).
//   --no-preamble  : don't prepend the dispatcher header (model id, disclosure
//             rule, final-report rule; + read discipline on agy).
//   --extend ID SECONDS : add time to a running --job (also dispatch_extend);
//             the runner warns at 80% of its timeout.
//   --worktree : run in a fresh git worktree (<repo>/.claude/worktrees/mc-<job>,
//             branch mc/<job>) so parallel edit jobs never share a tree.
//   --out F : write the final answer ONLY to F; stdout gets a short preview.
//             (Token-thrift for backgrounded jobs: read the small file, never the
//             event stream.)
//   stdout  : the delegate's final report, verbatim (or the preview when --out).
//             Progress narration before the last tool step is dropped on success
//             (kept in <job>.narration.md); failed runs keep everything.
//   env     : the delegate runs with MC_MODEL_ID / MC_DELEGATE / MC_JOB_ID set.
//   config  : .env* / *.local* files in the cwd + repo root are hashed before and
//             after; any change shows as envChanged=… (they are not in git diff).
//   stderr  : live progress, one line per step (agy stream-json / codex --json),
//             then ONE proof line:  [dispatch agy model=… status=SUCCESS tokens=N … dur=Ns steps=N calls=N]
//   tokens  : the CLI's own total over the whole run. Every model call re-sends
//             the conversation so far, so it grows with the square of the calls:
//             50 tool steps on a large context costs far more than 5. The
//             breakdown (in/out/cached) follows in parentheses when known.
//             steps = tool steps the delegate ran; calls = model calls (agy).
//   exit    : 0 ok · 1 delegate failed / no answer / QUOTA / BUDGET · 2 bad usage
//             (unknown model, prompt too big) · 3 agy denied actions (needs --edit)
//             · 124 timeout. On any failure in a git tree, `git status --short`
//             of what the run left behind is appended to the answer (changed=N).
//
// Pure Node, cross-platform.
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { which, nfmt } from './lib/mc.mjs';
import { spawnable } from './lib/spawn.mjs';
import { codexCatalog, isCodexModel, resolveCodexBands, agyModels, isAgyModel, resolveAgyTiers, EFFORT_ORDER } from './lib/models.mjs';
import { agyUsage, agyPoolState, codexState } from './lib/wallets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOB_RETENTION_DAYS = 14;
const CLAUDE_POOL_DEFAULT_BUDGET = 350_000;
// Prepended to agy prompts (not codex: its harness already reads in ranges).
// Observed: two Sonnet edit jobs `cat` whole files 5 at a time, ~50 steps each,
// and drained the AGY claude pool's whole 5h window in 150 s.
const READ_RULES = [
  '- Every model call re-sends the whole conversation, so each file you read is paid for again on every later step. Read only what the task needs.',
  '- Locate first (grep -n, ls, wc -l), then read line ranges (sed -n \'a,bp\' or a ranged read_file). Never cat several files at once, or any file over ~200 lines whole.',
  '- Batch independent edits; do not re-read a file you just wrote.',
];
// agy without --edit runs headless and auto-denies every command, and the
// FIRST denial ends the run with no answer (observed: 10 of 16 failed jobs —
// `git status`, `ls -la ..`, `wc -l` — often because READ_RULES suggests
// them). These read-only commands are allowed via agy's session-only
// `--settings` permissions.allow (`command(<prefix>)`, word-matched). agy still
// denies redirects (`>`) and `&&` / `;` chains; pipes between allowed commands
// pass. Measured on agy 1.5.0.
const AGY_READ_CMDS = ['git status', 'git log', 'git show', 'git diff', 'git blame', 'git ls-files', 'git grep', 'git rev-parse',
  'ls', 'pwd', 'wc', 'head', 'tail', 'cat', 'grep', 'sed -n', 'diff', 'stat', 'file', 'sort', 'uniq', 'cut', 'jq'];
const AGY_READ_SETTINGS = JSON.stringify({ permissions: { allow: AGY_READ_CMDS.map((c) => `command(${c})`) } });
const NO_EDIT_RULES = [
  `- This run is read-only. The only shell commands allowed are: ${AGY_READ_CMDS.join(', ')} (pipes between them are fine). Anything else — another command, \`&&\` or \`;\`, a redirect (\`>\`), curl, an install, a test run, reading files outside the working directory — is denied, and a denial ENDS the run with no answer. Prefer your own file tools (read_file with line ranges, search) to commands. If the task truly needs more, say so in your final report instead of trying it.`,
];
// Prepended to every delegate prompt (both CLIs). Observed: models misreport
// their own id in trailers ("gemini-3.1-pro" for Argon, "antigravity"), and a
// delegate silently flipped a flag in .env.local to make its tests pass.
const preambleFor = (cli, model, edit) => [
  'Working rules for this run (from the dispatcher):',
  `- You are running as model \`${model}\` via the ${cli} CLI. Wherever the task asks for your model id (e.g. an \`Implemented-by:\` trailer), write exactly \`${model}\` — not a display name or product name. (Also in $MC_MODEL_ID.)`,
  '- Never edit .env* files or local config to make something pass. If config blocks you, stop and report it. Name every change outside the task\'s stated scope in your final report.',
  '- Only your LAST message is returned to the caller: end with a self-contained final report (what changed, file paths, test results, open issues). Progress chatter before it is discarded.',
  ...(cli === 'agy' ? READ_RULES : []),
  ...(cli === 'agy' && !edit ? NO_EDIT_RULES : []),
  '',
  '---',
  '',
].join('\n');

const start = Date.now();
const el = () => `[+${Math.round((Date.now() - start) / 1000)}s]`;
const JOBS_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'multiclaude', 'jobs');
// ── tracked-job files (--job): the Delegates pane and dispatch_status read these,
// whichever way the runner was launched (tool, Bash, workflow node, forwarder).
let jobFiles = null;   // { id, json, log, md }
let jobMeta = null;
function jobWrite(patch = {}) {
  if (!jobFiles) return;
  jobMeta = { ...jobMeta, ...patch, updatedAt: Date.now() };
  try { writeFileSync(jobFiles.json, JSON.stringify(jobMeta) + '\n'); } catch { /* ignore */ }
}
function jobLog(line) {
  if (!jobFiles) return;
  try { appendFileSync(jobFiles.log, line + '\n'); } catch { /* ignore */ }
}
// ── failure log: one JSON line per run that did not succeed (failures.mjs reads
// it; /multiclaude:failures summarizes it and proposes prompt fixes).
const FAILURES_LOG = path.join(path.dirname(JOBS_DIR), 'failures.jsonl');
const FAILURES_MAX_BYTES = 2 * 1024 * 1024;
function logFailure(rec) {
  try {
    mkdirSync(path.dirname(FAILURES_LOG), { recursive: true });
    try {   // keep the newest half once it outgrows the cap
      if (statSync(FAILURES_LOG).size > FAILURES_MAX_BYTES) {
        const lines = readFileSync(FAILURES_LOG, 'utf8').split('\n').filter(Boolean);
        writeFileSync(FAILURES_LOG, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
      }
    } catch { /* no log yet */ }
    appendFileSync(FAILURES_LOG, JSON.stringify(rec) + '\n');
  } catch { /* never fail a run over its log */ }
}
const err = (s) => { process.stderr.write(s + '\n'); jobLog(s); if (jobFiles && !s.startsWith('[dispatch ')) jobWrite({ step: s.replace(/^\[\+\d+s\]\s*/, '') }); };
const AGY_ARGV_CAP = 120 * 1024;   // MAX_ARG_STRLEN is 128 KiB on Linux; keep margin
// A quota / rate-limit failure is NOT a quality failure — orchestrate §5 re-routes
// on it without spending a rework hop. Tag it so the proof line says QUOTA.
// Transient provider overload — not a quota window: retry later or another model.
const CAPACITY_RE = /at capacity|overloaded|server is busy|temporarily unavailable|\b503\b|UNAVAILABLE/i;
const QUOTA_RE = /usage limit|rate.?limit|quota|RESOURCE_EXHAUSTED|\b429\b|too many requests|purchase more credits/i;

// ── args ──
const argv = process.argv.slice(2);
if (argv[0] === '--jobs-dir') { process.stdout.write(JOBS_DIR + '\n'); process.exit(0); }
if (argv[0] === '--extend') {   // --extend <job id> <seconds>: the running runner picks it up within 2 s
  const id = String(argv[1] || '').replace(/[^A-Za-z0-9_.-]+/g, '_'), sec = Math.round(+argv[2]);
  if (!id || !(sec > 0)) { process.stderr.write('usage: dispatch.mjs --extend <job id> <seconds>\n'); process.exit(2); }
  try { mkdirSync(JOBS_DIR, { recursive: true }); writeFileSync(path.join(JOBS_DIR, `${id}.extend`), String(sec)); }
  catch (e) { process.stderr.write(`dispatch: ${e.message}\n`); process.exit(1); }
  process.stdout.write(`job ${id}: +${sec}s requested\n`); process.exit(0);
}
const which_ = argv.shift();
if (!['agy', 'codex'].includes(which_)) {
  err('usage: dispatch.mjs <agy|codex> --model <id> [--effort e] [--edit] [--sandbox M] [--timeout S] [--out F] [--cd D] [--quiet] [--prompt-file F | -- prompt…]');
  process.exit(2);
}
const o = { model: null, effort: null, edit: false, sandbox: null, timeout: null, out: null, cd: null, quiet: false, promptFile: null, job: null, label: null, maxTokens: null, fallback: null, preflight: true, preamble: true, worktree: false, rest: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--job') o.job = argv[++i];   // tracked job: <id>.json progress + <id>.log transcript + <id>.md answer under the jobs dir ('auto' = generate an id)
  else if (a === '--label') o.label = argv[++i];   // short task label for the Delegates pane
  else if (a === '--jobs-dir') { process.stdout.write(JOBS_DIR + '\n'); process.exit(0); }
  else if (a === '--model') o.model = argv[++i];
  else if (a === '--effort') o.effort = argv[++i];
  else if (a === '--edit') o.edit = true;
  else if (a === '--max-tokens') o.maxTokens = +argv[++i];
  else if (a === '--fallback') o.fallback = argv[++i];
  else if (a === '--no-preflight') o.preflight = false;
  else if (a === '--no-preamble') o.preamble = false;
  else if (a === '--worktree') o.worktree = true;
  else if (a === '--sandbox') o.sandbox = argv[++i];
  else if (a === '--timeout') o.timeout = +argv[++i];
  else if (a === '--out') o.out = argv[++i];
  else if (a === '--cd') o.cd = argv[++i];
  else if (a === '--quiet' || a === '-q') o.quiet = true;
  else if (a === '--prompt-file') o.promptFile = argv[++i];
  else if (a === '--') { o.rest.push(...argv.slice(i + 1)); break; }
  else if (a.startsWith('--')) { err(`dispatch: unknown flag ${a}`); process.exit(2); }
  else o.rest.push(a);
}
if (o.effort && !EFFORT_ORDER.includes(o.effort)) { err(`dispatch: --effort must be one of ${EFFORT_ORDER.join('|')}`); process.exit(2); }
// No --model → the band the orchestrate skill calls the default for that
// delegate (codex:std / agy:gem-med), resolved from the live catalog — never the
// CLI's own config default, which is the user's interactive setting.
if (!o.model) {
  if (which_ === 'codex') {
    const b = resolveCodexBands(codexCatalog());
    if (b.ok && b.std) { o.model = b.std.model; o.effort = o.effort || b.std.effort; }
  } else {
    const t = resolveAgyTiers(agyModels());
    if (t.ok && t.gemmed) o.model = t.gemmed;
  }
  if (!o.model) { err('dispatch: --model <id> is required and no default band could be resolved (run probe.mjs)'); process.exit(2); }
  err(`dispatch: no --model given — using the default band: ${o.model}${o.effort ? ' @ ' + o.effort : ''}`);
}
if (/[\s()\/\\"']/.test(o.model)) { err(`dispatch: '${o.model}' is a display name or a whole catalog row, not a model id`); process.exit(2); }

// ── prompt ──
let prompt = '';
if (o.promptFile) prompt = readFileSync(o.promptFile, 'utf8');
else if (o.rest.length) prompt = o.rest.join(' ');
else if (!process.stdin.isTTY) prompt = readFileSync(0, 'utf8');
prompt = prompt.replace(/\r\n/g, '\n').trim();
const taskPrompt = prompt;   // as the caller wrote it, before any preamble (the failure log keeps its head)
if (!prompt) { err('dispatch: empty prompt (pipe it on stdin, or --prompt-file, or -- text)'); process.exit(2); }

let cwd = o.cd ? path.resolve(o.cd) : process.cwd();
const timeoutSec = o.timeout || (which_ === 'agy' ? 600 : 900);
const git = (args, dir = cwd) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
const runId = (o.job && o.job !== 'auto' ? String(o.job) : `j${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`).replace(/[^A-Za-z0-9_.-]+/g, '_');
let worktreePath = null;
if (o.worktree) {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) { err(`dispatch: --worktree needs a git repository at ${cwd}`); process.exit(2); }
  const root = top.stdout.trim();
  worktreePath = path.join(root, '.claude', 'worktrees', `mc-${runId}`);
  // Keep the main tree clean (§4 needs it): ignore the worktrees dir locally,
  // via .git/info/exclude, unless the project already ignores it.
  if (git(['check-ignore', '-q', '.claude/worktrees/x'], root).status !== 0) {
    const gd = git(['rev-parse', '--git-common-dir'], root);
    if (gd.status === 0) { try { appendFileSync(path.resolve(root, gd.stdout.trim(), 'info', 'exclude'), '\n/.claude/worktrees/\n'); } catch { /* ignore */ } }
  }
  const add = git(['worktree', 'add', '-b', `mc/${runId}`, worktreePath, 'HEAD'], root);
  if (add.status !== 0) { err(`dispatch: git worktree add failed: ${(add.stderr || '').trim()}`); process.exit(2); }
  cwd = path.join(worktreePath, path.relative(root, cwd));
}
// Prune job files past retention (keeps a long session auditable, bounds the dir).
function pruneJobs() {
  try {
    const cutoff = Date.now() - JOB_RETENTION_DAYS * 86400_000;
    for (const f of readdirSync(JOBS_DIR)) {
      const p = path.join(JOBS_DIR, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
if (o.job) {
  const id = runId;
  try { mkdirSync(JOBS_DIR, { recursive: true }); } catch { /* ignore */ }
  pruneJobs();
  jobFiles = { id, json: path.join(JOBS_DIR, `${id}.json`), log: path.join(JOBS_DIR, `${id}.log`), md: path.join(JOBS_DIR, `${id}.md`) };
  try { writeFileSync(jobFiles.log, ''); } catch { /* ignore */ }
  jobMeta = { id, delegate: which_, model: o.model, effort: o.effort, label: (o.label || prompt.replace(/\s+/g, ' ').slice(0, 60)).slice(0, 60), status: 'running', startedAt: start, pid: process.pid, session: process.env.MC_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null, cwd, timeout: timeoutSec, step: 'starting…', proof: '' };
  jobWrite();
  if (o.job === 'auto') process.stderr.write(`dispatch: job id ${id} (files under ${JOBS_DIR})\n`);
}
if (worktreePath) err(`dispatch: running in worktree ${worktreePath} (branch mc/${runId})`);
// What a run left in the tree, for the answer of a failed / partial run.
// Only what the run changed: lines already in `git status` at start (e.g. an
// untracked .claude/ dir) are not the delegate's doing.
const statusLines = () => { const r = git(['status', '--short']); return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null; };
const statusBefore = new Set(statusLines() || []);
function leftBehind() {
  const all = statusLines();
  if (!all) return null;
  const lines = all.filter((l) => !statusBefore.has(l));
  return { n: lines.length, text: lines.slice(0, 40).join('\n') + (lines.length > 40 ? `\n… ${lines.length - 40} more` : '') };
}
// Untracked local config a delegate could change without it showing in git
// (observed: IMAGE_UPLOADS_ENABLED flipped in .env.local to make tests pass).
const CONFIG_RE = /^\.env(\..+)?$|^\.dev\.vars$|\.local(\.[A-Za-z0-9]+)?$/;
function configSnapshot() {
  const dirs = new Set([cwd]);
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status === 0) { dirs.add(top.stdout.trim()); dirs.add(path.join(top.stdout.trim(), '.claude')); }
  const snap = new Map();
  for (const d of dirs) {
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!CONFIG_RE.test(n)) continue;
      const p = path.join(d, n);
      try { if (statSync(p).isFile()) snap.set(p, createHash('sha256').update(readFileSync(p)).digest('hex')); } catch { /* ignore */ }
    }
  }
  return snap;
}
const configBefore = configSnapshot();
function configChanges() {
  const after = configSnapshot(), out = [], rel = (p) => path.relative(cwd, p) || p;
  for (const [p, h] of configBefore) { if (!after.has(p)) out.push('-' + rel(p)); else if (after.get(p) !== h) out.push(rel(p)); }
  for (const p of after.keys()) if (!configBefore.has(p)) out.push('+' + rel(p));
  return out;
}
const proofNotes = [];   // extra key=value notes collected before finish()
// Refresh the wallet-headroom cache after a run, so the hook line reflects what
// this job spent instead of a snapshot from hours ago.
function refreshWallets() {
  try {
    spawn(process.execPath, [path.join(HERE, 'usage-snapshot.mjs'), '--refresh'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* ignore */ }
}
const tokFmt = (u) => {
  if (!u) return null;
  const parts = [];
  if (u.input_tokens != null) parts.push(`in ${nfmt(u.input_tokens)}`);
  if (u.output_tokens != null) parts.push(`out ${nfmt(u.output_tokens)}`);
  if (u.thinking_tokens) parts.push(`think ${nfmt(u.thinking_tokens)}`);
  const cached = u.cache_read_tokens ?? u.cached_input_tokens;
  if (cached != null) parts.push(`cached ${nfmt(cached)}`);
  return parts.length ? `(${parts.join('/')})` : null;
};
const progress = (s) => { if (!o.quiet) err(`${el()} ${s}`); };
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const preview = (s, n = 160) => { const t = oneLine(s); return t.length > n ? t.slice(0, n) + '…' : t; };

// Keep the dropped progress narration next to the job for auditing.
function saveNarration(full) {
  if (!jobFiles || !full) return;
  try { writeFileSync(jobFiles.md.replace(/\.md$/, '.narration.md'), full + '\n'); } catch { /* ignore */ }
}
function finish({ answer, status, tokens, dur, turns, steps, calls, usage, extra = '', code }) {
  if (code !== 0 && code !== 2) {
    const left = leftBehind();
    if (left && left.n) {
      answer = `${answer ? answer + '\n\n' : ''}— the run stopped (${status}) and left these changes in ${cwd} —\n${left.text}`;
      extra = `${extra ? extra + ' ' : ''}changed=${left.n}`;
    }
  }
  if (code !== 2) {
    const cfg = configChanges();
    if (cfg.length) {
      answer = `${answer ? answer + '\n\n' : ''}— the run changed untracked local config (NOT visible in git diff): ${cfg.join(', ')} —`;
      proofNotes.push(`envChanged=${cfg.join(',')}`);
    }
  }
  if (proofNotes.length) extra = `${extra ? extra + ' ' : ''}${proofNotes.join(' ')}`;
  if (worktreePath) extra = `${extra ? extra + ' ' : ''}worktree=${worktreePath}`;
  if (jobFiles) {
    try { writeFileSync(jobFiles.md, (answer || '') + '\n'); extra = `${extra ? extra + ' ' : ''}out=${jobFiles.md}`; }
    catch (e) { err(`dispatch: could not write job file: ${e.message}`); }
  }
  if (o.out && answer) {
    try { mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true }); writeFileSync(o.out, answer + '\n'); }
    catch (e) { err(`dispatch: could not write --out: ${e.message}`); }
    process.stdout.write(preview(answer, 400) + `\n[full answer → ${o.out}]\n`);
  } else if (answer) {
    process.stdout.write(answer.endsWith('\n') ? answer : answer + '\n');
  }
  const tb = tokFmt(usage);
  const proof = `[dispatch ${which_} model=${o.model}${o.effort ? '@' + o.effort : ''} status=${status} tokens=${tokens != null ? nfmt(tokens) : '?'}${tb ? ' ' + tb : ''} dur=${dur}s${steps != null ? ' steps=' + steps : ''}${calls != null ? ' calls=' + calls : ''}${turns != null && steps == null ? ' turns=' + turns : ''}${extra ? ' ' + extra : ''}]`;
  err(proof);
  if (code !== 0) {
    const kv = (k) => { const m = new RegExp(`\\b${k}=(?:"([^"]*)"|(\\S+))`).exec(extra || ''); return m ? (m[1] ?? m[2]) : undefined; };
    logFailure({
      ts: new Date().toISOString(), session: process.env.MC_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null,
      job: jobFiles ? jobFiles.id : null, delegate: which_, model: o.model, effort: o.effort || null, edit: !!o.edit,
      label: o.label || null, cwd, status, exitCode: code, hint: kv('hint') || kv('reroute') || null, denied: kv('denied') || null,
      error: kv('error') || null, tokens: tokens ?? null, dur: dur != null && dur !== "" ? +dur : null, promptChars: (typeof taskPrompt === 'string' ? taskPrompt.length : null),
      prompt: typeof taskPrompt === 'string' ? taskPrompt.slice(0, 2000) : null, answerTail: answer ? String(answer).slice(-800) : null,
    });
  }
  jobWrite({ status: code === 0 ? 'done' : code === 3 ? 'denied' : code === 124 ? 'timeout' : code === 2 ? 'usage' : 'failed', endedAt: Date.now(), proof, step: proof.replace(/^\[dispatch /, '').replace(/\]$/, ''), exitCode: code, tokens });
  if (code !== 2) refreshWallets();
  process.exit(code);
}

function runChild(bin, args, { stdin = null } = {}) {
  const env = { ...process.env, MC_MODEL_ID: o.model, MC_DELEGATE: which_, ...(jobFiles ? { MC_JOB_ID: jobFiles.id } : {}) };
  // A Windows npm .cmd shim (codex.cmd) can't be spawned without a shell (EINVAL): run its script with node.
  const [cmd, argv] = spawnable(bin, args);
  let child;
  try {
    child = spawn(cmd, argv, { cwd, env, stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    finish({ answer: '', status: 'FAILED', tokens: null, dur: 0, extra: `error="could not start ${path.basename(bin)}: ${String(e.code || e.message).replace(/"/g, "'")}"`, code: 1 });
  }
  if (stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  // Deadline, not a one-shot timer: warn at 80% and accept extensions
  // (`dispatch.mjs --extend <id> <s>` / dispatch_extend write <id>.extend).
  const t0 = Date.now();
  let limit = timeoutSec, warned = false, timedOut = false;
  const extFile = jobFiles ? path.join(JOBS_DIR, `${jobFiles.id}.extend`) : null;
  const t = setInterval(() => {
    if (extFile) {
      try {
        const add = Math.round(+readFileSync(extFile, 'utf8'));
        unlinkSync(extFile);
        if (add > 0) { limit += add; warned = false; jobWrite({ timeout: limit }); progress(`⏱ timeout extended by ${add}s — now ${limit}s`); }
      } catch { /* no request */ }
    }
    const used = (Date.now() - t0) / 1000;
    if (!warned && used >= limit * 0.8) {
      warned = true;
      progress(`⏱ 80% of the ${limit}s timeout used — extend with dispatch_extend({ id: "${jobFiles ? jobFiles.id : '?'}", seconds: N }) or dispatch.mjs --extend <id> <s>`);
    }
    if (used >= limit) {
      timedOut = true;
      clearInterval(t);
      progress(`✗ timeout after ${limit}s — killing ${which_}`);
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000).unref();
    }
  }, 2000);
  child.on('close', () => clearInterval(t));
  return { child, isTimedOut: () => timedOut };
}
// Other live runner jobs on the same pool (any launch path) — parallel agentic
// runs drain a pool fast (3 Argon jobs: the weekly bucket in ~45 min).
function liveOnPool(pool, poolOf) {
  const out = [];
  try {
    for (const f of readdirSync(JOBS_DIR)) {
      if (!f.endsWith('.json') || (jobFiles && f === `${jobFiles.id}.json`)) continue;
      try {
        const m = JSON.parse(readFileSync(path.join(JOBS_DIR, f), 'utf8'));
        if (m.status !== 'running' || !m.updatedAt || Date.now() - m.updatedAt > 15 * 60_000) continue;
        const p = m.delegate === 'codex' ? 'codex' : poolOf(String(m.model || ''));
        if (p === pool) out.push(m.id);
      } catch { /* partial write */ }
    }
  } catch { /* no jobs dir */ }
  return out;
}

// The delegate's final report: agy's `response` (and codex's message list) is
// every narration message joined — 10–50 "Waiting for X…" lines before the
// report on long runs. Keep what came after the last tool step; if that is a
// stub, keep everything minus progress-only lines.
const PROGRESS_LINE = /^(?:waiting\b|running\b|launching\b|now\b|next\b|let me\b|i (?:have|am|will|'ll|'m)\b.*\b(?:launch|start|wait|run|check|inspect|continue|proceed|read|look)\w*\b)/i;
function trimNarration(full) {
  return full.split('\n').filter((l) => !(l.trim().length < 300 && PROGRESS_LINE.test(l.trim()))).join('\n').replace(/\n{3,}/g, '\n\n').trim() || full;
}
function finalReport(full, segs, lastToolIdx) {
  if (lastToolIdx < 0 || !segs.length) return full;
  const tail = segs.filter(([i]) => i > lastToolIdx).map(([, t]) => t).join('').trim();
  if (tail.length >= 200) return tail;
  return trimNarration(full);
}

// ═══════════════════════════════════════════════════════════ AGY ══
if (which_ === 'agy') {
  const bin = which('agy');
  if (!bin) { err('dispatch: `agy` CLI not found on PATH (run /multiclaude:setup)'); process.exit(127); }
  const rows = agyModels();
  const known = isAgyModel(rows, o.model);
  if (known === false) {
    err(`dispatch: unknown agy model '${o.model}'. Known ids:\n  ${rows.map((r) => r.id).join('\n  ')}`);
    process.exit(2);
  }
  if (known === null) progress('! could not read `agy models` — skipping model validation');
  if (o.fallback && isAgyModel(rows, o.fallback) === false) { err(`dispatch: unknown --fallback model '${o.fallback}'`); process.exit(2); }

  // ── preflight: is the model's pool already spent? (nothing has been paid yet)
  const poolOf = (id) => (/argon/i.test(id) ? 'argon' : /^(claude|gpt)/i.test(id) ? 'claude' : 'gemini');
  function poolCheck(id) {
    const cf = path.join(path.dirname(JOBS_DIR), 'agy-usage.json');
    let u = null;
    try { if (Date.now() - statSync(cf).mtimeMs < 60_000) u = JSON.parse(readFileSync(cf, 'utf8')); } catch { /* cold */ }
    if (!u) { u = agyUsage({ timeout: 20000 }); try { writeFileSync(cf, JSON.stringify(u)); } catch { /* ignore */ } }
    if (!u || !u.proactive || !u.pools) return null;
    const pool = poolOf(id);
    return { pool, ...agyPoolState(u.pools[pool]) };
  }
  if (o.preflight) {
    let pc = poolCheck(o.model);
    if (pc && pc.exhausted && o.fallback) {
      progress(`↪ ${pc.pool} pool exhausted (${Math.round(pc.pct)}% used) — falling back to ${o.fallback}`);
      proofNotes.push(`fallback-from=${o.model}`);
      o.model = o.fallback;
      jobWrite({ model: o.model });
      pc = poolCheck(o.model);
    }
    if (pc && pc.exhausted) {
      const rs = pc.resetSec != null ? ` resets in ${Math.round(pc.resetSec / 60)}m` : '';
      err(`dispatch: AGY ${pc.pool} pool is exhausted (${Math.round(pc.pct)}% used${rs}) — not starting. Re-route per orchestrate §5, or pass --fallback <id>.`);
      finish({ answer: '', status: 'QUOTA', tokens: 0, dur: '0.0', extra: `preflight pool=${pc.pool} reroute=§5`, code: 1 });
    }
    if (pc && pc.pct != null && pc.pct >= 90) progress(`! ${pc.pool} pool is ${Math.round(pc.pct)}% used — a long run may hit QUOTA`);
  }
  {
    const pool = poolOf(o.model), others = liveOnPool(pool, poolOf);
    if (others.length) { progress(`! ${others.length} other live job(s) on the AGY ${pool} pool (${others.join(', ')}) — they share one quota window`); proofNotes.push(`shared-pool=${pool}:${others.length}`); }
  }
  const budget = o.maxTokens != null ? o.maxTokens : (poolOf(o.model) === 'claude' ? CLAUDE_POOL_DEFAULT_BUDGET : 0);
  const task = prompt;
  if (o.preamble) prompt = preambleFor('agy', o.model, o.edit) + prompt;
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > AGY_ARGV_CAP) {
    err(`dispatch: prompt is ${Math.round(bytes / 1024)} KB — agy takes the prompt as ONE argv value (cap ~128 KB). Chunk it into several agy calls, or route this synthesis to codex (stdin, no cap).`);
    process.exit(2);
  }
  // agy ≥1.1 has no stdin prompt: the prompt must be --print's VALUE (one argv
  // element — no shell parses it here). --output-format stream-json gives live
  // step events plus the final `result` envelope with status/usage.
  const args = [`--print=${prompt}`, '--model', o.model, '--output-format', 'stream-json'];
  if (o.effort) args.push('--effort', o.effort);
  if (o.edit) args.push('--dangerously-skip-permissions');
  else args.push('--settings', AGY_READ_SETTINGS);
  progress(`▸ agy ${o.model}${o.effort ? ' @ ' + o.effort : ''}${o.edit ? ' · edit' : ' · no-edit'} · ${Math.round(bytes / 1024)} KB prompt${budget ? ` · budget ${nfmt(budget)} tok` : ''} · "${preview(task, 70)}"`);

  const { child, isTimedOut } = runChild(bin, args);
  let result = null, text = '', narr = '', lastStep = -1, lastToolIdx = -1;
  const segs = [];   // [step_index, text] of every agent_response delta
  let steps = 0, calls = 0, spent = 0, overBudget = false, quotaSeen = false;
  const stopChild = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000).unref();
  };
  const stderrLines = [];
  readline.createInterface({ input: child.stderr }).on('line', (l) => {
    if (!l.trim()) return;
    stderrLines.push(l);
    if (!o.quiet) err(`${el()} ⚠ ${preview(l, 200)}`);
    // A 429 mid-run: stop at once instead of letting the CLI wind down.
    if (!quotaSeen && /RESOURCE_EXHAUSTED|Individual quota reached/i.test(l)) { quotaSeen = true; setTimeout(stopChild, 3000).unref(); }
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    line = line.trim(); if (!line.startsWith('{')) { if (line) stderrLines.push(line); return; }
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.event === 'result') { result = ev.result; return; }
    if (ev.event !== 'step_update' || !ev.step_update) return;
    const s = ev.step_update;
    if (s.state === 'DONE' && s.usage && typeof s.usage.total_tokens === 'number') {
      calls++;
      spent += s.usage.total_tokens;
      if (budget && !overBudget && spent > budget) {
        overBudget = true;
        progress(`✗ budget: ${nfmt(spent)} tokens > ${nfmt(budget)} after ${calls} calls — stopping the run`);
        stopChild();
      }
    }
    if (s.step_type === 'agent_response') {
      // Narration: agy explains what it is doing between tool steps. Surface each
      // finished response step (the final answer is one too) as a 💬 line.
      if (s.text_delta) { text += s.text_delta; narr += s.text_delta; segs.push([s.step_index, s.text_delta]); }
      if (s.state === 'DONE' && narr.trim()) { progress(`💬 ${preview(narr, 200)}`); narr = ''; }
      return;
    }
    if (s.step_type === 'user_input') return;
    if (s.step_type === 'tool') {
      if (typeof s.step_index === 'number' && s.step_index > lastToolIdx) lastToolIdx = s.step_index;
      const name = s.tool_name || (s.tool_info && s.tool_info.name) || 'tool';
      const params = (s.tool_info && s.tool_info.parameters) || {};
      const arg = params.CommandLine || params.AbsolutePath || params.TargetFile || params.Query || params.SearchPath || params.Url || '';
      if (s.state === 'ACTIVE' && s.step_index !== lastStep) { lastStep = s.step_index; steps++; progress(`⚙ ${name}${arg ? ' ' + preview(arg, 100) : ''}`); }
      else if (s.state === 'ERROR') progress(`✗ ${name}: ${preview((s.tool_info && s.tool_info.error && s.tool_info.error.message) || 'error', 160)}`);
      return;
    }
    if (s.state === 'ACTIVE' && s.step_index !== lastStep) { lastStep = s.step_index; progress(`· ${s.step_type}`); }
  });
  child.on('error', (e) => { err(`dispatch: failed to launch agy: ${e.message}`); process.exit(127); });
  child.on('close', (code) => {
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    const sc = { steps, calls };
    if (isTimedOut()) finish({ answer: text.trim(), status: 'TIMEOUT', tokens: spent || null, dur, ...sc, code: 124 });
    if (overBudget) finish({ answer: text.trim(), status: 'BUDGET', tokens: (result && result.usage && result.usage.total_tokens) || spent, usage: result && result.usage, dur, ...sc, extra: `budget=${nfmt(budget)} hint=narrow-the-task-or-raise-max-tokens`, code: 1 });
    if (!result) {
      const tail = stderrLines.slice(-5).join('\n');
      const quota = quotaSeen || QUOTA_RE.test(tail);
      err(`dispatch: agy produced no result envelope (exit ${code})${tail ? ':\n' + tail : ''}`);
      finish({ answer: text.trim(), status: quota ? 'QUOTA' : 'NO_RESULT', tokens: spent || null, dur, ...sc, extra: quota ? 'reroute=§5' : '', code: 1 });
    }
    const full = (result.response && result.response.trim()) || text.trim();
    const answer = finalReport(full, segs, lastToolIdx);
    if (answer !== full) saveNarration(full);
    const tokens = result.usage ? result.usage.total_tokens : null;
    const usage = result.usage;
    const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
    const fr = result.finished_reason || '';
    if (result.status !== 'SUCCESS' || fr === 'error') {
      const blob = [answer, result.error, ...stderrLines].filter(Boolean).map(String).join('\n');
      const quota = QUOTA_RE.test(blob), busy = !quota && CAPACITY_RE.test(blob);
      finish({ answer, status: quota ? 'QUOTA' : busy ? 'CAPACITY' : result.status + (fr ? '/' + fr : ''), tokens, dur, ...sc, usage, extra: quota ? 'reroute=§5' : busy ? 'hint=other-model-or-retry' : '', code: 1 });
    }
    if (fr) {   // print_timeout / interrupted — partial output
      finish({ answer, status: `PARTIAL/${fr}`, tokens, dur, ...sc, usage, code: 1 });
    }
    if (denied.length) {
      const what = denied.map((d) => d.display_name || d.action).join(',');
      err(`dispatch: agy was DENIED ${denied.length} action(s) [${what}] — headless mode cannot prompt. Re-dispatch with --edit if the task needs commands/edits.`);
      finish({ answer, status: 'DENIED', tokens, dur, ...sc, usage, extra: `denied=${what}`, code: 3 });
    }
    if (!answer) finish({ answer: '', status: 'EMPTY', tokens, dur, ...sc, usage, code: 1 });
    finish({ answer, status: 'SUCCESS', tokens, dur, ...sc, usage, code: 0 });
  });
}

// ═════════════════════════════════════════════════════════ CODEX ══
if (which_ === 'codex') {
  const bin = which('codex');
  if (!bin) { err('dispatch: `codex` CLI not found on PATH (run /multiclaude:setup)'); process.exit(127); }
  const cat = codexCatalog();
  if (cat.ok && !isCodexModel(cat, o.model)) {
    err(`dispatch: unknown codex model '${o.model}'. Catalog: ${cat.models.filter((m) => m.visible).map((m) => m.slug).join(', ')}`);
    process.exit(2);
  }
  if (!cat.ok) progress('! no Codex catalog yet — skipping model validation');
  const sandbox = o.sandbox || 'workspace-write';
  // ── preflight: is the Codex plan already shut? A refused run fails in ~2 s with
  // "You've hit your usage limit … try again at …", and the CLI logs it to its
  // session files (lib/wallets.mjs codexUsage → blocked). Refuse here instead.
  if (o.preflight) {
    let cs = null; try { cs = codexState(); } catch { /* no data: let the run decide */ }
    if (cs && cs.out) {
      const when = cs.until ? ` until ${new Date(cs.until).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '';
      err(`dispatch: Codex is out of quota (${cs.why}${when}) — not starting. Re-route per orchestrate §5 (AGY), or retry after the reset.`);
      finish({ answer: '', status: 'QUOTA', tokens: 0, dur: '0.0', extra: `preflight pool=codex${cs.until ? ` until=${new Date(cs.until).toISOString()}` : ''} reroute=§5`, code: 1 });
    }
  }
  {
    const others = liveOnPool('codex', () => 'codex');
    if (others.length) { progress(`! ${others.length} other live Codex job(s) (${others.join(', ')}) — they share one quota window`); proofNotes.push(`shared-pool=codex:${others.length}`); }
  }
  const task = prompt;
  if (o.preamble) prompt = preambleFor('codex', o.model, true) + prompt;
  // Prompt rides stdin (`-`), so there is no argv cap and no shell quoting.
  const args = ['exec', '--json', '-m', o.model, '--sandbox', sandbox, '--skip-git-repo-check', '-C', cwd];
  if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
  args.push('-');
  progress(`▸ codex ${o.model}${o.effort ? ' @ ' + o.effort : ''} · ${sandbox} · "${preview(task, 70)}"`);

  const { child, isTimedOut } = runChild(bin, args, { stdin: prompt });
  const answers = [];
  let usage = null, failed = null, steps = 0;
  const stderrLines = [];
  readline.createInterface({ input: child.stderr }).on('line', (l) => {
    if (/Reading additional input from stdin/.test(l)) return;
    if (l.trim()) { stderrLines.push(l); if (!o.quiet) err(`${el()} ⚠ ${preview(l, 200)}`); }
  });
  const describe = (it) => {
    if (!it || typeof it !== 'object') return null;
    switch (it.type) {
      case 'agent_message': return null;
      case 'reasoning': return `▸ ${preview(it.text || it.summary || 'thinking…', 120)}`;
      case 'command_execution': return `$ ${preview(it.command || it.cmd || '', 120)}${it.exit_code != null ? `  (exit ${it.exit_code})` : ''}`;
      case 'file_change': case 'patch': { const l = (it.changes || it.files || []).map((c) => c.path || c.file || c).filter(Boolean); return `± ${l.length ? l.join(', ') : 'files changed'}`; }
      case 'mcp_tool_call': return `⚙ ${[it.server, it.tool || it.name].filter(Boolean).join('.') || 'tool call'}`;
      case 'web_search': return `⌕ web: ${preview(it.query || '', 80)}`;
      case 'todo_list': return null;
      default: return `· ${it.type}`;
    }
  };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    line = line.trim(); if (!line.startsWith('{')) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    switch (ev.type) {
      case 'turn.completed': if (ev.usage) usage = ev.usage; return;
      case 'turn.failed': failed = ev.error || ev; progress(`✗ turn failed: ${preview(JSON.stringify(ev.error || ev), 200)}`); return;
      case 'error': failed = ev; progress(`✗ error: ${preview(ev.message || JSON.stringify(ev), 200)}`); return;
      case 'item.completed': {
        const it = ev.item;
        if (it && it.type === 'agent_message' && typeof it.text === 'string') answers.push(it.text);
        else { const d = describe(it); if (d) { progress(d); if (it && /^(command_execution|file_change|patch|mcp_tool_call|web_search)$/.test(it.type)) steps++; } }
        return;
      }
      default: return;
    }
  });
  child.on('error', (e) => { err(`dispatch: failed to launch codex: ${e.message}`); process.exit(127); });
  child.on('close', (code) => {
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    const answer = answers.join('\n\n').trim();
    const u = usage || {};
    const tokens = u.total_tokens != null ? u.total_tokens : (u.input_tokens != null || u.output_tokens != null ? (u.input_tokens || 0) + (u.output_tokens || 0) : null);
    const common = { tokens, dur, steps, usage };
    // Known failure classes get their own status so the orchestrator can act:
    // QUOTA → re-route (§5); TOO_COMPLEX → split the task; others carry the
    // CLI's own last error line instead of a bare exit code.
    const classify = (msg) => QUOTA_RE.test(msg) ? { status: 'QUOTA', hint: 'reroute=§5' }
      : CAPACITY_RE.test(msg) ? { status: 'CAPACITY', hint: 'hint=other-model-or-retry' }
      : /complexity limit/i.test(msg) ? { status: 'TOO_COMPLEX', hint: 'hint=split-the-task' }
      : /failed to find expected lines|apply_patch|patch (?:failed|rejected)/i.test(msg) ? { status: 'PATCH_FAILED', hint: 'hint=re-read-then-retry' }
      : null;
    if (isTimedOut()) finish({ answer, status: 'TIMEOUT', ...common, code: 124 });
    if (failed) {
      const msg = preview((failed && (failed.message || failed.error && failed.error.message)) || JSON.stringify(failed), 300);
      const c = classify(msg);
      finish({ answer, status: c ? c.status : 'FAILED', ...common, extra: `${c ? c.hint + ' ' : ''}error="${msg.replace(/"/g, "'")}"`, code: 1 });
    }
    const lastErr = preview(stderrLines.filter((l) => /error|fail|limit|denied|EPERM/i.test(l)).slice(-1)[0] || stderrLines.slice(-1)[0] || '', 240);
    if (!answer) {
      const tail = stderrLines.slice(-5).join('\n');
      err(`dispatch: codex produced no agent message (exit ${code})${tail ? ':\n' + tail : ''}`);
      const c = classify(tail);
      finish({ answer: '', status: c ? c.status : 'EMPTY', ...common, extra: `${c ? c.hint + ' ' : ''}${lastErr ? `error="${lastErr.replace(/"/g, "'")}"` : ''}`.trim(), code: 1 });
    }
    if (code === 0 || code == null) {
      const last = answers.length > 1 ? answers[answers.length - 1].trim() : '';
      const report = last.length >= 200 ? last : answers.length > 1 ? trimNarration(answer) : answer;
      if (report !== answer) saveNarration(answer);
      finish({ answer: report, status: 'SUCCESS', ...common, code: 0 });
    }
    const c = classify(stderrLines.slice(-20).join('\n') + '\n' + answer.slice(-2000));
    finish({ answer, status: c ? c.status : `EXIT_${code}`, ...common, extra: `${c ? c.hint + ' ' : ''}${lastErr ? `error="${lastErr.replace(/"/g, "'")}"` : ''}`.trim(), code: 1 });
  });
}
