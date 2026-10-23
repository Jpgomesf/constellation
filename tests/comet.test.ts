import { expect, test } from 'claude-code/testing'

import type { SkyAgent } from '../hooks/core'
import {
  COMET,
  cometLabel,
  cometMiddle,
  cometTail,
  isStraggler,
  kindOf,
  latenessAt,
  latenessOf,
  paceOf,
  pacer,
  subagentPaceOf,
  tailLength,
} from '../hooks/events/comet'
import { HEX } from '../hooks/motion'
import { runsOf } from '../hooks/skies'

const SECOND = 1000
const MINUTE = 60 * SECOND

function agent(id: string, status: SkyAgent['status'], startedAt: number | null, endedAt: number | null = null, label = id): SkyAgent {
  return {
    id,
    label,
    status,
    model: null,
    effort: null,
    tokens: null,
    costUsd: null,
    tools: null,
    lastTool: null,
    startedAt,
    endedAt,
    error: null,
  }
}

const done = (id: string, tookS: number, startedAt = 0, label = id) => agent(id, 'done', startedAt, startedAt + tookS * SECOND, label)
const running = (id: string, startedAt = 0, label = id) => agent(id, 'running', startedAt, null, label)

const width = (s: string) => [...s].length
const text = (cells: readonly { t: string }[]) => cells.map(c => c.t).join('')
const brightness = (hex: string | undefined) => {
  const n = Number.parseInt((hex ?? '#000000').slice(1), 16)
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)
}
/** A copy of draw.tsx's cut. */
const cut = (s: string, room: number) => ([...s].length <= room ? s : room <= 0 ? '' : `${[...s].slice(0, room - 1).join('')}…`)

test('the pace is the median of finished siblings, once two have finished and they outnumber the running', () => {
  const late = running('scan-billing')
  expect(paceOf([done('scan-api', 60), done('scan-web', 100), done('scan-auth', 80), late])).toBe(80 * SECOND)
  expect(paceOf([done('scan-api', 60), done('scan-web', 100), late])).toBe(80 * SECOND)
  const failed = agent('scan-jobs', 'failed', 0, 2 * SECOND)
  const untimed = agent('scan-docs', 'done', null, 9 * SECOND)
  expect(paceOf([done('scan-api', 60), failed, untimed, late])).toBeNull()
  expect(paceOf([done('scan-api', 60), done('scan-web', 70), failed, untimed, late])).toBe(65 * SECOND)
  // The first to finish are the fastest, so no pace while most still run, unless finished ones were hidden.
  const crowd = [done('scan-api', 60), done('scan-web', 70), late, running('scan-jobs'), running('scan-auth')]
  expect(paceOf(crowd)).toBeNull()
  expect(paceOf(crowd, 1)).toBe(65 * SECOND)
  expect(paceOf([])).toBeNull()
})

test('siblings first seen already finished have no duration, and set no pace', () => {
  // Read mid-run: start and end stamped at the same poll.
  const seen = 50 * SECOND
  const instant = (id: string) => agent(id, 'done', seen, seen)
  expect(paceOf([instant('scan-api'), instant('scan-web'), running('scan-billing', seen)])).toBeNull()
  expect(latenessOf(running('scan-billing', seen), [instant('scan-api'), instant('scan-web')], seen + 20 * SECOND)).toBeNull()
  expect(paceOf([agent('scan-api', 'done', seen, seen - 1), done('scan-web', 40), running('scan-billing')])).toBeNull()
})

test('a straggler that just finished is judged against the others, as it was while it ran', () => {
  const siblings = [done('scan-api', 60), done('scan-web', 100), done('scan-billing', 300)]
  // 100 s with itself in the median, 80 s without.
  expect(paceOf(siblings)).toBe(100 * SECOND)
  expect(paceOf(siblings, 0, 'scan-billing')).toBe(80 * SECOND)
  const pace = pacer(siblings)
  expect(pace(siblings[2] as SkyAgent)).toBe(80 * SECOND)
  expect(latenessAt(siblings[2] as SkyAgent, 80 * SECOND, 0)).toBe(3.75)
})

