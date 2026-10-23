import { expect, test } from 'claude-code/testing'

import {
  FRESH_MS,
  METEOR_MS,
  PROPS_CAP,
  RING_CAP,
  WINDOW_MS,
  addFailures,
  cellsOf,
  demoFailures,
  intensityAt,
  isFalling,
  isRaining,
  launchAt,
  meteorOf,
  meteorOverlay,
  meteorsFor,
  perAgent,
  rateOf,
  settledMeteors,
  showerCaption,
  showerProps,
  toolErrorsOf,
} from '../hooks/events/meteor'
import type { Failure, FailureKind, Meteor, SkyFailure } from '../hooks/events/meteor'
import { HEX } from '../hooks/motion'
import { skyBand } from '../hooks/skies'
import type { Cell } from '../hooks/skies'

const fail = (id: string, at: number, agent: string | null = 'a-scan-api', kind: FailureKind = 'error'): Failure => ({ id, agent, at, kind })

/** A failure as the props carry it, through the production path. */
const sky = (id: string, at: number, who: string | null = 'scan-api', kind: FailureKind = 'error'): SkyFailure => {
  const [f] = showerProps([fail(id, at, who === null ? null : `a-${who}`, kind)], at, agent => agent.slice(2))
  if (!f) throw new Error('no props')
  return f
}

/** A meteor of failure `id`, from `who`, launching at `t0`. */
const meteor = (id: string, t0: number, who: string | null = 'scan-api', kind: FailureKind = 'error'): Meteor => meteorOf(sky(id, 0, who, kind), t0)

/** A blank `w` by `h` band. */
const blank = (w: number, h: number): Cell[][] => Array.from({ length: h }, () => Array.from({ length: w }, () => ({ t: ' ' })))

/** How many cells are not a space. */
const lit = (grid: readonly Cell[][]) => grid.flat().filter(c => c.t !== ' ').length

const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
}

const REJECT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to continue."

test("reads an agent's failed tool calls out of a tool-result row, and nothing else", () => {
  const content = [
    { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'Exit code 1' },
    { type: 'tool_result', tool_use_id: 'toolu_2', is_error: false, content: 'ok' },
    { type: 'tool_result', tool_use_id: 'toolu_3', content: 'ok' },
    { type: 'text', text: 'is_error: true' },
    { type: 'tool_result', tool_use_id: 'toolu_4', is_error: true, content: [{ type: 'text', text: 'No such file' }] },
    null,
    'toolu_5',
  ]
  expect(toolErrorsOf(content)).toEqual(['toolu_1', 'toolu_4'])
  expect(toolErrorsOf('not blocks')).toEqual([])
  expect(toolErrorsOf(undefined)).toEqual([])
})

test("the person's own acts never rain: a call they said no to or stopped, and a row they interrupted", () => {
  const said = [
    { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: REJECT },
    { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [{ type: 'text', text: REJECT }] },
    { type: 'tool_result', tool_use_id: 'toolu_3', is_error: true, content: '[Request interrupted by user for tool use]' },
    { type: 'tool_result', tool_use_id: 'toolu_4', is_error: true, content: 'Interrupted by user' },
    { type: 'tool_result', tool_use_id: 'toolu_5', is_error: true, content: 'Exit code 2' },
  ]
  expect(toolErrorsOf(said)).toEqual(['toolu_5'])
  // Escape during parallel calls puts the interruption beside the results: none of them counts.
  const stopped = [
    { type: 'tool_result', tool_use_id: 'toolu_6', is_error: true, content: 'Exit code 130' },
    { type: 'tool_result', tool_use_id: 'toolu_7', is_error: true, content: REJECT },
    { type: 'text', text: '[Request interrupted by user for tool use]' },
  ]
  expect(toolErrorsOf(stopped)).toEqual([])
})

test('the ring keeps one entry a call, a deny and its error result as one deny, inside the minute', () => {
  const now = 100_000
  const ring = addFailures([fail('old', now - WINDOW_MS - 1), fail('t1', now - 5_000)], [fail('t2', now - 2_000, 'a-build', 'deny'), fail('t2', now - 1_500, 'a-build')], now)
  expect(ring.map(f => f.id)).toEqual(['t1', 't2'])
  expect(ring[1]).toEqual({ id: 't2', agent: 'a-build', at: now - 2_000, kind: 'deny' })
  const again = addFailures(ring, [fail('t2', now - 1_000)], now)
  expect(again).toHaveLength(2)
  expect(again[1]?.kind).toBe('deny')
})

