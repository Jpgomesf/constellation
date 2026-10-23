// The session's context window as a dying star: it swells and reddens as the
// window fills and goes supernova on compaction, leaving a nebula ring. Drawn in
// half blocks so it is round; pure in time, importing only motion.ts.

import type { Cell } from './skies'
import { breathe, clamp01, ease, mix, quantize } from './motion'

/** The star's box in cells; its pixels are square (a cell is two tall). */
export const STAR_W = 22
export const STAR_H = 6

const NOVA_MS = 2600
const YOUNG_RADIUS = 2.1

/** One stage of a star's life, at a share of the context window. */
type Stage = { at: number; radius: number; core: string; edge: string; unrest: number }

const LIFE: readonly Stage[] = [
  { at: 0, radius: YOUNG_RADIUS, core: '#ffffff', edge: '#8fb8ff', unrest: 0 },
  { at: 30, radius: 2.7, core: '#fffbea', edge: '#ffd166', unrest: 0.05 },
  { at: 60, radius: 4, core: '#ffdcae', edge: '#ff7a3d', unrest: 0.18 },
  { at: 80, radius: 4.8, core: '#ffc48e', edge: '#e0442c', unrest: 0.38 },
  { at: 92, radius: 5.2, core: '#fff0dc', edge: '#b0201b', unrest: 0.62 },
  { at: 100, radius: 5.5, core: '#fff6ea', edge: '#8c1414', unrest: 0.8 },
]

function stageAt(pct: number): Stage {
  const p = Math.max(0, Math.min(100, pct))
  const i = Math.max(0, LIFE.findIndex(s => s.at > p) - 1)
  const a = LIFE[i] as Stage
  const b = LIFE[Math.min(LIFE.length - 1, i + 1)] as Stage
  const k = b.at === a.at ? 0 : (p - a.at) / (b.at - a.at)
  return {
    at: p,
    radius: a.radius + (b.radius - a.radius) * k,
    core: mix(a.core, b.core, k),
    edge: mix(a.edge, b.edge, k),
    unrest: a.unrest + (b.unrest - a.unrest) * k,
  }
}

/** What the star is going through, in words, and the color to say it in. */
export function starStage(pct: number | null, isNova: boolean, isReborn = false): { name: string; color: string } {
  if (isNova) return { name: 'supernova · reborn', color: '#c9b6ff' }
  if (pct === null && isReborn) return { name: 'a newborn star', color: '#8fb8ff' }
  if (pct === null) return { name: 'a protostar · waiting for the first answer', color: '#8a7fb0' }
  const s = stageAt(pct)
  if (pct < 30) return { name: 'a young star', color: s.edge }
  if (pct < 60) return { name: 'a steady star', color: s.edge }
  if (pct < 80) return { name: 'swelling · red giant', color: s.edge }
  if (pct < 92) return { name: 'unstable · shedding', color: s.edge }
  return { name: 'dying · compact soon', color: '#ff6b80' }
}

/** The star's radius in pixels at `pct`, without the per-frame swell (what an eclipse covers). */
export const starRadius = (pct: number | null) => stageAt(pct ?? 0).radius

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

const unit = (n: number) => (hash(n) % 10_000) / 10_000

/** Value noise in -1..1 that drifts smoothly over time: a star's boiling surface. */
function boil(x: number, y: number, t: number): number {
  const slice = t / 320
  const k = Math.floor(slice)
  const f = ease.inOutSine(slice - k)
  const at = (s: number) => unit(x * 7349 + y * 1597 + s * 92821) * 2 - 1
  return at(k) + (at(k + 1) - at(k)) * f
}

type Pixel = string | null