test('lateness is the running time over the pace, floored', () => {
  const late = running('scan-billing', 10 * SECOND)
  expect(latenessAt(late, 80 * SECOND, 170 * SECOND)).toBe(2)
  expect(latenessAt(late, 1 * SECOND, 20 * SECOND)).toBe((10 * SECOND) / COMET.floorMs)
  expect(latenessAt(late, 80 * SECOND, 0)).toBe(0)
  expect(latenessAt(late, null, 170 * SECOND)).toBeNull()
  expect(latenessAt(agent('scan-jobs', 'running', null), 80 * SECOND, 170 * SECOND)).toBeNull()
  expect(latenessAt(agent('scan-jobs', 'failed', 0, 9 * SECOND), 80 * SECOND, 170 * SECOND)).toBeNull()
  const siblings = [done('scan-api', 60), done('scan-web', 100), late]
  expect(latenessOf(late, siblings, 250 * SECOND)).toBe(3)
  expect(isStraggler(latenessOf(late, siblings, 120 * SECOND))).toBe(false)
  expect(isStraggler(latenessOf(late, siblings, 130 * SECOND))).toBe(true)
  expect(latenessOf(late, [done('scan-api', 5), late], 600 * SECOND)).toBeNull()
})

test('a subagent is judged only against its own type launched in the same burst', () => {
  const hourAgo = 0
  const now = 60 * MINUTE
  const old = Array.from({ length: 10 }, (_, i) => done(`s-${i}`, 40, hourAgo + i * SECOND, `Explore · look at area ${i}`))
  const lone = running('s-gp', now - 4 * MINUTE, 'general-purpose · trace the retry path')
  const group = [...old, lone]
  expect(kindOf(lone.label)).toBe('general-purpose')
  expect(kindOf('Explore')).toBe('Explore')
  expect(subagentPaceOf(lone, group)).toBeNull()
  expect(latenessAt(lone, pacer(group, 0, true)(lone), now)).toBeNull()
  const later = running('s-ex', now - 4 * MINUTE, 'Explore · read the docs')
  expect(subagentPaceOf(later, [...group, later])).toBeNull()
  const t0 = now - 3 * MINUTE
  const batch = [done('b-1', 38, t0, 'Explore · find the loader'), done('b-2', 42, t0 + SECOND, 'Explore · list fixtures'), running('b-3', t0 + 2 * SECOND, 'Explore · map every route')]
  const all = [...group, ...batch]
  expect(subagentPaceOf(batch[2] as SkyAgent, all)).toBe(40 * SECOND)
  expect(isStraggler(latenessAt(batch[2] as SkyAgent, pacer(all, 5, true)(batch[2] as SkyAgent), now))).toBe(true)
})

test('the tail grows from 1.5 times the pace to its longest by 4 times, and no further', () => {
  expect(tailLength(null)).toBe(0)
  expect(tailLength(1.49)).toBe(0)
  expect(tailLength(COMET.from)).toBe(COMET.minLen)
  expect(tailLength(COMET.full)).toBe(COMET.maxLen)
  expect(tailLength(1e9)).toBe(COMET.maxLen)
  let last = 0
  for (let l = COMET.from; l <= COMET.full; l += 0.05) {
    const n = tailLength(l)
    expect(n).toBeGreaterThanOrEqual(last)
    last = n
  }
})

test('a comet keeps the row exactly as wide at every moment, one column per cell', () => {
  const labels = [' scan-billing', ' reconcile the billing ledger against invoices', '']
  for (const middle of [-3, 0, 1, 2, 5, 9, 14, 16, 24, 40, 90]) {
    for (const label of labels) {
      for (const lateness of [null, 1, 1.5, 2.7, 4, 50]) {
        for (const age of [0, 120, 700, Number.POSITIVE_INFINITY]) {
          for (const gone of [null, 0, 300, COMET.exitMs]) {
            for (let t = 0; t < 3000; t += 467) {
              const m = cometMiddle(label, middle, lateness, t, { age, seed: 7, gone })
              expect(width(m.label) + m.tail.length).toBe(Math.max(1, middle))
              expect(m.tail.every(cell => width(cell.t) === 1)).toBe(true)
            }
          }
        }
      }
    }
  }
})

