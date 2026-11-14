---
name: shadow
description: Use when the user asks about shadow runs — pi running the same task beside every agent for the record — to switch them on or off, read how pi did per rules version, look at one pair, rate a recorded pi run, or tune the pi working rules from the recorded pairs and ratings.
---

# multiclaude:shadow

A **shadow** is a pi run of a task another agent is doing for real. With shadows on, every
Codex / AGY job — from the `dispatch` tool, a backgrounded Bash `dispatch.mjs --job`, an mc-*
forwarder — and every Claude subagent also runs once on pi, hard tasks included. The shadow's result is
never used: both ends are recorded as a pair, so the **prompts** pi gets — its working rules and
the way tasks are written for it — can be tuned. Nothing here trains a model.

Off by default. Each shadow is a real pi run: it costs what a pi run costs and uses the model's
serving capacity. Shadows run one at a time per chat (at most 12 waiting; a task text over 150k
characters gets none), with pi's band chosen to fit the tier of the agent it runs beside.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" [7d|24h|30d|all] [N] [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" pair <id>
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" rate <id> <pass|rework|fail> [--note "…"] [--gates "…"]
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" rules
```

Print the output as it is. `/multiclaude:shadow on` / `off` is Delegates setting 8
(`/delegates settings`, key `8`); only the plugin's own command or that pane changes it — if the
command did not answer by itself, tell the user to press `8` there.

- **No arguments / a period** — per pi model × rules version: runs, ok / stuck / failed, median
  steps, tokens, time, time to the first token, share of the input served from cache, spend, and
  how the shadow compares with the agent it ran beside (time, tokens, files in common); then the
  newest `N` pairs. *ok* and *stuck* say what the runner saw, not whether the answer was right;
  the `rated` line (pass / rework / fail) does. pi runs of their own — the trial — are in the same
  table.
- **`pair <id>`** — one pair: both answers, the shadow's steps and every rating it got. The id is
  the real agent's job id (or a Claude subagent's id), shown in brackets in the list; for a pi run
  of its own it is that job's id.
- **`rate <id> <pass|rework|fail> [--note "…"] [--gates "…"]`** — records a judgement of that pi
  run (by `user`; `--by <who>` names someone else). Use it when the user tells you how a shadow or
  a pi result did; never invent one.
- **`rules`** — the working rules a shadow gets today, their version hash, and the file your own
  rules go in.
- **`review [N]`** — builds a prompt from the newest `N` pairs (6 by default: task, both answers,
  the shadow's steps, the rules in force, the ratings already given) and queues **one AGY job**
  that gives each unrated pair a verdict and proposes rule lines. The verdicts are recorded as
  ratings (by `review:<model>`) when the answer arrives. **The pairs' text — task prompts, answers, file names, excerpts of tool
  output — is sent to that provider.** Say so before running it for the user, and do not run it
  over code that must not leave the machine. To do it by hand:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" review-prompt [period] [--n N]`, then one
  `dispatch` (agy, no edit) with that text as the prompt, then
  `shadow.mjs rate --from <the answer file> --by review:<model>` for its `VERDICT` lines.

## What a shadow may do

- **No shell**, ever: its tools are read / grep / find / ls, plus edit / write when the real agent
  may edit.
- **Edits happen in a throwaway worktree** (detached, started at the commit `HEAD` had when the
  real agent started, removed after the run). Outside a git repository, or beside a read-only
  agent, the shadow only reads. The real agent's uncommitted starting state is not in the worktree.
- pi has no sandbox, so a write outside the worktree cannot be prevented — only caught: the runner
  stops the run as `status=OUTSIDE` and names the file. That is the one case in which a shadow
  wakes the chat; check the named file (`git status` / `git diff` for that path) and tell the user.
- Otherwise a shadow is **silent**: no wake, no checkpoint, no grade, not on the scorecard, not in
  the failure log. Never wait for one, never use its answer, never call `dispatch_grade` on it.

## Ratings

Every judgement of a pi run is kept for good, with the run it judges and the rules version that
run got, so a later rules version can be held against an earlier one:

- **Your grade** of a pi job (`dispatch_grade`, orchestrate §10) — recorded automatically. The pi
  run itself (task, answer, patch, steps) is recorded too, as a `trial` run; job files only live
  14 days. `MULTICLAUDE_PI_RECORD=off` keeps trial runs out of the record.
- **A review's verdicts** — one per pair it read.
- **A rating typed by hand** — `rate`.

Only `dispatch_grade` counts on the scorecard and its trial verdict; a hand rating or a review
verdict is for the tuning, not for the routing decision. A shadow still gets no `dispatch_grade`.

## The tuning loop

1. Let pairs accumulate (`/multiclaude:shadow on`).
2. Read the figures per rules version; open the pairs that got stuck or were rated `fail`
   (`pair <id>`).
3. `review` for verdicts and proposals — or write your own from the steps you read.
4. Put accepted rules in the rules file `shadow.mjs rules` names (`pi-rules.md` in the multiclaude
   config folder): one `- rule` per line, 30 at most. Every pi run — shadow or not — gets them
   after the built-in ones. Write that file only when the user asks for the change.
5. A changed file gives later runs a new rules version; compare its row — ok, stuck and the
   ratings — with the old one.

## Where things live

- Records: `records.jsonl` in the multiclaude data folder under `shadow/` (the report's first line
  prints the path). Local disk only, file mode 0600, credentials scrubbed before writing, 64 MB cap.
  A record holds the task text, the answer, the patch and a compact step trace — company code
  included — so treat the file like the repositories it came from.
- Ratings: `ratings.jsonl` beside the records, same rules (0600, scrubbed, this machine only).
- Rules: `pi-rules.md` in the multiclaude config folder.
