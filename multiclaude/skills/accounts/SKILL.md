---
name: accounts
description: Use when the user wants to add, list, switch, or auto-switch between several Claude Code accounts (logins), see each account's 5-hour / weekly usage, or run Claude Code as a specific account in one terminal. The stored accounts are one Claude wallet.
---

# Accounts

Several Claude Code logins (subscriptions) pooled into **one Claude wallet**.
The plugin stores each login's OAuth credential, shows every account's official
5-hour / 7-day usage, switches the default login between them, and (opt-in) auto-switches
before the active account hits its limit. It is a pure-Node port of the core of
[claude-swap](https://github.com/realiti4/claude-swap) (MIT, see
`THIRD_PARTY_NOTICES.md`).

When the user types `/multiclaude:accounts [args]`, the plugin's hooks module runs
the script and prints its output directly, with no model turn. Otherwise run it
and show the output **verbatim**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/accounts.mjs" [command] [args]
```

| Command | Does |
|---|---|
| `list` (default) `[--refresh]` | Every account's 5h / 7d / per-model usage, reset times, the pool line, auto-switch settings |
| `add [--slot N] [--alias A]` | Stores the account Claude Code is logged in with **now** (re-run it to refresh an existing slot) |
| `switch [id]` | Makes `id` (number, email or alias) the default login. With no id, rotates to the next usable account |
| `remove id` · `alias id name` · `disable id` · `enable id` | Manage accounts. Disabled accounts are skipped by auto-switch and rotation |
| `threshold [id pct \| id --unset]` | Per-account switch-away line (50–100) instead of the global one |
| `auto --once [--dry-run]` | One auto-switch decision. The module already runs this every 60 s |
| `config [set key value]` | Settings: `auto.enabled`, `auto.threshold` (90), `auto.weeklyThreshold`, `auto.strategy` (`balance` \| `best` \| `consume-first`), `auto.balanceGap` (10), `auto.cooldownSec`, `auto.margin`, `auto.model`, `run.shareHistory` |
| `run id [--share-history] [-- claude args]` | **Terminal only:** starts `claude` as `id` in that terminal (its own `CLAUDE_CONFIG_DIR` profile sharing your settings, CLAUDE.md, skills, agents, plugins and MCP servers). Every other terminal keeps the default login |

## Adding accounts

1. In Claude Code, log in with the first account and run `accounts add`.
2. `/login` with the next account (**do not `/logout` first**: logging out can
   revoke the token you just stored) and run `accounts add` again.
3. Repeat for each account. `accounts list` shows them all.

## How it behaves

- **One owner per token.** The live login owns the active account's token, a
  running `run` session owns its account's token, and the store owns all the
  others. A switch saves the active account's current (possibly rotated) token
  before activating the target. A session's token is saved back when it exits.
  Expired tokens are refreshed only for accounts the store owns.
- **Claude Code's own locks.** A switch holds Claude Code's credential-refresh
  and config locks, so it never collides with one of its token refreshes. Running
  Claude Code picks up the new login on its next credential read (on Linux and
  Windows; restart to apply at once). The macOS Keychain is not supported.
- **Where the login lives.** `~/.claude/.credentials.json`, or on Windows the
  Credential Manager entry `Claude Code-credentials/claude-code-user` when
  Claude Code uses it (its `tengu_windows_credman` flag or
  `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1`). Reads and writes go through
  PowerShell there. `accounts status` names the store in use.
- **Host-provided logins can't be managed.** The Claude desktop app (and SDK
  hosts) pass the login in the environment (`CLAUDE_CODE_OAUTH_TOKEN*`,
  host-auth variables) and Claude Code stores none. It also strips those
  variables from plugin scripts, so the sign is `CLAUDE_CODE_ENTRYPOINT=claude-desktop`
  with no stored login. `status` prints a note, and `add` refuses. The app's
  own sign-in is a claude.ai web session in its encrypted browser profile, not
  a token either, so the pool cannot be built from the app. Tell the user to
  change the account in the app with its own sign-out / sign-in, and to run
  `claude` in a terminal or the VS Code extension to pool accounts.
- **Auto-switch is OFF by default.** A switch moves the default login of every
  running Claude Code session, so the user turns it on deliberately:
  `accounts config set auto.enabled true`. `add` prints this hint once two
  accounts are stored.
- **Auto-switch** (`balance`, the default strategy): it spreads the work over
  the accounts' weeks. Each account has a **weekly pace**: its weekly used %
  minus the share of its 7 days that has gone by (24 % used with 97 % of the
  week gone = 73 points behind; `list` prints it on the 7d line). The login
  moves to the account furthest behind its pace once that account is
  `auto.balanceGap` points (10) behind the active one and has room in its 5h
  window. So quota that expires soon is used first, and no account is used up
  days before its reset while the other sits unused — which would leave the
  remaining account with nowhere to go when its 5h window fills.
  At a line (5h or weekly, default 90 %) it moves to an account under its own
  lines, the one furthest behind its week, and only one that is better by
  `auto.margin` points. When every account is over its line, it moves only for
  a clear gain. `best` is the older behaviour: hold until the active account
  reaches its line, then go where the most room is. `consume-first` stays on
  the account whose weekly window resets soonest. There is a 5-minute cooldown
  between switches.
- **Storage:** `~/.local/share/multiclaude/accounts` (`%APPDATA%` on Windows),
  files mode 0600. Override with `MULTICLAUDE_ACCOUNTS_DIR`.

Exit codes: 0 ok (for `auto`: switched) · 1 error · 2 `auto`: nothing to do ·
3 `auto`: blocked (every account is at its line).
