# Native Dispatch Agents + Hybrid Dispatch + Workflow Opt-In

**Date:** 2026-07-10
**Status:** Approved (user: "1 sounds good" — hybrid + own agents)
**Target version:** 2.5.0

## Problem

Both external rescue agents misbehaved on 2026-07-10: `codex:codex-rescue`
backgrounded the CLI and returned a placeholder (its own instructions prefer
background for multi-step tasks), and `agy:agy-rescue`'s driver answered a
review itself (`tool_uses: 0`) instead of calling the CLI. We don't control
those prompts. Direct backgrounded Bash is reliable and free of driver cost
but renders as a plain background-task line, not a native agent card — the
agent card UI is inseparable from a Claude driver. Separately, the Workflow
tool requires explicit user opt-in that orchestrate §2's fan-out section
never mentions.

## Decisions (user-approved)

1. **The plugin ships its own forwarder agents** — reverses the documented
   "no agents/ dir" stance. Two files, `agents/mc-codex.md` and
   `agents/mc-agy.md`: `model: haiku`, `tools: Bash`, strict bodies (one
   FOREGROUND Bash call; never background; never answer the task yourself;
   return raw stdout verbatim; on failure return the exact error, never
   nothing). Registered as `multiclaude:mc-codex` / `multiclaude:mc-agy`.
2. **Hybrid dispatch rule** (§2 rework):
   - *Interactive default:* Agent tool with the mc-* agents, `model:
     "haiku"` — native agent cards, controlled behavior.
   - *Batches / long jobs / loops:* direct backgrounded CLI (zero driver
     cost; harness notifies on completion).
   - *Big fan-out (≥3 independent nodes):* Workflow — after the opt-in
     question below.
   - The external `codex:codex-rescue` / `agy:agy-rescue` agents are banned
     with the two observed failure modes cited.
   - `mc-agy` accepts `--model "<resolved tier name>"`, so tier-specific
     AGY work no longer forces the Bash path (the old rescue agent
     couldn't select a tier).
3. **Always-visible non-Claude indication (user requirement, mid-review):**
   §9 gains a fourth surface, listed FIRST — the live dispatch line. Every
   Agent-tool or Bash dispatch `description` starts with the executor tag
   (`Codex gpt-5.6-terra @ high: <short task>`), and narration names the
   delegate at dispatch and at result. Delegated work must never look like
   Claude did it. CLAUDE.md's Attribution bullet is extended to match.
4. **Workflow opt-in gate:** when a task classifies as big/multi-step (≥3
   independent substantive nodes or a multi-phase pipeline), ask the user
   ONE question — Workflow fan-out (with a rough scale note) vs. sequential
   dispatch — before launching any Workflow. Never launch unprompted; small
   tasks never trigger the question.

## Agent contracts

Prompt format for both: runtime controls first, then the task text.

- `mc-codex`: `--model <id>` required (`gpt-5.6-luna|terra|sol`), `--effort
  <low|medium|high|xhigh>` optional. Runs exactly:
  `timeout 900 codex exec -m <model> [-c model_reasoning_effort="<effort>"]
  --full-auto --skip-git-repo-check -` with the task text on stdin via a
  quoted heredoc. Never runs `git add`/`git commit` (sandbox blocks `.git`;
  the orchestrator commits).
- `mc-agy`: `--model "<resolved tier name>"` optional (default tier when
  absent), `--edit` optional (maps to `--dangerously-skip-permissions`).
  Writes the task text to a temp file via quoted heredoc, then runs
  `cat <file> | timeout 600 agy --print [--model "<tier>"] [flags]` — stdin
  form, immune to ARG_MAX.
- Both: single foreground Bash call, no repo inspection, no retries with
  different flags, stdout verbatim as the entire reply, exact error text on
  failure.

## Changes

1. **Create** `multiclaude/agents/mc-codex.md`, `multiclaude/agents/mc-agy.md`.
2. **`skills/orchestrate/SKILL.md` §2:** routing-table Dispatch cells point
   at the mc-* agents (interactive) with the Bash path noted for batches;
   dispatch mechanics rewritten around the three-path hybrid rule; the
   agy-rescue tier parenthetical replaced (mc-agy selects tiers); rescue
   agents banned; fan-out section gains the opt-in gate paragraph.
3. **CLAUDE.md:** Structure gains the `agents/` entries; the "NO agents/
   dir" line updated; File Formats gains an Agent section modeled on the
   real files; Orchestration Model delegation bullets rewritten for the
   hybrid rule + opt-in gate; the "agent types come from external plugins"
   line corrected.
4. **Version 2.5.0** everywhere; tag `v2.5.0`; GitHub Release.

## Error handling

- mc-* agents return exact CLI errors (empty result no longer ambiguous —
  §3's "empty result = dispatch failure" rule still applies as backstop).
- Model-name rejection fallback (§2 tier rule) unchanged.

## Testing

- New agents are loaded at session start → full end-to-end test of
  `multiclaude:mc-codex` requires a fresh session; this session verifies
  file format against the working `codex-rescue.md` example, JSON/YAML
  shape, and the underlying CLI commands (already proven live today).
- Grep gates for each edit; JSON validation for manifests; probe re-run.

## Out of scope

- Changing the wallet-headroom hook or scripts.
- A `commands/` dir or MCP server (the rest of the stance stands).
- Deprecating the direct Bash path (it remains the batch path).
