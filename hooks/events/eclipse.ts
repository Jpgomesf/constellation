// The eclipse: while the main loop waits on the person (a permission, a question,
// a plan, an MCP form), a dark moon slides across the session's star. The hooks
// module folds signals with eclipseStep; the Client marks and draws it on its clock.

import type { Cell } from '../skies'
import { breathe, ease, mix, quantize } from '../motion'

// ---------------------------------------------------------------- detection

/** What the person is asked for: a tool's permission, a question, a plan to approve, an MCP server's form. */
export type WaitReason = 'permission' | 'question' | 'plan' | 'input'

/** What the session waits on the person for, as the sky's props carry it. */
export type Waiting = {
  /** When the wait began, epoch milliseconds. */
  since: number
  reason: WaitReason
  /** The tool asking (`Bash`, `mcp__server__tool`), or the MCP server behind a form. */
  tool: string
  /** The ask in a few words (a command, a file, a question), at most SUMMARY_MAX characters. */
  summary: string
  /** How many asks are open at once; the oldest is the one described. */
  count: number
}

/**
 * What the hooks module observed, each at epoch time `at`:
 * - `check`: a `tool.check` verdict of `ask` for the person. Only AskUserQuestion and ExitPlanMode wait
 *   at once; any other may still be settled by the classifier or a hook, so it waits once a dialog confirms it.
 * - `dialog`: a PermissionRequest no hook decided, or an Elicitation. In a subagent it only confirms a
 *   check: a background agent's ask goes to hooks, never to a person.
 * - `result`: call `id` is past its dialog (its result, a ToolProgress row, an ElicitationResult).
 * - `resume`: nothing can still be pending (a model request, the turn's end, a prompt, the session's end).
 */
export type EclipseSignal =
  | { kind: 'check'; at: number; id: string; tool: string; summary: string; agentId?: string }
  | { kind: 'dialog'; at: number; reason: WaitReason; tool: string; summary: string; id?: string; agentId?: string }
  | { kind: 'result'; at: number; id: string; tool?: string }
  | { kind: 'resume'; at: number }

type Ask = { id: string | null; agentId: string | null; reason: WaitReason; tool: string; summary: string; since: number }

/** Open checks no dialog has confirmed yet, and the asks the person is shown. */
export type EclipseState = { readonly checks: readonly Ask[]; readonly waits: readonly Ask[] }

export const NO_ECLIPSE: EclipseState = { checks: [], waits: [] }

/** Tools whose ask always goes to the person: no classifier or hook settles it. */
const PERSON_ONLY: Readonly<Record<string, WaitReason>> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }
const CHECKS_KEPT = 8
const WAITS_KEPT = 4
/** A check no dialog follows within this long was settled elsewhere (a classifier, a hook). */
const CHECK_TTL_MS = 120_000
/** A wait whose end was never heard stops eclipsing the star after this long. */
const WAIT_TTL_MS = 6 * 3_600_000
const SUMMARY_MAX = 80

const short = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= SUMMARY_MAX ? one : `${one.slice(0, SUMMARY_MAX - 1)}…`
}

/** The prefix of an MCP server's tools, as the engine names them (`mcp__tracker__`). */
const mcpPrefix = (server: string) => `mcp__${server.replace(/[^\w-]/g, '_')}__`

