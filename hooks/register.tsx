import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Kind, Run, RunState, SharedRun, SharedSession } from '../types'
import { BG, EMPTY, KIND_HUE, MUTED, STATE_HUE, TEXT, TONE, bandSvg, critterSvg } from './art'
import type { AgyLimits, CodexLimits, Limit, LogUsage, TaskEnd } from './logic'
import {
  agentState,
  agyLimits,
  agyLogUsage,
  applyEnds,
  applyTabs,
  claimTabsByTitle,
  asSharedSession,
  codexLimits,
  codexLogUsage,
  compactCount,
  countRunning,
  elapsed,
  expectedMs,
  expandVars,
  flagValue,
  freshOthers,
  harnessInScript,
  harnessOf,
  hasReferences,
  hostPath,
  isQuiet,
  logFitsRun,
  lookOf,
  nextLook,
  progressOf,
  redact,
  scriptsOf,
  share,
  summarize,
  tabIdOf,
  tail,
  tokensOf,
  toneOf,
  usageFigure,
  taskEnds,
  terminalTabTitles,
  terminalTabs,
  trimRuns,
  usageTokens,
  windowName,
  withoutHeredocs,
} from './logic'

const PANE = 'harness-seer'
const TITLE = 'Runs'
const RUN_TOOL = 'mcp__harness-seer__run'
const RESULT_TOOL = 'mcp__harness-seer__result'
const MAX_OUTPUT = 16000
const MAX_PROMPT = 24000
const KEEP_RUNS = 80
const SHARE_EVERY_MS = 10_000

const runs = atom({ plugin: 'harness-seer', key: 'runs' } as const, [])
const others = atom({ plugin: 'harness-seer', key: 'others' } as const, [])
const showAll = atom({ plugin: 'harness-seer', key: 'showAll' } as const, false)
const autoOpened = atom({ plugin: 'harness-seer', key: 'autoOpened' } as const, false)
// Codex's own rate-limit use, read from its newest session log; held in the module, not shared.
let codexUse: CodexLimits | undefined
const LIMITS_EVERY_MS = 60_000
// Limits older than this are labelled with their age: Codex writes them only while it runs.
const STALE_LIMITS_MS = 6 * 3_600_000
// How many running characters move at once; the rest hold still.
const MAX_MOVING = 4

// Stop handles of child processes this copy of the module started.
const stops = new Map<string, () => void>()
// Task ends seen before their run knew its task id: a short task can end while its Bash call returns.
const early = new Map<string, TaskEnd>()
const KEEP_EARLY = 50
let seq = 0

const rememberEarly = (ends: readonly TaskEnd[]) => {
  for (const end of ends) {
    early.delete(end.taskId)
    early.set(end.taskId, end)
  }
  for (const key of early.keys()) {
    if (early.size <= KEEP_EARLY) break
    early.delete(key)
  }
}

type Access = 'read' | 'write'

// Write access lets the agent edit files in its working directory and no further:
// Codex's workspace-write sandbox, Agy's accept-edits mode with its terminal sandbox kept on.
const argvFor = (
  kind: 'codex' | 'agy',
  model: string,
  effort: string,
  prompt: string,
  access: Access = 'read',
): { argv: string[]; input?: string } => {
  if (kind === 'codex') {
    const argv = ['codex', 'exec', '-s', access === 'write' ? 'workspace-write' : 'read-only']
    if (model) argv.push('-m', model)
    if (effort) argv.push('-c', `model_reasoning_effort="${effort}"`)
    // The prompt goes in on stdin so long briefs do not hit argv limits.
    return { argv: [...argv, '-'], input: prompt }
  }
  const argv = ['agy', '--mode', access === 'write' ? 'accept-edits' : 'plan', '--sandbox', '--output-format', 'text']
  if (model) argv.push('--model', model)
  if (effort) argv.push('--effort', effort)
  return { argv: [...argv, '--print', prompt] }
}

const newId = (kind: Kind, now: number) => {
  seq += 1
  return `${kind}-${now.toString(36)}-${seq}`
}

// Variables a command may name a script folder by; only these are read from the environment,
// each by its literal name so the engine can list what the mod reads.
const folderVars = async ($: EngineInterface): Promise<Record<string, string | undefined>> => ({
  HOME: await $.env.get('HOME'),
  USERPROFILE: await $.env.get('USERPROFILE'),
  TEMP: await $.env.get('TEMP'),
  TMP: await $.env.get('TMP'),
  TMPDIR: await $.env.get('TMPDIR'),
  LOCALAPPDATA: await $.env.get('LOCALAPPDATA'),
  APPDATA: await $.env.get('APPDATA'),
})

/** Codex's latest rate limits, from the newest log in today's or yesterday's session folder. */
const readCodexLimits = async ($: EngineInterface) => {
  try {
    const home = await homeOf($)
    if (!home) return
    const now = await $.clock.now()
    for (const back of [0, 1]) {
      const day = new Date(now - back * 86_400_000)
      const dir = `${home}/.codex/sessions/${day.getFullYear()}/${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}`
      if (!(await $.fs.exists(dir))) continue
      const logs = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.size < 4_000_000)
      // Newest first; a log that has no limits yet (a run just started) gives way to the one before it.
      for (const entry of [...logs].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 3)) {
        const limits = codexLimits(await $.fs.read(`${dir}/${entry.name}`), entry.mtimeMs)
        if (limits) {
          codexUse = limits
          return
        }
      }
    }
  } catch {
    // Codex is not installed here, or its log moved; the pane leaves the line out.
  }
}

