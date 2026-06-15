# Changelog

All notable changes to the `multiclaude` plugin are documented here.

## 2.1.0 — 2026-06-15

The usage readout is now `/multiclaude:quota`.

### Changed

- **Renamed the `usage` skill to `quota`** so its slash command is
  `/multiclaude:quota` instead of `/multiclaude:usage`. The old name shadowed
  Claude Code's built-in `/usage` command and was confusing to invoke. The
  readout, output format, and underlying wallet sources are unchanged — only the
  command name. References to Claude Code's first-party `/usage` (the source of
  the CLAUDE utilization bars) are intentionally kept as-is.
- Moved `skills/usage/usage.mjs` → `skills/quota/quota.mjs`; updated the
  `setup` health check, the orchestrate §0 fallback pointer, the README, and the
  plugin/marketplace manifest descriptions to match.

### Migration

- `/multiclaude:usage` no longer exists — use `/multiclaude:quota`. Restart
  Claude Code after updating so the renamed skill is picked up.

## 2.0.2 — 2026-06-14

The CLAUDE wallet now shows the **real quota %**, not a time proxy.

### Fixed

- **CLAUDE bar was elapsed-time, not usage.** It tracked how far through the
  5-hour block you were (e.g. 86% at ~4h17m), which read like quota used but
  wasn't — a 69%-used account could show 86%. It now shows the **official
  utilization %** from the same first-party endpoint Claude Code's `/usage` uses
  (`GET https://api.anthropic.com/api/oauth/usage`), via the OAuth token at
  `~/.claude/.credentials.json` (token only ever goes to `api.anthropic.com`).

### Added

- `claudeLimits()` in `scripts/lib/wallets.mjs` — returns 5-hour + 7-day (and
  per-model 7-day opus/sonnet) **used %** with reset times, plan, and extra-usage
  credits. Degrades cleanly when offline, token-expired, or (macOS) creds live in
  the Keychain rather than the file.
- Full report (`/multiclaude:usage`) renders **two official bars** — `5h limit`
  and `weekly` — with opus/sonnet weekly + plan + extra credits as a sub-line;
  `ccusage` cost/tokens/burn/projection stays as detail.
- Compact hook line now leads with `CLAUDE 5h NN% / wk NN%` (the headroom signal
  that matters for routing) before the ccusage cost/burn detail.

### Fallback

- If the limits endpoint is unreachable, the report falls back to a **clearly
  labelled** elapsed-time bar ("elapsed time, not quota") so it can never again be
  mistaken for the real %.

## 2.0.1 — 2026-06-14

Documents the AGY-quota investigation and keeps the usage readout honest. AGY's
Gemini + Claude pools stay **reactive-only** — there is no usable proactive quota
number, and the real model lineup is still sourced from `agy models`.

### Why no proactive AGY %

Both backend RPCs were tried and rejected:

- `…/v1internal:retrieveUserQuota` answers `200` with a consumer token but reports
  the **legacy Gemini Code Assist** buckets (`gemini-2.5-flash` / `-flash-lite` /
  `-pro` / `gemini-3.1-flash-lite`), all pinned at `remainingFraction: 1`. AGY's
  real pooled quota never draws from them, so it would always read "100%"
  regardless of true depletion — actively misleading (the "models are wrong" bug).
- `…/v1internal:retrieveUserQuotaSummary` returns AGY's real pool grouping but
  `403 PERMISSION_DENIED` for a direct token. It only answers over the Antigravity
  Language Server (Connect RPC on a random localhost port; CSRF token in
  `/proc/<pid>/environ`) — live-session-only and Linux-only, so unusable from a
  background, cross-platform usage hook.

### Changed (docs + clarity; no behavior change)

- `scripts/lib/wallets.mjs`, `skills/usage/usage.mjs`,
  `scripts/usage-snapshot.mjs` now document the reactive-only rationale inline so
  the dead-end endpoint is never re-added; minor cosmetic refactor of the AGY
  pool rendering. The displayed output is unchanged from 2.0.0.
- `skills/usage/SKILL.md` gains a "Why no proactive %" subsection and corrected
  dependencies (only the Claude section needs the network).

## 2.0.0 — 2026-06-14

Full port of every script and hook from bash + python3 to **pure Node.js**, so
the plugin runs identically on Linux, macOS, and Windows. No `/bin/sh`, no
`bash`, no `python3`, no GNU `find` — only `node` (already required by Claude
Code) plus `bunx`/`npx` for the one `ccusage` network call.

### Changed (breaking — implementation only; commands & output are unchanged)

- **All four scripts are now `.mjs`.** `scripts/probe.sh` → `probe.mjs`,
  `scripts/usage-snapshot.sh` → `usage-snapshot.mjs`, `scripts/setup.sh` →
  `setup.mjs`, `skills/usage/usage.sh` → `usage.mjs`. The old `.sh` files are
  removed. Shared cross-platform helpers live in `scripts/lib/mc.mjs` (a
  PATHEXT-aware `which`, shell-free `run`, recursive `newestFile`, duration/bar
  formatting) and the wallet readers in `scripts/lib/wallets.mjs` (one source of
  truth for Codex / Claude / AGY data, used by both the full readout and the
  hook snapshot).
