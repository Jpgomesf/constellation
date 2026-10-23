// The constellation mod's state contract: what it keeps in $.state, by value.

/** What an agent's prompts were made of, and its settled red/blue level: shift.ts's CacheMix. */
export type CacheMix = { steps: number; read: number; write: number; fresh: number; recentRead: number; recentMiss: number; level: number }
/** An agent's loop tracker for retrograde: retrograde.ts's RetroTracker. */
export type RetroTracker = { calls: string[]; period: number; run: number; loopAt: number | null; pending: string[]; patient: boolean; sentAt: number | null; heardAt: number | null; endedAt: number | null; heldAt: number | null }
/** One agent's writes to one file, first and latest: binary.ts's Touch. */
export type Touch = { path: string; first: number; at: number }
/** One failed or denied tool call of an agent, in the meteors' sliding minute: meteor.ts's Failure. */
export type Failure = { id: string; agent: string | null; at: number; kind: 'error' | 'deny' }
/** What the session waits on the person for: eclipse.ts's Waiting, same shape. */
export type Waiting = { since: number; reason: 'permission' | 'question' | 'plan' | 'input'; tool: string; summary: string; count: number }

/** One agent of a workflow run, as the run's journal and final record describe it. */
export type RunAgent = {
  id: string
  label: string
  /** The phase the journal filed it under; a child workflow's agents carry "▸ <child>". */
  phase: string | null
  /** Start order within the run, from 0. */
  seq: number
  status: 'running' | 'done' | 'failed'
  /** When the mod first saw it, and first saw it finished (ms). */
  seenAt: number | null
  doneAt: number | null
  /** The journal lines that started and finished it, to order it against a child workflow's start. */
  startLine: number | null
  doneLine: number | null
  /** The rest comes from the run's final record, once it is written. */
  model: string | null
  tokens: number | null
  tools: number | null
  lastTool: string | null
  startedAt: number | null
  durationMs: number | null
  error: string | null
}

export type RunPhase = { title: string; detail: string }

/** A workflow run of this session (or one opened from history). */
export type Run = {
  id: string
  name: string
  description: string
  phases: RunPhase[]
  status: 'running' | 'completed' | 'failed' | 'killed'
  startedAt: number | null
  durationMs: number | null
  agents: RunAgent[]
  /** Each child workflow's parent phase ("▸ scan-stage" -> "Fan out"; null at the root), fixed when first seen. */
  childParents: Record<string, string | null>
  scriptPath: string | null
  hasMeta: boolean
  /** Whether its transcript folder has been seen on disk; a noted run that never gets one expires. */
  hasFolder: boolean
  isFinal: boolean
  journalBytes: number
  journalAt: number | null
}

/** What the mod measured of one agent loop from its model requests. */
export type AgentStats = {
  model: string | null
  effort: string | null
  tokens: number
  costUsd: number | null
  tools: number
  lastTool: string | null
  firstAt: number
  lastAt: number
  endedAt: number | null
  endReason: string | null
  /** The retrograde loop tracker; absent before its first step. */
  tracker?: RetroTracker | null
  /** Files it wrote lately (only while it runs), for the binary star. */
  files?: Touch[]
  /** Its cache mix, for the red/blue shift. */
  cache?: CacheMix
}

/** A plain (non-workflow) subagent or teammate of this session. */
export type SubAgent = {
  id: string
  description: string
  type: string
  status: string
  seenAt: number
}

export type ViewMode = 'live' | 'history' | 'past' | 'inspect'

/** What a press on a node opens in the inspector: an agent, a phase or child workflow, or a run. */
export type Target = { kind: 'agent' | 'node' | 'run'; runKey: string; key: string; from: 'live' | 'past' }

export type View = { mode: ViewMode; pastPath: string | null; target: Target | null }

/** One permission decision on a subagent's tool call, as `tool.check` settled it. */
export type CheckEvent = {
  tool: string
  summary: string
  decision: 'allow' | 'ask' | 'deny'
  /** What decided: `rule Bash(git push:*)`, `hook PreToolUse`, `setting …`, or the engine's reason. */
  by: string
  at: number
}

/** One tool call in an agent's transcript. */
export type TraceTool = {
  id: string
  name: string
  summary: string
  startedAt: number | null
  endedAt: number | null
  status: 'running' | 'ok' | 'error' | 'denied'
  note: string
}

/** What an agent's transcript says it was asked, did and answered. */
export type Trace = { prompt: string; answer: string; tools: TraceTool[]; toolCount: number }

/** The main session's context window and spend, as the engine last measured them. */
export type Gauge = {
  /** Input tokens the last response was answered over; null before the first. */
  tokens: number | null
  window: number
  /** Of the window compaction measures against, 0 to 100. */
  percent: number | null
  costUsd: number | null
  compactions: number
  /** True from a compaction until the next answer, when the engine measures again. */
  isReborn: boolean
}

/** Runs and subagents cleared from the live view; their files and history are kept. */
export type Dismissed = { runs: string[]; agents: string[] }

/** Which band of sky tops the live view, the demo tour's caption naming it, and how much each agent's row tells. */
export type Prefs = { sky: 'stars' | 'shooting' | 'map' | 'parallax' | 'spark'; caption: string | null; detail: 'naked-eye' | 'binoculars' | 'telescope' }

/** The transcript the inspector shows, read again whenever the file grows. */
export type TraceState = { agentId: string; path: string | null; bytes: number; trace: Trace | null; error: string | null }

/** One finished run on disk, for the history list. */
export type HistoryRow = {
  path: string
  runId: string
  name: string
  status: string
  startedAt: number | null
  durationMs: number | null
  agents: number
  tokens: number | null
  project: string
  mtimeMs: number
}

export type History = { rows: HistoryRow[]; isLoading: boolean }

/** A past run opened from history, with costs read from its agents' transcripts. */
export type Past = {
  path: string
  run: Run | null
  stats: Record<string, AgentStats>
  isCosting: boolean
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    constellation: {
      sessionDir: string | null
      runs: Run[]
      stats: Record<string, AgentStats>
      subagents: SubAgent[]
      view: View
      history: History
      past: Past | null
      checks: Record<string, CheckEvent[]>
      trace: TraceState | null
      prefs: Prefs
      gauge: Gauge | null
      /** The made-up gauge `/constellation demo star` plays a star's life on; null otherwise. */
      starDemo: Gauge | null
      dismissed: Dismissed
      /** Agents' failed and denied calls in the last minute, for the meteors (at most 64). */
      failures: Failure[]
      /** The oldest ask the person has not answered, for the eclipse; null when nothing waits. */
      waiting: Waiting | null
      /** The made-up wait `/constellation demo` plays; null otherwise. */
      waitingDemo: Waiting | null
    }
  }
}
