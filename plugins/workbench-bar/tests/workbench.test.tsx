import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 140 } as any } as const

// Fakes for the desktop app's sidebar, Linear, gh and the session
function fakes(on: any, start: string, opts: { linearTeam?: string; agents?: unknown[]; branch?: string; calls?: string[]; cli?: boolean } = {}) {
  const state = { groupBy: start, sortBy: 'created' }
  on('mcp.call', async ($: unknown, e: { server: string; tool: string; args: Record<string, unknown> }) => {
    const ok = (data: unknown) => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify(data) }] } })
    opts.calls?.push(e.server + ':' + e.tool)
    if (e.server === 'ccd_session') return ok({ started: true })
    if (e.server === 'ccd_session_mgmt')
      return ok([
        { sessionId: 'local_a', title: 'Fix calendar', cwd: '/home/me/code/acmeapp/.claude/worktrees/w', isRunning: true, prNumber: 7, prState: 'OPEN', lastActivityAt: '2026-10-29T10:00:00Z' },
        { sessionId: 'local_b', title: 'Old work', cwd: '/home/me/code/tools', isRunning: false },
      ])
    if (e.server === 'claude.ai Linear') {
      if (e.tool === 'get_workspace') return ok({ url: 'https://linear.app/demo' })
      if (e.tool === 'list_teams') return ok({ teams: [{ id: 't1', name: opts.linearTeam ?? 'Demo', key: 'DEM' }] })
      if (e.tool === 'list_issues')
        return ok({
          issues: [
            { id: 'DEM-1', title: 'Fix it', url: 'https://linear.app/demo/issue/DEM-1', status: 'In Progress', statusType: 'started', priority: 2, assignee: 'Alex', updatedAt: '2026-10-28T10:00:00Z' },
            { id: 'DEM-2', title: 'Done', status: 'Done', statusType: 'completed' },
          ],
        })
    }
    if (e.server !== 'ccd_sidebar') return { value: { isError: true, content: [] } }
    if (e.tool === 'list_sections') return ok([{ id: 'sessions', group_by: state.groupBy }])
    state.groupBy = String(e.args.group_by)
    state.sortBy = String(e.args.sort_by)
    return ok({})
  })
  on('process.run', async ($: unknown, e: any) => {
    const argv = (Array.isArray(e) ? e : (e.argv ?? e.args ?? [])) as string[]
    opts.calls?.push(argv.join(' '))
    // Two claude processes: one in a terminal in this repo, one the desktop app's (no terminal)
    if (argv[0] === 'ps') return { value: { exitCode: 0, stdout: !opts.cli ? '' : '  101 ttys003  claude --resume\n  102 ??  /Apps/claude\n  103 ttys004  vim\n', stderr: '' } }
    if (argv[0] === 'lsof') return { value: { exitCode: 0, stdout: 'p101\nfcwd\nn/home/me/code/demo/.claude/worktrees/w\n', stderr: '' } }
    if (argv[0] === 'grep') return { value: { exitCode: 0, stdout: JSON.stringify({ type: 'user', message: { content: 'Refactor the parser\nplease' } }), stderr: '' } }
    const branch = opts.branch ?? 'feat/pixel-bar'
    if (argv[0] === 'git') return { value: { exitCode: 0, stdout: '## ' + branch + '...origin/' + branch + ' [ahead 2]\n M a.ts\n?? b.ts\n', stderr: '' } }
    if (argv.includes('view') && argv.includes('pr'))
      return {
        value: {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ number: 42, title: 'Pixel bar', url: 'https://github.com/acme/demo/pull/42', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
        },
      }
    const out = argv.includes('repo')
      ? { nameWithOwner: 'acme/demo' }
      : argv.includes('pr')
        ? [{ number: 2, title: 'PR', url: 'https://github.com/acme/demo/pull/2', author: { login: 'alex' }, isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], additions: 120, deletions: 40, changedFiles: 6, headRefName: 'feat/x', updatedAt: '2026-10-28T10:00:00Z' }]
        : [
            { number: 1, title: 'Bug', author: { login: 'ola' }, labels: [{ name: 'bug', color: 'd73a4a' }], comments: [{}, {}], updatedAt: '2026-10-27T10:00:00Z' },
            { number: 3, title: 'Idea', author: { login: 'kari' }, labels: [], comments: [], updatedAt: '2026-10-20T10:00:00Z' },
          ]
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } }
  })
  on('session.root', async () => ({ value: '/home/me/code/demo/.claude/worktrees/x' }))
  on('tool.list', async () => ({ value: [] }))
  on('env.get', async () => ({ value: '/home/me' }))
  on('fs.list', async () => ({ value: [{ name: 'abc.jsonl', kind: 'file', size: 10, isLink: false }] }))
  on('fs.stat', async () => ({ value: { mtimeMs: 1, size: 10, kind: 'file' } }))
  on('agent.list', async () => ({ value: opts.agents ?? [] }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 0, window: 1, percent: 12 }, rateLimits: [], cost: { usd: 0.32 } } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.measure', async ($: unknown, e: any) => ({ changed: e.changed }))
  on('session.start', async ($: unknown, e: any) => ({ cwd: e.cwd }))
  on('ui.render', async ($: any, e: any) => $.ui.resolve(e).Box({ children: [] }))
  return state
}

