// node --test tests/scorecard.test.mjs — scripts/scorecard.mjs: the trial verdict rules, what
// counts as stuck / infra, bake-off pairing, and `grade` writing grades.jsonl (also for a job
// that was killed before the runner could log it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { build, verdictOf, RULES, TRIAL } from '../scripts/scorecard.mjs';

const CARD = fileURLToPath(new URL('../scripts/scorecard.mjs', import.meta.url));
const ts = new Date().toISOString();
let n = 0;
const runOf = (delegate, model, status, more = {}) => ({ ts, job: `j${++n}`, delegate, model, status, tokens: 1000, dur: 10, steps: 5, ...more });
const grade = (run, g, more = {}) => ({ ts, job: run.job, grade: g, delegate: run.delegate, model: run.model, status: run.status, ...more });
const row = (r, model) => r.rows.find((x) => x.model === model);

test('pi is the trial delegate; fewer than the minimum graded runs is UNDECIDED', () => {
  assert.ok(TRIAL.has('pi'));
  const runs = [1, 2, 3, 4].map(() => runOf('pi', 'm', 'SUCCESS'));
  const r = build(runs, runs.map((x) => grade(x, 'pass')));
  assert.equal(row(r, 'm').verdict, 'UNDECIDED');
  assert.equal(row(r, 'm').graded, RULES.minGraded - 1);
});

test('VIABLE needs the pass rate and a low stuck rate', () => {
  const ok = [1, 2, 3, 4, 5, 6, 7, 8].map(() => runOf('pi', 'm', 'SUCCESS'));
  const grades = ok.map((x, i) => grade(x, i < 6 ? 'pass' : 'rework'));   // 75 % pass
  assert.equal(row(build(ok, grades), 'm').verdict, 'VIABLE');
  // the same grades, but 2 of 10 runs looped (20 % stuck > 15 %) → only MARGINAL
  const loops = [runOf('pi', 'm', 'LOOP'), runOf('pi', 'm', 'TIMEOUT')];
  const withLoops = row(build([...ok, ...loops], grades), 'm');
  assert.equal(withLoops.stuck, 2);
  assert.equal(withLoops.verdict, 'MARGINAL');
});

test('mostly rework is MARGINAL; mostly fail is NOT VIABLE', () => {
  const runs = [1, 2, 3, 4, 5].map(() => runOf('pi', 'm', 'SUCCESS'));
  assert.equal(row(build(runs, runs.map((x, i) => grade(x, i < 2 ? 'pass' : 'rework'))), 'm').verdict, 'MARGINAL');
  assert.equal(row(build(runs, runs.map((x, i) => grade(x, i < 2 ? 'pass' : 'fail'))), 'm').verdict, 'NOT VIABLE');
  assert.equal(verdictOf({ runs: 6, infra: 0, stuck: 4, pass: 5, rework: 0, fail: 1 }).verdict, 'NOT VIABLE', 'stuck too often, whatever the grades');
});

test('quota and capacity count for nobody; a cancelled run counts as stuck only when graded fail', () => {
  const q = runOf('pi', 'm', 'QUOTA'), c = runOf('pi', 'm', 'CAPACITY');
  const stopped = runOf('pi', 'm', 'CANCELLED'), dropped = runOf('pi', 'm', 'CANCELLED');
  const r = build([q, c, stopped, dropped], [grade(stopped, 'fail')]);
  const m = row(r, 'm');
  assert.equal(m.runs, 4);
  assert.equal(m.infra, 3);          // quota, capacity, the ungraded cancel
  assert.equal(m.stuck, 1);
  assert.equal(m.stopped, 1);
  assert.equal(m.fail, 1);
  assert.deepEqual(r.ungraded, [], 'neither infra nor cancelled runs are asked for a grade');
});

test('an ungraded finished pi run is listed; Codex runs are never asked for a grade', () => {
  const p = runOf('pi', 'm', 'SUCCESS', { label: 'fix parser' }), x = runOf('codex', 'gx', 'SUCCESS');
  const r = build([p, x], []);
  assert.deepEqual(r.ungraded.map((u) => u.job), [p.job]);
  assert.equal(row(r, 'gx').verdict, undefined, 'no verdict for a non-trial delegate');
});

