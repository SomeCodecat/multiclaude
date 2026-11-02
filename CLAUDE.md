# Plugin Overview

`multiclaude` is a Claude Code plugin that makes Claude an orchestrator.
It routes substantive work to two external delegates — Codex (OpenAI) and AGY (Antigravity: Gemini + Claude tiers) — before spending Claude Code's own quota.
"Orchestration" is a behavior taught by a **skill**; the plugin's runtime is small and mechanical: one hooks module (`hooks/register.tsx`) that registers the `dispatch` tool and the Delegates pane, one shell-free runner (`scripts/dispatch.mjs`), and pure-Node readers for the model catalogs and wallet quotas.
The top-level orchestrator is **Claude Code itself**, driven by the `orchestrate` skill (`skills/orchestrate/SKILL.md`).
There is no build step and no test suite for the scripts; the hooks module is checked with `claude plugin validate` and `tsc`.

# Structure

The plugin root is `multiclaude/` (a subdir of this repo root). All paths below are relative to that plugin root. Two exceptions live in the repo root: this file, and `.claude-plugin/marketplace.json`.

- `.claude-plugin/plugin.json` — plugin manifest (`name`, `version`, `description`, `author`, `types`). **Edit version/description only.**
- Repo-root `.claude-plugin/marketplace.json` — marketplace manifest. **Edit with care; see Do Not Touch.**
- `skills/` — the plugin's content. Each subdir has a `SKILL.md`, exposed as `/multiclaude:<name>`.
  - `skills/orchestrate/SKILL.md` — the orchestration rules. Entry skill. **Safe to edit.**
  - `skills/setup/SKILL.md` — one-shot environment check/converge. **Safe to edit.**
  - `skills/quota/SKILL.md` + `quota.mjs` — usage/quota readout across wallets.
  - `skills/probe/SKILL.md` — availability + today's band → model id table (`scripts/probe.mjs`).
  - `skills/accounts/SKILL.md` — several Claude Code logins pooled as ONE Claude wallet: add / list / switch / auto-switch / `run` (per-terminal profile) via `scripts/accounts.mjs`.
  - `quota`, `setup`, `probe` and `accounts` are answered directly by the hooks module when the person types them (script output printed as the command's output, no model turn); the SKILL.md body is the fallback for hosts without modules or if the hook fails.
- `hooks/hooks.json` — registers (a) the wallet-headroom command hook on `SessionStart` and `PreToolUse` (`^(Agent|Task|Workflow|mcp__multiclaude__dispatch)$`; every % on the line is USED), and (b) the hooks module under `modules`. **Keep JSON valid.**
- `hooks/register.tsx` — the hooks module: registers `mcp__multiclaude__dispatch` / `dispatch_status` / `dispatch_cancel` / `dispatch_extend` (wakes the chat once at 80% of a job's timeout), `/delegates` (the pane, `immediate`, so it opens mid-turn), answers `/multiclaude:quota` / `:setup` / `:probe` / `:accounts` by running their scripts via `$.process.run` (no model turn; `accounts run` and looping `auto` are refused — terminal only), runs queued jobs from a `$.clock.every` tick started at `session.start` (the same tick runs `accounts.mjs auto --once` every 60 s and toasts a switch), and keeps `$.state.multiclaude.jobs`. Contract in `types/index.d.ts`. **Validate after every edit:** `claude plugin validate multiclaude` and `claude plugin test multiclaude`.
- `scripts/` — pure-Node (`.mjs`) helpers. **Edit as code.**
  - `scripts/dispatch.mjs` — THE runner: `dispatch.mjs <agy|codex> --model <id> [--effort e] [--edit] [--sandbox m] [--timeout s] [--out f] [--cd d] [--worktree] [--max-tokens N] [--fallback id] [--no-preflight] [--no-preamble] [--job id|auto] [--label l]` (and `--extend <id> <s>`), prompt on stdin. Validates the model, checks the AGY pool before starting (falls back or refuses with `QUOTA preflight`), prepends a header to every prompt (exact model id — also `$MC_MODEL_ID` — no `.env`/local-config edits, final-report rule; + read discipline on agy), returns only the final report on success (narration → `<id>.narration.md`), hashes `.env*` / `*.local*` before and after (`envChanged=`), warns at 80% of the timeout and accepts extensions, stops agy runs at a token budget (`BUDGET`; 350k default on the claude pool), parses the CLI's JSON stream, prints the answer on stdout and one proof line on stderr (`tokens=N (in/out/cached) steps=N calls=N`, `changed=N` + `git status` in the answer on failure). Codex failures are classed `QUOTA` / `TOO_COMPLEX` / `PATCH_FAILED` with the CLI's error text. Exit codes: 0 ok · 1 failed · 2 bad usage · 3 agy denied · 124 timeout. Job files live 14 days; `dispatch_status({ all: true })` lists them. Each finished run refreshes the wallet-headroom cache.
  - `scripts/probe.mjs` — orchestrate §0: opt-out, availability, Codex band table, AGY tier table, `--smoke`.
  - `scripts/usage-snapshot.mjs` — the headroom hook's engine; cached, refreshes in the background.
  - `scripts/setup.mjs` — the `setup` skill's engine (`check` / `apply`).
  - `scripts/lib/models.mjs` — model catalogs: Codex bands by role off `~/.codex/models_cache.json`; AGY tiers by family/version/effort off `agy models` (cached 1h).
  - `scripts/lib/wallets.mjs` — wallet readers: Codex windows (labelled by `window_minutes`), Claude official limits + ccusage, AGY pools via `agy -p /usage` (reactive 429-log fallback).
  - `scripts/accounts.mjs` + `scripts/lib/accounts.mjs` — Claude multi-account store (Node port of claude-swap's core, MIT — `THIRD_PARTY_NOTICES.md`). One owner per refresh token (live login / running session profile / store); switches hold Claude Code's proper-lockfile dirs (`<home>/.oauth_refresh.lock`, `~/.claude.lock`, `~/.claude.json.lock`) with no network inside; writes are atomic 0600. Store: `~/.local/share/multiclaude/accounts` (`MULTICLAUDE_ACCOUNTS_DIR`). The headroom hook and quota show the accounts as one pooled CLAUDE wallet (mean used %).
  - `scripts/lib/mc.mjs` — shared helpers (which/run/format).
- `agents/mc-agy.md`, `agents/mc-codex.md` — **fallback** Haiku forwarders (one Bash call to `dispatch.mjs`) for hosts that don't load plugin modules. The `dispatch` tool is the primary path.
- `THIRD_PARTY_NOTICES.md` — claude-swap's MIT license (keep it while `accounts` derives from it).
- `setup/settings.json` — desired-state `~/.claude/settings.json` template that `setup.mjs apply` deep-merges.
- `types/index.d.ts` — the hooks module's `$.state` contract.
- There is NO `commands/` dir and NO `.mcp.json`.

# Orchestration Model

- **Entrypoint:** the `orchestrate` skill. Claude reads it, runs the probe, then acts as orchestrator: classify → dispatch → verify with mechanical gates → synthesize.
- **Bands, not slugs.** The skill names bands (`codex: mech/std/hard/max`, `agy: opus/sonnet/gem-top/gem-hi/gem-med/gem-lo`); `probe.mjs` resolves them to today's ids from the live catalogs. Never hardcode a model id in the skill, the agents, or this file.
- **Delegation mechanism, in order of preference:**
  1. The `dispatch` tool — `mcp__multiclaude__dispatch({ delegate, model, effort, edit, label, prompt })`. Non-blocking: returns a job id, the job runs from a session-lifetime runner in the module (a tool.call hook has a 10 s own-time budget, so it cannot host the CLI run itself), and the plugin wakes the chat with the proof line + answer via `$.prompt.submit`. `dispatch_status({ id? })` for progress / the full answer; `dispatch_cancel({ id })`. No Claude driver; live Delegates pane + status line.
  2. Backgrounded Bash `node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" … --out <file>` for batches / long jobs; read only the `--out` file on completion.
  3. `Agent` with `subagent_type: "multiclaude:mc-agy" | "multiclaude:mc-codex"` and `model: "haiku"` — fallback only.
- **Work lands on external quota ONLY when the runner actually executes the CLI.** Every Agent / Workflow `agent()` / subagent is a Claude driver on your own quota; `subagent_type` swaps prompt + tools, not the provider.
- **Proof line gate (§3 gate 0):** `[dispatch <cli> model=… status=SUCCESS tokens=N …]`. `QUOTA` → re-route (§5); `DENIED` → agy needed `edit: true`; exit 2 → wrong id, re-probe; no proof line → not offloaded.
- **Never:** the external `codex:codex-rescue` / `agy:agy-rescue` agents, the AGY MCP tools, `--background` + `agy_status` polling, or a hand-rolled `agy`/`codex` command with the prompt on the command line.
- **Context passing:** by prompt only. Ground prompts with real file/diff content; include the verbatim anti-fabrication clause from orchestrate §2. AGY prompts ≤ ~120 KB (argv cap); Codex has no cap.
- **Concurrency:** non-edit tasks fan out freely (several `dispatch` calls in one turn). Edit tasks parallelize only under isolation. Workflows (≥3 nodes) only after the user opts in; each node is a Haiku driver that makes one `dispatch` call, labelled `<provider>:<model>:<item>`.
- **Attribution (§9):** provider + exact model id (+ effort) on the live line, the task subject, the synthesis, and the commit trailer `Implemented-by:`.

# File Formats

## Skill (`skills/<name>/SKILL.md`)
Frontmatter: `name:` (must equal the directory) and `description:` (one line, "Use when …"). No other fields. Body: Markdown.

## Agent (`agents/<name>.md`)
Frontmatter: `name` (= basename), `description`, `model: haiku` (keep), `tools: Bash` (only). Body: strict forwarding contract — one Bash call to `dispatch.mjs`, output returned verbatim.

## Hooks (`hooks/hooks.json`)
`description`, `hooks` (event → `[{ matcher, hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/…"], timeout }] }]`), and `modules: ["./register.tsx"]`.

## Hooks module (`hooks/register.tsx`)
`export const register: Register = on => { … }`. JSX against the global `h`; elements from `$.ui.resolve(e)`. No DOM, no Node: processes via `$.process.spawn`, state via `atom`/`read`/`update` declared in `types/index.d.ts`. Matchers must be string literals (the validator reads them).

# Conventions

- **New skill:** `skills/<name>/SKILL.md` with `name: <name>`; it becomes `/multiclaude:<name>`.
- **Shared script code:** `scripts/lib/`. Pure Node only — no bash, no python3, cross-platform.
- **Script path references:** always `${CLAUDE_PLUGIN_ROOT}/...` (skills, agents) or `$.plugin.root` (the module), never an absolute path.
- **Model ids:** only the probe prints them. Docs and skills use band names.
- **Version bump:** keep `version` identical across `plugin.json` and both `marketplace.json` fields; release notes go in the GitHub Release (there is no CHANGELOG.md).

# Do Not Touch

- `plugin.json` `name`, the marketplace `plugins[].name` / `source`, and the tool name `dispatch` (`mcp__multiclaude__dispatch` is referenced by the skill).
- `${CLAUDE_PLUGIN_ROOT}` tokens and `$.plugin.root` — replacing with an absolute path breaks portability.
- `setup/settings.json` `enabledPlugins` / `extraKnownMarketplaces` keys.
- The user's real `~/.claude/settings.json` — `setup.mjs apply` manages it (backs up to `.bak`).

# Gotchas

- **YAML frontmatter is strict.** Copy `skills/quota/SKILL.md`'s shape.
- **agy exits 0 on failure.** An unknown model prints the picker list and exits 0; that is why the runner parses the JSON envelope. Never trust `$?` from a raw `agy` call.
- **agy headless denies commands.** Without `--edit` (`--dangerously-skip-permissions`) every `run_command` is auto-denied; the runner reports exit 3 so the orchestrator can re-dispatch. File writes are *not* blocked by omitting `--edit` — treat "no edit" as "no commands", not "read-only".
- **agy has no stdin prompt.** The prompt is `--print`'s single argv value (~128 KB cap). The runner refuses bigger prompts with exit 2.
- **Codex `priority` is list order, not rank.** The workhorse lists above the frontier model. Bands come from the description text (`codexRole`).
- **The hooks module reloads only between turns.** After editing `register.tsx`, validate; the running session picks it up at the next turn end (dev-mods / `--plugin-dir`) or on restart (installed plugin).
- **Giving an offload node a `schema` or Read/Edit tools** makes the Claude driver do the work itself on your quota (observed: ~800k tokens).
