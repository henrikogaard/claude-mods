import type { Register } from 'claude-code'

const ATTRIBUTION_REASON = 'Commit/PR text credits an AI. The author wants no AI attribution: remove the attribution line and try again.'
const SECRET_REASON = 'Looks like a secret value. Keep secrets in 1Password and refer to them by item name.'
const PROTECTED_BRANCHES = ['main', 'master']
const CACHE_MS = 10_000

// Commands whose message text is checked
const MESSAGE_COMMAND = /\bgit\b[^\n|;&]*?\bcommit\b|\bgh\s+pr\s+(create|edit)\b/

const ATTRIBUTION: RegExp[] = [
  /co-authored-by:[^\n]*(claude|anthropic|\bai\b|\bllm\b|copilot|chatgpt|openai|\bgpt|gemini|codex)/i,
  /noreply@anthropic\.com/i,
  /generated with\s+\[?\s*claude/i,
  /🤖\s*generated/i,
  /\bclaude code\b/i,
]

const SECRETS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{40,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[bposa]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AIza[0-9A-Za-z_-]{35}/,
]

export function hasAttribution(command: string): boolean {
  return MESSAGE_COMMAND.test(command) && ATTRIBUTION.some(re => re.test(command))
}

export function hasSecret(text: string): boolean {
  // 1Password references are fine
  const clean = text.replace(/op:\/\/[^\s'"`)]+/g, '')
  return SECRETS.some(re => re.test(clean))
}

function isExempt(path: string): boolean {
  return path.startsWith('~/.claude/') || path.includes('/.claude/') || path.includes('/memory/')
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export const register: Register = (on, options) => {
  const opt = options as { attribution?: boolean; secrets?: boolean; branch?: boolean }
  const on_ = (name: 'attribution' | 'secrets' | 'branch') => opt?.[name] !== false
  const branches = new Map<string, { at: number; branch: string | undefined }>()

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command ?? ''
    if (on_('attribution') && hasAttribution(command)) {
      $.ui.toast('🛡 Blocked: commit/PR text credits an AI')
      return { deny: ATTRIBUTION_REASON }
    }
    if (on_('secrets') && hasSecret(command)) {
      $.ui.toast('🛡 Blocked: command contains a likely secret')
      return { deny: SECRET_REASON }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (on_('secrets') && hasSecret(e.content ?? '')) {
      $.ui.toast('🛡 Blocked: file content contains a likely secret')
      return { deny: SECRET_REASON }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (on_('secrets') && hasSecret(e.new_string ?? '')) {
      $.ui.toast('🛡 Blocked: edit contains a likely secret')
      return { deny: SECRET_REASON }
    }
    return next(e)
  })

  // MultiEdit is not a built-in tool in every build; matched by name when it exists
  on('tool.call', { tool: 'MultiEdit' as never }, async ($, e: any, next) => {
    const edits: { new_string?: string }[] = Array.isArray(e.edits) ? e.edits : []
    if (on_('secrets') && edits.some(x => hasSecret(x.new_string ?? ''))) {
      $.ui.toast('🛡 Blocked: edit contains a likely secret')
      return { deny: SECRET_REASON }
    }
    return next(e as never)
  })

  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const) {
    on('tool.call', { tool: tool as never }, async ($, e: any, next) => {
      const path: string | undefined = e.file_path ?? e.notebook_path
      if (on_('branch') && path && !isExempt(path)) {
        const dir = dirOf(path)
        const hit = branches.get(dir)
        const now = Date.now()
        let branch: string | undefined
        if (hit && now - hit.at < CACHE_MS) {
          branch = hit.branch
        } else {
          try {
            const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
            branch = r.exitCode === 0 ? String(r.stdout).trim() : undefined
          } catch {
            branch = undefined
          }
          branches.set(dir, { at: now, branch })
        }
        if (branch && PROTECTED_BRANCHES.includes(branch)) {
          $.ui.toast(`🛡 Blocked: edit on ${branch}`)
          return { deny: `You're on ${branch}. Create a feature branch (or worktree) first.` }
        }
      }
      return next(e as never)
    })
  }
}
