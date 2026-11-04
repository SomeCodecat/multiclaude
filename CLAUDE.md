# Plugin Overview

`multiclaude` is a Claude Code plugin that makes Claude an orchestrator.
It routes substantive work to two external delegates — Codex (OpenAI) and AGY (Antigravity: Gemini + Claude tiers) — before spending Claude Code's own quota.
"Orchestration" is a behavior taught by a **skill**; the plugin's runtime is small and mechanical: one hooks module (`hooks/register.tsx`) that registers the `dispatch` tool and the Delegates pane, one shell-free runner (`scripts/dispatch.mjs`), and pure-Node readers for the model catalogs and wallet quotas.
The top-level orchestrator is **Claude Code itself**, driven by the `orchestrate` skill (`skills/orchestrate/SKILL.md`).
There is no build step and no test suite for the scripts; the hooks module is checked with `claude plugin validate` and `tsc`.

# Structure

The plugin root is `multiclaude/` (a subdir of this repo root). All paths below are relative to that plugin root. Two exceptions live in the repo root: this file, and `.claude-plugin/marketplace.json`.
`docs/references.md` (repo root) lists external projects we borrowed from or used to require (e.g. ccstatusline, no longer a requirement) with features worth copying; check it before building a status-line feature.

- `.claude-plugin/plugin.json` — plugin manifest (`name`, `version`, `description`, `author`, `types`). **Edit version/description only.**
- Repo-root `.claude-plugin/marketplace.json` — marketplace manifest. **Edit with care; see Do Not Touch.**
- `skills/` — the plugin's content. Each subdir has a `SKILL.md`, exposed as `/multiclaude:<name>`.
  - `skills/orchestrate/SKILL.md` — the orchestration rules. Entry skill. **Safe to edit.**
  - `skills/setup/SKILL.md` — one-shot environment check/converge. **Safe to edit.**
  - `skills/quota/SKILL.md` + `quota.mjs` — usage/quota readout across wallets.
  - `skills/probe/SKILL.md` — availability + today's band → model id table (`scripts/probe.mjs`).
  - `skills/usage/SKILL.md` — token + ≈ API-spend tracker per wallet / account / model (`scripts/tracker.mjs`).
  - `skills/failures/SKILL.md` — the runner's failure log summary + `review` (an AGY job that proposes prompt-rule fixes) via `scripts/failures.mjs`.
  - `skills/help/SKILL.md` — command / hotkey / tool reference; the fallback for the module's help pane (`HELP_*` tables in `register.tsx` — keep both in step).
  - `skills/accounts/SKILL.md` — several Claude Code logins pooled as ONE Claude wallet: add / list / switch / auto-switch / `run` (per-terminal profile) via `scripts/accounts.mjs`.
  - A bare `/multiclaude:orchestrate` (no task) is answered by the hooks module too: it runs `probe.mjs`, prints it, and returns the SKILL.md body + probe block as `command.run` `context` (hidden, read on the next turn) — no model turn. With a task after the name the skill runs normally.
  - `quota`, `usage`, `failures`, `setup`, `probe` and `accounts` are answered directly by the hooks module when the person types them (script output printed as the command's output, no model turn); the SKILL.md body is the fallback for hosts without modules or if the hook fails.
- `hooks/hooks.json` — registers (a) the wallet-headroom command hook on `SessionStart` and `PreToolUse` (`^(Agent|Task|Workflow|mcp__multiclaude__dispatch)$`; every % on the line is USED), and (b) the hooks module under `modules`. **Keep JSON valid.**
- `hooks/register.tsx` — the hooks module: registers `mcp__multiclaude__dispatch` / `dispatch_status` / `dispatch_cancel` / `dispatch_extend` (wakes the chat once at 80% of a job's timeout), `/delegates [settings]` (the pane, `immediate`, so it opens mid-turn; list / job detail / settings views, rows coloured by model family; also opened on `skill.prompt` for orchestrate and on dispatch, per the settings kept in `$.store` 'settings'; optional idle auto-close) `/multiclaude:help` (help pane from the `HELP_*` tables, `d`/`w` open the other panes, `h` in both opens it; plain text where unplaced) and `/wallets` (live wallet pane from `usage-snapshot.mjs --json` + `accounts.mjs list --json`, refreshed every 30 s while open, account switch buttons; a Usage section from `tracker.mjs --json` every 5 min, `p` period / `i` combined↔split, view kept in `$.store` 'usageView'). Claude subagents (`agent.spawn` / generic `tool.call` by `agentId` / `turn.complete`) get Delegates rows (`source: 'agent'`), skipping the mc-* forwarders and folding a dispatching driver into its job (`parent`); settings toggle 6 hides them, toggle 7 switches the wallet rows of the status line off via `usage-snapshot.mjs --wallet-rows` (synced again at `session.start`), answers (output coloured by `paint()` when every attached surface is a terminal; the scripts print plain text) `/multiclaude:quota` / `:usage` / `:failures` / `:setup` / `:probe` / `:accounts` by running their scripts via `$.process.run` (no model turn; `/multiclaude:setup companions` opens the Setup pane instead — the companions menu from `setup.mjs companions --json`, a number key runs `companions add|remove <name>`, the `companions` atom holds it; `accounts run` and looping `auto` are refused — terminal only), runs queued jobs from a `$.clock.every` tick started at `session.start` (the same tick runs `accounts.mjs auto --once` every 60 s and toasts a switch), and keeps `$.state.multiclaude.jobs` / `settings` / `view` / `cleared` / `wallets` / `usage` / `usageView`. Contract in `types/index.d.ts`. **Validate after every edit:** `claude plugin validate multiclaude` and `claude plugin test multiclaude`.
- `scripts/` — pure-Node (`.mjs`) helpers. **Edit as code.**
  - `scripts/dispatch.mjs` — THE runner: `dispatch.mjs <agy|codex> --model <id> [--effort e] [--edit] [--sandbox m] [--timeout s] [--out f] [--cd d] [--worktree] [--max-tokens N] [--fallback id] [--no-preflight] [--no-preamble] [--job id|auto] [--label l]` (and `--extend <id> <s>`), prompt on stdin. Validates the model, checks the AGY pool before starting (falls back or refuses with `QUOTA preflight`), prepends a header to every prompt (exact model id — also `$MC_MODEL_ID` — no `.env`/local-config edits, final-report rule; + read discipline on agy), returns only the final report on success (narration → `<id>.narration.md`), hashes `.env*` / `*.local*` before and after (`envChanged=`), warns at 80% of the timeout and accepts extensions, stops agy runs at a token budget (`BUDGET`; 350k default on the claude pool), parses the CLI's JSON stream, prints the answer on stdout and one proof line on stderr (`tokens=N (in/out/cached) steps=N calls=N`, `changed=N` + `git status` in the answer on failure). Codex failures are classed `QUOTA` / `CAPACITY` (provider overloaded: other model or retry; agy too) / `TOO_COMPLEX` / `PATCH_FAILED` with the CLI's error text. `changed=N` counts only `git status` lines that were not there at start. Exit codes: 0 ok · 1 failed · 2 bad usage · 3 agy denied · 124 timeout. Job files live 14 days; `dispatch_status({ all: true })` lists them. Each finished run refreshes the wallet-headroom cache.
  - `scripts/tracker.mjs` + `scripts/lib/tracker.mjs` — the usage tracker: incremental scans of Claude transcripts (default + accounts session profiles; default-login usage attributed via the accounts `switches.jsonl` log), Codex session token counts, AGY runner job files → `~/.cache/multiclaude/tracker.json` (per day × wallet × account × model). `[today|7d|30d|all] [--json] [--no-scan]`.
  - `scripts/lib/prices.mjs` — API list prices from LiteLLM, cached daily in `~/.cache/multiclaude/prices.json`; overrides (USD per million tokens, `*` = prefix) in `~/.config/multiclaude/prices.json`. "≈ API $" is a comparison figure, never a bill.
  - `scripts/failures.mjs` — reads `failures.jsonl` (one line per non-SUCCESS run, appended by `dispatch.mjs`): counts, advice per status, `--review-prompt`.
  - `scripts/probe.mjs` — orchestrate §0: opt-out, availability, Codex band table, AGY tier table, `--smoke`.
  - `scripts/usage-snapshot.mjs` — the headroom hook's engine; cached, refreshes in the background. `--statusline` prints the wallet rows with usage bars stretched to the terminal width (`terminal_width` from ccstatusline's stdin JSON, else `COLUMNS`/120, minus ccstatusline's 6 reserved columns): Claude 5h / wk (+ pool) and Codex on row 1, the Antigravity pools on row 2, or one row per provider when row 1 has no room for 3-cell bars; 5h windows count down, weekly ones show weekday + HH:MM; every name has its own colour, the bar in that colour, the % in the usage tone. `--row N` prints one row (a ccstatusline widget per line; an empty row prints nothing, and ccstatusline drops the line), `--session` puts the session line `Model: … | Ctx: … | branch | (+ins,-del)` (ccstatusline's design) on top from the statusLine JSON on stdin. `--json` (the Wallets pane) reads the cache only. `--wallet-rows on|off` (Delegates setting 7) writes / removes `<cache>/statusline.off`; with the flag present the rows print nothing (a `--session` line still does) and no refresh starts.
  - `scripts/setup.mjs` — the `setup` skill's engine (`check` / `apply`). `apply` also adds `statusLine` (add-only; `--no-statusline` skips; a statusLine of OURS is refreshed to today's command) → `node "<launcher>" --session`, the launcher written to `<XDG data | %APPDATA%>/multiclaude/statusline.mjs`, which finds the current install via `installed_plugins.json` (the install path moves with every update) and runs `usage-snapshot.mjs --statusline` with the extra argv passed on. `apply --ccstatusline` sets `statusLine` to `bunx -y ccstatusline@latest` (npx fallback; replaces ours, never a foreign one) and writes `~/.config/ccstatusline/settings.json` from `setup/ccstatusline.json` when there is none, else adds our `--row 1..3` widget lines to it (an older single widget of ours is replaced; backup). `check` verifies whichever is set. `companions [--json]` lists the optional companions (superpowers, claude-mem, codex, agy plugins — ids and marketplaces from `setup/settings.json` — and ccstatusline) with their state; `companions add|remove <name>` installs / uninstalls one through `claude plugin install|enable|uninstall` (marketplace added first when unknown; no CLI on PATH → add-only settings.json entry / `false`), ccstatusline via `apply --ccstatusline` / `statusLine` back to ours; settings.json writes are backed up (a second write in the same second gets a `-2` suffix).
  - `scripts/lib/models.mjs` — model catalogs: Codex bands by role off `~/.codex/models_cache.json`; AGY tiers by family/version/effort off `agy models` (cached 1h).
  - `scripts/lib/wallets.mjs` — wallet readers: Codex windows (labelled by `window_minutes`), Claude official limits + ccusage, AGY pools via `agy -p /usage` (reactive 429-log fallback).
  - `scripts/accounts.mjs` + `scripts/lib/accounts.mjs` — Claude multi-account store (Node port of claude-swap's core, MIT — `THIRD_PARTY_NOTICES.md`). One owner per refresh token (live login / running session profile / store); switches hold Claude Code's proper-lockfile dirs (`<home>/.oauth_refresh.lock`, `~/.claude.lock`, `~/.claude.json.lock`) with no network inside; writes are atomic 0600. Store: `~/.local/share/multiclaude/accounts` (`MULTICLAUDE_ACCOUNTS_DIR`). The headroom hook and quota show the accounts as one pooled CLAUDE wallet (mean used %). Every switch also appends one line to `switches.jsonl` (the usage tracker attributes default-login Claude usage by it).
  - `scripts/lib/claudelogin.mjs` — where the live Claude login lives: `.credentials.json`, or on Windows Credential Manager (`Claude Code-credentials/claude-code-user`, Bun.secrets layout incl. `#0..#n`/`#m` chunking) when Claude Code's `tengu_windows_credman` flag / `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN` is on; read/write via PowerShell P/Invoke (the one non-Node spawn, win32 only). `MULTICLAUDE_CREDMAN_FAKE=<file.json>` fakes it for tests. Used by `accounts` and `wallets`.
  - `scripts/lib/mc.mjs` — shared helpers (which/run/format).
- `agents/mc-agy.md`, `agents/mc-codex.md` — **fallback** Haiku forwarders (one Bash call to `dispatch.mjs`) for hosts that don't load plugin modules. The `dispatch` tool is the primary path.
- `THIRD_PARTY_NOTICES.md` — claude-swap's MIT license (keep it while `accounts` derives from it).
- `setup/settings.json` — plugin wiring (`enabledPlugins`, `extraKnownMarketplaces`) that `setup.mjs apply` ADDS to `~/.claude/settings.json` (add-only: an existing key is kept, never overwritten; `--companions` for the non-multiclaude plugins).
- `setup/preferences.json` — optional defaults (env, theme, effort …; no `statusLine` — that is not a preference: plain `apply` adds it, see setup.mjs) added only with `apply --preferences`. Never put `permissions`, `model` or a bypass flag in either template.
- `setup/ccstatusline.json` — the ccstatusline config (v4) `apply --ccstatusline` installs: line 1 model | context | branch (no icon) | changes, lines 2–4 our `custom-command` widgets `node "${MULTICLAUDE_STATUSLINE}" --row N` (the token becomes the launcher path). ccstatusline truncates a widget to the line width and drops a line whose widget prints nothing, which is why each row is its own widget.
- `types/index.d.ts` — the hooks module's `$.state` contract (incl. `Companions` for the Setup pane).
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
- The user's real `~/.claude/settings.json` — only `setup.mjs apply` writes it, add-only, with a timestamped `settings.json.multiclaude-<time>.bak`. Nothing writes it on install; the module shows a first-run notice until `/multiclaude:setup` has run.
- Accounts auto-switch defaults to OFF (`DEFAULT_CONFIG.auto.enabled`); it moves every running session's login, so it stays opt-in.

# Gotchas

- **YAML frontmatter is strict.** Copy `skills/quota/SKILL.md`'s shape.
- **agy exits 0 on failure.** An unknown model prints the picker list and exits 0; that is why the runner parses the JSON envelope. Never trust `$?` from a raw `agy` call.
- **agy headless denies commands.** Without `--edit` (`--dangerously-skip-permissions`) every `run_command` is auto-denied except the runner's read-only allowlist (`AGY_READ_CMDS` in `dispatch.mjs`, passed as session-only `--settings` `permissions.allow` `command(<prefix>)` rules; agy still denies redirects and `&&`/`;` chains). The first denial ends the run with no answer; the runner reports exit 3 so the orchestrator can re-dispatch. The no-edit preamble lists the allowed commands. File writes are *not* blocked by omitting `--edit` — treat "no edit" as "no commands", not "read-only".
- **agy has no stdin prompt.** The prompt is `--print`'s single argv value (~128 KB cap). The runner refuses bigger prompts with exit 2.
- **Codex `priority` is list order, not rank.** The workhorse lists above the frontier model. Bands come from the description text (`codexRole`).
- **The hooks module reloads only between turns.** After editing `register.tsx`, validate; the running session picks it up at the next turn end (dev-mods / `--plugin-dir`) or on restart (installed plugin).
- **Giving an offload node a `schema` or Read/Edit tools** makes the Claude driver do the work itself on your quota (observed: ~800k tokens).
