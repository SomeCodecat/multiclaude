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
> provider**. Work lands on AGY / Codex quota ONLY when something actually
> executes the `agy` / `codex` CLI. The plugin gives you exactly two ways that
> do: the **`dispatch` tool** (`mcp__multiclaude__dispatch`, no driver at all)
> and the **`dispatch.mjs` runner** via Bash. A fan-out of N "rescue"
> subagents is **N Claude drivers = N× your own quota**, not offload (observed:
> a 15-way `agy:agy-rescue` workflow burned ~800k of *own* Opus quota and
> offloaded nothing). Mechanics in §2 and §7.

Two directional rules sharpen this:

- **AGY's Claude tier before your own Sonnet/Opus.** Any reasoning you'd
  otherwise run on your own Sonnet/Opus goes to AGY's Claude tier FIRST — same
  model family, separate paid quota. Spend your own Sonnet/Opus only when AGY's
  Claude pool is exhausted (§5) or unavailable (§0).
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

   It emits one labeled block covering, deterministically:
   - **opt-out** — `orchestrate: OFF` if the project CLAUDE.md has `orchestrate:
     off`. If OFF: tell the user once, work normally, skip §1–§9.
   - **availability** — `codex` / `agy` present or MISSING (with the exact install
     command), and whether the superpowers / claude-mem plugins are enabled.
   - **Codex bands** — `mech` / `std` / `hard` / `max`, each as `<slug> @
     <effort>`, resolved by **role** off the live catalog (the server's own
     description: "fast / affordable" → mech, "workhorse" → std, "frontier / most
     demanding" → hard). The catalog's `priority` is only the picker's list
     order, never a capability rank. Slugs drift every generation; **never
     recall one from memory — use the probe's.**
   - **AGY tiers** — `opus` / `sonnet` / `gem-top` / `gem-hi` / `gem-med` /
     `gem-lo` as **bare model ids** (e.g. `claude-sonnet-5-5-high`,
     `gemini-3.8-flash-medium`), resolved by family + version + effort off `agy
     models`. The display name after `//` is for attribution only. A tier shown
     as `none` carries its step-down.

   Add `--smoke` to also round-trip each CLI through the runner (`reply with
   exactly: OK`) for a HEALTHY/DEGRADED verdict — install ≠ authenticated ≠
   working. It spends a little external quota, so it's **opt-in**.

2. **Act on the probe block (this part is judgment — yours):**
   - **Missing CLI** → warn ONCE with the fix the probe printed, mark it
     unavailable for the whole session, re-route its work cross-agent:
     - Codex missing → implementation tasks to AGY Sonnet/Opus tier (`edit: true`)
     - AGY missing → review / heavy reasoning to Codex if suitable, else local
     - Both missing → say so once, work normally without orchestration.
   - **Plugin not enabled** → run `node
     "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply` (idempotent).
   - **Tier `none`** → use the step-down the probe noted. **DEGRADED** (with
     `--smoke`) → route around that CLI this session.
3. **Wallet headroom snapshot (proactive).** The multiclaude hooks inject a
   compact headroom line automatically — at session start and before every
   Agent/Task/Workflow dispatch:
   `[multiclaude wallets @ …] CODEX … | CLAUDE … | AGY gemini 5h N%/wk N% ·
   claude 5h N%/wk N% · argon wk N% …`. Normally you run nothing: read that
   line from context and let it bias routing (§5). It carries:
   - **Codex** — each rate-limit window the plan has (`5h` and/or `wk`) with %
     used + reset (local files, instant).
   - **Claude (own)** — official 5h + weekly utilization %, weekly by model,
     block cost and burn rate.
   - **AGY** — **real per-pool quota** from `agy -p /usage`: `gemini`
     (Flash + Pro), `claude` (Claude Opus/Sonnet + GPT-OSS) and, on paid plans,
     a separate `argon` bucket (Gemini 4 Argon). Each pool has a 5h and a weekly
     window.

   The snapshot is cached and refreshed in the background, so it can lag a few
   minutes and the first of a session may read `CLAUDE refreshing` / `AGY
   refreshing` — never block on it. If the line is absent, run it by hand; the
   full readout is always at `/multiclaude:quota`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-snapshot.mjs"
   ```

## 1. What to delegate

Default action for any substantive task: **delegate.** Keep a task local ONLY
when one of these holds:

1. **Trivial** — a one-liner or tiny edit where dispatch overhead (context
   serialization, gates, diff skim) clearly exceeds the work.
2. **Un-serializable context** — the task depends on conversation-history nuance
   that can't be written into a prompt without effectively re-deriving it.
   Context transfer is the dominant hidden cost: delegates don't share this
   conversation, so a context-heavy task can cost MORE delegated than done
   locally.
3. **No agent available** — all suitable externals exhausted (§5) or unavailable
   (§0).

If none hold, delegate — even when unsure.

**Two task families:**

- **Edit tasks** (write / refactor / test code) → Codex by default; AGY Claude
  tier (`edit: true`) for rework/fallback. Codex idling is under-delegation just
  as much as AGY idling.
- **Non-edit tasks** (review, research, analysis, architecture, heavy reasoning,
  docs) → AGY: gem-med by default, gem-hi / gem-top or the Claude tiers by
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
your own job. Heavy-reasoning work that belongs on AGY Claude / gem-hi:
multi-step planning, tricky-bug analysis, architecture trade-offs, synthesizing
large material, deep code review. If several substantive tasks have passed and
AGY *or* Codex stayed idle, you're under-delegating — fix it on the next task.

## 2. Routing

Bands and tiers come from §0's probe — the table names them, the probe
resolves them to today's ids. Never type a slug or model id from memory.

| Task type | Delegate | Band / tier (from probe) |
|---|---|---|
| Mechanical code: boilerplate, renames, config/doc edits, small clearly-specced fixes, formatting | Codex | `mech` |
| Standard code: features, ordinary bug fixes, refactors, test writing, everyday implementation | Codex | `std` (the default) |
| Hard code: complex refactors, tricky bugs, architecture, long agentic runs, security-sensitive | Codex | `hard` |
| Escalation only: a hard-band task that already failed a §3 gate, or a whole-system design/security audit | Codex | `max` |
| Code review, research, analysis, docs | AGY | `gem-med` (the default) |
| Hard review/research, architecture analysis | AGY | `gem-hi` (or `gem-top` when the newest Gemini family is a clear step up and its own `argon` bucket has headroom) |
| Heavy reasoning (would use own Sonnet) | AGY | `sonnet` |
| Hardest reasoning (would use own Opus) | AGY | `opus` |
| Implementation rework / Codex fallback | AGY | `sonnet` or `opus`, with `edit: true` |

**Band rules.** Name the band's model + effort explicitly on EVERY dispatch —
never rely on a CLI's config default (that is the user's interactive setting).
When unsure between two bands, pick the lower and escalate one band only if a
§3 gate fails. If the `hard` model is rejected (account gating, old CLI), use
the probe's `hard-fallback`; the mechanical and standard bands are unaffected.

**Flash tiers and cross-cutting fixes.** The Gemini Flash tiers (`gem-hi` /
`gem-med` / `gem-lo`) are reliable on single-file or well-bounded fixes and
on exploration-heavy work (they found 12 real bugs with exact causes across
~8M tokens), but on fixes that cut across modules they have ignored project
rules the brief repeated (i18n, "this config is private") and added a
circular import. Route cross-cutting fixes to Codex `std`/`hard` or `gem-top`;
if a Flash tier does one anyway, review its diff for convention breaks,
leaked private data and new import cycles before accepting it.
Gemini 4 Argon (`gem-top`) draws from its **own** `argon` quota bucket on paid
plans — a cheap way to keep the main `gemini` pool free, and a bucket to avoid
once the hook line shows it near its cap.

### Dispatch mechanics — three paths, in order of preference

1. **The `dispatch` tool (default — no driver, non-blocking, native UI).**
   The plugin registers `mcp__multiclaude__dispatch`. Call it directly:

   ```
   dispatch({ delegate: "agy", model: "<probe id>", label: "review auth middleware",
              prompt: "<grounded task text>" })
   dispatch({ delegate: "codex", model: "<probe slug>", effort: "high",
              label: "add rate limiter", prompt: "<grounded task text>" })
   ```

   It returns a **job id immediately**; the job runs in the background on the
   delegate's quota and the chat is never blocked. **Do not poll.** When the
   job finishes the plugin wakes you with a message carrying the proof line
   `[dispatch agy model=… status=SUCCESS tokens=N dur=Ns out=<file>]` and the
   answer (long answers are truncated in the wake-up; the full text is one
   `dispatch_status({ id })` away, or in the `out=` file). Meanwhile carry on
   with other work or end your turn. `dispatch_status()` (no id) lists every
   job with status, elapsed time and current step; `dispatch_status({ id })`
   gives one job's progress, or its full answer once done;
   `dispatch_cancel({ id })` kills one. A job that passes 80% of its
   `timeout` wakes you once: check its transcript and either
   `dispatch_extend({ id, seconds })` or let it run out.

   `edit: true` (agy) lets the delegate run commands and modify files — without
   it agy's headless mode **auto-denies every command** and the job ends
   `status=DENIED`. `sandbox` (codex) defaults to `workspace-write`. The job
   runs the CLI through `scripts/dispatch.mjs`, so the model id is validated
   against the live catalog before anything is spent and the prompt never
   touches a shell. While it runs, the **Delegates pane** (it opens when this skill
   loads; `/delegates` reopens it, `/wallets` shows the wallets) and the status line show provider · model · elapsed · current step —
   non-Claude execution is always visible, and it costs you zero driver
   tokens. Several dispatches run concurrently (§7). Edit jobs still obey the
   one-writer rule (§4): don't touch the tree while one runs.

2. **Batches, loops, very long jobs — the runner via backgrounded Bash.** Same
   runner, same validation and proof line, but you end your turn and the
   harness notifies you on completion (§8). Live step lines go to stderr (the
   background-task panel); the final answer goes ONLY to `--out`, so you read
   one small file, never the event stream:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" agy --model <id> [--edit] \
       --job auto --label "<short task>" --out /tmp/mc_<id>.md <<'MC_TASK'
   <task text>
   MC_TASK
   ```

   (`codex` takes `--model <slug> --effort <e> [--sandbox …]`; the prompt rides
   stdin on both — a quoted heredoc or `< file` — so no shell quoting rules
   apply. `--job auto` registers the run in the Delegates pane and
   `dispatch_status`, with its full transcript.) Exit codes: 0 ok · 1 failed
   (proof says `QUOTA` for a quota error) · 2 bad usage (unknown id, agy
   prompt over ~120 KB) · 3 agy DENIED (needs `--edit`) · 124 timeout.

3. **Fallback forwarders — `multiclaude:mc-agy` / `multiclaude:mc-codex`.**
   Thin Haiku drivers that make exactly one Bash call to the same runner. Use
   them ONLY where the `dispatch` tool isn't listed (a host that doesn't load
   plugin modules). A forwarder holds a Claude driver open for the whole run
   (one was killed after 4 h); on any host with the tool, never use them. Always pass `model: "haiku"` on the Agent call and put the
   runtime controls (`--model <id> --effort <e> --edit`) first in the prompt.

