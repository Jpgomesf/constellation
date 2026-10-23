// Comet tails on stragglers: a running agent well past the median duration of
// its finished siblings drags a tail into the row's empty leader. The tail grows
// from 1.5x the pace to its longest at 4x and scatters when the agent finishes.

import type { SkyAgent } from '../core'
import { HEX, clamp01, ease, mix, quantize, shimmer } from '../motion'
import type { Cell } from '../skies'

export const COMET = {
  /** No tail below this many times the pace. */
  from: 1.5,
  /** The tail is at its longest from this many times the pace. */
  full: 4,
  /** Finished siblings needed before their pace means anything. */
  minPeers: 2,
  /** The shortest pace counted: siblings that took a moment don't make a few seconds late. */
  floorMs: 5_000,
  /** Subagents are judged only against those of their type started within this long: one fan-out. */
  batchMs: 120_000,
  /** The tail's length in cells at `from` and at `full`. */
  minLen: 3,
  maxLen: 16,
  /** A new comet's tail unrolls from the label, and its first moments burn brighter. */
  unrollMs: 700,
  igniteMs: 1_600,
  /** When a straggler finishes, its tail scatters into dust over this long. */
  exitMs: 700,
} as const

/** A label keeps at least this many cells when it gives up room for a tail. */
const LABEL_KEEP = 10
/** The fewest tail cells worth drawing, and worth cutting a long label for. */
const MIN_SHOWN = 3
/** The most tail cells a long label is cut for. */
const CUT_CAP = 10
/** A cut label keeps at least this share of what the row would show: the label names the agent. */
const KEEP_SHARE = 2 / 3
/** Blank cells before the right part: its spinner is braille, like the dust. */
const AIR = 2
/** The dust drifts one braille dot column (half a cell) per this many ms. */
const DRIFT_MS = 140
/** A finishing comet's dust is blown out a dot column per this many ms. */
const BLOW_MS = 45

// ---------------------------------------------------------------- detection

/** A finished agent's duration, or null when it failed or is unknown (end <= start: both stamped at one poll). */
function durationOf(a: SkyAgent): number | null {
  if (a.status !== 'done' || a.startedAt === null || a.endedAt === null || a.endedAt <= a.startedAt) return null
  return a.endedAt - a.startedAt
}

/**
 * The median duration of a node's finished agents; null until `minPeers` finished and they match those
 * running, since the first to finish are the fastest. `hidden`: finished agents the props left out;
 * `self` counts as running, never in the pace.
 */
export function paceOf(siblings: readonly SkyAgent[], hidden = 0, self: string | null = null): number | null {
  const took: number[] = []
  let running = 0
  for (const s of siblings) {
    if (s.status === 'running' || s.id === self) running += 1
    else {
      const d = durationOf(s)
      if (d !== null) took.push(d)
    }
  }
  if (took.length < COMET.minPeers || took.length + hidden < running) return null
  took.sort((a, b) => a - b)
  const mid = took.length >> 1
  const hi = took[mid] as number
  return took.length % 2 === 1 ? hi : ((took[mid - 1] as number) + hi) / 2
}

/** A plain subagent's type: its label up to ' · '. */
export function kindOf(label: string): string {
  const i = label.indexOf(' · ')
  return i < 0 ? label : label.slice(0, i)
}

/** A plain subagent's pace: the group pools the whole session, so only its fan-out (same type, within `batchMs`) counts. */
export function subagentPaceOf(agent: SkyAgent, group: readonly SkyAgent[]): number | null {
  const start = agent.startedAt
  if (start === null) return null
  const kind = kindOf(agent.label)
  const batch = group.filter(s => s.startedAt !== null && Math.abs(s.startedAt - start) <= COMET.batchMs && kindOf(s.label) === kind)
  return paceOf(batch, 0, agent.id)
}

/** The pace for each agent of one list, computed lazily: once for running agents, per agent otherwise. */
export function pacer(siblings: readonly SkyAgent[], hidden = 0, isSubagents = false): (agent: SkyAgent) => number | null {
  let shared: number | null | undefined
  return agent => {
    if (isSubagents) return subagentPaceOf(agent, siblings)
    if (agent.status !== 'running') return paceOf(siblings, hidden, agent.id)
    if (shared === undefined) shared = paceOf(siblings, hidden)
    return shared
  }
}

