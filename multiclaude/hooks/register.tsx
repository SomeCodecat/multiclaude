// multiclaude hooks module — native, NON-BLOCKING delegate dispatch for Claude Code.
//
// The tools and the pane:
//   mcp__multiclaude__dispatch        enqueue a job on agy / codex / pi, return its id at once
//   mcp__multiclaude__dispatch_status progress + recent transcript of one job (or all), the answer once done
//   mcp__multiclaude__dispatch_cancel stop a running job (its own: kill; any other runner job: an <id>.cancel request)
//   mcp__multiclaude__dispatch_extend add time to a running job
//   mcp__multiclaude__dispatch_grade  record the orchestrator's verdict on a finished job (scripts/scorecard.mjs)
//   /delegates                         the Delegates pane: live provider · model · elapsed · step
//
// pi is a TRIAL delegate: the chat is also woken at every runner checkpoint of a
// pi job (to stop a run going nowhere), and a pi result asks for the gates and a grade.
//
// Why a queue: a tool.call hook has a 10 s own-time budget, so it cannot host a
// multi-minute CLI run. The hook only records the job; a runner tick started
// from session.start (a timer, which outlives any dispatch) spawns
// scripts/dispatch.mjs for each queued job, streams its progress into `$.state`,
// and when it ends wakes the chat with a plugin prompt carrying the proof line +
// the answer. The chat is never blocked, and nothing typed mid-turn kills a job.
//
// Every runner invocation with `--job` (the tool's, a backgrounded Bash job's, a
// workflow node's, a forwarder's) writes <id>.json / <id>.log / <id>.md under the
// jobs dir; the tick folds those files in, so the pane and dispatch_status show
// ALL delegate runs, whichever way they were launched.
import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { Job, Settings, View, Wallets, PiSpend, Usage, UsageRow, UsagePeriod, UsageView, Companions } from '../types'

const PANE = 'delegates'
const PANE_TITLE = 'Delegates'
const MAX_RUNNING = 6
const WAKE_INLINE_CHARS = 6000
const LOG_KEEP = 400
const TAIL_LINES = 15
// Change the tag when a job's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'multiclaude', key: 'jobs' } as const, [] as Job[], {
  shape: 'jobs-3',
})
// Pane settings ($.store 'settings' across sessions; this atom is what the pane draws from).
const SETTINGS_KEY = 'settings'
const DEFAULT_SETTINGS: Settings = { openOnOrchestrate: true, openOnDispatch: true, autoClose: 0, show: 'all', tail: 2 }
const settings = atom({ plugin: 'multiclaude', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'settings-1' })
const view = atom({ plugin: 'multiclaude', key: 'view' } as const, { mode: 'list' } as View, { shape: 'view-1' })
// When "clear finished" was last pressed: the scan no longer folds in a job file
// that had ended by then (the files stay on disk for dispatch_status).
const cleared = atom({ plugin: 'multiclaude', key: 'cleared' } as const, 0, { shape: 'cleared-1' })
// Mirrors for the timer (no read while ticking): the settings in force, whether the pane had
// the keyboard at its last draw, and when this module last opened it.
let cfg: Settings = DEFAULT_SETTINGS
let paneFocused = false
let paneOpenedAt = 0
// Inside herdr (asked once at session.start: usage-snapshot.mjs --herdr) its own panels already
// show the jobs and wallets, so no pane opens by itself; /delegates and /wallets still open them.
let inHerdr = false
const autoOpen = (setting: boolean | undefined) => !!setting && !inHerdr
// The store is shared by every session: a save takes what is stored now (another session may have
// changed a setting since this one started) and changes only the keys of the patch.
let settingsSaving = 0
let settingsRev = 0
const saveSettings = async ($: EngineInterface, patch: Partial<Settings>) => {
  settingsSaving++
  settingsRev++
  try {
    const saved = await $.store.get(SETTINGS_KEY).catch(() => undefined) as Partial<Settings> | undefined
    cfg = { ...cfg, ...(saved && typeof saved === 'object' ? saved : {}), ...patch }
    await update($, settings, () => cfg).catch(() => undefined)
    await $.store.set(SETTINGS_KEY, cfg).catch(() => undefined)
  } finally { settingsSaving-- }
  if ('statusline' in patch) await syncWalletRows($)
  if (patch.shadow) { piReady = null; void checkPi($) }
}
// Each session holds its own copy of the settings and the store is the one thing they share, so the
// copy is read again every few seconds (the runner tick). Without it a setting changed in one chat —
// /multiclaude:shadow on — reached no chat that was already open until its next reload: the switch
// was stored and confirmed, and no shadow ever started. A save of this session's own goes first.
async function syncSettings($: EngineInterface) {
  if (settingsSaving) return
  const rev = settingsRev
  const saved = await $.store.get(SETTINGS_KEY).catch(() => undefined) as Partial<Settings> | undefined
  if (settingsSaving || rev !== settingsRev || !saved || typeof saved !== 'object') return
  const next: Settings = { ...cfg, ...saved }
  if ((Object.keys(next) as (keyof Settings)[]).every(k => next[k] === cfg[k])) return
  const shadowOn = !!next.shadow && !cfg.shadow
  cfg = next
  await update($, settings, () => cfg).catch(() => undefined)
  if (shadowOn) { piReady = null; void checkPi($) }   // asked here, in the tick: never inside a tool.call hook
}
// Setting 7 lives outside the module too: the status-line script reads a flag file
// (statusline.off in the cache dir), so Claude Code's statusLine and ccstatusline's
// widgets see the switch on their next redraw. The script owns the file.
const syncWalletRows = async ($: EngineInterface) => {
  try { await $.process.run(['node', `${$.plugin.root}/scripts/usage-snapshot.mjs`, '--wallet-rows', cfg.statusline === false ? 'off' : 'on'], { timeoutMs: 15_000 }) } catch { /* next save */ }
}
const openPane = async ($: EngineInterface, v?: View) => {
  if (v) await update($, view, () => v).catch(() => undefined)
  paneOpenedAt = Date.now()
  return $.ui.open({ id: PANE, title: PANE_TITLE })
}

// ── colour code: one hue per model family, shade by tier ──
// codex/GPT green · Gemini blue (Pro deep, Flash light, Lite pale) · Claude orange
// (Mythos red, Fable red-orange, Opus deep, Sonnet mid, Haiku pale) · Argon violet ·
// pi coral, its logo colour (whatever self-hosted model it runs).
const PI = '#f09082'   // the coral of pi's logo: pi's one colour
const PI_LOGO = [PI, '#4d9abf', '#f1be58'] as const   // coral · steel blue · amber: the ∞ wallet bar and the legend swatch
const MODEL_LEGEND: [string, string][] = [['codex', '#10a37f'], ['gemini', '#4285f4'], ['claude', '#d97757'], ['argon', '#c678dd'], ['pi', PI]]
const modelColor = (delegate: Job['delegate'], model: string) => {
  const m = model.toLowerCase()
  if (delegate === 'pi') return PI
  if (/argon/.test(m)) return '#c678dd'
  if (/mythos/.test(m)) return '#e03131'
  if (/fable/.test(m)) return '#e0603a'
  if (/opus/.test(m)) return '#d97757'
  if (/sonnet/.test(m)) return '#e5a46b'
  if (/haiku/.test(m)) return '#eac7a1'
  if (/claude/.test(m)) return '#d97757'
  if (/gemini|flash/.test(m)) return /lite/.test(m) ? '#a8c7fa' : /flash/.test(m) ? '#6ea8fe' : '#4285f4'
  if (delegate === 'codex' || /^(gpt|o\d|codex)/.test(m)) return /mini|nano|spark/.test(m) ? '#6fcf97' : '#10a37f'
  return 'subtle'
}
const statusColor = (s: Job['status']) =>
  s === 'running' ? 'warning' : s === 'queued' ? 'subtle' : s === 'done' ? 'success' : s === 'cancelled' ? 'inactive' : 'error'
const statusMark = (s: Job['status']) => (s === 'running' ? '●' : s === 'queued' ? '○' : s === 'done' ? '✓' : s === 'cancelled' ? '–' : '✗')

// ── colour for the chat commands' output (scripts print plain text) ──
// Colour for the chat commands' output (terminal only; scripts print plain text).
// Every % the scripts print is USED: green < 60 ≤ yellow < 85 ≤ red, as on the status line.
const INK = { ok: '#5fb760', warn: '#d7af00', bad: '#e06c75', dim: '#7f848e', rule: '#4b5263', accent: '#56b6c2', money: '#e5c07b' }
const WALLET_INK: Record<string, string> = { codex: '#10a37f', claude: '#d97757', agy: '#4285f4', gemini: '#6ea8fe', argon: '#c678dd', pi: PI }
const fg = (hex: string, t: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `\x1b[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${t}\x1b[39m`
}
const bold = (t: string) => `\x1b[1m${t}\x1b[22m`
const usedInk = (v: number) => (v >= 85 ? INK.bad : v >= 60 ? INK.warn : INK.ok)
function paintWords(s: string): string {
  const cut = s.indexOf(' // ')
  const head = cut >= 0 ? s.slice(0, cut) : s
  const tail = cut >= 0 ? fg(INK.dim, s.slice(cut)) : ''
  const firstPct = /(\d+(?:\.\d+)?)%/.exec(head)
  const out = head
    .replace(/(█+)(░*)|(░+)/g, (_m: string, full?: string, rest?: string, empty?: string) =>
      empty ? fg(INK.rule, empty) : fg(firstPct ? usedInk(+firstPct[1]) : INK.accent, full ?? '') + (rest ? fg(INK.rule, rest) : ''))
    .replace(/(\d+(?:\.\d+)?)%/g, (m: string, v: string) => bold(fg(usedInk(+v), m)))
    .replace(/\$\d[\d,]*(?:\.\d+)?/g, (m: string) => fg(INK.money, m))
    .replace(/\b(?:claude|gpt|gemini|o\d)-[a-z0-9][a-z0-9.-]*/g, (m: string) => {
      const c = modelColor(/^(gpt|o\d)/.test(m) ? 'codex' : 'claude', m)
      return c.startsWith('#') ? fg(c, m) : m
    })
    .replace(/^(\s*)(CODEX|CLAUDE|AGY)\b/, (_m: string, sp: string, w: string) => sp + fg(WALLET_INK[w.toLowerCase()], w))
    .replace(/^(\s{2,4})(claude|codex|agy|gemini|argon)(?= )/, (_m: string, sp: string, w: string) => sp + fg(WALLET_INK[w], w))
    .replace(/▶|\[ACTIVE\]|\(active\)/g, (m: string) => bold(fg(INK.ok, m)))
    .replace(/\b(ON|present|enabled)\b/g, (m: string) => fg(INK.ok, m))
    .replace(/\b(OFF|missing|absent|disabled)\b/g, (m: string) => fg(INK.bad, m))
    .replace(/\b(resets?(?: in)?|next reset|↻) (\d+[dhms][\dhms]*)|\b(\d+[dhms][\dhms]*) left\b|\((?:read|showing data from) [^)]*\)/g, (m: string) => fg(INK.dim, m))
  return out + tail
}
function paintLine(l: string): string {
  if (!l.trim()) return l
  let m: RegExpExecArray | null
  if (/^\s*[═─]{8,}\s*$/.test(l)) return fg(INK.rule, l)
  if ((m = /^(\s*)▌ (.*)$/.exec(l))) return `${m[1]}${fg(INK.accent, '▌')} ${bold(paintWords(m[2]))}`
  if ((m = /^(\s{2}multiclaude \w+)( .*)$/.exec(l))) return bold(fg(INK.accent, m[1])) + fg(INK.dim, m[2])
  if ((m = /^(\[multiclaude [^\]]*\])(.*)$/.exec(l))) return bold(fg(INK.accent, m[1])) + paintWords(m[2])
  if ((m = /^(By \w+|ALL)(\b.*)$/.exec(l))) return bold(m[1]) + paintWords(m[2])
  if ((m = /^(\s*)fix: (.*)$/.exec(l))) return `${m[1]}${fg(INK.warn, 'fix:')} ${bold(m[2])}`
  if ((m = /^(\s*)✓ (.*)$/.exec(l))) return `${m[1]}${fg(INK.ok, '✓')} ${paintWords(m[2])}`
  if ((m = /^(\s*)✗ (.*)$/.exec(l))) return `${m[1]}${fg(INK.bad, '✗ ' + m[2])}`
  if ((m = /^(\s*)([·=]) (.*)$/.exec(l))) return `${m[1]}${fg(INK.dim, `${m[2]} ${m[3]}`)}`
  if ((m = /^(\s*)\+ (.*)$/.exec(l))) return `${m[1]}${fg(INK.ok, '+')} ${m[2]}`
  if (/^\s*(stale \(skip\)|\(bare ID)/.test(l)) return fg(INK.dim, l)
  if ((m = /^(\s*)(\S+:)( .*)$/.exec(l)) && /^\s{2}\S/.test(l) && m[2].length < 16) return `${m[1]}${fg(INK.dim, m[2])}${paintWords(m[3])}`
  return paintWords(l)
}
const paint = (text: string) => (text.includes('\x1b[') ? text : text.split('\n').map(paintLine).join('\n'))
// The terminal draws these escapes; the app and phones show command text as is,
// so colour only when every surface attached to the session is a terminal.
async function shown($: EngineInterface, r: { text: string, context?: readonly string[] }) {
  try {
    const s = await $.session.surfaces()
    return s.length > 0 && s.every(x => x === 'terminal') ? { ...r, text: paint(r.text) } : r
  } catch { return r }
}

