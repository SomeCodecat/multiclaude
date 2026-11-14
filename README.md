# multiclaude

A Claude Code plugin that makes Claude the **orchestrator** and sends the heavy
lifting to two external delegates on their own quota: **Codex** (OpenAI) for
edits and implementation, **Antigravity** (`agy`: Gemini + Claude tiers) for
review, research and analysis. Claude's own quota is spent last.

What you get:

- a native **`dispatch` tool** Claude calls to hand a task to a delegate, no
  Claude subagent in between, so a dispatch costs zero driver tokens;
- the **`orchestrate` skill** with the routing rules (what to delegate, which
  band, how to verify);
- a **Delegates pane** with every job live, a **Wallets pane** and a **status
  line** with the usage of every wallet;
- readouts for quota, token usage and failed runs, and a way to pool several
  Claude logins into one wallet;
- an optional **trial delegate**, `pi`, for testing a self-hosted model on
  coding tasks: Claude checks every run while it works, judges every result
  and grades it, and a **scorecard** rates the model against the others.

Full design notes live in `docs/superpowers/specs/`.

## Quick start

You need Claude Code and Node.js 18+ on the machine. Everything in the plugin
is pure Node (no bash, no python3), so it runs the same on Linux, macOS and
Windows.

**1. Install the plugin** from inside Claude Code, then restart it so the
skills and hooks load:

```
/plugin marketplace add SomeCodecat/multiclaude
/plugin install multiclaude@multiclaude
```

**2. Check the environment.** Installing changes nothing in your settings, and
this command only reads. It prints a checklist with an exact `fix:` line for
anything missing:

```
/multiclaude:setup
```

