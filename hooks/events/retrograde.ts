// Retrograde: an agent going round in circles. A planet's apparent motion slows,
// stands still, runs backwards, then goes direct again; the agent's own moon does
// the same. At the third identical call it slows to a stop (stationary); from the
// fourth it turns backwards in white, a phase further back with each repeat
// (retrograde); a different call eases it forward again (direct). A loop gone
// quiet for minutes stands still instead.
//
// Pure: detection takes the times it is given; drawing is a function of the frame
// clock's `t` and what the Client remembers of the moon (seeRetro).

import { HEX, clamp01, mix, quantize } from '../motion'
import type { Cell } from '../skies'

// ---------------------------------------------------------------- thresholds

/**
 * When the moon stops (`stationary`) and when it goes retrograde (`retrograde`; a silence stays still, white).
 * `model`: no answer to a request; `tool`: a tool's result awaited (Bash's ceiling is ten minutes); `same`: the
 * same call in a row; `cycle`: rounds of two or three calls in turn; `poll`: rounds that wait on purpose.
 */
export const RETRO = {
  model: { stationary: 3 * 60_000, retrograde: 5 * 60_000 },
  tool: { stationary: 5 * 60_000, retrograde: 10.5 * 60_000 },
  same: { stationary: 3, retrograde: 4 },
  cycle: { stationary: 2, retrograde: 3 },
  poll: { stationary: 10, retrograde: 20 },
} as const

/** Tools whose call waits on something else by design: a nested agent, a forked skill, the person. */
const PATIENT = new Set(['Agent', 'Skill', 'AskUserQuestion', 'ExitPlanMode'])

/** A Bash command that waits on purpose: a sleep, a watch, a wait loop. */
const POLL = /\bsleep\s+\d|\b(?:watch|until|while)\s|--watch\b/

/** Calls the tracker keeps: three rounds of a three-call cycle, and a little more. */
export const RING = 12
/** The longest repeating pattern it looks for. */
const MAX_PERIOD = 3

// ---------------------------------------------------------------- detection

/** Per-agent state in `AgentStats.tracker`, updated once a second with the stats; plain JSON, bounded. */
export type RetroTracker = {
  /** The latest call keys (`Bash#1x2y3z`), oldest first, at most RING; emptied when a turn ends. */
  calls: string[]
  /** The repeating pattern's length in calls (0: none), and how many calls it runs. */
  period: number
  run: number
  /** When the pattern was first seen repeating, epoch ms. */
  loopAt: number | null
  /** The tools the latest answered step asked for (short names, each once, at most 4). */
  pending: string[]
  /** Whether that step asked for a tool that waits by design. */
  patient: boolean
  /** When the newest request went out, and when a piece of a response last arrived, epoch ms. */
  sentAt: number | null
  heardAt: number | null
  /** When the loop's turn last ended; null once a request goes out after it. */
  endedAt: number | null
  /** Since when a person holds the loop (a permission dialog); null once released. */
  heldAt: number | null
}

export const newRetroTracker = (): RetroTracker => ({
  calls: [],
  period: 0,
  run: 0,
  loopAt: null,
  pending: [],
  patient: false,
  sentAt: null,
  heardAt: null,
  endedAt: null,
  heldAt: null,
})

/** `mcp__tracker__get_issue` -> `get_issue`. */
const shortTool = (name: string) => name.split('__').at(-1) ?? name

/** JSON with its keys sorted, so the same input always hashes alike. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`
}

/** FNV-1a, 32 bits, in base 36. */
function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** A call's key: its short name and a hash of its full name and input (`Bash#1x2y3z`), `#~` for a Bash command that waits on purpose. */
export function callKey(name: string, input: unknown): string {
  const command = name === 'Bash' && input !== null && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  const poll = typeof command === 'string' && POLL.test(command) ? '~' : ''
  return `${shortTool(name)}#${poll}${fnv(`${name}\n${stable(input)}`)}`
}

const toolOf = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf('#'))) || key
const isPollKey = (key: string) => key.includes('#~')

/** The run of a period-`p` pattern at the end of `calls`. */
function runOf(calls: readonly string[], p: number): number {
  const n = calls.length
  let k = 0
  while (n - 1 - k - p >= 0 && calls[n - 1 - k] === calls[n - 1 - k - p]) k++
  return Math.min(n, k + p)
}

/** Full rounds of a pattern: identical calls for a period of one, else whole cycles. */
const roundsOf = (period: number, run: number) => (period === 0 ? 0 : Math.floor(run / period))

const limitOf = (period: number, isPoll: boolean) => (isPoll ? RETRO.poll : period === 1 ? RETRO.same : RETRO.cycle)

