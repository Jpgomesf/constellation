import type { On, TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { AgentStats, Run } from '../types'
import {
  applySteps,
  costOf,
  decidedBy,
  keepChecks,
  leanNode,
  leanRuns,
  loopKey,
  modelKey,
  parseFinal,
  parseJournal,
  parseLaunch,
  parseMeta,
  pruneStats,
  shortModel,
  skyRun,
  summarizeInput,
  traceOf,
  transcriptStats,
} from '../hooks/core'
import type { SkyAgent, SkyNode, SkyProps, SkyRun, Step } from '../hooks/core'
import { DEMO_MS, demoAt } from '../hooks/demo'
import { applyTouches, binariesOf } from '../hooks/events/binary'
import { RETRO_HEX, callKey, retroIn, trackBegin, trackStep, watchOf } from '../hooks/events/retrograde'
import { demoFailures } from '../hooks/events/meteor'
import { moonColor } from '../hooks/events/shift'
import { HEX, comet, mix, progress, twinkle } from '../hooks/motion'
import { SKY_STYLES, skyBand } from '../hooks/skies'
import { STAR_H, STAR_W, starCells, starStage } from '../hooks/star'

const SCRIPT = `export const meta = {
  name: 'nightly-audit',
  description: 'Audit the overnight logs: gather them, check each service, report',
  phases: [
    { title: 'Gather', detail: 'fetch every log' },
    { title: 'Inspect', detail: 'a check per service, a retry when one flakes' },
    { title: 'Report', detail: "errors first, then what's slow" },
  ],
}
const x = { name: 'not meta' }
`

const LAUNCH = `Workflow launched in background. Task ID: wabc123
Summary: Audit the overnight logs: gather them, check each
Transcript dir: /home/someone/.claude/projects/-home-someone-shop/0000-session/subagents/workflows/wf_1234abcd-5ef
Script file: /home/someone/plugins/audits/workflows/nightly-audit.js
Run ID: wf_1234abcd-5ef`

const line = (o: object) => JSON.stringify(o)

const near = (got: number | null | undefined, want: number) => expect(Math.abs((got ?? NaN) - want) < 1e-9).toBe(true)

const JOURNAL = [
  line({ type: 'launched' }),
  line({ type: 'started', key: 'k1', agentId: 'a1', label: 'collect logs', phase: 'Gather' }),
  line({ type: 'result', key: 'k1', agentId: 'a1', result: {} }),
  line({ type: 'started', key: 'k2', agentId: 'a2', label: 'scan api', phase: '▸ check' }),
  line({ type: 'started', key: 'k3', agentId: 'a3', label: 'scan web', phase: '▸ check #2' }),
  line({ type: 'result', key: 'k2', agentId: 'a2', result: {} }),
  line({ type: 'started', key: 'k4', agentId: 'a4', label: 'rescan api logs', phase: '▸ retry' }),
  '{not json',
].join('\n')

/** A journal of 300 agents started at once, half under Inspect and half under no phase. */
const FAN_OUT = Array.from({ length: 300 }, (_, i) =>
  line({ type: 'started', agentId: `z${i}`, label: `research angle number ${i} of the big fan-out`, phase: i % 2 ? 'Inspect' : '' }),
).join('\n')

/** The tool call a stuck agent keeps making. */
const NPM_TEST = { name: 'Bash', input: { command: 'npm test' } }

const usage = (input: number, output: number, read = 0, write = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

function liveRun(): Run {
  const meta = parseMeta(SCRIPT)
  return {
    id: 'wf_1234abcd-5ef',
    name: meta.name ?? 'wf_1234abcd-5ef',
    description: meta.description,
    phases: meta.phases,
    status: 'running',
    startedAt: 1_000,
    durationMs: null,
    agents: parseJournal(JOURNAL, [], 2_000),
    childParents: {},
    scriptPath: null,
    hasMeta: true,
    hasFolder: true,
    isFinal: false,
    journalBytes: JOURNAL.length,
    journalAt: null,
  }
}

test('reads a workflow script meta, its phases and their details', () => {
  const meta = parseMeta(SCRIPT)
  expect(meta.name).toBe('nightly-audit')
  expect(meta.description).toBe('Audit the overnight logs: gather them, check each service, report')
  expect(meta.phases.map(p => p.title)).toEqual(['Gather', 'Inspect', 'Report'])
  expect(meta.phases[2]?.detail).toBe("errors first, then what's slow")
})

test('reads the Workflow tool result for the run id, script and transcripts', () => {
  const launch = parseLaunch(LAUNCH)
  expect(launch?.runId).toBe('wf_1234abcd-5ef')
  expect(launch?.scriptPath).toBe('/home/someone/plugins/audits/workflows/nightly-audit.js')
  expect(launch?.transcriptDir).toBe('/home/someone/.claude/projects/-home-someone-shop/0000-session/subagents/workflows/wf_1234abcd-5ef')
  expect(parseLaunch('no run here')).toBe(null)
})

test('reads a journal into agents in start order, a result marking one done', () => {
  const agents = parseJournal(JOURNAL, [], 2_000)
  expect(agents.map(a => [a.id, a.status, a.phase])).toEqual([
    ['a1', 'done', 'Gather'],
    ['a2', 'done', '▸ check'],
    ['a3', 'running', '▸ check #2'],
    ['a4', 'running', '▸ retry'],
  ])
  const again = parseJournal(JOURNAL, agents, 9_000)
  expect(again[0]?.seenAt).toBe(2_000)
})

test('nests child workflows under the parent phase that names them', () => {
  const sky = skyRun(liveRun(), {}, 60)
  expect(sky.nodes.map(n => n.title)).toEqual(['Gather', 'Inspect', 'Report'])
  const inspect = sky.nodes[1]
  expect(inspect?.children.map(c => c.title)).toEqual(['check', 'check #2', 'retry'])
  expect(inspect?.status).toBe('running')
  expect(inspect?.counts).toEqual({ done: 1, running: 2, failed: 0 })
  expect(sky.nodes[0]?.status).toBe('done')
  expect(sky.nodes[2]?.status).toBe('pending')
  expect(sky.counts).toEqual({ done: 2, running: 2, failed: 0 })
})

test('a child no phase names goes under the phase after the one that finished', () => {
  const run = { ...liveRun(), phases: [{ title: 'Read', detail: '' }, { title: 'Fan out', detail: '' }] }
  run.agents = run.agents.map(a => (a.phase === 'Gather' ? { ...a, phase: 'Read' } : a))
  const sky = skyRun(run, {}, 60)
  expect(sky.nodes[1]?.title).toBe('Fan out')
  expect(sky.nodes[1]?.children.length).toBe(3)
})

test('a child keeps the parent phase it started under, whatever finishes later', () => {
  const journal = [
    line({ type: 'started', agentId: 'p1', label: 'plan', phase: 'Plan' }),
    line({ type: 'started', agentId: 'c1', label: 'build', phase: '▸ worker' }),
    line({ type: 'result', agentId: 'p1' }),
    line({ type: 'started', agentId: 'c2', label: 'build 2', phase: '▸ worker #2' }),
  ].join('\n')
  const run = { ...liveRun(), phases: [{ title: 'Plan', detail: '' }, { title: 'Work', detail: '' }], agents: parseJournal(journal, [], 1) }
  const sky = skyRun(run, {}, 60)
  expect(sky.nodes[0]?.children.map(c => c.title)).toEqual(['worker'])
  expect(sky.nodes[1]?.children.map(c => c.title)).toEqual(['worker #2'])
})

test('stats outlive their agents only while something claims them', () => {
  const s = applySteps({}, [
    { id: 'kept', sentAt: 1, at: 2, model: 'claude-opus-5-5', effort: null, usage: null, tools: [], calls: [] },
    { id: 'fork', sentAt: 1, at: 2, model: 'claude-opus-5-5', effort: null, usage: null, tools: [], calls: [] },
  ], [])
  expect(Object.keys(pruneStats(s, new Set(['kept']), 60_000, 10))).toEqual(['kept', 'fork'])
  expect(Object.keys(pruneStats(s, new Set(['kept']), 600_000, 10))).toEqual(['kept'])
})

test('keeps running agents and only the newest finished ones', () => {
  const run = liveRun()
  const many = Array.from({ length: 10 }, (_, i) => ({ ...run.agents[0]!, id: `d${i}`, seq: 10 + i, status: 'done' as const }))
  const sky = skyRun({ ...run, agents: [...run.agents, ...many] }, {}, 4)
  const gather = sky.nodes[0]
  expect(gather?.agents.length).toBe(4)
  expect(gather?.hidden).toBe(7)
  expect(gather?.counts.done).toBe(11)
})

test('prices usage per model, cache reads and writes included', () => {
  expect(modelKey('claude-opus-5-5[1m]')).toBe('opus-5-5')
  expect(modelKey('anthropic.claude-opus-4-5@20251101')).toBe('opus-4-5')
  near(costOf(usage(1_000_000, 0), 'claude-opus-5-5'), 4)
  near(costOf(usage(0, 1_000_000), 'claude-fable-5-1'), 50)
  near(costOf(usage(0, 0, 1_000_000), 'claude-fable-5-1'), 0.25)
  near(costOf(usage(0, 0, 1_000_000), 'claude-fable-5'), 1)
  near(costOf(usage(0, 0, 0, 1_000_000), 'claude-sonnet-5-5'), 2.5)
  expect(costOf(usage(1, 1), 'some-other-model')).toBe(null)
  expect(shortModel('claude-fable-5-1')).toBe('fable 5.1')
  expect(shortModel('claude-opus-4-8')).toBe('opus 4.8')
  expect(shortModel('claude-sonnet-5')).toBe('sonnet 5')
})

test('agent stats add up cost and tools, keep the last context, and end on turn.complete', () => {
  const one = applySteps(
    {},
    [
      { id: 'a3', sentAt: 5, at: 10, model: 'claude-opus-5-5', effort: 'xhigh', usage: usage(0, 1_000, 0, 10_000), tools: ['Read'], calls: [] },
      { id: 'a3', sentAt: 12, at: 20, model: 'claude-opus-5-5', effort: 'xhigh', usage: usage(0, 2_000, 10_000, 500), tools: ['Edit', 'Bash'], calls: [] },
    ],
    [],
  )
  expect(one.a3?.tools).toBe(3)
  expect(one.a3?.lastTool).toBe('Bash')
  expect(one.a3?.tokens).toBe(10_500)
  expect(one.a3?.effort).toBe('xhigh')
  near(one.a3?.costUsd, (10_000 * 4 * 1.25 + 1_000 * 20 + 10_000 * 0.2 + 500 * 4 * 1.25 + 2_000 * 20) / 1e6)
  expect(one.a3?.firstAt).toBe(5)
  const ended = applySteps(one, [], [{ id: 'a3', at: 30, reason: 'answer' }])
  expect(ended.a3?.endedAt).toBe(30)
  const woken = applySteps(ended, [{ id: 'a3', sentAt: 35, at: 40, model: 'claude-opus-5-5', effort: null, usage: null, tools: [], calls: [] }], [])
  expect(woken.a3?.endedAt).toBe(null)
  const sky = skyRun(liveRun(), ended, 60)
  const a3 = sky.nodes[1]?.children[1]?.agents[0]
  expect(a3?.model).toBe('opus 5.5')
  expect(a3?.status).toBe('running')
})

/** `n` model requests of agent `id`, each prompt `read` parts in a thousand served from the cache. */
const cachedSteps = (id: string, n: number, read: number): Step[] =>
  Array.from({ length: n }, (_, i) => ({ id, sentAt: i * 10, at: i * 10 + 5, model: 'claude-opus-5-5', effort: null, usage: usage((1_000 - read) * 100, 50, read * 100), tools: ['Read'], calls: [] }))

test('each step folds its usage into the cache mix, an end keeps it, and a transcript gives one too', () => {
  const steps = cachedSteps('a3', 8, 999)
  const s = applySteps({}, steps, [])
  expect(s.a3?.cache?.steps).toBe(8)
  expect(s.a3?.cache?.level).toBe(-1)
  const ended = applySteps(s, [], [{ id: 'a3', at: 200, reason: 'answer' }])
  expect(ended.a3?.cache).toEqual(s.a3?.cache)
  const quiet = applySteps(s, [{ ...(steps[0] as Step), sentAt: 300, at: 310, usage: null }], [])
  expect(quiet.a3?.cache).toEqual(s.a3?.cache)
  const row = (id: string, u: object) =>
    line({ type: 'assistant', timestamp: '2026-10-01T10:00:00.000Z', message: { id, model: 'claude-opus-5-5', usage: u } })
  const past = transcriptStats([row('m1', usage(100, 10, 0, 50_000)), row('m1', usage(100, 10, 0, 50_000)), row('m2', usage(100, 10, 50_000))].join('\n'))
  expect(past?.cache?.steps).toBe(2)
  expect(past?.cache?.read).toBe(50_000)
})

test("a loop's tracker: the same call four times goes retrograde, an end is remembered, and only loops already measured are stamped", () => {
  const bash = callKey(NPM_TEST.name, NPM_TEST.input)
  const step = (at: number): Step => ({ id: 'a3', sentAt: at - 5, at, model: 'claude-opus-5-5', effort: null, usage: null, tools: ['Bash'], calls: [bash] })
  const a3 = (s: Record<string, AgentStats>) => skyRun(liveRun(), s, 60).nodes[1]?.children[1]?.agents[0]
  const looped = applySteps({}, [step(10), step(20), step(30), step(40)], [])
  expect(retroIn(a3(looped)?.watch, 41)).toMatchObject({ stage: 'retrograde', detail: 'same Bash call ×4' })
  const ended = applySteps(looped, [], [{ id: 'a3', at: 50, reason: 'answer' }])
  expect(ended.a3?.tracker?.endedAt).toBe(50)
  expect(retroIn(a3(ended)?.watch, 60 * 60_000)).toBe(null)
  const begun = applySteps(ended, [], [], [{ id: 'a3', at: 60 }, { id: 'a9', at: 60 }])
  expect([begun.a3?.tracker?.sentAt, begun.a3?.tracker?.endedAt]).toEqual([60, null])
  expect(begun.a9).toBeUndefined()
  // A release counts as heard.
  const held = applySteps(begun, [], [], [], [{ id: 'a3', at: 70 }], [{ id: 'a3', at: 80, isOn: true }])
  expect([held.a3?.tracker?.heardAt, held.a3?.tracker?.heldAt]).toEqual([70, 80])
  const released = applySteps(held, [], [], [], [], [{ id: 'a3', at: 90, isOn: false }])
  expect([released.a3?.tracker?.heardAt, released.a3?.tracker?.heldAt]).toEqual([90, null])
})

/** The file two fictional agents both write. */
const SHARED = '/home/someone/shop/hooks/draw.tsx'

test("a loop's files outlive its steps and its end; only running loops that wrote one file pair", () => {
  const step = (id: string, at: number): Step => ({ id, sentAt: at - 5, at, model: 'claude-opus-5-5', effort: null, usage: null, tools: ['Edit'], calls: [] })
  const measured = applySteps({}, [step('a3', 10), step('a4', 10)], [])
  const wrote = applyTouches(measured, [{ id: 'a3', path: SHARED, at: 20 }, { id: 'a4', path: SHARED, at: 30 }, { id: 'a9', path: SHARED, at: 30 }], 30)
  expect(wrote.a3?.files).toEqual([{ path: SHARED, first: 20, at: 20 }])
  // a9 has no stats, so its write lands nowhere.
  expect(wrote.a9).toBeUndefined()
  const stepped = applySteps(wrote, [step('a3', 40)], [])
  expect(stepped.a3?.files).toEqual(wrote.a3?.files)
  expect(binariesOf(stepped, ['a3', 'a4'], 40)).toEqual([{ path: SHARED, agents: ['a3', 'a4'] }])
  const ended = applySteps(stepped, [], [{ id: 'a4', at: 50, reason: 'answer' }])
  expect(ended.a4?.files).toEqual(wrote.a4?.files)
  expect(applyTouches(ended, [], 60).a4?.files).toBeUndefined()
  expect(binariesOf(stepped, ['a3'], 40)).toEqual([])
})

/** Every agent of a drawn node or run, in the order the tree draws them. */
const nodeAgents = (n: SkyNode): SkyAgent[] => [...n.agents, ...n.children.flatMap(nodeAgents)]
const runAgents = (r: SkyRun): SkyAgent[] => [...r.nodes.flatMap(nodeAgents), ...r.loose]
const withCache = (agents: readonly SkyAgent[]) => agents.filter(a => 'cache' in a).map(a => a.id)

test("the tree's props carry a running agent's cache only while it tints the moon, and only on the first running agents", () => {
  const blue = (id: string) => applySteps({}, cachedSteps(id, 8, 999), [])[id]
  const rest = (id: string) => applySteps({}, cachedSteps(id, 8, 970), [])[id]
  const run = liveRun()
  // a1 finished blue, a3 running blue, a4 running at rest, a2 with no stats at all.
  const runs = [skyRun(run, { a1: blue('a1')!, a3: blue('a3')!, a4: rest('a4')! }, 60)]
  expect(runAgents(runs[0] as SkyRun).find(a => a.id === 'a1')?.cache?.steps).toBe(8)
  expect(withCache(runAgents(leanRuns(runs)[0] as SkyRun))).toEqual(['a3'])
  // Past `keep` running agents in drawing order, none carries it.
  const both = [skyRun(run, { a3: blue('a3')!, a4: blue('a4')! }, 60)]
  expect(withCache(runAgents(leanRuns(both)[0] as SkyRun))).toEqual(['a3', 'a4'])
  expect(withCache(runAgents(leanRuns(both, 1)[0] as SkyRun))).toEqual(['a3'])
  const inspect = both[0]?.nodes[1] as SkyNode
  expect(withCache(nodeAgents(leanNode(inspect)))).toEqual(['a3', 'a4'])
  expect(withCache(nodeAgents(leanNode(inspect, 1)))).toEqual(['a3'])
})

test("a big running fan-out's watches and tints pass a Client's limit, unless only its first 40 running agents keep them", () => {
  const run = { ...liveRun(), agents: parseJournal(FAN_OUT, [], 2_000) }
  const tracker = trackStep(trackBegin(null, 1_000), { at: 2_000, calls: [callKey(NPM_TEST.name, NPM_TEST.input)] })
  const tinted = (id: string) => applySteps({}, cachedSteps(id, 8, 999), [])[id] as AgentStats
  const sky = [skyRun(run, Object.fromEntries(run.agents.map(a => [a.id, { ...tinted(a.id), tracker }])), 60)]
  expect(JSON.stringify(leanRuns(sky)).length).toBeGreaterThan(100_000)
  expect(JSON.stringify(leanRuns(sky, 40)).length).toBeLessThan(90_000)
})

test("an agent polling a background task with the same call waits, it does not loop: retrograde only at a poll's twentieth round", () => {
  /** Where an agent stands a second after making `key` its `n`th time, 30 s apart. */
  const retroAfter = (key: string, n: number) => {
    let tracker = trackBegin(null, 0)
    for (let k = 0; k < n; k++) tracker = trackStep(tracker, { at: 1_000 + k * 30_000, calls: [key] })
    const last = 1_000 + (n - 1) * 30_000
    return retroIn(watchOf(tracker, last), last + 1_000)
  }
  for (const [name, input] of [['GetTask', { taskId: 'task-1' }], ['TaskList', {}], ['Monitor', { taskId: 'task-1' }]] as const) {
    const key = loopKey(name, input)
    expect(key.startsWith(`${name}#~`)).toBe(true)
    expect(retroAfter(key, 4)).toBeNull()
    expect(retroAfter(key, 20)?.stage).toBe('retrograde')
    expect(retroAfter(key, 20)?.detail).toContain(name)
  }
  // Other tools keep their call key; a Bash wait is already marked as one.
  const read = loopKey('Read', { file_path: '/shop/a.ts' })
  expect(read).toBe(callKey('Read', { file_path: '/shop/a.ts' }))
  expect(retroAfter(read, 4)?.stage).toBe('retrograde')
  expect(loopKey('Bash', { command: 'sleep 30' })).toBe(callKey('Bash', { command: 'sleep 30' }))
})

test('a transcript is priced once per message id', () => {
  const row = (id: string, u: object) =>
    line({ type: 'assistant', timestamp: '2026-10-01T10:00:00.000Z', message: { id, model: 'claude-haiku-5-5', usage: u } })
  const text = [row('m1', usage(100, 10)), row('m1', usage(100, 10)), row('m2', usage(0, 1_000_000))].join('\n')
  const s = transcriptStats(text)
  near(s?.costUsd, (100 * 0.1 + 10 * 0.5 + 1_000_000 * 0.5) / 1e6)
  expect(s?.model).toBe('claude-haiku-5-5')
})

test('reads a final record, its agents and their phases', () => {
  const run = parseFinal({
    runId: 'wf_1234abcd-5ef',
    workflowName: 'nightly-audit',
    status: 'completed',
    startTime: 1_000,
    durationMs: 60_000,
    summary: 'done',
    phases: [{ title: 'Gather', detail: 'fetch' }],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Gather' },
      { type: 'workflow_agent', index: 1, label: 'collect logs', phaseTitle: 'Gather', agentId: 'a1', state: 'done', tokens: 5_000, toolCalls: 3, model: 'claude-opus-5-5', durationMs: 1_000, startedAt: 1_100 },
      { type: 'workflow_agent', index: 2, label: 'broken', phaseTitle: 'Gather', agentId: 'a2', state: 'failed', error: 'rate limit' },
    ],
  })
  expect(run?.isFinal).toBe(true)
  expect(run?.agents.map(a => [a.label, a.status, a.tokens])).toEqual([
    ['collect logs', 'done', 5_000],
    ['broken', 'failed', null],
  ])
  expect(parseFinal({ nothing: true })).toBe(null)
})

const HOME = '/home/someone'
const DIR = `${HOME}/.claude/projects/-home-someone-shop/sess-1`
const RUN = 'wf_1234abcd-5ef'

const file = (name: string, size: number) => ({ name, kind: 'file' as const, size, mtimeMs: 1_000, isLink: false })

const PANE = {
  plugin: 'constellation',
  component: 'Pane',
  requestId: 'constellation',
  props: {
    title: '✦ constellation',
    isFocused: false,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** `/constellation <args>` as the person types it, for `$.command.run`. */
const typed = (args: string) => ({ command: 'constellation', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 150 } })

test('the pane shows an empty sky, then a run found on disk with its child workflows', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  let hasRun = false
  const disk: Record<string, string> = {
    [`${DIR}/workflows/scripts/nightly-audit-${RUN}.js`]: SCRIPT,
    [`${DIR}/subagents/workflows/${RUN}/journal.jsonl`]: JOURNAL,
  }
  on('session.root', () => ({ value: `${HOME}/shop` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'constellation' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => {
    if (hasRun && e.path === `${DIR}/subagents/workflows`) return { value: [{ ...file(RUN, 0), kind: 'dir' as const }] }
    if (e.path === `${DIR}/workflows/scripts`) return { value: [file(`nightly-audit-${RUN}.js`, SCRIPT.length)] }
    return { value: [] }
  })
  on('fs.stat', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1_000, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })

  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)

  for (const surface of ['terminal', 'vscode'] as const) {
    const scope = surface === 'terminal' ? { in: 'sky' } : {}
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /no workflow runs yet/, ...scope })).toBeDefined()
    await ui.unmount()
  }

  hasRun = true
  await clock.advance(1_000)

  for (const surface of ['terminal', 'vscode'] as const) {
    const scope = surface === 'terminal' ? { in: 'sky' } : {}
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /nightly-audit/, ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /check #2/, ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /scan web/, ...scope })).toBeDefined()
    await ui.unmount()
  }

  // A huge fan-out stays under a Client's 100,000 serialized characters.
  disk[`${DIR}/subagents/workflows/${RUN}/journal.jsonl`] = FAN_OUT
  await clock.advance(1_000)
  const big = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tree = JSON.stringify(await big.drawn({ in: 'sky' }))
  expect(tree.length).toBeLessThan(100_000)
  expect(await big.find({ type: 'Text', text: /more rows/, in: 'sky' })).toBeDefined()
  await big.unmount()
})

