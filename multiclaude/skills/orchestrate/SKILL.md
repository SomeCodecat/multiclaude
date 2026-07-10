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

> **What runs on whose quota — read this first.** The Agent tool, every
> Workflow `agent()`, and every subagent run a **Claude driver on an Anthropic
> model — your own quota** (by default the inherited main-loop model).
> `agentType` / `subagent_type` swap only the system prompt and tools, **not the
> provider** — a custom agent's own definition may pin a different *Anthropic*
> model, but nothing here ever moves execution onto AGY / Codex. Work lands on
> AGY / Codex quota ONLY when something actually executes the `agy` / `codex`
> CLI via Bash. A
> fan-out of N "rescue" subagents is **N Claude drivers = N× your own quota**,
> not offload (observed: a 15-way `agy:agy-rescue` workflow burned ~800k of
> *own* Opus quota and offloaded nothing). Real offload = a Bash-only node whose
> prompt is **command-shaped** and that carries **no `schema` and no Read/Edit
> tools** (any of those makes the driver do the work itself). Mechanics in §7.

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

§0 is mechanical — a script does it, you read the result. Don't run availability,
tier-resolution, or health commands by hand and interpret them; that's exactly
the AI work this plugin pushes into code.

1. **Run the probe once, read its block:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/probe.mjs"
   ```

   (Pure Node — runs the same on Linux, macOS, and Windows; no bash/python3.)

   It emits one labeled block covering, deterministically:
   - **opt-out** — `orchestrate: OFF` if the project CLAUDE.md has `orchestrate:
     off`. If OFF: tell the user once, work normally, skip §1–§8.
   - **availability** — `codex` / `agy` present or MISSING (with the exact install
     command), and whether the superpowers / claude-mem plugins are enabled.
   - **AGY tiers** — Opus / Sonnet / Gemini-high / Gemini-medium **resolved by
     pattern** off `agy models` (names drift — the script matches `Claude.*Opus`
     etc. so you never hardcode). Use the printed names **verbatim**. A tier shown
     as `none` carries its step-down (Opus→Sonnet→Gemini-high→Gemini-medium).

   Add `--smoke` to also round-trip each CLI (`reply with exactly: OK`) for a
   HEALTHY/DEGRADED verdict — install ≠ authenticated ≠ working, and a CLI can
   pass `command -v` yet hang on a real call (observed: a real `--print` hung
   despite `agy models` listing tiers). The round-trip costs a little external
   quota, so it's **opt-in**; run `node "${CLAUDE_PLUGIN_ROOT}/scripts/probe.mjs"
   --smoke` once when you want to catch auth/backend breakage before depending on
   a CLI.

2. **Act on the probe block (this part is judgment — yours):**
   - **Missing CLI** → warn ONCE with the fix the probe printed, mark it
     unavailable for the whole session, re-route its work cross-agent:
     - Codex missing → implementation tasks to AGY Sonnet/Opus tier
     - AGY missing → review / heavy reasoning to Codex if suitable, else local
     - Both missing → say so once, work normally without orchestration.
   - **Plugin not enabled** → run `node
     "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply` (idempotent — merges the
     marketplace + enabledPlugins entries from the repo's `setup/settings.json`).
   - **Tier `none`** → use the step-down the probe noted. **DEGRADED** (with
     `--smoke`) → route around that CLI this session. (This within-AGY step-down
     is distinct from §5 quota re-routing.)