// Agy keeps its quota in memory only, so it is asked of Google the way Antigravity's own quota view asks:
// the stored Antigravity login is refreshed, then the quota summary is fetched. The access token lives in
// this module only; it is never put in state, in the shared files or in any output.
const AGY_TOKEN_HOST = 'oauth2.googleapis.com'
const AGY_QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
const AGY_EVERY_MS = 5 * 60_000
const AGY_CLIENT = (home: string) =>
  `antigravity/hub/2.26.0 (aidev_client; os_type=${/^[A-Za-z]:/.test(home) ? 'windows' : home.startsWith('/Users/') ? 'darwin' : 'linux'}; arch=amd64)`
let agyUse: AgyLimits | undefined
let agyNote = ''
let agyToken: { value: string; until: number } | undefined

let agyPending: Promise<void> | undefined

/** One read at a time: a second caller waits for the read already under way. */
const readAgyLimits = ($: EngineInterface): Promise<void> => {
  agyPending ??= readAgyOnce($).finally(() => {
    agyPending = undefined
  })
  return agyPending
}

const readAgyOnce = async ($: EngineInterface) => {
  try {
    const home = await homeOf($)
    if (!home) return
    const path = `${home}/.gemini/antigravity-acp/acp_token.json`
    if (!(await $.fs.exists(path))) {
      agyNote = 'no Antigravity login file'
      return
    }
    const login = JSON.parse(await $.fs.read(path)) as Record<string, unknown>
    const text = (key: string) => (typeof login[key] === 'string' ? (login[key] as string) : '')
    const tokenUri = text('token_uri')
    const host = /^https:\/\/([^/:?#]+)(?:[/?#]|$)/.exec(tokenUri)?.[1] ?? ''
    // The login is only ever sent to Google's own token service.
    if (host !== AGY_TOKEN_HOST || !text('refresh_token') || !text('client_id') || !text('project_id')) {
      agyNote = 'Antigravity login file not usable'
      return
    }
    const now = await $.clock.now()
    if (!agyToken || agyToken.until <= now) {
      const form = ['client_id', 'client_secret', 'refresh_token']
        .map(key => `${key}=${encodeURIComponent(text(key))}`)
        .concat('grant_type=refresh_token')
        .join('&')
      const refreshed = await $.http.fetch(tokenUri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form })
      if (!refreshed.ok) {
        agyToken = undefined
        agyNote = `Antigravity login refused (${refreshed.status}); sign in to agy again`
        return
      }
      const answer = JSON.parse(refreshed.text) as { access_token?: unknown; expires_in?: unknown }
      if (typeof answer.access_token !== 'string') return
      const life = typeof answer.expires_in === 'number' ? answer.expires_in : 3600
      // Renewed five minutes before Google says it lapses.
      agyToken = { value: answer.access_token, until: now + Math.max(60, life - 300) * 1000 }
    }
    const quota = await $.http.fetch(AGY_QUOTA_URL, {
      method: 'POST',
      // Google answers 403 to a client that does not name itself as Antigravity.
      headers: { Authorization: `Bearer ${agyToken.value}`, 'Content-Type': 'application/json', 'User-Agent': AGY_CLIENT(home) },
      body: JSON.stringify({ project: text('project_id') }),
    })
    if (quota.status === 401) agyToken = undefined
    if (!quota.ok) {
      agyNote = `Agy quota unavailable (${quota.status})`
      return
    }
    const limits = agyLimits(quota.text, now)
    if (limits) {
      agyUse = limits
      agyNote = ''
    }
  } catch {
    agyNote = 'Agy quota unavailable'
  }
}

// ---------- Usage from the harnesses' own logs ----------
// Codex writes a session log a run, Agy a conversation folder a run. A run claims the one that appeared
// after it started: the names present at its start are noted, so an older log is never taken for it.

const seenLogs = new Map<string, Set<string>>()
const USAGE_GRACE_MS = 3 * 60_000
// How long after a run's start its log may begin, and how many new logs one pass may read for it.
const USAGE_WINDOW_MS = 3 * 60_000
const MAX_CANDIDATES = 5
let usagePending: Promise<void> | undefined

const dayPart = (at: number) => {
  const day = new Date(at)
  return `${day.getFullYear()}/${String(day.getMonth() + 1).padStart(2, '0')}/${String(day.getDate()).padStart(2, '0')}`
}
const codexSessions = (home: string) => `${home}/.codex/sessions`
const agyBrain = (home: string) => `${home}/.gemini/antigravity-cli/brain`
const agyTranscript = (home: string, id: string) => `${agyBrain(home)}/${id}/.system_generated/logs/transcript.jsonl`

/**
 * The logs a run could have written: Codex's as `YYYY/MM/DD/rollout-*.jsonl` over each day its launch window
 * touches (a run started just before midnight logs under the next day), Agy's as conversation ids.
 * Codex logs older than the run are skipped by their time, and none over 4 MiB is read.
 */
const logNames = async ($: EngineInterface, kind: Kind, home: string, at: number): Promise<string[]> => {
  if (kind === 'agy') {
    const dir = agyBrain(home)
    if (!(await $.fs.exists(dir))) return []
    return (await $.fs.list(dir)).filter(entry => entry.kind === 'dir').map(entry => entry.name)
  }
  const names: string[] = []
  for (const day of new Set([dayPart(at), dayPart(at + USAGE_WINDOW_MS)])) {
    const dir = `${codexSessions(home)}/${day}`
    if (!(await $.fs.exists(dir))) continue
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.size < 4_000_000) names.push(`${day}/${entry.name}`)
    }
  }
  return names
}

/** Notes the logs already there when a Codex or Agy run starts. */
const noteLogs = async ($: EngineInterface, run: Run) => {
  if (run.kind !== 'codex' && run.kind !== 'agy') return
  try {
    const home = await homeOf($)
    if (home) seenLogs.set(run.id, new Set(await logNames($, run.kind, home, run.startedAt)))
  } catch {
    // Usage then comes from matching start times alone.
  }
}