/** The state after one signal. Returns `s` itself when nothing changed, so a caller can skip a write. */
export function eclipseStep(s: EclipseState, sig: EclipseSignal): EclipseState {
  const checks = s.checks.filter(a => sig.at - a.since < CHECK_TTL_MS)
  const waits = s.waits.filter(a => sig.at - a.since < WAIT_TTL_MS)
  const pruned = checks.length !== s.checks.length || waits.length !== s.waits.length
  const keep = (): EclipseState => (pruned ? { checks, waits } : s)

  if (sig.kind === 'resume') return checks.length === 0 && waits.length === 0 ? keep() : NO_ECLIPSE

  if (sig.kind === 'check') {
    if ([...checks, ...waits].some(a => a.id === sig.id)) return keep()
    const personOnly = PERSON_ONLY[sig.tool]
    const ask: Ask = { id: sig.id, agentId: sig.agentId ?? null, reason: personOnly ?? 'permission', tool: sig.tool, summary: short(sig.summary), since: sig.at }
    if (personOnly) return { checks, waits: [...waits, ask].slice(-WAITS_KEPT) }
    return { checks: [...checks, ask].slice(-CHECKS_KEPT), waits }
  }

  if (sig.kind === 'result') {
    const unnamed = sig.tool === undefined ? -1 : waits.findIndex(a => a.id === null && a.tool === sig.tool && a.since <= sig.at)
    const nextChecks = checks.filter(a => a.id !== sig.id)
    const nextWaits = waits.filter((a, i) => a.id !== sig.id && i !== unnamed)
    if (nextChecks.length === checks.length && nextWaits.length === waits.length) return keep()
    return { checks: nextChecks, waits: nextWaits }
  }

  // A dialog: the same ask shown again, or a new one.
  const agentId = sig.agentId ?? null
  if (sig.id !== undefined && waits.some(a => a.id === sig.id)) return keep()
  const fits = (a: Ask) => a.agentId === agentId && a.tool === sig.tool
  // A check matched by its input is a new ask, even beside an open wait for the same tool.
  const exact = sig.summary === '' ? -1 : checks.findLastIndex(a => fits(a) && a.summary === short(sig.summary))
  // Otherwise an open wait for the tool is this dialog again; failing that, it confirms the newest check.
  if (exact < 0 && waits.some(fits)) return keep()
  const k = exact >= 0 ? exact : checks.findLastIndex(fits)
  // An MCP form comes from a running call of that server, so that call's permission was answered.
  const prefix = sig.reason === 'input' ? mcpPrefix(sig.tool) : null
  const ran = prefix === null ? -1 : waits.findIndex(a => a.agentId === agentId && a.reason === 'permission' && a.tool.startsWith(prefix))
  const rest = ran >= 0 ? waits.filter((_, i) => i !== ran) : waits
  const reason = PERSON_ONLY[sig.tool] ?? sig.reason
  if (k >= 0) {
    const c = checks[k] as Ask
    const ask: Ask = { ...c, reason, summary: c.summary || short(sig.summary), since: sig.at }
    return { checks: checks.filter((_, i) => i !== k), waits: [...rest, ask].slice(-WAITS_KEPT) }
  }
  // A subagent's dialog with no person-approved check behind it went to hooks, not to a person.
  if (agentId !== null) return ran >= 0 ? { checks, waits: rest } : keep()
  const ask: Ask = { id: sig.id ?? null, agentId: null, reason, tool: sig.tool, summary: short(sig.summary), since: sig.at }
  return { checks, waits: [...rest, ask].slice(-WAITS_KEPT) }
}

/** What the sky shows: the oldest open ask, and how many are open; null when nothing waits on the person. */
export function waitingOf(s: EclipseState, now: number): Waiting | null {
  const open = s.waits.filter(a => now - a.since < WAIT_TTL_MS)
  const first = open.reduce<Ask | null>((a, b) => (a === null || b.since < a.since ? b : a), null)
  if (!first) return null
  return { since: first.since, reason: first.reason, tool: first.tool, summary: first.summary, count: open.length }
}

/** `mcp__tracker__save_issue` -> `save_issue`. */
const toolName = (name: string) => name.split('__').at(-1) ?? name

/** What is asked, in a few words: `Bash permission`, `a question`, `plan approval`, `tracker input`. */
function askOf(w: Waiting): string {
  if (w.reason === 'question') return 'a question'
  if (w.reason === 'plan') return 'plan approval'
  if (w.reason === 'input') return `${w.tool} input`
  return `${toolName(w.tool)} permission`
}

