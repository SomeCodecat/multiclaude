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
