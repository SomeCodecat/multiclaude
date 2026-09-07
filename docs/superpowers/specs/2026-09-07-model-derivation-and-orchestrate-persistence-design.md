# Model derivation, orchestrate persistence, and reliable AGY dispatch

Date: 2026-09-07
Status: approved design, not yet implemented
Target release: multiclaude 2.6.0

## Problem

Three failures observed in daily use, plus one capability gap:

1. **Model drift.** The `orchestrate` skill hardcodes `gpt-5.6-{luna,terra,sol}`
   and prose references to "Gemini 3.5 Flash". Both are stale. Every model
   release requires a doc edit, and a missed edit routes work to a name the CLI
   no longer accepts.
2. **Orchestrate is forgotten fast.** The skill body is 616 lines. It is loaded
   once, then evicted by compaction, and nothing re-injects it. Claude reverts
   to doing substantive work on its own quota.
3. **AGY is invoked badly**, wasting wall-clock and dispatches.
4. **Own quota is treated as monolithic**, so work that legitimately stays local
   runs on the main-loop Opus even when Sonnet or Haiku would do.

## Ground truth (verified against the live CLIs on 2026-09-07)

Everything below was measured, not assumed.

### Codex — `codex-cli 0.153.4` (updated from 0.150.1 during this design)

`~/.codex/models_cache.json`, refetched after the update:

| slug | priority | visibility | default effort | supported efforts |
|---|---|---|---|---|
| `gpt-6-astra` | 1 | list | low | low, medium, high, xhigh, max, ultra |
| `gpt-reserve` | 3 | hide | medium | low…max |
| `gpt-5.6-sol` | 6 | list | low | low…max, ultra |
| `gpt-5.6-terra` | 7 | list | medium | low…max, ultra |
| `gpt-5.6-luna` | 8 | list | medium | low…max |
| `gpt-5.5` | 12 | list | medium | low…xhigh |
| `gpt-5.4-mini` | 23 | list | medium | low…xhigh (carries `upgrade` → luna) |
| `codex-auto-review` | 43 | hide | medium | low…max |

Key facts:

- **`priority` is a server-provided capability rank; lower is better.** This is
  the ordering signal that makes generic band resolution possible.
- **GPT-6 Astra is real** (released 2026-09-03) and required CLI ≥ 0.153.1. It
  was invisible on 0.150.1. Smoke-tested here: 9s, 4,765 tokens, exit 0.
- Published docs claimed Astra supports five efforts (no `ultra`); **the live
  catalog reports six, including `ultra`.** The catalog wins over documentation.
- `gpt-5.4-mini` carries an `upgrade` object pointing at `gpt-5.6-luna` with a
  `retirement_at`. This field is how deprecation is detected programmatically.
- `codex exec` still takes effort only via `-c model_reasoning_effort="<e>"`.
  There is no `--effort` on `exec` in 0.153.4. The existing dispatch shape holds.

### AGY — `agy 1.1.27`

`agy models` emits `id<TAB>Display Name`:

```
gemini-3.8-flash-{high,medium,low}
gemini-3.7-flash-{high,medium,low}
gemini-3.6-flash-{high,medium,low}
gemini-3.1-pro-{high,low}
claude-sonnet-4-6            Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking     Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium          GPT-OSS 120B (Medium)
```

Measured CLI behaviour:

| invocation | result |
|---|---|
| `--model gemini-3.8-flash-medium` | works |
| `--model "Gemini 3.8 Flash (Medium)"` | works |
| `--model gemini-3.8-flash --effort high` | works — family + separate effort |
| `--model "<id>\t<Display Name>"` | **prints the model picker list, exits 0, never runs the prompt** |
| `--model definitely-not-a-model` | prints `Error: …`, **exits 0** |

Two conclusions:

- **AGY's exit code is worthless for error detection.** Both failure modes above
  exit 0. Any wrapper must parse output, not trust `$?`.
- `--output-format json` returns a structured envelope:
  `{conversation_id, status:"SUCCESS", response, duration_seconds, num_turns, usage:{…total_tokens}}`.
  This gives deterministic success detection **and** a token count that proves
  the call landed on AGY's quota.

