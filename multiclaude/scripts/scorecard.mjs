#!/usr/bin/env node
// multiclaude scorecard — /multiclaude:scorecard.
//
// How each delegate × model does: what the runner saw (runs.jsonl, one line per
// finished run from dispatch.mjs: status, duration, tokens, steps) and what the
// orchestrating Claude judged after its gates (grades.jsonl, one line per
// `grade`). A TRIAL delegate (pi) gets a verdict from both.
//
//   scorecard.mjs [7d|24h|30d|all] [--delegate <d>] [--json]
//   scorecard.mjs grade <job> <pass|rework|fail> [--note "…"] [--gates "…"] [--vs <job>] [--kind <k>]
//
// pass   = accepted as delivered (gates green, nothing fixed by hand)
// rework = usable only after a fix / a second dispatch / an edit by the orchestrator
// fail   = thrown away (wrong, fabricated, looped, broke the gates)
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRating } from './lib/shadow.mjs';

const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'multiclaude');
const RUNS = path.join(CACHE, 'runs.jsonl');
const GRADES = path.join(CACHE, 'grades.jsonl');
const JOBS_DIR = path.join(CACHE, 'jobs');

// Delegates on trial: every run is judged, and the scorecard says whether to keep them.
export const TRIAL = new Set(['pi']);
// The verdict's lines. A trial model needs MIN_GRADED judged runs before any verdict.
export const RULES = { minGraded: 5, viablePass: 0.7, viableStuck: 0.15, marginalUsable: 0.7, marginalStuck: 0.3 };
const GRADE_VALUES = ['pass', 'rework', 'fail'];
const RANK = { pass: 2, rework: 1, fail: 0 };
// Not the model's doing: the wallet or the provider was out.
const INFRA = /^(QUOTA|CAPACITY|AUTH)/;
// A run somebody stopped. Graded fail = stopped because it was going nowhere (counts as stuck);
// ungraded = stopped for another reason (left out, like the infra runs).
const CANCELLED = /^CANCELLED/;
const STUCK = /^(LOOP|TIMEOUT)/;

const lines = (f) => {
  try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
};
const median = (a) => {
  const v = a.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};
const fail = (msg, code = 2) => { process.stderr.write(msg + '\n'); process.exit(code); };

export function verdictOf(row, rules = RULES) {
  const judged = row.pass + row.rework + row.fail;
  const counted = row.runs - row.infra;
  const stuck = counted > 0 ? row.stuck / counted : 0;
  if (judged < rules.minGraded) return { verdict: 'UNDECIDED', why: `${judged} of ${rules.minGraded} graded runs` };
  const pass = row.pass / judged, usable = (row.pass + row.rework) / judged;
  const fig = `pass ${Math.round(pass * 100)}% · usable ${Math.round(usable * 100)}% · stuck ${Math.round(stuck * 100)}% (loop / timeout / stopped)`;
  if (pass >= rules.viablePass && stuck <= rules.viableStuck) return { verdict: 'VIABLE', why: fig };
  if (usable >= rules.marginalUsable && stuck <= rules.marginalStuck) return { verdict: 'MARGINAL', why: `${fig} — only with every result reviewed` };
  return { verdict: 'NOT VIABLE', why: fig };
}

