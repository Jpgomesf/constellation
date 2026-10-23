// Constellation: a live ASCII map of this session's Workflow runs and subagents.
// Runs are read from disk, not by wrapping the Workflow or Agent tool: a hook a
// spawn is nested in stops hearing that agent's steps. Stats come from `turn.step`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, Timer } from 'claude-code'

import type { AgentStats, CheckEvent, Dismissed, Failure, Gauge, HistoryRow, Prefs, Run, SubAgent, Target, View, ViewMode } from '../types'
import {
  applySteps,
  asRecord,
  decidedBy,
  findIn,
  historyRowOf,
  keepChecks,
  leanNode,
  leanRuns,
  loopKey,
  mergeFinal,
  normalizeRun,
  parseFinal,
  parseJournal,
  parseLaunch,
  parseMeta,
  pruneStats,
  sessionDirOf,
  sessionDirOfTranscripts,
  shortEffort,
  skyRun,
  skySubagents,
  slugOf,
  summarizeInput,
  traceOf,
  transcriptStats,
  withParents,
} from './core'
import type { Begin, DetailLevel, End, Heard, Hold, Launch, Meta, SkyAgent, SkyInspect, SkyNode, SkyProps, SkyRun, Step } from './core'
import { DEMO_END_MS, DEMO_MS, demoAt } from './demo'
import { DETAIL_LEVELS, DETAIL_NAMES, DETAIL_NOTES, drawSky, isDetailLevel, nextDetail } from './draw'
import { applyTouches, binariesOf, editedPath } from './events/binary'
import type { Touched } from './events/binary'
import { HEARD_MS } from './events/retrograde'
import { ECLIPSE_HELD, NO_ECLIPSE, eclipseStep, waitingOf } from './events/eclipse'
import type { EclipseSignal, EclipseState } from './events/eclipse'
import { addFailures, demoFailures, settledMeteors, showerProps, toolErrorsOf } from './events/meteor'
import { SKY_NAMES, SKY_STYLES } from './skies'
import type { SkyStyle } from './skies'
import type { SkyElements, SkyUi } from './draw'

const PANE = 'constellation'
const TITLE = '✦ constellation'
const PANE_COLUMNS = 60
const POLL_MS = 1000
/** `$.fs.read` refuses a file over 4 MiB. */
const MAX_READ = 4 * 1024 * 1024
const KEEP_DONE = 60
const MAX_STATS = 600
const MAX_SUBAGENTS = 16
const MAX_BUFFER = 5000
const HISTORY_ROWS = 40
const PROPS_BUDGET = 90_000
/** Running agents that keep their cache once the props exceed PROPS_BUDGET: about what a pane shows. */
const EXTRAS_KEPT = 40
/** A reported launch whose transcript folder never appears is dropped after this. */
const NOTED_EXPIRY_MS = 60_000
/** A run with no final record whose journal has not changed for this long is taken as killed. */
const STALE_JOURNAL_MS = 6 * 60 * 60 * 1000
/** How many runs' figures `$.store` keeps for the history view: the store holds 4 MiB in all. */
const KEPT_KEYS = 60

const sessionDir = atom({ plugin: 'constellation', key: 'sessionDir' } as const, null)
const runs = atom({ plugin: 'constellation', key: 'runs' } as const, [])
const stats = atom({ plugin: 'constellation', key: 'stats' } as const, {})
const subagents = atom({ plugin: 'constellation', key: 'subagents' } as const, [])
const view = atom({ plugin: 'constellation', key: 'view' } as const, { mode: 'live', pastPath: null, target: null })
const history = atom({ plugin: 'constellation', key: 'history' } as const, { rows: [], isLoading: false })
const past = atom({ plugin: 'constellation', key: 'past' } as const, null)
const checks = atom({ plugin: 'constellation', key: 'checks' } as const, {})
const trace = atom({ plugin: 'constellation', key: 'trace' } as const, null)
const prefs = atom({ plugin: 'constellation', key: 'prefs' } as const, { sky: 'stars', caption: null, detail: 'naked-eye' })
const gauge = atom({ plugin: 'constellation', key: 'gauge' } as const, null)
const starDemo = atom({ plugin: 'constellation', key: 'starDemo' } as const, null)
const dismissed = atom({ plugin: 'constellation', key: 'dismissed' } as const, { runs: [], agents: [] })
const failures = atom({ plugin: 'constellation', key: 'failures' } as const, [])
const waiting = atom({ plugin: 'constellation', key: 'waiting' } as const, null)
const waitingDemo = atom({ plugin: 'constellation', key: 'waitingDemo' } as const, null)

type Config = { autoOpen: boolean }

// Buffered here and flushed to state once a second, not once per model request.
let steps: Step[] = []
let ends: End[] = []
let checked: { id: string; event: CheckEvent }[] = []
// Retrograde stamps: request sent, response streaming, loop held by a person.
let begun: Begin[] = []
let heardIds = new Set<string>()
let holds: Hold[] = []
// Binary star: agents' file writes allowed to run.
let touched: Touched[] = []
// Meteors: agents' calls that failed or were denied.
let failed: Failure[] = []
/** The eclipse: asks put to the person, and the checks that may yet become one. */
let eclipse: EclipseState = NO_ECLIPSE
/** When the poll in flight began; a poll stuck past POLL_STUCK_MS no longer holds the next ones back. */
let pollingSince: number | null = null
const POLL_STUCK_MS = 20_000
/** The scripted run `/constellation demo` is playing; a tour walks every sky style over it. */
let demo: { id: string; startedAt: number; timer: Timer; isTour: boolean; restore: SkyStyle | null; failedTo: number; wroteEnd: boolean } | null = null

/** The styles a tour shows, in order. */
const TOUR: readonly SkyStyle[] = ['shooting', 'map', 'parallax', 'spark']

const isSkyStyle = (v: string): v is SkyStyle => (SKY_STYLES as readonly string[]).includes(v)

async function setSky($: EngineInterface, sky: SkyStyle, caption: string | null) {
  const was = await read($, prefs)
  if (was.sky !== sky || was.caption !== caption) await update($, prefs, (p): Prefs => ({ ...p, sky, caption }))
}

/** The tree's detail level; prefs saved before levels existed read as naked eye. */
const detailOf = (p: Prefs): DetailLevel => (isDetailLevel(p.detail) ? p.detail : 'naked-eye')

/** Draws the tree at `level` from now on, in this session and the next ones. */
async function setDetail($: EngineInterface, level: DetailLevel) {
  if (detailOf(await read($, prefs)) !== level) await update($, prefs, (p): Prefs => ({ ...p, detail: level }))
  await $.store.set('detail', level).catch(() => undefined)
}

// ---------------------------------------------------------------- disk

