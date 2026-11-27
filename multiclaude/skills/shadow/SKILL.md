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
serving capacity. Shadows run 1–8 at once per chat (default 1), with max(12, 6 × parallel) waiting;
a task text over 150k characters gets none. Shadows run on pi's **medium** band, every 5th on **high**,
never low: the band, not the agent beside it, decided how a shadow went (medium finished nearly everything,
high got stuck far more often at 5–10× the tokens, low finished nothing).
On top of that, every pi run on this machine — shadows and pi jobs of every chat — takes one of a
fixed number of slots (default 2, `slots N`), so several chats never overload the one model server;
a pi job goes before a shadow, a run waits up to 30 min (`⏳ waiting for a pi slot`), then ends CAPACITY.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" [7d|24h|30d|all] [N] [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" pair <id>
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" rate <id> <pass|rework|fail> [--cause c] [--kind k] [--note "…"] [--gates "…"]
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" auto [--dry] [--force]
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" rules
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" judge [on|off|status]
node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" snap [--cwd D]
```

Print the output as it is. `/multiclaude:shadow on` / `off` is Delegates setting 8
(`/delegates settings`, key `8`); only the plugin's own command or that pane changes it — if the
command did not answer by itself, tell the user to press `8` there.

- **`slots [N]`** — show or set how many pi runs may run at once on this machine, across every chat
  (1–16, default 2; saved in `~/.config/multiclaude/pi.json`, `MULTICLAUDE_PI_PARALLEL` wins). Lists the runs holding a
  slot and the ones waiting. Lower it when the model server answers `502 Bad Gateway` (CAPACITY) under load.
- **`parallel [N]`** — show or set concurrent shadows per chat (integer N clamped to 1–8). Settings key `9` cycles 1 → 2 → 4 → 8 → 1. Changes reach every open chat within a few seconds. This command is handled by the module, not the script.
- **No arguments / a period** — per pi model × rules version: runs, ok / stuck / failed, median
  steps, tokens, time, time to the first token, share of the input served from cache, spend, and
  how the shadow compares with the agent it ran beside (time, tokens, files in common); then the
  newest `N` pairs. *ok* and *stuck* say what the runner saw, not whether the answer was right;
  the `rated` line (pass / rework / fail, with the causes) does. pi runs of their own — the trial —
  are in the same table. Below it: **where pi fell short** (the cause of each rework / fail, newest
  rating per run) and the grades **per task kind**, then how many pairs still wait for a rating.
- **`pair <id>`** — one pair: both answers, the shadow's steps and every rating it got. The id is
  the real agent's job id (or a Claude subagent's id), shown in brackets in the list; for a pi run
  of its own it is that job's id.
- **`rate <id> <pass|rework|fail> [--cause c] [--kind k] [--note "…"] [--gates "…"]`** — records a
  judgement of that pi run (by `user`; `--by <who>` names someone else). `--cause` is why a rework /
  fail fell short — `loop` (went in circles, ran out of steps or time) · `misread` (the task or the
  place) · `knowledge` (of the repository, a tool, the domain) · `broke` (the change is wrong) ·
  `unfinished` · `false-claim` (the report claims what the steps do not show) · `gave-up` ·
  `tooling` (misused its tools) · `infra` (provider / gateway) · `env` (the shadow lacked a file,
  login or tool the real agent had); a pass is `none`. `infra` and `env` count for nobody. `--kind` is the
  task: `review` · `bugfix` · `feature` · `refactor` · `tests` · `docs` · `ops` · `research` ·
  `other`. Use it when the user tells you how a shadow or a pi result did; never invent one.
- **`auto [on|off]`** — the **automatic review**, on by default while shadows are on: every open
  chat asks every 10 min, and when 6 pairs with a reference wait unrated (at most hourly, or one has
  waited a day) **one AGY job** (default band, the AGY wallet) gets them and answers with verdict
  lines only — grade, cause, task kind — recorded as ratings by `review:<model>`. One review at a
  time on the machine (a lock); a pair shown twice without a verdict is left out. When AGY gives no
  answer (spent pool — refused before any token is paid —, busy, signed out, missing) the same prompt
  goes once to **Claude**: headless `claude -p`, Haiku (Sonnet when Haiku is overloaded), no tools, no
  settings, on the Claude login active then — the Claude wallet; `MULTICLAUDE_REVIEW_CLAUDE=model[,fallback]|off`.
  When neither answers the pairs count as not shown and the next round (an hour later) tries again. **The pairs' text
  is sent to that provider**, as with `review`. Bare `auto` runs one when it is due (that sends the pairs); `auto --dry` only says whether one is due; `auto on|off`
  (the module's) switches it in every chat; `--force` runs one now; the answers are kept under
  `reviews/` beside the records, the last run in `auto-review.json`.
- **`judge [on|off|status]`** — the **time judge**, on by default. Nobody is woken for a shadow, so
  when one reaches 80% of its limit after the runner's own two extensions (600 → 1200 s), one AGY job
  (default band; when AGY gives no answer, one headless Claude call, as for `auto`) reads its steps,
  repeated calls, errors, edits, its pace (tool steps in the last 5 min, the last step, how long
  the last model calls took), the failed model calls and how the real agent ended. It answers `EXTEND` (up to 600 s more,
  to a 40-min ceiling, `MULTICLAUDE_SHADOW_CEILING`) or `STOP <cause>` — `env` early for a task that
  needs a live host or a login, `infra` for a failing model server. STOP ends the shadow
  `CANCELLED` and records a fail rating with that cause, by `judge:<model>`; unless the cause is
  `infra`, the shadow first writes its final report with no tools (see below). The verdicts are in the
  record's `judge` field. **The task text and the steps are sent to that provider.** Off: `judge off`
  (every chat at once) or `MULTICLAUDE_SHADOW_JUDGE=off`.
- **`snap [--cwd D]`** — the commit a shadow would start from: the working tree as it is,
  uncommitted and untracked files included, ignored ones out, as a loose commit on `HEAD` (no
  branch, the index untouched). Prints `{ commit, head, snapshot }`. Mainly for the module.
- **`rules`** — the working rules a shadow gets today, their version hash, and the file your own
  rules go in.
- **`review [N]`** — builds a prompt from the newest `N` pairs (6 by default: task, both answers,
  the shadow's steps, the rules in force, the ratings already given) and queues **one AGY job**
  that gives each unrated pair a verdict (grade, cause, kind) and proposes rule lines. The verdicts are recorded as
  ratings (by `review:<model>`) when the answer arrives. **The pairs' text — task prompts, answers, file names, excerpts of tool
  output — is sent to that provider.** Say so before running it for the user, and do not run it
  over code that must not leave the machine. To do it by hand:
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/shadow.mjs" review-prompt [period] [--n N]`, then one
  `dispatch` (agy, no edit) with that text as the prompt, then
  `shadow.mjs rate --from <the answer file> --by review:<model>` for its `VERDICT` lines.

