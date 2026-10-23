// Red and blue shift: how much of each running agent's recent prompts the cache
// served. A mostly cached agent's moon turns blue, a mostly uncached one deep red;
// most sit in a wide deadband, and hysteresis keeps a tint from flickering.

import type { Usage } from '../core'
import { HEX, clamp01, ease, mix, quantize } from '../motion'
import type { Cell } from '../skies'

// ---------------------------------------------------------------- detection

/** What an agent's prompts were made of, updated per model request: seven numbers however long it runs. */
export type CacheMix = {
  /** Steps counted (requests that reported usage), the first included. */
  steps: number
  /** Over every step: prompt tokens read from the cache, written to it, and sent uncached. */
  read: number
  write: number
  fresh: number
  /** Decayed cache reads, and writes plus uncached input; the first step is left out, as it always writes its whole prompt. */
  recentRead: number
  recentMiss: number
  /** The shift as of the last step, with hysteresis: -1 blue, 0 at rest, 1 red. */
  level: number
}

/** What the drawing needs of an agent's cache, rounded so the props stay small and steady. */
export type SkyCache = {
  /** 0 at rest, negative blue, positive red; its size (MIN_SHIFT..1) is how far past the band's edge. */
  shift: number
  /** Share of the last few prompts read from the cache, 0..1; null while warming up or with no caching in play. */
  now: number | null
  /** Share of every prompt so far read from the cache, 0..1; null with no caching in play. */
  all: number | null
  steps: number
}

/** How much of the recent sums each step keeps: about the last three steps weigh. */
export const RECENT_KEEP = 0.7
/** Steps before the shift shows: first reads into a small context would redshift nearly every agent. */
export const WARM_STEPS = 6
/**
 * The band, as the share of the recent prompt NOT read from the cache, with separate entry and exit edges;
 * a further factor of `span` past entry is a full shift. Calibrated on a few hundred real agents.
 */
export const SHIFT_BAND = { blueIn: 0.003, blueOut: 0.006, redIn: 0.2, redOut: 0.1, span: 4 } as const
/** The least shift a tinted agent shows, so its spectrum's lines move a whole cell. */
export const MIN_SHIFT = 0.4
/** A tint fades from the old one over this long. */
export const SHIFT_FADE_MS = 900

const EMPTY: CacheMix = { steps: 0, read: 0, write: 0, fresh: 0, recentRead: 0, recentMiss: 0, level: 0 }

const count = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)

/** The share of the prompt the cache served, recent (`now`) or overall; null while warming up or with no caching in play. */
export function cacheShare(mix: CacheMix | null | undefined, span: 'now' | 'all' = 'now'): number | null {
  if (!mix || mix.read + mix.write === 0) return null
  if (span === 'all') {
    const total = mix.read + mix.write + mix.fresh
    return total > 0 ? mix.read / total : null
  }
  if (mix.steps < WARM_STEPS) return null
  const total = mix.recentRead + mix.recentMiss
  return total > 0 ? mix.recentRead / total : null
}

/** A share's level (-1 blue, 0, 1 red) given the level it `was`: a tint holds until its exit edge. */
export function levelOf(share: number | null | undefined, was = 0): number {
  if (share === null || share === undefined || !Number.isFinite(share)) return 0
  const miss = 1 - clamp01(share)
  if (was > 0 && miss >= SHIFT_BAND.redOut) return 1
  if (was < 0 && miss <= SHIFT_BAND.blueOut) return -1
  return miss > SHIFT_BAND.redIn ? 1 : miss < SHIFT_BAND.blueIn ? -1 : 0
}

/** A share's shift, -1..1: its level's sign, from MIN_SHIFT at the entry edge to 1 a factor of `span` past it, log scale. */
export function shiftOf(share: number | null | undefined, was = 0): number {
  const level = levelOf(share, was)
  if (level === 0 || share === null || share === undefined) return 0
  const miss = Math.max(1 - clamp01(share), 1e-6)
  const past = level > 0 ? miss / SHIFT_BAND.redIn : SHIFT_BAND.blueIn / miss
  return level * Math.max(MIN_SHIFT, clamp01(Math.log(past) / Math.log(SHIFT_BAND.span)))
}