test('the ring stays bounded however many failures pour in, keeping the newest', () => {
  const now = 50_000
  let ring: Failure[] = []
  for (let k = 0; k < 40; k++) ring = addFailures(ring, Array.from({ length: 25 }, (_, i) => fail(`t${k}-${i}`, now - 30_000 + k * 500 + i)), now)
  expect(ring).toHaveLength(RING_CAP)
  expect(ring.at(-1)?.id).toBe('t39-24')
  for (let i = 1; i < ring.length; i++) expect((ring[i]?.at ?? 0) >= (ring[i - 1]?.at ?? 0)).toBe(true)
  expect(addFailures(ring, [], now + WINDOW_MS)).toHaveLength(0)
})

test('counts failures in a sliding minute, overall and per agent', () => {
  const now = 200_000
  const ring = [fail('a', now - 70_000), fail('b', now - 50_000), fail('c', now - 10_000, null), fail('d', now - 1_000, 'a-build', 'deny'), fail('e', now)]
  expect(rateOf(ring, now)).toBe(4)
  expect(rateOf(ring, now, 5_000)).toBe(2)
  expect(rateOf(ring, now + 55_000)).toBe(2)
  expect(perAgent(ring, now)).toEqual({ 'a-scan-api': 2, main: 1, 'a-build': 1 })
})

test("the sky's props carry the minute's newest failures, small, with their agents' labels", () => {
  const now = 500_000
  // Real-length ids and labels, for the size bound.
  const agent = (i: number) => (i % 3 === 0 ? null : `a${(1_000_000_000_000 + i).toString(16)}`)
  const label = 'summarize the changes for the release notes'
  const ring = [fail('gone', now - WINDOW_MS), ...Array.from({ length: 50 }, (_, i) => fail(`toolu_01${String(i).padStart(22, 'Q')}`, now - 40_000 + i * 100, agent(i)))]
  const props = showerProps(ring, now, id => (id.endsWith('2') ? null : label))
  expect(props).toHaveLength(PROPS_CAP)
  expect(props.at(-1)?.at).toBe(now - 40_000 + 4_900)
  expect(props.some(f => f.at === now - WINDOW_MS)).toBe(false)
  for (const f of props) expect(f.who === null || [...f.who].length <= 24).toBe(true)
  expect(props.some(f => f.who?.endsWith('…'))).toBe(true)
  expect(props.some(f => f.who === null)).toBe(true)
  expect(new Set(props.filter(f => f.who === null && f.radiant === props[0]?.radiant).map(f => f.radiant)).size).toBeLessThanOrEqual(1)
  for (const f of props) expect(Number.isInteger(f.id) && f.id >= 0).toBe(true)
  expect(JSON.stringify(props).length).toBeLessThan(4_500)
})

test('a fresh failure launches within the next second, in the order they fell; an old one counts but never streaks', () => {
  const t = 10_000
  const now = 1_000_000
  const first = launchAt(t, now, { id: 11, at: now - 900 })
  const second = launchAt(t, now, { id: 12, at: now - 300 })
  expect(first).toBeGreaterThanOrEqual(t)
  expect(second).toBeGreaterThan(first)
  expect(second).toBeLessThan(t + 1_100)
  const old = launchAt(t, now, { id: 13, at: now - FRESH_MS - 20_000 })
  expect(old).toBe(t - FRESH_MS - 20_000)
  const meteors = [meteor('x3', old)]
  expect(lit(meteorOverlay(blank(36, 6), t, meteors))).toBe(0)
  expect(showerCaption(meteors, t, 40)?.t).toBe('a sporadic meteor from scan-api')
})