/** One round of the pattern from where the run began; a run longer than the ring starts at the same place in a round. */
function patternOf(calls: readonly string[], period: number, run: number): string[] {
  const first = calls.length - run
  const start = first >= 0 ? first : ((first % period) + period) % period
  return calls.slice(start, start + period)
}

/** A stamp that anything at `at` or later supersedes. */
const before = (stamp: number | null, at: number) => (stamp !== null && at > stamp ? null : stamp)

/** A request went out at `at`: a turn that had ended is woken, a hold is over. */
export function trackBegin(tr: RetroTracker | null, at: number): RetroTracker {
  const was = tr ?? newRetroTracker()
  return { ...was, sentAt: Math.max(was.sentAt ?? at, at), endedAt: before(was.endedAt, at), heldAt: before(was.heldAt, at) }
}

/** A piece of a response arrived by `at` (stamped at most every HEARD_MS). */
export function trackHeard(tr: RetroTracker | null, at: number): RetroTracker {
  const was = tr ?? newRetroTracker()
  return { ...was, heardAt: Math.max(was.heardAt ?? at, at) }
}

/** How stale `heardAt` may be: the hooks module restamps it only after this long. */
export const HEARD_MS = 30_000

/** The loop's turn ended at `at`: it waits on nothing until a request goes out, and its loop is over. */
export function trackEnd(tr: RetroTracker | null, at: number): RetroTracker {
  const was = tr ?? newRetroTracker()
  return { ...newRetroTracker(), sentAt: was.sentAt, heardAt: was.heardAt, endedAt: Math.max(was.endedAt ?? at, at) }
}

/** A person was asked on the loop's behalf at `at`: waiting on them is not being stuck. */
export function trackHold(tr: RetroTracker | null, at: number): RetroTracker {
  const was = tr ?? newRetroTracker()
  return { ...was, heldAt: Math.max(was.heldAt ?? at, at) }
}

/** The person answered at `at`: the loop's silence starts over. */
export function trackRelease(tr: RetroTracker | null, at: number): RetroTracker {
  const was = tr ?? newRetroTracker()
  return { ...was, heldAt: null, heardAt: Math.max(was.heardAt ?? at, at) }
}

/** A response came whole at `at`, asking for `calls` (in order); one asking for nothing ends the turn and the loop. */
export function trackStep(tr: RetroTracker | null, step: { at: number; calls: readonly string[] }): RetroTracker {
  const was = tr ?? newRetroTracker()
  if (step.calls.length === 0) {
    return { ...newRetroTracker(), sentAt: was.sentAt, heardAt: was.heardAt, endedAt: Math.max(was.endedAt ?? step.at, step.at), heldAt: before(was.heldAt, step.at) }
  }
  let { calls, period, run, loopAt } = was
  for (const key of step.calls) {
    const continues = period > 0 && calls.length >= period && calls[calls.length - period] === key
    calls = [...calls, key].slice(-RING)
    if (continues) {
      run += 1
      continue
    }
    period = 0
    run = 0
    loopAt = null
    for (let p = 1; p <= MAX_PERIOD; p++) {
      const r = runOf(calls, p)
      if (r >= 2 * p) {
        period = p
        run = r
        loopAt = step.at
        break
      }
    }
  }
  const tools = step.calls.map(toolOf)
  return {
    calls,
    period,
    run,
    loopAt,
    pending: [...new Set(tools)].slice(0, 4),
    patient: tools.some(name => PATIENT.has(name)),
    sentAt: was.sentAt,
    heardAt: was.heardAt,
    endedAt: before(was.endedAt, step.at),
    heldAt: before(was.heldAt, step.at),
  }
}

/** A loop the agent is in: rounds of a pattern named by its tools; a poll when a call in it waits on purpose. */
export type RetroLoop = { period: number; rounds: number; since: number; label: string; isPoll: boolean }

/** What the drawing needs, clock-free: computed in the hooks module for each running agent (SkyAgent.watch). */
export type RetroWatch = {
  /** What the loop waits on: the model, a tool's result, or nothing it could be stuck on. */
  wait: 'model' | 'tool' | 'none'
  /** The tool it waits on, in words (`Bash`, `Read + Grep`). */
  tool: string | null
  /** Since when nothing has been heard from it, epoch ms. */
  quiet: number
  loop: RetroLoop | null
}

