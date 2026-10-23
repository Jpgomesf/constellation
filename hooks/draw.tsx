// Draws the sky from its props: the tree of runs, phases, child workflows and
// agents, and the inspector. Every effect is a function of frame time, so the
// surface module (sky.tsx) animates it by redrawing. No runtime engine imports.
import type { ClientElements, JsonValue, RenderElement } from 'claude-code'

import type { CheckEvent, TraceTool } from '../types'
import type { Counts, DetailLevel, SkyAgent, SkyHistoryLine, SkyInspect, SkyNode, SkyProps, SkyRun } from './core'
import { binariesIn, binaryCells, binaryKey, binaryOfAgent, binaryRows } from './events/binary'
import type { Binary, Pair } from './events/binary'
import { COMET, cometLabel, cometMiddle, isStraggler, latenessAt, pacer } from './events/comet'
import { ECLIPSE_COLOR, eclipseCaption, eclipseCells, eclipseGlyph } from './events/eclipse'
import type { EclipseClock } from './events/eclipse'
import { cellsOf, isRaining, meteorOverlay, showerCaption } from './events/meteor'
import type { Meteor } from './events/meteor'
import { cachedFact, moonColor, shiftLegend, shiftLevel } from './events/shift'
import { DIRECT_FACT, retroFact, retroGlyph, retroIn } from './events/retrograde'
import type { Retro, RetroSeen } from './events/retrograde'
import type { ShiftSeen } from './events/shift'
import { HEX, breathe, comet, ease, mix, progress, quantize, shimmer, twinkle } from './motion'
import { runsOf, skyBand } from './skies'
import { STAR_H, STAR_W, starCells, starRadius, starStage } from './star'
import type { Sample, Shot } from './skies'

export type SkyElements = Pick<ClientElements, 'Box' | 'Text' | 'Button'>

/** What a drawing needs from whoever hosts it: the clock, what it has seen, and which nodes are open. */
export type SkyUi = {
  /** Frame clock time in ms. */
  t: number
  /** False where the drawing stays still (no Client): effects that split text are skipped. */
  isMoving: boolean
  /** Milliseconds the clock has moved since `props.now` was read. */
  drift: number
  /** When the drawing first showed `key`, on the frame clock; -Infinity where nothing fades in. */
  bornAt: (key: string) => number
  /** When the drawing saw agent `id` finish, or null when it never saw it running. */
  doneAt: (id: string, isDone: boolean) => number | null
  isOpen: (key: string, byDefault: boolean) => boolean
  toggle: (key: string, byDefault: boolean) => void
  post: (data: JsonValue) => void
  /** Shooting stars launched so far, and the sparkline's samples. */
  shots: readonly Shot[]
  samples: readonly Sample[]
  /** When the session last compacted, on the frame clock: the star's supernova. */
  novaAt: number | null
  /** Agent `id`'s remembered red/blue level: the level it left and when. */
  shiftSeen: (id: string, level: number) => ShiftSeen
  /** What the drawing remembers of agent `id`'s moon off its course; null for none, or where nothing animates. */
  retroSeen: (id: string, retro: Retro | null) => RetroSeen | null
  /** The meteors the Client keeps for the props' failures. */
  meteors: readonly Meteor[]
  /** The eclipse on the frame clock (sliding on, holding, sliding off); null when the star is clear. */
  eclipse: EclipseClock | null
}

const SPIN = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']
const ORBIT = [...'◐◓◑◒']
const TWINKLE = [...'✦✶✷✸✹✸✷✶']
const DONE_SHOWN = 3
/** Running agents whose detail line shows by default. */
const DETAILS_SHOWN = 12
const TREE_BUDGET = 80_000
const FADE_IN_MS = 700
const FLASH_MS = 900
const RAIL = new Set(['│', '├', '╰'])
/** The header's fixed parts: ' ✦ constellation', and the two tabs (`[live]`, ` history `). */
const TITLE_W = 16
const TABS_W = 15

/** The detail levels in the order a press steps through them, the naked eye first. */
export const DETAIL_LEVELS: readonly DetailLevel[] = ['naked-eye', 'binoculars', 'telescope']
/** Each level's word in the header, and what it shows, said when it is picked. */
export const DETAIL_NAMES: Readonly<Record<DetailLevel, string>> = { 'naked-eye': 'naked eye', binoculars: 'binoculars', telescope: 'telescope' }
export const DETAIL_NOTES: Readonly<Record<DetailLevel, string>> = {
  'naked-eye': 'just the stars: who is running, what tool, how long',
  binoculars: "each agent's model, effort and cost",
  telescope: "everything: context, tool count, cache share and each event's facts",
}
export const isDetailLevel = (v: unknown): v is DetailLevel => (DETAIL_LEVELS as readonly unknown[]).includes(v)
export const nextDetail = (level: DetailLevel): DetailLevel => DETAIL_LEVELS[(DETAIL_LEVELS.indexOf(level) + 1) % DETAIL_LEVELS.length] ?? 'naked-eye'
/** The level's word plus its two-cell gap, sized to the widest word so a press never shifts it. */
const LEVEL_W = Math.max(...DETAIL_LEVELS.map(l => DETAIL_NAMES[l].length)) + 2

/** Whether the header has room for the level's word; it gives way before the caption, so the header never wraps. */
export const hasLevelRoom = (cols: number, caption: string | null) => cols - TITLE_W - TABS_W - (caption ? width(caption) + 2 : 0) >= 1 + LEVEL_W

const C = {
  /** Every tree line (│ ├─ ╰─), one color, so only a comet ever brightens one. */
  rail: HEX.rail,
  line: 'subtle',
  live: 'claude',
  ok: 'success',
  bad: 'error',
  idle: 'inactive',
  child: 'merged',
  tool: 'suggestion',
  cost: 'warning',
  model: 'suggestion',
  effort: 'planMode',
} as const

type Seg = { t: string; c?: string; bg?: string; dim?: boolean; bold?: boolean }
/** A row: `lead`/`tail` make its first/last n segments separate presses (fold, ✕); `rails` are the live rail columns it crosses. */
type Line = {
  key: string
  segs: Seg[]
  act?: () => void
  lead?: { n: number; act?: () => void }
  tail?: { n: number; act: () => void }
  rails?: number[]
}
type Ctx = {
  ui: SkyUi
  cols: number
  now: number
  isPast: boolean
  isRunLive: boolean
  runKey: string
  rails: number[]
  /** How many more running agents show their detail line (shared across the drawing). */
  budget: { details: number }
  /** How much each agent's row tells: the level picked, or everything in an inspector. */
  level: DetailLevel
  /** The files running agents share (binary stars), and each paired agent's binary with its orbit phase. */
  binaries: readonly Binary[]
  pairs: Map<string, Pair>
}

// ---------------------------------------------------------------- formatting

const at = <T,>(list: readonly T[], i: number): T => list[((Math.floor(i) % list.length) + list.length) % list.length] as T

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

