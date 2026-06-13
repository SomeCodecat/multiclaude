---
name: orchestrate
description: Use at the start of any substantive task (implementation, review, research, analysis, heavy reasoning) to route work to Codex and AGY before spending Claude Code's own tokens. Claude acts as orchestrator - dispatch, verify with mechanical gates, synthesize.
---

# Orchestrate

Spend the wallet with headroom. Claude Code's own 5-hour quota is the scarce,
shared resource; AGY and Codex run on separate, independently-paid quotas that
normally sit idle. Default to delegating substantive work to them and reserve
Claude's own quota. Claude's job: classify, dispatch, verify cheaply,
synthesize, spot-fix.

Two directional rules sharpen this:

- **AGY's Claude tier before your own Sonnet/Opus.** Any reasoning you'd
  otherwise run on your own Sonnet/Opus goes to AGY's Claude tier FIRST — same
  model family, separate paid quota. Spend your own Sonnet/Opus only when AGY's
  Claude tier is exhausted (§5) or unavailable (§0).
- **When unsure, delegate.** A wasted dispatch is cheap; a habit of keeping work
  local is what leaves the external quotas idle. Push edit work to Codex as hard
  as you push reasoning/review work to AGY — neither should idle while the other
  is busy.

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

## 1. What to delegate

Default action for any substantive task: **delegate.** Keep a task local ONLY
when one of these holds:

1. **Trivial** — a one-liner or tiny edit where dispatch overhead (context
   serialization, polling, gates, diff skim) clearly exceeds the work.
2. **Un-serializable context** — the task depends on conversation-history nuance
   that can't be written into a prompt without effectively re-deriving it.
   Context transfer is the dominant hidden cost: sub-agents don't share this
   conversation, so a context-heavy task can cost MORE delegated than done
   locally.
3. **No agent available** — all suitable externals exhausted (§5) or unavailable
   (§0).

If none hold, delegate — even when unsure.

**Two task families:**

- **Edit tasks** (write / refactor / test code) → Codex by default; AGY Claude
  tier for rework/fallback. Codex idling is under-delegation just as much as AGY
  idling.
- **Non-edit tasks** (review, research, analysis, architecture, heavy reasoning,
  docs) → AGY: Gemini-medium by default, Gemini-high or Claude tier by
  difficulty. These have no file surface and no mechanical gate, and are
  delegated anyway.

**File surface & mechanical checkability are verification aids, not gates.** For
edit tasks they decide how cheaply you verify (clean file list + passing gates →
skim only, per §3). Their ABSENCE never bars delegation — it just means you
verify by reading the diff or judging the output (degraded, note it). Non-edit
tasks never have them.

**Self-check floor.** Before running a substantive task on your OWN quota, ask:
would Codex or AGY handle this? If yes, route it out. AGY is the most-missed
target, and its Claude tier the easiest to forget — heavy reasoning feels like
your own job. Heavy-reasoning work that belongs on AGY Claude / Gemini-high:
multi-step planning, tricky-bug analysis, architecture trade-offs, synthesizing
large material, deep code review. If several substantive tasks have passed and
AGY *or* Codex stayed idle, you're under-delegating — fix it on the next task.

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
  runs. Codex runs in the configured bypass mode and edits files directly. The
  Agent tool returns Codex's result inline — no polling.

- **AGY — always dispatch for an INLINE result; never poll a job.** Two paths,
  both hand the result back in the same turn:

  1. **Default tier, bounded research / review / analysis →** the Agent tool
     with `subagent_type: "agy:agy-rescue"`. It runs AGY in the foreground and
     returns the output directly — no job id, no status file, no polling. Use
     this whenever you don't need a specific model tier.
  2. **Specific tier / edits / long timeout →** the `agy --print` CLI in a
     **backgrounded Bash** (`run_in_background: true`); the harness notifies you
     on completion and you read the captured stdout (don't hand-roll a waiter —
     §8). This is the ONLY way to
     select a tier (`--model`) or to edit (`--dangerously-skip-permissions`) —
     the `agy:agy-rescue` subagent always runs AGY's default tier.

     The prompt is the **value** of `--print` (alias `--prompt`), NOT a trailing
     positional. Write the prompt to a temp file (via the Write tool, so no
     shell parses it), then read it back inside double quotes:

     ```bash
     agy --print="$(cat /tmp/agy_task.md)" \
         --print-timeout 30m \
         --model "<resolved tier name>" \
         --dangerously-skip-permissions   # edit tasks only — omit for read-only
     ```

  > ⚠️ Do NOT use the AGY **MCP** tools (`agy_rescue` / `agy_review` /
  > `agy_adversarial_review`) or `--background` + `agy_status` / `agy_result`
  > polling. The plugin writes each job's per-job `<id>.json` exactly once as
  > `status: "queued"` and never updates it — only the separate `state.json`
  > index advances — so a waiter that polls the job file (or a hand-rolled
  > `sleep`+`cat` loop) hangs on `queued` forever, even after the job has
  > finished and written its result. The two inline paths above sidestep the
  > broken state tracker entirely. (Observed: a completed review left a poller
  > stuck ~14 min.)

  > ⚠️ Prompt-passing failure modes (CLI path): `agy --print --print-timeout 30m
  > … "<prompt>"` (prompt as a trailing positional) makes `--print` swallow
  > `--print-timeout` as its value — AGY acts on the literal text
  > "--print-timeout" and ignores your real prompt. And `--print="$(cat file)"`
  > without the surrounding double quotes word-splits a multi-line prompt.
  > Always use the quoted `--print="$(cat <file>)"` form.

**Every delegation prompt must contain:** the task spec, the expected file
list, project conventions that matter (test command, lint command, style
notes), and the instruction to run the project's tests before finishing.

