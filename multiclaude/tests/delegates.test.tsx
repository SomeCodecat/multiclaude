import { expect, mock, test } from 'claude-code/testing'

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
  const ran: string[][] = []
  ENGINE(on, opened, stored, true)
  on('process.run', (_, e) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: 'ok\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
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
  // key 7 switches the wallet rows of the status line off: saved, and the script told (it owns the flag file)
  await ui.press({ key: 'set-7' })
  expect((stored.settings as { statusline?: boolean }).statusline).toBe(false)
  expect(ran.some(a => a.join(' ').includes('usage-snapshot.mjs --wallet-rows off'))).toBe(true)
  await ui.unmount()

  opened.length = 0
  await $.skill.prompt(call as never)
  expect(opened).toEqual([])
})

test('inside herdr no pane opens by itself; /delegates still opens it', async ($, on) => {
  const opened: string[] = []
  ENGINE(on, opened, {}, true)
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv.includes('--herdr') ? 'herdr\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.skill.prompt({ skill: 'multiclaude:orchestrate', text: 'rules', frontmatter: {}, source: 'plugin', pluginName: 'multiclaude' } as never)
  expect(opened).toEqual([])
  await $.command.run({ command: 'delegates', args: '' })
  expect(opened).toEqual(['delegates'])
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
      ? JSON.stringify({ ageSec: 12, claude: { pool: 2, fiveHour: 20, sevenDay: 40, active: '2', auto: true }, codex: { windows: [{ label: 'wk', pct: 63 }] }, agy: { gemini: { fiveHour: 5, weekly: 18, exhausted: false } }, pi: { installed: true, unlimited: true, today: { usd: 0.2, runs: 1, tokens: 38054, approx: false }, d7: { usd: 1.354, runs: 6, tokens: 250000, approx: true } } })
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
    // pi has no quota: ∞, and the spend — $ reported by the provider, ≈$ when a run was priced at list price
    expect(await ui.find({ type: 'Text', text: /trial · no quota/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$0\.20 today · ≈\$1\.35 7d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· 6 runs/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Refresh in the Wallets pane re-reads the snapshot now (--force), not only the accounts; an exhausted Codex is marked', async ($, on) => {
  ENGINE(on, [], {}, true)
  const snaps: string[][] = []
  on('process.run', (_, e) => {
    if (e.argv.some(a => /usage-snapshot/.test(a))) snaps.push([...e.argv])
    const fresh = snaps.at(-1)?.includes('--force')
    const out = e.argv.some(a => /usage-snapshot/.test(a))
      ? JSON.stringify({ ageSec: fresh ? 0 : 1140, codex: { windows: [{ label: 'wk', pct: 100 }], exhausted: true, until: Date.UTC(2026, 10, 11, 13, 28) } })
      : JSON.stringify({ accounts: [] })
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wallets' })
  const ui = await $.ui.mount({ ...PANE, requestId: 'wallets', props: { ...PANE.props, title: 'Wallets' }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /out of quota until 11-11 13:28 UTC/ })).toBeDefined()
  expect(snaps.some(a => a.includes('--force'))).toBe(false)
  await ui.press({ key: 'refresh' })
  for (let i = 0; i < 50 && !snaps.some(a => a.includes('--force')); i++) await new Promise(r => setTimeout(r, 5))
  expect(snaps.at(-1)).toEqual(expect.arrayContaining(['--json', '--force']))
  await ui.unmount()
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

test('chat commands get colour in the terminal, with the text itself unchanged', async ($, on) => {
  ENGINE(on, [], {}, true)
  const plain = '▌ CODEX  (ChatGPT)\n  weekly   ████████░░   91%  · resets in 6d20h\n  ✓ codex logged in\n  ✗ agy CLI\n      fix: agy login\n    std  = gpt-6-astra @ high   // workhorse'
  on('process.run', () => ({ value: { exitCode: 0, stdout: plain + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  let surfaces: ('terminal' | 'desktop')[] = ['terminal']
  on('session.surfaces', () => ({ value: surfaces }))
  const r = await $.command.run({ command: 'multiclaude:quota', args: '' })
  expect(r.text).toContain('\x1b[38;2;')
  expect(r.text.replace(/\x1b\[[0-9;]*m/g, '')).toBe('\n' + plain)   // a block starts on its own line (host prefix)
  expect(r.text).toMatch(/\x1b\[38;2;224;108;117m91%/)   // ≥ 85 % used → red
  surfaces = ['terminal', 'desktop']                       // an app attached: plain text
  expect((await $.command.run({ command: 'multiclaude:quota', args: '' })).text).toBe('\n' + plain)
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
  ENGINE(on, [], {}, true)
  const priced: string[] = []
  on('process.run', (_, e) => {
    const isPrice = /price\.mjs$/.test(e.argv[1] ?? '')
    if (isPrice) priced.push(e.argv[2]!)
    return { value: { exitCode: 0, stdout: isPrice ? JSON.stringify([{ file: e.argv[2], usd: 0.4239 }]) : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('classic.SubagentStop', () => ({}))
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

  // its transcript priced at list price (scripts/price.mjs) → ≈$… on the row and in the pane's sum
  expect(await ui.find({ type: 'Text', text: /for these jobs/ })).toBeUndefined()
  await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'ag-map-the-auth-flow', agent_transcript_path: '/t/agent-1.jsonl', agent_type: 'Explore' } as never)
  await $.classic.SubagentStop({ stop_hook_active: false, agent_id: 'ag-unknown', agent_transcript_path: '/t/agent-2.jsonl', agent_type: 'Explore' } as never)
  expect(priced).toEqual(['/t/agent-1.jsonl'])
  expect(await ui.find({ type: 'Text', text: /answered · 4s · ≈\$0\.42/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /≈ \$0\.42 for these jobs at API list price/ })).toBeDefined()

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

test('/multiclaude:help opens the help pane; d / w open Delegates and Wallets; h in the panes opens help', async ($, on) => {
  const opened: string[] = []
  ENGINE(on, opened)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'multiclaude:help', args: '' })
  expect(opened).toContain('multiclaude-help')
  expect(r.text).toMatch(/help opened/)
  const help = await $.ui.mount({ ...PANE, requestId: 'multiclaude-help', props: { ...PANE.props, title: 'multiclaude help' }, surface: 'terminal' })
  for (const name of [/\/multiclaude:orchestrate/, /\/multiclaude:setup/, /\/delegates/, /\/wallets/, /dispatch_status/])
    expect(await help.find({ type: 'Text', text: name })).toBeDefined()
  await help.press({ key: 'delegates' })
  await help.press({ key: 'wallets' })
  expect(opened).toEqual(['multiclaude-help', 'delegates', 'wallets'])
  await help.unmount()

  opened.length = 0
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'help' })
  await pane.unmount()
  const wallets = await $.ui.mount({ ...PANE, requestId: 'wallets', props: { ...PANE.props, title: 'Wallets' }, surface: 'terminal' })
  await wallets.press({ key: 'help' })
  await wallets.unmount()
  expect(opened).toEqual(['multiclaude-help', 'multiclaude-help'])
})

test('/multiclaude:help prints the help as text where no pane can be placed', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('store.get', (_, e) => ({ value: e.key === 'onboarded' ? 1 : undefined }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no room' } }))
  const r = await $.command.run({ command: 'multiclaude:help', args: '' })
  expect(r.text).toMatch(/^\[multiclaude help\]/)
  expect(r.text).toMatch(/\/multiclaude:accounts/)
  expect(r.text).toMatch(/Pane hotkeys/)
})

test('/multiclaude:setup companions opens the Setup pane; a key installs or removes one through setup.mjs', async ($, on) => {
  const opened: string[] = []
  const ran: string[][] = []
  ENGINE(on, opened, {}, true)
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const out = e.argv.includes('--json')
      ? JSON.stringify({ cli: true, companions: [
        { name: 'superpowers', id: 'superpowers@superpowers-marketplace', what: 'workflow skills', installed: true, enabled: true, state: 'enabled' },
        { name: 'claude-mem', id: 'claude-mem@thedotmack', what: 'memory', installed: false, enabled: false, state: 'absent' },
        { name: 'ccstatusline', what: 'session line on top', installed: false, enabled: false, state: 'absent' },
      ] })
      : '  - uninstalled superpowers@superpowers-marketplace\n  · the running session keeps it until Claude Code restarts\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'multiclaude:setup', args: 'companions' })
  expect(opened).toContain('multiclaude-setup')
  expect(r.text).toMatch(/companions menu/)
  const ui = await $.ui.mount({ ...PANE, requestId: 'multiclaude-setup', props: { ...PANE.props, title: 'multiclaude setup — companions' }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /superpowers/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act-superpowers' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act-claude-mem' })).toBeDefined()
  await ui.press({ key: 'act-superpowers' })
  expect(ran.some(a => a.join(' ').endsWith('setup.mjs companions remove superpowers'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /restarts/ })).toBeDefined()
  await ui.press({ key: 'act-claude-mem' })
  expect(ran.some(a => a.join(' ').endsWith('setup.mjs companions add claude-mem'))).toBe(true)
  await ui.unmount()
})

test('herdr-mascots: inside herdr with the companion on, each actor\'s activity is written to herdr-core', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const docs: { actors: { id: string; kind: string; state: string; detail: string; ended: number | null }[] }[] = []
  on('tool.register', (_, e) => ({ value: { tool: `mcp__multiclaude__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: e.key === 'onboarded' ? 1 : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const out = e.argv.includes('--herdr') ? 'herdr\n' : e.argv.includes('--enabled') ? 'on\n' : ''
    if (e.argv.some(a => a.endsWith('herdr-activity.mjs')) && e.argv.at(-1) === 'set') docs.push(JSON.parse(String(e.init?.stdin)))
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-1' }))
  // the Bash call stays open until the test lets it finish, so the tick writes while it runs
  let finishBash = () => {}
  const bashDone = new Promise<void>(r => { finishBash = r })
  on('tool.call', async (_, e) => { if (e.tool === 'Bash') await bashDone; return { result: 'ok' } })
  on('tool.check', (_, e) => ({ decision: e.tool === 'Edit' ? 'ask' : 'allow' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/home/x/myrepo', surface: 'terminal', isInteractive: true })
  const last = () => docs.at(-1)!
  const main = () => last().actors.find(a => a.id === 'main')!

  await clock.advance(1_000)
  expect(main().state).toBe('greeting')

  // a subagent: its tool call is classified while it runs (a test command → testing)
  await $.agent.spawn({ tool_use_id: 't1', provider: 'core', parentModel: 'claude-opus-5-5', description: 'run the tests', prompt: 'npm test', subagentType: 'general-purpose' } as never)
  const bash = $.tool.call({ tool: 'Bash', command: 'npm test -- --watch=false', agentId: 'ag-1' } as never)
  await clock.advance(2_000)
  const running = last().actors.find(a => a.id === 'ag-1')!
  expect(running.kind).toBe('subagent')
  expect(running.state).toBe('testing')
  expect(running.detail).toMatch(/npm test/)
  finishBash()
  await bash

  // a permission ask on the main chat → waiting-for-you
  await $.tool.check({ tool: 'Edit', input: { file_path: '/x' } } as never)
  await clock.advance(2_000)
  expect(main().state).toBe('waiting-for-you')

  // the subagent ends → done with `ended`; the chat's turn ends → done
  await $.turn.complete({ agentId: 'ag-1', answer: 'all green', durationMs: 3000, isAborted: false, turnId: 'x', reason: 'answer' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 3000, isAborted: false, turnId: 'y', reason: 'answer' } as never)
  await clock.advance(2_000)
  const sub = last().actors.find(a => a.id === 'ag-1')!
  expect(sub.state).toBe('done')
  expect(sub.ended).not.toBeNull()
  expect(main().state).toBe('done')

  // unchanged → no new write
  const n = docs.length
  await clock.advance(4_000)
  expect(docs.length).toBe(n)
})

test('herdr-mascots: off by default — nothing is written to herdr-core', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  let sets = 0
  on('tool.register', (_, e) => ({ value: { tool: `mcp__multiclaude__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: e.key === 'onboarded' ? 1 : undefined }))
  on('process.run', (_, e) => {
    if (e.argv.at(-1) === 'set') sets++
    const out = e.argv.includes('--herdr') ? 'herdr\n' : e.argv.includes('--enabled') ? 'off\n' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/x' } as never)
  await clock.advance(3_000)
  expect(sets).toBe(0)
})

test('the Setup pane groups the companions: a herdr heading above herdr-mascots', async ($, on) => {
  ENGINE(on, [], {}, true)
  on('process.run', (_, e) => {
    const out = e.argv.includes('--json')
      ? JSON.stringify({ cli: true, companions: [
        { name: 'ccstatusline', section: 'plugins & status line', what: 'session line on top', installed: false, enabled: false, state: 'absent' },
        { name: 'herdr-mascots', section: 'herdr', what: 'a live mascot per agent in herdr', installed: false, enabled: false, state: 'absent' },
      ] })
      : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'multiclaude:setup', args: 'companions' })
  const ui = await $.ui.mount({ ...PANE, requestId: 'multiclaude-setup', props: { ...PANE.props, title: 'multiclaude setup — companions' }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ herdr$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ plugins & status line$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act-herdr-mascots' })).toBeDefined()
  await ui.unmount()
})

test('the 80 % timeout wake fires again after each extension; a timeout says how it ended', async ($, on) => {
  ENGINE(on)
  const submitted: string[] = []
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('process.spawn', async function* () {
    yield { stream: 'stderr' as const, text: '[+0s] ⏱ 80% of the 100s timeout used — extend with dispatch_extend\n' }
    yield { stream: 'stderr' as const, text: '[+1s] ⏱ timeout extended by 60s — now 160s\n' }
    yield { stream: 'stderr' as const, text: '[+2s] ⏱ 80% of the 160s timeout used — extend with dispatch_extend\n' }
    yield { stream: 'stderr' as const, text: '[+3s] ⏱ 80% of the 160s timeout used — a repeat the runner never prints\n' }
    yield { stream: 'stderr' as const, text: '[dispatch codex model=gpt-test status=TIMEOUT tokens=0]\n' }
    return { value: { code: 124, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__multiclaude__dispatch', delegate: 'codex', model: 'gpt-test', prompt: 'do it', label: 'long job' } as never)
  for (let i = 0; i < 100 && !submitted.some(t => /TIMEOUT/.test(t)); i++) await new Promise(r => setTimeout(r, 5))

  const warns = submitted.filter(t => /has used 80% of its timeout/.test(t))
  expect(warns.length).toBe(2)
  expect(warns[0]).toMatch(/woken again at 80% of the new limit/)
  expect(warns[1]).toMatch(/warning 2, after 1 extension/)
  expect(submitted.at(-1)).toMatch(/Timed out at its limit after 2 warnings/)
})

test('a pi job wakes the chat at every checkpoint and its result asks for the gates and a grade', async ($, on) => {
  ENGINE(on)
  const submitted: string[] = []
  const spawned: string[][] = []
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    yield { stream: 'stderr' as const, text: '[+1s] ⚙ read src/a.mjs\n[+2s] ⚙ bash npm test\n' }
    yield { stream: 'stderr' as const, text: '[+3s] ⏸ checkpoint: 8 steps · 9 calls · 12,000 tokens · 1 file(s) edited (src/a.mjs)\n' }
    yield { stream: 'stderr' as const, text: '[+9s] ⏸ checkpoint: 16 steps · 17 calls · 30,000 tokens · 1 file(s) edited (src/a.mjs)\n' }
    yield { stream: 'stdout' as const, text: 'Fixed the off-by-one in src/a.mjs.\n' }
    yield { stream: 'stderr' as const, text: '[dispatch pi model=local-med status=SUCCESS tokens=31,000 dur=20.0s steps=17 calls=18 edited=1]\n' }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'mcp__multiclaude__dispatch', delegate: 'pi', model: 'local-med', effort: 'high', edit: true, maxSteps: 30, checkpoint: 5, prompt: 'fix the bug', label: 'off-by-one' } as never)
  expect(String((r as { result?: string }).result)).toMatch(/TRIAL delegate/)
  for (let i = 0; i < 100 && !submitted.some(t => /SUCCESS/.test(t)); i++) await new Promise(r => setTimeout(r, 5))

  const argv = spawned[0] ?? []
  expect(argv[2]).toBe('pi')
  expect(argv).toContain('--edit')
  expect(argv).not.toContain('--effort')   // the effort is part of a pi model id
  expect(argv.slice(argv.indexOf('--max-steps'), argv.indexOf('--max-steps') + 2)).toEqual(['--max-steps', '30'])
  expect(argv.slice(argv.indexOf('--checkpoint'), argv.indexOf('--checkpoint') + 2)).toEqual(['--checkpoint', '5'])

  const checks = submitted.filter(t => /checkpoint \d — still running/.test(t))
  expect(checks.length).toBe(2)
  expect(checks[0]).toMatch(/8 steps/)
  expect(checks[0]).toMatch(/bash npm test/)            // its last steps ride along: no status call needed
  expect(checks[1]).toMatch(/dispatch_cancel\(\{ id: "/)
  const done = submitted.at(-1) ?? ''
  expect(done).toMatch(/DONE/)
  expect(done).toMatch(/nothing from pi is accepted unjudged/)
  expect(done).toMatch(/dispatch_grade\(\{ id: "/)
})

test('a pi run the loop guard stopped says so; a Codex result asks for no grade', async ($, on) => {
  ENGINE(on)
  const submitted: string[] = []
  let n = 0
  on('prompt.submit', (_, e) => { submitted.push(e.text); return { text: e.text } })
  on('process.spawn', async function* () {
    if (n++ === 0) {
      yield { stream: 'stderr' as const, text: '[dispatch pi model=local-med status=LOOP tokens=9,000 dur=40.0s steps=12 calls=13 loop="same call 3× — read src/a.mjs"]\n' }
      return { value: { code: 1, signal: null } }
    }
    yield { stream: 'stdout' as const, text: 'done\n' }
    yield { stream: 'stderr' as const, text: '[dispatch codex model=gpt-test status=SUCCESS tokens=100 dur=2.0s]\n' }
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__multiclaude__dispatch', delegate: 'pi', model: 'local-med', prompt: 'fix it', label: 'loops' } as never)
  for (let i = 0; i < 100 && !submitted.some(t => /FAILED/.test(t)); i++) await new Promise(r => setTimeout(r, 5))
  expect(submitted.at(-1)).toMatch(/The loop guard stopped it/)
  expect(submitted.at(-1)).toMatch(/dispatch_grade/)

  await $.tool.call({ tool: 'mcp__multiclaude__dispatch', delegate: 'codex', model: 'gpt-test', prompt: 'do it', label: 'plain' } as never)
  for (let i = 0; i < 100 && !submitted.some(t => /plain\) DONE/.test(t)); i++) await new Promise(r => setTimeout(r, 5))
  expect(submitted.at(-1)).not.toMatch(/dispatch_grade|TRIAL/)
})

test('dispatch_grade records the verdict through the scorecard script; /multiclaude:scorecard prints it', async ($, on) => {
  ENGINE(on, [], {}, true)
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const a = e.argv.join(' ')
    const stdout = a.includes('--jobs-dir') ? '/jobs\n'
      : a.includes('scorecard.mjs grade') ? 'graded jab1 (pi local-med, SUCCESS): rework\n'
      : a.includes('scorecard.mjs') ? '[multiclaude scorecard] last 30d\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await $.tool.call({ tool: 'mcp__multiclaude__dispatch_grade', id: 'jab1', grade: 'rework', gates: 'tests 3/4', note: 'missed the empty case', vs: 'jcd2' } as never)
  expect(String((r as { result?: string }).result)).toMatch(/graded jab1 .* rework/)
  expect(ran.find(a => a[2] === 'grade')?.slice(2)).toEqual(['grade', 'jab1', 'rework', '--gates', 'tests 3/4', '--note', 'missed the empty case', '--vs', 'jcd2'])

  const bad = await $.tool.call({ tool: 'mcp__multiclaude__dispatch_grade', id: 'jab1', grade: 'great' } as never)
  expect(String((bad as { result?: string }).result)).toMatch(/pass \| rework \| fail/)

  const c = await $.command.run({ command: 'multiclaude:scorecard', args: '7d --delegate pi' })
  expect(c.text).toContain('[multiclaude scorecard]')
  expect(ran.find(a => /scorecard\.mjs$/.test(a[1] ?? '') && a[2] !== 'grade')?.slice(2)).toEqual(['7d', '--delegate', 'pi'])
})

test('the Delegates pane has a scorecard view: t opens it from scorecard.mjs --json, p changes the period', async ($, on) => {
  ENGINE(on, [], {}, true)
  const ran: string[][] = []
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const score = /scorecard\.mjs$/.test(e.argv[1] ?? '') && e.argv.includes('--json')
    const rows = [
      { delegate: 'pi', model: 'local-coder-medium', trial: true, runs: 6, ok: 5, infra: 0, stuck: 1, failed: 0, pass: 4, rework: 1, fail: 1, cost: 1.35, costApprox: true, graded: 6, medDur: 95, medTokens: 38054, verdict: 'MARGINAL', why: 'pass 67%, stuck 17%' },
      { delegate: 'agy', model: 'gemini-x-flash-high', trial: false, runs: 3, ok: 3, infra: 0, stuck: 0, failed: 0, pass: 0, rework: 0, fail: 0, cost: 0, graded: 0, medDur: 600, medTokens: 473945 },
    ]
    return { value: { exitCode: 0, stdout: score ? JSON.stringify({ since: e.argv[2], rows, bakeoffs: [{}], ungraded: [] }) : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scorecard' })
  expect(await ui.find({ type: 'Text', text: /Scorecard · last 7d/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^local-coder-medium$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /6 runs · ok 83% · stuck 17% · fail 0%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /judged 4\/1\/1 · pass 67% · 1m35s · 38\.1k tok · ≈\$1\.35/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /MARGINAL — pass 67%, stuck 17%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /judged – · 10m00s · 473\.9k tok$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 bake-off — \/multiclaude:scorecard/ })).toBeDefined()
  await ui.press({ key: 'period' })
  expect(await ui.find({ type: 'Text', text: /Scorecard · last 30d/ })).toBeDefined()
  expect(ran.filter(a => /scorecard\.mjs$/.test(a[1] ?? '')).map(a => a[2])).toEqual(['7d', '30d'])
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /No external dispatches yet/ })).toBeDefined()
  await ui.unmount()
})
