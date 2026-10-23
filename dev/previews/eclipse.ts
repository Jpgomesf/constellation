// Preview of the eclipse while the session waits on the user: in the pane, over
// every kind of star, slowed down, and in its one-line form. The lineups are 167
// columns wide.
//
//   bun dev/preview.ts dev/previews/eclipse.ts --for 12

import { ECLIPSE_COLOR, ECLIPSE_HELD, eclipseCaption, eclipseCells, eclipseClock, eclipseGlyph, eclipseMarks } from '../../hooks/events/eclipse'
import type { EclipseClock, EclipseMarks, Waiting } from '../../hooks/events/eclipse'
import { HEX } from '../../hooks/motion'
import type { Cell } from '../../hooks/skies'
import { skyBand } from '../../hooks/skies'
import { STAR_H, STAR_W, starCells, starRadius, starStage } from '../../hooks/star'
import { agentRow, cells, counts, detailRow, line, phaseRow, railRow, runMark, runRow } from '../preview'
import type { PreviewCell, Scene } from '../preview'

const W = 60
/** One loop: the plain star, the wait from WAIT_AT to END_AT, the moon sliding off, the plain star again. */
const LOOP_MS = 9000
const WAIT_AT = 700
const END_AT = 6300

/** Where a loop is, as the Client would hand it: null before the wait and once the moon has slid off. */
function clockAt(t: number, shift = 0): EclipseClock | null {
  const k = (((t - shift) % LOOP_MS) + LOOP_MS) % LOOP_MS
  if (k < WAIT_AT) return null
  const marks: EclipseMarks = { on: WAIT_AT, off: k >= END_AT ? END_AT : null, from: -1 }
  return eclipseMarks(marks, k < END_AT, k) === null ? null : eclipseClock(marks, k)
}

/** One cell per character: skies.ts merges a band's cells into runs. */
const split = (row: readonly Cell[]): PreviewCell[] => row.flatMap(c => [...c.t].map(ch => ({ ...c, t: ch })))

const WAITS: Record<string, Waiting> = {
  bash: { since: 0, reason: 'permission', tool: 'Bash', summary: 'git push origin main', count: 1 },
  question: { since: 0, reason: 'question', tool: 'AskUserQuestion', summary: 'Which library should we use?', count: 1 },
  plan: { since: 0, reason: 'plan', tool: 'ExitPlanMode', summary: '', count: 1 },
  two: { since: 0, reason: 'permission', tool: 'mcp__tracker__save_issue', summary: 'T-12', count: 2 },
}

/** A lineup star: its window share (null before the first answer), and whether it is a newborn. */
type Kind = { pct: number | null; reborn?: boolean }

/** The star of `kind`, eclipsed where the clock says so. */
function star(kind: Kind, t: number, clock: EclipseClock | null): Cell[][] {
  const { pct, reborn = false } = kind
  const base = starCells(pct, t, null, reborn ? 1 : 0, reborn)
  return clock ? eclipseCells(base, t, clock, { radius: starRadius(pct), color: starStage(pct, false, reborn).color }) : base
}

const nameOf = ({ pct, reborn = false }: Kind) => (pct === null ? (reborn ? 'newborn' : 'protostar') : `${pct}% · ${starStage(pct, false).name}`)

/** The star's caption row, right-aligned as draw.tsx's bandLines sets it. */
function captionRow(pct: number, w: Waiting, waitedMs: number, isWaiting: boolean, width: number): PreviewCell[] {
  const stage = starStage(pct, false)
  const text = isWaiting ? eclipseCaption(w, waitedMs, width - 2) : stage.name
  const label = [...text].slice(0, width - 2).join('')
  return [...cells(' '.repeat(Math.max(1, width - label.length - 1))), ...cells(label, { c: isWaiting ? ECLIPSE_COLOR : stage.color }), ...cells(' ')]
}

/** The band of sky with the star at its right, as bandLines lays it out. */
function bandRows(t: number, starGrid: Cell[][]): PreviewCell[][] {
  const leftW = W - 1 - (STAR_W + 1)
  const field = skyBand('shooting', leftW, t, null, false, [], [], () => null)
  return Array.from({ length: STAR_H }, (_, i) => {
    const left = field[i] ? split(field[i]) : cells(' '.repeat(leftW))
    return [{ t: ' ' }, ...left, { t: ' ' }, ...split(starGrid[i] ?? [])]
  })
}

const header = (): PreviewCell[] =>
  line(W, [{ t: ' ' }, { t: '✦', c: HEX.ok, bold: true }], cells(' constellation', { bold: true }), [...cells('[live]', { c: 'claude', bold: true }), ...cells(' history ', { dim: true })])

/** Stars side by side, two columns apart, with a label row under them. */
function lineup(t: number, kinds: readonly Kind[], at: (i: number) => EclipseClock | null): PreviewCell[][] {
  const grids = kinds.map((k, i) => star(k, t, at(i)))
  const rows = Array.from({ length: STAR_H }, (_, y) => grids.flatMap((g, i) => [...cells(i === 0 ? ' ' : '  '), ...split(g[y] ?? [])]))
  const labels = kinds.flatMap((k, i) => [...cells(i === 0 ? ' ' : '  '), ...cells(nameOf(k).slice(0, STAR_W).padEnd(STAR_W), { c: HEX.rail })])
  return [...rows, labels]
}

