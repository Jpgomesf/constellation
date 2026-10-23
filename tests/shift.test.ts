import { expect, test } from 'claude-code/testing'

import type { Usage } from '../hooks/core'
import {
  MIN_SHIFT,
  SHIFT_BAND,
  SHIFT_FADE_MS,
  SPECTRUM_W,
  WARM_STEPS,
  addUsage,
  cacheShare,
  cachedFact,
  levelOf,
  moonColor,
  pctText,
  seeShift,
  shiftLegend,
  shiftLevel,
  shiftOf,
  shiftWord,
  skyCacheOf,
  spectrumCells,
} from '../hooks/events/shift'
import type { CacheMix, SkyCache } from '../hooks/events/shift'
import { BINARY_HEX } from '../hooks/events/binary'
import { RETRO_HEX } from '../hooks/events/retrograde'
import { HEX, breathe, mix, quantize } from '../hooks/motion'

const usage = (read: number, write: number, fresh = 0, output = 500): Usage => ({
  input_tokens: fresh,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

const fold = (steps: readonly Usage[], from?: CacheMix) => steps.reduce<CacheMix | undefined>((m, u) => addUsage(m, u), from) as CacheMix

/** Each step's level as the props would show it. */
const levels = (steps: readonly Usage[], from?: CacheMix) => {
  const out: number[] = []
  let m = from
  for (const u of steps) {
    m = addUsage(m, u)
    out.push(shiftLevel(skyCacheOf(m)?.shift))
  }
  return out
}

/** How many times a run of levels changes. */
const changes = (ls: readonly number[]) => ls.reduce((n, l, i) => n + (i > 0 && l !== ls[i - 1] ? 1 : 0), 0)

/** An ordinary agent: it writes its prompt, then each step reads the context and writes the newest result. */
function ordinary(steps: number, prompt = 20_000, tail = 1_500): Usage[] {
  const out: Usage[] = [usage(0, prompt, 3)]
  let context = prompt
  for (let i = 1; i < steps; i++) {
    out.push(usage(context, tail, 3))
    context += tail
  }
  return out
}

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
}
/** CIE L*a*b* (D65), for distances the eye agrees with. */
function lab(hex: string): readonly [number, number, number] {
  const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number]
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047)
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722)
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}
/** A color's hue angle in L*a*b*, 0..360 degrees. */
const hue = (hex: string) => {
  const [, a, b] = lab(hex)
  return (Math.atan2(b, a) * 180) / Math.PI + (b < 0 ? 360 : 0)
}
const dE = (a: string, b: string) => {
  const x = lab(a)
  const y = lab(b)
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}
const isHex = (c: string | undefined) => typeof c === 'string' && /^#[0-9a-f]{6}$/.test(c)
const cache = (now: number | null, all: number | null, steps = 12, was = 0): SkyCache => ({ shift: shiftOf(now, was), now, all, steps })
/** Every point of the breath draw.tsx quantizes to. */
const SWELLS = [0, 1, 2, 3, 4, 5, 6].map(k => k / 6)
const resting = SWELLS.map(s => mix(HEX.live, HEX.glow, s))
const SUGGESTION = '#b1b9f9'
const FAILED = '#ff6b80'

// ---------------------------------------------------------------- detection

test('a mix sums every step and leaves the first out of the recent window', () => {
  const one = addUsage(undefined, usage(0, 20_000, 3))
  expect(one).toEqual({ steps: 1, read: 0, write: 20_000, fresh: 3, recentRead: 0, recentMiss: 0, level: 0 })
  const two = addUsage(one, usage(20_000, 1_000, 2))
  expect(two).toEqual({ steps: 2, read: 20_000, write: 21_000, fresh: 5, recentRead: 20_000, recentMiss: 1_002, level: 0 })
  const three = addUsage(two, usage(21_000, 500))
  expect(three.recentRead).toBe(Math.round(20_000 * 0.7 + 21_000))
  expect(three.recentMiss).toBe(Math.round(1_002 * 0.7 + 500))
  expect(Object.keys(three).sort()).toEqual(['fresh', 'level', 'read', 'recentMiss', 'recentRead', 'steps', 'write'])
})

