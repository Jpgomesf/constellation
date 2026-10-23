// Preview of the red/blue shift: running agents' moons tinted by how much of
// their recent prompts the cache served, in the pane, as a palette, fading
// between levels, and in the inspector.
//
//   bun dev/preview.ts dev/previews/shift.ts --for 14

import { BINARY_HEX } from '../../hooks/events/binary'
import { retroFact, retroGlyph, seeRetro } from '../../hooks/events/retrograde'
import type { Retro } from '../../hooks/events/retrograde'
import { MIN_SHIFT, SHIFT_FADE_MS, cachedFact, moonColor, shiftLegend, shiftLevel, shiftOf, shiftWord, spectrumCells } from '../../hooks/events/shift'
import type { ShiftSeg, SkyCache } from '../../hooks/events/shift'
import { HEX, breathe, mix, quantize } from '../../hooks/motion'
import { skyBand } from '../../hooks/skies'
import { STAR_H, STAR_W, starCells, starStage } from '../../hooks/star'
import { agentParts, cells, counts, detailRow, joinParts, line, moon, phaseRow, railRow, runMark, runRow, seedOf } from '../preview'
import type { MockAgent, PreviewCell, Scene } from '../preview'

/** About a docked pane's width. */
const W = 60
/** A wide pane, where the inspector's line has room for the share over every step. */
const WIDE = 84

/** Segments (several characters each) as one cell per character. */
const split = (segs: readonly ShiftSeg[]): PreviewCell[] => segs.flatMap(s => cells(s.t, { c: s.c, bg: s.bg, dim: s.dim, bold: s.bold }))

/** A cache as the props carry it; `was` is the level the agent held before (hysteresis). */
const cacheAt = (now: number | null, all: number | null, steps: number, was = 0): SkyCache => ({ shift: shiftOf(now, was), now, all, steps })

/** The breath draw.tsx gives an agent's moon. */
const swellOf = (id: string, t: number) => breathe(t, 1400, (seedOf(id) % 100) / 100)

type Mock = MockAgent & { cache: SkyCache; facts: [string, string, string, string] }

const AGENTS: Mock[] = [
  { id: 'a-scan-api', label: 'scan-api', tool: 'Grep', took: '3:12', cache: cacheAt(0.9988, 0.981, 41), facts: ['opus 5.5', 'high', '312k ctx', '$2.84'] },
  { id: 'a-map-routes', label: 'map-routes', tool: 'Read', took: '2:40', cache: cacheAt(0.993, 0.972, 23), facts: ['opus 5.5', 'high', '61k ctx', '$0.42'] },
  { id: 'a-lint-rules', label: 'lint-rules', tool: 'Bash', took: '1:58', cache: cacheAt(0.975, 0.95, 14), facts: ['sonnet 5', 'med', '34k ctx', '$0.12'] },
  { id: 'a-read-schemas', label: 'read-schemas', tool: 'Read', took: '1:05', cache: cacheAt(0.71, 0.82, 9), facts: ['opus 5.5', 'high', '48k ctx', '$0.37'] },
  { id: 'a-dump-logs', label: 'summarize-logs', tool: 'thinking', took: '0:47', cache: cacheAt(0.95, 0.9, 7), facts: ['opus 5.5', 'xhigh', '92k ctx', '$0.55'] },
]

/** A running agent's row with its moon tinted, fading from `from` for `age` ms. */
function shiftedRow(a: Mock, t: number, from = shiftLevel(a.cache.shift), age = Number.POSITIVE_INFINITY, isLast = false): PreviewCell[] {
  const parts = agentParts(a, t, ' │  ', isLast)
  parts.glyph = { ...parts.glyph, c: moonColor(swellOf(a.id, t), shiftLevel(a.cache.shift), from, age) }
  return joinParts(parts, W)
}

/** The running agent's detail line, with the cache fact last when the moon is shifted. */
function detail(a: Mock, isLast = false): PreviewCell[] {
  const [model, effort, ctx, cost] = a.facts
  const facts: PreviewCell[][] = [cells(model, { c: 'suggestion' }), cells(effort, { c: 'planMode' }), cells(ctx, { dim: true }), cells(cost, { c: 'warning' })]
  const fact = cachedFact(a.cache)
  if (fact) facts.push(split([fact]))
  const row = detailRow(W, facts, ' │  ', isLast)
  return [...row, ...cells(' '.repeat(Math.max(0, W - row.length)))]
}

/** A looping agent, retrograde since the preview began: white, turning backwards. */
const LOOP: Retro = { kind: 'loop', stage: 'retrograde', since: 0, detail: 'same Bash call ×5', kicks: 1 }
const retroMoon = (t: number) => retroGlyph(t, seeRetro(null, LOOP, 0), LOOP, HEX.live)

