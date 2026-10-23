import { expect, test } from 'claude-code/testing'

import {
  ECLIPSE_HELD,
  ECLIPSE_IN_MS,
  ECLIPSE_OUT_MS,
  NO_ECLIPSE,
  eclipseCaption,
  eclipseCells,
  eclipseClock,
  eclipseGlyph,
  eclipseMarks,
  eclipseNotice,
  eclipseStep,
  isEclipseMoving,
  moonPath,
  waitingOf,
} from '../hooks/events/eclipse'
import type { EclipseMarks, EclipseSignal, EclipseState, StarBody, Waiting } from '../hooks/events/eclipse'
import type { Cell } from '../hooks/skies'
import { STAR_H, STAR_W, starCells, starRadius, starStage } from '../hooks/star'

const T0 = 1_760_000_000_000

/** The state after a run of signals, from none. */
const fold = (signals: readonly EclipseSignal[], from: EclipseState = NO_ECLIPSE) => signals.reduce(eclipseStep, from)

const bashCheck: EclipseSignal = { kind: 'check', at: T0, id: 'tu-1', tool: 'Bash', summary: 'git push origin main' }
const bashDialog: EclipseSignal = { kind: 'dialog', at: T0 + 40, reason: 'permission', tool: 'Bash', summary: 'git push origin main' }

test('a permission the person is shown eclipses the star until the call settles', () => {
  const asked = fold([bashCheck])
  expect(waitingOf(asked, T0 + 10)).toBe(null)
  const shown = eclipseStep(asked, bashDialog)
  expect(waitingOf(shown, T0 + 50)).toEqual({ since: T0 + 40, reason: 'permission', tool: 'Bash', summary: 'git push origin main', count: 1 })
  const other = eclipseStep(shown, { kind: 'result', at: T0 + 60, id: 'tu-2' })
  expect(other).toBe(shown)
  expect(waitingOf(eclipseStep(other, { kind: 'result', at: T0 + 900, id: 'tu-1' }), T0 + 900)).toBe(null)
})

test('an approved long command ends the wait once it runs, not when it finishes', () => {
  const shown = fold([
    { kind: 'check', at: T0, id: 'tu-1', tool: 'Bash', summary: 'npm test' },
    { kind: 'dialog', at: T0 + 10, reason: 'permission', tool: 'Bash', summary: 'npm test' },
  ])
  // A ToolProgress row: the call was approved and now runs.
  const running = eclipseStep(shown, { kind: 'result', at: T0 + 3_000, id: 'tu-1' })
  expect(waitingOf(running, T0 + 3_000)).toBe(null)
  // Unchanged state comes back as the same object, so nothing is written.
  expect(eclipseStep(running, { kind: 'result', at: T0 + 180_000, id: 'tu-1', tool: 'Bash' })).toBe(running)
})

test('an ask auto mode or a hook settles never eclipses, and its check is forgotten', () => {
  const settled = fold([bashCheck, { kind: 'result', at: T0 + 300, id: 'tu-1' }])
  expect(settled.checks.length).toBe(0)
  expect(waitingOf(settled, T0 + 300)).toBe(null)
  const stale = fold([bashCheck, { kind: 'result', at: T0 + 10 * 60_000, id: 'tu-9' }])
  expect(stale.checks.length).toBe(0)
})

test('a question or a plan waits at once, and its own dialog is the same wait', () => {
  const question = fold([
    { kind: 'check', at: T0, id: 'tu-q', tool: 'AskUserQuestion', summary: 'Which library should we use?' },
    { kind: 'dialog', at: T0 + 20, reason: 'permission', tool: 'AskUserQuestion', summary: '' },
  ])
  expect(waitingOf(question, T0 + 40)).toEqual({ since: T0, reason: 'question', tool: 'AskUserQuestion', summary: 'Which library should we use?', count: 1 })
  expect(waitingOf(eclipseStep(question, { kind: 'result', at: T0 + 5000, id: 'tu-q' }), T0 + 5000)).toBe(null)
  const plan = fold([{ kind: 'check', at: T0, id: 'tu-p', tool: 'ExitPlanMode', summary: '' }])
  expect(waitingOf(plan, T0)?.reason).toBe('plan')
})

