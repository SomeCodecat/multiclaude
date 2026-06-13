# multiclaude — Multi-Agent Orchestration Setup

**Date:** 2026-06-13
**Status:** Approved design, pre-implementation
**Repo:** git@github.com:SomeCodecat/multiclaude.git

## Goal

Claude Code acts primarily as an orchestrator: it delegates substantive work to
Codex (OpenAI) and AGY (Antigravity CLI), verifies the results cheaply, and
spends its own tokens only on orchestration, synthesis, and targeted fixes.

**Spend the wallet with headroom.** Claude Code's own 5-hour quota is the
scarce, shared resource. AGY and Codex run on separate, independently-paid
quotas that normally sit idle. So the default for any substantive task is to
delegate — spend the external wallets and reserve Claude Code's own. Expect to
delegate the large majority of substantive work; if AGY or Codex is sitting near
idle, that is the signal that too much is being kept local. The two external
agents are pushed symmetrically: edit work belongs on Codex as firmly as
reasoning/review work belongs on AGY.

**AGY's Claude tier before Claude Code's own Sonnet/Opus.** Any reasoning that
would otherwise run on Claude Code's own Sonnet or Opus goes to AGY's Claude
tier first — the same model family on a separate, paid quota. Claude Code spends
its own Sonnet/Opus only when AGY's Claude tier is exhausted (a quota error) or
unavailable (tier resolution found no Claude model).

The whole setup must be reproducible on a new machine from this repo plus a
small number of documented manual steps.

## Non-Goals

- No proactive quota tracking (not technically possible; see Quota Handling).
- No parallel multi-model racing by default. AGY's Gemini and Claude models are
  alternative engines selected per task, not competitors run side by side.
- No automation of CLI logins (`codex login`, AGY auth) — these are interactive
  by design and stay manual bootstrap steps.

## Architecture

```
Claude Code (orchestrator + synthesis, minimal own-quota usage)
├── small/quick tasks ─────────────── handled directly by Claude Code
├── implementation (write/edit) ───── Codex
├── review / research / analysis ──── AGY, Gemini Flash tier
└── heavy reasoning (would have used
    Claude Code's own Sonnet/Opus) ── AGY, Claude Sonnet/Opus tier (AGY quota)
```

Cross-fallback when a result fails acceptance gates:

- Codex result fails → AGY reworks it (with failure summary in the prompt)
- AGY result fails → Codex reworks it (with failure summary in the prompt)
- Hard hop limit: **2 rework attempts total**, then Claude Code takes over
  directly. Each rework prompt MUST include a summary of what the previous
  attempt got wrong, otherwise the next agent repeats the same mistakes.

## What to Delegate

The default action for any substantive task is to delegate. A task stays local
ONLY when one of these holds:

1. **Trivial.** A one-liner or tiny edit where dispatch overhead (context
   serialization, job polling, gate runs, diff skim) clearly exceeds the work.
   This is why "small/quick tasks" stay with Claude Code in the architecture
   diagram.
2. **Un-serializable context.** The task depends on conversation-history nuance
   that cannot be written into a prompt without effectively re-deriving it.
   Context transfer is the dominant hidden cost: sub-agents do not share
   Claude's conversation, and Claude Code costs are dominated by input tokens,
   so a context-heavy task can cost MORE delegated than done locally.
3. **No agent available.** All suitable external agents are exhausted or
   unavailable (see Quota Handling).

If none of these hold, delegate — even when unsure. A wasted dispatch is cheap;
a habit of keeping work local is what leaves the external quotas idle.

### Two task families

- **Edit tasks** (write / refactor / test code) route to Codex by default, or to
  AGY's Claude tier for rework and fallback.
- **Non-edit tasks** (review, research, analysis, architecture, heavy reasoning,
  docs) route to AGY — Gemini-medium tier by default, Gemini-high or Claude tier
  by difficulty. These have no file surface and no mechanical gate, and are
  delegated anyway.

### File surface and mechanical checkability are verification aids, not gates

