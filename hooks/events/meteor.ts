// Meteor shower: each failed or denied tool call falls across the band of sky as
// a meteor, and one agent's failures share a radiant. Detection runs in the hooks
// module on epoch time; drawing in the Client on its frame clock.

import type { Cell } from '../skies'
import { HEX, clamp01, ease, mix, quantize } from '../motion'

// ---------------------------------------------------------------- detection (hooks module, epoch ms)

/** How far back failures count: the sliding minute. */
export const WINDOW_MS = 60_000
/** The most failures the ring keeps; a burst past it keeps its newest. */
export const RING_CAP = 64
/** The most failures the sky's props carry: enough for a storm, small beside the props budget. */
export const PROPS_CAP = 40
/** The longest agent label the props carry; the caption cuts it further to fit. */
const WHO_MAX = 24

export type FailureKind = 'error' | 'deny'

/** One failed tool call: its `tool_use_id`, its loop (agent id, null for the main session), when and how. */
export type Failure = { id: string; agent: string | null; at: number; kind: FailureKind }

/** A failure as the props carry it: hashed id and loop (`radiant`), and the agent's label cut to WHO_MAX. */
export type SkyFailure = { id: number; radiant: number; who: string | null; at: number; kind: FailureKind }

/** Results the engine writes when the person stopped the turn or said no: never an agent failing. */
const INTERRUPTED = /^\s*\[?(request )?interrupted by user/i
const REJECTED = /^\s*the user doesn['’]t want to (proceed with this tool use|take this action)/i

/** A tool result's text, whichever shape its content came in. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const t = typeof part === 'object' && part !== null ? (part as { text?: unknown }).text : undefined
    if (typeof t === 'string') text += `${t}\n`
  }
  return text
}

/** The `tool_use_id` of each failed tool_result in a row, leaving out the person's interrupts and refusals. */
export function toolErrorsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const blocks: Record<string, unknown>[] = []
  for (const block of content) if (typeof block === 'object' && block !== null) blocks.push(block as Record<string, unknown>)
  if (blocks.some(b => b.type === 'text' && INTERRUPTED.test(textOf(b.text)))) return []
  const ids: string[] = []
  for (const b of blocks) {
    if (b.type !== 'tool_result' || b.is_error !== true || typeof b.tool_use_id !== 'string') continue
    const text = textOf(b.content)
    if (!INTERRUPTED.test(text) && !REJECTED.test(text)) ids.push(b.tool_use_id)
  }
  return ids
}

/** The ring with `fresh` filed in, oldest first: one entry per call (a deny and its error result merge). */
export function addFailures(ring: readonly Failure[], fresh: readonly Failure[], now: number): Failure[] {
  const byId = new Map<string, Failure>()
  for (const f of [...ring, ...fresh]) {
    const was = byId.get(f.id)
    byId.set(f.id, was ? { ...was, at: Math.min(was.at, f.at), kind: was.kind === 'deny' || f.kind === 'deny' ? 'deny' : 'error' } : f)
  }
  return [...byId.values()]
    .filter(f => now - f.at < WINDOW_MS)
    .sort((a, b) => a.at - b.at)
    .slice(-RING_CAP)
}

/** How many failures fell in the `windowMs` before `now` (exact up to RING_CAP). */
export function rateOf(ring: readonly Failure[], now: number, windowMs = WINDOW_MS): number {
  let n = 0
  for (const f of ring) if (now - f.at < windowMs) n += 1
  return n
}

/** Failures in the window per loop: an agent's id, or `main` for the main session. */
export function perAgent(ring: readonly Failure[], now: number, windowMs = WINDOW_MS): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of ring) if (now - f.at < windowMs) out[f.agent ?? 'main'] = (out[f.agent ?? 'main'] ?? 0) + 1
  return out
}

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

const seedOf = (key: string) => [...key].reduce((h, ch) => hash(h + (ch.codePointAt(0) ?? 0)), 7)

const cut = (text: string, most: number) => {
  const chars = [...text]
  return chars.length <= most ? text : `${chars.slice(0, Math.max(0, most - 1)).join('')}…`
}