/** The watch for a running agent from its tracker and its stats' `lastAt`; stamps count only while nothing newer supersedes them. */
export function watchOf(tr: RetroTracker | null, lastAt: number): RetroWatch {
  const sentAt = tr?.sentAt ?? null
  const isAsking = sentAt !== null && sentAt > lastAt
  // An end or a hold stands while no answer came after it and no request went out since.
  const stands = (stamp: number | null | undefined) => stamp !== null && stamp !== undefined && stamp >= lastAt && !(sentAt !== null && sentAt > stamp)
  const isEnded = stands(tr?.endedAt)
  const pending = isAsking ? [] : (tr?.pending ?? [])
  const isPatient = !isAsking && tr?.patient === true
  const wait = isEnded || stands(tr?.heldAt) || isPatient ? 'none' : pending.length > 0 ? 'tool' : 'model'
  const quiet = Math.max(lastAt, sentAt ?? lastAt, tr?.heardAt ?? lastAt)
  let loop: RetroLoop | null = null
  if (tr && !isEnded && tr.period > 0 && tr.loopAt !== null) {
    const pattern = patternOf(tr.calls, tr.period, tr.run)
    loop = { period: tr.period, rounds: roundsOf(tr.period, tr.run), since: tr.loopAt, label: pattern.map(toolOf).join(' → '), isPoll: pattern.some(isPollKey) }
  }
  return { wait, tool: wait !== 'none' && pending.length > 0 ? pending.join(' + ') : null, quiet, loop }
}

/**
 * An agent off its course. `stationary`: the moon stops (its words through the telescope only); `retrograde`:
 * past the line, its words at every level, a loop turning backwards in white and a silence standing still in white.
 */
export type Retro = {
  kind: 'stuck' | 'loop'
  stage: 'stationary' | 'retrograde'
  /** When the silence or the loop began, epoch ms. */
  since: number
  /** In words: 'no answer for 6:12', 'same Bash call ×5'. */
  detail: string
  /** Repeats past the line: the moon kicks back a phase for each. */
  kicks: number
}

/** `m:ss` under an hour, `XhMM` past it. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

function stuckIn(w: RetroWatch, now: number): Retro | null {
  if (w.wait === 'none') return null
  const limit = w.wait === 'tool' ? RETRO.tool : RETRO.model
  const quiet = now - w.quiet
  if (quiet < limit.stationary) return null
  return {
    kind: 'stuck',
    stage: quiet >= limit.retrograde ? 'retrograde' : 'stationary',
    since: w.quiet,
    detail: w.wait === 'tool' && w.tool ? `${w.tool} running for ${clock(quiet)}` : `no answer for ${clock(quiet)}`,
    kicks: 0,
  }
}

function loopIn(loop: RetroLoop): Retro | null {
  const limit = limitOf(loop.period, loop.isPoll)
  if (loop.rounds < limit.stationary) return null
  const isPast = loop.rounds >= limit.retrograde
  const what = loop.period > 1 ? 'cycle' : loop.isPoll ? 'poll' : 'call'
  return {
    kind: 'loop',
    stage: isPast ? 'retrograde' : 'stationary',
    since: loop.since,
    detail: `same ${loop.label} ${what} ×${loop.rounds}`,
    kicks: isPast ? loop.rounds - limit.retrograde : 0,
  }
}

/** Where a watch stands at `now` (epoch ms): a silence past its line outranks a loop past its; either outranks a stationary one. */
export function retroIn(w: RetroWatch | null | undefined, now: number): Retro | null {
  if (!w) return null
  const stuck = stuckIn(w, now)
  const loop = w.loop ? loopIn(w.loop) : null
  if (stuck?.stage === 'retrograde') return stuck
  if (loop?.stage === 'retrograde') return loop
  return stuck ?? loop
}

/** Where an agent stands at `now`, from its tracker and its stats' `lastAt`. */
export const retroOf = (tr: RetroTracker | null, lastAt: number, now: number): Retro | null => retroIn(watchOf(tr, lastAt), now)

// ---------------------------------------------------------------- the Client's memory

/** The moon's turn in phases per ms: forward as draw.tsx turns it, and backward, slower and steady. */
const FORWARD = 1 / 150
const BACKWARD = -1 / 260
/** How long it takes to slow to a stop, to get going backwards, and to turn white. */
export const STOP_MS = 900
const TURN_MS = 500
const WHITE_MS = 400
/** Direct: the backward turn slows to a stop, stands a moment, then speeds up forwards; `direct` shows meanwhile. */
const SLOW_MS = 500
const STILL_MS = 300
export const DIRECT_MS = 1500

/** What the Client remembers of a moon off its course (all times on the frame clock). */
export type RetroSeen = {
  stage: 'stationary' | 'retrograde' | 'direct'
  /** When it entered the stage, and its phase then (draw.tsx's ORBIT steps, unwrapped). */
  at: number
  phase: number
  /** Kicks counted as it entered the stage, and now. */
  kicks0: number
  kicks: number
  /** Past the line: white, its words at every level. */
  formed: boolean
  /** Direct: whether it was turning backwards, and how white it was. */
  back: boolean
  white: number
}

