---
name: probe
description: Use to see which delegates are available right now and which model id each band resolves to today (Codex mech/std/hard/max, AGY opus/sonnet/gem-top/gem-alt/gem-hi/gem-med/gem-lo). Pass --smoke to round-trip both CLIs through the runner.
---

# Probe

Prints orchestrate §0's availability check and the live band tables: Codex
bands resolved by role from `~/.codex/models_cache.json`, AGY tiers from
`agy models`, each with a ready-to-use dispatch hint. `--smoke` also sends a
tiny prompt through `dispatch.mjs` to each CLI and reports HEALTHY / DEGRADED.

Typed as `/multiclaude:probe`, the plugin's hooks module runs the script and
prints its output directly, with no model turn. Otherwise run it and show the
output to the user **verbatim**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/probe.mjs"            # bands + availability
node "${CLAUDE_PLUGIN_ROOT}/scripts/probe.mjs" --smoke    # + one round-trip per CLI
```