### Root cause of "AGY invoked badly"

`scripts/lib/wallets.mjs:agyTiers()` returns whole trimmed lines from
`agy models`. `resolveTiers()` then regex-matches the whole line, so
`probe.mjs` prints — and instructs the orchestrator to use "verbatim":

```
gem-hi  = gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)
```

Passing that to `agy --model` hits row 4 of the table above: AGY prints its
model picker and exits 0. The dispatch produces a plausible-looking non-empty
result, so orchestrate §3's "empty result = dispatch failure" backstop does not
catch it. The orchestrator burns a dispatch and wall-clock, gets a model list
back, and then does the work itself — which also feeds problem 2.

## Design

### 1. Derive models from the CLIs (new `scripts/models.mjs`)

Reads Codex from `~/.codex/models_cache.json` and AGY from `agy models`. Cached
with a TTL and refreshed detached, following the existing `usage-snapshot.mjs`
pattern. Emits a resolved **band table**. Pure Node, cross-platform.

AGY parsing: split each line on the tab into `{id, displayName}`; split `id`
into `{family, effort}` on a trailing `-high|-medium|-low`; treat
`claude-*-thinking` as family `claude-opus-4-6` with no effort suffix. Select
the **highest version per family** by numeric comparison of the version segment,
never by list order.

**Codex band resolution algorithm** (no slug appears in code):

1. Candidates = `visibility == "list"` AND no `upgrade` field. (`gpt-5.5`
   survives this filter but forms a single-member generation, so step 4 never
   selects it while a 3-member generation exists.)
2. Sort by `priority` ascending.
3. `codex:hard` = candidates[0]; `codex:max` = candidates[0] at its highest
   supported effort.
4. Let `G` = the generation of candidates[0], parsed from `gpt-<major>[.<minor>]`.
   If `G` has ≥3 members use `G` for the lower bands; otherwise use the next
   lower generation having ≥2 members.
5. Within that group, sorted by priority ascending (`n` members):
   `codex:std` = index `Math.floor(n/2)`, `codex:mech` = index `n-1`. For the
   3-member `gpt-5.6` group this is terra and luna respectively. If `n == 1`,
   both bands take that single member.
6. Clamp every band's effort to the model's own `supported_reasoning_levels`.

Applied to today's catalog this yields exactly the intended mapping — `G` is
`gpt-6` with one member, so the lower bands fall to the `gpt-5.6` group:

| band | resolves today | effort |
|---|---|---|
| `codex:mech` | `gpt-5.6-luna` | medium |
| `codex:std` | `gpt-5.6-terra` | high |
| `codex:hard` | `gpt-6-astra` | xhigh |
| `codex:max` | `gpt-6-astra` | ultra — escalation only, after a §3 gate failure |
| `agy:review` | `gemini-3.8-flash` | medium |
| `agy:hard` | `gemini-3.8-flash` | high |
| `agy:deep` | `gemini-3.1-pro` | high |
| `agy:sonnet` | `claude-sonnet-4-6` | — |
| `agy:opus` | `claude-opus-4-6-thinking` | — |

Routine burn rate is unchanged: only the hard and escalation bands move to
Astra. `gpt-5.6-sol` becomes the `codex:hard` fallback when the top-ranked model
is unavailable. `gpt-oss-120b` gets no band — no clear role.

Step 6 is load-bearing: `codex:max` is defined as *"top model at its highest
supported effort"*, never pinned to `ultra`. A future top model without `ultra`
would silently break a pinned band.

`SKILL.md` stops naming versions entirely and refers to bands. `probe.mjs`
prints the resolved table, so the mapping is always auditable, and additionally
warns when the installed CLI is older than the catalog's `client_version` — a
generic staleness check that would have surfaced the Astra gap.

### 2. Orchestrate persistence — per-turn card + armed gate