test('a subagent the list no longer names has ended', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  let listed = [{ id: 's1', description: 'find the retry logic', type: 'Explore', status: 'running' as const }]
  on('session.root', () => ({ value: `${HOME}/shop` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: listed }))
  on('command.register', () => ({ value: { command: 'constellation' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', () => ({ value: [] }))
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  const live = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await live.find({ type: 'Text', text: /1◐/ })).toBeDefined()
  await live.unmount()
  listed = []
  await clock.advance(1_000)
  const ended = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ended.find({ type: 'Text', text: /1●/ })).toBeDefined()
  expect(await ended.find({ type: 'Text', text: /◐/ })).toBeUndefined()
  await ended.unmount()
})

test('motion eases between colors and keeps every effect in range', () => {
  expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
  expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
  expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  for (let t = 0; t < 10_000; t += 333) {
    const b = twinkle(t, 12345)
    expect(b >= 0 && b <= 1).toBe(true)
  }
  // A comet's head outshines its tail above, and nothing below it is lit.
  const head = Array.from({ length: 12 }, (_, k) => comet(k, 12, 300))
  const lit = head.findLastIndex(b => b > 0.9)
  expect(lit).toBeGreaterThan(0)
  expect(head[lit - 1] ?? 0).toBeLessThan(head[lit] ?? 0)
  expect(head[lit + 2] ?? 0).toBe(0)
  expect(progress(500, 0, 1_000)).toBe(0.5)
})

const TRANSCRIPT = [
  line({ type: 'user', timestamp: '2026-10-22T10:00:00.000Z', message: { role: 'user', content: 'Scan web logs for errors' } }),
  line({ type: 'assistant', timestamp: '2026-10-22T10:00:02.000Z', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/repo/shop/refunds.py' } }] } }),
  line({ type: 'user', timestamp: '2026-10-22T10:00:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'def refund(): ...' }] } }),
  line({ type: 'assistant', timestamp: '2026-10-22T10:00:05.000Z', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'git push origin main' } }] } }),
  line({ type: 'user', timestamp: '2026-10-22T10:00:06.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'Permission to use Bash has been denied.' }] } }),
  line({ type: 'assistant', timestamp: '2026-10-22T10:00:09.000Z', message: { id: 'm3', content: [{ type: 'tool_use', id: 'tu3', name: 'mcp__tracker__get_issue', input: { id: 'INC-42' } }] } }),
  line({ type: 'assistant', timestamp: '2026-10-22T10:00:12.000Z', message: { id: 'm4', content: [{ type: 'text', text: 'The plan is ready.' }] } }),
].join('\n')

test('reads an agent transcript into its prompt, tool calls and last answer', () => {
  const trace = traceOf(TRANSCRIPT)
  expect(trace.prompt).toBe('Scan web logs for errors')
  expect(trace.answer).toBe('The plan is ready.')
  expect(trace.tools.map(t => [t.name, t.summary, t.status])).toEqual([
    ['Read', 'shop/refunds.py', 'ok'],
    ['Bash', 'git push origin main', 'denied'],
    ['mcp__tracker__get_issue', 'INC-42', 'running'],
  ])
  expect(trace.tools[1]?.note).toBe('Permission to use Bash has been denied.')
  expect(trace.tools[0]?.endedAt! - trace.tools[0]?.startedAt!).toBe(1_000)
})

test('names what decided a permission check, and keeps every deny', () => {
  expect(decidedBy({ decision: 'deny', rule: 'Bash(git push:*)', reason: 'x' })).toBe('rule Bash(git push:*)')
  expect(decidedBy({ decision: 'ask', hook: 'PreToolUse' })).toBe('hook PreToolUse')
  expect(decidedBy({ decision: 'allow', reason: 'acceptEdits  mode' })).toBe('acceptEdits mode')
  const allow = (at: number) => ({ tool: 'Read', summary: 'f', decision: 'allow' as const, by: 'mode', at })
  const deny = { tool: 'Bash', summary: 'git push', decision: 'deny' as const, by: 'rule', at: 1 }
  const kept = keepChecks([deny, ...Array.from({ length: 40 }, (_, i) => allow(i + 2))], 10)
  expect(kept.length).toBe(10)
  expect(kept[0]).toEqual(deny)
  expect(summarizeInput('Edit', { file_path: '/a/b/c/d.ts' })).toBe('c/d.ts')
  const ask = { questions: [{ question: 'Which library?', header: 'Library', options: [{ label: 'zod' }, { label: 'valibot' }], multiSelect: false }] }
  expect(summarizeInput('AskUserQuestion', ask)).toBe('Which library?')
})

test('a press on an agent opens its inspector: prompt, tools, permissions, answer; back returns', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  const disk: Record<string, string> = {
    [`${DIR}/workflows/scripts/nightly-audit-${RUN}.js`]: SCRIPT,
    [`${DIR}/subagents/workflows/${RUN}/journal.jsonl`]: JOURNAL,
    [`${DIR}/subagents/workflows/${RUN}/agent-a3.jsonl`]: TRANSCRIPT,
  }
  on('session.root', () => ({ value: `${HOME}/shop` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'constellation' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => {
    if (e.path === `${DIR}/subagents/workflows`) return { value: [{ ...file(RUN, 0), kind: 'dir' as const }] }
    if (e.path === `${DIR}/workflows/scripts`) return { value: [file(`nightly-audit-${RUN}.js`, SCRIPT.length)] }
    return { value: [] }
  })
  on('fs.stat', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1_000, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('tool.check', () => ({ decision: 'deny' as const, reason: 'blocked by a rule', rule: 'Bash(git push:*)' }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main', agentId: 'a3' })
  await clock.advance(1_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'a3' })
  await clock.advance(10)
  await ui.advance(100)
  const seen = async (text: RegExp) => ui.find({ type: 'Text', text, in: 'sky' })
  expect(await seen(/nightly-audit › Inspect › check #2/)).toBeDefined()
  expect(await seen(/Scan web logs for errors/)).toBeDefined()
  expect(await seen(/git push origin main/)).toBeDefined()
  expect(await seen(/rule Bash\(git push:\*\)/)).toBeDefined()
  expect(await seen(/The plan is ready\./)).toBeDefined()

  await ui.press({ key: 'i:back:lead' })
  await ui.advance(100)
  expect(await seen(/no agents yet|check/)).toBeDefined()
  expect(await seen(/Scan web logs for errors/)).toBeUndefined()
  await ui.unmount()
})

test('the demo plays a scout, two child workflows, a denied push, a flaky rerun and a summary, then completes', () => {
  const at = (s: number) => demoAt('demo-1', 0, s * 1000)
  expect(at(1).run.agents.map(a => a.status)).toEqual(['running'])
  const mid = skyRun(at(16).run, at(16).stats, 60)
  expect(mid.nodes[1]?.children.map(c => c.title)).toEqual(['scan-stage', 'scan-stage #2'])
  expect(mid.counts.running).toBeGreaterThan(0)
  const end = demoAt('demo-1', 0, DEMO_MS)
  expect(end.run.status).toBe('completed')
  expect(end.run.agents.find(a => a.id === 'demo-push')?.status).toBe('failed')
  expect(end.checks['demo-push']?.some(c => c.decision === 'deny')).toBe(true)
  const statusOf = (label: string) => end.run.agents.find(a => a.label === label)?.status
  expect(statusOf('count hooks')).toBe('done')
  expect(statusOf('rerun the flaky test')).toBe('done')
  expect(at(24).run.agents.find(a => a.label === 'rerun the flaky test')?.phase).toBe('Wrap up')
  // An agent's seq is its place in the tree, so it must never change.
  const seqs = new Map<string, number>()
  for (let ms = 0; ms <= DEMO_MS; ms += 250) {
    for (const a of demoAt('demo-1', 0, ms).run.agents) {
      expect(seqs.get(a.id) ?? a.seq).toBe(a.seq)
      seqs.set(a.id, a.seq)
    }
  }
})

test("the demo's permission log names what the sky names", () => {
  const { checks } = demoAt('demo-1', 0, 34_000)
  expect(checks['demo-long-a']?.some(c => c.tool === 'Edit' && c.summary === 'hooks/draw.tsx')).toBe(true)
  const retries = checks['demo-retry']?.filter(c => c.tool === 'Bash') ?? []
  expect(retries.length).toBeGreaterThan(0)
  expect(retries.every(c => c.summary === 'npm test -- flaky' && c.decision === 'allow')).toBe(true)
  const pushes = checks['demo-push']?.filter(c => c.tool === 'Bash') ?? []
  expect(pushes.length).toBe(8)
  const denied = pushes.filter(c => c.decision === 'deny')
  expect(denied.map(c => c.at / 1000)).toEqual([15, 19.6])
  expect(denied.every(c => c.summary === 'git push origin demo' && c.by === 'rule Bash(git push:*)')).toBe(true)
  expect(pushes.filter(c => c.decision === 'allow').every(c => c.by === 'auto mode')).toBe(true)
  expect(demoAt('demo-1', 0, 21_000).stats['demo-push']?.tools).toBe(7)
  for (const f of demoFailures(0, 0, DEMO_MS)) {
    const log = demoAt('demo-1', 0, f.at).checks[f.agent ?? ''] ?? []
    if (f.kind === 'deny') expect(log.some(c => c.decision === 'deny' && c.at === f.at)).toBe(true)
    else expect(log.some(c => c.decision === 'allow' && c.at <= f.at)).toBe(true)
  }
  expect(retries.map(c => c.at / 1000)).toEqual([22, 24, 26, 28, 30, 32])
  const retryAt = (ms: number) => {
    const now = demoAt('demo-1', 0, ms)
    expect(now.checks['demo-retry']?.length).toBe(now.stats['demo-retry']?.tools)
    const agent = skyRun(now.run, now.stats, 60).nodes.flatMap(nodeAgents).find(a => a.id === 'demo-retry')
    return { retro: retroIn(agent?.watch, ms), tools: now.stats['demo-retry']?.tools }
  }
  // Stationary at the third run (26 s), retrograde from the fourth, direct at the read (33.5 s).
  for (let ms = 26_000; ms < 33_500; ms += 100) {
    const { retro, tools } = retryAt(ms)
    expect(retro).toMatchObject({ stage: ms < 28_000 ? 'stationary' : 'retrograde', detail: `same Bash call ×${tools}` })
  }
  for (let ms = 33_500; ms < 35_500; ms += 100) expect(retryAt(ms)).toEqual({ retro: null, tools: 7 })
  expect(demoAt('demo-1', 0, DEMO_MS).stats['demo-retry']?.lastTool).toBe('Read')
})

test("the demo's two longest-file agents edit one file: a binary star from 12 s until one of them ends at 19", () => {
  const binariesAt = (s: number) => {
    const { run, stats } = demoAt('demo-1', 0, s * 1000)
    return binariesOf(stats, run.agents.filter(a => a.status === 'running').map(a => a.id), s * 1000)
  }
  expect(binariesAt(11.9)).toEqual([])
  expect(binariesAt(12)).toEqual([{ path: '/demo/constellation/hooks/draw.tsx', agents: ['demo-long-a', 'demo-long-b'] }])
  expect(binariesAt(18.9).length).toBe(1)
  expect(binariesAt(19)).toEqual([])
  const { checks } = demoAt('demo-1', 0, 12_000)
  for (const id of ['demo-long-a', 'demo-long-b']) expect(checks[id]?.some(c => c.tool === 'Edit' && c.summary === 'hooks/draw.tsx')).toBe(true)
})

test('every sky style draws a band exactly as wide as asked, at any moment', () => {
  const { run, stats } = demoAt('demo-1', 0, 20_000)
  const sky = skyRun(run, stats, 60)
  const samples = Array.from({ length: 80 }, (_, i) => ({ t: i * 500, live: i % 5, cost: i * 0.1 }))
  for (const style of SKY_STYLES) {
    for (const t of [0, 1_234, 9_999, 60_000]) {
      const rows = skyBand(style, 54, t, sky, true, [{ t0: t - 400, seed: 7 }], samples, () => null)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect([...row.map(c => c.t).join('')].length).toBe(54)
    }
  }
})

/** A session folder on disk holding one finished run, for the tests that clear and measure. */
function finishedWorld(on: On) {
  const final = {
    runId: RUN,
    workflowName: 'nightly-audit',
    status: 'completed',
    startTime: 1_000,
    durationMs: 60_000,
    summary: 'Nightly log audit',
    phases: [{ title: 'Gather', detail: 'fetch every log' }],
    workflowProgress: [
      { type: 'workflow_agent', index: 1, label: 'collect logs', phaseTitle: 'Gather', agentId: 'a1', state: 'done', tokens: 100, toolCalls: 1, durationMs: 1_000, startedAt: 1_000 },
    ],
  }
  const disk: Record<string, string> = { [`${DIR}/workflows/${RUN}.json`]: JSON.stringify(final) }
  on('session.root', () => ({ value: `${HOME}/shop` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'constellation' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => ({ value: e.path === `${DIR}/subagents/workflows` ? [{ ...file(RUN, 0), kind: 'dir' as const }] : [] }))
  on('fs.stat', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1_000, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
}

/** A session folder holding a running nightly-audit run (in JOURNAL, `a3` runs under Inspect › check #2); returns the disk so a test can add files. */
function runningWorld(on: On, journal = JOURNAL): Record<string, string> {
  const disk: Record<string, string> = {
    [`${DIR}/workflows/scripts/nightly-audit-${RUN}.js`]: SCRIPT,
    [`${DIR}/subagents/workflows/${RUN}/journal.jsonl`]: journal,
  }
  on('session.root', () => ({ value: `${HOME}/shop` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'constellation' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => {
    if (e.path === `${DIR}/subagents/workflows`) return { value: [{ ...file(RUN, 0), kind: 'dir' as const }] }
    if (e.path === `${DIR}/workflows/scripts`) return { value: [file(`nightly-audit-${RUN}.js`, SCRIPT.length)] }
    return { value: [] }
  })
  on('fs.stat', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 1_000, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const text = disk[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  return disk
}

/** Reads a step's stream to its end, as the engine does above every hook. */
async function drain(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>): Promise<{ chunks: TurnStepChunk[]; result: TurnStepResult | undefined }> {
  const chunks: TurnStepChunk[] = []
  let step = await stream.next()
  while (!step.done) {
    chunks.push(step.value)
    step = await stream.next()
  }
  return { chunks, result: step.value }
}

/** A mock model under every hook: each request almost fully cached, asking for `calls` (a getter is read per request). */
function cachedModel(on: On, calls: TurnStepResult['toolUses'] | (() => TurnStepResult['toolUses']) = []) {
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    const toolUses = typeof calls === 'function' ? calls() : calls
    yield { kind: 'text', index: 0, text: 'Reading on.' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Reading on.',
      toolUses,
      stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 0, output_tokens: 50 },
    }
  })
}

/** The props the terminal's hooks tree hands its Client (a test's `$` has no `$.state`). */
async function clientProps($: Engine): Promise<SkyProps | null> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const drawn = await ui.drawn()
  await ui.unmount()
  return drawn.type === 'Client' ? (drawn.props.props as SkyProps) : null
}

/** The agents in the Client's props, in drawing order, and the props' `now`. */
async function clientAgents($: Engine): Promise<{ now: number; agents: SkyAgent[] }> {
  const sky = await clientProps($)
  return { now: sky?.now ?? 0, agents: sky ? [...sky.runs, ...(sky.subagents ? [sky.subagents] : [])].flatMap(runAgents) : [] }
}

test('the session star says what the context window is going through', async ($, on) => {
  mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  finishedWorld(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 124_000, window: 200_000, percent: 62 }, rateLimits: [], cost: { usd: 4.12 } } }))
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'vscode'] as const) {
    const scope = surface === 'terminal' ? { in: 'sky' } : {}
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /swelling · red giant/, ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /62%/, ...scope })).toBeUndefined()
    await ui.unmount()
  }
})

test('clearing a finished run hides it for good, though its files stay on disk', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  finishedWorld(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /nightly-audit/, in: 'sky' })).toBeDefined()
  await ui.press({ key: 'clear' })
  await clock.advance(3_000)
  await ui.advance(100)
  expect(await ui.find({ type: 'Text', text: /nightly-audit/, in: 'sky' })).toBeUndefined()
  await ui.unmount()
})

