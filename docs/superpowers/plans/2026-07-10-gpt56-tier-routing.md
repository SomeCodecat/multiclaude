# GPT-5.6 Tier Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Codex dispatches to the new GPT-5.6 tiers (luna/terra/sol) by task band, with paired reasoning effort, so orchestration stops burning gpt-5.5 @ xhigh on every task.

**Architecture:** Markdown + manifest changes only. The orchestrate skill's §2 routing table gains three Codex bands (tier + effort each); dispatch mechanics document how the tier rides the two existing paths (`codex:codex-rescue` prompt pass-through, `codex exec -m` + `-c model_reasoning_effort`). CLAUDE.md gets one orienting line; version bumps to 2.3.0.

**Tech Stack:** Markdown skills, JSON manifests, Codex CLI 0.144.1. No build, no test suite — verification is smoke tests + JSON parse + `probe.mjs`.

**Spec:** `docs/superpowers/specs/2026-07-10-gpt56-tier-routing-design.md` (approved)

**Context for the engineer:**
- Repo root is `/home/max/dev/multiclaude`; the plugin lives in the `multiclaude/` subdir.
- `skills/orchestrate/SKILL.md` is the orchestration rulebook Claude reads at runtime. Section numbers (§2, §3) are referenced from elsewhere in the file — do not renumber sections.
- The `codex:codex-rescue` agent (external plugin) passes `--model <value>` and `--effort <value>` from its dispatch prompt through to the codex CLI as runtime controls; this is existing behavior we rely on, not something we implement.
- There is NO test suite and NO build step. Do not add one.

---

### Task 1: Split the Codex routing row into three tier bands

**Files:**
- Modify: `multiclaude/skills/orchestrate/SKILL.md` (§2 Routing, the table at ~line 147 and the parenthetical after it)

- [ ] **Step 1: Replace the single Codex table row with three band rows**

Old text (exact, one table row):

```markdown
| Code implementation, refactors, test writing | Codex | Codex default | Agent tool `codex:codex-rescue`, `model: "haiku"` |
```

New text:

```markdown
| Mechanical code: boilerplate, renames, config/doc edits, small clearly-specced fixes, formatting | Codex | `gpt-5.6-luna`, effort `medium` | Agent tool `codex:codex-rescue`, `model: "haiku"` |
| Standard code: features, refactors, test writing, everyday implementation | Codex | `gpt-5.6-terra`, effort `high` | Agent tool `codex:codex-rescue`, `model: "haiku"` |
| Hard code: complex refactors, tricky bugs, architecture, long agentic runs, security-sensitive | Codex | `gpt-5.6-sol`, effort `xhigh` | Agent tool `codex:codex-rescue`, `model: "haiku"` |
```

- [ ] **Step 2: Add the Codex tier rule after the existing AGY parenthetical**

Old text (exact):

```markdown
(The `agy:agy-rescue` subagent cannot select a tier — anything tier-specific
goes through the Bash CLI path below.)
```

New text (keep the parenthetical, append the new paragraph):

```markdown
(The `agy:agy-rescue` subagent cannot select a tier — anything tier-specific
goes through the Bash CLI path below.)

**Codex tier rule.** Name the tier + effort explicitly on EVERY Codex
dispatch — never rely on the CLI's config default (that is the user's
interactive setting, not the orchestrator's). When unsure between two bands,
pick the lower and escalate one band only if a §3 gate fails: one
re-dispatch after a real failure is cheaper than defaulting everything
upward. If the CLI rejects the model name (older CLI, account gating), retry
once with no model flag and note the degraded routing in the synthesis.
```

- [ ] **Step 3: Verify the edit**

Run: `grep -c "gpt-5.6-" multiclaude/skills/orchestrate/SKILL.md`
Expected: `3` (one per band row; dispatch-mechanics mentions come in Task 2)

Run: `grep -n "Codex default" multiclaude/skills/orchestrate/SKILL.md`
Expected: no output (the flat row is gone)

- [ ] **Step 4: Commit**

```bash
git add multiclaude/skills/orchestrate/SKILL.md
git commit -m "feat(orchestrate): route Codex by GPT-5.6 tier band (luna/terra/sol)"
```

---

### Task 2: Document tier selection in the Codex dispatch mechanics

**Files:**
- Modify: `multiclaude/skills/orchestrate/SKILL.md` (§2 Dispatch mechanics, Codex bullet at ~line 160)

- [ ] **Step 1: Extend the Codex dispatch bullet**

Old text (exact):

```markdown
- **Codex:** use the Agent tool with `subagent_type: "codex:codex-rescue"` and
  `model: "haiku"` (preferred — shared runtime), or `codex exec` via Bash for
  fully scripted runs. Codex runs in the configured bypass mode and edits
  files directly. The Agent tool returns Codex's result inline — no polling.
```

New text:

```markdown
- **Codex:** use the Agent tool with `subagent_type: "codex:codex-rescue"` and
  `model: "haiku"` (preferred — shared runtime), or `codex exec` via Bash for
  fully scripted runs. Codex runs in the configured bypass mode and edits
  files directly. The Agent tool returns Codex's result inline — no polling.
  Select the routed tier (§2 table) on both paths:

  1. **Agent path:** put `--model gpt-5.6-<tier> --effort <effort>` in the
     dispatch prompt. The rescue agent treats `--model <value>` and
     `--effort <value>` as pass-through runtime controls and keeps them out
     of the task text it forwards.
  2. **Bash path:** `codex exec -m gpt-5.6-<tier> -c
     model_reasoning_effort="<effort>" …` — `codex exec` has no `--effort`
     flag; effort only passes via `-c`.
```

- [ ] **Step 2: Verify the edit**

Run: `grep -c "gpt-5.6-" multiclaude/skills/orchestrate/SKILL.md`
Expected: `5` (3 band rows + 2 dispatch-mechanics mentions)

Run: `grep -n "model_reasoning_effort" multiclaude/skills/orchestrate/SKILL.md`
Expected: exactly one hit, inside the new Bash-path item

- [ ] **Step 3: Commit**

```bash
git add multiclaude/skills/orchestrate/SKILL.md
git commit -m "docs(orchestrate): tier + effort selection on both Codex dispatch paths"
```

---

### Task 3: Orient future sessions in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (repo root, "Delegation mechanism" Codex bullet, line 55)

- [ ] **Step 1: Extend the Codex delegation bullet**

Old text (exact):

```markdown
  - Codex: `Agent` tool with `subagent_type: "codex:codex-rescue"` and `model: "haiku"`, or `codex exec` via Bash.
```

New text:

```markdown
  - Codex: `Agent` tool with `subagent_type: "codex:codex-rescue"` and `model: "haiku"`, or `codex exec` via Bash. Every dispatch names an explicit GPT-5.6 tier + effort per orchestrate §2's band table (`--model gpt-5.6-<luna|terra|sol> --effort <effort>` in the rescue prompt; `codex exec -m … -c model_reasoning_effort=…` on Bash) — never the CLI's config default.
```

- [ ] **Step 2: Verify the edit**

Run: `grep -c "gpt-5.6" CLAUDE.md`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note explicit GPT-5.6 tier selection in delegation mechanism"
```

---

### Task 4: Version bump to 2.3.0

**Files:**
- Modify: `multiclaude/.claude-plugin/plugin.json` (line 3)
- Modify: `.claude-plugin/marketplace.json` (both `version` fields: `metadata.version` and `plugins[0].version`)

- [ ] **Step 1: Bump all three version fields**

In `multiclaude/.claude-plugin/plugin.json`:

```json
  "version": "2.3.0",
```

In `.claude-plugin/marketplace.json`, change BOTH occurrences of `"version": "2.2.0"` to:

```json
      "version": "2.3.0",
```

Do NOT touch `name`, `source`, or any other field (repo Do-Not-Touch rule).

- [ ] **Step 2: Verify JSON validity and version consistency**

Run:
```bash
node -e 'const a=require("/home/max/dev/multiclaude/multiclaude/.claude-plugin/plugin.json"),b=require("/home/max/dev/multiclaude/.claude-plugin/marketplace.json");console.log(a.version,b.metadata.version,b.plugins[0].version)'
```
Expected: `2.3.0 2.3.0 2.3.0` (a parse error means broken JSON — fix before committing)

- [ ] **Step 3: Commit**

```bash
git add multiclaude/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "release: multiclaude 2.3.0 — GPT-5.6 tier routing"
```

---

### Task 5: End-to-end verification

**Files:** none modified — verification only.

- [ ] **Step 1: Smoke-test terra and sol tier access**

(luna was already verified: `OK`, 2,142 tokens.)

Run:
```bash
codex exec -m gpt-5.6-terra --skip-git-repo-check "reply with exactly: OK" 2>&1 | tail -3
codex exec -m gpt-5.6-sol   --skip-git-repo-check "reply with exactly: OK" 2>&1 | tail -3
```
Expected: each prints `OK`. If a tier is rejected (account gating), report it — the skill's fallback rule covers runtime, but the user should know.

- [ ] **Step 2: Smoke-test effort override syntax on the Bash path**

Run:
```bash
codex exec -m gpt-5.6-luna -c model_reasoning_effort="medium" --skip-git-repo-check "reply with exactly: OK" 2>&1 | tail -3
```
Expected: `OK` with no config-key warning (a warning about an unrecognized key means the effort override key is wrong — stop and fix the skill text).

- [ ] **Step 3: Run the environment probe**

Run: `node /home/max/dev/multiclaude/multiclaude/scripts/probe.mjs`
Expected: same healthy output as before the change (probe does not reference codex models; this confirms no regression).

- [ ] **Step 4: Confirm the skill still loads (frontmatter untouched)**

Run: `head -4 multiclaude/skills/orchestrate/SKILL.md`
Expected:
```
---
name: orchestrate
description: …(unchanged single line)…
---
```

No commit — nothing changed in this task.