- **Hooks switched to exec form.** `hooks/hooks.json` now uses
  `"command": "node"` + `"args": [...]` (spawned directly, no shell) instead of
  `"shell": "bash"` with a `$(find …)` fallback — the documented cross-platform
  pattern. `${CLAUDE_PLUGIN_ROOT}` is still substituted by Claude Code.
- **`/multiclaude:setup` gained an idempotent `apply` mode.** `check` (default)
  verifies and changes nothing; `apply` deep-merges the desired-state template
  into `~/.claude/settings.json` (backing up to `.bak`, never clobbering keys it
  doesn't manage), with `--full`, `--set dotted.key=value`, `--ttl`, `--model`,
  and `--dry-run`. The JSON merge is native JS — the python3 heredoc is gone.

### Removed

- **`python3`, GNU `find`, and `bash` as dependencies.** The usage readout's
  Codex and AGY sections read local files directly and now work fully offline;
  only the Claude block still needs the network (`ccusage` via `bunx`/`npx`).

## 1.9.0 — 2026-06-14

Completes the `orchestrate` → `multiclaude` rename and makes the setup step real.

### Added

- **`/multiclaude:setup` command.** New `skills/setup` skill wrapping
  `scripts/setup.sh` — the deploy docs and the `usage` skill already referenced
  `/multiclaude:setup`, but no such command existed. Verifies codex/agy
  (installed + authenticated), python3/find/node, companion plugins, the
  wallet-headroom hook, and ccusage; prints an exact `fix:` for anything missing.

### Changed

- **Ship the bootstrap settings inside the plugin.** Moved
  `setup/settings.json` (repo root, *not* distributed) →
  `multiclaude/setup/settings.json`, so a plugin-only install can find the
  canonical `~/.claude/settings.json` at `${CLAUDE_PLUGIN_ROOT}/setup/`.
  `scripts/setup.sh` now points its fix messages at that shipped path.
- **Finished the rename drift.** `setup/settings.json` `enabledPlugins`, the
  README (`orchestrate/` dir, `/orchestrate` command, `orchestrate@multiclaude`
  enable key, install name), and the manifest descriptions now all say
  `multiclaude` / `multiclaude@multiclaude` instead of the dead `orchestrate`
  name.

## 1.8.0 — 2026-06-14

Hardening pass driven by live v1.6.0 field feedback. The theme: make the
quota mental model impossible to miss, and document the CLI failure modes that
silently burned own-quota or hung for an hour.

### Fixed / Changed

- **Lead with the quota mental model (P0).** Added a top-of-file "What runs on
  whose quota — read this first" box: the Agent tool, every Workflow `agent()`,
  and every subagent run a Claude driver on your own main-loop model;
  `agentType`/`subagent_type` swap only prompt + tools, never the model. Work
  lands on AGY/Codex quota only when a node actually shells out to the CLI.
- **Resolved the §7 contradiction (P0).** The old "Workflow agents still route
  by these rules via `agentType` … so the tier rules hold" line implied
  `agentType` offloads. Rewritten: a Workflow does not offload by itself; the
  node must shell out with a command-shaped prompt and no schema. Added the
  real cost to the observed anti-pattern (~800k own-Opus tokens burned by a
  15-way rescue fan-out with schema + Read tools).
- **128 KB argv limit / stdin form (P1).** §2 now documents that
  `--print="$(cat bigfile)"` dies with `Argument list too long` past
  ~128 KB (`MAX_ARG_STRLEN`); large/grounded prompts go via stdin. Added
  "never chain `agy …; echo done`" — the `echo`'s `exit 0` masks CLI failure.
- **`timeout(1)` is the only real backstop (P2).** All `agy --print` calls are
  now wrapped in an OS-level `timeout`; `--print-timeout` did not stop a
  59-minute hang in practice. Refined the "let the agent read the repo itself"
  guidance: hang-prone for multi-file synthesis — inline content, run
  single-shot.
- **"Is it hung?" heuristic (P3).** §8 now shows how to compare accumulated CPU
  vs. elapsed (`ps -o pid,etime,time,stat`) to tell a stalled job from a
  working one.
- **Auth/health smoke test (P4).** §0 setup adds a one-line round-trip per CLI
  (install ≠ authenticated ≠ working); failing CLIs are marked degraded for the
  session.
- **Post-dispatch quota verification (P5).** §7 adds a "verify the quota, not
  just the result" step — offload failures are silent, so confirm a real
  `agy`/`codex` process ran (CLI) or check `/workflows` for own-model spend.
- **Killed-workflow recovery (P6).** §8 documents extracting completed
  `StructuredOutput` results from the transcript dir with `jq` instead of
  re-running on own quota.
- **AGY MCP hygiene (P7).** §2 notes the AGY plugin may auto-start an MCP
  server whose tools appear available — ignore them; the inline CLI paths are
  the only supported AGY routes.

## 1.7.0 — 2026-06-14

- Proactive wallet-headroom hooks (SessionStart + PreToolUse) inject a cached,
  non-blocking quota snapshot (Codex / Claude block / AGY) so routing sees live
  limits before dispatch; §0/§5 restructured for proactive + reactive routing.
- Added `/multiclaude:usage` readout and `setup.sh` dependency verification.
- Reorganized the project under the `multiclaude/` namespace.

## 1.4.0 — 2026-06-13

- Inline AGY dispatch refactor; runaway-waiter guards (§8); fixed
  self-matching-`pgrep` and queued-forever `agy_status` polling traps.