async function configDir($: EngineInterface): Promise<string | null> {
  const explicit = await $.env.get('CLAUDE_CONFIG_DIR')
  if (explicit) return explicit
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude` : null
}

async function list($: EngineInterface, dir: string): Promise<FsEntry[]> {
  return $.fs.list(dir).catch(() => [])
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  const stat = await $.fs.stat(path).catch(() => null)
  if (!stat || stat.kind !== 'file' || stat.size >= MAX_READ) return null
  return $.fs.read(path).catch(() => null)
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  const text = await readText($, path)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function readMeta($: EngineInterface, scriptPath: string): Promise<Meta | null> {
  const text = await readText($, scriptPath)
  return text === null ? null : parseMeta(text)
}

/** A run launched with an inline script has it persisted as `workflows/scripts/<name>-<runId>.js`. */
async function findScript($: EngineInterface, dir: string, runId: string): Promise<FsEntry & { path: string } | null> {
  const scripts = `${dir}/workflows/scripts`
  const hit = (await list($, scripts)).find(e => e.kind === 'file' && e.name.endsWith(`-${runId}.js`))
  return hit ? { ...hit, path: `${scripts}/${hit.name}` } : null
}

/** Keeps a run's figures for the history view (newest KEPT_KEYS); a full store costs only those figures. */
async function remember($: EngineInterface, kind: 'stats' | 'cost', runId: string, value: Record<string, AgentStats>) {
  try {
    const raw = await $.store.get('kept')
    const kept = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
    const key = `${kind}:${runId}`
    const next = [...kept.filter(k => k !== key), key]
    for (const old of next.slice(0, Math.max(0, next.length - KEPT_KEYS))) await $.store.delete(old)
    await $.store.set(key, value)
    await $.store.set('kept', next.slice(-KEPT_KEYS))
  } catch {
    // Nothing else depends on it.
  }
}

// ---------------------------------------------------------------- runs

function newRun(id: string, now: number, scriptPath: string | null, meta: Meta | null, summary: string | null): Run {
  return {
    id,
    name: meta?.name ?? id,
    description: meta?.description || summary || '',
    phases: meta?.phases ?? [],
    status: 'running',
    startedAt: now,
    durationMs: null,
    agents: [],
    childParents: {},
    scriptPath,
    hasMeta: meta !== null,
    hasFolder: false,
    isFinal: false,
    journalBytes: 0,
    journalAt: null,
  }
}

function withMeta(run: Run, meta: Meta): Run {
  return {
    ...run,
    name: meta.name ?? run.name,
    description: meta.description || run.description,
    phases: meta.phases.length > 0 ? meta.phases : run.phases,
    hasMeta: true,
  }
}

async function readRuns($: EngineInterface): Promise<Run[]> {
  return (await read($, runs)).map(normalizeRun)
}

/** Puts `fresh` runs into `list` by id; what a fresher copy lacks (its script, its meta) the listed one keeps. */
function upsert(list: readonly Run[], fresh: readonly Run[]): Run[] {
  const out = list.map(normalizeRun)
  for (const r of fresh) {
    const i = out.findIndex(x => x.id === r.id)
    const was = i >= 0 ? out[i] : undefined
    if (!was) {
      out.push(r)
      continue
    }
    const kept = !r.hasMeta && was.hasMeta ? { ...r, name: was.name, description: was.description, phases: was.phases, hasMeta: true } : r
    out[i] = { ...kept, scriptPath: kept.scriptPath ?? was.scriptPath }
  }
  return out
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
}

/** Opens the pane from background work without waiting on it: an unasked open may wait for room. */
function openUnasked($: EngineInterface) {
  void openPane($).catch(() => undefined)
}

async function setSessionDir($: EngineInterface, dir: string | null) {
  if ((await read($, sessionDir)) !== dir) await update($, sessionDir, () => dir)
}

/** Notes a run the Workflow tool just launched, with its script's meta; a resumed run goes live again. */
async function noteLaunch($: EngineInterface, cfg: Config, launch: Launch) {
  if (launch.transcriptDir) await setSessionDir($, sessionDirOfTranscripts(launch.transcriptDir))
  const meta = launch.scriptPath ? await readMeta($, launch.scriptPath) : null
  const now = await $.clock.now()
  const isNew = !(await readRuns($)).some(r => r.id === launch.runId)
  await update($, dismissed, d => (d.runs.includes(launch.runId) ? { ...d, runs: d.runs.filter(id => id !== launch.runId) } : d))
  await update($, runs, list => {
    const was = list.map(normalizeRun).find(r => r.id === launch.runId)
    return upsert(list, [was ? relaunched(was, launch, meta) : newRun(launch.runId, now, launch.scriptPath, meta, launch.summary)])
  })
  if (isNew && cfg.autoOpen) openUnasked($)
}

/** A run the Workflow tool reported again: named if it was not, live again if it had ended (a resume keeps the id). */
function relaunched(was: Run, launch: Launch, meta: Meta | null): Run {
  const named = meta && !was.hasMeta ? withMeta(was, meta) : was
  const live = was.isFinal ? { ...named, status: 'running' as const, isFinal: false, durationMs: null, journalBytes: 0 } : named
  return { ...live, scriptPath: launch.scriptPath ?? live.scriptPath }
}

/** Brings one run up to date from disk: its meta, its journal, and its final record once written. */
async function refreshRun($: EngineInterface, dir: string, id: string, was: Run | null, now: number): Promise<Run> {
  let run: Run = { ...(was ?? newRun(id, now, null, null, null)), hasFolder: true }
  if (!run.hasMeta) {
    const found = run.scriptPath ? null : await findScript($, dir, id)
    const path = run.scriptPath ?? found?.path ?? null
    const meta = path ? await readMeta($, path) : null
    if (meta) run = { ...withMeta(run, meta), scriptPath: path }
    if (!was && found && found.mtimeMs > 0) run = { ...run, startedAt: found.mtimeMs }
  }
  const final = parseFinal(await readJson($, `${dir}/workflows/${id}.json`))
  if (final) return mergeFinal(run, final)
  const journal = `${dir}/subagents/workflows/${id}/journal.jsonl`
  const stat = await $.fs.stat(journal).catch(() => null)
  if (stat && stat.size !== run.journalBytes) {
    const text = stat.size < MAX_READ ? await $.fs.read(journal).catch(() => null) : null
    if (text !== null) run = { ...run, agents: parseJournal(text, run.agents, now), journalBytes: stat.size }
    run = { ...run, journalAt: stat.mtimeMs, status: 'running' }
  }
  // A child's parent phase is fixed once the run's own phases are known, so it never moves.
  if (run.phases.length > 0) run = withParents(run)
  const isStale = run.status === 'running' && run.journalAt !== null && now - run.journalAt > STALE_JOURNAL_MS
  return isStale ? { ...run, status: 'killed' } : run
}

/** Keeps what the mod measured of a finished run's agents, for its history view. */
async function keepStats($: EngineInterface, run: Run) {
  const all = await read($, stats)
  const mine: Record<string, AgentStats> = {}
  for (const a of run.agents) {
    const s = all[a.id]
    if (s) {
      // History needs neither tracker nor files; the cache stays for the inspector.
      const { tracker, files, ...kept } = s
      mine[a.id] = kept
    }
  }
  if (Object.keys(mine).length > 0) await remember($, 'stats', run.id, mine)
}

async function scanRuns($: EngineInterface, cfg: Config, dir: string) {
  const gone = new Set((await read($, dismissed)).runs)
  const ids = (await list($, `${dir}/subagents/workflows`))
    .filter(e => e.kind === 'dir' && e.name.startsWith('wf_') && !gone.has(e.name))
    .map(e => e.name)
  const now = await $.clock.now()
  const current = await readRuns($)
  const changed: Run[] = []
  let hasNewLive = false
  for (const id of ids) {
    const was = current.find(r => r.id === id) ?? null
    if (was?.isFinal) continue
    const run = await refreshRun($, dir, id, was, now)
    if (JSON.stringify(run) === JSON.stringify(was)) continue
    changed.push(run)
    if (!was && run.status === 'running') hasNewLive = true
  }
  const onDisk = new Set(ids)
  const expired = new Set(
    current
      .filter(r => !onDisk.has(r.id) && !r.hasFolder && !r.isFinal && now - (r.startedAt ?? 0) > NOTED_EXPIRY_MS)
      .map(r => r.id),
  )
  if (changed.length === 0 && expired.size === 0) return
  // The session folder changed during the scan (a /clear): its findings are stale.
  if ((await read($, sessionDir)) !== dir) return
  await update($, runs, list => upsert(list, changed).filter(r => !expired.has(r.id)))
  for (const run of changed) if (run.isFinal) await keepStats($, run)
  if (hasNewLive && cfg.autoOpen) openUnasked($)
}

// ---------------------------------------------------------------- subagents and stats

const isLoopLive = (status: string) => status === 'running' || status === 'pending' || status === 'waiting'

async function scanSubagents($: EngineInterface) {
  const listed = await $.agent.list().catch(() => null)
  if (listed === null) return
  const gone = new Set((await read($, dismissed)).agents)
  const shown = listed.filter(a => !gone.has(a.id))
  const prev = await read($, subagents)
  if (shown.length === 0 && !prev.some(s => isLoopLive(s.status))) return
  const now = await $.clock.now()
  const byId = new Map(prev.map(s => [s.id, s]))
  const listedIds = new Set(shown.map(a => a.id))
  // The list drops an agent once it has ended; one last seen live has finished.
  for (const s of prev) if (!listedIds.has(s.id) && isLoopLive(s.status)) byId.set(s.id, { ...s, status: 'completed' })
  for (const a of shown) {
    const was = byId.get(a.id)
    byId.set(a.id, { id: a.id, description: a.description, type: a.type, status: a.status, seenAt: was?.seenAt ?? now })
  }
  const next: SubAgent[] = [...byId.values()].sort((a, b) => a.seenAt - b.seenAt).slice(-MAX_SUBAGENTS)
  if (JSON.stringify(next) !== JSON.stringify(prev)) await update($, subagents, () => next)
}

async function flushStats($: EngineInterface) {
  if (steps.length + ends.length + checked.length + begun.length + heardIds.size + holds.length + touched.length + failed.length === 0) return
  const take = { steps, ends, checks: checked, begun, heard: heardIds, holds, touched, failed }
  steps = []
  ends = []
  checked = []
  begun = []
  heardIds = new Set()
  holds = []
  touched = []
  failed = []
  const [rs, subs, now, st] = await Promise.all([readRuns($), read($, subagents), $.clock.now(), read($, stats)])
  const claimed = new Set([...rs.flatMap(r => r.agents.map(a => a.id)), ...subs.map(s => s.id)])
  // heardAt is restamped at most once per HEARD_MS, so streaming alone writes neither per chunk nor every second.
  const heard: Heard[] = [...take.heard]
    .filter(id => {
      const heardAt = st[id]?.tracker?.heardAt
      return heardAt !== undefined && (heardAt === null || now - heardAt >= HEARD_MS)
    })
    .map(id => ({ id, at: now }))
  if (take.steps.length + take.ends.length + take.begun.length + heard.length + take.holds.length + take.touched.length > 0) {
    // Writes after steps, so a loop's first step and the write it asked for can share a flush.
    await update($, stats, s => pruneStats(applyTouches(applySteps(s, take.steps, take.ends, take.begun, heard, take.holds), take.touched, now), claimed, now, MAX_STATS))
  }
  if (take.checks.length > 0) await update($, checks, c => addChecks(c, take.checks, claimed, now))
  if (take.failed.length > 0) await update($, failures, ring => addFailures(ring, take.failed, now))
}

/** Files new permission checks under their agents, keeping those something claims or that checked lately. */
function addChecks(
  all: Readonly<Record<string, CheckEvent[]>>,
  fresh: readonly { id: string; event: CheckEvent }[],
  claimed: ReadonlySet<string>,
  now: number,
): Record<string, CheckEvent[]> {
  const next: Record<string, CheckEvent[]> = { ...all }
  for (const { id, event } of fresh) next[id] = keepChecks([...(next[id] ?? []), event])
  const keep = Object.keys(next).filter(id => claimed.has(id) || now - (next[id]?.at(-1)?.at ?? 0) < 120_000)
  return Object.fromEntries(keep.slice(-MAX_STATS).map(id => [id, next[id] ?? []]))
}

// ---------------------------------------------------------------- the eclipse

const isEclipseOpen = () => eclipse.checks.length > 0 || eclipse.waits.length > 0

/** Folds one observation into the eclipse; tells retrograde who a person now holds; publishes the wait when it changed. */
function raiseEclipse($: EngineInterface, sig: EclipseSignal) {
  const prev = eclipse
  const next = eclipseStep(prev, sig)
  if (next === prev) return
  eclipse = next
  const held = (s: EclipseState) => new Set(s.waits.flatMap(a => (a.agentId ? [a.agentId] : [])))
  const wasHeld = held(prev)
  const isHeld = held(next)
  for (const id of isHeld) if (!wasHeld.has(id) && holds.length < MAX_BUFFER) holds.push({ id, at: sig.at, isOn: true })
  for (const id of wasHeld) if (!isHeld.has(id) && holds.length < MAX_BUFFER) holds.push({ id, at: sig.at, isOn: false })
  void showWaiting($, sig.at).catch(() => undefined)
}

/** Publishes the oldest wait when it changed; the poll also calls it, for expiry and after a reload. */
async function showWaiting($: EngineInterface, now: number) {
  const w = waitingOf(eclipse, now)
  if (JSON.stringify(await read($, waiting)) !== JSON.stringify(w)) await update($, waiting, () => waitingOf(eclipse, now))
}

/** A ToolProgress row is drawn only under a call that runs: whatever it asked of the person was answered. */
async function resultFromProgress($: EngineInterface, id: string) {
  raiseEclipse($, { kind: 'result', at: await $.clock.now(), id })
}

/** An MCP server's form, as its dialog and its answer both name it. */
const elicitId = (e: { elicitation_id?: string; mcp_server_name: string }) => `elicit:${e.elicitation_id ?? e.mcp_server_name}`

/** The call ids a tool-result row answers. */
function toolResultIds(content: unknown): string[] {
  const blocks = Array.isArray(content) ? content : []
  return blocks.map(asRecord).flatMap(b => (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' ? [b.tool_use_id] : []))
}

// ---------------------------------------------------------------- the poll

async function poll($: EngineInterface, cfg: Config) {
  const now = await $.clock.now()
  if (pollingSince !== null && now - pollingSince < POLL_STUCK_MS) return
  const mine = now
  pollingSince = mine
  try {
    await flushStats($)
    await showWaiting($, now)
    const dir = await read($, sessionDir)
    if (dir) await scanRuns($, cfg, dir)
    await scanSubagents($)
    await refreshTrace($)
  } catch {
    // A failed poll is tried again on the next tick.
  } finally {
    if (pollingSince === mine) pollingSince = null
  }
}

// ---------------------------------------------------------------- history

async function loadHistory($: EngineInterface) {
  await update($, history, h => ({ ...h, isLoading: true }))
  try {
    const dir = await read($, sessionDir)
    const config = await configDir($)
    const root = dir ? dir.replace(/\/[^/]+\/[^/]+$/, '') : config ? `${config}/projects` : null
    if (!root) return
    const files: { path: string; mtimeMs: number }[] = []
    for (const project of await list($, root)) {
      if (project.kind !== 'dir') continue
      for (const session of await list($, `${root}/${project.name}`)) {
        if (session.kind !== 'dir') continue
        const wf = `${root}/${project.name}/${session.name}/workflows`
        for (const f of await list($, wf)) {
          if (f.kind === 'file' && /^wf_.+\.json$/.test(f.name)) files.push({ path: `${wf}/${f.name}`, mtimeMs: f.mtimeMs })
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const home = await $.env.get('HOME')
    const homeSlug = home ? slugOf(home) : null
    const cached = (asRecord(await $.store.get('history')) ?? {}) as Record<string, HistoryRow>
    const rows: HistoryRow[] = []
    for (const f of files.slice(0, HISTORY_ROWS)) {
      const hit = cached[f.path]
      const row = hit && hit.mtimeMs === f.mtimeMs ? hit : historyRowOf(await readJson($, f.path), f.path, f.mtimeMs, homeSlug)
      if (row) rows.push(row)
    }
    await update($, history, () => ({ rows, isLoading: false }))
    await $.store.set('history', Object.fromEntries(rows.map(r => [r.path, r]))).catch(() => undefined)
  } finally {
    await update($, history, h => (h.isLoading ? { ...h, isLoading: false } : h))
  }
}

/** Opens a finished run from disk; its agents' costs come from their transcripts, once. */
async function loadPast($: EngineInterface, path: string) {
  try {
    const run = parseFinal(await readJson($, path))
    if (!run) {
      await update($, past, p => (p?.path === path ? { ...p, error: 'could not read that run' } : p))
      return
    }
    const placed = withParents(run)
    const seen = asRecord(await $.store.get(`stats:${run.id}`)) as Record<string, AgentStats> | null
    const costed = asRecord(await $.store.get(`cost:${run.id}`)) as Record<string, AgentStats> | null
    const known = { ...(costed ?? {}), ...(seen ?? {}) }
    const isCosting = !seen && !costed
    await update($, past, p => (p?.path === path ? { ...p, run: placed, stats: known, isCosting } : p))
    if (!isCosting) return
    const transcripts = path.replace(/\/workflows\/[^/]+\.json$/, `/subagents/workflows/${run.id}`)
    const got: Record<string, AgentStats> = {}
    for (const [i, a] of run.agents.entries()) {
      const text = await readText($, `${transcripts}/agent-${a.id}.jsonl`)
      const s = text === null ? null : transcriptStats(text)
      if (s) got[a.id] = s
      if (i % 10 === 9) {
        if ((await read($, view)).pastPath !== path) return
        const partial = { ...got }
        await update($, past, p => (p?.path === path ? { ...p, stats: partial } : p))
      }
    }
    await update($, past, p => (p?.path === path ? { ...p, stats: got, isCosting: false } : p))
    await remember($, 'cost', run.id, got)
  } finally {
    await update($, past, p => (p?.path === path && p.isCosting ? { ...p, isCosting: false } : p))
  }
}

// ---------------------------------------------------------------- clearing and the gauge

const KEPT_DISMISSED = 500

/** Clears finished runs and ended subagents from the live view (just `runKey`'s when given); returns how many went. */
async function clearFinished($: EngineInterface, runKey?: string): Promise<{ runs: number; agents: number }> {
  const [rs, subs] = await Promise.all([readRuns($), read($, subagents)])
  const runIds = runKey === 'subagents' ? [] : rs.filter(r => r.status !== 'running' && (!runKey || r.id === runKey)).map(r => r.id)
  const agentIds = !runKey || runKey === 'subagents' ? subs.filter(s => !isLoopLive(s.status)).map(s => s.id) : []
  if (runIds.length === 0 && agentIds.length === 0) return { runs: 0, agents: 0 }
  await update($, dismissed, (d): Dismissed => ({
    runs: [...d.runs, ...runIds].slice(-KEPT_DISMISSED),
    agents: [...d.agents, ...agentIds].slice(-KEPT_DISMISSED),
  }))
  await update($, runs, list => list.filter(r => !runIds.includes(r.id)))
  await update($, subagents, list => list.filter(s => !agentIds.includes(s.id)))
  return { runs: runIds.length, agents: agentIds.length }
}

/** Keeps the gauge's figures, writing only when what it shows would change. */
async function measure($: EngineInterface, context: { tokens?: number; window: number; percent?: number }, costUsd: number | null) {
  const was = await read($, gauge)
  const next: Gauge = {
    tokens: context.tokens ?? was?.tokens ?? null,
    window: context.window,
    percent: context.percent ?? was?.percent ?? null,
    costUsd: costUsd ?? was?.costUsd ?? null,
    compactions: was?.compactions ?? 0,
    isReborn: context.percent === undefined ? (was?.isReborn ?? false) : false,
  }
  const shows = (g: Gauge | null) => (g ? `${Math.round(g.percent ?? -1)}|${Math.round((g.tokens ?? 0) / 1000)}|${g.window}|${(g.costUsd ?? 0).toFixed(2)}|${g.isReborn}` : '')
  if (shows(next) !== shows(was)) await update($, gauge, () => next)
}

// ---------------------------------------------------------------- the demo

/** The star demo's sped-up life: it dies at STAR_DEATH_MS and is reborn. */
const STAR_LIFE_MS = 40_000
const STAR_DEATH_MS = 28_000
let starTimer: Timer | null = null

async function startStarDemo($: EngineInterface) {
  starTimer?.cancel()
  const startedAt = await $.clock.now()
  const deaths = (await read($, gauge))?.compactions ?? 0
  const step = async () => {
    const e = (await $.clock.now()) - startedAt
    if (e >= STAR_LIFE_MS) {
      starTimer?.cancel()
      starTimer = null
      await update($, starDemo, () => null)
      return
    }
    const isDead = e >= STAR_DEATH_MS
    const share = isDead ? 4 + ((e - STAR_DEATH_MS) / (STAR_LIFE_MS - STAR_DEATH_MS)) * 6 : 2 + 97 * (e / STAR_DEATH_MS) ** 1.6
    const window = 1_000_000
    await update($, starDemo, (): Gauge => ({ tokens: Math.round((share / 100) * window), window, percent: share, costUsd: null, compactions: deaths + (isDead ? 1 : 0), isReborn: false }))
  }
  starTimer = $.clock.every(250, () => void step().catch(() => undefined))
  await update($, view, (w): View => ({ ...viewOf(w), mode: 'live', target: null }))
  await step()
}

/** Starts the scripted run (no agents, no tokens) in `style`, or every style for `tour`; the prior style returns after. */
async function startDemo($: EngineInterface, style: string | undefined) {
  demo?.timer.cancel()
  const startedAt = await $.clock.now()
  const id = `demo-${startedAt}`
  const before = (await read($, prefs)).sky
  await update($, runs, list => list.filter(r => !r.id.startsWith('demo-')))
  await update($, failures, ring => ring.filter(f => !f.id.startsWith('demo-fail-')))
  await update($, waitingDemo, () => null)
  await update($, view, (w): View => ({ ...viewOf(w), mode: 'live', target: null }))
  if (style && isSkyStyle(style)) await setSky($, style, SKY_NAMES[style])
  const isTour = style === 'tour'
  const restore = isTour || (style !== undefined && isSkyStyle(style)) ? (isSkyStyle(before) ? before : 'stars') : null
  demo = { id, startedAt, timer: $.clock.every(250, () => void stepDemo($).catch(() => undefined)), isTour, restore, failedTo: 0, wroteEnd: false }
  await stepDemo($)
}

async function stepDemo($: EngineInterface) {
  if (!demo) return
  const now = await $.clock.now()
  const elapsed = now - demo.startedAt
  const { run, stats: s, checks: c, waiting: asked } = demoAt(demo.id, demo.startedAt, elapsed)
  // Taken before any await, so a tick in flight never moves a newer demo's mark.
  const fresh = demoFailures(demo.startedAt, demo.failedTo, elapsed)
  demo.failedTo = Math.max(demo.failedTo, elapsed)
  if (demo.isTour) {
    const k = Math.min(TOUR.length - 1, Math.floor((elapsed / DEMO_MS) * TOUR.length))
    const style = TOUR[k] ?? 'stars'
    await setSky($, style, `${k + 1}/${TOUR.length} · ${SKY_NAMES[style]}`)
  }
  // The completed run is written once, so `clear` or its `✕` hides it for good.
  if (!demo.wroteEnd) {
    if (run.status === 'completed') demo.wroteEnd = true
    await update($, runs, list => upsert(list, [run]))
    await update($, stats, all => ({ ...all, ...s }))
    await update($, checks, all => ({ ...all, ...c }))
  }
  if (fresh.length > 0) await update($, failures, ring => addFailures(ring, fresh, now))
  if (JSON.stringify(await read($, waitingDemo)) !== JSON.stringify(asked)) await update($, waitingDemo, () => asked)
  // The run ends at DEMO_MS; its finished tree stays in view until DEMO_END_MS.
  if (elapsed >= DEMO_END_MS) {
    demo.timer.cancel()
    const back = demo.restore
    demo = null
    if (back) await setSky($, back, null)
    else await update($, prefs, p => (p.caption ? { ...p, caption: null } : p))
  }
}

// ---------------------------------------------------------------- the inspector

const viewOf = (v: View): View => ({ ...v, target: (v as Partial<View>).target ?? null })

/** Where the inspected agent's transcript is: beside its run's, or the session's subagents'. */
async function transcriptOf($: EngineInterface, target: Target): Promise<string | null> {
  if (target.kind !== 'agent') return null
  if (target.from === 'past') {
    const p = await read($, past)
    return p ? p.path.replace(/\/workflows\/[^/]+\.json$/, `/subagents/workflows/${target.runKey}/agent-${target.key}.jsonl`) : null
  }
  const dir = await read($, sessionDir)
  if (!dir) return null
  if (target.runKey === 'subagents') return `${dir}/subagents/agent-${target.key}.jsonl`
  return `${dir}/subagents/workflows/${target.runKey}/agent-${target.key}.jsonl`
}

/** Reads the inspected agent's transcript again when it has grown. */
async function refreshTrace($: EngineInterface) {
  const v = viewOf(await read($, view))
  const target = v.target
  if (v.mode !== 'inspect' || !target || target.kind !== 'agent') return
  const was = await read($, trace)
  const path = await transcriptOf($, target)
  const stat = path ? await $.fs.stat(path).catch(() => null) : null
  const base = { agentId: target.key, path, bytes: stat?.size ?? 0 }
  if (was?.agentId === target.key && was.path === path && was.bytes === base.bytes && (was.trace || was.error)) return
  if (!path || !stat) {
    const error = target.runKey.startsWith('demo-') ? 'a demo agent has no transcript' : 'no transcript on disk yet'
    await update($, trace, () => ({ ...base, trace: null, error }))
    return
  }
  if (stat.size >= MAX_READ) {
    await update($, trace, () => ({ ...base, trace: was?.agentId === target.key ? (was.trace ?? null) : null, error: 'transcript over 4 MiB: showing what was read before' }))
    return
  }
  const text = await $.fs.read(path).catch(() => null)
  await update($, trace, () => (text === null ? { ...base, trace: null, error: 'could not read the transcript' } : { ...base, trace: traceOf(text), error: null }))
}

async function inspect($: EngineInterface, kind: Target['kind'], key: string, runKey: string) {
  const v = viewOf(await read($, view))
  const from = v.mode === 'past' || (v.mode === 'inspect' && v.target?.from === 'past') ? 'past' : 'live'
  await update($, view, (w): View => ({ ...viewOf(w), mode: 'inspect', target: { kind, key, runKey, from } }))
  if (kind === 'agent') $.clock.after(0, () => void refreshTrace($).catch(() => undefined))
}

async function back($: EngineInterface) {
  await update($, view, (w): View => {
    const v = viewOf(w)
    return { ...v, mode: v.target?.from === 'past' ? 'past' : 'live', target: null }
  })
}

/** A node with its children's agents left out: the inspector lists them, it does not draw their trees. */
const shallow = (n: SkyNode): SkyNode => ({ ...n, children: n.children.map(c => ({ ...c, agents: [], children: [], hidden: c.hidden + c.agents.length })) })

async function inspectProps($: EngineInterface, base: SkyProps, target: Target): Promise<SkyProps> {
  const [st, allChecks, tr] = await Promise.all([read($, stats), read($, checks), read($, trace)])
  let sky: SkyRun | null = null
  let run: Run | null = null
  if (target.from === 'past') {
    const p = await read($, past)
    run = p?.run ? normalizeRun(p.run) : null
    sky = run ? skyRun(run, { ...st, ...(p?.stats ?? {}) }, 1000) : null
  } else if (target.runKey === 'subagents') {
    const subs = await read($, subagents)
    sky = subs.length > 0 ? skySubagents(subs, st, 1000) : null
  } else {
    run = (await readRuns($)).find(r => r.id === target.runKey) ?? null
    sky = run ? skyRun(run, st, 1000) : null
  }
  const found = sky && target.kind !== 'run' ? findIn(sky, target.kind, target.key) : null
  // An inspected agent is not leaned: its legend needs the cache even at rest or finished.
  const node = target.kind === 'node' && found?.node ? leanNode(shallow(found.node), EXTRAS_KEPT) : null
  const crumbs = [sky?.name ?? target.runKey, ...(found?.path ?? []), ...(node ? [node.title] : [])]
  const facts: { label: string; value: string }[] = []
  if (target.kind === 'run' && run) {
    facts.push({ label: 'run id', value: run.id })
    facts.push({ label: 'resume', value: `Workflow({ resumeFromRunId: "${run.id}" })` })
    if (run.scriptPath) facts.push({ label: 'script', value: run.scriptPath })
    const dir = await read($, sessionDir)
    if (dir && target.from === 'live') facts.push({ label: 'transcripts', value: `${dir}/subagents/workflows/${run.id}` })
  }
  if (target.kind === 'agent') {
    facts.push({ label: 'agent id', value: target.key })
    const sub = target.runKey === 'subagents' ? (await read($, subagents)).find(s => s.id === target.key) : undefined
    if (sub) facts.push({ label: 'type', value: sub.type })
    if (tr?.agentId === target.key && tr.path) facts.push({ label: 'transcript', value: tr.path })
  }
  const home = await $.env.get('HOME')
  const tidy = (value: string) => (home && value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value)
  const isTrace = tr?.agentId === target.key
  const inspected: SkyInspect = {
    kind: target.kind,
    runKey: target.runKey,
    crumbs,
    run: target.kind === 'run' && sky ? { ...sky, nodes: sky.nodes.map(n => ({ ...n, agents: [], children: [], hidden: 0 })), loose: sky.loose.slice(-40) } : null,
    node,
    agent: target.kind === 'agent' ? (found?.agent ?? null) : null,
    facts: facts.map(f => ({ ...f, value: tidy(f.value) })),
    trace: isTrace ? (tr?.trace ?? null) : null,
    traceNote: target.kind !== 'agent' ? null : !isTrace ? 'reading the transcript…' : tr?.error ?? null,
    checks: target.kind === 'agent' ? (allChecks[target.key] ?? []) : [],
  }
  return { ...base, mode: 'inspect', inspect: inspected }
}

async function setMode($: EngineInterface, mode: ViewMode) {
  await update($, view, v => ({ ...viewOf(v), mode }))
  if (mode === 'history') $.clock.after(0, () => void loadHistory($).catch(() => undefined))
}

async function openPast($: EngineInterface, path: string) {
  await update($, view, (): View => ({ mode: 'past', pastPath: path, target: null }))
  await update($, past, () => ({ path, run: null, stats: {}, isCosting: true, error: null }))
  $.clock.after(0, () => void loadPast($, path).catch(() => undefined))
}

async function handle($: EngineInterface, data: unknown) {
  const d = asRecord(data)
  if (d?.type === 'mode' && (d.mode === 'live' || d.mode === 'history')) await setMode($, d.mode)
  else if (d?.type === 'open' && typeof d.path === 'string') await openPast($, d.path)
  else if (d?.type === 'back') await back($)
  else if (d?.type === 'clear') await clearFinished($)
  else if (d?.type === 'detail') await setDetail($, nextDetail(detailOf(await read($, prefs))))
  else if (d?.type === 'dismiss' && typeof d.runKey === 'string') await clearFinished($, d.runKey)
  else if (
    d?.type === 'inspect' &&
    (d.kind === 'agent' || d.kind === 'node' || d.kind === 'run') &&
    typeof d.key === 'string' &&
    typeof d.runKey === 'string'
  ) {
    await inspect($, d.kind, d.key, d.runKey)
  }
}

// ---------------------------------------------------------------- the sky's props

async function skyProps($: EngineInterface, columns: number): Promise<SkyProps> {
  const [w, now, pref, real, played, realWaiting, playedWaiting] = await Promise.all([read($, view), $.clock.now(), read($, prefs), read($, gauge), read($, starDemo), read($, waiting), read($, waitingDemo)])
  const g = played ?? real
  const v = viewOf(w)
  const sky = isSkyStyle(pref.sky) ? pref.sky : 'stars'
  // Every view gets the eclipse; only the live tree gets binaries and meteors.
  const base: SkyProps = { now, columns, mode: v.mode, runs: [], subagents: null, history: [], isLoading: false, note: null, inspect: null, sky, caption: pref.caption, detail: detailOf(pref), gauge: g, waiting: playedWaiting ?? realWaiting, binaries: [], failures: [] }
  if (v.mode === 'inspect') {
    if (v.target) return inspectProps($, base, v.target)
    return liveProps($, { ...base, mode: 'live' })
  }
  if (v.mode === 'history') {
    const h = await read($, history)
    return {
      ...base,
      isLoading: h.isLoading,
      history: h.rows.map(r => ({
        path: r.path,
        name: r.name,
        status: r.status,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        agents: r.agents,
        tokens: r.tokens,
        project: r.project,
      })),
    }
  }
  if (v.mode === 'past') {
    const p = await read($, past)
    if (!p?.run) return { ...base, note: p?.error ?? 'reading the run…' }
    return {
      ...base,
      runs: leanRuns([skyRun(normalizeRun(p.run), p.stats, KEEP_DONE)]),
      note: p.isCosting ? 'pricing agents from their transcripts…' : null,
    }
  }
  return liveProps($, base)
}

async function liveProps($: EngineInterface, base: SkyProps): Promise<SkyProps> {
  const [rs, st, subs, ring] = await Promise.all([readRuns($), read($, stats), read($, subagents), read($, failures)])
  const sorted = [...rs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const draw = (keepDone: number, keepRuns: number, keepExtras = Number.POSITIVE_INFINITY): SkyProps => {
    const shown = sorted.slice(0, keepRuns).map((r, i) => skyRun(r, st, i < 3 ? keepDone : 0))
    const group = subs.length > 0 ? skySubagents(subs, st) : null
    // The group last, as the tree draws it.
    const lean = leanRuns(group ? [...shown, group] : shown, keepExtras)
    return { ...base, runs: lean.slice(0, shown.length), subagents: group ? (lean[shown.length] ?? null) : null }
  }
  const first = draw(KEEP_DONE, sorted.length)
  // No retry trims a running agent, so extras computed from the first drawing hold for every retry.
  const running = runningIds([...first.runs, ...(first.subagents ? [first.subagents] : [])])
  const extras = { binaries: binariesOf(st, running, base.now), failures: ring.length > 0 ? showerProps(ring, base.now, labelOf(rs, subs)) : [] }
  // A Client's props are capped at 100,000 characters: trim finished detail first, then extras.
  let props = { ...first, ...extras }
  if (JSON.stringify(props).length > PROPS_BUDGET) props = { ...draw(8, sorted.length), ...extras }
  if (JSON.stringify(props).length > PROPS_BUDGET) props = { ...draw(3, 3), ...extras }
  if (JSON.stringify(props).length > PROPS_BUDGET) props = { ...draw(3, 3, EXTRAS_KEPT), ...extras }
  return props
}

/** The ids of the running agents in drawn runs: their nodes', child workflows' and loose ones. */
function runningIds(drawn: readonly SkyRun[]): string[] {
  const walk = (n: SkyNode): SkyAgent[] => [...n.agents, ...n.children.flatMap(walk)]
  return drawn.flatMap(r => [...r.nodes.flatMap(walk), ...r.loose]).filter(a => a.status === 'running').map(a => a.id)
}

/** Who a failing loop is, for the meteors' words: a workflow agent by its label, a subagent by its description. */
function labelOf(rs: readonly Run[], subs: readonly SubAgent[]): (agentId: string) => string | null {
  const names = new Map<string, string>([...rs.flatMap(r => r.agents.map(a => [a.id, a.label] as const)), ...subs.map(s => [s.id, s.description] as const)])
  return id => names.get(id) ?? null
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const cfg: Config = { autoOpen: options.autoOpen !== false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'constellation',
      description: 'Constellation: a live ASCII map of workflow runs and subagents (open, close, clear, history, live, demo, sky, detail)',
      argumentHint: '[open|close|clear|history|live|demo [tour|star|<style>]|sky <style>|detail [naked-eye|binoculars|telescope]]',
    })
    if (!(await read($, sessionDir))) {
      const config = await configDir($)
      const [root, id] = await Promise.all([$.session.root().catch(() => e.cwd), $.session.id()])
      if (config) await update($, sessionDir, () => `${config}/projects/${slugOf(root)}/${id}`)
    }
    const usage = await $.session.usage().catch(() => null)
    if (usage) await measure($, usage.context, usage.cost?.usd ?? null)
    const kept = await $.store.get('sky').catch(() => undefined)
    if (typeof kept === 'string' && isSkyStyle(kept)) await setSky($, kept, null)
    const level = await $.store.get('detail').catch(() => undefined)
    if (isDetailLevel(level) && detailOf(await read($, prefs)) !== level) await update($, prefs, (p): Prefs => ({ ...p, detail: level }))
    // A hot reload reruns this with the demos' timers gone: clear what no timer will finish.
    if (!starTimer && (await read($, starDemo)) !== null) await update($, starDemo, () => null)
    if (!demo) {
      if ((await read($, waitingDemo)) !== null) await update($, waitingDemo, () => null)
      // Only a demo sets a caption, so a leftover one means a stranded demo style.
      if ((await read($, prefs)).caption !== null) await setSky($, typeof kept === 'string' && isSkyStyle(kept) ? kept : 'stars', null)
      const isStranded = (r: Run) => r.id.startsWith('demo-') && r.status === 'running'
      if ((await read($, runs)).some(isStranded)) await update($, runs, list => list.filter(r => !isStranded(r)))
    }
    $.clock.every(POLL_MS, () => void poll($, cfg))
    return next(e)
  })

  // The transcript's path names the session folder exactly, and follows a /clear.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path) await setSessionDir($, sessionDirOf(e.transcript_path))
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.transcript_path) await setSessionDir($, sessionDirOf(e.transcript_path))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await setSessionDir($, null)
      await update($, runs, () => [])
      await update($, stats, () => ({}))
      await update($, subagents, () => [])
      await update($, view, (): View => ({ mode: 'live', pastPath: null, target: null }))
      await update($, checks, () => ({}))
      await update($, trace, () => null)
      await update($, dismissed, (): Dismissed => ({ runs: [], agents: [] }))
      await update($, failures, () => [])
      // A null gauge draws a protostar until the first answer.
      await update($, gauge, () => null)
    }
    // However the session ends, nothing waits on the person any more.
    if (isEclipseOpen()) raiseEclipse($, { kind: 'resume', at: await $.clock.now() })
    if ((await read($, waiting)) !== null) await update($, waiting, () => null)
    return next(e)
  })

  // A Workflow call's result names the run, its script and its transcripts at launch.
  on('session.append', { door: 'tool-result', origin: { kind: 'tool', tool: 'Workflow' } }, async ($, e, next) => {
    const stored = await next(e)
    const blocks = Array.isArray(e.message.content) ? e.message.content : []
    for (const block of blocks) {
      const b = asRecord(block)
      if (b?.type !== 'tool_result') continue
      const inner: unknown[] = typeof b.content === 'string' ? [b.content] : Array.isArray(b.content) ? b.content : []
      for (const part of inner) {
        const text = typeof part === 'string' ? part : asRecord(part)?.text
        const launch = typeof text === 'string' && text.startsWith('Workflow launched') ? parseLaunch(text) : null
        if (launch) $.clock.after(0, () => void noteLaunch($, cfg, launch).catch(() => undefined))
      }
    }
    return stored
  })

  // Tool results: agents' failed calls for the meteors (toolErrorsOf leaves out the person's own
  // rejections and interrupts) and, during a wait, calls past their dialog for the eclipse. Observes only.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.origin.kind !== 'tool') return stored
    const errors = e.agentId ? toolErrorsOf(e.message.content) : []
    const isOpen = isEclipseOpen()
    if (errors.length === 0 && !isOpen) return stored
    const at = await $.clock.now()
    for (const id of errors) if (failed.length < MAX_BUFFER) failed.push({ id, agent: e.agentId ?? null, at, kind: 'error' })
    if (isOpen) for (const id of toolResultIds(e.message.content)) raiseEclipse($, { kind: 'result', at, id, tool: e.origin.tool })
    return stored
  })

  // The main session's context window and spend, for the gauge.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') || e.changed.includes('cost')) await measure($, e.context, e.cost?.usd ?? null)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    // The star dies and is reborn; the next answer measures the new share.
    if (!e.agentId && e.trigger !== 'precompute') {
      await update($, gauge, (g): Gauge => ({
        tokens: null,
        window: g?.window ?? 0,
        percent: null,
        costUsd: g?.costUsd ?? null,
        compactions: (g?.compactions ?? 0) + 1,
        isReborn: true,
      }))
    }
    return done
  })

  // Subagents' permission decisions (inspector, binary-star writes, meteor denials) and any loop's
  // ask of the person (eclipse). Observes only: the verdict goes back as it came.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // A query ($.tool.check) has no call id.
    if (!e.tool_use_id) return verdict
    try {
      const tool = String(e.tool)
      const isAsk = verdict.decision === 'ask' && e.approver === 'person'
      // The main loop's checks matter only when they ask the person.
      if (!e.agentId && !isAsk) return verdict
      const at = await $.clock.now()
      if (e.agentId) {
        if (checked.length < MAX_BUFFER) {
          const event: CheckEvent = { tool, summary: summarizeInput(tool, e.input), decision: verdict.decision, by: decidedBy(verdict), at }
          checked.push({ id: e.agentId, event })
        }
        // An ask someone can answer is mostly allowed, so count it as a write that will run.
        const willRun = verdict.decision === 'allow' || (verdict.decision === 'ask' && e.approver !== undefined)
        const path = willRun ? editedPath(tool, e.input) : null
        if (path && touched.length < MAX_BUFFER) touched.push({ id: e.agentId, path, at })
        // The error result a denied call ends in merges with this meteor by call id.
        if (verdict.decision === 'deny' && failed.length < MAX_BUFFER) failed.push({ id: e.tool_use_id, agent: e.agentId, at, kind: 'deny' })
      }
      if (isAsk) raiseEclipse($, { kind: 'check', at, id: e.tool_use_id, tool, summary: summarizeInput(tool, e.input), ...(e.agentId ? { agentId: e.agentId } : {}) })
    } catch {
      // Observing never changes the verdict.
    }
    return verdict
  })

  // Every model request: an agent's stats and retrograde stamps; the main loop's ends the eclipse.
  // Observes only: chunks pass on untouched and nothing is written per chunk.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    // A new main-loop request means every call it waited on came back.
    if (id === undefined && isEclipseOpen()) raiseEclipse($, { kind: 'resume', at: await $.clock.now() })
    const sentAt = id ? await $.clock.now() : 0
    if (id && begun.length < MAX_BUFFER) begun.push({ id, at: sentAt })
    const stream = next(e)
    for await (const chunk of stream) {
      if (id) heardIds.add(id)
      yield chunk
    }
    const result = await stream.result
    if (id && steps.length < MAX_BUFFER) {
      steps.push({
        id,
        sentAt,
        at: await $.clock.now(),
        model: result.usage?.model ?? e.model,
        effort: e.effort === undefined ? null : shortEffort(String(e.effort)),
        usage: result.usage,
        tools: result.toolUses.map(t => t.name),
        calls: result.toolUses.map(t => loopKey(t.name, t.input)),
      })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId && ends.length < MAX_BUFFER) ends.push({ id: e.agentId, at: await $.clock.now(), reason: e.reason })
    // The main loop's turn is over: nothing it asked can still be waiting.
    if (e.agentId === undefined && isEclipseOpen()) raiseEclipse($, { kind: 'resume', at: await $.clock.now() })
    return next(e)
  })

  // Only the person's own prompt (terminal or Remote Control) ends a wait, never a task
  // notification, peer, schedule or plugin prompt. Observes only.
  on('prompt.submit', async ($, e, next) => {
    if (isEclipseOpen() && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')) raiseEclipse($, { kind: 'resume', at: await $.clock.now() })
    return next(e)
  })

  // A permission dialog no hook answered, for the eclipse. A subagent's only confirms an ask its
  // own check raised: a background agent's goes to hooks. Observes only.
  on('classic.PermissionRequest', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === undefined) {
      const at = await $.clock.now()
      raiseEclipse($, { kind: 'dialog', at, reason: 'permission', tool: e.tool_name, summary: summarizeInput(e.tool_name, e.tool_input), ...(e.agent_id ? { agentId: e.agent_id } : {}) })
    }
    return r
  })

  // An MCP server's form and the answer that ends it, for the eclipse. Observes only.
  on('classic.Elicitation', async ($, e, next) => {
    const r = await next(e)
    raiseEclipse($, { kind: 'dialog', at: await $.clock.now(), reason: 'input', tool: e.mcp_server_name, summary: e.message, id: elicitId(e), ...(e.agent_id ? { agentId: e.agent_id } : {}) })
    return r
  })

  on('classic.ElicitationResult', async ($, e, next) => {
    const r = await next(e)
    if (isEclipseOpen()) raiseEclipse($, { kind: 'result', at: await $.clock.now(), id: elicitId(e) })
    return r
  })

  // The run-in-background pill shows only under a running call, so a long approved Bash ends the
  // eclipse at once, not when it finishes. A render never writes: the work waits a tick.
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (isEclipseOpen()) $.clock.after(0, () => void resultFromProgress($, e.props.tool_use_id).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'constellation' }, async ($, e) => {
    const verb = e.args.trim().split(/\s+/)[0] || 'open'
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Constellation closed.' }
    }
    if (verb === 'history' || verb === 'live') await setMode($, verb)
    const arg = e.args.trim().split(/\s+/)[1]
    if (verb === 'demo' && arg === 'star') await startStarDemo($)
    else if (verb === 'demo') await startDemo($, arg)
    if (verb === 'clear') {
      const gone = await clearFinished($)
      return { text: `Cleared ${gone.runs} finished run${gone.runs === 1 ? '' : 's'} and ${gone.agents} ended subagent${gone.agents === 1 ? '' : 's'} from the live view; the history tab keeps them.` }
    }
    if (verb === 'sky') {
      if (!arg || !isSkyStyle(arg)) return { text: `Sky styles: ${SKY_STYLES.join(', ')}. Try /constellation demo tour to see each.` }
      await setSky($, arg, null)
      await $.store.set('sky', arg).catch(() => undefined)
    }
    let said = 'Constellation open.'
    if (verb === 'detail') {
      // `naked eye` with a space works too; no level steps to the next, like the header's word.
      const named = e.args.trim().split(/\s+/).slice(1).join('-').toLowerCase()
      const level = named ? named : nextDetail(detailOf(await read($, prefs)))
      if (!isDetailLevel(level)) return { text: `Detail levels: ${DETAIL_LEVELS.map(l => `${l} (${DETAIL_NOTES[l]})`).join('; ')}. With no level, /constellation detail steps to the next.` }
      await setDetail($, level)
      said = `Detail: ${DETAIL_NAMES[level]}, ${DETAIL_NOTES[level]}.`
    }
    const opened = await openPane($)
    return { text: opened.isPlaced ? said : `${verb === 'detail' ? `${said} ` : ''}Constellation is waiting for room: ${opened.reason}` }
  })

  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    await handle($, e.data)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const props = await skyProps($, e.props.bodyColumns)
    // Branch on the surface, not `'Client' in` its table: probing the table that
    // way left the still tree below with no children on vscode and mobile.
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)
      return <Client key="sky" module="./sky.tsx" props={props} width="100%" />
    }
    // vscode and mobile draw no Client: the same tree, still.
    const ui: SkyUi = {
      t: 0,
      isMoving: false,
      drift: 0,
      bornAt: () => Number.NEGATIVE_INFINITY,
      doneAt: () => null,
      isOpen: (_, byDefault) => byDefault,
      toggle: () => {},
      post: data => void handle($, data),
      shots: [],
      samples: [],
      novaAt: null,
      // Still stand-ins for motion: tints never fade, a moon off its course stands, meteors have fallen.
      shiftSeen: (_id, level) => ({ level, from: level, at: 0 }),
      retroSeen: () => null,
      meteors: settledMeteors(props.failures, props.now),
      eclipse: props.waiting ? ECLIPSE_HELD : null,
    }
    return drawSky($.ui.resolve(e) as unknown as SkyElements, props, ui)
  })
}
