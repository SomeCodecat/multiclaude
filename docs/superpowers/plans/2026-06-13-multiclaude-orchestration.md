# multiclaude Orchestration Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multiclaude marketplace repo containing the `orchestrate` plugin (skill that routes work to Codex/AGY before Claude's own quota), a canonical settings template, and new-machine bootstrap docs.

**Architecture:** A Claude Code plugin marketplace hosted in this repo. One plugin (`orchestrate`) with one skill (`orchestrate`) that encodes the delegation test, routing table, acceptance gates, one-writer protocol, quota re-routing cascade, and availability checks defined in the spec (`docs/superpowers/specs/2026-06-13-multiclaude-orchestration-design.md`).

**Tech Stack:** Claude Code plugin system (marketplace.json / plugin.json / SKILL.md), JSON, Markdown. No application code; verification is JSON validation + live plugin-load smoke tests.

**Working directory for all tasks:** `/home/max/dev/multiclaude`

---

### Task 1: Marketplace and plugin manifests

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `orchestrate/.claude-plugin/plugin.json`

- [ ] **Step 1: Write marketplace.json**

```json
{
  "name": "multiclaude",
  "owner": {
    "name": "SomeCodecat"
  },
  "metadata": {
    "description": "SomeCodecat's multi-agent orchestration setup: route work to Codex and AGY before spending Claude Code's own quota.",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "orchestrate",
      "description": "Orchestrator skill: delegation test, Codex/AGY routing, acceptance gates, quota re-routing.",
      "version": "1.0.0",
      "author": {
        "name": "SomeCodecat"
      },
      "source": "./orchestrate"
    }
  ]
}
```

- [ ] **Step 2: Write orchestrate/.claude-plugin/plugin.json**

```json
{
  "name": "orchestrate",
  "version": "1.0.0",
  "description": "Multi-agent orchestration for Claude Code: delegate to Codex and AGY first, verify with mechanical gates, spend own quota last.",
  "author": {
    "name": "SomeCodecat"
  }
}
```

- [ ] **Step 3: Validate both JSON files**

Run: `python3 -m json.tool .claude-plugin/marketplace.json > /dev/null && python3 -m json.tool orchestrate/.claude-plugin/plugin.json > /dev/null && echo VALID`
Expected: `VALID`

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin orchestrate
git commit -m "feat: marketplace and plugin manifests"
```

---

### Task 2: The orchestrate skill

**Files:**
- Create: `orchestrate/skills/orchestrate/SKILL.md`

- [ ] **Step 1: Write SKILL.md with the complete content below**

````markdown
---
name: orchestrate
description: Use at the start of any substantive task (implementation, review, research, analysis, heavy reasoning) to route work to Codex and AGY before spending Claude Code's own tokens. Claude acts as orchestrator - dispatch, verify with mechanical gates, synthesize.
---

# Orchestrate

Route delegation-shaped work to external agents (Codex, AGY) first. Claude
Code's own quota is the LAST resort. Claude's job: classify, dispatch, verify
cheaply, synthesize, spot-fix.

## 0. Session setup (run once per session, cache the results)

1. **Per-project opt-out:** check the project's CLAUDE.md for a line
   `orchestrate: off`. If present: tell the user once, skip orchestration
   entirely this session, work normally.
2. **Availability checks:**

   ```bash
   command -v codex || echo "CODEX MISSING"
   command -v agy || echo "AGY MISSING"
   agy models 2>/dev/null || echo "AGY MODELS UNAVAILABLE"
   ```

3. **Resolve AGY model tiers by pattern** (NEVER hardcode names — they drift).
   From `agy models` output match, case-insensitive:
   - Opus tier: first line matching `Claude.*Opus`
   - Sonnet tier: first line matching `Claude.*Sonnet`
   - Gemini-high tier: first line matching `Gemini.*Flash.*High`
   - Gemini-medium tier: first line matching `Gemini.*Flash.*Medium`

   A pattern with no match = tier unavailable; route to the next tier down
   (Opus→Sonnet→Gemini-high→Gemini-medium) or re-route per §5.
4. **If a component is missing**, warn ONCE with the exact fix:
   - Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` then `codex login`
   - AGY: `curl -fsSL https://antigravity.google/cli/install.sh | bash` then authenticate
   - superpowers / claude-mem plugins (if their skills are absent): add the
     marketplace + enabledPlugins entries from the multiclaude repo's
     `setup/settings.json`
   Then continue in degraded form with explicit availability re-routing
   (availability gaps work like quota exhaustion, §5, but are marked for the
   whole session immediately):
   - Codex missing → route implementation tasks to AGY Sonnet/Opus tier
   - AGY missing → route review and heavy reasoning to Codex if suitable,
     else Claude handles them locally
   If BOTH CLIs are missing: say so once, work normally without orchestration.

