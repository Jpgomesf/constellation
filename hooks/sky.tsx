// The sky as a surface module: draws the tree (draw.tsx) and animates it on the
// surface's own frame clock, so the pane never redraws for motion.
import type { ClientModule } from 'claude-code'

import type { SkyAgent, SkyNode, SkyProps } from './core'
import { drawSky } from './draw'
import type { SkyUi } from './draw'
import { ECLIPSE_OUT_MS, eclipseClock, eclipseMarks } from './events/eclipse'
import type { EclipseMarks } from './events/eclipse'
import { isFalling, meteorsFor } from './events/meteor'
import type { Meteor } from './events/meteor'
import { retroIn, seeRetro } from './events/retrograde'
import type { RetroSeen } from './events/retrograde'
import { SHIFT_FADE_MS, seeShift } from './events/shift'
import type { ShiftSeen } from './events/shift'
import { TICK_MS } from './motion'
import type { Sample, Shot } from './skies'

/** How long a node fades in or a finish flashes; the clock runs fast meanwhile. */
const FADE_MS = 900
/** While nothing else moves, the sky redraws one frame in two (twinkle, breathe). */
const IDLE_EVERY = 2
/** How long a shooting star crosses the band, and how often the sparkline samples the work. */
const SHOT_MS = 1100
const SAMPLE_MS = 500
const SAMPLES_KEPT = 240

/** Whether anything on screen moves by itself: a live run or subagent, or work in flight. */
function isAnimated(p: SkyProps): boolean {
  if (p.isLoading || p.note !== null) return true
  if (p.mode === 'inspect') return p.inspect?.agent?.status === 'running' || p.inspect?.run?.status === 'running' || p.inspect?.node?.status === 'running'
  return p.mode === 'live' && (p.runs.some(r => r.status === 'running') || p.subagents?.status === 'running')
}

type Clock = {
  frame: number
  nowSeen: number
  frameAtNow: number
  isLive: boolean
  twinkles: boolean
  /** Frame time until which a fade or flash plays. */
  fadeUntil: number
  open: Record<string, boolean>
  born: Record<string, number>
  status: Record<string, boolean>
  doneAt: Record<string, number>
  shots: Shot[]
  samples: Sample[]
  /** Compactions seen (null before the first look), and when the last one went supernova. */
  deaths: number | null
  novaAt: number | null
  /** Each running agent's red/blue level, the one it left and when. */
  shifts: Record<string, ShiftSeen>
  /** Each moon off its course: its stage, since when, and its phase then. */
  retro: Record<string, RetroSeen>
  /** The props' failures as meteors on this clock. */
  meteors: readonly Meteor[]
  /** When the moon began to slide on and off the star, and from where; null while clear. */
  eclipse: EclipseMarks | null
}
type State = { clock: Clock }