test('the same moment always draws the same comet, whatever was drawn before', () => {
  const draw = (t: number) => [cometMiddle(' scan-billing', 40, 3.2, t, { age: 400, seed: 42 }), cometTail(16, 4, t, { seed: 9, gone: 250 }), cometLabel(' scan-billing', 3.2, t, { seed: 42 })]
  const first = draw(500)
  draw(100)
  draw(9_000)
  expect(draw(500)).toEqual(first)
})

test('an agent on pace is laid out as row() lays out any agent: the label, then spaces', () => {
  for (const lateness of [null, 0.4, 1.49]) {
    const m = cometMiddle(' scan-api', 30, lateness, 1234)
    expect(m.label).toBe(' scan-api')
    expect(text(m.tail)).toBe(' '.repeat(21))
  }
  expect(cometMiddle(' reconcile the billing ledger', 12, null, 0).label).toBe(' reconcile…')
})

test('a straggler drags a streak that tapers by glyph and by brightness alone', () => {
  const m = cometMiddle(' scan-billing', 40, COMET.full, 0)
  expect(m.label).toBe(' scan-billing')
  expect(m.tail[0]?.t).toBe(' ')
  const tail = m.tail.slice(1, 1 + COMET.maxLen)
  const glyphs = text(tail)
  // Heavy, narrowing to light, fraying into braille dust.
  expect(glyphs.startsWith('━')).toBe(true)
  expect(/^━+╾─*╴[⠀-⣿ ]+$/.test(glyphs)).toBe(true)
  for (let t = 0; t < 4000; t += 211) {
    const lit = cometTail(16, 3, t, { seed: 5 }).map(c => brightness(c.c))
    for (let k = 1; k < lit.length; k++) expect(lit[k]).toBeLessThanOrEqual(lit[k - 1] as number)
  }
  expect(tail.every(c => brightness(c.c) >= brightness(HEX.rail))).toBe(true)
})

test('two blank cells of air keep the dust off the spinner, and its tip sparse', () => {
  for (let t = 0; t < 6000; t += 97) {
    for (const middle of [16, 21, 30, 40]) {
      const m = cometMiddle(' scan-billing', middle, 6, t, { seed: 3 })
      expect(text(m.tail.slice(-2))).toBe('  ')
    }
    const tip = cometTail(16, 6, t, { seed: 3 }).at(-1)?.t ?? ' '
    const dots = tip === ' ' ? 0 : (tip.codePointAt(0) ?? 0x2800) - 0x2800
    expect([...dots.toString(2)].filter(b => b === '1').length).toBeLessThanOrEqual(4)
  }
})

test('a long label gives up more of itself the later the agent, keeping ten', () => {
  const long = ' reconcile the billing ledger against invoices'
  // Blank dust cells still carry a color; `- 1` drops the leading space, which shares one.
  const cellsOf = (m: { tail: readonly { c?: string }[] }) => m.tail.filter(c => c.c !== undefined).length - 1
  const tailOf = (lateness: number, middle: number) => cellsOf(cometMiddle(long, middle, lateness, 0))
  // 42: about a docked pane's width.
  expect(tailOf(4, 42)).toBeGreaterThan(tailOf(2, 42) + 2)
  expect(tailOf(2, 42)).toBeGreaterThan(tailOf(1.5, 42))
  const m = cometMiddle(long, 42, COMET.full, 0)
  expect(m.label.endsWith('…')).toBe(true)
  expect(m.tail[1]?.t).toBe('━')
  const tight = cometMiddle(long, 16, COMET.full, 0)
  expect(width(tight.label)).toBe(10)
  expect(tight.tail[1]?.t).toBe('━')
  // The label keeps two thirds of what the row would show.
  const narrow = cometMiddle(' longest file in the tests folder', 25, COMET.full, 0)
  expect(width(narrow.label)).toBe(16)
  expect(cellsOf(narrow)).toBe(6)
  expect(width(cometMiddle(long, 30, 1, 0).label)).toBe(29)
})

