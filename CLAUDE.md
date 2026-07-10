# Plugin Overview

`multiclaude` is a Claude Code plugin that makes Claude an orchestrator.
It routes substantive work to two external delegates — Codex (OpenAI) and AGY (Antigravity/Gemini) — before spending Claude Code's own quota.
"Orchestration" here is a behavior taught by a **skill**, not a runtime. There is no orchestrator process and no agent-definition files in this repo.
The top-level orchestrator is **Claude Code itself**, driven by the `orchestrate` skill (`skills/orchestrate/SKILL.md`).
The plugin is markdown (SKILL.md files) + JSON config (manifests, hooks, settings) + pure-Node scripts. There is no build step and no test suite.

# Structure

The plugin root is `multiclaude/` (a subdir of this repo root). All paths below are relative to that plugin root. Two exceptions live in the repo root: this file, and `.claude-plugin/marketplace.json`.

- `.claude-plugin/plugin.json` — plugin manifest. Machine-read by Claude Code to discover the plugin. **Edit name/version/description/author only.**
- Repo-root `.claude-plugin/marketplace.json` — marketplace manifest. Lists this plugin and its `source`. **Edit with care; see Do Not Touch.**
- `skills/` — the plugin's real content. Each subdir has a `SKILL.md`. Each skill is exposed as a slash command `/multiclaude:<name>`.
  - `skills/orchestrate/SKILL.md` — the orchestration rules. Entry skill. Trigger: start of any substantive task. **Safe to edit.**
  - `skills/setup/SKILL.md` — one-shot environment check/converge. Trigger: `/multiclaude:setup`. **Safe to edit.**
  - `skills/quota/SKILL.md` — usage/quota readout across wallets. Trigger: `/multiclaude:quota`, or user asks about usage/limits/cost. **Safe to edit.**
  - `skills/quota/quota.mjs` — script the quota skill runs. **Edit as code.**
- `hooks/hooks.json` — registers the wallet-headroom hook on `SessionStart` and `PreToolUse` (Task/Workflow). **Safe to edit; keep JSON valid.**
- `scripts/` — pure-Node (`.mjs`) helpers the skills and hooks invoke. **Edit as code.**
  - `scripts/probe.mjs` — mechanical session setup (orchestrate §0): opt-out, CLI availability, AGY tier resolution.
  - `scripts/setup.mjs` — the `setup` skill's engine (`check` / `apply`).
  - `scripts/usage-snapshot.mjs` — the hook's engine; emits the cached headroom line.
  - `scripts/lib/mc.mjs`, `scripts/lib/wallets.mjs` — shared helpers imported by the above.
- `setup/settings.json` — desired-state `~/.claude/settings.json` template that `setup.mjs apply` deep-merges. **Edit to change defaults.**
- There is NO `agents/` dir, NO `commands/` dir, NO `.mcp.json`. The plugin ships no MCP server and no agent files.

# File Formats

Verify against the named example before copying. Frontmatter is YAML between `---` lines at the very top.

## Skill (`skills/<name>/SKILL.md`)
Example: `skills/orchestrate/SKILL.md`. Only two fields are used, both **required**:
- `name:` — string. Must equal the skill's directory name. Example: `name: orchestrate`.
- `description:` — string, one line. This is the trigger text; write it as "Use when …". No other fields (no `tools`, `model`, `allowed-tools`) appear in this repo — do not add them.
Body: Markdown after the closing `---`.

## Plugin manifest (`.claude-plugin/plugin.json`)
Plain JSON object. Fields used: `name` (string, `"multiclaude"`), `version` (string, semver), `description` (string), `author` (object with `name`). No `commands`/`agents`/`hooks`/`mcpServers` keys — those are discovered by convention from the directories.

## Marketplace manifest (repo-root `.claude-plugin/marketplace.json`)
Plain JSON. Fields: `name`, `owner.name`, `metadata.description`, `metadata.version`, and `plugins` (array). Each `plugins[]` entry: `name`, `description`, `version`, `author.name`, `source` (`"./multiclaude"` — the plugin subdir).

