// Preview of the meteor shower: failures falling across the sky band, in a
// mocked pane and in bands of every size. Scenes go through the real path
// (a failure ring, showerProps, meteorOf), so they show only what the pane can.
//
//   bun dev/preview.ts dev/previews/meteor.ts --for 12

import { HEX, mix, quantize, twinkle } from '../../hooks/motion'
import { cellsOf, meteorOf, meteorOverlay, showerCaption, showerProps } from '../../hooks/events/meteor'
import type { Failure, FailureKind, Meteor } from '../../hooks/events/meteor'
import { skyBand } from '../../hooks/skies'
import type { Cell, Sample, SkyStyle } from '../../hooks/skies'
import { STAR_H, STAR_W, starCells, starStage } from '../../hooks/star'
import { agentParts, agentRow, cells, counts, joinParts, phaseRow, railRow, runMark, runRow } from '../preview'
import type { PreviewCell, Scene } from '../preview'

/** A docked pane's width. */
const W = 60
/** A narrow pane's width: too narrow for the star, so the band stands alone. */
const NARROW = 40

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** draw.tsx's starfield (the rows under a one-row band, beside the star), as cells. */
function starfield(cols: number, t: number, seed: number): Cell[] {
  const row: Cell[] = Array.from({ length: cols }, () => ({ t: ' ' }))
  for (let cell = 0; cell * 7 < cols; cell++) {
    const h = hash(cell * 7919 + seed * 104_729)
    if (h % 4 === 0) continue
    const x = cell * 7 + 1 + (h % 5)
    if (x >= cols) continue
    const b = quantize(twinkle(t, h), 8)
    row[x] = { t: b < 0.2 ? '·' : b < 0.45 ? '∙' : b < 0.75 ? '✧' : '✦', c: mix(HEX.dim, h % 3 === 0 ? HEX.glow : HEX.star, 0.25 + 0.75 * b) }
  }
  return row
}

const LABELS: Record<string, string> = {
  'a-scan-api': 'scan-api',
  'a-scan-web': 'scan-web',
  'a-build': 'build',
  'a-publish': 'publish the branch',
}

/** One failure of a script: when it falls on the frame clock (ms), which agent, how. */
type Shot = { at: number; agent: string; kind?: FailureKind }

/** The meteors the pane would hold at `t`; failures arrive a second early, as props reach the Client before a launch. */
function meteorsAt(shots: readonly Shot[], t: number): Meteor[] {
  const ring: Failure[] = shots
    .filter(s => s.at <= t + 1_000)
    .sort((a, b) => a.at - b.at)
    .map(s => ({ id: `toolu_${s.agent}_${s.at}`, agent: s.agent, at: s.at, kind: s.kind ?? 'error' }))
  return showerProps(ring, t + 1_000, id => LABELS[id] ?? null).map(f => meteorOf(f, f.at))
}

/** A script repeated every `period` ms, from long before t=0, so the minute's history is pure in t. */
function every(period: number, shots: readonly Shot[], t: number): Shot[] {
  const out: Shot[] = []
  const last = Math.floor(t / period)
  for (let k = last - Math.ceil(61_000 / period); k <= last; k++) for (const s of shots) out.push({ ...s, at: k * period + s.at })
  return out
}

/** The band beside the star, as draw.tsx's bandLines lays it out, with the shower's name on the stage line. */
function band(t: number, meteors: readonly Meteor[], cols = W, pct = 45): PreviewCell[][] {
  const leftW = cols - 1 - (STAR_W + 1)
  const sky = skyBand('stars', leftW, t, null, true, [], [], () => null)
  const grid = Array.from({ length: STAR_H }, (_, i) => cellsOf(sky[i] ?? (i % 2 === 1 ? starfield(leftW, t, 20 + i) : [{ t: ' '.repeat(leftW) }])))
  meteorOverlay(grid, t, meteors)
  const star = starCells(pct, t, null, 0)
  const rows: PreviewCell[][] = grid.map((left, i) => [{ t: ' ' }, ...left, { t: ' ' }, ...(star[i] ?? [])])
  const stage = starStage(pct, false)
  const label = [...stage.name].length
  const words = showerCaption(meteors, t, cols - 2 - label - 4)
  const caption = words ? cells(words.t, { c: words.c }) : []
  rows.push([{ t: ' ' }, ...caption, ...cells(' '.repeat(Math.max(1, cols - 2 - caption.length - label))), ...cells(stage.name, { c: stage.color })])
  return rows
}

/** A narrow pane's band: the style alone, no star and no caption, so the tree never moves while it rains. */
function narrow(style: SkyStyle, t: number, meteors: readonly Meteor[], samples: readonly Sample[] = []): PreviewCell[][] {
  const grid = skyBand(style, NARROW - 1, t, null, true, [], samples, () => null).map(cellsOf)
  meteorOverlay(grid, t, meteors)
  return grid.map(row => [{ t: ' ' }, ...row])
}

