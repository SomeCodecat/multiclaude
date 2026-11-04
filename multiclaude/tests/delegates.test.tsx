import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'multiclaude',
  component: 'Pane',
  requestId: 'delegates',
  props: {
    title: 'Delegates',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('session start registers the dispatch tool and the /delegates command', async ($, on) => {
  const registered: string[] = []
  on('tool.register', (_, e) => { registered.push(`tool:${e.name}`); return { value: { tool: `mcp__multiclaude__${e.name}` } } })
  on('command.register', (_, e) => { registered.push(`command:${e.name}`); return { value: { command: e.name } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(registered).toContain('tool:dispatch')
  expect(registered).toContain('command:delegates')
})

test('the empty pane explains itself on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await ui.find({ type: 'Text', text: /No external dispatches yet/ })
    expect(row).toBeDefined()
    await ui.unmount()
  }
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: [{ id: 'x', delegate: 'agy' }], version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No external dispatches yet/ }))).toBeDefined()
  await ui.unmount()
})

test('/multiclaude:quota prints the script output itself, no model turn', async ($, on) => {
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'QUOTA REPORT\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const r = await $.command.run({ command: 'multiclaude:quota' })
  expect(r.text).toBe('QUOTA REPORT')
  expect(ran[0]?.[1]).toMatch(/skills\/quota\/quota\.mjs$/)
})

test('/multiclaude:setup passes its arguments through, quotes kept together', async ($, on) => {
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 1, stdout: 'checks', stderr: 'boom\n', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const r = await $.command.run({ command: 'multiclaude:setup', args: 'apply --set env.X="a b"' })
  expect(ran[0]?.slice(2)).toEqual(['apply', '--set', 'env.X=a b'])
  expect(r.text).toContain('exit 1')
  expect(r.text).toContain('boom')
})