const readUsage = async ($: EngineInterface, kind: Kind, home: string, name: string) => {
  const path = kind === 'codex' ? `${codexSessions(home)}/${name}` : agyTranscript(home, name)
  const text = await $.fs.read(path)
  return kind === 'codex' ? codexLogUsage(text) : agyLogUsage(text)
}

/** One usage pass at a time: a pass still reading logs is not doubled by the next tick. */
const syncUsage = ($: EngineInterface): Promise<void> => {
  usagePending ??= syncUsageOnce($).finally(() => {
    usagePending = undefined
  })
  return usagePending
}

/** Fills tokens, cached share and, for Codex, the model and effort, from each run's own log. */
const syncUsageOnce = async ($: EngineInterface) => {
  try {
    const now = await $.clock.now()
    const list = await read($, runs)
    const due = list.filter(
      run =>
        (run.kind === 'codex' || run.kind === 'agy') &&
        run.source !== 'agent' &&
        (run.state === 'running' || now - (run.endedAt ?? now) < USAGE_GRACE_MS),
    )
    if (due.length === 0) return
    const home = await homeOf($)
    if (!home) return
    const claimed = new Set(list.map(run => run.logId).filter(Boolean))
    for (const run of due) {
      let name = run.logId
      let usage: LogUsage | undefined
      if (name) {
        usage = await readUsage($, run.kind, home, name).catch(() => undefined)
      } else {
        const seen = seenLogs.get(run.id)
        const fresh = (await logNames($, run.kind, home, run.startedAt)).filter(one => !claimed.has(one) && !seen?.has(one))
        // The nearest start after the run's own wins.
        let best: { name: string; usage: LogUsage } | undefined
        // At most a few candidates a pass, so a busy log folder does not stall the host.
        for (const one of fresh.slice(-MAX_CANDIDATES)) {
          const found = await readUsage($, run.kind, home, one).catch(() => undefined)
          if (!found?.startedAt || !logFitsRun(found.startedAt, run.startedAt)) continue
          if (!best || Math.abs(found.startedAt - run.startedAt) < Math.abs((best.usage.startedAt ?? 0) - run.startedAt)) best = { name: one, usage: found }
        }
        if (best) {
          name = best.name
          usage = best.usage
          claimed.add(best.name)
        }
      }
      if (!name || !usage) continue
      const found = usage
      const logId = name
      await patchRun($, run.id, {
        logId,
        tokens: found.tokens || run.tokens,
        cached: found.cached,
        ...(found.model && (!run.model || run.model === 'default') ? { model: found.model } : {}),
        ...(found.effort && (!run.effort || run.effort === 'default') ? { effort: found.effort } : {}),
      })
    }
  } catch {
    // The next pass tries again.
  }
}

const homeOf = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

const sharedDir = async ($: EngineInterface) => {
  const home = await homeOf($)
  return home ? `${home}/.claude/harness-seer/sessions` : undefined
}

// One sync at a time, so a slow periodic pass cannot write an older list over Clear's.
let syncing: Promise<void> = Promise.resolve()
const syncShared = ($: EngineInterface): Promise<void> => {
  syncing = syncing.then(() => syncOnce($))
  return syncing
}

