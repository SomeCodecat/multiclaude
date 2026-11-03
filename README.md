# multiclaude

My reproducible multi-agent Claude Code setup. **Claude Code orchestrates; Codex
(OpenAI) and AGY (Antigravity CLI) do the heavy lifting; Claude's own quota is
spent last.** Full design: `docs/superpowers/specs/`.

## Components

| Component | What it is | How it installs |
|---|---|---|
| **Claude Code** | the host CLI that orchestrates | `npm i -g @anthropic-ai/claude-code` |
| **Node.js 18+** | runtime for Claude Code *and* every plugin script (pure Node, no bash/python3) | your package manager / nodejs.org |
| **`multiclaude` plugin** | orchestration skill, the native `dispatch` tool + `/delegates` and `/wallets` panes, `/multiclaude:quota`, `/multiclaude:setup`, `/multiclaude:probe` (all three print their script output directly, no model turn), wallet-headroom hooks | **marketplace add (below)** |
| **`superpowers`** plugin | skills framework the orchestrate skill builds on | `/multiclaude:setup apply --companions` |
| **`claude-mem`** plugin | cross-session memory | `/multiclaude:setup apply --companions` |
| **`codex` CLI** (≥ 0.166) | OpenAI delegate (edits/implementation) | **manual** (the openai `codex` plugin is optional) |
| **`agy` CLI** (≥ 1.4) | Antigravity delegate: Gemini + Claude tiers on their own quota | **manual** (the iicmaster `agy` plugin is optional — multiclaude talks to the CLI directly) |
| **`ccusage` / `ccstatusline`** | Claude block cost + status line (via `bunx`/`npx`) | auto on demand |

## Install

You need Claude Code (and Node 18+) already on the machine. Then, inside Claude
Code, add this repo as a marketplace and install the plugin:

```
/plugin marketplace add SomeCodecat/multiclaude
/plugin install multiclaude@multiclaude
```

That's the whole plugin. Restart Claude Code so its skills and hooks load, then
verify and wire up the rest in one shot:

```
/multiclaude:setup
```

Installing the plugin changes nothing in your settings, and `/multiclaude:setup`
on its own only reads. Until you have run it once, each session shows a short
notice saying so.

`/multiclaude:setup` prints a checklist with an exact `fix:` line for anything
missing — Node, `bunx`/`npx`, the companion plugins, the wallet-headroom hook,
`ccusage` reachability, and the codex/agy CLIs + logins.

### Pull in the companion plugins automatically

`multiclaude` builds on `superpowers` (skills framework) and `claude-mem`
(memory). `apply` **only adds** to `~/.claude/settings.json`: a value you already
set is kept and listed as `= kept yours`, your marketplaces and status line are
never mixed with ours, `permissions` and `model` are never touched, and every
write is preceded by a timestamped backup (`settings.json.multiclaude-<time>.bak`).

```
/multiclaude:setup apply --dry-run                 # preview: what would be added / kept
/multiclaude:setup apply --companions              # add the companion plugins + marketplaces
/multiclaude:setup apply --preferences             # optional env/statusLine/theme defaults you lack
/multiclaude:setup apply --full                    # both
/multiclaude:setup apply --set env.X=1             # the only way to overwrite a value
```

Restart Claude Code and the companion plugins install on launch. Re-run
`/multiclaude:setup` to confirm everything is green.

### Install the delegate CLIs

The codex/agy **plugins** come in via setup, but their **CLIs** need interactive
logins that can't be automated (skip any you already have):

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # first run authenticates
```

Re-run `/multiclaude:setup` — it should now report codex and agy installed and
authenticated.

## Manual install (no interactive `/plugin`)

Prefer editing config directly? Add the marketplace and enable the plugin in
`~/.claude/settings.json`, then restart.

Into `extraKnownMarketplaces`:

```json
"multiclaude": {
  "source": { "source": "github", "repo": "SomeCodecat/multiclaude" }
}
```

Into `enabledPlugins`:

```json
"multiclaude@multiclaude": true
```

The marketplace + plugin install on next launch; then follow the
`/multiclaude:setup` steps above for the companions and CLIs.

## Updating

When this repo ships a new version, update from inside Claude Code:

```
/plugin marketplace update multiclaude
/plugin update multiclaude@multiclaude
```

Restart Claude Code, then `/multiclaude:quota` should show the new version.

## How delegation runs

The plugin ships a hooks module that registers a native **`dispatch` tool**
(`mcp__multiclaude__dispatch`) and a **Delegates pane** (`/delegates`). Claude
calls the tool with `{ delegate: "agy" | "codex", model, effort, edit, label,
prompt }`; the plugin runs `scripts/dispatch.mjs`, which validates the model id
against the live catalog, runs the CLI shell-free, parses its JSON stream, and
returns the answer plus one proof line:

```
[dispatch agy model=gemini-3.8-flash-medium status=SUCCESS tokens=14,196 (in 14,100/out 96/cached 0) dur=7.0s steps=1 calls=2]
```

Guards for the AGY pools: before an agy job starts, the runner checks the
target pool with `agy /usage` and refuses (`QUOTA preflight`) or switches to
`fallback` when it is empty. It prepends read-discipline rules to the prompt
and stops a run at a token budget (`BUDGET`; 350k by default on the small
claude pool). `worktree: true` runs a job in its own git worktree, so parallel
edit jobs never share a tree. A failed run reports what it left in the tree
(`changed=N`).

Every prompt also gets a short header: the exact model id to use in commit
trailers (also `$MC_MODEL_ID` in the delegate's environment), a rule against
editing `.env` or local config to make things pass, and a rule to end with a
self-contained report. On success only that final report comes back; the
progress narration is kept in `<job>.narration.md`. `.env*` and `*.local*`
files are hashed before and after each run, and any change shows on the proof
line as `envChanged=…`, since git diff does not show them. A job that passes
80% of its timeout wakes the chat once, and `dispatch_extend({ id, seconds })`
adds time.

No Claude subagent is involved, so a dispatch costs zero driver tokens; the
pane and the status line show provider · model · elapsed · current step while
it runs.

### The panes

- **`/delegates`** opens the Delegates pane. It also opens by itself when the
  orchestrate skill loads and when a job is dispatched. Each job is one row,
  coloured by model family: Codex green, Claude orange (opus / sonnet / haiku
  in lighter shades), Gemini blue (pro / flash / lite), Argon violet. Each
  job shows its label, model, a one-line summary of the prompt, and then
  either its current step (running) or its result and the answer's first
  line (finished).
  - Press a row's number to open that job: its answer as Markdown, the proof
    line, the transcript tail, and **x** cancel / **e** +5 min while it runs.
  - **c** clears the finished jobs.
  - **s** (or `/delegates settings`) opens the settings:
    - open when orchestration starts
    - open on every dispatch
    - close when idle (never / 30 s / 2 min / 10 min)
    - all jobs or only recent ones
    - live lines per running job

  Settings are kept across sessions. Auto-close never closes a pane that has
  focus, and never one you opened yourself before any job ended.
- **`/wallets`** opens a live wallet view, refreshed every 30 s while it is
  open (**r** refreshes now):
  - the Claude pool and each stored account (5h and weekly meters, reset
    times, and a number key to switch account)
  - the Codex windows
  - each AGY pool

  Every % in it is USED, not remaining.

The same runner works from a shell for batches and long jobs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" agy --model <id> [--edit] --out /tmp/result.md <<'EOF'
<task>
EOF
```

