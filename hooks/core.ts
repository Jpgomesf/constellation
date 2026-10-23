// Pure logic for the constellation mod: reading what a workflow run leaves on
// disk, pricing model usage, and shaping the tree the sky draws. No `$` here.

import type { AgentStats, CacheMix, CheckEvent, Gauge, HistoryRow, RetroTracker, Run, RunAgent, RunPhase, SubAgent, Trace, TraceTool } from '../types'
import type { Binary } from './events/binary'
import { callKey, trackBegin, trackEnd, trackHeard, trackHold, trackRelease, trackStep, watchOf } from './events/retrograde'
import type { RetroWatch } from './events/retrograde'
import type { Waiting } from './events/eclipse'
import type { SkyFailure } from './events/meteor'
import { addUsage, shiftLevel, skyCacheOf } from './events/shift'
import type { SkyCache } from './events/shift'
import type { SkyStyle } from './skies'

// ---------------------------------------------------------------- the sky's props

export type Counts = { done: number; running: number; failed: number }

export type SkyStatus = 'pending' | 'running' | 'done' | 'failed'

export type SkyAgent = {
  id: string
  label: string
  status: 'running' | 'done' | 'failed'
  model: string | null
  effort: string | null
  tokens: number | null
  costUsd: number | null
  tools: number | null
  lastTool: string | null
  startedAt: number | null
  endedAt: number | null
  error: string | null
  /** What retrograde needs, clock-free; null unless running with a tracker. */
  watch?: RetroWatch | null
  /** Its cache share and red/blue shift; null before its first step. */
  cache?: SkyCache | null
}

export type SkyNode = {
  key: string
  kind: 'phase' | 'child'
  title: string
  detail: string
  status: SkyStatus
  agents: SkyAgent[]
  /** Finished agents left out of `agents` to keep the props small. */
  hidden: number
  children: SkyNode[]
  counts: Counts
  costUsd: number | null
  startedAt: number | null
  endedAt: number | null
}

export type SkyRun = {
  key: string
  name: string
  description: string
  status: Run['status']
  startedAt: number | null
  endedAt: number | null
  nodes: SkyNode[]
  /** Agents filed under no phase (and, for the subagents group, every agent). */
  loose: SkyAgent[]
  looseHidden: number
  counts: Counts
  costUsd: number | null
  tools: number
}

export type SkyHistoryLine = {
  path: string
  name: string
  status: string
  startedAt: number | null
  durationMs: number | null
  agents: number
  tokens: number | null
  project: string
}

/** What the inspector shows of the node it was opened on. */
export type SkyInspect = {
  kind: 'agent' | 'node' | 'run'
  runKey: string
  /** The run's name, then each phase and child workflow down to the node. */
  crumbs: string[]
  run: SkyRun | null
  node: SkyNode | null
  agent: SkyAgent | null
  /** Labelled facts: a run's id, script and transcripts, an agent's id and type. */
  facts: { label: string; value: string }[]
  trace: Trace | null
  traceNote: string | null
  checks: CheckEvent[]
}

/** How much the tree tells of each agent, as the person picks it. */
export type DetailLevel = 'naked-eye' | 'binoculars' | 'telescope'

export type SkyProps = {
  now: number
  columns: number
  mode: 'live' | 'history' | 'past' | 'inspect'
  runs: SkyRun[]
  subagents: SkyRun | null
  history: SkyHistoryLine[]
  isLoading: boolean
  note: string | null
  inspect: SkyInspect | null
  /** Which band of sky tops the live view, and the tour's caption for it. */
  sky: SkyStyle
  caption: string | null
  /** How much each agent's row tells (the inspectors always tell everything). */
  detail: DetailLevel
  /** The main session's context window and spend, for the gauge under the header. */
  gauge: Gauge | null
  /** The oldest open ask (eclipse), demo or real; null when nothing waits. */
  waiting: Waiting | null
  /** Files two or more running agents wrote lately; an entry's index is its orbit phase, so never sort or filter it. */
  binaries: Binary[]
  /** The failures of the last minute, newest PROPS_CAP, hashed and labelled (meteors). */
  failures: SkyFailure[]
}

// ---------------------------------------------------------------- pricing

type Price = { input: number; output: number; cacheRead: number }

// USD per million tokens at Anthropic's list prices (October 2026). Cache writes
// are priced at the 5-minute rate (1.25x input; 1-hour writes cost 2x), so every
// cost is an estimate.
const PRICES: readonly (readonly [string, Price])[] = [
  ['fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4-8', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3 }],
  ['haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ['haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
]

const HAIKU_LONG_PROMPT = 100_000

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** `claude-opus-5-5[1m]`, `anthropic.claude-opus-5-5`, `claude-opus-4-5@20251101` -> `opus-5-5`. */
export function modelKey(model: string): string {
  const lower = model.toLowerCase()
  const at = lower.indexOf('claude-')
  return (at >= 0 ? lower.slice(at + 'claude-'.length) : lower)
    .replace(/\[.*\]$/, '')
    .replace(/[@-]\d{8}$/, '')
}

