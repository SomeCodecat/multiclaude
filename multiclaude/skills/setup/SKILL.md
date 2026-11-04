---
name: setup
description: Verify or converge the multiclaude orchestration environment in one shot — codex + agy CLIs (installed AND authenticated), node + bunx/npx for the usage readout, the optional companion plugins (superpowers, claude-mem), the wallet-headroom hook, and ccusage reachability. `check` verifies and prints the exact fix for anything missing; `apply` only ADDS missing settings (never changes a value the user set; timestamped backup); `companions` is the menu to install or remove the optional companions. Run once after installing the plugin, or whenever a delegate/usage feature misbehaves.
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

## Three modes

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
  - **the status line:** adds `statusLine` → `node "<data dir>/multiclaude/statusline.mjs" --session`
    when the user has none (a status line of their own is kept and the
    widget commands to embed ours are printed; one of ours from an older
    setup is refreshed). The launcher is written to
    `~/.local/share/multiclaude/` (`%APPDATA%\multiclaude\` on Windows); it
    finds the current plugin install, which moves with every update, and
    runs `usage-snapshot.mjs --statusline`: a session line (model, context
    size, git branch and changes, from the JSON Claude Code pipes in) over
    the wallet rows — usage bars stretched to the terminal width, Claude and
    Codex on top, Antigravity below (one row per provider on a narrow terminal); cached
    headroom, never the network. `--no-statusline` skips it.
  - **`--ccstatusline`** (optional companion): sets `statusLine` to
    `bunx -y ccstatusline@latest` (`npx` fallback) instead — replacing ours,
    never a foreign one — and gives ccstatusline our wallet rows: when
    `~/.config/ccstatusline/settings.json` is missing it is written from
    `setup/ccstatusline.json` (its session line, then one custom-command
    widget per row); an existing config keeps every widget and gains ours
    (an older single widget of ours is replaced; timestamped backup).
  - warms the ccusage cache.
- **`companions`** — the optional extras, one at a time. Typed as
  `/multiclaude:setup companions` the hooks module opens a pane: superpowers,
  claude-mem, the codex and agy plugins and ccstatusline, each with its state
  and a number key that installs it when absent or removes it when present
  (`r` refresh, `h` help). The script behind it:
  - `companions [--json]` lists them; `companions add <name>` /
    `companions remove <name>` act on one.
  - plugins go through `claude plugin install | enable | uninstall` (the
    marketplace is added first when it is unknown); the change loads at the next
    Claude Code start. With no `claude` on PATH, add puts the plugin into
    `settings.json` add-only (Claude Code installs it at its next start) and
    remove sets it to `false` there.
  - ccstatusline: add runs `apply --ccstatusline`; remove sets `statusLine`
    back to ours (the launcher is written if missing) and leaves
    `~/.config/ccstatusline/settings.json` alone.
  - every `settings.json` write has a timestamped backup, as `apply`.

Scopes — the default is the multiclaude wiring alone; everything else is opt-in.
Always offer `--dry-run` first and apply only what the user agrees to:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --dry-run       # list what WOULD be added / kept
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply                 # multiclaude's own wiring + status line
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --no-statusline # … without the status line
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --ccstatusline   # … with the ccstatusline companion on top, our wallet rows under it
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --companions    # + the optional companions: superpowers, claude-mem, codex, agy plugins
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --preferences   # + setup/preferences.json keys the user lacks
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --full          # --companions + --preferences
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --set env.X=1   # the ONLY way to overwrite a value
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --ttl 600       # shortcut for --set env.MULTICLAUDE_USAGE_TTL
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" companions [--json]   # the companions and their state (the menu's data)
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" companions add <name>     # install one: superpowers | claude-mem | codex | agy | ccstatusline
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" companions remove <name>  # remove one
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
- **Companions (optional):** whether `superpowers` (workflow skills) and
  `claude-mem` (cross-session memory) are enabled, and whether ccstatusline is
  on top of the status line. Informational: nothing in multiclaude needs them,
  so a missing one is a note, not a failure.
- **ccusage:** reachable through `bunx`/`npx` for the Claude-block readout.
- **Wallet-headroom hook:** `hooks/hooks.json` present and
  `scripts/usage-snapshot.mjs` runnable (orchestrate §0/§5).
- **Status line:** `statusLine` is ours and the launcher prints the wallet
  rows, or it is ccstatusline and its config carries our row widgets
  (`fix: setup apply --ccstatusline` otherwise). None set → `fix: setup apply`;
  one of the user's own → noted and kept, with the widget commands to embed ours.
  Wallet rows switched off in the Delegates settings (7) are noted too: the
  script then prints the session line only, the flag being
  `~/.cache/multiclaude/statusline.off`.

Anything missing prints a `fix:` line with the exact command. Config gaps
(plugins, status line) are fixed by `setup.mjs apply` (plugins: `--companions`, or one at a time with `companions add`); CLI installs/logins can't
be automated, so those print the command for you to run. The templates ship with
the plugin: `${CLAUDE_PLUGIN_ROOT}/setup/settings.json` (plugin wiring) and
`${CLAUDE_PLUGIN_ROOT}/setup/preferences.json` (optional env /
theme / effort defaults, used only with `--preferences`) and
`${CLAUDE_PLUGIN_ROOT}/setup/ccstatusline.json` (the ccstatusline layout, used
only with `--ccstatusline`).