// Let the background refresh finish
async function settle($: any) {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}

test('the toggle flips the sidebar, sorted by recency, with an icon only', async ($, on) => {
  const sidebar = fakes(on, 'state')
  for (const surface of ['desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'workbench-bar', surface, ...BAND })
    const before = sidebar.groupBy
    await ui.press({ key: 'flip' })
    expect(sidebar.groupBy).toBe(before === 'project' ? 'state' : 'project')
    expect(sidebar.sortBy).toBe('recency')
    expect(((await ui.find({ key: 'flip' })) as any)?.props?.label).toBe(sidebar.groupBy === 'state' ? '⚡' : '☰')
    await ui.unmount()
  }
})

test('one click switches even when the sidebar was changed in the app', async ($, on) => {
  const sidebar = fakes(on, 'state')
  const ui = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  await ui.press({ key: 'flip' })
  sidebar.groupBy = sidebar.groupBy === 'project' ? 'state' : 'project'
  const before = sidebar.groupBy
  await ui.press({ key: 'flip' })
  expect(sidebar.groupBy).toBe(before === 'project' ? 'state' : 'project')
  await ui.unmount()
})

test('the row shows usage, agents, GitHub and the matching Linear team as icons and numbers', async ($, on) => {
  const clock = mock.clock(on)
  fakes(on, 'state')
  // A session starts: the mod registers its timers and refreshes in the background, past the intro rain
  await ($ as any).session.start({ cwd: '/home/me/code/demo', surface: 'desktop' })
  await clock.advance(5_100)
  // Then a reply reports the usage windows
  await ($ as any).session.measure({
    context: { tokens: 0, window: 1, percent: 0 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 92 }],
    changed: ['rateLimits'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'workbench-bar', surface, ...BAND })
    const label = async (key: string) => ((await ui.find({ key })) as any)?.props?.label
    if (surface === 'terminal') {
      // The terminal shows usage only: two colour-cell meters, no Clawd, toggle or icons
      expect(await ui.find({ type: 'Text', text: /60%/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
      expect(((await ui.findAll({ type: 'Raster' })) as any[]).length).toBe(2)
      expect(await ui.find({ key: 'flip' })).toBeUndefined()
      expect(await ui.find({ key: 'agents' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /[[\]↻■]/ })).toBeUndefined()
    } else {
      expect(await label('agents')).toBe('0')
      expect(await label('linear')).toBe('1')
      expect(await label('github')).toBe('1 · 2')
      expect(await ui.find({ key: 'git' })).toBeUndefined()
      expect(await label('pr')).toBe('#42')
      expect(await ui.find({ type: 'Text', text: /● ✓/ })).toBeDefined()
      const svgs = ((await ui.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props.alt))
      expect(svgs).toContain('5H 60% left, WK 8% left')
      expect(svgs).toContain('agents')
    }
    await ui.unmount()
  }
})

test('a repo with no matching Linear team hides the Linear icon', async ($, on) => {
  const clock = mock.clock(on)
  fakes(on, 'state', { linearTeam: 'Elsewhere' })
  await ($ as any).session.start({ cwd: '/home/me/code/demo', surface: 'desktop' })
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'linear' })).toBeUndefined()
  await ui.unmount()
})

