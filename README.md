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

## Per-project opt-out

Projects whose code must not go to OpenAI/Google: add to the project
CLAUDE.md:

```
orchestrate: off
```
