// Binary star: running agents that wrote the same file within ten minutes. Each
// one's moon becomes an orbiting amber pair, and a warning row under the run
// names the file. Imports only motion.ts, so the surface module can carry it.

import type { SkyNode, SkyRun } from '../core'
import { HEX, breathe, clamp01, ease, mix, quantize } from '../motion'
import type { Cell } from '../skies'

// ---------------------------------------------------------------- detection

export const BINARY = {
  /** Two agents' writes to one file this close together are a collision risk. */
  windowMs: 10 * 60_000,
  /** A safety cap per agent; the window is the real bound. */
  perAgent: 32,
  /** The most binaries the props carry. */
  maxShown: 8,
  /** The most warning rows under one run. */
  rows: 2,
} as const

/** Tools that write a named file, and the input field naming it. Bash is left out: its command line names files unreliably. */
const PATH_FIELD: ReadonlyMap<string, string> = new Map([
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
])

/** The tools a `tool.call` matcher observes. */
export const FILE_TOOLS: readonly string[] = [...PATH_FIELD.keys()]

/** One agent's first and latest write to one file, epoch ms; a gap longer than the window starts afresh. */
export type Touch = { path: string; first: number; at: number }

/** A file two or more running agents wrote within the window, and those agents, earliest writer first. */
export type Binary = { path: string; agents: string[] }

/** A binary and its index in SkyProps.binaries, which sets its orbit's phase. */
export type Pair = { binary: Binary; index: number }

/** A path with `.`, `..` and doubled slashes resolved, so two spellings of one file compare equal. */
export function normalizePath(path: string): string {
  const p = /^[a-zA-Z]:[\\/]/.test(path) ? path.replace(/\\/g, '/') : path
  const isAbsolute = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop()
      else if (!isAbsolute) out.push('..')
      continue
    }
    out.push(part)
  }
  return `${isAbsolute ? '/' : ''}${out.join('/')}`
}

/** The normalized file a tool call writes, or null; `input` is `tool.call`'s `e` or a tool use's `input`. */
export function editedPath(tool: string, input: unknown): string | null {
  const field = PATH_FIELD.get(tool)
  if (field === undefined || typeof input !== 'object' || input === null) return null
  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' && value !== '' ? normalizePath(value) : null
}

/** An agent's record after it wrote `paths` at `at`: each file once, oldest first, pruned to the window. */
export function addTouches(was: readonly Touch[] | null | undefined, paths: readonly string[], at: number, windowMs: number = BINARY.windowMs): Touch[] {
  const live = (was ?? []).filter(x => at - x.at < windowMs)
  const fresh = [...new Set(paths)]
  const kept = live.filter(x => !fresh.includes(x.path))
  const added = fresh.map(path => ({ path, first: live.find(x => x.path === path)?.first ?? at, at }))
  return [...kept, ...added].slice(-BINARY.perAgent)
}

/** One write a hook heard, buffered until the stats flush. */
export type Touched = { id: string; path: string; at: number }

/** The stats record after the writes `touched`; ended agents keep no files, since only running agents pair. */
export function applyTouches<S extends { endedAt: number | null; files?: Touch[] }>(
  stats: Readonly<Record<string, S>>,
  touched: readonly Touched[],
  now: number,
  windowMs: number = BINARY.windowMs,
): Record<string, S> {
  const next: Record<string, S> = { ...stats }
  for (const x of touched) {
    const was = Object.hasOwn(next, x.id) ? next[x.id] : undefined
    if (was && was.endedAt === null) next[x.id] = { ...was, files: addTouches(was.files, [x.path], x.at, windowMs) }
  }
  for (const [id, s] of Object.entries(next)) {
    if (!s.files) continue
    const files = s.endedAt === null ? s.files.filter(x => now - x.at < windowMs) : []
    if (files.length < s.files.length) next[id] = { ...s, files: files.length > 0 ? files : undefined }
  }
  return next
}

type Seen = { id: string; first: number; last: number }

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Files two or more `running` agents wrote within the window. The order is stable (larger, then
 * earliest formed, then path), so warning rows and orbit phases never swap.
 */
