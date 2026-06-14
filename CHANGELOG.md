# Changelog

All notable changes to the `multiclaude` plugin are documented here.

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
