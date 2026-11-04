#!/usr/bin/env node
// multiclaude failure log reader — /multiclaude:failures.
//
// dispatch.mjs appends one JSON line per run that did not succeed to
// <cache>/multiclaude/failures.jsonl (status, model, denied actions, error,
// the head of the task prompt). This script summarizes it: counts by status and
// model, a fixed "why + what to change in the prompt" per status, the most
// recent failures. `--review-prompt` prints a prompt for an AGY review of the
// log against the orchestrate prompt rules (the hooks module dispatches it).
//
//   failures.mjs [N] [--since 7d|24h|all] [--session <id>] [--json] [--review-prompt]
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'multiclaude', 'failures.jsonl');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Why a status happens and what to change in the next prompt / dispatch.
// Keyed by the status's first word (agy statuses can read ERROR/error etc.).
const ADVICE = {
  DENIED: ['agy ran headless without edit and every command was auto-denied.',
    'If the task needs commands or edits, dispatch with edit: true. If it is meant to be read-only, paste the file contents into the prompt and say "do not run commands".'],
  QUOTA: ['The wallet was out of quota. This is routing, not the prompt.',
    'Re-route per orchestrate §5 (other pool / delegate); check /wallets before re-dispatching to the same pool.'],
  TOO_COMPLEX: ['Codex hit its complexity limit: the task was too big for one run.',
    'Split it into independently verifiable steps (one file / one concern each) and dispatch them separately.'],
  PATCH_FAILED: ['The patch did not match the file: the prompt\'s excerpt was stale or paraphrased.',
    'Paste current file content verbatim (or tell it to re-read the file first), and avoid parallel edits to the same file (§4).'],
  BUDGET: ['The agy run hit its token budget, usually from open-ended exploration.',
    'Name the exact files / functions to read, state the expected output, or raise maxTokens for a genuinely large task.'],
  TIMEOUT: ['The run outlived its timeout.',
    'Narrow the task, or raise timeout / use dispatch_extend when the transcript shows steady progress.'],
  PARTIAL: ['agy stopped early (print timeout / interrupted) with partial output.',
    'Narrow the task or raise timeout; ask for the final report first and details after.'],
  EMPTY: ['The delegate finished without a final answer.',
    'End the prompt with an explicit deliverable ("finish with a report listing …"); keep the anti-fabrication clause.'],
  FAILED: ['The CLI failed: see the error text.',
    'Usually environment (auth, CLI version, bad flag). Run /multiclaude:probe --smoke; change the prompt only if the error names it.'],
  ERROR: ['The delegate returned an error status.', 'See the error text; run /multiclaude:probe --smoke if it repeats.'],
};
const adviceFor = (status) => ADVICE[String(status || '').split(/[/\s]/)[0].toUpperCase()] || ADVICE.FAILED;

// ── args ──
const argv = process.argv.slice(2);
let limit = 10, since = '7d', session = null, json = false, review = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--since') since = argv[++i] || since;
  else if (a === '--session') session = argv[++i] || null;
  else if (a === '--json') json = true;
  else if (a === '--review-prompt' || a === 'review') review = true;
  else if (/^\d+$/.test(a)) limit = +a;
  else { process.stderr.write(`failures: unknown argument ${a}\nusage: failures.mjs [N] [--since 7d|24h|all] [--session id] [--json] [--review-prompt]\n`); process.exit(2); }
}
const sinceMs = since === 'all' ? 0 : (() => {
  const m = /^(\d+)([hd])$/.exec(since);
  if (!m) { process.stderr.write(`failures: --since takes e.g. 24h, 7d or all\n`); process.exit(2); }
  return Date.now() - (+m[1]) * (m[2] === 'h' ? 3600_000 : 86400_000);
})();

// ── read ──
const rows = [];
if (existsSync(LOG)) {
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (Date.parse(r.ts) < sinceMs) continue;
      if (session && r.session !== session) continue;
      rows.push(r);
    } catch { /* torn line */ }
  }
}
rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

if (json) { process.stdout.write(JSON.stringify(rows) + '\n'); process.exit(0); }