test('dispatch_extend hands the runner an <id>.extend request in the jobs dir', async ($, on) => {
  on('tool.register', (_, e) => ({ value: { tool: `mcp__multiclaude__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/jobs\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const writes: [string, string][] = []
  on('fs.write', (_, e) => { writes.push([e.path, e.text]); return { value: undefined } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__multiclaude__dispatch_extend', id: 'jab/c', seconds: 119.6 } as never)
  expect(writes).toEqual([['/jobs/jab_c.extend', '120']])
})

test('/multiclaude:accounts runs the accounts script with its arguments', async ($, on) => {
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'Switched to #2\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const r = await $.command.run({ command: 'multiclaude:accounts', args: 'switch work' })
  expect(r.text).toBe('Switched to #2')
  expect(ran[0]?.[1]).toMatch(/scripts\/accounts\.mjs$/)
  expect(ran[0]?.slice(2)).toEqual(['switch', 'work'])
})

test('/multiclaude:accounts run is sent to a terminal, never spawned', async ($, on) => {
  const ran: string[][] = []
  on('process.run', (_, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  const r = await $.command.run({ command: 'multiclaude:accounts', args: 'run 2 -- --resume' })
  expect(ran).toEqual([])
  expect(r.text).toContain('scripts/accounts.mjs" run 2 -- --resume')
})

test('first run: a one-time notice that nothing was changed, until /multiclaude:setup runs', async ($, on) => {
  const toasts: string[] = []
  const stored: Record<string, unknown> = {}
  on('tool.register', (_, e) => ({ value: { tool: `mcp__multiclaude__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => { stored[e.key] = e.value; return { value: undefined } })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(toasts.some(t => /changed nothing/.test(t))).toBe(true)

  await $.command.run({ command: 'multiclaude:setup' })
  expect(stored.onboarded).toBeDefined()

  toasts.length = 0
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(toasts.some(t => /changed nothing/.test(t))).toBe(false)
})

const ENGINE = (on: Parameters<Parameters<typeof test>[1]>[1], opened: string[] = [], stored: Record<string, unknown> = {}, noRun = false) => {
  on('tool.register', (_, e) => ({ value: { tool: `mcp__multiclaude__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  if (!noRun) on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: e.key === 'onboarded' ? 1 : stored[e.key] }))
  on('store.set', (_, e) => { stored[e.key] = e.value; return { value: undefined } })
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
}

test('loading the orchestrate skill opens the Delegates pane; the setting turns it off', async ($, on) => {
  const opened: string[] = []
  const stored: Record<string, unknown> = {}
  ENGINE(on, opened, stored)
  on('skill.prompt', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const call = { skill: 'multiclaude:orchestrate', text: 'rules', frontmatter: {}, source: 'plugin', pluginName: 'multiclaude' }
  await $.skill.prompt(call as never)
  expect(opened).toEqual(['delegates'])

  // settings view: key 1 cycles "Open when orchestration starts" to off, saved to the store
  await $.command.run({ command: 'delegates', args: 'settings' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Delegates settings/ })).toBeDefined()
  await ui.press({ key: 'set-1' })
  expect((stored.settings as { openOnOrchestrate: boolean }).openOnOrchestrate).toBe(false)
  await ui.unmount()

  opened.length = 0
  await $.skill.prompt(call as never)
  expect(opened).toEqual([])
})

test('a job row opens its detail view; a failed job shows its transcript tail', async ($, on) => {
  ENGINE(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__multiclaude__dispatch', delegate: 'codex', model: 'gpt-test', prompt: 'do it', label: 'impl thing' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /gpt-test/ })).toBeDefined()
  const id = (await ui.findAll({ type: 'Button' })).map(b => b.key).find(k => k?.startsWith('open-'))?.slice(5)
  expect(id).toBeDefined()
  await ui.press({ key: `open-${id}` })
  // the runner cannot spawn here, so the job failed: detail shows its transcript tail, no cancel
  expect(await ui.find({ type: 'Text', text: /transcript tail/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'cancel' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  await ui.unmount()
})

test('the Wallets pane draws the Claude pool, each account and the AGY pools', async ($, on) => {
  ENGINE(on, [], {}, true)
  on('process.run', (_, e) => {
    const out = e.argv.some(a => /usage-snapshot/.test(a))
      ? JSON.stringify({ ageSec: 12, claude: { pool: 2, fiveHour: 20, sevenDay: 40, active: '2', auto: true }, codex: { windows: [{ label: 'wk', pct: 63 }] }, agy: { gemini: { fiveHour: 5, weekly: 18, exhausted: false } } })
      : e.argv.some(a => /accounts\.mjs/.test(a))
        ? JSON.stringify({ accounts: [{ slot: '1', email: 'a@x', active: false, disabled: false, usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 73 } } }, { slot: '2', email: 'b@x', active: true, disabled: false, usage: { fiveHour: { pct: 39 }, sevenDay: { pct: 6 } } }] })
        : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wallets' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, requestId: 'wallets', props: { ...PANE.props, title: 'Wallets' }, surface })
    expect(await ui.find({ type: 'Text', text: /pool of 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶2 b/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'switch-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gemini/ })).toBeDefined()
    await ui.unmount()
  }
})

const ROW = (usd: number, total: number) => ({ in: 10, cacheRead: total - 110, cacheWrite: 0, cacheWrite1h: 0, out: 100, reasoning: 0, calls: 3, usd, unpriced: 0, input: total - 100, total })
const TRACKER = JSON.stringify({
  since: '7d', from: '2026-10-29', firstDay: '2026-04-07', scannedAt: 1, totals: ROW(12.5, 3_000_000),
  wallets: [{ wallet: 'claude', ...ROW(10, 2_000_000) }, { wallet: 'codex', ...ROW(2.5, 1_000_000) }],
  accounts: [{ wallet: 'claude', account: '1', label: 'a@x', ...ROW(6, 1_200_000) }, { wallet: 'claude', account: '?', label: 'unattributed', ...ROW(4, 800_000) }, { wallet: 'codex', account: 'codex', label: 'codex', ...ROW(2.5, 1_000_000) }],
  models: [{ wallet: 'claude', model: 'claude-opus-5-5', priced: true, ...ROW(10, 2_000_000) }, { wallet: 'codex', model: 'mystery-model', priced: false, ...ROW(0, 1_000_000), unpriced: 1_000_000 }],
})

test('the Wallets pane shows token usage and spend: combined or split, per wallet, account and model', async ($, on) => {
  ENGINE(on, [], {}, true)
  const tracker: string[][] = []
  on('process.run', (_, e) => {
    if (e.argv.some(a => /tracker\.mjs/.test(a))) tracker.push([...e.argv])
    const out = e.argv.some(a => /tracker\.mjs/.test(a)) ? TRACKER : e.argv.some(a => /usage-snapshot/.test(a)) ? JSON.stringify({ ageSec: 1 }) : JSON.stringify({ accounts: [] })
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wallets' })
  const ui = await $.ui.mount({ ...PANE, requestId: 'wallets', props: { ...PANE.props, title: 'Wallets' }, surface: 'terminal' })
  expect(tracker[0]).toContain('7d')
  expect(await ui.find({ type: 'Text', text: /7d, from 2026-10-29/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /in\+out/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3\.0M\s+\$12\.50/ })).toBeDefined()     // ALL: combined total + spend
  expect(await ui.find({ type: 'Text', text: /claude-opus-5-5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /mystery-model \(no \$\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude unattributed/ })).toBeDefined()  // claude has 2 accounts → by account
  expect(await ui.find({ type: 'Text', text: /codex codex/ })).toBeUndefined()        // one codex account → no row
  await ui.press({ key: 'split' })
  expect(await ui.find({ type: 'Text', text: /cached/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3\.0M\s+3\.0M\s+100\s+\$12\.50/ })).toBeDefined()
  await ui.press({ key: 'period' })
  expect(tracker.at(-1)).toEqual(expect.arrayContaining(['30d', '--no-scan']))
  expect((await ui.find({ type: 'Button', key: 'period' }))?.text).toBe('period: 30d')   // view kept in $.state + $.store
  await ui.unmount()
})

test('/multiclaude:usage prints the tracker report itself, no model turn', async ($, on) => {
  ENGINE(on, [], {}, true)
  let argv: string[] = []
  on('process.run', (_, e) => { argv = [...e.argv]; return { value: { exitCode: 0, stdout: '[multiclaude usage] today\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  const r = await $.command.run({ command: 'multiclaude:usage', args: 'today' })
  expect(r.text).toMatch(/multiclaude usage/)
  expect(argv.at(-1)).toBe('today')
  expect(argv.some(a => /scripts\/tracker\.mjs$/.test(a))).toBe(true)
})

test('clear finished keeps a runner job file from folding the row back in', async ($, on) => {
  ENGINE(on, [], {}, true)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/jobs\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const t0 = Date.now()
  const meta = { id: 'old1', delegate: 'agy', model: 'gem-x', label: 'old review', status: 'done', startedAt: t0, endedAt: t0, updatedAt: t0, proof: '[dispatch agy status=SUCCESS]', session: null }
  on('fs.list', () => ({ value: [{ name: 'old1.json', kind: 'file', size: 1, mtimeMs: t0 }] }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('.json') ? JSON.stringify(meta) : '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'mcp__multiclaude__dispatch_status' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /old review/ })).toBeDefined()
  await ui.press({ key: 'clear' })
  // the next scan (dispatch_status runs one) must not bring it back
  await $.tool.call({ tool: 'mcp__multiclaude__dispatch_status' } as never)
  expect(await ui.find({ type: 'Text', text: /old review/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No external dispatches yet/ })).toBeDefined()
  await ui.unmount()
})

test('/multiclaude:orchestrate with no task arms the rules + probe as context, no model turn', async ($, on) => {
  const opened: string[] = []
  ENGINE(on, opened, {}, true)
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '[multiclaude probe]\n  run: node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs"\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_, e) => ({ value: e.path.endsWith('skills/orchestrate/SKILL.md') ? '---\nname: orchestrate\ndescription: x\n---\n\n# Orchestrate\nrun node "${CLAUDE_PLUGIN_ROOT}/scripts/probe.mjs"\n' : '' }))
  let reachedSkill = 0
  on('command.run', () => { reachedSkill++; return { text: 'skill ran' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await $.command.run({ command: 'multiclaude:orchestrate', args: '' })
  expect(reachedSkill).toBe(0)
  expect(ran.some(a => /scripts\/probe\.mjs$/.test(a[1] ?? ''))).toBe(true)
  expect(r.text).toContain('[multiclaude probe]')
  expect(r.text).toContain('armed')
  expect(r.context?.length).toBe(1)
  const ctx = r.context?.[0] ?? ''
  expect(ctx).toContain('# Orchestrate')
  expect(ctx).toContain('do not run the probe again')
  expect(ctx).not.toContain('name: orchestrate')
  expect(ctx).not.toContain('${CLAUDE_PLUGIN_ROOT}')
  expect(opened).toEqual(['delegates'])

  // with a task, the skill runs as usual
  const r2 = await $.command.run({ command: 'multiclaude:orchestrate', args: 'fix the login bug' })
  expect(reachedSkill).toBe(1)
  expect(r2.text).toBe('skill ran')
})

test('bare /multiclaude:orchestrate in a chat with work under way offers to split it; a yes submits the request', async ($, on) => {
  ENGINE(on, [], {}, true)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[multiclaude probe]\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: '---\nname: orchestrate\n---\n# Orchestrate\n' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'plan the auth rewrite', toolUses: [] }, { role: 'assistant', text: 'Plan: 1. … 2. …', toolUses: [] }] }))
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    asked.push(q)
    return { result: { questions: [], answers: { [q]: 'Split it now' } } } as never
  })
  const submitted: string[] = []
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'multiclaude:orchestrate', args: '' })
  for (let i = 0; i < 50 && !submitted.length; i++) await new Promise(r => setTimeout(r, 5))
  expect(asked[0]).toMatch(/Split the work currently being planned/)
  expect(submitted[0]).toMatch(/^Split the work currently being planned in this conversation across the delegates/)
})

test('bare /multiclaude:orchestrate in a fresh chat asks nothing', async ($, on) => {
  ENGINE(on, [], {}, true)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[multiclaude probe]\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: '# Orchestrate\n' }))
  on('session.messages', () => ({ value: [] }))
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, () => { asked++; return { result: {} } as never })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'multiclaude:orchestrate', args: '' })
  await new Promise(r => setTimeout(r, 30))
  expect(asked).toBe(0)
})

test('/multiclaude:failures prints the log summary; review queues one AGY job with the review prompt', async ($, on) => {
  ENGINE(on, [], {}, true)
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const a = e.argv.join(' ')
    const stdout = a.includes('--jobs-dir') ? '/jobs\n'
      : a.includes('--review-prompt') ? 'You are reviewing why delegated runs failed…\n'
      : a.includes('failures.mjs') ? '[multiclaude failures] 2 failed runs\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await $.command.run({ command: 'multiclaude:failures', args: '20 --since all' })
  expect(r.text).toContain('[multiclaude failures] 2 failed runs')
  expect(ran.find(a => /failures\.mjs$/.test(a[1] ?? ''))?.slice(2)).toEqual(['20', '--since', 'all'])

  const r2 = await $.command.run({ command: 'multiclaude:failures', args: 'review' })
  expect(r2.text).toMatch(/queued on AGY .* as job \S+/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /failure log review/ })).toBeDefined()
  await ui.unmount()
})

test('Claude subagents get a row: steps from their tool calls, ended by their last turn; forwarders are skipped', async ($, on) => {
  ENGINE(on)
  on('agent.spawn', (_, e) => ({ model: 'claude-sonnet-5-5', agentId: `ag-${e.description.replace(/\W+/g, '-')}` }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const base = { tool_use_id: 't1', provider: 'core', parentModel: 'claude-opus-5-5' }
  await $.agent.spawn({ ...base, description: 'map the auth flow', prompt: 'Find where tokens are refreshed.', subagentType: 'Explore' } as never)
  await $.agent.spawn({ ...base, description: 'forward to codex', prompt: '--model x do it', subagentType: 'multiclaude:mc-codex' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'refreshToken', agentId: 'ag-map-the-auth-flow' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /map the auth flow ·Explore/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude-sonnet-5-5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Grep refreshToken/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /forward to codex/ })).toBeUndefined()

  await $.turn.complete({ agentId: 'ag-map-the-auth-flow', answer: 'Tokens refresh in auth/session.ts.', durationMs: 4000, isAborted: false, turnId: 'x', reason: 'answer' } as never)
  expect(await ui.find({ type: 'Text', text: /answered · 4s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Tokens refresh in auth\/session\.ts/ })).toBeDefined()

  // settings 6 hides Claude rows
  await $.command.run({ command: 'delegates', args: 'settings' })
  await ui.press({ key: 'set-6' })
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /map the auth flow/ })).toBeUndefined()
  await ui.unmount()
})

test('a subagent that calls dispatch folds into the job it started', async ($, on) => {
  ENGINE(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'drv1' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't', provider: 'core', parentModel: 'p', description: 'node: review api', prompt: 'call dispatch', subagentType: 'general-purpose' } as never)
  await $.tool.call({ tool: 'mcp__multiclaude__dispatch', delegate: 'agy', model: 'gemini-test', prompt: 'review the api', label: 'agy:review api', agentId: 'drv1' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /agy:review api/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /via general-purpose “node: review api”/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^node: review api/ })).toBeUndefined()
  await ui.unmount()
})
