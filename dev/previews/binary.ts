// Preview of the binary star: two agents editing one file have their moons
// caught into a binary. Also how it ranks against retrograde and the shift.
//
//   bun dev/preview.ts dev/previews/binary.ts --for 12

import { BINARY_HEX, ORBIT, STEP_MS, binaryCells, binaryRows, binaryWarning } from '../../hooks/events/binary'
import type { Binary, Pair } from '../../hooks/events/binary'
import { retroGlyph, seeRetro } from '../../hooks/events/retrograde'
import type { Retro } from '../../hooks/events/retrograde'
import { moonColor } from '../../hooks/events/shift'
import { HEX, breathe } from '../../hooks/motion'
import { runsOf, skyBand } from '../../hooks/skies'
import { STAR_H, STAR_W, starCells } from '../../hooks/star'
import { agentParts, agentRow, cells, counts, detailRow, joinParts, phaseRow, railRow, runMark, runRow, seedOf } from '../preview'
import type { MockAgent, PreviewCell } from '../preview'
import type { Scene } from '../preview'

/** About a docked pane's width. */
const W = 62
/** The pane scene loops every LOOP_MS: moons for FORM_MS, then the binary. */
const LOOP_MS = 7000
const FORM_MS = 1500

const flat = (row: readonly PreviewCell[]): PreviewCell[] => runsOf(row).flatMap(c => [...c.t].map(ch => ({ ...c, t: ch })))

/** The sky band with the star at its right, as draw.tsx's bandLines lays it out. */
function band(t: number, width: number): PreviewCell[][] {
  const leftW = width - 1 - (STAR_W + 1)
  const sky = skyBand('stars', leftW, t, null, true, [], [], () => null)
  const star = starCells(41, t, null, 0)
  return Array.from({ length: STAR_H }, (_, i) => [{ t: ' ' }, ...flat(sky[i] ?? [{ t: ' '.repeat(leftW) }]), { t: ' ' }, ...(star[i] ?? [])])
}

/** Rows padded to `width`, so an inserted row changes no other row's width. */
const padded = (rows: PreviewCell[][], width: number): PreviewCell[][] => rows.map(r => [...r, ...cells(' '.repeat(Math.max(0, width - r.length)))])

/** A run's warning rows on its rail. */
const warnRows = (rows: PreviewCell[][]): PreviewCell[][] => rows.map(r => flat([...cells(' │ ', { c: HEX.rail }), ...r]))

/** An agent row with its moon replaced by the binary when `p` pairs it, laid out as draw.tsx does. */
function pairedRow(a: MockAgent, p: Pair | null, t: number, age: number, width: number, prefix = ' │  ', isLast = false): PreviewCell[] {
  const parts = agentParts(a, t, prefix, isLast)
  if (p && age >= 0) {
    const [companion, glyph] = binaryCells(t, age, p.index, parts.glyph.c)
    parts.glyph = glyph
    if (companion.t !== ' ') parts.left = [...parts.left.slice(0, -1), companion]
  }
  return joinParts(parts, width)
}

const facts = (ctx: string) => [cells('opus-5.5', { c: 'suggestion' }), cells('high', { c: 'planMode' }), cells(`${ctx} ctx`, { dim: true })]

const DRAW: Pair = { binary: { path: '/home/someone/project/hooks/draw.tsx', agents: ['a-glyphs', 'a-rows'] }, index: 0 }
const CORE: Pair = { binary: { path: '/home/someone/project/hooks/core.ts', agents: ['a-stats', 's-tidy'] }, index: 1 }
const STATE: Pair = { binary: { path: '/home/someone/project/STATE.md', agents: ['a-rows', 'a-notes', 'a-docs'] }, index: 0 }

/** Ages the contact sheet shows, in ms: the capture, then the orbit settling. */
const SHEET = [0, 100, 200, 300, 420, 520, 700, 900, 1000]