// runs + grades → rows per delegate × model, bake-off groups, ungraded trial runs.
export function build(runs, grades, { sinceMs = 0, delegate = null } = {}) {
  const latest = new Map();   // job → its newest grade
  for (const g of grades) if (g.job && GRADE_VALUES.includes(g.grade)) latest.set(g.job, g);
  const byJob = new Map();
  for (const r of runs) if (r.job) byJob.set(r.job, r);
  // a graded job whose run line is gone (older runner, trimmed log) still counts with the grade's snapshot
  // A shadow run (dispatch.mjs --shadow-of) is nobody's delivery: it is in /multiclaude:shadow, and here only once somebody graded it.
  const all = runs.filter((r) => !r.shadowOf || latest.has(r.job));
  for (const g of latest.values()) if (!byJob.has(g.job)) all.push({ ...g, fromGrade: true });
  const inWin = all.filter((r) => (Date.parse(r.ts) || 0) >= sinceMs && (!delegate || r.delegate === delegate));

  const rows = new Map();
  for (const r of inWin) {
    const key = `${r.delegate}\t${r.model}`;
    const row = rows.get(key) || { delegate: r.delegate, model: r.model, trial: TRIAL.has(r.delegate), runs: 0, ok: 0, infra: 0, stuck: 0, loop: 0, timeout: 0, stopped: 0, failed: 0, pass: 0, rework: 0, fail: 0, durs: [], toks: [], steps: [], cost: 0, costApprox: false };
    const st = String(r.status || '');
    const g = r.job ? latest.get(r.job) : null;
    row.runs++;
    if (st === 'SUCCESS') row.ok++;
    else if (INFRA.test(st)) row.infra++;
    else if (CANCELLED.test(st)) { if (g && g.grade === 'fail') { row.stuck++; row.stopped++; } else row.infra++; }
    else if (STUCK.test(st)) { row.stuck++; if (st.startsWith('LOOP')) row.loop++; else row.timeout++; }
    else row.failed++;
    if (g) row[g.grade]++;
    if (st === 'SUCCESS') { row.durs.push(r.dur); row.toks.push(r.tokens); row.steps.push(r.steps); }
    row.cost += r.cost || 0;
    if (r.cost > 0 && r.costKind === 'list') row.costApprox = true;   // priced at list price by the runner, not billed
    rows.set(key, row);
  }
  const table = [...rows.values()].map((row) => {
    const judged = row.pass + row.rework + row.fail;
    const { durs, toks, steps, ...rest } = row;
    return {
      ...rest, graded: judged, passRate: judged ? row.pass / judged : null,
      medDur: median(durs), medTokens: median(toks), medSteps: median(steps),
      ...(row.trial ? verdictOf(row) : {}),
    };
  }).sort((a, b) => (Number(b.trial) - Number(a.trial)) || (b.runs - a.runs));

  // bake-offs: the same task text on ≥ 2 models, or runs linked with --vs
  const groups = new Map();
  const join = (k, r) => { const g = groups.get(k) || []; if (!g.some((x) => x.job === r.job)) g.push(r); groups.set(k, g); };
  for (const r of inWin) if (r.task && r.job) join(`t:${r.task}`, r);
  for (const g of latest.values()) {
    if (!g.vs) continue;
    const a = byJob.get(g.job) || g, b = byJob.get(g.vs) || latest.get(g.vs);
    if (!b) continue;
    const k = a.task && a.task === b.task ? `t:${a.task}` : `v:${[g.job, g.vs].sort().join('+')}`;
    join(k, a); join(k, b);
  }
  const bakeoffs = [...groups.values()]
    .filter((g) => new Set(g.map((r) => `${r.delegate}\t${r.model}`)).size > 1)
    .map((g) => ({
      label: g.find((r) => r.label)?.label || g[0].job, ts: g.map((r) => r.ts).sort().pop(),
      runs: g.map((r) => ({ job: r.job, delegate: r.delegate, model: r.model, status: r.status, grade: latest.get(r.job)?.grade ?? null, tokens: r.tokens ?? null, dur: r.dur ?? null, cost: r.cost ?? null })),
    }))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  // head-to-head per trial model: graded pairs only
  const h2h = new Map();
  for (const b of bakeoffs) {
    for (const t of b.runs.filter((r) => TRIAL.has(r.delegate) && r.grade)) {
      for (const o of b.runs.filter((r) => !TRIAL.has(r.delegate) && r.grade)) {
        const k = `${t.delegate}\t${t.model}`;
        const s = h2h.get(k) || { delegate: t.delegate, model: t.model, won: 0, tied: 0, lost: 0 };
        const d = RANK[t.grade] - RANK[o.grade];
        if (d > 0) s.won++; else if (d < 0) s.lost++; else s.tied++;
        h2h.set(k, s);
      }
    }
  }
  const ungraded = inWin.filter((r) => TRIAL.has(r.delegate) && r.job && !latest.has(r.job) && !INFRA.test(String(r.status || '')) && !CANCELLED.test(String(r.status || '')))
    .map((r) => ({ job: r.job, model: r.model, status: r.status, label: r.label || '', ts: r.ts }));
  return { rows: table, bakeoffs, headToHead: [...h2h.values()], ungraded };
}