test('Clawd gets busy while Claude works and rests after', async ($, on) => {
  fakes(on, 'state')
  const working = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 5, bodyColumns: 140 } as any } as const
  const ui = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...working })
  const alts = async (u: any) => ((await u.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props.alt))
  expect((await alts(ui)).find(a => a.startsWith('Clawd'))).toMatch(/^Clawd (laptop|weights|bounce)$/)
  await ui.unmount()
  const idle = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  expect(await alts(idle)).toContain('Clawd idle')
  await idle.unmount()
})

test('the Git panel shows the branch, the PR and its delivery state', async ($, on) => {
  const clock = mock.clock(on)
  fakes(on, 'state')
  await ($ as any).session.start({ cwd: '/home/me/code/demo', surface: 'desktop' })
  // Past the intro rain
  await clock.advance(5_100)
  const ui = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  await ui.press({ key: 'pr' })
  await ui.unmount()
  const deck = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', component: 'Pane', requestId: 'utility-deck', props: { title: 'Details', isFocused: false, bodyColumns: 56, placement: 'dock' } as any } as any)
  expect(await deck.find({ type: 'Text', text: /Stage · Merge-ready/ })).toBeDefined()
  expect(await deck.find({ type: 'Text', text: /Checks · pass/ })).toBeDefined()
  await deck.unmount()
})

test('a new thread opens with a few seconds of falling letters, then the bar', async ($, on) => {
  const clock = mock.clock(on)
  fakes(on, 'state')
  await ($ as any).session.start({ cwd: '/home/me/code/demo', surface: 'desktop' })
  await clock.advance(0)
  const alts = async () => {
    const ui = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
    const found = ((await ui.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props.alt))
    await ui.unmount()
    return found
  }
  expect(await alts()).toEqual(['intro rain'])
  await clock.advance(5_100)
  expect(await alts()).toContain('Clawd idle')
})

const PANE = { component: 'Pane', requestId: 'utility-deck', props: { title: 'Details', isFocused: false, bodyColumns: 60, placement: 'dock' } as any } as any

test('the Agents panel shows tiles and a card per subagent', async ($, on) => {
  const clock = mock.clock(on)
  fakes(on, 'state', { agents: [{ id: 'a1', description: 'Launch emails', type: 'general-purpose', status: 'running' }] })
  await ($ as any).session.start({ cwd: '/home/me/code/demo', surface: 'desktop' })
  await clock.advance(5_100)
  const bar = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  await bar.press({ key: 'agents' })
  await bar.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const deck = await $.ui.mount({ plugin: 'workbench-bar', surface, ...PANE })
    expect(await deck.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
    expect(await deck.find({ type: 'Text', text: /Launch emails/ })).toBeDefined()
    expect(await deck.find({ type: 'Text', text: /\$0\.32/ })).toBeDefined()
    if (surface === 'desktop') expect(((await deck.findAll({ type: 'Svg' })) as any[]).length).toBe(2)
    await deck.unmount()
  }
})