function priceOf(model: string): Price | null {
  const key = modelKey(model)
  const hit = PRICES.find(([name]) => key === name || key.startsWith(`${name}-`))
  return hit ? hit[1] : null
}

/** What one response cost in USD at list price, or null for a model with no price. */
export function costOf(usage: Usage, model: string): number | null {
  const p = priceOf(model)
  if (!p) return null
  const prompt = promptTokens(usage)
  const scale = modelKey(model).startsWith('haiku-5-5') && prompt > HAIKU_LONG_PROMPT ? 5 : 1
  const usd =
    usage.input_tokens * p.input +
    usage.cache_creation_input_tokens * p.input * 1.25 +
    usage.cache_read_input_tokens * p.cacheRead +
    usage.output_tokens * p.output
  return (scale * usd) / 1e6
}

/** The request's whole prompt: what the engine's per-agent `tokens` tracks (its context). */
export const promptTokens = (u: Usage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const addCost = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b)

// ---------------------------------------------------------------- agent stats

/** One model request of an agent loop, as `turn.step` saw it: sent at `sentAt`, answered by `at`. */
export type Step = {
  id: string
  sentAt: number
  at: number
  model: string
  effort: string | null
  usage: Usage | null
  tools: string[]
  /** The loopKey of each tool use, for the retrograde loop tracker. */
  calls: string[]
}

/** Tools called repeatedly with the same input by design: they poll a task, monitor or server. */
const POLLING = new Set(['GetTask', 'TaskGet', 'TaskList', 'Poll', 'Monitor', 'WaitForMcpServers'])

/** A tool call's key for the loop tracker; polling tools' keys are marked `#~`. */
export function loopKey(name: string, input: unknown): string {
  const key = callKey(name, input)
  return POLLING.has(name) && !key.includes('#~') ? key.replace('#', '#~') : key
}

export type End = { id: string; at: number; reason: string }
/** A loop's model request went out at `at`. */
export type Begin = { id: string; at: number }
/** Part of a loop's response had streamed in by `at`. */
export type Heard = { id: string; at: number }
/** A person began (`isOn`) or stopped holding a loop that waits on them, at `at`. */
export type Hold = { id: string; at: number; isOn: boolean }

export function applySteps(
  stats: Readonly<Record<string, AgentStats>>,
  steps: readonly Step[],
  ends: readonly End[],
  begins: readonly Begin[] = [],
  heard: readonly Heard[] = [],
  holds: readonly Hold[] = [],
): Record<string, AgentStats> {
  const next: Record<string, AgentStats> = { ...stats }
  for (const s of steps) {
    const was = next[s.id]
    const cost = s.usage ? costOf(s.usage, s.model) : null
    next[s.id] = {
      model: s.model,
      effort: s.effort ?? was?.effort ?? null,
      tokens: s.usage ? promptTokens(s.usage) : (was?.tokens ?? 0),
      costUsd: addCost(was?.costUsd ?? null, cost),
      tools: (was?.tools ?? 0) + s.tools.length,
      lastTool: s.tools.at(-1) ?? was?.lastTool ?? null,
      firstAt: Math.min(was?.firstAt ?? s.sentAt, s.sentAt),
      lastAt: Math.max(was?.lastAt ?? s.at, s.at),
      // A step after an end is the loop woken again.
      endedAt: was?.endedAt !== null && was?.endedAt !== undefined && s.at > was.endedAt ? null : (was?.endedAt ?? null),
      endReason: was?.endedAt !== null && was?.endedAt !== undefined && s.at > was.endedAt ? null : (was?.endReason ?? null),
      tracker: trackStep(was?.tracker ?? null, { at: s.at, calls: s.calls }),
      files: was?.files,
      cache: s.usage ? addUsage(was?.cache, s.usage) : was?.cache,
    }
  }
  for (const e of ends) {
    const was = next[e.id]
    next[e.id] = {
      model: was?.model ?? null,
      effort: was?.effort ?? null,
      tokens: was?.tokens ?? 0,
      costUsd: was?.costUsd ?? null,
      tools: was?.tools ?? 0,
      lastTool: was?.lastTool ?? null,
      firstAt: was?.firstAt ?? e.at,
      lastAt: Math.max(was?.lastAt ?? e.at, e.at),
      endedAt: e.at,
      endReason: e.reason,
      // Never nulled: a row still drawn running after its turn ended must not read as silent.
      tracker: trackEnd(was?.tracker ?? null, e.at),
      // Kept: binary.ts's applyTouches drops an ended loop's files.
      files: was?.files,
      cache: was?.cache,
    }
  }
  // Retrograde stamps (each list in time order) apply only to loops already measured.
  const stamp = (id: string, fold: (tr: RetroTracker | null) => RetroTracker) => {
    const was = next[id]
    if (was) next[id] = { ...was, tracker: fold(was.tracker ?? null) }
  }
  for (const b of begins) stamp(b.id, tr => trackBegin(tr, b.at))
  for (const h of heard) stamp(h.id, tr => trackHeard(tr, h.at))
  for (const h of holds) stamp(h.id, tr => (h.isOn ? trackHold(tr, h.at) : trackRelease(tr, h.at)))
  return next
}

