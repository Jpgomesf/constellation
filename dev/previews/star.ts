// The worked example for dev/preview.ts: the session star at four stages, its
// supernova on a loop, and a mocked stretch of the tree.
//
//   bun dev/preview.ts dev/previews/star.ts --for 8

import { HEX } from '../../hooks/motion'
import { starCells, starStage } from '../../hooks/star'
import { agentRow, cells, counts, detailRow, phaseRow, railRow, runMark, runRow } from '../preview'
import type { Scene } from '../preview'

/** The supernova's loop: its 2.6 s blast, then the newborn star. */
const NOVA_LOOP_MS = 4200
/** The mocked tree's width, about a docked pane's. */
const TREE_W = 60

const stage = (pct: number): Scene => ({
  name: `star ${pct}%`,
  note: starStage(pct, false).name,
  draw: t => starCells(pct, t, null, 0),
})

export const scenes: Scene[] = [
  stage(10),
  stage(50),
  stage(85),
  stage(97),
  {
    name: 'supernova',
    note: `a compaction: the blast, then the newborn star and one nebula ring; replays every ${NOVA_LOOP_MS / 1000} s`,
    // The compaction happens at the start of each loop.
    draw: t => starCells(null, t, t - (t % NOVA_LOOP_MS), 1, true),
  },
  {
    name: 'tree',
    note: 'a mocked run: phase, a running agent with its detail line, a finished one',
    draw: t => [
      runRow(t, 'scan-repo', TREE_W, [...counts(1, 1), ...runMark(t, '0:42')]),
      railRow(),
      phaseRow(t, 'Scan', TREE_W, [...counts(1, 1), ...cells(' 0:42', { dim: true })]),
      agentRow({ id: 'a-scan-api', label: 'scan-api', tool: 'Grep', took: '0:31' }, t, TREE_W),
      detailRow(TREE_W, [cells('opus-5.5', { c: 'suggestion' }), cells('high', { c: 'planMode' }), cells('42k ctx', { dim: true }), cells('$0.31', { c: 'warning' })]),
      agentRow({ id: 'a-scan-web', label: 'scan-web', status: 'done', cost: '$0.12', took: '0:18' }, t, TREE_W, ' │  ', true),
      [...cells(' ╰─', { c: HEX.rail }), { t: '○', c: 'inactive' }, ...cells(' Report', { dim: true })],
    ],
  },
]
