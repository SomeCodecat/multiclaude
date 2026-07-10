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

## Scope addition (2026-07-10, user-approved): Workflow fan-out

The orchestrate skill gains a `### Workflow fan-out` subsection at the end of
§2 Dispatch mechanics, teaching how to drive MANY offload nodes through the
native Workflow tool while keeping compute on Codex/AGY wallets:

- **When:** ≥3 independent offload nodes (parallel review sweep, multi-angle
  research, edit fan-out under §4 isolation). Below that, plain dispatch.
- **Node shape (the supported one):** default workflow subagent,
  `model: 'haiku'`, `effort: 'low'`, Bash-only command-shaped prompt that runs
  the external CLI **synchronously** (`codex exec -m gpt-5.6-<tier> -c
  model_reasoning_effort="<effort>" …` or `timeout N agy --print=…`) and
  returns raw stdout. No `schema`, no Read/Edit — parse results in the
  workflow script's plain JS.
- **The `agentType: '*-rescue'` path is documented as hazardous, not
  recommended:** (a) the forwarder may background the CLI and resolve
  `agent()` early with a placeholder string (observed 2026-07-10, codex-rescue
  1.0.5); (b) a non-command-shaped prompt makes the Claude driver answer
  itself on own quota (observed same day, `tool_uses: 0`).
- **Tri-provider fan-out (user requirement):** nodes are independent, so one
  workflow can run all three wallets at once — Codex nodes, AGY nodes, and
  (sparingly) own-Claude nodes in the same `parallel()`/`pipeline()`. Named
  patterns: cross-provider judge panel (same question to `gpt-5.6-sol`, AGY
  Gemini-high, and one own-quota driver), and headroom-weighted partitioning
  of a work list across wallets.
- **Concurrency caveat:** a workflow runs ~10 nodes at once against the
  external wallets' own rate limits, and the wallet-headroom hook fires once
  per Workflow call, not per node — size fan-out to headroom.
- **Edits in fan-out** only with `isolation: 'worktree'` or disjoint file
  sets (§4 one-writer rule still governs).

CLAUDE.md's Orchestration Model section gets one matching bullet. Version
stays 2.3.0 (additive, non-breaking).

## Scope addition 2 (2026-07-10, user-approved): Executor attribution (§9)

New section `## 9. Attribution — make the executor visible` in the
orchestrate skill. Every delegated task must surface who actually ran it —
provider, exact model, and (Codex) effort — on three surfaces:

1. **Task tracker:** executor appended to the task subject
   (`[Codex · gpt-5.6-luna @ medium]`, `[AGY · <resolved tier verbatim>]`,
   `[Claude · <driver model id>]`), updated on escalation so the final
   executor is visible; prior executors move to task metadata
   (`executorHistory`), not the subject.
2. **Synthesis:** the final report lists each subtask with its executor.
   Exact-model rules: Codex = full model id + effort; AGY = the §0
   probe-resolved tier name verbatim (names drift — never paraphrase);
   own-quota work = the actual driver model id.
3. **Commits & workflow labels:** delegated-edit commits carry a trailer
   `Implemented-by: Codex (gpt-5.6-luna, effort medium)`; workflow fan-out
   nodes encode the executor in `label` (`codex:gpt-5.6-terra:<item>`) so
   `/workflows` shows it live.

CLAUDE.md Orchestration Model gets one matching bullet. Version → **2.4.0**,
tagged `v2.4.0` and pushed. Rationale: attribution makes §5 quota decisions
and §6 rework routing auditable after the fact.

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
