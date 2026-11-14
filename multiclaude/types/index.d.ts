// Type contract for the multiclaude hooks module (hooks/register.tsx): the
// values it keeps in `$.state`, declared under the plugin's name.
export type Job = {
  id: string
  /** 'claude' = a Claude Code subagent (Agent tool), shown beside the external delegates. */
  /** 'pi' = the pi harness on a self-hosted model (a trial delegate: checkpoints, graded runs). */
  delegate: 'agy' | 'codex' | 'pi' | 'claude'
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
  /** 'tool' = started by the dispatch tool; 'runner' = folded in from a <id>.json the runner wrote (Bash / workflow / forwarder); 'agent' = a Claude subagent row (id = its agentId). */
  source?: 'tool' | 'runner' | 'agent'
  /** On a dispatch job: the agentId of the Claude subagent that called dispatch (its driver row folds into this job). */
  parent?: string
  /** On a Claude subagent row: its subagent type (general-purpose, Explore, a plugin agent …). */
  agentType?: string
  /** Where the delegate works, set only when that is not this chat's project directory (a `cwd` given to dispatch, a runner's `--cd`). The job is this chat's all the same; the pane shows the directory as a detail. */
  cwd?: string
  /** On a shadow run (a pi run of a task another agent is doing for real; recorded, never used): the id of the job or Claude subagent it runs beside. The pane folds it under that row. */
  shadowOf?: string
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
  /** List Claude subagents (Agent tool) beside the delegates; absent = on. */
  claude?: boolean
  /** Show the wallet rows in the status line; absent = on. Off writes ~/.cache/multiclaude/statusline.off, which the status-line script honours. */
  statusline?: boolean
  /** Start a pi shadow run beside every dispatch (Codex / AGY) and every Claude subagent, and record both results (scripts/lib/shadow.mjs); absent = off. */
  shadow?: boolean
  /** Concurrent shadows per chat, clamped to 1–8; absent = 1. */
  shadowParallel?: number
}

/** What the pane shows: the job list, one job's detail, or the settings. */
export type View = { mode: 'list' | 'job' | 'settings' | 'scorecard'; id?: string; /** the scorecard view's period */ period?: '7d' | '30d' | 'all' }

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
  /** Set when Codex refuses runs (usage limit hit / a window full); `until` = the retry time, ms. */
  codexOut?: { until: number | null } | null
  agy: { pool: string; fiveHour: number | null; weekly: number | null; exhausted: boolean }[]
  /** pi has no quota (an unlimited wallet): its spend instead. Absent / null when pi is not installed and has not run this week. */
  pi?: { installed: boolean; today: PiSpend; d7: PiSpend } | null
}
/** pi spend over a period: `usd` = what the provider reported per run, else tokens at list price (`approx`: at least one run priced that way). */
export type PiSpend = { usd: number; runs: number; tokens: number; approx: boolean }

/** One usage bucket from `tracker.mjs --json`: `input` = all input (fresh + cache reads + cache writes), `cached` = the cache part, `usd` ≈ API list price (`unpriced` = tokens with no known price). */
export type UsageRow = { input: number; cached: number; out: number; total: number; usd: number; unpriced: number; calls: number }
export type UsagePeriod = 'today' | '7d' | '30d' | 'all'
/** The Wallets pane's usage section: tokens and ≈ API spend per wallet, account and model over one period. */
export type Usage = {
  readAt: number
  period: UsagePeriod
  /** First day counted (YYYY-MM-DD); for 'all' the first day with history. */
  from: string | null
  scannedAt: number | null
  totals: UsageRow
  wallets: (UsageRow & { wallet: string })[]
  accounts: (UsageRow & { wallet: string; label: string })[]
  /** Top models by spend (at most 12). */
  models: (UsageRow & { wallet: string; model: string; priced: boolean })[]
  modelCount: number
  error?: string
}
/** How the usage section shows: the period, and in/out combined (total) or split (input · cached · output). Kept in `$.store` ('usageView'). */
export type UsageView = { period: UsagePeriod; split: boolean }

/** The Setup pane's companions menu: `setup.mjs companions --json` — each optional companion (plugins and ccstatusline) with its state; `busy` names the one an install / remove is running for. */
export type Companions = {
  readAt: number
  /** A `claude` CLI is on PATH (plugins install / uninstall through it; otherwise settings.json is edited add-only). */
  cli: boolean
  /** `section` groups the menu: 'plugins & status line', 'herdr' (absent = the first group). */
  list: { name: string; id?: string; section?: string; what: string; installed: boolean; enabled: boolean; state: string }[]
  busy?: string
  /** The last action's output (one line), shown under the list. */
  note?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    multiclaude: { jobs: Shaped<Job[]>; settings: Shaped<Settings>; view: Shaped<View>; cleared: Shaped<number>; wallets: Shaped<Wallets | null>; usage: Shaped<Usage | null>; usageView: Shaped<UsageView>; companions: Shaped<Companions | null> }
  }
}