## 1. The Delegation Test

Delegate a task ONLY if ALL four hold:

1. **Self-contained spec** — describable completely in a prompt without
   constraints that live only in conversation history.
2. **Bounded file surface** — expected touched files nameable in advance.
3. **Mechanically checkable** — acceptance gates (§3) can verify it without
   reading the full implementation.
4. **Substantive enough to pay for itself** — dispatch overhead (context
   serialization, polling, gates, diff skim) < expected savings. One-liners
   and trivial edits fail this; do them directly.

Tasks failing ANY criterion: Claude does them directly. Never delegate just to
push the delegation share up.

## 2. Routing

| Task type | Agent | Model |
|---|---|---|
| Code implementation, refactors, test writing | Codex | Codex default |
| Code review, research, analysis, docs | AGY | Gemini-medium tier |
| Hard review/research, architecture analysis | AGY | Gemini-high tier |
| Heavy reasoning (would use own Sonnet) | AGY | Sonnet tier |
| Hardest reasoning (would use own Opus) | AGY | Opus tier |

**Dispatch mechanics:**

- **Codex:** use the Agent tool with `subagent_type: "codex:codex-rescue"`
  (preferred — shared runtime), or `codex exec` via Bash for fully scripted
  runs. Codex runs in the configured bypass mode and edits files directly.
- **AGY review/research (no edits):** use the MCP tools `agy_rescue` /
  `agy_review` with `--background` for anything that could exceed ~2 minutes;
  poll `agy_status` / `agy_result <job-id>`. The MCP path keeps AGY sandboxed
  — correct for no-edit work.
- **AGY edit/rework tasks:** call the CLI directly via Bash (the MCP tool is
  deliberately no-edit):

  ```bash
  agy --print --print-timeout 30m --dangerously-skip-permissions \
      --model "<resolved tier name>" "<task prompt>"
  ```

  Use Bash `run_in_background: true` for long jobs.

**Every delegation prompt must contain:** the task spec, the expected file
list, project conventions that matter (test command, lint command, style
notes), and the instruction to run the project's tests before finishing.

## 3. Acceptance Gates (verify mechanically, not by re-reading)

Run in order after a delegated edit task returns:

1. Project test suite (or the relevant subset).
2. Typecheck.
3. Lint.
4. `git diff --stat` — touches only the expected file set (± clearly
   justified additions like new test files).

**All pass:** skim `git diff --stat` plus changed hunks in critical files
only. Accept. NO deep read.
**Any fail:** read the failing output + relevant hunks. Then: (a) spot-fix if
small; (b) dispatch rework to the OTHER agent with a failure summary; (c)
after 2 failed reworks, take over directly.

Projects without tests/typecheck/lint: diff-scope check + actually read the
diff (degraded, more expensive — note it).

## 4. One-Writer Protocol

1. Working tree MUST be clean before delegating an edit task (commit or stash
   first). Dirty tree blocks delegation.
2. While a delegated edit job runs, do NOT edit files in that workspace.
3. Every accepted delegated change lands as its own commit with attribution:
   - Codex sets `Co-Authored-By: Codex <noreply@openai.com>` itself
   - add `Co-Authored-By: AGY <noreply@antigravity>` for AGY edits
4. Rejected work: `git checkout . && git clean -fd` (safe — tree was clean at
   dispatch), THEN send the rework.

## 5. Quota Re-Routing (reactive; quota errors are NOT quality failures)

Exhaustion is detected only via quota/rate-limit errors from a call. On one:

- **AGY tier exhausted:** Gemini and Claude tiers have SEPARATE quotas — step
  to the other tier first, either direction (Gemini out → Claude tier; Claude
  out → Gemini tier). Both out → re-evaluate: Codex-suitable? → Codex; else
  Claude does it locally.
- **Codex exhausted:** re-evaluate: AGY-suitable? → AGY (implementation
  rework → Sonnet/Opus tier, review/research → Gemini tier); else local.
- **Everything exhausted:** work normally on own quota; tell the user ONCE
  that orchestration is suspended.

A quota failure does NOT consume a rework hop (no work product was produced).

**Session exhaustion marks:** after a quota error, mark that agent/tier
exhausted for the REST OF THE SESSION and skip it immediately for later tasks.
Tell the user once per session which agents are marked. Fresh sessions
re-probe naturally.

## 6. Fallback summary (quality failures)