export function binariesOf(
  stats: Readonly<Record<string, { readonly files?: readonly Touch[] | null } | null | undefined>>,
  running: Iterable<string>,
  now: number,
  windowMs: number = BINARY.windowMs,
): Binary[] {
  const byPath = new Map<string, Seen[]>()
  for (const id of new Set(running)) {
    const files = Object.hasOwn(stats, id) ? stats[id]?.files : undefined
    for (const x of files ?? []) {
      if (now - x.at >= windowMs) continue
      let seen = byPath.get(x.path)
      if (!seen) byPath.set(x.path, (seen = []))
      const had = seen.find(s => s.id === id)
      if (had) {
        had.first = Math.min(had.first, x.first)
        had.last = Math.max(had.last, x.at)
      } else seen.push({ id, first: x.first, last: x.at })
    }
  }
  const found: { path: string; seen: Seen[]; formed: number; last: number }[] = []
  for (const [path, seen] of byPath) {
    if (seen.length < 2) continue
    seen.sort((a, b) => a.first - b.first || byText(a.id, b.id))
    found.push({ path, seen, formed: seen[1]?.first ?? 0, last: Math.max(...seen.map(s => s.last)) })
  }
  const kept = found.length <= BINARY.maxShown ? found : found.sort((a, b) => b.last - a.last || byText(a.path, b.path)).slice(0, BINARY.maxShown)
  kept.sort((a, b) => b.seen.length - a.seen.length || a.formed - b.formed || byText(a.path, b.path))
  return kept.map(f => ({ path: f.path, agents: f.seen.map(s => s.id) }))
}

/** Each paired agent's binary: the first one it is in, with its index. */
export function binaryOfAgent(binaries: readonly Binary[]): Map<string, Pair> {
  const out = new Map<string, Pair>()
  binaries.forEach((binary, index) => {
    for (const id of binary.agents) if (!out.has(id)) out.set(id, { binary, index })
  })
  return out
}

/** The binaries a run (or the subagents group) has an agent in, with their indexes. */
export function binariesIn(run: SkyRun, binaries: readonly Binary[]): Pair[] {
  if (binaries.length === 0) return []
  const ids = new Set<string>()
  const walk = (n: SkyNode) => {
    for (const a of n.agents) ids.add(a.id)
    n.children.forEach(walk)
  }
  run.nodes.forEach(walk)
  for (const a of run.loose) ids.add(a.id)
  const out: Pair[] = []
  binaries.forEach((binary, index) => {
    if (binary.agents.some(id => ids.has(id))) out.push({ binary, index })
  })
  return out
}

/** The Client's key for a binary: stable while the same agents share the file; a new partner gets a new key. */
export const binaryKey = (b: Binary) => `binary:${b.path}:${[...b.agents].sort().join('+')}`

// ---------------------------------------------------------------- drawing

/** The binary's colors: amber bodies, their brightest swell, the eclipse's dip, the flash of capture. */
export const BINARY_HEX = {
  body: HEX.warn,
  bright: '#ffd9a0',
  /** The eclipse dims the pair toward this: still brighter than the rails. */
  dip: '#b08040',
  flash: HEX.shine,
  /** The warning's words and the file it names. */
  words: '#c9b28f',
  file: '#f1d3a4',
} as const

/** How long the capture plays: the moon turns amber, fuses, then splits in two. */
export const LOCK_MS = 1000
/** The moon flares until TURN_MS, the fused body holds until SPLIT_MS, the pair cools until LOCK_MS. */
const TURN_MS = 320
const SPLIT_MS = 520
/** One orbit step: slow enough to read as a revolution beside the moons (150 ms) and spinners (80 ms). */
export const STEP_MS = 450
const BREATH_MS = 1700
const FADE_MS = 700

/**
 * Half an orbit seen edge on, over the cell before the glyph and the glyph's own (the other half is
 * the same, stars swapped). Every step differs, so binaries a step apart never match.
 */
export const ORBIT: readonly (readonly [string, string])[] = [
  ['•', '●'],
  [' ', '●'],
  ['●', '•'],
  ['•', '•'],
]
const ECLIPSE = 1
/** The fused body of the capture, before it splits in two. */
const FUSED: readonly [string, string] = [' ', '●']
/** The pair just split, as the orbit begins. */
const SPLIT = ORBIT[0] ?? FUSED

const MOON = [...'◐◓◑◒']
const at = <T>(list: readonly T[], i: number): T => list[((Math.floor(i) % list.length) + list.length) % list.length] as T

/** The ORBIT step at `t`: one shared clock offset by the binary's index, so partners match and neighbours differ. */
export const orbitStep = (t: number, index = 0): number => (((Math.floor(t / STEP_MS) + index) % ORBIT.length) + ORBIT.length) % ORBIT.length

/** The stars' color at `t`: amber breathing toward bright on the binary's own clock, dipping in the eclipse. */
function bodyColor(t: number, index: number, step: number): string {
  const lit = mix(BINARY_HEX.body, BINARY_HEX.bright, quantize(breathe(t, BREATH_MS, index * 0.29), 4))
  return step === ECLIPSE ? mix(lit, BINARY_HEX.dip, 0.35) : lit
}

