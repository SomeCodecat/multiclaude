---
name: failures
description: Use when delegated runs keep failing (denied, quota, patch failed, budget, timeout) to see the runner's failure log, why each class happens and what to change in the dispatch prompt; `review` has AGY propose prompt-rule fixes.
---

# Failures

`dispatch.mjs` appends one JSON line per run that did not succeed to
`~/.cache/multiclaude/failures.jsonl` (`$XDG_CACHE_HOME`): status, delegate,
model, effort, edit flag, denied actions, error text, the head of the task
prompt and the tail of the answer.

Typed as `/multiclaude:failures`, the plugin's hooks module runs the script and
prints its output directly, with no model turn; `/multiclaude:failures review`
queues one AGY job that reads the log against orchestrate §2 and proposes prompt
fixes. Otherwise run it and show the output to the user **verbatim**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/failures.mjs"                  # last 7 days: counts, why + fix per status, recent runs
node "${CLAUDE_PLUGIN_ROOT}/scripts/failures.mjs" 20 --since all   # more rows, whole log
node "${CLAUDE_PLUGIN_ROOT}/scripts/failures.mjs" --review-prompt  # the AGY review prompt (dispatch it with the dispatch tool)
```
