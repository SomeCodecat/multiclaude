# multiclaude

My reproducible multi-agent Claude Code setup. **Claude Code orchestrates; Codex
(OpenAI) and AGY (Antigravity CLI) do the heavy lifting; Claude's own quota is
spent last.** Full design: `docs/superpowers/specs/`.

## Components

| Component | What it is | How it installs |
|---|---|---|
| **Claude Code** | the host CLI that orchestrates | `npm i -g @anthropic-ai/claude-code` |
| **Node.js 18+** | runtime for Claude Code *and* every plugin script (pure Node, no bash/python3) | your package manager / nodejs.org |
| **`multiclaude` plugin** | orchestration skill, `/multiclaude:usage`, `/multiclaude:setup`, wallet-headroom hooks | **marketplace add (below)** |
| **`superpowers`** plugin | skills framework the orchestrate skill builds on | `/multiclaude:setup apply --full` |
| **`claude-mem`** plugin | cross-session memory | `/multiclaude:setup apply --full` |
| **`codex`** plugin + **`codex` CLI** | OpenAI delegate (edits/implementation) | plugin via setup; **CLI manual** |
| **`agy`** plugin + **`agy` CLI** | Antigravity/Gemini delegate | plugin via setup; **CLI manual** |
| **`ccusage` / `ccstatusline`** | Claude block cost + status line (via `bunx`/`npx`) | auto on demand |

## Install

You need Claude Code (and Node 18+) already on the machine. Then, inside Claude
Code, add this repo as a marketplace and install the plugin:

```
/plugin marketplace add SomeCodecat/multiclaude
/plugin install multiclaude@multiclaude
```

That's the whole plugin. Restart Claude Code so its skills and hooks load, then
verify and wire up the rest in one shot:

```
/multiclaude:setup
```

`/multiclaude:setup` prints a checklist with an exact `fix:` line for anything
missing — Node, `bunx`/`npx`, the companion plugins, the wallet-headroom hook,
`ccusage` reachability, and the codex/agy CLIs + logins.

### Pull in the companion plugins automatically

`multiclaude` builds on `superpowers` (skills framework) and `claude-mem`
(memory). Have Claude run setup in **apply** mode to merge their marketplaces +
plugins — plus the model/theme/env defaults — into your `~/.claude/settings.json`
non-destructively (it backs up to `settings.json.bak` and never clobbers keys it
doesn't manage):

```
/multiclaude:setup apply --full      # merge the whole template
/multiclaude:setup apply --dry-run   # preview the diff first
```

Restart Claude Code and the companion plugins install on launch. Re-run
`/multiclaude:setup` to confirm everything is green.

### Install the delegate CLIs

The codex/agy **plugins** come in via setup, but their **CLIs** need interactive
logins that can't be automated (skip any you already have):

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # first run authenticates
```

Re-run `/multiclaude:setup` — it should now report codex and agy installed and
authenticated.

## Manual install (no interactive `/plugin`)

Prefer editing config directly? Add the marketplace and enable the plugin in
`~/.claude/settings.json`, then restart.

Into `extraKnownMarketplaces`:

```json
"multiclaude": {
  "source": { "source": "github", "repo": "SomeCodecat/multiclaude" }
}
```

Into `enabledPlugins`:

```json
"multiclaude@multiclaude": true
```

The marketplace + plugin install on next launch; then follow the
`/multiclaude:setup` steps above for the companions and CLIs.

## Updating

When this repo ships a new version, update from inside Claude Code:

```
/plugin marketplace update multiclaude
/plugin update multiclaude@multiclaude
```

Restart Claude Code, then `/multiclaude:usage` should show the new version.

## Per-project opt-out

Projects whose code must not leave for OpenAI/Google: add to the project
`CLAUDE.md`:

```
orchestrate: off
```
