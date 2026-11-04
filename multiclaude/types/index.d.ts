// Type contract for the multiclaude hooks module (hooks/register.tsx): the
// values it keeps in `$.state`, declared under the plugin's name.
export type Job = {
  id: string
  delegate: 'agy' | 'codex'
  model: string
  effort?: string
  label: string
  /** One line from the prompt saying what the delegate was asked (the pane shows it under the label). */
  brief?: string
  startedAt: number
  endedAt?: number
  status: 'queued' | 'running' | 'done' | 'denied' | 'failed' | 'timeout' | 'usage' | 'cancelled'
  /** The latest progress line the runner printed (one per delegate step). */
  step: string
  /** The runner's final proof line: `[dispatch agy model=… status=… tokens=… out=…]`. */
  proof: string
  /** Where the runner wrote the full answer (from the proof line's out=…). */
  outFile?: string
  /** 'tool' = started by the dispatch tool; 'runner' = folded in from a <id>.json the runner wrote (Bash / workflow / forwarder). */
  source?: 'tool' | 'runner'
}

/** Delegates pane settings, kept in `$.store` ('settings') across sessions and edited in the pane's settings view. */
export type Settings = {
  /** Open the pane when the orchestrate skill is loaded (typed /multiclaude:orchestrate or run by the model). */
  openOnOrchestrate: boolean
  /** Open the pane whenever a dispatch is queued. */
  openOnDispatch: boolean
  /** Close the pane this many seconds after the last job ends (0 = never). Only after a job ended while it was open, never while it has focus. */
  autoClose: number
  /** 'all' jobs of this chat, or 'recent' = running + the last 5 finished. */
  show: 'all' | 'recent'
  /** Live transcript lines shown under each running job in the list (0–5). */
  tail: number
}

/** What the pane shows: the job list, one job's detail, or the settings. */
export type View = { mode: 'list' | 'job' | 'settings'; id?: string }

/** `cleared`: epoch ms of the last "clear finished"; job files that ended before it stay out of the pane. */

/** One used-% window: `pct` 0–100 (null = unknown), `resetsAt` epoch ms. */
export type Window = { pct: number | null; resetsAt?: number | null }
/** The Wallets pane's figures: from `usage-snapshot.mjs --json` (cache only) and `accounts.mjs list --json`. */
export type Wallets = {
  readAt: number
  /** Age of the cached figures, seconds (null = no cache yet). */
  ageSec: number | null
  claude: { pool: number; fiveHour: Window; sevenDay: Window; active: string | null; auto: boolean } | null
  accounts: { slot: string; label: string; active: boolean; disabled: boolean; fiveHour: Window; sevenDay: Window }[]
  codex: { label: string; pct: number | null }[]
  agy: { pool: string; fiveHour: number | null; weekly: number | null; exhausted: boolean }[]
}

declare module 'claude-code' {
  interface PluginState {
    multiclaude: { jobs: Shaped<Job[]>; settings: Shaped<Settings>; view: Shaped<View>; cleared: Shaped<number>; wallets: Shaped<Wallets | null> }
  }
}
