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
//             tool that needs a permission prompt (commands), and the run is
//             reported with exit 3 + the denied actions so you can re-dispatch.
//   --out F : write the final answer ONLY to F; stdout gets a short preview.
//             (Token-thrift for backgrounded jobs: read the small file, never the
//             event stream.)
//   stdout  : the delegate's final answer, verbatim (or the preview when --out)
//   stderr  : live progress, one line per step (agy stream-json / codex --json),
//             then ONE proof line:  [dispatch agy model=… status=SUCCESS tokens=N dur=Ns]
//   exit    : 0 ok · 1 delegate failed / no answer · 2 bad usage (unknown model,
//             prompt too big) · 3 agy denied actions (needs --edit) · 124 timeout
//
// Pure Node, cross-platform.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { which, nfmt } from './lib/mc.mjs';
import { codexCatalog, isCodexModel, resolveCodexBands, agyModels, isAgyModel, resolveAgyTiers, EFFORT_ORDER } from './lib/models.mjs';

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
const err = (s) => { process.stderr.write(s + '\n'); jobLog(s); if (jobFiles && !s.startsWith('[dispatch ')) jobWrite({ step: s.replace(/^\[\+\d+s\]\s*/, '') }); };
const AGY_ARGV_CAP = 120 * 1024;   // MAX_ARG_STRLEN is 128 KiB on Linux; keep margin
// A quota / rate-limit failure is NOT a quality failure — orchestrate §5 re-routes
// on it without spending a rework hop. Tag it so the proof line says QUOTA.
const QUOTA_RE = /usage limit|rate.?limit|quota|RESOURCE_EXHAUSTED|\b429\b|too many requests|purchase more credits/i;