test('the GitHub and Linear panels show metadata', async ($, on) => {
  const clock = mock.clock(on)
  fakes(on, 'state')
  await ($ as any).session.start({ cwd: '/home/me/code/demo', surface: 'desktop' })
  await clock.advance(5_100)
  const bar = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  await bar.press({ key: 'github' })
  const deck = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...PANE })
  expect(await deck.find({ type: 'Text', text: /\+120/ })).toBeDefined()
  expect(await deck.find({ type: 'Text', text: /approved/ })).toBeDefined()
  expect(await deck.find({ type: 'Text', text: /◆ bug/ })).toBeDefined()
  await deck.unmount()
  await bar.press({ key: 'linear' })
  await bar.unmount()
  const deck2 = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...PANE })
  expect(await deck2.find({ type: 'Text', text: /In Progress/ })).toBeDefined()
  expect(await deck2.find({ type: 'Text', text: /▲ high/ })).toBeDefined()
  await deck2.unmount()
})

test('panel groups fold and titles link to the page', async ($, on) => {
  const clock = mock.clock(on)
  fakes(on, 'state')
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => ({ value: undefined }))
  await ($ as any).session.start({ cwd: '/home/me/code/demo', surface: 'desktop' })
  await clock.advance(5_100)
  const bar = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  await bar.press({ key: 'linear' })
  const deck = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...PANE })
  const link = (await deck.find({ type: 'Link' })) as any
  expect(link?.props?.href).toBe('https://linear.app/demo/issue/DEM-1')
  await deck.press({ key: 'grp-linear:In Progress' })
  expect(await deck.find({ type: 'Link' })).toBeUndefined()
  expect(((await deck.find({ key: 'grp-linear:In Progress' })) as any)?.props?.label).toBe('▸ In Progress · 1')
  await deck.unmount()
  await bar.press({ key: 'github' })
  await bar.unmount()
  const gh = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...PANE })
  expect(((await gh.findAll({ type: 'Link' })) as any[]).map(x => x.props.href)).toContain('https://github.com/acme/demo/pull/2')
  await gh.unmount()
})

async function started($: any, on: any, opts: Parameters<typeof fakes>[2] = {}) {
  const clock = mock.clock(on)
  fakes(on, 'state', opts)
  on('ui.toast', async ($: unknown, e: any) => {
    opts.calls?.push('toast:' + (e.text ?? e))
    return { value: undefined }
  })
  on('audio.play', async () => {
    opts.calls?.push('sound')
    return { value: undefined }
  })
  on('turn.start', async ($: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  await $.session.start({ cwd: '/home/me/code/demo', surface: 'desktop' })
  await clock.advance(5_100)
  return clock
}

test('the bar links the branch to its Linear issue and rings for review requests', async ($, on) => {
  await started($, on, { branch: 'claude/dem-1-fix-it' })
  const ui = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  const links = ((await ui.findAll({ type: 'Link' })) as any[]).map(x => x.props.label)
  expect(links).toContain('DEM-1')
  expect(((await ui.find({ key: 'reviews' })) as any)?.props?.label).toBe('🔔 1')
  await ui.unmount()
})

test('▶ on an issue starts a thread for it', async ($, on) => {
  const calls: string[] = []
  await started($, on, { calls })
  const bar = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  await bar.press({ key: 'linear' })
  await bar.unmount()
  const deck = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...PANE })
  await deck.press({ key: 'linh-0-start' })
  expect(calls).toContain('ccd_session:start_session')
  // Filters: Mine keeps my issue, Urgent keeps priority 1-2
  await deck.press({ key: 'filter-urgent' })
  expect(await deck.find({ type: 'Text', text: /▲ high/ })).toBeDefined()
  await deck.unmount()
})

test('the Git panel lists delivery steps and the next one', async ($, on) => {
  await started($, on)
  const bar = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  await bar.press({ key: 'pr' })
  await bar.unmount()
  const deck = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...PANE })
  expect(await deck.find({ type: 'Text', text: /✓ Ready for review/ })).toBeDefined()
  expect(await deck.find({ type: 'Text', text: /→ Next: merge/ })).toBeDefined()
  await deck.unmount()
})