test('the star lives, swells, dies and is reborn, always inside its box', () => {
  const stages = [null, 5, 45, 70, 88, 97].map(pct => starStage(pct, false).name)
  expect(stages).toEqual([
    'a protostar · waiting for the first answer',
    'a young star',
    'a steady star',
    'swelling · red giant',
    'unstable · shedding',
    'dying · compact soon',
  ])
  expect(starStage(97, true).name).toBe('supernova · reborn')
  expect(starStage(null, false, true).name).toBe('a newborn star')
  expect(starCells(null, 0, null, 1, true).flat().filter(c => c.t === '▀' || c.t === '▄').length).toBeGreaterThan(0)
  const drawn = (cells: { t: string }[][]) => cells.flat().filter(c => c.t !== ' ').length
  const young = starCells(5, 0, null, 0)
  const dying = starCells(97, 0, null, 0)
  expect(drawn(dying)).toBeGreaterThan(drawn(young))
  for (const [pct, novaAt, t] of [[null, null, 0], [5, null, 500], [97, null, 9_000], [20, 1_000, 1_300], [20, 1_000, 3_000]] as const) {
    const cells = starCells(pct, t, novaAt, 2)
    expect(cells.length).toBe(STAR_H)
    for (const row of cells) expect(row.length).toBe(STAR_W)
  }
})

