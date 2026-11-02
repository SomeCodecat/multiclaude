---
name: setup
description: Verify or converge the multiclaude orchestration environment in one shot — codex + agy CLIs (installed AND authenticated), node + bunx/npx for the usage readout, companion plugins (superpowers, claude-mem), the wallet-headroom hook, and ccusage reachability. `check` verifies and prints the exact fix for anything missing; `apply` only ADDS missing settings (never changes a value the user set; timestamped backup). Run once after installing the plugin, or whenever a delegate/usage feature misbehaves.
---

# Setup

One-shot, idempotent setup for everything `orchestrate` (§0) and `usage` depend
on. Pure Node — runs the same on Linux, macOS, and Windows; no bash/python3.

Typed as `/multiclaude:setup`, the plugin's hooks module runs the script and
prints its output directly, with no model turn (arguments pass through).
Otherwise run the bundled script and show its output to the user **verbatim** — it is
preformatted (a checklist with `fix:` lines); do not summarize or reformat:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
```

## Two modes

- **`check`** (default) — verify everything; **change nothing**; print the exact
  fix for anything missing.
- **`apply`** — ADD what is missing to `~/.claude/settings.json`, then verify:
  - **add-only**: a key the user already has is kept and reported as
    `= kept yours`; it is never overwritten. A marketplace entry and
    `statusLine` are kept whole, never mixed with ours. A multiclaude
    marketplace under any name or source (e.g. a local folder) counts as present.
  - a timestamped backup (`settings.json.multiclaude-<time>.bak`) before every
    write; the write itself is atomic.
  - never touched: `permissions`, `model`, and any key outside the chosen scope.
  - warms the ccusage cache.

Scopes — the default is the multiclaude wiring alone; everything else is opt-in.
Always offer `--dry-run` first and apply only what the user agrees to:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --dry-run       # list what WOULD be added / kept
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply                 # multiclaude's own wiring only
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --companions    # + superpowers, claude-mem, codex, agy plugins
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --preferences   # + setup/preferences.json keys the user lacks
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --full          # --companions + --preferences
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --set env.X=1   # the ONLY way to overwrite a value
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --ttl 600       # shortcut for --set env.MULTICLAUDE_USAGE_TTL
```

Re-running reports "no change" once everything selected is present.

## First run

Installing the plugin changes nothing in the user's settings. Until
`/multiclaude:setup` has run once, each session shows a one-time notice saying
so. Accounts auto-switch is off by default (see `/multiclaude:accounts`).

## What it checks

- **Core runtime:** `node` (the script itself) and `bunx`/`npx` — the only
  backend `/multiclaude:quota` needs (for the Claude-block `ccusage` call).
- **Plugin scripts:** `probe.mjs`, `usage-snapshot.mjs`, `quota.mjs`, and the
  shared `lib/*.mjs` all present.
- **Codex:** CLI installed and logged in (edit / implementation tasks).
- **AGY:** CLI installed and authenticated (`agy models` reachable).
- **Companion plugins:** `superpowers` and `claude-mem` enabled (orchestrate §0).
- **ccusage:** reachable through `bunx`/`npx` for the Claude-block readout.
- **Wallet-headroom hook:** `hooks/hooks.json` present and
  `scripts/usage-snapshot.mjs` runnable (orchestrate §0/§5).

Anything missing prints a `fix:` line with the exact command. Config gaps
(plugins) are fixed by `setup.mjs apply --companions`; CLI installs/logins can't
be automated, so those print the command for you to run. The templates ship with
the plugin: `${CLAUDE_PLUGIN_ROOT}/setup/settings.json` (plugin wiring) and
`${CLAUDE_PLUGIN_ROOT}/setup/preferences.json` (optional env / statusLine /
theme / effort defaults, used only with `--preferences`).