/** Running time (or duration, once finished) over the floored pace; null when unknown. `now` is epoch ms. */
export function latenessAt(agent: SkyAgent, paceMs: number | null, now: number): number | null {
  if (agent.startedAt === null || paceMs === null) return null
  const pace = Math.max(paceMs, COMET.floorMs)
  if (agent.status === 'running') return Math.max(0, now - agent.startedAt) / pace
  const took = durationOf(agent)
  return took === null ? null : took / pace
}

/** How late an agent is against its siblings (a node's agents; it may be among them). */
export const latenessOf = (agent: SkyAgent, siblings: readonly SkyAgent[], now: number): number | null =>
  latenessAt(agent, paceOf(siblings, 0, agent.id), now)

export const isStraggler = (lateness: number | null): lateness is number => lateness !== null && lateness >= COMET.from

/** The tail's length in cells: none below `from`, then growing evenly with lateness to `maxLen` at `full`. */
export function tailLength(lateness: number | null): number {
  if (!isStraggler(lateness)) return 0
  const k = clamp01((lateness - COMET.from) / (COMET.full - COMET.from))
  return Math.round(COMET.minLen + (COMET.maxLen - COMET.minLen) * k)
}

// ---------------------------------------------------------------- drawing

/** What a comet's drawing needs besides its lateness and the frame clock. */
export type CometDraw = {
  /** Ms since the Client first saw this comet; Infinity draws it settled. */
  age?: number
  /** Varies the dust and the shimmer per agent: draw.tsx's seedOf(agent.id). */
  seed?: number
  /** Ms since the agent finished: the tail scatters for `exitMs`, then is gone. */
  gone?: number | null
}

/** Where the heavy streak tapers to a light line, and where the line frays into dust, along the tail. */
const HEAVY = 0.3
const LIGHT = 0.5
/** The dimmest the tail fades to, as a share of the way from HEX.rail to its head's color. */
const FLOOR = 0.3

/** Braille dot bits of a cell's 4×2 dots, row by row: [row * 2 + column]. */
const DOT = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80]

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/**
 * One cell of drifting dust as braille: dense on the middle rows near the streak, thinning toward the
 * tip. `v` is how far into the spray (0..1); `thin` scales the odds; `push` blows it further out.
 */
function dust(k: number, v: number, t: number, seed: number, thin = 1, push = 0): string {
  const drift = Math.floor(t / DRIFT_MS) + push
  const middle = (0.12 + 0.78 * (1 - v) ** 0.8) * thin
  const outer = (0.04 + 0.64 * v * (1 - v)) * thin
  let bits = 0
  for (let col = 0; col < 2; col++) {
    // The field shifts a dot column per DRIFT_MS; each grain keeps its place in it.
    const x = 2 * k + col - drift
    for (let row = 0; row < 4; row++) {
      const odds = row === 1 || row === 2 ? middle : outer
      if ((hash(x * 4 + row + seed * 131) % 1000) / 1000 < odds) bits |= DOT[row * 2 + col] ?? 0
    }
  }
  return bits === 0 ? ' ' : String.fromCodePoint(0x2800 + bits)
}

const zoneOf = (u: number) => (u < HEAVY ? 0 : u < LIGHT ? 1 : 2)

/**
 * A comet's tail, exactly `n` cells from the label: a heavy streak tapering to a line that frays into
 * dust. Blank cells keep the tail's color so it merges into few runs.
 */