export const scenes: Scene[] = [
  {
    name: 'binary, in the pane',
    note: `glyphs and rows both write hooks/draw.tsx; their moons are caught at ${FORM_MS / 1000} s; replays every ${LOOP_MS / 1000} s`,
    draw: t => {
      const age = (t % LOOP_MS) - FORM_MS
      const p = age >= 0 ? DRAW : null
      const warning = p ? warnRows(binaryRows([p], W - 3, t, () => age)) : []
      return padded([
        ...band(t, W),
        cells(' '),
        runRow(t, 'tidy-hooks', W, [...counts(2, 4), ...runMark(t, '3:12')]),
        ...warning,
        railRow(),
        phaseRow(t, 'Refactor', W, [...counts(1, 4), ...cells(' 3:12', { dim: true })]),
        agentRow({ id: 'a-motion', label: 'tidy motion helpers', tool: 'Read', took: '2:40' }, t, W),
        detailRow(W, facts('38k')),
        pairedRow({ id: 'a-glyphs', label: 'split agent glyphs', tool: 'Edit', took: '2:55' }, p, t, age, W),
        detailRow(W, facts('51k')),
        agentRow({ id: 'a-tests', label: 'cover the parser', tool: 'Bash', took: '1:58' }, t, W),
        detailRow(W, facts('44k')),
        pairedRow({ id: 'a-rows', label: 'shorten row()', tool: 'Write', took: '2:21' }, p, t, age, W),
        detailRow(W, facts('29k')),
        agentRow({ id: 'a-lint', label: 'lint', status: 'done', cost: '$0.04', took: '0:18' }, t, W, ' │  ', true),
        flat([...cells(' ╰─', { c: HEX.rail }), { t: '○', c: 'inactive' }, ...cells(' Review', { dim: true })]),
      ], W)
    },
  },
  {
    name: 'the capture, frame by frame',
    note: 'the two cells at each age (tenths of a second): the moon turns amber, fuses, splits, and the pair cools into its orbit',
    draw: t => {
      const glyphs: PreviewCell[] = [{ t: ' ' }]
      const ages: PreviewCell[] = [{ t: ' ' }]
      for (const age of SHEET) {
        glyphs.push(...binaryCells(t, age, 0), ...cells('   '))
        ages.push(...cells(String(Math.round(age / 100)).padEnd(5, ' '), { c: HEX.rail }))
      }
      // Half an orbit: the other half is the same with the stars swapped.
      const orbit: PreviewCell[] = [{ t: ' ' }]
      ORBIT.forEach((g, k) => orbit.push(...g.map(ch => ({ t: ch, c: k === 1 ? BINARY_HEX.dip : BINARY_HEX.body })), ...cells('   ')))
      return [
        glyphs,
        ages,
        cells(' '),
        orbit,
        cells(` half an orbit, a step every ${STEP_MS / 1000} s: the right one in front, the eclipse, the left one in front, apart`, { c: HEX.rail }),
      ]
    },
  },
  {
    name: 'two binaries',
    note: 'draw.tsx shared across two child workflows, core.ts between a workflow agent and a plain subagent; a step apart, they never match',
    draw: t => {
      const age = 60_000
      return [
        runRow(t, 'tidy-hooks', W, [...counts(1, 5), ...runMark(t, '6:02')]),
        ...warnRows(binaryRows([DRAW, CORE], W - 3, t, () => age)),
        railRow(),
        phaseRow(t, 'Refactor', W, [...counts(1, 4)]),
        flat([...cells(' │  ├─', { c: HEX.rail }), { t: '✦', c: HEX.child }, ...cells(' split-stage', { bold: true })]),
        pairedRow({ id: 'a-glyphs', label: 'split agent glyphs', tool: 'Edit', took: '5:40' }, DRAW, t, age, W, ' │  │  '),
        pairedRow({ id: 'a-stats', label: 'cache sums in stats', tool: 'Edit', took: '4:02' }, CORE, t, age, W, ' │  │  ', true),
        flat([...cells(' │  ╰─', { c: HEX.rail }), { t: '✦', c: HEX.child }, ...cells(' split-stage #2', { bold: true })]),
        pairedRow({ id: 'a-rows', label: 'shorten row()', tool: 'Edit', took: '3:10' }, DRAW, t, age, W, ' │     '),
        agentRow({ id: 'a-scan', label: 'scan the tests', tool: 'Grep', took: '1:12' }, t, W, ' │     ', true),
        cells(''),
        runRow(t, 'subagents', W, [...counts(0, 1)]),
        ...warnRows(binaryRows([CORE], W - 3, t, () => age)),
        pairedRow({ id: 's-tidy', label: 'general-purpose · tidy core', tool: 'Write', took: '0:52' }, CORE, t, age, W, ' ', true),
      ]
    },
  },
  {
    name: 'precedence',
    note: "retrograde outranks the binary (one partner looping: retrograde.ts's own glyph); the binary outranks a blue shift (shift.ts's tint)",
    draw: t => {
      const age = 60_000
      const loop: Retro = { kind: 'loop', stage: 'retrograde', since: 0, detail: 'same Edit call ×4', kicks: 0 }
      const stuck = agentParts({ id: 'a-rows', label: 'shorten row() · retrograde, not a binary', tool: 'Edit', took: '9:40' }, t)
      stuck.glyph = retroGlyph(t, seeRetro(null, loop, 0), loop, HEX.live)
      const tinted = agentParts({ id: 'a-tint', label: 'a blue-shifted moon', tool: 'Read', took: '1:02' }, t)
      tinted.glyph = { ...tinted.glyph, c: moonColor(breathe(t, 1400, (seedOf('a-tint') % 100) / 100), -1) }
      return [
        phaseRow(t, 'Refactor', W, [...counts(0, 4)]),
        pairedRow({ id: 'a-glyphs', label: 'split agent glyphs · binary', tool: 'Edit', took: '5:40' }, DRAW, t, age, W),
        joinParts(stuck, W),
        pairedRow({ id: 'a-tint2', label: 'tidy core · blue-shifted, paired', tool: 'Edit', took: '2:02' }, CORE, t, age, W),
        joinParts(tinted, W),
        agentRow({ id: 'a-moon', label: 'a plain moon', tool: 'Grep', took: '0:40' }, t, W, ' │  ', true),
      ]
    },
  },
  {
    name: 'crowded run, narrow pane',
    note: 'three files shared at once in a 40-column pane: the second row counts the rest; paths shorten to fit',
    draw: t => {
      const w = 40
      const age = 60_000
      const long: Binary = { path: '/home/someone/project/hooks/events/a-rather-long-file-name.ts', agents: ['x', 'y'] }
      return [
        runRow(t, 'tidy-hooks', w, [...counts(0, 5), ...runMark(t, '6:02')]),
        ...warnRows(binaryRows([STATE, DRAW, CORE].map((p, index) => ({ ...p, index })), w - 3, t, () => age)),
        railRow(),
        ...warnRows([binaryWarning({ binary: long, index: 2 }, 24, t, age)]),
        pairedRow({ id: 'a-rows', label: 'shorten row()', tool: 'Edit', took: '3:10' }, STATE, t, age, w, ' ', true),
      ]
    },
  },
]