/** The failures the sky's props carry: the window's newest PROPS_CAP, small, each with its agent's label. */
export function showerProps(ring: readonly Failure[], now: number, labelOf: (agentId: string) => string | null): SkyFailure[] {
  return ring
    .filter(f => now - f.at < WINDOW_MS)
    .slice(-PROPS_CAP)
    .map(f => {
      const label = f.agent === null ? null : labelOf(f.agent)
      return { id: seedOf(f.id), radiant: seedOf(f.agent ?? 'main'), who: label === null ? null : cut(label, WHO_MAX), at: f.at, kind: f.kind }
    })
}

// ---------------------------------------------------------------- the Client's clock

/** A failure first seen later than this after it happened counts, but no longer streaks. */
export const FRESH_MS = 5_000
/** Failures arrive in once-a-second batches: a meteor waits out its second, so a batch keeps its rhythm. */
const LAG_MS = 1_000

/** When a failure first seen at `t` launches on the frame clock; `nowEpoch` is the epoch time at `t`. */
export function launchAt(t: number, nowEpoch: number, f: Pick<SkyFailure, 'id' | 'at'>): number {
  const age = Math.max(0, nowEpoch - f.at)
  if (age > FRESH_MS) return t - age
  return t + Math.max(0, LAG_MS - age) + (f.id % 80)
}

/** One meteor: its failure's id (which seeds its look), launch time on the frame clock, radiant, kind and agent. */
export type Meteor = { id: number; t0: number; radiant: number; kind: FailureKind; who: string | null }

/** The meteor of a failure that launches at `t0`. */
export const meteorOf = (f: SkyFailure, t0: number): Meteor => ({ id: f.id, t0, radiant: f.radiant, kind: f.kind, who: f.who })

/** The Client's meteors for the props' failures at `t`; `seen` itself while unchanged, so a frame allocates nothing. */
export function meteorsFor(seen: readonly Meteor[], failures: readonly SkyFailure[], t: number, nowEpoch: number): readonly Meteor[] {
  if (seen.length === failures.length && failures.every((f, i) => seen[i]?.id === f.id && seen[i]?.who === f.who)) return seen
  const byId = new Map<number, Meteor>()
  for (const m of seen) byId.set(m.id, m)
  return failures.map(f => {
    const was = byId.get(f.id)
    if (!was) return meteorOf(f, launchAt(t, nowEpoch, f))
    return was.who === f.who ? was : { ...was, who: f.who }
  })
}

// ---------------------------------------------------------------- drawing (Client, frame clock)

/** How long a meteor's head takes per cell, at its slowest; each meteor is up to a third faster. */
const STEP_MS = 70
/** How long the train glows after the head burns out. */
const FADE_MS = 460
/** The longest a failure's meteor lives: its longest flight plus its fade. */
export const METEOR_MS = 10 * STEP_MS + FADE_MS
/** The longest a background meteor lives. */
const AMBIENT_MS = 5 * STEP_MS + FADE_MS
/** The background shower's beat: each slot may launch one faint meteor. */
const SLOT_MS = 60

/** For a still drawing (frame time 0): every failure already fallen, counted but not streaking. */
export const settledMeteors = (failures: readonly SkyFailure[], nowEpoch: number): Meteor[] =>
  failures.map(f => meteorOf(f, Math.min(f.at - nowEpoch, -METEOR_MS)))

/** Each kind's colors from hot head to the dark its train fades into: rose-red for an error, amber for a deny. */
const RAMP: Record<FailureKind, { head: string; body: string; ash: string }> = {
  error: { head: '#fff0f3', body: HEX.hot, ash: '#3d1520' },
  deny: { head: '#fff6e2', body: HEX.warn, ash: '#3a2610' },
}

/** A meteor's color at brightness `b` (0..1), in seven steps so neighboring cells share one Text. */
function colorOf(kind: FailureKind, b: number): string {
  const r = RAMP[kind]
  const q = quantize(b, 6)
  return q <= 0.5 ? mix(r.ash, r.body, q / 0.5) : mix(r.body, r.head, (q - 0.5) / 0.5)
}

