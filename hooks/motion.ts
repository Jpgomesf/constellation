// Easing, color fades and effects for the sky, each a pure function of time in
// milliseconds. Import-free so the surface module can carry it. Effects are
// modeled on tachyonfx.

/** The frame clock's period while something moves: about 30 fps. */
export const TICK_MS = 33

/** Hex stand-ins for the dark theme's colors, for anything that fades: a theme key cannot be mixed. */
export const HEX = {
  ink: '#e4e4e4',
  dim: '#4e4e4e',
  /** Tree lines: quiet beside the text, still legible over a terminal background image. */
  rail: '#77738f',
  live: '#d77757',
  glow: '#ffd2a8',
  ok: '#4eba65',
  flash: '#d6ffe0',
  star: '#f3e3b5',
  child: '#af87ff',
  childGlow: '#e6d9ff',
  shine: '#fff1de',
  /** The context gauge: calm while there is room, amber past 60%, red near compaction. */
  calm: '#9a96c4',
  warn: '#e8a54b',
  hot: '#ff6b80',
} as const

type Rgb = readonly [number, number, number]

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

function rgbOf(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const hexOf = (c: Rgb) => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/** The color `t` of the way from `a` to `b` (0 is `a`). */
export function mix(a: string, b: string, t: number): string {
  const x = rgbOf(a)
  const y = rgbOf(b)
  const k = clamp01(t)
  return hexOf([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k])
}

export const ease = {
  inOutSine: (t: number) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2,
  outCubic: (t: number) => 1 - (1 - clamp01(t)) ** 3,
}

/** Snaps a 0..1 level to `steps` levels, so neighboring cells share one Text and its color. */
export const quantize = (v: number, steps = 6) => Math.round(clamp01(v) * steps) / steps

/** A slow 0..1 swell, `periodMs` long, starting `phase` (0..1) of the way in. */
export const breathe = (t: number, periodMs: number, phase = 0) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (t / periodMs + phase))

/** A star's 0..1 brightness: calm most of the time, flaring now and then, each star on its own clock. */
export function twinkle(t: number, seed: number): number {
  const period = 2400 + (seed % 2600)
  const s = breathe(t, period, (seed % 997) / 997)
  return s * s * s
}

/** How brightly character `i` of an `n`-long label is lit by a sweeping band about `width` characters wide. */
export function shimmer(i: number, n: number, t: number, periodMs = 2600, width = 3): number {
  const travel = n + width * 4
  const pos = ((t % periodMs) / periodMs) * travel * 1.5 - width * 2
  const d = i - pos
  return Math.exp(-(d * d) / (2 * width * width))
}

/** How brightly row `k` of a `span`-row rail is lit by a comet falling a row every `rowMs`. */
export function comet(k: number, span: number, t: number, seed = 0, rowMs = 60): number {
  const cycle = span + 10
  const head = ((t / rowMs + seed * 3) % cycle) - 2
  const behind = head - k
  if (behind < -0.6) return 0
  return Math.exp(-Math.max(0, behind) / 1.8)
}

/** 0..1 of the way through something that began at `since` and lasts `ms`. */
export const progress = (t: number, since: number, ms: number) => clamp01((t - since) / ms)