type Pending = {
  id: string
  argv: string[]
  cwd?: string
  prompt: string
  delegate: Delegate
  label: string
  /** A shadow run (scripts/lib/shadow.mjs): for the record only — no wake, no toast, no status line. */
  shadow?: boolean
}
/** The external delegates the runner knows. pi is the TRIAL one: checkpoints wake the chat and every run is graded. */
type Delegate = 'agy' | 'codex' | 'pi'
const delegateOf = (d: unknown): Delegate => (d === 'codex' ? 'codex' : d === 'pi' ? 'pi' : 'agy')
// Module-level: lives as long as the loaded module (a reload drops queued work;
// `$.state` keeps the rows, so the pane still shows them as failed).
const queue: Pending[] = []
const running = new Map<string, { stop: () => void }>()
// ── shadows: a pi run of a task another agent is doing for real, recorded and never used
// (scripts/lib/shadow.mjs, /multiclaude:shadow). One at a time — a self-hosted model serves
// everybody from the same hardware — a short line behind it, and silent. Off unless setting 8
// is on and pi resolves its bands (asked in the background: session.start, the toggle).
const shadowQueue: Pending[] = []
// the AGY jobs /multiclaude:shadow review queued: the verdicts in their answer become ratings
const reviewJobs = new Set<string>()
let shadowLive = 0
const SHADOW_WAITING = 4
const SHADOW_PROMPT_MAX = 60_000
let piReady: boolean | null = null
let piCheckAt = 0   // a "not ready" is asked again every 5 minutes: pi installed, or logged in, after the session began
// Claude subagents with a shadow: what the reference record needs once the subagent answers.
const shadowed = new Map<string, { prompt: string; label: string; type: string }>()
async function checkPi($: EngineInterface) {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/shadow.mjs`, 'ready'], { timeoutMs: 60_000 })
    piReady = r.exitCode === 0
  } catch { piReady = false }
  piCheckAt = Date.now() + 300_000
  return piReady
}
// The pi band that fits the agent a shadow runs beside: its tier, not its provider.
type Band = 'lo' | 'med' | 'hi'
export function shadowBand(delegate: Job['delegate'], model?: string, effort?: string): Band {
  const m = (model ?? '').toLowerCase(), ef = (effort ?? '').toLowerCase()
  if (delegate === 'claude') return /haiku/.test(m) ? 'lo' : /opus|fable|mythos/.test(m) ? 'hi' : 'med'
  if (delegate === 'codex') return /^(xhigh|max|ultra)$/.test(ef) ? 'hi' : /^(low|minimal|medium)$/.test(ef) || /mini|nano|spark/.test(m) ? 'lo' : 'med'
  if (/opus|argon|-pro\b|pro-high|-high$/.test(m) || /^(xhigh|max|ultra)$/.test(ef)) return 'hi'
  return /lite|-low$|-minimal$/.test(m) || /^(low|minimal)$/.test(ef) ? 'lo' : 'med'
}
// Subagents that get no shadow (nothing a coding model could repeat: the web, a hand-off to another CLI)
// and the ones that only read.
const NO_SHADOW = /^(web-fetch|claude-code-guide|statusline-setup)$|(^|:)(agy|codex)-rescue$/
const READ_ONLY_AGENT = /^(Explore|Plan|mythos-review)$/
type ShadowOf = { of: string; prompt: string; label: string; band: Band; edit: boolean; cwd?: string }
async function enqueueShadow($: EngineInterface, s: ShadowOf): Promise<string | null> {
  if (!cfg.shadow || piReady !== true || !s.prompt.trim() || s.prompt.length > SHADOW_PROMPT_MAX || shadowQueue.length >= SHADOW_WAITING) return null
  const id = shortId()
  const label = `shadow · ${s.label}`.slice(0, 60)
  const argv = ['node', `${$.plugin.root}/scripts/dispatch.mjs`, 'pi', '--job', id, '--label', label, '--band', s.band, '--shadow-of', s.of,
    '--max-steps', '25', '--max-tokens', '400000', '--checkpoint', '0', '--timeout', '600']
  if (s.edit) {
    argv.push('--edit', '--worktree')
    try {   // the tree the real agent starts from: a shadow that waits its turn must not find the task done
      const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { ...(s.cwd ? { cwd: s.cwd } : {}), timeoutMs: 4000 })
      const sha = head.exitCode === 0 ? head.stdout.trim() : ''
      if (/^[0-9a-f]{7,40}$/.test(sha)) argv.push('--base', sha)
    } catch { /* not a repository: the runner makes it a read-only shadow */ }
  }
  const job: Job = {
    id, delegate: 'pi', model: `(${s.band} band)`, label, brief: briefOf(s.prompt),
    startedAt: Date.now(), status: 'queued', step: 'queued', proof: '', source: 'tool', shadowOf: s.of,
  }
  await update($, jobs, list => [...list.filter(j => j.id !== id), job].slice(-80))
  shadowQueue.push({ id, argv, cwd: s.cwd, prompt: s.prompt, delegate: 'pi', label, shadow: true })
  pump($)
  return id
}
// The real agent's side of a pair, when it is a Claude subagent (a runner job writes its own: --reference).
async function recordReference($: EngineInterface, rec: Record<string, unknown>) {
  try { await $.process.run(['node', `${$.plugin.root}/scripts/shadow.mjs`, 'record'], { stdin: JSON.stringify(rec), timeoutMs: 30_000 }) } catch { /* the pair stays one-sided */ }
}
const logs = new Map<string, string[]>()
const answers = new Map<string, { code: number | null; answer: string; proof: string; tail: string[] }>()
let jobsDir = ''
let sessionStartedAt = Date.now()
let pumping = false
let scanning = false

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    delegate: {
      type: 'string',
      enum: ['agy', 'codex', 'pi'],
      description:
        'agy = Antigravity (review, research, analysis, heavy reasoning; Gemini + Claude tiers on a separate wallet). codex = OpenAI Codex (implementation, edits, refactors, tests). pi = the pi harness on a self-hosted model — a TRIAL delegate, only when the probe lists it: small, clearly-specced coding tasks; you are woken at every checkpoint to judge its progress, and you must gate and grade every result (dispatch_grade).',
    },
    prompt: {
      type: 'string',
      description:
        'The full task text: spec, expected files, project conventions, test command, and the anti-fabrication clause. Ground it with real file excerpts. agy prompts must stay under ~120 KB; codex has no cap.',
    },
    model: {
      type: 'string',
      description:
        'Bare model id from the probe band table (agy: e.g. gemini-3.8-flash-medium, claude-sonnet-5-5-high; codex: a catalog slug e.g. gpt-6.1-sol). Never a display name. pi: a pi band id from the probe (the effort is part of the id, or the probe names it beside the id). Omit for the default band (agy gem-med / codex std / pi med).',
    },
    effort: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      description: 'Reasoning effort. codex: the band effort (mech medium / std high / hard xhigh / max ultra). agy: optional. pi: the level the probe prints beside the band id (one id at three efforts); ignored for an id that carries its effort.',
    },
    edit: {
      type: 'boolean',
      description:
        'agy / pi: allow the delegate to run commands and modify files (agy: --dangerously-skip-permissions; pi: the edit, write and bash tools). Without it agy may only run read-only commands (git status/log/diff/show, ls, grep, sed -n, wc …); anything else is denied and ends the run; pi gets only read / grep / find / ls — no shell at all, so no git diff and no test run: paste the diff or excerpts a pi review needs into the prompt. A review/research task normally runs without it; a pi coding task needs it.',
    },
    sandbox: {
      type: 'string',
      enum: ['read-only', 'workspace-write', 'danger-full-access'],
      description: 'codex only: sandbox mode (default workspace-write).',
    },
    label: {
      type: 'string',
      description: 'Short task label (≤ 60 chars) for the Delegates pane and the task tracker, e.g. "review auth middleware".',
    },
    cwd: { type: 'string', description: 'Working directory for the delegate (default: the session cwd). Set it to the checkout or worktree a review is about: a read-only agy job cannot run `git -C <path>` (denied, ends the run), and its git commands read the branch this directory has checked out.' },
    worktree: {
      type: 'boolean',
      description: 'Run in a fresh git worktree (<repo>/.claude/worktrees/mc-<job>, branch mc/<job>) so parallel edit jobs never share a tree. The proof line names it (worktree=…); install deps / pick ports in the prompt if the task runs a server.',
    },
    maxTokens: {
      type: 'number',
      description: 'agy / pi: stop the run cleanly once it has used this many tokens (agy: status=BUDGET; pi: status=LOOP). Default 350000 on the AGY claude pool (Claude / GPT models), none on Gemini or pi; 0 disables.',
    },
    maxSteps: {
      type: 'number',
      description: 'pi only: tool steps before the loop guard stops the run (status=LOOP). Default 40; raise it only for a task you know is long, 0 disables.',
    },
    checkpoint: {
      type: 'number',
      description: 'pi only: wake you every N tool steps with what the run has done so far, so you can judge it and cancel a run that is going nowhere. Default 8; lower it (4–5) for a first run on a new kind of task, 0 disables.',
    },
    fallback: {
      type: 'string',
      description: 'agy only: bare model id to run instead if the preflight finds the chosen model\'s pool exhausted (nothing spent yet), e.g. a Gemini tier for a Claude-pool job.',
    },
    timeout: { type: 'number', description: 'Seconds before the runner kills the delegate (default agy 600 / codex 900 / pi 600). You are woken at 80% of it (and again after each extension); dispatch_extend adds time.' },
  },
  required: ['delegate', 'prompt'],
}

const DISPATCH_DESCRIPTION = [
  'Start a task on an EXTERNAL delegate CLI — agy (Antigravity: review / research / analysis / heavy reasoning) codex (OpenAI Codex: implementation / edits / tests) or pi (a self-hosted model on trial: small coding tasks, judged and graded by you) — on that delegate\'s own quota, not Claude\'s.',
  'NON-BLOCKING: returns a job id immediately and the job runs in the background. Do not poll: when it finishes the plugin wakes you with a message carrying the proof line `[dispatch <cli> model=… status=SUCCESS tokens=N …]` and the answer. Meanwhile carry on with other work or end your turn.',
  'Check progress + the delegate\'s live transcript any time with dispatch_status({ id }) (or no id for every job); dispatch_cancel({ id }) stops one. Prefer this over any subagent or Bash call to agy/codex/pi.',
].join(' ')

const STATUS_DESCRIPTION =
  'Progress of a background delegate job: with `id`, that job\'s status, elapsed time, the last lines of its live transcript (tool steps, narration), the proof line and — once done — the full answer. Without `id`, one line per job (newest first), including runner jobs launched from Bash or a workflow node. Use it to check on a dispatch before its wake-up arrives, or to re-read an answer.'

const CANCEL_DESCRIPTION = 'Stop a running background delegate job by `id` (from dispatch / dispatch_status, or the `dispatch: job id …` line of a runner started from Bash or by an mc-* forwarder agent). A job this tool started is killed; any other runner job gets a cancel request its runner picks up within 2 s — either way the delegate is stopped and the run recorded as CANCELLED.'

const GRADE_DESCRIPTION =
  'Record your verdict on a finished delegate job AFTER you ran the gates on its result yourself (read the diff, ran the tests): pass = accepted as delivered; rework = usable only after a fix, an edit of yours or a second dispatch; fail = thrown away (wrong, fabricated, looped, broke the gates). REQUIRED for every pi job — pi is a trial delegate and its scorecard verdict (VIABLE / MARGINAL / NOT VIABLE) comes from these grades. Grade Codex / AGY jobs too when you can: they are the reference pi is rated against. `vs` names another model\'s job on the same task (a bake-off). Returns the model\'s tally and verdict so far.'

const EXTEND_DESCRIPTION =
  'Give a running delegate job more time: adds `seconds` to its timeout (the runner picks it up within 2 s). The plugin wakes you each time a job passes 80% of its current timeout (again after every extension): extend it if its transcript (dispatch_status) shows progress, else dispatch_cancel it. Works for runner jobs launched from Bash with --job too.'

const fmtDur = (sec: number) =>
  sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`
const stripStamp = (line: string) => line.replace(/^\[\+\d+s\]\s*/, '').trim()
// The first line of a prompt that says what to do: skips headings, fences, rules and blank lines.
const briefOf = (prompt: string) => {
  const line = prompt.split('\n').map(l => l.replace(/^[\s>*-]+|[*_`]/g, '').trim())
    .find(l => l.length > 12 && !/^(#|```|---|===|\[)/.test(l))
  return line ? (line.length > 160 ? line.slice(0, 159) + '…' : line) : undefined
}
// `[dispatch agy model=… status=SUCCESS tokens=14,196 (…) dur=7.0s … cost≈$0.31]` → `SUCCESS · 14,196 tokens · 7.0s · ≈$0.31`
// (cost=$… is what the provider billed, cost≈$… the tokens at API list price)
const proofShort = (proof: string) => {
  const st = /status=(\S+)/.exec(proof)?.[1]
  if (!st) return proof
  const tok = /tokens=([\d,]+)/.exec(proof)?.[1]
  const dur = /dur=([\d.]+s)/.exec(proof)?.[1]
  const cost = /cost([=≈])(\$[\d.]+)/.exec(proof)
  return [st, tok && `${tok} tokens`, dur, cost && `${cost[1] === '≈' ? '≈' : ''}${cost[2]}`].filter(Boolean).join(' · ')
}
const shortId = () => `j${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`
const elapsed = (j: Job, now = Date.now()) => Math.max(0, Math.round(((j.endedAt ?? now) - j.startedAt) / 1000))
const isLive = (j: Job) => j.status === 'running' || j.status === 'queued'
// Which AGY quota pool a model id draws on (same rule as dispatch.mjs).
const poolOf = (model: string) => (/argon/i.test(model) ? 'argon' : /^(claude|gpt)/i.test(model) ? 'claude' : 'gemini')
const summary = (j: Job, now = Date.now()) =>
  `${j.id} · ${j.status} · ${j.delegate} ${j.model}${j.effort ? '@' + j.effort : ''} · ${fmtDur(elapsed(j, now))} · ${j.label}${j.source === 'runner' ? ' · (runner job)' : ''}` +
  (isLive(j) ? ` · ${j.step}` : j.proof ? `\n    ${j.proof}` : '')
const logPush = (id: string, line: string) => {
  const l = logs.get(id) ?? []
  l.push(line)
  if (l.length > LOG_KEEP) l.splice(0, l.length - LOG_KEEP)
  logs.set(id, l)
}
const patchJob = ($: EngineInterface, id: string, fn: (j: Job) => Job) =>
  update($, jobs, list => list.map(j => (j.id === id ? fn(j) : j))).catch(() => undefined)

// Orchestration requested: open the Delegates pane, when the setting allows. Typed
// (/multiclaude:orchestrate …) it arrives as command.run; loaded by the model, as a Skill
// tool call (the tool.call hook). Not skill.prompt: a built-in plugin keeps that event from
// other plugins.
function orchestrateAsked($: EngineInterface) {
  if (autoOpen(cfg.openOnOrchestrate)) void openPane($, { mode: 'list' }).catch(() => undefined)
}

// ── Claude subagents (Agent tool) as rows beside the delegates ──
// The mc-agy / mc-codex / mc-pi forwarders are skipped: their runner job is already the row.
// A subagent that calls dispatch (a workflow node / driver) folds into that job's row.
const FORWARDER = /^multiclaude:mc-(agy|codex|pi)$/
const isAgentRow = (j: Job) => j.source === 'agent'
const rowTag = (j: Job) => (j.shadowOf ? ' ·shadow' : j.source === 'runner' ? ' ·bash' : isAgentRow(j) ? ` ·${j.agentType ?? 'agent'}` : '')
const agentRows = new Set<string>()          // agentIds this module instance tracks
const agentStepAt = new Map<string, number>() // last step write per agent (≤ 1/s)
// What a Claude subagent's tokens come to at API list price: scripts/price.mjs --usage over the
// counts its turn.complete carries (summed over the turn's requests) → `≈$0.42` at the end of
// the row's result line. A subagent sent a follow-up runs another turn: the figures add up.
// (Not classic.SubagentStop + the transcript: a built-in plugin keeps that event from other plugins.)
type TurnTokens = { model?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
const agentUsd = new Map<string, number>()
const costText = (usd: number) => `≈$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`
const withCost = (line: string, cost?: string) => { const base = line.replace(/ · ≈\$[\d.]+$/, ''); return cost ? `${base} · ${cost}` : base }
async function priceAgent($: EngineInterface, id: string, u: TurnTokens) {
  try {
    const rec = { model: u.model, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 }
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/price.mjs`, '--usage', JSON.stringify(rec)], { timeoutMs: 15_000 })
    const usd = r.exitCode === 0 ? Number((JSON.parse(r.stdout) as { usd?: number | null }[])[0]?.usd) : NaN
    if (!(usd > 0)) return
    const sum = (agentUsd.get(id) ?? 0) + usd
    agentUsd.set(id, sum)
    const cost = costText(sum)
    await patchJob($, id, j => (isLive(j) ? j : { ...j, step: withCost(j.step, cost), proof: withCost(j.proof, cost) }))
  } catch { /* no figure for this row */ }
}
// The pane's scorecard view (key t): scripts/scorecard.mjs --json, kept 30 s per period; a new grade drops it.
type ScoreRow = { delegate: string; model: string; trial?: boolean; runs: number; ok: number; infra: number; stuck: number; failed: number; pass: number; rework: number; fail: number; cost?: number; costApprox?: boolean; graded: number; medDur?: number | null; medTokens?: number | null; verdict?: string; why?: string }
type Score = { rows: ScoreRow[]; bakeoffs: unknown[]; ungraded: unknown[]; error?: string }
const scoreCache = new Map<string, { at: number; score: Score }>()
async function scoreOf($: EngineInterface, period: string): Promise<Score> {
  const hit = scoreCache.get(period)
  if (hit && Date.now() - hit.at < 30_000) return hit.score
  let score: Score = { rows: [], bakeoffs: [], ungraded: [] }
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/scorecard.mjs`, period, '--json'], { timeoutMs: 30_000 })
    const j = JSON.parse(r.stdout) as Partial<Score>
    score = { rows: Array.isArray(j.rows) ? j.rows : [], bakeoffs: Array.isArray(j.bakeoffs) ? j.bakeoffs : [], ungraded: Array.isArray(j.ungraded) ? j.ungraded : [] }
  } catch { score = { ...score, error: 'could not read the scorecard — /multiclaude:scorecard prints it' } }
  scoreCache.set(period, { at: Date.now(), score })
  return score
}
// A row's dollar figure: a runner job's proof line (cost=$… billed, cost≈$… at list price), a subagent's ≈$….
const costOf = (j: Job): { usd: number; approx: boolean } | null => {
  const m = /cost([=≈])\$([\d.]+)/.exec(j.proof) ?? (isAgentRow(j) ? / · (≈)\$([\d.]+)$/.exec(j.proof) : null)
  const usd = +(m?.[2] ?? 0)
  return usd > 0 ? { usd, approx: m?.[1] === '≈' } : null
}
const STEP_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'path', 'label', 'skill', 'prompt'] as const
const stepOf = (e: Record<string, unknown>) => {
  const tool = String(e.tool ?? '').replace(/^mcp__([^_]+(?:_[^_]+)*)__/, '')
  const arg = STEP_KEYS.map(k => e[k]).find(v => typeof v === 'string' && v.trim()) as string | undefined
  return `${tool}${arg ? ' ' + arg.replace(/\s+/g, ' ').slice(0, 100) : ''}`
}
const agentEnd = (status: string | undefined): Job['status'] | undefined =>
  status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'killed' ? 'cancelled' : undefined
// Keep agent rows in step with $.agent.list(): a row whose turn.complete was missed ends,
// a background agent woken again (SendMessage) runs again.
async function reconcileAgents($: EngineInterface) {
  const list = await read($, jobs)
  if (!list.some(isAgentRow)) return
  const infos = new Map((await $.agent.list()).map(a => [a.id, a] as const))
  const now = Date.now()
  let changed = false
  const next = list.map((j): Job => {
    if (!isAgentRow(j)) return j
    const a = infos.get(j.id)
    if (!a) return j
    const end = agentEnd(a.status)
    if (end && isLive(j)) { changed = true; return { ...j, status: end, endedAt: now } }
    if (!end && !isLive(j) && (a.status === 'running' || a.status === 'pending')) { changed = true; return { ...j, status: 'running', endedAt: undefined } }
    return j
  })
  if (changed) await update($, jobs, () => next)
}

// ── the runner (timer context: outlives every dispatch) ──
async function runJob($: EngineInterface, p: Pending) {
  await patchJob($, p.id, j => ({ ...j, status: 'running', startedAt: Date.now(), step: 'starting…' }))
  if (!p.shadow) $.ui.status(`${p.delegate} ${p.label}`)

  let out = ''
  let buf = ''
  let code: number | null = null
  let stopped = false
  let warnedTimeout = false
  let warnings = 0
  let checkpoints = 0
  const child = $.process.spawn({ argv: p.argv, cwd: p.cwd, input: p.prompt, ...(mySession ? { env: { MC_SESSION_ID: mySession } } : {}) })
  running.set(p.id, { stop: () => { stopped = true; void child.return(undefined as never) } })
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stdout') { out += text; continue }
      buf += text
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        logPush(p.id, line)
        // The runner warns at 80% of every limit it runs under (it re-arms on each extension), and so does the wake.
        if (line.includes('⏱ timeout extended')) warnedTimeout = false
        if (!p.shadow && !warnedTimeout && line.includes('⏱ 80% of the')) {
          warnedTimeout = true
          warnings++
          const nth = warnings > 1 ? ` (warning ${warnings}, after ${warnings - 1} extension${warnings > 2 ? 's' : ''})` : ''
          $.ui.toast(`${p.delegate} ${p.label}: 80% of its timeout used${nth}`)
          void $.prompt.submit({
            text: `dispatch job ${p.id} (${p.delegate} · ${p.label}) is still running and has used 80% of its timeout${nth}.\n${stripStamp(line)}\nCheck dispatch_status({ id: "${p.id}" }) and decide now:\n- the transcript shows progress → dispatch_extend({ id: "${p.id}", seconds: N }); you will be woken again at 80% of the new limit;\n- it is stuck or looping → dispatch_cancel({ id: "${p.id}" }).\nDoing nothing lets the runner kill it at the limit (TIMEOUT).`,
          }).catch(() => undefined)
        }
        // A trial delegate reports every N tool steps; each report wakes the chat to judge the run.
        if (!p.shadow && line.includes('⏸ checkpoint:')) {
          checkpoints++
          const recent = (logs.get(p.id) ?? []).slice(-12, -1).map(stripStamp).join('\n')
          $.ui.toast(`${p.delegate} ${p.label}: checkpoint ${checkpoints}`)
          void $.prompt.submit({
            text: `dispatch job ${p.id} (${p.delegate} · ${p.label}) checkpoint ${checkpoints} — still running.\n${stripStamp(line)}\n\n— its last steps —\n${recent || '(none)'}\n\nJudge it now, from these lines alone unless they are unclear (then dispatch_status({ id: "${p.id}" })):\n- converging — new files, new commands, test output changing, edits inside the task → do nothing; the next checkpoint or the result wakes you;\n- going nowhere — the same files re-read, the same command re-run, edits outside the task, a plan that restarts → dispatch_cancel({ id: "${p.id}" }), then dispatch_grade({ id: "${p.id}", grade: "fail", note: "why" }) and re-dispatch narrower or on Codex / AGY.\nDo not wait for the loop guard when you can already see it.`,
          }).catch(() => undefined)
        }
        const picked = /^dispatch: no --model given — using the default band: (\S+)/.exec(line)?.[1]
        await patchJob($, p.id, j => ({
          ...j,
          step: stripStamp(line),
          proof: line.startsWith('[dispatch ') ? line : j.proof,
          model: picked ?? j.model,
        }))
      }
    }
    if (buf.trim()) logPush(p.id, buf.trim())
    code = (await child.result).code
  } catch (err) {
    logPush(p.id, `runner error: ${err instanceof Error ? err.message : String(err)}`)
    code = code ?? 1
  } finally {
    running.delete(p.id)
  }

  const tail = logs.get(p.id) ?? []
  const proof = [...tail].reverse().find(l => l.startsWith('[dispatch ')) ?? ''
  const outFile = /\bout=([^\s\]]+)/.exec(proof)?.[1]
  const status: Job['status'] = stopped ? 'cancelled'
    : code === 0 ? 'done' : code === 3 ? 'denied' : code === 124 ? 'timeout' : code === 2 ? 'usage' : 'failed'
  const answer = out.trimEnd()
  answers.set(p.id, { code, answer, proof, tail: tail.slice(-8) })
  // a job sent by band ("(hi band)", "(default band)") learns its model — and its effort — from the proof
  // line (`model=<id>@<effort>`); a pi job always takes the effort that ran: the runner picks the band's
  // level, or drops an effort the id already carries
  const ran = /\bmodel=([^\s@]+)(?:@(\S+))?/.exec(proof)
  await patchJob($, p.id, j => ({ ...j, status, endedAt: Date.now(), proof: proof || j.proof, outFile, step: proof ? stripStamp(proof) : (tail[tail.length - 1] ?? j.step), ...(ran && j.model.startsWith('(') ? { model: ran[1], effort: ran[2] ?? j.effort } : {}), ...(ran && j.delegate === 'pi' ? { effort: ran[2] } : {}) }))
  if (p.shadow) {   // recorded, not reported (/multiclaude:shadow has it) — unless it wrote where it must not
    const where = /\boutside="([^"]*)"/.exec(proof)?.[1]
    if (where) {
      $.ui.toast(`pi shadow stopped: it wrote outside its worktree — ${where}`)
      void $.prompt.submit({
        text: `Shadow job ${p.id} (${p.label}) was stopped: pi called a write tool on a file outside its throwaway worktree:\n${where}\nThe file may have been changed by that call. Check it now (git diff / git status for that path), restore it if the change is not part of the real agent's work, and tell the user what you found.`,
      }).catch(() => undefined)
    }
    return
  }
  $.ui.status(undefined)
  $.ui.toast(`${p.delegate} ${status}: ${p.label}`)
  // a pairs review: its `VERDICT <pair> <grade>` lines are recorded as ratings of those pi runs
  let rated = ''
  if (reviewJobs.delete(p.id) && status === 'done' && outFile) {
    try {
      const r = await $.process.run(['node', `${$.plugin.root}/scripts/shadow.mjs`, 'rate', '--from', outFile, '--by', `review:${ran ? ran[1] + (ran[2] ? '@' + ran[2] : '') : 'agy'}`], { timeoutMs: 30_000 })
      if (r.exitCode === 0 && r.stdout.trim()) rated = `\n${r.stdout.trim()} (/multiclaude:shadow shows them per rules version).`
    } catch { /* the review still arrives; the verdicts can be recorded by hand */ }
  }

  // Wake the chat: a plugin prompt starts a turn of its own once the session is idle.
  const diag = tail.filter(l => !l.startsWith('[+')).slice(-6).join('\n')
  const body = answer.length > WAKE_INLINE_CHARS
    ? answer.slice(0, 2000) + `\n…\n[answer is ${answer.length} chars — full text via dispatch_status({ id: "${p.id}" })${outFile ? ' or the file ' + outFile : ''}]`
    : answer
  const hint = status === 'done' ? ''
    : status === 'denied' ? '\nagy denied actions — re-dispatch with edit: true if the task needs commands/edits.'
    : status === 'usage' ? '\nBad usage (unknown model id / prompt too big) — check probe.mjs and re-dispatch.'
    : status === 'cancelled' ? '\nCancelled by dispatch_cancel.'
    : status === 'timeout' ? `\nTimed out at its limit${warnings ? ` after ${warnings} warning${warnings > 1 ? 's' : ''}` : ''} — partial edits may be in the tree (git status); re-dispatch with a larger timeout or a narrower task.`
    : `\nDispatch failed (exit ${code}) — see orchestrate §3 gate 0${/status=QUOTA/.test(proof) ? ': QUOTA → re-route per §5' : ''}.`
  const logged = status === 'done' || status === 'cancelled' ? '' : '\nLogged to the failure log — /multiclaude:failures shows why runs fail and what to change in the prompt.'
  // A trial delegate's result is never accepted unjudged: the wake asks for the gates and a grade.
  const looped = /status=LOOP/.test(proof)
  const trial = p.delegate !== 'pi' || status === 'usage' || /status=(QUOTA|CAPACITY|NO_RESULT)/.test(proof) ? ''
    : status === 'cancelled' ? `\nTRIAL delegate: if you stopped it because it was stuck or off-task, record that — dispatch_grade({ id: "${p.id}", grade: "fail", note: "why" }); partial edits may be in the tree (git status).`
    : `${looped ? '\nThe loop guard stopped it: partial edits may be in the tree (git status). Re-dispatch narrower (one file, the exact test command) or re-route to Codex / AGY.' : ''}\nTRIAL delegate — nothing from pi is accepted unjudged. Now: (1) run the §3 gates yourself: read the diff of what it touched, run the tests / build, check each claim of its report against the files; (2) record the verdict: dispatch_grade({ id: "${p.id}", grade: "pass" | "rework" | "fail", gates: "what you ran and what it showed", note: "why" }) — pass = accepted as delivered · rework = usable only after a fix · fail = thrown away.`
  void $.prompt.submit({
    text: `dispatch job ${p.id} (${p.delegate} · ${p.label}) ${status.toUpperCase()}\n${proof || diag}${hint}${logged}${trial}${rated}\n\n${body || '(no output)'}`,
  }).catch(() => undefined)
}

