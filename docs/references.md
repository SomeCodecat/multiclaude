# References

Projects multiclaude used to depend on or borrows from. None of them is a
requirement. They are listed for pointers when a feature is worth copying.

## ccstatusline

- Repo: https://github.com/sirmalloc/ccstatusline (MIT). Run `bunx ccstatusline` for its config TUI.
- **What it was used for:** until v2.10 the optional preferences template set
  `statusLine` to `bunx -y ccstatusline@latest`. The README also listed it as a
  requirement. multiclaude now has its own status features, so neither is true
  any more:
  - the wallet rows (`scripts/usage-snapshot.mjs --statusline`), which
    `/multiclaude:setup apply` installs as the status line itself, under a
    session line of ours in ccstatusline's design;
  - the module's `$.ui.status`;
  - the Delegates and Wallets panes.
- **Still an optional extra (v2.12):** `setup apply --ccstatusline` puts
  ccstatusline on top — its session line stays configurable through its TUI —
  and adds our wallet rows as `custom-command` widgets, one per line, from the
  config shipped in `multiclaude/setup/ccstatusline.json`.
- **What we already took from it:** the 256-colour palette of the wallet rows,
  with cyan labels, grey separators and green / yellow / red percentages; and
  the session line in its design — `Model: … | Ctx: … | branch | (+ins,-del)`
  in its default widget colours, no branch icon — drawn by
  `usage-snapshot.mjs --statusline --session` from the statusLine stdin JSON.
- **How its custom-command widget behaves** (2.2.x, read from its bundle):
  the command gets the statusLine JSON on stdin plus `terminal_width`; the
  output is trimmed and truncated to the line width (about `terminal_width - 6`
  with `flexMode: full`), so a multi-line output loses everything past the
  first width; an empty output drops the whole line. Hence one widget per row
  (`--row N`) and a row 3 that prints only on narrow terminals.
- **The shipped layout** (`setup/ccstatusline.json`, v4):
  - Line 1: model (cyan) | context length (bright black) | git branch (magenta, no icon) | git changes (yellow).
  - Lines 2–4: `custom-command` widgets `node "<launcher>" --row 1|2|3`
    (`preserveColors: true`, 2 s timeout, `customCommandCacheTtlSeconds: 0`).
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
