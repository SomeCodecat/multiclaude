---
name: help
description: Use when the user asks what multiclaude can do — its commands, panes, pane hotkeys, the tools the model calls, the status line, or where its files live.
---

# multiclaude help

Where the plugin's hooks module is loaded, `/multiclaude:help` opens a help
pane (or prints this as text) with no model turn. This body is the fallback:
show the person the reference below, as is.

## Commands

| Command | Arguments | What it does |
|---|---|---|
| `/multiclaude:orchestrate` | `[task]` | Route work to Codex / AGY first. Bare: arms the rules for this chat and prints the probe. |
| `/multiclaude:setup` | `[apply [--dry-run \| --companions \| --preferences \| --full \| --no-statusline]]` | Check the environment (read-only), or add what is missing: plugin wiring and the status line. Add-only, with a backup. |
| `/multiclaude:probe` | `[--smoke]` | Which delegates are up, and the model id each band maps to today. |
| `/multiclaude:quota` | | Used % and resets per wallet: Codex, Claude (each account), AGY pools. |
| `/multiclaude:usage` | `[today \| 7d \| 30d \| all]` | Tokens and ≈ API $ per wallet, account and model. |
| `/multiclaude:failures` | `[N] [--since 7d] \| review` | Failed delegate runs and what to change; `review` asks AGY to propose prompt fixes. |
| `/multiclaude:accounts` | `list \| add \| switch [id] \| auto --once \| config …` | Several Claude logins pooled as one wallet; auto-switch is off by default. |
| `/delegates` | `[settings]` | Pane: live Codex / AGY dispatches and Claude subagents. |
| `/wallets` | | Pane: usage bars per wallet and account, token usage and spend. |
| `/multiclaude:help` | | This help. |

## Pane hotkeys

- **Delegates:** `1`–`9` open a job · `b` back · `x` cancel · `e` +5 min · `s` settings · `c` clear finished · `h` help
- **Wallets:** `r` refresh · `1`–`9` switch Claude account · `p` period · `i` in / out split · `h` help
- **Help:** `d` Delegates · `w` Wallets
- Hotkeys work while the pane has focus (`ctrl+x tab` moves focus into a pane).

## Tools the model calls

- `dispatch`: start a Codex / AGY job (non-blocking); the answer wakes the chat.
- `dispatch_status`: progress, live transcript, the full answer.
- `dispatch_cancel` · `dispatch_extend`: stop a job · add time (offered at 80 % of the timeout).

## Good to know

- **Status line:** Claude 5h / wk (+ account pool), Codex, AGY pools. Every % is USED: green, yellow from 60, red from 85. Installed by `/multiclaude:setup apply`.
- **Bands:** codex `mech` · `std` · `hard` · `max`; agy `opus` · `sonnet` · `gem-top` · `gem-hi` · `gem-med` · `gem-lo`. `/multiclaude:probe` shows today's ids.
- **Files:** `~/.cache/multiclaude` (jobs kept 14 days, `failures.jsonl`, `tracker.json`); `~/.local/share/multiclaude` (accounts, the status-line launcher).