const fmtUsd = (n: number) => (n < 0.01 ? '<$0.01' : n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`)

const fmtTokens = (n: number) =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`

function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const month = at(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], d.getMonth())
  return `${month} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `mcp__tracker__get_issue` -> `get_issue`. */
const toolName = (name: string) => name.split('__').at(-1) ?? name

const width = (s: string) => [...s].length

function cut(s: string, room: number): string {
  const chars = [...s]
  if (room <= 0) return ''
  return chars.length <= room ? s : `${chars.slice(0, Math.max(0, room - 1)).join('')}…`
}

const segWidth = (segs: readonly Seg[]) => segs.reduce((n, s) => n + width(s.t), 0)

/** Cuts a run of segments to `room` cells. */
function clip(segs: readonly Seg[], room: number): Seg[] {
  const out: Seg[] = []
  let left = room
  for (const s of segs) {
    if (left <= 0) break
    const t = cut(s.t, left)
    out.push({ ...s, t })
    left -= width(t)
  }
  return out
}

/** Facts joined by ' · ' within `room` cells; the first that won't fit and all after it are dropped (a lone first fact is cut). */
function joinFacts(facts: readonly Seg[], room: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const f of facts) {
    const sep = out.length > 0 ? 3 : 0
    if (used + sep + width(f.t) > room) {
      if (out.length === 0) out.push({ ...f, t: cut(f.t, room) })
      break
    }
    if (sep > 0) out.push({ t: ' · ', c: C.line, dim: true })
    out.push(f)
    used += sep + width(f.t)
  }
  return out
}

/** Word-wraps `text` to `room` columns, at most `max` lines, the last ending `…` when cut short. */
function wrap(text: string, room: number, max: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (width(line) + width(word) + (line ? 1 : 0) > room) {
        if (line) out.push(line)
        line = width(word) > room ? cut(word, room) : word
      } else line = line ? `${line} ${word}` : word
    }
    out.push(line)
    if (out.length > max) break
  }
  const lines = out.filter((l, i) => l || (i > 0 && i < out.length - 1))
  if (lines.length <= max) return lines
  return [...lines.slice(0, max - 1), cut(`${lines[max - 1] ?? ''} …`, room)]
}

/** One row: `left` and `right` kept whole, the label cut to fit between and painted, `fill` the leader. */
function row(
  key: string,
  left: Seg[],
  label: Seg,
  right: Seg[],
  cols: number,
  fill: ' ' | '·',
  act?: () => void,
  paint?: (text: string) => Seg[],
): Line {
  const room = cols - segWidth(left) - segWidth(right) - (right.length > 0 ? 1 : 0)
  const text = cut(label.t, room)
  const pad = Math.max(0, room - width(text)) + (right.length > 0 ? 1 : 0)
  const leader: Seg =
    fill === '·' && pad >= 4 && right.length > 0 ? { t: ` ${'·'.repeat(pad - 2)} `, c: C.line, dim: true } : { t: ' '.repeat(pad) }
  const body = paint ? paint(text) : [{ ...label, t: text }]
  return { key, segs: [...left, ...body, leader, ...right], act }
}

function countSegs(c: Counts): Seg[] {
  const parts: Seg[] = []
  const add = (n: number, glyph: string, color: string) => {
    if (n === 0) return
    if (parts.length > 0) parts.push({ t: ' ' })
    parts.push({ t: `${n}${glyph}`, c: color })
  }
  add(c.done, '●', C.ok)
  add(c.running, '◐', C.live)
  add(c.failed, '✗', C.bad)
  return parts
}

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

const seedOf = (key: string) => [...key].reduce((h, ch) => hash(h + (ch.codePointAt(0) ?? 0)), 7)

// ---------------------------------------------------------------- effects

/** Columns per star cell: at most one star per cell keeps the sky from clumping. */
const STAR_CELL = 7

/** A row of twinkling stars, at most one per STAR_CELL columns, jittered, a quarter of cells dark. */
function starfield(cols: number, t: number, seed: number): Seg[] {
  const segs: Seg[] = []
  let gap = ''
  const stars = new Map<number, number>()
  for (let cell = 0; cell * STAR_CELL < cols; cell++) {
    const h = hash(cell * 7919 + seed * 104_729)
    if (h % 4 === 0) continue
    stars.set(cell * STAR_CELL + 1 + (h % (STAR_CELL - 2)), h)
  }
  for (let i = 0; i < cols; i++) {
    const h = stars.get(i)
    if (h === undefined) {
      gap += ' '
      continue
    }
    if (gap) segs.push({ t: gap })
    gap = ''
    const b = quantize(twinkle(t, h), 8)
    const glyph = b < 0.2 ? '·' : b < 0.45 ? '∙' : b < 0.75 ? '✧' : '✦'
    segs.push({ t: glyph, c: mix(HEX.dim, h % 3 === 0 ? HEX.glow : HEX.star, 0.25 + 0.75 * b) })
  }
  if (gap) segs.push({ t: gap })
  return segs
}

/** A label lit by a band that sweeps across it; unlit characters keep the theme's color. */
function shimmered(text: string, t: number, seed: number): Seg[] {
  const chars = [...text]
  const out: Seg[] = []
  chars.forEach((ch, i) => {
    const lit = quantize(shimmer(i, chars.length, t + (seed % 1300)), 5)
    const c = lit > 0.1 ? mix(HEX.ink, HEX.shine, lit) : undefined
    const last = out.at(-1)
    if (last && last.c === c) last.t += ch
    else out.push(c ? { t: ch, c } : { t: ch })
  })
  return out
}

/** A label fading in from the dark, `p` (0..1) of the way. */
const fadedIn = (text: string, p: number): Seg[] => [{ t: text, c: mix(HEX.dim, HEX.ink, ease.outCubic(p)) }]

/** Colors the character at `col` of a row, splitting the segment it falls in. */
function recolorAt(line: Line, col: number, color: string) {
  let start = 0
  for (let i = 0; i < line.segs.length; i++) {
    const s = line.segs[i] as Seg
    const chars = [...s.t]
    if (col < start + chars.length) {
      const k = col - start
      const ch = chars[k] ?? ''
      if (!RAIL.has(ch)) return
      const parts: Seg[] = [
        ...(k > 0 ? [{ ...s, t: chars.slice(0, k).join('') }] : []),
        { t: ch, c: color },
        ...(k < chars.length - 1 ? [{ ...s, t: chars.slice(k + 1).join('') }] : []),
      ]
      line.segs.splice(i, 1, ...parts)
      if (line.lead && i < line.lead.n) line.lead.n += parts.length - 1
      return
    }
    start += chars.length
  }
}

/** Sends comets down every live rail: each column's run of consecutive rows is one rail. */
function paintRails(lines: Line[], t: number) {
  const cols = new Set(lines.flatMap(l => l.rails ?? []))
  for (const col of cols) {
    let span: Line[] = []
    const flush = () => {
      span.forEach((l, k) => {
        const b = comet(k, span.length, t, col)
        if (b > 0.06) recolorAt(l, col, mix(HEX.rail, HEX.glow, quantize(b, 6)))
      })
      span = []
    }
    for (const l of lines) {
      if (l.rails?.includes(col)) span.push(l)
      else flush()
    }
    flush()
  }
}

// ---------------------------------------------------------------- the tree

/** A finished agent's glyph: a flash as it finishes, then ●; ✗ when it failed. */
function agentGlyph(a: SkyAgent, x: Ctx): Seg {
  const t = x.ui.t
  if (a.status === 'failed') return { t: '✗', c: C.bad }
  const since = x.ui.doneAt(a.id, true)
  const p = since === null ? 1 : progress(t, since, FLASH_MS)
  if (p >= 1) return { t: '●', c: C.ok }
  return { t: p < 0.35 ? '✦' : '●', c: mix(HEX.flash, HEX.ok, quantize(ease.outCubic(p), 6)) }
}

/** A running agent's glyph cells: retrograde, else a binary star (two cells), else stationary or going direct, else the shift-tinted moon. */
function agentGlyphs(a: SkyAgent, x: Ctx, retro: Retro | null): Seg[] {
  if (a.status !== 'running') return [agentGlyph(a, x)]
  const t = x.ui.t
  const seed = seedOf(a.id)
  const level = shiftLevel(a.cache?.shift)
  const seen = x.ui.shiftSeen(a.id, level)
  const base = moonColor(breathe(t, 1400, (seed % 100) / 100), level, seen.from, t - seen.at)
  const course = x.ui.retroSeen(a.id, retro)
  if (retro?.stage === 'retrograde') return [retroGlyph(t, course, retro, base)]
  const pair = x.pairs.get(a.id)
  if (pair) return binaryCells(t, t - x.ui.bornAt(binaryKey(pair.binary)), pair.index, base)
  if (retro || course) return [retroGlyph(t, course, retro, base)]
  return [{ t: at(ORBIT, t / 150), c: base }]
}

/** `lead` then an agent's glyph; a binary's companion takes lead's last cell, so the glyph and label never move. */
function glyphsAfter(lead: Seg, glyphs: readonly Seg[]): Seg[] {
  const companion = glyphs.length === 2 ? glyphs[0] : undefined
  const glyph = glyphs.slice(-1)
  if (!companion || companion.t === ' ') return [lead, ...glyph]
  const rest = [...lead.t].slice(0, -1).join('')
  return [...(rest ? [{ ...lead, t: rest }] : []), companion, ...glyph]
}

/** A count and its noun, singular for one: `1 tool`, `16 tools`. */
const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** An agent's label: fading in when new, shimmering while it runs. */
function agentPaint(a: SkyAgent, x: Ctx): (text: string) => Seg[] {
  const t = x.ui.t
  const born = progress(t, x.ui.bornAt(a.id), FADE_IN_MS)
  if (born < 1) return text => fadedIn(text, quantize(born, 8))
  if (a.status === 'running' && x.ui.isMoving) return text => shimmered(text, t, seedOf(a.id))
  return text => [{ t: text }]
}

/** The pace each agent of one list is judged against, for the comets (comet.ts's pacer over its siblings). */
type Pace = ReturnType<typeof pacer>

/** A straggler's row: the label lit as the comet's body, its tail trailing into the blank leader. */
function cometRow(a: SkyAgent, left: Seg[], label: string, right: Seg[], lateness: number, gone: number | null, x: Ctx, act: () => void, paint: (text: string) => Seg[]): Line {
  const t = x.ui.t
  const draw = { age: t - x.ui.bornAt(`${a.id}:comet`), seed: seedOf(a.id), gone }
  const m = cometMiddle(label, x.cols - segWidth(left) - segWidth(right), lateness, t, draw)
  // Any `gone` switches cometLabel's shimmer off, and 0 keeps its warmth.
  const lit = x.ui.isMoving ? draw : { ...draw, gone: gone ?? 0 }
  const body = progress(t, x.ui.bornAt(a.id), FADE_IN_MS) < 1 ? paint(m.label) : runsOf(cometLabel(m.label, lateness, t, lit))
  return { key: a.id, segs: [...left, ...body, ...runsOf(m.tail), ...right], act }
}

function agentLines(a: SkyAgent, prefix: string, isLast: boolean, x: Ctx, pace: Pace | null = null): Line[] {
  const t = x.ui.t
  const conn = isLast ? '╰─' : '├─'
  const isLive = a.status === 'running'
  const doneSince = x.ui.doneAt(a.id, a.status === 'done')
  const now = x.now + x.ui.drift
  const retro = isLive ? retroIn(a.watch, now) : null
  const end = isLive ? now : a.endedAt
  const took = a.startedAt === null || end === null ? '' : fmtDuration(end - a.startedAt)
  const right: Seg[] = isLive
    ? [{ t: `${at(SPIN, t / 80)} `, c: C.tool }, { t: cut(toolName(a.lastTool ?? 'thinking'), 14), c: C.tool }, ...(took ? [{ t: ` ${took}`, dim: true }] : [])]
    : a.status === 'failed'
      ? [{ t: cut(a.error ?? 'failed', 18), c: C.bad }, ...(took ? [{ t: ` ${took}`, dim: true }] : [])]
      : [...(a.costUsd !== null && x.level !== 'naked-eye' ? [{ t: `${fmtUsd(a.costUsd)}${took ? ' ' : ''}`, c: C.cost }] : []), ...(took ? [{ t: took, dim: true }] : [])]
  const inspect = () => x.ui.post({ type: 'inspect', kind: 'agent', key: a.id, runKey: x.runKey })
  const left: Seg[] = [{ t: prefix, c: C.rail }, ...glyphsAfter({ t: conn, c: C.rail }, agentGlyphs(a, x, retro))]
  const label = ` ${a.label}`
  const paint = agentPaint(a, x)
  // A finished straggler's tail scatters briefly; a retrograde one has none, its label plain (a stationary one keeps it).
  const gone = a.status === 'done' && doneSince !== null ? t - doneSince : null
  const canComet = pace !== null && retro?.stage !== 'retrograde' && (isLive || (gone !== null && gone < COMET.exitMs))
  const lateness = canComet ? latenessAt(a, pace(a), now) : null
  const line = isStraggler(lateness)
    ? cometRow(a, left, label, right, lateness, gone, x, inspect, paint)
    : row(a.id, left, { t: label }, right, x.cols, ' ', inspect, paint)
  const lines: Line[] = [{ ...line, rails: x.rails }]
  const facts = isLive && x.budget.details > 0 ? detailFacts(a, retro, x.ui.retroSeen(a.id, retro), x.level) : []
  if (facts.length > 0) {
    x.budget.details -= 1
    const indent = `${prefix}${isLast ? '   ' : '│  '}  `
    lines.push({ key: `${a.id}:detail`, segs: [{ t: indent, c: C.rail }, ...joinFacts(facts, x.cols - width(indent))], rails: x.rails })
  }
  return lines
}

/** A running agent's detail facts at `level`; the naked eye gets none unless it is retrograde, or going direct from it. */
function detailFacts(a: SkyAgent, retro: Retro | null, course: RetroSeen | null, level: DetailLevel): Seg[] {
  const facts: Seg[] = []
  if (retro && (retro.stage === 'retrograde' || level === 'telescope')) facts.push(retroFact(retro))
  else if (!retro && course?.stage === 'direct' && (course.formed || level === 'telescope')) facts.push(DIRECT_FACT)
  if (level === 'naked-eye') return facts
  if (a.model) facts.push({ t: a.model, c: C.model })
  if (a.effort) facts.push({ t: a.effort, c: C.effort })
  if (level === 'telescope') {
    if (a.tokens !== null) facts.push({ t: `${fmtTokens(a.tokens)} ctx`, dim: true })
    // A tinted moon explains itself in place of the tool count.
    const cached = cachedFact(a.cache)
    if (cached) facts.push(cached)
    else if (a.tools !== null) facts.push({ t: counted(a.tools, 'tool'), dim: true })
  }
  if (a.costUsd !== null) facts.push({ t: fmtUsd(a.costUsd), c: C.cost })
  if (facts.length === 0) facts.push({ t: 'waiting for its first answer', dim: true })
  return facts
}

/** The agents a list shows: running and failed ones, and the newest DONE_SHOWN finished unless all are asked for. */
function shown(agents: readonly SkyAgent[], hidden: number, allKey: string, x: Ctx): { agents: SkyAgent[]; more: number; showAll: boolean } {
  const showAll = x.ui.isOpen(allKey, false)
  const done = agents.filter(a => a.status === 'done')
  const keep = new Set(showAll ? done : done.slice(-DONE_SHOWN))
  return { agents: agents.filter(a => a.status !== 'done' || keep.has(a)), more: done.length - keep.size + hidden, showAll }
}

/** The row that folds a list's finished agents away, or brings them back. */
function moreLine(allKey: string, inner: string, isLast: boolean, more: number, hidden: number, showAll: boolean, x: Ctx): Line {
  const text = showAll ? (hidden > 0 ? ` fewer (${hidden} older not kept)` : ' fewer') : ` … ${more} more done`
  const left: Seg[] = [{ t: inner, c: C.rail }, { t: isLast ? '╰─' : '├─', c: C.rail }, { t: '●', c: C.ok, dim: true }]
  return { ...row(allKey, left, { t: text, dim: true }, [], x.cols, ' ', () => x.ui.toggle(allKey, false)), rails: x.rails }
}

function nodeGlyph(n: SkyNode, t: number): Seg {
  const swell = quantize(breathe(t, 1700, (seedOf(n.key) % 100) / 100), 6)
  if (n.kind === 'child') {
    if (n.status === 'running') return { t: '✦', c: mix(HEX.child, HEX.childGlow, swell) }
    return { t: '✧', c: n.status === 'pending' ? C.idle : C.child }
  }
  if (n.status === 'running') return { t: '◉', c: mix(HEX.live, HEX.glow, swell) }
  if (n.status === 'done') return { t: '◉', c: C.ok }
  if (n.status === 'failed') return { t: '✗', c: C.bad }
  return { t: '○', c: C.idle }
}

/** Whether a node shares its level: another of the `nodes` beside it, or any agent, shown or folded away. */
const sharesLevel = (nodes: number, agents: number) => nodes > 1 || agents > 0

/** A phase's or child workflow's rows; its cost shows only beside siblings (`isCrowded`), else it would repeat its parent's. */
function nodeLines(n: SkyNode, prefix: string, isLast: boolean, x: Ctx, isCrowded: boolean): Line[] {
  const conn = isLast ? '╰─' : '├─'
  const isLive = n.status === 'running'
  const hasContent = n.agents.length + n.children.length + n.hidden > 0
  const byDefault = isLive || (n.counts.failed > 0 && x.isRunLive) || (x.isPast && hasContent)
  const isOpen = hasContent && x.ui.isOpen(n.key, byDefault)
  const time = n.startedAt === null ? '' : fmtDuration((n.endedAt ?? x.now + x.ui.drift) - n.startedAt)
  const right: Seg[] = [...countSegs(n.counts)]
  if (n.status === 'done' && n.counts.failed === 0) right.push({ t: ' ✔', c: C.ok })
  if (time) right.push({ t: ` ${time}`, dim: true })
  if (n.costUsd !== null && isCrowded && x.level !== 'naked-eye') right.push({ t: ` ${fmtUsd(n.costUsd)}`, c: C.cost })
  const title = hasContent && !isOpen ? `${n.title} ›` : n.title
  const born = progress(x.ui.t, x.ui.bornAt(n.key), FADE_IN_MS)
  const label: Seg = { t: ` ${title}`, dim: n.status === 'pending', bold: isLive }
  const paint = born < 1 ? (text: string) => fadedIn(text, quantize(born, 8)) : undefined
  const left: Seg[] = [{ t: prefix, c: C.rail }, { t: conn, c: C.rail }, nodeGlyph(n, x.ui.t)]
  const inspect = () => x.ui.post({ type: 'inspect', kind: 'node', key: n.key, runKey: x.runKey })
  const head = row(n.key, left, label, right, x.cols, '·', inspect, paint)
  const lines: Line[] = [{ ...head, lead: hasContent ? { n: left.length, act: () => x.ui.toggle(n.key, byDefault) } : undefined, rails: x.rails }]
  if (!isOpen) return lines
  const inner = `${prefix}${isLast ? '   ' : '│  '}`
  const sub: Ctx = isLive ? { ...x, rails: [...x.rails, width(inner)] } : x
  const allKey = `${n.key}:all`
  const { agents, more, showAll } = shown(n.agents, n.hidden, allKey, sub)
  // Judged against every agent of the node, not only those shown.
  const pace = pacer(n.agents, n.hidden)
  type Item = { kind: 'agent'; a: SkyAgent } | { kind: 'node'; n: SkyNode } | { kind: 'more' }
  const items: Item[] = [
    ...agents.map(a => ({ kind: 'agent' as const, a })),
    ...(more > 0 || showAll ? [{ kind: 'more' as const }] : []),
    ...n.children.map(c => ({ kind: 'node' as const, n: c })),
  ]
  items.forEach((it, i) => {
    const last = i === items.length - 1
    if (it.kind === 'agent') lines.push(...agentLines(it.a, inner, last, sub, pace))
    else if (it.kind === 'node') lines.push(...nodeLines(it.n, inner, last, sub, sharesLevel(n.children.length, n.agents.length + n.hidden)))
    else lines.push(moreLine(allKey, inner, last, more, n.hidden, showAll, sub))
  })
  return lines
}

function runStar(r: SkyRun, t: number, isGroup: boolean): Seg {
  const isLive = r.status === 'running'
  const color = r.status === 'completed' ? C.ok : r.status === 'killed' ? C.cost : C.bad
  if (!isLive) return { t: isGroup ? '✧' : '✦', c: isGroup ? C.child : color, bold: true }
  const glow = quantize(breathe(t, 2000), 6)
  return { t: isGroup ? '✦' : at(TWINKLE, t / 130), c: mix(isGroup ? HEX.child : HEX.live, isGroup ? HEX.childGlow : HEX.glow, glow), bold: true }
}

function runLines(r: SkyRun, x: Ctx, isNewest: boolean, isGroup: boolean): Line[] {
  const t = x.ui.t
  const isLive = r.status === 'running'
  const color = isLive ? C.live : r.status === 'completed' ? C.ok : r.status === 'killed' ? C.cost : C.bad
  const byDefault = isLive || isNewest || x.isPast
  const isOpen = x.ui.isOpen(r.key, byDefault)
  const time = r.startedAt === null ? '' : fmtDuration((r.endedAt ?? x.now + x.ui.drift) - r.startedAt)
  const mark = isGroup ? '' : isLive ? at(SPIN, t / 80) : r.status === 'completed' ? '✔' : r.status === 'killed' ? '◌' : '✗'
  const right: Seg[] = [...countSegs(r.counts)]
  if (mark) right.push({ t: ` ${mark}`, c: color })
  if (time && !isGroup) right.push({ t: ` ${time}`, dim: true })
  const left: Seg[] = [{ t: ' ' }, runStar(r, t, isGroup)]
  const fold = () => x.ui.toggle(r.key, byDefault)
  const inspect = isGroup ? fold : () => x.ui.post({ type: 'inspect', kind: 'run', key: r.key, runKey: r.key })
  const canClear = !x.isPast && (isGroup ? r.counts.done + r.counts.failed > 0 : !isLive)
  const cross: Seg[] = canClear ? [{ t: ' ✕', c: C.rail }] : []
  const head = row(r.key, left, { t: ` ${isOpen ? r.name : `${r.name} ›`}`, bold: true }, [...right, ...cross], x.cols, ' ', inspect)
  const dismiss = () => x.ui.post({ type: 'dismiss', runKey: r.key })
  const lines: Line[] = [{ ...head, lead: isGroup ? undefined : { n: left.length, act: fold }, tail: canClear ? { n: 1, act: dismiss } : undefined }]
  if (!isOpen) return lines
  const rail: Seg = { t: ' │', c: C.rail }
  const rails = isLive ? [1] : []
  // The run's cost and tool count are the footer's alone.
  if (r.description) lines.push({ key: `${r.key}:desc`, segs: [rail, { t: ` ${cut(r.description, x.cols - 3)}`, dim: true }], rails })
  // Binary stars: files its agents share with running agents anywhere. Not pressable.
  binaryRows(binariesIn(r, x.binaries), x.cols - 3, t, b => t - x.ui.bornAt(binaryKey(b))).forEach((cells, i) =>
    lines.push({ key: `${r.key}:binary:${i}`, segs: [rail, { t: ' ' }, ...runsOf(cells)], rails }),
  )
  const sub: Ctx = { ...x, isRunLive: isLive, runKey: r.key, rails }
  const allKey = `${r.key}:all`
  const loose = shown(r.loose, r.looseHidden, allKey, sub)
  // Loose agents are judged against each other; a subagent only against its own type launched in the same burst.
  const pace = pacer(r.loose, r.looseHidden, isGroup)
  type Item = { kind: 'node'; n: SkyNode } | { kind: 'agent'; a: SkyAgent } | { kind: 'more' }
  const items: Item[] = [
    ...r.nodes.map(n => ({ kind: 'node' as const, n })),
    ...loose.agents.map(a => ({ kind: 'agent' as const, a })),
    ...(loose.more > 0 || loose.showAll ? [{ kind: 'more' as const }] : []),
  ]
  if (items.length > 0 && !isGroup) lines.push({ key: `${r.key}:gap`, segs: [rail], rails })
  if (items.length === 0) lines.push({ key: `${r.key}:none`, segs: [{ t: ' ╰─', c: C.rail }, { t: ' no agents yet', dim: true }] })
  items.forEach((it, i) => {
    const last = i === items.length - 1
    if (it.kind === 'node') lines.push(...nodeLines(it.n, ' ', last, sub, sharesLevel(r.nodes.length, r.loose.length + r.looseHidden)))
    else if (it.kind === 'agent') lines.push(...agentLines(it.a, ' ', last, sub, pace))
    else lines.push(moreLine(allKey, ' ', last, loose.more, r.looseHidden, loose.showAll, sub))
  })
  return lines
}

// ---------------------------------------------------------------- views

const NOVA_MS = 2600

/** Whether the star is mid-supernova. */
const isNova = (x: Ctx) => x.ui.novaAt !== null && x.ui.t - x.ui.novaAt >= 0 && x.ui.t - x.ui.novaAt < NOVA_MS

/** What the star says in `room` columns: the eclipse's caption while a wait is open (silent as it slides off), else its stage. */
function starWords(p: SkyProps, x: Ctx, stage: { name: string; color: string }, room: number): Seg {
  if (p.waiting && x.ui.eclipse?.outAge === null) return { t: eclipseCaption(p.waiting, x.now + x.ui.drift - p.waiting.since, room), c: ECLIPSE_COLOR }
  return { t: cut(stage.name, room), c: stage.color }
}

/** The band of sky with the session's star at its right when wide enough, its words beneath, meteors and the eclipse. */
function bandLines(p: SkyProps, x: Ctx): Line[] {
  const t = x.ui.t
  const isLive = p.runs.some(r => r.status === 'running') || p.subagents?.status === 'running'
  const hasStar = x.cols >= 46
  const leftW = x.cols - 1 - (hasStar ? STAR_W + 1 : 0)
  const band = skyBand(p.sky, leftW, t, p.runs[0] ?? null, isLive, x.ui.shots, x.ui.samples, id => x.ui.doneAt(id, true))
  const meteors = x.ui.meteors
  // No overlay on the still tree: its meteors would freeze on screen.
  const isWet = x.ui.isMoving && isRaining(meteors, t)
  const rain = (rows: readonly Seg[][]): Seg[][] => (isWet ? meteorOverlay(rows.map(cellsOf), t, meteors).map(runsOf) : [...rows])
  const stage = starStage(p.gauge?.percent ?? null, isNova(x), p.gauge?.isReborn ?? false)
  // A narrow pane has no star and no extra row, so the tree never moves while it rains; only an eclipse adds one.
  if (!hasStar) {
    const lines: Line[] = rain(band).map((cells, i) => ({ key: `band-${i}`, segs: [{ t: ' ' }, ...cells] }))
    if (x.ui.eclipse) lines.push({ key: 'star-stage', segs: [{ t: ' ' }, eclipseGlyph(t, x.ui.eclipse, stage.color), { t: ' ' }, starWords(p, x, stage, x.cols - 3)] })
    return lines
  }
  const shown = starCells(p.gauge?.percent ?? null, t, x.ui.novaAt, p.gauge?.compactions ?? 0, p.gauge?.isReborn ?? false)
  const star = x.ui.eclipse ? eclipseCells(shown, t, x.ui.eclipse, { radius: starRadius(p.gauge?.percent ?? null), color: stage.color }) : shown
  const rows = Math.max(band.length, STAR_H)
  // Filler rows are sky the meteors fall through too.
  const left = rain(Array.from({ length: rows }, (_, i) => band[i] ?? (i % 2 === 1 ? starfield(leftW, t, 20 + i) : [{ t: ' '.repeat(leftW) }])))
  const lines: Line[] = left.map((cells, i) => ({ key: `band-${i}`, segs: [{ t: ' ' }, ...cells, { t: ' ' }, ...runsOf(star[i] ?? [])] }))
  // The star's words get room first: an eclipse's ask must stay readable.
  const label = starWords(p, x, stage, x.cols - 2)
  const words = showerCaption(meteors, t, x.cols - 2 - width(label.t) - 4)
  const gap = Math.max(1, x.cols - 1 - (words ? 1 + width(words.t) : 0) - width(label.t))
  lines.push({ key: 'star-stage', segs: [...(words ? [{ t: ' ' }, words] : []), { t: ' '.repeat(gap) }, label] })
  return lines
}

/** The star in one line, for views without a band: its stage, or the eclipse over it. */
function starLine(p: SkyProps, x: Ctx): Line {
  const stage = starStage(p.gauge?.percent ?? null, isNova(x), p.gauge?.isReborn ?? false)
  const glow = quantize(breathe(x.ui.t, 1600), 6)
  const glyph: Seg = x.ui.eclipse ? eclipseGlyph(x.ui.t, x.ui.eclipse, stage.color) : { t: '●', c: mix(stage.color, HEX.shine, glow * 0.3) }
  return { key: 'star-line', segs: [{ t: ' ' }, glyph, { t: ' ' }, starWords(p, x, stage, x.cols - 3)] }
}

function liveLines(p: SkyProps, x: Ctx): Line[] {
  const t = x.ui.t
  const lines: Line[] = bandLines(p, x)
  if (p.runs.length === 0 && !p.subagents) {
    lines.push({ key: 'sky-2', segs: starfield(x.cols, t, 2) })
    lines.push({ key: 'empty-1', segs: [{ t: '   no workflow runs yet', dim: true }] })
    lines.push({ key: 'empty-2', segs: [{ t: '   they light up here the moment one starts', dim: true }] })
    lines.push({ key: 'sky-4', segs: starfield(x.cols, t, 4) })
    return lines
  }
  p.runs.forEach((r, i) => {
    lines.push(...runLines(r, x, i === 0, false))
    lines.push({ key: `${r.key}:end`, segs: [{ t: '' }] })
  })
  if (p.subagents) lines.push(...runLines(p.subagents, x, true, true), { key: 'subagents:end', segs: [{ t: '' }] })
  lines.push(...footerLines([...p.runs, ...(p.subagents ? [p.subagents] : [])], x))
  const finished = p.runs.filter(r => r.status !== 'running').length
  const ended = p.subagents ? p.subagents.counts.done + p.subagents.counts.failed : 0
  if (finished + ended > 0) {
    const what = [finished > 0 ? `${finished} finished run${finished === 1 ? '' : 's'}` : '', ended > 0 ? `${ended} ended subagent${ended === 1 ? '' : 's'}` : '']
    lines.push({
      key: 'clear',
      segs: [{ t: ' ✕ ', c: C.rail }, { t: `clear ${what.filter(Boolean).join(' and ')}`, dim: true }],
      act: () => x.ui.post({ type: 'clear' }),
    })
  }
  return lines
}

/** The rule and totals of every run above: the only place the tree shows their cost and tool count. */
function footerLines(all: readonly SkyRun[], x: Ctx): Line[] {
  const agents = all.reduce((n, r) => n + r.counts.done + r.counts.running + r.counts.failed, 0)
  const live = all.reduce((n, r) => n + r.counts.running, 0)
  const costs = all.map(r => r.costUsd).filter((c): c is number => c !== null)
  const tools = all.reduce((n, r) => n + r.tools, 0)
  const footer: Seg[] = [{ t: ` ${counted(agents, 'agent')}`, dim: true }]
  if (live > 0) footer.push({ t: ' · ', dim: true }, { t: `${live} live`, c: C.live })
  if (costs.length > 0) footer.push({ t: ' · ', dim: true }, { t: `≈${fmtUsd(costs.reduce((a, b) => a + b, 0))}`, c: C.cost })
  if (tools > 0) footer.push({ t: ` · ${counted(tools, 'tool')}`, dim: true })
  return [
    { key: 'rule', segs: [{ t: ` ${'─'.repeat(Math.max(0, x.cols - 2))}`, c: C.line, dim: true }] },
    { key: 'footer', segs: clip(footer, x.cols) },
  ]
}

function historyLines(p: SkyProps, x: Ctx): Line[] {
  const lines: Line[] = []
  if (p.isLoading && p.history.length === 0) {
    lines.push({ key: 'loading', segs: [{ t: ` ${at(SPIN, x.ui.t / 80)} `, c: C.live }, { t: 'reading past runs…', dim: true }] })
    return lines
  }
  lines.push(
    row('h:title', [{ t: ' ' }, { t: '◷', c: C.live }], { t: ' past runs', bold: true }, [{ t: `${p.history.length}${p.isLoading ? ` ${at(SPIN, x.ui.t / 80)}` : ''}`, dim: true }], x.cols, ' '),
  )
  if (p.history.length === 0) lines.push({ key: 'h:none', segs: [{ t: ' ╰─', c: C.rail }, { t: ' none found', dim: true }] })
  p.history.forEach((h: SkyHistoryLine, i) => {
    const last = i === p.history.length - 1
    const color = h.status === 'completed' ? C.ok : h.status === 'killed' ? C.cost : C.bad
    const right: Seg[] = [{ t: `${h.agents}●`, c: C.ok }]
    if (h.durationMs !== null) right.push({ t: ` ${fmtDuration(h.durationMs)}`, dim: true })
    if (h.startedAt !== null) right.push({ t: ` ${fmtWhen(h.startedAt)}`, dim: true })
    lines.push(
      row(`h:${h.path}`, [{ t: ' ' }, { t: last ? '╰─' : '├─', c: C.rail }, { t: '✦', c: color }], { t: ` ${h.name} (${h.project})` }, right, x.cols, ' ', () =>
        x.ui.post({ type: 'open', path: h.path }),
      ),
    )
  })
  return lines
}

function pastLines(p: SkyProps, x: Ctx): Line[] {
  const lines: Line[] = [
    { key: 'back', segs: [{ t: ' ‹ ', c: C.live }, { t: 'back to history', dim: true }], act: () => x.ui.post({ type: 'mode', mode: 'history' }) },
  ]
  if (p.note) lines.push({ key: 'note', segs: [{ t: ` ${at(SPIN, x.ui.t / 80)} `, c: C.live }, { t: p.note, dim: true }] })
  lines.push({ key: 'gap', segs: [{ t: '' }] })
  for (const r of p.runs) lines.push(...runLines(r, x, true, false))
  if (p.runs.length > 0) lines.push({ key: 'past:end', segs: [{ t: '' }] }, ...footerLines(p.runs, x))
  return lines
}

// ---------------------------------------------------------------- the inspector

function section(key: string, title: string, count: string, cols: number): Line {
  const head = ` ─ ${title} `
  const tail = count ? ` ${count}` : ''
  return { key, segs: [{ t: head, c: C.line }, { t: '─'.repeat(Math.max(2, cols - width(head) - width(tail) - 1)), c: C.line, dim: true }, { t: tail, dim: true }] }
}

/** Wrapped text that opens in full on a press. */
function prose(key: string, text: string, max: number, x: Ctx): Line[] {
  const isAll = x.ui.isOpen(key, false)
  const lines = wrap(text, x.cols - 3, isAll ? 60 : max)
  const isCut = !isAll && wrap(text, x.cols - 3, max + 1).length > max
  const act = isCut || isAll ? () => x.ui.toggle(key, false) : undefined
  return lines.map((l, i) => ({ key: `${key}:${i}`, segs: [{ t: `   ${l}`, dim: true }], act }))
}

function toolLines(tools: readonly TraceTool[], total: number, isRunning: boolean, x: Ctx): Line[] {
  const key = 'i:tools'
  const isAll = x.ui.isOpen(key, false)
  const list = isAll ? tools : tools.slice(-12)
  const lines: Line[] = [section(key, 'tools', `${total}`, x.cols)]
  if (list.length === 0) lines.push({ key: `${key}:none`, segs: [{ t: '   none yet', dim: true }] })
  for (const tool of list) {
    const isOpen = tool.status === 'running' && isRunning
    const glyph: Seg =
      tool.status === 'ok'
        ? { t: '✓', c: C.ok }
        : tool.status === 'error'
          ? { t: '✗', c: C.bad }
          : tool.status === 'denied'
            ? { t: '⊘', c: C.bad }
            : isOpen
              ? { t: at(SPIN, x.ui.t / 80), c: C.tool }
              : { t: '·', dim: true }
    const end = tool.endedAt ?? (isOpen ? x.now + x.ui.drift : null)
    const took = tool.startedAt !== null && end !== null ? fmtDuration(end - tool.startedAt) : ''
    const right: Seg[] = took ? [{ t: took, dim: true }] : []
    const name = cut(toolName(tool.name), 8).padEnd(8, ' ')
    lines.push(row(`t:${tool.id}`, [{ t: ' ' }, glyph, { t: ` ${name}`, c: C.tool }], { t: ` ${tool.summary}`, dim: true }, right, x.cols, ' '))
    if (tool.note) lines.push({ key: `t:${tool.id}:note`, segs: [{ t: '   ↳ ', c: C.rail }, { t: cut(tool.note, x.cols - 5), c: C.bad }] })
  }
  if (tools.length > 12 || total > tools.length) {
    const text = isAll ? ` fewer${total > tools.length ? ` (${total - tools.length} older not kept)` : ''}` : ` … ${total - list.length} earlier`
    lines.push({ key: `${key}:more`, segs: [{ t: '  ' }, { t: text, dim: true }], act: () => x.ui.toggle(key, false) })
  }
  return lines
}

function checkLines(checks: readonly CheckEvent[], x: Ctx): Line[] {
  const key = 'i:checks'
  const isAll = x.ui.isOpen(key, false)
  const list = isAll ? checks : checks.slice(-10)
  const denied = checks.filter(c => c.decision === 'deny').length
  const lines: Line[] = [section(key, 'permissions', denied > 0 ? `${denied} denied` : `${checks.length}`, x.cols)]
  if (list.length === 0) lines.push({ key: `${key}:none`, segs: [{ t: '   none seen (checks show while the mod watches the agent)', dim: true }] })
  list.forEach((c, i) => {
    const glyph: Seg = c.decision === 'allow' ? { t: '✓ allow', c: C.ok } : c.decision === 'ask' ? { t: '? ask  ', c: C.cost } : { t: '✗ deny ', c: C.bad }
    const tool = cut(toolName(c.tool), 8).padEnd(8, ' ')
    lines.push(row(`c:${i}`, [{ t: ' ' }, glyph, { t: ` ${tool}`, c: C.tool }], { t: ` ${c.summary}`, dim: true }, [{ t: cut(c.by, 26), dim: c.decision === 'allow', c: c.decision === 'deny' ? C.bad : undefined }], x.cols, ' '))
  })
  if (checks.length > 10) lines.push({ key: `${key}:more`, segs: [{ t: '  ' }, { t: isAll ? ' fewer' : ` … ${checks.length - 10} earlier`, dim: true }], act: () => x.ui.toggle(key, false) })
  return lines
}

function factLines(facts: readonly { label: string; value: string }[], x: Ctx): Line[] {
  return facts.map(f => ({ key: `f:${f.label}`, segs: [{ t: ` ${f.label.padEnd(12, ' ')}`, dim: true }, { t: cut(f.value, x.cols - 14) }] }))
}

function inspectLines(i: SkyInspect, x: Ctx): Line[] {
  const t = x.ui.t
  const back: Line = {
    key: 'i:back',
    segs: [{ t: ' ‹ back ', c: C.live }, ...clip([{ t: ` ${i.crumbs.join(' › ')}`, dim: true }], x.cols - 9)],
    lead: { n: 1, act: () => x.ui.post({ type: 'back' }) },
  }
  const lines: Line[] = [back, { key: 'i:gap', segs: [{ t: '' }] }]
  // An inspector tells everything, whatever the level.
  const sub: Ctx = { ...x, runKey: i.runKey, level: 'telescope' }
  if (i.kind === 'agent' && i.agent) {
    const a = i.agent
    const isLive = a.status === 'running'
    const retro = isLive ? retroIn(a.watch, x.now + x.ui.drift) : null
    const end = isLive ? x.now + x.ui.drift : a.endedAt
    const took = a.startedAt !== null && end !== null ? fmtDuration(end - a.startedAt) : ''
    const state: Seg[] = isLive ? [{ t: `${at(SPIN, t / 80)} running`, c: C.live }] : a.status === 'done' ? [{ t: '✔ done', c: C.ok }] : [{ t: '✗ failed', c: C.bad }]
    lines.push(row('i:title', glyphsAfter({ t: ' ' }, agentGlyphs(a, sub, retro)), { t: ` ${a.label}`, bold: true }, [...state, ...(took ? [{ t: ` ${took}`, dim: true }] : [])], x.cols, ' ', undefined, isLive && x.ui.isMoving ? text => shimmered(text, t, seedOf(a.id)) : undefined))
    const facts: Seg[] = []
    const add = (seg: Seg) => {
      if (facts.length > 0) facts.push({ t: ' · ', c: C.line, dim: true })
      facts.push(seg)
    }
    if (a.model) add({ t: a.model, c: C.model })
    if (a.effort) add({ t: a.effort, c: C.effort })
    if (a.tokens !== null) add({ t: `${fmtTokens(a.tokens)} ctx`, dim: true })
    if (a.tools !== null) add({ t: counted(a.tools, 'tool'), dim: true })
    if (a.costUsd !== null) add({ t: `≈${fmtUsd(a.costUsd)}`, c: C.cost })
    if (facts.length > 0) lines.push({ key: 'i:facts', segs: [{ t: ' ' }, ...clip(facts, x.cols - 1)] })
    const course = isLive ? x.ui.retroSeen(a.id, retro) : null
    if (retro) lines.push({ key: 'i:retro', segs: [{ t: ' ' }, retroFact(retro)] })
    else if (course?.stage === 'direct') lines.push({ key: 'i:retro', segs: [{ t: ' ' }, DIRECT_FACT] })
    const legend = a.cache ? shiftLegend(a.cache, isLive, x.cols - 1) : []
    if (legend.length > 0) lines.push({ key: 'i:shift', segs: [{ t: ' ' }, ...legend] })
    if (a.error) lines.push({ key: 'i:error', segs: [{ t: ' ' }, { t: cut(a.error, x.cols - 1), c: C.bad }] })
    lines.push(...factLines(i.facts, x))
    if (i.traceNote) lines.push({ key: 'i:note', segs: [{ t: ` ${i.trace ? '' : `${at(SPIN, t / 80)} `}`, c: C.live }, { t: i.traceNote, dim: true }] })
    if (i.trace?.prompt) lines.push({ key: 'i:gap2', segs: [{ t: '' }] }, section('i:prompt-h', 'prompt', '', x.cols), ...prose('i:prompt', i.trace.prompt, 4, x))
    lines.push({ key: 'i:gap3', segs: [{ t: '' }] }, ...toolLines(i.trace?.tools ?? [], i.trace?.toolCount ?? 0, isLive, sub))
    lines.push({ key: 'i:gap4', segs: [{ t: '' }] }, ...checkLines(i.checks, x))
    lines.push({ key: 'i:gap5', segs: [{ t: '' }] }, section('i:answer-h', 'last answer', '', x.cols))
    lines.push(...(i.trace?.answer ? prose('i:answer', i.trace.answer, 6, x) : [{ key: 'i:answer-none', segs: [{ t: isLive ? '   (still running)' : '   (none)', dim: true }] }]))
    return lines
  }
  if (i.kind === 'node' && i.node) {
    const n = i.node
    const right: Seg[] = [...countSegs(n.counts)]
    if (n.startedAt !== null) right.push({ t: ` ${fmtDuration((n.endedAt ?? x.now + x.ui.drift) - n.startedAt)}`, dim: true })
    if (n.costUsd !== null) right.push({ t: ` ${fmtUsd(n.costUsd)}`, c: C.cost })
    lines.push(row('i:title', [{ t: ' ' }, nodeGlyph(n, t)], { t: ` ${n.title}`, bold: true }, right, x.cols, ' '))
    if (n.detail) lines.push(...prose('i:detail', n.detail, 4, x))
    if (n.children.length > 0) {
      lines.push({ key: 'i:gap2', segs: [{ t: '' }] }, section('i:children', 'child workflows', `${n.children.length}`, x.cols))
      n.children.forEach((c, k) => lines.push(...nodeLines({ ...c, agents: [], children: [], hidden: 0 }, ' ', k === n.children.length - 1, sub, true)))
    }
    lines.push({ key: 'i:gap3', segs: [{ t: '' }] }, section('i:agents', 'agents', `${n.agents.length + n.hidden}`, x.cols))
    const pace = pacer(n.agents, n.hidden)
    n.agents.forEach((a, k) => lines.push(...agentLines(a, ' ', k === n.agents.length - 1, { ...sub, budget: { details: 0 } }, pace)))
    if (n.agents.length === 0) lines.push({ key: 'i:agents-none', segs: [{ t: '   none of its own', dim: true }] })
    return lines
  }
  if (i.kind === 'run' && i.run) {
    const r = i.run
    const isLive = r.status === 'running'
    const state: Seg = isLive ? { t: `${at(SPIN, t / 80)} running`, c: C.live } : r.status === 'completed' ? { t: '✔ completed', c: C.ok } : { t: `✗ ${r.status}`, c: C.bad }
    const end = r.endedAt ?? (isLive ? x.now + x.ui.drift : null)
    const right: Seg[] = [...countSegs(r.counts), { t: ` ${state.t}`, c: state.c }]
    if (r.startedAt !== null && end !== null) right.push({ t: ` ${fmtDuration(end - r.startedAt)}`, dim: true })
    lines.push(row('i:title', [{ t: ' ' }, runStar(r, t, false)], { t: ` ${r.name}`, bold: true }, right, x.cols, ' '))
    const totals: Seg[] = []
    if (r.costUsd !== null) totals.push({ t: `≈${fmtUsd(r.costUsd)}`, c: C.cost })
    if (r.tools > 0) totals.push({ t: `${totals.length ? ' · ' : ''}${counted(r.tools, 'tool')}`, dim: true })
    if (totals.length > 0) lines.push({ key: 'i:totals', segs: [{ t: ' ' }, ...clip(totals, x.cols - 1)] })
    if (r.description) lines.push(...prose('i:desc', r.description, 4, x))
    lines.push(...factLines(i.facts, x))
    lines.push({ key: 'i:gap2', segs: [{ t: '' }] }, section('i:phases', 'phases', `${r.nodes.length}`, x.cols))
    r.nodes.forEach((n, k) => lines.push(...nodeLines({ ...n, agents: [], children: [], hidden: 0 }, ' ', k === r.nodes.length - 1 && r.loose.length === 0, sub, true)))
    const pace = pacer(r.loose, r.looseHidden)
    r.loose.forEach((a, k) => lines.push(...agentLines(a, ' ', k === r.loose.length - 1, { ...sub, budget: { details: 0 } }, pace)))
    return lines
  }
  lines.push({ key: 'i:gone', segs: [{ t: '   that node is no longer here', dim: true }] })
  return lines
}

// ---------------------------------------------------------------- drawing

/** Keeps the tree under a Client's 100,000 serialized characters (past that it unmounts); a Button's label counts twice. */
function fit(lines: readonly Line[], cols: number): Line[] {
  let used = 0
  for (const [i, l] of lines.entries()) {
    used += 120 + l.segs.reduce((n, s) => n + 70 + s.t.length * (l.act || l.lead ? 2 : 1), 0)
    if (used > TREE_BUDGET) {
      const rest = lines.length - i
      return [...lines.slice(0, i), { key: 'cut', segs: [{ t: cut(` … ${rest} more rows: fold finished runs to see them`, cols), dim: true }] }]
    }
  }
  return [...lines]
}

function attrs(s: Seg): { color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean } {
  const a: { color?: string; backgroundColor?: string; dimColor?: boolean; bold?: boolean } = {}
  if (s.c) a.color = s.c
  if (s.bg) a.backgroundColor = s.bg
  if (s.dim && !s.c?.startsWith('#')) a.dimColor = true
  if (s.bold) a.bold = true
  return a
}

/** Draws the sky with any host's elements: the surface module's own, or a hooks module's where no `Client` is. */
export function drawSky(els: SkyElements, p: SkyProps, ui: SkyUi): RenderElement {
  const { Box, Text, Button } = els
  const cols = Math.max(24, p.columns)
  // Props from an older hooks module (mid-reload) may lack these two.
  const binaries = p.binaries ?? []
  const level = p.detail ?? 'naked-eye'
  const x: Ctx = { ui, cols, now: p.now, isPast: p.mode === 'past', isRunLive: false, runKey: '', rails: [], budget: { details: DETAILS_SHOWN }, level, binaries, pairs: binaryOfAgent(binaries) }
  const body =
    p.mode === 'inspect' && p.inspect
      ? inspectLines(p.inspect, x)
      : p.mode === 'history'
        ? historyLines(p, x)
        : p.mode === 'past'
          ? pastLines(p, x)
          : liveLines(p, x)
  paintRails(body, ui.t)
  const lines = fit(p.mode === 'live' ? body : [starLine(p, x), ...body], cols)
  const isLive = p.runs.some(r => r.status === 'running') || p.subagents?.status === 'running'
  const glow = quantize(breathe(ui.t, 2000), 6)
  const tab = (mode: 'live' | 'history', label: string) => {
    const isOn = p.mode === mode || (mode === 'history' && p.mode === 'past') || (mode === 'live' && p.mode === 'inspect')
    return (
      <Button key={`tab-${mode}`} plain onPress={() => ui.post({ type: 'mode', mode })}>
        <Text {...(isOn ? { color: C.live, bold: true } : { dimColor: true })}>{isOn ? `[${label}]` : ` ${label} `}</Text>
      </Button>
    )
  }
  const text = (segs: readonly Seg[]) => segs.map(s => <Text {...attrs(s)}>{s.t}</Text>)
  // Only where the level changes the drawing.
  const hasLevel = (p.mode === 'live' || p.mode === 'past') && hasLevelRoom(cols, p.caption)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={isLive ? mix(HEX.live, HEX.glow, glow) : C.ok} bold>
            {` ${isLive ? at(TWINKLE, ui.t / 130) : '✦'}`}
          </Text>
          <Text bold> constellation</Text>
          {p.caption ? <Text color={HEX.glow}>{`  ${p.caption}`}</Text> : null}
        </Text>
        <Box flexDirection="row">
          {hasLevel ? (
            <Button key="tab-detail" plain onPress={() => ui.post({ type: 'detail' })}>
              <Text dimColor>{`${DETAIL_NAMES[level]}  `}</Text>
            </Button>
          ) : null}
          {tab('live', 'live')}
          {tab('history', 'history')}
        </Box>
      </Box>
      {lines.map(l => {
        if (l.lead || l.tail) {
          const from = l.lead?.n ?? 0
          const to = l.segs.length - (l.tail?.n ?? 0)
          const head = l.segs.slice(0, from)
          const rest = l.segs.slice(from, to)
          const end = l.segs.slice(to)
          return (
            <Box flexDirection="row">
              {head.length === 0 ? null : l.lead?.act ? (
                <Button key={`${l.key}:lead`} plain onPress={l.lead.act}>
                  {text(head)}
                </Button>
              ) : (
                <Text>{text(head)}</Text>
              )}
              {l.act ? (
                <Button key={l.key} plain onPress={l.act}>
                  {text(rest)}
                </Button>
              ) : (
                <Text wrap="truncate">{text(rest)}</Text>
              )}
              {l.tail ? (
                <Button key={`${l.key}:tail`} plain onPress={l.tail.act}>
                  {text(end)}
                </Button>
              ) : null}
            </Box>
          )
        }
        return l.act ? (
          <Button key={l.key} plain onPress={l.act}>
            {text(l.segs)}
          </Button>
        ) : (
          <Text wrap="truncate">{text(l.segs)}</Text>
        )
      })}
    </Box>
  )
}
