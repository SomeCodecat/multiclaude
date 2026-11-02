// multiclaude hooks module — native, NON-BLOCKING delegate dispatch for Claude Code.
//
// Three tools and one pane:
//   mcp__multiclaude__dispatch        enqueue a job on agy / codex, return its id at once
//   mcp__multiclaude__dispatch_status progress + recent transcript of one job (or all), the answer once done
//   mcp__multiclaude__dispatch_cancel kill a running job
//   /delegates                         the Delegates pane: live provider · model · elapsed · step
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

import type { Job } from '../types'

const PANE = 'delegates'
const MAX_RUNNING = 6
const WAKE_INLINE_CHARS = 6000
const LOG_KEEP = 400
const TAIL_LINES = 15
// Change the tag when a job's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'multiclaude', key: 'jobs' } as const, [] as Job[], {
  shape: 'jobs-3',
})

type Pending = {
  id: string
  argv: string[]
  cwd?: string
  prompt: string
  delegate: 'agy' | 'codex'
  label: string
}
// Module-level: lives as long as the loaded module (a reload drops queued work;
// `$.state` keeps the rows, so the pane still shows them as failed).
const queue: Pending[] = []
const running = new Map<string, { stop: () => void }>()
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
      enum: ['agy', 'codex'],
      description:
        'agy = Antigravity (review, research, analysis, heavy reasoning; Gemini + Claude tiers on a separate wallet). codex = OpenAI Codex (implementation, edits, refactors, tests).',
    },
    prompt: {
      type: 'string',
      description:
        'The full task text: spec, expected files, project conventions, test command, and the anti-fabrication clause. Ground it with real file excerpts. agy prompts must stay under ~120 KB; codex has no cap.',
    },
    model: {
      type: 'string',
      description:
        'Bare model id from the probe band table (agy: e.g. gemini-3.8-flash-medium, claude-sonnet-5-5-high; codex: a catalog slug e.g. gpt-6.1-sol). Never a display name. Omit for the default band (agy gem-med / codex std).',
    },
    effort: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      description: 'Reasoning effort. codex: the band effort (mech medium / std high / hard xhigh / max ultra). agy: optional.',
    },
    edit: {
      type: 'boolean',
      description:
        'agy only: allow the delegate to run commands and modify files (--dangerously-skip-permissions). Without it agy auto-denies every command; a review/research task normally runs without it.',
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
    cwd: { type: 'string', description: 'Working directory for the delegate (default: the session cwd).' },
    worktree: {
      type: 'boolean',
      description: 'Run in a fresh git worktree (<repo>/.claude/worktrees/mc-<job>, branch mc/<job>) so parallel edit jobs never share a tree. The proof line names it (worktree=…); install deps / pick ports in the prompt if the task runs a server.',
    },
    maxTokens: {
      type: 'number',
      description: 'agy only: stop the run cleanly (status=BUDGET) once it has used this many tokens. Default 350000 on the AGY claude pool (Claude / GPT models), none on Gemini; 0 disables.',
    },
    fallback: {
      type: 'string',
      description: 'agy only: bare model id to run instead if the preflight finds the chosen model\'s pool exhausted (nothing spent yet), e.g. a Gemini tier for a Claude-pool job.',
    },
    timeout: { type: 'number', description: 'Seconds before the runner kills the delegate (default agy 600 / codex 900). You are woken at 80%; dispatch_extend adds time.' },
  },
  required: ['delegate', 'prompt'],
}

const DISPATCH_DESCRIPTION = [
  'Start a task on an EXTERNAL delegate CLI — agy (Antigravity: review / research / analysis / heavy reasoning) or codex (OpenAI Codex: implementation / edits / tests) — on that delegate\'s own quota, not Claude\'s.',
  'NON-BLOCKING: returns a job id immediately and the job runs in the background. Do not poll: when it finishes the plugin wakes you with a message carrying the proof line `[dispatch <cli> model=… status=SUCCESS tokens=N …]` and the answer. Meanwhile carry on with other work or end your turn.',
  'Check progress + the delegate\'s live transcript any time with dispatch_status({ id }) (or no id for every job); dispatch_cancel({ id }) kills one. Prefer this over any subagent or Bash call to agy/codex.',
].join(' ')

