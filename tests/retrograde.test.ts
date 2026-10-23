import { expect, test } from 'claude-code/testing'

import {
  DIRECT_FACT,
  DIRECT_MS,
  RETRO,
  RETRO_HEX,
  RING,
  STOP_MS,
  callKey,
  newRetroTracker,
  phaseOf,
  retroFact,
  retroGlyph,
  retroIn,
  retroOf,
  seeRetro,
  trackBegin,
  trackEnd,
  trackHeard,
  trackHold,
  trackRelease,
  trackStep,
  watchOf,
} from '../hooks/events/retrograde'
import type { Retro, RetroSeen, RetroTracker } from '../hooks/events/retrograde'
import { HEX } from '../hooks/motion'

const T0 = 1_760_000_000_000
const MIN = 60_000

const bash = (command: string) => callKey('Bash', { command, description: 'run it' })
const read = (path: string) => callKey('Read', { file_path: path })
const grep = (pattern: string) => callKey('Grep', { pattern, path: '/home/someone/project' })
const tool = (name: string) => callKey(name, { anything: name })

/** Steps one call each, a second apart from T0, from a fresh tracker. */
function stepsOf(calls: readonly string[], gapMs = 1000): RetroTracker {
  return calls.reduce<RetroTracker>((tr, key, i) => trackStep(tr, { at: T0 + i * gapMs, calls: [key] }), newRetroTracker())
}

/** WCAG relative luminance of a hex color. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255)
}

/** draw.tsx's moon phases, in the order it turns them. */
const ORBIT = [...'◐◓◑◒']
const BASE = '#d77757'
const loopAt = (stage: Retro['stage'], rounds: number): Retro => ({
  kind: 'loop',
  stage,
  since: T0,
  detail: `same Bash call ×${rounds}`,
  kicks: stage === 'retrograde' ? rounds - RETRO.same.retrograde : 0,
})
const STATIONARY = loopAt('stationary', 3)

/** The glyphs a memory draws from `from` to `to` ms, each change once. */
function course(seen: RetroSeen, retro: Retro | null, from: number, to: number): string[] {
  const out: string[] = []
  for (let t = from; t <= to; t += 10) {
    const g = retroGlyph(t, seen, retro, BASE).t
    if (out.at(-1) !== g) out.push(g)
  }
  return out
}

/** +1 for a step forward through ORBIT, -1 for one back. */
const direction = (a: string, b: string) => {
  const d = (ORBIT.indexOf(b) - ORBIT.indexOf(a) + 4) % 4
  return d === 1 ? 1 : d === 3 ? -1 : 0
}

// ---------------------------------------------------------------- detection

