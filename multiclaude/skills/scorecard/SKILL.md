---
name: scorecard
description: Use when the user asks how a delegate or model is doing, whether the trial delegate (pi, a self-hosted model) is good enough to keep using, or to grade a finished delegate job (pass, rework, fail) and compare models on the same task.
---

# Scorecard

Two logs under `~/.cache/multiclaude` (`$XDG_CACHE_HOME`):

- `runs.jsonl`: one line per finished run, written by `dispatch.mjs` — delegate,
  model, status, duration, tokens, tool steps, what the provider billed, and a
  hash of the task text.
- `grades.jsonl`: one line per verdict the orchestrator recorded after running
  its gates on a result: **pass** (accepted as delivered), **rework** (usable
  only after a fix, an edit by the orchestrator or a second dispatch), **fail**
  (thrown away: wrong, fabricated, looped, broke the gates). The newest grade
  of a job counts.

Typed as `/multiclaude:scorecard`, the plugin's hooks module runs the script and
prints its output directly, with no model turn. Otherwise run it and show the
output to the user **verbatim**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scorecard.mjs"                    # last 30 days, every delegate × model
node "${CLAUDE_PLUGIN_ROOT}/scripts/scorecard.mjs" all --delegate pi  # the trial delegate only, whole log
node "${CLAUDE_PLUGIN_ROOT}/scripts/scorecard.mjs" 7d --json
```

## Reading it

- **ok / stuck / fail** are what the runner saw: `SUCCESS`; `LOOP`, `TIMEOUT` or
  a run the orchestrator stopped and graded fail; any other failure. `QUOTA` and
  `CAPACITY` runs are left out: the wallet was empty, the model did nothing wrong.
- **judged p/r/f** are the orchestrator's grades. A run that ended `SUCCESS` can
  still be a fail: the runner only knows that the CLI returned an answer.
- **Trial verdict** (rows marked ◆): `UNDECIDED` below 5 graded runs; `VIABLE`
  at ≥ 70 % pass with ≤ 15 % stuck; `MARGINAL` at ≥ 70 % pass + rework with
  ≤ 30 % stuck (usable only with every result reviewed); else `NOT VIABLE`.
- **Bake-offs** pair runs of the same task text on different models (or runs
  linked with `vs`), and count how the trial model did against the others.

## Grading a job

The orchestrator grades with the `dispatch_grade` tool. By hand:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scorecard.mjs" grade <job> pass|rework|fail \
  --gates "tests 14/14, diff read" --note "why" [--vs <other job>] [--kind bugfix]
```

Grade only after the gates ran (orchestrate §3). Every pi job needs a grade;
grades on Codex / AGY jobs give the reference the trial model is rated against.