test('a mix stays seven numbers and its window stays bounded, however long the agent runs', () => {
  let m: CacheMix | undefined
  for (let i = 0; i < 5_000; i++) m = addUsage(m, usage(40_000, 2_000, 10))
  const end = m as CacheMix
  expect(end.steps).toBe(5_000)
  // A steady step S settles at S / (1 - 0.7).
  expect(end.recentRead).toBeLessThanOrEqual(Math.ceil(40_000 / 0.3) + 3)
  expect(end.recentMiss).toBeLessThanOrEqual(Math.ceil(2_010 / 0.3) + 3)
  expect(JSON.stringify(end).length).toBeLessThan(150)
})

test('bad counts read as zero', () => {
  const m = addUsage(undefined, { input_tokens: Number.NaN, output_tokens: 1, cache_read_input_tokens: -5, cache_creation_input_tokens: 100 })
  expect(m).toEqual({ steps: 1, read: 0, write: 100, fresh: 0, recentRead: 0, recentMiss: 0, level: 0 })
})

test('the share now waits for the warm-up; the share over every step does not', () => {
  expect(WARM_STEPS).toBe(6)
  for (let n = 1; n < WARM_STEPS; n++) expect(cacheShare(fold(ordinary(n)), 'now')).toBe(null)
  expect(cacheShare(fold(ordinary(1)), 'all')).toBe(0)
  expect(cacheShare(fold(ordinary(WARM_STEPS)), 'now')).toBeGreaterThan(0.9)
  expect(cacheShare(undefined)).toBe(null)
})

test('with caching off there is no share and no shift', () => {
  const m = fold([9_000, 10_000, 11_000, 12_000, 13_000, 14_000, 15_000].map(n => usage(0, 0, n)))
  expect(cacheShare(m, 'now')).toBe(null)
  expect(cacheShare(m, 'all')).toBe(null)
  expect(skyCacheOf(m)).toEqual({ shift: 0, now: null, all: null, steps: 7 })
})

test('a tint holds until its exit edge, so an agent near an edge keeps one color', () => {
  const at = (miss: number) => 1 - miss
  for (const miss of [0.004, 0.01, 0.05, 0.1, 0.19]) expect(levelOf(at(miss))).toBe(0)
  expect(levelOf(at(0.21))).toBe(1)
  expect(levelOf(at(0.002))).toBe(-1)
  expect(levelOf(at(0.15), 1)).toBe(1)
  expect(levelOf(at(SHIFT_BAND.redOut + 0.001), 1)).toBe(1)
  expect(levelOf(at(0.09), 1)).toBe(0)
  expect(levelOf(at(0.005), -1)).toBe(-1)
  expect(levelOf(at(SHIFT_BAND.blueOut - 0.0001), -1)).toBe(-1)
  expect(levelOf(at(0.007), -1)).toBe(0)
  expect(levelOf(at(0.5), -1)).toBe(1)
  expect(levelOf(null, 1)).toBe(0)
  expect(levelOf(Number.NaN, -1)).toBe(0)
})

test('a shift is 0 at rest; past an edge it takes the level’s sign, at least MIN_SHIFT, deeper further out', () => {
  for (const share of [0.85, 0.9, 0.95, 0.975, 0.99, 0.996]) expect(shiftOf(share)).toBe(0)
  expect(shiftOf(null)).toBe(0)
  expect(shiftOf(0.79)).toBe(MIN_SHIFT)
  expect(shiftOf(0.998)).toBe(-MIN_SHIFT)
  expect(shiftOf(0.2)).toBe(1)
  expect(shiftOf(0)).toBe(1)
  expect(shiftOf(1)).toBe(-1)
  // Held by hysteresis inside the band: the least shift of the held side.
  expect(shiftOf(0.88, 1)).toBe(MIN_SHIFT)
  expect(shiftOf(0.995, -1)).toBe(-MIN_SHIFT)
  let last = 2
  for (let s = 0; s <= 1.0001; s += 0.001) {
    const v = shiftOf(Math.min(1, s))
    expect(v).toBeLessThanOrEqual(last)
    expect(Math.abs(v) === 0 || Math.abs(v) >= MIN_SHIFT).toBe(true)
    last = v
  }
})

test('an agent reading its first big files into a small context stays at rest', () => {
  // More than a fifth of the prompt is new, but only during the warm-up.
  const start = [usage(0, 15_000, 3), usage(15_000, 12_000, 3), usage(27_000, 12_000, 3)]
  const rest = ordinary(12, 39_000, 1_500).slice(1)
  expect(levels([...start, ...rest]).every(l => l === 0)).toBe(true)
})