For edit tasks, a bounded file surface and a mechanical gate (tests, typecheck,
lint) determine how cheaply the result can be verified — a clean file list plus
passing gates means Claude skims rather than deep-reads. Their ABSENCE never
bars delegation; it just means verification is by reading the diff or judging
the output (a degraded, more expensive mode, noted when used). Non-edit tasks
never have them and are delegated regardless.

### Self-check floor

Before running a substantive task on its own quota, the orchestrator asks: would
Codex or AGY handle this? If yes, route it out. AGY is the most-missed target,
and its Claude tier is the easiest to forget because heavy reasoning feels like
the orchestrator's own job. Concrete heavy-reasoning work that belongs on AGY's
Claude (or Gemini-high) tier: planning a multi-step change, analyzing a tricky
bug, weighing architecture trade-offs, synthesizing large material, deep code
review. If several substantive tasks have gone by and AGY *or* Codex has stayed
idle, that is under-delegation — corrected on the next task.

### Routing within delegated tasks

| Task type | Agent | Model |
|---|---|---|
| Code implementation, refactors, test writing | Codex | Codex default |
| Code review, research, analysis, docs | AGY | Gemini Flash (Medium) |
| Hard review/research, architecture analysis | AGY | Gemini Flash (High) |
| Heavy reasoning, would've used own Sonnet | AGY | Claude Sonnet tier |
| Hardest reasoning, would've used own Opus | AGY | Claude Opus tier |

Model names are NEVER hardcoded. At availability-check time the skill runs
`agy models` and pattern-matches (`Claude.*Opus`, `Claude.*Sonnet`,
`Gemini.*Flash.*High`, `Gemini.*Flash.*Medium`), caching the resolved names for
the session. If a pattern matches nothing, that tier is marked unavailable and
routing degrades to the next tier.

## Acceptance Gates (the core of verification)

Delegated output is judged by mechanical gates, not by Claude re-reading the
work. Gates, in order:

1. Project test suite passes (or the relevant subset for the touched area).
2. Typecheck passes.
3. Lint passes.
4. `git diff --stat` touches only the expected file set (± clearly justified
   additions like new test files).

If **all gates pass**: Claude skims the diff summary (`git diff --stat` plus a
quick scan of changed hunks in critical files only) and accepts. No deep read.

If **any gate fails**: Claude reads the failing output and the relevant diff
hunks, then either (a) spot-fixes if small, (b) dispatches a rework to the
other agent with the failure summary, or (c) after 2 failed reworks, takes over.

Projects without tests/typecheck/lint fall back to: diff-scope check plus
Claude reading the diff. This is more expensive — noted as a degraded mode.

## One-Writer Protocol (working-tree discipline)

Exactly one agent owns the working tree at a time. The skill enforces:

1. Before delegating an edit task: working tree must be clean (commit or stash
   first). A dirty tree blocks delegation.
2. While a delegated edit job runs, Claude Code does not edit files in that
   workspace.
3. Every accepted delegated change lands as its own commit, so it stays clear
   which agent produced which change. Commit messages carry no co-author
   trailers.
4. Rejected work is reverted with `git checkout . && git clean -fd` (safe
   because the tree was clean at delegation time) before the rework dispatch.
5. Parallel edit tasks are allowed only under isolation: provably disjoint file
   sets, or separate git worktrees. Concurrent writes to one working tree break
   the protocol and are serialized instead. Non-edit tasks have no writes and
   parallelize without restriction.

This makes "which agent broke the build" answerable and rollbacks clean.

## Parallelism

Delegation only saves wall-clock if independent tasks run concurrently, so the
default is to dispatch in parallel and serialize only when one task's output
feeds the next.

- Non-edit tasks (review/research/reasoning) fan out freely — multiple
  `agy:agy-rescue` Agent calls and/or backgrounded `agy --print` jobs and/or
  Codex agents launched in a single turn, inline results collected together.
- Edit tasks parallelize only under the isolation rule above.
- Small fan-out (≈2–4 independent tasks) is just concurrent dispatch in one
  turn. Large or multi-stage fan-out (many files; find→fix→verify pipelines;
  migrations; broad audits) uses the Workflow tool, which pipelines subagents
  deterministically and isolates concurrent edits per-agent via worktrees.
  Routing rules apply unchanged inside a workflow. Workflows spend many agents
  and tokens, so they are reserved for genuinely parallel, substantial work.