**3. Wire it up.** `apply` adds the plugin's settings and the status line to
`~/.claude/settings.json`, and only ever *adds* (details under
[Setup](#setup)):

```
/multiclaude:setup apply
```

**4. Install the delegate CLIs.** Their logins are interactive, so this part
is manual (skip what you already have):

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # first run authenticates
```

Run `/multiclaude:setup` once more; everything should be green. From then on,
start a task with `/multiclaude:orchestrate <task>` or let Claude pick the
skill up on its own.

## Commands

All of these print their output directly, with no model turn.

| Command | What it does |
|---|---|
| `/multiclaude:orchestrate [task]` | Loads the routing rules and runs the probe. Bare, it arms the rules for the next turn (and, in a chat with work under way, asks whether to split that work across the delegates now); with a task, it starts orchestrating. |
| `/delegates [settings]` | The Delegates pane: every dispatched job, live. |
| `/wallets` | The Wallets pane: every wallet's usage, refreshed while open. |
| `/multiclaude:quota` | One section per wallet: Codex, Claude, Antigravity. |
| `/multiclaude:usage [today\|7d\|30d\|all]` | Tokens and ≈ API spend per wallet, account and model. |
| `/multiclaude:failures [N] [--since 7d]` | What went wrong in failed runs and what to change. |
| `/multiclaude:scorecard [24h\|7d\|30d\|all]` | Graded runs per delegate and model, bake-offs, and the verdict on the trial delegate. |
| `/multiclaude:shadow [7d\|30d\|all] \| on \| off \| pair <id> \| rate <id> <grade> \| rules \| review [N]` | Shadow runs: pi repeats every agent's task for the record. Figures and ratings per pi model and rules version, one pair, your own rating of a run, the working rules, a review that gives verdicts and proposes rule changes. |
| `/multiclaude:probe` | Availability and today's band → model id table. |
| `/multiclaude:accounts …` | Several Claude logins pooled as one wallet. |
| `/multiclaude:setup [apply … \| companions]` | Environment check and converge; `companions` opens a menu to install or remove the optional companions. |
| `/multiclaude:help` | Help pane: commands, hotkeys, tools, bands, file locations. |

## Components

| Component | Role | Installed by |
|---|---|---|
| **Claude Code** | the host CLI that orchestrates | `npm i -g @anthropic-ai/claude-code` |
| **Node.js 18+** | runtime for Claude Code and every plugin script | your package manager |
| **`multiclaude`** plugin | everything above | marketplace add (quick start) |
| **`codex` CLI** (≥ 0.166) | the OpenAI delegate | manual (the `codex` plugin is optional) |
| **`agy` CLI** (≥ 1.4) | the Antigravity delegate | manual (the `agy` plugin is optional; multiclaude talks to the CLI directly) |
| **`pi` CLI** | optional trial delegate: a self-hosted or gateway model you want to test on coding tasks | manual; multiclaude uses the provider and models pi is already configured with |
| **`superpowers`** plugin | optional companion: workflow skills (brainstorming, plans, TDD) | `/multiclaude:setup companions` (or `apply --companions`) |
| **`claude-mem`** plugin | optional companion: cross-session memory | `/multiclaude:setup companions` (or `apply --companions`) |
| **`ccstatusline`** | optional companion: a configurable session line on top of our wallet rows | `/multiclaude:setup companions` (or `apply --ccstatusline`) |
| **`ccusage`** | Claude block cost in the quota readout | on demand via `bunx`/`npx` |

## Setup

`/multiclaude:setup` has two modes. `check` (the default) verifies and changes
nothing. `apply` adds what is missing to `~/.claude/settings.json` and then
verifies.

`apply` **only adds**. A value you already set is kept and listed as
`= kept yours`. Your marketplaces and your status line are never mixed with
ours, `permissions` and `model` are never touched, and every write is preceded
by a timestamped backup (`settings.json.multiclaude-<time>.bak`).

```
/multiclaude:setup apply --dry-run        # preview what would be added / kept
/multiclaude:setup apply                  # the multiclaude wiring + status line
/multiclaude:setup apply --no-statusline  # … without the status line
/multiclaude:setup apply --ccstatusline   # … with ccstatusline on top (see below)
/multiclaude:setup apply --companions     # + the optional companions superpowers and claude-mem
/multiclaude:setup apply --preferences    # + optional env / theme / effort defaults you lack
/multiclaude:setup apply --full           # --companions + --preferences
/multiclaude:setup apply --set env.X=1    # the only way to overwrite a value
```

The companions (superpowers, claude-mem, and ccstatusline for the status
line) are optional: nothing in multiclaude depends on them, and `setup` only
notes whether they are in use. After `--companions`, restart
Claude Code and they install on launch.

### Companions menu

`/multiclaude:setup companions` opens a pane that lists every optional
companion with its state, one line each:

- **superpowers** (workflow skills), **claude-mem** (memory), the **codex**
  and **agy** plugins (multiclaude talks to the CLIs directly; the plugins are
  extras), and **ccstatusline** (its configurable session line on top of our
  wallet rows).
- The row's **number** installs the companion when it is absent and removes it
  when it is present. **r** refreshes, **h** opens the help.

Plugins install and uninstall through the `claude plugin` CLI, so the
marketplace is added when needed and the change loads at the next Claude Code
start. Without a `claude` on PATH, install adds the plugin to
`settings.json` (Claude Code installs it at its next start) and remove
disables it there. ccstatusline installs as `apply --ccstatusline` does and
removes by putting our own status line back; its config file under
`~/.config/ccstatusline/` is left for you. Every write to `settings.json`
is preceded by a timestamped backup. The same works from the command line
where no pane can be placed:

```
/multiclaude:setup companions                  # the list, as text
node "<plugin>/scripts/setup.mjs" companions add claude-mem
node "<plugin>/scripts/setup.mjs" companions remove ccstatusline
```

### Status line

`apply` sets Claude Code's status line to a session line over the wallet
rows, with usage bars stretched to the terminal width:

```
Model: Mythos 5.1 | Ctx: 45.3k | main | (+33,-2)
Claude 5h ████░░░░░░░░ 20% 32m  wk ██████░░░░░░ 53% Thu 14:59  #2/2 auto | Codex wk ██░░░░░░░░░░ 16% Wed 13:28
Antigravity gem ████░░░░░░░░ 22% Sun 02:55  cl ██████████░░ 89% Sun 02:55  arg ██░░░░░░░░░░ 11% Tue 16:13
```

How to read it:

- **Line 1** is the session: model, context size, git branch, +insertions /
  -deletions.
- **Line 2** is Claude (5h window, weekly window, and the account pool when
  you have one) and Codex. **Line 3** is the Antigravity pools: gemini,
  claude, argon. On a narrow terminal each provider gets its own row.
- With pi installed, `pi ∞ $0.20 today · $1.35 7d` closes the last row when
  there is room (a shorter form, or nothing, when there is not): pi has no
  quota, so there is no bar, only what it spent.
- Every **%** is USED, coloured green → yellow → red. Every name and its bar
  has its own colour.
- A **5h window counts down** (`32m`); a **weekly window** names the weekday
  and hour it resets (`Thu 14:59`).
- Resizing the terminal re-lays it out.

The status line reads cached figures only, never the network. It points at a
small launcher in `~/.local/share/multiclaude/statusline.mjs`
(`%APPDATA%\multiclaude` on Windows) that follows the plugin across updates.
If you already have a status line, it is kept and setup prints the command to
run from it instead.

To hide the wallet rows without touching your settings, switch them off in
the Delegates settings (`/delegates settings`, 7); the session line stays.

**Companion: ccstatusline on top.** `apply --ccstatusline` puts
[ccstatusline](https://github.com/sirmalloc/ccstatusline) in charge of the
session line (configurable: `bunx ccstatusline` opens its editor) and adds our
wallet rows under it as custom-command widgets, from the config shipped in
`setup/ccstatusline.json`. An existing ccstatusline config keeps its widgets
and only gains ours; `setup` checks that they are there.

## How delegation runs

The orchestrate skill names **bands**, not model ids: `codex: mech / std /
hard / max` and `agy: opus / sonnet / gem-top / gem-hi / gem-med / gem-lo`.
`/multiclaude:probe` resolves them to today's ids from the live catalogs, so
nothing in the plugin names a model version.

Claude then calls the **`dispatch` tool** with `{ delegate: "agy" | "codex",
model, effort, edit, label, prompt }`. The tool returns a job id at once, the
plugin runs the CLI shell-free in the background, and wakes the chat with the
answer and one **proof line**:

```
[dispatch agy model=<id> status=SUCCESS tokens=14,196 (in 14,100/out 96/cached 0) dur=7.0s steps=1 calls=2 cost≈$0.03]
```

Every run carries a dollar figure when one is known: `cost=$…` is what the
provider billed, as the CLI reported it (pi through a gateway that reports
cost); `cost≈$…` is the run's tokens at API list price, a comparison figure
and never a bill (Codex and Antigravity run on subscriptions). A model with
no known price gets no figure. The job file and `runs.jsonl` carry the same
as `cost` and `costKind` (`reported` or `list`).

No proof line means the work did not leave Claude's quota. While a job runs,
the Delegates pane and the status line show provider · model · elapsed ·
current step. `dispatch_status({ id })` returns progress or the full answer,
`dispatch_cancel({ id })` stops a job (also a runner started from Bash or by a
forwarder agent: `dispatch.mjs --cancel <id>` does the same from a shell), and `dispatch_extend({ id, seconds })`
adds time (the chat is woken when a job passes 80 % of its timeout, and again
after each extension).

What the runner guarantees on every job:

- **Model check.** The id is validated against the live catalog; a wrong id is
  refused before anything runs.
- **Pool preflight (Antigravity).** The target pool is checked with
  `agy /usage` first. An empty pool is refused (`QUOTA preflight`) or the job
  switches to `fallback`. A run also stops at a token budget (`BUDGET`; 350k
  by default on the small claude pool).
- **Quota preflight (Codex).** When the Codex CLI has already refused a run
  for its usage limit ("try again at …"), or a window is full, the job is
  refused at once (`QUOTA preflight pool=codex until=…`) instead of failing
  two seconds into the run. The probe, the headroom line, the status line and
  the Wallets pane show Codex as exhausted until then, so the orchestrator
  routes its work to Antigravity.
- **Prompt header.** The exact model id for commit trailers (also
  `$MC_MODEL_ID` in the delegate's environment), a rule against editing
  `.env` or local config to make things pass, read-discipline rules for agy,
  and a rule to end with a self-contained report. Only that final report
  comes back; the narration is kept in `<job>.narration.md`.
- **Env guard.** `.env*` and `*.local*` files are hashed before and after; a
  change shows on the proof line as `envChanged=…`, since git diff does not
  show them.
- **Isolation.** `worktree: true` runs a job in its own git worktree, so
  parallel edit jobs never share a tree. A failed run reports what it left
  behind (`changed=N`).

Failures are classed so Claude can react: `QUOTA` re-routes to another
wallet, `CAPACITY` (provider overloaded) retries or picks another model,
`DENIED` means agy needed `edit: true`, `AUTH` means the CLI is signed out (run `agy`
in a terminal; the run stops at once instead of waiting out its timeout), `TOO_COMPLEX` / `PATCH_FAILED` carry
the CLI's own error text.

### Trial delegate: pi

When the `pi` CLI is installed, the probe lists it as a third delegate with
three bands (`lo` / `med` / `hi`: pi's default model at three reasoning
efforts — three model ids when the effort is part of the id, else one id run
with `pi --thinking low | medium | xhigh`). multiclaude reads pi's own model list at run time and holds no
provider, endpoint or model name of its own.

pi is on trial, so the rules are stricter than for Codex and Antigravity:

- **Small coding tasks only**, never the default route. The orchestrate skill
  (§10) says which tasks qualify.
- **Loop guard.** The runner stops a run that makes the same tool call three
  times with the same result (a re-read of a file that changed meanwhile, or
  the tests after a fix, does not count), gives the same reply twice, hits four tool errors in a row, or passes
  `maxSteps` or `maxTokens` when given (cached input counted at a tenth,
  roughly what it costs; neither has a default). Otherwise a pi run is bounded
  by its time limit, as Codex and AGY are: Claude is woken at 80% of it and
  extends a run that is making progress. Such a run ends as `status=LOOP`.
- **Checkpoints.** Every 8 tool steps (`checkpoint`) the chat is woken with
  the step count, tokens, files edited and the last transcript lines. Claude
  lets a converging run continue and cancels one that is going nowhere.
- **Nothing is accepted unjudged.** A pi result wakes the chat with the
  instruction to run the acceptance gates and record a verdict:
  `dispatch_grade({ id, grade: "pass" | "rework" | "fail", gates, note })`.
- **Rated against the others.** The same task can run on pi and on Codex or
  Antigravity, each in its own worktree; both are graded and linked with
  `vs`. Codex and Antigravity jobs can be graded too, as the baseline.
- **Read-only pi has no shell.** Without `edit: true` pi gets read, grep, find
  and ls only: it cannot run `git diff` or a test, so a review prompt has to
  carry the diff.

- **Every rating is kept.** A grade goes to the scorecard and, with the run
  it judges (task, answer, patch, steps) and the version of the working rules
  that run got, into the ratings record described under Shadow runs. Job
  files live 14 days; the ratings and the recorded runs stay.

`/multiclaude:scorecard` turns the grades into a verdict per model (see
Readouts). Once it says NOT VIABLE, Claude stops sending work to pi and says so.

### Shadow runs: tuning the prompts pi gets

A trial needs runs to judge, and hand-picked pi tasks come slowly. With shadows
on, **every agent that starts gets a pi run of the same task beside it**: a
`dispatch` to Codex or Antigravity, and every Claude subagent. The pi run is
the *shadow*. Its result is never used. Both ends are recorded as a pair, so
you can see where the self-hosted model gets stuck on real work and change the
**prompts** it gets: its working rules and the way tasks are written for it.
Nothing here trains a model.

```
/multiclaude:shadow on        # or /delegates settings → 8
```

Off by default: each shadow is a real pi run that costs what a pi run costs
and uses the model's serving capacity.

- **Which pi model.** The band that fits the agent's tier: `lo` beside a Haiku
  subagent or a low-effort / mini model, `hi` beside Opus-class or high-effort
  runs, `med` otherwise.
- **One at a time**, at most four waiting; a task text over 60k characters gets
  none. The real jobs keep their own six slots.
- **No shell.** A shadow reads, and edits when the real agent may edit.
- **Edits in a throwaway worktree**, detached, started at the commit `HEAD`
  had when the real agent started, removed after the run; paths in the task
  text are pointed at it. Outside a git repository, or beside a read-only
  agent, the shadow only reads. The real agent's uncommitted starting state
  is not in the worktree.
- **Silent.** No wake, no checkpoint, no grade, not on the scorecard, not in
  the failure log. In the Delegates pane it is one `◌ shadow · pi …` line
  under the job it runs beside.
- **pi has no sandbox**, so a write outside the worktree cannot be prevented,
  only caught: the runner stops such a run (`status=OUTSIDE`), names the file,
  and that one shadow does wake the chat so the file gets checked.

**What is recorded** (`~/.local/share/multiclaude/shadow/records.jsonl`, this
machine only, mode 0600, credentials scrubbed, 64 MB cap): for both sides the
task text, the answer, the files changed and the patch, status, time, tokens
and cost; for the shadow also every step — each model call with its time to
first token, duration, input / output / cached tokens, each tool call with
its arguments, duration and whether it failed — and the **version of the
working rules** it got. The file holds your code; treat it like the
repositories it came from.

**Every rating of a pi run is recorded** beside it (`ratings.jsonl`, same
folder, same rules), whoever gave it:

- Claude's grade of a pi job (`dispatch_grade`: pass / rework / fail, the
  gates it ran, its note). pi runs of their own are recorded like shadows —
  `MULTICLAUDE_PI_RECORD=off` keeps them out — so the rating stays attached to
  the run after the job file is gone.
- the verdict a review gives each pair it reads;
- your own: `/multiclaude:shadow rate <id> <pass|rework|fail> --note "…"`.

Each rating carries the pi model and the rules version, so the report shows
`rated 7: 4 pass · 2 rework · 1 fail` per rules version, and the next review
reads the ratings as given. Only `dispatch_grade` counts on the scorecard and
its trial verdict; a hand rating or a review verdict is for tuning.

**The loop.**

1. `/multiclaude:shadow` — per pi model × rules version: ok / stuck / failed,
   median steps, tokens, time, first-token time, share of the input served from
   cache, spend, the ratings, and time / tokens / files in common against the
   real agent.
2. `/multiclaude:shadow pair <id>` — both answers, the shadow's steps and its
   ratings; `rate` adds yours.
3. `/multiclaude:shadow review [N]` — one Antigravity job gives each unrated
   pair a verdict (recorded as a rating) and proposes rule lines. **The
   pairs' text goes to that provider.**
4. Put the rules you accept in `~/.config/multiclaude/pi-rules.md`, one
   `- rule` per line (30 at most). Every pi run gets them after the built-in
   ones (`/multiclaude:shadow rules` prints the set and its version).
5. A changed file is a new rules version: its row — ok, stuck, ratings —
   shows whether it helped.

*ok* and *stuck* are what the runner saw, not whether the answer was right;
that is what the ratings are for. Runner jobs started from
a shell get no shadow by themselves (`dispatch.mjs pi --shadow-of <job id>
--band <lo|med|hi> [--edit --worktree]` beside a run started with
`--reference` does it by hand).

The same runner works from a shell for batches and long jobs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" agy --model <id> [--edit] --job auto --out /tmp/result.md <<'EOF'
<task>
EOF
```

With `--job auto` the run shows in the Delegates pane and `dispatch_status`,
and `dispatch_cancel({ id })` or `dispatch.mjs --cancel <id>` stops it.

A resumed conversation (`claude -c`, `--resume`) can keep the tool list it
started with. After a plugin update it may still show Claude the old
`dispatch` tool, for example without `"pi"` or without `dispatch_grade`. The
orchestrate skill then sends the job through this runner. Start a new
conversation to get the current tools.

A read-only Antigravity job runs its git commands in the job's working
directory and cannot run `git -C <path>`. To review a worktree or another
checkout, pass `cwd` to `dispatch` (runner: `--cd <path>`).

## The panes

### `/delegates`

Opens by itself when orchestration is asked for (`/multiclaude:orchestrate`,
or Claude loading the skill) and when a job is dispatched. One row per job, coloured by model family: Codex green, Claude
orange (mythos red, fable red-orange, opus / sonnet / haiku in lighter
shades), Gemini blue (pro / flash /
lite), Argon violet, pi coral. A row shows the label, model, a one-line prompt summary,
then the current step while running or the result and the answer's first line
when finished.

- a row's **number** opens the job: answer as Markdown, proof line,
  transcript tail, **x** cancel / **e** +5 min while it runs
- **c** clears finished jobs
- **t** opens the scorecard: per delegate and model the runs, ok / stuck /
  fail, the grades, median time and tokens, cost, and the trial verdict;
  **p** changes the period (7d / 30d / all)
- **s** (or `/delegates settings`) opens the settings: open when orchestration
  starts, open on every dispatch, close when idle (never / 30 s / 2 min /
  10 min), all jobs or only recent ones, live lines per running job, show
  Claude subagents, wallet rows in the status line (on / off; the status
  line follows at its next redraw), shadow every agent with pi (off by
  default; see Shadow runs)

Finished rows end with their dollar figure (`$` billed, `≈$` at API list
price), and the pane sums the rows it lists.
Claude subagents (the Agent tool) get a row too, labelled `·<agent type>`
and priced from their transcript at list price,
with their current tool call as the step. They are never double-counted: a
subagent that calls `dispatch` folds into that job's row. Settings persist
across sessions. Auto-close never closes a pane that has focus or one you
opened yourself before any job ended.

### `/wallets`

A live view refreshed every 30 s while open (**r** refreshes now): the Claude
pool and each stored account (5h and weekly meters, reset times, a number key
to switch), the Codex windows, each Antigravity pool, pi (an ∞ bar in its logo colours, with its spend
today and over 7 days, when installed), and a **Usage** section
with tokens and ≈ API spend per wallet, account and model (top 10). **p**
cycles the period (today / 7d / 30d / all), **i** switches between combined
and split (input · cached · output). Every % is USED.

### `/multiclaude:setup companions`

The companions menu: each optional companion with its state and a number key
that installs or removes it. See [Companions menu](#companions-menu).

### `/multiclaude:help`

Every command with its arguments, the pane hotkeys, the tools the model
calls, the bands, the status line and where the files live. **d** / **w**
open Delegates / Wallets from it, and **h** in either pane opens the help. (A
bare `/help` is Claude Code's own, so this one keeps the prefix.)

## Readouts

### Quota (`/multiclaude:quota`)

One section per wallet, each a 10-cell bar per metered window plus detail. A
window with no readable percentage shows an empty bar and `n/a` with a note;
each source degrades on its own.

- **Codex**: 5-hour and weekly % used with reset times, plan and latest
  session tokens, parsed from the newest `~/.codex/sessions` snapshot. Local,
  no API call.
- **Claude**: the official 5-hour and weekly utilization (the numbers Claude
  Code's `/usage` shows), read from the same first-party endpoint with the
  OAuth token Claude Code stores. The token only ever goes to
  `api.anthropic.com`. Plus per-model weekly, plan and extra-usage credits,
  and cost / tokens / burn / projection from `ccusage`. Offline or with an
  expired token it falls back to a clearly labelled elapsed-time bar.
- **Antigravity**: real per-pool quota from the CLI's own `/usage` command
  (zero token cost): the **gemini** pool (Flash + Pro), the **claude** pool
  (Opus / Sonnet + GPT-OSS) and, on paid plans, the **argon** bucket, each
  with 5-hour and weekly bars, reset times and the resolved model tiers. If
  the CLI is offline it falls back to the reactive 429-log status.
- **pi** (when installed, or run this week): no quota, so the bar reads ∞.
  Shown instead: runs, tokens and spend today and over the last 7 days, from
  the run log. `$` is what the provider reported per run; `≈` marks a sum
  that includes runs priced at list price.

### Usage (`/multiclaude:usage`)

Counts the tokens each wallet has spent from what the CLIs already recorded,
so history from before the plugin was installed counts too:

- **Claude**: the transcripts in `~/.claude/projects` and each `accounts`
  session profile, one row per API response, deduplicated. Default-login
  usage is attributed by the account switch log; older default-login history
  shows as "unattributed".
- **Codex**: the token counts in `~/.codex/sessions`.
- **Antigravity**: the runner's job files only (agy's own store is not
  readable), so runs made outside `dispatch.mjs` are missing.
- **pi**: the runner's job files as well, with the cost pi reported for the
  run when the model has no list price.

`node "<plugin>/scripts/price.mjs" <transcript.jsonl>…` prices single Claude
transcripts (a subagent's `agent-*.jsonl`, a session file) the same way and
prints JSON: tokens and ≈ USD per file and per model. `price.mjs --usage '<json>'`
prices token counts directly (`{ model, input_tokens, output_tokens,
cache_read_input_tokens, cache_creation_input_tokens }`).

Scans are incremental (state in `~/.cache/multiclaude/tracker.json`); the
first one reads the whole history, a few seconds per GB. "≈ API $" prices
tokens at API list prices from the LiteLLM table (cached daily). It is a
comparison figure, not a bill. `MULTICLAUDE_PRICES=off` stops the daily
fetch (the cached table and your overrides still price). Add a price the table lacks in
`~/.config/multiclaude/prices.json`, in USD per million tokens:
`{"model-id": {"in": 1, "out": 5}}`; a key ending in `*` matches by prefix.

### Scorecard (`/multiclaude:scorecard`)

Every finished run is logged in `~/.cache/multiclaude/runs.jsonl` (delegate,
model, status, tokens, time, steps, cost) and every verdict in
`grades.jsonl`. The scorecard joins the two: per delegate and model the
runs, pass / rework / fail, the share of runs that got stuck (loop, timeout,
stopped), mean tokens, time and cost, and the bake-offs with who won.
Infrastructure failures (quota, capacity, a failed start) count for nobody.

A trial model gets a verdict:

| Verdict | Rule |
|---|---|
| UNDECIDED | fewer than 5 graded runs |
| VIABLE | at least 70 % pass and at most 15 % stuck |
| MARGINAL | at least 70 % pass or rework and at most 30 % stuck |
| NOT VIABLE | anything below that |

The probe prints the verdict next to the pi bands, so every orchestrated
session starts with it. A run can be graded by hand as well:
`node scripts/scorecard.mjs grade <job> <pass|rework|fail> --note "…"`.

A run through a gateway that reports its cost shows that cost (`billed $…`).
A run with no reported cost is priced at list price (`≈ $… at list price`);
for a model with no list price, add a comparison price in
`~/.config/multiclaude/prices.json` (see Usage).

### Failures (`/multiclaude:failures`)

Summarizes the runner's failure log (`~/.cache/multiclaude/failures.jsonl`,
one line per run that did not succeed): failures by status and model, the
denied actions, and the usual cause of each status with what to change in the
next prompt. `/multiclaude:failures review` dispatches an Antigravity job that
reads the log against the orchestrate rules and proposes rule edits. A failed
dispatch's wake message points at the log.

## Several Claude accounts, one wallet

`/multiclaude:accounts` pools several Claude Code logins into one Claude
wallet (a Node port of the core of
[claude-swap](https://github.com/realiti4/claude-swap), MIT). Log in with each
account in turn and run `/multiclaude:accounts add`. **Do not `/logout` in
between**: logging out can revoke the token you just stored.

- `/multiclaude:accounts` lists every account's official 5h / 7d / per-model
  usage, plus the pool line (mean used % across accounts).
- `/multiclaude:accounts switch <num|email|alias>` moves the default login.
  Running sessions pick it up on their next credential read.
- **Auto-switch is off by default**, because a switch moves the login of
  every running session. `/multiclaude:accounts config set auto.enabled true`
  turns it on. Every 60 s it balances the accounts' weeks: the login moves to
  the account that is furthest behind an even weekly pace (weekly used % minus
  the share of its week that has gone by), so quota about to expire is used
  first and no account is used up days before its reset while another sits
  unused. When the active account reaches a line (default 90 % of its 5h or
  weekly window) the login moves to one that is under its lines. Tune with
  `auto.balanceGap 15`, `auto.threshold 85`, `auto.strategy best` (switch
  only at the line), …
- `node <plugin>/scripts/accounts.mjs run 2` (in a terminal) starts Claude
  Code as account 2 in that terminal only, with your settings, skills and
  plugins.

The headroom line then reads `CLAUDE pool of N acct …`, and the orchestrator
treats the pool as one wallet.

**Where the login lives.** Linux and WSL keep it in
`~/.claude/.credentials.json`. Windows keeps it there too, or, once Claude
Code's Credential Manager rollout reaches you, in Windows Credential Manager;
`accounts` follows Claude Code's choice and uses the same entry through
PowerShell. `accounts status` prints which store is in use. The macOS Keychain
is not supported.

**The Claude desktop app is different.** It hands Claude Code its login
through the environment and Claude Code stores nothing, so there is no token
for `accounts` to store or swap. In the app, `accounts status` says so and
`add` refuses with that reason. Change the account there with the app's own
sign-out / sign-in; pool your accounts with `claude` in a terminal or the VS
Code extension.

## Per-project opt-out

For projects whose code must not leave for OpenAI or Google, add to the
project `CLAUDE.md`:

```
orchestrate: off
```

## Manual install and updating

**Without the interactive `/plugin` command**, add the marketplace and enable
the plugin in `~/.claude/settings.json`, then restart:

```json
"extraKnownMarketplaces": {
  "multiclaude": { "source": { "source": "github", "repo": "SomeCodecat/multiclaude" } }
},
"enabledPlugins": {
  "multiclaude@multiclaude": true
}
```

Then follow the quick start from step 2.

**Updating** when this repo ships a new version:

```
/plugin marketplace update multiclaude
/plugin update multiclaude@multiclaude
```

Restart Claude Code; `/multiclaude:quota` shows the new version.

**An update that fails on `git@github.com`** (no GitHub SSH key, e.g. a fresh WSL
distro): the marketplace was registered over SSH. Either rewrite GitHub SSH URLs to
https once:

```
git config --global url."https://github.com/".insteadOf git@github.com:
```

or register it by its https URL: `/plugin marketplace add https://github.com/SomeCodecat/multiclaude.git`.

**herdr.** Inside herdr multiclaude steps aside (no pane opens by
itself, no wallet rows) and can publish live agent activity for a herdr-app mod
(`herdr-mascots` in `/multiclaude:setup companions`; contract: `docs/herdr-mascots.md`).
Every chat inside herdr also keeps an inbox card for herdr's Inbox window — its last prompt,
what the last turn answered, and what it waits on from you (a question, a permission, a plan) —
as `mc-inbox-<terminal>` (on by default, `MULTICLAUDE_INBOX=0` turns it off; contract: `docs/herdr-inbox.md`).
Claude Code in **WSL under a Windows herdr** needs herdr's variables forwarded:
`/multiclaude:setup apply` on Windows adds `HC_TERMINAL_SOCKET/u:HC_TERMINAL_ID/u:HC_SCOPE/u`
to your user `WSLENV`; restart herdr.

## References

[`docs/references.md`](docs/references.md) lists projects multiclaude borrowed
from or used to rely on, with features worth copying. For example
[ccstatusline](https://github.com/sirmalloc/ccstatusline) is no longer a
requirement, since multiclaude has its own status line and panes; it stays an
optional extra (`setup apply --ccstatusline`).