**`scripts/orchestrate-card.mjs`** on `UserPromptSubmit`. Emits a ~20-line
`additionalContext` card: the delegate-first rule, the three §1 keep-local
exemptions, the live band table from §1, the driver-thin rule, and the two
dispatch one-liners. Firing every turn puts it in the freshest part of context
and makes it survive compaction by construction. It also **arms the gate**.

**`scripts/edit-gate.mjs`** on `PreToolUse` matching
`^(Edit|Write|MultiEdit|NotebookEdit)$`:

- armed → `permissionDecision: "deny"`, reason offering three outs (delegate
  externally, dispatch `own:sonnet`, or state the §1 exemption), then **disarms**
- not armed → silent allow

At most one challenge per user turn; zero interruptions while delegating; the
second attempt always proceeds.

Auto-disarm — the gate never fires — when any of: `orchestrate: off` in the
project CLAUDE.md; both CLIs missing; all delegates marked exhausted;
`MULTICLAUDE_GATE=off`. This guarantees it can never hard-block work with
nowhere else to go.

`Bash` is deliberately **not** matched — gating it would block git, tests, and
the delegate CLI calls themselves.

State: one file per `session_id` under the existing cache dir. The gate denies
only when the incoming `session_id` matches the armed one.

`SessionStart` gains `resume` alongside `startup|clear|compact`.

**Open verification item:** whether `PreToolUse` fires inside subagents and
whether their `session_id` differs from the parent's. To be measured during
implementation by logging hook stdin. If subagents share the id, worst case is
one challenge spent inside a subagent — harmless, since it retries.

### 3. Reliable dispatch — a runner, and no shell (new `scripts/dispatch.mjs`)

Subcommands `agy` and `codex`. Spawns each CLI with an **argv array**, so no
shell ever parses the prompt. This deletes the entire quoting / word-splitting /
trailing-positional failure class the skill currently spends ~40 lines warning
about, and those warnings come out with it.

Behaviour:

- **Validates the model against the live catalog before spending anything**,
  making the picker-list no-op structurally impossible.
- AGY: forces `--output-format json`, parses the envelope, exits **non-zero** on
  `status != SUCCESS` or non-JSON output. Necessary because AGY exits 0 on both
  known failure modes.
- Prints `response` on stdout; prints a proof line to stderr:
  `[agy gemini-3.8-flash@high tokens=5410 dur=1.7s]`. The token count is direct
  evidence the work landed on AGY's quota, mechanising §7's "verify the quota,
  not just the result".
- Rejects prompts over ~120 KB with a clear message rather than
  `Argument list too long`.
- Codex: prompt on stdin (`codex exec … -`), no size cap, effort via
  `-c model_reasoning_effort=`, `--sandbox workspace-write --skip-git-repo-check`.
- Wraps every call in an OS-level timeout; `--print-timeout` is not a reliable
  backstop.

`agents/mc-agy.md` and `agents/mc-codex.md` collapse to a single `dispatch.mjs`
call each, leaving far less contract to get wrong. Their `model: haiku` and
`tools: Bash` frontmatter is unchanged.

`wallets.mjs:resolveTiers()` is fixed to split on the tab, resolve by **id**
(shell- and label-safe), rank version-aware, and add the missing `pro` and `low`
tiers.

### 4. Own-Claude tiering — a three-rung ladder

§1 is currently binary, so everything failing the delegation bar lands on the
main-loop Opus. It becomes:

| rung | target | scope |
|---|---|---|
| 1 | Codex / AGY | anything substantive — unchanged default |
| 2 | own lesser model via subagent | real work that failed rung 1: un-serializable-context edits, spot-fixes after a §3 gate failure, focused refactors in files already in context, test-run triage |
| 3 | own main loop (Opus) | classify, dispatch, verify, synthesize, judge; hard reasoning only once AGY's Claude tier is out |

Bands use built-in agent types with a `model` override — **no new files in
`agents/`**:

| band | dispatch | for |
|---|---|---|
| `own:haiku` | `Explore` / `general-purpose`, `model: "haiku"` | mechanical scale-out: wide greps, log scans, file sweeps |
| `own:sonnet` | `general-purpose`, `model: "sonnet"` | rung 2 above |

