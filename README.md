# multiclaude

My reproducible multi-agent Claude Code setup. Claude Code orchestrates;
Codex (OpenAI) and AGY (Antigravity CLI) do the heavy lifting; Claude's own
quota is spent last. Full design: `docs/superpowers/specs/`.

## What's in here

- `orchestrate/` — Claude Code plugin with the orchestration skill
  (delegation test, Codex/AGY routing, acceptance gates, quota re-routing)
- `setup/settings.json` — canonical `~/.claude/settings.json` (all
  marketplaces + plugins: superpowers, claude-mem, codex, agy, orchestrate)
- `.claude-plugin/marketplace.json` — makes this repo a plugin marketplace

## New machine bootstrap

Order matters — GitHub auth must come first (private repo + git marketplace
sources).

```bash
# 1. GitHub auth FIRST
#    Add an SSH key to GitHub, or: gh auth login

# 2. Install Claude Code
npm i -g @anthropic-ai/claude-code

# 3. Canonical settings
git clone git@github.com:SomeCodecat/multiclaude.git ~/dev/multiclaude
cp ~/dev/multiclaude/setup/settings.json ~/.claude/settings.json

# 4. Delegate CLIs (interactive logins, cannot be automated)
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy   # first run triggers authentication

# 5. First launch - marketplaces and plugins install automatically
claude
```

Partial bootstrap degrades gracefully: the orchestrate skill checks each
component on first use and prints the exact missing step.

## Install on an existing Claude Code setup

If you already have Claude Code configured and don't want to overwrite your
`~/.claude/settings.json`, add just the two multiclaude entries to it.

Into `extraKnownMarketplaces`:

```json
"multiclaude": {
  "source": {
    "source": "git",
    "url": "git@github.com:SomeCodecat/multiclaude.git"
  }
}
```

Into `enabledPlugins`:

```json
"orchestrate@multiclaude": true
```

Then make sure the delegate CLIs are present (skip any you already have):

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy
```

Restart Claude Code. The marketplace and `orchestrate` plugin install on the
next launch; confirm with `/orchestrate`, which prints an availability table
for Codex, AGY, the model tiers, and the superpowers / claude-mem plugins.

Prefer the interactive route? Run `/plugin`, add the `multiclaude` marketplace
from `git@github.com:SomeCodecat/multiclaude.git`, then install `orchestrate`
from it — no manual JSON editing required.

## Per-project opt-out

Projects whose code must not go to OpenAI/Google: add to the project
CLAUDE.md:

```
orchestrate: off
```