const statusKey = (r) => String(r.status || 'FAILED').split(/[/\s]/)[0].toUpperCase();
const count = (f) => { const m = new Map(); for (const r of rows) { const k = f(r); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
const one = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const when = (ts) => { const d = new Date(ts); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const span = since === 'all' ? 'in the whole log' : `in the last ${since}`;

if (review) {
  if (!rows.length) { process.stdout.write(`NO_FAILURES ${span}\n`); process.exit(0); }
  let rules = '';
  try {
    const skill = readFileSync(path.join(ROOT, 'skills', 'orchestrate', 'SKILL.md'), 'utf8');
    const a = skill.indexOf('## 2. Routing'), b = skill.indexOf('## 3.');
    rules = a >= 0 ? skill.slice(a, b > a ? b : undefined) : '';
  } catch { /* skill missing */ }
  const incidents = rows.slice(0, 25).map((r, i) => [
    `### ${i + 1}. ${r.ts} ${r.delegate} ${r.model}${r.effort ? '@' + r.effort : ''} edit=${!!r.edit} → ${r.status}`,
    r.label ? `label: ${r.label}` : '', r.denied ? `denied: ${r.denied}` : '', r.error ? `error: ${r.error}` : '', r.hint ? `hint: ${r.hint}` : '',
    r.prompt ? `prompt head (${r.promptChars ?? '?'} chars total):\n\`\`\`\n${String(r.prompt).slice(0, 900)}\n\`\`\`` : '',
    r.answerTail ? `answer tail:\n\`\`\`\n${String(r.answerTail).slice(-400)}\n\`\`\`` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  process.stdout.write([
    'You are reviewing why delegated runs of the multiclaude orchestrator failed, so the orchestrator can write better prompts.',
    `Below are ${Math.min(rows.length, 25)} failed runs (${span}, newest first) as the runner logged them, followed by the orchestrator's current routing and prompt-writing rules (orchestrate skill §2).`,
    '',
    'Produce a final report with:',
    '1. Recurring causes: group the failures and, for each group, say whether the cause is the PROMPT (missing context, stale excerpt, no deliverable, too broad), the ROUTING (wrong delegate/band, missing edit: true, pool out of quota), or the ENVIRONMENT (auth, CLI, flags). Cite incident numbers.',
    '2. Prompt fixes: for each prompt-caused group, a concrete before/after of what the orchestrator should write differently, as short reusable wording.',
    '3. Rule edits: exact proposed changes to the §2 text below (quote the line to replace and its replacement). Propose an edit only where a pattern repeats; say "none" otherwise.',
    'Keep it under 600 words. Do not run commands or edit files.',
    '',
    'Ground every factual claim in files you actually read. If a file read or command fails, output the exact error and STOP — do not invent or guess file contents, signatures, schema, routes, or names. If unsure, say so explicitly.',
    '',
    '## Failed runs', '', incidents, '', '## Current orchestrate §2 (routing + prompt rules)', '', rules.trim() || '(not available)', '',
  ].join('\n'));
  process.exit(0);
}

const out = [];
out.push(`[multiclaude failures] ${rows.length} failed run${rows.length === 1 ? '' : 's'} ${span}${session ? ` (session ${session.slice(0, 8)})` : ''}   log: ${LOG}`);
if (!rows.length) { out.push('  nothing to fix.'); process.stdout.write(out.join('\n') + '\n'); process.exit(0); }
out.push(`  by status: ${count(statusKey).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
out.push(`  by model:  ${count(r => `${r.delegate}:${r.model}`).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
const deniedActions = (() => { const m = new Map(); for (const r of rows) for (const a of String(r.denied || '').split(',').map(x => x.trim()).filter(Boolean)) m.set(a, (m.get(a) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); })();
if (deniedActions.length) out.push(`  denied:    ${deniedActions.slice(0, 5).map(([k, n]) => `${one(k, 40)} ×${n}`).join(' · ')}`);
out.push('', 'Why, and what to change:');
for (const [k, n] of count(statusKey)) {
  const [why, fix] = adviceFor(k);
  out.push(`  ${k} ×${n} — ${why}`, `      → ${fix}`);
}
out.push('', `Recent (${Math.min(limit, rows.length)} of ${rows.length}):`);
for (const r of rows.slice(0, limit)) {
  const detail = r.denied ? `denied ${r.denied}` : r.error ? r.error : r.hint || '';
  out.push(`  ${when(r.ts)}  ${r.delegate} ${one(r.model, 28)}${r.effort ? '@' + r.effort : ''}${r.edit ? ' edit' : ''}  ${r.status}  "${one(r.label || r.prompt, 50)}"${detail ? `  — ${one(detail, 90)}` : ''}${r.job ? `  [${r.job}]` : ''}`);
}
out.push('', '/multiclaude:failures review — AGY reads the log against the prompt rules and proposes prompt fixes (its own quota).');
process.stdout.write(out.join('\n') + '\n');
