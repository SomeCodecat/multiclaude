---
name: quota
description: Show usage/quota across the orchestration wallets — Codex 5h+weekly rate limits, the orchestrator's own official Claude 5-hour + weekly utilization %, and AGY's Gemini + Claude pool status. Use to check headroom before delegating, or when the user asks about usage/quota/limits/cost.
---

# Quota

Reports usage/quota for every wallet the orchestrate skill spends, so routing
decisions can account for headroom (complements the reactive quota handling in
orchestrate §5).

Run the bundled script and show its output to the user **verbatim** — it is
preformatted; do not summarize or reformat unless asked:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/quota/quota.mjs"
```

(Pure Node — runs the same on Linux, macOS, and Windows; no bash/python3.)

Details of what each wallet section shows, its data source, and why AGY has no
proactive % are documented in the README ("The quota readout") and in the
comments of `scripts/lib/wallets.mjs`.

**Dependencies:** `node` (the script itself), plus `bunx`/`npx` for the Claude
section's `ccusage` call. The Codex section and AGY's reactive pool status read
local files (work offline); only the Claude section needs the network. Run
`/multiclaude:setup` once after installing the plugin to ensure these — plus
the `codex` and `agy` CLIs — are present.