test('a long turn ends with a toast and no sound by default', async ($, on) => {
  const calls: string[] = []
  const clock = await started($, on, { calls })
  await ($ as any).turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(61_000)
  await ($ as any).turn.complete({ turnId: 't1', reason: 'answer', text: '' }).catch(() => {})
  expect(calls.some(c => c.startsWith('toast:✓ Done in'))).toBe(true)
  expect(calls).not.toContain('sound')
})

test('with sound switched on, a long turn also plays the chime', { options: { sound: true } } as any, async ($: any, on: any) => {
  const calls: string[] = []
  const clock = await started($, on, { calls })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(61_000)
  await $.turn.complete({ turnId: 't1', reason: 'answer', text: '' }).catch(() => {})
  expect(calls).toContain('sound')
})

test('the 🔇 button switches sound on, remembers it, and plays a sample', async ($, on) => {
  const calls: string[] = []
  const saved: Record<string, unknown> = {}
  on('store.get', async ($: unknown, e: any) => ({ value: saved[e.key ?? e] }))
  on('store.set', async ($: unknown, e: any) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  await started($, on, { calls })
  const ui = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  expect(((await ui.find({ key: 'sound' })) as any)?.props?.label).toBe('🔇')
  await ui.press({ key: 'sound' })
  expect(((await ui.find({ key: 'sound' })) as any)?.props?.label).toBe('🔈')
  expect(saved.sound).toBe(true)
  expect(calls).toContain('sound')
  await ui.unmount()
})

test('⟳ in the panel fetches PRs, issues and Linear again', async ($, on) => {
  const calls: string[] = []
  await started($, on, { calls })
  const bar = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  await bar.press({ key: 'github' })
  await bar.unmount()
  const deck = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...PANE })
  const before = calls.filter(c => c.includes('pr list') || c.includes('list_issues')).length
  await deck.press({ key: 'refresh' })
  const after = calls.filter(c => c.includes('pr list') || c.includes('list_issues')).length
  expect(after).toBeGreaterThan(before)
  expect(((await deck.find({ key: 'refresh' })) as any)?.props?.label).toBe('⟳')
  await deck.unmount()
})

test('the bar shows this thread\'s context, other threads working, and overall subagent steps', async ($, on) => {
  const clock = await started($, on, { agents: [{ id: 'a1', description: 'Emails', type: 'general-purpose', status: 'running' }] })
  await ($ as any).session.measure({ context: { tokens: 300, window: 1000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], changed: ['context', 'rateLimits'] })
  // The subagent reports its steps through the mod's tool
  await ($ as any).tool.call({ tool: 'mcp__workbench-bar__step', agentId: 'a1', done: 2, total: 5 }).catch(() => {})
  await clock.advance(46_000)
  const ui = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  const alts = ((await ui.findAll({ type: 'Svg' })) as any[]).map(x => String(x.props.alt))
  expect(alts.some(a => a.startsWith('CTX 70% left'))).toBe(true)
  expect(((await ui.find({ key: 'threads' })) as any)?.props?.label).toBe('⧗ 1')
  expect(((await ui.find({ key: 'agents' })) as any)?.props?.label).toBe('1 · 2/5')
  await ui.press({ key: 'threads' })
  await ui.unmount()
  const deck = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...PANE })
  expect(await deck.find({ type: 'Text', text: /Fix calendar/ })).toBeDefined()
  await deck.unmount()
})

test('Claude CLI threads in the same repo show in the Agents panel and the chip', async ($, on) => {
  await started($, on, { cli: true })
  const bar = await $.ui.mount({ plugin: 'workbench-bar', surface: 'desktop', ...BAND })
  expect(((await bar.find({ key: 'agents' })) as any)?.props?.label).toBe('0 +1 ⌨')
  await bar.press({ key: 'agents' })
  await bar.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const deck = await $.ui.mount({ plugin: 'workbench-bar', surface, ...PANE })
    expect(await deck.find({ type: 'Text', text: /Refactor the parser/ })).toBeDefined()
    expect(await deck.find({ type: 'Text', text: /ttys003/ })).toBeDefined()
    await deck.unmount()
  }
})