/** A looping agent's row, its moon retrograde, its words after the label. */
function retroRow(t: number): PreviewCell[] {
  const parts = agentParts({ id: 'a-rerun', label: 'rerun-flaky', tool: 'Bash', took: '0:09' }, t)
  parts.glyph = retroMoon(t)
  const words = retroFact(LOOP)
  parts.label = [...parts.label, ...cells(`  ${words.t}`, { c: words.c })]
  return joinParts(parts, W)
}

/** The band and the star, as draw.tsx's bandLines lays them out (the plain style). */
function band(t: number): PreviewCell[][] {
  const leftW = W - 1 - (STAR_W + 1)
  const sky = skyBand('stars', leftW, t, null, true, [], [], () => null).map(split)
  const star = starCells(42, t, null, 0)
  const rows: PreviewCell[][] = []
  for (let i = 0; i < STAR_H; i++) {
    const left = sky[i] ?? cells(' '.repeat(leftW))
    rows.push([{ t: ' ' }, ...left, ...cells(' '.repeat(Math.max(0, leftW - left.length))), { t: ' ' }, ...(star[i] ?? [])])
  }
  const stage = starStage(42, false)
  rows.push([...cells(' '.repeat(W - stage.name.length - 1)), ...cells(stage.name, { c: stage.color })])
  return rows
}

/** The palette: each level's moon in step, out of step and as swatches, then the colors near them. */
function palette(t: number): PreviewCell[][] {
  const names: PreviewCell[] = [{ t: ' ' }]
  const inStep: PreviewCell[] = [{ t: ' ' }]
  const offStep: PreviewCell[] = [{ t: ' ' }]
  const swatches: PreviewCell[] = [{ t: ' ' }]
  for (const level of [-1, 0, 1]) {
    names.push(...cells(shiftWord(level).padEnd(12, ' '), { c: HEX.rail }))
    const m = moon(t, 'a-same-phase')
    inStep.push({ ...m, c: moonColor(swellOf('a-same-phase', t), level) }, ...cells(' '.repeat(11)))
    for (const id of ['a-north', 'a-west', 'a-p1']) offStep.push({ ...moon(t, id), c: moonColor(swellOf(id, t), level) }, { t: ' ' })
    offStep.push(...cells(' '.repeat(6)))
    for (let k = 0; k <= 6; k++) swatches.push({ t: '█', c: moonColor(k / 6, level) })
    swatches.push(...cells(' '.repeat(5)))
  }
  const near: PreviewCell[] = [
    ...cells(' near it: '),
    { t: '●', c: 'success' },
    ...cells(' done  ', { dim: true }),
    { t: '✗', c: 'error' },
    ...cells(' failed  ', { dim: true }),
    { t: '✦', c: mix(HEX.child, HEX.childGlow, quantize(breathe(t, 1700), 6)) },
    ...cells(' child  ', { dim: true }),
    ...cells('Grep', { c: 'suggestion' }),
    ...cells(' tool  ', { dim: true }),
    retroMoon(t),
    ...cells(' retrograde  ', { dim: true }),
    { t: '●', c: BINARY_HEX.body },
    ...cells(' binary', { dim: true }),
  ]
  return [names, inStep, offStep, swatches, [], near]
}

/** One agent whose level changes every few seconds, each change fading from the tint it leaves. */
const CYCLE_MS = 3000
const CYCLE: SkyCache[] = [cacheAt(0.975, 0.96, 18), cacheAt(0.9985, 0.975, 24), cacheAt(0.97, 0.972, 30), cacheAt(0.6, 0.93, 34), cacheAt(0.88, 0.92, 36, 1), cacheAt(0.9988, 0.94, 60)]

function cycling(t: number): PreviewCell[][] {
  const i = Math.floor(t / CYCLE_MS) % CYCLE.length
  const cache = CYCLE[i] as SkyCache
  const before = CYCLE[(i + CYCLE.length - 1) % CYCLE.length] as SkyCache
  const a: Mock = { id: 'a-watch', label: 'watch-cache', tool: 'Read', took: '5:02', cache, facts: ['opus 5.5', 'high', '77k ctx', '$0.66'] }
  const from = t < CYCLE_MS ? shiftLevel(cache.shift) : shiftLevel(before.shift)
  return [
    phaseRow(t, 'Watch', W, [...counts(0, 1), ...cells(' 5:02', { dim: true })]),
    shiftedRow(a, t, from, t % CYCLE_MS, true),
    detail(a, true),
    line(W, cells('   '), cells(`now ${shiftWord(cache.shift)}, from ${shiftWord(from)}`, { c: HEX.rail }), []),
  ]
}

