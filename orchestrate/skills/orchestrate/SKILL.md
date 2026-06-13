---
name: orchestrate
description: Use at the start of any substantive task (implementation, review, research, analysis, heavy reasoning) to route work to Codex and AGY before spending Claude Code's own tokens. Claude acts as orchestrator - dispatch, verify with mechanical gates, synthesize.
---

# Orchestrate

Route delegation-shaped work to external agents (Codex, AGY) first. Claude
Code's own quota is the LAST resort. Claude's job: classify, dispatch, verify
cheaply, synthesize, spot-fix.

## 0. Session setup (run once per session, cache the results)

1. **Per-project opt-out:** check the project's CLAUDE.md for a line
   `orchestrate: off`. If present: tell the user once, skip orchestration
   entirely this session, work normally.
2. **Availability checks:**

   ```bash
   command -v codex || echo "CODEX MISSING"
   command -v agy || echo "AGY MISSING"
   agy models 2>/dev/null || echo "AGY MODELS UNAVAILABLE"
   grep -q 'superpowers@' ~/.claude/settings.json || echo "SUPERPOWERS PLUGIN NOT ENABLED"
   grep -q 'claude-mem@' ~/.claude/settings.json || echo "CLAUDE-MEM PLUGIN NOT ENABLED"
   ```

3. **Resolve AGY model tiers by pattern** (NEVER hardcode names — they drift).
   `agy models` prints one model per line; for each tier take the first model
   line matching, case-insensitive:
   - Opus tier: `Claude.*Opus`
   - Sonnet tier: `Claude.*Sonnet`
   - Gemini-high tier: `Gemini.*Flash.*High`
   - Gemini-medium tier: `Gemini.*Flash.*Medium`

   If a pattern matches nothing, AGY does not currently offer that tier: step
   DOWN the chain (Opus→Sonnet→Gemini-high→Gemini-medium) to the next available
   AGY tier. This within-AGY step-down is distinct from §0.4 missing-CLI
   re-routing and from §5 quota re-routing.
4. **If a component is missing**, warn ONCE with the exact fix:
   - Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` then `codex login`
   - AGY: `curl -fsSL https://antigravity.google/cli/install.sh | bash` then authenticate
   - superpowers / claude-mem plugins (if their skills are absent): add the
     marketplace + enabledPlugins entries from the multiclaude repo's
     `setup/settings.json`
   Then continue in degraded form. A missing CLI is marked unavailable for the
   whole session immediately (no error needed to detect it) and its work is
   re-routed cross-agent:
   - Codex missing → route implementation tasks to AGY Sonnet/Opus tier
   - AGY missing → route review and heavy reasoning to Codex if suitable,
     else Claude handles them locally
   If BOTH CLIs are missing: say so once, work normally without orchestration.

## 1. The Delegation Test

Delegate a task ONLY if ALL four hold:

1. **Self-contained spec** — describable completely in a prompt without
   constraints that live only in conversation history.
2. **Bounded file surface** — expected touched files nameable in advance.
3. **Mechanically checkable** — acceptance gates (§3) can verify it without
   reading the full implementation.
4. **Substantive enough to pay for itself** — dispatch overhead (context
   serialization, polling, gates, diff skim) < expected savings. One-liners
   and trivial edits fail this; do them directly.

Tasks failing ANY criterion: Claude does them directly. Never delegate just to
push the delegation share up.

## 2. Routing

| Task type | Agent | Model |
|---|---|---|
| Code implementation, refactors, test writing | Codex | Codex default |
| Code review, research, analysis, docs | AGY | Gemini-medium tier |
| Hard review/research, architecture analysis | AGY | Gemini-high tier |
| Heavy reasoning (would use own Sonnet) | AGY | Sonnet tier |
| Hardest reasoning (would use own Opus) | AGY | Opus tier |

**Dispatch mechanics:**

