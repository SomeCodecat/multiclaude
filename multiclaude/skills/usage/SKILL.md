---
name: usage
description: Use when the user asks how many tokens were used or what they would have cost — tokens in / cached / out and ≈ API list-price spend per wallet (Claude, Codex, AGY), per Claude account and per model, for today, 7d, 30d or all recorded history.
---

# Usage

Counts the tokens every wallet has spent, from what the CLIs already recorded,
and prices them at API list prices:

- **Claude** — Claude Code transcripts (`~/.claude/projects`, plus each
  `accounts` session profile), one row per API response, deduplicated.
  Attributed to an account by the profile it ran under, or for the default login
  by the account switch log (`switches.jsonl` in the accounts store); history
  from before the first known switch point shows as "unattributed".
- **Codex** — `~/.codex/sessions` token counts (cumulative totals, counted as deltas).
- **AGY** — the runner's job files (runs made through `dispatch.mjs` only; agy's
  own conversation store is not readable).

The first scan reads the whole history (a few seconds per GB); later scans read
only what was appended. State: `~/.cache/multiclaude/tracker.json`. Prices: the
LiteLLM table, cached daily in `~/.cache/multiclaude/prices.json`; overrides in
USD per million tokens go in `~/.config/multiclaude/prices.json`
(`{"model-id": {"in": 1, "out": 5, "cacheRead": 0.1}}`, a key ending in `*`
matches by prefix). "≈ API $" is what the same tokens would cost on the API —
subscriptions are not billed per token. `MULTICLAUDE_PRICES=off` stops the
daily fetch of the table.

One transcript instead of the whole history (a subagent's `agent-*.jsonl`, a
session file): `node "${CLAUDE_PLUGIN_ROOT}/scripts/price.mjs" <file.jsonl>…`
prints JSON — tokens and ≈ USD per file and per model.

Typed as `/multiclaude:usage [today|7d|30d|all]`, the plugin's hooks module runs
the script and prints its output directly, with no model turn. The Wallets pane
(`/wallets`) shows the same figures under "Usage" (`p` cycles the period, `i`
switches in/out combined ↔ split). Otherwise run the script and show its output
**verbatim**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs" 7d
```

Flags: `--json` (machine-readable), `--no-scan` (report from the last scan),
`--refresh-prices` (refetch the price table now).