/** How long an unclaimed loop keeps its stats: a run's journal may not have named it yet. */
const UNCLAIMED_MS = 120_000

/** Keeps the newest `max` stats among claimed agents and loops active within UNCLAIMED_MS. */
export function pruneStats(
  stats: Record<string, AgentStats>,
  claimed: ReadonlySet<string>,
  now: number,
  max: number,
): Record<string, AgentStats> {
  const keep = Object.keys(stats)
    .filter(id => claimed.has(id) || now - (stats[id]?.lastAt ?? 0) < UNCLAIMED_MS)
    .sort((a, b) => (stats[b]?.lastAt ?? 0) - (stats[a]?.lastAt ?? 0))
    .slice(0, max)
  if (keep.length === Object.keys(stats).length) return stats
  return Object.fromEntries(keep.map(id => [id, stats[id] as AgentStats]))
}

/** An agent transcript's cost and last model, from its assistant rows (one per message id). */
export function transcriptStats(text: string): AgentStats | null {
  const byMessage = new Map<string, { model: string; usage: Usage }>()
  let firstAt: number | null = null
  let lastAt: number | null = null
  for (const line of text.split('\n')) {
    const row = parseLine(line)
    if (!row) continue
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (!Number.isNaN(at)) {
      firstAt ??= at
      lastAt = at
    }
    const message = asRecord(row.message)
    if (row.type !== 'assistant' || !message) continue
    const model = str(message.model)
    const usage = usageOf(message.usage)
    const id = str(message.id)
    if (!model || model.startsWith('<') || !usage || !id) continue
    byMessage.set(id, { model, usage })
  }
  if (byMessage.size === 0) return null
  let cost: number | null = null
  let last: { model: string; usage: Usage } | null = null
  // The Map keeps step order, which the cache mix depends on.
  let mixed: CacheMix | undefined
  for (const m of byMessage.values()) {
    cost = addCost(cost, costOf(m.usage, m.model))
    mixed = addUsage(mixed, m.usage)
    last = m
  }
  return {
    model: last?.model ?? null,
    effort: null,
    tokens: last ? promptTokens(last.usage) : 0,
    costUsd: cost,
    tools: 0,
    lastTool: null,
    firstAt: firstAt ?? 0,
    lastAt: lastAt ?? 0,
    endedAt: lastAt,
    endReason: 'answer',
    cache: mixed,
  }
}

function usageOf(value: unknown): Usage | null {
  const u = asRecord(value)
  if (!u) return null
  return {
    input_tokens: num(u.input_tokens) ?? 0,
    output_tokens: num(u.output_tokens) ?? 0,
    cache_read_input_tokens: num(u.cache_read_input_tokens) ?? 0,
    cache_creation_input_tokens: num(u.cache_creation_input_tokens) ?? 0,
  }
}

// ---------------------------------------------------------------- reading a run

export type Meta = { name: string | null; description: string; phases: RunPhase[] }