3. **Wallet headroom snapshot (proactive).** The multiclaude hooks inject a
   compact headroom line automatically — at session start and before every
   Task/Workflow dispatch (`[multiclaude wallets @ …] CODEX … | CLAUDE … | AGY
   …`). Normally you run nothing: read that line from context and let it bias
   routing — spend the wallet with headroom (§2) and don't start work a wallet
   can't finish (§5). It carries:
   - **Codex** — 5h and weekly % used + reset times (instant, local files).
   - **Claude (own block)** — burn rate, projection, minutes left in the active
     5-hour block (the most decision-relevant read).
   - **AGY** — no readout exists; treat as full until a §5 error says otherwise.

   The snapshot is cached and refreshed in the background, so it can lag a few
   minutes and the first of a session may read `CLAUDE refreshing` until the
   ccusage value lands — never block on it. If the line is absent (hooks
   disabled / `hooks/hooks.json` not loaded) run it by hand; the full readout is
   always at `/multiclaude:quota`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-snapshot.mjs"
   ```

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

| Task type | Agent | Model | Dispatch |
|---|---|---|---|
| Mechanical code: boilerplate, renames, config/doc edits, small clearly-specced fixes, formatting | Codex | `gpt-5.6-luna`, effort `medium` | Agent tool `multiclaude:mc-codex`, `model: "haiku"` |
| Standard code: features, ordinary bug fixes, refactors, test writing, everyday implementation | Codex | `gpt-5.6-terra`, effort `high` | Agent tool `multiclaude:mc-codex`, `model: "haiku"` |
| Hard code: complex refactors, tricky bugs, architecture, long agentic runs, security-sensitive | Codex | `gpt-5.6-sol`, effort `xhigh` | Agent tool `multiclaude:mc-codex`, `model: "haiku"` |
| Code review, research, analysis, docs | AGY | default tier (Gemini-class assumed) | Agent tool `multiclaude:mc-agy`, `model: "haiku"` |
| Hard review/research, architecture analysis | AGY | Gemini-high tier | `multiclaude:mc-agy` + `--model`, or Bash for batches |
| Heavy reasoning (would use own Sonnet) | AGY | Sonnet tier | `multiclaude:mc-agy` + `--model`, or Bash for batches |
| Hardest reasoning (would use own Opus) | AGY | Opus tier | `multiclaude:mc-agy` + `--model`, or Bash for batches |

(`multiclaude:mc-agy` accepts `--model "<resolved tier name>"`, so any tier
can dispatch through the Agent path; use the Bash path for batches and very
long jobs.)

**Codex tier rule.** Name the tier + effort explicitly on EVERY Codex
dispatch — never rely on the CLI's config default (that is the user's
interactive setting, not the orchestrator's); the **Dispatch mechanics**
block below shows how each path carries them. When unsure between two bands,
pick the lower and escalate one band only if a §3 gate fails: one
re-dispatch after a real failure is cheaper than defaulting everything
upward. If the CLI rejects the model name (older CLI, account gating), retry
once with no model flag — the one permitted fall-back to the config default —
and note the degraded routing in the synthesis.

**Dispatch mechanics:**

- **Choose the dispatch path by situation (applies to both delegates):**

  1. **Interactive default — the plugin's own forwarder agents.** Agent tool
     with `subagent_type: "multiclaude:mc-codex"` (edits) or
     `"multiclaude:mc-agy"` (review / research), always `model: "haiku"`.
     Runtime controls go FIRST in the dispatch prompt — `--model
     gpt-5.6-<tier> --effort <effort>` for Codex; `--model "<resolved tier
     name>"` and `--edit` for AGY — then the task text. You get a native
     agent card, an inline result, and a guaranteed foreground CLI call.
  2. **Batches, loops, very long jobs — direct CLI via backgrounded Bash.**
     Zero driver cost; the harness notifies on completion (§8). Codex:
     `timeout 900 codex exec -m gpt-5.6-<tier> -c
     model_reasoning_effort="<effort>" --full-auto - < <promptfile>` —
     `codex exec` has no `--effort` flag; effort only passes via `-c`. The
     codex sandbox blocks `.git` writes: never ask Codex to commit; the
     orchestrator commits. AGY: the `agy --print` forms below.
  3. **Big fan-out (≥3 independent nodes) — the Workflow tool,** only after
     the user opts in (see "Ask before you fan out" under Workflow fan-out).

  > ⚠️ Do NOT dispatch to the external `codex:codex-rescue` /
  > `agy:agy-rescue` agents. Observed 2026-07-10: codex-rescue backgrounds
  > multi-step tasks by design and returns a placeholder instead of the
  > result; agy-rescue's driver can answer the task itself without ever
  > calling the CLI (`tool_uses: 0`). The `mc-*` agents above are the
  > supported forwarders.