function pump($: EngineInterface) {
  if (pumping) return
  pumping = true
  try {
    while (queue.length && running.size - shadowLive < MAX_RUNNING) {
      const p = queue.shift()!
      running.set(p.id, { stop: () => undefined })   // reserve the slot until spawn registers the real stop
      void runJob($, p)
    }
    while (shadowQueue.length && shadowLive < 1) {
      const p = shadowQueue.shift()!
      shadowLive++
      running.set(p.id, { stop: () => undefined })
      void runJob($, p).catch(() => undefined).then(() => { shadowLive = Math.max(0, shadowLive - 1) })
    }
  } finally { pumping = false }
}

// Fold in runner jobs launched outside the tool (Bash, workflow nodes, forwarders):
// each wrote <id>.json under the jobs dir. Only files from this chat: written since it started and,
// when the runner stamped one, carrying this session's id.
type RunnerMeta = {
  id: string; delegate: Delegate; model: string | null; effort?: string | null; label: string
  status: Job['status']; startedAt: number; endedAt?: number; step?: string; proof?: string; updatedAt?: number
  /** The Claude Code session that started it (MC_SESSION_ID / CLAUDE_CODE_SESSION_ID); null from an older runner. */
  session?: string | null
  /** A shadow run: the job or agent id it runs beside (dispatch.mjs --shadow-of). */
  shadowOf?: string
}
// This chat's session id: the pane shows only jobs this chat started.
let mySession = ''
// $.store key (across sessions): set once the person has run /multiclaude:setup.
const ONBOARDED = 'onboarded'
const ONBOARD_TEXT = 'multiclaude is installed and has changed nothing in your setup. Run /multiclaude:setup for a read-only check; "setup apply --dry-run" lists what it would ADD (it never overwrites a value you set).'
async function scanRunnerJobs($: EngineInterface) {
  if (!jobsDir || scanning) return
  scanning = true
  try {
    const entries = await $.fs.list(jobsDir)
    const fresh = entries.filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.mtimeMs >= sessionStartedAt - 60_000)
    if (!fresh.length) return
    const list = await read($, jobs)
    const own = new Set(list.filter(j => j.source !== 'runner').map(j => j.id))
    const clearedAt = await read($, cleared)
    const metas: RunnerMeta[] = []
    for (const e of fresh) {
      const id = e.name.slice(0, -5)
      if (own.has(id)) continue   // the tool's own jobs are tracked live
      try {
        const m = JSON.parse(await $.fs.read(`${jobsDir}/${e.name}`)) as RunnerMeta
        if (m && m.session && mySession && m.session !== mySession) continue   // another chat's job
        if (m && m.status !== 'running' && m.status !== 'queued' && (m.endedAt ?? m.updatedAt ?? m.startedAt ?? 0) <= clearedAt) continue   // cleared from the pane
        metas.push(m)
      } catch { /* partial write */ }
    }
    if (!metas.length) return
    await update($, jobs, cur => {
      const byId = new Map(cur.map(j => [j.id, j] as const))
      for (const m of metas) {
        if (!m || !m.id) continue
        const prev = byId.get(m.id)
        const row: Job = {
          id: m.id, delegate: delegateOf(m.delegate), model: m.model ?? '(default band)', effort: m.effort ?? undefined,
          label: m.label ?? m.id, startedAt: m.startedAt ?? Date.now(), endedAt: m.endedAt, status: m.status ?? 'running',
          step: m.step ?? '', proof: m.proof ?? '', outFile: m.proof ? /\bout=([^\s\]]+)/.exec(m.proof)?.[1] : undefined, source: 'runner',
          ...(m.shadowOf ? { shadowOf: String(m.shadowOf) } : {}),
        }
        // A runner that died without finishing leaves 'running' behind: stale after 15 min without an update.
        if (row.status === 'running' && m.updatedAt && Date.now() - m.updatedAt > 15 * 60_000) { row.status = 'failed'; row.step = 'runner stopped reporting' }
        if (!prev || JSON.stringify(prev) !== JSON.stringify(row)) byId.set(m.id, row)
      }
      return [...byId.values()].slice(-60)
    })
  } catch { /* jobs dir absent or unreadable */ }
  finally { scanning = false }
}

// Drop finished rows and keep the jobs-dir scan from folding them back in.
async function clearFinished($: EngineInterface) {
  await update($, cleared, () => Date.now())
  await update($, jobs, l => l.filter(isLive))
}

