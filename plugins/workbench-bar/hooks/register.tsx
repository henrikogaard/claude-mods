import type { EngineInterface, McpToolResult, Register, SessionRateLimit } from 'claude-code'

// The desktop app's own sidebar server, the one behind mcp__ccd_sidebar__*
const SERVER = 'ccd_sidebar'
// Names the Linear connector may go by, tried after the ones the tool list shows
const LINEAR_FALLBACKS = ['claude.ai Linear', 'linear']
const REFRESH_MS = 45_000

type Mode = 'project' | 'state'
type Item = { id: string; title: string }

// Neon palette
const CYAN = '#00e5ff'
const GREEN = '#39ff14'
const AMBER = '#ffb000'
const RED = '#ff3b30'
const WHITE = '#ffffff'
const DARK = '#3a4a3a'
// Labels and reset times: dim like the desktop's, but readable on a black terminal
const LABEL = '#7d8f7d'

// Terminal colour cells: 24-bit RGB per cell; one above that range is the terminal's default
const DEFAULT_CELL = 0x01000000

function hexToInt(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

// A colour made darker by k (1 = as is)
function scale(rgb: number, k: number): number {
  const ch = (shift: number) => Math.round(((rgb >> shift) & 0xff) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

// Rows of [character, colour] packed into the base64 string a Raster takes
function cellsOf(rows: [string, number][][]): string {
  const numbers = rows.flat().flatMap(([char, colour]) => [char.codePointAt(0) ?? 32, colour, DEFAULT_CELL])
  const bytes = new Uint8Array(Uint32Array.from(numbers).buffer)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// What the bar shows, refreshed in the background
let mode: Mode | null = null
let limits: readonly SessionRateLimit[] = []
let agents: { name: string; status: string; model: string }[] = []
const models: Record<string, string> = {}
type GhIssue = Item & { url: string; author: string; labels: { name: string; color: string }[]; comments: number; updated: string }
type GhPr = Item & { url: string; author: string; branch: string; isDraft: boolean; review: string; ci: Ci; additions: number; deletions: number; files: number; updated: string }
type LinIssue = Item & { url: string; status: string; statusType: string; priority: number; assignee: string; updated: string }
let github: { repo: string | null; issues: GhIssue[]; prs: GhPr[] } = { repo: null, issues: [], prs: [] }
let linear: LinIssue[] | null = null

// Every subagent this session has seen, with when it started and ended, for the Agents panel
type AgentRow = { id: string; name: string; type: string; status: string; model: string; startedAt: number; endedAt?: number }
let allAgents: AgentRow[] = []
const agentStarts: Record<string, number> = {}
const agentEnds: Record<string, number> = {}
// Per-agent numbers from each of its model requests, and the steps it reported itself
type AgentUse = { context: number; window: number; tokens: number; cost: number; effort?: string; stepDone?: number; stepTotal?: number; note?: string }
const agentUse: Record<string, AgentUse> = {}
const STEP_TOOL = 'mcp__workbench-bar__step'
const STEP_BRIEF =
  '\n\nProgress: when you know your steps, call the `' + STEP_TOOL + '` tool with `done` and `total` (and a few-word `note`), and again as each step finishes. It only draws a progress bar.'

// List prices in USD per million tokens: input, output, cache read, cache write. An estimate, not a bill
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
function costOf(model: string, u: Usage): number {
  const [i, o, r, w] = PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 8]
  return ((u.input_tokens ?? 0) * i + (u.output_tokens ?? 0) * o + (u.cache_read_input_tokens ?? 0) * r + (u.cache_creation_input_tokens ?? 0) * w) / 1e6
}
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// Other threads on this machine, from the desktop app, and how full this thread's context is
type Thread = { id: string; title: string; project: string; isRunning: boolean; pr?: string; at: string }
let threads: Thread[] = []
let contextPct: number | undefined

async function refreshThreads($: EngineInterface) {
  const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 40 })
  if (r.isError) return
  const list = (parseMcp(r) ?? []) as { sessionId: string; title?: string; cwd?: string; isRunning?: boolean; prNumber?: number; prState?: string; lastActivityAt?: string }[]
  threads = list.map(x => ({
    id: x.sessionId,
    title: x.title ?? x.sessionId,
    project: x.cwd ? projectOf(x.cwd) : '',
    isRunning: Boolean(x.isRunning),
    pr: x.prNumber ? '#' + x.prNumber + (x.prState ? ' ' + x.prState.toLowerCase() : '') : undefined,
    at: x.lastActivityAt ?? '',
  }))
}

// Claude CLI threads in this same repository: open in a terminal, or closed in the last 7 days
type CliThread = { id: string; pid: string; tty: string; cwd: string; title: string; isWorking: boolean; isClosed: boolean; at: number; stats?: CliStats }
// What a CLI thread's transcript says: its model, effort, branch, tokens (each request counted once),
// the last request's context, and its last step (a tool, or the start of what it wrote)
type CliStats = { model: string; effort: string; branch: string; usage: Usage; context: number; requests: number; tool: string; text: string }
let cliThreads: CliThread[] = []
let cliClosed: CliThread[] = []
let cliScannedAt = -Infinity
const CLI_DAYS = 7

const CLI_STATS_PL = "use JSON::PP; my $j = JSON::PP->new; my (%u, @ids, $model, $effort, $branch, $tool, $text, $ts);\nwhile (<>) {\n  next unless /\"type\":\"assistant\"/;\n  my $d = eval { $j->decode($_) } or next; my $m = $d->{message} or next;\n  $model = $m->{model} if $m->{model} && $m->{model} !~ /^</; $effort = $d->{effort} if $d->{effort}; $branch = $d->{gitBranch} if $d->{gitBranch}; $ts = $d->{timestamp};\n  for my $c (@{ $m->{content} || [] }) { if ($c->{type} eq 'tool_use') { $tool = $c->{name}; $text = '' } elsif ($c->{type} eq 'text' && $c->{text} =~ /\\S/) { ($text) = $c->{text} =~ /(\\S[^\\n]*)/; $tool = '' } }\n  push @ids, $m->{id} unless exists $u{ $m->{id} }; $u{ $m->{id} } = $m->{usage} || {};\n}\nmy %t = (input_tokens => 0, output_tokens => 0, cache_read_input_tokens => 0, cache_creation_input_tokens => 0);\nfor my $id (@ids) { $t{$_} += $u{$id}{$_} || 0 for keys %t }\nmy $l = @ids ? $u{ $ids[-1] } : {}; my $ctx = 0; $ctx += $l->{$_} || 0 for keys %t;\nprint $j->encode({ model => $model // '', effort => $effort // '', branch => $branch // '', usage => \\%t, context => $ctx, requests => scalar @ids, tool => $tool // '', text => substr($text // '', 0, 100), at => $ts // '' });"
const cliStatsCache: Record<string, { at: number; stats: CliStats }> = {}

// Read again only when the transcript has changed
async function cliStats($: EngineInterface, path: string, at: number): Promise<CliStats | undefined> {
  const hit = cliStatsCache[path]
  if (hit && hit.at === at) return hit.stats
  const r = await $.process.run(['perl', '-e', CLI_STATS_PL, path], { timeoutMs: 10_000 })
  if (r.exitCode !== 0) return hit?.stats
  const stats = JSON.parse(r.stdout) as CliStats
  cliStatsCache[path] = { at, stats }
  return stats
}

// The first user message in a transcript, as a one-line title, and the folder it ran in
async function transcriptHead($: EngineInterface, path: string) {
  const first = await $.process.run(['grep', '-m1', '"type":"user"', path], { timeoutMs: 5_000 })
  const msg = JSON.parse(first.stdout || '{}') as { cwd?: string; message?: { content?: string | { type: string; text?: string }[] } }
  const c = msg.message?.content
  const text = typeof c === 'string' ? c : (c?.find(b => b.type === 'text')?.text ?? '')
  return { title: text.trim() ? text.trim().split('\n')[0]!.slice(0, 80) : '', cwd: msg.cwd ?? '' }
}

// Closed CLI threads: transcripts from the CLI (entrypoint "cli") in this repo's project folders
async function scanClosedCli($: EngineInterface, repo: string, home: string, t: number, open: Set<string>) {
  const root = home + '/.claude/projects'
  const dirs = (await $.fs.list(root)).filter(d => d.kind === 'dir' && d.name.includes('-' + repo.replace(/[/.]/g, '-')))
  const recent: { path: string; at: number }[] = []
  for (const d of dirs) {
    for (const f of await $.fs.list(root + '/' + d.name)) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
      const path = root + '/' + d.name + '/' + f.name
      const at = Number(((await $.fs.stat(path)) as { mtimeMs?: number }).mtimeMs ?? 0)
      if (t - at < CLI_DAYS * 86_400_000 && !open.has(path)) recent.push({ path, at })
    }
  }
  if (recent.length === 0) return []
  const cli = await $.process.run(['grep', '-l', '"entrypoint":"cli"', ...recent.map(r => r.path)], { timeoutMs: 10_000 })
  const isCli = new Set(cli.stdout.split('\n').filter(Boolean))
  const found: CliThread[] = []
  for (const r of recent.filter(x => isCli.has(x.path)).sort((a, b) => b.at - a.at).slice(0, 10)) {
    const head = await transcriptHead($, r.path)
    if (head.cwd && projectOf(head.cwd) !== repo) continue
    const id = r.path.split('/').pop()!.replace(/\.jsonl$/, '')
    const stats = await cliStats($, r.path, r.at).catch(() => undefined)
    found.push({ id, pid: '', tty: '', cwd: head.cwd, title: head.title || 'Terminal thread', isWorking: false, isClosed: true, at: r.at, stats })
  }
  return found
}

// CLI threads this thread started (say, `claude -p` for API billing), kept after they close
let cliSpawned: CliThread[] = []
let selfPid = ''

// A transcript's path and age: the newest .jsonl in ~/.claude/projects/<cwd with / and . as ->
async function newestTranscript($: EngineInterface, home: string, cwd: string, skip: string) {
  const dir = home + '/.claude/projects/' + cwd.replace(/[/.]/g, '-')
  let path = ''
  let at = 0
  try {
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.name === skip) continue
      const m = Number(((await $.fs.stat(dir + '/' + f.name)) as { mtimeMs?: number }).mtimeMs ?? 0)
      if (m > at) {
        at = m
        path = dir + '/' + f.name
      }
    }
  } catch {}
  return { path, at }
}