- **AGY — always dispatch for an INLINE result; never poll a job.** Two paths,
  both hand the result back in the same turn:

  1. **Any tier, bounded research / review / analysis / edits →** the Agent
     tool with `subagent_type: "multiclaude:mc-agy"` and `model: "haiku"`,
     runtime controls first (`--model "<resolved tier name>"`, `--edit`). It
     runs AGY in the foreground and returns the output directly — no job id,
     no status file, no polling.
  2. **Batches / very long timeout →** the `agy --print` CLI in a
     **backgrounded Bash** (`run_in_background: true`); the harness notifies
     you on completion and you read the captured stdout (don't hand-roll a
     waiter — §8).

     Write the prompt to a temp file (via the Write tool, so no shell parses
     it). **Always wrap the call in an OS-level `timeout`** — `--print-timeout`
     is NOT a reliable backstop (observed: a `--print-timeout 30m` job hung 59
     minutes at near-zero CPU; `timeout(1)` is the only cap that actually
     fired). Two passing forms by prompt size:

     **Small prompt (≲100 KB)** — the prompt is the **value** of `--print`
     (alias `--prompt`), read back inside double quotes (NOT a trailing
     positional):

     ```bash
     timeout 600 agy --print="$(cat /tmp/agy_task.md)" \
         --model "<resolved tier name>" \
         --dangerously-skip-permissions   # edit tasks only — omit for read-only
     ```

     **Large / grounded prompt (>~100 KB)** — pass it on **stdin** (`--print`
     with no value reads stdin). argv caps a single argument at ~128 KB
     (`MAX_ARG_STRLEN`), so `--print="$(cat bigfile)"` dies with **`Argument
     list too long`** and never runs — and an inlined-code prompt (§"Ground the
     prompt") routinely exceeds that:

     ```bash
     cat /tmp/agy_task.md | timeout 600 agy --print \
         --model "<resolved tier name>" \
         --dangerously-skip-permissions   # edit tasks only — omit for read-only
     ```

     **Check the CLI's own exit code — never chain `agy …; echo done`.** A
     trailing `echo`'s `exit 0` masks the CLI's failure (observed: an `Argument
     list too long` that died was reported as success by a following `echo`).

  > ⚠️ Do NOT use the AGY **MCP** tools (`agy_rescue` / `agy_review` /
  > `agy_adversarial_review`) or `--background` + `agy_status` / `agy_result`
  > polling. The plugin writes each job's per-job `<id>.json` exactly once as
  > `status: "queued"` and never updates it — only the separate `state.json`
  > index advances — so a waiter that polls the job file (or a hand-rolled
  > `sleep`+`cat` loop) hangs on `queued` forever, even after the job has
  > finished and written its result. The two inline paths above sidestep the
  > broken state tracker entirely. (Observed: a completed review left a poller
  > stuck ~14 min.) The AGY plugin may also auto-start an MCP server
  > (`agy-mcp-server.mjs`) so its tools show up as available — ignore them
  > regardless; the two inline CLI paths above are the only supported AGY routes.

  > ⚠️ Prompt-passing failure modes (CLI path): `agy --print --print-timeout 30m
  > … "<prompt>"` (prompt as a trailing positional) makes `--print` swallow
  > `--print-timeout` as its value — AGY acts on the literal text
  > "--print-timeout" and ignores your real prompt. And `--print="$(cat file)"`
  > without the surrounding double quotes word-splits a multi-line prompt.
  > Always use the quoted `--print="$(cat <file>)"` form for small prompts, or
  > the stdin form above for large ones.

**Always pass `model: "haiku"` on `mc-*` Agent calls.** Both forwarder agents
are thin (one Bash call, output returned verbatim); the driver does no
reasoning, and without the override the driver inherits your main-loop model —
every dispatch then spends the scarce wallet just to forward a string. The
call-site `model` overrides the agent's own frontmatter.

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
  itself" for small / broad exploration — not for anything whose correctness
  depends on exact code, and not for synthesis over many files, where an agentic
  read loop is also **hang-prone** (the 59-minute hang above was a ~35-file read
  loop; inlined and run single-shot via stdin, the same task finished in
  seconds). For multi-file synthesis, inline the content and run single-shot.
- **Anti-fabrication clause, verbatim in every prompt:** *"Ground every factual
  claim in files you actually read. If a file read or command fails, output the
  exact error and STOP — do not invent or guess file contents, signatures,
  schema, routes, or names. If unsure, say so explicitly."*

### Workflow fan-out (many offload nodes)

For ≥3 independent offload nodes (parallel review sweep, multi-angle
research, edit fan-out under §4 isolation), drive the fan-out with the native
Workflow tool: the script gives deterministic loops and barriers while every
node's compute stays on an external wallet.

**Ask before you fan out.** The Workflow tool requires explicit user opt-in.
When a task classifies as big and multi-step (≥3 independent substantive
nodes, or a multi-phase pipeline), ask the user ONE question — Workflow
fan-out (say roughly how many nodes and which wallets) vs. sequential
dispatch — and launch a Workflow only on a yes. Never launch one unprompted;
small tasks never trigger the question.

- **Node shape (the only supported one):** default workflow subagent,
  `model: 'haiku'`, `effort: 'low'`, and a Bash-only command-shaped prompt
  that runs the external CLI **synchronously** and returns raw stdout:

  ```js
  const results = await parallel(items.map(it => () =>
    agent(`Write the TASK below verbatim to /tmp/mc_${it.id}.md (quoted
  heredoc), then run exactly:
  codex exec -m gpt-5.6-terra -c model_reasoning_effort="high" --skip-git-repo-check - < /tmp/mc_${it.id}.md
  Return its raw stdout, nothing else.
  TASK:
  ${it.task}`,
      { model: 'haiku', effort: 'low', label: `codex:${it.id}` })))
  ```

  No `schema`, no Read/Edit expectations — §7 applies per node; parse the
  raw text in the script's plain JS. Per-item content rides the prompt body
  into a per-node temp file — never interpolate it inside shell quotes (one
  quote character in the task breaks the command). Both CLIs read stdin:
  `cat <file> | timeout 600 agy --print --model "<tier>"` and `codex exec
  -m gpt-5.6-<tier> - < <file>` (the `-` reads the prompt from stdin;
  `"$(cat <file>)"` is argv and dies at ~128 KB).

- **All three wallets at once.** Nodes are independent — mix Codex nodes,
  AGY nodes, and (sparingly) own-Claude nodes in the same
  `parallel()`/`pipeline()`. Two named patterns: a **cross-provider judge
  panel** (same question to `gpt-5.6-sol`, AGY Gemini-high, and one
  own-quota driver; majority or synthesis wins) and **headroom-weighted
  partitioning** (split a work list across wallets in proportion to the
  hook's headroom line).

- **Do NOT use `agentType: 'codex:codex-rescue'` / `'agy:agy-rescue'` inside
  workflows.** Observed 2026-07-10: the forwarder may background the CLI and
  resolve `agent()` early with a placeholder string, and a
  non-command-shaped prompt makes the Claude driver answer on your own quota
  (`tool_uses: 0`). The synchronous node shape above avoids both.

- **Concurrency:** a workflow runs ~10 nodes concurrently against the
  external wallets' own rate limits, and the wallet-headroom hook fires once
  per Workflow call — not per node. Size the fan-out to the headroom line;
  batch smaller when a wallet is tight (§5).

- **Edit nodes** fan out only with `isolation: 'worktree'` or provably
  disjoint file sets — the §4 one-writer rule governs inside workflows too.

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

**Empty result = dispatch failure.** The rescue agents return nothing when the
underlying CLI call fails. Treat an empty or near-empty result as a dispatch
error — re-route per §5 — never as "no findings". It consumes no rework hop.

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

## 5. Quota-aware routing (proactive headroom + reactive re-routing)

### Proactive — bias by the §0 headroom snapshot

Prefer the wallet with the most headroom and keep your own Claude block in
reserve. Headroom **biases** routing; it does not override task-fit (§2) — a
near-cap wallet is deprioritized, not banned, and a tiny task that obviously
fits is still fine.

- **Don't start work a wallet can't finish.** A 5-hour or weekly window resets
  on a clock; a task that crosses an exhaustion boundary is killed mid-flight and
  the tokens already spent on it are wasted — the failure mode the snapshot
  exists to prevent. If Codex 5h or weekly is near its cap (≳90%) with little
  time left before reset, don't hand it a long edit task: route to AGY, give
  Codex only work that clearly fits the remaining budget, or — if the user isn't
  blocked — wait for the reset. Size every dispatch to the headroom you saw.
- **Watch your own block.** If the Claude snapshot shows a high burn rate or a
  projection that runs past the block with few minutes left, delegate harder and
  avoid local heavy reasoning — your own window is the scarce, shared one.
- **AGY can't be pre-judged** (no readout), so with Codex tight and your own
  block tight, AGY's separate quota is usually the safe landing zone — keep using
  it until a reactive error marks it exhausted.

### Reactive — re-route on a quota error (errors are NOT quality failures)

Exhaustion is also detected via quota/rate-limit errors from a call. On one:

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
  — fan them out freely. Launch multiple `multiclaude:mc-agy` Agent calls
  (and/or `multiclaude:mc-codex` agents, and/or backgrounded CLI Bash jobs)
  in a SINGLE turn,
  then collect the inline results. A review across N modules or several
  independent research questions should all be in flight at once, not one after
  another. (No `agy_status` polling — inline dispatch means each result arrives
  as its agent returns; bound any genuine external poll — §8.)
- **Edit tasks** parallelize only under isolation (§4.5): disjoint file sets or
  separate worktrees. Otherwise serialize.
- **Small fan-out (≈2–4 independent tasks):** just issue the delegations
  together in one turn (multiple Agent calls / background Bash jobs) and gather
  the results — no extra machinery needed.
- **Pure offload fan-out** (N independent CLI jobs, no pipeline / verify
  stages): prefer **N backgrounded `agy --print` / `codex exec` Bash jobs** over
  a Workflow of rescue agents. The Bash jobs shell out to external quota directly
  with none of the N-drivers trap; a Workflow of `*-rescue` agents spends N
  Claude drivers on YOUR quota unless every node is hand-built to shell out
  (the driver-thin rule below) — needless risk when you only want parallel CLI
  calls.
- **Large or multi-stage fan-out** (many files; find→fix→verify pipelines;
  migrations; broad audits): use the **Workflow** tool for the *orchestration* —
  it pipelines work across many subagents deterministically, runs concurrent
  edits safely via per-agent `isolation: 'worktree'`, and — crucially — the
  harness tracks each agent's completion, so there is no waiter to hand-roll and
  none of the §8 hung-poller / self-matching-`pgrep` failure class can occur. But
  **a Workflow does not offload by itself** — every `agent()` is a Claude driver
  on your own quota (top-of-file box); to land on external quota each node must
  satisfy the driver-thin rule below. No AGY MCP tools inside a workflow (§2).
  Workflows spend many agents and tokens; use them for genuinely parallel,
  substantial work, not trivial pairs.

**Driver-thin rule (the top-of-file box, operationalized):** an offload node
must be **Bash-only, schema-free, with a command-shaped prompt** — *"Run exactly
this command and return ONLY its stdout, verbatim. Do not read files, analyze,
or summarize: `agy --print --model "<tier>" "<task>"`"*. A `schema`, Read/Edit
tools, or a task-shaped prompt ("map this module") makes the driver do the work
itself on YOUR quota (observed: 15 `agy:agy-rescue` drivers given a `schema` +
read tools burned ~800k own tokens and offloaded nothing).

**Verify the quota, not just the result.** Offload failures are silent — the
result still comes back, just billed to the wrong wallet. After an offload
dispatch, confirm it landed externally: for CLI jobs, that a real process did
the work (`ps aux | grep -E '[a]gy|[c]odex'` while it runs); for Workflow /
Agent jobs, open `/workflows` — agents showing **your** main model with high
token counts mean you are NOT offloading. Treat unexpectedly-high local spend as
a delegation failure, fix the node (command-shaped prompt, no schema, Bash-only),
and re-run before continuing.

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
  updates is an infinite loop (the §2 AGY poller trap is exactly this).

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

**Hung vs. working.** A healthy agentic job accrues CPU as it makes tool calls;
a stalled model/auth call does not — so compare accumulated CPU to elapsed time:

```bash
ps -o pid,etime,time,stat -p <PID>     # or /proc/<PID>/stat fields 14–15 (utime/stime)
```

Near-zero accumulated CPU + long elapsed + zero output = **hung — kill it**
(`kill -9`) and re-dispatch single-shot (inline the content; see §2 — the
59-minute hang there showed 0.41 CPU-seconds).

**Recovering a killed / partial Workflow.** Completed `agent()` outputs survive
a `TaskStop` — they're already written to the run's transcript dir. When you
only need the finished subset, extract their StructuredOutput inputs with `jq`
instead of `resumeFromRunId` (cheaper, no straggler re-runs on your own quota):

```bash
jq -c '.. | objects
  | select(.type? == "tool_use" and .name? == "StructuredOutput") | .input' \
  agent-*.jsonl
```

(Recovered 13/15 structured maps this way after a kill — no re-run needed.)

## 9. Attribution — make the executor visible

Every delegated task must show who actually ran it — the provider, the
**exact model**, and (for Codex) the effort. It must be obvious at every
moment that a non-Claude agent is executing. Four surfaces:

1. **Live dispatch line.** Every dispatch announces its executor WHILE it
   runs: the Agent-tool or Bash `description` starts with the executor tag —
   `Codex gpt-5.6-terra @ high: <short task>`, `AGY Gemini 3.5 Flash
   (High): <short task>` — and your narration names the delegate when you
   dispatch and when you report its result. Delegated work must never look
   like Claude did it.
2. **Task tracker.** When dispatching work tracked as a task, append the
   executor to the subject — `[Codex · gpt-5.6-luna @ medium]`,
   `[AGY · <resolved tier name verbatim>]`, `[Claude · <driver model id>]` —
   and update it on escalation or re-dispatch so the FINAL executor is
   always visible. Move prior executors into task metadata
   (`executorHistory`, an array of the same bracket strings), not the
   subject.
3. **Synthesis.** The final report lists each subtask with its executor.
   Exact-model rules: Codex = full model id + effort (`gpt-5.6-terra @
   high`); AGY = the §0 probe-resolved tier name verbatim (names drift —
   never paraphrase); own Claude = the actual driver model id.
4. **Commits and workflow labels.** Delegated-edit commits carry a body
   trailer `Implemented-by: <Provider> (<exact model>[, effort <effort>])`
   — e.g. `Implemented-by: Codex (gpt-5.6-luna, effort medium)` or
   `Implemented-by: AGY (Claude Sonnet 4.6 (Thinking))`. Workflow fan-out
   nodes (§2) encode the executor in `label` as
   `<provider>:<model>[@<effort>]:<item>` — e.g.
   `codex:gpt-5.6-terra@high:<item>`, `agy:Gemini 3.5 Flash (High):<item>`
   — so `/workflows` shows it live.

Attribution is not optional bookkeeping: it is what makes §5 quota decisions
and §6 rework routing auditable after the fact.