test('an ordinary agent rests; a lapsed cache redshifts once and recovers once; a long read-heavy loop blueshifts', () => {
  const calm = skyCacheOf(fold(ordinary(14)))
  expect(calm?.shift).toBe(0)
  expect(calm?.now).toBeGreaterThan(0.9)

  // A lapse: two requests write the whole context again.
  const before = fold(ordinary(14))
  const lapse = [usage(0, 80_000, 4), usage(0, 82_000, 4)]
  const after = Array.from({ length: 10 }, (_, i) => usage(84_000 + i * 1_500, 1_500, 3))
  const ls = [shiftLevel(skyCacheOf(before)?.shift), ...levels([...lapse, ...after], before)]
  expect(ls[0]).toBe(0)
  expect(ls[1]).toBe(1)
  expect(ls[2]).toBe(1)
  expect(ls.at(-1)).toBe(0)
  expect(changes(ls)).toBe(2)
  expect(ls.indexOf(0, 1)).toBeLessThanOrEqual(8)
  expect(shiftWord(skyCacheOf(fold(lapse, before))?.shift)).toBe('redshift')
  expect(skyCacheOf(fold(lapse, before))?.shift).toBeGreaterThan(0.5)

  const cheap = skyCacheOf(fold(ordinary(30, 150_000, 200)))
  expect(shiftWord(cheap?.shift)).toBe('blueshift')
})

test('an agent hovering at an edge changes level once, not every step', () => {
  // New input alternates between about a fifth and a tenth of the context.
  const steps: Usage[] = [usage(0, 50_000, 3)]
  for (let i = 0; i < 30; i++) steps.push(usage(50_000, i % 2 ? 6_000 : 14_000, 3))
  expect(changes(levels(steps))).toBeLessThanOrEqual(1)
})

test('the props are rounded, null before the first step', () => {
  expect(skyCacheOf(undefined)).toBe(null)
  expect(skyCacheOf({ steps: 0, read: 0, write: 0, fresh: 0, recentRead: 0, recentMiss: 0, level: 0 })).toBe(null)
  const sky = skyCacheOf(fold(ordinary(9))) as SkyCache
  expect(String(sky.now).length).toBeLessThanOrEqual(6)
  expect(String(sky.shift).length).toBeLessThanOrEqual(5)
  expect(sky.steps).toBe(9)
  expect(skyCacheOf(fold(ordinary(3)))?.shift).toBe(0)
})

// ---------------------------------------------------------------- the Client's memory

test('the Client remembers a change of level, and nothing else', () => {
  const first = seeShift(undefined, -1, 500)
  expect(first).toEqual({ level: -1, from: -1, at: 500 })
  expect(seeShift(first, -1, 900)).toBe(first)
  expect(seeShift(first, 0, 1_200)).toEqual({ level: 0, from: -1, at: 1_200 })
})

// ---------------------------------------------------------------- drawing

test('levels are the shift’s sign', () => {
  expect(shiftLevel(0)).toBe(0)
  expect(shiftLevel(null)).toBe(0)
  expect(shiftLevel(undefined)).toBe(0)
  expect(shiftLevel(Number.NaN)).toBe(0)
  expect(shiftLevel(0.4)).toBe(1)
  expect(shiftLevel(-1)).toBe(-1)
})

test('at rest the moon is draw.tsx’s own color; blue breathes azure; red breathes a deep garnet, dim and shallow', () => {
  for (const s of [0, 0.1, 0.37, 0.5, 0.92, 1]) expect(moonColor(s, 0)).toBe(mix(HEX.live, HEX.glow, quantize(s, 6)))
  for (const s of SWELLS) {
    const [r, g, b] = rgb(moonColor(s, -1))
    expect(b).toBeGreaterThan(r + 60)
    expect(g).toBeGreaterThan(r)
  }
  expect(lab(moonColor(1, -1))[0]).toBeGreaterThan(lab(moonColor(0, -1))[0] + 10)
  // A true red: neither orange (green over blue) nor rose (blue over green).
  for (const s of SWELLS) {
    const [r, g, b] = rgb(moonColor(s, 1))
    expect(r).toBeGreaterThan(g + 60)
    expect(r).toBeGreaterThan(b + 60)
    expect(Math.abs(g - b)).toBeLessThan(12)
  }
  const depth = (s: number) => lab(moonColor(s, 1))[0]
  expect(depth(1)).toBeGreaterThan(depth(0) + 6)
  expect(depth(1) - depth(0)).toBeLessThan((lab(HEX.glow)[0] - lab(HEX.live)[0]) / 2)
  for (const s of SWELLS) expect(depth(s)).toBeLessThan(lab(HEX.live)[0] - 12)
})

