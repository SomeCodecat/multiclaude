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
| `/multiclaude:setup` | `[companions \| apply [--dry-run \| --companions \| --preferences \| --full \| --no-statusline \| --ccstatusline]]` | Check the environment (read-only), or add what is missing: plugin wiring and the status line. Add-only, with a backup. `companions` opens a pane to install / remove the optional companions. |
| `/multiclaude:probe` | `[--smoke]` | Which delegates are up, and the model id each band maps to today. |
| `/multiclaude:quota` | | Used % and resets per wallet: Codex, Claude (each account), AGY pools; pi (no quota: ∞) with its spend today and over 7 days. |
| `/multiclaude:usage` | `[today \| 7d \| 30d \| all]` | Tokens and ≈ API $ per wallet, account and model. |
| `/multiclaude:failures` | `[N] [--since 7d] \| review` | Failed delegate runs and what to change; `review` asks AGY to propose prompt fixes. |
| `/multiclaude:scorecard` | `[7d \| 30d \| all] [--delegate pi]` | How each delegate × model does: runner outcomes, the orchestrator's grades, bake-offs, and the verdict on a trial delegate (pi). |
| `/multiclaude:shadow` | `[7d \| 30d \| all] \| on \| off \| parallel [N] \| pair <id> \| rate <id> <grade> \| rules \| review [N]` | Shadow runs: with it on, every Codex / AGY job (dispatch tool, Bash runner, forwarder) and every Claude subagent also runs once on pi, for the record only. Shows how pi did per rules version beside the real agents, with every rating; `rate` records yours; `review` asks AGY for verdicts and changes to the pi working rules. |
| `/multiclaude:accounts` | `list \| add \| switch [id] \| auto --once \| config …` | Several Claude logins pooled as one wallet; auto-switch is off by default (it balances the accounts' weekly usage and leaves an account at its 5h or weekly line). |
| `/delegates` | `[settings]` | Pane: live Codex / AGY / pi dispatches and Claude subagents. |
| `/wallets` | | Pane: usage bars per wallet and account, pi (∞) with its spend, token usage and ≈ API spend. |
| `/multiclaude:help` | | This help. |

## Pane hotkeys

- **Delegates:** `1`–`9` open a job · `b` back · `x` cancel · `e` +5 min · `s` settings (open on orchestrate / on dispatch, idle close, jobs listed, live lines, Claude subagents, `7` wallet rows in the status line, `8` shadow every agent with pi, `9` parallel shadows) · `t` scorecard (`p` period) · `c` clear finished · `h` help
- **Wallets:** `r` refresh · `1`–`9` switch Claude account · `p` period · `i` in / out split · `h` help
- **Setup:** `1`–`6` install / remove a companion (superpowers, claude-mem, codex and agy plugins, ccstatusline; under **herdr**: herdr-mascots) · `r` refresh · `h` help
- **Help:** `d` Delegates · `w` Wallets
- Hotkeys work while the pane has focus (`ctrl+x tab` moves focus into a pane).

## Tools the model calls

- `dispatch`: start a Codex / AGY / pi job (non-blocking); the answer wakes the chat (a pi job also at every checkpoint).
- `dispatch_status`: progress, live transcript, the full answer.
- `dispatch_cancel` · `dispatch_extend`: stop a job (also a runner job started from Bash) · add time (offered at 80 % of the timeout once the runner has extended a still-working run twice by itself, or at once for a quiet one; again after each extension).
- `dispatch_grade`: the orchestrator's verdict on a finished job after its gates: pass · rework · fail (required for every pi job; feeds the scorecard).

## Good to know

- **Status line:** `Model: … | Ctx: … | branch | (+ins,-del)`, then the wallets with usage bars stretched to the width — Claude 5h / wk (+ account pool) and Codex on one row, the Antigravity pools below (one row per provider when narrow), pi ∞ with its spend today · 7d at the end of the last row when it fits. Every % is USED: green, yellow from 60, red from 85; 5h windows count down, weekly ones show the weekday and hour they reset. Installed by `/multiclaude:setup apply`; `apply --ccstatusline` puts ccstatusline's configurable session line on top instead. Inside herdr (it draws its own status bar) the wallet rows hide themselves; `MULTICLAUDE_WALLET_ROWS=on` shows them, `=off` hides them anywhere.
- **herdr:** inside herdr (its own panels show the jobs and wallets) multiclaude steps aside: no pane opens by itself — `/delegates` and `/wallets` still open one — and the status line has no wallet rows. `MULTICLAUDE_HERDR=0` turns this off, `=1` forces it. The optional **herdr-mascots** companion (`/multiclaude:setup companions`, herdr section) publishes what the chat, each subagent and each Codex / AGY / pi job is doing as the herdr-core document `mc-activity-<terminal>`; a herdr-app mod draws an animated mascot per agent (contract: `docs/herdr-mascots.md` in the repo). Inside herdr every chat also publishes its **inbox** card `mc-inbox-<terminal>` — the last prompt, what the last turn answered, and what it waits on from you (a question, a permission, a plan) — for herdr's Inbox window; on by default (it draws nothing itself), `MULTICLAUDE_INBOX=0` turns it off (contract: `docs/herdr-inbox.md`). **WSL under a Windows herdr:** Claude Code there only knows it is inside herdr when `WSLENV` forwards `HC_TERMINAL_SOCKET/u:HC_TERMINAL_ID/u:HC_SCOPE/u`. `/multiclaude:setup` flags it, and `setup apply` on Windows adds them to the user `WSLENV` (restart herdr). In WSL, herdr-mascots and the inbox reach herdr through `hc.exe` (WSL interop).
- **Bands:** codex `mech` · `std` · `hard` · `max`; agy `opus` · `sonnet` · `gem-top` · `gem-alt` · `gem-hi` · `gem-med` · `gem-lo`; pi `lo` · `med` · `hi`. `/multiclaude:probe` shows today's ids.
- **pi (trial):** an optional third delegate: the pi harness on a self-hosted model, listed by the probe only when `pi` is installed. Small coding tasks only. The runner stops a looping run (the same call 3× with the same result, the same reply twice, 4 tool errors in a row, the step or token cap → `LOOP`), a checkpoint every 8 tool steps wakes the chat to judge it, and every result is gated and graded (`dispatch_grade`). `/multiclaude:scorecard` gives the verdict after 5 graded runs: `VIABLE` · `MARGINAL` · `NOT VIABLE`.
- **Shadows:** off by default (setting `8` or `/multiclaude:shadow on`). A shadow is a pi run of a task another agent is doing for real: 1–8 at once per chat (default 1; `/multiclaude:shadow parallel N`), max(12, 6 × parallel) waiting, no shell, edits only in a throwaway worktree, never a wake, never a grade, not on the scorecard. Both ends are recorded on this machine only (`~/.local/share/multiclaude/shadow/records.jsonl`, secrets scrubbed): prompt, answer, patch, and for pi every step with its timing and the version of the working rules it got. Your own rules go in `~/.config/multiclaude/pi-rules.md` (one `- rule` per line; every pi run gets them). Each shadow is a paid pi run.
- **Ratings:** every judgement of a pi run is kept beside those records (`ratings.jsonl`): each `dispatch_grade`, each verdict of a `/multiclaude:shadow review`, each `/multiclaude:shadow rate <id> <pass|rework|fail>`. pi runs of their own are recorded like shadows, so a rating keeps the run it judged. Only `dispatch_grade` counts on the scorecard.
- **Cost:** every finished job has a dollar figure on its proof line and in the Delegates pane: `cost=$…` is what the provider billed (pi reports it), `cost≈$…` the run's tokens at API list price — a comparison figure, never a bill. A Claude subagent row gets `≈$…` from its transcript the same way, and the pane sums the rows it lists. No price known for the model: no figure. `MULTICLAUDE_PRICES=off` keeps the price table off the network.
- **Files:** `~/.cache/multiclaude` (jobs kept 14 days, `failures.jsonl`, `runs.jsonl` + `grades.jsonl` for the scorecard, `tracker.json`); `~/.local/share/multiclaude` (accounts, the status-line launcher, `shadow/records.jsonl` + `ratings.jsonl`); `~/.config/multiclaude` (`prices.json` overrides, `pi-rules.md`).