const pair = (glyphs: readonly [string, string], c: string): [Cell, Cell] => [
  { t: glyphs[0], c },
  { t: glyphs[1], c },
]

/**
 * A paired agent's two cells `age` ms after the binary formed: the companion over the connector's
 * tail (blank: hidden), then the glyph. `base` is the moon's color, where the capture starts.
 * Draw it only when the agent is not retrograde.
 */
export function binaryCells(t: number, age: number, index = 0, base: string = HEX.live): [Cell, Cell] {
  const a = Math.max(0, age)
  if (a < TURN_MS) {
    const c = mix(base, BINARY_HEX.bright, quantize(ease.inOutSine(a / TURN_MS), 4))
    return [{ t: ' ', c }, { t: at(MOON, t / 150), c }]
  }
  if (a < SPLIT_MS) return pair(FUSED, mix(BINARY_HEX.bright, BINARY_HEX.flash, quantize(1 - (a - TURN_MS) / (SPLIT_MS - TURN_MS), 3)))
  if (a < LOCK_MS) return pair(SPLIT, mix(BINARY_HEX.flash, bodyColor(t, index, 0), quantize(ease.outCubic((a - SPLIT_MS) / (LOCK_MS - SPLIT_MS)), 4)))
  const step = orbitStep(t, index)
  return pair(ORBIT[step] ?? SPLIT, bodyColor(t, index, step))
}

const width = (s: string) => [...s].length

/** draw.tsx's cut: `s` in at most `room` cells, ending '…' when cut short. */
function cut(s: string, room: number): string {
  const chars = [...s]
  if (room <= 0) return ''
  return chars.length <= room ? s : `${chars.slice(0, Math.max(0, room - 1)).join('')}…`
}

/** `path` in at most `room` cells: relative to `root`, else folder and name, else the name, cut. */
export function shortPath(path: string, room: number, root: string | null = null): string {
  const base = root ? normalizePath(root) : null
  const under = base && base !== '/' && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
  const parts = path.split('/').filter(Boolean)
  const tries = [under, parts.slice(-2).join('/'), parts.at(-1) ?? path]
  for (const p of tries) if (p && width(p) <= room) return p
  return cut(parts.at(-1) ?? path, room)
}

const cellsOf = (text: string, c: string): Cell[] => [...text].map(ch => ({ t: ch, c }))

/**
 * A binary's warning row after the run's rail, in at most `room` cells: the pair's orbit in step
 * with its partners, then `binary · 2 agents editing <file>`. Its width never changes over time.
 */
export function binaryWarning(p: Pair, room: number, t: number, age: number, root: string | null = null): Cell[] {
  const fade = quantize(ease.outCubic(clamp01(Math.max(0, age) / FADE_MS)), 4)
  const tone = (c: string) => (fade >= 1 ? c : mix(HEX.dim, c, fade))
  // No moon to capture here: start from the fused body, as the partners do.
  const orbit = binaryCells(t, Math.max(age, TURN_MS), p.index).map(c => ({ t: c.t, c: tone(c.c ?? BINARY_HEX.body) }))
  const n = p.binary.agents.length
  const who = `${n} agents editing `
  const lead = 12 // orbit (2) + ' binary · ' (10)
  if (room >= lead + width(who) + 6) {
    return [
      ...orbit,
      ...cellsOf(' binary', tone(BINARY_HEX.body)),
      ...cellsOf(' · ', tone(HEX.rail)),
      ...cellsOf(who, tone(BINARY_HEX.words)),
      ...cellsOf(shortPath(p.binary.path, room - lead - width(who), root), tone(BINARY_HEX.file)),
    ]
  }
  if (room < 3) return orbit.slice(0, Math.max(0, room))
  const words = cut(` ${n} editing `, room - 2)
  return [...orbit, ...cellsOf(words, tone(BINARY_HEX.words)), ...cellsOf(shortPath(p.binary.path, room - 2 - width(words), root), tone(BINARY_HEX.file))]
}

/** A run's warning rows, at most BINARY.rows, the last counting the rest; `ageOf` is a binary's age on the Client's clock. */
export function binaryRows(pairs: readonly Pair[], room: number, t: number, ageOf: (b: Binary) => number, root: string | null = null): Cell[][] {
  const row = (p: Pair) => binaryWarning(p, room, t, ageOf(p.binary), root)
  if (pairs.length <= BINARY.rows) return pairs.map(row)
  const shown = pairs.slice(0, BINARY.rows - 1).map(row)
  return [...shown, cellsOf(cut(`   and ${pairs.length - shown.length} more files`, room), BINARY_HEX.words)]
}