test('a label is never cut unless a tail of at least three cells shows', () => {
  for (const label of [' reconcile the billing ledger', ' reconcile the billing ledger against invoices', ' scan-billing']) {
    for (let middle = 1; middle < 50; middle++) {
      for (const lateness of [1.5, 2, 4, 9]) {
        const m = cometMiddle(label, middle, lateness, 0)
        const marks = m.tail.filter(c => c.t !== ' ').length
        if (m.label !== cut(label, middle - 1)) expect(marks).toBeGreaterThanOrEqual(2)
        if (marks === 0) expect(m.label).toBe(cut(label, middle - 1))
        // One space, three tail cells, two of air.
        if (marks > 0) expect(m.tail.length).toBeGreaterThanOrEqual(1 + 3 + 2)
      }
    }
  }
})

test('a new comet unrolls from its label, then burns down to its settled glow', () => {
  const at = (age: number) => cometTail(12, 3, 0, { age, seed: 3 })
  expect(at(0)[0]?.t).toBe('━')
  expect(text(at(0).slice(1)).trim()).toBe('')
  // A third of the way in, the tail reaches about two thirds of its length.
  expect(text(at(COMET.unrollMs / 3).slice(9)).trim()).toBe('')
  expect(at(COMET.unrollMs).length).toBe(12)
  expect(brightness(at(200)[0]?.c)).toBeGreaterThan(brightness(at(COMET.igniteMs)[0]?.c))
  expect(at(COMET.igniteMs)).toEqual(at(Number.POSITIVE_INFINITY))
})

test('a finished straggler scatters its tail into dust, then the row is row() again', () => {
  const marks = (gone: number | null) => cometTail(16, 4, 1000, { seed: 3, gone }).filter(c => c.t !== ' ').length
  const lines = (gone: number | null) => cometTail(16, 4, 1000, { seed: 3, gone }).filter(c => /[━╾─╴╸]/.test(c.t)).length
  expect(lines(null)).toBeGreaterThan(5)
  expect(lines(100)).toBeLessThan(lines(null))
  expect(lines(COMET.exitMs / 2)).toBe(0)
  expect(marks(COMET.exitMs * 0.8)).toBeLessThan(marks(COMET.exitMs * 0.2))
  expect(marks(COMET.exitMs)).toBe(0)
  const after = cometMiddle(' scan-billing', 40, 4, 1000, { gone: COMET.exitMs })
  expect(after.label).toBe(' scan-billing')
  expect(text(after.tail)).toBe(' '.repeat(27))
})

test("a straggler's label warms toward the moon's glow, and cools as it finishes", () => {
  const settled = cometLabel(' scan-billing', 4, 0, { seed: 1 })
  expect(text(settled)).toBe(' scan-billing')
  expect(settled.every(c => c.c !== undefined)).toBe(true)
  const base = settled.at(-1)?.c ?? HEX.ink
  const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16))
  expect((rgb(base)[0] ?? 0) - (rgb(base)[2] ?? 0)).toBeGreaterThan(20)
  const blue = (lateness: number, age = Number.POSITIVE_INFINITY) => rgb(cometLabel(' scan-billing', lateness, 0, { seed: 1, age }).at(-1)?.c ?? HEX.ink)[2] ?? 0
  expect(blue(4)).toBeLessThan(blue(1.5))
  expect(blue(1.5, 100)).toBeLessThan(blue(1.5))
  expect(cometLabel(' scan-billing', 4, 0, { gone: COMET.exitMs }).every(c => c.c === HEX.ink)).toBe(true)
})

test('however late or wide, a tail merges into a handful of runs and colors', () => {
  for (let t = 0; t < 10_000; t += 33) {
    const m = cometMiddle(' scan-billing', 400, 1e6, t, { seed: 5 })
    expect(m.tail.filter(c => c.t !== ' ').length).toBeLessThanOrEqual(COMET.maxLen)
    expect(runsOf(m.tail).length).toBeLessThanOrEqual(8)
    expect(new Set(m.tail.map(c => c.c).filter(Boolean)).size).toBeLessThanOrEqual(6)
  }
  expect(cometTail(0, 3, 0)).toEqual([])
  expect(cometTail(5, 3, 0).length).toBe(5)
})