test('session.start again, as a hot reload runs it, leaves a demo and a star life that still play alone', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  on('session.root', () => ({ value: `${HOME}/shop` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'constellation' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', () => ({ value: [] }))
  const start = () => $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  const seen = async (text: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found
  }
  await start()
  await $.command.run(typed('demo star'))
  await $.command.run(typed('demo'))
  await clock.advance(5_000)
  await start()
  // Their timers survive the reload, so nothing they drive is cleared.
  expect(await seen(/scout the repo/)).toBeDefined()
  expect(await seen(/a young star/)).toBeDefined()
  await clock.advance(5_000)
  expect(await seen(/count hooks/)).toBeDefined()
  expect(await seen(/list tests/)).toBeDefined()
})

test('a compaction makes a newborn star until the next answer measures it; /clear starts a protostar', async ($, on) => {
  mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  finishedWorld(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 950_000, window: 1_000_000, percent: 95 }, rateLimits: [], cost: { usd: 9 } } }))
  const summary = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
  on('session.compact', () => ({ messages: summary }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  const seen = async (text: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found
  }
  expect(await seen(/dying · compact soon/)).toBeDefined()
  await $.session.compact({ trigger: 'manual', messages: summary })
  expect(await seen(/a newborn star/)).toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(await seen(/a protostar/)).toBeDefined()
})

test('an agent served from its cache shows it: the tool count gives way to its share, and its inspector reads the spectrum', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  // The telescope tells the share.
  mock.store(on, { detail: 'telescope' })
  runningWorld(on)
  cachedModel(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 8; i++) {
    const { chunks } = await drain($.turn.step({ turnId: 'turn-k', index: i, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a3' }))
    expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'Reading on.' }])
  }
  await clock.advance(1_000)

  for (const surface of ['terminal', 'vscode'] as const) {
    const scope = surface === 'terminal' ? { in: 'sky' } : {}
    const ui = await $.ui.mount({ ...PANE, surface })
    // 12 columns of indent leave 44, enough for the whole line.
    // Anchored to the end because the phase, child workflow and footer also draw `$0.17`.
    expect(await ui.find({ type: 'Text', text: /99\.9% cached · \$0\.17$/, ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\d+ tools?\b/, ...scope })).toBeUndefined()
    // The moon takes a color of the blue breath.
    const row = (await ui.find({ key: 'a3', ...scope }))?.children as { props?: { color?: string }; children?: unknown[] }[] | undefined
    const moon = row?.find(c => /^[◐◓◑◒]$/.test(String(c.children?.[0])))
    expect(Array.from({ length: 7 }, (_, k) => moonColor(k / 6, -1))).toContain(moon?.props?.color)
    await ui.unmount()
    // 50 columns leave 38: the cost no longer fits and is dropped with its separator.
    const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 50 }, surface })
    expect(await narrow.find({ type: 'Text', text: /ctx · 99\.9% cached$/, ...scope })).toBeDefined()
    await narrow.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'a3' })
  await clock.advance(10)
  await ui.advance(100)
  expect(await ui.find({ type: 'Text', text: /blueshift/, in: 'sky' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /99\.9% cached now/, in: 'sky' })).toBeDefined()
  await ui.unmount()
})