## Hooks (`hooks/hooks.json`)
Plain JSON. Top-level `description` (string) + `hooks` object keyed by event (`SessionStart`, `PreToolUse`). Each event holds an array of `{ matcher, hooks }`.
- `matcher` — string regex against the trigger (`"startup|clear|compact"`, `"Task|Workflow"`).
- `hooks[]` — `{ type: "command", command: "node", args: [ ... ], timeout: <seconds> }`.
- Script paths in `args` use `${CLAUDE_PLUGIN_ROOT}` — never a hardcoded absolute path.

# Orchestration Model

- **Entrypoint:** the `orchestrate` skill. Claude reads it, then acts as orchestrator: classify → dispatch → verify with mechanical gates → synthesize.
- **Delegation mechanism (exact, as used in this repo):**
  - Codex: `Agent` tool with `subagent_type: "codex:codex-rescue"` and `model: "haiku"`, or `codex exec` via Bash. Every dispatch names an explicit GPT-5.6 tier + effort per orchestrate §2's band table (`--model gpt-5.6-<luna|terra|sol> --effort <effort>` in the rescue prompt; `codex exec -m gpt-5.6-<tier> -c model_reasoning_effort="<effort>"` on Bash) — never the CLI's config default.
  - AGY default tier: `Agent` tool with `subagent_type: "agy:agy-rescue"` and `model: "haiku"` (inline result, no polling).
  - The `model: "haiku"` override matters: the rescue agents are thin one-Bash-call forwarders, so a bigger driver buys nothing — without the override the driver inherits the main-loop model (Opus) and spends own quota to forward a string.
  - AGY specific tier / edits: `agy --print` via **backgrounded Bash** with `--model "<resolved tier name>"` and, for edits, `--dangerously-skip-permissions`.
  - These agent types come from the external `codex` and `agy` plugins, NOT from files in this repo.
- **Model choice:** every `Agent`/`agent()`/subagent runs a Claude driver on **your own Anthropic quota** by default. `subagent_type`/`agentType` swaps the system prompt + tools, not the provider. Work lands on Codex/AGY quota **only** when a driver actually shells out to the `codex`/`agy` CLI via Bash.
- **Tool restriction for offload:** an offload node must be Bash-only, carry **no `schema`** and **no Read/Edit tools**, and use a **command-shaped prompt**. Any of those three makes the driver do the work itself on your quota.
- **Context passing:** by prompt only — sub-agents do not share this conversation. Ground prompts with real file/diff content; include the verbatim anti-fabrication clause from orchestrate §2.
- **Concurrency:** non-edit tasks (review/research) fan out freely in one turn. Edit tasks parallelize only under isolation (disjoint files or separate worktrees). Otherwise serialize (one-writer protocol, §4).
- **Workflow fan-out:** ≥3 independent offload nodes go through the native Workflow tool with synchronous Bash-only CLI nodes (orchestrate §2 "Workflow fan-out"); all three wallets (Codex, AGY, own Claude) can run at once in one workflow. Never use the `*-rescue` agentTypes inside workflows — the forwarder can resolve early with a placeholder.
- **Attribution:** every delegated task surfaces its executor — provider + exact model (+ effort for Codex) — in the task subject, the synthesis, commit trailers (`Implemented-by:`), and workflow node labels (orchestrate §9).
- **AGY MCP tools and `--background`/`agy_status` polling are broken (§2) — never use them; the two inline CLI paths are the only supported AGY routes.**

# Conventions

- **New skill:** create `skills/<name>/SKILL.md`. Set `name: <name>` equal to the dir. It becomes `/multiclaude:<name>`. Example dir: `skills/quota/`.
- **Skill script:** co-locate with the skill (e.g. `skills/quota/quota.mjs`); the SKILL.md invokes it via `node "${CLAUDE_PLUGIN_ROOT}/skills/<name>/<script>.mjs"`.
- **Shared script code:** put in `scripts/`; shared helpers go in `scripts/lib/` and are imported (see `mc.mjs`, `wallets.mjs`). Pure Node only — no bash, no python3, cross-platform.
- **`description` field:** write it as a trigger, specific and non-overlapping. Good: `quota`'s "Use to check headroom before delegating, or when the user asks about usage/quota/limits/cost." Bad: a vague "Handles usage stuff" that could also match `setup`.
- **Tool allow-listing:** this repo's skills list no `tools` field. Do not add one unless you intend to restrict — leave it off to inherit defaults.
- **Model selection:** skills do not pin a model. The default orchestrator model is set in `setup/settings.json` (`"model": "claude-opus-4-8"`), not in skill frontmatter.
- **Script path references:** always `${CLAUDE_PLUGIN_ROOT}/...`, never an absolute path.