Acceptance gates and the one-writer protocol apply to every delegated change,
parallel or not.

## AGY Invocation Details

### Always dispatch AGY for an inline result; never poll a job

AGY is invoked so the result comes back in the same turn, never via a background
job that Claude then polls. Two inline paths:

1. **Default tier, bounded research / review / analysis** — the Agent tool with
   `subagent_type: "agy:agy-rescue"`, which runs AGY in the foreground and
   returns its output directly.
2. **Specific tier, edits, or long timeout** — the `agy --print` CLI run in a
   backgrounded Bash; the harness notifies on completion and Claude reads the
   captured stdout. This is the only path that can select a model tier
   (`--model`) or permit edits (`--dangerously-skip-permissions`), since the
   `agy:agy-rescue` subagent always runs AGY's default tier.

The AGY plugin's **MCP** tools (`agy_rescue` / `agy_review`) and their
`--background` + `agy_status` / `agy_result` polling are deliberately NOT used.
The plugin writes each job's per-job `<id>.json` exactly once as
`status: "queued"` and never updates it — only the separate `state.json` index
advances — so any waiter that polls the job file hangs on `queued` forever even
after the job has finished and written its result. Inline dispatch avoids the
broken state tracker completely. (Observed: a finished review left a poller
stuck ~14 minutes; the orchestrator then fell back to ad-hoc shell `cat` loops
that also stuck on the frozen file.)

### Ground the prompt; forbid fabrication

AGY (when it fans out to its own subagents) will sometimes fabricate file
contents after a silent read failure, returning a confident, plausible, wrong
answer. Two required defenses: (1) supply ground truth in the prompt — paste the
diff for a review, real file excerpts / signatures / schema for research, so the
agent is handed the facts rather than reading for them; (2) an anti-fabrication
clause in every prompt instructing the agent to stop and report on any failed
read instead of guessing. Research/review deliverables that assert specific code
facts are spot-checked against the real files before they are trusted, and
re-dispatched with embedded ground truth if anything was invented. (Observed:
AGY invented an entire data model and DAL signatures; a diff against the real
files was the only thing that caught it.) Note that the failure is not a sandbox
read-permission block — direct probes showed `agy --print` reads files fine
(even outside its workspace, without `--dangerously-skip-permissions`); the
fabrication arises under subagent fan-out / auth lapse on long runs, which is why
the defense is prompt-grounding + verification rather than a sandbox flag.

### CLI prompt passing (escaping-proof)

`--print` (alias `--prompt`) is a string-valued flag: the prompt is its VALUE,
not a trailing positional. Pass it as `--print="$(cat <file>)"`, writing the
prompt to a temp file first (via the Write tool, so no shell parses it) and
quoting the substitution. Two guarded failure modes: prompt as a trailing
positional (`agy --print --print-timeout 30m … "<prompt>"`) makes `--print`
swallow `--print-timeout` as its value, so AGY acts on the literal text
"--print-timeout"; and unquoted `--print=$(cat file)` word-splits a multi-line
prompt.

## Quota Handling (reactive, with re-routing)

Neither AGY's remaining quota nor Claude Code's own remaining quota is
programmatically readable, so exhaustion is detected reactively — a call fails
with a quota/rate-limit error. When that happens the task is **re-evaluated and
re-routed**, not simply pulled local:

- **AGY tier exhausted:** AGY's Gemini and Claude tiers have separate quotas,
  so step to the OTHER AGY tier first, in either direction — Gemini exhausted →
  Claude tier (the original motivating case), Claude tier exhausted → Gemini.
  If both AGY tiers are exhausted, re-evaluate the task: if Codex can
  reasonably handle it (most implementation and review tasks), route it to
  Codex; only otherwise does Claude Code execute it locally.
- **Codex exhausted:** re-evaluate the task: if AGY can reasonably handle it,
  route it to AGY on the tier matching its difficulty (implementation rework →
  Claude tier, review/research → Gemini tier); only otherwise does Claude Code
  execute it locally.
