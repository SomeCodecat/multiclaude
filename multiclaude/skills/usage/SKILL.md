---
name: usage
description: Show current usage/quota across the orchestration wallets — Codex (ChatGPT) 5h+weekly rate limits, the orchestrator's active 5-hour Claude block (cost/tokens/burn/projection), and AGY tiers. Use to check headroom before delegating, or when the user asks about usage/quota/limits/cost.
---

# Usage

Reports usage/quota for every wallet the orchestrate skill spends, so routing
decisions can account for headroom (complements the reactive quota handling in
orchestrate §5).

Run the bundled script and show its output to the user **verbatim** — it is
preformatted; do not summarize or reformat unless asked:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/usage/usage.sh" \
  || bash "$(find "$HOME/.claude/plugins" -path '*multiclaude/skills/usage/usage.sh' 2>/dev/null | head -1)"
```

## What it reports

- **CODEX** — primary (5-hour) and secondary (weekly) rate-limit % used, reset
  times, and plan, parsed from the newest `~/.codex/sessions/**/*.jsonl`
  `rate_limits` snapshot. Real numbers, no API call.
- **CLAUDE (orchestrator)** — cost, tokens, burn rate, and projection for the
  active 5-hour billing block via `ccusage` over `~/.claude/projects`. Needs
  network (pulls `ccusage` through `bunx`/`npx`).
- **AGY** — available model tiers. AGY's CLI exposes **no** usage readout; its
  Gemini/Claude quota is enforced reactively (resource_exhausted / 429), so this
  section is informational, not a live percentage.

Each source degrades independently: if one is unavailable the script prints a
short note on that line instead of failing.

**Dependencies:** `python3`, GNU `find`, and `bunx`/`npx` (Node) for the Claude
section. Run `/multiclaude:setup` once after installing the plugin to ensure
these — plus the `codex` and `agy` CLIs — are present.