> ⚠️ Never dispatch to the external `codex:codex-rescue` / `agy:agy-rescue`
> agents (observed: codex-rescue backgrounds and returns a placeholder;
> agy-rescue's driver answers the task itself with `tool_uses: 0`), never use
> the AGY MCP tools (`agy_rescue` / `agy_review` / …) or `--background` +
> `agy_status` polling (their job files never leave `queued`), and never call
> `agy` / `codex` by hand with a prompt on the command line — the runner exists
> so that the prompt-as-argv, display-name-as-model, and silent-picker failure
> classes cannot happen.

**Codex sandbox limits.** `workspace-write` blocks local IPC sockets: anything
that opens one (e.g. `tsx`, which listens on a pipe under `/tmp/tsx-<uid>/`)
fails with `listen EPERM`. Don't ask Codex to run `tsx` scripts; run them
yourself after the job, or have the task use plain `node` on built output.

**AGY prompt size.** agy takes the prompt as ONE argv value (no stdin form since
agy 1.1), capped at ~128 KB. The runner refuses anything bigger (exit 2):
chunk the material across several AGY calls, or route the synthesis to Codex
(stdin, no cap).

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
  read loop is also **hang-prone** (observed: a ~35-file read loop ran 59 min at
  near-zero CPU and emitted nothing; inlined and run single-shot, the same task
  finished in seconds). For multi-file synthesis, inline the content and run
  single-shot.
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
fan-out (say roughly how many nodes and which wallets) vs. parallel `dispatch`
calls — and launch a Workflow only on a yes. Never launch one unprompted;
small tasks never trigger the question.

- **Node shape (the only supported one):** default workflow subagent,
  `model: 'haiku'`, `effort: 'low'`, and a command-shaped prompt that runs
  the runner through Bash **synchronously** (`--job auto` registers it in
  the Delegates pane and `dispatch_status`) and returns its raw output. Not
  the `dispatch` tool — that one returns a job id and wakes the *main* chat,
  which a workflow node cannot wait on:

  ```js
  const results = await parallel(items.map(it => () =>
    agent(`Run exactly this one Bash command (foreground, no edits to it) and
  return its complete output verbatim — stdout and stderr, including the final
  [dispatch …] proof line. Do not read files, analyze, or summarize.
  node "${PLUGIN_ROOT}/scripts/dispatch.mjs" agy --model ${AGY_GEMHI} --job auto --label "${it.id}" <<'MC_TASK'
  ${it.task}
  MC_TASK`,
      { model: 'haiku', effort: 'low', label: `agy:${AGY_GEMHI}:${it.id}` })))
  ```

  No `schema`, no Read/Edit expectations — §7 applies per node; parse the
  raw text in the script's plain JS. Each node is a Haiku driver that makes
  one Bash call: the work lands on the external wallet, `/workflows` shows
  every node live under its `label` (`<provider>:<model>:<item>`), and the
  Delegates pane shows the same runs tagged `·bash`. That is as close as the
  Workflow UI gets to a non-Claude executor — the harness only tracks Claude
  agents, so the thin driver is the price of the native card; the `dispatch`
  tool outside a workflow costs no driver at all. (`PLUGIN_ROOT` = the value
  of `${CLAUDE_PLUGIN_ROOT}` in your context; a Bash node has no such
  variable of its own.)

- **All three wallets at once.** Nodes are independent — mix Codex nodes,
  AGY nodes, and (sparingly) own-Claude nodes in the same
  `parallel()`/`pipeline()`. Two named patterns: a **cross-provider judge
  panel** (same question to Codex `hard`, AGY `gem-hi`, and one own-quota
  driver; majority or synthesis wins) and **headroom-weighted partitioning**
  (split a work list across wallets in proportion to the hook's headroom line).

- **Do NOT use `agentType: 'codex:codex-rescue'` / `'agy:agy-rescue'` inside
  workflows** (they background or self-answer; see above).

- **Concurrency:** a workflow runs ~10 nodes concurrently against the
  external wallets' own rate limits, and the wallet-headroom hook fires once
  per Workflow call — not per node. Size the fan-out to the headroom line;
  batch smaller when a wallet is tight (§5).

- **Edit nodes** fan out only with `isolation: 'worktree'` or provably
  disjoint file sets — the §4 one-writer rule governs inside workflows too.

## 3. Acceptance Gates (verify mechanically, not by re-reading)

**Gate 0 — read the proof line, every time.** Every dispatch ends with
`[dispatch <cli> model=<id> status=<S> tokens=<N> …]`:

- `status=SUCCESS` with a token count → the work ran on the delegate's wallet.
  Carry the id + tokens into §9 attribution.
- `status=QUOTA` → a quota / rate-limit error. Not a quality failure: re-route
  per §5, no rework hop consumed. `preflight` on the line means the runner
  refused before spending anything (the pool was already empty).
- `status=BUDGET` → an agy run hit its token cap (`maxTokens`; 350k by default
  on the AGY claude pool) and was stopped. Narrow the task or inline more of
  the ground truth, then re-dispatch; raise `maxTokens` only deliberately.
- `status=TOO_COMPLEX` (codex "exceeds complexity limits") → split the task.
  `status=PATCH_FAILED` → codex's patch did not apply; the tree is partly
  edited — inspect, reset (§4.4), re-dispatch with fresh file excerpts.
- `changed=N` on any failed line → the run left N changed files; the answer
  ends with their `git status --short`. Inspect or reset before rework.
- `envChanged=<files>` on ANY line, success included → the delegate changed
  untracked local config (`.env*`, `*.local*`) that git diff does not show.
  Treat it as a gate failure until you have looked: revert it unless the task
  asked for it (one delegate flipped a feature flag in `.env.local` to make
  its tests pass, and the tests failed in every other checkout).
- `fallback-from=<id>` → the preflight found that model's pool empty and ran
  the `fallback` instead; attribute to the model actually named in `model=`.
  `shared-pool=<pool>:N` → N other live jobs drew on the same quota window.
- `status=DENIED` (exit 3) → agy needed `edit: true`; re-dispatch with it (or
  rewrite the task as read-only) — no rework hop consumed.
- `steps=` counts the delegate's tool steps, `calls=` its model calls (agy).
  `tokens=` is the CLI's own total; each call re-sends the conversation, so
  cost grows with the square of the calls — the breakdown (in/out/cached)
  follows it.
- exit 2 → **your** bug (unknown model id, prompt too big): re-run the probe,
  fix the call, re-dispatch.
- `status=EMPTY` / `NO_RESULT` / `TIMEOUT` → dispatch failure: re-dispatch
  once (single-shot, inlined content), then re-route per §5.
- No proof line at all → the dispatch didn't go through the runner. Treat as
  a delegation failure, never as "no findings".

Then, after a delegated **edit** task returns, run in order:

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
   trailers (they carry the §9 `Implemented-by:` trailer instead).
4. Rejected work: `git checkout . && git clean -fd` (safe — tree was clean at
   dispatch), THEN send the rework.
5. Parallel EDIT tasks are allowed only under isolation: provably disjoint file
   sets, or separate git worktrees — `dispatch({ …, worktree: true })` (runner:
   `--worktree`) creates `<repo>/.claude/worktrees/mc-<job>` on branch
   `mc/<job>` and names it on the proof line; inside a Workflow, its
   `isolation: 'worktree'`. If the task runs a dev server or needs installed
   deps, say so in the prompt (install command, a free port per job). Two agents writing one working tree at once breaks
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
  exists to prevent. If a Codex window is near its cap (≳90%) with little time
  left before reset, don't hand it a long edit task: route to AGY's Claude tier
  (`edit: true`), give Codex only work that clearly fits, or — if the user isn't
  blocked — wait for the reset. Size every dispatch to the headroom you saw.
- **Several Claude accounts are ONE wallet.** When the snapshot reads
  `CLAUDE pool of N acct …`, the numbers are the mean used % across the
  stored accounts (`/multiclaude:accounts`), and auto-switch moves the login to
  another account before the active one hits its line. Judge Claude headroom by
  the pool line, not by the active account alone. Claude is exhausted only when
  the pool is (or auto-switch reports `blocked`). Do not switch accounts
  yourself to dodge a limit mid-task, and do not treat accounts as separate
  wallets to route between.
- **Watch your own block.** If the Claude snapshot shows a high burn rate or a
  projection that runs past the block with few minutes left, delegate harder and
  avoid local heavy reasoning — your own window is the scarce, shared one.
- **The AGY claude pool is small.** Agentic edit runs on `sonnet`/`opus`
  re-send their whole context every step: two parallel Sonnet edit jobs that
  `cat` whole files drained its full 5h window (and half the weekly one) in
  150 s, and both died with nothing to show. Run at most one long Claude-pool
  edit job at a time, inline the ground truth so it reads less, and pass
  `fallback: <gem-top or gem-hi id>`. The runner checks the pool before
  starting (`agy /usage`, cached 60 s), stops a run at its token budget, and
  prepends read-discipline rules to every agy prompt (`--no-preamble` skips
  them). The `dispatch` tool and the proof line (`shared-pool=`) tell you
  when other live jobs share the pool — the same holds for `argon`: three
  parallel Gemini 4 Argon jobs emptied its weekly bucket in ~45 min.
- **AGY pools are separate.** `gemini` and `claude` have independent 5h +
  weekly windows, and `argon` (Gemini 4 Argon) is a third bucket on paid plans.
  Spread load: a review sweep on the Gemini pool, reasoning on the Claude pool,
  and `gem-top` only while `argon` has room. A pool ≥ 90% in either window is
  "tight" — prefer another pool for anything long.

### Reactive — re-route on a quota error (errors are NOT quality failures)

Exhaustion also shows up as `status=QUOTA` on a proof line (or a quota /
rate-limit error from a CLI). On one:

- **AGY pool exhausted:** step to the other pool first, either direction
  (gemini out → `sonnet`/`opus`; claude out → `gem-hi`/`gem-top`). Both out →
  re-evaluate: Codex-suitable? → Codex; else Claude does it locally.
- **Codex exhausted:** re-evaluate: AGY-suitable? → AGY (implementation
  rework → `sonnet`/`opus` with `edit: true`, review/research → Gemini tier);
  else local.
- **Everything exhausted:** work normally on own quota; tell the user ONCE
  that orchestration is suspended.

A quota failure does NOT consume a rework hop (no work product was produced).

**Session exhaustion marks:** after a quota error, mark that delegate/pool
exhausted for the REST OF THE SESSION and skip it immediately for later tasks.
Tell the user once per session which are marked. Fresh sessions re-probe
naturally.

## 6. Fallback summary (quality failures)

Codex fails gates → AGY reworks (`sonnet`/`opus`, `edit: true`, failure summary
in prompt).
AGY fails gates → Codex reworks (failure summary in prompt).
Hard limit: 2 rework attempts total, then Claude takes over.
Rework prompts MUST summarize what the previous attempt got wrong.

## 7. Parallelize independent work

Delegation is only fast if independent tasks run concurrently. Default to
dispatching in parallel; serialize ONLY when one task's output feeds the next.

- **Non-edit tasks (review, research, reasoning)** never touch the working tree
  — fan them out freely. Issue several `dispatch` tool calls in a SINGLE turn
  (they run concurrently; each wakes you as it finishes), or several
  backgrounded runner jobs. A review across N modules or several independent research
  questions should all be in flight at once, not one after another.
- **Edit tasks** parallelize only under isolation (§4.5): disjoint file sets or
  separate worktrees. Otherwise serialize.
- **Small fan-out (2 independent tasks):** just issue the dispatches together in
  one turn and gather the results — no extra machinery needed. At ≥3
  independent substantive nodes the Workflow opt-in question applies (§2 "Ask
  before you fan out"); if the user declines, dispatch directly in parallel as
  here.
- **Pure offload fan-out** (N independent CLI jobs, no pipeline / verify
  stages): N parallel `dispatch` calls (or N backgrounded runner jobs) — never a
  Workflow of rescue agents, which spends N Claude drivers on YOUR quota.
- **Large or multi-stage fan-out** (many files; find→fix→verify pipelines;
  migrations; broad audits): the **Workflow** tool for the *orchestration* (§2
  "Workflow fan-out") — it pipelines deterministically, runs concurrent edits
  safely via `isolation: 'worktree'`, and the harness tracks each node's
  completion so no waiter is hand-rolled. Every node must still call the
  `dispatch` tool / runner with a command-shaped prompt and no `schema`, or it
  is a Claude driver doing the work itself.

**Driver-thin rule (the top-of-file box, operationalized):** an offload node
must be **schema-free, with a command-shaped prompt** that calls the `dispatch`
tool or the runner — *"Call the dispatch tool exactly once with {…} and return
its result verbatim. Do not read files, analyze, or summarize."* A `schema`,
Read/Edit tools, or a task-shaped prompt ("map this module") makes the driver do
the work itself on YOUR quota (observed: 15 `agy:agy-rescue` drivers given a
`schema` + read tools burned ~800k own tokens and offloaded nothing).

**Verify the quota, not just the result.** The proof line is the evidence: a
`tokens=N` count on `status=SUCCESS` means the delegate's wallet paid. For
Workflow / Agent jobs, open `/workflows` — nodes showing **your** main model
with high token counts mean you are NOT offloading. Treat unexpectedly-high
local spend as a delegation failure, fix the node, and re-run before continuing.

Acceptance gates (§3) and the one-writer protocol (§4) still apply to every
delegated change, parallel or not: gate each result and land it as its own
commit.

## 8. Waiting on delegated work (don't hand-roll waiters)

The `dispatch` tool wakes you with the result; backgrounded runner jobs and
tracked agents re-invoke you automatically when they finish — so the default
is to **not poll at all** (`dispatch_status` is for a deliberate progress check,
not a loop). Dispatch (`run_in_background: true`, or an Agent / Workflow call), end
your turn, and act on the completion notification. Do NOT read a background
job's live output into your context (that pays for the whole step stream);
read ONLY its `--out` file when it completes. A hand-rolled wait loop is pure
waste, and it is where the runaway-waiter failures come from.

When you genuinely must poll something the harness can't notify you about (an
external queue, a status that lives only behind a tool call), every wait MUST
be:

- **Bounded** — a max attempt count or wall-clock deadline. Never a loop whose
  only exit is the condition you're hoping for.
- **Matched by PID, not substring** — `pgrep -f "<task-id>"` matches the
  *waiter's own command line* (which contains that id), so it never sees the
  worker exit and spins forever. Capture the worker PID and watch that.
- **Watching a field you've confirmed changes** — never block on a status value
  until you've seen it transition at least once (the AGY `agy_status` trap).

Canonical bounded, PID-based wait (only when notifications aren't available):

```bash
# $WORKER_PID = the PID to wait on (NOT a -f substring of it)
deadline=$(( SECONDS + 1800 ))          # 30-min hard cap
while kill -0 "$WORKER_PID" 2>/dev/null; do
  [ "$SECONDS" -ge "$deadline" ] && { echo "wait: deadline hit for $WORKER_PID" >&2; break; }
  sleep 5
done
```

**Hung vs. working.** The runner already kills a delegate at `--timeout`
(default agy 600 s / codex 900 s) and reports `TIMEOUT`; it warns at 80%, and
`dispatch_extend` (or `dispatch.mjs --extend <id> <s>` for a Bash-launched
`--job`) adds time to a run that is still making progress. For anything else: a
healthy agentic job accrues CPU as it makes tool calls; a stalled model/auth
call does not — compare accumulated CPU to elapsed time
(`ps -o pid,etime,time,stat -p <PID>`). Near-zero CPU + long elapsed + zero
output = **hung — kill it** (`kill -9`) and re-dispatch single-shot with the
content inlined (the 59-minute `agy --print` hang showed 0.41 CPU-seconds).

**Recovering a killed / partial Workflow.** Completed `agent()` outputs survive
a `TaskStop` — they're already written to the run's transcript dir. When you
only need the finished subset, extract their StructuredOutput inputs with `jq`
instead of `resumeFromRunId`:

```bash
jq -c '.. | objects
  | select(.type? == "tool_use" and .name? == "StructuredOutput") | .input' \
  agent-*.jsonl
```

## 9. Attribution — make the executor visible

Every delegated task must show who actually ran it — the provider, the
**exact model id**, and (for Codex) the effort. It must be obvious at every
moment that a non-Claude agent is executing. Four surfaces:

1. **Live dispatch line.** The `dispatch` tool's `label` and the Delegates
   pane / status line show `<provider> <model> · <elapsed> · <label>` while it
   runs; for Bash or Agent dispatches, start the `description` with the
   executor tag — `Codex gpt-… @ high: <short task>`, `AGY gemini-…: <short
   task>` — and name the delegate in narration at dispatch and at result.
   Delegated work must never look like Claude did it.
2. **Task tracker.** When dispatching work tracked as a task, append the
   executor to the subject — `[Codex · <slug> @ <effort>]`, `[AGY · <model
   id>]`, `[Claude · <driver model id>]` — and update it on escalation or
   re-dispatch so the FINAL executor is always visible. Move prior executors
   into task metadata (`executorHistory`, an array of the same bracket
   strings), not the subject.
3. **Synthesis.** The final report lists each subtask with its executor and
   the proof line's token count. Exact-model rules: Codex = catalog slug +
   effort; AGY = the probe-resolved model id verbatim (ids drift — never
   paraphrase); own Claude = the actual driver model id.
4. **Commits and workflow labels.** Delegated-edit commits carry a body
   trailer `Implemented-by: <Provider> (<exact model>[, effort <effort>])`
   — e.g. `Implemented-by: Codex (<std slug>, effort high)` or
   `Implemented-by: AGY (<sonnet id>)`, ids exactly as the probe prints them.
   When the delegate commits itself, the runner tells it its exact id (a
   prompt header and `$MC_MODEL_ID`); still check the trailer against the
   proof line's `model=` before accepting — models misreport themselves
   (an Argon run named an older Gemini, a Flash run wrote the product name).
   Workflow fan-out nodes (§2) encode the executor in `label` as
   `<provider>:<model>[@<effort>]:<item>` so `/workflows` shows it live.

Attribution is not optional bookkeeping: it is what makes §5 quota decisions
and §6 rework routing auditable after the fact.
