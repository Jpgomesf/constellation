// Preview of comet tails on stragglers, in mocked pane rows.
//
//   bun dev/preview.ts dev/previews/comet.ts --for 20

import type { SkyAgent } from '../../hooks/core'
import { COMET, cometLabel, cometMiddle, isStraggler, latenessAt, pacer } from '../../hooks/events/comet'
import type { CometDraw } from '../../hooks/events/comet'
import { HEX, ease, mix, quantize, twinkle } from '../../hooks/motion'
import { skyBand } from '../../hooks/skies'
import { STAR_H, STAR_W, starCells, starStage } from '../../hooks/star'
import { agentParts, agentRow, cells, counts, detailRow, line, phaseRow, railRow, runMark, runRow, seedOf, shimmerCells } from '../preview'
import type { MockAgent, PreviewCell, Scene } from '../preview'

/** About a docked pane's width. */
const W = 60
/** The finished siblings' pace in the mocks: 1:20. */
const PACE_MS = 80_000
/** The pane's loop: lateness grows, holds, then the straggler finishes and rests. */
const GROW_MS = 13_000
const HOLD_MS = 2_000
const REST_MS = 2_500
const LOOP_MS = GROW_MS + HOLD_MS + REST_MS
/** The ignite-and-exit loop: a comet appears, holds, finishes, scatters. */
const LIFE_MS = 4_000
const LIFE_END = 2_600
/** draw.tsx's finish flash on the glyph. */
const FLASH_MS = 900

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** draw.tsx's finish flash: a white star that settles to the finished green dot. */
function flash(gone: number): PreviewCell {
  const p = Math.min(1, gone / FLASH_MS)
  return p >= 1 ? { t: '●', c: 'success' } : { t: p < 0.35 ? '✦' : '●', c: mix(HEX.flash, HEX.ok, quantize(ease.outCubic(p), 6)) }
}

/** An agent row with a comet, as draw.tsx draws it; `draw.gone` is how long ago it finished (null while it runs). */
function cometRow(a: MockAgent, lateness: number | null, t: number, draw: CometDraw, width: number, prefix = ' │  ', isLast = false): PreviewCell[] {
  const p = agentParts(a, t, prefix, isLast)
  const gone = draw.gone ?? null
  const left = [...p.left, gone === null ? p.glyph : flash(gone)]
  const seed = seedOf(a.id)
  const m = cometMiddle(` ${a.label}`, width - left.length - p.right.length, lateness, t, { ...draw, seed })
  const isComet = isStraggler(lateness) && (gone === null || gone < COMET.exitMs)
  const label = isComet ? cometLabel(m.label, lateness, t, { ...draw, seed }) : gone === null ? shimmerCells(m.label, t, seed) : cells(m.label)
  return [...left, ...label, ...m.tail, ...p.right]
}

const header = (t: number): PreviewCell[] =>
  line(W, [...cells(' ✦', { c: mix(HEX.live, HEX.glow, quantize(twinkle(t, 3), 6)), bold: true })], cells(' constellation', { bold: true }), [...cells('[live]', { c: 'claude', bold: true }), ...cells(' history ', { dim: true })])

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** draw.tsx's starfield: one star per seven columns at most, a quarter of them dark. */
function starfield(width: number, t: number, seed: number): PreviewCell[] {
  const row: PreviewCell[] = cells(' '.repeat(width))
  for (let cell = 0; cell * 7 < width; cell++) {
    const h = hash(cell * 7919 + seed * 104_729)
    if (h % 4 === 0) continue
    const x = cell * 7 + 1 + (h % 5)
    if (x >= width) continue
    const b = quantize(twinkle(t, h), 8)
    row[x] = { t: b < 0.2 ? '·' : b < 0.45 ? '∙' : b < 0.75 ? '✧' : '✦', c: mix(HEX.dim, h % 3 === 0 ? HEX.glow : HEX.star, 0.25 + 0.75 * b) }
  }
  return row
}