// Cancel / extend, shared by the tools and the pane's buttons.
async function cancelJob($: EngineInterface, id: string) {
  const qi = queue.findIndex(p => p.id === id)
  if (qi >= 0) {
    queue.splice(qi, 1)
    await update($, jobs, list => list.map((j): Job => (j.id === id ? { ...j, status: 'cancelled', endedAt: Date.now(), step: 'cancelled before start' } : j)))
    return `job ${id} removed from the queue`
  }
  const r = running.get(id)
  if (r) { r.stop(); return `job ${id}: kill requested — its final status follows in the wake-up message` }
  // A runner this module did not start (backgrounded Bash, an mc-* forwarder, another session):
  // leave a request in the jobs dir — its runner polls for one every 2 s, stops the delegate
  // and records CANCELLED (dispatch.mjs --cancel does the same from a shell).
  const safe = String(id ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_')
  if (!safe) return 'dispatch_cancel needs { id }'
  if (!jobsDir) return `job ${safe} is not running under this tool, and the jobs dir is unknown — stop its runner process instead`
  let meta: RunnerMeta | undefined
  try { meta = JSON.parse(await $.fs.read(`${jobsDir}/${safe}.json`)) as RunnerMeta } catch { /* no such job file */ }
  if (!meta) return `no job ${safe}: not running under this tool and no job file in ${jobsDir}`
  if ((meta.status ?? 'running') !== 'running') return `job ${safe} is ${meta.status} — nothing to cancel`
  await $.fs.write(`${jobsDir}/${safe}.cancel`, String(Date.now()))
  return `job ${safe}: cancel requested — its runner stops the delegate within 2 s and records CANCELLED (dispatch_status({ id: "${safe}" }) shows it; a runner that already died never answers)`
}
const canCancel = (j: Job) => running.has(j.id) || queue.some(p => p.id === j.id) || (j.source === 'runner' && isLive(j))
async function extendJob($: EngineInterface, id: string, seconds: number) {
  const safe = String(id ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_')
  const sec = Math.round(Number(seconds))
  if (!safe || !(sec > 0)) return 'dispatch_extend needs { id, seconds > 0 }'
  if (!jobsDir) return 'jobs dir unknown — cannot reach the runner'
  const j = (await read($, jobs)).find(x => x.id === safe)
  if (j && !isLive(j)) return `job ${safe} is ${j.status} — nothing to extend`
  await $.fs.write(`${jobsDir}/${safe}.extend`, String(sec))
  return `job ${safe}: +${sec}s requested — the runner confirms with a ⏱ line in its transcript within 2 s`
}
// A job's transcript: the module's own log for tool jobs; the runner's .log file for the rest.
async function transcriptOf($: EngineInterface, id: string) {
  const own = logs.get(id)
  if (own?.length) return own
  if (!jobsDir) return []
  try { return (await $.fs.read(`${jobsDir}/${id}.log`)).split('\n').filter(Boolean) } catch { return [] }
}
async function answerOf($: EngineInterface, j: Job) {
  const a = answers.get(j.id)?.answer
  if (a !== undefined) return a
  if (j.outFile) { try { return (await $.fs.read(j.outFile)).trimEnd() } catch { /* gone */ } }
  return undefined
}
// First meaningful line of a finished job's answer, cached per job.
const resultLines = new Map<string, string>()
async function resultLine($: EngineInterface, j: Job) {
  const hit = resultLines.get(j.id)
  if (hit !== undefined) return hit
  const ans = await answerOf($, j)
  if (ans === undefined) return ''
  const line = ans.split('\n').map(l => l.replace(/^[\s#>*-]+|[*_`]/g, '').trim()).find(l => l.length > 3 && !/^(```|---)/.test(l)) ?? ''
  resultLines.set(j.id, line)
  return line
}
// Close the pane once every job has ended and `autoClose` seconds passed, only after a job
// ended while it was open, and never while the person has it focused.
async function maybeAutoClose($: EngineInterface) {
  if (!(cfg.autoClose > 0) || paneFocused) return
  const list = await read($, jobs)
  if (!list.length || list.some(isLive)) return
  const last = Math.max(...list.map(j => j.endedAt ?? 0))
  if (last < paneOpenedAt || Date.now() - last < cfg.autoClose * 1000) return
  if (!(await $.ui.panes()).some(p => p.id === PANE)) { paneOpenedAt = Date.now(); return }
  paneOpenedAt = Date.now()
  await $.ui.close({ id: PANE })
}

// ── Wallets pane: cached figures only (usage-snapshot --json never hits the network;
// a stale cache refreshes in the background), re-read every 30 s while the pane is open.
const WALLETS = 'wallets'
const wallets = atom({ plugin: 'multiclaude', key: 'wallets' } as const, null as Wallets | null, { shape: 'wallets-1' })
let walletsBusy = false
function openWallets($: EngineInterface) {
  void refreshWallets($)
  void read($, usageView).then(v => refreshUsage($, v.period)).catch(() => undefined)
  return $.ui.open({ id: WALLETS, title: 'Wallets' })
}
let walletsNextAt = 0
async function refreshWallets($: EngineInterface, opts: { refresh?: boolean } = {}) {
  if (walletsBusy) return
  walletsBusy = true
  walletsNextAt = Date.now() + 30_000
  try {
    // A Refresh re-reads every wallet now (usage-snapshot --force waits for the new figures);
    // plain --json only serves the cache, so the pane showed the old snapshot until a later poll.
    const node = (rel: string, ...a: string[]) => $.process.run(['node', `${$.plugin.root}/${rel}`, ...a], { timeoutMs: opts.refresh ? 150_000 : 20_000 })
    const [u, acc] = await Promise.all([
      node('scripts/usage-snapshot.mjs', '--json', ...(opts.refresh ? ['--force'] : [])).catch(() => null),
      node('scripts/accounts.mjs', 'list', '--json', ...(opts.refresh ? ['--refresh'] : [])).catch(() => null),
    ])
    type Facts = {
      ageSec?: number | null
      claude?: { pool: number; fiveHour: number | null; sevenDay: number | null; fiveHourReset?: number | null; active: string | null; auto: boolean }
      codex?: { windows: { label: string; pct: number | null }[]; exhausted?: boolean; until?: number | null } | null
      agy?: Record<string, { fiveHour: number | null; weekly: number | null; exhausted: boolean }> | null
      pi?: { installed?: boolean; today?: Partial<PiSpend>; d7?: Partial<PiSpend> } | null
    }
    const spend = (b?: Partial<PiSpend>): PiSpend => ({ usd: +(b?.usd ?? 0) || 0, runs: +(b?.runs ?? 0) || 0, tokens: +(b?.tokens ?? 0) || 0, approx: !!b?.approx })
    type Acc = { slot: string; email: string; alias?: string; active: boolean; disabled: boolean; dead?: boolean
      usage?: { fiveHour?: { pct: number; resetsAt: number | null }; sevenDay?: { pct: number; resetsAt: number | null } } | null }
    let f: Facts = {}
    try { f = JSON.parse(u?.stdout ?? '{}') } catch { /* cold */ }
    let accounts: Acc[] = []
    try { accounts = (JSON.parse(acc?.stdout ?? '{}').accounts ?? []) as Acc[] } catch { /* none */ }
    const k = f.claude
    const w: Wallets = {
      readAt: Date.now(),
      ageSec: f.ageSec ?? null,
      claude: k ? { pool: k.pool, fiveHour: { pct: k.fiveHour, resetsAt: k.fiveHourReset ?? null }, sevenDay: { pct: k.sevenDay }, active: k.active, auto: !!k.auto } : null,
      accounts: accounts.map(a => ({
        slot: String(a.slot), label: a.alias || a.email, active: !!a.active, disabled: !!a.disabled || !!a.dead,
        fiveHour: { pct: a.usage?.fiveHour?.pct ?? null, resetsAt: a.usage?.fiveHour?.resetsAt ?? null },
        sevenDay: { pct: a.usage?.sevenDay?.pct ?? null, resetsAt: a.usage?.sevenDay?.resetsAt ?? null },
      })),
      codex: f.codex?.windows ?? [],
      codexOut: f.codex?.exhausted ? { until: f.codex.until ?? null } : null,
      agy: Object.entries(f.agy ?? {}).map(([pool, p]) => ({ pool, fiveHour: p.fiveHour, weekly: p.weekly, exhausted: !!p.exhausted })),
      pi: f.pi && (f.pi.installed || (f.pi.d7?.runs ?? 0) > 0) ? { installed: !!f.pi.installed, today: spend(f.pi.today), d7: spend(f.pi.d7) } : null,
    }
    await update($, wallets, () => w).catch(() => undefined)
  } finally { walletsBusy = false }
}
// ── herdr mascots (optional companion, docs/herdr-mascots.md) ──
// Inside herdr, with the companion on (scripts/herdr-activity.mjs enable), every actor of
// this chat — the chat itself, each Claude subagent, each Codex / AGY job — gets a
// mascot-studio state from what it is doing. The 1 s tick writes the document
// mc-activity-<HC_TERMINAL_ID> to herdr-core (only on a change, ≤ 1 write / s); a herdr-app
// mod draws it. Time rules (done → idle → asleep) are the mod's; this side only reports.
type MascotActor = {
  id: string; kind: 'main' | 'subagent' | 'codex' | 'agy' | 'pi'; parent: string | null
  label: string; model: string; state: string; detail: string; since: number; ended: number | null
  /** A pi shadow: the id of the actor (job or subagent) whose task it repeats for the record. */
  shadowOf?: string
}
let mascotsOn = false
let mascotsCheckAt = 0
let mascotsSent = ''           // the last document written ('' = none yet, 'null' = cleared)
let mascotsBusy = false
let mascotsDirty = false
let mainLabel = 'chat'
let ctxPct: number | undefined
const actors = new Map<string, MascotActor>()
const jobSince = new Map<string, { state: string; since: number }>()
// The tick samples once a second, so a quick tool (a Read) would never be seen: a tool's state
// stays up at least this long before the actor goes back to thinking (a newer state replaces it).
const MASCOT_HOLD_MS = 1500
const thinkLater = new Map<string, { at: number; since: number }>()
// A change made from a hook is written right away when the last write is
// ≥ 400 ms old; otherwise the tick writes it. Keeps quick tools visible without a write storm.
let mascotsWroteAt = 0
const MASCOT_MIN_GAP_MS = 400
const TEST_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|mocha|go\s+test|cargo\s+test|dotnet\s+test|plugin\s+test|rspec|phpunit|tox|ctest)\b/i
const COMMIT_CMD = /\bgit\s+(?:commit|push|tag)\b|\bgh\s+(?:pr\s+create|release\s+create)\b/i
const SERVE_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|\b(?:vite|next\s+(?:dev|start)|expo\s+start|http-server)\b/i
const READ_CMD = /^\s*(?:cat|head|tail|less|bat|nl|wc|type|Get-Content|sed\s+-n)\b/i
const SEARCH_CMD = /^\s*(?:rg|grep|ag|find|fd|git\s+grep|ls|tree)\b/i
const commandState = (cmd: string) =>
  TEST_CMD.test(cmd) ? 'testing' : COMMIT_CMD.test(cmd) ? 'committing' : SERVE_CMD.test(cmd) ? 'server-running'
    : READ_CMD.test(cmd) ? 'reading' : SEARCH_CMD.test(cmd) ? 'searching-code' : 'running-commands'
/** A Claude Code tool call (main chat or subagent) → mascot state. */
const toolState = (tool: string, e: Record<string, unknown>): string => {
  if (/^(?:Read|NotebookRead|Skill)$/.test(tool)) return 'reading'
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'writing'
  if (/^(?:Grep|Glob|LSP)$/.test(tool)) return 'searching-code'
  if (/^(?:WebSearch|WebFetch)$/.test(tool)) return 'searching-web'
  if (/^(?:Bash|PowerShell)$/.test(tool)) return commandState(String(e.command ?? ''))
  if (/^(?:Agent|Task|Workflow|SendMessage)$/.test(tool) || /^mcp__multiclaude__dispatch$/.test(tool)) return 'directing-helpers'
  if (/^(?:TodoWrite|TaskCreate|TaskUpdate)$/.test(tool) || /work_state_write$/.test(tool)) return 'plan-progress'
  if (/^(?:AskUserQuestion|ExitPlanMode)$/.test(tool)) return 'waiting-for-you'
  if (/^mcp__/.test(tool)) return /web|fetch|url|browse/i.test(tool) ? 'searching-web' : /search|query|find|outline|unfold/i.test(tool) ? 'searching-code' : 'using-tool'
  return 'using-tool'
}
/** A runner progress line (dispatch.mjs: `$ cmd`, `± files`, `⌕ web`, `⚙ tool arg`, `▸`/`💬` narration, `✗ error`) → mascot state. */
const stepState = (step: string): string => {
  const s = step.trim()
  if (s.startsWith('$ ')) return commandState(s.slice(2))
  if (s.startsWith('± ')) return 'writing'
  if (s.startsWith('⌕')) return 'searching-web'
  if (s.startsWith('✗')) return 'error'
  const m = /^⚙\s+(\S+)(?:\s+(.*))?$/u.exec(s)
  if (!m) return 'thinking'
  const name = m[1] ?? '', arg = m[2] ?? ''
  if (/run_command|command|shell|exec|^bash$/i.test(name)) return commandState(arg)
  if (/view_file|read|list_dir|view_code|open|^ls$/i.test(name)) return 'reading'
  if (/write|replace|edit|create_file|patch/i.test(name)) return 'writing'
  if (/web|url|browser|fetch/i.test(name)) return 'searching-web'
  if (/grep|find|search|codebase/i.test(name)) return 'searching-code'
  return 'using-tool'
}
const actorOf = (agentId: string | undefined) => (agentId === undefined ? 'main' : agentRows.has(agentId) ? agentId : undefined)
const setActor = (id: string | undefined, patch: Partial<MascotActor>, $: EngineInterface) => {
  if (!mascotsOn || !id) return
  const now = Date.now()
  const a = actors.get(id) ?? {
    id, kind: id === 'main' ? 'main' : 'subagent', parent: id === 'main' ? null : 'main',
    label: id === 'main' ? mainLabel : 'subagent', model: '', state: 'thinking', detail: '', since: now, ended: null,
  } as MascotActor
  const nextA: MascotActor = { ...a, ...patch }
  if (patch.state && patch.state !== a.state) nextA.since = now
  if (patch.detail !== undefined) nextA.detail = patch.detail.replace(/\s+/g, ' ').slice(0, 100)
  actors.set(id, nextA)
  mascotsDirty = true
  if (!mascotsBusy && now - mascotsWroteAt >= MASCOT_MIN_GAP_MS) void publishMascots($, false).catch(() => undefined)
}
const jobActor = (j: Job, now: number): MascotActor | null => {
  if (j.source === 'agent' || j.delegate === 'claude') return null
  const live = isLive(j)
  if (!live && now - (j.endedAt ?? now) > 60_000) return null
  const state = j.status === 'queued' ? 'thinking' : live ? stepState(j.step) : j.status === 'done' ? 'done'
    : /status=BUDGET/.test(j.proof) ? 'context-nearly-full' : 'error'
  const prev = jobSince.get(j.id)
  const since = prev && prev.state === state ? prev.since : now
  jobSince.set(j.id, { state, since })
  return {
    id: j.id, kind: j.delegate, parent: j.parent ?? 'main', label: j.label.slice(0, 60),
    model: j.model + (j.effort ? `@${j.effort}` : ''), state, detail: j.step.replace(/\s+/g, ' ').slice(0, 100),
    since, ended: live ? null : (j.endedAt ?? now),
    ...(j.shadowOf ? { shadowOf: j.shadowOf } : {}),
  }
}
// Asked at session.start and every minute after (inside herdr only): the flag can be
// switched from the Setup pane or another session.
async function checkMascots($: EngineInterface) {
  mascotsCheckAt = Date.now() + 60_000
  if (!inHerdr) { mascotsOn = false; return }
  let on = false
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/herdr-activity.mjs`, '--enabled'], { timeoutMs: 15_000 })
    on = r.exitCode === 0 && r.stdout.trim() === 'on'
  } catch { /* stays off */ }
  if (on && !mascotsOn) { mascotsOn = true; setActor('main', { state: 'greeting', detail: '' }, $) }
  else if (!on && mascotsOn) { mascotsOn = false; actors.clear(); await writeMascots($, null) }
}
async function writeMascots($: EngineInterface, doc: unknown, key = JSON.stringify(doc)) {
  if (mascotsBusy || key === mascotsSent) return
  mascotsBusy = true
  mascotsWroteAt = Date.now()
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/herdr-activity.mjs`, 'set'], { stdin: JSON.stringify(doc), timeoutMs: 15_000 })
    if (r.exitCode === 0) mascotsSent = key
  } catch { /* next tick tries again */ } finally { mascotsBusy = false }
}
// The tick: build the document (subagents + jobs from the jobs atom), write it when it changed.
async function publishMascots($: EngineInterface, poll: boolean) {
  if (!mascotsOn || mascotsBusy) return
  // A tool that ended inside its hold goes back to thinking now, unless something newer came.
  for (const [id, p] of thinkLater) {
    if (Date.now() < p.at) continue
    thinkLater.delete(id)
    const a = actors.get(id)
    if (a && a.since === p.since && a.ended == null) setActor(id, { state: 'thinking', detail: '' }, $)
  }
  if (!mascotsDirty && !poll) return
  mascotsDirty = false
  const now = Date.now()
  for (const [id, a] of actors) if (a.ended && now - a.ended > 60_000) actors.delete(id)
  const list = await read($, jobs).catch(() => [] as Job[])
  const jobActors = list.map(j => jobActor(j, now)).filter((a): a is MascotActor => !!a)
  const doc = {
    v: 1, terminal: '', at: now,
    actors: [...actors.values(), ...jobActors].sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : 0)),
    ...(ctxPct !== undefined ? { context: { usedPct: ctxPct } } : {}),
  }
  const key = JSON.stringify({ ...doc, at: 0 })
  if (key === mascotsSent) return
  await writeMascots($, doc, key)
}
// ── Setup pane: the companions menu (/multiclaude:setup companions). setup.mjs
// `companions --json` lists the optional extras (superpowers, claude-mem, the codex
// and agy plugins, ccstatusline; under "herdr" the herdr-mascots publisher) with their state; a key installs or removes one
// through `setup.mjs companions add|remove <name>` (plugins via the claude CLI,
// ccstatusline via apply --ccstatusline / our own status line back). Plugin
// changes load at the next Claude Code start; the pane says so.
const COMPANIONS = 'multiclaude-setup'
const companions = atom({ plugin: 'multiclaude', key: 'companions' } as const, null as Companions | null, { shape: 'companions-1' })
function openCompanions($: EngineInterface) {
  void refreshCompanions($)
  return $.ui.open({ id: COMPANIONS, title: 'multiclaude setup — companions' })
}
async function refreshCompanions($: EngineInterface, patch: Partial<Companions> = {}) {
  let next: Companions
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/setup.mjs`, 'companions', '--json'], { timeoutMs: 30_000 })
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.exitCode}`)
    const j = JSON.parse(r.stdout) as { cli: boolean; companions: Companions['list'] }
    next = { readAt: Date.now(), cli: !!j.cli, list: j.companions ?? [], ...patch }
  } catch (err) {
    const prev = await read($, companions).catch(() => null)
    next = { ...(prev ?? { readAt: Date.now(), cli: false, list: [] }), busy: undefined, ...patch, error: err instanceof Error ? err.message : String(err) }
  }
  await update($, companions, () => next).catch(() => undefined)
}
async function companionAction($: EngineInterface, action: 'add' | 'remove', name: string) {
  const cur = await read($, companions).catch(() => null)
  if (cur?.busy) return
  await update($, companions, c => ({ ...(c ?? { readAt: Date.now(), cli: false, list: [] }), busy: name, note: undefined, error: undefined })).catch(() => undefined)
  $.ui.status(`multiclaude: ${action === 'add' ? 'installing' : 'removing'} ${name}…`)
  let note: string
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/setup.mjs`, 'companions', action, name], { timeoutMs: 300_000 })
    const lines = (r.stdout + (r.exitCode === 0 ? '' : '\n' + r.stderr)).trim().split('\n').map(l => l.trim()).filter(Boolean)
    note = lines.slice(-2).join(' · ') || (r.exitCode === 0 ? 'done' : `exit ${r.exitCode}`)
    $.ui.toast(r.exitCode === 0 ? `${name}: ${action === 'add' ? 'installed' : 'removed'}` : `${name}: ${action} failed — ${lines.pop() ?? `exit ${r.exitCode}`}`)
  } catch (err) {
    note = `${action} ${name}: ${err instanceof Error ? err.message : String(err)}`
  } finally { $.ui.status(undefined) }
  if (name === 'herdr-mascots') await checkMascots($)   // on / off in this session right away
  await refreshCompanions($, { busy: undefined, note })
}
// ── Usage tracker (Wallets pane section + /multiclaude:usage): tracker.mjs scans what
// the CLIs recorded (incremental) and reports tokens + ≈ API list-price spend per
// wallet, account and model. Re-scanned every 5 min while the pane is open.
const usage = atom({ plugin: 'multiclaude', key: 'usage' } as const, null as Usage | null, { shape: 'usage-1' })
const USAGE_VIEW_KEY = 'usageView'
const PERIOD_ORDER: UsagePeriod[] = ['today', '7d', '30d', 'all']
const usageView = atom({ plugin: 'multiclaude', key: 'usageView' } as const, { period: '7d', split: false } as UsageView, { shape: 'usage-view-1' })
let usageBusy = false
let usageNextAt = 0
let usagePending: UsagePeriod | null = null
async function refreshUsage($: EngineInterface, period: UsagePeriod, opts: { scan?: boolean } = {}) {
  if (usageBusy) { usagePending = period; return }
  usageBusy = true
  usageNextAt = Date.now() + 300_000
  try {
    $.ui.invalidate('ui.render')
    type Raw = { input: number; cacheRead: number; cacheWrite?: number; cacheWrite1h?: number; out: number; total: number; usd: number; unpriced: number; calls: number }
    const row = (x: Raw): UsageRow => ({ input: x.input, cached: x.cacheRead + (x.cacheWrite ?? 0) + (x.cacheWrite1h ?? 0), out: x.out, total: x.total, usd: x.usd, unpriced: x.unpriced, calls: x.calls })
    let next: Usage
    try {
      const r = await $.process.run(['node', `${$.plugin.root}/scripts/tracker.mjs`, period, '--json', ...(opts.scan === false ? ['--no-scan'] : [])], { timeoutMs: 180_000 })
      if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.exitCode}`)
      const j = JSON.parse(r.stdout) as {
        from?: string | null; firstDay?: string | null; scannedAt?: number | null; totals: Raw
        wallets: (Raw & { wallet: string })[]; accounts: (Raw & { wallet: string; label: string })[]; models: (Raw & { wallet: string; model: string; priced: boolean })[]
      }
      next = {
        readAt: Date.now(), period, from: (period === 'all' ? j.firstDay : j.from) ?? null, scannedAt: j.scannedAt ?? null,
        totals: row(j.totals),
        wallets: j.wallets.map(w => ({ ...row(w), wallet: w.wallet })),
        accounts: j.accounts.map(a => ({ ...row(a), wallet: a.wallet, label: a.label })),
        models: j.models.slice(0, 12).map(m => ({ ...row(m), wallet: m.wallet, model: m.model, priced: !!m.priced })),
        modelCount: j.models.length,
      }
    } catch (err) {
      const prev = await read($, usage).catch(() => null)
      next = { ...(prev ?? { readAt: Date.now(), period, from: null, scannedAt: null, totals: { input: 0, cached: 0, out: 0, total: 0, usd: 0, unpriced: 0, calls: 0 }, wallets: [], accounts: [], models: [], modelCount: 0 }),
        error: err instanceof Error ? err.message : String(err) }
    }
    await update($, usage, () => next).catch(() => undefined)
  } finally {
    usageBusy = false
    $.ui.invalidate('ui.render')
    if (usagePending) { const p = usagePending; usagePending = null; if (p !== (await read($, usage).catch(() => null))?.period) void refreshUsage($, p, { scan: false }) }
  }
}
const tok = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)))
const dollars = (r: UsageRow) => (r.usd > 0 || !r.unpriced ? '$' + (r.usd >= 100 ? r.usd.toFixed(0) : r.usd.toFixed(2)) : '–') + (r.usd > 0 && r.unpriced ? '+' : '')
const pctColor = (v: number | null) => (v == null ? 'subtle' : v >= 85 ? 'error' : v >= 60 ? 'warning' : 'success')
const bar = (v: number | null, width: number) => {
  const n = v == null ? 0 : Math.max(0, Math.min(width, Math.round((v / 100) * width)))
  return ['█'.repeat(n), '░'.repeat(width - n)] as const
}
const shortUntil = (at: number | null | undefined) => {
  if (!at || at <= Date.now()) return ''
  const m = Math.round((at - Date.now()) / 60_000)
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
}