test('one is singular: an agent of one call reads "1 tool" in its detail line, the footer and both inspectors, the footer "1 agent"', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on, { detail: 'telescope' })
  runningWorld(on, [line({ type: 'launched' }), line({ type: 'started', key: 'k3', agentId: 'a3', label: 'scan web', phase: '▸ check #2' })].join('\n'))
  // One step is too soon for a cache share, so the tool count stays.
  cachedModel(on, [NPM_TEST])
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await drain($.turn.step({ turnId: 'turn-k', index: 0, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a3' }))
  await clock.advance(1_000)

  for (const surface of ['terminal', 'vscode'] as const) {
    const scope = surface === 'terminal' ? { in: 'sky' } : {}
    const ui = await $.ui.mount({ ...PANE, surface })
    const seen = (text: RegExp) => ui.find({ type: 'Text', text, ...scope })
    expect(await seen(/ctx · 1 tool · \$[\d.]+$/)).toBeDefined()
    // Only the footer shows the run's totals.
    expect(await seen(/^ │ ≈\$/)).toBeUndefined()
    expect(await seen(/^ 1 agent · 1 live · ≈\$[\d.]+ · 1 tool$/)).toBeDefined()
    expect(await seen(/\b1 (tools|agents)\b/)).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const seen = (text: RegExp) => ui.find({ type: 'Text', text, in: 'sky' })
  for (const [key, facts] of [['a3', /^ opus 5\.5 · .*ctx · 1 tool · ≈\$[\d.]+$/], [RUN, /^ ≈\$[\d.]+ · 1 tool$/]] as const) {
    await ui.press({ key })
    await clock.advance(10)
    await ui.advance(100)
    expect(await seen(facts)).toBeDefined()
    expect(await seen(/\b1 tools\b/)).toBeUndefined()
    await ui.press({ key: 'i:back:lead' })
    await clock.advance(10)
    await ui.advance(100)
  }
  await ui.unmount()
})

/** A one-phase script, so the phase stands alone at its level. */
const ONE_PHASE = `export const meta = {
  name: 'nightly-audit',
  description: 'Nightly log audit',
  phases: [{ title: 'Inspect', detail: 'check, then retry' }],
}
`

/** All the text a pane draws, run together. */
const paneText = async (ui: { drawn: (scope?: { in?: string }) => Promise<unknown> }, scope: { in?: string }) => textOf(await ui.drawn(scope))

test("the tree draws the totals only in its footer; a phase or child workflow shows its cost only beside siblings, and never to the naked eye", async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on, { detail: 'binoculars' })
  const started = (id: string, label: string, phase: string) => line({ type: 'started', key: id, agentId: id, label, phase })
  const JOURNAL_PATH = `${DIR}/subagents/workflows/${RUN}/journal.jsonl`
  const journal = [line({ type: 'launched' }), started('a2', 'scan api', '▸ check')]
  const disk = runningWorld(on, journal.join('\n'))
  disk[`${DIR}/workflows/scripts/nightly-audit-${RUN}.js`] = ONE_PHASE
  cachedModel(on, [NPM_TEST])
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  const step = (agentId: string) => drain($.turn.step({ turnId: `turn-${agentId}`, index: 0, model: 'claude-opus-5-5', messageCount: 2, agentId }))
  await step('a2')
  await clock.advance(1_000)
  const INSPECT = `${RUN}/Inspect`
  const CHECK = `${RUN}/▸ check`
  const RETRY = `${RUN}/▸ retry`
  const REPORT = `${RUN}/Report`
  /** Which of the node rows keyed `keys` draw a cost, on each surface. */
  const costed = async (...keys: string[]): Promise<boolean[]> => {
    const seen: boolean[] = []
    for (const surface of ['terminal', 'vscode'] as const) {
      const scope = surface === 'terminal' ? { in: 'sky' } : {}
      const ui = await $.ui.mount({ ...PANE, surface })
      for (const key of keys) seen.push(rowText(await cellsOfRow(ui, key, scope)).includes('$'))
      await ui.unmount()
    }
    return seen
  }

  // A lone node's cost would repeat the run's, which only the footer tells.
  expect(await costed(INSPECT, CHECK)).toEqual([false, false, false, false])
  for (const surface of ['terminal', 'vscode'] as const) {
    const scope = surface === 'terminal' ? { in: 'sky' } : {}
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^ │ Nightly log audit$/, ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ │ ≈?\$|^ │ \d+ tools?$/, ...scope })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^ 1 agent · 1 live · ≈\$[\d.]+ · 1 tool$/, ...scope })).toBeDefined()
    await ui.unmount()
  }

  // Sibling child workflows now tell their shares; the phase still stands alone.
  disk[JOURNAL_PATH] = [...journal, started('a4', 'rescan api logs', '▸ retry')].join('\n')
  await step('a4')
  await clock.advance(1_000)
  expect(await costed(INSPECT, CHECK, RETRY)).toEqual([false, true, true, false, true, true])
  await $.command.run(typed('detail naked-eye'))
  expect(await costed(INSPECT, CHECK, RETRY)).toEqual([false, false, false, false, false, false])

  // A second phase: the first phase's cost is now a share too.
  await $.command.run(typed('detail telescope'))
  disk[JOURNAL_PATH] = [...journal, started('a4', 'rescan api logs', '▸ retry'), started('a6', 'write the report', 'Report')].join('\n')
  await step('a6')
  await clock.advance(1_000)
  expect(await costed(INSPECT, REPORT)).toEqual([true, true, true, true])
})

test("each level's agent rows: the naked eye sees who runs, what tool and how long; binoculars add model, effort and cost; the telescope everything", async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  // a4 runs beside a finished a5; a3 runs with no answer yet.
  runningWorld(on, [JOURNAL, line({ type: 'started', key: 'k5', agentId: 'a5', label: 'rescan web logs', phase: '▸ retry' }), line({ type: 'result', key: 'k5', agentId: 'a5', result: {} })].join('\n'))
  cachedModel(on, [NPM_TEST])
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  for (const agentId of ['a4', 'a5']) await drain($.turn.step({ turnId: `turn-${agentId}`, index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 2, agentId }))
  await clock.advance(1_000)
  /** Per surface: a4's row and the line under it, a5's row, whether a3 says it waits, and the pane's cost count. */
  const look = async () => {
    const seen: { running: string; detail: string | null; finished: string; waits: boolean; costs: number }[] = []
    for (const surface of ['terminal', 'vscode'] as const) {
      const scope = surface === 'terminal' ? { in: 'sky' } : {}
      const ui = await $.ui.mount({ ...PANE, surface })
      const running = rowText(await cellsOfRow(ui, 'a4', scope))
      const under = await ui.find({ type: 'Text', text: /opus 5\.5/, ...scope })
      seen.push({
        running: running.replace(/[◐◓◑◒]/, '◐').replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, '⠋'),
        detail: under ? textOf(under).replace(/^[ │]+/, '') : null,
        finished: rowText(await cellsOfRow(ui, 'a5', scope)),
        waits: (await ui.find({ type: 'Text', text: /waiting for its first answer/, ...scope })) !== undefined,
        costs: (await paneText(ui, scope)).match(/\$/g)?.length ?? 0,
      })
      await ui.unmount()
    }
    expect(seen[0]).toEqual(seen[1])
    return seen[0]
  }

  // The naked eye is the default; only the footer draws a cost.
  const naked = await look()
  expect(naked?.running).toMatch(/├─◐ rescan api logs +⠋ Bash 0:\d\d$/)
  expect(naked?.detail).toBe(null)
  expect(naked?.finished).toMatch(/╰─● rescan web logs +0:\d\d$/)
  expect([naked?.waits, naked?.costs]).toEqual([false, 1])

  await $.command.run(typed('detail binoculars'))
  const binoculars = await look()
  expect(binoculars?.running).toBe(naked?.running)
  expect(binoculars?.detail).toMatch(/^opus 5\.5 · xhigh · \$\d+\.\d\d$/)
  expect(binoculars?.finished).toMatch(/╰─● rescan web logs +\$\d+\.\d\d 0:\d\d$/)
  expect(binoculars?.waits).toBe(true)

  await $.command.run(typed('detail telescope'))
  const telescope = await look()
  expect(telescope?.running).toBe(naked?.running)
  expect(telescope?.detail).toMatch(/^opus 5\.5 · xhigh · \d+k ctx · 1 tool · \$\d+\.\d\d$/)
  expect(telescope?.finished).toBe(binoculars?.finished)
})

test('retrograde keeps its words at every level; stationary shows only through the telescope', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  runningWorld(on)
  cachedModel(on, [NPM_TEST])
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  const step = (i: number) => drain($.turn.step({ turnId: 'turn-k', index: i, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a3' }))
  /** The line under a3's row on vscode at each level (a4 has no answer to tell yet). */
  const words = async () => {
    const seen: (string | null)[] = []
    for (const level of ['naked-eye', 'binoculars', 'telescope']) {
      await $.command.run(typed(`detail ${level}`))
      const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
      const under = await ui.find({ type: 'Text', text: /opus 5\.5|same Bash call/ })
      seen.push(under ? textOf(under).replace(/^[ │]+/, '') : null)
      await ui.unmount()
    }
    return seen
  }
  for (let i = 0; i < 3; i++) await step(i)
  await clock.advance(1_000)
  expect(await words()).toEqual([null, expect.stringMatching(/^opus 5\.5 · \$\d+\.\d\d$/), expect.stringMatching(/^stationary · same Bash call ×3 · opus 5\.5/)])
  await step(3)
  await clock.advance(1_000)
  expect(await words()).toEqual([
    'retrograde · same Bash call ×4',
    expect.stringMatching(/^retrograde · same Bash call ×4 · opus 5\.5/),
    expect.stringMatching(/^retrograde · same Bash call ×4 · opus 5\.5/),
  ])
})

test('the detail level: the command names or steps it, the header word steps it where it fits, and the store keeps it for the next session', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  // An in-memory store holding the level an earlier session kept.
  const store: Record<string, unknown> = { detail: 'telescope' }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  runningWorld(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  const level = async () => (await clientProps($))?.detail
  const kept = () => store.detail
  expect(await level()).toBe('telescope')

  // With no level, the command steps on, wrapping from the telescope to the naked eye.
  expect((await $.command.run(typed('detail'))).text).toBe('Detail: naked eye, just the stars: who is running, what tool, how long.')
  expect([await level(), kept()]).toEqual(['naked-eye', 'naked-eye'])
  expect((await $.command.run(typed('detail binoculars'))).text).toBe("Detail: binoculars, each agent's model, effort and cost.")
  expect([await level(), kept()]).toEqual(['binoculars', 'binoculars'])
  await $.command.run(typed('detail naked eye'))
  expect([await level(), kept()]).toEqual(['naked-eye', 'naked-eye'])
  expect((await $.command.run(typed('detail microscope'))).text).toMatch(/^Detail levels: naked-eye \(.+\); binoculars \(.+\); telescope \(.+\)\./)
  expect(await level()).toBe('naked-eye')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(textOf(await ui.find({ key: 'tab-detail', in: 'sky' }))).toBe('naked eye  ')
  await ui.press({ key: 'tab-detail' })
  await clock.advance(10)
  await ui.advance(100)
  expect(textOf(await ui.find({ key: 'tab-detail', in: 'sky' }))).toBe('binoculars  ')
  await ui.unmount()
  expect([await level(), kept()]).toEqual(['binoculars', 'binoculars'])
  const still = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await still.press({ key: 'tab-detail' })
  await clock.advance(10)
  expect([await level(), kept()]).toEqual(['telescope', 'telescope'])
  await still.unmount()

  /** The header's level word in a still pane `cols` wide, or undefined where it gave way. */
  const word = async (cols: number) => {
    const pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols }, surface: 'vscode' })
    const found = await pane.find({ key: 'tab-detail' })
    await pane.unmount()
    return found ? textOf(found) : undefined
  }
  // The word takes the room between the title and the tabs, and gives way under 44 columns so the header never wraps.
  expect([await word(56), await headerOf($, 56)]).toEqual(['telescope  ', ' ✦ constellation'])
  expect(await word(44)).toBe('telescope  ')
  expect(await word(43)).toBeUndefined()
  expect(await word(40)).toBeUndefined()
  // The history list has no agents, so no word.
  const history = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await history.press({ key: 'tab-history' })
  await clock.advance(10)
  await history.unmount()
  expect(await word(56)).toBeUndefined()

  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  expect(await level()).toBe('telescope')
})

test('a past run opened from history ends with its totals, as the live view does', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  finishedWorld(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.post({ type: 'open', path: `${DIR}/workflows/${RUN}.json` })
  await clock.advance(10)
  await ui.unmount()
  for (const surface of ['terminal', 'vscode'] as const) {
    const scope = surface === 'terminal' ? { in: 'sky' } : {}
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /back to history/, ...scope })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^ 1 agent\b/, ...scope })).toBeDefined()
    await pane.unmount()
  }
})