test('a tinted moon is told apart from a resting one at any two points of their breaths', () => {
  // The garnet differs more by depth than by hue, so its bound is lower.
  for (const level of [-1, 1]) {
    for (const s of SWELLS) {
      for (const r of resting) expect(dE(moonColor(s, level), r)).toBeGreaterThan(level < 0 ? 25 : 20)
    }
  }
})

test('the tints keep clear of the tool lavender, the failed pink, retrograde’s white moon and amber words, the binary’s amber, the finished green and the child violet', () => {
  for (const s of SWELLS) {
    const blue = moonColor(s, -1)
    const red = moonColor(s, 1)
    expect(dE(blue, SUGGESTION)).toBeGreaterThan(20)
    expect(dE(blue, HEX.child)).toBeGreaterThan(25)
    expect(dE(red, FAILED)).toBeGreaterThan(25)
    expect(dE(red, RETRO_HEX.words)).toBeGreaterThan(22)
    for (const c of [blue, red]) expect(dE(c, RETRO_HEX.white)).toBeGreaterThan(25)
    expect(dE(red, BINARY_HEX.body)).toBeGreaterThan(40)
    for (const c of [blue, red]) expect(dE(c, HEX.ok)).toBeGreaterThan(40)
    expect(hue(red)).toBeGreaterThan(hue(FAILED) + 5)
    expect(hue(red)).toBeLessThan(hue(RETRO_HEX.words) - 12)
  }
  // Legible over a background image.
  expect(lab(moonColor(1, 1))[0]).toBeGreaterThan(lab(HEX.rail)[0] - 5)
  expect(lab(moonColor(0, 1))[0]).toBeGreaterThan(33)
  expect(lab(moonColor(0, -1))[0]).toBeGreaterThan(lab(HEX.rail)[0] + 10)
})

test('a change of level fades from the old tint, never through the resting orange or a gray', () => {
  const s = 0.5
  expect(moonColor(s, -1, -1, 0)).toBe(moonColor(s, -1))
  expect(moonColor(s, 1, 0, SHIFT_FADE_MS)).toBe(moonColor(s, 1))
  for (const [from, to] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, -1], [-1, 1]] as const) {
    expect(moonColor(s, to, from, 0)).toBe(moonColor(s, from))
  }
  // Warm to blue crosses white.
  for (const [from, to] of [[0, -1], [-1, 0], [1, -1], [-1, 1]] as const) {
    const [r, g, b] = rgb(moonColor(s, to, from, SHIFT_FADE_MS / 2))
    expect(Math.min(r, g, b)).toBeGreaterThan(220)
  }
  // Blue to rest does not reach the resting orange early.
  for (let age = 0; age < SHIFT_FADE_MS / 2; age += 33) {
    const [r, , b] = rgb(moonColor(s, 0, -1, age))
    expect(b).toBeGreaterThan(r - 20)
  }
  // Red to rest stays warm and saturated.
  for (let age = 0; age < SHIFT_FADE_MS; age += 33) {
    const [r, g, b] = rgb(moonColor(s, 0, 1, age))
    expect(r - Math.min(g, b)).toBeGreaterThan(60)
  }
})

test('the moon is one hex color at every frame, the same twice', () => {
  for (let t = 0; t < 6_000; t += 33) {
    const swell = breathe(t, 1400, 0.37)
    for (const [level, from] of [[-1, 0], [0, -1], [0, 0], [1, 0], [1, -1]] as const) {
      const c = moonColor(swell, level, from, t % 1_200)
      expect(isHex(c)).toBe(true)
      expect(moonColor(swell, level, from, t % 1_200)).toBe(c)
    }
  }
})