## What a shadow may do

- **A shell, contained.** Its tools are read / grep / find / ls, plus edit / write when the real
  agent may edit, plus bash (and PowerShell on Windows) in the tier `pi.json` `shadowShell` picks
  (`auto` default: bwrap, else the user's sandbox `command` with `sandboxed: true`, else the guard;
  `sandbox`: never the guard; `guard`; `off`: no shell — `MULTICLAUDE_SHADOW_SHELL` overrides). The
  record's `sandbox` field and the progress line say which tier ran.
- **bwrap tier** (Linux, `bwrap` usable): the whole pi run is inside the sandbox
  (`scripts/lib/sandbox.mjs`): `$HOME` is empty except an allowlist bound read-only (`~/dev`, tool
  installs, git config, CA certs — no `~/.ssh`, no CLI logins, no agent sockets, no tokens in the
  environment), the filesystem is read-only except the worktree, a private `/tmp` and pi's own agent
  dir, sudo does not work, and the network stays on for lookups (registries, release pages) — a
  command can read the network, not act on anything that needs a login. More read-only paths:
  `MULTICLAUDE_SANDBOX_RO` (`:`-joined).
- **guard tier** — the weaker fallback, no OS sandbox (`scripts/pi-guard.ts`, rules in
  `scripts/lib/guard.mjs`): each command gets an environment allowlist; commands that log in,
  deploy, push, publish or change a remote system are refused (also behind `env`, `bash -c`,
  `pwsh -Command`, `eval`, `find -exec`), so are writes outside the worktree and the temp dir. It reads
  command lines only: `python -c`, a repo script or a build tool still runs with the user's rights.
  A read-only shadow gets a throwaway worktree for it; outside a git repository, no shell.
  `MULTICLAUDE_SANDBOX_ENV` (`,`-joined names) adds variables a command may see in every tier.
