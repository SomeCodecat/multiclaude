---
name: quota
description: Show usage/quota across the orchestration wallets — Codex 5h+weekly rate limits, the orchestrator's own official Claude 5-hour + weekly utilization %, AGY's Gemini + Claude pool status, and pi (no quota — its spend today and over 7 days). Use to check headroom before delegating, or when the user asks about usage/quota/limits/cost.
---

# Quota

Reports usage/quota for every wallet the orchestrate skill spends, so routing
decisions can account for headroom (complements the reactive quota handling in
orchestrate §5).

Typed as `/multiclaude:quota`, the plugin's hooks module runs the script and
prints its output directly, with no model turn (arguments pass through).
Otherwise run the bundled script and show its output to the user **verbatim** — it is
preformatted; do not summarize or reformat unless asked:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/quota/quota.mjs"
```

(Pure Node — runs the same on Linux, macOS, and Windows; no bash/python3.)

With pi installed (or run this week) a PI section follows: pi has no quota, so
its bar reads ∞ and the section shows runs, tokens and spend today and over 7
days (`$` = what the provider reported; `≈` = includes runs priced at list
price). Unlimited is not headroom to route to — pi gets work by orchestrate
§10 only.

Details of what each wallet section shows, its data source, and why AGY has no
proactive % are documented in the README ("The quota readout") and in the
comments of `scripts/lib/wallets.mjs`.

**Dependencies:** `node` (the script itself), plus `bunx`/`npx` for the Claude
section's `ccusage` call. The Codex section and AGY's reactive pool status read
local files (work offline); only the Claude section needs the network. Run
`/multiclaude:setup` once after installing the plugin to ensure these — plus
the `codex` and `agy` CLIs — are present.