- **Codex:** use the Agent tool with `subagent_type: "codex:codex-rescue"`
  (preferred — shared runtime), or `codex exec` via Bash for fully scripted
  runs. Codex runs in the configured bypass mode and edits files directly.
- **AGY review/research (no edits):** use the MCP tools, which keep AGY
  sandboxed (correct for no-edit work). Pick the right one:
  - `agy_review` — review the current worktree or a branch diff; params
    `base` (diff base ref) and `focus` (review angle).
  - `agy_rescue` — any other bounded research/analysis task; param `task`.
  Both take `background` (boolean) and `timeout` (Go duration like `10m0s`):
  set `background: true` for anything that could exceed ~2 minutes, then poll
  the `agy_status` / `agy_result` MCP tools (optional `jobId` param).
- **AGY edit/rework tasks:** the MCP path keeps sandboxing on and does not
  expose permission bypass, so call the CLI directly via Bash instead:

  ```bash
  agy --print --print-timeout 30m --dangerously-skip-permissions \
      --model "<resolved tier name>" "<task prompt>"
  ```

  Use Bash `run_in_background: true` for long jobs.

**Every delegation prompt must contain:** the task spec, the expected file
list, project conventions that matter (test command, lint command, style
notes), and the instruction to run the project's tests before finishing.

## 3. Acceptance Gates (verify mechanically, not by re-reading)

Run in order after a delegated edit task returns:

1. Project test suite (or the relevant subset).
2. Typecheck.
3. Lint.
4. `git diff --stat` — touches only the expected file set (± clearly
   justified additions like new test files).

**All pass:** skim `git diff --stat` plus changed hunks in critical files
only. Accept. NO deep read.
**Any fail:** read the failing output + relevant hunks. Then: (a) spot-fix if
small; (b) dispatch rework to the OTHER agent with a failure summary; (c)
after 2 failed reworks, take over directly.

Projects without tests/typecheck/lint: diff-scope check + actually read the
diff (degraded, more expensive — note it).

**Non-edit delegations (review/research):** the gates above are for edit tasks.
A review or research result has no mechanical gate — accept it by judging
completeness and usefulness yourself. A weak result is simply re-requested
(optionally with a sharper prompt or a different tier); it does NOT enter the
edit-rework loop in §6, which applies only to failed edit tasks.

## 4. One-Writer Protocol

1. Working tree MUST be clean before delegating an edit task (commit or stash
   first). Dirty tree blocks delegation.
2. While a delegated edit job runs, do NOT edit files in that workspace.
3. Every accepted delegated change lands as its own commit, so it stays clear
   which agent produced which change. Commit messages carry no co-author
   trailers.
4. Rejected work: `git checkout . && git clean -fd` (safe — tree was clean at
   dispatch), THEN send the rework.

## 5. Quota Re-Routing (reactive; quota errors are NOT quality failures)

Exhaustion is detected only via quota/rate-limit errors from a call. On one:

- **AGY tier exhausted:** Gemini and Claude tiers have SEPARATE quotas — step
  to the other tier first, either direction (Gemini out → Claude tier; Claude
  out → Gemini tier). Both out → re-evaluate: Codex-suitable? → Codex; else
  Claude does it locally.
- **Codex exhausted:** re-evaluate: AGY-suitable? → AGY (implementation
  rework → Sonnet/Opus tier, review/research → Gemini tier); else local.
- **Everything exhausted:** work normally on own quota; tell the user ONCE
  that orchestration is suspended.

A quota failure does NOT consume a rework hop (no work product was produced).

**Session exhaustion marks:** after a quota error, mark that agent/tier
exhausted for the REST OF THE SESSION and skip it immediately for later tasks.
Tell the user once per session which agents are marked. Fresh sessions
re-probe naturally.

## 6. Fallback summary (quality failures)

Codex fails gates → AGY reworks (failure summary in prompt).
AGY fails gates → Codex reworks (failure summary in prompt).
Hard limit: 2 rework attempts total, then Claude takes over.
Rework prompts MUST summarize what the previous attempt got wrong.
