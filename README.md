# multiclaude

My reproducible multi-agent Claude Code setup. **Claude Code orchestrates; Codex
(OpenAI) and AGY (Antigravity CLI) do the heavy lifting; Claude's own quota is
spent last.** Full design: `docs/superpowers/specs/`.

## Components

| Component | What it is | How it installs |
|---|---|---|
| **Claude Code** | the host CLI that orchestrates | `npm i -g @anthropic-ai/claude-code` |
| **Node.js 18+** | runtime for Claude Code *and* every plugin script (pure Node, no bash/python3) | your package manager / nodejs.org |
| **`multiclaude` plugin** | orchestration skill, the native `dispatch` tool + `/delegates` pane, `/multiclaude:quota`, `/multiclaude:setup`, `/multiclaude:probe` (all three print their script output directly, no model turn), wallet-headroom hooks | **marketplace add (below)** |
| **`superpowers`** plugin | skills framework the orchestrate skill builds on | `/multiclaude:setup apply --full` |
| **`claude-mem`** plugin | cross-session memory | `/multiclaude:setup apply --full` |
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

`/multiclaude:setup` prints a checklist with an exact `fix:` line for anything
missing — Node, `bunx`/`npx`, the companion plugins, the wallet-headroom hook,
`ccusage` reachability, and the codex/agy CLIs + logins.

### Pull in the companion plugins automatically

`multiclaude` builds on `superpowers` (skills framework) and `claude-mem`
(memory). Have Claude run setup in **apply** mode to merge their marketplaces +
plugins — plus the model/theme/env defaults — into your `~/.claude/settings.json`
non-destructively (it backs up to `settings.json.bak` and never clobbers keys it
doesn't manage):

```
/multiclaude:setup apply --full      # merge the whole template
/multiclaude:setup apply --dry-run   # preview the diff first
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
it runs. The same runner works from a shell for batches and long jobs:

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

## Per-project opt-out

Projects whose code must not leave for OpenAI/Google: add to the project
`CLAUDE.md`:

```
orchestrate: off
```