export function cometTail(n: number, lateness: number, t: number, draw: CometDraw = {}): Cell[] {
  const { age = Number.POSITIVE_INFINITY, seed = 0, gone = null } = draw
  const out: Cell[] = []
  if (n <= 0) return out
  const heat = clamp01((lateness - COMET.from) / (COMET.full - COMET.from))
  const shown = age >= COMET.unrollMs ? n : Math.max(1, Math.round(n * ease.outCubic(clamp01(age / COMET.unrollMs))))
  const flare = age >= COMET.igniteMs ? 0 : 1 - clamp01(age / COMET.igniteMs)
  const exit = gone === null ? 0 : clamp01(gone / COMET.exitMs)
  const thin = (1 - exit) ** 1.4
  const push = gone === null ? 0 : Math.floor(gone / BLOW_MS)
  const head = mix(HEX.glow, HEX.shine, quantize(heat * 0.6, 3))
  let before = -1
  for (let k = 0; k < n; k++) {
    // Over all `n`, not `shown`: an unrolling tail shows its streak first.
    const u = (k + 0.5) / n
    const zone = zoneOf(u)
    const b = quantize((FLOOR + (1 - FLOOR) * (1 - u) ** 0.9) * (0.8 + 0.2 * heat) * (1 - 0.6 * exit), 6)
    const lit = mix(HEX.rail, head, b)
    const c = flare > 0 ? mix(lit, HEX.shine, quantize(flare * (1 - u), 4)) : lit
    // Breaks from the head outward, all of it by halfway through the exit.
    const isBroken = exit > 0 && u < exit * 2
    let glyph: string
    if (k >= shown) glyph = ' '
    else if (isBroken || (zone === 2 && before === 2)) glyph = dust(k, zone < 2 ? u * 0.4 : (u - LIGHT) / (1 - LIGHT), t, seed, thin, push)
    else if (zone === 0) glyph = '━'
    else if (zone === 1) glyph = before === 0 ? '╾' : '─'
    else glyph = before === 0 ? '╸' : '╴'
    before = zone
    out.push({ t: glyph, c })
  }
  return out
}

/** A straggler's label as the comet's lit body: warmed toward the glow under the running shimmer; one cell per character. */
export function cometLabel(text: string, lateness: number, t: number, draw: CometDraw = {}): Cell[] {
  const { age = Number.POSITIVE_INFINITY, seed = 0, gone = null } = draw
  const heat = clamp01((lateness - COMET.from) / (COMET.full - COMET.from))
  const flare = age >= COMET.igniteMs ? 0 : 1 - clamp01(age / COMET.igniteMs)
  const exit = gone === null ? 0 : clamp01(gone / COMET.exitMs)
  const base = mix(HEX.ink, HEX.glow, quantize((0.3 + 0.25 * heat + 0.2 * flare) * (1 - exit), 6))
  const chars = [...text]
  return chars.map((ch, i) => {
    const lit = gone === null ? quantize(shimmer(i, chars.length, t + (seed % 1300)), 5) : 0
    return { t: ch, c: lit > 0.1 ? mix(base, HEX.shine, lit) : base }
  })
}

/** What fills the space between an agent row's left part (rails, connector, glyph) and its right part. */
export type CometMiddle = {
  /** The label, cut to leave the tail room. */
  label: string
  /** One cell per column: a space, the tail, then at least AIR spaces. */
  tail: Cell[]
}

const width = (s: string) => [...s].length

/** draw.tsx's cut: `s` in at most `room` cells, ending '…' when cut short. */
function cut(s: string, room: number): string {
  const chars = [...s]
  if (room <= 0) return ''
  return chars.length <= room ? s : `${chars.slice(0, Math.max(0, room - 1)).join('')}…`
}

const blanks = (n: number): Cell[] => Array.from({ length: Math.max(0, n) }, () => ({ t: ' ' }))

/** A row's middle, `middle` cells wide, laid out as draw.tsx's row() does but with the tail after the label. */
export function cometMiddle(label: string, middle: number, lateness: number | null, t: number, draw: CometDraw = {}): CometMiddle {
  const plain = cut(label, middle - 1)
  const isGone = draw.gone !== undefined && draw.gone !== null && draw.gone >= COMET.exitMs
  const want = isGone ? 0 : tailLength(lateness)
  const room = (text: string) => middle - width(text) - 1 - AIR
  let text = plain
  if (want > 0 && room(text) < Math.min(want, CUT_CAP) && width(text) > LABEL_KEEP) {
    const keep = Math.max(LABEL_KEEP, Math.ceil(width(plain) * KEEP_SHARE))
    text = cut(label, Math.max(keep, middle - 1 - AIR - Math.min(want, CUT_CAP)))
  }
  const n = Math.min(want, room(text))
  if (!isStraggler(lateness) || n < MIN_SHOWN) return { label: plain, tail: blanks(Math.max(1, middle) - width(plain)) }
  const tail = cometTail(n, lateness, t, draw)
  const lead: Cell = tail[0]?.c ? { t: ' ', c: tail[0].c } : { t: ' ' }
  return { label: text, tail: [lead, ...tail, ...blanks(middle - width(text) - 1 - n)] }
}