Model **bands** (`codex: mech / std / hard / max`, `agy: opus / sonnet /
gem-top / gem-hi / gem-med / gem-lo`) are resolved from the live catalogs by
`scripts/probe.mjs` — nothing in the plugin names a model version.

## The quota readout

`/multiclaude:quota` renders one section per wallet, each with the same
skeleton — one 10-cell bar per metered window, then indented detail. A window
with no readable percentage shows an empty bar + `n/a` + a note; a window at
its cap shows a full bar + reset countdown. Each source degrades independently.

- **CODEX** — primary (5-hour) and secondary (weekly) rate-limit % used with
  reset times, plus plan and latest-session tokens. Parsed from the newest
  `~/.codex/sessions/**/*.jsonl` `rate_limits` snapshot — local, no API call.
- **CLAUDE (orchestrator)** — the **official** 5-hour + weekly utilization %
  (the exact numbers Claude Code's `/usage` shows), read from the same
  first-party endpoint (`GET …/api/oauth/usage`) with the OAuth token Claude
  Code stores at `~/.claude/.credentials.json`; the token only ever goes to
  `api.anthropic.com`. Per-model weekly, plan, and extra-usage credits as a
  sub-line, then cost/tokens/burn/projection from `ccusage` (a separate
  `bunx`/`npx` call). Needs network; if the endpoint is unavailable (offline,
  expired token, macOS Keychain creds) it falls back to a clearly-labelled
  elapsed-time bar so it's never mistaken for the real %.
- **AGY** — real per-pool quota from the CLI's own `/usage` command
  (`agy -p /usage --output-format json`, zero token cost): the **gemini** pool
  (Gemini Flash + Pro), the **claude** pool (Claude Opus/Sonnet + GPT-OSS) and,
  on paid plans, a separate **argon** bucket (Gemini 4 Argon) — each with a
  5-hour and a weekly bar + reset countdown, plus the resolved model tiers. If
  the CLI is offline or not logged in it falls back to the reactive 429-log
  status (clearly labelled). The backend RPCs are still not used: see the
  NOTE in `scripts/lib/wallets.mjs`.

## Several Claude accounts (one wallet)

`/multiclaude:accounts` pools several Claude Code logins into **one Claude
wallet** (a Node port of the core of
[claude-swap](https://github.com/realiti4/claude-swap), MIT). Log in with each
account in turn and run `/multiclaude:accounts add`. **Do not `/logout` in
between**: logging out can revoke the token you just stored. After that:

- `/multiclaude:accounts` lists every account's official 5h / 7d / per-model
  usage, plus the pool line (the mean used % across accounts).
- `/multiclaude:accounts switch <num|email|alias>` moves the default login.
  Running Claude Code picks it up on its next credential read.
- Auto-switch is **off by default**, because a switch moves the default login of
  every running Claude Code session. Turn it on with
  `/multiclaude:accounts config set auto.enabled true`. It then runs inside
  Claude Code every 60 s: when the active account reaches its line (default 90%),
  the login moves to the account with the most room. Tune it with
  `auto.threshold 85`, `auto.strategy consume-first`, …
- `node <plugin>/scripts/accounts.mjs run 2` (in a terminal) starts Claude Code
  as account 2 in that terminal only, with your settings, skills and plugins.

The wallet-headroom line then reads `CLAUDE pool of N acct …`, and the
orchestrator treats the pool as one Claude wallet (orchestrate §5). The macOS
Keychain is not supported; Linux, WSL and Windows keep credentials in
`~/.claude/.credentials.json`.

## Per-project opt-out

Projects whose code must not leave for OpenAI/Google: add to the project
`CLAUDE.md`:

```
orchestrate: off
```
