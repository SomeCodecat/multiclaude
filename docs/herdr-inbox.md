# herdr inbox — the contract between multiclaude and the herdr-app mod

One card per Claude Code chat in herdr: what the chat did last, what it needs from the person
(a question, a permission, a plan) and what started it. Two halves, like the mascots
([herdr-mascots.md](herdr-mascots.md)):

| Half | Runs on | Does |
|---|---|---|
| **Publisher** | the machine Claude Code runs on (inside herdr-core) | multiclaude's hooks module follows the **main chat** — its prompts, turns and open asks — and keeps one herdr-core document per terminal up to date. |
| **Mod** | the machine herdr-app runs on (Windows) | reads those documents and draws the Inbox window (cards, suggested replies, a digest). |

They share only the document below. The publisher draws nothing, so it is **on by default**
inside herdr, independent of the herdr-mascots flag.

## Switching it off

- `MULTICLAUDE_INBOX=0` (also `off`, `false`, `no`) in the environment Claude Code starts with.
  Read once at session start.
- Outside herdr (no `HC_TERMINAL_ID`, or `HC_TERMINAL_SOCKET` not a herdr socket) nothing is
  published. `MULTICLAUDE_HERDR=1|0` forces the herdr check, like everywhere else.
- `node scripts/herdr-activity.mjs status` prints `inbox on|off`; `--inbox-enabled` is what
  the module asks.

## The document

- **Name:** `mc-inbox-<terminal>`; `<terminal>` is the chat's `HC_TERMINAL_ID`. One document
  per terminal.
- **Where:** the herdr-core of the machine Claude runs on (`doc.get { name, on: "<machine>" }`
  from elsewhere; `doc` events from `events.subscribe`).
- **Written** by `herdr-activity.mjs set --doc inbox` with `doc.set`, version-checked (re-read
  and retried on a conflict), the same mechanics as `mc-activity-*`. Only on a change, at most
  one write a second (a change inside that second is written by the next 1 s tick).
- **Scrubbed:** every string in the document, at any depth, goes through the credential
  scrubber of the shadow records (`scrub()` in `scripts/lib/shadow.mjs`: API keys, tokens,
  bearer headers, passwords in URLs …) before it is written. Plain text and code stay.
- **`null`** = the session ended (exit, logout, a `-p` run done): the mod drops the card.
- **Main chat only.** Subagent turns, their tool calls and permission asks, and Codex / AGY /
  pi jobs never touch it.

```jsonc
{
  "v": 1,
  "terminal": "t1d",               // HC_TERMINAL_ID (the script fills it in)
  "at": 1794174581606,             // ms epoch of this write
  "session": "<session id>",       // "" if the engine did not say
  "cwd": "/home/x/dev/project",    // the session's start directory
  "model": "claude-opus-5-5",      // from the session, then each turn's usage
  "turn": {
    "n": 12,                       // main-chat turns ended since the hooks module loaded (0 at start)
    "state": "working",            // working | ended | waiting   (waiting = `ask` is open)
    "startedAt": 1794174500000,    // null until the first turn
    "endedAt": null,               // set when the turn ends; null while it works
    "reason": null                 // answer | aborted | error | refusal, when it ends
  },
  "prompt": "what started the current / last turn, first 500 characters",
  "promptFrom": "person",          // person | peer | unknown
  "outcome": "the last ENDED turn's answer, ≤ 1200 characters, cut at a paragraph or sentence end, ' …' when cut",
  "final": "the same answer, first 4000 characters",
  "ask": null
}
```

`ask` while one is open (and `turn.state` is `waiting`), otherwise `null`:

```jsonc
{ "kind": "question", "since": 1794…, "questions": [ … ] }            // AskUserQuestion's `questions`, as given
{ "kind": "permission", "since": 1794…, "tool": "Bash", "detail": "systemctl restart nginx" }
{ "kind": "plan", "since": 1794…, "plan": "the plan, ≤ 2000 characters" }
```

- `questions`: `[{ question, header, options: [{ label, description }], multiSelect }]`.
- `detail` (≤ 300 characters, one line): the call's `command`, else `file_path`,
  `notebook_path`, `path`, `url`, `pattern`, `query`, `description`, else its input as JSON.
- `plan`: from ExitPlanMode's input when the engine passes one; this Claude Code build does not,
  so the publisher reads the plan file named by the chat's plan-mode reminder. `""` when neither
  is there (a plan kept in no file): the card still shows that a plan waits for approval.

## Lifecycle

| Event (main chat) | Document |
|---|---|
| session start (inside herdr) | first write: `turn.n` 0, `state` `ended`, empty `prompt` / `outcome` / `final`, `ask` null |
| a turn starts | `state` working, `startedAt`, `endedAt` null, `reason` null, `ask` null; `prompt` / `promptFrom` from its text. A continued turn (no text) keeps the prompt that started the work. `outcome` / `final` of the last turn stay. |
| permission ask (a real call put to the person) | `ask` permission, `state` waiting |
| AskUserQuestion / ExitPlanMode called | `ask` question / plan, `state` waiting |
| the call returns, or the next call starts | `ask` null, `state` working |
| the turn ends | `outcome`, `final` (the answer, else the last assistant text of `$.session.messages()`), `reason`, `endedAt`, `turn.n` + 1, `state` ended, `ask` null |
| `/clear`, or a resume in the same terminal | the card starts over (new `session`, `turn.n` 0, empty texts); the document stays |
| the session ends | `null` |

`promptFrom`: `peer` when the text opens with a peer note (`<hc … from=…>`,
`<cross-session-message … from=…>`, `<teammate-message … from=…>`); `unknown` when the
prompt was one the person did not type (a plugin wake, an engine notice: the prompt carried
`isMeta`); else `person`.

## Where it differs from the first spec

- `reason` can also be `refusal` (the engine ends a turn with one of four reasons).
- A permission ask is cleared when the call returns, or when the next call starts. The engine has
  no "permission answered" event, so a refused call clears it the same way.
- `plan` comes from the plan file when ExitPlanMode's input has none (as in this build).
- `turn.n` counts ended main-chat turns since the hooks module loaded, not since the transcript
  began. A reload or a resume starts it at 0 again.
- A first document is written at session start, so a fresh chat has a card before its first
  turn. A `/clear` resets the card instead of removing it.
- Strings are scrubbed of credentials before the write.

`v` stays 1 while fields are only added. A rename, removal or change of meaning is `v: 2`.