/** Folds one step's usage into an agent's mix (a fresh one when `mix` is absent), settling its level. */
export function addUsage(mix: CacheMix | null | undefined, u: Usage): CacheMix {
  const was = mix ?? EMPTY
  const read = count(u.cache_read_input_tokens)
  const write = count(u.cache_creation_input_tokens)
  const fresh = count(u.input_tokens)
  const isFirst = was.steps === 0
  const next: CacheMix = {
    steps: was.steps + 1,
    read: was.read + read,
    write: was.write + write,
    fresh: was.fresh + fresh,
    recentRead: isFirst ? 0 : Math.round(was.recentRead * RECENT_KEEP + read),
    recentMiss: isFirst ? 0 : Math.round(was.recentMiss * RECENT_KEEP + write + fresh),
    level: 0,
  }
  next.level = levelOf(cacheShare(next, 'now'), was.level)
  return next
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places

/** The drawing's view of an agent's mix, or null before its first step. Computed where the props are built. */
export function skyCacheOf(mix: CacheMix | null | undefined): SkyCache | null {
  if (!mix || mix.steps === 0) return null
  const now = cacheShare(mix, 'now')
  const all = cacheShare(mix, 'all')
  return {
    shift: now === null ? 0 : round(shiftOf(now, mix.level), 2),
    now: now === null ? null : round(now, 4),
    all: all === null ? null : round(all, 4),
    steps: mix.steps,
  }
}

// ---------------------------------------------------------------- the Client's memory

/** What the Client remembers of a running agent's tint: its level, the one before, and when it changed (frame clock ms). */
export type ShiftSeen = { level: number; from: number; at: number }

/**
 * The Client's memory of a tint after seeing `level` at `t`, the same object while it holds. A first
 * sight records no change, so a pane opened mid-run tints at once.
 */
export function seeShift(seen: ShiftSeen | null | undefined, level: number, t: number): ShiftSeen {
  if (!seen) return { level, from: level, at: t }
  return seen.level === level ? seen : { level, from: seen.level, at: t }
}

// ---------------------------------------------------------------- drawing

/** A piece of a row: draw.tsx's Seg takes it as it is. */
export type ShiftSeg = Cell & { dim?: boolean }

/** A shift's level: -1 blue, 0 at rest, 1 red. */
export function shiftLevel(shift: number | null | undefined): number {
  return !shift || !Number.isFinite(shift) ? 0 : Math.sign(shift)
}

/**
 * Moon colors by level, over the breath's seven steps. Blue leans cyan, away from the tool lavender and
 * child violet; red is a dim garnet that reads as a fainter moon, never an alarm.
 */
const BLUE = ['#2e9fe8', '#8fdcff'] as const
const RED = ['#8e393d', '#b04c4d'] as const
const BREATH_STEPS = 6
const row = (dark: string, light: string) => Object.freeze(Array.from({ length: BREATH_STEPS + 1 }, (_, k) => mix(dark, light, k / BREATH_STEPS)))
const MOONS: Readonly<Record<number, readonly string[]>> = Object.freeze({ [-1]: row(BLUE[0], BLUE[1]), 0: row(HEX.live, HEX.glow), 1: row(RED[0], RED[1]) })
/** The color a tint passes between warm and blue: a star's color crosses white as it heats or cools. */
const WHITE = '#f6f0ea'

const moonAt = (level: number, k: number) => MOONS[shiftLevel(level)]?.[k] ?? HEX.live

/**
 * The moon's color for draw.tsx's 0..1 `swell` (its own color at rest). A level change fades from `from`
 * over SHIFT_FADE_MS, through white between warm and blue, never through the resting orange or a gray.
 */
export function moonColor(swell: number, level: number, from = level, age = Number.POSITIVE_INFINITY): string {
  const k = Math.round(clamp01(Number.isFinite(swell) ? swell : 0) * BREATH_STEPS)
  const to = moonAt(level, k)
  if (shiftLevel(from) === shiftLevel(level) || !(age < SHIFT_FADE_MS)) return to
  const was = moonAt(from, k)
  const p = quantize(ease.inOutSine(Math.max(0, age) / SHIFT_FADE_MS), 6)
  if ((from < 0) === (level < 0)) return mix(was, to, p)
  return p < 0.5 ? mix(was, WHITE, p * 2) : mix(WHITE, to, p * 2 - 1)
}

/** A steady inspector color for a shift's word; the garnet at its brightest, to read as text. */
const wordColor = (level: number) => (level < 0 ? mix(BLUE[0], BLUE[1], 0.25) : RED[1])

/** `0.823` -> `82%`, rounded down; past 99% with a decimal, so the most cached agents still differ. */
export function pctText(share: number): string {
  const s = clamp01(share)
  return `${s >= 0.99 && s < 1 ? Math.floor(s * 1000 + 1e-6) / 10 : Math.floor(s * 100 + 1e-6)}%`
}

/** `0.823` -> `82% cached`. */
export const cachedText = (share: number) => `${pctText(share)} cached`

/** The detail line's dim `82% cached` fact, only for a shifted moon. */
export function cachedFact(cache: SkyCache | null | undefined): ShiftSeg | null {
  if (!cache || cache.now === null || shiftLevel(cache.shift) === 0) return null
  return { t: cachedText(cache.now), dim: true }
}

/** The shift in a word. */
export function shiftWord(shift: number | null | undefined): string {
  const level = shiftLevel(shift)
  return level < 0 ? 'blueshift' : level > 0 ? 'redshift' : 'at rest'
}

/** The spectrum's width in cells, and where its two absorption lines rest (in cells from its violet end). */
export const SPECTRUM_W = 13
const LINES_AT = [3.25, 9.25] as const
/** How far a full shift moves the lines, in cells: MIN_SHIFT of it is one whole cell. */
const LINE_TRAVEL = 2.5
/** Violet to red, every stop at least as bright as the rails, to stay legible over a background image. */
const RAINBOW = ['#8a72f0', '#5b84ff', '#3aa0e8', '#3cc0b0', '#5cc860', '#c8d250', '#f0b444', '#f08040', '#e8573f'] as const
/** The spectrum is a touch quieter than the pure stops, mixed this far from the night sky. */
const SPECTRUM_LIFT = 0.92
const NIGHT = '#16121f'

function rainbowAt(f: number): string {
  const x = clamp01(f) * (RAINBOW.length - 1)
  const i = Math.min(RAINBOW.length - 2, Math.floor(x))
  return mix(RAINBOW[i] ?? NIGHT, RAINBOW[i + 1] ?? NIGHT, quantize(x - i, 4))
}

/** The spectrum's colors, cell by cell, built once. */
const SPECTRUM = Object.freeze(Array.from({ length: SPECTRUM_W }, (_, i) => mix(NIGHT, rainbowAt((i + 0.5) / SPECTRUM_W), SPECTRUM_LIFT)))

/** The agent's spectrum: a rainbow whose two absorption lines slide with the shift; `isFaint` dims it while none is known. */
export function spectrumCells(shift: number, isFaint = false): ShiftSeg[] {
  const s = Number.isFinite(shift) ? Math.sign(shift) * clamp01(Math.abs(shift)) : 0
  const at = LINES_AT.map(x => x + s * LINE_TRAVEL)
  const out: ShiftSeg[] = []
  for (let i = 0; i < SPECTRUM_W; i++) {
    const line = at.find(x => x >= i && x < i + 1)
    // A line in a cell's left half leaves its right half lit, and vice versa.
    const cell: ShiftSeg = { t: line === undefined ? '━' : line - i < 0.5 ? '╺' : '╸', c: SPECTRUM[i] ?? NIGHT }
    out.push(isFaint ? { ...cell, dim: true } : cell)
  }
  return out
}

/**
 * The inspector's cache line in at most `width` cells: spectrum, shift word, share now and overall. A finished
 * agent gets only the share; pieces that don't fit drop whole from the end.
 */
export function shiftLegend(cache: SkyCache | null | undefined, isLive: boolean, width: number): ShiftSeg[] {
  if (!cache || width <= 0) return []
  const level = isLive ? shiftLevel(cache.shift) : 0
  const steps = `${cache.steps} step${cache.steps === 1 ? '' : 's'}`
  const head: ShiftSeg[] = isLive ? [...spectrumCells(cache.shift, cache.now === null), { t: ' ' }] : []
  const parts: ShiftSeg[][] = []
  if (cache.all === null && cache.now === null) parts.push([{ t: `no prompt caching · ${steps}`, dim: true }])
  else if (!isLive) parts.push([{ t: `${cachedText(cache.all ?? 0)} over ${steps}`, dim: true }])
  else if (cache.now === null) parts.push([{ t: 'warming up', dim: true }], [{ t: ` · ${cachedText(cache.all ?? 0)} over ${steps}`, dim: true }])
  else {
    const word = shiftWord(cache.shift)
    parts.push(
      [level === 0 ? { t: word, dim: true } : { t: word, c: wordColor(level) }],
      [{ t: ` · ${cachedText(cache.now)} now`, dim: true }],
      [{ t: ` · ${pctText(cache.all ?? 0)} over ${steps}`, dim: true }],
    )
  }
  const out = head.length < width ? [...head] : []
  let used = out.length
  for (const part of parts) {
    const n = part.reduce((k, s) => k + [...s.t].length, 0)
    if (used + n > width) break
    out.push(...part)
    used += n
  }
  return out
}