/** Reads `export const meta = { name, description, phases }` from a workflow script. */
export function parseMeta(source: string): Meta {
  const start = source.indexOf('export const meta')
  const open = start < 0 ? -1 : source.indexOf('{', start)
  const block = open < 0 ? '' : balanced(source, open, '{', '}')
  const phasesAt = block.search(/\bphases\s*:\s*\[/)
  const list = phasesAt < 0 ? '' : balanced(block, block.indexOf('[', phasesAt), '[', ']')
  const phases = [...list.matchAll(/\{[^{}]*\}/g)].flatMap(m => {
    const title = stringAfter(m[0], 'title')
    return title ? [{ title, detail: stringAfter(m[0], 'detail') ?? '' }] : []
  })
  const outer = phasesAt < 0 ? block : block.slice(0, phasesAt)
  return { name: stringAfter(outer, 'name'), description: stringAfter(outer, 'description') ?? '', phases }
}

/** The text from `open` (an opening bracket) to its matching close, strings skipped. */
function balanced(text: string, open: number, opener: string, closer: string): string {
  if (open < 0) return ''
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === opener) depth++
    else if (c === closer && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

function stringAfter(text: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`).exec(text)
  return m?.[2] === undefined ? null : m[2].replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, ' ')
}

/** What the Workflow tool's result text says of the run it launched. */
export type Launch = { runId: string; transcriptDir: string | null; scriptPath: string | null; summary: string | null }

export function parseLaunch(text: string): Launch | null {
  const runId = /Run ID:\s*(wf_[\w-]+)/.exec(text)?.[1]
  if (!runId) return null
  const line = (label: string) => new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim() ?? null
  return { runId, transcriptDir: line('Transcript dir'), scriptPath: line('Script file'), summary: line('Summary') }
}

/** The agents a run's journal names so far, in start order; `prior` keeps when each was first seen running and done. */
export function parseJournal(text: string, prior: readonly RunAgent[], now: number): RunAgent[] {
  const seen = new Map(prior.map(a => [a.id, a]))
  const agents = new Map<string, RunAgent>()
  text.split('\n').forEach((line, n) => {
    const row = parseLine(line)
    const id = row ? str(row.agentId) : null
    if (!row || !id) return
    const a = agents.get(id)
    const was = seen.get(id)
    if (row.type === 'started') {
      agents.set(id, {
        ...blankAgent(id, agents.size),
        label: str(row.label) ?? was?.label ?? id,
        phase: str(row.phase) ?? null,
        seenAt: was?.seenAt ?? now,
        startLine: n,
      })
    } else if (a && row.type === 'result') {
      agents.set(id, { ...a, status: 'done', doneAt: was?.doneAt ?? now, doneLine: n })
    } else if (a && (row.type === 'error' || row.type === 'failed')) {
      const error = str(row.error) ?? str(row.message) ?? 'failed'
      agents.set(id, { ...a, status: 'failed', error, doneAt: was?.doneAt ?? now, doneLine: n })
    }
  })
  return [...agents.values()]
}

function blankAgent(id: string, seq: number): RunAgent {
  return {
    id,
    label: id,
    phase: null,
    seq,
    status: 'running',
    seenAt: null,
    doneAt: null,
    startLine: null,
    doneLine: null,
    model: null,
    tokens: null,
    tools: null,
    lastTool: null,
    startedAt: null,
    durationMs: null,
    error: null,
  }
}

/** A run's final record (`workflows/<runId>.json`), written once the run ends. */
export function parseFinal(value: unknown): Run | null {
  const d = asRecord(value)
  const runId = d ? str(d.runId) : null
  if (!d || !runId) return null
  const progress = Array.isArray(d.workflowProgress) ? d.workflowProgress.map(asRecord) : []
  const declared: RunPhase[] = (Array.isArray(d.phases) ? d.phases : []).flatMap(p => {
    const r = asRecord(p)
    const title = r ? str(r.title) : null
    return r && title ? [{ title, detail: str(r.detail) ?? '' }] : []
  })
  const status = str(d.status)
  const agents = progress.flatMap((e, i): RunAgent[] => {
    const id = e && e.type === 'workflow_agent' ? str(e.agentId) : null
    if (!e || !id) return []
    const state = str(e.state) ?? 'done'
    return [
      {
        id,
        label: str(e.label) ?? id,
        phase: str(e.phaseTitle),
        seq: num(e.index) ?? i,
        status: state === 'done' ? 'done' : state === 'running' && !status ? 'running' : 'failed',
        seenAt: null,
        doneAt: null,
        startLine: null,
        doneLine: null,
        model: str(e.model),
        tokens: num(e.tokens),
        tools: num(e.toolCalls),
        lastTool: str(e.lastToolName),
        startedAt: num(e.startedAt),
        durationMs: num(e.durationMs),
        error: str(e.error) ?? str(e.lastAttemptReason),
      },
    ]
  })
  const meta = typeof d.script === 'string' ? parseMeta(d.script) : null
  return {
    id: runId,
    name: str(d.workflowName) ?? meta?.name ?? runId,
    description: str(d.summary) ?? meta?.description ?? '',
    phases: declared.length > 0 ? declared : (meta?.phases ?? []),
    status: status === 'completed' || status === 'failed' || status === 'killed' ? status : 'failed',
    startedAt: num(d.startTime),
    durationMs: num(d.durationMs),
    agents,
    childParents: {},
    scriptPath: str(d.scriptPath),
    hasMeta: true,
    hasFolder: true,
    isFinal: true,
    journalBytes: 0,
    journalAt: null,
  }
}

/** Joins a live run with its final record: the record wins, the live run fills in what it lacks. */
export function mergeFinal(live: Run, final: Run): Run {
  const before = new Map(live.agents.map(a => [a.id, a]))
  return withParents({
    ...final,
    name: final.name === final.id ? live.name : final.name,
    description: final.description || live.description,
    phases: final.phases.length > 0 ? final.phases : live.phases,
    childParents: live.childParents,
    agents: final.agents.map(a => {
      const was = before.get(a.id)
      return {
        ...a,
        seenAt: was?.seenAt ?? null,
        doneAt: was?.doneAt ?? null,
        startLine: was?.startLine ?? null,
        doneLine: was?.doneLine ?? null,
      }
    }),
  })
}

/** A run kept by an earlier version of the mod, with the fields it lacks filled in. */
export function normalizeRun(r: Run): Run {
  const partial = r as Partial<Run> & Pick<Run, 'id'>
  return {
    ...r,
    childParents: partial.childParents ?? {},
    hasFolder: partial.hasFolder ?? false,
    journalAt: partial.journalAt ?? null,
    agents: r.agents.map(a => ({
      ...a,
      doneAt: a.doneAt ?? null,
      startLine: a.startLine ?? null,
      doneLine: a.doneLine ?? null,
    })),
  }
}

export function historyRowOf(value: unknown, path: string, mtimeMs: number, homeSlug: string | null): HistoryRow | null {
  const run = parseFinal(value)
  if (!run) return null
  const d = asRecord(value)
  const parts = path.split('/')
  return {
    path,
    runId: run.id,
    name: run.name,
    status: run.status,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    agents: num(d?.agentCount) ?? run.agents.length,
    tokens: num(d?.totalTokens),
    project: projectName(parts.at(-4) ?? '', homeSlug),
    mtimeMs,
  }
}

/** A project folder's name relative to home: `-Users-someone-shop-api` -> `shop-api`, home itself `~`. */
export function projectName(slug: string, homeSlug: string | null): string {
  if (homeSlug && slug === homeSlug) return '~'
  if (homeSlug && slug.startsWith(`${homeSlug}-`)) return slug.slice(homeSlug.length + 1) || '~'
  return slug.replace(/^-/, '')
}

/** The folder name Claude Code keeps a project's sessions under. */
export const slugOf = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')

/** The session folder beside a transcript: `<...>/<session>.jsonl` -> `<...>/<session>`. */
export const sessionDirOf = (transcriptPath: string) => transcriptPath.replace(/\.jsonl$/, '')

/** A run's transcript folder -> its session folder (`<session>/subagents/workflows/<runId>`). */
export const sessionDirOfTranscripts = (dir: string) => dir.replace(/\/subagents\/workflows\/[^/]+\/?$/, '')

// ---------------------------------------------------------------- shaping the tree

const CHILD = /^▸\s*/

type Top = { title: string; detail: string; agents: RunAgent[] }

/** Whether `a` was still running when `child` started: by journal lines, else by times, else by `a`'s status now. */
function wasRunningAt(a: RunAgent, child: RunAgent): boolean {
  if (a.startLine !== null && child.startLine !== null) return a.doneLine === null || a.doneLine > child.startLine
  const at = child.startedAt ?? child.seenAt
  const end = a.startedAt !== null && a.durationMs !== null ? a.startedAt + a.durationMs : a.doneAt
  if (at !== null && end !== null) return end > at
  return a.status === 'running'
}

/**
 * The parent phase of the child workflow whose first agent is `first`: the phase
 * naming it, else the one at work when `first` began. `tops` holds earlier agents only.
 */
function parentOf(child: string, first: RunAgent, tops: readonly Top[]): Top | null {
  const base = child.replace(/\s*#\d+$/, '').replace(/^.*:/, '').trim().toLowerCase()
  const named = base ? tops.find(t => `${t.title} ${t.detail}`.toLowerCase().includes(base)) : undefined
  if (named) return named
  const last = tops.filter(t => t.agents.length > 0).at(-1)
  if (!last) return tops[0] ?? null
  const next = tops[tops.indexOf(last) + 1]
  return next && !last.agents.some(a => wasRunningAt(a, first)) ? next : last
}

/** Places each child workflow not placed yet under its parent phase (null: the run itself), as of its start. */
export function withParents(run: Run): Run {
  const tops: Top[] = run.phases.map(p => ({ title: p.title, detail: p.detail, agents: [] }))
  const parents: Record<string, string | null> = { ...run.childParents }
  let isChanged = false
  for (const a of [...run.agents].sort((x, y) => x.seq - y.seq)) {
    const phase = a.phase?.trim()
    if (!phase) continue
    if (CHILD.test(phase)) {
      if (phase in parents) continue
      parents[phase] = parentOf(phase.replace(CHILD, ''), a, tops)?.title ?? null
      isChanged = true
      continue
    }
    let top = tops.find(t => t.title === phase)
    if (!top) {
      top = { title: phase, detail: '', agents: [] }
      tops.push(top)
    }
    top.agents.push(a)
  }
  return isChanged ? { ...run, childParents: parents } : run
}

export function skyAgentOf(a: RunAgent, s: AgentStats | undefined): SkyAgent {
  const firstSeen = [s?.firstAt, a.seenAt].filter((t): t is number => typeof t === 'number')
  const startedAt = a.startedAt ?? (firstSeen.length > 0 ? Math.min(...firstSeen) : null)
  const failedByLoop = s?.endReason === 'error' || s?.endReason === 'aborted'
  const status = failedByLoop && a.status === 'running' ? 'failed' : a.status
  // A finished agent with no recorded end shows no duration rather than a growing one.
  const endedAt =
    a.startedAt !== null && a.durationMs !== null
      ? a.startedAt + a.durationMs
      : status === 'running'
        ? null
        : (s?.endedAt ?? a.doneAt ?? null)
  const model = s?.model ?? a.model
  return {
    id: a.id,
    label: a.label,
    status,
    model: model ? shortModel(model) : null,
    effort: s?.effort ?? null,
    tokens: a.tokens ?? (s ? s.tokens : null),
    costUsd: s?.costUsd ?? null,
    tools: s ? Math.max(s.tools, a.tools ?? 0) : a.tools,
    lastTool: s?.lastTool ?? a.lastTool,
    startedAt,
    endedAt,
    error: a.error ?? (failedByLoop ? (s?.endReason ?? null) : null),
    // A watch needs a tracker: an agent the mod never saw answer cannot be told stuck.
    watch: status === 'running' && s?.tracker ? watchOf(s.tracker, s.lastAt) : null,
    cache: skyCacheOf(s?.cache),
  }
}

const zero = (): Counts => ({ done: 0, running: 0, failed: 0 })

function node(key: string, kind: SkyNode['kind'], title: string, detail: string): SkyNode {
  return {
    key,
    kind,
    title,
    detail,
    status: 'pending',
    agents: [],
    hidden: 0,
    children: [],
    counts: zero(),
    costUsd: null,
    startedAt: null,
    endedAt: null,
  }
}

function tally(counts: Counts, a: SkyAgent) {
  counts[a.status] += 1
}

/** Fills a node's totals from its agents and children, and leaves out all but `keepDone` finished agents. */
function settle(n: SkyNode, keepDone: number): SkyNode {
  const children = n.children.map(c => settle(c, keepDone))
  const counts = zero()
  let cost: number | null = null
  let startedAt: number | null = null
  let endedAt: number | null = null
  for (const a of n.agents) {
    tally(counts, a)
    cost = addCost(cost, a.costUsd)
    if (a.startedAt !== null) startedAt = startedAt === null ? a.startedAt : Math.min(startedAt, a.startedAt)
    if (a.endedAt !== null) endedAt = endedAt === null ? a.endedAt : Math.max(endedAt, a.endedAt)
  }
  for (const c of children) {
    counts.done += c.counts.done
    counts.running += c.counts.running
    counts.failed += c.counts.failed
    cost = addCost(cost, c.costUsd)
    if (c.startedAt !== null) startedAt = startedAt === null ? c.startedAt : Math.min(startedAt, c.startedAt)
    if (c.endedAt !== null) endedAt = endedAt === null ? c.endedAt : Math.max(endedAt, c.endedAt)
  }
  const total = counts.done + counts.running + counts.failed
  const status: SkyStatus =
    counts.running > 0 ? 'running' : total === 0 ? 'pending' : counts.done === 0 ? 'failed' : 'done'
  const { agents, hidden } = trim(n.agents, keepDone)
  return {
    ...n,
    children,
    agents,
    hidden,
    counts,
    status,
    costUsd: cost,
    startedAt,
    endedAt: status === 'running' ? null : endedAt,
  }
}

/** Keeps every running or failed agent and the newest `keepDone` finished ones. */
function trim(agents: readonly SkyAgent[], keepDone: number): { agents: SkyAgent[]; hidden: number } {
  const done = agents.filter(a => a.status === 'done')
  const kept = new Set(done.slice(Math.max(0, done.length - keepDone)))
  const out = agents.filter(a => a.status !== 'done' || kept.has(a))
  return { agents: out, hidden: agents.length - out.length }
}

/** A run as the sky draws it: declared phases, child workflows nested under them, agents as leaves. */
export function skyRun(
  run: Run,
  stats: Readonly<Record<string, AgentStats>>,
  keepDone: number,
): SkyRun {
  const ordered = [...run.agents].sort((a, b) => a.seq - b.seq)
  const parents = withParents(run).childParents
  const tops: SkyNode[] = run.phases.map(p => node(`${run.id}/${p.title}`, 'phase', p.title, p.detail))
  const rootChildren: SkyNode[] = []
  const children = new Map<string, SkyNode>()
  const loose: SkyAgent[] = []
  let tools = 0
  for (const a of ordered) {
    const sa = skyAgentOf(a, stats[a.id])
    tools += sa.tools ?? 0
    const phase = a.phase?.trim()
    if (!phase) {
      loose.push(sa)
    } else if (CHILD.test(phase)) {
      let child = children.get(phase)
      if (!child) {
        child = node(`${run.id}/${phase}`, 'child', phase.replace(CHILD, ''), '')
        children.set(phase, child)
        const parentTitle = parents[phase] ?? null
        const parent = parentTitle === null ? undefined : tops.find(t => t.title === parentTitle)
        ;(parent ? parent.children : rootChildren).push(child)
      }
      child.agents.push(sa)
    } else {
      let top = tops.find(t => t.title === phase)
      if (!top) {
        top = node(`${run.id}/${phase}`, 'phase', phase, '')
        tops.push(top)
      }
      top.agents.push(sa)
    }
  }
  const nodes = [...tops, ...rootChildren].map(n => settle(n, keepDone))
  const counts = zero()
  let cost: number | null = null
  for (const n of nodes) {
    counts.done += n.counts.done
    counts.running += n.counts.running
    counts.failed += n.counts.failed
    cost = addCost(cost, n.costUsd)
  }
  for (const a of loose) {
    tally(counts, a)
    cost = addCost(cost, a.costUsd)
  }
  const trimmed = trim(loose, keepDone)
  const firstStart = ordered.map(a => a.startedAt ?? a.seenAt).find((t): t is number => t !== null) ?? null
  const startedAt = run.startedAt ?? firstStart
  return {
    key: run.id,
    name: run.name,
    description: run.description,
    status: run.status,
    startedAt,
    endedAt: run.durationMs !== null && startedAt !== null ? startedAt + run.durationMs : null,
    nodes,
    loose: trimmed.agents,
    looseHidden: trimmed.hidden,
    counts,
    costUsd: cost,
    tools,
  }
}

/** This session's plain subagents as one group, the newest last. */
export function skySubagents(subs: readonly SubAgent[], stats: Readonly<Record<string, AgentStats>>, keepDone = 6): SkyRun {
  const agents = [...subs]
    .sort((a, b) => a.seenAt - b.seenAt)
    .map((s, i) => {
      const status: RunAgent['status'] =
        s.status === 'failed' || s.status === 'killed'
          ? 'failed'
          : s.status === 'completed' || s.status === 'idle'
            ? 'done'
            : 'running'
      const label = s.description ? `${s.type} · ${s.description}` : s.type
      return skyAgentOf({ ...blankAgent(s.id, i), label, status, seenAt: s.seenAt }, stats[s.id])
    })
  const counts = zero()
  let cost: number | null = null
  let tools = 0
  for (const a of agents) {
    tally(counts, a)
    cost = addCost(cost, a.costUsd)
    tools += a.tools ?? 0
  }
  const trimmed = trim(agents, keepDone)
  return {
    key: 'subagents',
    name: 'subagents',
    description: '',
    status: counts.running > 0 ? 'running' : 'completed',
    startedAt: null,
    endedAt: null,
    nodes: [],
    loose: trimmed.agents,
    looseHidden: trimmed.hidden,
    counts,
    costUsd: cost,
    tools,
  }
}

/**
 * Strips what the tree does not draw: only the first `keep` running agents keep their
 * watch and tinting cache, so a large fan-out stays under a Client's 100,000-character props.
 */
function leaner(keep: number) {
  let left = keep
  const agent = (a: SkyAgent): SkyAgent => {
    const { watch, cache, ...rest } = a
    if (a.status !== 'running' || left <= 0) return rest
    left -= 1
    return { ...rest, ...(watch ? { watch } : {}), ...(cache && shiftLevel(cache.shift) !== 0 ? { cache } : {}) }
  }
  const node = (n: SkyNode): SkyNode => ({ ...n, agents: n.agents.map(agent), children: n.children.map(node) })
  return { agent, node }
}

/** The runs as the tree's props carry them (see leaner). Pass the subagents group last, as the tree draws it. */
export function leanRuns(runs: readonly SkyRun[], keep = Number.POSITIVE_INFINITY): SkyRun[] {
  const l = leaner(keep)
  return runs.map(r => ({ ...r, nodes: r.nodes.map(l.node), loose: r.loose.map(l.agent) }))
}

/** One node as the node inspector's agent list carries it (see leaner). */
export const leanNode = (n: SkyNode, keep = Number.POSITIVE_INFINITY): SkyNode => leaner(keep).node(n)

// ---------------------------------------------------------------- the inspector

/** Where a node sits in a drawn run: the node itself and the titles of the phases above it. */
export type Found = { node: SkyNode | null; agent: SkyAgent | null; path: string[] }

/** Finds a node (by key) or an agent (by id) anywhere in a drawn run. */
export function findIn(run: SkyRun, kind: 'agent' | 'node', key: string): Found | null {
  const walk = (nodes: readonly SkyNode[], path: string[]): Found | null => {
    for (const n of nodes) {
      const here = [...path, n.title]
      if (kind === 'node' && n.key === key) return { node: n, agent: null, path }
      const agent = kind === 'agent' ? n.agents.find(a => a.id === key) : undefined
      if (agent) return { node: n, agent, path: here }
      const deeper = walk(n.children, here)
      if (deeper) return deeper
    }
    return null
  }
  const loose = kind === 'agent' ? run.loose.find(a => a.id === key) : undefined
  return loose ? { node: null, agent: loose, path: [] } : walk(run.nodes, [])
}

/** A tool call's input in a few words: a command, a file, a pattern, a URL. */
export function summarizeInput(tool: string, input: unknown): string {
  const r = asRecord(input) ?? {}
  const pick = (...keys: string[]) => keys.map(k => r[k]).find((v): v is string => typeof v === 'string' && v !== '')
  const file = (p: string) => p.split('/').slice(-2).join('/')
  const byTool: Record<string, () => string | undefined> = {
    Bash: () => pick('command'),
    Read: () => pick('file_path') && file(pick('file_path') as string),
    Write: () => pick('file_path') && file(pick('file_path') as string),
    Edit: () => pick('file_path') && file(pick('file_path') as string),
    NotebookEdit: () => pick('notebook_path') && file(pick('notebook_path') as string),
    Grep: () => pick('pattern'),
    Glob: () => pick('pattern'),
    WebFetch: () => pick('url'),
    WebSearch: () => pick('query'),
    Agent: () => pick('description'),
    Skill: () => pick('skill'),
    AskUserQuestion: () => {
      const q = Array.isArray(r.questions) ? asRecord(r.questions[0])?.question : undefined
      return typeof q === 'string' ? q : undefined
    },
  }
  const text = byTool[tool]?.() ?? Object.values(r).find((v): v is string => typeof v === 'string') ?? ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** What decided a permission check, in a few words. */
export function decidedBy(v: { decision: string; rule?: string; hook?: string; setting?: string; reason?: string }): string {
  if (v.rule) return `rule ${v.rule}`
  if (v.hook) return `hook ${v.hook}`
  if (v.setting) return `setting ${v.setting}`
  return (v.reason ?? '').replace(/\s+/g, ' ').slice(0, 80)
}

/** Keeps an agent's last checks, every ask and deny among them before any allow. */
export function keepChecks(list: readonly CheckEvent[], max = 24): CheckEvent[] {
  if (list.length <= max) return [...list]
  const notable = list.filter(c => c.decision !== 'allow').slice(-max)
  const room = max - notable.length
  const allows = room > 0 ? list.filter(c => c.decision === 'allow').slice(-room) : []
  return [...notable, ...allows].sort((a, b) => a.at - b.at)
}

const DENIAL = /permission|denied|doesn't want to proceed|not allowed/i

/** The text of a tool result's content, whichever shape it came in. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => str(asRecord(b)?.text) ?? '').join('\n')
}

const firstLine = (text: string) => (text.split('\n').find(l => l.trim()) ?? '').trim().slice(0, 120)

/** An agent's transcript (`agent-<id>.jsonl`) as the inspector shows it. */
export function traceOf(text: string): Trace {
  let prompt = ''
  let answer = ''
  const tools = new Map<string, TraceTool>()
  for (const line of text.split('\n')) {
    const row = parseLine(line)
    const message = row ? asRecord(row.message) : null
    if (!row || !message) continue
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    const when = Number.isNaN(at) ? null : at
    const content = message.content
    const blocks = Array.isArray(content) ? content.map(asRecord).filter((b): b is Record<string, unknown> => b !== null) : []
    if (row.type === 'user') {
      if (!prompt) prompt = typeof content === 'string' ? content : blocks.filter(b => b.type === 'text').map(b => str(b.text) ?? '').join('\n')
      for (const b of blocks) {
        const tool = b.type === 'tool_result' ? tools.get(str(b.tool_use_id) ?? '') : undefined
        if (!tool) continue
        const out = resultText(b.content)
        const isError = b.is_error === true
        tools.set(tool.id, {
          ...tool,
          endedAt: when,
          status: isError ? (DENIAL.test(out) ? 'denied' : 'error') : 'ok',
          note: isError ? firstLine(out) : '',
        })
      }
    } else if (row.type === 'assistant') {
      for (const b of blocks) {
        const id = str(b.id)
        if (b.type === 'tool_use' && id) {
          const name = str(b.name) ?? 'tool'
          tools.set(id, { id, name, summary: summarizeInput(name, b.input), startedAt: when, endedAt: null, status: 'running', note: '' })
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          answer = b.text
        }
      }
    }
  }
  const all = [...tools.values()]
  return { prompt: prompt.trim().slice(0, 2000), answer: answer.trim().slice(0, 2000), tools: all.slice(-40), toolCount: all.length }
}

// ---------------------------------------------------------------- formatting

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function fmtUsd(n: number): string {
  if (n < 0.01) return '<$0.01'
  if (n >= 100) return `$${Math.round(n)}`
  return `$${n.toFixed(2)}`
}

/** `claude-fable-5-1` -> `fable 5.1`; anything else as given, its prefix cut. */
export function shortModel(model: string): string {
  const m = /^([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:$|-)/.exec(modelKey(model))
  if (!m) return modelKey(model)
  return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

export const shortEffort = (effort: string) => (effort === 'medium' ? 'med' : effort)

// ---------------------------------------------------------------- small readers

type Row = Record<string, unknown>

export function parseLine(line: string): Row | null {
  if (!line.trim()) return null
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return null
  }
}

export function asRecord(value: unknown): Row | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : null
}

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}
