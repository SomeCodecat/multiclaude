---
name: setup
description: Verify the multiclaude orchestration environment in one shot — codex + agy CLIs (installed AND authenticated), python3/find/node for the usage readout, companion plugins (superpowers, claude-mem), the wallet-headroom hook, and ccusage reachability. Run once after installing the plugin, or whenever a delegate/usage feature misbehaves. Prints the exact fix for anything missing.
---

# Setup

One-shot health check for everything `orchestrate` (§0) and `usage` depend on.
Idempotent — safe to run repeatedly; its only side effect is pre-warming the
ccusage cache.

Run the bundled script and show its output to the user **verbatim** — it is
preformatted (a checklist with `fix:` lines); do not summarize or reformat:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh" \
  || bash "$(find "$HOME/.claude/plugins" -path '*multiclaude/scripts/setup.sh' 2>/dev/null | head -1)"
```

## What it checks

- **Core tools (usage):** `python3`, GNU `find` (`-printf`), and `bunx`/`npx`
  (Node) — the backends for `/multiclaude:usage`.
- **Codex:** CLI installed and logged in (edit / implementation tasks).
- **AGY:** CLI installed and authenticated (`agy models` reachable).
- **Companion plugins:** `superpowers` and `claude-mem` enabled (orchestrate §0).
- **ccusage:** reachable through `bunx`/`npx` for the Claude-block readout.
- **Wallet-headroom hook:** `hooks/hooks.json` present and
  `scripts/usage-snapshot.sh` runnable (orchestrate §0/§5).

Anything missing prints a `fix:` line with the exact command; re-run until it
reports all-clear. The canonical `~/.claude/settings.json` (every marketplace +
plugin entry) ships with the plugin at `${CLAUDE_PLUGIN_ROOT}/setup/settings.json`
— copy it on a fresh machine, or lift the two `multiclaude` entries into an
existing settings file.