/** The header row, as drawSky writes it: the twinkling title and the tabs. */
function header(t: number): PreviewCell[] {
  const glow = quantize(0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 2000), 6)
  const left = [{ t: ' ' }, { t: '✦', c: mix(HEX.live, HEX.glow, glow), bold: true }, ...cells(' constellation', { bold: true })]
  const right = [...cells('[live]', { c: 'claude', bold: true }), ...cells(' history ', { dim: true })]
  return [...left, ...cells(' '.repeat(W - left.length - right.length)), ...right]
}

// scan-api's meteors fall down to the right, build's down to the left.
const API = { agent: 'a-scan-api' }
const WEB = { agent: 'a-scan-web' }
const BUILD = { agent: 'a-build' }
const PUBLISH = { agent: 'a-publish' }

/** The pane scene's one-shot script: a straggler half a minute ago, then scan-api's burst (one call denied), then another straggler. */
const PANE_SHOTS: Shot[] = [
  { ...WEB, at: -31_000 },
  { ...API, at: 900 },
  { ...API, at: 1_150 },
  { ...API, at: 1_500, kind: 'deny' },
  { ...API, at: 1_850 },
  { ...API, at: 2_600 },
  { ...API, at: 3_100 },
  { ...WEB, at: 6_400 },
]

/** Two agents failing all minute, eighty times a minute: scan-api three times in four. */
const STORM: Shot[] = [
  { ...API, at: 100 },
  { ...API, at: 700 },
  { ...BUILD, at: 1_300 },
  { ...API, at: 2_200 },
]

/** A sparkline's samples: two agents running, then three, at about a cent a second. */
const SAMPLES: Sample[] = Array.from({ length: 40 }, (_, i) => ({ t: i * 500, live: 2 + (i % 7 === 0 ? 1 : 0), cost: i * 0.005 }))

export const scenes: Scene[] = [
  {
    name: 'in the pane',
    note: 'scan-api fails six times in two seconds (one a deny), then a straggler from scan-web',
    draw: t => {
      const meteors = meteorsAt(PANE_SHOTS, t)
      const api = agentParts({ id: 'a-scan-api', label: 'scan-api', tool: 'Bash', took: '4:12' }, t)
      return [
        header(t),
        ...band(t, meteors),
        runRow(t, 'scan-repo', W, [...counts(1, 2), ...runMark(t, '4:20')]),
        railRow(),
        phaseRow(t, 'Scan', W, [...counts(1, 2), ...cells(' 4:20', { dim: true })]),
        joinParts(api, W),
        agentRow({ id: 'a-scan-web', label: 'scan-web', tool: 'Read', took: '0:40' }, t, W),
        agentRow({ id: 'a-lint', label: 'lint', status: 'done', cost: '$0.04', took: '0:18' }, t, W, ' │  ', true),
      ]
    },
  },
  {
    name: 'a lone failure',
    note: 'one failure at 0.5 s and another at 6 s, nothing else: sporadics',
    draw: t => band(t, meteorsAt([{ ...WEB, at: 500 }, { ...WEB, at: 6_000 }], t)),
  },
  {
    name: 'a burst',
    note: 'twelve failures from scan-api in three seconds, from 0.5 s: a shower, then its faint meteors',
    draw: t => band(t, meteorsAt(Array.from({ length: 12 }, (_, i) => ({ ...API, at: 500 + i * 250 })), t)),
  },
  {
    name: 'storm',
    note: 'eighty a minute from two agents, as the props carry it (the newest forty)',
    draw: t => band(t, meteorsAt(every(3_000, STORM, t), t), W, 85),
  },
  {
    name: 'fading',
    note: 'a burst of twelve, forty seconds ago: thinning, the name quiet',
    draw: t => band(t, meteorsAt(Array.from({ length: 12 }, (_, i) => ({ ...API, at: -40_000 + i * 250 })), t)),
  },
  {
    name: 'denied',
    note: 'a deny falls amber (at 0.4 s and 4.4 s)',
    draw: t => band(t, meteorsAt([{ ...PUBLISH, at: 400, kind: 'deny' }, { ...PUBLISH, at: 4_400, kind: 'deny' }], t)),
  },
  {
    name: 'one row',
    note: 'a narrow pane (40 columns, no star): meteors fall through the scan lines of one row; no caption',
    draw: t => narrow('stars', t, meteorsAt(every(2_500, [{ ...API, at: 200 }, { ...BUILD, at: 1_100 }], t), t)),
  },
  {
    name: 'two rows · sparkline',
    note: 'the sparkline band in a narrow pane: meteors pass behind its words',
    draw: t => narrow('spark', t, meteorsAt(every(3_000, STORM, t), t), SAMPLES),
  },
  {
    name: 'three rows · parallax',
    note: 'a three-row band: the meteors fall a row a cell again',
    draw: t => narrow('parallax', t, meteorsAt(every(3_000, STORM, t), t)),
  },
]