/** Each change of level as a filmstrip: three moons at the old level, then the new at 0, 100 … 1000 ms. */
function fades(): PreviewCell[][] {
  const swell = 0.5
  const rows: PreviewCell[][] = []
  for (const [from, to] of [[0, -1], [-1, 0], [0, 1], [1, 0], [1, -1], [-1, 1]] as const) {
    const out: PreviewCell[] = [...cells(` ${shiftWord(from)} → ${shiftWord(to)}`.padEnd(26, ' '), { c: HEX.rail })]
    for (let i = 0; i < 3; i++) out.push({ t: '●', c: moonColor(swell, from) }, { t: ' ' })
    out.push(...cells('│ ', { c: HEX.rail }))
    for (let age = 0; age <= 1000; age += 100) out.push({ t: '●', c: moonColor(swell, to, from, age) }, { t: ' ' })
    rows.push(out)
  }
  return rows
}

/** The spectrum at every shift, and faint (no shift known yet). */
function spectra(): PreviewCell[][] {
  const at = [-1, -MIN_SHIFT, 0, MIN_SHIFT, 1]
  return at
    .map(s => [{ t: ' ' }, ...split(spectrumCells(s)), ...cells(`  ${s > 0 ? '+' : ''}${s}  ${shiftWord(s)}`, { c: HEX.rail })])
    .concat([[{ t: ' ' }, ...split(spectrumCells(0, true)), ...cells('  faint: warming up', { c: HEX.rail })]])
}

/** The inspector of an agent: its title with the tinted moon, its facts, then the shift's line. */
function inspector(a: Mock, t: number, width: number): PreviewCell[][] {
  const glyph: PreviewCell = { ...moon(t, a.id), c: moonColor(swellOf(a.id, t), shiftLevel(a.cache.shift)) }
  const title = line(width, [{ t: ' ' }, glyph], cells(` ${a.label}`, { bold: true }), [...cells('⠋ running', { c: 'claude' }), ...cells(` ${a.took}`, { dim: true })])
  const [model, effort, ctx, cost] = a.facts
  const dot = () => cells(' · ', { c: 'subtle', dim: true })
  const facts = [{ t: ' ' }, ...cells(model, { c: 'suggestion' }), ...dot(), ...cells(effort, { c: 'planMode' }), ...dot(), ...cells(ctx, { dim: true }), ...dot(), ...cells(`≈${cost}`, { c: 'warning' })]
  return [title, facts, [{ t: ' ' }, ...split(shiftLegend(a.cache, true, width - 1))], []]
}

export const scenes: Scene[] = [
  {
    name: 'in the pane',
    note: 'one blueshifted, one redshifted, three at rest; a retrograde, a finished and a failed one keep their colors',
    draw: t => [
      ...band(t),
      runRow(t, 'audit-repo', W, [...counts(1, 5, 1), ...runMark(t, '3:20')]),
      railRow(),
      phaseRow(t, 'Survey', W, [...counts(1, 5, 1), ...cells(' 3:20', { dim: true })]),
      ...AGENTS.flatMap(a => [shiftedRow(a, t), detail(a)]),
      retroRow(t),
      joinParts(agentParts({ id: 'a-index', label: 'index-docs', status: 'done', cost: '$0.21', took: '0:58' }, t), W),
      joinParts(agentParts({ id: 'a-probe', label: 'probe-auth', status: 'failed', tool: 'denied', took: '0:12' }, t, ' │  ', true), W),
    ],
  },
  { name: 'palette', note: 'blue, rest, red: in step, on their own phases, and each breath as seven swatches', draw: palette },
  { name: 'shift changes', note: `rest, blue, rest, red, held red, blue: every ${CYCLE_MS / 1000} s, each fading over ${SHIFT_FADE_MS} ms`, draw: cycling },
  { name: 'fades', note: 'old level | new level at 0, 100 … 1000 ms', draw: fades },
  { name: 'spectrum', note: 'the inspector’s: two absorption lines slide violet for blue, red for red', draw: spectra },
  {
    name: 'inspector',
    note: 'a docked pane: blue, rest, red; then warming up, finished, no caching',
    draw: t => [
      ...[AGENTS[0], AGENTS[2], AGENTS[3]].flatMap(a => (a ? inspector(a, t, W) : [])),
      [{ t: ' ' }, ...split(shiftLegend(cacheAt(null, 0.31, 2), true, W - 1))],
      [{ t: ' ' }, ...split(shiftLegend(cacheAt(0.99, 0.962, 41), false, W - 1))],
      [{ t: ' ' }, ...split(shiftLegend({ shift: 0, now: null, all: null, steps: 9 }, false, W - 1))],
    ],
  },
  {
    name: 'inspector, wide',
    note: `${WIDE} columns: room for the share over every step`,
    draw: t => inspector(AGENTS[3] as Mock, t, WIDE).slice(0, 3),
  },
]
