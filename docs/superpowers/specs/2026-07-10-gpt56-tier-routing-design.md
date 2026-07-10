# GPT-5.6 Tier Routing for Codex Dispatch

**Date:** 2026-07-10
**Status:** Approved
**Target version:** 2.3.0

## Problem

OpenAI released the GPT-5.6 family on 2026-07-09: three durable capability
tiers available in Codex — `gpt-5.6-luna` (cheapest, $1/$6 per M tokens),
`gpt-5.6-terra` (GPT-5.5-level quality at half the price, $2.50/$15), and
`gpt-5.6-sol` (flagship, $5/$30). The multiclaude orchestrate skill currently
routes all Codex work as one flat band ("Codex default"), and the user's
`~/.codex/config.toml` default is `gpt-5.5` at `model_reasoning_effort =
"xhigh"` — every dispatch runs the previous-generation model at the most
token-hungry setting. Task-appropriate tiering saves both money and
rate-limit-window burn.

Verified locally: Codex CLI 0.144.1 accepts the new tiers
(`codex exec -m gpt-5.6-luna` round-trip succeeded, 2,142 tokens).

## Decisions (user-approved)

1. **Explicit tier on every dispatch.** The orchestrate skill always names a
   tier; `~/.codex/config.toml` is never touched. Interactive codex sessions
   keep the user's own default.
2. **Tier + effort pairing.** Each routing band names both a model and a
   reasoning effort; effort is never left to the config default.
3. **Three-band mapping by task type** (over "terra-with-exceptions" and
   "luna-first escalation"):

| Codex task band | Model | Effort |
|---|---|---|
| Mechanical: boilerplate, renames, config/doc edits, small clearly-specced fixes, formatting | `gpt-5.6-luna` | medium |
| Standard: features, refactors, test writing, everyday implementation | `gpt-5.6-terra` | high |
| Hard: complex refactors, tricky bugs, architecture, long agentic runs, security-sensitive | `gpt-5.6-sol` | xhigh |

**Classification rule:** when unsure between two bands, pick the lower and
escalate one band only if a verification gate (§3 of the orchestrate skill)
fails. A single re-dispatch after a real failure is cheaper than defaulting
everything upward.

## Changes

Markdown + manifests only. No new scripts, no script edits, no new mechanism.

### 1. `multiclaude/skills/orchestrate/SKILL.md` — §2 Routing

- Replace the single Codex row of the routing table with the three bands
  above. AGY rows unchanged.
- Add the classification rule as a short note under the table.

### 2. `multiclaude/skills/orchestrate/SKILL.md` — §2 Dispatch mechanics

Both existing Codex paths gain explicit tier selection:

- **Agent path** (`codex:codex-rescue`, `model: "haiku"`): include
  `--model gpt-5.6-<tier> --effort <effort>` in the dispatch prompt. The
  rescue agent already treats `--model <value>` and `--effort <value>` as
  pass-through runtime controls and excludes them from the task text.
- **Bash path**: `codex exec -m gpt-5.6-<tier> -c
  model_reasoning_effort="<effort>" ...` (`codex exec` has no `--effort`
  flag; effort goes through `-c`).
- **Never rely on the config default** — it is the user's interactive
  setting, not the orchestrator's.
- **Fallback:** if the CLI rejects the model name (older CLI, account
  gating), retry once with no `-m` (config default) and note the degraded
  routing in the synthesis.

### 3. Repo-root `CLAUDE.md` — Orchestration Model section

Extend the Codex delegation-mechanism bullet with one line: dispatches name
an explicit GPT-5.6 tier + effort per the orchestrate §2 band table.

### 4. Version bump — 2.3.0

`multiclaude/.claude-plugin/plugin.json` and both version fields in the
repo-root `.claude-plugin/marketplace.json`, kept identical.

## Error handling

- Model-name rejection → single fallback dispatch without `-m` (above).
- No other new failure surface: tier selection reuses the two existing,
  already-hardened dispatch paths.

## Testing

- One tiny `codex exec` round-trip each on `gpt-5.6-terra` and `gpt-5.6-sol`
  to confirm account access to all three tiers (luna already verified).
- Re-run `scripts/probe.mjs` to confirm the environment probe still passes.
- Validate JSON of both manifests after the version bump.

## Out of scope

- Managing `~/.codex/config.toml` (default model/effort) from setup.
- AGY routing changes — its tier table is unaffected.
- Luna-first automatic escalation loops.
- Changes to `probe.mjs`, `quota.mjs`, wallets, or hooks.
