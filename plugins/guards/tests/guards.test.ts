import { expect, test } from 'claude-code/testing'

const REASON_AI = 'Commit/PR text credits an AI. The author wants no AI attribution: remove the attribution line and try again.'
const REASON_SECRET = 'Looks like a secret value. Keep secrets in 1Password and refer to them by item name.'
const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'

// The engine beneath: every tool call that gets through succeeds; `git rev-parse` answers per directory
function engine(on: any, branches: Record<string, string> = {}) {
  const runs: string[][] = []
  on('tool.call', () => ({ result: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = Array.isArray(e) ? e : e.argv
    runs.push(argv)
    const dir = argv[2] ?? ''
    return dir in branches ? { value: { exitCode: 0, stdout: branches[dir] + '\n', stderr: '' } } : { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }
  })
  return runs
}

const denied = (r: any, reason: string) => typeof r.deny === 'string' && r.deny.includes(reason)

test('an attribution commit is denied, a normal commit passes', async ($, on) => {
  engine(on)
  const heredoc = `git commit -F - <<'EOF'\nfix: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF`
  expect(denied(await $.tool.call({ tool: 'Bash', command: `git commit -m "fix: x" -m "Co-Authored-By: Claude Opus <noreply@anthropic.com>"` }), REASON_AI)).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Bash', command: heredoc }), REASON_AI)).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `git commit --message "feat: x\n\nGenerated with Claude Code"` }), REASON_AI)).toBe(true)
  const ok = await $.tool.call({ tool: 'Bash', command: `git commit -m "docs: update claude.md instructions"` })
  expect(ok.deny).toBeUndefined()
  expect((ok as any).deny).toBeUndefined()
})

test('gh pr create with Generated with Claude Code is denied', async ($, on) => {
  engine(on)
  const bad = await $.tool.call({ tool: 'Bash', command: `gh pr create --title "x" --body "Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"` })
  expect(denied(bad, REASON_AI)).toBe(true)
  const ok = await $.tool.call({ tool: 'Bash', command: `gh pr create --title "x" --body "Summary of change"` })
  expect(ok.deny).toBeUndefined()
})

test('a Write with a ghp_ token is denied, an op:// reference passes', async ($, on) => {
  engine(on)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/tmp/a.env', content: `TOKEN=${TOKEN}` }), REASON_SECRET)).toBe(true)
  const ok = await $.tool.call({ tool: 'Write', file_path: '/tmp/a.env', content: 'TOKEN=op://Vault/item/field' })
  expect(ok.deny).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: `export X=${TOKEN}` }), REASON_SECRET)).toBe(true)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: '/tmp/a', old_string: 'a', new_string: 'AKIAABCDEFGHIJKLMNOP' }), REASON_SECRET)).toBe(true)
  const op = await $.tool.call({ tool: 'Bash', command: 'op read op://Vault/item/field' })
  expect(op.deny).toBeUndefined()
})

test('an Edit on main is denied, on a feature branch and outside a repo it passes', async ($, on) => {
  engine(on, { '/repo/main': 'main', '/repo/feat': 'feat/x', '/repo/master': 'master' })
  const edit = (file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
  const r = await edit('/repo/main/a.ts')
  expect(denied(r, "You're on main. Create a feature branch (or worktree) first.")).toBe(true)
  expect(denied(await edit('/repo/master/a.ts'), "You're on master.")).toBe(true)
  expect((await edit('/repo/feat/a.ts')).deny).toBeUndefined()
  expect((await edit('/nowhere/a.ts')).deny).toBeUndefined()
  // Exempt paths never ask git
  expect((await edit('/repo/main/.claude/x.md')).deny).toBeUndefined()
  expect((await edit('/repo/main/memory/x.md')).deny).toBeUndefined()
})

test('the branch lookup is cached', async ($, on) => {
  const runs = engine(on, { '/repo/main': 'main' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/main/a', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/main/b', content: 'x' })
  expect(runs.length).toBe(1)
})

test('a guard turned off does not deny', { options: { attribution: false, secrets: false, branch: false } }, async ($, on) => {
  engine(on, { '/repo/main': 'main' })
  expect((await $.tool.call({ tool: 'Bash', command: `git commit -m "x\n\nGenerated with Claude Code"` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/tmp/a', content: TOKEN })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/main/a', content: 'x' })).deny).toBeUndefined()
})

test('turning off one guard leaves the others on', { options: { attribution: false } }, async ($, on) => {
  engine(on)
  expect((await $.tool.call({ tool: 'Bash', command: `git commit -m "Generated with Claude Code"` })).deny).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/tmp/a', content: TOKEN }), REASON_SECRET)).toBe(true)
})
