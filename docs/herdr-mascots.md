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
      "kind": "main",           // main | subagent | codex | agy | pi
      "parent": null,           // id of the actor that started it (subagents, jobs) or null
      "label": "multiclaude",   // short human label (≤ 60 chars)
      "model": "claude-opus-5-5",
      "state": "reading",       // one of the mascot states below
      "detail": "Read hooks/register.tsx",   // what it is doing, ≤ 100 chars, may be ""
      "since": 1794174580000,   // ms epoch the state began
      "ended": null             // ms epoch the actor finished (state then done | error), else null
      // "shadowOf": "<actor id>"  — only on a pi shadow (below): the actor whose task it repeats
    }
  ],
  "context": { "usedPct": 42 }  // optional: the main chat's context use
}
```

Ended actors stay in `actors` for 60 s, then the publisher drops them.

`kind` names who runs the actor. `codex`, `agy` and `pi` are delegate jobs of the runner
(`pi` only where the pi CLI is installed). The list can grow: a mod draws a kind it does not
know as a generic delegate, never as an error.

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
| `error` | a tool failed, or a job ended QUOTA / DENIED / PATCH_FAILED / TIMEOUT / LOOP / failed |
| `done` | the actor finished (`ended` set) or the main turn ended |
| `idle` | the main chat waits for the user |

Time-based states are the **mod's** job (the publisher only writes on events):
- `done` → play once (~5 s), then `idle` for `main`, then hide for every other actor.
- `idle` for more than 10 min → `asleep`.

## WSL under a Windows herdr

A herdr pane that starts `wsl.exe … claude` passes on only the variables `WSLENV` names. With
`HC_TERMINAL_SOCKET/u:HC_TERMINAL_ID/u:HC_SCOPE/u` in it, Claude Code in WSL knows it is inside herdr
(no wallet rows, no pane opening by itself) and publishes `mc-activity-<terminal>` like any other
session — through `hc.exe` (WSL interop), since the socket is a Windows named pipe
(`\\.\pipe\herdr-core-…`) that a Linux `hc` cannot reach. The document lands in the Windows
herdr-core under the pane's own terminal id. `/multiclaude:setup` (Windows, inside herdr) flags a
missing entry and `setup apply` adds them to the user `WSLENV`; restart herdr afterwards.

## Which chat a job belongs to

A runner job belongs to the chat that dispatched it, **whatever directory it runs in**. Every job
file carries:

| Field | Meaning |
|---|---|
| `session` | the dispatching chat's session id — the key to group by |
| `project` | that chat's project directory (`CLAUDE_PROJECT_DIR`) — the fallback key when `session` is missing |
| `cwd` | where the delegate ran; may be outside the project (a scratchpad, another checkout) |

Group by `session` (then `project`), never by `cwd`: a job whose `cwd` is outside the project is
not "elsewhere". When `cwd` differs from `project`, show it as a secondary detail, e.g.
`cwd: …/scratchpad/demo/src` (the module's own pane does this: `./rel` under the project, else the
last three directories). The activity document's job actors carry `cwd` the same way — set only when
it is not the chat's project.

## Shadows (a pi run beside another agent)

With Delegates setting 8 on (`/multiclaude:shadow on`, off by default), every Codex / AGY
dispatch and every Claude subagent also runs once on pi. That run — the **shadow** — is for the
record only: its result is never used, it never wakes the chat and it is not graded. A mod should
draw it as part of the agent it runs beside, not as a job of its own.

| Where | Field | Meaning |
|---|---|---|
| activity document, the shadow's actor | `kind: "pi"`, `shadowOf: "<actor id>"` | the `id` of the actor it shadows: a job id, or a Claude subagent's `agentId`. `parent` is `"main"`. Its label starts `shadow · `. |
| job file `<cache>/multiclaude/jobs/<id>.json`, the shadow | `delegate: "pi"`, `shadowOf: "<id>"`, `label: "shadow · …"` | same id as above |
| job file, the real job (Codex / AGY) | `reference: true` | this run is the reference side of a pair; a Claude subagent has no job file |
| `runs.jsonl` line, the shadow | `shadowOf: "<id>"` | the scorecard leaves such a run out unless it was graded by hand |
| proof line, the shadow | `shadow-of=<id>` | `[dispatch pi model=… status=… shadow-of=<id>]` |

Drawing rules:

- **Group, do not list.** A shadow whose `shadowOf` actor / job is shown goes under it as one small
  line or badge (model, step or result); it gets no row and no mascot of its own. Shown alone only
  when the agent it shadows is not listed (already dropped, another session).
- **Do not count it** as a running job, and leave its outcome out of any ok / failed tally: a shadow
  that ends `LOOP`, `TIMEOUT` or `FAILED` is data for the prompt tuning, not an error to act on.
- **One exception — `status=OUTSIDE`.** The shadow called a write tool on a file outside its
  throwaway worktree and was stopped; the proof line carries `outside="<path>"`. Show that one as a
  real error, with the path: a file in the person's checkout may have been changed.
- Each chat runs 1–8 shadows at once (default 1, `/multiclaude:shadow parallel N`); more wait as
  `status: "queued"` (up to max(12, 6 × parallel)). Across all chats, pi runs also wait for a
  machine-wide slot (default 2 at once); such a run's step reads `⏳ waiting for a pi slot …`.

## Background work (no one in the chat asked for it)

Some runner jobs are housekeeping that the plugin starts by itself. Today there are two: the
**automatic shadow review** and the **shadow judge** (below the table). The first is the
automatic review. While shadows are on, an open chat's module checks every 10 minutes.
When 6 shadow pairs with a reference wait unrated (at most hourly), it starts **one AGY job**. That job
rates the shadows and writes the ratings to the shadow records. It never wakes the chat and its
answer is not shown there.

| Where | Field | Meaning |
|---|---|---|
| job file `<cache>/multiclaude/jobs/<id>.json` | `background: "shadow-review"` | started by `shadow.mjs auto`; `delegate: "agy"`, `label: "shadow auto-review"`, no `shadowOf`, no `reference` |
| job file | `background: "shadow-judge"` | started by a shadow's runner at 80% of its time limit (`shadow.mjs judge --stdin`); `delegate: "agy"`, `label: "shadow judge"`, at most 150 s |

The **shadow judge** decides whether a shadow gets more time. Its verdict shows on the shadow's own
job as a progress line starting `⚖`:
- `⚖ judge (<model>): extend +600s — now 1800s — …`: the shadow's job file `timeout` grows.
- `⚖ judge (<model>): stop (<cause>) — …`: the shadow ends `CANCELLED`, and its proof line carries
  `stopped-by=judge cause=<cause>`.

A judge stop is the system working, not an error: draw it like any other ended shadow. The shadow's
job file gets `judge` (the verdicts so far) once the judge has answered. In the bubblewrap tier it
also gets `masked: true` (its worktree is mounted at the real checkout path) and `base` (`snapshot`
or `head`: what it started from).

`session` / `project` on that job file are those of whichever chat's tick happened to start it.
That chat did not ask for it.

Drawing rules:

- **Do not draw it as that chat's own job.** Show it apart from the chat's jobs: as a small
  "background" line or badge, or under the shadows of that session. It gets no mascot of its own and
  is not counted as a running job of the chat.
- **Its cost is real.** It spends the AGY wallet, so a wallet / spend view should still count it.
- **A failure is not the chat's error.** `QUOTA` / `CAPACITY` / `FAILED` on it only means no ratings
  this round; the next round retries. Show it quietly, if at all.
- **A failed AGY review or judge may be followed by a Claude call that has no job file.** When the AGY job ends
  without an answer (`QUOTA`, `CAPACITY`, `AUTH` …), `shadow.mjs auto` (or `judge`) sends the same prompt once to
  a headless `claude -p` (Haiku, Sonnet when busy) with no settings, so no plugin or hook runs in
  it and it never publishes a herdr document. It has no job file and no actor. Its spend shows only
  in the Claude wallet and the usage tracker (a transcript under the shadow dir's project folder).
  Nothing for the mod to draw.
- **Match on the field, not on the value.** Any `background` value means background work. More
  kinds may follow; show the value as the caption.

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