/** The sky band with the session star and its stage, as bandLines lays them out. */
function band(t: number): PreviewCell[][] {
  const leftW = W - 1 - (STAR_W + 1)
  const sky = skyBand('stars', leftW, t, null, true, [], [], () => null).map(r => r.flatMap(c => cells(c.t, { c: c.c, bold: c.bold })))
  const star = starCells(46, t, null, 0)
  const rows = Array.from({ length: Math.max(sky.length, STAR_H) }, (_, i) => [
    { t: ' ' },
    ...(sky[i] ?? (i % 2 === 1 ? starfield(leftW, t, 20 + i) : cells(' '.repeat(leftW)))),
    { t: ' ' },
    ...(star[i] ?? []),
  ])
  const stage = starStage(46, false)
  return [...rows, [...cells(' '.repeat(W - stage.name.length - 1)), ...cells(stage.name, { c: stage.color })]]
}

/** Where the pane's loop is at `t`: the straggler's lateness, how long since it crossed 1.5x, and since it finished. */
function growth(t: number): { lateness: number; age: number; gone: number | null } {
  const k = t % LOOP_MS
  const lateness = 1.1 + 3.9 * Math.min(1, k / GROW_MS)
  const crossed = ((COMET.from - 1.1) / 3.9) * GROW_MS
  const end = GROW_MS + HOLD_MS
  return { lateness, age: k - crossed, gone: k >= end ? k - end : null }
}

/** A row padded to the pane's width, so rows keep one width when a detail line goes. */
const pad = (row: PreviewCell[]): PreviewCell[] => [...row, ...cells(' '.repeat(Math.max(0, W - row.length)))]

const done = (id: string, label: string, cost: string, took: string): MockAgent => ({ id, label, status: 'done', cost, took })

/** A mocked SkyAgent for the detection in the subagents scene. */
function sky(id: string, label: string, status: SkyAgent['status'], startedAt: number, endedAt: number | null = null): SkyAgent {
  return { id, label, status, model: null, effort: null, tokens: null, costUsd: null, tools: null, lastTool: null, startedAt, endedAt, error: null }
}

/** The subagents group of the session: an old Explore batch, a new one with a straggler, and a general-purpose one launched alone. */
const NOW = 60 * 60_000
const SUBS: SkyAgent[] = [
  sky('s-old-1', 'Explore · find the config loader', 'done', 0, 41_000),
  sky('s-old-2', 'Explore · list the test fixtures', 'done', 1_000, 36_000),
  sky('s-new-1', 'Explore · read the retry docs', 'done', NOW - 200_000, NOW - 158_000),
  sky('s-new-2', 'Explore · find every caller', 'done', NOW - 199_000, NOW - 150_000),
  sky('s-new-3', 'Explore · map every route', 'running', NOW - 198_000),
  sky('s-gp', 'general-purpose · trace the retry path', 'running', NOW - 240_000),
]