# Do Not Touch

- `plugin.json` `name` and the marketplace `plugins[].name` / `source` — changing these breaks plugin discovery and install.
- Keep `version` identical across `plugin.json` and both `marketplace.json` version fields when bumping. A mismatch misreports the installed version.
- `${CLAUDE_PLUGIN_ROOT}` tokens in `hooks/hooks.json` and SKILL.md — replacing with an absolute path breaks portability.
- `setup/settings.json` `enabledPlugins` / `extraKnownMarketplaces` keys and their `@marketplace` suffixes — these must match the real marketplaces or `setup apply` wires nothing.
- User's real `~/.claude/settings.json` — never edit by hand; `setup.mjs apply` manages it (and backs it up to `.bak`).

# Common Tasks

1. **Add a skill (= a slash command):** create `skills/<name>/SKILL.md` with `name: <name>` and a trigger `description`. Write the body. It auto-registers as `/multiclaude:<name>`. If it needs code, add `skills/<name>/<name>.mjs` and call it from the body.
2. **Add a slash command:** same as #1 — commands in this plugin ARE skills. Do not create a `commands/` dir.
3. **Wire a new agent into the orchestrator:** external agents are not files here. Add a routing rule to `skills/orchestrate/SKILL.md` (§2 table + §2 "Dispatch mechanics"), referencing the agent by its exact `subagent_type` (e.g. `codex:codex-rescue`). If it is a new plugin, also add it to `setup/settings.json` `enabledPlugins` + `extraKnownMarketplaces`.
4. **Restrict an agent's tools / keep offload thin:** in the orchestrate prompt guidance, dispatch the offload node Bash-only, with no `schema` and no Read/Edit tools, and a command-shaped prompt (orchestrate §7). Do not add a `tools:` field to a SKILL.md.
5. **Change a default (model/theme/env/plugins):** edit `setup/settings.json`; users pick it up via `/multiclaude:setup apply --full`.
6. **Add a hook:** add an entry under the event key in `hooks/hooks.json` with a `matcher` and a `{type:"command", command:"node", args:["${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs", ...], timeout}` block.

# Gotchas

- **YAML frontmatter is strict.** A skill loads only with `---` on the first line, exactly `name:` and `description:`, and no tab indentation. Problem: a missing/misspelled field or a stray tab makes the skill silently not load → **What to do instead:** copy `skills/quota/SKILL.md`'s frontmatter shape verbatim and change the values.
- **`name` must equal the directory.** Problem: `name: usage` in `skills/quota/` mis-registers the command → **What to do instead:** always set `name` to the exact folder name.
- **Vague/overlapping `description`.** Problem: two skills with similar descriptions cause the wrong one to trigger → **What to do instead:** write distinct "Use when …" triggers; keep `setup` (converge env), `quota` (report usage), and `orchestrate` (route work) clearly separated.
- **Wrong agent/tool name.** Problem: `subagent_type: "codex-rescue"` or `"agy:rescue"` does not resolve → **What to do instead:** use the exact strings `codex:codex-rescue` and `agy:agy-rescue`; verify against the installed plugins.
- **Giving an offload node a `schema` or Read/Edit tools.** Problem: the Claude driver does the work itself on your quota and offloads nothing (observed: ~800k tokens burned) → **What to do instead:** Bash-only node, command-shaped prompt, no schema, no read/edit tools (orchestrate §7).
- **Editing the manifest wrong.** Problem: changing `plugins[].source` away from `"./multiclaude"`, or breaking JSON in `plugin.json`, makes the plugin fail to load → **What to do instead:** change only description/version; keep `name`/`source` stable; validate JSON.
- **Assuming an unused orchestration mechanism.** Problem: reaching for AGY MCP tools, `--background` + `agy_status`, or a hand-rolled `sleep`/`pgrep` waiter — all hang here → **What to do instead:** use the two inline AGY CLI paths (orchestrate §2) and let backgrounded jobs notify you (§8).
- **Assuming a build/test step.** Problem: there is none; scripts are run directly with `node`. Do not add a package manifest or CI expectation that isn't here.
