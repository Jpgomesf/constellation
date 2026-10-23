// Retrograde in the preview harness: a looping agent's moon through its whole
// course (forward, stationary at the third call, backwards and white from the
// fourth with a kick at each repeat, direct at a different call), each stage
// side by side, and the loops' words. The Client's memory is replayed frame by
// frame, as sky.tsx keeps it.
//
//   bun dev/preview.ts dev/previews/retrograde.ts --for 15

import { DIRECT_FACT, RETRO, retroFact, retroGlyph, seeRetro } from '../../hooks/events/retrograde'
import type { Retro, RetroSeen } from '../../hooks/events/retrograde'
import { HEX, breathe, mix, quantize } from '../../hooks/motion'
import { agentParts, agentRow, cells, counts, detailRow, joinParts, line, phaseRow, seedOf } from '../preview'
import type { PreviewCell, Scene } from '../preview'

const W = 56
const STORY_MS = 14_000
const FRAME_MS = 33
const ORBIT = [...'◐◓◑◒']
const at = <T>(list: readonly T[], i: number): T => list[((Math.floor(i) % list.length) + list.length) % list.length] as T

const loop = (stage: Retro['stage'], rounds: number): Retro => ({
  kind: 'loop',
  stage,
  since: 0,
  detail: `same Bash call ×${rounds}`,
  kicks: stage === 'retrograde' ? rounds - RETRO.same.retrograde : 0,
})

/** Where the story's agent stands `s` ms in: stationary at the third call, retrograde from the fourth, a read at 10.5 s. */
function storyAt(s: number): Retro | null {
  if (s < 2500 || s >= 10_500) return null
  if (s < 5000) return loop('stationary', 3)
  return loop('retrograde', s < 7000 ? 4 : s < 9000 ? 5 : 6)
}

/** The Client's memory `s` ms in, replayed frame by frame from the start. */
function memoryAt(s: number, where: (u: number) => Retro | null): RetroSeen | null {
  let seen: RetroSeen | null = null
  for (let u = 0; u <= s; u += FRAME_MS) seen = seeRetro(seen, where(u), u)
  return seen
}

/** The moon's own breathing colour, as draw.tsx draws it at rest. */
const own = (t: number, id: string) => mix(HEX.live, HEX.glow, quantize(breathe(t, 1400, (seedOf(id) % 100) / 100), 6))

/** An agent's moon and words with `where` its course: the plain moon when it is on course. */
function course(t: number, id: string, where: (u: number) => Retro | null): { glyph: PreviewCell; words: PreviewCell[] } {
  const retro = where(t)
  const seen = memoryAt(t, where)
  const glyph = retro || seen ? retroGlyph(t, seen, retro, own(t, id)) : { t: at(ORBIT, t / 150), c: own(t, id) }
  const said = retro ? [retroFact(retro)] : seen?.stage === 'direct' ? [DIRECT_FACT] : []
  return { glyph, words: said }
}

const model = [cells('opus 5.5', { c: 'suggestion' }), cells('xhigh', { c: 'planMode' })]
/** A word cell as the harness wants it: one character a cell. */
const chars = (c: PreviewCell): PreviewCell[] => [...c.t].map(ch => ({ ...c, t: ch }))
/** A detail line padded to the pane's width, so its row keeps one width as words come and go. */
const detail = (facts: PreviewCell[][], isLast = false): PreviewCell[] => {
  const row = detailRow(W, facts, ' │  ', isLast)
  return [...row, ...cells(' '.repeat(Math.max(0, W - row.length)))]
}

/** The tree around an agent with this course: a sibling turning forward, a done one, a pending phase. */
function tree(t: number, id: string, label: string, where: (u: number) => Retro | null): PreviewCell[][] {
  const { glyph, words } = course(t, id, where)
  const parts = agentParts({ id, label, tool: 'Bash', took: `0:${String(31 + Math.floor((t % STORY_MS) / 1000)).padStart(2, '0')}` }, t)
  parts.glyph = glyph
  return [
    phaseRow(t, 'Wrap up', W, [...counts(1, 2), ...cells(' 0:41', { dim: true })]),
    agentRow({ id: 'scan', label: 'scan the routes', tool: 'Read', took: '0:21' }, t, W),
    joinParts(parts, W),
    detail([...words.map(chars), ...model]),
    agentRow({ id: 'lint', label: 'lint the diff', status: 'done', cost: '$0.04', took: '0:18' }, t, W, ' │  ', true),
    line(W, cells(' ╰─', { c: HEX.rail }), [{ t: '○', c: 'inactive' }, ...cells(' Report', { dim: true })], []),
  ]
}

export const scenes: Scene[] = [
  {
    name: 'the whole course',
    note: `forward, stationary ×3, retrograde ×4 ×5 ×6 (a kick at each), direct; every ${STORY_MS / 1000} s`,
    draw: t => tree(t % STORY_MS, 'rerun', 'rerun the flaky test', storyAt),
  },
  {
    name: 'each stage, held',
    note: 'stationary (its words through the telescope only), retrograde, a silence past its line (still, white), going direct',
    draw: t => {
      const silent: Retro = { kind: 'stuck', stage: 'retrograde', since: 0, detail: 'no answer for 6:12', kicks: 0 }
      const rows: [string, string, (u: number) => Retro | null][] = [
        ['s-still', 'map the routes', () => loop('stationary', 3)],
        ['s-back', 'rerun the flaky test', () => loop('retrograde', 5)],
        ['s-quiet', 'plan the migration', () => silent],
        // A loop that broke 400 ms before each frame: going direct.
        ['s-direct', 'fix the import', u => (u < t - 400 ? loop('retrograde', 4) : null)],
      ]
      return rows.flatMap(([id, label, where], i) => {
        const { glyph, words } = course(t, id, where)
        const parts = agentParts({ id, label, tool: 'Bash', took: '1:02' }, t, ' │  ', i === rows.length - 1)
        parts.glyph = glyph
        return [joinParts(parts, W), detail(words.map(chars), i === rows.length - 1)]
      })
    },
  },
  {
    name: 'the words',
    note: 'the same call, a cycle, a poll, a tool past its line',
    draw: () => {
      const said: Retro[] = [
        loop('retrograde', 6),
        { kind: 'loop', stage: 'retrograde', since: 0, detail: 'same Read → Grep cycle ×3', kicks: 0 },
        { kind: 'loop', stage: 'stationary', since: 0, detail: 'same Bash poll ×12', kicks: 0 },
        { kind: 'stuck', stage: 'retrograde', since: 0, detail: 'Bash running for 11:02', kicks: 0 },
      ]
      return said.map(r => [{ t: ' ' }, ...chars(retroFact(r))])
    },
  },
]
