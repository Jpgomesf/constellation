import { expect, test } from 'claude-code/testing'

import type { SkyAgent, SkyNode, SkyRun } from '../hooks/core'
import {
  BINARY,
  FILE_TOOLS,
  LOCK_MS,
  ORBIT,
  STEP_MS,
  addTouches,
  applyTouches,
  binariesIn,
  binariesOf,
  binaryCells,
  binaryKey,
  binaryOfAgent,
  binaryRows,
  binaryWarning,
  editedPath,
  normalizePath,
  orbitStep,
  shortPath,
} from '../hooks/events/binary'
import type { Binary, Pair, Touch } from '../hooks/events/binary'
import { HEX } from '../hooks/motion'
import { runsOf } from '../hooks/skies'
import type { Cell } from '../hooks/skies'

const MINUTE = 60_000
const NOW = 1_800_000_000_000
const ROOT = '/home/someone/project'
const DRAW = `${ROOT}/hooks/draw.tsx`
const CORE = `${ROOT}/hooks/core.ts`

const textOf = (cells: readonly Cell[]) => cells.map(c => c.t).join('')
const luma = (hex: string | undefined) => {
  const n = Number.parseInt((hex ?? '#000000').slice(1), 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
}
const isOneCell = (c: Cell) => [...c.t].length === 1
/** A file first written at `first` and last at `at`. */
const touch = (path: string, first: number, at = first): Touch => ({ path, first, at })
const stats = (files: Record<string, Touch[]>) => Object.fromEntries(Object.entries(files).map(([id, f]) => [id, { files: f }]))
const pairOf = (binary: Binary, index = 0): Pair => ({ binary, index })

// ---------------------------------------------------------------- detection

test('the file a call writes comes from Edit, Write and NotebookEdit, normalized', () => {
  expect(editedPath('Edit', { file_path: `${ROOT}/./hooks/../hooks//draw.tsx`, old_string: 'a', new_string: 'b' })).toBe(DRAW)
  expect(editedPath('Write', { file_path: DRAW, content: '' })).toBe(DRAW)
  expect(editedPath('NotebookEdit', { notebook_path: `${ROOT}/notes/scan.ipynb`, new_source: '' })).toBe(`${ROOT}/notes/scan.ipynb`)
  // tool.call's `e` carries the arguments beside `tool`, so it can be passed whole.
  expect(editedPath('Edit', { tool: 'Edit', tool_use_id: 'tu-1', agentId: 'a-rows', file_path: DRAW })).toBe(DRAW)
  for (const [tool, input] of [
    ['Read', { file_path: DRAW }],
    ['Bash', { command: `echo hi > ${CORE}` }],
    ['Edit', { file_path: '' }],
    ['Edit', { file_path: 42 }],
    ['Write', null],
    ['mcp__files__write', { file_path: CORE }],
    ['constructor', { file_path: CORE }],
  ] as const) {
    expect(editedPath(tool, input)).toBeNull()
  }
  expect([...FILE_TOOLS].sort()).toEqual(['Edit', 'NotebookEdit', 'Write'])
})

test('paths normalize the way the file system reads them', () => {
  expect(normalizePath('/home/someone//project/./a/../b.ts')).toBe('/home/someone/project/b.ts')
  expect(normalizePath('/../etc/x')).toBe('/etc/x')
  expect(normalizePath('../shared/x.ts')).toBe('../shared/x.ts')
  expect(normalizePath('C:\\Users\\someone\\x.ts')).toBe('C:/Users/someone/x.ts')
})

test("an agent's record keeps each file once, when it first and last wrote it, within the window", () => {
  let mine = addTouches(null, [DRAW], NOW)
  mine = addTouches(mine, [CORE], NOW + 1000)
  mine = addTouches(mine, [DRAW, DRAW], NOW + 2000)
  expect(mine).toEqual([touch(CORE, NOW + 1000), touch(DRAW, NOW, NOW + 2000)])
  const later = NOW + 2000 + BINARY.windowMs
  expect(addTouches(mine, [DRAW], later)).toEqual([touch(DRAW, later)])
})

test('the window, not the cap, bounds the record: a refactor across many files still pairs on the first', () => {
  let a: Touch[] = addTouches(null, [DRAW], NOW - 5 * MINUTE)
  for (let i = 0; i < 12; i++) a = addTouches(a, [`${ROOT}/f${i}.ts`], NOW - 5 * MINUTE + (i + 1) * 1500)
  expect(a.some(x => x.path === DRAW)).toBe(true)
  const b = addTouches(null, [DRAW], NOW - MINUTE)
  expect(binariesOf(stats({ a, b }), ['a', 'b'], NOW)).toEqual([{ path: DRAW, agents: ['a', 'b'] }])
  let many: Touch[] = []
  for (let i = 0; i < 100; i++) many = addTouches(many, [`${ROOT}/f${i}.ts`, `${ROOT}/g${i}.ts`], NOW + i)
  expect(many).toHaveLength(BINARY.perAgent)
  expect(many.at(-1)).toEqual(touch(`${ROOT}/g99.ts`, NOW + 99))
})

test("the flush files each write under its agent, and keeps files only for running agents' recent writes", () => {
  type S = { endedAt: number | null; lastAt: number; files?: Touch[] }
  const record: Record<string, S> = {
    'a-rows': { endedAt: null, lastAt: NOW },
    'a-done': { endedAt: NOW - 1000, lastAt: NOW - 1000, files: [touch(DRAW, NOW - 2 * MINUTE)] },
    'a-idle': { endedAt: null, lastAt: NOW, files: [touch(CORE, NOW - BINARY.windowMs - 1), touch(DRAW, NOW - MINUTE)] },
    'a-stale': { endedAt: null, lastAt: NOW, files: [touch(CORE, NOW - BINARY.windowMs)] },
  }
  const next = applyTouches(record, [{ id: 'a-rows', path: DRAW, at: NOW - 500 }, { id: 'a-done', path: CORE, at: NOW }, { id: 'a-ghost', path: DRAW, at: NOW }, { id: 'a-rows', path: DRAW, at: NOW }], NOW)
  expect(next['a-rows']).toEqual({ endedAt: null, lastAt: NOW, files: [touch(DRAW, NOW - 500, NOW)] })
  expect(next['a-done']).toEqual({ endedAt: NOW - 1000, lastAt: NOW - 1000, files: undefined })
  expect(next['a-idle']?.files).toEqual([touch(DRAW, NOW - MINUTE)])
  expect(next['a-stale']?.files).toBeUndefined()
  expect(Object.hasOwn(next, 'a-ghost')).toBe(false)
  expect(record['a-rows']?.files).toBeUndefined()
  let all: Record<string, S> = {}
  for (let i = 0; i < 300; i++) {
    const id = `a-${i}`
    all = { ...all, [id]: { endedAt: null, lastAt: NOW + i } }
    all = applyTouches(all, [{ id, path: `${ROOT}/f${i % 7}.ts`, at: NOW + i }], NOW + i)
    if (i >= 2) all = applyTouches({ ...all, [`a-${i - 2}`]: { ...(all[`a-${i - 2}`] as S), endedAt: NOW + i } }, [], NOW + i)
  }
  expect(Object.values(all).filter(s => s.files).length).toBe(2)
})

test('two running agents writing one file within ten minutes are a binary, the first to write listed first', () => {
  const record = stats({
    'a-rows': [touch(DRAW, NOW - 2 * MINUTE)],
    'a-glyphs': [touch(DRAW, NOW - 8 * MINUTE), touch(CORE, NOW - MINUTE)],
    'a-tests': [touch(`${ROOT}/tests/a.test.ts`, NOW)],
  })
  expect(binariesOf(record, ['a-rows', 'a-glyphs', 'a-tests'], NOW)).toEqual([{ path: DRAW, agents: ['a-glyphs', 'a-rows'] }])
  expect(binariesOf(record, ['a-tests', 'a-glyphs', 'a-rows'], NOW)).toEqual(binariesOf(record, ['a-rows', 'a-glyphs', 'a-tests'], NOW))
})

test('partners taking turns at the file keep their order and their key, so the capture plays once', () => {
  let a = addTouches(null, [DRAW], NOW - 3 * MINUTE)
  let b = addTouches(null, [DRAW], NOW - 2 * MINUTE)
  const first = binariesOf(stats({ a, b }), ['a', 'b'], NOW)
  a = addTouches(a, [DRAW], NOW - MINUTE)
  const second = binariesOf(stats({ a, b }), ['a', 'b'], NOW)
  b = addTouches(b, [DRAW], NOW)
  const third = binariesOf(stats({ a, b }), ['a', 'b'], NOW)
  expect(first).toEqual([{ path: DRAW, agents: ['a', 'b'] }])
  expect(second).toEqual(first)
  expect(third).toEqual(first)
  expect(binaryKey({ path: DRAW, agents: ['b', 'a'] })).toBe(binaryKey({ path: DRAW, agents: ['a', 'b'] }))
  expect(binaryKey({ path: DRAW, agents: ['a', 'b', 'c'] })).not.toBe(binaryKey({ path: DRAW, agents: ['a', 'b'] }))
  expect(binaryKey({ path: CORE, agents: ['a', 'b'] })).not.toBe(binaryKey({ path: DRAW, agents: ['a', 'b'] }))
})

test('no binary when a partner has finished, wrote too long ago, or is the same agent twice', () => {
  const record = stats({
    'a-rows': [touch(DRAW, NOW - MINUTE)],
    'a-glyphs': [touch(DRAW, NOW - 2 * MINUTE)],
    'a-old': [touch(CORE, NOW - BINARY.windowMs)],
    'a-new': [touch(CORE, NOW)],
    // The same file twice in one record is still one agent.
    'a-twice': [touch(`${ROOT}/x.ts`, NOW - 3000), touch(`${ROOT}/x.ts`, NOW - 2000, NOW)],
  })
  expect(binariesOf(record, ['a-rows', 'a-old', 'a-new', 'a-twice'], NOW)).toEqual([])
  expect(binariesOf(record, [], NOW)).toEqual([])
  expect(binariesOf({ 'a-x': { files: null }, 'a-y': null, 'a-z': {} }, ['a-x', 'a-y', 'a-z'], NOW)).toEqual([])
  // Prototype keys name no agent.
  expect(binariesOf(record, ['constructor', 'toString', 'a-missing'], NOW)).toEqual([])
})

test('larger binaries come first, then the one that formed first; another write never reorders them', () => {
  const record = stats({
    a: [touch(CORE, NOW - 30_000), touch(DRAW, NOW - 9 * MINUTE)],
    b: [touch(CORE, NOW - 20_000)],
    c: [touch(DRAW, NOW - MINUTE), touch(CORE, NOW - 10_000)],
    d: [touch(`${ROOT}/STATE.md`, NOW - 5000)],
    e: [touch(`${ROOT}/STATE.md`, NOW - 4000)],
  })
  const before = binariesOf(record, ['a', 'b', 'c', 'd', 'e'], NOW)
  expect(before).toEqual([
    { path: CORE, agents: ['a', 'b', 'c'] },
    { path: DRAW, agents: ['a', 'c'] },
    { path: `${ROOT}/STATE.md`, agents: ['d', 'e'] },
  ])
  const after = binariesOf({ ...record, c: { files: addTouches(record.c?.files, [DRAW], NOW) } }, ['a', 'b', 'c', 'd', 'e'], NOW)
  expect(after).toEqual(before)
  expect(binaryOfAgent(after).get('c')).toEqual(binaryOfAgent(before).get('c'))
})

test('the props carry at most a few binaries, the most recently written', () => {
  const x: Touch[] = []
  const y: Touch[] = []
  for (let i = 0; i < 12; i++) {
    x.push(touch(`${ROOT}/f${i}.ts`, NOW - 60_000 + i * 1000))
    y.push(touch(`${ROOT}/f${i}.ts`, NOW - 50_000 + i * 1000))
  }
  const found = binariesOf(stats({ x, y }), ['x', 'y'], NOW)
  expect(found).toHaveLength(BINARY.maxShown)
  expect(found.map(b => b.path).sort()).toEqual(Array.from({ length: BINARY.maxShown }, (_, k) => `${ROOT}/f${k + 12 - BINARY.maxShown}.ts`).sort())
})

function agent(id: string): SkyAgent {
  return { id, label: id, status: 'running', model: null, effort: null, tokens: null, costUsd: null, tools: null, lastTool: null, startedAt: null, endedAt: null, error: null }
}

function node(key: string, agents: SkyAgent[], children: SkyNode[] = []): SkyNode {
  return { key, kind: 'phase', title: key, detail: '', status: 'running', agents, hidden: 0, children, counts: { done: 0, running: agents.length, failed: 0 }, costUsd: null, startedAt: null, endedAt: null }
}

function run(key: string, nodes: SkyNode[], loose: SkyAgent[] = []): SkyRun {
  return { key, name: key, description: '', status: 'running', startedAt: null, endedAt: null, nodes, loose, looseHidden: 0, counts: { done: 0, running: 0, failed: 0 }, costUsd: null, tools: 0 }
}

test('a run warns of the binaries one of its agents is in, wherever it sits in the tree, with their indexes', () => {
  const draw: Binary = { path: DRAW, agents: ['a-glyphs', 's-tidy'] }
  const core: Binary = { path: CORE, agents: ['a-stats', 'a-cache'] }
  const tidy = run('wf-1', [node('Refactor', [agent('a-motion')], [node('▸ split-stage', [agent('a-glyphs')])])])
  const subs = run('subagents', [], [agent('s-tidy')])
  expect(binariesIn(tidy, [core, draw])).toEqual([pairOf(draw, 1)])
  expect(binariesIn(subs, [core, draw])).toEqual([pairOf(draw, 1)])
  expect(binariesIn(run('wf-2', [node('Scan', [agent('a-scan')])]), [draw, core])).toEqual([])
  expect(binariesIn(tidy, [])).toEqual([])
  const both: Binary = { path: `${ROOT}/STATE.md`, agents: ['a-glyphs', 'a-stats', 'a-notes'] }
  const pairs = binaryOfAgent([both, draw, core])
  expect(pairs.get('a-glyphs')).toEqual(pairOf(both, 0))
  expect(pairs.get('s-tidy')).toEqual(pairOf(draw, 1))
  expect(pairs.get('a-motion')).toBeUndefined()
})

// ---------------------------------------------------------------- drawing

test('the glyph is always two one-wide cells in a hex color, and the same inputs draw the same cells', () => {
  for (let t = 0; t < 6000; t += 33) {
    for (const age of [0, 150, 330, 450, 600, 900, LOCK_MS, 60_000]) {
      for (const index of [0, 3]) {
        const g = binaryCells(t, age, index)
        expect(g).toHaveLength(2)
        expect(g.every(isOneCell)).toBe(true)
        expect(g[0]?.c).toMatch(/^#[0-9a-f]{6}$/)
        expect(binaryCells(t, age, index)).toEqual(g)
      }
    }
  }
})

test('the capture: the moon turns amber, fuses into one body, splits apart, then joins the orbit', () => {
  const at = (age: number) => textOf(binaryCells(1000, age, 0, HEX.live))
  expect([' ◐', ' ◓', ' ◑', ' ◒']).toContain(at(0))
  expect(binaryCells(1000, 0, 0, HEX.live)[1]?.c).toBe(HEX.live)
  expect(at(400)).toBe(' ●')
  expect(at(600)).toBe('•●')
  expect(at(900)).toBe('•●')
  for (const age of [LOCK_MS, 10 * MINUTE]) expect(ORBIT.map(g => g.join(''))).toContain(at(age))
})

test('the orbit passes through four distinct steps, slower than the moon, and stays brighter than the rails', () => {
  expect(new Set(ORBIT.map(g => g.join(''))).size).toBe(ORBIT.length)
  // The eclipse step merges the two stars into one cell.
  expect(ORBIT.map(g => g.filter(ch => ch !== ' ').length)).toEqual([2, 1, 2, 2])
  for (const g of ORBIT) expect(['•', '●']).toContain(g[1])
  // A still pane shows the first step.
  expect(ORBIT[0]).toEqual(['•', '●'])
  expect(STEP_MS).toBeGreaterThanOrEqual(400)
  const seen = new Set<string>()
  for (let t = 0; t < 4 * ORBIT.length * STEP_MS; t += 33) {
    const g = binaryCells(t, LOCK_MS, 1)
    seen.add(textOf(g))
    for (const c of g) if (c.t !== ' ') expect(luma(c.c)).toBeGreaterThan(luma(HEX.rail))
  }
  expect(seen.size).toBe(ORBIT.length)
})

test('partners turn as one, and the first four binaries never show the same step at once', () => {
  for (let t = 0; t < 10_000; t += 33) {
    const steps = [0, 1, 2, 3].map(index => orbitStep(t, index))
    expect(new Set(steps).size).toBe(4)
    expect(binaryCells(t, 60_000, 2)).toEqual(binaryCells(t, 60_000, 2))
  }
})

test('the warning names the file, fits its room, never changes width with time, and leads with the pair in step', () => {
  const p = pairOf({ path: DRAW, agents: ['a-glyphs', 'a-rows'] }, 1)
  const wide = binaryWarning(p, 59, 0, 60_000, ROOT)
  expect(textOf(wide.slice(2))).toBe(' binary · 2 agents editing hooks/draw.tsx')
  expect(textOf(binaryWarning(p, 59, 0, 60_000))).toContain('2 agents editing hooks/draw.tsx')
  expect(runsOf(wide).length).toBeLessThanOrEqual(6)
  for (let room = 0; room <= 70; room++) {
    const widths = new Set<number>()
    for (let t = 0; t < 2000; t += 99) {
      for (const age of [0, 300, 800, 60_000]) {
        const row = binaryWarning(p, room, t, age)
        expect(row.length).toBeLessThanOrEqual(room)
        expect(row.every(isOneCell)).toBe(true)
        widths.add(row.length)
      }
    }
    expect(widths.size).toBe(1)
  }
  for (let t = 0; t < 4000; t += 33) expect(binaryWarning(p, 59, t, 60_000).slice(0, 2)).toEqual(binaryCells(t, 60_000, 1))
  expect(textOf(binaryWarning(p, 59, 0, 0).slice(0, 3))).toBe(' ● ')
  for (let t = 0; t < 2000; t += 99) expect(textOf(binaryWarning(p, 59, t, 60_000)).slice(2, 9)).toBe(' binary')
  expect(textOf(binaryWarning(p, 24, 0, 60_000))).toContain('2 editing draw.tsx')
})

test('paths shorten to fit: under the root, then folder and name, then the name, cut', () => {
  expect(shortPath(DRAW, 40, ROOT)).toBe('hooks/draw.tsx')
  expect(shortPath(`${ROOT}/hooks/events/binary.ts`, 40, ROOT)).toBe('hooks/events/binary.ts')
  expect(shortPath(`${ROOT}/hooks/events/binary.ts`, 40)).toBe('events/binary.ts')
  expect(shortPath(`${ROOT}/hooks/events/binary.ts`, 12)).toBe('binary.ts')
  expect(shortPath(`${ROOT}/hooks/events/a-rather-long-name.ts`, 10)).toBe('a-rather-…')
  expect(shortPath(DRAW, 0)).toBe('')
})

test('a crowded run shows at most a couple of warning rows, the last counting the rest', () => {
  const list: Pair[] = [CORE, DRAW, `${ROOT}/a.ts`, `${ROOT}/b.ts`].map((path, index) => pairOf({ path, agents: ['x', 'y'] }, index))
  const rows = binaryRows(list, 59, 0, () => 60_000)
  expect(rows).toHaveLength(BINARY.rows)
  expect(textOf(rows.at(-1) ?? [])).toBe(`   and ${list.length - BINARY.rows + 1} more files`)
  expect(binaryRows(list.slice(0, 1), 59, 0, () => 60_000)).toHaveLength(1)
  expect(binaryRows([], 59, 0, () => 60_000)).toEqual([])
})