const STATUS_DESCRIPTION =
  'Progress of a background delegate job: with `id`, that job\'s status, elapsed time, the last lines of its live transcript (tool steps, narration), the proof line and — once done — the full answer. Without `id`, one line per job (newest first), including runner jobs launched from Bash or a workflow node. Use it to check on a dispatch before its wake-up arrives, or to re-read an answer.'

const CANCEL_DESCRIPTION = 'Kill a running background delegate job by `id` (from dispatch / dispatch_status).'

const EXTEND_DESCRIPTION =
  'Give a running delegate job more time: adds `seconds` to its timeout (the runner picks it up within 2 s). The plugin wakes you once when a job passes 80% of its timeout; extend it if its transcript (dispatch_status) shows progress. Works for runner jobs launched from Bash with --job too.'

const fmtDur = (sec: number) =>
  sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`
const stripStamp = (line: string) => line.replace(/^\[\+\d+s\]\s*/, '').trim()
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

// ── the runner (timer context: outlives every dispatch) ──
async function runJob($: EngineInterface, p: Pending) {
  await patchJob($, p.id, j => ({ ...j, status: 'running', startedAt: Date.now(), step: 'starting…' }))
  $.ui.status(`${p.delegate} ${p.label}`)

  let out = ''
  let buf = ''
  let code: number | null = null
  let stopped = false
  let warnedTimeout = false
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
        if (!warnedTimeout && line.includes('⏱ 80% of the')) {
          warnedTimeout = true
          $.ui.toast(`${p.delegate} ${p.label}: 80% of its timeout used`)
          void $.prompt.submit({
            text: `dispatch job ${p.id} (${p.delegate} · ${p.label}) is still running and has used 80% of its timeout.\n${stripStamp(line)}\nCheck dispatch_status({ id: "${p.id}" }): if the transcript shows progress, call dispatch_extend({ id: "${p.id}", seconds: N }); otherwise let it run out or dispatch_cancel it.`,
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
  const outFile = /\bout=(\S+)/.exec(proof)?.[1]
  const status: Job['status'] = stopped ? 'cancelled'
    : code === 0 ? 'done' : code === 3 ? 'denied' : code === 124 ? 'timeout' : code === 2 ? 'usage' : 'failed'
  const answer = out.trimEnd()
  answers.set(p.id, { code, answer, proof, tail: tail.slice(-8) })
  await patchJob($, p.id, j => ({ ...j, status, endedAt: Date.now(), proof: proof || j.proof, outFile, step: proof ? stripStamp(proof) : (tail[tail.length - 1] ?? j.step) }))
  $.ui.status(undefined)
  $.ui.toast(`${p.delegate} ${status}: ${p.label}`)

  // Wake the chat: a plugin prompt starts a turn of its own once the session is idle.
  const diag = tail.filter(l => !l.startsWith('[+')).slice(-6).join('\n')
  const body = answer.length > WAKE_INLINE_CHARS
    ? answer.slice(0, 2000) + `\n…\n[answer is ${answer.length} chars — full text via dispatch_status({ id: "${p.id}" })${outFile ? ' or the file ' + outFile : ''}]`
    : answer
  const hint = status === 'done' ? ''
    : status === 'denied' ? '\nagy denied actions — re-dispatch with edit: true if the task needs commands/edits.'
    : status === 'usage' ? '\nBad usage (unknown model id / prompt too big) — check probe.mjs and re-dispatch.'
    : status === 'cancelled' ? '\nCancelled by dispatch_cancel.'
    : `\nDispatch failed (exit ${code}) — see orchestrate §3 gate 0${/status=QUOTA/.test(proof) ? ': QUOTA → re-route per §5' : ''}.`
  void $.prompt.submit({
    text: `dispatch job ${p.id} (${p.delegate} · ${p.label}) ${status.toUpperCase()}\n${proof || diag}${hint}\n\n${body || '(no output)'}`,
  }).catch(() => undefined)
}

function pump($: EngineInterface) {
  if (pumping) return
  pumping = true
  try {
    while (queue.length && running.size < MAX_RUNNING) {
      const p = queue.shift()!
      running.set(p.id, { stop: () => undefined })   // reserve the slot until spawn registers the real stop
      void runJob($, p)
    }
  } finally { pumping = false }
}

// Fold in runner jobs launched outside the tool (Bash, workflow nodes, forwarders):
// each wrote <id>.json under the jobs dir. Only files from this chat: written since it started and,
// when the runner stamped one, carrying this session's id.
type RunnerMeta = {
  id: string; delegate: 'agy' | 'codex'; model: string | null; effort?: string | null; label: string
  status: Job['status']; startedAt: number; endedAt?: number; step?: string; proof?: string; updatedAt?: number
  /** The Claude Code session that started it (MC_SESSION_ID / CLAUDE_CODE_SESSION_ID); null from an older runner. */
  session?: string | null
}
// This chat's session id: the pane shows only jobs this chat started.
let mySession = ''
async function scanRunnerJobs($: EngineInterface) {
  if (!jobsDir || scanning) return
  scanning = true
  try {
    const entries = await $.fs.list(jobsDir)
    const fresh = entries.filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.mtimeMs >= sessionStartedAt - 60_000)
    if (!fresh.length) return
    const list = await read($, jobs)
    const own = new Set(list.filter(j => j.source !== 'runner').map(j => j.id))
    const metas: RunnerMeta[] = []
    for (const e of fresh) {
      const id = e.name.slice(0, -5)
      if (own.has(id)) continue   // the tool's own jobs are tracked live
      try {
        const m = JSON.parse(await $.fs.read(`${jobsDir}/${e.name}`)) as RunnerMeta
        if (m && m.session && mySession && m.session !== mySession) continue   // another chat's job
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
          id: m.id, delegate: m.delegate === 'codex' ? 'codex' : 'agy', model: m.model ?? '(default band)', effort: m.effort ?? undefined,
          label: m.label ?? m.id, startedAt: m.startedAt ?? Date.now(), endedAt: m.endedAt, status: m.status ?? 'running',
          step: m.step ?? '', proof: m.proof ?? '', outFile: m.proof ? /\bout=(\S+)/.exec(m.proof)?.[1] : undefined, source: 'runner',
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
    const out = r.stdout.trimEnd()
    const errTail = r.stderr.trim().split('\n').slice(-12).join('\n')
    if (r.exitCode === 0) return { text: out || errTail || '(no output)' }
    return { text: `${out}${out ? '\n\n' : ''}exit ${r.exitCode}${errTail ? '\n' + errTail : ''}` }
  } catch (err) {
    return { text: `${rel} did not finish: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    $.ui.status(undefined)
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
// Every 60 s: `accounts.mjs auto --once --json` checks the active account's
// usage against its switch-away line and moves the default login to the stored
// account with the most room. The script holds when fewer than two accounts are
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
      description: 'Open the Delegates pane: live agy / codex dispatches with model, elapsed time and current step',
      immediate: true,   // opens mid-turn too, without waiting for (or starting) a model turn
    })
    try {
      const r = await $.process.run(['node', `${$.plugin.root}/scripts/dispatch.mjs`, '--jobs-dir'], { timeoutMs: 15_000 })
      jobsDir = r.exitCode === 0 ? r.stdout.trim() : ''
    } catch { jobsDir = '' }
    // Mark rows a previous module instance left running (a reload dropped them).
    await update($, jobs, list => list.map((j): Job => isLive(j) && j.source !== 'runner' && !running.has(j.id) && !queue.some(p => p.id === j.id)
      ? { ...j, status: 'failed', endedAt: Date.now(), step: 'lost on reload' } : j)).catch(() => undefined)
    // The runner tick: start queued jobs, fold in runner-launched jobs, redraw timers while any runs.
    let tick = 0
    $.clock.every(1000, () => {
      pump($)
      if (tick++ % 3 === 0) void scanRunnerJobs($)
      if (Date.now() >= autoNextAt) void autoSwitchTick($)
      void read($, jobs).then(list => {
        if (list.some(isLive)) $.ui.invalidate('ui.render')
      }).catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'delegates' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Delegates' })
    return { text: opened.isPlaced ? 'Delegates pane opened.' : `Delegates pane waits: ${opened.reason}` }
  })

  // ── Stats commands answered by the module: the script runs and its output is
  // printed as the command's own output — no model turn, no tokens. Each
  // command is also a skill (skills/<name>/SKILL.md), which stays the fallback
  // on hosts that do not load plugin modules and whenever this hook fails.
  on('command.run', { command: 'multiclaude:quota' }, async ($, e) =>
    runScript($, 'skills/quota/quota.mjs', splitArgs(e.args), 'reading wallet quotas…', 180_000),
  ).catch(($, e, next) => next(e))
  on('command.run', { command: 'multiclaude:setup' }, async ($, e) =>
    runScript($, 'scripts/setup.mjs', splitArgs(e.args), 'checking the multiclaude environment…', 300_000),
  ).catch(($, e, next) => next(e))
  on('command.run', { command: 'multiclaude:probe' }, async ($, e) =>
    runScript($, 'scripts/probe.mjs', splitArgs(e.args), 'probing delegates…', 600_000),
  ).catch(($, e, next) => next(e))
  on('command.run', { command: 'multiclaude:accounts' }, async ($, e) => {
    const a = splitArgs(e.args)
    // `run` needs the terminal and plain `auto` loops forever; neither belongs in a command's output.
    if (a[0] === 'run' || (a[0] === 'auto' && !a.includes('--once')))
      return { text: `Run this in a terminal instead:\n  node "${$.plugin.root}/scripts/accounts.mjs" ${a.join(' ')}\n(auto-switch already runs inside Claude Code every 60 s: /multiclaude:accounts auto --once --dry-run shows its next decision)` }
    const r = await runScript($, 'scripts/accounts.mjs', a, 'reading Claude accounts…', 90_000)
    if (a[0] === 'switch' || a[0] === 'add') autoNextAt = Date.now() + 20_000
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch' }, async ($, e) => {
    const input = e as unknown as {
      delegate: 'agy' | 'codex'; prompt: string; model?: string; effort?: string; edit?: boolean
      sandbox?: string; label?: string; cwd?: string; timeout?: number
      worktree?: boolean; maxTokens?: number; fallback?: string
    }
    const delegate = input.delegate === 'codex' ? 'codex' : 'agy'
    const prompt = String(input.prompt ?? '')
    if (!prompt.trim()) return { deny: 'dispatch: empty prompt' }
    const id = shortId()
    const label = (input.label ?? prompt.replace(/\s+/g, ' ').slice(0, 60)).slice(0, 60)

    const argv = ['node', `${$.plugin.root}/scripts/dispatch.mjs`, delegate, '--job', id, '--label', label]
    if (input.model) argv.push('--model', String(input.model))
    if (input.effort) argv.push('--effort', String(input.effort))
    if (delegate === 'agy' && input.edit) argv.push('--edit')
    if (delegate === 'codex' && input.sandbox) argv.push('--sandbox', String(input.sandbox))
    if (input.timeout) argv.push('--timeout', String(Math.round(input.timeout)))
    if (input.worktree) argv.push('--worktree')
    if (delegate === 'agy' && input.maxTokens != null) argv.push('--max-tokens', String(Math.round(input.maxTokens)))
    if (delegate === 'agy' && input.fallback) argv.push('--fallback', String(input.fallback))

    const job: Job = {
      id, delegate, model: input.model ?? '(default band)', effort: input.effort, label,
      startedAt: Date.now(), status: 'queued', step: 'queued', proof: '', source: 'tool',
    }
    const before = await read($, jobs)
    const pool = delegate === 'codex' ? 'codex' : poolOf(job.model)
    const sharing = before.filter(j => isLive(j) && (j.delegate === 'codex' ? 'codex' : poolOf(j.model)) === pool)
    await update($, jobs, list => [...list.filter(j => j.id !== id), job].slice(-60))
    queue.push({ id, argv, cwd: input.cwd ? String(input.cwd) : undefined, prompt, delegate, label })
    void $.ui.open({ id: PANE, title: 'Delegates' })
    pump($)
    return {
      result:
        `dispatched job ${id}: ${delegate} ${job.model}${input.effort ? '@' + input.effort : ''} — ${label}\n` +
        'Running in the background on the delegate\'s quota. You will be woken with the proof line + answer when it finishes; ' +
        `do not poll. Progress + transcript: dispatch_status({ id: "${id}" }). Cancel: dispatch_cancel({ id: "${id}" }).` +
        (sharing.length
          ? `\nNote: ${sharing.length} other job(s) already draw on the ${pool === 'codex' ? 'Codex' : 'AGY ' + pool} pool (${sharing.map(j => j.id).join(', ')}). Parallel agentic runs drain a pool fast — two Claude-pool edit jobs once emptied a 5h window in 150 s.`
          : ''),
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: dispatch could not be queued` }))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch_status' }, async ($, e) => {
    const { id, all } = e as unknown as { id?: string; all?: boolean }
    if (!id && all) return { result: await listAllJobs($) }
    await scanRunnerJobs($)
    const list = await read($, jobs)
    const now = Date.now()
    if (!id) {
      const rows = [...list].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20)
      return { result: rows.length ? rows.map(j => summary(j, now)).join('\n') : 'no delegate jobs yet' }
    }
    const j = list.find(x => x.id === id)
    if (!j) return { result: `no job ${id}` }
    const head = summary(j, now)
    // Transcript: the module's own log for tool jobs; the runner's .log file for the rest.
    let transcript = logs.get(id) ?? []
    if (!transcript.length && jobsDir) {
      try { transcript = (await $.fs.read(`${jobsDir}/${id}.log`)).split('\n').filter(Boolean) } catch { /* none */ }
    }
    const recent = transcript.slice(-TAIL_LINES).join('\n')
    if (isLive(j)) return { result: `${head}\n\n— live transcript (last ${Math.min(TAIL_LINES, transcript.length)} of ${transcript.length} lines) —\n${recent || '(nothing yet)'}` }
    const a = answers.get(id)
    let answer = a?.answer
    if (answer === undefined && j.outFile) { try { answer = (await $.fs.read(j.outFile)).trimEnd() } catch { /* none */ } }
    return { result: `${head}\n\n${answer ?? '(answer not available — the job file is gone)'}${j.status !== 'done' && recent ? '\n\n— transcript tail —\n' + recent : ''}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: status lookup failed` }))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch_cancel' }, async ($, e) => {
    const id = String((e as unknown as { id: string }).id ?? '')
    const qi = queue.findIndex(p => p.id === id)
    if (qi >= 0) {
      queue.splice(qi, 1)
      await update($, jobs, list => list.map((j): Job => (j.id === id ? { ...j, status: 'cancelled', endedAt: Date.now(), step: 'cancelled before start' } : j)))
      return { result: `job ${id} removed from the queue` }
    }
    const r = running.get(id)
    if (!r) return { result: `job ${id} is not running under this tool (a Bash-launched runner job is stopped by killing its process)` }
    r.stop()
    return { result: `job ${id}: kill requested — its final status follows in the wake-up message` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: cancel failed` }))

  on('tool.call', { tool: 'mcp__multiclaude__dispatch_extend' }, async ($, e) => {
    const { id, seconds } = e as unknown as { id?: string; seconds?: number }
    const safe = String(id ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_')
    const sec = Math.round(Number(seconds))
    if (!safe || !(sec > 0)) return { result: 'dispatch_extend needs { id, seconds > 0 }' }
    if (!jobsDir) return { result: 'jobs dir unknown — cannot reach the runner' }
    const j = (await read($, jobs)).find(x => x.id === safe)
    if (j && !isLive(j)) return { result: `job ${safe} is ${j.status} — nothing to extend` }
    await $.fs.write(`${jobsDir}/${safe}.extend`, String(sec))
    return { result: `job ${safe}: +${sec}s requested — the runner confirms with a ⏱ line in its transcript within 2 s` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: extend failed` }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, jobs)
    const now = Date.now()
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 2) / 2))
    const rows = [...list].sort((a, b) => b.startedAt - a.startedAt).slice(0, room)
    const mark = (s: Job['status']) => (s === 'running' ? '●' : s === 'queued' ? '○' : s === 'done' ? '✓' : '✗')

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>No external dispatches yet — the dispatch tool (agy / codex) lists them here.</Text>}
        {rows.map(j => {
          const live = isLive(j)
          const head = `${mark(j.status)} ${j.id} ${j.delegate} ${j.model}${j.effort ? '@' + j.effort : ''} · ${fmtDur(elapsed(j, now))} · ${j.label}${j.source === 'runner' ? ' ·bash' : ''}`
          return (
            <Box flexDirection="column">
              <Text bold={live} dimColor={!live}>{head}</Text>
              <Text dimColor>{'   ' + (live ? j.step : j.proof || j.step || j.status)}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