/** How hard it rains at `s`: each failure weighs 1 when fresh, fading to 0 at a minute old. */
export function intensityAt(meteors: readonly Meteor[], s: number): number {
  let sum = 0
  for (const m of meteors) {
    const age = s - m.t0
    if (age >= 0 && age < WINDOW_MS) sum += 1 - age / WINDOW_MS
  }
  return sum
}

/** Faint meteors a second at `intensity`: none for a failure or two, about three a second for a fresh dozen, nine at most in a storm. */
const ambientRate = (intensity: number) => Math.min(9, Math.max(0, 0.3 * (intensity - 2)))

/** How far a shower has grown toward a storm: 0 for two failures or fewer, 1 at about twenty fresh ones. */
const growth = (intensity: number) => clamp01((intensity - 2) / 20)

/** Characters of words a band may hold (the sparkline's `2 live`, `$0.31/min`): meteors pass behind them. */
const TEXT = /[\p{L}\p{N}$./]/u
/** Block elements (the sparkline's bars): solid things a meteor passes behind too. */
const SOLID = /[▀-▟]/u

const isWord = (cell: Cell | undefined) => cell !== undefined && TEXT.test(cell.t)

/** Writes `cell` at (x, y) unless a word, a bar or a word's neighbour is there, so words keep a space either side. */
function put(grid: Cell[][], x: number, y: number, cell: Cell) {
  const row = grid[y]
  const was = row?.[x]
  if (!row || !was || TEXT.test(was.t) || SOLID.test(was.t)) return
  if (isWord(row[x - 1]) || isWord(row[x + 1])) return
  row[x] = cell
}

/** Horizontal scan lines, top of the cell to its foot: a meteor falls through them in a band one or two rows tall. */
const SCAN = ['⎺', '⎻', '─', '⎼', '⎽'] as const

const unit = (n: number) => (n % 1000) / 1000

/** How a meteor flies: its length in cells, its brightness, how far from its radiant it may stray (0..1), and whether it is a failure's own. */
type Flight = { len: number; gain: number; spread: number; isOwn: boolean }

/** A meteor's length: a failure's own is longer than a background one; in a short band it runs further along the row. */
function lengthOf(h: number, w: number, id: number, isOwn: boolean): number {
  const [few, most] = h >= 3 ? (isOwn ? [3, Math.min(6, h)] : [2, Math.min(4, h)]) : isOwn ? (h === 1 ? [6, 10] : [5, 9]) : [3, 6]
  const top = Math.max(2, Math.min(most, w - 2))
  const lo = Math.min(few, top)
  return lo + (id % (top - lo + 1))
}

/**
 * Draws one meteor `age` ms into its life: diagonal in a band three rows or taller, through the scan
 * lines otherwise. Its radiant sets its direction and region; its id sets the rest.
 */