// ── args ──
const argv = process.argv.slice(2);
if (argv[0] === '--jobs-dir') { process.stdout.write(JOBS_DIR + '\n'); process.exit(0); }
const which_ = argv.shift();
if (!['agy', 'codex'].includes(which_)) {
  err('usage: dispatch.mjs <agy|codex> --model <id> [--effort e] [--edit] [--sandbox M] [--timeout S] [--out F] [--cd D] [--quiet] [--prompt-file F | -- prompt…]');
  process.exit(2);
}
const o = { model: null, effort: null, edit: false, sandbox: null, timeout: null, out: null, cd: null, quiet: false, promptFile: null, job: null, label: null, rest: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--job') o.job = argv[++i];   // tracked job: <id>.json progress + <id>.log transcript + <id>.md answer under the jobs dir ('auto' = generate an id)
  else if (a === '--label') o.label = argv[++i];   // short task label for the Delegates pane
  else if (a === '--jobs-dir') { process.stdout.write(JOBS_DIR + '\n'); process.exit(0); }
  else if (a === '--model') o.model = argv[++i];
  else if (a === '--effort') o.effort = argv[++i];
  else if (a === '--edit') o.edit = true;
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
if (!prompt) { err('dispatch: empty prompt (pipe it on stdin, or --prompt-file, or -- text)'); process.exit(2); }

const cwd = o.cd ? path.resolve(o.cd) : process.cwd();
const timeoutSec = o.timeout || (which_ === 'agy' ? 600 : 900);
if (o.job) {
  const id = (o.job === 'auto' ? `j${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}` : String(o.job)).replace(/[^A-Za-z0-9_.-]+/g, '_');
  try { mkdirSync(JOBS_DIR, { recursive: true }); } catch { /* ignore */ }
  jobFiles = { id, json: path.join(JOBS_DIR, `${id}.json`), log: path.join(JOBS_DIR, `${id}.log`), md: path.join(JOBS_DIR, `${id}.md`) };
  try { writeFileSync(jobFiles.log, ''); } catch { /* ignore */ }
  jobMeta = { id, delegate: which_, model: o.model, effort: o.effort, label: (o.label || prompt.replace(/\s+/g, ' ').slice(0, 60)).slice(0, 60), status: 'running', startedAt: start, pid: process.pid, cwd, step: 'starting…', proof: '' };
  jobWrite();
  if (o.job === 'auto') process.stderr.write(`dispatch: job id ${id} (files under ${JOBS_DIR})\n`);
}
const progress = (s) => { if (!o.quiet) err(`${el()} ${s}`); };
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const preview = (s, n = 160) => { const t = oneLine(s); return t.length > n ? t.slice(0, n) + '…' : t; };

function finish({ answer, status, tokens, dur, turns, extra = '', code }) {
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
  const proof = `[dispatch ${which_} model=${o.model}${o.effort ? '@' + o.effort : ''} status=${status} tokens=${tokens != null ? nfmt(tokens) : '?'} dur=${dur}s${turns != null ? ' turns=' + turns : ''}${extra ? ' ' + extra : ''}]`;
  err(proof);
  jobWrite({ status: code === 0 ? 'done' : code === 3 ? 'denied' : code === 124 ? 'timeout' : code === 2 ? 'usage' : 'failed', endedAt: Date.now(), proof, step: proof.replace(/^\[dispatch /, '').replace(/\]$/, ''), exitCode: code, tokens });
  process.exit(code);
}

function runChild(bin, args, { stdin = null } = {}) {
  const child = spawn(bin, args, { cwd, stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
  if (stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    progress(`✗ timeout after ${timeoutSec}s — killing ${which_}`);
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000).unref();
  }, timeoutSec * 1000);
  child.on('close', () => clearTimeout(t));
  return { child, isTimedOut: () => timedOut };
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
  progress(`▸ agy ${o.model}${o.effort ? ' @ ' + o.effort : ''}${o.edit ? ' · edit' : ' · no-edit'} · ${Math.round(bytes / 1024)} KB prompt · "${preview(prompt, 70)}"`);

  const { child, isTimedOut } = runChild(bin, args);
  let result = null, text = '', narr = '', lastStep = -1;
  const stderrLines = [];
  readline.createInterface({ input: child.stderr }).on('line', (l) => { if (l.trim()) { stderrLines.push(l); if (!o.quiet) err(`${el()} ⚠ ${preview(l, 200)}`); } });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    line = line.trim(); if (!line.startsWith('{')) { if (line) stderrLines.push(line); return; }
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.event === 'result') { result = ev.result; return; }
    if (ev.event !== 'step_update' || !ev.step_update) return;
    const s = ev.step_update;
    if (s.step_type === 'agent_response') {
      // Narration: agy explains what it is doing between tool steps. Surface each
      // finished response step (the final answer is one too) as a 💬 line.
      if (s.text_delta) { text += s.text_delta; narr += s.text_delta; }
      if (s.state === 'DONE' && narr.trim()) { progress(`💬 ${preview(narr, 200)}`); narr = ''; }
      return;
    }
    if (s.step_type === 'user_input') return;
    if (s.step_type === 'tool') {
      const name = s.tool_name || (s.tool_info && s.tool_info.name) || 'tool';
      const params = (s.tool_info && s.tool_info.parameters) || {};
      const arg = params.CommandLine || params.AbsolutePath || params.TargetFile || params.Query || params.SearchPath || params.Url || '';
      if (s.state === 'ACTIVE' && s.step_index !== lastStep) { lastStep = s.step_index; progress(`⚙ ${name}${arg ? ' ' + preview(arg, 100) : ''}`); }
      else if (s.state === 'ERROR') progress(`✗ ${name}: ${preview((s.tool_info && s.tool_info.error && s.tool_info.error.message) || 'error', 160)}`);
      return;
    }
    if (s.state === 'ACTIVE' && s.step_index !== lastStep) { lastStep = s.step_index; progress(`· ${s.step_type}`); }
  });
  child.on('error', (e) => { err(`dispatch: failed to launch agy: ${e.message}`); process.exit(127); });
  child.on('close', (code) => {
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    if (isTimedOut()) finish({ answer: text.trim(), status: 'TIMEOUT', tokens: null, dur, code: 124 });
    if (!result) {
      const tail = stderrLines.slice(-5).join('\n');
      err(`dispatch: agy produced no result envelope (exit ${code})${tail ? ':\n' + tail : ''}`);
      finish({ answer: text.trim(), status: 'NO_RESULT', tokens: null, dur, code: 1 });
    }
    const answer = (result.response && result.response.trim()) || text.trim();
    const tokens = result.usage ? result.usage.total_tokens : null;
    const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
    const fr = result.finished_reason || '';
    if (result.status !== 'SUCCESS' || fr === 'error') {
      const blob = [answer, result.error, ...stderrLines].filter(Boolean).map(String).join('\n');
      const quota = QUOTA_RE.test(blob);
      finish({ answer, status: quota ? 'QUOTA' : result.status + (fr ? '/' + fr : ''), tokens, dur, turns: result.num_turns, extra: quota ? 'reroute=§5' : '', code: 1 });
    }
    if (fr) {   // print_timeout / interrupted — partial output
      finish({ answer, status: `PARTIAL/${fr}`, tokens, dur, turns: result.num_turns, code: 1 });
    }
    if (denied.length) {
      const what = denied.map((d) => d.display_name || d.action).join(',');
      err(`dispatch: agy was DENIED ${denied.length} action(s) [${what}] — headless mode cannot prompt. Re-dispatch with --edit if the task needs commands/edits.`);
      finish({ answer, status: 'DENIED', tokens, dur, turns: result.num_turns, extra: `denied=${what}`, code: 3 });
    }
    if (!answer) finish({ answer: '', status: 'EMPTY', tokens, dur, turns: result.num_turns, code: 1 });
    finish({ answer, status: 'SUCCESS', tokens, dur, turns: result.num_turns, code: 0 });
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
  // Prompt rides stdin (`-`), so there is no argv cap and no shell quoting.
  const args = ['exec', '--json', '-m', o.model, '--sandbox', sandbox, '--skip-git-repo-check', '-C', cwd];
  if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
  args.push('-');
  progress(`▸ codex ${o.model}${o.effort ? ' @ ' + o.effort : ''} · ${sandbox} · "${preview(prompt, 70)}"`);

  const { child, isTimedOut } = runChild(bin, args, { stdin: prompt });
  const answers = [];
  let usage = null, failed = null;
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
        else { const d = describe(it); if (d) progress(d); }
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
    if (isTimedOut()) finish({ answer, status: 'TIMEOUT', tokens, dur, code: 124 });
    if (failed) {
      const msg = preview((failed && (failed.message || failed.error && failed.error.message)) || JSON.stringify(failed), 300);
      const quota = QUOTA_RE.test(msg);
      finish({ answer, status: quota ? 'QUOTA' : 'FAILED', tokens, dur, extra: `${quota ? 'reroute=§5 ' : ''}error="${msg}"`, code: 1 });
    }
    if (!answer) {
      const tail = stderrLines.slice(-5).join('\n');
      err(`dispatch: codex produced no agent message (exit ${code})${tail ? ':\n' + tail : ''}`);
      finish({ answer: '', status: 'EMPTY', tokens, dur, code: 1 });
    }
    finish({ answer, status: code === 0 || code == null ? 'SUCCESS' : `EXIT_${code}`, tokens, dur, code: code === 0 || code == null ? 0 : 1 });
  });
}