// The recorded runs and grades, summarized (probe.mjs prints the trial rows).
export const summarize = (opts) => build(lines(RUNS), lines(GRADES), opts);

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);

  // ── grade ──
  if (argv[0] === 'grade') {
    const [, job, grade] = argv;
    const opt = {};
    for (let i = 3; i < argv.length; i++) {
      const a = argv[i];
      if (['--note', '--gates', '--vs', '--kind'].includes(a)) opt[a.slice(2)] = argv[++i] ?? '';
      else fail(`scorecard: unknown argument ${a}`);
    }
    if (!job || !/^[A-Za-z0-9_.-]+$/.test(job) || !GRADE_VALUES.includes(grade))
      fail('usage: scorecard.mjs grade <job> <pass|rework|fail> [--note "…"] [--gates "…"] [--vs <job>] [--kind <k>]');
    let run = lines(RUNS).filter((r) => r.job === job).pop();
    if (!run) {   // a run from before the run log: the job file still has the proof line
      try {
        const m = JSON.parse(readFileSync(path.join(JOBS_DIR, `${job}.json`), 'utf8'));
        // 'running' with its runner gone = killed before it could report (dispatch_cancel on an older runner)
        let alive = m.status === 'queued';
        if (m.status === 'running') { try { process.kill(m.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
        if (alive) fail(`scorecard: job ${job} is still ${m.status} — grade it when it has finished`, 1);
        if (m.status === 'running') { m.status = 'CANCELLED'; m.proof = ''; }
        run = { ts: new Date(m.endedAt || m.startedAt || Date.now()).toISOString(), job, delegate: m.delegate, model: m.model, effort: m.effort || null, label: m.label || null, status: /status=(\S+)/.exec(m.proof || '')?.[1] || String(m.status).toUpperCase(), tokens: m.tokens ?? null, session: m.session || null };
      } catch { fail(`scorecard: no run ${job} in ${RUNS} and no job file — check the id (dispatch_status lists them)`, 1); }
    }
    if (opt.vs && opt.vs === job) fail('scorecard: --vs names the other run of the bake-off, not this one');
    const rec = {
      ts: run.ts, gradedAt: new Date().toISOString(), job, grade, note: opt.note || null, gates: opt.gates || null, vs: opt.vs || null, kind: opt.kind || null,
      delegate: run.delegate, model: run.model, effort: run.effort || null, label: run.label || null, status: run.status,
      tokens: run.tokens ?? null, dur: run.dur ?? null, steps: run.steps ?? null, cost: run.cost ?? null, task: run.task || null, session: run.session || null,
    };
    mkdirSync(CACHE, { recursive: true });
    appendFileSync(GRADES, JSON.stringify(rec) + '\n');
    // The cache copy above is the scorecard's; the rating is also kept for good, next to the recorded run (lib/shadow.mjs).
    const kept = writeRating({ ts: rec.gradedAt, job, pair: run.shadowOf || job, delegate: run.delegate, model: run.model, rules: run.rules || null, grade, by: 'orchestrator', note: rec.note, gates: rec.gates, vs: rec.vs, kind: rec.kind, label: rec.label, task: rec.task, status: rec.status, tokens: rec.tokens, dur: rec.dur, steps: rec.steps, cost: rec.cost });
    const again = lines(GRADES).filter((g) => g.job === job).length > 1;
    const sum = build(lines(RUNS), lines(GRADES), { delegate: run.delegate }).rows.find((r) => r.model === run.model);
    process.stdout.write(`graded ${job} (${run.delegate} ${run.model}, ${run.status}): ${grade}${again ? ' — replaces the earlier grade' : ''}${kept ? ' · kept in the ratings record' : ''}\n` +
      (sum ? `${run.delegate} ${run.model} so far: ${sum.pass} pass · ${sum.rework} rework · ${sum.fail} fail of ${sum.runs} run(s)${sum.verdict ? ` → ${sum.verdict} (${sum.why})` : ''}\n` : ''));
    process.exit(0);
  }

  // ── summary ──
  let since = '30d', delegate = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--delegate') delegate = argv[++i] || null;
    else if (/^(all|\d+[hd])$/.test(a)) since = a;
    else fail(`scorecard: unknown argument ${a}\nusage: scorecard.mjs [7d|24h|30d|all] [--delegate <d>] [--json] | grade <job> <pass|rework|fail> …`);
  }
  const m = /^(\d+)([hd])$/.exec(since);
  const sinceMs = m ? Date.now() - +m[1] * (m[2] === 'h' ? 3600_000 : 86400_000) : 0;
  const r = build(lines(RUNS), lines(GRADES), { sinceMs, delegate });
  if (json) { process.stdout.write(JSON.stringify({ since, rules: RULES, ...r }) + '\n'); process.exit(0); }

  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');
  const k = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
  const sec = (n) => (n == null ? '–' : n >= 90 ? `${Math.round(n / 60)}m` : `${Math.round(n)}s`);
  const pad = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t).padEnd(n);
  const out = [`[multiclaude scorecard] ${since === 'all' ? 'all recorded runs' : `last ${since}`}${delegate ? ` · ${delegate} only` : ''}`];
  if (!r.rows.length) {
    out.push('', 'No runs recorded yet. Every dispatch adds one line; grade a run with dispatch_grade (or scorecard.mjs grade <job> pass|rework|fail).');
  } else {
    out.push('  runner: ok = SUCCESS · stuck = LOOP / TIMEOUT / stopped by the orchestrator and graded fail · fail = other failures (QUOTA / CAPACITY / AUTH / other cancels are left out) — judged: pass / rework / fail by the orchestrator',
      '', `${pad('', 38)}${'runs'.padStart(5)}${'ok'.padStart(6)}${'stuck'.padStart(6)}${'fail'.padStart(6)}  ${pad('judged p/r/f', 14)}${'pass'.padStart(5)}${'med t'.padStart(7)}${'med tok'.padStart(9)}`);
    for (const x of r.rows) {
      const counted = x.runs - x.infra;
      out.push(`${pad(`${x.trial ? '◆ ' : '  '}${x.delegate} ${x.model}`, 38)}${String(x.runs).padStart(5)}${pct(x.ok, counted).padStart(6)}${pct(x.stuck, counted).padStart(6)}${pct(x.failed, counted).padStart(6)}  ${pad(x.graded ? `${x.pass}/${x.rework}/${x.fail}` : '–', 14)}${pct(x.pass, x.graded).padStart(5)}${sec(x.medDur).padStart(7)}${k(x.medTokens).padStart(9)}`);
    }
    const trial = r.rows.filter((x) => x.trial);
    if (trial.length) {
      out.push('', `Trial verdict (◆; needs ${RULES.minGraded} graded runs · VIABLE: pass ≥ ${RULES.viablePass * 100}% and stuck ≤ ${RULES.viableStuck * 100}% · MARGINAL: pass + rework ≥ ${RULES.marginalUsable * 100}% and stuck ≤ ${RULES.marginalStuck * 100}%)`);
      const ref = r.rows.filter((x) => !x.trial && x.graded >= 3).sort((a, b) => b.passRate - a.passRate)[0];
      for (const x of trial) {
        const h = r.headToHead.find((s) => s.delegate === x.delegate && s.model === x.model);
        out.push(`  ${x.delegate} ${x.model}: ${x.verdict} — ${x.why}${x.cost > 0 ? ` · ${x.costApprox ? '≈ $' : 'billed $'}${x.cost < 0.01 ? x.cost.toFixed(4) : x.cost.toFixed(2)}${x.costApprox ? ' at list price' : ''}` : ''}`);
        if (h) out.push(`      bake-offs vs other models: won ${h.won} · tied ${h.tied} · lost ${h.lost}`);
      }
      if (ref) out.push(`  reference: ${ref.delegate} ${ref.model} passes ${pct(ref.pass, ref.graded)} of ${ref.graded} graded run(s)`);
      else out.push('  reference: no other model has 3 graded runs yet — grade Codex / AGY runs too, or run bake-offs (same task text on both)');
    }
    if (r.bakeoffs.length) {
      out.push('', 'Bake-offs (same task on several models; newest first)');
      for (const b of r.bakeoffs.slice(0, 8)) {
        out.push(`  ${b.label}`);
        for (const x of b.runs) out.push(`      ${pad(`${x.delegate} ${x.model}`, 34)} ${pad(String(x.status), 10)} ${pad(x.grade || 'ungraded', 9)} ${k(x.tokens).padStart(7)} tok ${sec(x.dur).padStart(5)}  ${x.job}`);
      }
      if (r.bakeoffs.length > 8) out.push(`  … ${r.bakeoffs.length - 8} more (--json)`);
    }
    if (r.ungraded.length) {
      out.push('', `Trial runs still ungraded (${r.ungraded.length}) — judge each with dispatch_grade:`);
      for (const u of r.ungraded.slice(-10)) out.push(`  ${u.job} · ${u.status} · ${u.model} · ${u.label}`);
    }
  }
  process.stdout.write(out.join('\n') + '\n');
}