function streak(grid: Cell[][], age: number, m: Meteor, f: Flight) {
  const h = grid.length
  const w = grid[0]?.length ?? 0
  const dir = m.radiant % 2 === 0 ? 1 : -1
  const isSteep = h >= 3
  const len = f.len
  // Each direction keeps to its half of the band, so two showers never cross; the harder it rains,
  // the further a meteor strays from its radiant's stretch.
  const lo = dir > 0 ? 0.5 : 0
  const home = lo + 0.5 * (0.3 + 0.4 * unit(m.radiant >>> 5)) + (unit(m.id >>> 9) - 0.5) * 0.34
  const anywhere = lo + 0.5 * unit(m.id >>> 19)
  const pos = Math.min(lo + 0.5, Math.max(lo, home + (anywhere - home) * f.spread))
  const x0 = Math.round(pos * Math.max(0, w - len)) + (dir < 0 ? len - 1 : 0)
  // Steep: a row a cell. Shallow: a scan level every `run` cells, five levels a row.
  const run = h === 1 ? 2 : 1
  const y0 = isSteep ? (m.id >>> 4) % (h - len + 1) : 0
  const lv0 = isSteep ? 0 : (m.id >>> 4) % (5 * h - Math.ceil(len / run) + 1)
  const step = STEP_MS * (0.7 + 0.3 * (((m.id >>> 13) % 100) / 100))
  const flight = (len - 1) * step
  const head = Math.min(len - 1, age / step)
  const fade = clamp01((age - flight) / FADE_MS)
  const flare = ease.outCubic(clamp01(age / 90)) * f.gain
  for (let k = Math.floor(head); k >= 0; k--) {
    const d = head - k
    const b = flare * Math.exp(-d / (isSteep ? 2.4 : 3.2)) * clamp01(1 - fade * (1 + (0.9 * d) / len))
    if (b < 0.08) continue
    const x = x0 + dir * k
    const lv = lv0 + Math.floor(k / run)
    const y = isSteep ? y0 + k : Math.floor(lv / 5)
    if (f.isOwn && k === len - 1 && fade > 0) {
      if (fade < 0.35) put(grid, x, y, { t: fade < 0.15 ? '✦' : '✧', c: colorOf(m.kind, Math.min(1, flare * (1.1 - fade))), bold: fade < 0.15 })
      continue
    }
    put(grid, x, y, { t: isSteep ? (dir > 0 ? '╲' : '╱') : SCAN[lv % 5] ?? '─', c: colorOf(m.kind, b) })
  }
}

/** The meteor of the window at `s` that `roll` lands on, without building a list. */
function pick(meteors: readonly Meteor[], s: number, roll: number): Meteor | null {
  let n = 0
  for (const m of meteors) if (m.t0 <= s && s - m.t0 < WINDOW_MS) n += 1
  if (n === 0) return null
  let i = roll % n
  for (const m of meteors) {
    if (!(m.t0 <= s && s - m.t0 < WINDOW_MS)) continue
    if (i === 0) return m
    i -= 1
  }
  return null
}

/**
 * Writes the shower onto the band's grid (its left part, a character a cell) at `t` and returns it:
 * background meteors on seen radiants, then each failure's own. Rows keep their width; words stay.
 */
export function meteorOverlay(grid: Cell[][], t: number, meteors: readonly Meteor[]): Cell[][] {
  const h = grid.length
  const w = grid[0]?.length ?? 0
  if (h === 0 || w < 6 || meteors.length === 0) return grid
  for (let k = Math.floor((t - AMBIENT_MS) / SLOT_MS); k <= Math.floor(t / SLOT_MS); k++) {
    const s = k * SLOT_MS
    const t0 = s + (hash(k + 5) % SLOT_MS)
    if (t < t0) continue
    const intensity = intensityAt(meteors, s)
    const chance = (ambientRate(intensity) * SLOT_MS) / 1000
    if (chance <= 0 || hash(k * 2_654_435 + 17) % 10_000 >= chance * 10_000) continue
    const from = pick(meteors, s, hash(k + 3))
    if (!from) continue
    const id = hash(k * 31 + 7)
    const g = growth(intensity)
    streak(grid, t - t0, { ...from, id, t0 }, { len: lengthOf(h, w, id, false), gain: 0.55 + 0.35 * g, spread: 0.2 + 0.8 * g, isOwn: false })
  }
  for (const m of meteors) {
    const age = t - m.t0
    // Own meteors stray further, so a burst reads as many streaks, not one.
    if (age >= 0 && age < METEOR_MS) streak(grid, age, m, { len: lengthOf(h, w, m.id, true), gain: 1, spread: 0.4 + 0.6 * growth(intensityAt(meteors, m.t0)), isOwn: true })
  }
  return grid
}

/** A band row of merged runs split back into one cell a character, for meteorOverlay. */
export function cellsOf(row: readonly Cell[]): Cell[] {
  const out: Cell[] = []
  for (const cell of row) for (const ch of cell.t) out.push({ ...cell, t: ch })
  return out
}