// `apply --set env.X="a b"` → ['apply', '--set', 'env.X=a b']
const splitArgs = (args: string | undefined) =>
  ((args ?? "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(t => t.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))

// Run one of the plugin's report scripts and hand its output back as the
// command's text. `$.process.run` in flight does not count against the hook's
// own-time budget, so a slow read (ccusage, agy /usage, a smoke test) is fine.
async function runScript($: EngineInterface, rel: string, args: string[], busy: string, timeoutMs: number) {
  $.ui.status(`multiclaude: ${busy}`)
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/${rel}`, ...args], { timeoutMs })
    // A multi-line block starts on its own line: the host draws the first line
    // after a `⎿ ` prefix, which would shift a leading rule to the right.
    const block = (s: string) => (s.includes('\n') ? '\n' + s : s)
    const out = block(r.stdout.trimEnd())
    const errTail = r.stderr.trim().split('\n').slice(-12).join('\n')
    if (r.exitCode === 0) return { text: out || errTail || '(no output)' }
    return { text: `${out}${out ? '\n\n' : ''}exit ${r.exitCode}${errTail ? '\n' + errTail : ''}` }
  } catch (err) {
    return { text: `${rel} did not finish: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    $.ui.status(undefined)
  }
}

// After a bare /multiclaude:orchestrate in a chat with work under way: ask
// whether to split that work across the delegates now; a yes submits the
// request as the person's own prompt.
const SPLIT_YES = 'Split it now'
const SPLIT_PROMPT =
  'Split the work currently being planned in this conversation across the delegates now, following the orchestrate rules: ' +
  'break it into independent tasks, pick a band for each (§1–§2), dispatch the non-overlapping ones in parallel with the dispatch tool, ' +
  'and keep only classification, verification and synthesis here.'
async function offerSplit($: EngineInterface) {
  const a = await $.ui.ask('Orchestration is on. Split the work currently being planned across the delegates now?', {
    header: 'Orchestrate',
    options: [SPLIT_YES, 'Not yet'],
  })
  if (a === SPLIT_YES) await $.prompt.submit({ text: SPLIT_PROMPT, asUser: true })
}

// Queue one dispatch job (the dispatch tool's body; /multiclaude:failures review uses it too).
type DispatchInput = {
  delegate: Delegate; prompt: string; model?: string; effort?: string; edit?: boolean
  sandbox?: string; label?: string; cwd?: string; timeout?: number
  worktree?: boolean; maxTokens?: number; fallback?: string
  /** pi only: the loop guard's step cap, and how often a checkpoint wakes the chat. */
  maxSteps?: number; checkpoint?: number
  /** The Claude subagent that called dispatch (tool.call's agentId); its row folds into this job. */
  parent?: string
  /** The dispatch tool sets it: with setting 8 on, a pi shadow runs beside this job and both are recorded. */
  shadow?: boolean
}
async function enqueueDispatch($: EngineInterface, input: DispatchInput): Promise<{ deny: string } | { id: string; text: string }> {
  const delegate = delegateOf(input.delegate)
  const prompt = String(input.prompt ?? '')
  if (!prompt.trim()) return { deny: 'dispatch: empty prompt' } as const
  const id = shortId()
  const label = (input.label ?? prompt.replace(/\s+/g, ' ').slice(0, 60)).slice(0, 60)

  const argv = ['node', `${$.plugin.root}/scripts/dispatch.mjs`, delegate, '--job', id, '--label', label]
  if (input.model) argv.push('--model', String(input.model))
  if (input.effort) argv.push('--effort', String(input.effort))   // pi: the runner drops it for an id that carries its effort
  if (delegate !== 'codex' && input.edit) argv.push('--edit')
  if (delegate === 'codex' && input.sandbox) argv.push('--sandbox', String(input.sandbox))
  if (input.timeout) argv.push('--timeout', String(Math.round(input.timeout)))
  if (input.worktree) argv.push('--worktree')
  if (delegate !== 'codex' && input.maxTokens != null) argv.push('--max-tokens', String(Math.round(input.maxTokens)))
  if (delegate === 'pi' && input.maxSteps != null) argv.push('--max-steps', String(Math.max(0, Math.round(input.maxSteps))))
  if (delegate === 'pi' && input.checkpoint != null) argv.push('--checkpoint', String(Math.max(0, Math.round(input.checkpoint))))
  if (delegate === 'agy' && input.fallback) argv.push('--fallback', String(input.fallback))
  const shadowIt = !!input.shadow && delegate !== 'pi' && !!cfg.shadow && piReady === true && prompt.length <= SHADOW_PROMPT_MAX && shadowQueue.length < SHADOW_WAITING
  if (shadowIt) argv.push('--reference')

  const job: Job = {
    id, delegate, model: input.model ?? '(default band)', effort: input.effort, label, brief: briefOf(prompt),
    startedAt: Date.now(), status: 'queued', step: 'queued', proof: '', source: 'tool',
    ...(input.parent ? { parent: input.parent } : {}),
  }
  const before = await read($, jobs)
  const poolFor = (d: Job['delegate'], model: string) => (d === 'codex' || d === 'pi' ? d : poolOf(model))
  const pool = poolFor(delegate, job.model)
  const sharing = before.filter(j => isLive(j) && j.delegate !== 'claude' && poolFor(j.delegate, j.model) === pool)
  await update($, jobs, list => [...list.filter(j => j.id !== id), job].slice(-80))
  queue.push({ id, argv, cwd: input.cwd ? String(input.cwd) : undefined, prompt, delegate, label })
  if (autoOpen(cfg.openOnDispatch)) void openPane($)
  pump($)
  const shadowId = shadowIt
    ? await enqueueShadow($, {
      of: id, prompt, label, band: shadowBand(delegate, input.model, input.effort), cwd: input.cwd ? String(input.cwd) : undefined,
      edit: delegate === 'codex' ? input.sandbox !== 'read-only' : !!input.edit,
    }).catch(() => null)
    : null
  return {
    id,
    text:
    `dispatched job ${id}: ${delegate} ${job.model}${job.effort ? '@' + job.effort : ''} — ${label}\n` +
    'Running in the background on the delegate\'s quota. You will be woken with the proof line + answer when it finishes; ' +
    `do not poll. Progress + transcript: dispatch_status({ id: "${id}" }). Cancel: dispatch_cancel({ id: "${id}" }).` +
    (sharing.length
      ? `\nNote: ${sharing.length} other job(s) already draw on the ${pool === 'codex' ? 'Codex' : pool === 'pi' ? 'pi' : 'AGY ' + pool} pool (${sharing.map(j => j.id).join(', ')}). Parallel agentic runs drain a pool fast — two Claude-pool edit jobs once emptied a 5h window in 150 s.`
      : '') +
    (shadowId
      ? `\nShadow: pi job ${shadowId} runs the same task for the record (setting 8). It works in a throwaway worktree or read-only, changes nothing in your tree, never wakes you and needs no grade — do not wait for it or use its result.`
      : '') +
    (delegate === 'pi'
      ? `\nTRIAL delegate: you are woken at every checkpoint to judge the run (cancel one that is going nowhere), and its result must pass your gates and be graded — dispatch_grade({ id: "${id}", grade }).`
      : ''),
  }
}

// Every job file in the jobs dir (any session, 14-day retention), newest first.
async function listAllJobs($: EngineInterface) {
  if (!jobsDir) return 'jobs dir unknown'
  const entries = (await $.fs.list(jobsDir)).filter(e => e.kind === 'file' && e.name.endsWith('.json')).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 200)
  const now = Date.now()
  const rows: string[] = []
  for (const e of entries) {
    try {
      const m = JSON.parse(await $.fs.read(`${jobsDir}/${e.name}`)) as RunnerMeta
      const when = new Date(m.startedAt).toISOString().slice(0, 16).replace('T', ' ')
      rows.push(`${m.id} · ${when} · ${m.status} · ${m.delegate} ${m.model}${m.effort ? '@' + m.effort : ''} · ${fmtDur(Math.max(0, Math.round(((m.endedAt ?? now) - m.startedAt) / 1000)))} · ${m.label}${m.proof ? '\n    ' + m.proof : ''}`)
    } catch { /* partial write */ }
  }
  return rows.length ? `${rows.length} job(s) in ${jobsDir} (answers in <id>.md, transcripts in <id>.log):\n${rows.join('\n')}` : 'no job files'
}

// ── Claude accounts auto-switch (scripts/accounts.mjs) ──
// Every 60 s: `accounts.mjs auto --once --json` balances the accounts' weekly
// usage (the login goes to the account furthest behind an even weekly pace) and
// moves the default login away from an account at its line. The script holds when fewer than two accounts are
// usable or auto-switch is off; then the tick backs off to every 10 min.
let autoNextAt = Date.now() + 20_000
let autoBusy = false
async function autoSwitchTick($: EngineInterface) {
  if (autoBusy) return
  autoBusy = true
  autoNextAt = Date.now() + 60_000
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/accounts.mjs`, 'auto', '--once', '--json'], { timeoutMs: 45_000 })
    const line = r.stdout.trim().split('\n').pop() ?? ''
    let ev: { action?: string; to?: string; email?: string; reason?: string } = {}
    try { ev = JSON.parse(line) } catch { /* no JSON */ }
    if (ev.action === 'switch') $.ui.toast(`Claude account → #${ev.to} ${ev.email ?? ''} (${ev.reason ?? 'auto'})`)
    else if (/fewer than two|disabled/.test(ev.reason ?? '')) autoNextAt = Date.now() + 600_000
  } catch { autoNextAt = Date.now() + 300_000 }
  finally { autoBusy = false }
}