test('the detail line names only a shifted moon, quietly', () => {
  expect(cachedFact(cache(0.975, 0.95))).toBe(null)
  expect(cachedFact(cache(null, 0.4, 2))).toBe(null)
  expect(cachedFact(null)).toBe(null)
  expect(cachedFact(cache(0.9988, 0.98))).toEqual({ t: '99.8% cached', dim: true })
  expect(cachedFact(cache(0.52, 0.48))).toEqual({ t: '52% cached', dim: true })
  // Held red by hysteresis.
  expect(cachedFact(cache(0.86, 0.9, 12, 1))?.t).toBe('86% cached')
  expect(pctText(0.823)).toBe('82%')
  expect(pctText(0.99)).toBe('99%')
  expect(pctText(0.9999)).toBe('99.9%')
  expect(pctText(1)).toBe('100%')
  expect(pctText(0)).toBe('0%')
})

test('the spectrum is SPECTRUM_W narrow cells, bright enough over a picture, its lines moving a cell or more', () => {
  const lineAt = (cells: readonly { t: string }[]) => cells.findIndex(c => c.t !== '━')
  const rest = spectrumCells(0)
  const least = [spectrumCells(-MIN_SHIFT), spectrumCells(MIN_SHIFT)]
  for (const s of [rest, spectrumCells(-1), spectrumCells(1), ...least]) {
    expect(s).toHaveLength(SPECTRUM_W)
    for (const c of s) {
      expect([...c.t]).toHaveLength(1)
      expect(isHex(c.c)).toBe(true)
      expect(lab(c.c ?? '#000000')[0]).toBeGreaterThan(lab(HEX.rail)[0])
    }
    expect(s.filter(c => c.t !== '━')).toHaveLength(2)
  }
  expect(lineAt(least[0] ?? [])).toBe(lineAt(rest) - 1)
  expect(lineAt(least[1] ?? [])).toBe(lineAt(rest) + 1)
  expect(lineAt(spectrumCells(-1))).toBeLessThan(lineAt(least[0] ?? []))
  const faint = spectrumCells(0, true)
  expect(faint.map(c => c.c)).toEqual(rest.map(c => c.c))
  expect(faint.every(c => c.dim === true)).toBe(true)
})

test('the inspector line fits its width, drops whole pieces, says what it measures and gives a finished agent only its share', () => {
  const live = cache(0.9988, 0.981, 41)
  const text = (segs: readonly { t: string }[]) => segs.map(s => s.t).join('')
  const width = (segs: readonly { t: string }[]) => [...text(segs)].length
  for (const w of [0, 5, 14, 20, 40, 59, 120]) {
    const line = shiftLegend(live, true, w)
    expect(width(line)).toBeLessThanOrEqual(w)
    expect(shiftLegend(live, true, w)).toEqual(line)
  }
  expect(text(shiftLegend(live, true, 120))).toContain('blueshift · 99.8% cached now · 98% over 41 steps')
  expect(text(shiftLegend(live, true, 45))).toContain('blueshift · 99.8% cached now')
  expect(text(shiftLegend(live, true, 45))).not.toContain('over')
  const red = text(shiftLegend(cache(0.52, 0.48, 9), true, 80))
  expect(red).toContain('redshift · 52% cached now')
  // The word takes its moon's color at a point of the breath that reads as text.
  const word = (c: SkyCache) => shiftLegend(c, true, 80).find(seg => seg.t === shiftWord(c.shift))?.c
  expect(word(cache(0.52, 0.48, 9))).toBe(moonColor(1, 1))
  expect(word(live)).toBe(mix(moonColor(0, -1), moonColor(1, -1), 0.25))
  for (const word of ['cheap', 'costly']) expect(red + text(shiftLegend(live, true, 120))).not.toContain(word)
  expect(text(shiftLegend(cache(0.975, 0.96), true, 80))).toContain('at rest')
  expect(text(shiftLegend(cache(null, 0.31, 2), true, 80))).toContain('warming up · 31% cached over 2 steps')
  expect(text(shiftLegend(cache(0.52, 0.961, 41), false, 80))).toBe('96% cached over 41 steps')
  expect(text(shiftLegend({ shift: 0, now: null, all: null, steps: 9 }, false, 80))).toBe('no prompt caching · 9 steps')
  expect(shiftLegend(null, true, 80)).toEqual([])
})