test('a call key is the short tool name and a hash of its input, whatever the key order', () => {
  expect(callKey('Bash', { command: 'ls', description: 'list' })).toBe(callKey('Bash', { description: 'list', command: 'ls' }))
  expect(callKey('Bash', { command: 'ls' })).not.toBe(callKey('Bash', { command: 'ls -la' }))
  expect(callKey('Read', { file_path: '/a' })).not.toBe(callKey('Grep', { file_path: '/a' }))
  expect(callKey('mcp__tracker__get_issue', { id: 'T-1' })).toMatch(/^get_issue#[0-9a-z]+$/)
  // The same short name from two servers still hashes apart.
  expect(callKey('mcp__a__search', { q: 'x' })).not.toBe(callKey('mcp__b__search', { q: 'x' }))
  expect(bash('sleep 30 && gh run view 123 --json status')).toMatch(/^Bash#~[0-9a-z]+$/)
  expect(bash('gh run watch 123')).toMatch(/^Bash#~/)
  expect(bash('npm test')).toMatch(/^Bash#[0-9a-z]+$/)
})

test('the same call over and over: stationary at three, retrograde at four with a kick for each repeat, gone when the agent moves on', () => {
  const now = T0 + 10_000
  expect(retroOf(stepsOf([bash('npm test'), bash('npm test')]), T0 + 1000, now)).toBeNull()
  expect(retroOf(stepsOf(Array.from({ length: 3 }, () => bash('npm test'))), T0 + 2000, now)).toMatchObject({ kind: 'loop', stage: 'stationary', detail: 'same Bash call ×3', kicks: 0 })
  expect(retroOf(stepsOf(Array.from({ length: 4 }, () => bash('npm test'))), T0 + 3000, now)).toMatchObject({ stage: 'retrograde', kicks: 0 })
  const five = stepsOf([read('/home/someone/project/a.ts'), ...Array.from({ length: 5 }, () => bash('npm test'))])
  expect(retroOf(five, T0 + 5000, now)).toMatchObject({ stage: 'retrograde', detail: 'same Bash call ×5', kicks: 1 })
  const moved = trackStep(five, { at: T0 + 6000, calls: [bash('npm run build')] })
  expect(retroOf(moved, T0 + 6000, now)).toBeNull()
})

test('a poll is work, not a loop, until it has gone on for twenty rounds', () => {
  const poll = bash('sleep 30 && gh run view 123 --json status')
  const at = (n: number) => retroOf(stepsOf(Array.from({ length: n }, () => poll), 30_000), T0 + (n - 1) * 30_000, T0 + (n - 1) * 30_000 + 1000)
  expect(at(4)).toBeNull()
  expect(at(9)).toBeNull()
  expect(at(10)).toMatchObject({ kind: 'loop', stage: 'stationary', detail: 'same Bash poll ×10' })
  expect(at(20)).toMatchObject({ stage: 'retrograde', detail: 'same Bash poll ×20', kicks: 0 })
})

test('two or three calls in turn: stationary at two rounds, retrograde at three, named in the order they began', () => {
  const now = T0 + 20_000
  const pair = [read('/home/someone/project/a.ts'), grep('todo')]
  expect(retroOf(stepsOf([...pair, ...pair]), T0, now)?.stage).toBe('stationary')
  expect(retroOf(stepsOf([...pair, ...pair, ...pair]), T0, now)).toMatchObject({ stage: 'retrograde', detail: 'same Read → Grep cycle ×3' })
  // Ending part way into a round keeps the name the run began with.
  expect(retroOf(stepsOf([...pair, ...pair, ...pair, pair[0] as string]), T0, now)?.detail).toBe('same Read → Grep cycle ×3')
  const trio = [read('/home/someone/project/a.ts'), callKey('Edit', { file_path: '/home/someone/project/a.ts', old_string: 'x', new_string: 'y' }), bash('npm test')]
  expect(retroOf(stepsOf([...trio, ...trio, ...trio]), T0, now)?.detail).toBe('same Read → Edit → Bash cycle ×3')
  // Work that changes as it goes is no loop: an edit that differs each time breaks the cycle.
  const edits = [0, 1, 2, 3].flatMap(i => [read('/home/someone/project/a.ts'), callKey('Edit', { file_path: '/home/someone/project/a.ts', old_string: `v${i}`, new_string: `v${i + 1}` })])
  expect(retroOf(stepsOf(edits), T0, now)).toBeNull()
})

test('the tracker stays small however long a loop runs, and keeps counting past its ring', () => {
  let tr = newRetroTracker()
  for (let i = 0; i < 2000; i++) tr = trackStep(tr, { at: T0 + i, calls: [bash('npm test -- --bail')] })
  expect(tr.calls.length).toBe(RING)
  expect(retroOf(tr, T0 + 2000, T0 + 2000)).toMatchObject({ detail: 'same Bash call ×2000', kicks: 1996 })
  expect(JSON.stringify(tr).length).toBeLessThan(400)
  // A step of several calls counts each, in order; the tools it waits on are named once each.
  const parallel = trackStep(newRetroTracker(), { at: T0, calls: [read('/a'), read('/a'), read('/a'), read('/a')] })
  expect(retroOf(parallel, T0, T0)?.stage).toBe('retrograde')
  expect(parallel.pending).toEqual(['Read'])
})

test('a request with no answer: stationary from three minutes, past the line at five, and never turning back', () => {
  const tr = trackBegin(trackStep(null, { at: T0, calls: [bash('ls')] }), T0 + 2000)
  const sent = T0 + 2000
  expect(retroOf(tr, T0, sent + RETRO.model.stationary - 1)).toBeNull()
  expect(retroOf(tr, T0, sent + 3 * MIN + 10_000)).toMatchObject({ kind: 'stuck', stage: 'stationary', detail: 'no answer for 3:10' })
  const past = retroOf(tr, T0, sent + 6 * MIN + 12_000) as Retro
  expect(past).toMatchObject({ kind: 'stuck', stage: 'retrograde', since: sent, detail: 'no answer for 6:12', kicks: 0 })
  // A silence stands still: the Client keeps it stationary, white.
  expect(seeRetro(null, past, 0)?.stage).toBe('stationary')
  expect(retroFact(past).t).toBe('stationary · no answer for 6:12')
  // A response streaming in keeps it heard; the answer arriving ends it.
  expect(retroOf(trackHeard(tr, sent + 4 * MIN), T0, sent + 6 * MIN)).toBeNull()
  expect(retroOf(trackStep(tr, { at: sent + 6 * MIN, calls: [bash('ls -la')] }), sent + 6 * MIN, sent + 6 * MIN + 1000)).toBeNull()
})

test('a tool still running gets longer: stationary from five minutes, past the line beyond Bash’s ten-minute ceiling', () => {
  const tr = trackStep(null, { at: T0, calls: [bash('npm run e2e')] })
  expect(retroOf(tr, T0, T0 + 4 * MIN)).toBeNull()
  expect(retroOf(tr, T0, T0 + 6 * MIN)).toMatchObject({ kind: 'stuck', stage: 'stationary', detail: 'Bash running for 6:00' })
  expect(retroOf(tr, T0, T0 + RETRO.tool.retrograde)).toMatchObject({ stage: 'retrograde' })
  const two = trackStep(null, { at: T0, calls: [read('/a'), grep('x'), read('/b')] })
  expect(retroOf(two, T0, T0 + 6 * MIN)?.detail).toBe('Read + Grep running for 6:00')
})

test('what waits by design is never stuck: a nested agent, a skill, the person, wherever it sits in the step', () => {
  const late = T0 + 60 * MIN
  for (const name of ['Agent', 'Skill', 'AskUserQuestion', 'ExitPlanMode']) expect(retroOf(trackStep(null, { at: T0, calls: [tool(name)] }), T0, late)).toBeNull()
  const busy = trackStep(null, { at: T0, calls: [read('/a'), read('/b'), read('/c'), tool('TodoWrite'), tool('Agent')] })
  expect(watchOf(busy, T0).wait).toBe('none')
  expect(retroOf(busy, T0, late)).toBeNull()
})

test('a turn that ended waits on nothing until a request goes out again', () => {
  const answered = trackStep(trackBegin(null, T0), { at: T0 + 2000, calls: [] })
  expect(retroOf(answered, T0 + 2000, T0 + 6 * MIN)).toBeNull()
  expect(watchOf(answered, T0 + 2000).wait).toBe('none')
  // turn.complete ends it too, and drops whatever loop it was in.
  const looping = stepsOf(Array.from({ length: 5 }, () => bash('git status')))
  expect(retroOf(looping, T0 + 4000, T0 + 5000)?.stage).toBe('retrograde')
  const ended = trackEnd(looping, T0 + 4500)
  expect(retroOf(ended, T0 + 4500, T0 + 20 * MIN)).toBeNull()
  expect(JSON.stringify(ended).length).toBeLessThan(200)
  // Woken by a message, it asks again: the silence counts from that request.
  const woken = trackBegin(ended, T0 + 10 * MIN)
  expect(retroOf(woken, T0 + 4500, T0 + 14 * MIN)?.stage).toBe('stationary')
  expect(retroOf(woken, T0 + 4500, T0 + 15 * MIN)?.stage).toBe('retrograde')
  // A begin from before the end (applied late in one flush) does not wake it.
  expect(watchOf(trackBegin(ended, T0 + 1000), T0 + 4500).wait).toBe('none')
})

test('a loop held by a person is not stuck, and its silence starts over when they answer', () => {
  const asked = trackStep(trackBegin(null, T0), { at: T0 + 1000, calls: [callKey('Edit', { file_path: '/home/someone/project/a.ts' })] })
  const held = trackHold(asked, T0 + 2000)
  expect(retroOf(held, T0 + 1000, T0 + 15 * MIN)).toBeNull()
  const released = trackRelease(held, T0 + 15 * MIN)
  expect(retroOf(released, T0 + 1000, T0 + 15 * MIN + 1000)).toBeNull()
  expect(retroOf(released, T0 + 1000, T0 + 21 * MIN)).toMatchObject({ stage: 'stationary', detail: 'Edit running for 6:00' })
  // A request after the hold ends it without a release; a hold older than the last answer is no hold.
  expect(watchOf(trackBegin(held, T0 + 3000), T0 + 1000).wait).toBe('model')
  expect(watchOf(trackHold(asked, T0 + 500), T0 + 1000).wait).toBe('tool')
})

test('begins and answers may be applied in any order within a flush', () => {
  const tr = trackBegin(trackStep(null, { at: T0 + 5000, calls: [bash('make')] }), T0)
  expect(watchOf(tr, T0 + 5000)).toMatchObject({ wait: 'tool', tool: 'Bash', quiet: T0 + 5000 })
  expect(watchOf(trackBegin(tr, T0 + 9000), T0 + 5000)).toMatchObject({ wait: 'model', tool: null, quiet: T0 + 9000 })
  expect(watchOf(null, T0)).toEqual({ wait: 'model', tool: null, quiet: T0, loop: null })
})

test('a silence past its line outranks a loop past its; a stationary silence never hides a retrograde loop', () => {
  const looping = stepsOf(Array.from({ length: 4 }, () => bash('git status')))
  const lastAt = T0 + 3000
  expect(retroOf(looping, lastAt, lastAt + MIN)?.kind).toBe('loop')
  expect(retroOf(looping, lastAt, lastAt + 6 * MIN)?.kind).toBe('loop')
  expect(retroOf(looping, lastAt, lastAt + 12 * MIN)?.kind).toBe('stuck')
  expect(retroIn(null, T0)).toBeNull()
  expect(retroIn(undefined, T0)).toBeNull()
})

// ---------------------------------------------------------------- the moon

test('stationary: the moon slows to a stop where it was and holds that phase, in its own colour', () => {
  const t0 = 12_345
  const seen = seeRetro(null, STATIONARY, t0) as RetroSeen
  expect(seen).toMatchObject({ stage: 'stationary', at: t0 })
  // It starts where the forward moon is, so nothing jumps.
  expect(retroGlyph(t0, seen, STATIONARY, BASE).t).toBe(ORBIT[Math.floor(t0 / 150) % 4])
  // Still turning forward while it slows, then still.
  const slowing = course(seen, STATIONARY, t0, t0 + STOP_MS)
  expect(slowing.slice(1).every((g, i) => direction(slowing[i] ?? '', g) === 1)).toBe(true)
  const held = retroGlyph(t0 + STOP_MS, seen, STATIONARY, BASE)
  for (let t = t0 + STOP_MS; t < t0 + 20_000; t += 37) expect(retroGlyph(t, seen, STATIONARY, BASE)).toEqual(held)
  expect(held.c).toBe(BASE)
  expect(seeRetro(seen, STATIONARY, t0 + 5000)).toBe(seen)
})

test('retrograde: the moon turns backwards through the phases, slower than forward, and steady', () => {
  const stopped = seeRetro(null, STATIONARY, 0) as RetroSeen
  const t1 = 5000
  const back = seeRetro(stopped, loopAt('retrograde', 4), t1) as RetroSeen
  expect(back).toMatchObject({ stage: 'retrograde', at: t1, kicks0: 0, kicks: 0 })
  // It begins from where it stood.
  expect(phaseOf(back, t1)).toBe(phaseOf(stopped, t1))
  const glyphs = course(back, loopAt('retrograde', 4), t1, t1 + 6000)
  expect(glyphs.length).toBeGreaterThan(15)
  expect(glyphs.slice(1).every((g, i) => direction(glyphs[i] ?? '', g) === -1)).toBe(true)
  // A step every 260 ms once going: four phases in about a second.
  expect(Math.round((phaseOf(back, t1 + 3000) - phaseOf(back, t1 + 4040)) * 1000)).toBe(4000)
})

test('retrograde is white: past the line the moon turns from its colour to a white unlike any other glyph', () => {
  const back = seeRetro(null, loopAt('retrograde', 4), 0) as RetroSeen
  expect(retroGlyph(0, back, loopAt('retrograde', 4), BASE).c).toBe(BASE)
  expect(retroGlyph(2000, back, loopAt('retrograde', 4), BASE).c).toBe(RETRO_HEX.white)
  expect(retroGlyph(2000, back, loopAt('retrograde', 4), '#2e9fe8').c).toBe(RETRO_HEX.white)
  // Stationary keeps its colour; a silence past its line stands white.
  const stopped = seeRetro(null, STATIONARY, 0) as RetroSeen
  expect(retroGlyph(2000, stopped, STATIONARY, BASE).c).toBe(BASE)
  const silent: Retro = { kind: 'stuck', stage: 'retrograde', since: T0, detail: 'no answer for 6:12', kicks: 0 }
  expect(retroGlyph(2000, seeRetro(null, silent, 0), silent, BASE).c).toBe(RETRO_HEX.white)
  // Where nothing animates there is no memory: still white past the line.
  expect(retroGlyph(0, null, loopAt('retrograde', 5), BASE).c).toBe(RETRO_HEX.white)
  // Apart from the running moons' orange, the done ●'s green, the finish flash and the comet's head.
  for (const other of [HEX.live, HEX.glow, HEX.ok, HEX.flash, HEX.shine]) expect(RETRO_HEX.white).not.toBe(other)
  expect(luminance(RETRO_HEX.white)).toBeGreaterThan(luminance(HEX.glow))
  expect(luminance(RETRO_HEX.white)).toBeGreaterThan(luminance(HEX.shine))
})

test('each further identical call kicks the moon one phase back, on top of its turn', () => {
  const four = loopAt('retrograde', 4)
  const back = seeRetro(null, four, 0) as RetroSeen
  const t = 3333
  const before = phaseOf(back, t)
  const five = seeRetro(back, loopAt('retrograde', 5), t) as RetroSeen
  expect(five).not.toBe(back)
  expect(five).toMatchObject({ at: back.at, kicks: 1 })
  expect(phaseOf(five, t)).toBe(before - 1)
  expect(phaseOf(seeRetro(five, loopAt('retrograde', 7), t) as RetroSeen, t)).toBe(before - 3)
  // Same count, same memory.
  expect(seeRetro(five, loopAt('retrograde', 5), t + 100)).toBe(five)
})

test('direct: a different call slows the backward turn, stands, turns forward again, fades the white, then forgets', () => {
  const back = seeRetro(seeRetro(null, STATIONARY, 0), loopAt('retrograde', 5), 2000) as RetroSeen
  const t2 = 9000
  const direct = seeRetro(back, null, t2) as RetroSeen
  expect(direct).toMatchObject({ stage: 'direct', at: t2, back: true, formed: true, white: 1 })
  expect(phaseOf(direct, t2)).toBe(phaseOf(back, t2))
  const glyphs = course(direct, null, t2, t2 + DIRECT_MS - 10)
  const turns = glyphs.slice(1).map((g, i) => direction(glyphs[i] ?? '', g))
  // Backward first, then forward: it goes direct.
  expect(turns.at(-1)).toBe(1)
  expect(turns.indexOf(1)).toBeGreaterThan(turns.lastIndexOf(-1))
  expect(retroGlyph(t2, direct, null, BASE).c).toBe(RETRO_HEX.white)
  expect(retroGlyph(t2 + DIRECT_MS - 10, direct, null, BASE).c).toBe(BASE)
  // Kept while it eases, then forgotten: the plain moon again.
  expect(seeRetro(direct, null, t2 + DIRECT_MS - 1)).toBe(direct)
  expect(seeRetro(direct, null, t2 + DIRECT_MS)).toBeNull()
  // From stationary there is no backward turn to undo, and nothing to forget before it began.
  expect(seeRetro(seeRetro(null, STATIONARY, 0), null, 3000)).toMatchObject({ stage: 'direct', back: false, formed: false, white: 0 })
  expect(seeRetro(null, null, 0)).toBeNull()
})

test('the words: stationary pale, retrograde in amber at every level, direct for a moment; all as bright as the rails', () => {
  expect(retroFact(STATIONARY)).toEqual({ t: 'stationary · same Bash call ×3', c: RETRO_HEX.pale })
  expect(retroFact(loopAt('retrograde', 5))).toEqual({ t: 'retrograde · same Bash call ×5', c: RETRO_HEX.words })
  expect(DIRECT_FACT.t).toBe('direct')
  for (const c of [RETRO_HEX.pale, RETRO_HEX.words, RETRO_HEX.direct]) expect(luminance(c)).toBeGreaterThanOrEqual(luminance(HEX.rail))
})

test('the moon is one narrow cell, the same for the same inputs, in hex', () => {
  const memories = [seeRetro(null, STATIONARY, 0), seeRetro(null, loopAt('retrograde', 6), 0), seeRetro(seeRetro(null, loopAt('retrograde', 4), 0), null, 1000), null]
  for (let t = 0; t < 8000; t += 37) {
    for (const seen of memories) {
      const cell = retroGlyph(t, seen, loopAt('retrograde', 6), '#7f9fd7')
      expect(ORBIT).toContain(cell.t)
      expect(cell.c).toMatch(/^#[0-9a-f]{6}$/)
      expect(retroGlyph(t, seen, loopAt('retrograde', 6), '#7f9fd7')).toEqual(cell)
    }
  }
  expect(JSON.parse(JSON.stringify(memories[1]))).toEqual(memories[1])
})
