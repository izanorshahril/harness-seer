// Pure rules: what counts as a run, how a run ends, what other sessions see.

import type { Kind, Run, RunState, SharedRun, SharedSession } from '../types'

export const QUIET_AFTER_MS = 90_000
export const FORGET_AFTER_MS = 24 * 60 * 60 * 1000
const MAX_SHARED_RUNS = 30
const MAX_READ_RUNS = 200
const KINDS: readonly Kind[] = ['codex', 'agy', 'claude', 'shell']
const STATES: readonly RunState[] = ['running', 'done', 'failed', 'cancelled', 'lost']

// A command position, optional wrappers, optional folders, then the program.
// `env` takes `-u NAME`, short and long flags and `NAME=value` before the program it runs.
const ENV = String.raw`env(?:\s+(?:-u\s+[\w.-]+|-[iS0]|--[\w-]+(?:=\S*)?|[A-Za-z_]\w*=\S*))*`
const WRAPPER = String.raw`(?:(?:cmd(?:\.exe)?\s+/c|(?:pwsh|powershell|bash|sh)(?:\.exe)?(?:\s+-\w+)*?\s+-c(?:ommand)?|npx(?:\s+-\w+)*|bunx|bun\s+x|call|start(?:\s+/\w+)*|time|nohup|${ENV})\s+["']?)*`
const NAME = String.raw`(codex|agy)(?:\.exe|\.cmd)?`
// Each folder ends in exactly one slash and holds none, so a path splits one way only: no backtracking blow-up.
const DIRS = String.raw`(?:[\w.:~$-]*[\\/])*`
// A quoted path may hold spaces after its first part ("C:/Program Files/..."), and must close right after the name.
const quotedPath = (q: string) => String.raw`${q}(?:[^${q}\\/\s]*(?:[\\/][^${q}\\/\n]*)*[\\/])?${NAME}${q}`
const PROGRAM = `(?:${quotedPath('"')}|${quotedPath("'")}|["']?${DIRS}${NAME}["']?)`
const SHELL_CALL = new RegExp(
  // Blanks after a command position are spaces or tabs only, so a run of newlines is not rescanned from each one.
  String.raw`(?:^|[;|(\n{]|&&)[ \t]*(?:&[ \t]*)?` + WRAPPER + PROGRAM + String.raw`\s+(?!--?(?:version|help|h)\b)\S`,
  'i',
)
const SCRIPT_FILE = /\.(?:py|ps1|sh|ts|mjs|js)$/i
// Programs that run the script they are handed; a script named after anything else (cat, grep) is only read.
const RUNNER = /^(?:uv|uvx|python3?|py|node|bun|bunx|deno|tsx|npx|pwsh|powershell|bash|sh|zsh|cmd|call|source|env|\.)(?:\.exe)?$/i
// A `NAME=value` word: an assignment before a command, or `env`'s.
const ASSIGNMENT = /^[A-Za-z_]\w*=/
// Words between a runner and its script that are not the script: subcommands and nested runners.
const PASS = /^(?:run|x|exec|python3?|py|node|bun|deno|tsx)(?:\.exe)?$/i
// Flags whose value is inline code, not a script (`-c`, `--eval=...`).
const INLINE = /^--?(?:c|e|p|command|encodedcommand|eval|print|m)$/i
// One word: quoted (spaces and escapes allowed) or bare. Each character is read once, so long words cost linear time.
const WORD = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
const SEPARATOR = /[;|&(\n{]/g
// Double quotes take backslash escapes; both kinds may span lines.
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
// Same length as the command, separators inside quotes made inert, so positions map back to the original.
const maskQuoted = (command: string) => command.replace(QUOTED, text => text.replace(SEPARATOR, '\u0001'))
const IN_SCRIPT = /["'`](codex|agy)(?:\.exe)?["'`]|\b(codex) exec\b|\b(agy) --/i

export const harnessOf = (command: string): Kind | undefined => {
  // A separator inside quotes is text (`echo "hi; codex exec"`), so it cannot start a command.
  // This also hides `pwsh -c "cd x; codex exec"`, where only the first statement is checked.
  const hit = SHELL_CALL.exec(maskQuoted(command))
  const name = hit?.[1] ?? hit?.[2] ?? hit?.[3]
  return name ? (name.toLowerCase() as Kind) : undefined
}

const wordsOf = (part: string): string[] => [...part.matchAll(WORD)].map(hit => hit[1] ?? hit[2] ?? hit[3] ?? '')

/** The script a runner runs: its first word that is not a flag or a subcommand, when that word is a script. */
const scriptOfRunner = (args: readonly string[]): string | undefined => {
  let afterFlag = false
  for (const word of args) {
    if (word.startsWith('-')) {
      if (INLINE.test(word.split('=')[0] ?? '')) return undefined
      afterFlag = !word.includes('=')
      continue
    }
    if (ASSIGNMENT.test(word) || PASS.test(word.split(/[\\/]/).pop() ?? '')) {
      afterFlag = false
      continue
    }
    if (SCRIPT_FILE.test(word)) return word
    // A word right after a flag may be its value (`-W ignore`, `--project .`); anything else is the program.
    if (!afterFlag) return undefined
    afterFlag = false
  }
  return undefined
}

/** Script files a command runs, at most two, to look inside for a harness: run by a runner, or run as the command itself. */
export const scriptsOf = (command: string): string[] => {
  const found: string[] = []
  const masked = maskQuoted(command)
  const pieces: string[] = []
  let from = 0
  // Split where the masked command has a separator, but take the text from the original.
  for (const hit of masked.matchAll(/&&|\|\||[;|\n]/g)) {
    pieces.push(command.slice(from, hit.index))
    from = hit.index + hit[0].length
  }
  pieces.push(command.slice(from))
  for (const piece of pieces) {
    const words = wordsOf(piece.trim().replace(/^&\s*/, ''))
    // `FOO=1 python x.py` runs python; a word that is only an assignment runs nothing.
    while (words.length > 0 && ASSIGNMENT.test(words[0] ?? '')) words.shift()
    const [first = '', ...args] = words
    if (RUNNER.test(first.split(/[\\/]/).pop() ?? '')) {
      const script = scriptOfRunner(args)
      if (script) found.push(script)
    } else if (SCRIPT_FILE.test(first)) found.push(first)
  }
  return [...new Set(found)].slice(0, 2)
}

// `S=/x; ...`, `export S="/x" && ...` and PowerShell's `$S = '/x'; ...`, at a command position.
const SH_SET = /(?:^|[;&|\n(])[ \t]*(?:export[ \t]+)?([A-Za-z_]\w*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)]*)/g
const PS_SET = /(?:^|[;\n])[ \t]*\$([A-Za-z_]\w*)[ \t]*=[ \t]*("(?:[^"`]|`.)*"|'[^']*'|[^\s;]+)/g
// `${S}`, `$env:S`, `$S` and `%S%`.
const REFERENCE = /\$\{(\w+)\}|\$env:(\w+)|\$(\w+)|%(\w+)%/gi

const unquote = (value: string) => (/^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value)

/** Whether a command refers to a variable or the home folder, so it is worth expanding. */
export const hasReferences = (command: string): boolean => /[$%~]/.test(command)

/**
 * The command with the variables it sets, and the given environment's, put in for their references,
 * and a leading `~` as the home folder: enough to find the scripts it names (`S=/x; python $S/a.py`).
 * A reference to a variable it cannot tell is left as written.
 */
export const expandVars = (command: string, env: Readonly<Record<string, string | undefined>>): string => {
  const known = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) if (value) known.set(key.toUpperCase(), value)
  const put = (text: string) =>
    text.replace(REFERENCE, (whole, a?: string, b?: string, c?: string, d?: string) => known.get((a ?? b ?? c ?? d ?? '').toUpperCase()) ?? whole)
  const sets = [...command.matchAll(SH_SET), ...command.matchAll(PS_SET)].sort((x, y) => (x.index ?? 0) - (y.index ?? 0))
  for (const hit of sets) if (hit[1]) known.set(hit[1].toUpperCase(), put(unquote(hit[2] ?? '')))
  const home = known.get('USERPROFILE') ?? known.get('HOME')
  const expanded = put(command)
  return home ? expanded.replace(/(^|[\s"'=])~(?=[\\/])/g, (_, lead: string) => lead + home) : expanded
}

/** A Git Bash path (`/c/Users/...`) as Windows reads it (`C:/Users/...`); other paths unchanged. */
export const hostPath = (path: string): string => path.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`)

export const harnessInScript = (text: string): Kind | undefined => {
  const hit = IN_SCRIPT.exec(text)
  const name = hit?.[1] ?? hit?.[2] ?? hit?.[3]
  return name ? (name.toLowerCase() as Kind) : undefined
}

export const flagValue = (command: string, flags: readonly string[]): string => {
  for (const flag of flags) {
    const hit = new RegExp(`${flag}[ =]"?([\\w.:/-]+)`).exec(command)
    if (hit?.[1]) return hit[1]
  }
  return ''
}

export const tail = (text: string, max: number): string => (text.length > max ? text.slice(text.length - max) : text)

export const summarize = (text: string): string =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ')
    .slice(0, 300)

export const elapsed = (run: Pick<Run, 'startedAt' | 'endedAt'>, now: number): string => {
  const s = Math.max(0, Math.round(((run.endedAt ?? now) - run.startedAt) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}

export type TaskEnd = { taskId: string; state: RunState; summary: string }

const stateOfWord = (word: string): RunState =>
  word === 'completed' ? 'done' : word === 'killed' || word === 'stopped' ? 'cancelled' : 'failed'

/** The ends a task-notification row reports. It may name several tasks with one status. */
export const taskEnds = (text: string): TaskEnd[] => {
  if (!text.includes('<task-notification>')) return []
  const out: TaskEnd[] = []
  for (const block of text.split('<task-notification>').slice(1)) {
    const word = /<status>([^<]+)<\/status>/.exec(block)?.[1]?.trim()
    if (!word || word === 'running') continue
    const summary = /<summary>([^<]*)<\/summary>/.exec(block)?.[1]?.trim() ?? ''
    for (const match of block.matchAll(/<task-id>([^<]+)<\/task-id>/g)) {
      const taskId = match[1]?.trim()
      if (taskId) out.push({ taskId, state: stateOfWord(word), summary })
    }
  }
  return out
}

/** Applies reported ends to the runs waiting on those tasks. */
export const applyEnds = (list: readonly Run[], ends: readonly TaskEnd[], now: number): Run[] =>
  list.map(run => {
    const end = run.state === 'running' && run.taskId ? ends.find(one => one.taskId === run.taskId) : undefined
    return end ? { ...run, state: end.state, endedAt: now, summary: end.summary || run.summary } : run
  })

export const agentState = (status: string): RunState | undefined =>
  status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'killed' ? 'cancelled' : undefined

export const usageTokens = (usage: {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}): number =>
  (usage.input_tokens ?? 0) +
  (usage.output_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0) +
  (usage.cache_creation_input_tokens ?? 0)

/** Keeps every running run and the newest ended ones, `max` in all unless more are running. */
export const trimRuns = <R extends Pick<Run, 'state'>>(list: readonly R[], max: number): R[] => {
  let room = Math.max(0, max - list.filter(run => run.state === 'running').length)
  const keep = new Set<R>()
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const run = list[i] as R
    if (run.state === 'running') keep.add(run)
    else if (room > 0) {
      keep.add(run)
      room -= 1
    }
  }
  return list.filter(run => keep.has(run))
}

export const compactCount = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** A session's folder name for other sessions; a home folder is shown as `home`, not as the user's name. */
export const projectName = (path: string): string => {
  if (/(?:^|[\\/])(?:Users|home)[\\/][^\\/]+[\\/]?$/i.test(path) || /^~[\\/]?$/.test(path)) return 'home'
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export const share = (session: string, project: string, updatedAt: number, list: readonly Run[]): SharedSession => ({
  session,
  project: projectName(project),
  updatedAt,
  // Output never leaves the session, nor a summary drawn from it: only a subagent's type and the
  // engine's background-task and terminal-tab notices are shared. Deciding by source also covers runs saved earlier.
  // Each field is named, so a field added later is not shared until it is listed here.
  runs: trimRuns(list, MAX_SHARED_RUNS).map(
    (run): SharedRun => ({
      id: run.id,
      kind: run.kind,
      source: run.source,
      title: redact(run.title),
      model: redact(run.model).slice(0, 80),
      effort: redact(run.effort).slice(0, 40),
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      summary: run.source === 'agent' || run.taskId || run.tabId ? redact(run.summary).slice(0, 200) : '',
      tokens: run.tokens,
      cached: run.cached,
      steps: run.steps,
      look: run.look,
    }),
  ),
})

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Another session's file as parsed from disk, or undefined when it is not one; runs that do not fit are dropped. */
export const asSharedSession = (value: unknown): SharedSession | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const one = value as Record<string, unknown>
  const updatedAt = count(one.updatedAt)
  if (typeof one.session !== 'string' || !one.session || updatedAt === undefined || !Array.isArray(one.runs)) return undefined
  const runs: SharedRun[] = []
  // Every running run is shared, so more than MAX_SHARED_RUNS may arrive; this cap only bounds a bad file.
  for (const item of one.runs.slice(0, MAX_READ_RUNS)) {
    if (!item || typeof item !== 'object') continue
    const run = item as Record<string, unknown>
    const startedAt = count(run.startedAt)
    if (typeof run.id !== 'string' || !KINDS.includes(run.kind as Kind) || !STATES.includes(run.state as RunState)) continue
    if (startedAt === undefined) continue
    runs.push({
      id: run.id.slice(0, 80),
      kind: run.kind as Kind,
      source: run.source === 'tool' || run.source === 'agent' || run.source === 'terminal' ? run.source : 'shell',
      title: text(run.title, 80),
      model: text(run.model, 80) || 'default',
      effort: text(run.effort, 40) || 'default',
      state: run.state as RunState,
      startedAt,
      endedAt: count(run.endedAt),
      summary: text(run.summary, 200),
      tokens: count(run.tokens),
      cached: count(run.cached),
      steps: count(run.steps),
      look: count(run.look),
    })
  }
  return { session: one.session.slice(0, 80), project: text(one.project, 80), updatedAt, runs }
}

/** Other sessions' files: not this one, not forgotten. */
export const freshOthers = (all: readonly SharedSession[], self: string, now: number): SharedSession[] =>
  all
    .filter(one => one.session !== self && now - one.updatedAt < FORGET_AFTER_MS && one.runs.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)

/** A running run whose session stopped writing cannot be vouched for. */
export const isQuiet = (one: SharedSession, now: number): boolean => now - one.updatedAt > QUIET_AFTER_MS

export const countRunning = (list: readonly Pick<Run, 'kind' | 'state'>[]): Partial<Record<Kind, number>> => {
  const out: Partial<Record<Kind, number>> = {}
  for (const run of list) if (run.state === 'running') out[run.kind] = (out[run.kind] ?? 0) + 1
  return out
}

/** The tab a `run_in_terminal` result names (`{"tab_id":"c2",...}`). */
// The JSON line (`{"tab_id":"c2"}`), even quoted once more (`\"tab_id\":\"c2\"`), or the prose after it (`terminal tab "c2"`).
const TAB_ID = /\\?"tab_id\\?"\s*:\s*\\?"([\w.-]{1,64})\\?"|terminal tab \\?"([\w.-]{1,64})\\?"/
export const tabIdOf = (text: string): string | undefined => {
  const hit = TAB_ID.exec(text)
  return hit?.[1] ?? hit?.[2]
}

/** `list_terminal_tabs` as tab id to whether a command runs there (null when the app cannot tell). */
export const terminalTabs = (text: string): Map<string, boolean | null> | undefined => {
  const start = text.indexOf('[')
  if (start < 0) return undefined
  try {
    const list: unknown = JSON.parse(text.slice(start, text.lastIndexOf(']') + 1))
    if (!Array.isArray(list)) return undefined
    const tabs = new Map<string, boolean | null>()
    for (const tab of list as { tab_id?: unknown; is_running_command?: unknown }[]) {
      if (typeof tab?.tab_id !== 'string') continue
      tabs.set(tab.tab_id, typeof tab.is_running_command === 'boolean' ? tab.is_running_command : null)
    }
    return tabs
  } catch {
    return undefined
  }
}

/** A tab is only judged once its command has had time to start, so a slow shell is not read as finished. */
export const TAB_GRACE_MS = 15_000

/** Ends terminal runs whose tab closed or went back to its prompt. */
export const applyTabs = (list: readonly Run[], tabs: ReadonlyMap<string, boolean | null>, now: number): Run[] =>
  list.map(run => {
    if (run.state !== 'running' || !run.tabId || now - run.startedAt < TAB_GRACE_MS) return run
    if (!tabs.has(run.tabId)) return { ...run, state: 'done', endedAt: now, summary: `Terminal tab ${run.tabId} closed` }
    if (tabs.get(run.tabId) === false) return { ...run, state: 'done', endedAt: now, summary: `Terminal tab ${run.tabId} is back at its prompt` }
    return run
  })

/** Tokens a Codex run reported at its end (`tokens used` then a count, on one line or the next). */
export const tokensOf = (output: string): number | undefined => {
  const hit = /tokens used[:\s]*([\d,]+)/i.exec(output)
  const n = hit ? Number(hit[1]?.replace(/,/g, '')) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// How long a run of a kind usually takes, before this session has finished any.
const TYPICAL_MS: Readonly<Record<Kind, number>> = { codex: 5 * 60_000, agy: 15 * 60_000, claude: 3 * 60_000, shell: 4 * 60_000 }

/** The usual length of a kind's run: the median of the last finished ones, or a default. */
export const expectedMs = (list: readonly Pick<Run, 'kind' | 'state' | 'startedAt' | 'endedAt'>[], kind: Kind): number => {
  const spans = list
    .filter(run => run.kind === kind && run.state === 'done' && run.endedAt !== undefined)
    .map(run => (run.endedAt ?? 0) - run.startedAt)
    .filter(span => span > 0)
    .slice(-9)
    .sort((a, b) => a - b)
  if (spans.length < 2) return TYPICAL_MS[kind]
  return Math.max(15_000, spans[Math.floor(spans.length / 2)] ?? TYPICAL_MS[kind])
}

/**
 * An estimated share done, 0 to 1. Nothing reports real progress, so a running run moves with time
 * against the usual length: 90% at the usual length, then creeping toward 99% and never 100% until it ends.
 */
export const progressOf = (run: Pick<Run, 'state' | 'startedAt' | 'endedAt'>, now: number, expected: number): number => {
  if (run.state === 'done') return 1
  const span = Math.max(0, (run.endedAt ?? now) - run.startedAt)
  const usual = Math.max(1, expected)
  return span < usual ? 0.9 * (span / usual) : 0.9 + 0.09 * (1 - Math.exp(-(span - usual) / usual))
}

/** A Codex rate-limit window: how much is used and when it resets. */
export type Limit = { usedPercent: number; windowMinutes: number; resetsAt?: number }
export type CodexLimits = { primary?: Limit; secondary?: Limit; seenAt: number }

const limitOf = (value: unknown): Limit | undefined => {
  const v = value as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null
  if (!v || typeof v.used_percent !== 'number' || typeof v.window_minutes !== 'number') return undefined
  return {
    usedPercent: Math.max(0, Math.min(100, v.used_percent)),
    windowMinutes: v.window_minutes,
    resetsAt: typeof v.resets_at === 'number' ? v.resets_at * 1000 : undefined,
  }
}

/** The last rate limits a Codex session log recorded (`"rate_limits":{"primary":...,"secondary":...}`). */
export const codexLimits = (log: string, seenAt: number): CodexLimits | undefined => {
  const at = log.lastIndexOf('"rate_limits":{')
  if (at < 0) return undefined
  const lineEnd = log.indexOf('\n', at)
  const line = log.slice(log.lastIndexOf('\n', at) + 1, lineEnd < 0 ? undefined : lineEnd)
  try {
    const find = (node: unknown): unknown => {
      if (!node || typeof node !== 'object') return undefined
      const o = node as Record<string, unknown>
      if (o.rate_limits && typeof o.rate_limits === 'object') return o.rate_limits
      for (const child of Object.values(o)) {
        const hit = find(child)
        if (hit) return hit
      }
      return undefined
    }
    const limits = find(JSON.parse(line)) as { primary?: unknown; secondary?: unknown } | undefined
    if (!limits) return undefined
    const out = { primary: limitOf(limits.primary), secondary: limitOf(limits.secondary), seenAt }
    return out.primary || out.secondary ? out : undefined
  } catch {
    return undefined
  }
}

/** A window's name from its length: `5h`, `7D`, `1D`. */
export const windowName = (minutes: number): string =>
  minutes === 10080 ? '7D' : minutes === 1440 ? '1D' : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`

/** The next look for a new run of a kind: one past the newest of that kind, so neighbours differ. */
export const nextLook = (list: readonly Pick<Run, 'kind' | 'look' | 'startedAt'>[], kind: Kind): number => {
  const same = list.filter(run => run.kind === kind && typeof run.look === 'number')
  if (same.length === 0) return 0
  const newest = same.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))
  return (newest.look ?? 0) + 1
}

/** A look for a run that has none, such as one shared by an older version: steady by its id. */
export const lookOf = (run: Pick<Run, 'id' | 'look'>): number => {
  if (typeof run.look === 'number') return run.look
  let hash = 0
  for (const ch of run.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash
}

// `<<EOF`, `<<-'EOF'` or `<<"EOF"`, its body, and the line that closes it.
const HEREDOC = /<<-?[ \t]*(["']?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g

// Programs that run what they read on stdin as code: their heredoc is a script, not data.
const RUNS_STDIN = /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|python3?|py|node|bun|deno|ruby|perl|php|xargs|env|codex|agy)(?:\.exe)?(?:\s+-[\w-]+)*\s*$/i

/**
 * A command without the heredoc bodies it feeds to a program as data (`cat > x <<'EOF'`), so the text
 * written into a file is not read as a command. A heredoc fed to a shell or interpreter (`bash <<EOF`) runs,
 * so it stays.
 */
export const withoutHeredocs = (command: string): string =>
  command.replace(HEREDOC, (match, _quote: string, _tag: string, offset: number) => {
    const before = command.slice(command.lastIndexOf('\n', offset) + 1, offset)
    return RUNS_STDIN.test(before) ? match : match.slice(0, match.indexOf('\n'))
  })

/** One Agy model group's windows, as its quota summary reports them. */
export type AgyGroup = { name: string; windows: Limit[] }
export type AgyLimits = { groups: AgyGroup[]; seenAt: number }

const AGY_WINDOW_MINUTES: Readonly<Record<string, number>> = { '5h': 300, daily: 1440, weekly: 10080 }

/** A short name for an Agy model group: `Gemini Models` is gemini, `Claude and GPT models` is claude/gpt. */
export const agyGroupName = (display: string): string => {
  const name = display.toLowerCase().replace(/\bmodels?\b/g, '').replace(/\s+and\s+/g, '/').replace(/\s+/g, ' ').trim()
  const short = name.replace(/^gemini \d+(\.\d+)? /, '')
  return (short || name || 'agy').slice(0, 16)
}

/** Agy's quota summary (`retrieveUserQuotaSummary`) as limits per model group; buckets without a window are left out. */
export const agyLimits = (text: string, seenAt: number): AgyLimits | undefined => {
  try {
    const data = JSON.parse(text) as { groups?: unknown }
    if (!Array.isArray(data.groups)) return undefined
    const groups: AgyGroup[] = []
    for (const group of data.groups.slice(0, 8) as { displayName?: unknown; buckets?: unknown }[]) {
      if (!Array.isArray(group?.buckets)) continue
      const windows: Limit[] = []
      for (const bucket of group.buckets.slice(0, 8) as { window?: unknown; remainingFraction?: unknown; resetTime?: unknown; disabled?: unknown }[]) {
        const minutes = AGY_WINDOW_MINUTES[String(bucket?.window ?? '')]
        if (!minutes || bucket.disabled === true) continue
        // A bucket that reports no fraction but a reset time is used up until then.
        const left = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : bucket.resetTime ? 0 : undefined
        if (left === undefined || !Number.isFinite(left)) continue
        const reset = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN
        windows.push({ usedPercent: Math.max(0, Math.min(100, (1 - left) * 100)), windowMinutes: minutes, resetsAt: Number.isFinite(reset) ? reset : undefined })
      }
      windows.sort((a, b) => a.windowMinutes - b.windowMinutes)
      if (windows.length > 0) groups.push({ name: agyGroupName(String(group.displayName ?? '')), windows })
    }
    return groups.length > 0 ? { groups, seenAt } : undefined
  } catch {
    return undefined
  }
}

// Paths name the user, their projects and files: `C:\Users\me\x`, `/c/Users/me/x`, `~/x`, `/home/me/x`, `./a/b.py`, `a/b.py`.
// A quoted path is taken whole first, so a space in a folder name (`C:\Users\Jane Doe\x`) leaves nothing behind.
const QUOTED_PATH = /(["'])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^"'\n]*\1/g
const WINDOWS_PATH = /(?:\b[A-Za-z]:|\\\\[\w.$-]+)[\\/][^\s"'`<>|;&)]*/g
// Any absolute path of two or more parts (`/srv/private/x`, `/c/Users/me`), and `~/x`; a URL's `//host/x` is not one.
const ROOTED_PATH = /(?:~|(?<![\w:/.])\/[\w.$@-]+)\/[^\s"'`<>|;&)]*/g
// `a/b.py`, `./x/y`: a file, or a path that starts at the current folder. `claude/gpt` is a word.
const RELATIVE_PATH = /(?:\.{1,2}[\\/])?(?:[\w.-]+[\\/])+[\w.-]+/g
const isFilePath = (match: string) => /^\.{1,2}[\\/]/.test(match) || /\.[A-Za-z0-9]{1,8}$/.test(match.split(/[\\/]/).pop() ?? '')
// `user@host`, an email, and `KEY=value` secrets from a command line.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
// `KEY=x`, `API_KEY="a b"`, `token='x'`, `--password x`, `Bearer x`: the name stays, the whole value goes.
const SECRET = /\b([\w-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH))(=)("[^"]*"|'[^']*'|[^\s"';&|]+)/gi
const SECRET_FLAG = /(--?(?:[\w-]*(?:key|token|secret|password|passwd|pass|auth)))(\s+|=)("[^"]*"|'[^']*'|[^\s"';&|]+)/gi
const BEARER = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi

/** Text fit to show and share: paths, file names, emails and secret-looking assignments become `…`. */
export const redact = (text: string): string =>
  text
    .replace(SECRET, '$1$2…')
    .replace(SECRET_FLAG, '$1$2…')
    .replace(BEARER, '$1 …')
    .replace(EMAIL, '…')
    .replace(QUOTED_PATH, '…')
    .replace(WINDOWS_PATH, '…')
    .replace(ROOTED_PATH, '…')
    .replace(RELATIVE_PATH, match => (isFilePath(match) ? '…' : match))
    // A bare file name with a script or data extension (`review.py`) names the user's files too.
    .replace(
      /\b[\w-]+\.(?:py|ps1|psm1|sh|bat|cmd|ts|tsx|js|mjs|cjs|json|jsonl|md|txt|toml|yaml|yml|ini|cfg|conf|env|xml|html?|sqlite3?|db|csv|tsv|log|pem|key|crt|p12|pfx|pdf|docx?|xlsx?|pptx?|png|jpe?g|zip)\b/gi,
      '…',
    )
    // `.env`, `.npmrc`: a dot file is a file name too.
    .replace(/(?<![\w.])\.(?:env|npmrc|netrc|pypirc|git-credentials|aws|ssh)\b[\w.-]*/gi, '…')
    .replace(/…(?:\s*…)+/g, '…')

/** What a harness's own log says a run used: tokens in all, the cached share, and the model it ran. */
export type LogUsage = { startedAt?: number; tokens: number; cached: number; model?: string; effort?: string }

const lines = (text: string) => text.split('\n').filter(line => line.trim().startsWith('{'))

/** A Codex session log (`~/.codex/sessions/.../rollout-*.jsonl`): its start, last token totals and model. */
export const codexLogUsage = (text: string): LogUsage | undefined => {
  let startedAt: number | undefined
  let model: string | undefined
  let effort: string | undefined
  let tokens = 0
  let cached = 0
  for (const line of lines(text)) {
    try {
      const row = JSON.parse(line) as { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> }
      if (startedAt === undefined && typeof row.timestamp === 'string') {
        const at = Date.parse(row.timestamp)
        if (Number.isFinite(at)) startedAt = at
      }
      const payload = row.payload ?? {}
      if (row.type === 'turn_context' && !model) {
        if (typeof payload.model === 'string') model = payload.model
        const raw = payload.effort ?? payload.reasoning_effort
        if (typeof raw === 'string') effort = raw
      }
      // The last running total is the run's total.
      const info = (payload.info ?? payload) as { total_token_usage?: { total_tokens?: unknown; cached_input_tokens?: unknown } }
      const total = info.total_token_usage
      if (total && typeof total.total_tokens === 'number') {
        tokens = total.total_tokens
        cached = typeof total.cached_input_tokens === 'number' ? total.cached_input_tokens : 0
      }
    } catch {
      // A line cut off while Codex writes it.
    }
  }
  return startedAt === undefined ? undefined : { startedAt, tokens, cached, model, effort }
}

/** An Agy conversation transcript (`brain/<id>/.system_generated/logs/transcript.jsonl`): its start and summed tokens. */
export const agyLogUsage = (text: string): LogUsage | undefined => {
  let startedAt: number | undefined
  let tokens = 0
  let cached = 0
  for (const line of lines(text)) {
    try {
      const step = JSON.parse(line) as { created_at?: unknown; input_tokens?: unknown; cache_read_tokens?: unknown; output_tokens?: unknown }
      if (startedAt === undefined && typeof step.created_at === 'string') {
        const at = Date.parse(step.created_at)
        if (Number.isFinite(at)) startedAt = at
      }
      const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      const read = num(step.cache_read_tokens)
      tokens += num(step.input_tokens) + read + num(step.output_tokens)
      cached += read
    } catch {
      // A step cut off while Agy writes it.
    }
  }
  return startedAt === undefined ? undefined : { startedAt, tokens, cached }
}

/** Whether a log started close enough after a run to be that run's: from 15 seconds before to 3 minutes after. */
export const logFitsRun = (logStart: number, runStart: number): boolean => logStart >= runStart - 15_000 && logStart <= runStart + 180_000

/** `list_terminal_tabs` as each tab's id and title, for a run whose tab id the call's result did not name. */
export const terminalTabTitles = (text: string): { id: string; title: string }[] => {
  const start = text.indexOf('[')
  if (start < 0) return []
  try {
    const list: unknown = JSON.parse(text.slice(start, text.lastIndexOf(']') + 1))
    if (!Array.isArray(list)) return []
    return (list as { tab_id?: unknown; title?: unknown }[])
      .filter(tab => typeof tab?.tab_id === 'string' && typeof tab.title === 'string')
      .map(tab => ({ id: tab.tab_id as string, title: tab.title as string }))
  } catch {
    return []
  }
}

/** Gives terminal runs that know no tab the tab of their title, newest tab first, each tab to one run. */
export const claimTabsByTitle = (list: readonly Run[], tabs: readonly { id: string; title: string }[]): Run[] => {
  const taken = new Set(list.map(run => run.tabId).filter(Boolean))
  const label = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 80)
  return list.map(run => {
    if (run.state !== 'running' || run.source !== 'terminal' || run.tabId) return run
    const tab = [...tabs].reverse().find(one => !taken.has(one.id) && label(one.title) === label(run.title))
    if (!tab) return run
    taken.add(tab.id)
    return { ...run, tabId: tab.id, summary: `Terminal tab ${tab.id}` }
  })
}

/** How a usage window stands, by what is left, as cache-seer reads it: ok, watch, high, then critical below 15%. */
export type Tone = 'ok' | 'watch' | 'high' | 'critical'
export const toneOf = (left: number): Tone => (left > 50 ? 'ok' : left > 25 ? 'watch' : left >= 15 ? 'high' : 'critical')

/** A window's figure as the person chose to read it: percent used (Claude's way) or left (Codex's). */
export const usageFigure = (usedPercent: number, shows: 'used' | 'left'): number =>
  Math.round(shows === 'used' ? usedPercent : 100 - usedPercent)