- **Everything exhausted:** Claude Code works normally on its own quota and
  tells the user once that orchestration is suspended.

A quota failure is NOT a quality failure: it does not consume one of the two
rework hops (no work product was produced to rework).

**Session-level exhaustion marking:** when an agent or tier returns a quota
error, it is marked exhausted for the rest of the session so subsequent tasks
skip it immediately instead of re-hitting the dead quota. A fresh session
re-probes naturally. The user is told once per session which agents are marked
exhausted.

No attempt is made to predict or track remaining quota proactively.

## Availability Checks & Degraded Modes

On first invocation per session, the skill checks:

| Component | Check | If missing |
|---|---|---|
| Codex CLI | `command -v codex` | Warn + print `npm i -g @openai/codex` + `codex login`; route implementation tasks to AGY-Claude instead |
| AGY CLI | `command -v agy` | Warn + print install/auth instructions; re-route per the quota re-routing rules (review and heavy reasoning → Codex if suitable, else local) |
| AGY models | `agy models` pattern match | Mark missing tiers unavailable, degrade to next tier |
| superpowers plugin | enabledPlugins in settings | Warn + print marketplace/plugin entry to add |
| claude-mem plugin | enabledPlugins in settings | Warn + print marketplace/plugin entry to add |

Every degradation is reported to the user once, with the exact command or
settings entry needed to fix it. Orchestration continues in degraded form
rather than blocking — except when BOTH CLIs are missing, in which case the
skill says so and Claude works normally (no orchestration).

## Per-Project Opt-Out (privacy/trust)

Delegation sends code to OpenAI (Codex) and Google (AGY/Gemini). Some projects
must not do that. The skill checks the project's CLAUDE.md for:

```
orchestrate: off
```

If present, no delegation happens in that project; Claude notes it once and
works normally. (Finer-grained `orchestrate: codex-only` / `agy-only` values
are reserved for later if needed.)

## Repo Structure

```
multiclaude/
├── .claude-plugin/
│   └── marketplace.json          # marketplace index (format verified, below)
├── orchestrate/                  # the plugin (no version subdirectory —
│   │                             #   versioning lives in plugin.json)
│   ├── .claude-plugin/
│   │   └── plugin.json           # { name, version, description, author }
│   └── skills/
│       └── orchestrate/
│           └── SKILL.md          # the orchestration skill (all rules above)
├── setup/
│   └── settings.json             # canonical ~/.claude/settings.json template
├── docs/
│   └── superpowers/specs/        # this spec
└── README.md                     # bootstrap instructions (below)
```

**marketplace.json format (verified 2026-06-13 against the working
claude-code-agy marketplace, which hosts its plugin in-repo the same way):**

```json
{
  "name": "multiclaude",
  "owner": { "name": "SomeCodecat" },
  "metadata": { "description": "...", "version": "1.0.0" },
  "plugins": [
    {
      "name": "orchestrate",
      "description": "...",
      "version": "1.0.0",
      "source": "./orchestrate"
    }
  ]
}
```

In-repo plugins use a relative-path `source` (the claude-code-agy marketplace
uses `"./plugins/agy"`); external plugins use `{ "source": "url", "url": ... }`
(the superpowers marketplace pattern). The versioned cache directory seen under
`~/.claude/plugins/cache/` is created by Claude Code, not by the repo layout.

`setup/settings.json` contains: all four marketplace sources (superpowers,
thedotmack/claude-mem, openai-codex, claude-code-agy) **plus** the multiclaude
marketplace and the orchestrate plugin enabled, model preference, permission
mode, and statusline config — a superset of the current working settings.

## New-Machine Bootstrap (auth-ordering aware)

The repo may be private; raw-URL curl and SSH clones fail without credentials.
README documents this order:

```bash
# 1. GitHub auth FIRST (required for private repo + git marketplace sources)
#    - add SSH key to GitHub, or `gh auth login`

# 2. Install Claude Code
npm i -g @anthropic-ai/claude-code

# 3. Get the canonical settings
git clone git@github.com:SomeCodecat/multiclaude.git ~/dev/multiclaude
cp ~/dev/multiclaude/setup/settings.json ~/.claude/settings.json

# 4. Install + authenticate the delegate CLIs (interactive, cannot be automated)
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy   # first run triggers authentication

# 5. First launch — marketplaces and plugins install automatically
claude
```

