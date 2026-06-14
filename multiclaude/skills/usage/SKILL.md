---
name: usage
description: Show current usage/quota across the orchestration wallets — Codex (ChatGPT) 5h+weekly rate limits, the orchestrator's active 5-hour Claude block (cost/tokens/burn/projection), and AGY's Gemini/Claude pools (reactive 429 status + reset, derived from logs). Use to check headroom before delegating, or when the user asks about usage/quota/limits/cost.
---

# Usage

Reports usage/quota for every wallet the orchestrate skill spends, so routing
decisions can account for headroom (complements the reactive quota handling in
orchestrate §5).

Run the bundled script and show its output to the user **verbatim** — it is
preformatted; do not summarize or reformat unless asked:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/usage/usage.mjs"
```

(Pure Node — runs the same on Linux, macOS, and Windows; no bash/python3.)

## Output format

Every wallet renders the **same skeleton** so they read alike at a glance — one
bar line per metered window, then indented detail:

```
▌ NAME  (description)
  <label>  <10-char bar>  <pct>  · <status>
    <detail>
```

A window with no readable percentage (an idle/available AGY pool, or any source
that's unavailable) shows an empty bar + `n/a` + a short note, keeping the same
shape. A window known to be at its cap (AGY pool with an active 429) shows a full
bar + reset countdown.

## What it reports

- **CODEX** — two real bars: primary (5-hour) and secondary (weekly) rate-limit
  % used, with reset times; plan + latest-session tokens as detail. Parsed from
  the newest `~/.codex/sessions/**/*.jsonl` `rate_limits` snapshot, no API call.
- **CLAUDE (orchestrator)** — one bar tracking **elapsed time through the active
  5-hour block** (Claude has no fixed quota %, so this is the one bounded 0–100
  metric); cost, tokens, burn rate, projection, and models as detail. Via
  `ccusage` over `~/.claude/projects`; needs network (pulls `ccusage` through
  `bunx`/`npx`).
- **AGY** — one bar per pool (**Gemini** + **Claude**), with account + model tiers
  as detail. AGY's CLI exposes no usage **percentage**, but it logs a reactive
  `RESOURCE_EXHAUSTED (code 429) … Resets in 2h6m5s` line on exhaustion, preceded
  by the active model `label="…"`. The script scans `~/.gemini/antigravity-cli/log`,
  attributes each newest 429 to the Gemini or Claude pool by that label, and turns
  it into a live status: **exhausted** (full bar) + reset countdown if the reset is
  still in the future, otherwise **available** (empty bar, `n/a` %). "available"
  means "no active 429" — not a guaranteed-headroom percentage.

Each source degrades independently: if one is unavailable the script prints an
`n/a` bar with a short note on that line instead of failing.

**Dependencies:** `node` (the script itself), plus `bunx`/`npx` for the Claude
section's `ccusage` call. No `python3`, no GNU `find`, no shell — the Codex and
AGY sections read local files directly, so they work even offline. Run
`/multiclaude:setup` once after installing the plugin to ensure these — plus the
`codex` and `agy` CLIs — are present.