// ── /multiclaude:help: one pane with every command, pane hotkey and model tool ──
// The same data prints as text where the pane cannot be placed (and is the
// skills/help/SKILL.md fallback's content; keep both in step).
const HELP = 'multiclaude-help'
type HelpRow = { name: string, args?: string, what: string }
const HELP_COMMANDS: HelpRow[] = [
  { name: '/multiclaude:orchestrate', args: '[task]', what: 'Route work to Codex / AGY first. Bare: arms it for this chat with no model turn and prints the probe.' },
  { name: '/multiclaude:setup', args: '[companions | apply [--dry-run | --companions | --preferences | --full | --no-statusline | --ccstatusline]]', what: 'Check the environment (read-only), or add what is missing: plugin wiring and the status line. Add-only, with a backup. "companions" opens a pane to install / remove the optional companions.' },
  { name: '/multiclaude:probe', args: '[--smoke]', what: 'Which delegates are up, and the model id each band maps to today.' },
  { name: '/multiclaude:quota', what: 'Used % and resets per wallet: Codex, Claude (each account), AGY pools; pi (no quota: ∞) with its spend today and over 7 days.' },
  { name: '/multiclaude:usage', args: '[today | 7d | 30d | all]', what: 'Tokens and ≈ API $ per wallet, account and model.' },
  { name: '/multiclaude:failures', args: '[N] [--since 7d] | review', what: 'Failed delegate runs and what to change; review asks AGY to propose prompt fixes.' },
  { name: '/multiclaude:scorecard', args: '[7d | 30d | all] [--delegate pi]', what: 'How each delegate × model does: runner outcomes, the orchestrator\'s grades, bake-offs, and the verdict on a trial delegate (pi).' },
  { name: '/multiclaude:shadow', args: '[7d | 30d | all] | on | off | pair <id> | rate <id> <grade> | rules | review [N]', what: 'Shadow runs: with it on, every dispatch (Codex / AGY) and every Claude subagent also runs once on pi, for the record only. Shows how pi did per rules version beside the real agents, with every rating; rate records yours; review asks AGY for verdicts and changes to the pi working rules.' },
  { name: '/multiclaude:accounts', args: 'list | add | switch [id] | auto --once | config …', what: 'Several Claude logins pooled as one wallet: add, switch, auto-switch (off by default; it balances the accounts\' weekly usage and leaves an account at its 5h or weekly line).' },
  { name: '/delegates', args: '[settings]', what: 'Pane: live Codex / AGY / pi dispatches and Claude subagents.' },
  { name: '/wallets', what: 'Pane: usage bars per wallet and account, pi (∞) with its spend, token usage and ≈ API spend.' },
  { name: '/multiclaude:help', what: 'This help.' },
]
const HELP_KEYS: HelpRow[] = [
  { name: 'Delegates', what: '1–9 open a job · b back · x cancel · e +5 min · s settings (… 7 wallet rows in the status line on/off · 8 shadow every agent with pi) · t scorecard (p period) · c clear finished · h help' },
  { name: 'Wallets', what: 'r refresh · 1–9 switch Claude account · p period · i in / out split · h help' },
  { name: 'Setup', what: '1–6 install / remove a companion (superpowers, claude-mem, codex and agy plugins, ccstatusline; herdr: herdr-mascots) · r refresh · h help' },
  { name: 'Help', what: 'd Delegates · w Wallets' },
  { name: 'focus', what: 'ctrl+x tab moves focus into a pane; its hotkeys work while it has focus' },
]
const HELP_TOOLS: HelpRow[] = [
  { name: 'dispatch', what: 'start a Codex / AGY / pi job (non-blocking); the answer wakes the chat (a pi job also at every checkpoint)' },
  { name: 'dispatch_status', what: 'progress, live transcript, the full answer' },
  { name: 'dispatch_cancel · dispatch_extend', what: 'stop a job (also a runner job started from Bash) · add time (offered at 80 % of the timeout, again after each extension)' },
  { name: 'dispatch_grade', what: 'the orchestrator\'s verdict on a finished job after its gates: pass · rework · fail (required for every pi job; feeds the scorecard)' },
]
const HELP_NOTES: HelpRow[] = [
  { name: 'status line', what: 'Model | Ctx | git branch | (+ins,-del), then the wallets as usage bars stretched to the width: Claude 5h / wk (+ account pool) and Codex on one row, the Antigravity pools below (one row per provider when narrow), pi ∞ with its spend today · 7d at the end of the last row when it fits. Every % is USED, green → yellow (60) → red (85); 5h windows count down, weekly ones show weekday + hour. Installed by /multiclaude:setup apply; apply --ccstatusline puts ccstatusline\'s configurable session line on top. Inside herdr the wallet rows hide themselves (MULTICLAUDE_WALLET_ROWS=on shows them).' },
  { name: 'herdr', what: 'Inside herdr (HC_TERMINAL_SOCKET names a herdr socket) multiclaude steps aside: herdr\'s panels show the jobs and wallets, so no pane opens by itself (/delegates, /wallets still open one) and the status line has no wallet rows. MULTICLAUDE_HERDR=0|1 forces it off / on. The herdr-mascots companion (Setup pane, herdr section) publishes what the chat, each subagent and each Codex / AGY / pi job is doing as the herdr-core document mc-activity-<terminal>; a herdr-app mod draws a mascot per agent (docs/herdr-mascots.md). Claude Code in WSL under a Windows herdr only knows it is inside herdr when WSLENV forwards HC_TERMINAL_SOCKET/u:HC_TERMINAL_ID/u:HC_SCOPE/u: /multiclaude:setup flags it, setup apply on Windows adds them to the user WSLENV (restart herdr). In WSL, herdr-mascots reaches herdr through hc.exe (WSL interop).' },
  { name: 'bands', what: 'codex mech · std · hard · max — agy opus · sonnet · gem-top · gem-hi · gem-med · gem-lo — pi lo · med · hi (ids: /multiclaude:probe)' },
  { name: 'pi (trial)', what: 'Optional third delegate: the pi harness on a self-hosted model, listed by the probe only when pi is installed. Small coding tasks only. The runner stops a looping run (same call 3×, same reply twice, 4 tool errors in a row, step / token cap → LOOP), a checkpoint every 8 tool steps wakes the chat to judge it, and every result is gated and graded (dispatch_grade). /multiclaude:scorecard gives the verdict after 5 graded runs: VIABLE · MARGINAL · NOT VIABLE.' },
  { name: 'shadows', what: 'Off by default (setting 8 or /multiclaude:shadow on). A shadow is a pi run of a task another agent is doing for real: one at a time, no shell, edits only in a throwaway worktree, never a wake, never a grade, not on the scorecard. Both ends are recorded on this machine only (~/.local/share/multiclaude/shadow/records.jsonl, secrets scrubbed): prompt, answer, patch, and for pi every step with its timing and the version of the working rules it got. Your own rules go in ~/.config/multiclaude/pi-rules.md (one "- rule" per line; every pi run gets them). Each shadow is a paid pi run.' },
  { name: 'ratings', what: 'Every judgement of a pi run is kept beside those records (ratings.jsonl): each dispatch_grade, each verdict of a /multiclaude:shadow review, each /multiclaude:shadow rate <id> <pass|rework|fail>. pi runs of their own are recorded like shadows, so a rating keeps the run it judged. Only dispatch_grade counts on the scorecard.' },
  { name: 'cost', what: 'Every finished job has a dollar figure on its proof line and in the Delegates pane: cost=$… is what the provider billed (pi reports it), cost≈$… the run\'s tokens at API list price — a comparison figure, never a bill. A Claude subagent row gets ≈$… from its transcript the same way, and the pane sums the rows it lists. No price known for the model: no figure. MULTICLAUDE_PRICES=off keeps the price table off the network.' },
  { name: 'files', what: '~/.cache/multiclaude (jobs 14 days, failures.jsonl, runs.jsonl + grades.jsonl for the scorecard, tracker.json) · ~/.local/share/multiclaude (accounts, status-line launcher, shadow/records.jsonl + ratings.jsonl) · ~/.config/multiclaude (prices.json overrides, pi-rules.md)' },
]
const HELP_SECTIONS: [string, HelpRow[]][] = [['Commands', HELP_COMMANDS], ['Pane hotkeys', HELP_KEYS], ['Tools the model calls', HELP_TOOLS], ['Good to know', HELP_NOTES]]
function helpText(): string {
  const out = ['[multiclaude help]', '']
  for (const [title, rows] of HELP_SECTIONS) {
    out.push(`▌ ${title}`)
    for (const r of rows) out.push(`  ${r.name}${r.args ? ' ' + r.args : ''}`, `      ${r.what}`)
    out.push('')
  }
  return out.join('\n').trimEnd()
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionStartedAt = Date.now()
    try { mySession = await $.session.id() } catch { mySession = '' }
    await $.tool.register({ name: 'dispatch', description: DISPATCH_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.tool.register({
      name: 'dispatch_status', description: STATUS_DESCRIPTION, isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'job id from dispatch; omit to list all jobs' },
          all: { type: 'boolean', description: 'with no id: list every job kept in the jobs dir (14 days), not only this session\'s' },
        },
      },
    })
    await $.tool.register({
      name: 'dispatch_cancel', description: CANCEL_DESCRIPTION, isDeferred: false,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    await $.tool.register({
      name: 'dispatch_grade', description: GRADE_DESCRIPTION, isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'job id of the finished run' },
          grade: { type: 'string', enum: ['pass', 'rework', 'fail'], description: 'pass = accepted as delivered · rework = usable only after a fix · fail = thrown away' },
          gates: { type: 'string', description: 'What you checked and what it showed, e.g. "node --test 14/14 green; diff read; report matches the files".' },
          note: { type: 'string', description: 'Why this grade: what was wrong or missing, or what stood out.' },
          vs: { type: 'string', description: 'Job id of another model\'s run of the same task (a bake-off pair).' },
          kind: { type: 'string', description: 'Task kind for the record, e.g. bugfix, feature, refactor, tests, docs.' },
        },
        required: ['id', 'grade'],
      },
    })
    await $.tool.register({
      name: 'dispatch_extend', description: EXTEND_DESCRIPTION, isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'job id' },
          seconds: { type: 'number', description: 'seconds to add to the job\'s timeout' },
        },
        required: ['id', 'seconds'],
      },
    })
    await $.command.register({
      name: 'delegates',
      description: 'Open the Delegates pane: live agy / codex / pi dispatches with model, elapsed time and current step',
      immediate: true,   // opens mid-turn too, without waiting for (or starting) a model turn
      argumentHint: '[settings]',
    })
    await $.command.register({
      name: 'multiclaude:help',
      description: 'multiclaude help: every command, pane hotkey and model tool, in a pane',
      immediate: true,
    }).catch(() => undefined)
    await $.command.register({
      name: 'wallets',
      description: 'Open the Wallets pane: live Claude (per account) / Codex / AGY usage bars, from the cached snapshot',
      immediate: true,
    })
    // Pane settings saved in an earlier session.
    try {
      const saved = (await $.store.get(SETTINGS_KEY)) as Partial<Settings> | undefined
      cfg = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) }
    } catch { cfg = DEFAULT_SETTINGS }
    await update($, settings, () => cfg).catch(() => undefined)
    try {
      const uv = (await $.store.get(USAGE_VIEW_KEY)) as Partial<UsageView> | undefined
      if (uv && typeof uv === 'object') await update($, usageView, v => ({ period: PERIOD_ORDER.includes(uv.period as UsagePeriod) ? uv.period as UsagePeriod : v.period, split: typeof uv.split === 'boolean' ? uv.split : v.split }))
    } catch { /* defaults */ }
    try {
      const r = await $.process.run(['node', `${$.plugin.root}/scripts/dispatch.mjs`, '--jobs-dir'], { timeoutMs: 15_000 })
      jobsDir = r.exitCode === 0 ? r.stdout.trim() : ''
    } catch { jobsDir = '' }
    try {
      const r = await $.process.run(['node', `${$.plugin.root}/scripts/usage-snapshot.mjs`, '--herdr'], { timeoutMs: 15_000 })
      inHerdr = r.exitCode === 0 && r.stdout.trim() === 'herdr'
    } catch { inHerdr = false }
    mainLabel = (e.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || 'chat'
    if (cfg.shadow) void checkPi($)
    if (inHerdr) void checkMascots($)
    if (cfg.statusline === false) void syncWalletRows($)   // the flag file follows the saved setting (a cleared cache dir, another machine)
    // Onboarding: until the person has run /multiclaude:setup once, say plainly
    // that nothing in their setup was changed and where to look first.
    const onboarded = await $.store.get(ONBOARDED).catch(() => true)
    if (!onboarded) {
      $.ui.toast(ONBOARD_TEXT)
      $.ui.status('multiclaude: not set up yet — /multiclaude:setup (read-only check)')
    }
    // Mark rows a previous module instance left running (a reload dropped them).
    await update($, jobs, list => list.map((j): Job => isLive(j) && j.source !== 'runner' && !isAgentRow(j) && !running.has(j.id) && !queue.some(p => p.id === j.id)
      ? { ...j, status: 'failed', endedAt: Date.now(), step: 'lost on reload' } : j)).catch(() => undefined)
    // Subagent rows outlive a reload (the agents do); keep tracking the live ones.
    for (const j of await read($, jobs).catch(() => [] as Job[])) if (isAgentRow(j) && isLive(j)) agentRows.add(j.id)
    // The runner tick: start queued jobs, fold in runner-launched jobs, redraw timers while any runs.
    let tick = 0
    $.clock.every(1000, () => {
      pump($)
      if (tick++ % 3 === 0) void scanRunnerJobs($)
      if (Date.now() >= autoNextAt) void autoSwitchTick($)
      if (tick % 5 === 0) void maybeAutoClose($).catch(() => undefined)
      if (tick % 5 === 2) void reconcileAgents($).catch(() => undefined)
      if (tick % 5 === 3) void syncSettings($).catch(() => undefined)
      if (cfg.shadow && piReady === false && Date.now() >= piCheckAt) { piCheckAt = Date.now() + 300_000; void checkPi($) }
      if (inHerdr && Date.now() >= mascotsCheckAt) void checkMascots($)
      if (mascotsOn) void publishMascots($, tick % 2 === 0).catch(() => undefined)
      if (Date.now() >= walletsNextAt) {
        walletsNextAt = Date.now() + 30_000
        void $.ui.panes().then(ps => { if (ps.some(p => p.id === WALLETS)) void refreshWallets($) }).catch(() => undefined)
      }
      if (Date.now() >= usageNextAt) {
        usageNextAt = Date.now() + 300_000
        void $.ui.panes().then(async ps => { if (ps.some(p => p.id === WALLETS)) void refreshUsage($, (await read($, usageView)).period) }).catch(() => undefined)
      }
      void read($, jobs).then(list => {
        if (list.some(isLive)) $.ui.invalidate('ui.render')
      }).catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'delegates' }, async ($, e) => {
    const opened = await openPane($, /^\s*settings\b/.test(e.args ?? '') ? { mode: 'settings' } : { mode: 'list' })
    return { text: opened.isPlaced ? 'Delegates pane opened.' : `Delegates pane waits: ${opened.reason}` }
  })
  on('command.run', { command: 'wallets' }, async $ => {
    const opened = await openWallets($)
    return { text: opened.isPlaced ? 'Wallets pane opened.' : `Wallets pane waits: ${opened.reason}` }
  })
  // /multiclaude:help: the help pane; as text where no pane can be placed.
  on('command.run', { command: 'multiclaude:help' }, async $ => {
    const opened = await $.ui.open({ id: HELP, title: 'multiclaude help' }).catch(() => ({ isPlaced: false }))
    return opened.isPlaced ? { text: 'multiclaude help opened in a pane (d Delegates · w Wallets).' } : shown($, { text: helpText() })
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'Pane', requestId: HELP }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const wide = e.props.bodyColumns >= 100
    const NAME = 34
    const item = (r: HelpRow, i: number) => (
      <Box key={`${r.name}-${i}`} flexDirection="column">
        <Box flexDirection="row">
          <Text color="#56b6c2" bold>{`  ${r.name}`}</Text>
          {r.args && <Text dimColor>{` ${r.args}`}</Text>}
        </Box>
        <Text wrap="wrap">{`      ${r.what}`}</Text>
      </Box>
    )
    const keyRow = (r: HelpRow, i: number) => (
      <Box key={`${r.name}-${i}`} flexDirection={wide ? 'row' : 'column'}>
        <Box width={wide ? NAME : undefined}><Text color="#56b6c2" bold>{`  ${r.name}`}</Text></Box>
        <Text wrap="wrap">{wide ? r.what : `      ${r.what}`}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{'open  '}</Text>
          <Button key="delegates" hotkey="d" label="Delegates" plain onPress={() => { void openPane($, { mode: 'list' }).catch(() => undefined) }} />
          <Text>{'   '}</Text>
          <Button key="wallets" hotkey="w" label="Wallets" plain onPress={() => { void openWallets($).catch(() => undefined) }} />
        </Box>
        {HELP_SECTIONS.map(([title, rows]) => (
          <Box key={title} flexDirection="column">
            <Text>{' '}</Text>
            <Text bold>{title}</Text>
            {rows.map(title === 'Commands' ? item : keyRow)}
          </Box>
        ))}
      </Box>
    )
  })

  // ── Stats commands answered by the module: the script runs and its output is
  // printed as the command's own output — no model turn, no tokens. Each
  // command is also a skill (skills/<name>/SKILL.md), which stays the fallback
  // on hosts that do not load plugin modules and whenever this hook fails.
  on('command.run', { command: 'multiclaude:quota' }, async ($, e) =>
    shown($, await runScript($, 'skills/quota/quota.mjs', splitArgs(e.args), 'reading wallet quotas…', 180_000)),
  ).catch(($, e, next) => next(e))
  on('command.run', { command: 'multiclaude:usage' }, async ($, e) =>
    shown($, await runScript($, 'scripts/tracker.mjs', splitArgs(e.args), 'counting tokens…', 300_000)),
  ).catch(($, e, next) => next(e))
  on('command.run', { command: 'multiclaude:setup' }, async ($, e) => {
    if (/^\s*companions\s*$/.test(e.args ?? '')) {
      const opened = await openCompanions($).catch(() => ({ isPlaced: false as const, reason: 'no pane surface' }))
      if (opened.isPlaced) return { text: 'Setup pane opened: the companions menu (a key installs or removes one).' }
      return shown($, await runScript($, 'scripts/setup.mjs', ['companions'], 'listing the companions…', 30_000))
    }
    const r = await runScript($, 'scripts/setup.mjs', splitArgs(e.args), 'checking the multiclaude environment…', 300_000)
    await $.store.set(ONBOARDED, Date.now()).catch(() => undefined)
    return shown($, r)
  }).catch(($, e, next) => next(e))
  // /multiclaude:orchestrate typed with no task: arm orchestration without a model
  // turn. The module runs the probe (§0.1), prints it, and hands the model the
  // rules + that probe block as hidden context for its next turn. With a task
  // after the name, the skill runs as usual (the model has work to do anyway).
  on('command.run', { command: 'multiclaude:orchestrate' }, async ($, e, next) => {
    orchestrateAsked($)
    if ((e.args ?? '').trim()) return next(e)
    const root = $.plugin.root
    const probe = (await runScript($, 'scripts/probe.mjs', [], 'probing delegates…', 120_000)).text.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    const skill = (await $.fs.read(`${root}/skills/orchestrate/SKILL.md`))
      .replace(/^---\n[\s\S]*?\n---\n/, '')
      .replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
      .trim()
    // Work already under way in this chat: offer to split it now. The dialog is
    // the engine's own (no model turn); only a yes starts one.
    let underWay = false
    try { const m = await $.session.messages(); underWay = Array.isArray(m) && m.some(x => x.role === 'assistant') } catch { /* no transcript to read */ }
    if (underWay) void offerSplit($).catch(() => undefined)
    return shown($, {
      text: `${probe}\n\nOrchestration is armed for this chat (no model turn spent). Your next task is routed through dispatch.`,
      context: [
        'The person armed orchestration with /multiclaude:orchestrate (no task yet). Follow the orchestrate rules below for the rest of this session. ' +
        '§0.1 is already done: the probe block below is this session\'s result — do not run the probe again; act on it per §0.2 when the next task arrives.\n\n' +
        `${probe}\n\n${skill}`,
      ],
    })
  }).catch(($, e, next) => next(e))
  // /multiclaude:failures [N] [--since 7d] — the runner's failure log, why each
  // class happens and what to change in the prompt (no model turn).
  // /multiclaude:failures review — one AGY job reads the log against the
  // orchestrate prompt rules and proposes fixes; its answer wakes the chat.
  on('command.run', { command: 'multiclaude:failures' }, async ($, e) => {
    const args = splitArgs(e.args)
    if (args[0] !== 'review') return shown($, await runScript($, 'scripts/failures.mjs', args, 'reading the failure log…', 60_000))
    const r = await runScript($, 'scripts/failures.mjs', ['--review-prompt', ...args.slice(1)], 'building the review prompt…', 60_000)
    if (/^NO_FAILURES/.test(r.text)) return { text: `No failed runs to review (${r.text.replace(/^NO_FAILURES\s*/, '')}).` }
    if (!/^You are reviewing/.test(r.text)) return r   // the script failed: show why
    const q = await enqueueDispatch($, { delegate: 'agy', prompt: r.text, label: 'failure log review' })
    return { text: 'deny' in q ? q.deny : `Failure log review queued on AGY (default band) as job ${q.id}. Its report arrives as a message when it finishes; progress in /delegates.` }
  }).catch(($, e, next) => next(e))
  // /multiclaude:shadow [7d|30d|all] — the shadow pairs: how pi did beside the real agents, per rules version (no model turn).
  // /multiclaude:shadow on|off — setting 8. /multiclaude:shadow review [N] — one AGY job reads the newest pairs and
  // proposes changes to the pi working rules; its answer wakes the chat.
  on('command.run', { command: 'multiclaude:shadow' }, async ($, e) => {
    const args = splitArgs(e.args)
    if (args[0] === 'on' || args[0] === 'off') {
      await saveSettings($, { shadow: args[0] === 'on' })
      if (args[0] === 'off') return { text: 'Shadows are off: no pi run is started beside an agent. The records stay (/multiclaude:shadow).' }
      const ok = await checkPi($)
      return { text: ok
        ? 'Shadows are on: every dispatch (Codex / AGY) and every Claude subagent also runs once on pi, one at a time, and both results are recorded — in this chat now, in every other open chat within a few seconds, and in later ones. Each shadow is a paid pi run. /multiclaude:shadow off stops it everywhere.'
        : 'Shadows are switched on, but pi is not installed or lists no model (pi --list-models), so nothing is started.' }
    }
    if (args[0] !== 'review') return shown($, await runScript($, 'scripts/shadow.mjs', args, 'reading the shadow records…', 60_000))
    const r = await runScript($, 'scripts/shadow.mjs', ['review-prompt', ...args.slice(1)], 'building the review prompt…', 60_000)
    if (/^NO_PAIRS/.test(r.text)) return { text: `No pairs to review (${r.text.replace(/^NO_PAIRS\s*/, '')}).` }
    if (!/^You are tuning/.test(r.text)) return r   // the script failed: show why
    const q = await enqueueDispatch($, { delegate: 'agy', prompt: r.text, label: 'shadow pairs review' })
    if (!('deny' in q)) reviewJobs.add(q.id)
    return { text: 'deny' in q ? q.deny : `Shadow review queued on AGY (default band) as job ${q.id}: the newest pairs (task, both answers, the shadow's steps) go to that provider. Its verdicts are recorded as ratings of those pi runs; its proposals for the pi working rules arrive as a message, and nothing is changed by itself.` }
  }).catch(($, e, next) => next(e))
  // /multiclaude:scorecard [7d|30d|all] [--delegate d] — runs, grades, bake-offs and the trial verdict (no model turn).
  on('command.run', { command: 'multiclaude:scorecard' }, async ($, e) =>
    shown($, await runScript($, 'scripts/scorecard.mjs', splitArgs(e.args).filter(a => a !== 'grade'), 'reading the scorecard…', 60_000)),
  ).catch(($, e, next) => next(e))
  on('command.run', { command: 'multiclaude:probe' }, async ($, e) =>
    shown($, await runScript($, 'scripts/probe.mjs', splitArgs(e.args), 'probing delegates…', 600_000)),
  ).catch(($, e, next) => next(e))
  on('command.run', { command: 'multiclaude:accounts' }, async ($, e) => {
    const a = splitArgs(e.args)
    // `run` needs the terminal and plain `auto` loops forever; neither belongs in a command's output.
    if (a[0] === 'run' || (a[0] === 'auto' && !a.includes('--once')))
      return { text: `Run this in a terminal instead:\n  node "${$.plugin.root}/scripts/accounts.mjs" ${a.join(' ')}\n(auto-switch already runs inside Claude Code every 60 s: /multiclaude:accounts auto --once --dry-run shows its next decision)` }
    const r = await runScript($, 'scripts/accounts.mjs', a, 'reading Claude accounts…', 90_000)
    if (a[0] === 'switch' || a[0] === 'add') autoNextAt = Date.now() + 20_000
    return shown($, r)
  }).catch(($, e, next) => next(e))

  // ── Claude subagents: a row per spawn, its tool calls as live steps, ended by its last turn ──
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || !r.agentId || FORWARDER.test(e.subagentType ?? '')) return r
    const id = r.agentId
    agentRows.add(id)
    const row: Job = {
      id, delegate: 'claude', model: r.model || e.model || e.parentModel || 'claude', label: (e.description || e.subagentType || 'subagent').slice(0, 60),
      brief: briefOf(e.prompt ?? ''), agentType: e.subagentType || 'general-purpose',
      startedAt: Date.now(), status: 'running', step: 'started', proof: '', source: 'agent',
    }
    void update($, jobs, list => [...list.filter(j => j.id !== id), row].slice(-60)).catch(() => undefined)
    setActor(id, { kind: 'subagent', parent: actorOf((e as { agentId?: string }).agentId) ?? 'main', label: row.label, model: row.model, state: 'thinking', detail: row.brief ?? '', ended: null }, $)
    // A pi shadow beside it (setting 8) — not beside a driver that only forwards to a delegate: that job gets its own.
    const type = row.agentType ?? ''
    if (cfg.shadow && piReady === true && e.prompt && !NO_SHADOW.test(type) && !/^(agy|codex|pi):/.test(row.label)) {
      const sid = await enqueueShadow($, { of: id, prompt: String(e.prompt), label: row.label, band: shadowBand('claude', row.model), edit: !READ_ONLY_AGENT.test(type) }).catch(() => null)
      if (sid) shadowed.set(id, { prompt: String(e.prompt), label: row.label, type })
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (e.tool === 'Skill' && /^(multiclaude:)?orchestrate$/.test(String((e as unknown as { skill?: unknown }).skill ?? ''))) orchestrateAsked($)
    if (id && agentRows.has(id)) {
      const step = stepOf(e as unknown as Record<string, unknown>)
      logPush(id, step)
      const now = Date.now()
      if (now - (agentStepAt.get(id) ?? 0) >= 1000) {
        agentStepAt.set(id, now)
        void patchJob($, id, j => (isLive(j) ? { ...j, step } : { ...j, step, status: 'running', endedAt: undefined }))
      }
    }
    // herdr mascots: what the chat / this subagent is doing (a no-op unless the companion is on)
    const mid = mascotsOn ? actorOf(id) : undefined
    if (!mid) return next(e)
    try { const rec = e as unknown as Record<string, unknown>; setActor(mid, { state: toolState(e.tool, rec), detail: stepOf(rec) }, $) } catch { /* the tool runs regardless */ }
    const r = await next(e)
    try {
      // A foreground helper call returns when the helpers are done; anything else goes back to thinking.
      const failed = 'isError' in r && r.isError === true
      const a = actors.get(mid)
      if (a && a.ended == null) {
        if (failed) setActor(mid, { state: 'error' }, $)
        else if (Date.now() - a.since < MASCOT_HOLD_MS) thinkLater.set(mid, { at: a.since + MASCOT_HOLD_MS, since: a.since })
        else setActor(mid, { state: 'thinking', detail: '' }, $)
      }
    } catch { /* never change the result */ }
    return r
  }).catch(($, e, next) => (next.called ? Promise.reject(new Error('tool.call hook failed after the tool ran')) : next(e)))

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id && agentRows.has(id)) {
      const reason = 'reason' in e ? e.reason : 'refusal'
      const status: Job['status'] = e.isAborted || reason === 'aborted' ? 'cancelled' : reason === 'answer' ? 'done' : 'failed'
      answers.set(id, { code: status === 'done' ? 0 : 1, answer: String(e.answer ?? '').trimEnd(), proof: '', tail: [] })
      resultLines.delete(id)
      const secs = Math.round((e.durationMs ?? 0) / 1000)
      const tok = e.usage?.output_tokens
      const summaryLine = withCost([reason === 'answer' ? 'answered' : reason, tok ? `${tok.toLocaleString('en-US')} output tokens` : '', secs ? fmtDur(secs) : ''].filter(Boolean).join(' · '), agentUsd.has(id) ? costText(agentUsd.get(id) as number) : undefined)
      void patchJob($, id, j => ({ ...j, status, endedAt: Date.now(), step: summaryLine, proof: summaryLine, model: e.usage?.model || j.model }))
        .then(() => (e.usage ? priceAgent($, id, e.usage) : undefined)).catch(() => undefined)
      setActor(id, { state: status === 'done' ? 'done' : 'error', detail: summaryLine, ended: Date.now(), ...(e.usage?.model ? { model: e.usage.model } : {}) }, $)
      const sh = shadowed.get(id)
      if (sh) {
        shadowed.delete(id)
        const u = e.usage
        void recordReference($, {
          pair: id, role: 'reference', job: id, delegate: 'claude', model: u?.model ?? null, kind: sh.type, label: sh.label,
          edit: !READ_ONLY_AGENT.test(sh.type), shell: !READ_ONLY_AGENT.test(sh.type),
          status: status === 'done' ? 'SUCCESS' : status.toUpperCase(), dur: Math.round((e.durationMs ?? 0) / 100) / 10,
          in: u?.input_tokens ?? null, out: u?.output_tokens ?? null, cached: u?.cache_read_input_tokens ?? null,
          tokens: u ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : null,
          prompt: sh.prompt, answer: String(e.answer ?? ''),
        })
      }
    }
    // herdr mascots: the chat finished its turn
    if (mascotsOn && e.agentId === undefined) {
      const reason = 'reason' in e ? e.reason : 'refusal'
      const state = e.isAborted || reason === 'aborted' ? 'idle' : reason === 'answer' ? ((ctxPct ?? 0) >= 80 ? 'context-nearly-full' : 'done') : 'error'
      setActor('main', { state, detail: '', ...(e.usage?.model ? { model: e.usage.model } : {}) }, $)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── herdr mascots: turns, permission asks, compaction, context, typing (no-ops unless the companion is on) ──
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    try {
      const id = mascotsOn ? actorOf(e.agentId) : undefined
      if (id && r.decision === 'ask') setActor(id, { state: 'waiting-for-you', detail: `permission: ${e.tool}` }, $)
    } catch { /* never block a check */ }
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    const id = mascotsOn ? actorOf(e.agentId) : undefined
    if (id) setActor(id, { state: 'thinking', detail: '', ended: null }, $)
    return r
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const id = mascotsOn ? actorOf(e.agentId) : undefined
    if (id) setActor(id, { state: 'compacting', detail: '' }, $)
    const r = await next(e)
    if (id) setActor(id, { state: 'thinking' }, $)
    return r
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const pct = e.context?.percent
    if (typeof pct === 'number' && Math.round(pct) !== ctxPct) { ctxPct = Math.round(pct); if (mascotsOn) mascotsDirty = true }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The person typing in the prompt box while the chat waits.
  on('prompt.edit', async ($, e, next) => {
    const a = mascotsOn ? actors.get('main') : undefined
    if (a && /^(?:idle|done|greeting|context-nearly-full|error)$/.test(a.state)) setActor('main', { state: 'typing', detail: '' }, $)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (mascotsOn) { mascotsOn = false; mascotsSent = ''; await writeMascots($, null).catch(() => undefined) }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch' }, async ($, e) => {
    const input = { ...(e as unknown as DispatchInput), parent: e.agentId, shadow: true }
    const r = await enqueueDispatch($, input)
    return 'deny' in r ? r : { result: r.text }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: dispatch could not be queued` }))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch_status' }, async ($, e) => {
    const { id, all } = e as unknown as { id?: string; all?: boolean }
    if (!id && all) return { result: await listAllJobs($) }
    await scanRunnerJobs($)
    const list = (await read($, jobs)).filter(j => !isAgentRow(j))
    const now = Date.now()
    if (!id) {
      const rows = [...list].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20)
      return { result: rows.length ? rows.map(j => summary(j, now)).join('\n') : 'no delegate jobs yet' }
    }
    const j = list.find(x => x.id === id)
    if (!j) return { result: `no job ${id}` }
    const head = summary(j, now)
    const transcript = await transcriptOf($, id)
    const recent = transcript.slice(-TAIL_LINES).join('\n')
    if (isLive(j)) return { result: `${head}\n\n— live transcript (last ${Math.min(TAIL_LINES, transcript.length)} of ${transcript.length} lines) —\n${recent || '(nothing yet)'}` }
    const answer = await answerOf($, j)
    return { result: `${head}\n\n${answer ?? '(answer not available — the job file is gone)'}${j.status !== 'done' && recent ? '\n\n— transcript tail —\n' + recent : ''}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: status lookup failed` }))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch_cancel' }, async ($, e) =>
    ({ result: await cancelJob($, String((e as unknown as { id: string }).id ?? '')) }),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: cancel failed` }))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch_grade' }, async ($, e) => {
    const g = e as unknown as { id?: string; grade?: string; gates?: string; note?: string; vs?: string; kind?: string }
    const id = String(g.id ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_')
    const grade = String(g.grade ?? '')
    if (!id || !['pass', 'rework', 'fail'].includes(grade)) return { result: 'dispatch_grade needs id and grade: pass | rework | fail' }
    if (running.has(id) || queue.some(p => p.id === id)) return { result: `job ${id} has not finished — grade it once its result is in (or dispatch_cancel it first)` }
    const argv = ['node', `${$.plugin.root}/scripts/scorecard.mjs`, 'grade', id, grade]
    for (const k of ['gates', 'note', 'vs', 'kind'] as const) if (g[k]) argv.push(`--${k}`, String(g[k]).slice(0, 600))
    const r = await $.process.run(argv, { timeoutMs: 20_000 })
    scoreCache.clear()
    return { result: (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim() || `scorecard exited ${r.exitCode}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: grade could not be recorded` }))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch_extend' }, async ($, e) => {
    const { id, seconds } = e as unknown as { id?: string; seconds?: number }
    return { result: await extendJob($, String(id ?? ''), Number(seconds)) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: extend failed` }))

  // ── the Delegates pane: list · one job · settings ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    paneFocused = e.props.isFocused
    const s = { ...DEFAULT_SETTINGS, ...((await read($, settings)) as Settings) }
    const v = (await read($, view)) as View
    const list = await read($, jobs)
    const now = Date.now()
    const go = (next: View) => () => { void update($, view, () => next).catch(() => undefined) }
    const toast = (p: Promise<string>) => { void p.then(t => $.ui.toast(t)).catch(() => undefined) }
    const modelText = (j: Job) => (
      <Box flexDirection="row">
        <Text color={statusColor(j.status)}>{`${statusMark(j.status)} `}</Text>
        <Text color={modelColor(j.delegate, j.model)} bold>{j.model}</Text>
        <Text dimColor>{`${j.effort ? '@' + j.effort : ''} · ${j.delegate} · `}</Text>
        <Text>{`${fmtDur(elapsed(j, now))} `}</Text>
        <Text wrap="truncate-end">{`${j.label}${rowTag(j)}`}</Text>
      </Box>
    )

    if (v.mode === 'settings') {
      // Each setting is a button that cycles its value (every surface has Button; not every one has Select).
      type Opt = { label: string; value: string }
      const cycle = (n: string, label: string, cur: string, opts: Opt[], set: (x: string) => Partial<Settings>) => {
        const at = Math.max(0, opts.findIndex(o => o.value === cur))
        const nextVal = opts[(at + 1) % opts.length]!.value
        return (
          <Box flexDirection="row">
            <Button key={`set-${n}`} hotkey={n} label={label} plain onPress={() => { void saveSettings($, set(nextVal)) }} />
            <Text>{'  '}</Text>
            <Text color="suggestion" bold>{opts[at]?.label ?? cur}</Text>
          </Box>
        )
      }
      const onOff: Opt[] = [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }]
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button key="back" hotkey="b" label="back" plain onPress={go({ mode: 'list' })} />
            <Text bold>{'   Delegates settings — press a number to change'}</Text>
          </Box>
          {cycle('1', 'Open when orchestration starts', s.openOnOrchestrate ? 'on' : 'off', onOff, x => ({ openOnOrchestrate: x === 'on' }))}
          {cycle('2', 'Open on every dispatch', s.openOnDispatch ? 'on' : 'off', onOff, x => ({ openOnDispatch: x === 'on' }))}
          {cycle('3', 'Close when idle', String(s.autoClose),
            [{ value: '0', label: 'never' }, { value: '30', label: 'after 30 s' }, { value: '120', label: 'after 2 min' }, { value: '600', label: 'after 10 min' }],
            x => ({ autoClose: Number(x) || 0 }))}
          {cycle('4', 'Jobs listed', s.show, [{ value: 'all', label: 'all of this chat' }, { value: 'recent', label: 'running + last 5' }],
            x => ({ show: x === 'recent' ? 'recent' : 'all' }))}
          {cycle('5', 'Live lines per running job', String(s.tail), ['0', '1', '2', '3', '5'].map(n => ({ value: n, label: n })), x => ({ tail: Number(x) || 0 }))}
          {cycle('6', 'Show Claude subagents', s.claude === false ? 'off' : 'on', onOff, x => ({ claude: x === 'on' }))}
          {cycle('7', 'Wallet rows in the status line', s.statusline === false ? 'off' : 'on', onOff, x => ({ statusline: x === 'on' }))}
          {cycle('8', 'Shadow every agent with pi', s.shadow ? 'on' : 'off', onOff, x => ({ shadow: x === 'on' }))}
          {s.shadow ? <Text color={piReady === false ? 'error' : PI} wrap="wrap">{piReady === false
            ? 'Shadows are on, but pi is not installed or lists no model (pi --list-models): nothing is started.'
            : 'Shadows: every dispatch (Codex / AGY) and every Claude subagent also runs once on pi — one at a time, no shell, edits only in a throwaway worktree — and both results are recorded. Each shadow is a paid pi run on the self-hosted model. /multiclaude:shadow shows the pairs.'}</Text> : null}
          {inHerdr ? <Text color="yellow">Inside herdr: 1, 2 and 7 are on hold. herdr's own panels show the jobs and wallets, so this pane opens only on /delegates and the wallet rows stay hidden (MULTICLAUDE_HERDR=0 turns this off).</Text> : null}
          <Text dimColor>Saved across sessions. Idle close waits until a job has ended while the pane was open, and never closes it while focused. The status line follows setting 7 at its next redraw.</Text>
        </Box>
      )
    }

    if (v.mode === 'scorecard') {
      const period = v.period ?? '7d'
      const sc = await scoreOf($, period)
      const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–')
      const kTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
      const verdictColor = (x?: string) => (x === 'VIABLE' ? 'success' : x === 'NOT VIABLE' ? 'error' : x === 'MARGINAL' ? 'warning' : undefined)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button key="back" hotkey="b" label="back" plain onPress={go({ mode: 'list' })} />
            <Text>{'   '}</Text>
            <Button key="period" hotkey="p" label={`period: ${period}`} plain onPress={go({ mode: 'scorecard', period: period === '7d' ? '30d' : period === '30d' ? 'all' : '7d' })} />
          </Box>
          <Text bold>{`Scorecard · ${period === 'all' ? 'all runs' : 'last ' + period}`}</Text>
          <Text dimColor wrap="wrap">◆ = on trial · ok / stuck / fail are the runner's outcomes · judged = the orchestrator's pass / rework / fail</Text>
          <Text>{' '}</Text>
          {sc.error && <Text color="warning" wrap="wrap">{sc.error}</Text>}
          {!sc.error && sc.rows.length === 0 && <Text dimColor>No finished runs in this period.</Text>}
          {sc.rows.map(x => {
            const counted = x.runs - x.infra
            const money = (x.cost ?? 0) > 0 ? ` · ${x.costApprox ? '≈' : ''}$${x.cost! < 0.01 ? x.cost!.toFixed(4) : x.cost!.toFixed(2)}` : ''
            return (
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Text>{x.trial ? '◆ ' : '  '}</Text>
                  <Text color={modelColor(x.delegate === 'codex' || x.delegate === 'pi' ? x.delegate : 'agy', x.model)} bold wrap="truncate-end">{x.model}</Text>
                  <Text dimColor>{` · ${x.delegate}`}</Text>
                </Box>
                <Text wrap="truncate-end">{`    ${x.runs} run${x.runs === 1 ? '' : 's'} · ok ${pct(x.ok, counted)} · stuck ${pct(x.stuck, counted)} · fail ${pct(x.failed, counted)}`}</Text>
                <Text dimColor wrap="truncate-end">{`    judged ${x.graded ? `${x.pass}/${x.rework}/${x.fail} · pass ${pct(x.pass, x.graded)}` : '–'}${x.medDur != null ? ' · ' + fmtDur(Math.round(x.medDur)) : ''}${x.medTokens != null ? ' · ' + kTok(x.medTokens) + ' tok' : ''}${money}`}</Text>
                {x.verdict && <Text color={verdictColor(x.verdict)} wrap="wrap">{`    ${x.verdict}${x.why ? ' — ' + x.why : ''}`}</Text>}
                <Text>{' '}</Text>
              </Box>
            )
          })}
          {(sc.bakeoffs.length > 0 || sc.ungraded.length > 0) && <Text dimColor wrap="wrap">{[sc.bakeoffs.length ? `${sc.bakeoffs.length} bake-off${sc.bakeoffs.length === 1 ? '' : 's'}` : '', sc.ungraded.length ? `${sc.ungraded.length} run${sc.ungraded.length === 1 ? '' : 's'} not graded yet` : ''].filter(Boolean).join(' · ') + ' — /multiclaude:scorecard prints the details'}</Text>}
        </Box>
      )
    }

    const job = v.mode === 'job' ? list.find(j => j.id === v.id) : undefined
    if (job) {
      const live = isLive(job)
      const t = await transcriptOf($, job.id)
      const answer = live ? undefined : await answerOf($, job)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button key="back" hotkey="b" label="back" plain onPress={go({ mode: 'list' })} />
            {canCancel(job) && <Text>{'   '}</Text>}
            {canCancel(job) && <Button key="cancel" hotkey="x" label="cancel" plain onPress={() => toast(cancelJob($, job.id))} />}
            {live && !isAgentRow(job) && <Text>{'   '}</Text>}
            {live && !isAgentRow(job) && <Button key="extend" hotkey="e" label="+5 min" plain onPress={() => toast(extendJob($, job.id, 300))} />}
          </Box>
          {modelText(job)}
          {job.brief && <Text dimColor italic>{job.brief}</Text>}
          <Text dimColor>{`${job.id} · ${/status=LOOP\b/.test(job.proof) ? 'loop' : job.status} · started ${new Date(job.startedAt).toLocaleTimeString()}`}</Text>
          {job.proof && <Text dimColor>{job.proof}</Text>}
          {live && <Text bold>{`live transcript (last ${Math.min(TAIL_LINES, t.length)} of ${t.length})`}</Text>}
          {live && t.slice(-TAIL_LINES).map(l => <Text dimColor wrap="truncate-end">{stripStamp(l)}</Text>)}
          {!live && (answer ? <Markdown text={answer.length > 20_000 ? answer.slice(0, 20_000) + `\n\n… ${answer.length - 20_000} more characters — dispatch_status({ id: "${job.id}" })` : answer} />
            : <Text dimColor>(no answer kept for this job)</Text>)}
          {!live && job.status !== 'done' && t.length > 0 && <Text bold>transcript tail</Text>}
          {!live && job.status !== 'done' && t.slice(-8).map(l => <Text dimColor wrap="truncate-end">{stripStamp(l)}</Text>)}
        </Box>
      )
    }

    // A subagent that dispatched folds into its jobs (they say "via …"); Claude rows can be hidden.
    const parents = new Set(list.filter(j => j.parent).map(j => j.parent!))
    const drivers = new Map(list.filter(j => isAgentRow(j) && parents.has(j.id)).map(j => [j.id, j] as const))
    const listed = [...list].filter(j => !isAgentRow(j) || (s.claude !== false && !drivers.has(j.id))).sort((a, b) => b.startedAt - a.startedAt)
    // A shadow (a pi run beside another agent, for the record) is one line under the row it shadows;
    // it is a row of its own only when that row is not listed.
    const listedIds = new Set(listed.map(j => j.id))
    const shadows = new Map<string, Job[]>()
    for (const j of listed) if (j.shadowOf && listedIds.has(j.shadowOf)) shadows.set(j.shadowOf, [...(shadows.get(j.shadowOf) ?? []), j])
    const sorted = listed.filter(j => !(j.shadowOf && listedIds.has(j.shadowOf)))
    const liveJobs = sorted.filter(isLive)
    const ended = sorted.filter(j => !isLive(j))
    const shown = (s.show === 'recent' ? [...liveJobs, ...ended.slice(0, 5)] : sorted).slice(0, 40)
    const tails = new Map<string, string[]>()
    if (s.tail > 0) for (const j of liveJobs) tails.set(j.id, (await transcriptOf($, j.id)).filter(l => !l.startsWith('[dispatch ')).map(stripStamp).filter(l => l && l !== j.step).slice(-s.tail))
    const results = new Map<string, string>()
    for (const j of shown) if (j.status === 'done') { const r = await resultLine($, j); if (r) results.set(j.id, r) }
    const IND = '    '
    const costs = listed.map(costOf).filter((x): x is { usd: number; approx: boolean } => !!x)
    const spent = costs.reduce((n, x) => n + x.usd, 0)
    const billed = costs.filter(x => !x.approx).length
    const spentNote = !costs.length ? '' : billed === costs.length ? `$${spent.toFixed(2)} billed for these jobs`
      : `≈ $${spent.toFixed(2)} for these jobs ${billed ? '(billed + API list price)' : 'at API list price'}`
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>{`${liveJobs.length} running · ${ended.length} finished   `}</Text>
          <Button key="settings" hotkey="s" label="settings" plain onPress={go({ mode: 'settings' })} />
          <Text>{'   '}</Text>
          <Button key="scorecard" hotkey="t" label="scorecard" plain onPress={go({ mode: 'scorecard', period: '7d' })} />
          <Text>{'   '}</Text>
          <Button key="help" hotkey="h" label="help" plain onPress={() => { void $.ui.open({ id: HELP, title: 'multiclaude help' }).catch(() => undefined) }} />
          {ended.length > 0 && <Text>{'   '}</Text>}
          {ended.length > 0 && <Button key="clear" hotkey="c" label="clear finished" plain onPress={() => { void clearFinished($).catch(() => undefined) }} />}
        </Box>
        {spentNote ? <Text dimColor>{spentNote}</Text> : null}
        <Text>{' '}</Text>
        {shown.length === 0 && <Text dimColor>{s.claude === false ? 'No external dispatches yet — the dispatch tool (agy / codex) lists them here.' : 'No external dispatches yet — dispatches (agy / codex) and Claude subagents are listed here.'}</Text>}
        {shown.map((j, i) => {
          const live = isLive(j)
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Button key={`open-${j.id}`} hotkey={i < 9 ? String(i + 1) : undefined} label={statusMark(j.status)} plain onPress={go({ mode: 'job', id: j.id })} />
                <Text>{' '}</Text>
                <Text bold wrap="truncate-end">{`${j.label}${rowTag(j)}`}</Text>
                <Text color={statusColor(j.status)}>{`  ${fmtDur(elapsed(j, now))}`}</Text>
              </Box>
              <Box flexDirection="row">
                <Text>{IND}</Text>
                <Text color={modelColor(j.delegate, j.model)} bold>{j.model}</Text>
                <Text dimColor>{`${j.effort ? ' @' + j.effort : ''} · ${j.delegate}${j.parent && drivers.has(j.parent) ? ` · via ${drivers.get(j.parent)!.agentType ?? 'subagent'} “${drivers.get(j.parent)!.label}”` : ''}`}</Text>
              </Box>
              {j.brief && j.brief !== j.label && <Text dimColor italic wrap="truncate-end">{IND + j.brief}</Text>}
              {live && <Text color="warning" wrap="truncate-end">{`${IND}▸ ${j.step || j.status}`}</Text>}
              {live && (tails.get(j.id) ?? []).map(l => <Text dimColor wrap="truncate-end">{`${IND}┊ ${l}`}</Text>)}
              {!live && <Text color={statusColor(j.status)} wrap="truncate-end">{`${IND}${proofShort(j.proof || j.step || j.status)}`}</Text>}
              {results.get(j.id) && <Text wrap="truncate-end">{`${IND}→ ${results.get(j.id)}`}</Text>}
              {(shadows.get(j.id) ?? []).map(sh => (
                <Text color={PI} dimColor={!isLive(sh)} wrap="truncate-end">{`${IND}◌ shadow · pi ${sh.model} · ${isLive(sh) ? sh.step || sh.status : proofShort(sh.proof || sh.step || sh.status)}`}</Text>
              ))}
              <Text>{' '}</Text>
            </Box>
          )
        })}
        {shown.length > 0 && <Box flexDirection="row">{MODEL_LEGEND.map(([name, c]) => (name === 'pi'
          ? <Box flexDirection="row">{PI_LOGO.map(k => <Text color={k}>▪</Text>)}<Text color={c}>{` ${name}  `}</Text></Box>
          : <Text color={c}>{`■ ${name}  `}</Text>))}</Box>}
      </Box>
    )
  })

  // ── the Wallets pane: Claude pool + each account, Codex windows, AGY pools ──
  on('ui.render', { component: 'Pane', requestId: COMPANIONS }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = await read($, companions)
    if (!c) return <Box flexDirection="column"><Text dimColor>Reading the companions…</Text></Box>
    const NAME = 14, STATE = 26
    const fit = (t: string, n: number) => (t.length > n - 1 ? t.slice(0, n - 2) + '…' : t).padEnd(n)
    const rows = c.list.map((x, i) => {
      const key = String(i + 1)
      const act = x.installed ? 'remove' : 'install'
      const busy = c.busy === x.name
      const heading = x.section && x.section !== c.list[i - 1]?.section ? x.section : ''
      return (
        <Box key={x.name} flexDirection="column">
          {heading && i > 0 && <Text>{' '}</Text>}
          {heading && <Text bold>{` ${heading}`}</Text>}
          <Box flexDirection="row">
            <Text color={x.enabled ? 'success' : undefined} bold={x.enabled}>{` ${x.enabled ? '✓' : '·'} ${fit(x.name, NAME)}`}</Text>
            <Text dimColor={!x.enabled} color={x.enabled && /missing|not found/.test(x.state) ? 'warning' : undefined}>{fit(x.state, STATE)}</Text>
            {busy
              ? <Text color="warning">{`${act === 'install' ? 'installing' : 'removing'}…`}</Text>
              : c.busy
                ? <Text dimColor>{`${key} ${act}`}</Text>
                : <Button key={`act-${x.name}`} hotkey={key} label={act} plain onPress={() => { void companionAction($, act === 'install' ? 'add' : 'remove', x.name).catch(() => undefined) }} />}
          </Box>
          <Text dimColor wrap="wrap">{`     ${x.what}`}</Text>
        </Box>
      )
    })
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{'optional — nothing in multiclaude needs them  '}</Text>
          <Button key="refresh" hotkey="r" label="refresh" plain onPress={() => { void refreshCompanions($) }} />
          <Text>{'   '}</Text>
          <Button key="help" hotkey="h" label="help" plain onPress={() => { void $.ui.open({ id: HELP, title: 'multiclaude help' }).catch(() => undefined) }} />
        </Box>
        <Text>{' '}</Text>
        {rows}
        <Text>{' '}</Text>
        {c.note && <Text wrap="wrap">{` ${c.note}`}</Text>}
        {c.error && <Text color="warning" wrap="wrap">{` ${c.error}`}</Text>}
        <Text dimColor wrap="wrap">{c.cli
          ? ' plugins install and uninstall through the claude CLI; a change loads at the next Claude Code start'
          : ' no claude CLI on PATH: install adds the plugin to settings.json (Claude Code installs it at its next start), remove disables it there'}</Text>
        <Text dimColor wrap="wrap">{' ccstatusline: install = setup apply --ccstatusline, remove = our own status line back (its config file stays); settings.json is backed up before every write'}</Text>
      </Box>
    )
  })
  on('ui.render', { component: 'Pane', requestId: WALLETS }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const w = await read($, wallets)
    if (!w) return <Box flexDirection="column"><Text dimColor>Reading wallets…</Text></Box>
    // one row per wallet: name column, then 5h and wk side by side (thin bars, % used, short reset)
    const NAME = 15
    const BW = Math.max(4, Math.min(14, Math.floor((e.props.bodyColumns - NAME - 22) / 2)))
    const cell = (v: number | null | undefined, at: number | null | undefined, color: string) => {
      if (v === undefined) return <Text>{' '.repeat(BW + 11)}</Text>
      const [full, empty] = bar(v, BW)
      return (
        <Box flexDirection="row">
          <Text color={color}>{full}</Text>
          <Text dimColor>{empty}</Text>
          <Text color={pctColor(v)}>{v == null ? '    –' : String(Math.round(v)).padStart(4) + '%'}</Text>
          <Text dimColor>{(' ' + shortUntil(at)).padEnd(6)}</Text>
        </Box>
      )
    }
    const fit = (t: string, n: number) => (t.length > n - 1 ? t.slice(0, n - 2) + '…' : t).padEnd(n)
    const row = (color: string, name: JSX.Element, five: number | null | undefined, fiveAt: number | null | undefined, wk: number | null | undefined, wkAt?: number | null) => (
      <Box flexDirection="row">{name}{cell(five, fiveAt, color)}<Text>{'  '}</Text>{cell(wk, wkAt, color)}</Box>
    )
    const CLAUDE = '#d97757', CODEX = '#10a37f'
    const agyColor = (pool: string) => (pool === 'claude' ? CLAUDE : pool === 'argon' ? '#c678dd' : '#4285f4')
    const label = (t: string, color?: string, extra: Record<string, unknown> = {}) => <Text color={color} {...extra}>{fit(t, NAME)}</Text>
    const switchTo = (slot: string) => () => {
      void $.process.run(['node', `${$.plugin.root}/scripts/accounts.mjs`, 'switch', slot], { timeoutMs: 60_000 })
        .then(r => { $.ui.toast(r.exitCode === 0 ? `Claude account → #${slot}` : `switch failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); autoNextAt = Date.now() + 20_000; return refreshWallets($) })
        .catch(() => undefined)
    }
    const age = w.ageSec == null ? 'no cache yet' : w.ageSec < 90 ? `${w.ageSec}s old` : `${Math.round(w.ageSec / 60)}m old`
    const head = (t: string, color: string, note = '') => (
      <Box flexDirection="row"><Text color={color} bold>{t}</Text><Text dimColor>{note ? '  ' + note : ''}</Text></Box>
    )
    const codexWin = (re: RegExp) => w.codex.find(x => re.test(x.label))?.pct
    // pi spend: $ = what the provider reported per run, ≈$ = (partly) tokens at list price
    const piMoney = (b: PiSpend) => `${b.approx ? '≈' : ''}$${b.usd > 0 && b.usd < 0.01 ? b.usd.toFixed(4) : b.usd.toFixed(2)}`
    const multi = w.accounts.length > 1
    // ── usage section: tokens + ≈ API spend, combined (total) or split (input · cached · output)
    const u = await read($, usage)
    const uv = await read($, usageView)
    const setView = (patch: Partial<UsageView>) => () => {
      const nv = { ...uv, ...patch }
      void update($, usageView, () => nv).then(() => $.store.set(USAGE_VIEW_KEY, nv)).catch(() => undefined)
      if (patch.period) void refreshUsage($, patch.period, { scan: false })
    }
    const COL = 8
    const cols = uv.split ? ['input', 'cached', 'output', '≈ $'] : ['in+out', '≈ $']
    const UN = Math.max(14, Math.min(30, e.props.bodyColumns - cols.length * COL - 1))
    const nums = (r: UsageRow) => (uv.split ? [tok(r.input), tok(r.cached), tok(r.out), dollars(r)] : [tok(r.total), dollars(r)]).map(t => t.padStart(COL)).join('')
    const urow = (key: string, name: string, r: UsageRow, color?: string, extra: Record<string, unknown> = {}) => (
      <Box key={key} flexDirection="row"><Text color={color} {...extra}>{fit(name, UN)}</Text><Text>{nums(r)}</Text></Box>
    )
    const walletColor = (wl: string) => (wl === 'claude' ? CLAUDE : wl === 'codex' ? CODEX : wl === 'pi' ? PI : '#4285f4')
    const periodText = !u ? '' : u.period === 'today' ? 'today' : u.period === 'all' ? `all, since ${u.from ?? '—'}` : `${u.period}, from ${u.from ?? '—'}`
    const splitAccounts = u ? u.accounts.filter(a => u.accounts.filter(b => b.wallet === a.wallet).length > 1) : []
    const usageSection = (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>Usage</Text>
          <Text dimColor>{`  ${u && u.period === uv.period ? periodText : uv.period}${usageBusy ? ' · counting…' : ''}  `}</Text>
          <Button key="period" hotkey="p" label={`period: ${uv.period}`} plain onPress={setView({ period: PERIOD_ORDER[(PERIOD_ORDER.indexOf(uv.period) + 1) % PERIOD_ORDER.length] })} />
          <Text>{'  '}</Text>
          <Button key="split" hotkey="i" label={uv.split ? 'in / out split' : 'in+out combined'} plain onPress={setView({ split: !uv.split })} />
        </Box>
        {!u
          ? <Text dimColor>{usageBusy ? ' counting tokens (the first scan reads the whole history)…' : ' no figures yet'}</Text>
          : <Box flexDirection="column">
            {u.error && <Text color="warning">{` tracker: ${u.error}`}</Text>}
            <Text dimColor>{' '.repeat(UN) + cols.map(c => c.padStart(COL)).join('')}</Text>
            {urow('all', 'ALL', u.totals, undefined, { bold: true })}
            {u.wallets.map(x => urow(`w-${x.wallet}`, ` ${x.wallet}`, x, walletColor(x.wallet)))}
            {splitAccounts.length > 0 && <Box flexDirection="column"><Text>{' '}</Text><Text dimColor>by account</Text></Box>}
            {splitAccounts.map(a => urow(`a-${a.wallet}-${a.label}`, ` ${a.wallet} ${a.label.split('@')[0] ?? a.label}`, a, walletColor(a.wallet), a.label === 'unattributed' ? { dimColor: true } : {}))}
            {u.models.length > 0 && <Box flexDirection="column"><Text>{' '}</Text><Text dimColor>by model</Text></Box>}
            {u.models.slice(0, 10).map(m => urow(`m-${m.wallet}-${m.model}`, ` ${m.model}${m.priced ? '' : ' (no $)'}`, m, modelColor(m.wallet === 'codex' ? 'codex' : m.wallet === 'agy' ? 'agy' : m.wallet === 'pi' ? 'pi' : 'claude', m.model)))}
            {u.modelCount > 10 && <Text dimColor>{` … ${u.modelCount - 10} more — /multiclaude:usage ${u.period}`}</Text>}
            <Text>{' '}</Text>
            <Text dimColor>≈ $ = API list price of the same tokens, not a bill</Text>
          </Box>}
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{`% used · ${age}  `}</Text>
          <Button key="refresh" hotkey="r" label="refresh" plain onPress={() => { void refreshWallets($, { refresh: true }) }} />
          <Text>{'   '}</Text>
          <Button key="help" hotkey="h" label="help" plain onPress={() => { void $.ui.open({ id: HELP, title: 'multiclaude help' }).catch(() => undefined) }} />
        </Box>
        <Text dimColor>{' '.repeat(NAME) + '5h'.padEnd(BW + 13) + 'wk'}</Text>
        {head('Claude', '#d97757', [w.claude && w.claude.pool > 1 ? `pool of ${w.claude.pool}` : '', w.claude?.auto ? 'auto-switch' : '', multi ? 'key = switch' : ''].filter(Boolean).join(' · '))}
        {w.claude
          ? row(CLAUDE, label(multi ? ' pool (mean)' : ' account'), w.claude.fiveHour.pct, w.claude.fiveHour.resetsAt, w.claude.sevenDay.pct)
          : <Text dimColor> no figures yet</Text>}
        {multi && w.accounts.map(a => row(CLAUDE,
          a.active || a.disabled || !/^\d$/.test(a.slot)
            ? label(`${a.active ? '▶' : ' '}${a.slot} ${a.label.split('@')[0] ?? a.label}`, a.active ? '#d97757' : undefined, { bold: a.active, dimColor: a.disabled })
            : <Box flexDirection="row" width={NAME}><Text>{' '}</Text><Button key={`switch-${a.slot}`} hotkey={a.slot} label={fit(a.label.split('@')[0] ?? a.label, NAME - 4).trimEnd()} plain onPress={switchTo(a.slot)} /></Box>,
          a.fiveHour.pct, a.fiveHour.resetsAt, a.sevenDay.pct, a.sevenDay.resetsAt,
        ))}
        <Text>{' '}</Text>
        {head('Codex', '#10a37f')}
        {w.codex.length
          ? row(CODEX, label(` plan${w.codexOut ? ' ✗' : ''}`, w.codexOut ? CODEX : undefined), codexWin(/5h|hour/i), null, codexWin(/wk|week/i) ?? (codexWin(/5h|hour/i) === undefined ? w.codex[0]?.pct : undefined))
          : w.codexOut
            ? row(CODEX, label(' plan ✗', CODEX), undefined, null, 100)
            : <Text dimColor> no figures</Text>}
        {w.codexOut ? <Text color="#e03131">{` out of quota${w.codexOut.until ? ` until ${new Date(w.codexOut.until).toISOString().slice(5, 16).replace('T', ' ')} UTC` : ''} — dispatch refuses Codex`}</Text> : null}
        <Text>{' '}</Text>
        {head('AGY', '#4285f4')}
        {w.agy.length
          ? w.agy.map(p => row(agyColor(p.pool),
            label(` ${p.pool}${p.exhausted ? ' ✗' : ''}`, agyColor(p.pool)),
            p.fiveHour ?? undefined, null, p.weekly))
          : <Text dimColor> no figures</Text>}
        {w.pi ? (
          <Box flexDirection="column">
            <Text>{' '}</Text>
            {head('pi', PI, `trial · no quota${w.pi.installed ? '' : ' · CLI not found here'}`)}
            <Box flexDirection="row">
              {label(' unlimited', PI)}
              {PI_LOGO.map((k, i) => <Text color={k}>{'█'.repeat(Math.floor(BW / 3) + (i < BW % 3 ? 1 : 0))}</Text>)}
              <Text color={PI}>{'    ∞'}</Text>
              <Text>{`  ${piMoney(w.pi.today)} today · ${piMoney(w.pi.d7)} 7d`}</Text>
              <Text dimColor>{` · ${w.pi.d7.runs} run${w.pi.d7.runs === 1 ? '' : 's'}`}</Text>
            </Box>
          </Box>
        ) : null}
        <Text>{' '}</Text>
        {usageSection}
      </Box>
    )
  })
}