The orchestrate skill's availability checks (above) catch anything skipped and
print the exact missing step, so a partial bootstrap degrades gracefully
instead of failing mysteriously.

## Testing / Verification Plan

1. **Skill dry-run:** invoke the skill in a scratch project; verify the
   availability table prints correctly with all components present.
2. **Degradation test:** temporarily rename `agy` off PATH; verify the warning
   and the rerouting (review tasks → Codex).
3. **Delegation round-trip:** delegate a small bounded implementation task to
   Codex in a scratch repo; verify gates run, commit lands with attribution.
4. **Rework path:** force a gate failure (e.g. delegate with an intentionally
   wrong expected-file list); verify the failure summary is built and the
   rework dispatch targets the other agent, and the 2-hop limit stops the loop.
5. **Fresh-machine simulation:** on a clean user/container, follow README
   bootstrap top to bottom; verify plugins install on first `claude` launch.

## Decisions Log

- AGY Gemini and Claude tiers are alternatives by effort, not parallel racers
  (user decision, supersedes earlier parallel design).
- AGY edit tasks use direct CLI with explicit flags, not patch-and-apply
  (token economics; one-writer protocol is the safety net).
- Quota handling is reactive-only (proactive tracking impossible).
- External quota is always tried before Claude Code's own; quota exhaustion
  triggers re-evaluation and cross-agent re-routing, is marked for the session,
  and does not count as a rework hop (user decision).
- Model names resolved by pattern at runtime, never hardcoded.
- Default is to delegate; work stays local only when trivial, when context
  cannot be serialized, or when no external agent is available. The orchestrator
  runs a self-check for Codex/AGY idleness instead of disavowing a target share
  (negative "don't chase a percentage" framing was removed — stating what NOT to
  do only suppressed delegation).
- Non-edit work (review/research/reasoning) is NOT gated by the edit-shaped
  file-surface and mechanical-checkability criteria; those are verification aids
  for edit tasks, not delegation gates. This unblocks AGY, which was otherwise
  excluded by construction.
- AGY's Claude tier is preferred over Claude Code's own Sonnet/Opus for heavy
  reasoning (same model family, separate paid quota); own Sonnet/Opus is used
  only when AGY's Claude tier is exhausted or unavailable.
- Codex and AGY are pushed symmetrically so neither idles while the other is
  busy.
- AGY CLI prompt is passed as the value of `--print` via a quoted
  `--print="$(cat <file>)"` (prompt written to a temp file first), never as a
  trailing positional — the positional form caused AGY to act on the literal
  "--print-timeout" text (observed dispatch bug).
- AGY is dispatched for INLINE results only — the `agy:agy-rescue` Agent
  subagent (default tier) or a backgrounded `agy --print` CLI (tier/edits) — and
  the AGY MCP tools + `--background` / `agy_status` polling are NOT used: the
  plugin freezes each per-job `<id>.json` at `status: "queued"` (only the
  `state.json` index advances), so polling the job file hangs forever on an
  already-finished job (observed ~14-min stuck waiter, then ad-hoc shell `cat`
  loops stuck on the same frozen file). This supersedes the earlier
  "MCP preferred for no-edit work" decision. (v1.3.0)
- Delegation prompts are grounded (the needed code/diff is pasted in) and carry
  an anti-fabrication clause; research/review deliverables that assert code facts
  are spot-checked against the real files before trust. Response to AGY's
  subagents silently fabricating file contents (invented data model + DAL
  signatures) after failed reads — not a sandbox read block (probes showed
  `agy --print` reads fine), but subagent/auth-lapse fabrication. (v1.3.0)
- Independent tasks are dispatched in parallel by default; non-edit work fans
  out freely, edit work parallelizes only under worktree/disjoint-file
  isolation, and large multi-stage fan-out uses the Workflow tool.
