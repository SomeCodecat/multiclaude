# multiclaude — Multi-Agent Orchestration Setup

**Date:** 2026-06-13
**Status:** Approved design, pre-implementation
**Repo:** git@github.com:SomeCodecat/multiclaude.git

## Goal

Claude Code acts primarily as an orchestrator: it delegates every
delegation-shaped task (see the Delegation Test) to Codex (OpenAI) and AGY
(Antigravity CLI), verifies the results cheaply, and spends its own tokens only
on orchestration, synthesis, and targeted fixes. In practice this should land
around 60–75% of substantive work delegated — that number is the expected
outcome of applying the test, never a quota to force.

**External-quota-first principle:** for any delegation-shaped task, an external
agent (Codex or AGY) is always tried before Claude Code spends its own tokens.
Claude's own quota is the last resort, used only when the task fails the
Delegation Test (delegation would cost more than it saves) or when all suitable
external agents are exhausted or unavailable.
Heavy reasoning that would otherwise burn Claude Code's own Sonnet/Opus quota is
routed to AGY's Claude models, which draw on the separate AGY plan quota.

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

## The Delegation Test ("is this task delegation-shaped?")

Context transfer is the dominant hidden cost: sub-agents do not share Claude's
conversation, so every delegation requires serializing context into the prompt
and reading the result back. Claude Code costs are dominated by input tokens,
so delegating context-heavy tasks can cost MORE than doing them locally.

A task is delegated only if ALL of the following hold:

1. **Self-contained spec.** The task can be described completely in a prompt of
   reasonable size without losing constraints that live only in conversation
   history.
2. **Bounded file surface.** The expected set of files to touch is known and
   nameable in advance.
3. **Mechanically checkable.** Success can be verified by acceptance gates
   (below) without Claude reading the full implementation.
4. **Substantive enough to pay for itself.** Dispatch overhead (context
   serialization, job polling, gate runs, diff skim) must be smaller than the
   expected token savings. One-liners and trivial edits fail this criterion —
   that is why "small/quick tasks" stay with Claude Code in the architecture
   diagram, consistent with the external-quota-first principle.

Tasks that fail this test stay local, full stop — no task is delegated just
to push the delegation share up.

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

This makes "which agent broke the build" answerable and rollbacks clean.

## AGY Invocation Details

### Background jobs, not foreground print

`agy --print` has a 5-minute default timeout; real tasks exceed it. The skill
uses the AGY plugin's background mode (`--background` via `agy_rescue` /
wrapper script) and polls `agy_status` / `agy_result <job-id>`. Foreground
print mode is reserved for quick bounded checks (< ~2 min expected).

### Edit tasks bypass the MCP sandbox deliberately

The AGY plugin's MCP rescue tool keeps sandboxing on and is no-edit by default.
That is correct for review/research delegation, and those calls go through MCP.

For **edit/rework tasks**, the skill invokes the `agy` CLI directly via Bash
with explicit flags (model, `--dangerously-skip-permissions` where the
environment already runs in bypass mode). Rationale: the alternative
(AGY returns a patch, Claude applies it) burns Claude tokens on every patch
application, contradicting the core goal. The one-writer protocol and
per-agent commits are the safety net instead. This tradeoff is explicit and
accepted.

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
npm i -g @openai/codex && codex login
# AGY: exact install command to be captured from the current working machine
# during implementation and pinned in the README, then authenticate

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
- Delegation gated by the delegation test, not by hitting a percentage.