Codex fails gates → AGY reworks (failure summary in prompt).
AGY fails gates → Codex reworks (failure summary in prompt).
Hard limit: 2 rework attempts total, then Claude takes over.
Rework prompts MUST summarize what the previous attempt got wrong.
````

- [ ] **Step 2: Verify frontmatter and structure**

Run: `head -5 orchestrate/skills/orchestrate/SKILL.md`
Expected: `---`, `name: orchestrate`, `description: Use at the start...` lines present.

- [ ] **Step 3: Commit**

```bash
git add orchestrate/skills
git commit -m "feat: orchestrate skill - delegation test, routing, gates, quota re-routing"
```

---

### Task 3: Canonical settings template

**Files:**
- Create: `setup/settings.json`

- [ ] **Step 1: Read the LIVE settings as base**

Run: `cat ~/.claude/settings.json`
The live file is the source of truth (the user may have changed `model` or
other prefs since this plan was written). Do NOT copy stale values from this
plan.

- [ ] **Step 2: Write setup/settings.json = live settings + these additions**

Add to `enabledPlugins`:

```json
"orchestrate@multiclaude": true
```

Add to `extraKnownMarketplaces`:

```json
"multiclaude": {
  "source": {
    "source": "git",
    "url": "git@github.com:SomeCodecat/multiclaude.git"
  }
}
```

Everything else (env, permissions, model, statusLine, effortLevel, theme,
existing plugins/marketplaces) is carried over from the live file unchanged.

- [ ] **Step 3: Validate**

Run: `python3 -m json.tool setup/settings.json > /dev/null && echo VALID`
Expected: `VALID`

- [ ] **Step 4: Commit**

```bash
git add setup
git commit -m "feat: canonical settings template with multiclaude marketplace"
```

---

### Task 4: README with bootstrap instructions

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

````markdown
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
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with auth-ordered bootstrap instructions"
```

---

### Task 5: Wire into the live machine and push

**Files:**
- Modify: `/home/max/.claude/settings.json` (add multiclaude marketplace + enable orchestrate plugin — same two additions as Task 3 Step 2)

- [ ] **Step 1: Add to live ~/.claude/settings.json**

Insert into `enabledPlugins`: `"orchestrate@multiclaude": true`
Insert into `extraKnownMarketplaces`: the `multiclaude` entry from Task 3 Step 2.

- [ ] **Step 2: Validate live settings**

Run: `python3 -m json.tool ~/.claude/settings.json > /dev/null && echo VALID`
Expected: `VALID`

- [ ] **Step 3: Push the repo**

```bash
cd /home/max/dev/multiclaude && git push -u origin main
```

Expected: branch `main` pushed to git@github.com:SomeCodecat/multiclaude.git

---

### Task 6: Verification (spec test plan items 1-2; 3-5 are post-restart)

- [ ] **Step 1: Structural smoke test**

Run from repo root:
```bash
python3 - <<'EOF'
import json, pathlib
mp = json.load(open(".claude-plugin/marketplace.json"))
pl = json.load(open("orchestrate/.claude-plugin/plugin.json"))
assert mp["plugins"][0]["source"] == "./orchestrate"
assert mp["plugins"][0]["name"] == pl["name"] == "orchestrate"
assert pathlib.Path("orchestrate/skills/orchestrate/SKILL.md").exists()
s = json.load(open("setup/settings.json"))
assert s["enabledPlugins"]["orchestrate@multiclaude"] is True
assert "multiclaude" in s["extraKnownMarketplaces"]
print("STRUCTURE OK")
EOF
```
Expected: `STRUCTURE OK`

- [ ] **Step 2: Tell the user the restart-dependent steps**

Plugin loading happens at Claude Code startup. The user must restart Claude
Code, then:
1. Confirm the skill exists: the skill list should include `orchestrate:orchestrate`.
2. Dry-run: invoke `/orchestrate` in a scratch project — availability table
   should print with all components green.
3. (Optional, from spec test plan) degradation test: `mv ~/.local/bin/agy{,.bak}`,
   re-invoke, expect the AGY-missing warning + re-routing note; restore with
   `mv ~/.local/bin/agy{.bak,}`.
4. (Optional) delegation round-trip: in a scratch repo, ask for a small
   bounded feature; verify Codex dispatch, gates, attributed commit.
5. (Optional) rework path: delegate with an intentionally wrong expected-file
   list to force a gate-4 failure; verify the failure summary is built, the
   rework goes to the other agent, and the 2-hop limit stops the loop.
6. (Optional, larger) fresh-machine simulation: on a clean user or container,
   follow the README bootstrap top to bottom; verify plugins install on the
   first `claude` launch.