- **A throwaway worktree of the real agent's tree.** It starts at a snapshot of the working tree
  as the real agent had it: uncommitted and untracked files included, ignored ones (`.venv`,
  `node_modules`) left out. A file git cannot read is left out too, and named in the record's
  `snapError`; the rest is still there (before, one such file sent the whole shadow back to `HEAD`).
  The worktree is detached and removed after the run. Read-only shadows
  get one too; the shadow edits only when the real agent may. Outside a git repository the shadow
  only reads.
- **Scratchpad files as they were.** Files under the Claude Code scratchpad that the task names are
  bound read-only as copies taken as of the real agent's start (`asOf`): what the real agent wrote
  there afterwards — its results — stays out (2000 files / 64 MB; the job file's `scratchCopied` /
  `scratchSkipped`).
- **No login, no ssh.** There is no `~/.ssh`, no agent and no login. The working rules tell pi
  that the first such failure is final: answer from the repository and name the commands it would
  have run.
- **A final report after a stop.** A shadow stopped by its time limit, or by a judge `STOP` whose
  cause is not `infra`, is resumed once with no tools (≤ 240 s) to write its final report; that
  becomes the answer, marked `[final report written after …]`, the record's `salvaged` is `yes` or
  `partial`, the status stays `TIMEOUT` / `CANCELLED`.
- **Failed model calls stop it early.** Model calls pi gives up on count as no progress; 4 in a row,
  or 2 in a row with no answer for 5 min, end the run `CAPACITY` (`QUOTA` for a spent quota,
  `model-errors=N` on the proof line), with no final report — the model server is the problem, not
  pi.
- **In bwrap, at the real path:** the worktree is mounted over the real checkout, so paths and
  `cwd` are the real ones and the live checkout is hidden. `git status` / `diff` / `log` work and
  the repository is read-only (`git add` / `commit` / `stash` fail). The real `.venv` / `venv` /
  `node_modules` are bound read-only.
- **Records from before this** have no `base` field. They started at `HEAD` without the uncommitted
  files, and a bwrap one could read the live checkout. Rate a contaminated pair `--cause env`.
- A write outside the worktree is refused (the guard extension in every tier; in bwrap the filesystem
  too) and the run goes on; the temp dir is scratch. A shadow with no shell has no guard: an
  `edit` / `write` outside the worktree there stops the run as `status=OUTSIDE` and names the file. That is the one case in which a shadow
  wakes the chat; check the named file (`git status` / `git diff` for that path) and tell the user.
- Otherwise a shadow is **silent**: no wake, no checkpoint, no grade, not on the scorecard, not in
  the failure log. Never wait for one, never use its answer, never call `dispatch_grade` on it.

## Ratings

Every judgement of a pi run is kept for good, with the run it judges and the rules version that
run got, so a later rules version can be held against an earlier one:

- **Your grade** of a pi job (`dispatch_grade`, orchestrate §10) — recorded automatically. The pi
  run itself (task, answer, patch, steps) is recorded too, as a `trial` run; job files only live
  14 days. `MULTICLAUDE_PI_RECORD=off` keeps trial runs out of the record.
- **A review's verdicts** — one per pair it read, from `review` or the automatic review.
- **A rating typed by hand** — `rate`.

Only `dispatch_grade` counts on the scorecard and its trial verdict; a hand rating or a review
verdict is for the tuning, not for the routing decision. A shadow still gets no `dispatch_grade`.

## The tuning loop

1. Let pairs accumulate (`/multiclaude:shadow on`).
2. Read the figures per rules version and the causes; open the pairs that got stuck or were
   rated `fail` (`pair <id>`). The most frequent cause is the next rule to write.
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