test('a main-loop dialog with no check behind it still waits, and the tool’s result ends it', () => {
  const lone = fold([{ kind: 'dialog', at: T0, reason: 'permission', tool: 'Write', summary: 'notes/plan.md' }])
  expect(waitingOf(lone, T0 + 5)).toEqual({ since: T0, reason: 'permission', tool: 'Write', summary: 'notes/plan.md', count: 1 })
  expect(eclipseStep(lone, { kind: 'result', at: T0 - 5, id: 'tu-x', tool: 'Write' }).waits.length).toBe(1)
  expect(waitingOf(eclipseStep(lone, { kind: 'result', at: T0 + 800, id: 'tu-x', tool: 'Write' }), T0 + 800)).toBe(null)
})

test('two asks of one tool are two waits: the first call returning leaves the second dialog eclipsing', () => {
  const s = fold([
    { kind: 'check', at: T0, id: 'tu-1', tool: 'WebFetch', summary: 'https://a.example' },
    { kind: 'check', at: T0 + 5, id: 'tu-2', tool: 'WebFetch', summary: 'https://b.example' },
    { kind: 'dialog', at: T0 + 10, reason: 'permission', tool: 'WebFetch', summary: 'https://a.example' },
    { kind: 'dialog', at: T0 + 4_000, reason: 'permission', tool: 'WebFetch', summary: 'https://b.example' },
    { kind: 'result', at: T0 + 6_000, id: 'tu-1' },
  ])
  expect(waitingOf(s, T0 + 6_000)).toEqual({ since: T0 + 4_000, reason: 'permission', tool: 'WebFetch', summary: 'https://b.example', count: 1 })
  expect(waitingOf(eclipseStep(s, { kind: 'result', at: T0 + 30_000, id: 'tu-2' }), T0 + 30_000)).toBe(null)
  // A dialog raised twice (a hook chain, a redraw) is one wait.
  const twice = fold([bashCheck, bashDialog, { ...bashDialog, at: T0 + 60 }])
  expect(waitingOf(twice, T0 + 60)?.count).toBe(1)
})

test("a subagent's dialog waits only behind a check a person approves, and ends with its call", () => {
  const hooksAnswer = fold([{ kind: 'dialog', at: T0, reason: 'permission', tool: 'Bash', summary: 'rm -rf build', agentId: 'a-scan' }])
  expect(waitingOf(hooksAnswer, T0)).toBe(null)
  const person = fold([
    { kind: 'check', at: T0, id: 'tu-s', tool: 'Bash', summary: 'make build', agentId: 'a-build' },
    { kind: 'dialog', at: T0 + 10, reason: 'permission', tool: 'Bash', summary: 'make build', agentId: 'a-build' },
  ])
  expect(waitingOf(person, T0 + 10)?.tool).toBe('Bash')
  const done = eclipseStep(person, { kind: 'result', at: T0 + 9_000, id: 'tu-s', tool: 'Bash' })
  expect(waitingOf(done, T0 + 60_000)).toBe(null)
})

test("an MCP server's form waits for its result, ends the permission of the call that raised it, and a resume clears everything", () => {
  const form = fold([{ kind: 'dialog', at: T0, reason: 'input', tool: 'tracker', summary: 'Pick a project', id: 'elicit:e1' }])
  expect(waitingOf(form, T0)?.reason).toBe('input')
  expect(waitingOf(eclipseStep(form, { kind: 'result', at: T0 + 100, id: 'elicit:e1' }), T0 + 100)).toBe(null)
  const asked = fold([
    { kind: 'check', at: T0, id: 'tu-m', tool: 'mcp__tracker__save_issue', summary: 'T-12' },
    { kind: 'dialog', at: T0 + 10, reason: 'permission', tool: 'mcp__tracker__save_issue', summary: 'T-12' },
    { kind: 'dialog', at: T0 + 3_000, reason: 'input', tool: 'tracker', summary: 'Pick a project', id: 'elicit:e2' },
  ])
  expect(waitingOf(asked, T0 + 3_000)).toEqual({ since: T0 + 3_000, reason: 'input', tool: 'tracker', summary: 'Pick a project', count: 1 })
  expect(waitingOf(eclipseStep(asked, { kind: 'result', at: T0 + 9_000, id: 'elicit:e2' }), T0 + 9_000)).toBe(null)
  const busy = fold([bashCheck, bashDialog, { kind: 'check', at: T0 + 50, id: 'tu-3', tool: 'Edit', summary: 'src/app.ts' }])
  const resumed = eclipseStep(busy, { kind: 'resume', at: T0 + 60 })
  expect(resumed).toEqual(NO_ECLIPSE)
  // A resume comes every main-loop step, so with nothing open it must return the same object.
  expect(eclipseStep(resumed, { kind: 'resume', at: T0 + 70 })).toBe(resumed)
})