const Sky: ClientModule<SkyProps, State> = (props, surface) => {
  const clock: Clock = surface.state?.clock ?? {
    frame: 0,
    nowSeen: props.now,
    frameAtNow: 0,
    isLive: false,
    twinkles: false,
    fadeUntil: 0,
    open: {},
    born: {},
    status: {},
    doneAt: {},
    shots: [],
    samples: [],
    deaths: null,
    novaAt: null,
    shifts: {},
    retro: {},
    meteors: [],
    eclipse: null,
  }
  // A clock from before a module reload may lack newer fields.
  clock.shots ??= []
  clock.samples ??= []
  clock.deaths ??= null
  clock.novaAt ??= null
  clock.shifts ??= {}
  clock.retro ??= {}
  clock.meteors ??= []
  clock.eclipse ??= null
  if (props.now !== clock.nowSeen) {
    // A fresh `now` from the hooks module: elapsed times count from here.
    clock.nowSeen = props.now
    clock.frameAtNow = clock.frame
  }
  clock.isLive = isAnimated(props)
  // Props from an older hooks module (mid-reload) carry no wait.
  const isWaiting = (props.waiting ?? null) !== null
  // The eclipse's beads glint at the idle pace in every view.
  clock.twinkles = props.mode === 'live' || isWaiting
  if (surface.state === undefined) {
    surface.setState({ clock })
    surface.every(TICK_MS, () => {
      clock.frame += 1
      const t = clock.frame * TICK_MS
      // A meteor in flight keeps the clock fast; the rest of its minute idles.
      const isMoving = clock.isLive || t < clock.fadeUntil || isFalling(clock.meteors, t)
      if (isMoving || (clock.twinkles && clock.frame % IDLE_EVERY === 0)) surface.setState({ clock })
    })
  }
  const t = clock.frame * TICK_MS
  const now = props.now + (clock.frame - clock.frameAtNow) * TICK_MS
  // Props from an older hooks module (mid-reload) carry no failures.
  clock.meteors = meteorsFor(clock.meteors, props.failures ?? [], t, now)
  // The clock runs fast while the moon slides on or off.
  const marks = eclipseMarks(clock.eclipse, isWaiting, t)
  if (marks !== clock.eclipse) {
    clock.eclipse = marks
    clock.fadeUntil = Math.max(clock.fadeUntil, t + ECLIPSE_OUT_MS)
  }
  const deaths = props.gauge?.compactions ?? 0
  if (clock.deaths !== null && deaths > clock.deaths) {
    clock.novaAt = t
    clock.fadeUntil = Math.max(clock.fadeUntil, t + 3000)
  }
  clock.deaths = deaths
  const lastSample = clock.samples.at(-1)
  if (!lastSample || t - lastSample.t >= SAMPLE_MS) {
    const all = [...props.runs, ...(props.subagents ? [props.subagents] : [])]
    const live = all.reduce((n, r) => n + r.counts.running, 0)
    const cost = all.reduce((n, r) => n + (r.costUsd ?? 0), 0)
    clock.samples = [...clock.samples, { t, live, cost }].slice(-SAMPLES_KEPT)
  }
  const ui: SkyUi = {
    t,
    isMoving: true,
    drift: (clock.frame - clock.frameAtNow) * TICK_MS,
    bornAt: key => {
      const seen = clock.born[key]
      if (seen !== undefined) return seen
      clock.born[key] = t
      clock.fadeUntil = Math.max(clock.fadeUntil, t + FADE_MS)
      return t
    },
    doneAt: (id, isDone) => {
      const was = clock.status[id]
      clock.status[id] = isDone
      if (isDone && was === false) {
        clock.doneAt[id] = t
        clock.shots = [...clock.shots, { t0: t, seed: [...id].reduce((h, ch) => (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0, 7) }].slice(-8)
        clock.fadeUntil = Math.max(clock.fadeUntil, t + Math.max(FADE_MS, SHOT_MS))
      }
      return clock.doneAt[id] ?? null
    },
    isOpen: (key, byDefault) => clock.open[key] ?? byDefault,
    toggle: (key, byDefault) => {
      clock.open[key] = !(clock.open[key] ?? byDefault)
      surface.setState({ clock })
    },
    post: data => surface.post(data),
    shots: clock.shots,
    samples: clock.samples,
    novaAt: clock.novaAt,
    shiftSeen: (id, level) => {
      const was = clock.shifts[id]
      const seen = seeShift(was, level, t)
      if (seen !== was) {
        clock.shifts[id] = seen
        // A first sight tints at once; only a change fades.
        if (was) clock.fadeUntil = Math.max(clock.fadeUntil, t + SHIFT_FADE_MS)
      }
      return seen
    },
    retroSeen: (id, retro) => {
      const seen = seeRetro(clock.retro[id], retro, t)
      if (seen) clock.retro[id] = seen
      else delete clock.retro[id]
      return seen
    },
    meteors: clock.meteors,
    eclipse: clock.eclipse === null ? null : eclipseClock(clock.eclipse, t),
  }
  // Folded rows included, so every finish flashes and every moon's course is followed.
  const walk = (n: SkyNode): SkyAgent[] => [...n.agents, ...n.children.flatMap(walk)]
  for (const r of [...props.runs, ...(props.subagents ? [props.subagents] : [])]) {
    for (const a of [...r.nodes.flatMap(walk), ...r.loose]) {
      ui.doneAt(a.id, a.status === 'done')
      ui.retroSeen(a.id, a.status === 'running' ? retroIn(a.watch, now) : null)
    }
  }
  const columns = surface.columns > 0 ? surface.columns : props.columns
  return drawSky(surface.elements, { ...props, columns }, ui)
}

export default Sky