test("the Client's meteors keep their launch, add the new, drop the gone, and cost nothing while unchanged", () => {
  const now = 1_000_000
  const a = sky('toolu_a', now - 200)
  const b = sky('toolu_b', now - 100)
  const c = sky('toolu_c', now)
  const first = meteorsFor([], [a, b], 5_000, now)
  expect(first).toHaveLength(2)
  expect(meteorsFor(first, [a, b], 9_000, now + 4_000)).toBe(first)
  const next = meteorsFor(first, [b, c], 9_000, now)
  expect(next.map(m => m.id)).toEqual([b.id, c.id])
  expect(next[0]).toBe(first[1])
  expect(next[1]?.t0).toBeGreaterThanOrEqual(9_000)
  const named = meteorsFor(next, [{ ...b, who: 'scan-web' }, c], 9_500, now)
  expect(named[0]?.who).toBe('scan-web')
  expect(named[0]?.t0).toBe(next[0]?.t0)
  const still = settledMeteors([a, b], now)
  expect(lit(meteorOverlay(blank(36, 6), 0, still))).toBe(0)
  expect(showerCaption(still, 0, 40)?.t).toBe('sporadic meteors from scan-api')
})

test('a meteor falls a row a cell, bursts and fades inside the band, every row keeping its width', () => {
  const m = meteor('toolu_9', 1_000)
  const at = (t: number, w = 36, h = 6) => meteorOverlay(blank(w, h), t, [m])
  expect(lit(at(999))).toBe(0)
  expect(lit(at(1_000 + METEOR_MS + 1))).toBe(0)
  // The head is the lowest trail cell.
  const heads: { x: number; y: number }[] = []
  let burst = -1
  for (let t = 1_000; t < 1_000 + METEOR_MS; t += 10) {
    const grid = at(t)
    const trail = grid.flatMap((row, y) => row.flatMap((c, x) => ('╲╱'.includes(c.t) ? [{ x, y }] : [])))
    const head = trail.reduce<{ x: number; y: number } | null>((low, p) => (low === null || p.y > low.y ? p : low), null)
    if (head && (heads.length === 0 || head.y !== heads.at(-1)?.y)) heads.push(head)
    if (burst < 0 && grid.flat().some(c => c.t === '✦')) burst = t
  }
  expect(heads.length).toBeGreaterThanOrEqual(2)
  for (let i = 1; i < heads.length; i++) {
    expect((heads[i]?.y ?? 0) - (heads[i - 1]?.y ?? 0)).toBe(1)
    expect(Math.abs((heads[i]?.x ?? 0) - (heads[i - 1]?.x ?? 0))).toBe(1)
  }
  expect(burst).toBeGreaterThan(1_000)
  const glyphs = new Set<string>()
  for (let t = 1_000; t < 1_000 + METEOR_MS; t += 33) {
    for (const [w, h] of [[36, 6], [36, 3], [39, 2], [39, 1], [12, 2]] as const) {
      const grid = at(t, w, h)
      expect(grid).toHaveLength(h)
      for (const row of grid) {
        expect(row).toHaveLength(w)
        for (const cell of row) {
          expect([...cell.t]).toHaveLength(1)
          glyphs.add(cell.t)
          if (cell.c !== undefined) expect(cell.c).toMatch(/^#[0-9a-f]{6}$/)
        }
      }
      expect(JSON.stringify(grid)).toBe(JSON.stringify(at(t, w, h)))
    }
  }
  for (const g of glyphs) expect(' ╲╱⎺⎻─⎼⎽✦✧'.includes(g)).toBe(true)
  expect(lit(meteorOverlay(blank(4, 6), 1_100, [m]))).toBe(0)
  expect(lit(meteorOverlay(blank(36, 6), 1_100, []))).toBe(0)
})

test('in one row a meteor falls through the scan lines, top of the row to its foot', () => {
  const m = meteor('toolu_8', 0)
  let seen = ''
  for (let t = 0; t < METEOR_MS; t += 20) {
    const row = meteorOverlay(blank(39, 1), t, [m])[0] ?? []
    const scan = row.map(c => c.t).join('').replace(/[^⎺⎻─⎼⎽]/g, '')
    if (scan.length > seen.length) seen = scan
  }
  const levels = [...seen].map(ch => '⎺⎻─⎼⎽'.indexOf(ch))
  expect(levels.length).toBeGreaterThanOrEqual(5)
  for (let i = 1; i < levels.length; i++) expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeGreaterThanOrEqual(0)
  expect((levels.at(-1) ?? 0) - (levels[0] ?? 0)).toBeGreaterThanOrEqual(2)
})

/** The meteors a pane holds at `t` for a failure every `gap` ms. */
function rain(gap: number, t: number, agents: readonly string[] = ['a-scan-api']): Meteor[] {
  const ring: Failure[] = []
  for (let at = Math.max(0, Math.ceil((t - WINDOW_MS) / gap) * gap); at <= t; at += gap) ring.push(fail(`toolu_${at}`, at, agents[(at / gap) % agents.length] ?? null))
  return showerProps(ring, t, id => id.slice(2)).map(f => meteorOf(f, f.at))
}

/** Cells drawn per frame over `ms`, and how many are at least as bright as the rails. */
function busy(meteorsAt: (t: number) => readonly Meteor[], from: number, ms = 10_000) {
  let cells = 0
  let bright = 0
  let frames = 0
  for (let t = from; t < from + ms; t += 33) {
    const drawn = meteorOverlay(blank(36, 6), t, meteorsAt(t)).flat().filter(c => c.t !== ' ')
    cells += drawn.length
    bright += drawn.filter(c => c.c !== undefined && luminance(c.c) >= luminance(HEX.rail)).length
    frames += 1
  }
  return { cells: cells / frames, bright: bright / frames }
}

test('the shower grows with the rate, to a storm, and thins as the minute empties', () => {
  const lone = [meteor('one', 0)]
  expect(busy(() => lone, 3_000).cells).toBe(0)
  const light = busy(t => rain(3_000, t), 70_000)
  const storm = busy(t => rain(750, t, ['a-scan-api', 'a-scan-api', 'a-build', 'a-scan-api']), 70_000)
  // 750 ms apart is eighty a minute: a storm.
  expect(storm.cells).toBeGreaterThan(2.5 * light.cells)
  expect(storm.bright).toBeGreaterThan(3)
  expect(storm.cells).toBeLessThan(30)
  const burst = Array.from({ length: 12 }, (_, i) => meteor(`b${i}`, i * 200, i % 3 ? 'scan-api' : 'build'))
  expect(busy(() => burst, 3_000).cells).toBeGreaterThan(0)
  expect(busy(() => burst, 3_000).cells).toBeGreaterThan(busy(() => burst, 35_000).cells)
  expect(busy(() => burst, WINDOW_MS + 3_000).cells).toBe(0)
  expect(intensityAt(burst, 2_400)).toBeGreaterThan(intensityAt(burst, 40_000))
  expect(intensityAt(burst, WINDOW_MS + 2_400)).toBe(0)
  expect(isRaining(burst, 30_000)).toBe(true)
  expect(isRaining(burst, WINDOW_MS + 2_300)).toBe(false)
})

test('the sky keeps moving while meteors fall, and rests once they stop, though the minute still holds them', () => {
  const lone = [meteor('one', 1_000)]
  expect(isFalling(lone, 500)).toBe(true)
  expect(isFalling(lone, 1_500)).toBe(true)
  expect(isFalling(lone, 1_000 + METEOR_MS)).toBe(false)
  expect(isRaining(lone, 30_000)).toBe(true)
  const burst = Array.from({ length: 12 }, (_, i) => meteor(`b${i}`, i * 200))
  expect(isFalling(burst, 20_000)).toBe(true)
  expect(isFalling(burst, WINDOW_MS)).toBe(false)
})

test('the overlay writes over a band split back into cells, never past it, and never over its words', () => {
  const runs: Cell[] = [{ t: '  ·  ', c: '#4e4e4e' }, { t: '✦', c: '#f3e3b5' }, { t: ' '.repeat(30) }]
  const row = cellsOf(runs)
  expect(row).toHaveLength(36)
  expect(row[2]).toEqual({ t: '·', c: '#4e4e4e' })
  const grid = [row, ...blank(36, 5)]
  meteorOverlay(grid, 1_200, [meteor('toolu_3', 1_000)])
  for (const r of grid) expect(r).toHaveLength(36)
  // The sparkline's words and bars stay whole: meteors pass behind them.
  const samples = Array.from({ length: 30 }, (_, i) => ({ t: i * 500, live: 1 + (i % 3), cost: i * 0.01 }))
  const storm = (t: number) => rain(400, t, ['a-scan-api', 'a-build'])
  let crossed = 0
  for (const [w, h] of [[39, 2], [36, 6]] as const) {
    for (let t = 70_000; t < 74_000; t += 33) {
      const band = skyBand('spark', w, t, null, true, [], samples, () => null).map(cellsOf)
      while (band.length < h) band.push(blank(w, 1)[0] ?? [])
      const before = band.map(r => r.map(c => c.t).join(''))
      meteorOverlay(band, t, storm(t))
      const after = band.map(r => r.map(c => c.t).join(''))
      for (const [y, text] of before.entries()) {
        const words = text.slice(w - 14).trim()
        if (words) expect(after[y]?.includes(` ${words}`)).toBe(true)
        ;[...text].forEach((ch, x) => /[▀-▟]/u.test(ch) && expect([...(after[y] ?? '')][x]).toBe(ch))
        if (after[y] !== text) crossed += 1
      }
    }
  }
  expect(crossed).toBeGreaterThan(50)
})

test("the caption names the shower in the star's voice, quiet, and whose it is when one agent sends most", () => {
  const t = 20_000
  const words = (meteors: readonly Meteor[], room = 60) => showerCaption(meteors, t, room)?.t ?? null
  expect(words([])).toBeNull()
  const api = (i: number, kind: FailureKind = 'error') => meteor(`a${i}`, t - 1_000 * i, 'scan-api', kind)
  expect(words([api(1)])).toBe('a sporadic meteor from scan-api')
  expect(words([api(1), api(2)])).toBe('sporadic meteors from scan-api')
  const mixed = [api(1), api(2), api(3, 'deny'), meteor('w1', t - 3_000, 'scan-web'), meteor('w2', t - 4_000, 'scan-web'), meteor('w3', t - 5_000, 'scan-web')]
  expect(words(mixed)).toBe('a meteor shower')
  const shower = [api(1), api(2), api(3, 'deny'), api(4), meteor('w', t - 3_000, 'scan-web')]
  expect(words(shower)).toBe('a meteor shower from scan-api')
  const storm = Array.from({ length: 20 }, (_, i) => api(i + 1))
  expect(words(storm)).toBe('a meteor storm from scan-api')
  expect(words(shower, 26)).toBe('a meteor shower from scan…')
  expect(words(shower, 20)).toBe('a meteor shower')
  expect(words(shower, 10)).toBeNull()
  for (const room of [60, 31, 26, 20, 15]) expect([...(words(shower, room) ?? '')].length).toBeLessThanOrEqual(room)
  expect(words([meteor('m', t - 100, null), meteor('soon', t + 500), meteor('gone', t - WINDOW_MS)])).toBe('a sporadic meteor')
  const lit1 = showerCaption([meteor('n', t)], t, 60)?.c ?? '#000000'
  const quiet = showerCaption([meteor('n', t - 5_000)], t, 60)?.c ?? '#000000'
  const cold = showerCaption([meteor('n', t - 55_000)], t, 60)?.c ?? '#000000'
  expect(luminance(lit1)).toBeGreaterThan(luminance(quiet) + 20)
  expect(cold).toBe(quiet)
  expect(luminance(quiet)).toBeGreaterThanOrEqual(luminance(HEX.rail))
  expect(luminance(quiet)).toBeLessThan(luminance(HEX.rail) + 25)
  const denied = showerCaption([meteor('d', t - 5_000, 'publish', 'deny')], t, 60)?.c ?? '#000000'
  expect(denied).not.toBe(quiet)
  expect(luminance(denied)).toBeGreaterThanOrEqual(luminance(HEX.rail))
})

test("the demo's failures: a lone one, then a burst on the denied push, each once", () => {
  const all = demoFailures(5_000, 0, 36_000)
  expect(all.length).toBeGreaterThanOrEqual(8)
  expect(new Set(all.map(f => f.id)).size).toBe(all.length)
  expect(all.every(f => f.agent?.startsWith('demo-'))).toBe(true)
  expect(all.some(f => f.kind === 'deny')).toBe(true)
  const split = [...demoFailures(5_000, 0, 15_500), ...demoFailures(5_000, 15_500, 36_000)]
  expect(split).toEqual(all)
  expect(rateOf(addFailures([], all, 5_000 + 22_000), 5_000 + 22_000)).toBe(all.length)
})