/** Whether any failure is in the minute: the band needs the overlay, and the caption shows, only then. */
export const isRaining = (meteors: readonly Meteor[], t: number) => meteors.some(m => t - m.t0 >= 0 && t - m.t0 < WINDOW_MS)

/** Whether a meteor is due or falling at `t`: the frame clock stays fast while it holds. */
export function isFalling(meteors: readonly Meteor[], t: number): boolean {
  for (const m of meteors) if (t - m.t0 < METEOR_MS) return true
  return ambientRate(intensityAt(meteors, t - AMBIENT_MS)) > 0
}

/** Failures in the minute that make it a shower, and a storm. */
const SHOWER_AT = 3
const STORM_AT = 15
/** The caption's quiet color (about the rails' brightness) and the one it lights to when a failure falls. */
const WORDS: Record<FailureKind, { calm: string; lit: string }> = {
  error: { calm: '#a47284', lit: '#f88695' },
  deny: { calm: '#9c8466', lit: '#eeb062' },
}
/** How long the caption stays lit after a failure falls. */
const LIT_MS = 1_200

/** The shower named in at most `room` cells (`a meteor shower from scan-api`), lit as each failure falls; null when none. */
export function showerCaption(meteors: readonly Meteor[], t: number, room: number): Cell | null {
  let n = 0
  let denied = 0
  let newest = Number.POSITIVE_INFINITY
  const byWho = new Map<string, number>()
  for (const m of meteors) {
    const age = t - m.t0
    if (age < 0 || age >= WINDOW_MS) continue
    n += 1
    if (m.kind === 'deny') denied += 1
    newest = Math.min(newest, age)
    if (m.who !== null) byWho.set(m.who, (byWho.get(m.who) ?? 0) + 1)
  }
  if (n === 0) return null
  let top: string | null = null
  let most = 0
  for (const [who, k] of byWho) {
    if (k > most) {
      top = who
      most = k
    }
  }
  const name = n >= STORM_AT ? 'a meteor storm' : n >= SHOWER_AT ? 'a meteor shower' : n === 2 ? 'sporadic meteors' : 'a sporadic meteor'
  if (name.length > room) return null
  const from = top !== null && most / n >= 0.6 ? ` from ${top}` : ''
  const spare = room - name.length - ' from '.length
  const text = [...from].length <= room - name.length ? `${name}${from}` : from && spare >= 5 ? `${name} from ${cut(top ?? '', spare)}` : name
  const words = denied === n ? WORDS.deny : WORDS.error
  return { t: text, c: mix(words.calm, words.lit, quantize(1 - newest / LIT_MS, 4)) }
}

// ---------------------------------------------------------------- the demo's failures

type DemoFailure = { at: number; agent: string; kind: FailureKind }

/** The failures `/constellation demo` plays, in seconds, on hooks/demo.ts's agents. */
const DEMO: readonly DemoFailure[] = [
  { at: 10.4, agent: 'demo-long-a', kind: 'error' },
  { at: 15.0, agent: 'demo-push', kind: 'deny' },
  { at: 15.7, agent: 'demo-push', kind: 'error' },
  { at: 16.1, agent: 'demo-push', kind: 'error' },
  { at: 16.3, agent: 'demo-push', kind: 'error' },
  { at: 17.2, agent: 'demo-long-b', kind: 'error' },
  { at: 17.9, agent: 'demo-push', kind: 'error' },
  { at: 18.4, agent: 'demo-push', kind: 'error' },
  { at: 19.6, agent: 'demo-push', kind: 'deny' },
  { at: 21.5, agent: 'demo-push', kind: 'error' },
]

/** The demo's failures that happen in [fromMs, toMs) of a demo started at `startedAt` (epoch ms). */
export function demoFailures(startedAt: number, fromMs: number, toMs: number): Failure[] {
  return DEMO.filter(d => d.at * 1000 >= fromMs && d.at * 1000 < toMs).map(d => ({
    id: `demo-fail-${startedAt}-${d.at}`,
    agent: d.agent,
    at: startedAt + d.at * 1000,
    kind: d.kind,
  }))
}