async function refreshCli($: EngineInterface) {
  const ps = await $.process.run(['ps', '-axo', 'pid=,ppid=,tty=,command='], { timeoutMs: 5_000 })
  if (ps.exitCode !== 0) return
  const repo = projectOf(await $.session.root())
  const t = await $.clock.now()
  const home = (await $.env.get('HOME')) ?? ''
  const rows = ps.stdout
    .split('\n')
    .map(l => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map(m => ({ pid: m[1] as string, ppid: m[2] as string, tty: m[3] as string, isClaude: /(^|\/)claude$|\/claude\/versions\/[^/]+$/.test(m[4] ?? ''), isThisPs: /(^|\/)ps$/.test(m[4] ?? '') && (m[5] ?? '').includes('pid=,ppid=,tty=,command=') }))
  // This thread's own process started the ps above, so it's that ps's parent
  selfPid = rows.find(r => r.isThisPs)?.ppid ?? selfPid
  const parent: Record<string, string> = {}
  for (const r of rows) parent[r.pid] = r.ppid
  const isMine = (pid: string) => {
    for (let p = parent[pid], n = 0; p && p !== '1' && n < 30; p = parent[p], n++) if (p === selfPid) return true
    return false
  }
  // A background command is cut loose from its parent, but a claude it starts still carries the
  // thread's CLAUDE_PID and CLAUDE_CODE_SESSION_ID. Only those two are read; the rest is dropped
  const sessionId = await $.session.id().catch(() => '')
  const others = rows.filter(r => r.isClaude && r.pid !== selfPid)
  const startedBy: Record<string, boolean> = {}
  if (others.length > 0) {
    const env = await $.process.run(['ps', 'eww', '-o', 'pid=,command=', '-p', others.map(r => r.pid).join(',')], { timeoutMs: 5_000 })
    for (const line of env.stdout.split('\n')) {
      const pid = /^\s*(\d+)/.exec(line)?.[1]
      const byPid = [...line.matchAll(/ CLAUDE_PID=(\d+)/g)].pop()?.[1]
      const bySession = [...line.matchAll(/ CLAUDE_CODE_SESSION_ID=([\w-]+)/g)].pop()?.[1]
      if (pid) startedBy[pid] = Boolean((selfPid && byPid === selfPid) || (sessionId && bySession === sessionId))
    }
  }
  const mine = others.filter(r => startedBy[r.pid] || (selfPid && isMine(r.pid)))
  // A terminal thread has a terminal; the desktop app's own threads have none (??)
  const terminal = rows.filter(r => r.isClaude && r.tty !== '??' && !mine.includes(r))
  const procs = [...mine, ...terminal]
  const cwds: Record<string, string> = {}
  if (procs.length > 0) {
    // Each process's working folder, from lsof: p<pid> then n<path>
    const ls = await $.process.run(['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', procs.map(x => x.pid).join(',')], { timeoutMs: 5_000 })
    let pid = ''
    for (const line of ls.stdout.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1)
      else if (line.startsWith('n') && pid) cwds[pid] = line.slice(1)
    }
  }
  const open = new Set<string>()
  // This thread writes its own transcript all the time, so never take that one
  const thread = async (x: { pid: string; tty: string }, cwd: string): Promise<CliThread> => {
    const tr = await newestTranscript($, home, cwd, sessionId + '.jsonl')
    let title = 'Terminal thread'
    if (tr.path) {
      open.add(tr.path)
      try {
        title = (await transcriptHead($, tr.path)).title || title
      } catch {}
    }
    const id = tr.path ? tr.path.split('/').pop()!.replace(/\.jsonl$/, '') : x.pid
    const stats = tr.path ? await cliStats($, tr.path, tr.at).catch(() => undefined) : undefined
    return { id, pid: x.pid, tty: x.tty, cwd, title, isWorking: tr.at > 0 && t - tr.at < 20_000, isClosed: false, at: tr.at, stats }
  }
  const found: CliThread[] = []
  for (const x of terminal) {
    const cwd = cwds[x.pid]
    if (cwd && projectOf(cwd) === repo) found.push(await thread(x, cwd))
  }
  // Started here: wherever they run. Ones that ended stay listed as closed
  const key = 'spawned:' + sessionId
  const live: CliThread[] = []
  for (const x of mine) live.push({ ...(await thread(x, cwds[x.pid] ?? '')), isWorking: true })
  const saved = ((await $.store.get(key).catch(() => undefined)) as CliThread[] | undefined) ?? []
  const gone = saved.filter(c => !live.some(l => l.pid === c.pid)).map(c => ({ ...c, isWorking: false, isClosed: true }))
  cliSpawned = [...live, ...gone].slice(0, 20)
  if (cliSpawned.length) await $.store.set(key, cliSpawned).catch(() => {})
  // Closed threads change slowly, so look again at most once a minute
  if (t - cliScannedAt > 60_000) {
    cliScannedAt = t
    try {
      cliClosed = await scanClosedCli($, repo, home, t, open)
    } catch {}
  }
  cliThreads = found
}

// PRs where someone asked you for a review
let reviewRequests: { id: string; title: string; url: string; author: string }[] = []
// The Linear issue this thread works on, from the branch name (claude/abc-26-calendar → ABC-26)
let linkedIssue: { id: string; title: string; url: string } | null = null
// Linear issues assigned to me, and which filter the panel shows
let mineIds = new Set<string>()
type LinFilter = 'all' | 'mine' | 'urgent' | 'started'
let linFilter: LinFilter = 'all'
// Usage readings over time, to forecast when a window runs out
const usageHistory: { t: number; kind: string; pct: number }[] = []
// What every thread on this machine has cost today, from the shared store
let costToday: number | undefined
// When the main turn started, for the done ping; and a short celebration for Clawd
let turnStartedAt = 0
let partyUntil = 0
let soundOn = false
// A Linear connector name to try first, from the mod's settings (for connectors /mcp lists under an id)
let linearServerOption = ''

// Minutes until a window hits 100% at the pace of the last 45 minutes; undefined when not rising
function forecastMinutes(kind: string): number | undefined {
  const recent = usageHistory.filter(h => h.kind === kind && now - h.t < 45 * 60_000)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || last.t - first.t < 5 * 60_000 || last.pct <= first.pct) return undefined
  const perMinute = (last.pct - first.pct) / ((last.t - first.t) / 60_000)
  return (100 - last.pct) / perMinute
}

// "1h20" from minutes
function minutesWord(m: number): string {
  const r = Math.round(m)
  return r < 60 ? r + 'm' : Math.floor(r / 60) + 'h' + String(r % 60).padStart(2, '0')
}

// A short sound when sound is switched on in the mod's settings
function ping($: EngineInterface) {
  if (soundOn) void $.audio.play({ asset: 'sounds/done.wav' }).catch(() => {})
}

// The session's cost, context fill and start, for the panel's tiles
let stats: { cost?: number; context?: number; startedAt?: number } = {}

// "3m", "5h", "2d": how long ago an ISO time was
function ago(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!(t > 0) || !now) return ''
  const m = Math.max(0, Math.floor((now - t) / 60000))
  return m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : Math.floor(m / 1440) + 'd'
}

// 1:16 or 12:03 or 1:02:09
function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const mm = Math.floor((sec % 3600) / 60)
  const ss = String(sec % 60).padStart(2, '0')
  return h ? h + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss
}

// Animation frame and the time it was drawn at
let tick = 0
// The surface that last drew the row; the desktop animates on its own
let surface = ''
let now = 0

// The first text block of an MCP result, parsed as JSON
function parseMcp(r: McpToolResult): unknown {
  const block = r.content.find((b: { type: string }) => b.type === 'text') as { text?: string } | undefined
  return JSON.parse(block?.text ?? 'null')
}

// claude-haiku-5-5 → haiku
function shortModel(model: string): string {
  return /opus|sonnet|haiku|fable/i.exec(model)?.[0]?.toLowerCase() ?? model
}

// The family and version from a model id: claude-sonnet-5-5 → sonnet 5.5, claude-opus-4-1-20250805 → opus 4.1
export function modelLabel(model: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(model)
  return m ? m[1]!.toLowerCase() + ' ' + m[2] + (m[3] ? '.' + m[3] : '') : shortModel(model)
}

// A short name for a usage window: 5H, WK, FABLE, or the window's own name
function windowName(kind: string): string {
  if (kind === 'context') return 'CTX'
  if (kind === 'five_hour') return '5H'
  if (kind === 'seven_day') return 'WK'
  if (/fable/i.test(kind)) return 'FABLE'
  if (kind === 'spend_limit') return '$$'
  return kind.replace(/_/g, ' ').toUpperCase()
}

// The colour for what's left of a window
function health(left: number): string {
  return left > 50 ? GREEN : left > 25 ? AMBER : RED
}

// Time until a window resets: 2h14, 3d5h, 9m
function untilReset(resetsAt: string | undefined): string {
  if (!resetsAt || !now) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return ''
  const m = Math.floor(ms / 60000)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h' + String(m % 60).padStart(2, '0')
  return Math.floor(h / 24) + 'd' + (h % 24) + 'h'
}

// Reads the sidebar's grouping from the app
async function readMode($: EngineInterface): Promise<Mode | null> {
  const r = await $.mcp.call(SERVER, 'list_sections')
  if (r.isError) return null
  const sections = (parseMcp(r) ?? []) as { id: string; group_by: string }[]
  const groupBy = sections.find(s => s.id === 'sessions')?.group_by
  return groupBy === 'project' ? 'project' : groupBy === 'state' ? 'state' : null
}

// Groups the sidebar by `target`, sorted by last activity
async function setMode($: EngineInterface, target: Mode) {
  try {
    const r = await $.mcp.call(SERVER, 'set_view', { group_by: target, sort_by: 'recency' })
    if (r.isError) {
      $.ui.toast('Sidebar switch failed')
      mode = target === 'project' ? 'state' : 'project'
      $.ui.invalidate('ui.render')
      return
    }
    mode = target
    $.ui.invalidate('ui.render')
  } catch (err) {
    $.ui.toast('Sidebar switch failed: ' + String(err))
  }
}

// True while a switch is on its way to the app, so a second click doesn't undo it
let isSwitching = false

// Switches to the other mode, starting from what the sidebar shows now
async function flip($: EngineInterface) {
  if (isSwitching) return
  isSwitching = true
  try {
    let current = mode
    try {
      // The person may have changed the sidebar in the app since we last looked
      current = (await readMode($)) ?? current
    } catch {}
    const target: Mode = current === 'project' ? 'state' : 'project'
    // Show the new mode at once; setMode puts it back if the app refuses
    mode = target
    $.ui.invalidate('ui.render')
    await setMode($, target)
  } finally {
    isSwitching = false
  }
}

// The project a folder belongs to: the repo name, also for a worktree inside or beside it
function projectOf(cwd: string): string {
  const beside = /\/\.worktrees\/([^/]+)\//.exec(cwd)
  if (beside?.[1]) return beside[1]
  const root = cwd.split('/.claude/worktrees/')[0] ?? cwd
  return root.replace(/\/+$/, '').split('/').pop() ?? root
}

const LIVE = ['running', 'pending', 'waiting']