test('a subagent making the same call over and over goes retrograde, and every step passes through untouched', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  runningWorld(on)
  cachedModel(on, [NPM_TEST])
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  const chunks = [{ kind: 'text', index: 0, text: 'Reading on.' }]
  for (let i = 0; i < 4; i++) {
    const step = await drain($.turn.step({ turnId: 'turn-k', index: i, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a3' }))
    expect(step.chunks).toEqual(chunks)
    expect(step.result?.toolUses).toEqual([NPM_TEST])
  }
  const main = await drain($.turn.step({ turnId: 'turn-m', index: 0, model: 'claude-opus-5-5', messageCount: 2 }))
  expect(main.chunks).toEqual(chunks)
  expect(main.result?.answer).toBe('Reading on.')
  await clock.advance(1_000)

  const { now, agents } = await clientAgents($)
  const retro = retroIn(agents.find(a => a.id === 'a3')?.watch, now)
  expect([retro?.stage, retro?.detail]).toEqual(['retrograde', 'same Bash call ×4'])
  expect(agents.find(a => a.id === 'a3')?.watch?.wait).toBe('tool')
  // a4 never answered here: no tracker, so no watch.
  expect(agents.find(a => a.id === 'a4')?.status).toBe('running')
  expect(agents.find(a => a.id === 'a4')?.watch).toBeUndefined()

  // A request still out at the flush: the loop waits on the model, heard from when streaming began.
  const open = $.turn.step({ turnId: 'turn-k', index: 4, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a3' })
  expect((await open.next()).value).toEqual(chunks[0])
  await clock.advance(1_000)
  const asking = await clientAgents($)
  const watch = asking.agents.find(a => a.id === 'a3')?.watch
  expect([watch?.wait, watch?.quiet]).toEqual(['model', asking.now])
  await drain(open)
})

/** A drawn row's cells: each Text child's characters, color and weight. */
type Drawn = { props?: { color?: string; bold?: boolean }; children?: unknown[] }
const cellsOf = (row: unknown) => (((row as Drawn | undefined)?.children ?? []) as Drawn[]).map(c => ({ t: String(c.children?.[0] ?? ''), c: c.props?.color, b: c.props?.bold }))
/** The cells of a pressable row, found by its key. */
const cellsOfRow = async (ui: { find: (q: { key: string; in?: string }) => Promise<unknown> }, key: string, scope: { in?: string }) => cellsOf(await ui.find({ key, ...scope }))

/** Every colour a resting moon breathes through. */
const RESTING_MOONS = Array.from({ length: 7 }, (_, k) => moonColor(k / 6, 0))
const isMoon = (t: string) => /^[◐◓◑◒]$/.test(t)

/** draw.tsx's moon phases in the order it turns them; +1 for a step forward, -1 for one back. */
const ORBIT = [...'◐◓◑◒']
const direction = (a: string, b: string) => {
  const d = (ORBIT.indexOf(b) - ORBIT.indexOf(a) + 4) % 4
  return d === 1 ? 1 : d === 3 ? -1 : 0
}

test('retrograde draws on the tree: stationary at the third same call, backwards and white from the fourth, its words first, the label plain, the inspector told', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  // The telescope shows the stationary words, and the model after them.
  mock.store(on, { detail: 'telescope' })
  runningWorld(on)
  cachedModel(on, [NPM_TEST])
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  const step = (i: number) => drain($.turn.step({ turnId: 'turn-k', index: i, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a3' }))
  const isSpinner = (t: string) => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/.test(t)
  for (let i = 0; i < 3; i++) await step(i)
  await clock.advance(1_000)

  // Stationary: pale words, the moon in its own colour, the label and spinner as ever.
  const stationary = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await stationary.find({ type: 'Text', text: /^stationary · same Bash call ×3$/ }))?.props.color).toBe(RETRO_HEX.pale)
  const stopped = await cellsOfRow(stationary, 'a3', {})
  expect(RESTING_MOONS).toContain(stopped.find(c => isMoon(c.t))?.c)
  expect(stopped.find(c => c.t === ' scan web')?.c).toBeUndefined()
  expect(stopped.find(c => isSpinner(c.t))?.c).toBe('suggestion')
  await stationary.unmount()

  // Where it moves, the moon slows to a stop and holds while a4's turns on.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const moonOf = async (id: string) => (await cellsOfRow(ui, id, { in: 'sky' })).find(c => isMoon(c.t))
  await ui.advance(1_200)
  const held = (await moonOf('a3'))?.t
  const a4 = new Set<string>()
  for (let k = 0; k < 6; k++) {
    await ui.advance(99)
    expect((await moonOf('a3'))?.t).toBe(held)
    a4.add((await moonOf('a4'))?.t ?? '')
  }
  expect(a4.size).toBeGreaterThan(1)

  // Retrograde: white, turning backwards, its words first.
  await step(3)
  await clock.advance(1_000)
  await ui.advance(700)
  expect((await moonOf('a3'))?.c).toBe(RETRO_HEX.white)
  const turns: string[] = []
  for (let k = 0; k < 40; k++) {
    await ui.advance(33)
    const g = (await moonOf('a3'))?.t ?? ''
    if (turns.at(-1) !== g) turns.push(g)
  }
  expect(turns.length).toBeGreaterThan(3)
  expect(turns.slice(1).map((g, k) => direction(turns[k] ?? '', g))).toEqual(turns.slice(1).map(() => -1))
  expect(await ui.find({ type: 'Text', text: /retrograde · same Bash call ×4/, in: 'sky' })).toBeDefined()

  // Its inspector tells the words under the facts, and its moon turns white there too.
  await ui.press({ key: 'a3' })
  await clock.advance(10)
  await ui.advance(100)
  expect(await ui.find({ type: 'Text', text: /^ retrograde · same Bash call ×4$/, in: 'sky' })).toBeDefined()
  const white = await ui.find({ type: 'Text', text: /^[◐◓◑◒]$/, in: 'sky' })
  expect((white as Drawn | undefined)?.props?.color).toBe(RETRO_HEX.white)
  await ui.press({ key: 'i:back:lead' })
  await clock.advance(10)
  await ui.unmount()

  // Where nothing moves: the white moon, amber words, the label and spinner plain.
  const still = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await still.find({ type: 'Text', text: /^retrograde · same Bash call ×4$/ }))?.props.color).toBe(RETRO_HEX.words)
  const back = await cellsOfRow(still, 'a3', {})
  expect(back.find(c => isMoon(c.t))?.c).toBe(RETRO_HEX.white)
  expect(back.find(c => c.t === ' scan web')?.c).toBeUndefined()
  expect(back.find(c => isSpinner(c.t))?.c).toBe('suggestion')
  expect(RESTING_MOONS).toContain((await cellsOfRow(still, 'a4', {})).find(c => isMoon(c.t))?.c)
  await still.unmount()
})

test('direct: a retrograde agent that makes a different call says so for a moment, loses its white and turns forward again; a new loop goes retrograde again', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  runningWorld(on)
  let uses: TurnStepResult['toolUses'] = [NPM_TEST]
  cachedModel(on, () => uses)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  let i = 0
  const steps = async (n: number) => {
    for (let k = 0; k < n; k++) await drain($.turn.step({ turnId: 'turn-k', index: i++, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a3' }))
    await clock.advance(1_000)
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const moon = async () => (await cellsOfRow(ui, 'a3', { in: 'sky' })).find(c => isMoon(c.t))
  const said = async (text: RegExp) => (await ui.find({ type: 'Text', text, in: 'sky' })) !== undefined

  await steps(4)
  await ui.advance(1_000)
  expect((await moon())?.c).toBe(RETRO_HEX.white)
  // The naked eye shows retrograde's words.
  expect(await said(/retrograde · same Bash call ×4/)).toBe(true)
  uses = [{ name: 'Read', input: { file_path: '/home/someone/shop/notes.md' } }]
  await steps(1)
  await ui.advance(100)
  expect([await said(/^direct$/), await said(/retrograde/)]).toEqual([true, false])
  await ui.advance(1_600)
  expect(await said(/^direct$/)).toBe(false)
  expect((await moon())?.c).not.toBe(RETRO_HEX.white)
  const turns: string[] = []
  for (let k = 0; k < 30; k++) {
    await ui.advance(33)
    const g = (await moon())?.t ?? ''
    if (turns.at(-1) !== g) turns.push(g)
  }
  expect(turns.slice(1).map((g, k) => direction(turns[k] ?? '', g))).toEqual(turns.slice(1).map(() => 1))
  uses = [NPM_TEST]
  await steps(4)
  await ui.advance(1_000)
  expect((await moon())?.c).toBe(RETRO_HEX.white)
  await ui.unmount()
})

test('a running fan-out, every agent tinted and tracked, still fits a Client: only its first 40 running agents keep the extras', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  runningWorld(on, FAN_OUT)
  cachedModel(on, [NPM_TEST])
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  // 6 × 300 = 1,800 steps warm every cache mix and tracker in one flush, under MAX_BUFFER.
  for (let k = 0; k < 6; k++) {
    for (let i = 0; i < 300; i++) await drain($.turn.step({ turnId: `turn-z${i}`, index: k, model: 'claude-opus-5-5', messageCount: 2, agentId: `z${i}` }))
  }
  await clock.advance(1_000)
  const big = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await big.find({ type: 'Text', text: /more rows/, in: 'sky' })).toBeDefined()
  // The hooks' tree: the Client element with its props.
  const tree = JSON.stringify(await big.drawn())
  expect(tree.length).toBeLessThan(100_000)
  expect([tree.match(/"watch":/g)?.length, tree.match(/"cache":/g)?.length]).toEqual([40, 40])
  // The 40 go retrograde; the Client's own tree must still fit.
  await big.advance(2_000)
  expect(await big.find({ type: 'Text', text: /same Bash call ×6/, in: 'sky' })).toBeDefined()
  expect(JSON.stringify(await big.drawn({ in: 'sky' })).length).toBeLessThan(100_000)
  await big.unmount()
})

/** JOURNAL with a third running agent, a5, beside a4 under Inspect › retry. */
const JOURNAL_A5 = [JOURNAL, line({ type: 'started', key: 'k5', agentId: 'a5', label: 'rescan web logs', phase: '▸ retry' })].join('\n')

/** A row's text, and its `n` glyph cells (one per character) ending two past its `├`/`╰` connector. */
const rowText = (cells: readonly { t: string }[]) => cells.map(c => c.t).join('')
const glyphCells = <C extends { t: string }>(cells: readonly C[], n: number): C[] => {
  const chars = cells.flatMap(c => [...c.t].map(t => ({ ...c, t })))
  const glyph = chars.findIndex(c => c.t === '├' || c.t === '╰') + 2
  return chars.slice(glyph + 1 - n, glyph + 1)
}

test('two running agents writing one file lock into a binary star, in step, the run naming the file; a refused write pairs no one', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  runningWorld(on, JOURNAL_A5)
  cachedModel(on)
  on('tool.check', (_, e) => (e.agentId === 'a5' ? { decision: 'deny' as const, reason: 'blocked by a rule', rule: 'Edit(hooks/**)' } : { decision: 'allow' as const }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  for (const agentId of ['a3', 'a4', 'a5']) await drain($.turn.step({ turnId: `turn-${agentId}`, index: 0, model: 'claude-opus-5-5', messageCount: 2, agentId }))
  const edit = (agentId: string) => $.tool.call({ tool: 'Edit', file_path: SHARED, old_string: 'a', new_string: 'b', agentId })
  const WARNING = /^ │ •● binary · 2 agents editing hooks\/draw\.tsx$/

  await edit('a3')
  await edit('a5')
  await clock.advance(1_000)
  const alone = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await alone.find({ type: 'Text', text: /agents editing/ })).toBeUndefined()
  expect(isMoon(glyphCells(await cellsOfRow(alone, 'a3', {}), 1)[0]?.t ?? '')).toBe(true)
  await alone.unmount()

  await edit('a4')
  await clock.advance(1_000)
  const still = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await still.find({ type: 'Text', text: WARNING })).toBeDefined()
  const [a3, a4, a5] = await Promise.all(['a3', 'a4', 'a5'].map(id => cellsOfRow(still, id, {})))
  // The companion takes the connector's tail, so the label stays where a5's is.
  expect(rowText(a3 ?? [])).toMatch(/[├╰]•● scan web/)
  expect(rowText(a4 ?? [])).toMatch(/[├╰]•● rescan api logs/)
  expect(rowText(a5 ?? [])).toMatch(/[├╰]─[◐◓◑◒] rescan web logs/)
  expect(rowText(a4 ?? []).indexOf('rescan')).toBe(rowText(a5 ?? []).indexOf('rescan'))
  expect(glyphCells(a3 ?? [], 2)).toEqual(glyphCells(a4 ?? [], 2))
  expect(RESTING_MOONS).not.toContain(glyphCells(a3 ?? [], 1)[0]?.c)
  await still.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const glyphsOf = async (id: string, n: number) => glyphCells(await cellsOfRow(ui, id, { in: 'sky' }), n)
  expect(isMoon((await glyphsOf('a3', 1))[0]?.t ?? '')).toBe(true)
  for (const ms of [1_500, 450, 450]) {
    await ui.advance(ms)
    const pair = await glyphsOf('a3', 2)
    // Two stars, or an eclipse: the companion hidden, the connector's tail back (`─●`).
    expect(pair.map(c => c.t).join('')).toMatch(/^[•●][•●]$|^─●$/)
    expect(rowText(await cellsOfRow(ui, 'a3', { in: 'sky' }))).toMatch(/[├╰][•●─][•●] scan web/)
    expect(await glyphsOf('a4', 2)).toEqual(pair)
    const warning = await ui.find({ type: 'Text', text: /^ │ .. binary · 2 agents editing hooks\/draw\.tsx$/, in: 'sky' })
    expect(rowText(cellsOf(warning)).slice(3, 5)).toBe(pair.map(c => c.t).join('').replace('─', ' '))
  }
  expect(JSON.stringify(await ui.drawn({ in: 'sky' })).length).toBeLessThan(100_000)
  await ui.unmount()
})

test("a finished run's figures are kept for its history without the loop tracker or the files written, its cache mix with them", async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  // An in-memory store, so the test can read what was kept.
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  const disk = runningWorld(on)
  cachedModel(on)
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 6; i++) await drain($.turn.step({ turnId: 'turn-k', index: i, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a3' }))
  await drain($.turn.step({ turnId: 'turn-j', index: 0, model: 'claude-opus-5-5', messageCount: 2, agentId: 'a4' }))
  for (const agentId of ['a3', 'a4']) await $.tool.call({ tool: 'Edit', file_path: SHARED, old_string: 'a', new_string: 'b', agentId })
  await clock.advance(1_000)
  // While it runs, its loop is tracked and its file held (a4 wrote it too).
  expect((await clientAgents($)).agents.find(a => a.id === 'a3')?.watch).toBeTruthy()
  const live = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await live.find({ type: 'Text', text: /agents editing/ })).toBeDefined()
  await live.unmount()

  disk[`${DIR}/workflows/${RUN}.json`] = JSON.stringify({
    runId: RUN,
    workflowName: 'nightly-audit',
    status: 'completed',
    startTime: 1_000,
    durationMs: 60_000,
    workflowProgress: [{ type: 'workflow_agent', index: 3, label: 'scan web', phaseTitle: '▸ check #2', agentId: 'a3', state: 'done', tokens: 99_010, toolCalls: 0, durationMs: 5_000, startedAt: 1_000 }],
  })
  await clock.advance(1_000)
  const kept = (store[`stats:${RUN}`] ?? {}) as Record<string, AgentStats>
  expect(kept.a3?.cache?.steps).toBe(6)
  expect(Object.keys(kept.a3 ?? {})).not.toContain('tracker')
  expect(Object.keys(kept.a3 ?? {})).not.toContain('files')
})

/** An empty session that `/constellation demo` plays into: no runs on disk, no subagents. */
function demoWorld(on: On) {
  on('session.root', () => ({ value: `${HOME}/shop` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'constellation' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', () => ({ value: [] }))
}

/** Every colour a comet's label warms to, from the ink: cometLabel quantizes its warmth to sixths. */
const WARM_LABELS = Array.from({ length: 7 }, (_, k) => mix(HEX.ink, HEX.glow, k / 6))
const isDust = (t: string) => /[⠁-⣿]/.test(t)

test("a straggler its finished siblings left behind drags a comet's tail, its label warm and whole where nothing moves; the tail scatters as it finishes", async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  demoWorld(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await $.command.run(typed('demo'))
  // 20 s: `longest in hooks` has run 13 s; its siblings took 5 s and 4 s (pace floored to 5 s), so it is 2.6× late.
  await clock.advance(20_000)

  const still = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const straggler = await cellsOfRow(still, 'demo-long-a', {})
  expect(straggler.some(c => c.t.includes('━'))).toBe(true)
  expect([...rowText(straggler)].length).toBe(56)
  expect(WARM_LABELS.slice(2)).toContain(straggler.find(c => c.t === ' longest in hooks')?.c)
  // `publish the branch` is on pace with its own siblings: no tail, plain label.
  const onPace = await cellsOfRow(still, 'demo-push', {})
  expect(rowText(onPace)).toMatch(/─[◐◓◑◒] publish the branch +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /)
  expect(onPace.find(c => c.t === ' publish the branch')?.c).toBeUndefined()
  await still.unmount()

  // Where it moves, the label keeps its column (as `count hooks` shows).
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.advance(1_000)
  const lit = await cellsOfRow(ui, 'demo-long-a', { in: 'sky' })
  expect(lit.some(c => c.t.includes('━'))).toBe(true)
  expect([...rowText(lit)].length).toBe(56)
  expect(rowText(lit).indexOf('longest')).toBe(rowText(await cellsOfRow(ui, 'demo-count-a', { in: 'sky' })).indexOf('count'))

  await ui.press({ key: `demo-5000/▸ scan-stage` })
  await clock.advance(10)
  await ui.advance(100)
  expect(await ui.find({ type: 'Text', text: /^ ─ agents/, in: 'sky' })).toBeDefined()
  expect((await cellsOfRow(ui, 'demo-long-a', { in: 'sky' })).some(c => c.t.includes('━'))).toBe(true)

  // It finishes at 27 s. The tree folds the finished stage at once, so the scatter is watched in the inspector.
  await clock.advance(7_000)
  await ui.advance(200)
  const scattering = await cellsOfRow(ui, 'demo-long-a', { in: 'sky' })
  expect(scattering.some(c => c.t.includes('━'))).toBe(false)
  expect(scattering.some(c => isDust(c.t))).toBe(true)
  await ui.advance(1_000)
  const done = rowText(await cellsOfRow(ui, 'demo-long-a', { in: 'sky' }))
  expect(done).toMatch(/─● longest in hooks +\$\d\.\d\d 0:20$/)
  expect(isDust(done)).toBe(false)
  await ui.unmount()

  await clock.advance(1_500)
  const fresh = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await fresh.advance(1_000)
  expect(await fresh.find({ type: 'Text', text: /━/, in: 'sky' })).toBeUndefined()
  await fresh.unmount()
  const flat = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await flat.find({ type: 'Text', text: /━/ })).toBeUndefined()
  await flat.unmount()
})

test('a stationary straggler keeps its tail and warm label; once retrograde, its row is plain', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  // The telescope tells the stationary words.
  mock.store(on, { detail: 'telescope' })
  // No phase: the run's loose agents are judged against each other.
  const started = (id: string, label: string) => line({ type: 'started', key: id, agentId: id, label, phase: '' })
  const journal = [line({ type: 'launched' }), started('b1', 'triage T-1'), started('b2', 'triage T-2'), started('b3', 'fix the flaky test')]
  const disk = runningWorld(on, journal.join('\n'))
  cachedModel(on, [NPM_TEST])
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  // All three seen at 6 s; b1 and b2 seen finished at 12 s: a pace of 6 s.
  await clock.advance(1_000)
  await clock.advance(5_000)
  const done = (id: string) => line({ type: 'result', key: id, agentId: id, result: {} })
  disk[`${DIR}/subagents/workflows/${RUN}/journal.jsonl`] = [...journal, done('b1'), done('b2')].join('\n')
  await clock.advance(1_000)
  const step = (i: number) => drain($.turn.step({ turnId: 'turn-b', index: i, model: 'claude-opus-5-5', messageCount: 2, agentId: 'b3' }))
  for (let i = 0; i < 3; i++) await step(i)
  // 16 s: b3 has run 10 s (1.7× the pace) and made the same call three times: late and stationary.
  await clock.advance(4_000)
  const stationary = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await stationary.find({ type: 'Text', text: /^stationary · same Bash call ×3$/ })).toBeDefined()
  const late = await cellsOfRow(stationary, 'b3', {})
  expect(late.some(c => c.t.includes('━'))).toBe(true)
  expect(WARM_LABELS.slice(2)).toContain(late.find(c => c.t === ' fix the flaky test')?.c)
  await stationary.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: RUN })
  await clock.advance(10)
  await ui.advance(1_000)
  expect(await ui.find({ type: 'Text', text: /^ ─ phases/, in: 'sky' })).toBeDefined()
  expect((await cellsOfRow(ui, 'b3', { in: 'sky' })).some(c => c.t.includes('━'))).toBe(true)
  await ui.press({ key: 'i:back:lead' })
  await clock.advance(10)
  await ui.unmount()

  await step(3)
  await clock.advance(1_000)
  const retro = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await retro.find({ type: 'Text', text: /^retrograde · same Bash call ×4$/ })).toBeDefined()
  const plain = await cellsOfRow(retro, 'b3', {})
  expect(rowText(plain)).toMatch(/─[◐◓◑◒] fix the flaky test +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /)
  expect(plain.some(c => c.t.includes('━'))).toBe(false)
  expect(plain.find(c => c.t === ' fix the flaky test')?.c).toBeUndefined()
  await retro.unmount()
})

