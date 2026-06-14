---
name: usage
description: Show current usage/quota across the orchestration wallets — Codex (ChatGPT) 5h+weekly rate limits, the orchestrator's own Claude limits (official 5-hour + weekly utilization %, same as /usage, plus cost/tokens/burn detail), and AGY's Gemini + Claude pools (reactive 429 status, since AGY exposes no usable proactive quota). Use to check headroom before delegating, or when the user asks about usage/quota/limits/cost.
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
- **CLAUDE (orchestrator)** — two **official** bars: 5-hour + weekly **utilization
  %** (the exact numbers Claude Code's `/usage` shows), with reset times; per-model
  weekly (opus/sonnet), plan, and any extra-usage credits as a sub-line, then cost,
  tokens, burn rate, projection, and models from `ccusage`. The % is read from the
  same first-party endpoint `/usage` uses (`GET …/api/oauth/usage`) with the OAuth
  token Claude Code stores at `~/.claude/.credentials.json` (refreshed whenever the
  app runs); the token only ever goes to `api.anthropic.com`. Needs network. If the
  endpoint is unavailable — offline, token expired, or (on macOS) creds kept in the
  Keychain rather than that file — it falls back to a **clearly-labelled elapsed-time**
  bar (time through the 5-hour block, *not* quota) so it's never mistaken for the
  real %. The `ccusage` detail is a separate `bunx`/`npx` network call.
- **AGY** — one bar per pool (**Gemini** + **Claude**), with account + model tiers
  as detail. **Reactive only** — AGY exposes no usable proactive quota number
  (see "Why no proactive %" below), so both pools are derived from logs: AGY writes
  a `RESOURCE_EXHAUSTED (code 429) … Resets in 2h6m5s` line on exhaustion, preceded
  by the active model `label="…"`. The script scans `~/.gemini/antigravity-cli/log`,
  attributes each newest 429 to its pool by that label, and shows **exhausted**
  (full bar) + reset countdown if the reset is still in the future, otherwise
  **available** (empty bar). "available" means "no active 429" — not a
  guaranteed-headroom percentage.

  **Why no proactive %.** Two backend RPCs exist but neither gives correct,
  reachable numbers for a background usage hook:
  - `POST …/v1internal:retrieveUserQuota` answers 200 with the user's OAuth token,
    but reports the **legacy Gemini Code Assist** buckets (`gemini-2.5-flash`,
    `-flash-lite`, `-pro`, `gemini-3.1-flash-lite`) — all pinned at
    `remainingFraction: 1`. AGY's real pooled quota (Gemini 3.5 Flash, 3.1 Pro,
    Claude 4.6, GPT-OSS 120B) never draws from them, so it would always read
    "100%" regardless of true depletion — actively misleading.
  - `POST …/v1internal:retrieveUserQuotaSummary` returns AGY's real pool grouping
    but `403 PERMISSION_DENIED` for a direct consumer token. It only answers over
    the **Antigravity Language Server** (Connect RPC on a random localhost port;
    CSRF token in `/proc/<pid>/environ`), which exists only during a live
    interactive `agy` session and is Linux-only — unusable from a cross-platform
    background hook. If a proactive % is ever wanted, that LS path is the only
    accurate source and would have to be implemented separately.

Each source degrades independently: if one is unavailable the script prints an
`n/a` bar with a short note on that line instead of failing.

**Dependencies:** `node` (the script itself), plus `bunx`/`npx` for the Claude
section's `ccusage` call. No `python3`, no GNU `find`, no shell. The Codex section
and AGY's reactive pool status read local files directly (work offline); only the
Claude section needs the network. Run `/multiclaude:setup` once after installing
the plugin to ensure these — plus the `codex` and `agy` CLIs — are present.