// What the mod learns about each agent (model, usage, steps, start) is kept per thread, so
// /reload-plugins doesn't wipe it; agents that haven't made a request since would show "?"
let agentsLoaded = false
let agentsSavedAt = 0

async function loadAgentInfo($: EngineInterface) {
  agentsLoaded = true
  const saved = (await $.store.get('agents:' + (await $.session.id())).catch(() => undefined)) as
    | { models?: Record<string, string>; use?: Record<string, AgentUse>; starts?: Record<string, number> }
    | undefined
  for (const [id, m] of Object.entries(saved?.models ?? {})) models[id] ??= m
  for (const [id, u] of Object.entries(saved?.use ?? {})) agentUse[id] ??= u
  for (const [id, at] of Object.entries(saved?.starts ?? {})) agentStarts[id] ??= at
}

async function saveAgentInfo($: EngineInterface, isNow = false) {
  const t = await $.clock.now()
  if (!isNow && t - agentsSavedAt < 10_000) return
  agentsSavedAt = t
  await $.store.set('agents:' + (await $.session.id()), { models, use: agentUse, starts: agentStarts }).catch(() => {})
}

async function refreshAgents($: EngineInterface) {
  if (!agentsLoaded) await loadAgentInfo($).catch(() => {})
  const list = await $.agent.list()
  const t = await $.clock.now()
  allAgents = list.map(a => {
    const startedAt = (agentStarts[a.id] ??= t)
    if (!LIVE.includes(a.status) && a.status !== 'idle' && agentEnds[a.id] === undefined) agentEnds[a.id] = t
    return {
      id: a.id,
      name: a.name ?? a.teammateId ?? a.description,
      type: a.type,
      status: a.status,
      model: models[a.id] ?? (a.teammateId ? models[a.teammateId] : undefined) ?? '?',
      startedAt,
      endedAt: agentEnds[a.id],
    }
  })
  agents = allAgents.filter(a => LIVE.includes(a.status)).map(a => ({ name: a.name, status: a.status, model: a.model }))
}

async function refreshStats($: EngineInterface) {
  const u = await $.session.usage()
  const started = typeof u.startedAt === 'string' ? Date.parse(u.startedAt) : Number(u.startedAt)
  stats = { cost: u.cost?.usd, context: u.context.percent, startedAt: started > 0 ? started : undefined }
  // Every thread writes its own cost under today's date; the sum is today's spend on this machine
  if (stats.cost !== undefined) {
    const day = new Date(now || Date.now()).toISOString().slice(0, 10)
    await $.store.set('cost:' + day + ':' + (await $.session.id()), stats.cost)
    const keys = (await $.store.keys()).filter(k => k.startsWith('cost:' + day + ':'))
    let sum = 0
    for (const k of keys) sum += Number((await $.store.get(k)) ?? 0)
    costToday = sum
    // Forget other days
    for (const k of (await $.store.keys()).filter(k => k.startsWith('cost:') && !k.startsWith('cost:' + day))) await $.store.delete(k)
  }
}

async function gh($: EngineInterface, args: string[]): Promise<unknown | null> {
  const r = await $.process.run(['gh', ...args], { timeoutMs: 20_000 })
  return r.exitCode === 0 ? JSON.parse(r.stdout) : null
}

async function refreshGithub($: EngineInterface) {
  const repo = (await gh($, ['repo', 'view', '--json', 'nameWithOwner'])) as { nameWithOwner?: string } | null
  if (!repo?.nameWithOwner) {
    github = { repo: null, issues: [], prs: [] }
    return
  }
  const open = ['--state', 'open', '--limit', '50', '--json']
  type RawIssue = { number: number; title: string; url?: string; author?: { login?: string }; labels?: { name: string; color?: string }[]; comments?: unknown[]; updatedAt?: string }
  type RawPr = RawIssue & { isDraft?: boolean; reviewDecision?: string; statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[]; additions?: number; deletions?: number; changedFiles?: number; headRefName?: string }
  const issues = ((await gh($, ['issue', 'list', ...open, 'number,title,url,author,labels,comments,updatedAt'])) ?? []) as RawIssue[]
  const prs = ((await gh($, ['pr', 'list', ...open, 'number,title,url,author,isDraft,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,headRefName,updatedAt'])) ?? []) as RawPr[]
  const asked = ((await gh($, ['pr', 'list', '--search', 'review-requested:@me', '--state', 'open', '--json', 'number,title,url,author'])) ?? []) as RawIssue[]
  reviewRequests = asked.map(x => ({ id: '#' + x.number, title: x.title, url: x.url ?? '', author: x.author?.login ?? '' }))
  github = {
    repo: repo.nameWithOwner,
    issues: issues.map(x => ({
      id: '#' + x.number,
      title: x.title,
      url: x.url ?? '',
      author: x.author?.login ?? '',
      labels: (x.labels ?? []).map(l => ({ name: l.name, color: '#' + (l.color ?? '8b949e') })),
      comments: Array.isArray(x.comments) ? x.comments.length : Number(x.comments ?? 0),
      updated: x.updatedAt ?? '',
    })),
    prs: prs.map(x => ({
      id: '#' + x.number,
      title: x.title,
      url: x.url ?? '',
      author: x.author?.login ?? '',
      branch: x.headRefName ?? '',
      isDraft: Boolean(x.isDraft),
      review: x.reviewDecision ?? '',
      ci: ciOf(x.statusCheckRollup ?? []),
      additions: x.additions ?? 0,
      deletions: x.deletions ?? 0,
      files: x.changedFiles ?? 0,
      updated: x.updatedAt ?? '',
    })),
  }
}

// The connected server whose workspace is on linear.app; undefined until looked for
let linearServer: string | null | undefined

async function findLinear($: EngineInterface): Promise<string | null> {
  const names = new Set<string>()
  try {
    for (const t of await $.tool.list()) {
      const m = /^mcp__(.+)__list_teams$/.exec(t.name)
      if (m?.[1]) names.add(m[1])
    }
  } catch {}
  if (linearServerOption) names.add(linearServerOption)
  for (const n of LINEAR_FALLBACKS) names.add(n)
  for (const server of names) {
    try {
      const r = await $.mcp.call(server, 'get_workspace')
      if (!r.isError && /linear\.app/.test(JSON.stringify(r.content))) return server
    } catch {
      // Not connected under this name
    }
  }
  return null
}

// Open issues of the Linear team this repo belongs to (e.g. repo acmeapp → team Acme); null hides the icon
async function refreshLinear($: EngineInterface) {
  if (linearServer === undefined) linearServer = await findLinear($)
  if (!linearServer) {
    linear = null
    return
  }
  const repo = projectOf(await $.session.root()).toLowerCase()
  const teams = ((parseMcp(await $.mcp.call(linearServer, 'list_teams', { limit: 100 })) as { teams?: { id: string; name: string; key: string }[] } | null)?.teams ?? [])
  const team = teams.find(t => {
    const name = t.name.toLowerCase().replace(/\s+/g, '')
    const key = t.key.toLowerCase()
    return repo.startsWith(name) || name.startsWith(repo) || repo === key
  })
  if (!team) {
    linear = null
    return
  }
  const fields = ['id', 'title', 'url', 'status', 'statusType', 'priority', 'assignee', 'updatedAt']
  type Raw = { id: string; title: string; url?: string; status?: string | { name?: string }; statusType?: string; priority?: number | { value?: number }; assignee?: string | { name?: string; displayName?: string } | null; updatedAt?: string }
  const data = parseMcp(await $.mcp.call(linearServer, 'list_issues', { team: team.id, limit: 100, fields })) as { issues?: Raw[] } | null
  try {
    const mine = parseMcp(await $.mcp.call(linearServer, 'list_issues', { team: team.id, assignee: 'me', limit: 100, fields: ['id'] })) as { issues?: { id: string }[] } | null
    mineIds = new Set((mine?.issues ?? []).map(i => i.id))
  } catch {}
  linear = (data?.issues ?? [])
    .filter(i => i.statusType !== 'completed' && i.statusType !== 'canceled')
    .map(i => ({
      id: i.id,
      title: i.title,
      url: i.url ?? '',
      status: typeof i.status === 'string' ? i.status : (i.status?.name ?? ''),
      statusType: i.statusType ?? '',
      priority: typeof i.priority === 'number' ? i.priority : (i.priority?.value ?? 0),
      assignee: typeof i.assignee === 'string' ? i.assignee : (i.assignee?.displayName ?? i.assignee?.name ?? ''),
      updated: i.updatedAt ?? '',
    }))
}

// This checkout's branch and changes, and the branch's pull request with its checks
type Ci = 'pass' | 'pending' | 'fail' | 'none'
type Stage = 'Local changes' | 'Draft' | 'Ready for review' | 'Merge-ready' | 'Merged' | 'Closed'
type Pr = { number: number; title: string; url: string; state: string; isDraft: boolean; review: string; ci: Ci; checks: { name: string; result: string; runId?: string }[] }
let git: { branch: string; changed: number; ahead: number; behind: number } | null = null
let pr: Pr | null = null

async function refreshGit($: EngineInterface) {
  const r = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 10_000 })
  if (r.exitCode !== 0) {
    git = null
    return
  }
  const [head = '', ...files] = r.stdout.split('\n').filter(l => l.length > 0)
  // "## main...origin/main [ahead 1]" or "## No commits yet on main"
  const branch = head.replace(/^## (No commits yet on )?/, '').split('...')[0]?.split(' ')[0] || 'HEAD'
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
  git = { branch, changed: files.length, ahead, behind }
}

// Green when every check passed, amber while any runs, red when any failed
function ciOf(rollup: { status?: string; conclusion?: string; state?: string }[]): Ci {
  if (rollup.length === 0) return 'none'
  const results = rollup.map(c => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (results.some(x => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(x))) return 'fail'
  if (rollup.some(c => (c.status && c.status.toUpperCase() !== 'COMPLETED') || (c.state || '').toUpperCase() === 'PENDING')) return 'pending'
  return 'pass'
}

async function refreshPr($: EngineInterface) {
  if (!git || !github.repo) {
    pr = null
    return
  }
  const fields = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup'
  const r = await $.process.run(['gh', 'pr', 'view', '--json', fields], { timeoutMs: 20_000 })
  if (r.exitCode !== 0) {
    pr = null
    return
  }
  const d = JSON.parse(r.stdout) as { number: number; title: string; url: string; state: string; isDraft: boolean; reviewDecision?: string; statusCheckRollup?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }[] }
  const rollup = d.statusCheckRollup ?? []
  const before = pr?.number === d.number ? pr.ci : undefined
  pr = {
    number: d.number,
    title: d.title,
    url: d.url,
    state: d.state,
    isDraft: d.isDraft,
    review: d.reviewDecision ?? '',
    ci: ciOf(rollup),
    checks: rollup.map(c => ({ name: c.name ?? c.context ?? '?', result: (c.conclusion || c.state || c.status || '?').toLowerCase(), runId: /\/runs\/(\d+)/.exec(c.detailsUrl ?? c.targetUrl ?? '')?.[1] })),
  }
  // CI finished since the last look: say so
  if (before === 'pending' && (pr.ci === 'pass' || pr.ci === 'fail')) {
    $.ui.toast(pr.ci === 'pass' ? '✓ CI passed on #' + pr.number : '✗ CI failed on #' + pr.number)
    ping($)
  }
}