test('parallel asks count up, the oldest described; memory stays bounded', () => {
  const two = fold([
    bashDialog,
    { kind: 'dialog', at: T0 + 500, reason: 'permission', tool: 'mcp__tracker__save_issue', summary: 'T-12', id: 'tu-m' },
  ])
  expect(waitingOf(two, T0 + 600)).toEqual({ since: T0 + 40, reason: 'permission', tool: 'Bash', summary: 'git push origin main', count: 2 })
  let s: EclipseState = NO_ECLIPSE
  for (let i = 0; i < 60; i++) {
    s = eclipseStep(s, { kind: 'check', at: T0 + i, id: `tu-c${i}`, tool: 'Bash', summary: `step ${i}` })
    s = eclipseStep(s, { kind: 'dialog', at: T0 + i, reason: 'input', tool: `server-${i}`, summary: '', id: `elicit:${i}` })
  }
  expect(s.checks.length <= 8).toBe(true)
  expect(s.waits.length <= 4).toBe(true)
  expect(waitingOf(s, T0 + 100)?.count).toBe(4)
  expect(waitingOf(s, T0 + 7 * 3_600_000)).toBe(null)
})

test('the eclipsed star says what it waits for, in its own voice, and keeps what is asked when cut', () => {
  const w = (over: Partial<Waiting>): Waiting => ({ since: 0, reason: 'permission', tool: 'Bash', summary: '', count: 1, ...over })
  expect(eclipseCaption(w({}), 4000)).toBe('eclipse · waiting on you (Bash permission)')
  expect(eclipseCaption(w({ tool: 'mcp__tracker__save_issue', count: 2 }), 3 * 60_000 + 5000)).toBe('eclipse · waiting on you (save_issue permission +1) · 3 min')
  expect(eclipseCaption(w({ reason: 'question', tool: 'AskUserQuestion' }), 0)).toBe('eclipse · waiting on you (a question)')
  expect(eclipseCaption(w({ reason: 'plan', tool: 'ExitPlanMode' }), 0)).toBe('eclipse · waiting on you (plan approval)')
  expect(eclipseCaption(w({ reason: 'input', tool: 'tracker' }), 75 * 60_000)).toBe('eclipse · waiting on you (tracker input) · 1 h 15 min')
  const two = w({ tool: 'mcp__tracker__save_issue', count: 2 })
  expect(eclipseCaption(two, 3 * 60_000, 52)).toBe('eclipse · waiting on you (save_issue permission +1)')
  expect(eclipseCaption(two, 3 * 60_000, 44)).toBe('waiting on you (save_issue permission +1)')
  expect(eclipseCaption(two, 3 * 60_000, 30)).toBe('save_issue permission +1')
  expect(eclipseCaption(two, 3 * 60_000, 12)).toBe('save_issue …')
  expect(eclipseNotice(w({ summary: 'git push origin main' }))).toBe('Waiting on you: Bash permission · git push origin main')
})