/** The star's cells for window share `pct` (null before the first answer), the last compaction at `novaAt`, and `deaths` nebula rings. */
export function starCells(
  pct: number | null,
  t: number,
  novaAt: number | null,
  deaths: number,
  isReborn = false,
  w = STAR_W,
  h = STAR_H,
): Cell[][] {
  const pw = w
  const ph = h * 2
  const cx = pw / 2
  const cy = ph / 2
  const px: Pixel[][] = Array.from({ length: ph }, () => Array.from({ length: pw }, () => null))
  const marks: (Cell | null)[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => null))
  const age = novaAt === null ? Number.POSITIVE_INFINITY : t - novaAt
  const isNova = age >= 0 && age < NOVA_MS

  // A nebula ring per past death.
  for (let d = 0; d < Math.min(deaths, 3); d++) {
    const ring = 7.2 + d * 1.6
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2 + d * 0.7
      const x = Math.round(cx + Math.cos(a) * ring)
      const y = Math.floor((cy + Math.sin(a) * ring * 0.62) / 2)
      const shimmer = 0.35 + 0.65 * breathe(t, 3200 + k * 140, k / 18)
      if (marks[y]?.[x] === null) marks[y]![x] = { t: hash(k + d * 31) % 3 === 0 ? '∙' : '·', c: mix('#2a2140', '#8c78c8', quantize(shimmer * (0.8 - d * 0.2), 5)) }
    }
  }

  if (pct === null && !isNova && !isReborn) {
    // Protostar: a dim cloud round a faint spark.
    for (let k = 0; k < 14; k++) {
      const a = unit(k * 13) * Math.PI * 2 + t / 2600
      const r = 1.5 + unit(k * 29) * 4
      const x = Math.round(cx + Math.cos(a) * r * 1.6)
      const y = Math.floor((cy + Math.sin(a) * r) / 2)
      if (marks[y]?.[x] === null) marks[y]![x] = { t: '·', c: mix('#2a2140', '#8a7fb0', quantize(breathe(t, 2200, k / 14), 5)) }
    }
    const y = Math.floor(cy / 2)
    const x = Math.floor(cx)
    if (marks[y]) marks[y]![x] = { t: '∙', c: mix('#5a4f86', '#d8ccff', quantize(breathe(t, 1800), 5)) }
    return compose(px, marks, w, h)
  }

  const life = stageAt(isNova ? 0 : (pct ?? 0))
  const born = isNova ? clamp01((age - 900) / (NOVA_MS - 900)) : 1
  const swell = 1 + 0.05 * Math.sin((t / 1300) * Math.PI * 2) + life.unrest * 0.11 * (Math.sin(t / 370) + Math.sin(t / 530 + 1.3))
  const radius = Math.max(0.6, life.radius * (isNova ? ease.outCubic(born) : 1) * swell)
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (d <= radius) {
        const k = d / radius
        const surface = boil(x, y, t) * (0.08 + life.unrest * 0.32)
        const base = mix(life.core, life.edge, quantize(k ** 1.35, 10))
        const lit = surface >= 0 ? mix(base, life.core, quantize(surface, 8)) : mix(base, '#200808', quantize(-surface, 8))
        px[y]![x] = mix(lit, '#1a0b0b', quantize(Math.max(0, k - 0.82) * 1.6, 6))
      } else if (d <= radius + 1.1 && !isNova) {
        // Corona.
        const flicker = 0.55 + 0.45 * boil(x + 50, y + 50, t * (1 + life.unrest))
        px[y]![x] = mix('#160c10', life.edge, quantize(0.42 * flicker * (1 - (d - radius) / 1.1), 6))
      }
    }
  }

  if (isNova) {
    // Supernova: a flash, then an expanding ring.
    const p = age / NOVA_MS
    // The ring fades before it reaches the box's edge, so no corner stays lit.
    const ringR = 1 + ease.outCubic(p) * (pw / 2 - 1.5)
    const color = p < 0.4 ? mix('#ffffff', '#8fe3ff', p / 0.4) : mix('#8fe3ff', '#7a5cc8', (p - 0.4) / 0.6)
    const fade = 1 - clamp01((p - 0.35) / 0.5)
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const d = Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) * 1.15)
        if (Math.abs(d - ringR) <= 0.9 && fade > 0.05) px[y]![x] = mix('#140c1c', color, quantize(fade, 6))
        if (age < 420 && d <= 3.4 - age / 160) px[y]![x] = '#ffffff'
      }
    }
  } else if (life.unrest > 0.15) {
    // Shedding: specks drifting away.
    const n = Math.round(life.unrest * 12)
    for (let k = 0; k < n; k++) {
      const period = 1900 + (hash(k) % 1300)
      const q = ((t + hash(k + 7) % period) % period) / period
      const a = unit(k * 17 + Math.floor((t + (hash(k + 7) % period)) / period) * 3) * Math.PI * 2
      const r = radius + 1 + q * (pw / 2 - radius)
      const x = Math.round(cx + Math.cos(a) * r)
      const y = Math.floor((cy + Math.sin(a) * r * 0.9) / 2)
      if (marks[y]?.[x] === null && px[y * 2]?.[x] == null && px[y * 2 + 1]?.[x] == null) {
        marks[y]![x] = { t: q < 0.35 ? '∙' : '·', c: mix(life.edge, '#2a1414', quantize(q, 6)) }
      }
    }
  }
  return compose(px, marks, w, h)
}

/** Folds pixel pairs into half-block cells; a cell with no pixel shows its mark, else stays empty. */
function compose(px: Pixel[][], marks: (Cell | null)[][], w: number, h: number): Cell[][] {
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x): Cell => {
      const top = px[y * 2]?.[x] ?? null
      const bottom = px[y * 2 + 1]?.[x] ?? null
      if (top && bottom) return { t: '▀', c: top, bg: bottom }
      if (top) return { t: '▀', c: top }
      if (bottom) return { t: '▄', c: bottom }
      return marks[y]?.[x] ?? { t: ' ' }
    }),
  )
}