// Delivery states, from what git and GitHub say
function stageOf(): Stage | null {
  if (pr?.state === 'MERGED') return 'Merged'
  if (pr?.state === 'CLOSED') return 'Closed'
  if (pr?.isDraft) return 'Draft'
  if (pr) return pr.ci === 'pass' && pr.review === 'APPROVED' ? 'Merge-ready' : 'Ready for review'
  if (git && (git.changed > 0 || git.ahead > 0)) return 'Local changes'
  return null
}

// The Linear issue named in the branch, looked up in the team's list or fetched by id
async function refreshLinked($: EngineInterface) {
  const id = /(?:^|[/_-])([a-z]{2,6}-\d+)(?=$|[/_-])/i.exec(git?.branch ?? '')?.[1]?.toUpperCase()
  if (!id || !linearServer) {
    linkedIssue = null
    return
  }
  const known = linear?.find(x => x.id === id)
  if (known) {
    linkedIssue = { id, title: known.title, url: known.url }
    return
  }
  const d = parseMcp(await $.mcp.call(linearServer, 'get_issue', { id })) as { id?: string; title?: string; url?: string } | null
  linkedIssue = d?.title ? { id, title: d.title, url: d.url ?? '' } : null
}

async function refreshAll($: EngineInterface) {
  await Promise.allSettled([refreshAgents($), refreshGithub($), refreshGit($), refreshThreads($), refreshCli($)])
  await refreshPr($).catch(() => {})
  await refreshLinear($).catch(() => {})
  await refreshLinked($).catch(() => {})
  refreshedAt = await $.clock.now()
  $.ui.invalidate('ui.render')
}

// Desktop meters: a pixel bar that dithers out towards its tip, with a scanline gliding over it
const PX = 2
const BAR_COLS = 56
const BAR_ROWS = 4
const METER_W = 22 + BAR_COLS * PX + 74
const STRIP_H = 14
// 4×4 ordered (Bayer) dither thresholds
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c)
}

// Pixels of one bar: solid at the start, dithering away over the last third of what's left; a faint dotted track after
function barPixels(x0: number, y0: number, filled: number, colour: string): string {
  const lit: string[] = []
  const track: string[] = []
  for (let c = 0; c < BAR_COLS; c++) {
    for (let r = 0; r < BAR_ROWS; r++) {
      const at = `x='${x0 + c * PX}' y='${y0 + r * PX}' width='${PX}' height='${PX}'`
      const threshold = BAYER[r % 4]?.[c % 4] ?? 0
      if (c < filled) {
        const fade = filled < 6 ? 1 : Math.min(1, (filled - c) / (filled / 3))
        if (threshold < fade * 16) lit.push(`<rect ${at}/>`)
      } else if (threshold < 2) {
        track.push(`<rect ${at}/>`)
      }
    }
  }
  return `<g fill='${colour}'>${lit.join('')}</g><g fill='${DARK}'>${track.join('')}</g>`
}

function meterSvg(list: readonly SessionRateLimit[]): string {
  const font = "font-family='ui-monospace,SFMono-Regular,Menlo,monospace' font-size='10'"
  const parts: string[] = []
  list.forEach((l, n) => {
    const x0 = n * METER_W
    const left = Math.max(0, Math.min(100, Math.round(100 - l.percentUsed)))
    const filled = Math.round((left / 100) * BAR_COLS)
    const colour = health(left)
    const bx = x0 + 22
    const by = 3
    parts.push(`<text x='${x0}' y='11' fill='#6b7a6b' ${font}>${windowName(l.kind).toLowerCase()}</text>`)
    parts.push(barPixels(bx, by, filled, colour))
    if (filled > 0) {
      const w = filled * PX
      parts.push(
        `<clipPath id='clip${n}'><rect x='${bx}' y='${by}' width='${w}' height='${BAR_ROWS * PX}'/></clipPath>`,
        `<rect x='${bx}' y='${by}' width='${PX * 2}' height='${BAR_ROWS * PX}' fill='white' opacity='0.6' clip-path='url(#clip${n})'><animate attributeName='x' from='${bx - PX * 2}' to='${bx + w}' dur='2.4s' repeatCount='indefinite'/></rect>`,
      )
    }
    const pctX = bx + BAR_COLS * PX + 8
    const blink = left <= 10 ? "<animate attributeName='opacity' values='1;0.2;1' dur='1s' repeatCount='indefinite'/>" : ''
    parts.push(`<text x='${pctX}' y='11' fill='${colour}' ${font} font-weight='700'>${left}%${blink}</text>`)
    const reset = untilReset(l.resetsAt)
    const runsOut = forecastMinutes(l.kind)
    const resetMinutes = l.resetsAt ? (Date.parse(l.resetsAt) - now) / 60_000 : Infinity
    if (runsOut !== undefined && runsOut < resetMinutes) parts.push(`<text x='${pctX + 30}' y='11' fill='${AMBER}' ${font}>${escapeXml('⚠ ~' + minutesWord(runsOut))}</text>`)
    else if (reset) parts.push(`<text x='${pctX + 30}' y='11' fill='#4d5a4d' ${font}>${escapeXml(reset)}</text>`)
  })
  const width = Math.max(1, list.length) * METER_W
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${STRIP_H}' viewBox='0 0 ${width} ${STRIP_H}' shape-rendering='crispEdges'>${parts.join('')}</svg>`
}

// Pixel icons, 7 by 7 cells, two pixels a cell
const ICONS = {
  agents: ['...X...', '.XXXXX.', '.X.X.X.', '.XXXXX.', '.X...X.', '.XXXXX.', 'X.....X'],
  github: ['.X...X.', '.XXXXX.', 'XXXXXXX', 'X.XXX.X', 'XXXXXXX', '.XXXXX.', '.X.X.X.'],
  linear: ['..XXX..', '.X.XXX.', 'X.X.XXX', 'XX.X.XX', 'XXX.X.X', '.XXX.X.', '..XXX..'],
  branch: ['.X.....', '.X...X.', '.X...X.', '.X..X..', '.XXX...', '.X.....', '.X.....'],
  pr: ['.X...X.', 'XXX.XX.', '.X...X.', '.X...X.', '.X...X.', '.X..XXX', '.X...X.'],
} as const
type IconName = keyof typeof ICONS

function iconSvg(name: IconName, colour: string): string {
  const rects: string[] = []
  ICONS[name].forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === 'X') rects.push(`<rect x='${x * 2}' y='${y * 2}' width='2' height='2'/>`)
    }),
  )
  return `<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14' shape-rendering='crispEdges'><g fill='${colour}'>${rects.join('')}</g></svg>`
}

// Clawd, pixel by pixel: X body, o eye; two pixels a cell, 20 by 14
const CLAWD_ORANGE = '#d97757'
const CLAWD = ['.XXXXXXXX.', '.XXoXXoXX.', 'XXXXXXXXXX', 'XXXXXXXXXX', '.XXXXXXXX.', '.X.X..X.X.', '.X.X..X.X.']

// What Clawd does while Claude works; picked again every few seconds
type Activity = 'idle' | 'laptop' | 'weights' | 'bounce' | 'party'
const BUSY: Activity[] = ['laptop', 'weights', 'bounce']
let activity: Activity = 'idle'
let isWorking = false
let switchedAt = 0

function nextActivity(): Activity {
  const others = BUSY.filter(a => a !== activity)
  return others[Math.floor(Math.random() * others.length)] ?? 'bounce'
}

const loop = "repeatCount='indefinite'"

// Clawd at (ox, oy), two pixels a cell, eyes blinking every 4 s
function clawdBody(ox: number, oy: number): string {
  const px = 2
  const rects: string[] = []
  const lids: string[] = []
  CLAWD.forEach((row, y) =>
    [...row].forEach((c, x) => {
      const at = `x='${ox + x * px}' y='${oy + y * px}' width='${px}' height='${px}'`
      if (c === 'X') rects.push(`<rect ${at}/>`)
      if (c === 'o') lids.push(`<rect ${at} opacity='0'><animate attributeName='opacity' values='0;0;1;0' keyTimes='0;0.92;0.96;1' dur='4s' ${loop}/></rect>`)
    }),
  )
  return `<g fill='${CLAWD_ORANGE}'>${rects.join('')}${lids.join('')}</g>`
}

// Clawd, plus whatever he's busy with: 36 by 18
function clawdSvg(what: Activity): string {
  let scene: string
  if (what === 'laptop') {
    // Typing: a bob, a laptop with code lines that grow and reset
    const line = (y: number, colour: string, dur: string) =>
      `<rect x='25' y='${y}' height='1' fill='${colour}' width='1'><animate attributeName='width' values='1;7;7;1' dur='${dur}' ${loop}/></rect>`
    scene =
      `<g><animateTransform attributeName='transform' type='translate' values='0 0;0 1;0 0' dur='0.3s' ${loop}/>${clawdBody(1, 4)}</g>` +
      `<rect x='23.5' y='5.5' width='11' height='8' fill='#1e2230' stroke='#9aa3b2'/>` +
      line(7, GREEN, '1.1s') + line(9, CYAN, '0.8s') + line(11, AMBER, '1.4s') +
      `<rect x='21' y='14' width='15' height='2' fill='#9aa3b2'/>`
  } else if (what === 'weights') {
    // Lifting: the barbell goes up and Clawd squats with it
    scene =
      `<g><animateTransform attributeName='transform' type='translate' values='0 1;0 0;0 1' dur='1.2s' ${loop}/>${clawdBody(8, 4)}</g>` +
      `<g><animateTransform attributeName='transform' type='translate' values='0 3;0 0;0 3' dur='1.2s' ${loop}/>` +
      `<rect x='3' y='1' width='30' height='1' fill='#c0c4cc'/>` +
      `<rect x='3' y='-1' width='3' height='5' fill='#6b7280'/><rect x='30' y='-1' width='3' height='5' fill='#6b7280'/></g>`
  } else if (what === 'party') {
    // Done! Clawd jumps and confetti falls
    const bits = [[3, '#ffb000'], [10, '#39ff14'], [27, '#58a6ff'], [32, '#ff4fd8'], [16, '#ffffff']]
      .map(([x, c], i) => `<rect x='${x}' y='-2' width='2' height='2' fill='${c}'><animate attributeName='y' values='-2;18' dur='${0.8 + i * 0.15}s' repeatCount='indefinite'/></rect>`)
      .join('')
    scene = bits + `<g><animateTransform attributeName='transform' type='translate' values='0 3;0 -1;0 3' dur='0.35s' ${loop}/>${clawdBody(8, 2)}</g>`
  } else if (what === 'bounce') {
    // Bouncing in place, a little shadow under him
    scene =
      `<ellipse cx='18' cy='17' rx='7' ry='1' fill='#000' opacity='0.35'><animate attributeName='rx' values='7;5;7' dur='0.5s' ${loop}/></ellipse>` +
      `<g><animateTransform attributeName='transform' type='translate' values='0 2;0 -2;0 2' dur='0.5s' ${loop}/>${clawdBody(8, 2)}</g>`
  } else {
    scene = clawdBody(8, 4)
  }
  return `<svg xmlns='http://www.w3.org/2000/svg' width='36' height='18' viewBox='0 0 36 18' shape-rendering='crispEdges'>${scene}</svg>`
}