/** Every star the eclipse can meet: a total eclipse up to the swelling giant (three moon sizes), an annular one past it. */
const SEVEN: readonly Kind[] = [{ pct: null }, { pct: null, reborn: true }, { pct: 8 }, { pct: 45 }, { pct: 70 }, { pct: 85 }, { pct: 97 }]

/** Text cut or padded to the rest of a one-line row. */
const fitted = (text: string, width: number) => [...text.padEnd(width)].slice(0, width).join('')

/** The one-line form that other views and a narrow pane use. */
function oneLine(t: number, pct: number, w: Waiting, waitedMs: number, shift: number, width: number): PreviewCell[] {
  const clock = clockAt(t, shift)
  const stage = starStage(pct, false)
  const glyph: PreviewCell = clock ? eclipseGlyph(t, clock, stage.color) : { t: '●', c: stage.color }
  if (!clock || clock.outAge !== null) return [{ t: ' ' }, glyph, ...cells(fitted(` ${stage.name}`, width - 2), { c: stage.color })]
  return [{ t: ' ' }, glyph, { t: ' ' }, ...cells(fitted(eclipseCaption(w, waitedMs, width - 3), width - 3), { c: ECLIPSE_COLOR })]
}

/** A wait answered at 2.4 s and a new one asked at 3.0 s, while the moon is still sliding off; loops every 6 s. */
function reentry(t: number): EclipseClock | null {
  const k = t % 6000
  const first: EclipseMarks = { on: 0, off: 2400, from: -1 }
  if (k < 2400) return eclipseClock({ ...first, off: null }, k)
  if (k < 3000) return eclipseClock(first, k)
  const again = eclipseMarks(first, true, 3000) as EclipseMarks
  if (k < 5000) return eclipseClock(again, k)
  const ended = { ...again, off: 5000 }
  return eclipseMarks(ended, false, k) === null ? null : eclipseClock(ended, k)
}

export const scenes: Scene[] = [
  {
    name: 'eclipse in the pane',
    note: `a Bash permission: the wait begins at ${WAIT_AT / 1000} s, the person answers at ${END_AT / 1000} s; loops every ${LOOP_MS / 1000} s`,
    draw: t => {
      const clock = clockAt(t)
      const isWaiting = clock !== null && clock.outAge === null
      return [
        header(),
        ...bandRows(t, star({ pct: 45 }, t, clock)),
        captionRow(45, WAITS.bash as Waiting, 0, isWaiting, W),
        runRow(t, 'scan-repo', W, [...counts(1, 2), ...runMark(t, '4:20')]),
        railRow(),
        phaseRow(t, 'Scan', W, [...counts(1, 2), ...cells(' 4:20', { dim: true })]),
        agentRow({ id: 'a-scan-api', label: 'scan-api', tool: 'Grep', took: '4:12' }, t, W),
        detailRow(W, [cells('opus-5.5', { c: 'suggestion' }), cells('high', { c: 'planMode' }), cells('42k ctx', { dim: true }), cells('$0.31', { c: 'warning' })]),
        agentRow({ id: 'a-lint', label: 'lint', status: 'done', cost: '$0.04', took: '0:18' }, t, W, ' │  ', true),
      ]
    },
  },
  {
    name: 'the hold',
    note: 'every kind of star: a protostar faintly ringed, total eclipses (a dark disc in a thin corona, beads glinting), then annular rings of fire',
    draw: t => lineup(t, SEVEN, () => ({ ...ECLIPSE_HELD, age: 60_000 + t })),
  },
  {
    name: 'the cycle',
    note: 'the same seven, staggered by 0.8 s',
    draw: t => lineup(t, SEVEN, i => clockAt(t, i * 800)),
  },
  {
    name: 'slow motion',
    note: 'six times slower: coming on, then sliding off, over a newborn and a steady star (total) and an unstable one (annular)',
    draw: t => {
      const k = (t % 6600) / 6
      const kinds: Kind[] = [{ pct: null, reborn: true }, { pct: null, reborn: true }, { pct: 35 }, { pct: 35 }, { pct: 85 }, { pct: 85 }]
      return lineup(t, kinds, i => (i % 2 === 0 ? { age: k, outAge: null } : { age: 60_000 + k, outAge: k }))
    },
  },
  {
    name: 're-entry',
    note: 'answered at 2.4 s, asked again at 3.0 s while the moon slides off: it comes back from where it is',
    draw: t => lineup(t, [{ pct: 45 }], () => reentry(t)),
  },
  {
    name: 'one line',
    note: 'where no star is drawn: other views (60 columns), a narrow pane (40)',
    draw: t => [
      oneLine(t, 45, WAITS.question as Waiting, 0, 0, W),
      oneLine(t, 85, WAITS.plan as Waiting, 0, 1500, W),
      oneLine(t, 97, WAITS.two as Waiting, 200_000, 3000, W),
      oneLine(t, 97, WAITS.two as Waiting, 200_000, 3000, 40),
    ],
  },
]