/** A tool-result row as the engine appends it to a loop's conversation: the main loop's when `agentId` is left out. */
const resultRow = (uuid: string, content: { type: string; [field: string]: unknown }[], agentId?: string) => ({
  uuid,
  door: 'tool-result' as const,
  origin: { kind: 'tool' as const, tool: 'Bash' },
  ...(agentId ? { agentId } : {}),
  message: { type: 'user' as const, role: 'user' as const, content },
})
/** A tool_result block saying call `id` failed, with the text the tool answered. */
const failedResult = (id: string, text = 'exit 1') => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: text })
/** The glyphs a meteor falls in: diagonals, and scan lines in a short band (`─` draws rules too, so it is left out). */
const STREAK = /[╲╱⎺⎻⎼⎽]/
/** A star in its steady years: its short name leaves the shower's words room beside it (a protostar's leaves none). */
const steadyStar = (on: On) =>
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 100_000, window: 200_000, percent: 50 }, rateLimits: [], cost: { usd: 1 } } }))

/** The still tree's Text matching `text`, from a vscode pane mounted for the look. */
async function stillText($: Engine, text: RegExp): Promise<unknown> {
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const found = await ui.find({ type: 'Text', text })
  await ui.unmount()
  return found
}

test("an agent's failed and denied calls fall as meteors, named beside the star; the main loop's, the person's own no and a deny's own error add none", async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  runningWorld(on)
  steadyStar(on)
  // No session.append hook beneath: the kit keeps each row itself, and refuses a bottom that answers without next.
  let denied = ''
  on('tool.check', (_, e) => {
    denied = e.tool_use_id ?? ''
    return { decision: 'deny' as const, reason: 'blocked by a rule', rule: 'Bash(git push:*)' }
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  const ONE = /^ a sporadic meteor from scan web +a steady star$/

  // One failed call of a3 (`scan web`): a sporadic meteor.
  const stored = await $.session.append(resultRow('row-1', [failedResult('toolu_1')], 'a3'))
  expect(stored.uuid).toBe('row-1')
  await clock.advance(1_000)
  expect(await stillText($, ONE)).toBeDefined()

  // The main loop's failure and a call the person refused are no agent failing.
  await $.session.append(resultRow('row-2', [failedResult('toolu_2')]))
  await $.session.append(resultRow('row-3', [failedResult('toolu_3', "The user doesn't want to proceed with this tool use. The tool use was rejected.")], 'a3'))
  await clock.advance(1_000)
  expect(await stillText($, ONE)).toBeDefined()

  // A denied call counts once, though its error result arrives a flush later.
  await $.tool.call({ tool: 'Bash', command: 'git push origin main', agentId: 'a3' })
  expect(denied).not.toBe('')
  await clock.advance(1_000)
  const TWO = /^ sporadic meteors from scan web +a steady star$/
  expect(await stillText($, TWO)).toBeDefined()
  await $.session.append(resultRow('row-4', [failedResult(denied, 'Permission to use Bash has been denied.')], 'a3'))
  await clock.advance(1_000)
  expect(await stillText($, TWO)).toBeDefined()

  // Twenty more make a storm; where nothing moves, no streak is left frozen.
  for (let i = 0; i < 20; i++) await $.session.append(resultRow(`row-burst-${i}`, [failedResult(`toolu_burst_${i}`)], 'a3'))
  await clock.advance(1_000)
  const STORM = /^ a meteor storm from scan web +a steady star$/
  expect(await stillText($, STORM)).toBeDefined()
  expect(await stillText($, STREAK)).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.advance(300)
  expect(await ui.find({ type: 'Text', text: STREAK, in: 'sky' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: STORM, in: 'sky' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn({ in: 'sky' })).length).toBeLessThan(100_000)
  await ui.unmount()
})

test("the demo's failures rain as they happen, from the agent failing most, and leave the sky when the demo starts over", async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  demoWorld(on)
  steadyStar(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await $.command.run(typed('demo'))
  // At 10.4 s a Read of `longest in hooks` fails (its label cut to fit).
  await clock.advance(10_000)
  expect(await stillText($, /meteor/)).toBeUndefined()
  await clock.advance(1_000)
  expect(await stillText($, /^ a sporadic meteor from longest in ho… +a steady star$/)).toBeDefined()
  // 17 s: the denied push and its failing retries make a shower.
  await clock.advance(6_000)
  expect(await stillText($, /^ a meteor shower from publish the bra… +a steady star$/)).toBeDefined()
  await $.command.run(typed('demo'))
  expect(await stillText($, /meteor/)).toBeUndefined()
})

test('a dialog put to the person opens a wait; only their own prompt, the main loop going on, its result or the session ending closes it', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  runningWorld(on)
  cachedModel(on)
  on('classic.PermissionRequest', (_, e) => (e.tool_name === 'Read' ? { decision: { behavior: 'allow' as const } } : {}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.Elicitation', () => ({}))
  on('classic.ElicitationResult', () => ({}))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  // What the sky gets a flush later (a test's `$` has no `$.state`).
  const waited = async () => {
    await clock.advance(1_000)
    return (await clientProps($))?.waiting ?? null
  }
  const ask = (command: string, agentId?: string) => $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command }, ...(agentId ? { agent_id: agentId } : {}) })

  // A dialog a hook answered never reached the person; its answer passes through.
  expect(await $.classic.PermissionRequest({ tool_name: 'Read', tool_input: { file_path: '/home/someone/shop/a.ts' } })).toEqual({ decision: { behavior: 'allow' } })
  expect(await waited()).toBe(null)

  // A task notification is no answer; the person's own prompt is.
  await ask('git push origin main')
  expect(await waited()).toEqual({ since: 6_000, reason: 'permission', tool: 'Bash', summary: 'git push origin main', count: 1 })
  await $.prompt.submit({ text: 'a task finished', wait: false, origin: { kind: 'task-notification' } })
  expect((await waited())?.summary).toBe('git push origin main')
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  expect(await waited()).toBe(null)

  await ask('npm publish')
  expect((await waited())?.summary).toBe('npm publish')
  await $.turn.complete({ answer: 'Done.', durationMs: 1_000, isAborted: false, turnId: 'turn-m', reason: 'answer' })
  expect(await waited()).toBe(null)
  await ask('npm publish')
  expect((await waited())?.summary).toBe('npm publish')
  const { chunks } = await drain($.turn.step({ turnId: 'turn-m', index: 1, model: 'claude-opus-5-5', messageCount: 4 }))
  expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'Reading on.' }])
  expect(await waited()).toBe(null)

  // The call's own result row closes it, by tool name when no call id was known.
  await ask('rm -rf build')
  expect((await waited())?.summary).toBe('rm -rf build')
  await $.session.append(resultRow('row-1', [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'removed' }]))
  expect(await waited()).toBe(null)

  // A subagent's dialog with no prior ask went to hooks, not to a person.
  await ask('npm test', 'a3')
  expect(await waited()).toBe(null)

  // Two asks open: the oldest is told, the other counted.
  await ask('git push origin main')
  await clock.advance(1_000)
  await $.classic.Elicitation({ mcp_server_name: 'tracker', message: 'Which project?', elicitation_id: 'el-1' })
  expect(await waited()).toEqual({ since: 16_000, reason: 'permission', tool: 'Bash', summary: 'git push origin main', count: 2 })
  await $.classic.ElicitationResult({ mcp_server_name: 'tracker', elicitation_id: 'el-1', action: 'accept' })
  expect((await waited())?.count).toBe(1)
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(await waited()).toBe(null)
})