/** ∫ of a speed easing from 1 to 0 over `d` ms, `e` ms in. */
const slowing = (e: number, d: number) => (e >= d ? d / 2 : e / 2 + (d / (2 * Math.PI)) * Math.sin((Math.PI * e) / d))
/** ∫ of a speed easing from 0 to 1 over `d` ms, then steady. */
const speeding = (e: number, d: number) => (e >= d ? d / 2 + (e - d) : e / 2 - (d / (2 * Math.PI)) * Math.sin((Math.PI * e) / d))

/** The moon's phase at `t`: its speed summed since it entered the stage, so it never jumps but for a kick. */
export function phaseOf(seen: RetroSeen, t: number): number {
  const e = Math.max(0, t - seen.at)
  if (seen.stage === 'stationary') return seen.phase + FORWARD * slowing(e, STOP_MS)
  if (seen.stage === 'retrograde') return seen.phase + BACKWARD * speeding(e, TURN_MS) - (seen.kicks - seen.kicks0)
  const back = seen.back ? BACKWARD * slowing(e, SLOW_MS) : 0
  const ahead = e > SLOW_MS + STILL_MS ? FORWARD * speeding(e - SLOW_MS - STILL_MS, DIRECT_MS - SLOW_MS - STILL_MS) : 0
  return seen.phase + back + ahead
}

/** How white the moon is at `t`, 0..1. */
function whiteOf(seen: RetroSeen, t: number): number {
  if (seen.stage === 'direct') return seen.white * (1 - clamp01((t - seen.at) / DIRECT_MS))
  if (!seen.formed) return 0
  return seen.stage === 'retrograde' ? clamp01((t - seen.at) / WHITE_MS) : 1
}

/** The Client's memory after this frame: a new stage is anchored where the moon is; going direct is kept for DIRECT_MS. */
export function seeRetro(seen: RetroSeen | null | undefined, retro: Retro | null, t: number): RetroSeen | null {
  const was = seen ?? null
  if (retro === null) {
    if (!was) return null
    if (was.stage === 'direct') return t - was.at < DIRECT_MS ? was : null
    return { ...was, stage: 'direct', at: t, phase: phaseOf(was, t), kicks0: 0, kicks: 0, back: was.stage === 'retrograde', white: whiteOf(was, t) }
  }
  const stage = retro.kind === 'loop' && retro.stage === 'retrograde' ? 'retrograde' : 'stationary'
  const formed = retro.stage === 'retrograde'
  if (was?.stage === stage) return was.formed === formed && was.kicks === retro.kicks ? was : { ...was, formed, kicks: retro.kicks }
  return { stage, at: t, phase: was ? phaseOf(was, t) : t * FORWARD, kicks0: retro.kicks, kicks: retro.kicks, formed, back: false, white: 0 }
}

// ---------------------------------------------------------------- drawing

export const RETRO_HEX = {
  /** The retrograde moon: a cool white, apart from the orange moons, the green ●, the comet's cream head and the mint flash. */
  white: '#f2f4ff',
  /** Its words past the line, and before it. */
  words: '#d97c4e',
  pale: '#a98c98',
  direct: HEX.calm,
} as const

const ORBIT = [...'◐◓◑◒']
const at = <T>(list: readonly T[], i: number): T => list[((Math.floor(i) % list.length) + list.length) % list.length] as T

/** The moon off its course at `t`, `base` its own colour; without a memory (nothing animates) it stands, white past the line. */
export function retroGlyph(t: number, seen: RetroSeen | null, retro: Retro | null, base: string): Cell {
  const phase = seen ? phaseOf(seen, t) : t * FORWARD
  const white = seen ? whiteOf(seen, t) : retro?.stage === 'retrograde' ? 1 : 0
  return { t: at(ORBIT, phase), c: white > 0 ? mix(base, RETRO_HEX.white, quantize(white, 4)) : base }
}

/** The words for the detail line and the inspector: `retrograde · same Bash call ×5`, `stationary · no answer for 6:12`. */
export function retroFact(retro: Retro): Cell {
  const name = retro.kind === 'loop' && retro.stage === 'retrograde' ? 'retrograde' : 'stationary'
  return { t: `${name} · ${retro.detail}`, c: retro.stage === 'retrograde' ? RETRO_HEX.words : RETRO_HEX.pale }
}

/** The word while the moon goes direct again. */
export const DIRECT_FACT: Cell = { t: 'direct', c: RETRO_HEX.direct }