/** Writes this session's runs and reads the others'. Sharing never breaks the session. */
const syncOnce = async ($: EngineInterface) => {
  try {
    const dir = await sharedDir($)
    if (!dir) return
    const self = await $.session.id()
    const now = await $.clock.now()
    const mine = await read($, runs)
    const file = `${dir}/${self}.json`
    // Once written, the file is kept current, so clearing the list clears it for others too.
    if (mine.length > 0 || (await $.fs.exists(file))) {
      await $.fs.write(file, JSON.stringify(share(self, await $.session.root(), now, mine)))
    }
    if (!(await $.fs.exists(dir))) return
    const found: SharedSession[] = []
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${self}.json`) continue
      try {
        const one = asSharedSession(JSON.parse(await $.fs.read(`${dir}/${entry.name}`)))
        if (one) found.push(one)
      } catch {
        // Another session is mid-write, or the file is not one; the next pass reads it again.
      }
    }
    await update($, others, () => freshOthers(found, self, now))
  } catch {
    // The pane shows this session alone until the next pass.
  }
}

/** Ended subagents that no turn.complete reported, such as a stopped one. */
const syncAgents = async ($: EngineInterface) => {
  try {
    const live = await $.agent.list()
    const now = await $.clock.now()
    await update($, runs, list =>
      list.map(run => {
        if (run.state !== 'running' || !run.agentId) return run
        const state = agentState(live.find(one => one.id === run.agentId)?.status ?? '')
        return state ? { ...run, state, endedAt: now } : run
      }),
    )
  } catch {
    // The next pass tries again.
  }
}

const TERMINAL_RUN = 'mcp__terminal__run_in_terminal'
const TERMINAL_STOP = 'mcp__terminal__stop_terminal_tab'

/** A tool result's text, whether it came back as MCP content blocks, `{ text }` or a plain string. */
const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  // An MCP tool's result may come as its bare array of content blocks.
  if (Array.isArray(value)) return value.map(block => textOf(block)).join('\n')
  const blocks = (value as { content?: unknown } | undefined)?.content
  if (Array.isArray(blocks)) return blocks.map(block => (block as { text?: unknown })?.text ?? '').join('\n')
  const text = (value as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : JSON.stringify(value ?? '')
}

/**
 * Whether a row is the engine's own task notice. One that waits for an idle session comes as a
 * `task-notification` row; one delivered into a running turn comes as the engine's `queued_command`
 * attachment under the engine's notification banner, and only counts in that form, not as a prompt that quotes one.
 */
const isNotificationRow = (e: { origin?: { kind?: string }; message?: { type?: string; name?: string } }, text: string) => {
  if (e.origin?.kind === 'task-notification') return true
  return (
    e.origin?.kind === 'engine' &&
    e.message?.type === 'attachment' &&
    e.message?.name === 'queued_command' &&
    text.includes('<task-notification>') &&
    (text.trimStart().startsWith('<task-notification>') || text.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]'))
  )
}

/** Terminal-tab runs that ended: their tab closed, or its shell is back at the prompt. */
const syncTabs = async ($: EngineInterface) => {
  try {
    if (!(await read($, runs)).some(run => run.state === 'running' && run.source === 'terminal')) return
    // The Terminal panel's server, asked directly; failing that, through its tool.
    const text = textOf(
      await $.mcp.call('terminal', 'list_terminal_tabs').catch(() => $.tool.call({ tool: 'mcp__terminal__list_terminal_tabs' } as never)),
    )
    const tabs = terminalTabs(text)
    if (!tabs) return
    const now = await $.clock.now()
    await update($, runs, list => applyTabs(claimTabsByTitle(list, terminalTabTitles(text)), tabs, now))
  } catch {
    // No Terminal panel here (the CLI), or it did not answer; the next pass tries again.
  }
}

const openOnce = async ($: EngineInterface, setting: string) => {
  if (setting === 'never' || (await read($, autoOpened))) return
  await update($, autoOpened, () => true)
  void $.ui.open({ id: PANE, title: TITLE })
}

const startRun = async ($: EngineInterface, setting: string, run: Run) => {
  await noteLogs($, run)
  await update($, runs, list => {
    const looked = run.look === undefined ? { ...run, look: nextLook(list, run.kind) } : run
    return trimRuns([...list.filter(one => one.id !== run.id), looked], KEEP_RUNS)
  })
  await openOnce($, setting)
}

const patchRun = ($: EngineInterface, id: string, patch: Partial<Run>) =>
  update($, runs, list => list.map(one => (one.id === id ? { ...one, ...patch } : one)))

/** A Codex or Agy command's model and effort flags; another program's `-m` (`python -m`) is not a model. */
const specOf = (kind: Kind, typed: string) => {
  if (kind === 'shell') return { model: 'default', effort: 'default' }
  const command = withoutHeredocs(typed)
  return {
    model: flagValue(command, ['--model', '-m']) || 'default',
    effort: flagValue(command, ['--effort', 'model_reasoning_effort=']) || 'default',
  }
}

/** Which harness a shell command runs, looking one level into a script it names. */
const kindOfCommand = async ($: EngineInterface, typed: string): Promise<Kind | undefined> => {
  const command = withoutHeredocs(typed)
  const direct = harnessOf(command)
  if (direct) return direct
  // `S=/x; python $S/a.py` names its script through a variable; put the values in before reading.
  let expanded = command
  if (hasReferences(command)) {
    expanded = expandVars(command, await folderVars($))
  }
  for (const path of scriptsOf(expanded)) {
    // A Git Bash path (`/c/Users/...`) is tried as written, then as Windows spells it.
    for (const candidate of new Set([path, hostPath(path)])) {
      try {
        const inside = harnessInScript(await $.fs.read(candidate))
        if (inside) return inside
        break
      } catch {
        // Not a readable file here; the name was only a word, or the path needs the other spelling.
      }
    }
  }
  return undefined
}

/** A span as the pane writes it: 45s, 3m05s, 2h10m, 3d4h. */
const clock = (ms: number) => {
  const hours = Math.floor(Math.max(0, ms) / 3_600_000)
  if (hours >= 48) return `${Math.floor(hours / 24)}d${hours % 24}h`
  return elapsed({ startedAt: 0, endedAt: Math.max(0, ms) }, 0)
}

export const register: Register = (on, options) => {
  const setting = String((options as { autoOpen?: unknown } | undefined)?.autoOpen ?? 'first-run')
  // Usage reads as percent used by default, as Claude shows it; `left` reads it as Codex does.
  const usageShows: 'used' | 'left' = (options as { usageShows?: unknown } | undefined)?.usageShows === 'left' ? 'left' : 'used'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A reload loses the children of the previous copy; background tasks, subagents and terminal tabs outlive it.
    await update($, runs, list =>
      list.map(run =>
        run.state === 'running' && !stops.has(run.id) && !run.taskId && !run.agentId && run.source !== 'terminal'
          ? { ...run, state: 'lost' as RunState, summary: run.summary || 'Reloaded while running.' }
          : run,
      ),
    )
    await $.command.register({ name: 'runs', description: 'Show Codex, Agy, subagent and background runs in a pane' })
    await $.tool.register({
      name: 'run',
      isDeferred: false,
      description:
        'Start a Codex CLI (codex exec) or Agy CLI run in the background and track it in the Runs pane. access "read" (default) is for reviews and research: Codex read-only sandbox, Agy plan mode. access "write" is for implementation: the agent edits files inside cwd itself (Codex workspace-write sandbox, Agy accept-edits mode with its sandbox on); use a git worktree as cwd to keep its edits apart. Returns a run id at once; when the run ends a short notice arrives, then read the output with the result tool. Do not pass secrets in the prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          harness: { type: 'string', enum: ['codex', 'agy'] },
          prompt: { type: 'string', description: 'The full brief for the external agent.' },
          title: { type: 'string', description: 'Short label for the pane.' },
          model: { type: 'string', description: 'Model id; omit for the CLI default.' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
          access: {
            type: 'string',
            enum: ['read', 'write'],
            description: 'read (default): no file edits. write: may edit files inside cwd.',
          },
          cwd: { type: 'string', description: 'Working directory; default the session cwd. With write access, edits land here.' },
        },
        required: ['harness', 'prompt'],
      },
    })
    await $.tool.register({
      name: 'result',
      isDeferred: false,
      description: 'Read a tracked run by id: state, exit code, elapsed time and captured output tail. Without an id, lists recent runs.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    })
    $.clock.every(1000, () => {
      if (stops.size > 0) $.ui.invalidate('ui.render')
    })
    $.clock.every(SHARE_EVERY_MS, () => {
      void syncAgents($)
        .then(() => syncTabs($))
        .then(() => syncUsage($))
        .then(() => syncShared($))
    })
    $.clock.every(LIMITS_EVERY_MS, () => {
      void readCodexLimits($).then(() => $.ui.invalidate('ui.render'))
    })
    void readCodexLimits($)
    $.clock.every(AGY_EVERY_MS, () => {
      void readAgyLimits($).then(() => $.ui.invalidate('ui.render'))
    })
    void readAgyLimits($).then(() => $.ui.invalidate('ui.render'))
    await syncShared($)
    return started
  })

  on('command.run', { command: 'runs' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Runs pane opened.' }
  })

  on('tool.call', { tool: RUN_TOOL }, async ($, e) => {
    const input = e as unknown as {
      harness?: string
      prompt?: string
      title?: string
      model?: string
      effort?: string
      access?: string
      cwd?: string
    }
    if (input.harness !== 'codex' && input.harness !== 'agy') return { deny: 'harness must be "codex" or "agy".' }
    const access = input.access ?? 'read'
    if (access !== 'read' && access !== 'write') return { deny: 'access must be "read" or "write".' }
    const kind = input.harness
    const prompt = input.prompt ?? ''
    if (!prompt.trim()) return { deny: 'prompt is empty.' }
    if (prompt.length > MAX_PROMPT) return { deny: `prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT}.` }

    const now = await $.clock.now()
    const id = newId(kind, now)
    const model = input.model ?? ''
    const effort = input.effort ?? ''
    const title = (input.title ?? prompt.split('\n')[0] ?? '').slice(0, 80)
    await startRun($, setting, {
      id,
      kind,
      source: 'tool',
      title,
      model: model || 'default',
      effort: effort || 'default',
      state: 'running',
      startedAt: now,
      summary: '',
      output: '',
    })

    const { argv, input: stdin } = argvFor(kind, model, effort, prompt, access)
    let child: ReturnType<EngineInterface['process']['spawn']>
    try {
      child = $.process.spawn({ argv, cwd: input.cwd, input: stdin })
    } catch (err) {
      const summary = `Could not run ${kind}: ${String(err)}`
      await patchRun($, id, { state: 'failed', endedAt: await $.clock.now(), exitCode: null, summary })
      return { deny: summary }
    }
    let cancelled = false
    stops.set(id, () => {
      cancelled = true
      // Ending the stream kills the child.
      void child.return?.(undefined as never)
    })

    void (async () => {
      let output = ''
      let code: number | null = null
      let failure = ''
      let state: RunState = 'failed'
      try {
        try {
          const it = child[Symbol.asyncIterator]()
          for (;;) {
            const step = await it.next()
            if (step.done) {
              code = step.value?.code ?? null
              break
            }
            output = tail(output + step.value.text, MAX_OUTPUT)
            // A missed live update only delays the pane; the final record carries the output.
            await patchRun($, id, { output, summary: summarize(output) }).catch(() => undefined)
          }
        } catch (err) {
          failure = `Could not run ${kind}: ${String(err)}`
          // Whatever broke the loop, the child must not outlive it.
          void Promise.resolve(child.return?.(undefined as never)).catch(() => undefined)
        }
        state = cancelled ? 'cancelled' : failure || code !== 0 ? 'failed' : 'done'
        await patchRun($, id, {
          state,
          endedAt: await $.clock.now(),
          exitCode: code,
          output,
          tokens: tokensOf(output),
          summary: failure || summarize(output) || '(no output)',
        })
      } catch {
        // The full record failed; a bare end still keeps the row from staying running.
        await patchRun($, id, { state, endedAt: Date.now(), exitCode: code }).catch(() => undefined)
      } finally {
        stops.delete(id)
      }
      try {
        $.ui.toast(`${kind} ${state}: ${redact(title)}`)
        if (!cancelled) {
          await $.prompt.submit({ text: `[harness-seer] Run ${id} (${kind}, ${redact(title)}) ended: ${state}, exit ${code}. Read it with ${RESULT_TOOL}.` })
        }
      } catch {
        // The row shows the end; only the notice is lost.
      }
    })()

    return { result: JSON.stringify({ id, state: 'running', note: `Started. Read it later with ${RESULT_TOOL}.` }) }
  }).catch(() => ({ deny: 'harness-seer: the run tool failed to start.' }))

  on('tool.call', { tool: RESULT_TOOL }, async ($, e) => {
    const { id } = e as unknown as { id?: string }
    const list = await read($, runs)
    const now = await $.clock.now()
    if (!id) {
      return {
        result: JSON.stringify(
          list.slice(-15).map(run => ({ id: run.id, kind: run.kind, title: run.title, state: run.state, elapsed: elapsed(run, now), summary: run.summary })),
          null,
          1,
        ),
      }
    }
    const run = list.find(one => one.id === id)
    if (!run) return { deny: `No run has id ${id}.` }
    return { result: JSON.stringify({ ...run, elapsed: elapsed(run, now) }, null, 1) }
  }).catch(() => ({ deny: 'harness-seer: the result tool failed.' }))

  // Every background task shows, named or not, so this pane and the tasks list agree.
  // Bookkeeping never throws past next(e), so the command never runs twice.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const input = e as { command?: unknown; run_in_background?: unknown; description?: unknown }
    const command = String(input.command ?? '')
    const harness = await kindOfCommand($, command)
    const asked = input.run_in_background === true
    let id: string | undefined

    const now = await $.clock.now()
    const begin = async (kind: Kind, at: number) => {
      id = newId(kind, at)
      // The description names the job; the command may carry paths, file names and secrets.
      const label = typeof input.description === 'string' && input.description.trim() ? input.description : command
      await startRun($, setting, {
        id,
        kind,
        source: 'shell',
        title: label.replace(/\s+/g, ' ').slice(0, 80),
        ...specOf(kind, command),
        state: 'running',
        startedAt: at,
        summary: '',
        output: '',
      })
    }
    if (harness || asked) await begin(harness ?? 'shell', now)

    const ran = await next(e)
    try {
      const result = (ran.result ?? {}) as { stdout?: string; stderr?: string; backgroundTaskId?: string; interrupted?: boolean }
      const taskId = result.backgroundTaskId
      // A foreground command the engine moved to the background shows from here.
      if (!id && taskId) await begin('shell', now)
      if (id) {
        if (taskId) {
          await patchRun($, id, { taskId, summary: `Background task ${taskId}` })
          // Its end may have arrived while the call was returning or the id was being attached;
          // from here on, the notification hook finds the id and ends the run itself.
          const end = early.get(taskId)
          early.delete(taskId)
          if (end) {
            const at = await $.clock.now()
            await update($, runs, list => applyEnds(list, [end], at))
          }
        } else {
          const output = tail([result.stdout, result.stderr].filter(Boolean).join('\n'), MAX_OUTPUT)
          const state: RunState = ran.deny !== undefined ? 'cancelled' : ran.isError || result.interrupted ? 'failed' : 'done'
          await patchRun($, id, {
            state,
            endedAt: await $.clock.now(),
            output,
            tokens: tokensOf(output),
            summary: ran.deny ?? (summarize(output) || '(no output)'),
          })
        }
      }
    } catch {
      // The pane misses this run's end; the command's result still goes back.
    }
    return ran
  }).catch(($, e, next) => (next.called ? { deny: 'harness-seer: tracker failed after the command ran.' } : next(e)))

  // The desktop app's Terminal panel: a Codex or Agy command typed into a tab of its own.
  // Its end is read from the tab list, as nothing in the conversation reports it.
  on('tool.call', { tool: TERMINAL_RUN }, async ($, e, next) => {
    const input = e as { command?: unknown; title?: unknown }
    const command = String(input.command ?? '')
    let id: string | undefined
    try {
      const kind = await kindOfCommand($, command)
      if (kind) {
        const now = await $.clock.now()
        id = newId(kind, now)
        const label = typeof input.title === 'string' && input.title.trim() ? input.title : command
        await startRun($, setting, {
          id,
          kind,
          source: 'terminal',
          title: label.replace(/\s+/g, ' ').slice(0, 80),
          ...specOf(kind, command),
          state: 'running',
          startedAt: now,
          summary: 'Starting in a terminal tab',
          output: '',
        })
      }
    } catch {
      id = undefined
    }
    const ran = await next(e)
    if (!id) return ran
    try {
      const tabId = tabIdOf(textOf(ran.result))
      if (ran.deny !== undefined || ran.isError) {
        await patchRun($, id, {
          state: ran.deny !== undefined ? 'cancelled' : 'failed',
          endedAt: await $.clock.now(),
          summary: ran.deny !== undefined ? 'Not started: the call was refused' : 'Not started: no terminal tab opened',
        })
      } else if (!tabId) {
        // The command was typed, but the result named no tab: the tab list finds it by title.
        await patchRun($, id, { summary: 'Terminal tab' })
      } else {
        await patchRun($, id, { tabId, summary: `Terminal tab ${tabId}` })
      }
    } catch {
      // The pane misses this run's tab; the call's result still goes back.
    }
    return ran
  }).catch(($, e, next) => (next.called ? { deny: 'harness-seer: tracker failed after the command was typed.' } : next(e)))

  // Stopping or closing a tab ends the run typed into it.
  on('tool.call', { tool: TERMINAL_STOP }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const tabId = String((e as { tab_id?: unknown }).tab_id ?? '')
      if (tabId && ran.deny === undefined && !ran.isError) {
        const now = await $.clock.now()
        await update($, runs, list =>
          list.map(run =>
            run.state === 'running' && run.tabId === tabId
              ? { ...run, state: 'cancelled', endedAt: now, summary: `Terminal tab ${tabId} stopped` }
              : run,
          ),
        )
      }
    } catch {
      // The tab list catches it on the next pass.
    }
    return ran
  }).catch(($, e, next) => (next.called ? { deny: 'harness-seer: tracker failed after the tab was stopped.' } : next(e)))

  // A task stopped through TaskStop may never get a notice of its own, so the stop itself ends the run.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const input = e as { task_id?: unknown; shell_id?: unknown }
      const taskId = String(input.task_id ?? input.shell_id ?? '')
      if (taskId && ran.deny === undefined && !ran.isError) {
        const at = await $.clock.now()
        await update($, runs, list => applyEnds(list, [{ taskId, state: 'cancelled', summary: 'Stopped' }], at))
      }
    } catch {
      // A notice, if one comes, still ends it.
    }
    return ran
  }).catch(($, e, next) => (next.called ? { deny: 'harness-seer: tracker failed after the task was stopped.' } : next(e)))

  // A background task's end arrives as a notification row in the conversation.
  // Only the engine's own notification rows count: quoted text elsewhere must not end a run.
  on('session.append', async ($, e, next) => {
    try {
      const content = (e.message as { content?: unknown }).content
      const text = typeof content === 'string' ? content : textOf({ content })
      if (!isNotificationRow(e as { origin?: { kind?: string }; message?: { type?: string; name?: string } }, text)) return next(e)
      const ends = taskEnds(text)
      if (ends.length > 0) {
        const at = await $.clock.now()
        const list = await read($, runs)
        rememberEarly(ends.filter(end => !list.some(run => run.taskId === end.taskId)))
        await update($, runs, rows => applyEnds(rows, ends, at))
      }
    } catch {
      // A row is never held up by the pane.
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started
    try {
      const at = await $.clock.now()
      const id = started.agentId ?? newId('claude', at)
      await startRun($, setting, {
        id,
        kind: 'claude',
        source: 'agent',
        title: (e.description || e.subagentType).slice(0, 80),
        model: started.model || 'default',
        effort: 'default',
        state: 'running',
        startedAt: at,
        summary: e.subagentType,
        output: '',
        agentId: started.agentId,
        tokens: 0,
        steps: 0,
      })
    } catch {
      // The subagent still runs.
    }
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (agentId && usage) {
      await update($, runs, list =>
        list.map(run =>
          run.agentId === agentId
            ? { ...run, state: 'running', endedAt: undefined, model: usage.model || run.model, tokens: (run.tokens ?? 0) + usageTokens(usage), cached: (run.cached ?? 0) + (usage.cache_read_input_tokens ?? 0), steps: (run.steps ?? 0) + 1 }
            : run,
        ),
      )
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, runs, list =>
        list.map(run => (run.agentId === agentId ? { ...run, state: e.reason === 'answer' ? 'done' : 'failed', endedAt: at } : run)),
      )
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = await read($, runs)
    const elsewhere = await read($, others)
    const all = await read($, showAll)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns ?? 40)
    const narrow = width < 50
    const barCols = narrow ? 6 : 12
    const usual = (kind: Kind) => expectedMs(list, kind)

    // Summaries that only repeat the bookkeeping are left out.
    const worthShowing = (summary: string) => summary && !/^(Background task|Terminal tab|Starting in a terminal tab)\b/.test(summary)
    // Only the newest few running characters move, so a long list is not all motion beside the prompt.
    const moving = new Set(
      [...list, ...elsewhere.flatMap(one => one.runs)]
        .filter(run => run.state === 'running')
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_MOVING)
        .map(run => run.id),
    )

    const STATE_WORD: Readonly<Record<RunState, string>> = { running: '●', done: '✓ done', failed: '✕ failed', cancelled: '○ cancelled', lost: '? unknown' }

    const card = (run: SharedRun, mine: boolean, prefix: string): RenderElement => {
      const art = critterSvg(run.kind, run.state, lookOf(run), 1.5, !moving.has(run.id))
      const hue = KIND_HUE[run.kind]
      const live = run.state === 'running'
      const expected = usual(run.kind)
      const fraction = progressOf(run, now, expected)
      const filled = Math.round(fraction * barCols)
      const past = live && now - run.startedAt > expected
      const estimate = live ? (past ? 'past usual' : `est ~${Math.round(fraction * 100)}%`) : run.state === 'done' ? '100%' : `${Math.round(fraction * 100)}%`
      const spec = [run.model, run.effort].filter(word => word && word !== 'default').map(redact).join(' ')
      // Tokens are what a harness run costs; a shell task spends none, so it shows none.
      const cachedShare = run.tokens && run.cached ? Math.round((run.cached / run.tokens) * 100) : 0
      const usage = run.kind === 'shell' || !run.tokens ? '' : `${compactCount(run.tokens)} tok${cachedShare ? ` (${cachedShare}% cached)` : ''}`
      const end =
        mine && live
          ? stops.has(run.id)
            ? { label: 'Cancel', press: () => stops.get(run.id)?.() }
            : // A run whose end never arrived (a stop the engine did not report) is closed by hand; nothing is stopped.
              {
                label: 'Mark ended',
                press: async () =>
                  patchRun($, run.id, { state: 'lost', endedAt: await $.clock.now(), summary: 'Marked ended by hand; the process itself was not stopped' }),
              }
          : undefined
      return (
        <Box key={`${prefix}${run.id}`} flexDirection="row">
          {Svg ? (
            <Box key="icon" flexShrink={0} marginRight={1}>
              <Svg source={art.source} alt={`${run.kind} ${run.state}`} width={art.width} height={art.height} />
            </Box>
          ) : null}
          <Box key="text" flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box key="top" flexDirection="row">
              <Box key="title" flexGrow={1} flexShrink={1}>
                <Text bold wrap="truncate-end">
                  {redact(run.title)}
                </Text>
              </Box>
              <Box key="state" flexShrink={0}>
                <Text color={STATE_HUE[run.state]}>
                  {' '}
                  {STATE_WORD[run.state]} {elapsed(run, now)}
                </Text>
              </Box>
            </Box>
            <Box key="bottom" flexDirection="row" alignItems="center">
              <Box key="meta" flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  <Text color={hue} bold>
                    {run.kind}
                  </Text>
                  {spec ? <Text> {spec}</Text> : null}
                  <Text color={MUTED}> </Text>
                  <Text color={live ? hue : STATE_HUE[run.state]}>{'━'.repeat(filled)}</Text>
                  <Text color={EMPTY}>{'·'.repeat(barCols - filled)}</Text>
                  <Text color={MUTED} size="footnote">
                    {' '}
                    {estimate}
                  </Text>
                  {usage ? (
                    <Text color={TEXT} size="footnote">
                      {' · '}
                      {usage}
                    </Text>
                  ) : null}
                  {run.steps ? (
                    <Text color={MUTED} size="footnote">
                      {' · '}
                      {run.steps} steps
                    </Text>
                  ) : null}
                </Text>
              </Box>
              {end ? (
                <Box key="end" flexShrink={0}>
                  <Button label={end.label} onPress={end.press} />
                </Box>
              ) : null}
            </Box>
            {!live && (run.kind !== 'shell' || run.state !== 'done') && worthShowing(run.summary) ? (
              <Text key="summary" dimColor size="footnote" wrap="truncate-end">
                {redact(run.summary)}
              </Text>
            ) : null}
          </Box>
        </Box>
      )
    }

    const sorted = (rows: readonly SharedRun[]) =>
      [...rows].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt - a.startedAt)

    // The header counts this session's runs, and the other sessions' too when they are shown.
    const counted = all ? [...list, ...elsewhere.flatMap(one => one.runs)] : list
    const live = counted.filter(run => run.state === 'running')
    const tokens = counted.reduce((sum, run) => sum + (run.tokens ?? 0), 0)
    const longest = live.reduce((most, run) => Math.max(most, now - run.startedAt), 0)
    const facts = [
      `${live.length} running`,
      tokens ? `${compactCount(tokens)} tok` : '',
      live.length && !narrow ? `longest ${clock(longest)}` : '',
    ].filter(Boolean)

    // One line a harness: what is left in each window, the tightest first, and when the next one resets.
    const limitLine = (
      key: string,
      label: string,
      hue: string,
      items: readonly { name: string; part: Limit }[],
      seenAt: number,
      staleAfter: number,
      note = '',
    ) => {
      if (items.length === 0) return null
      const next = items
        .filter(item => item.part.resetsAt && item.part.resetsAt > now && item.part.usedPercent >= 50)
        .sort((a, b) => (a.part.resetsAt ?? 0) - (b.part.resetsAt ?? 0))[0]
      const age = now - seenAt
      return (
        <Text key={key} size="footnote" wrap="truncate-end">
          <Text color={hue} bold>
            {label}
          </Text>
          {items.map(({ name, part }) => (
            <Text key={name}>
              <Text color={MUTED}> {name} </Text>
              {/* The colour follows what is left, whichever way the figure reads. */}
              <Text color={TONE[toneOf(100 - part.usedPercent)]} bold>
                {usageFigure(part.usedPercent, usageShows)}%
              </Text>
            </Text>
          ))}
          <Text color={MUTED}>
            {next?.part.resetsAt ? ` · ${next.name} resets ${clock(next.part.resetsAt - now)}` : ''}
            {age > staleAfter ? ` · as of ${clock(age)} ago` : ''}
            {note ? ` · ${note}` : ''}
          </Text>
        </Text>
      )
    }
    const codexLine = codexUse
      ? limitLine(
          'codex',
          `Codex ${usageShows}`,
          KIND_HUE.codex,
          [codexUse.primary, codexUse.secondary]
            .filter((one): one is Limit => Boolean(one))
            .map(part => ({ name: windowName(part.windowMinutes), part })),
          codexUse.seenAt,
          STALE_LIMITS_MS,
        )
      : null
    // Agy has several model groups; each shows its tightest window (`gemini 99% week`).
    const agyLine = agyUse
      ? limitLine(
          'agy',
          `Agy ${usageShows}`,
          KIND_HUE.agy,
          agyUse.groups.map(group => {
            const part = [...group.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0] as Limit
            return { name: `${group.name} ${windowName(part.windowMinutes)}`, part }
          }),
          agyUse.seenAt,
          // Asked every 5 minutes: older figures, or a failed ask, say so beside them.
          AGY_EVERY_MS * 3,
          agyNote,
        )
      : agyNote
        ? (
            <Text key="agy" size="footnote" color={MUTED} wrap="truncate-end">
              <Text color={KIND_HUE.agy} bold>
                Agy
              </Text>{' '}
              {agyNote}
            </Text>
          )
        : null

    return (
      <Box flexDirection="column" backgroundColor={Svg ? BG : undefined} paddingX={Svg ? 1 : 0}>
        <Box key="head" flexDirection="row" alignItems="center">
          <Box key="facts" flexGrow={1} flexShrink={1}>
            <Text color={MUTED} size="footnote" wrap="truncate-end">
              {facts.join(' · ')}
            </Text>
          </Box>
          <Box key="tools" flexDirection="row" flexShrink={0}>
            <Button key="scope" label={all ? 'This session' : `All sessions (${elsewhere.length})`} onPress={() => update($, showAll, isAll => !isAll)} />
            {!all && list.some(run => run.state !== 'running') ? (
              <Button
                key="clear"
                label="Clear ended"
                onPress={async () => {
                  await update($, runs, rows => rows.filter(run => run.state === 'running'))
                  await syncShared($)
                }}
              />
            ) : null}
          </Box>
        </Box>
        {codexLine}
        {agyLine}
        <Box key="gap" height={1} />
        {list.length === 0 ? <Text color={MUTED}>No runs in this session yet.</Text> : null}
        {sorted(list).map(run => card(run, true, ''))}
        {all
          ? elsewhere.map(one => (
              <Box key={one.session} flexDirection="column">
                <Text bold color={MUTED} size="footnote">
                  {one.project} · {one.session.slice(0, 8)}
                  {isQuiet(one, now) ? ' · quiet' : ''}
                </Text>
                {sorted(one.runs).map(run => card(run, false, `${one.session}-`))}
              </Box>
            ))
          : null}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e.props as { hasSurvey?: boolean }).hasSurvey) return next(e)
    const counts = countRunning(await read($, runs))
    const drawing = bandSvg(counts)
    if (!drawing) return next(e)
    // Other mods (cache-seer) draw here too: keep what the rest of the chain draws, under the band.
    const below = await next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const words = Object.entries(counts).map(([kind, n]) => `${kind} ${n}`).join(' · ')
    const band = (
      <Box key="harness-seer" flexDirection="row" alignItems="center" backgroundColor={Svg ? BG : undefined} paddingX={1}>
        {Svg ? (
          <Svg key="band" source={drawing.source} alt={`Running: ${words}`} width={drawing.width} height={drawing.height} />
        ) : (
          <Text key="band">Running: {words}</Text>
        )}
        <Button key="open" label={TITLE} onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
      </Box>
    )
    const rest = below && typeof below === 'object' && 'type' in below ? (below as RenderElement) : null
    return rest ? (
      <Box flexDirection="column">
        {band}
        {rest}
      </Box>
    ) : (
      band
    )
  })
}