export const scenes: Scene[] = [
  {
    name: 'in the pane',
    note: 'scan-billing falls behind its finished siblings (pace 1:20), grows a tail, finishes and scatters it; replays every 17.5 s',
    draw: t => {
      const { lateness, age, gone } = growth(t)
      const took = fmt(lateness * PACE_MS)
      const late: MockAgent = gone === null ? { id: 'a-scan-billing', label: 'scan-billing', tool: 'Grep', took } : done('a-scan-billing', 'scan-billing', '$0.71', took)
      const left = gone === null ? 2 : 1
      const rows: PreviewCell[][] = [
        header(t),
        ...band(t),
        runRow(t, 'audit-repo', W, [...counts(5 - left, left), ...runMark(t, fmt(lateness * PACE_MS + 20_000))]),
        railRow(),
        phaseRow(t, 'Scan', W, [...counts(5 - left, left), ...cells(` ${fmt(lateness * PACE_MS + 20_000)}`, { dim: true })]),
        agentRow(done('a-scan-api', 'scan-api', '$0.21', '1:12'), t, W),
        agentRow(done('a-scan-web', 'scan-web', '$0.18', '1:20'), t, W),
        agentRow(done('a-scan-auth', 'scan-auth', '$0.25', '1:31'), t, W),
        cometRow(late, lateness, t, { age, gone }, W),
        ...(gone === null ? [detailRow(W, [cells('opus 5.5', { c: 'suggestion' }), cells('xhigh', { c: 'planMode' }), cells('88k ctx', { dim: true }), cells('41 tools', { dim: true }), cells('$0.64', { c: 'warning' })])] : []),
        cometRow({ id: 'a-scan-jobs', label: 'scan-jobs', tool: 'Read', took: '0:52' }, 0.65, t, {}, W, ' │  ', true),
        detailRow(W, [cells('opus 5.5', { c: 'suggestion' }), cells('xhigh', { c: 'planMode' }), cells('31k ctx', { dim: true }), cells('$0.12', { c: 'warning' })], ' │  ', true),
        [...cells(' ╰─', { c: HEX.rail }), { t: '○', c: 'inactive' }, ...cells(' Report', { dim: true })],
        ...(gone === null ? [] : [[]]),
      ]
      return rows.map(pad)
    },
  },
  {
    name: 'ladder',
    note: 'settled tails at 1.4x (none), 1.5x, 2x, 3x, 4x and 6x the pace',
    draw: t =>
      [1.4, 1.5, 2, 3, 4, 6].map((l, i) =>
        cometRow({ id: `a-ladder-${i}`, label: `scan-billing ${l}x`, tool: 'Grep', took: fmt(l * PACE_MS) }, l, t, {}, W, ' │  ', i === 5),
      ),
  },
  {
    name: 'long labels',
    note: 'little room: at 60 columns, 4x, 2x and 1.5x; at 46 columns under a child workflow, 4x',
    draw: t => [
      cometRow({ id: 'a-long-1', label: 'reconcile the billing ledger against invoices', tool: 'Bash', took: '5:20' }, 4, t, {}, W),
      cometRow({ id: 'a-long-2', label: 'reconcile the billing ledger against invoices', tool: 'Read', took: '2:40' }, 2, t, {}, W),
      cometRow({ id: 'a-long-6', label: 'reconcile the billing ledger against invoices', tool: 'Read', took: '2:00' }, 1.5, t, {}, W),
      cometRow({ id: 'a-long-3', label: 'map every route', tool: 'mcp_get_issue', took: '5:20' }, 4, t, {}, W),
      [],
      [...cells(' │  ├─', { c: HEX.rail }), { t: '✦', c: HEX.child }, ...cells(' scan-stage #2', { bold: true })],
      cometRow({ id: 'a-long-4', label: 'longest file in the tests folder', tool: 'Grep', took: '5:20' }, 4, t, {}, 46, ' │  │  '),
      cometRow({ id: 'a-long-5', label: 'list tests', tool: 'Glob', took: '5:20' }, 4, t, {}, 46, ' │  │  ', true),
    ],
  },
  {
    name: 'ignite and exit',
    note: 'a comet at 2.5x unrolls and burns bright, holds, then finishes and scatters; replays every 4 s',
    draw: t => {
      const k = t % LIFE_MS
      const gone = k >= LIFE_END ? k - LIFE_END : null
      const a: MockAgent = gone === null ? { id: 'a-ig-1', label: 'scan-billing', tool: 'Grep', took: '3:20' } : done('a-ig-1', 'scan-billing', '$0.52', '3:20')
      return [agentRow(done('a-ig-0', 'scan-web', '$0.18', '1:20'), t, W), cometRow(a, 2.5, t, { age: k, gone }, W, ' │  ', true)]
    },
  },
  {
    name: 'subagents',
    note: 'detection by type and burst: the Explore straggler drags a tail, the lone general-purpose one does not',
    draw: t => {
      const pace = pacer(SUBS, 0, true)
      const now = NOW + (t % 20_000)
      const shown = SUBS.slice(2)
      return [
        line(W, [{ t: ' ' }, { t: '✦', c: mix(HEX.child, HEX.childGlow, 0.5), bold: true }], cells(' subagents', { bold: true }), counts(2, 2)),
        ...shown.map((s, i) => {
          const isLast = i === shown.length - 1
          if (s.status === 'done') return agentRow(done(s.id, s.label, '$0.08', fmt((s.endedAt ?? 0) - (s.startedAt ?? 0))), t, W, ' ', isLast)
          const lateness = latenessAt(s, pace(s), now)
          return cometRow({ id: s.id, label: s.label, tool: 'Read', took: fmt(now - (s.startedAt ?? 0)) }, lateness, t, {}, W, ' ', isLast)
        }),
      ]
    },
  },
]
