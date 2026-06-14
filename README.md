# multiclaude

My reproducible multi-agent Claude Code setup. **Claude Code orchestrates; Codex
(OpenAI) and AGY (Antigravity CLI) do the heavy lifting; Claude's own quota is
spent last.** Full design: `docs/superpowers/specs/`.

## Components

One canonical `settings.json` wires up everything below. The five plugins
install themselves from their marketplaces on first launch; the two delegate
CLIs and GitHub auth are the only manual steps.

| Component | What it is | How it installs |
|---|---|---|
| **Claude Code** | the host CLI that orchestrates | `npm i -g @anthropic-ai/claude-code` |
| **Node.js 18+** | runtime for Claude Code *and* every plugin script (pure Node, no bash/python3) | your package manager / nodejs.org |
| **`multiclaude` plugin** | orchestration skill, `/multiclaude:usage`, `/multiclaude:setup`, wallet-headroom hooks | auto (marketplace) |
| **`superpowers`** plugin | skills framework the orchestrate skill builds on | auto (marketplace) |
| **`claude-mem`** plugin | cross-session memory | auto (marketplace) |
| **`codex`** plugin + **`codex` CLI** | OpenAI delegate (edits/implementation) | plugin auto; **CLI manual** |
| **`agy`** plugin + **`agy` CLI** | Antigravity/Gemini delegate | plugin auto; **CLI manual** |
| **`ccusage` / `ccstatusline`** | Claude block cost + status line (via `bunx`/`npx`) | auto on demand |

## Quick install (fresh machine)

Order matters — **GitHub auth must come first** (the marketplace is a private
git repo over SSH).

```bash
# 1. GitHub auth FIRST — add an SSH key to GitHub, or:  gh auth login

# 2. Claude Code (pulls Node if you used a Node installer; otherwise install Node 18+ first)
npm i -g @anthropic-ai/claude-code

# 3. Canonical settings — bootstraps ALL marketplaces + plugins on next launch
git clone git@github.com:SomeCodecat/multiclaude.git ~/dev/multiclaude
cp ~/dev/multiclaude/multiclaude/setup/settings.json ~/.claude/settings.json
#   Already have a ~/.claude/settings.json you care about? Skip the cp and use
#   the "existing setup" section below instead — it merges, doesn't overwrite.

# 4. Delegate CLIs — interactive logins, can't be automated
curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # first run authenticates

# 5. First launch — marketplaces + all five plugins install automatically
claude
```

Then, inside Claude Code, verify everything in one shot:

```
/multiclaude:setup
```

It prints a checklist with an exact `fix:` line for anything missing (Node,
`bunx`/`npx`, the codex/agy CLIs + logins, the companion plugins, the hook, and
`ccusage` reachability). Re-run after applying any fix.

Partial bootstrap degrades gracefully: the orchestrate skill also checks each
component on first use and prints the exact missing step.

## Install onto an existing Claude Code setup

If you already have a `~/.claude/settings.json` you don't want to overwrite, add
just the two multiclaude entries and let the plugin's own `apply` mode merge the
rest non-destructively.

Into `extraKnownMarketplaces`:

```json
"multiclaude": {
  "source": { "source": "git", "url": "git@github.com:SomeCodecat/multiclaude.git" }
}
```

Into `enabledPlugins`:

```json
"multiclaude@multiclaude": true
```

Restart Claude Code (the marketplace + `multiclaude` plugin install on launch),
then converge the rest of the wiring — companion marketplaces/plugins, model,
hooks, env — without clobbering keys you already set. Run the setup skill and let
Claude execute it (it knows the installed plugin path):

```
/multiclaude:setup            # check: verify, change nothing, print fixes
```

To actually write the merged config, ask Claude to run setup in **apply** mode
(`apply` = plugin wiring; `apply --full` = the whole template — model/theme/env;
`apply --dry-run` = preview the diff). It backs up to `settings.json.bak` and
never touches keys it doesn't manage. If you cloned this repo, you can also run it
straight from a shell:

```bash
node <repo>/multiclaude/scripts/setup.mjs apply --dry-run   # preview
node <repo>/multiclaude/scripts/setup.mjs apply             # write
```

Finally install the delegate CLIs (skip any you already have):

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy
```

Prefer clicking? Run `/plugin`, add the `multiclaude` marketplace from
`git@github.com:SomeCodecat/multiclaude.git`, install `multiclaude` from it — no
manual JSON editing.

## Updating

When this repo ships a new version, update the other machines from inside Claude
Code:

```
/plugin marketplace update multiclaude
/plugin update multiclaude@multiclaude
```

Restart Claude Code, then `/multiclaude:usage` should show the new version. If a
machine tracks this repo directly instead, `git -C <path>/multiclaude pull
--ff-only` and restart.

## Per-project opt-out

Projects whose code must not leave for OpenAI/Google: add to the project
`CLAUDE.md`:

```
orchestrate: off
```