test("the demo's main loop asks to write the README from 29 s, and the person answers at 33.5", async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  demoWorld(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await $.command.run(typed('demo'))
  await clock.advance(28_750)
  expect((await clientProps($))?.waiting ?? null).toBe(null)
  await clock.advance(500)
  expect((await clientProps($))?.waiting).toEqual({ since: 34_000, reason: 'permission', tool: 'Write', summary: 'README.md', count: 1 })
  await clock.advance(4_500)
  expect((await clientProps($))?.waiting ?? null).toBe(null)
})

/** eclipse.ts's moon: the colour of its silhouette over the star. */
const MOON = '#0d0b14'
/** The band's rows in a drawn pane, the session star at their right: the rows after the header. */
const bandOf = (drawn: unknown) => JSON.stringify((drawn as Drawn).children?.slice(1, 1 + STAR_H))

test('a wait eclipses the session star, its words saying what is asked in every view and on every surface; answered, the moon slides off in silence', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  runningWorld(on)
  steadyStar(on)
  on('classic.PermissionRequest', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  const ASKING = /^ +eclipse · waiting on you \(Bash permission\)$/
  const CLEAR = /^ +a steady star$/
  const LINE = /^ ○ eclipse · waiting on you \(Bash permission\)$/
  /** The band a fresh Client draws 1.5 s in (the moon slides on in 1.1 s), and whether the star's words ask. */
  const look = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.advance(1_500)
    const band = bandOf(await ui.drawn({ in: 'sky' }))
    const isAsking = (await ui.find({ type: 'Text', text: ASKING, in: 'sky' })) !== undefined
    await ui.unmount()
    return { band, isAsking }
  }
  const clear = await look()
  expect(clear.isAsking).toBe(false)
  expect(clear.band).not.toContain(MOON)

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } })
  await clock.advance(1_000)
  const eclipsed = await look()
  expect(eclipsed.isAsking).toBe(true)
  expect(eclipsed.band).not.toBe(clear.band)
  expect(eclipsed.band).toContain(MOON)
  expect(await stillText($, ASKING)).toBeDefined()
  expect(await stillText($, CLEAR)).toBeUndefined()
  // A pane too narrow for the star gets one line under the band.
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'vscode' })
  expect(await narrow.find({ type: 'Text', text: /^ ○ waiting on you \(Bash permission\)$/ })).toBeDefined()
  await narrow.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  await clock.advance(10)
  await ui.advance(1_500)
  expect(await ui.find({ type: 'Text', text: LINE, in: 'sky' })).toBeDefined()
  expect(await stillText($, LINE)).toBeDefined()
  // Its beads keep glinting at the idle pace, though nothing else in the view moves.
  const glints = new Set<string | undefined>()
  for (let k = 0; k < 100; k++) {
    await ui.advance(100)
    glints.add(cellsOf(await ui.find({ type: 'Text', text: LINE, in: 'sky' })).find(c => c.t === '○')?.c)
  }
  expect(glints.has(undefined)).toBe(false)
  expect(glints.size).toBeGreaterThan(1)
  await ui.press({ key: 'tab-live' })
  await clock.advance(10)
  await ui.advance(100)

  // Answered: the words return at once, and the moon slides off.
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1_000)
  await ui.advance(300)
  expect(await ui.find({ type: 'Text', text: CLEAR, in: 'sky' })).toBeDefined()
  expect(bandOf(await ui.drawn({ in: 'sky' }))).toContain(MOON)
  await ui.advance(1_500)
  expect(bandOf(await ui.drawn({ in: 'sky' }))).not.toContain(MOON)
  await ui.unmount()
  expect(await look()).toEqual(clear)
  expect(await stillText($, CLEAR)).toBeDefined()
})

/** A drawn element's text, its nested Texts' joined. */
const textOf = (n: unknown): string => (typeof n === 'string' ? n : ((n as Drawn | undefined)?.children ?? []).map(textOf).join(''))
/** The header's text in a still pane `cols` wide. */
async function headerOf($: Engine, cols = 56): Promise<string> {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: cols }, surface: 'vscode' })
  const found = await ui.find({ type: 'Text', text: /^ \S constellation/ })
  await ui.unmount()
  return textOf(found)
}
test("the tour names each sky style by the title as it plays, past the run's end, and the title stands alone once the demo is over", async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  demoWorld(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await $.command.run(typed('demo tour'))
  // 1 s: the first style's caption follows the title two cells on, at any width.
  await clock.advance(1_000)
  expect(await headerOf($, 60)).toBe(' ✦ constellation  1/4 · shooting stars')
  expect(await headerOf($, 56)).toBe(' ✦ constellation  1/4 · shooting stars')
  // 15.5 s: the second style.
  await clock.advance(14_500)
  expect(await headerOf($, 60)).toBe(' ✦ constellation  2/4 · constellation map')
  // 37 s: the run has completed and the last style holds until the demo ends.
  await clock.advance(21_500)
  expect((await clientProps($))?.runs[0]?.status).toBe('completed')
  expect(await headerOf($, 60)).toMatch(/4\/4 · activity sparkline$/)
  // 39.5 s: the demo is over; the caption is gone.
  await clock.advance(2_500)
  expect(await headerOf($, 60)).toBe(' ✦ constellation')
})

test('every event shows in the demo, on terminal and vscode, to the naked eye; the telescope adds the cache shares', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000 })
  mock.env(on, { HOME })
  mock.store(on)
  demoWorld(on)
  steadyStar(on)
  await $.session.start({ cwd: `${HOME}/shop`, surface: 'terminal', isInteractive: true })
  await $.command.run(typed('demo'))
  /** The texts a pane leaves out: on terminal 1.5 s after mounting (a failure falls a second late), on vscode at once. */
  const unseen = async (...texts: RegExp[]): Promise<string[]> => {
    const missed: string[] = []
    const moving = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await moving.advance(1_500)
    expect(JSON.stringify(await moving.drawn({ in: 'sky' })).length).toBeLessThan(100_000)
    for (const text of texts) if ((await moving.find({ type: 'Text', text, in: 'sky' })) === undefined) missed.push(`terminal ${text}`)
    await moving.unmount()
    for (const text of texts) if ((await stillText($, text)) === undefined) missed.push(`vscode ${text}`)
    return missed
  }

  // 10.6 s: cache tints on `list hooks` and `list tests`; the Read that failed at 10.4 s falls beside the star.
  await clock.advance(10_600)
  expect(await unseen(/a sporadic meteor/)).toEqual([])
  // The naked eye shows tints but no detail line; the telescope shows each share.
  expect(await unseen(/cached/, /opus 5\.5/)).toEqual(['terminal /cached/', 'terminal /opus 5\\.5/', 'vscode /cached/', 'vscode /opus 5\\.5/'])
  await $.command.run(typed('detail telescope'))
  expect(await unseen(/99\.8% cached/, /55% cached/)).toEqual([])
  await $.command.run(typed('detail naked-eye'))

  // 16 s: a binary on draw.tsx, a comet on `longest in hooks` (plain stars draw no `━`), and a shower.
  await clock.advance(5_400)
  expect(await unseen(/2 agents editing hooks\/draw\.tsx/, /━/, /a meteor shower/)).toEqual([])

  // 30 s: the flaky rerun is retrograde, and the main loop waits on the person.
  await clock.advance(14_000)
  expect(await unseen(/retrograde · same Bash call ×\d/, /eclipse · waiting on you \(Write permission\)/)).toEqual([])

  // 37.5 s: answered; the run has completed.
  await clock.advance(7_500)
  expect(await unseen(/waiting on you/)).toEqual(['terminal /waiting on you/', 'vscode /waiting on you/'])
  expect((await clientProps($))?.runs[0]?.status).toBe('completed')
  // Cleared in the demo's last seconds, the run stays gone: the demo writes it once.
  await $.command.run(typed('clear'))
  await clock.advance(1_000)
  expect((await clientProps($))?.runs.length).toBe(0)

  // 40 s: the demo is over.
  await clock.advance(1_500)
  expect((await clientProps($))?.waiting ?? null).toBe(null)
})
