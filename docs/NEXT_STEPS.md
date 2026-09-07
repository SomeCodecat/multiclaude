# Next Steps

Pending work as of **v2.6.0** (`0261ecc`, 2026-09-07). The working tree is clean
and everything below is *not started* unless stated otherwise.

## 1. The 2026-09-07 design spec is committed but unimplemented

`docs/superpowers/specs/2026-09-07-model-derivation-and-orchestrate-persistence-design.md`
(`02bc9c1`) designs four changes. The user explicitly deferred implementation
("nevermind, i will try it as is") and v2.6.0 shipped only two targeted fixes
instead — the AGY bare-ID repair and the Astra band routing. **Do not implement
the spec wholesale without new confirmation from the user.**

What is still pending from it:

- **Model derivation (`scripts/lib/models.mjs`, `scripts/dispatch.mjs`).** Bands
  (`mech`/`std`/`hard`/`max`) would resolve from the live `codex` catalog via the
  server-provided `priority` field (lower = better) and the `upgrade`
  deprecation signal, instead of the slugs now hardcoded in
  `skills/orchestrate/SKILL.md` §2 and `agents/mc-codex.md`.
  *Done looks like:* a new GPT generation appears in the catalog and the routing
  table needs no edit.
- **Orchestrate persistence (`scripts/orchestrate-card.mjs`, `scripts/edit-gate.mjs`,
  `hooks/hooks.json`).** The 616-line skill is loaded once and evicted by
  compaction; the only recurring hook matches `^(Task|Workflow)$`, i.e. it fires
  only when Claude is *already* delegating correctly and never when it is about
  to do the work itself. Design: a per-turn context card plus a **hard**
  PreToolUse deny gate on own-quota edits.
  *Done looks like:* Claude still routes to Codex/AGY 50+ turns after the skill
  was last read.
- **Own-Claude ladder.** Opus dispatching Sonnet (and Sonnet dispatching Haiku)
  for tasks too small to justify an external round-trip.
  *Done looks like:* a size/complexity rule in §2 with an explicit band.
- **Activation gating.** The card and edit gate must arm **only** on
  `/orchestrate`, never auto-trigger — per the user's "multiclaude should not
  activate itself". The SessionStart + PreToolUse wallet-headroom lines and the
  `quota` skill's auto-trigger stay as they are.

**The spec is stale in one respect:** it describes the card and gate as
always-on. The user's later "Behavior only" decision supersedes that — they must
be armed by `/orchestrate`. Fix the spec text before implementing from it.

## 2. No positive success check on an AGY dispatch

v2.6.0 removed the *cause* of the silent no-op (display names and whole
`agy models` rows can no longer reach `--model`), but nothing yet verifies that
a dispatch actually ran. `agy` exits 0 on both known failure modes — an invalid
model and the picker-list no-op — so the exit code is useless.

`agy --output-format json` returns an envelope with `status` (`SUCCESS`) and
`usage.total_tokens`, which is both a deterministic success check and proof the
work landed on the AGY wallet rather than Claude's.

*Done looks like:* `mc-agy` and orchestrate §3's verification gate parse
`status` instead of trusting exit 0, and the token count appears in §9
attribution.

## 3. Historical docs still carry stale model strings

`docs/superpowers/plans/` and the pre-2026-09 files in `docs/superpowers/specs/`
still reference `gpt-5.6-{luna,terra,sol}` as the full band set and
`Gemini 3.5 Flash`. **This is intentional** — they are dated records of what was
true when written. Only the live plugin (`multiclaude/`) and the root
`CLAUDE.md` are kept current. Do not "fix" them.

## 4. Restart required to pick up 2.6.0

The plugin is installed at user scope
(`~/.claude/plugins/cache/multiclaude/multiclaude/2.6.0`, sha `0261ecc`), but a
running session keeps the snapshot it started with. Any session open before the
update still follows the 2.5.1 orchestrate rules until it is restarted.
