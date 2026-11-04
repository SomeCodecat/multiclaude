# References

Projects multiclaude used to depend on or borrows from. None of them is a
requirement. They are listed for pointers when a feature is worth copying.

## ccstatusline

- Repo: https://github.com/sirmalloc/ccstatusline (MIT). Run `bunx ccstatusline` for its config TUI.
- **What it was used for:** until v2.10 the optional preferences template set
  `statusLine` to `bunx -y ccstatusline@latest`. The README also listed it as a
  requirement. multiclaude now has its own status features, so neither is true
  any more:
  - the wallet line (`scripts/usage-snapshot.mjs --statusline`), which
    `/multiclaude:setup apply` now installs as the status line itself;
  - the module's `$.ui.status`;
  - the Delegates and Wallets panes.
- **What we already took from it:** the 256-colour palette of the wallet line,
  with cyan labels, grey separators and green / yellow / red percentages.
- **The last layout used here** (`~/.config/ccstatusline/settings.json`, v4):
  - Line 1: model (cyan) | context length (bright black) | git branch (magenta) | git changes (yellow).
  - Line 2: a `custom-command` widget running `usage-snapshot.mjs --statusline`
    (`preserveColors: true`, 2 s timeout).
  - Settings: `flexMode: full`, `compactThreshold: 60`, `colorLevel: 2`, powerline off.

### Features worth copying

| ccstatusline feature | What it does | Where it would go here |
|---|---|---|
| model / version widgets | Current model id and Claude Code version, read from the statusLine stdin JSON | Read stdin in our status-line command |
| context length / context % (usable) | Tokens in the current context, and the share of the usable window | The transcript path from stdin. `scripts/lib/tracker.mjs` already parses usage rows |
| tokens in / out / cached / total, session cost | Per-session token counts and ≈ cost | Reuse `lib/tracker.mjs` and `lib/prices.mjs` per transcript |
| block timer | Time into or left in the current 5 h block | We already have the reset times (usage-snapshot `fiveHourReset`) |
| git branch / git changes | Branch and +/- counts, cached by TTL (`gitCacheTtlSeconds`) | A cheap `git` call with a short cache |
| custom-command widget | Any command's output as a segment, with an optional colour pass-through | Our wallet line already runs as one. A built-in line would make the hop unnecessary |
| flex separator / `flexMode` / `compactThreshold` | Fill or trim to the terminal width; a compact form below N columns | Width-aware rendering of the wallet line |
| multiple lines | Each line is its own widget list | Status line and wallets on separate lines |
| powerline mode | Powerline separators, caps and theme continuation across lines | Cosmetic, optional |
| interactive TUI config | Edit the widgets and colours in a terminal UI, saved to `~/.config/ccstatusline/settings.json` | Could become a settings view in a pane, as Delegates does |