function waited(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** The star's caption while eclipsed, `eclipse · waiting on you (Bash permission) · 3 min`, shortened to `width` keeping the ask. */
export function eclipseCaption(w: Waiting, waitedMs: number, width = Number.POSITIVE_INFINITY): string {
  const ask = `${askOf(w)}${w.count > 1 ? ` +${w.count - 1}` : ''}`
  const forms = [`eclipse · waiting on you (${ask})`, `waiting on you (${ask})`, ask]
  if (waitedMs >= 60_000) forms.unshift(`${forms[0]} · ${waited(waitedMs)}`)
  const fit = forms.find(f => [...f].length <= width)
  if (fit !== undefined) return fit
  return width < 1 ? '' : `${[...ask].slice(0, width - 1).join('')}…`
}

/** A desktop notification's text for a long wait: what is asked, and the ask itself. */
export function eclipseNotice(w: Waiting): string {
  return `Waiting on you: ${askOf(w)}${w.summary ? ` · ${w.summary}` : ''}${w.count > 1 ? ` (+${w.count - 1} more)` : ''}`
}

// ---------------------------------------------------------------- the Client's clock

/** How long the moon takes to slide on, and off once the person answers. */
export const ECLIPSE_IN_MS = 1100
export const ECLIPSE_OUT_MS = 1200

/** An eclipse on the frame clock: ms since the moon began sliding on and off, and where on its path it started. */
export type EclipseClock = { age: number; outAge: number | null; from?: number }

/** A total eclipse at rest: for a drawing with no clock (a still surface). */
export const ECLIPSE_HELD: EclipseClock = { age: ECLIPSE_IN_MS, outAge: null }

/** What the Client keeps: when, on its frame clock, it saw the wait begin and end, and where the moon started. */
export type EclipseMarks = { readonly on: number; readonly off: number | null; readonly from: number }

/** The clock of an eclipse the Client marked, at frame time `t`. */
export const eclipseClock = (m: EclipseMarks, t: number): EclipseClock => ({ age: t - m.on, outAge: m.off === null ? null : t - m.off, from: m.from })

/** The marks after a frame at `t`; `m` itself when unchanged, since a change keeps the Client at full frame rate. */
export function eclipseMarks(m: EclipseMarks | null, isWaiting: boolean, t: number): EclipseMarks | null {
  if (isWaiting) {
    if (m !== null && m.off === null) return m
    const f = m === null ? 1 : moonPath(eclipseClock(m, t))
    return { on: t, off: null, from: f >= 1 ? -1 : f }
  }
  if (m === null) return null
  if (m.off === null) return { ...m, off: t }
  return t - m.off < ECLIPSE_OUT_MS ? m : null
}

/** Whether the moon is moving; the hold is slow enough for the idle frame rate. */
export const isEclipseMoving = (c: EclipseClock) => c.age < ECLIPSE_IN_MS || (c.outAge !== null && c.outAge < ECLIPSE_OUT_MS)

/** The moon's place on its path: -1 clear left of the star, 0 centred, 1 clear right. */
export function moonPath(c: EclipseClock): number {
  const from = c.from ?? -1
  const on = (a: number) => from - from * ease.outCubic(a / ECLIPSE_IN_MS)
  if (c.outAge === null) return on(Math.max(0, c.age))
  const was = on(Math.max(0, c.age - c.outAge))
  return was + (1 - was) * ease.inOutSine(c.outAge / ECLIPSE_OUT_MS)
}

// ---------------------------------------------------------------- drawing

/** The caption's color: the corona's. */
export const ECLIPSE_COLOR = '#d6d0f7'

/** The star the moon crosses: its body radius in pixels (the stage's, not the frame's swell) and its stage color. */
export type StarBody = { radius: number; color: string }

const MOON = '#0d0b14'
/** The corona: pearly at the limb, cooling to the rail's lavender in the streamers. */
const CORONA_HOT = '#f3f1ff'
const CORONA_MID = '#c3bee6'
const CORONA_DIM = '#8f8ab4'
const DUST = '#77738f'
/** The dark a faint glow fades into. */
const NIGHT = '#15111d'
/** Sunlight through the moon's valleys: warmer than the corona, so a bead reads as the sun's. */
const SUNLIGHT = '#fff1cc'

/**
 * Moon radii whose discs are round on whole pixels, so the ring round them is a closed circle. The moon
 * takes the smallest covering the star by MOON_OVER; a red giant none covers gets the smallest.
 */
const ROUND = [3.2, 4, 4.8] as const
const MOON_OVER = 0.3
/** How close to centred (on the path's -1..1) the corona starts to show, and where the diamond ring flares. */
const CORONA_FROM = 0.24
const CONTACT = 0.12
/** Pixels above the limb where the streamers' falloff starts: about the bright ring's width. */
const RING = 0.85
/** Star pixels dimmer than this (its own faint corona) are no backdrop for the moon's silhouette. */
const BACKDROP = 0.22
/** How much of the star's stage color the outer corona and its dust take on. */
const TINT = 0.25

/** A color's 0..1 luminance. */
function luma(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

/** A glint's brightness, 0..1: a short flash once every `period`, on its own clock. */
const glint = (t: number, period: number, offset: number) => {
  const d = ((((t + offset) % period) + period) % period) - period / 2
  return Math.exp(-(d * d) / (2 * 260 * 260))
}

/** Baily's beads: where on the limb (radians, 0 to the right, clockwise on screen) each sits, and its clock. */
const BEADS = [
  { at: 0.55, period: 6100, offset: 0 },
  { at: 2.6, period: 7900, offset: 2600 },
  { at: 4.1, period: 9700, offset: 5200 },
] as const

/** The spark a glint of strength `k` throws: a dot, a four-pointed star, a bright one. */
const sparkOf = (k: number): Cell | null =>
  k > 0.8 ? { t: '✦', c: SUNLIGHT, bold: true } : k > 0.5 ? { t: '✧', c: mix(CORONA_MID, SUNLIGHT, 0.6) } : k > 0.3 ? { t: '∙', c: CORONA_MID } : null

type Pixel = string | null

/**
 * starCells' output with the moon in front, the same size: a total eclipse, an annular one on a red giant,
 * or a silhouette in a protostar's cloud. `body.radius` is the stage's, steady while the star swells.
 */
export function eclipseCells(star: readonly (readonly Cell[])[], t: number, clock: EclipseClock, body: StarBody): Cell[][] {
  const h = star.length
  const pw = star[0]?.length ?? 0
  const ph = h * 2
  const f = moonPath(clock)
  if (pw === 0 || f >= 1 || f <= -1) return star.map(row => row.map(c => ({ ...c })))

  // Recover the pixels from the half blocks; any other glyph is a mark.
  const px: Pixel[] = Array.from({ length: pw * ph }, () => null)
  let hasBody = false
  star.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c.t === '▀') {
        px[y * 2 * pw + x] = c.c ?? null
        px[(y * 2 + 1) * pw + x] = c.bg ?? null
        hasBody = true
      } else if (c.t === '▄') {
        px[(y * 2 + 1) * pw + x] = c.c ?? null
        hasBody = true
      }
    }),
  )

  const sun = body.radius
  const covers = ROUND.find(r => r >= sun + MOON_OVER)
  const isAnnular = hasBody && covers === undefined
  const rm: number = isAnnular ? ROUND[0] : (covers ?? ROUND[2])
  const cx = pw / 2
  const cy = ph / 2
  // Far enough that the moon clears the swollen star and its corona at either end.
  const travel = Math.max(sun * 1.25 + 1.2, rm) + rm + 0.6
  // Whole pixels only, so the disc stays round.
  const mx = cx + Math.round(f * travel)
  const my = cy
  const totality = ease.inOutSine(1 - Math.abs(f) / CORONA_FROM)
  const corona = isAnnular ? 0 : totality
  const cloud = mix(CORONA_DIM, body.color, 0.5)
  const swell = 0.88 + 0.12 * breathe(t, 5600)
  const drift = t / 26_000
  const dim = mix(CORONA_DIM, body.color, TINT)
  const dust = mix(DUST, body.color, TINT)

  /** The corona's 0..1 brightness `lift` pixels above the limb: equatorial streamers, polar plumes, drifting rays. */
  const streamer = (lift: number, dx: number, dy: number) => {
    const a = Math.atan2(dy, dx)
    const ray = 1.3 * Math.max(0, Math.cos(5 * a + 0.4 + drift)) ** 8
    const reach = 0.3 + 2.3 * Math.cos(a) ** 6 + ray
    return Math.exp(-(lift - RING) / reach) * 0.8 * swell * corona
  }

  const disc: boolean[] = Array.from({ length: pw * ph }, (_, i) => Math.hypot((i % pw) + 0.5 - mx, Math.floor(i / pw) + 0.5 - my) <= rm)
  const inDisc = (x: number, y: number) => x >= 0 && y >= 0 && x < pw && y < ph && disc[y * pw + x] === true
  const isLimb = (x: number, y: number) => !inDisc(x, y) && (inDisc(x - 1, y) || inDisc(x + 1, y) || inDisc(x, y - 1) || inDisc(x, y + 1))
  /** How much of pixel (x, y) the moon's disc covers, 0..1, sampled four by four. */
  const coverOf = (x: number, y: number) => {
    if (Math.hypot(x + 0.5 - mx, y + 0.5 - my) > rm + 0.75) return 0
    let n = 0
    for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) if (Math.hypot(x + (k + 0.5) / 4 - mx, y + (j + 0.5) / 4 - my) <= rm) n++
    return n / 16
  }

  const out: Pixel[] = px.slice()
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = y * pw + x
      const dx = x + 0.5 - mx
      const dy = y + 0.5 - my
      const was = px[i] ?? null
      const isSunlit = was !== null && luma(was) >= BACKDROP
      if (disc[i]) {
        // The moon shows only as a silhouette against light.
        if (isSunlit || corona > 0.3 || (isAnnular && totality > 0.3 && was !== null)) out[i] = MOON
        else if (was !== null) out[i] = null
        continue
      }
      if (isSunlit) {
        // A partly covered pixel is partly dark, so a crescent tapers to its horns.
        const lit = mix(was, MOON, quantize(coverOf(x, y), 4))
        out[i] = isAnnular ? mix(lit, body.color, quantize(0.45 * totality, 3)) : lit
      }
      if (corona === 0) continue
      // Before totality the sunlight outshines the corona.
      if (isSunlit && corona < 0.6) continue
      if (corona > 0.3 && isLimb(x, y)) {
        // Inner corona, brightest where the equatorial streamers leave the limb.
        const k = ((corona - 0.3) / 0.7) * (0.6 + 0.4 * Math.abs(dx / Math.hypot(dx, dy)))
        out[i] = hasBody ? mix(CORONA_MID, CORONA_HOT, quantize(k, 3)) : mix(NIGHT, cloud, 0.75 * quantize(corona, 3))
      } else if (corona > 0.6) out[i] = null
    }
  }

  /** The first pixel outside the disc on the ray from the moon's centre at angle `a`. */
  const offLimb = (a: number): [number, number] | null => {
    for (let s = rm - 0.5; s <= rm + 4; s += 0.25) {
      const x = Math.floor(mx + Math.cos(a) * s)
      const y = Math.floor(my + Math.sin(a) * s)
      if (x < 0 || y < 0 || x >= pw || y >= ph) return null
      if (!disc[y * pw + x]) return [x, y]
    }
    return null
  }

  /** Sparks by cell, only where the pixels left a cell empty. */
  const sparks = new Map<number, Cell>()
  const cellIsEmpty = (xi: number, yi: number) => out[yi * 2 * pw + xi] == null && out[(yi * 2 + 1) * pw + xi] == null
  /** A bead of sunlight at the limb at angle `a`, throwing a spark outward as it flares. */
  const bead = (a: number, k: number) => {
    const at = hasBody && k > 0.15 ? offLimb(a) : null
    if (at) out[at[1] * pw + at[0]] = mix(CORONA_HOT, SUNLIGHT, quantize(k, 3))
    const spark = sparkOf(k)
    if (!spark) return
    for (let s = 1.3; s <= 3.4; s += 0.7) {
      const xi = Math.floor(mx + Math.cos(a) * (rm + s))
      const yi = Math.floor((my + Math.sin(a) * (rm + s)) / 2)
      if (xi < 0 || yi < 0 || xi >= pw || yi >= h) return
      if (cellIsEmpty(xi, yi)) {
        sparks.set(yi * pw + xi, spark)
        return
      }
    }
  }

  if (hasBody && !isAnnular) {
    // The diamond ring: the last sliver of sunlight before totality.
    const contact = Math.exp(-(((Math.abs(f) - CONTACT) / 0.06) ** 2))
    if (contact > 0.05 && Math.hypot(cx - mx, cy - my) > 0.01) bead(Math.atan2(cy - my, cx - mx), contact)
  }

  if (totality > 0.5 && !isAnnular) {
    // Baily's beads (on a protostar, only their sparks).
    const k = (totality - 0.5) * 2
    for (const b of BEADS) bead(b.at, glint(t, b.period, b.offset) * k * (hasBody ? 1 : 0.75))
  }

  // Fold the pixels back into half blocks; the outer corona becomes dust in empty cells.
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: pw }, (_, x): Cell => {
      const top = out[y * 2 * pw + x] ?? null
      const bottom = out[(y * 2 + 1) * pw + x] ?? null
      if (top && bottom) return { t: '▀', c: top, bg: bottom }
      if (top) return { t: '▀', c: top }
      if (bottom) return { t: '▄', c: bottom }
      const spark = sparks.get(y * pw + x)
      if (spark) return { ...spark }
      const dx = x + 0.5 - mx
      const dy = y * 2 + 1 - my
      const lift = Math.hypot(dx, dy) - rm
      // Marks behind the moon are hidden.
      const was = star[y]?.[x]
      if (was && was.t !== ' ' && was.t !== '▀' && was.t !== '▄') return lift < 0 ? { t: ' ' } : { ...was }
      const haze = hasBody && corona > 0.3 && lift >= RING ? streamer(lift, dx, dy) : 0
      if (haze >= 0.13) return { t: haze >= 0.3 ? '∙' : '·', c: haze >= 0.3 ? dim : dust }
      return { t: ' ' }
    }),
  )
}

/** The eclipse in one cell, for views with no star. */
export function eclipseGlyph(t: number, clock: EclipseClock, starColor: string): Cell {
  const f = moonPath(clock)
  if (f <= -0.85 || f >= 0.85) return { t: '●', c: starColor }
  if (f < -0.15) return { t: '◑', c: starColor }
  if (f > 0.15) return { t: '◐', c: starColor }
  const g = Math.max(...BEADS.map(b => glint(t, b.period, b.offset)), Math.exp(-(((Math.abs(f) - CONTACT) / 0.06) ** 2)))
  return { t: '○', c: mix(CORONA_MID, SUNLIGHT, quantize(g, 3)), bold: g > 0.5 }
}