Two guardrails, stated flatly in the skill because this is where the plugin's
premise could spring a leak:

- **Rung 2 sits strictly below rung 1.** An own-Sonnet subagent is a cost
  reduction on work already staying local, never a substitute for external
  delegation. The existing "AGY's Claude tier before your own Sonnet/Opus" rule
  still wins.
- **Cheaper, not free.** The "N drivers = N× your own quota" box still holds.
  `own:*` bands are for serial, bounded work; they are not a fan-out licence.

Secondary benefit: a subagent carries its own context, keeping the main Opus
loop lean and delaying compaction — which directly helps problem 2.

`claudeCompact()` currently prints only `5h` and total `wk` while
`claudeLimits()` already fetches `sevenDayOpus` and `sevenDaySonnet` and discards
them. It gains `opus wk` and `sonnet wk`, so rung 2 is preferred automatically
when Opus weekly is tight and Sonnet weekly is not.

`fable` is deliberately left unbanded: it is in the `model` enum, but its
cost/capability position relative to Opus is unknown here and a wrong guess
silently misroutes work.

### 5. Attribution (§9)

Extended to cover rung 2 and to use ids. Live tag `Claude sonnet: <task>`;
tracker `[Claude · claude-sonnet-5]`; trailer
`Implemented-by: Claude (claude-sonnet-5)`. Non-Opus own execution must be as
visible as external execution. All examples switch from display names to ids,
which are shell- and label-safe.

### 6. Doc sweep and release

Every `Gemini 3.5 Flash` and hardcoded `gpt-5.6-*` becomes a band name.
Superseded shell-quoting warnings are removed. §3 gains "a result that is just a
model list = dispatch failure". Version `2.5.1 → 2.6.0`, kept identical across
`plugin.json` and both `marketplace.json` version fields, plus a CHANGELOG entry.

## Files

| file | change |
|---|---|
| `scripts/models.mjs` | new — catalog reader + band resolution |
| `scripts/dispatch.mjs` | new — shell-free validated runner for both CLIs |
| `scripts/orchestrate-card.mjs` | new — per-turn card, arms the gate |
| `scripts/edit-gate.mjs` | new — armed PreToolUse gate |
| `scripts/lib/wallets.mjs` | fix `agyTiers`/`resolveTiers`; add opus/sonnet weekly to compact |
| `scripts/probe.mjs` | print resolved bands; CLI-staleness warning |
| `scripts/usage-snapshot.mjs` | surface per-model weekly utilisation |
| `hooks/hooks.json` | add `UserPromptSubmit` + edit-gate `PreToolUse`; `SessionStart` gains `resume` |
| `skills/orchestrate/SKILL.md` | bands replace versions; §1 ladder; §3, §7, §9 updates; delete superseded warnings |
| `agents/mc-agy.md`, `agents/mc-codex.md` | collapse to one `dispatch.mjs` call |
| `skills/quota/quota.mjs` | per-model weekly utilisation |
| `.claude-plugin/plugin.json`, root `.claude-plugin/marketplace.json` | 2.6.0 |
| `CHANGELOG.md` | 2.6.0 entry |
| `CLAUDE.md` | band vocabulary; new scripts; hook inventory |

## Verification

1. `node scripts/models.mjs` resolves the band table above from the live
   catalogs.
2. `node scripts/dispatch.mjs agy --model <valid id>` returns a response plus a
   token proof line; an **invalid** id exits non-zero instead of printing a
   picker list — the specific regression that motivated this work.
3. `node scripts/dispatch.mjs codex --band std` round-trips.
4. Hook JSON validates; `UserPromptSubmit` card appears in context; a local
   `Edit` is challenged exactly once per turn and proceeds on retry.
5. Gate auto-disarms under `MULTICLAUDE_GATE=off` and under `orchestrate: off`.
6. Version string identical in all three manifest locations.

## Out of scope

- A usage/quota readout for AGY — still no viable endpoint (see the note in
  `wallets.mjs`).
- Banding `gpt-oss-120b` or `fable`.
- Any build step or test framework; this repo has neither by design.
