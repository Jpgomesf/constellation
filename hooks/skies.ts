// The band of sky above the tree, in five styles, each a pure function of time
// and what the sky has seen. Imports only motion.ts, so a surface module can carry it.

import type { SkyAgent, SkyNode, SkyRun } from './core'
import { HEX, breathe, clamp01, ease, mix, progress, quantize, twinkle } from './motion'

export type SkyStyle = 'stars' | 'shooting' | 'map' | 'parallax' | 'spark'

export const SKY_STYLES: readonly SkyStyle[] = ['stars', 'shooting', 'map', 'parallax', 'spark']

export const SKY_NAMES: Record<SkyStyle, string> = {
  stars: 'stars',
  shooting: 'shooting stars',
  map: 'constellation map',
  parallax: 'parallax drift',
  spark: 'activity sparkline',
}

/** A streak across the band, launched when an agent finishes. */
export type Shot = { t0: number; seed: number }

/** A twice-a-second sample: agents running and the cost so far. */
export type Sample = { t: number; live: number; cost: number }

/** One cell of the band: a character, its color and an optional background. */
export type Cell = { t: string; c?: string; bg?: string; bold?: boolean }

type Grid = Cell[][]

const blank = (w: number, h: number): Grid => Array.from({ length: h }, () => Array.from({ length: w }, () => ({ t: ' ' })))

function put(g: Grid, x: number, y: number, cell: Cell) {
  const row = g[y]
  if (row && x >= 0 && x < row.length) row[x] = { ...row[x], ...cell }
}

/** Merges neighboring cells of one color into runs, so a row is a handful of Texts. */
export function runsOf(row: readonly Cell[]): Cell[] {
  const out: Cell[] = []
  for (const cell of row) {
    const last = out.at(-1)
    if (last && last.c === cell.c && last.bg === cell.bg && last.bold === cell.bold) last.t += cell.t
    else out.push({ ...cell })
  }
  return out
}

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

const seedOf = (key: string) => [...key].reduce((h, ch) => hash(h + (ch.codePointAt(0) ?? 0)), 7)

/** A star's glyph for its brightness: a dot when dim, a four-pointed star at its brightest. */
const starGlyph = (b: number) => (b < 0.2 ? '·' : b < 0.45 ? '∙' : b < 0.75 ? '✧' : '✦')

/** Evenly spread stars: at most one per `cell` columns, jittered inside it, a quarter of the cells dark. */
function scatter(g: Grid, t: number, seed: number, cell: number, rows: number[], offset = 0) {
  const w = g[0]?.length ?? 0
  const span = w + cell
  for (let k = 0; k * cell < span; k++) {
    const h = hash(k * 7919 + seed * 104_729)
    if (h % 4 === 0) continue
    const x = (((k * cell + 1 + (h % (cell - 2)) - offset) % span) + span) % span
    const y = rows[h % rows.length] ?? 0
    const b = quantize(twinkle(t, h), 8)
    put(g, x, y, { t: starGlyph(b), c: mix(HEX.dim, h % 3 === 0 ? HEX.glow : HEX.star, 0.25 + 0.75 * b) })
  }
}

// ---------------------------------------------------------------- the styles

/** The plain style: one row of twinkling stars. */
function stars(w: number, t: number): Grid {
  const g = blank(w, 1)
  scatter(g, t, 1, 7, [0])
  return g
}

const SHOT_MS = 1100

/** Shooting stars: a streak whenever an agent finishes, and now and then while work runs. */
function shooting(w: number, t: number, shots: readonly Shot[], isLive: boolean): Grid {
  const h = 3
  const g = blank(w, h)
  scatter(g, t, 2, 9, [0, 1, 2])
  const ambient: Shot[] = isLive ? [{ t0: Math.floor(t / 4700) * 4700, seed: Math.floor(t / 4700) }] : []
  for (const shot of [...ambient, ...shots]) {
    const age = t - shot.t0
    if (age < 0 || age > SHOT_MS) continue
    const span = Math.max(12, Math.round(w * 0.55))
    const x0 = hash(shot.seed) % Math.max(1, w - span)
    const leftward = hash(shot.seed + 1) % 2 === 0
    // The cell `along` columns into the streak, which drops a row each third of its span.
    const cellAt = (along: number) => ({ x: leftward ? x0 + span - along : x0 + along, y: Math.min(h - 1, Math.floor((along / span) * h)) })
    const p = age / SHOT_MS
    const fade = 1 - clamp01((p - 0.75) / 0.25)
    const head = Math.round(ease.outCubic(p) * span)
    const tail = 10
    for (let k = tail; k >= 1; k--) {
      if (head - k < 0) continue
      const { x, y } = cellAt(head - k)
      const glow = (1 - k / (tail + 1)) * fade
      put(g, x, y, { t: k <= 3 ? '━' : k <= 7 ? '─' : '·', c: mix(HEX.dim, HEX.glow, quantize(glow, 8)) })
    }
    const at = cellAt(head)
    put(g, at.x, at.y, { t: '✦', c: mix(HEX.dim, HEX.shine, quantize(fade, 6)), bold: true })
  }
  return g
}

