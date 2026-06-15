---
name: setup
description: Verify or converge the multiclaude orchestration environment in one shot — codex + agy CLIs (installed AND authenticated), node + bunx/npx for the usage readout, companion plugins (superpowers, claude-mem), the wallet-headroom hook, and ccusage reachability. `check` verifies and prints the exact fix for anything missing; `apply` idempotently merges the desired settings.json. Run once after installing the plugin, or whenever a delegate/usage feature misbehaves.
---

# Setup

One-shot, idempotent setup for everything `orchestrate` (§0) and `usage` depend
on. Pure Node — runs the same on Linux, macOS, and Windows; no bash/python3.

Run the bundled script and show its output to the user **verbatim** — it is
preformatted (a checklist with `fix:` lines); do not summarize or reformat:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
```

## Two modes

- **`check`** (default) — verify everything; **change nothing**; print the exact
  fix for anything missing.
- **`apply`** — converge local config to the desired state, then verify:
  - deep-merge the desired-state template (`setup/settings.json`) into
    `~/.claude/settings.json` (backs up to `.bak` first; never clobbers keys it
    doesn't manage), and
  - warm the ccusage cache.

Re-running converges to the same state and reports "no change" once applied:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply              # enable the plugin wiring
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --full       # apply the WHOLE template (model/theme/env/…)
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --set model=opus --set env.X=1   # set any dotted key (JSON or string)
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --ttl 600     # shortcut for env.MULTICLAUDE_USAGE_TTL
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply --dry-run     # show the diff that WOULD be written
```

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
(plugins, hook wiring) are fixed by `setup.mjs apply`; CLI installs/logins can't
be automated, so those print the command for you to run. The desired-state
template ships with the plugin at `${CLAUDE_PLUGIN_ROOT}/setup/settings.json` —
edit it to change the defaults `apply` converges to.