const lumaOf = (hex: string | undefined) => {
  if (!hex?.startsWith('#')) return -1
  const n = Number.parseInt(hex.slice(1), 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

const shapeOf = (grid: readonly (readonly Cell[])[]) => grid.map(row => row.map(c => [...c.t].length))
const bodyOf = (pct: number | null): StarBody => ({ radius: starRadius(pct), color: starStage(pct, false).color })
const MOON = '#0d0b14'
const CORONA_HOT = '#f3f1ff'
const pixels = (grid: readonly (readonly Cell[])[]) => grid.flat().flatMap(c => (c.t === '▀' ? [c.c, c.bg] : c.t === '▄' ? [c.c] : []))

/** Each painted pixel's color, keyed `x,y` (two pixels to a cell, top first). */
const pixelMap = (grid: readonly (readonly Cell[])[]) => {
  const m = new Map<string, string>()
  grid.forEach((row, y) =>
    row.forEach((c, x) => {
      if (c.t === '▀' && c.c) m.set(`${x},${y * 2}`, c.c)
      if (c.t === '▀' && c.bg) m.set(`${x},${y * 2 + 1}`, c.bg)
      if (c.t === '▄' && c.c) m.set(`${x},${y * 2 + 1}`, c.c)
    }),
  )
  return m
}
const placeOf = (key: string) => key.split(',').map(Number) as [number, number]
/** `key` turned a quarter about the box's centre: a round shape maps onto itself. */
const turned = (key: string) => {
  const [x, y] = placeOf(key)
  return `${y - STAR_H + STAR_W / 2},${x - STAR_W / 2 + STAR_H}`
}
const touches = (m: ReadonlyMap<string, string>, key: string, color: string) => {
  const [x, y] = placeOf(key)
  return [`${x - 1},${y}`, `${x + 1},${y}`, `${x},${y - 1}`, `${x},${y + 1}`].some(k => m.get(k) === color)
}

test('the eclipse keeps the star box, one character a cell, and draws the same cells for the same moment', () => {
  const moments: [number | null, number, number, number | null][] = [
    [null, 0, 0, null],
    [null, 4_000, 60_000, null],
    [5, 400, 300, null],
    [45, 2_000, 600, null],
    [70, 9_000, 60_000, null],
    [97, 12_345, 60_000, 250],
    [97, 700, 1_000, 900],
    [30, 3_000, 200, 100],
  ]
  for (const [pct, t, age, outAge] of moments) {
    const star = starCells(pct, t, null, 1)
    const before = JSON.stringify(star)
    const drawn = eclipseCells(star, t, { age, outAge }, bodyOf(pct))
    expect(JSON.stringify(star)).toBe(before)
    expect(drawn.length).toBe(STAR_H)
    for (const row of drawn) expect(row.length).toBe(STAR_W)
    expect(shapeOf(drawn).flat().every(n => n === 1)).toBe(true)
    expect(JSON.stringify(eclipseCells(star, t, { age, outAge }, bodyOf(pct)))).toBe(JSON.stringify(drawn))
  }
})

test('the moon comes on clear of the star, darkens it ringed by corona, and leaves it as it was', () => {
  const t = 4_000
  const star = starCells(45, t, null, 0)
  expect(eclipseCells(star, t, { age: 0, outAge: null }, bodyOf(45))).toEqual(star)
  expect(eclipseCells(star, t, { age: 60_000, outAge: ECLIPSE_OUT_MS }, bodyOf(45))).toEqual(star)
  const total = eclipseCells(star, t, ECLIPSE_HELD, bodyOf(45))
  const heart = total[Math.floor(STAR_H / 2)]?.[Math.floor(STAR_W / 2)]
  expect(lumaOf(star[Math.floor(STAR_H / 2)]?.[Math.floor(STAR_W / 2)]?.c) > 0.6).toBe(true)
  expect(heart?.t).toBe('▀')
  expect(lumaOf(heart?.c) < 0.1 && lumaOf(heart?.bg) < 0.1).toBe(true)
  expect(pixels(total).filter(c => lumaOf(c) > 0.85).length >= 14).toBe(true)
  expect(total.flat().some(c => c.t === '·' || c.t === '∙')).toBe(true)
})

test('the moon holds one size through the hold, whatever the star swells to', () => {
  for (const pct of [5, 45, 97]) {
    const counts = new Set<number>()
    for (let t = 0; t < 6_000; t += 33) counts.add(pixels(eclipseCells(starCells(pct, t, null, 0), t, { age: 60_000 + t, outAge: null }, bodyOf(pct))).filter(c => c === MOON).length)
    expect(counts.size).toBe(1)
  }
})

test('the moon covers the star it eclipses: a young star stays small, a red giant keeps its fire', () => {
  const t = 2_000
  /** The farthest painted pixel from the box's centre, in pixels. */
  const reach = (grid: readonly (readonly Cell[])[]) => {
    let r = 0
    grid.forEach((row, y) =>
      row.forEach((c, x) => {
        if (c.t === '▀') r = Math.max(r, Math.hypot(x + 0.5 - STAR_W / 2, y * 2 + 0.5 - STAR_H))
        if ((c.t === '▀' && c.bg) || c.t === '▄') r = Math.max(r, Math.hypot(x + 0.5 - STAR_W / 2, y * 2 + 1.5 - STAR_H))
      }),
    )
    return r
  }
  const young = eclipseCells(starCells(8, t, null, 0), t, ECLIPSE_HELD, bodyOf(8))
  expect(reach(young) <= bodyOf(8).radius + 2).toBe(true)
  const dying = eclipseCells(starCells(97, t, null, 0), t, ECLIPSE_HELD, bodyOf(97))
  const px = pixels(dying)
  expect(px.includes(CORONA_HOT)).toBe(false)
  expect(px.includes(MOON)).toBe(true)
  const red = px.filter(c => c !== undefined && c !== MOON && Number.parseInt(c.slice(1, 3), 16) > 2 * Number.parseInt(c.slice(5, 7), 16) && lumaOf(c) > 0.3)
  expect(red.length >= 12).toBe(true)
})

test('a total eclipse is round at every size: a dark disc in one thin closed ring, never a box, and no off-colour cell', () => {
  const stars: [string, (t: number) => Cell[][], StarBody][] = [
    ['newborn', t => starCells(null, t, null, 1, true), { radius: starRadius(null), color: starStage(null, false, true).color }],
    ...[8, 25, 45, 70].map((pct): [string, (t: number) => Cell[][], StarBody] => [`${pct}%`, t => starCells(pct, t, null, 0), bodyOf(pct)]),
  ]
  for (const [, star, body] of stars) {
    // A moment when no bead glints.
    const t = 2_200
    const m = pixelMap(eclipseCells(star(t), t, ECLIPSE_HELD, body))
    const bright = [...m.keys()].filter(k => lumaOf(m.get(k)) > 0.6)
    expect(bright.length >= 20).toBe(true)
    expect(bright.every(k => touches(m, k, MOON))).toBe(true)
    expect(bright.every(k => bright.includes(turned(k)))).toBe(true)
    // Nothing pink or red through the hold.
    for (let at = 0; at < 12_000; at += 100) {
      for (const c of pixels(eclipseCells(star(at), at, { age: 60_000 + at, outAge: null }, body))) {
        if (c === undefined) continue
        const [r, g] = [Number.parseInt(c.slice(1, 3), 16), Number.parseInt(c.slice(3, 5), 16)]
        expect(r - g <= 40).toBe(true)
      }
    }
  }
})

test('the moon slides off level: a small star comes back a crescent the same above and below, never an L', () => {
  const lit = (x: number, y: number) => Math.hypot(x + 0.5 - STAR_W / 2, y + 0.5 - STAR_H) <= 2.2
  const flat = Array.from({ length: STAR_H }, (_, y) =>
    Array.from({ length: STAR_W }, (_, x): Cell => {
      const [top, bottom] = [lit(x, y * 2), lit(x, y * 2 + 1)]
      return top && bottom ? { t: '▀', c: '#ffffff', bg: '#ffffff' } : top ? { t: '▀', c: '#ffffff' } : bottom ? { t: '▄', c: '#ffffff' } : { t: ' ' }
    }),
  )
  let crescents = 0
  // From 400 ms: before that the diamond ring's bead sits on one side.
  for (let outAge = 400; outAge < ECLIPSE_OUT_MS; outAge += 33) {
    const m = pixelMap(eclipseCells(flat, 0, { age: 60_000, outAge }, { radius: 2.1, color: '#8fb8ff' }))
    for (const [k, c] of m) {
      const [x, y] = placeOf(k)
      expect(m.get(`${x},${STAR_H * 2 - 1 - y}`)).toBe(c)
    }
    const light = [...m.keys()].filter(k => lumaOf(m.get(k)) > 0.3)
    if (light.length > 0 && light.length <= 8 && light.every(k => placeOf(k)[0] < STAR_W / 2)) crescents += 1
  }
  expect(crescents >= 3).toBe(true)
})

test("a protostar's eclipse is quiet but whole: the moon's dark disc where its cloud was, in a faint closed ring", () => {
  const t = 3_000
  const held = eclipseCells(starCells(null, t, null, 0), t, ECLIPSE_HELD, bodyOf(null))
  const m = pixelMap(held)
  expect(held[STAR_H / 2]?.[STAR_W / 2]).toEqual({ t: '▀', c: MOON, bg: MOON })
  const ring = [...m.keys()].filter(k => m.get(k) !== MOON)
  expect(ring.length >= 16).toBe(true)
  expect(ring.every(k => touches(m, k, MOON) && ring.includes(turned(k)))).toBe(true)
  const young = pixelMap(eclipseCells(starCells(8, t, null, 0), t, ECLIPSE_HELD, bodyOf(8)))
  const corona = Math.min(...[...young.values()].filter(c => c !== MOON).map(lumaOf))
  expect(new Set(ring.map(k => m.get(k))).size).toBe(1)
  const faint = lumaOf(m.get(ring[0] ?? ''))
  expect(faint > 0.25 && faint < corona - 0.15).toBe(true)
  expect(held.flat().some(c => c.t === '·')).toBe(true)
})

test("a red giant's ring of fire stays open round the moon however the star pulses", () => {
  for (const pct of [80, 90, 97]) {
    for (let t = 0; t < 12_000; t += 33) {
      const px = pixels(eclipseCells(starCells(pct, t, null, 0), t, ECLIPSE_HELD, bodyOf(pct)))
      const red = px.filter(c => c !== undefined && c !== MOON && Number.parseInt(c.slice(1, 3), 16) > 2 * Number.parseInt(c.slice(5, 7), 16) && lumaOf(c) > 0.2)
      expect(red.length >= 14).toBe(true)
    }
  }
})

test('the moon slides on in a second, holds, and slides off from wherever it got to', () => {
  expect(moonPath({ age: 0, outAge: null })).toBe(-1)
  expect(moonPath({ age: ECLIPSE_IN_MS, outAge: null })).toBe(0)
  expect(moonPath({ age: 600_000, outAge: null })).toBe(0)
  expect(moonPath({ age: 600_000, outAge: ECLIPSE_OUT_MS })).toBe(1)
  const cut = moonPath({ age: 300, outAge: null })
  expect(moonPath({ age: 300, outAge: 0 })).toBe(cut)
  expect(moonPath({ age: 400, outAge: 100 }) > cut).toBe(true)
  expect(isEclipseMoving({ age: 200, outAge: null })).toBe(true)
  expect(isEclipseMoving({ age: 5_000, outAge: null })).toBe(false)
  expect(isEclipseMoving({ age: 5_000, outAge: 300 })).toBe(true)
})

test("the Client's marks: a wait begins and ends once, and a new one calls the moon back without a jump", () => {
  let m: EclipseMarks | null = null
  m = eclipseMarks(m, true, 1_000)
  expect(m).toEqual({ on: 1_000, off: null, from: -1 })
  expect(eclipseMarks(m, true, 1_033)).toBe(m)
  const ended = eclipseMarks(m, false, 5_000) as EclipseMarks
  expect(ended.off).toBe(5_000)
  expect(eclipseMarks(ended, false, 5_400)).toBe(ended)
  const before = moonPath(eclipseClock(ended, 5_400))
  const again = eclipseMarks(ended, true, 5_400) as EclipseMarks
  expect(again.from).toBe(before)
  expect(moonPath(eclipseClock(again, 5_400))).toBe(before)
  expect(Math.abs(moonPath(eclipseClock(again, 5_433)) - before) < 0.1).toBe(true)
  expect(moonPath(eclipseClock(again, 5_400 + ECLIPSE_IN_MS))).toBe(0)
  expect(eclipseMarks(ended, false, 5_000 + ECLIPSE_OUT_MS)).toBe(null)
  expect(eclipseMarks(ended, true, 5_000 + ECLIPSE_OUT_MS)?.from).toBe(-1)
})

test('where no star is drawn, one cell tells the eclipse: bitten, ringed, lit again', () => {
  const glyphs = [
    eclipseGlyph(0, { age: 0, outAge: null }, '#ffd166').t,
    eclipseGlyph(0, { age: 300, outAge: null }, '#ffd166').t,
    eclipseGlyph(0, ECLIPSE_HELD, '#ffd166').t,
    eclipseGlyph(0, { age: 60_000, outAge: 700 }, '#ffd166').t,
    eclipseGlyph(0, { age: 60_000, outAge: ECLIPSE_OUT_MS }, '#ffd166').t,
  ]
  expect(glyphs).toEqual(['●', '◑', '○', '◐', '●'])
  for (let t = 0; t < 20_000; t += 333) expect([...eclipseGlyph(t, ECLIPSE_HELD, '#ffd166').t].length).toBe(1)
})