/** Every agent of a run, in start order: its own agents first, then its child workflows'. */
function agentsOf(r: SkyRun): SkyAgent[] {
  const walk = (n: SkyNode): SkyAgent[] => [...n.agents, ...n.children.flatMap(walk)]
  return [...r.nodes.flatMap(walk), ...r.loose]
}

/** Dots along the line from (x0, y0) to (x1, y1), its ends left out. */
function dotted(g: Grid, x0: number, y0: number, x1: number, y1: number, c: string) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  for (let i = 2; i < steps - 1; i += 2) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps)
    const y = Math.round(y0 + ((y1 - y0) * i) / steps)
    if (g[y]?.[x]?.t === ' ') put(g, x, y, { t: '·', c })
  }
}

/** A constellation map of the newest run: a star per agent, joined in start order, a link lit once both ends finish. */
function map(w: number, t: number, run: SkyRun | null, doneAt: (id: string) => number | null): Grid {
  const h = 5
  const g = blank(w, h)
  scatter(g, t, 3, 11, [0, 4])
  if (!run) return g
  const agents = agentsOf(run).slice(0, Math.max(1, Math.floor(w / 4)))
  const n = agents.length
  const spots = agents.map((a, i) => {
    const s = seedOf(a.id)
    return { a, x: Math.round(((i + 0.5) * (w - 2)) / n) + ((s % 3) - 1), y: s % h }
  })
  spots.forEach((s, i) => {
    const prev = spots[i - 1]
    if (!prev) return
    const isLit = prev.a.status !== 'running' && s.a.status !== 'running'
    dotted(g, prev.x, prev.y, s.x, s.y, isLit ? mix(HEX.rail, HEX.star, 0.55) : HEX.dim)
  })
  for (const s of spots) {
    if (s.a.status === 'running') {
      const swell = quantize(breathe(t, 1300, (seedOf(s.a.id) % 100) / 100), 6)
      put(g, s.x, s.y, { t: swell > 0.5 ? '✦' : '✧', c: mix(HEX.live, HEX.glow, swell), bold: true })
    } else if (s.a.status === 'failed') {
      put(g, s.x, s.y, { t: '✗', c: '#ff6b80', bold: true })
    } else {
      const since = doneAt(s.a.id)
      const flash = since === null ? 1 : progress(t, since, 900)
      put(g, s.x, s.y, { t: '✦', c: mix(HEX.shine, HEX.star, quantize(flash, 6)), bold: flash < 1 })
    }
  }
  return g
}

/** Parallax drift: a far field creeping by and a near one passing faster, the way a window moves past the stars. */
function parallax(w: number, t: number): Grid {
  const h = 3
  const g = blank(w, h)
  const far = Math.floor(t / 900)
  const near = Math.floor(t / 300)
  scatter(g, t, 4, 5, [0, 1, 2], far)
  const w2 = w + 12
  for (let k = 0; k * 12 < w2; k++) {
    const s = hash(k * 31 + 5)
    if (s % 3 === 0) continue
    const x = (((k * 12 + (s % 8) - near) % w2) + w2) % w2
    const b = quantize(0.55 + 0.45 * twinkle(t, s), 6)
    put(g, x, s % h, { t: b > 0.8 ? '✦' : '✧', c: mix(HEX.dim, HEX.shine, b), bold: b > 0.8 })
  }
  return g
}

/** Eighth blocks, empty to full: solid in any font, where braille draws as speckles. */
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** An activity sparkline: running agents per sample over two rows, with the spend per minute beside it. */
function spark(w: number, samples: readonly Sample[]): Grid {
  const h = 2
  const g = blank(w, h)
  const room = w - 16
  const recent = samples.slice(-room)
  const top = Math.max(1, ...recent.map(s => s.live))
  recent.forEach((s, i) => {
    const level = Math.round((s.live / top) * 16)
    const x = room - recent.length + i
    const c = mix(HEX.live, HEX.glow, quantize(level / 16, 6))
    put(g, x, 1, level === 0 ? { t: '▁', c: HEX.dim } : { t: BLOCKS[Math.min(8, level)] ?? ' ', c })
    if (level > 8) put(g, x, 0, { t: BLOCKS[level - 8] ?? ' ', c })
  })
  const last = samples.at(-1)
  const back = samples.find(s => last && last.t - s.t <= 30_000)
  const perMinute = last && back && last.t > back.t ? ((last.cost - back.cost) / (last.t - back.t)) * 60_000 : 0
  const label = [`${last?.live ?? 0} live`, `$${perMinute.toFixed(2)}/min`]
  label.forEach((text, y) => [...text.padStart(14, ' ')].forEach((ch, k) => put(g, w - 14 + k, y, { t: ch, c: y === 0 ? HEX.glow : HEX.rail })))
  return g
}

/** The band for a style: rows of cell runs, sized to `w` columns. */
export function skyBand(
  style: SkyStyle,
  w: number,
  t: number,
  run: SkyRun | null,
  isLive: boolean,
  shots: readonly Shot[],
  samples: readonly Sample[],
  doneAt: (id: string) => number | null,
): Cell[][] {
  const grid =
    style === 'shooting'
      ? shooting(w, t, shots, isLive)
      : style === 'map'
        ? map(w, t, run, doneAt)
        : style === 'parallax'
          ? parallax(w, t)
          : style === 'spark'
            ? spark(w, samples)
            : stars(w, t)
  return grid.map(runsOf)
}