// Intro: a few seconds of falling letters when a thread starts, a nod to the old new-thread screen
const INTRO_MS = 5000
const RAIN_W = 960
const RAIN_H = 18
let introSvg = ''
let introUntil = 0

// The same letters every time it's drawn, so a redraw doesn't restart the animation
function rainSvg(seed: number): string {
  let x = seed || 1
  const rand = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const font = "font-family='ui-monospace,SFMono-Regular,Menlo,monospace' font-size='9'"
  const cols: string[] = []
  for (let c = 0; c < RAIN_W / 9; c++) {
    const dur = (0.7 + rand() * 1.4).toFixed(2)
    const begin = (-rand() * 2).toFixed(2)
    // Claude orange: a few bright drops, most in the brand colour, some dim
    const shade = rand() < 0.12 ? '#f5b89e' : rand() < 0.55 ? CLAWD_ORANGE : '#7a3f2c'
    const chars = [0, 1, 2].map(i => `<tspan x='${c * 9}' dy='${i === 0 ? 0 : 10}'>${letters[Math.floor(rand() * letters.length)]}</tspan>`).join('')
    cols.push(
      `<text y='-20' fill='${shade}' ${font}>${chars}<animate attributeName='y' values='-22;${RAIN_H + 6}' dur='${dur}s' begin='${begin}s' repeatCount='indefinite'/></text>`,
    )
  }
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${RAIN_W}' height='${RAIN_H}' viewBox='0 0 ${RAIN_W} ${RAIN_H}'>` +
    `<g opacity='0'>${cols.join('')}<animate attributeName='opacity' values='0;1;1;0' keyTimes='0;0.1;0.8;1' dur='${INTRO_MS / 1000}s' fill='freeze'/></g></svg>`
  )
}

// Panel art: a hat colour per model, a Clawd wearing it, and a thin progress bar
function modelColor(model: string): string {
  const m = model.toLowerCase()
  return m.includes('haiku') ? '#3fb950' : m.includes('sonnet') ? '#58a6ff' : m.includes('opus') ? '#a371f7' : m.includes('fable') ? '#ff9e3d' : '#9aa3b2'
}

function avatarSvg(model: string, isRunning: boolean): string {
  const hat = modelColor(model)
  const bob = isRunning ? "<animateTransform attributeName='transform' type='translate' values='0 0;0 -1;0 0' dur='0.5s' repeatCount='indefinite'/>" : ''
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='20' viewBox='0 0 22 20' shape-rendering='crispEdges'>` +
    `<g opacity='${isRunning ? 1 : 0.55}'>${bob}${clawdBody(1, 6)}<rect x='5' y='1' width='12' height='4' fill='${hat}'/><rect x='3' y='4' width='16' height='2' fill='${hat}'/></g></svg>`
  )
}

// A 4 px bar: filled to `fraction` in `colour`, with a light sweeping over it while running
function barSvg(fraction: number, colour: string, isRunning: boolean, width = 260): string {
  const w = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  const sweep = isRunning && w > 8 ? `<rect y='0' width='18' height='4' fill='white' opacity='0.35' clip-path='url(#c)'><animate attributeName='x' from='-18' to='${w}' dur='1.6s' repeatCount='indefinite'/></rect>` : ''
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='4' viewBox='0 0 ${width} 4'>` +
    `<defs><clipPath id='c'><rect width='${w}' height='4' rx='2'/></clipPath></defs>` +
    `<rect width='${width}' height='4' rx='2' fill='#2b2f36'/><rect width='${w}' height='4' rx='2' fill='${colour}'/>${sweep}</svg>`
  )
}