test('the same task on two models is a bake-off; head-to-head counts graded pairs', () => {
  const a = runOf('pi', 'm', 'SUCCESS', { task: 'aaaaaaaaaa' }), b = runOf('codex', 'gx', 'SUCCESS', { task: 'aaaaaaaaaa' });
  const c = runOf('pi', 'm', 'SUCCESS', { task: 'bbbbbbbbbb' }), d = runOf('agy', 'gem', 'SUCCESS', { task: 'cccccccccc' });
  const r = build([a, b, c, d], [grade(a, 'rework'), grade(b, 'pass'), grade(c, 'pass', { vs: d.job }), grade(d, 'rework')]);
  assert.equal(r.bakeoffs.length, 2, 'one by task hash, one linked with --vs');
  assert.deepEqual(r.headToHead, [{ delegate: 'pi', model: 'm', won: 1, tied: 0, lost: 1 }]);
});

test('only the newest grade of a job counts, and the window filters by time', () => {
  const a = runOf('pi', 'm', 'SUCCESS');
  const m = row(build([a], [grade(a, 'fail'), grade(a, 'pass')]), 'm');
  assert.equal(m.pass, 1);
  assert.equal(m.fail, 0);
  const old = { ...runOf('pi', 'm', 'SUCCESS'), ts: new Date(Date.now() - 40 * 86400_000).toISOString() };
  assert.equal(row(build([a, old], [], { sinceMs: Date.now() - 7 * 86400_000 }), 'm').runs, 1);
});

function cache(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mc-card-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'multiclaude');
  mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  const card = (...args) => spawnSync(process.execPath, [CARD, ...args], { env: { ...process.env, XDG_CACHE_HOME: home, MULTICLAUDE_SHADOW_DIR: path.join(home, 'shadow') }, encoding: 'utf8' });
  const grades = () => readFileSync(path.join(dir, 'grades.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ratings = () => { try { return readFileSync(path.join(home, 'shadow', 'ratings.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { dir, card, grades, ratings };
}

test('grade writes grades.jsonl and the table shows the model; a bad grade or job is refused', (t) => {
  const c = cache(t);
  const run = { ...runOf('pi', 'm', 'SUCCESS'), job: 'jabc123', rules: 'aaaa1111' };
  writeFileSync(path.join(c.dir, 'runs.jsonl'), JSON.stringify(run) + '\n');
  const ok = c.card('grade', 'jabc123', 'rework', '--note', 'missed the empty case', '--gates', 'npm test: 1 failed');
  assert.equal(ok.status, 0, ok.stderr);
  // every grade is also kept for good, with the rules version the run got
  assert.match(ok.stdout, /kept in the ratings record/);
  const [kept] = c.ratings();
  assert.deepEqual([kept.job, kept.pair, kept.grade, kept.by, kept.rules, kept.model, kept.note, kept.gates], ['jabc123', 'jabc123', 'rework', 'orchestrator', 'aaaa1111', 'm', 'missed the empty case', 'npm test: 1 failed']);
  const [g] = c.grades();
  assert.equal(g.grade, 'rework');
  assert.equal(g.note, 'missed the empty case');
  assert.equal(g.gates, 'npm test: 1 failed');
  assert.equal(g.model, 'm');
  assert.notEqual(c.card('grade', 'jabc123', 'great').status, 0);
  assert.notEqual(c.card('grade', 'nosuchjob', 'pass').status, 0);
  const table = c.card('all');
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /UNDECIDED/);
  const json = JSON.parse(c.card('all', '--json').stdout);
  assert.equal(json.rows[0].rework, 1);
});

test('a job killed before the runner logged it is graded from its job file as CANCELLED', (t) => {
  const c = cache(t);
  // a pid that is certainly gone: a child that already exited
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(path.join(c.dir, 'jobs', 'jdead01.json'), JSON.stringify({ id: 'jdead01', delegate: 'pi', model: 'm', status: 'running', pid: dead, startedAt: Date.now() - 60_000, label: 'stuck run' }));
  const r = c.card('grade', 'jdead01', 'fail', '--note', 'edited the same file four times');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(c.grades()[0].status, 'CANCELLED');
  const json = JSON.parse(c.card('all', '--json').stdout);
  assert.equal(json.rows[0].stopped, 1);
  // a runner that is still alive is not graded
  writeFileSync(path.join(c.dir, 'jobs', 'jlive01.json'), JSON.stringify({ id: 'jlive01', delegate: 'pi', model: 'm', status: 'running', pid: process.pid, startedAt: Date.now() }));
  assert.notEqual(c.card('grade', 'jlive01', 'fail').status, 0);
});
