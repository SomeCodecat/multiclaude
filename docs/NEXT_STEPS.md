# Next Steps

Pending work as of **v2.8.0** (2026-11-01). Everything below is *not started*
unless stated otherwise.

## Done in 2.7.0 (from the 2026-09-07 spec and the AGY field notes)

- **Model derivation** — `scripts/lib/models.mjs` resolves Codex bands by
  *role* off the live catalog (`"workhorse"` → std, `"frontier"` → hard,
  `"fast / affordable"` → mech) and AGY tiers by family + version + effort off
  `agy models`. No slug or model id is hardcoded anywhere in the live plugin.
- **Reliable dispatch** — `scripts/dispatch.mjs`: shell-free argv, prompt on
  stdin, model validated before anything is spent, agy's JSON envelope parsed
  (`status`, `finished_reason`, `denied_actions`), `QUOTA` tagged, one proof
  line with the token count. The `mc-*` forwarders collapse to one runner call.
- **Native, non-blocking dispatch** — `hooks/register.tsx` registers
  `mcp__multiclaude__dispatch` (returns a job id; a session-lifetime runner
  tick executes the job; the plugin wakes the chat with the proof line +
  answer), `dispatch_status` (progress + live transcript + answer),
  `dispatch_cancel`, and the `/delegates` pane. No Haiku driver. Runner jobs
  started any other way with `--job auto` (Bash, workflow nodes, forwarders)
  are folded into the same pane from their `<id>.json` files.
- **Proactive AGY quota** — `agy -p /usage --output-format json` gives real
  per-pool 5h + weekly %. The reactive 429-log scan is now only a fallback.
- **Hook matcher** — the PreToolUse headroom hook matches `Agent` (the current
  tool name), not just the old `Task`; SessionStart also fires on `resume`.
- **Codex window labelling** — windows are labelled by `window_minutes`, so a
  weekly-only Plus plan no longer reads as "5h".

## 1. Orchestrate persistence (still pending)

The 2026-09-07 spec's per-turn card + armed edit gate
(`scripts/orchestrate-card.mjs`, `scripts/edit-gate.mjs`) is unimplemented. Now
that the plugin ships a hooks module, the natural home is `hooks/register.tsx`:
a `prompt.compose` hook that appends a ~20-line band table + delegate-first
rule (`scope: 'session'`), and a `tool.call` hook on `Edit|Write|MultiEdit|
NotebookEdit` that challenges once per turn while armed. **Must arm only on
`/orchestrate`** — per the user's "multiclaude should not activate itself".
*Done looks like:* Claude still routes to Codex/AGY 50+ turns after the skill
was last read, and a plain session without `/orchestrate` sees no card and no
gate.

## 2. Own-Claude ladder

Opus dispatching Sonnet (and Sonnet dispatching Haiku) for tasks too small to
justify an external round-trip. *Done looks like:* a size/complexity rule in
§2 with an explicit `own:*` band and the `wk by model` headroom (already in the
hook line) steering it.

## 3. Verify the mod on the desktop / VS Code surfaces

`hooks/register.tsx` was validated and type-checked against the terminal
surface. The pane draws with `Box`/`Text` only, so it should seat on every
surface, but it has not been seen on `desktop` or `vscode`.

## 4. Historical docs still carry stale model strings

`docs/superpowers/plans/` and the pre-2026-11 files in `docs/superpowers/specs/`
reference `gpt-5.6-*`, `gemini-3.8-flash`, `claude-sonnet-4-6`, etc. **This is
intentional** — they are dated records. Only the live plugin (`multiclaude/`),
the root `CLAUDE.md` and the README are kept current. Do not "fix" them.

## 5. Restart required to pick up 2.7.0

A running session keeps the plugin snapshot it started with (the `dispatch`
tool and `/delegates` only appear after a restart, since `$.tool.register`
runs at `session.start`). Update with `/plugin marketplace update multiclaude`
+ `/plugin update multiclaude@multiclaude`, then restart.
