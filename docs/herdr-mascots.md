# herdr mascots — the contract between multiclaude and the herdr-app mod

An optional multiclaude companion (`herdr-mascots`, under the **herdr** section of
`/multiclaude:setup companions`). Two halves:

| Half | Runs on | Does |
|---|---|---|
| **Publisher** | the machine Claude Code runs on (inside herdr-core) | multiclaude's hooks module turns every tool call of the main chat, each Claude subagent and each Codex / AGY job into a mascot state and keeps one herdr-core document per terminal up to date. |
| **Mod** | the machine herdr-app runs on (Windows) | subscribes to herdr-core events, reads those documents, and shows one animated mascot per actor in herdr's UI. |

The two halves only share the document below. The publisher never draws, the mod never
guesses activity from screen text.

## The document

- **Name:** `mc-activity-<terminal>`; `<terminal>` is the publishing Claude Code's
  `HC_TERMINAL_ID` (`t1`, `t1b` …). One document per terminal: no write contention between
  sessions.
- **Where:** the herdr-core of the machine Claude runs on. From herdr-app's machine read it with
  `doc.get { name, on: "<machine>" }`; changes arrive as `doc` events from
  `events.subscribe` (snapshot first, then every change).
- **Written** with `doc.set` (version-checked; on a mismatch the publisher re-reads and retries).
  Only on a change, at most ~2 writes / s per terminal. `null` = the session ended (the mod
  removes that terminal's mascots).

```jsonc
{
  "v": 1,                       // contract version; the mod ignores a document with v > what it knows
  "terminal": "t1",             // HC_TERMINAL_ID of the Claude Code session (same as the doc name suffix)
  "at": 1794174581606,          // ms epoch of this write
  "actors": [
    {
      "id": "main",             // "main" for the chat itself; agentId / job id otherwise
      "kind": "main",           // main | subagent | codex | agy
      "parent": null,           // id of the actor that started it (subagents, jobs) or null
      "label": "multiclaude",   // short human label (≤ 60 chars)
      "model": "claude-opus-5-5",
      "state": "reading",       // one of the mascot states below
      "detail": "Read hooks/register.tsx",   // what it is doing, ≤ 100 chars, may be ""
      "since": 1794174580000,   // ms epoch the state began
      "ended": null             // ms epoch the actor finished (state then done | error), else null
    }
  ],
  "context": { "usedPct": 42 }  // optional: the main chat's context use
}
```

Ended actors stay in `actors` for 60 s, then the publisher drops them.

## States

The `state` value is a mascot-studio state id, so the mod maps it straight to `<state>.svg`
(or `<state>-fluid.svg` for the extended look). An unknown value renders as `using-tool`.

| state | publisher sets it when |
|---|---|
| `greeting` | a session starts |
| `thinking` | working, no tool running (a prompt was sent; between tool calls) |
| `reading` | Read / NotebookRead; delegate file views (`cat`, `sed -n`, `head`, AGY view_file) |
| `writing` | Edit / Write / NotebookEdit; Codex file_change / patch; AGY write / replace tools |
| `searching-code` | Grep / Glob / LSP; `rg` / `grep` / `find` in a delegate |
| `searching-web` | WebSearch / WebFetch; Codex web_search; AGY web tools |
| `running-commands` | Bash and delegate commands not matched below |
| `testing` | a test runner command (`npm test`, `pytest`, `cargo test`, `go test`, `vitest` …) |
| `committing` | `git commit` / `git push` / `gh pr create` |
| `server-running` | a background command that serves (`dev`, `serve`, `vite`, `expo`, `next start`) |
| `directing-helpers` | Agent / Workflow / `dispatch` — the actor is waiting on helpers it started |
| `plan-progress` | TodoWrite / work_state_write |
| `waiting-for-you` | AskUserQuestion, a permission prompt, `blocked` |
| `compacting` | the chat compacts |
| `context-nearly-full` | context ≥ 80 %, or a delegate hit its token budget |
| `error` | a tool failed, or a job ended QUOTA / DENIED / PATCH_FAILED / TIMEOUT / failed |
| `done` | the actor finished (`ended` set) or the main turn ended |
| `idle` | the main chat waits for the user |

Time-based states are the **mod's** job (the publisher only writes on events):
- `done` → play once (~5 s), then `idle` for `main`, then hide for every other actor.
- `idle` for more than 10 min → `asleep`.

## The mod's job (herdr-app side)

1. Subscribe to herdr-core events on every machine herdr-app knows; on a snapshot and on each
   `doc` event whose name starts with `mc-activity-`, `doc.get` it (with `on`).
   **Use two connections:** once a connection has called `events.subscribe` it only streams
   events and answers no further requests (verified with `hc connect`), so `doc.get` goes over a
   second connection (or herdr-app's own API client). A `doc` event carries only
   `{ name, version }`, never the value.
   **Drop stale documents:** show a document only while its terminal is live and still runs
   Claude Code (the terminal's `status.app` is `claude-code`, or its `foreground.name` is
   `claude`). The publisher clears its document (`null`) at session end, but a hard exit
   (`claude -p`, a killed process) can leave the last write behind.
2. Attach each document to its terminal (`<machine>/<terminal>`) — show the mascots on / next to
   that terminal's pane or tab: the `main` actor large, subagents and jobs as small mascots under
   it (label + model + detail as tooltip / caption, `kind` as a small badge).
3. Render the SVGs in a web view (their animation is CSS; a rasterizing image view drops it).
   Respect `prefers-reduced-motion` (the SVGs already do).
4. Assets: download mascot-studio's latest release `mascot-assets.zip`
   (github.com/Harriszed/mascot-studio/releases) into the mod's own data folder on first run.
   Do **not** commit or redistribute them — their NOTICE says redistribution permission is
   unverified; the Claude character belongs to Anthropic.
5. Off switch: the mod shows nothing when no `mc-activity-*` document exists.