function fmtTokens(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

// Start work on an issue in a new thread; falls back to asking Claude here
async function startIssue($: EngineInterface, issue: { id: string; title: string; url: string }) {
  const prompt = 'Start work on ' + issue.id + ': ' + issue.title + (issue.url ? ' (' + issue.url + ')' : '') + '. Read the issue first, then plan and implement it on its own branch.'
  const background = 'Started from the utility bar in another thread for issue ' + issue.id + '. Follow the repository instructions (AGENTS.md) and the usual branch → verify → PR workflow.'
  try {
    const r = await $.mcp.call('ccd_session', 'start_session', { initiation: 'user_asked', title: (issue.id + ' ' + issue.title).slice(0, 58), prompt, background, context: 'fresh', branch_name: issue.id.toLowerCase().replace('#', 'issue-') })
    if (!r.isError) {
      $.ui.toast('▶ Started a thread for ' + issue.id)
      return
    }
  } catch {}
  await $.prompt.submit({ text: prompt, asUser: true })
}

// Ask Claude to fix the failing checks on this branch's PR
async function fixCi($: EngineInterface) {
  if (!pr) return
  const failed = pr.checks.filter(c => ['failure', 'error', 'timed_out', 'cancelled'].includes(c.result)).map(c => c.name)
  await $.prompt.submit({ text: 'CI is failing on PR #' + pr.number + ' (' + failed.join(', ') + '). Read the failing logs with gh, fix the cause, and push.', asUser: true })
}

// Run a failed check's workflow again
async function rerun($: EngineInterface, runId: string) {
  const r = await $.process.run(['gh', 'run', 'rerun', runId, '--failed'], { timeoutMs: 20_000 })
  $.ui.toast(r.exitCode === 0 ? '↻ Re-running failed jobs' : '↻ Re-run failed: ' + (r.stderr.trim().split('\n')[0] ?? ''))
  if (r.exitCode === 0) refreshPrSoon($)
}
function refreshPrSoon($: EngineInterface) {
  $.clock.after(5_000, () => void refreshPr($).then(() => $.ui.invalidate('ui.render')).catch(() => {}))
}

// Open a page in Claude's own browser pane, beside this thread
async function openInClaude($: EngineInterface, url: string) {
  try {
    const r = await $.mcp.call('Claude_Browser', 'preview_start', { url })
    if (!r.isError) return
  } catch {}
  $.ui.toast("Couldn't open Claude's browser; the link still opens in your own browser")
}

// The details panel: its id and which section it shows
const DECK = 'utility-deck'
type Section = 'agents' | 'github' | 'linear' | 'git' | 'threads'
let section: Section = 'agents'

// Shows `which` in the details panel, opening it if it's closed
let isDeckOpen = false
// True while the panel's ⟳ button is fetching everything again
let isRefreshing = false
let refreshedAt = 0
// Groups folded shut in the panel, as "scope:name"; Backlog starts folded
let collapsed = new Set<string>(['linear:Backlog'])

async function openDeck($: EngineInterface, which: Section) {
  section = which
  isDeckOpen = true
  if (which === 'agents') await Promise.allSettled([refreshAgents($), refreshStats($)])
  await $.ui.open({ id: DECK, title: 'Details', closeOnEscape: true, columns: 56 })
  $.ui.invalidate('ui.render')
}

export const register: Register = (on, options) => {
  soundOn = (options as { sound?: boolean } | undefined)?.sound === true
  linearServerOption = String((options as { linearServer?: string } | undefined)?.linearServer ?? '')

  on('session.start', async ($, e, next) => {
    try {
      limits = (await $.session.usage()).rateLimits
    } catch {}
    try {
      // The bar's 🔈 button wins over the setting once it has been clicked
      const savedSound = await $.store.get('sound')
      if (typeof savedSound === 'boolean') soundOn = savedSound
    } catch {}
    try {
      const saved = (await $.store.get('collapsed')) as string[] | undefined
      if (Array.isArray(saved)) collapsed = new Set(saved)
    } catch {}
    try {
      mode = await readMode($)
    } catch {
      mode = null
    }
    try {
      await $.command.register({ name: 'flip', description: 'Switch the sidebar between project and activity grouping', immediate: true })
      await $.tool.register({
        name: 'step',
        description: "A subagent reports its own progress for the user's Agents panel: steps done out of total, and a few-word note. Call it when the plan is known and as each step finishes.",
        inputSchema: {
          type: 'object',
          properties: {
            done: { type: 'integer', minimum: 0 },
            total: { type: 'integer', minimum: 0 },
            note: { type: 'string', description: 'A few words on the current step.' },
          },
        },
      })
    } catch {}
    // Rain for a few seconds, then the bar
    const started = await $.clock.now()
    introSvg = rainSvg(started % 100000)
    introUntil = started + INTRO_MS
    $.clock.after(INTRO_MS, () => $.ui.invalidate('ui.render'))
    void refreshAll($)
    $.clock.every(REFRESH_MS, () => void refreshAll($))
    // Move the terminal's scan light
    $.clock.every(400, async () => {
      tick += 1
      const t = await $.clock.now()
      // On desktop, redraw only when the reset clocks change minute
      const isNewMinute = Math.floor(t / 60000) !== Math.floor(now / 60000)
      now = t
      // A long turn: Clawd moves on to another activity every 8 s
      const isTimeToSwitch = isWorking && t - switchedAt > 8000
      if (isTimeToSwitch) {
        activity = nextActivity()
        switchedAt = t
      }
      // The Agents panel is open: keep its clocks and statuses moving
      const isPanelTick = isDeckOpen && section === 'agents' && tick % 3 === 0
      if (isPanelTick) await Promise.allSettled([refreshAgents($), refreshStats($), refreshCli($)])
      if (surface !== 'desktop' || isNewMinute || isTimeToSwitch || isPanelTick) $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // Claude finished a turn: files may have changed, so look at git again
  on('turn.start', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) turnStartedAt = await $.clock.now()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A long main turn finished: a toast, a little party for Clawd, and a sound if switched on
    if (!e.agentId && turnStartedAt) {
      const t = await $.clock.now()
      const took = t - turnStartedAt
      turnStartedAt = 0
      if (took > 60_000) {
        $.ui.toast('✓ Done in ' + clock(took))
        partyUntil = t + 4_000
        ping($)
        $.clock.after(4_100, () => $.ui.invalidate('ui.render'))
        $.ui.invalidate('ui.render')
      }
    }
    if (e.agentId) {
      // A subagent finished its turn: stop its clock
      agentEnds[e.agentId] ??= await $.clock.now()
      void refreshAgents($).then(() => $.ui.invalidate('ui.render')).catch(() => {})
      return next(e)
    }
    void refreshGit($).then(() => refreshPr($)).then(() => $.ui.invalidate('ui.render')).catch(() => {})
    return next(e)
  })

  // Each model request of a subagent: its context fill, tokens and estimated cost
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = (result as { usage?: Usage & { model?: string } }).usage
    if (!e.agentId || !usage) return result
    const model = usage.model || e.model
    const u = (agentUse[e.agentId] ??= { context: 0, window: windowOf(model), tokens: 0, cost: 0 })
    const all = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    u.context = all
    u.window = windowOf(model)
    u.tokens += all
    u.cost += costOf(model, usage)
    if (typeof e.effort === 'string') u.effort = e.effort
    // A request names the exact model; the spawn may only have said "sonnet"
    const isNewModel = Boolean(model && models[e.agentId] !== model && (/\d/.test(model) || !models[e.agentId]))
    if (isNewModel) models[e.agentId] = model
    await saveAgentInfo($, isNewModel).catch(() => {})
    if (isDeckOpen) $.ui.invalidate('ui.render')
    return result
  })

  // A subagent reports its steps; the call runs in its own loop, so agentId names it
  // The tool is this mod's own, so the engine's list of known tool names doesn't have it yet
  on('tool.call', { tool: STEP_TOOL } as any, async ($: EngineInterface, e: any) => {
    const id: string | undefined = e.agentId
    if (!id) return { result: 'ignored: only subagents report steps' }
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const u = (agentUse[id] ??= { context: 0, window: 1_000_000, tokens: 0, cost: 0 })
    u.stepTotal = Math.max(0, Math.round(input.total ?? u.stepTotal ?? 0))
    u.stepDone = Math.min(u.stepTotal || Infinity, Math.max(0, Math.round(input.done ?? u.stepDone ?? 0)))
    u.note = input.note?.trim() || undefined
    await saveAgentInfo($, true).catch(() => {})
    if (isDeckOpen) $.ui.invalidate('ui.render')
    return { result: 'ok' }
  })

  // A usage window moved: redraw the bars
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') && typeof e.context?.percent === 'number') {
      contextPct = e.context.percent
      $.ui.invalidate('ui.render')
    }
    if (e.changed.includes('rateLimits')) {
      limits = e.rateLimits
      const t = await $.clock.now()
      for (const l of e.rateLimits) usageHistory.push({ t, kind: l.kind, pct: l.percentUsed })
      while (usageHistory.length > 400 || (usageHistory[0] && t - usageHistory[0].t > 2 * 3600_000)) usageHistory.shift()
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Remember which model each subagent runs on; $.agent.list does not say
  on('agent.spawn', async ($, e, next) => {
    // One line at the end of each brief asking the subagent to report its steps
    const r = await next(e.prompt.includes(STEP_TOOL) ? e : { ...e, prompt: e.prompt + STEP_BRIEF })
    const id = r.agentId ?? r.teammateId
    if (id) {
      models[id] = r.model ?? '?'
      agentStarts[id] = await $.clock.now()
      await saveAgentInfo($, true).catch(() => {})
      await refreshAgents($).catch(() => {})
      $.ui.invalidate('ui.render')
    }
    return r
  }).catch(($, e, next) => next(e))

  // The details panel closed
  on('ui.close', async ($, e, next) => {
    if (e.id === DECK) isDeckOpen = false
    return next(e)
  })

  on('command.run', { command: 'flip' }, async $ => {
    await flip($)
    return {}
  })

  // The utility row: one thin full-width line above the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    surface = e.surface
    // Claude started or stopped: give Clawd something to do, or let him rest
    if (e.props.isWorking !== isWorking) {
      isWorking = e.props.isWorking
      activity = isWorking ? nextActivity() : 'idle'
      switchedAt = now
    }
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const theirs = await next(e)

    // Terminal meters, drawn like the desktop's: a dim lowercase label, a solid bar that
    // dithers away over its last third (█ ▓ ▒ ░), a faint dotted track, a bright cell
    // gliding along, then the bold percentage and the reset time
    // Terminal meters: one row of cells, each its own colour: a thin line that fades out towards its tip, a light gliding along it
    const textMeter = (l: SessionRateLimit) => {
      const cells = 24
      const left = Math.max(0, Math.min(100, Math.round(100 - l.percentUsed)))
      const filled = Math.round((left / 100) * cells)
      const colour = health(left)
      const reset = untilReset(l.resetsAt)
      const Raster = (els as any).Raster as ((props: Record<string, unknown>) => unknown) | undefined
      if (!Raster) {
        return (
          <Box key={l.kind} flexDirection="row">
            <Text color={LABEL}>{windowName(l.kind).toLowerCase() + ' '}</Text>
            <Text color={colour}>{'━'.repeat(filled)}</Text>
            <Text color={DARK}>{'─'.repeat(cells - filled)}</Text>
            <Text color={colour} bold>{' ' + String(left).padStart(3) + '%'}</Text>
          </Box>
        )
      }
      const glide = filled > 1 ? tick % (filled + 6) : -1
      const fadeFrom = filled < 6 ? filled : filled - Math.ceil(filled / 3)
      const row = Array.from({ length: cells }, (_, c): [string, number] => {
        if (c >= filled) return ['─', hexToInt(DARK)]
        if (c === glide) return ['━', 0xffffff]
        const k = c < fadeFrom ? 1 : 1 - (0.6 * (c - fadeFrom + 1)) / (filled - fadeFrom + 1)
        return ['━', scale(hexToInt(colour), k)]
      })
      return (
        <Box key={l.kind} flexDirection="row">
          <Text color={LABEL}>{windowName(l.kind).toLowerCase() + ' '}</Text>
          {Raster({ key: 'meter-' + l.kind, columns: cells, rows: 1, cells: cellsOf([row]) }) as any}
          <Text color={colour} bold>{' ' + String(left).padStart(3) + '%'}</Text>
          {(() => {
            const runsOut = forecastMinutes(l.kind)
            const resetMinutes = l.resetsAt ? (Date.parse(l.resetsAt) - now) / 60_000 : Infinity
            if (runsOut !== undefined && runsOut < resetMinutes) return <Text color={AMBER}>{' ⚠ ~' + minutesWord(runsOut)}</Text>
            return reset ? <Text color={LABEL}>{' ' + reset}</Text> : null
          })()}
        </Box>
      )
    }

    const isDesktop = 'Svg' in els && e.surface === 'desktop'
    if (isDesktop && introSvg && (await $.clock.now()) < introUntil) {
      return (
        <Box flexDirection="column">
          {theirs}
          {(els as any).Svg({ key: 'intro', source: introSvg, alt: 'intro rain', isInteractive: true, width: RAIN_W, height: RAIN_H })}
        </Box>
      )
    }
    // This thread's context fill shows as the first meter, beside the plan's usage windows
    const shownLimits: SessionRateLimit[] = contextPct !== undefined ? [{ kind: 'context', percentUsed: contextPct } as SessionRateLimit, ...limits] : [...limits]
    const meters =
      shownLimits.length === 0
        ? [<Text key="wait" color={DARK}>{'usage: waiting for a reply'}</Text>]
        : isDesktop
          ? [
              (els as any).Svg({
                key: 'meters',
                source: meterSvg(shownLimits),
                alt: shownLimits.map(l => windowName(l.kind) + ' ' + Math.round(100 - l.percentUsed) + '% left').join(', '),
                isInteractive: true,
                width: Math.max(1, shownLimits.length) * METER_W,
                height: STRIP_H,
              }),
            ]
          : shownLimits.map(textMeter)
    // An icon (pixel art on desktop, a glyph in the terminal) and a number that opens its list
    const item = (key: Section, icon: IconName, glyph: string, colour: string, count: string, isQuiet: boolean) => (
      <Box key={'item-' + key} flexDirection="row" columnGap={1}>
        {isDesktop ? (els as any).Svg({ key: 'icon-' + key, source: iconSvg(icon, isQuiet ? '#5a5a5a' : colour), alt: key, width: 14, height: 14 }) : <Text color={isQuiet ? DARK : colour}>{glyph}</Text>}
        <Button key={key} label={count} plain dimColor={isQuiet} onPress={() => openDeck($, key)} />
      </Box>
    )
    const running = agents.length
    // The terminal shows usage only; the desktop gets the whole bar
    if (!isDesktop) {
      return (
        <Box flexDirection="column">
          {theirs}
          <Box key="workbench-row" flexDirection="row" columnGap={3}>
            <Box flexGrow={1} />
            {meters}
          </Box>
        </Box>
      )
    }
    const cliOpen = cliThreads.length + cliSpawned.filter(c => !c.isClosed).length
    const row = (
      <Box key="workbench-row" flexDirection="row" columnGap={3}>
        {(els as any).Svg({ key: 'clawd', source: clawdSvg(now < partyUntil ? 'party' : activity), alt: 'Clawd ' + (now < partyUntil ? 'party' : activity), isInteractive: true, width: 36, height: 18 })}
        <Button key="flip" label={mode === 'state' ? '⚡' : '☰'} plain onPress={() => flip($)} />
        <Button
          key="sound"
          label={soundOn ? '🔈' : '🔇'}
          plain
          dimColor={!soundOn}
          onPress={async () => {
            soundOn = !soundOn
            $.ui.invalidate('ui.render')
            await $.store.set('sound', soundOn)
            ping($)
          }}
        />
        {linkedIssue ? (
          <Box key="linked" flexDirection="row" columnGap={1}>
            <Text color="#8b93ff">◆</Text>
            {linkedIssue.url && (els as any).Link ? (els as any).Link({ key: 'linked-link', href: linkedIssue.url, label: linkedIssue.id }) : <Text>{linkedIssue.id}</Text>}
          </Box>
        ) : null}
        {reviewRequests.length ? <Button key="reviews" label={'🔔 ' + reviewRequests.length} plain onPress={() => openDeck($, 'github')} /> : null}
        {pr ? (
          <Box key="item-pr" flexDirection="row" columnGap={1}>
            {isDesktop ? (els as any).Svg({ key: 'icon-pr', source: iconSvg('pr', pr.state === 'MERGED' ? '#a371f7' : pr.isDraft ? '#5a5a5a' : '#3fb950'), alt: 'pull request', width: 14, height: 14 }) : <Text color="#3fb950">⇄</Text>}
            <Button key="pr" label={'#' + pr.number} plain dimColor={pr.isDraft} onPress={() => openDeck($, 'git')} />
            <Text color={pr.ci === 'pass' ? GREEN : pr.ci === 'fail' ? RED : pr.ci === 'pending' ? AMBER : DARK}>{(pr.ci === 'pending' && tick % 2 ? '○' : '●') + (stageOf() === 'Merge-ready' ? ' ✓' : '')}</Text>
          </Box>
        ) : null}
        {(() => {
          // Overall progress of the subagents that report steps: 5/9
          const live = allAgents.filter(a => LIVE.includes(a.status))
          const done = live.reduce((n, a) => n + (agentUse[a.id]?.stepDone ?? 0), 0)
          const total = live.reduce((n, a) => n + (agentUse[a.id]?.stepTotal ?? 0), 0)
          return (
            <Box key="agents-wrap" flexDirection="row" columnGap={1}>
              {item('agents', 'agents', '◉', CYAN, String(running) + (cliOpen ? ' +' + cliOpen + ' ⌨' : '') + (total ? ' · ' + done + '/' + total : ''), running === 0 && cliOpen === 0)}
              {total ? (els as any).Svg({ key: 'agents-progress', source: barSvg(done / total, CYAN, true, 48), alt: 'subagent progress ' + done + ' of ' + total, width: 48, height: 4, isInteractive: true }) : null}
            </Box>
          )
        })()}
        {(() => {
          // Other threads working right now
          const busy = threads.filter(t => t.isRunning).length
          return threads.length ? <Button key="threads" label={'⧗ ' + busy} plain dimColor={busy === 0} onPress={() => openDeck($, 'threads')} /> : null
        })()}
        {github.repo ? item('github', 'github', '⎇', '#e6edf3', github.prs.length + ' · ' + github.issues.length, false) : null}
        {linear ? item('linear', 'linear', '◆', '#8b93ff', String(linear.length), linear.length === 0) : null}
        <Box flexGrow={1} />
        {meters}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {theirs}
        {row}
      </Box>
    )
  })

  // The details panel: tabs for agents, GitHub and Linear, and the open one's list
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== DECK) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const isDesk = e.surface === 'desktop' && 'Svg' in els
    const svg = (key: string, source: string, alt: string, width: number, height: number, isInteractive = false) =>
      isDesk ? ((els as any).Svg({ key, source, alt, width, height, isInteractive }) as any) : null
    const dim = '#8b949e'
    const { Link } = els as any
    // A header that folds its group: ▾ open, ▸ shut
    const group = (scope: string, name: string, count: number) => {
      const id = scope + ':' + name
      return (
        <Button
          key={'grp-' + id}
          label={(collapsed.has(id) ? '▸ ' : '▾ ') + name + ' · ' + count}
          plain
          onPress={() => {
            if (collapsed.has(id)) collapsed.delete(id)
            else collapsed.add(id)
            $.ui.invalidate('ui.render')
            void $.store.set('collapsed', [...collapsed]).catch(() => {})
          }}
        />
      )
    }
    const isOpen = (scope: string, name: string) => !collapsed.has(scope + ':' + name)
    // The id in its colour, then the title as a link to the page when there is one
    // ⧉ opens the page in Claude's browser pane; ▶ starts a thread for the issue
    const heading = (key: string, id: string, idColour: string, title: string, url: string, canStart = false) => (
      <Box key={key} flexDirection="row" columnGap={1}>
        <Text color={idColour}>{id}</Text>
        {url && Link ? Link({ key: key + '-link', href: url, label: title }) : <Text bold wrap="truncate-end">{title}</Text>}
        <Box flexGrow={1} />
        {url ? <Button key={key + '-claude'} label="⧉" plain dimColor onPress={() => openInClaude($, url)} /> : null}
        {canStart ? <Button key={key + '-start'} label="▶" plain onPress={() => startIssue($, { id, title, url })} /> : null}
      </Box>
    )
    const tile = (key: string, label: string, value: string) => (
      <Box key={key} flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
        <Text color={dim}>{label}</Text>
        <Text bold>{value}</Text>
      </Box>
    )
    const tab = (id: Section, label: string, hotkey: string) => (
      <Button
        key={'tab-' + id}
        label={label}
        hotkey={hotkey}
        plain
        dimColor={section !== id}
        onPress={() => {
          section = id
          $.ui.invalidate('ui.render')
        }}
      />
    )
    const line = (key: string, id: string, title: string, note = '') => (
      <Text key={key} wrap="truncate-end">
        <Text color={CYAN}>{id}</Text> {title} <Text color={DARK}>{note}</Text>
      </Text>
    )
    const empty = (text: string) => <Text color={DARK}>{text}</Text>

    let body
    if (section === 'agents') {
      const t = now || 0
      const live = allAgents.filter(a => LIVE.includes(a.status))
      const done = allAgents.filter(a => !LIVE.includes(a.status))
      const cliGroup = (name: string, list: CliThread[]) =>
        list.length
          ? [
              <Text key={'gap-' + name}> </Text>,
              group('agents', name, list.length),
              ...(isOpen('agents', name)
                ? list.map(c => {
                    const st = c.stats
                    const tokens = st ? (st.usage.input_tokens ?? 0) + (st.usage.output_tokens ?? 0) + (st.usage.cache_read_input_tokens ?? 0) + (st.usage.cache_creation_input_tokens ?? 0) : 0
                    const last = st?.tool ? '▸ ' + st.tool : st?.text ? '“' + st.text + '”' : ''
                    return (
                    <Box key={'cli-' + name + c.id} flexDirection="row" columnGap={1} marginBottom={1}>
                      {svg('cli-av-' + c.id, avatarSvg(st?.model || 'terminal', c.isWorking), 'terminal thread', 22, 20, c.isWorking)}
                      <Box flexDirection="column" flexGrow={1}>
                        <Box flexDirection="row">
                          <Text bold wrap="truncate-end">{c.title}</Text>
                          <Box flexGrow={1} />
                          <Text color={c.isWorking ? GREEN : dim}>{c.isClosed ? '✕' : c.isWorking ? '●' : '○'}</Text>
                        </Box>
                        <Text color={dim} wrap="truncate-end">
                          {(c.isClosed ? 'closed' : 'cli · ' + (c.tty === '??' ? 'pid ' + c.pid : c.tty)) + ' · ' + (st?.branch || (c.cwd.split('/').pop() ?? '')) + (c.at ? ' · ' + ago(new Date(c.at).toISOString()) : '') + (c.isClosed && c.id !== c.pid ? ' · claude -r ' + c.id : '')}
                        </Text>
                        {st?.model ? (
                          <Box flexDirection="row">
                            <Text color={modelColor(st.model)}>{modelLabel(st.model)}</Text>
                            <Text color={dim} wrap="truncate-end">
                              {(st.effort ? ' · ' + st.effort : '') + ' · ' + st.requests + ' req · ' + fmtTokens(tokens) + ' tok · ≈$' + costOf(st.model, st.usage).toFixed(2) + ' · ctx ' + Math.round((100 * st.context) / windowOf(st.model)) + '%'}
                            </Text>
                          </Box>
                        ) : null}
                        {last && !c.isClosed ? <Text color={dim} wrap="truncate-end">{last}</Text> : null}
                      </Box>
                    </Box>
                    )
                  })
                : []),
            ]
          : []
      const card = (a: AgentRow) => {
        const u = agentUse[a.id]
        const isLive = LIVE.includes(a.status)
        const steps = u?.stepTotal ? u.stepDone + '/' + u.stepTotal : ''
        const ctx = u ? Math.round((100 * u.context) / u.window) : 0
        const fraction = u?.stepTotal ? (u.stepDone ?? 0) / u.stepTotal : isLive ? ctx / 100 : 1
        const colour = a.status === 'failed' || a.status === 'killed' ? RED : u?.stepTotal || !isLive ? modelColor(a.model) : '#6e7681'
        const meta = [u ? 'ctx ' + ctx + '%' : '', u ? fmtTokens(u.tokens) : '', u ? '≈$' + u.cost.toFixed(2) : '', clock((a.endedAt ?? t) - a.startedAt)].filter(Boolean).join(' · ')
        return (
          <Box key={'agent-' + a.id} flexDirection="row" columnGap={1} marginBottom={1}>
            {svg('av-' + a.id, avatarSvg(a.model, isLive), modelLabel(a.model) + ' agent', 22, 20, isLive)}
            <Box flexDirection="column" flexGrow={1}>
              <Box flexDirection="row">
                <Text bold wrap="truncate-end">{a.name}</Text>
                <Box flexGrow={1} />
                <Text color={isLive ? GREEN : a.status === 'completed' ? dim : RED}>{isLive ? '●' : a.status === 'completed' ? '✓' : '✗'}</Text>
              </Box>
              <Text wrap="truncate-end">
                <Text color={modelColor(a.model)}>{modelLabel(a.model)}</Text>
                <Text color={dim}>{(u?.effort ? ' · ' + u.effort : '') + ' · ' + a.type}</Text>
              </Text>
              <Box flexDirection="row">
                <Text color={u?.stepTotal ? WHITE : dim}>{steps || (u?.note ?? '')}</Text>
                <Box flexGrow={1} />
                <Text color={dim}>{meta}</Text>
              </Box>
              {isDesk ? svg('bar-' + a.id, barSvg(fraction, colour, isLive), 'progress ' + Math.round(fraction * 100) + '%', 260, 4, isLive) : null}
            </Box>
          </Box>
        )
      }
      const totals = allAgents.reduce((sum, a) => ({ cost: sum.cost + (agentUse[a.id]?.cost ?? 0), tokens: sum.tokens + (agentUse[a.id]?.tokens ?? 0) }), { cost: 0, tokens: 0 })
      body = [
        <Box key="tiles" flexDirection="row" columnGap={1}>
          {tile('t1', 'Cost', stats.cost !== undefined ? '$' + stats.cost.toFixed(2) : '≈$' + totals.cost.toFixed(2))}
          {tile('t2', 'Today', costToday !== undefined ? '$' + costToday.toFixed(2) : '–')}
          {tile('t2b', 'Agent tokens', fmtTokens(totals.tokens))}
          {tile('t3', 'Time', stats.startedAt ? clock(t - stats.startedAt) : '–')}
        </Box>,
        <Text key="gap1"> </Text>,
        <Text key="h-run" bold>{'▾ Running · ' + live.length}</Text>,
        ...(live.length ? live.map(card) : [empty('No subagents running.')]),
        ...cliGroup('⤷ Started here', cliSpawned),
        ...cliGroup('⌨ Terminal threads', [...cliThreads, ...cliClosed]),
        ...(done.length ? [<Text key="gap2"> </Text>, <Text key="h-done" bold>{'▾ Finished · ' + done.length}</Text>, ...done.slice(-10).reverse().map(card)] : []),
      ]
    } else if (section === 'github') {
      const ciDot = (ci: Ci) => <Text color={ci === 'pass' ? GREEN : ci === 'fail' ? RED : ci === 'pending' ? AMBER : DARK}>●</Text>
      const reviewWord = (r: string) => (r === 'APPROVED' ? '✓ approved' : r === 'CHANGES_REQUESTED' ? '✗ changes' : r === 'REVIEW_REQUIRED' ? '○ review' : '')
      const prCard = (x: GhPr, i: number) => (
        <Box key={'pr-' + i} flexDirection="column" marginBottom={1}>
          {heading('prh-' + i, x.id, x.isDraft ? dim : '#3fb950', x.title, x.url)}
          <Text wrap="truncate-end">
            {ciDot(x.ci)}
            <Text color={dim}>{' @' + x.author + ' · ' + x.branch + ' · '}</Text>
            <Text color="#3fb950">{'+' + x.additions}</Text> <Text color={RED}>{'−' + x.deletions}</Text>
            <Text color={dim}>{' · ' + x.files + ' files · ' + ago(x.updated) + (x.isDraft ? ' · draft' : '')}</Text>
            {reviewWord(x.review) ? <Text color={x.review === 'APPROVED' ? GREEN : x.review === 'CHANGES_REQUESTED' ? RED : AMBER}>{' · ' + reviewWord(x.review)}</Text> : null}
          </Text>
        </Box>
      )
      const issueCard = (x: GhIssue, i: number) => (
        <Box key={'is-' + i} flexDirection="column" marginBottom={1}>
          {heading('ish-' + i, x.id, CYAN, x.title, x.url, true)}
          <Text wrap="truncate-end">
            {x.labels.slice(0, 4).map((l, j) => (
              <Text key={'l' + j} color={l.color}>{'◆ ' + l.name + '  '}</Text>
            ))}
            <Text color={dim}>{'@' + x.author + (x.comments ? ' · 💬' + x.comments : '') + ' · ' + ago(x.updated)}</Text>
          </Text>
        </Box>
      )
      body = github.repo
        ? [
            ...(reviewRequests.length
              ? [
                  group('github', '🔔 Review requested', reviewRequests.length),
                  ...(isOpen('github', '🔔 Review requested')
                    ? reviewRequests.map((x, i) => (
                        <Box key={'rr-' + i} flexDirection="column" marginBottom={1}>
                          {heading('rrh-' + i, x.id, AMBER, x.title, x.url)}
                          <Text color={dim}>{'@' + x.author}</Text>
                        </Box>
                      ))
                    : []),
                  <Text key="gap-rr"> </Text>,
                ]
              : []),
            group('github', 'Pull requests', github.prs.length),
            ...(isOpen('github', 'Pull requests') ? (github.prs.length ? github.prs.slice(0, 12).map(prCard) : [empty('None open.')]) : []),
            <Text key="gap"> </Text>,
            group('github', 'Issues', github.issues.length),
            ...(isOpen('github', 'Issues') ? (github.issues.length ? github.issues.slice(0, 20).map(issueCard) : [empty('None open.')]) : []),
          ]
        : [empty('This session is not in a GitHub repo.')]
    } else if (section === 'threads') {
      const card = (x: Thread, i: number) => (
        <Box key={'th-' + i} flexDirection="column" marginBottom={1}>
          <Text wrap="truncate-end">
            <Text color={x.isRunning ? GREEN : dim}>{x.isRunning ? '● ' : '○ '}</Text>
            <Text bold>{x.title}</Text>
          </Text>
          <Text color={dim} wrap="truncate-end">{[x.project, x.pr, ago(x.at)].filter(Boolean).join(' · ')}</Text>
        </Box>
      )
      const busy = threads.filter(t => t.isRunning)
      const idle = threads.filter(t => !t.isRunning)
      body = [
        group('threads', 'Working', busy.length),
        ...(isOpen('threads', 'Working') ? (busy.length ? busy.map(card) : [empty('No other thread is working.')]) : []),
        <Text key="gap-th"> </Text>,
        group('threads', 'Waiting', idle.length),
        ...(isOpen('threads', 'Waiting') ? idle.slice(0, 20).map((x, i) => card(x, 100 + i)) : []),
        <Text key="th-note" color={dim}>Open a thread from the sidebar; the app lets a mod show threads but not switch to them.</Text>,
      ]
    } else if (section === 'git') {
      const stage = stageOf()
      body = git
        ? [
            line('g1', '⑂ ' + git.branch, git.changed + ' changed', (git.ahead ? '↑' + git.ahead + ' ' : '') + (git.behind ? '↓' + git.behind : '')),
            <Text key="g2" bold>{'Stage · ' + (stage ?? 'Clean')}</Text>,
            // Delivery states as a checklist, with the next step
            ...(() => {
              const steps: [string, boolean, string][] = [
                ['Implemented locally', Boolean(git.changed || git.ahead || pr), 'make the change and verify it'],
                ['Pushed', Boolean(pr) || (git.ahead === 0 && git.changed === 0 && Boolean(pr)), 'commit and push the branch'],
                ['Ready for review', Boolean(pr && !pr.isDraft && pr.state === 'OPEN') || pr?.state === 'MERGED', 'open a non-draft PR'],
                ['Merge-ready', stage === 'Merge-ready' || stage === 'Merged', pr?.ci !== 'pass' ? 'get CI green' : 'get an approval'],
                ['Merged', stage === 'Merged', 'merge (your go-ahead)'],
              ]
              const nextStep = steps.find(([, isDone]) => !isDone)
              return [
                ...steps.map(([name, isDone], i) => (
                  <Text key={'ck-' + i} color={isDone ? GREEN : dim}>
                    {(isDone ? '✓ ' : '○ ') + name}
                  </Text>
                )),
                nextStep ? <Text key="ck-next" color={AMBER}>{'→ Next: ' + nextStep[2]}</Text> : null,
              ]
            })(),
            ...(pr
              ? [
                  <Text key="gap"> </Text>,
                  line('p0', '#' + pr.number, pr.title, pr.state.toLowerCase() + (pr.isDraft ? ' · draft' : '') + (pr.review ? ' · ' + pr.review.toLowerCase().replace(/_/g, ' ') : '')),
                  <Box key="p1" flexDirection="row" columnGap={2}>
                    <Text bold>{'Checks · ' + (pr.ci === 'none' ? 'none' : pr.ci)}</Text>
                    {pr.ci === 'fail' ? <Button key="fix-ci" label="🛠 Fix CI" plain onPress={() => fixCi($)} /> : null}
                  </Box>,
                  ...pr.checks.slice(0, 15).map((c, i) => (
                    <Box key={'ck' + i} flexDirection="row" columnGap={1}>
                      {line('c' + i, c.result === 'success' ? '✓' : c.result === 'failure' ? '✗' : '…', c.name, c.result)}
                      {c.result === 'failure' && c.runId ? <Button key={'rerun-' + i} label="↻" plain onPress={() => rerun($, c.runId as string)} /> : null}
                    </Box>
                  )),
                ]
              : [empty('No pull request for this branch.')]),
          ]
        : [empty('Not a git checkout.')]
    } else {
      const statusColor = (type: string) => (type === 'started' ? AMBER : type === 'triage' ? '#ff8f5c' : type === 'unstarted' ? '#c9d1d9' : dim)
      const priority = (n: number) => (n === 1 ? ['‼ urgent', RED] : n === 2 ? ['▲ high', AMBER] : n === 3 ? ['■ medium', '#c9d1d9'] : n === 4 ? ['▽ low', dim] : ['', dim])
      const linCard = (x: LinIssue, i: number) => {
        const [pLabel, pColor] = priority(x.priority)
        return (
          <Box key={'lin-' + i} flexDirection="column" marginBottom={1}>
            {heading('linh-' + i, x.id, '#8b93ff', x.title, x.url, true)}
            <Text wrap="truncate-end">
              <Text color={statusColor(x.statusType)}>{'● ' + x.status}</Text>
              {pLabel ? <Text color={pColor}>{'  ' + pLabel}</Text> : null}
              <Text color={dim}>{(x.assignee ? '  @' + x.assignee : '  unassigned') + ' · ' + ago(x.updated)}</Text>
            </Text>
          </Box>
        )
      }
      // Quick filters: all, mine, urgent (priority 1-2), in progress
      const filters: [LinFilter, string][] = [['all', 'All'], ['mine', 'Mine'], ['urgent', 'Urgent'], ['started', 'In progress']]
      const shown = (linear ?? []).filter(x =>
        linFilter === 'mine' ? mineIds.has(x.id) : linFilter === 'urgent' ? x.priority === 1 || x.priority === 2 : linFilter === 'started' ? x.statusType === 'started' : true,
      )
      const filterRow = (
        <Box key="filters" flexDirection="row" columnGap={2} marginBottom={1}>
          {filters.map(([f, label]) => (
            <Button
              key={'filter-' + f}
              label={label}
              plain
              dimColor={linFilter !== f}
              onPress={() => {
                linFilter = f
                $.ui.invalidate('ui.render')
              }}
            />
          ))}
        </Box>
      )
      // One group per status, in progress first; urgent first inside a group
      const rank: Record<string, number> = { started: 0, unstarted: 1, triage: 2, backlog: 3 }
      const statuses = [...new Map(shown.map(x => [x.status, x.statusType])).entries()].sort((a, b) => (rank[a[1]] ?? 9) - (rank[b[1]] ?? 9))
      let n = 0
      const groups = statuses.flatMap(([status]) => {
        const items = shown.filter(x => x.status === status).sort((x, y) => (x.priority || 5) - (y.priority || 5))
        return [group('linear', status, items.length), ...(isOpen('linear', status) ? items.slice(0, 30).map(x => linCard(x, n++)) : []), <Text key={'gap-' + status}> </Text>]
      })
      body = linear
        ? linear.length
          ? [filterRow, ...(groups.length ? groups : [empty('Nothing matches this filter.')])]
          : [empty('No open Linear issues.')]
        : [empty('No Linear team matches this repo.')]
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={3}>
          {git ? tab('git', 'Git', '0') : null}
          {tab('agents', 'Agents', '1')}
          {threads.length ? tab('threads', 'Threads', '4') : null}
          {tab('github', 'GitHub', '2')}
          {linear ? tab('linear', 'Linear', '3') : null}
          <Box flexGrow={1} />
          <Text color={dim}>{refreshedAt ? ago(new Date(refreshedAt).toISOString()) || 'now' : ''}</Text>
          <Button
            key="refresh"
            label={isRefreshing ? '⟳ …' : '⟳'}
            hotkey="r"
            plain
            onPress={async () => {
              if (isRefreshing) return
              isRefreshing = true
              $.ui.invalidate('ui.render')
              try {
                await Promise.allSettled([refreshAll($), refreshStats($)])
              } finally {
                isRefreshing = false
                refreshedAt = await $.clock.now()
                $.ui.invalidate('ui.render')
              }
            }}
          />
        </Box>
        <Text> </Text>
        {body}
      </Box>
    )
  })
}