**Ground the prompt, and forbid fabrication.** Delegated agents — AGY especially,
when it fans out to its own subagents — will sometimes fabricate file contents
rather than admit a read failed, and the result reads as confident, plausible,
and wrong. Two defenses, both required:

- **Supply ground truth in the prompt.** Put the code the agent needs INTO the
  prompt — paste the diff for a review, the real file excerpts / signatures /
  schema for research. Claude reads these cheaply with its own tools; an agent
  handed the facts cannot hallucinate them. Reserve "let the agent read the repo
  itself" for broad exploration, not for anything whose correctness depends on
  exact code.
- **Anti-fabrication clause, verbatim in every prompt:** *"Ground every factual
  claim in files you actually read. If a file read or command fails, output the
  exact error and STOP — do not invent or guess file contents, signatures,
  schema, routes, or names. If unsure, say so explicitly."*

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

**Verify code-fact claims before trusting them.** When a research/review
deliverable asserts specific code facts — file contents, function signatures,
schema columns, enum values, route names — do NOT accept them on read. Spot-check
the load-bearing claims against the real files (cheap and targeted: a couple of
Reads/greps). If any were fabricated, discard the deliverable and re-dispatch
with the real facts embedded in the prompt (see "Ground the prompt" in §2). This
is the one gate non-edit work does get, because a confidently-wrong spec is worse
than none. (Observed: AGY's subagents invented a whole data model and DAL
signatures after silent read failures; only a diff against the real files caught
it.)

## 4. One-Writer Protocol

1. Working tree MUST be clean before delegating an edit task (commit or stash
   first). Dirty tree blocks delegation.
2. While a delegated edit job runs, do NOT edit files in that workspace.
3. Every accepted delegated change lands as its own commit, so it stays clear
   which agent produced which change. Commit messages carry no co-author
   trailers.
4. Rejected work: `git checkout . && git clean -fd` (safe — tree was clean at
   dispatch), THEN send the rework.
5. Parallel EDIT tasks are allowed only under isolation: provably disjoint file
   sets, or separate git worktrees (e.g. the Workflow tool's
   `isolation: 'worktree'`). Two agents writing one working tree at once breaks
   this protocol — serialize them instead. Non-edit tasks have no writes and
   parallelize freely (§7).

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

## 7. Parallelize independent work

Delegation is only fast if independent tasks run concurrently. Default to
dispatching in parallel; serialize ONLY when one task's output feeds the next.

- **Non-edit tasks (review, research, reasoning)** never touch the working tree
  — fan them out freely. Launch multiple `agy:agy-rescue` Agent calls (and/or
  Codex agents, and/or backgrounded `agy --print` Bash jobs) in a SINGLE turn,
  then collect the inline results. A review across N modules or several
  independent research questions should all be in flight at once, not one after
  another. (No `agy_status` polling — inline dispatch means each result arrives
  as its agent returns; bound any genuine external poll — §8.)
- **Edit tasks** parallelize only under isolation (§4.5): disjoint file sets or
  separate worktrees. Otherwise serialize.
- **Small fan-out (≈2–4 independent tasks):** just issue the delegations
  together in one turn (multiple Agent calls / background Bash jobs) and gather
  the results — no extra machinery needed.
- **Large or multi-stage fan-out** (many files; find→fix→verify pipelines;
  migrations; broad audits): use the **Workflow** tool. It pipelines work across
  many subagents deterministically and runs concurrent edits safely via
  per-agent `isolation: 'worktree'`. Workflow agents still route by these rules
  — reach Codex with `agentType: 'codex:codex-rescue'` and AGY via its tools, so
  the wallet-with-headroom and tier rules hold inside the workflow too. Workflows
  spend many agents and tokens; use them for genuinely parallel, substantial
  work, not trivial pairs.

Acceptance gates (§3) and the one-writer protocol (§4) still apply to every
delegated change, parallel or not: gate each result and land it as its own
commit.

## 8. Waiting on delegated work (don't hand-roll waiters)

Backgrounded Bash jobs and tracked agents re-invoke you automatically when they
finish — so the default is to **not poll at all**. Dispatch
(`run_in_background: true`, or an Agent / Workflow call), end your turn, and act
on the completion notification. A hand-rolled wait loop is usually pure waste,
and it is where the runaway-waiter failures come from.

When you genuinely must poll something the harness can't notify you about (an
external queue, a status that lives only behind a tool call), every wait MUST
be:

- **Bounded** — a max attempt count or wall-clock deadline. Never a loop whose
  only exit is the condition you're hoping for.
- **Matched by PID, not substring** — `pgrep -f "<task-id>"` matches the
  *waiter's own command line* (which contains that id), so it never sees the
  worker exit and spins forever. Capture the worker PID and watch that.
- **Watching a field you've confirmed changes** — never block on a status value
  until you've seen it transition at least once. A field the producer never
  updates is an infinite loop (the AGY `agy_status` / per-job `<id>.json` trap
  in §2 is exactly this — which is why both AGY paths there are inline, not
  polled).

Canonical bounded, PID-based wait (only when notifications aren't available):

```bash
# $WORKER_PID = the PID to wait on (NOT a -f substring of it)
deadline=$(( SECONDS + 1800 ))          # 30-min hard cap
while kill -0 "$WORKER_PID" 2>/dev/null; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "wait: deadline hit for $WORKER_PID" >&2; break; }
  sleep 5
done
```

> ⚠️ Observed failure: a `pgrep -f "<task-id>"` waiter self-matched its own
> command line and spun on `sleep 5` for an hour — the worker had exited long
> before. If a waiter ever outlives its job, `kill -9` it (a self-matching
> `pgrep` loop won't die on a plain `kill`) and use the notification path next
> time.
