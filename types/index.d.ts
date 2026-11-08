export type Kind = 'codex' | 'agy' | 'claude' | 'shell'

export type RunState = 'running' | 'done' | 'failed' | 'cancelled' | 'lost'

export type Run = {
  id: string
  kind: Kind
  source: 'tool' | 'shell' | 'agent' | 'terminal'
  title: string
  model: string
  effort: string
  state: RunState
  startedAt: number
  endedAt?: number
  exitCode?: number | null
  summary: string
  output: string
  /** The Bash or PowerShell background task that carries this run. */
  taskId?: string
  /** The Terminal panel tab (`run_in_terminal`) this run types into. */
  tabId?: string
  /** Tokens served from cache, out of `tokens`. */
  cached?: number
  /** The harness's own log this run's usage comes from (a Codex rollout file or an Agy conversation id). */
  logId?: string
  /** Which of its kind's characters draws this run (a hat and a coat). */
  look?: number
  /** The subagent this run is, as `$.agent.list()` names it. */
  agentId?: string
  tokens?: number
  steps?: number
}

/** A run as other sessions read it: never the output, nor a summary drawn from it. */
export type SharedRun = Omit<Run, 'output'>

export type SharedSession = {
  session: string
  project: string
  updatedAt: number
  runs: SharedRun[]
}

declare module 'claude-code' {
  interface PluginState {
    'harness-seer': {
      runs: Run[]
      others: SharedSession[]
      showAll: boolean
      autoOpened: boolean
    }
  }
}
