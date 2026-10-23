// A scripted run for `/constellation demo`, played on a fixed timeline with
// made-up figures. It spends no tokens; dev/sandbox.py drives it too.

import type { AgentStats, CacheMix, CheckEvent, RetroTracker, Run, RunAgent, Touch, Waiting } from '../types'
import { callKey, newRetroTracker, trackStep } from './events/retrograde'
import { WARM_STEPS, levelOf } from './events/shift'

/** One demo agent. `at` holds each call's demo second (else calls spread over its time); `denied` the denied calls' seconds. */
type Beat = { id: string; label: string; phase: string; start: number; end: number; tools: string[]; at?: number[]; denied?: number[]; fails?: string; bash?: string }

/** What a denied call of the demo asked for, and the rule that denied it. */
const DENIED = { bash: 'git push origin demo', by: 'rule Bash(git push:*)' }

const SECOND = 1000

// Sorted by start, so an agent's seq never changes mid-demo.
const BEATS: readonly Beat[] = [
  { id: 'demo-scout', label: 'scout the repo', phase: 'Scout', start: 0, end: 6, tools: ['Read', 'Glob', 'Read'] },
  { id: 'demo-list-a', label: 'list hooks', phase: '▸ scan-stage', start: 7, end: 12, tools: ['Bash', 'Read'] },
  { id: 'demo-count-a', label: 'count hooks', phase: '▸ scan-stage', start: 7, end: 11, tools: ['Bash'] },
  // `at` lines up with WRITES and with meteor.ts's demo failures.
  { id: 'demo-long-a', label: 'longest in hooks', phase: '▸ scan-stage', start: 7, end: 27, tools: ['Grep', 'Read', 'Edit', 'Bash', 'Read'], at: [7, 8.5, 10, 18, 24] },
  { id: 'demo-list-b', label: 'list tests', phase: '▸ scan-stage #2', start: 8, end: 13, tools: ['Glob', 'Read'] },
  { id: 'demo-long-b', label: 'longest in tests', phase: '▸ scan-stage #2', start: 8, end: 19, tools: ['Grep', 'Edit', 'Bash'], at: [8, 12, 17] },
  // `at` and `denied` match meteor.ts's demo failures.
  {
    id: 'demo-push',
    label: 'publish the branch',
    phase: '▸ scan-stage #2',
    start: 14,
    end: 22,
    tools: Array.from({ length: 8 }, () => 'Bash'),
    at: [15, 15.7, 16.1, 16.3, 17.9, 18.4, 19.6, 21.5],
    denied: [15, 19.6],
    fails: 'push denied',
    bash: 'gh pr create --fill',
  },
  // `at` matches LOOP: six identical runs, then a read that breaks the loop.
  { id: 'demo-retry', label: 'rerun the flaky test', phase: 'Wrap up', start: 22, end: 35.5, tools: [...Array.from({ length: 6 }, () => 'Bash'), 'Read'], at: [22, 24, 26, 28, 30, 32, 33.5], bash: 'npm test -- flaky' },
  { id: 'demo-sum', label: 'summarize for the README', phase: 'Wrap up', start: 28, end: 34, tools: ['Read', 'Write'] },
]

export const DEMO_MS = 36 * SECOND
/** How long the demo plays: a few seconds past the run's end, so its finished tree shows. */
export const DEMO_END_MS = 39 * SECOND

const MODEL = 'claude-opus-5-5'

/** Recent cache share by demo second, for the beats that shift; the rest stay at rest (97%). */
const CACHED: Record<string, (s: number) => number> = {
  'demo-list-a': s => (s >= 7.5 ? 0.9985 : 0.97), // blueshift
  'demo-list-b': s => (s >= 8.5 ? 0.55 : 0.97), // redshift
}

/** A made-up cache mix whose recent share is `share`, over `steps` steps. */
const mixAt = (share: number, steps: number): CacheMix => ({
  steps,
  read: Math.round(steps * 30_000 * share),
  write: Math.round(steps * 30_000 * (1 - share)),
  fresh: steps * 3,
  recentRead: Math.round(80_000 * share),
  recentMiss: Math.round(80_000 * (1 - share)),
  level: levelOf(share),
})

/** The beat that repeats one call: stationary at the third (26 s), retrograde from the fourth (28 s), direct at the read (33.5 s). */
const LOOP = { id: 'demo-retry', calls: { Bash: callKey('Bash', { command: 'npm test -- flaky' }), Read: callKey('Read', { file_path: 'hooks/register.tsx' }) } as Record<string, string> }

/** The looping beat's tracker `s` seconds in and its last call's time; null for other beats and once done. */
function loopOf(b: Beat, s: number, startedAt: number): { tracker: RetroTracker; lastAt: number } | null {
  if (b.id !== LOOP.id || s >= b.end || !b.at) return null
  const made = b.at.filter(c => c <= s)
  let tracker = newRetroTracker()
  made.forEach((c, k) => {
    tracker = trackStep(tracker, { at: startedAt + c * SECOND, calls: [LOOP.calls[b.tools[k] ?? ''] ?? ''] })
  })
  return { tracker, lastAt: startedAt + (made.at(-1) ?? b.start) * SECOND }
}

/** The file both `longest in …` beats write, and when: a binary star from 12 s to 19 s. */
const DEMO_FILE = '/demo/constellation/hooks/draw.tsx'
const WRITES: Record<string, number> = { 'demo-long-a': 10, 'demo-long-b': 12 }

/** A beat's writes `s` seconds in; undefined for beats that write nothing. */
function filesOf(b: Beat, s: number, startedAt: number): Touch[] | undefined {
  const w = WRITES[b.id]
  if (w === undefined || s < w) return undefined
  const at = startedAt + w * SECOND
  return [{ path: DEMO_FILE, first: at, at }]
}

/** When the main loop waits for permission to write the README: an eclipse. */
const ASK = { from: 29, to: 33.5 }

/** The demo run `elapsed` ms in, with its agents' stats, permission checks and what it waits on. */
export function demoAt(
  id: string,
  startedAt: number,
  elapsed: number,
): { run: Run; stats: Record<string, AgentStats>; checks: Record<string, CheckEvent[]>; waiting: Waiting | null } {
  const s = elapsed / SECOND
  const agents: RunAgent[] = []
  const stats: Record<string, AgentStats> = {}
  const checks: Record<string, CheckEvent[]> = {}
  BEATS.filter(b => s >= b.start).forEach((b, seq) => {
    const isDone = s >= b.end
    const share = Math.min(1, (s - b.start) / (b.end - b.start))
    // Counted by calls, so `same Bash call ×n` and `n tools` agree.
    const used = b.at ? b.at.filter(c => c <= s).length : Math.max(1, Math.ceil(share * b.tools.length))
    agents.push({
      id: b.id,
      label: b.label,
      phase: b.phase,
      seq,
      status: isDone ? (b.fails ? 'failed' : 'done') : 'running',
      seenAt: startedAt + b.start * SECOND,
      doneAt: isDone ? startedAt + b.end * SECOND : null,
      startLine: seq * 2,
      doneLine: isDone ? seq * 2 + 1 : null,
      model: null,
      tokens: null,
      tools: null,
      lastTool: null,
      startedAt: startedAt + b.start * SECOND,
      durationMs: isDone ? (b.end - b.start) * SECOND : null,
      error: isDone && b.fails ? b.fails : null,
    })
    const loop = loopOf(b, s, startedAt)
    stats[b.id] = {
      model: MODEL,
      effort: 'xhigh',
      tokens: Math.round(24_000 + share * 30_000),
      costUsd: 0.08 + share * 0.9,
      tools: used,
      lastTool: b.tools[used - 1] ?? null,
      firstAt: startedAt + b.start * SECOND,
      lastAt: loop?.lastAt ?? startedAt + Math.min(s, b.end) * SECOND,
      endedAt: isDone ? startedAt + b.end * SECOND : null,
      endReason: isDone ? (b.fails ? 'error' : 'answer') : null,
      // Past the warm-up from the start, so a tint shows at once.
      cache: mixAt(CACHED[b.id]?.(s) ?? 0.97, used + WARM_STEPS),
      files: filesOf(b, s, startedAt),
      ...(loop ? { tracker: loop.tracker } : {}),
    }
    const secondOf = (k: number) => b.at?.[k] ?? b.start + k
    const at = (k: number) => startedAt + secondOf(k) * SECOND
    checks[b.id] = b.tools.slice(0, used).map((tool, k) => {
      const isDenied = b.denied?.includes(secondOf(k)) ?? false
      return {
        tool,
        summary: isDenied ? DENIED.bash : tool === 'Bash' ? (b.bash ?? 'wc -l hooks/*.ts') : tool === 'Edit' ? 'hooks/draw.tsx' : 'hooks/register.tsx',
        decision: isDenied ? 'deny' : 'allow',
        by: isDenied ? DENIED.by : 'auto mode',
        at: at(k),
      }
    })
  })
  const isOver = elapsed >= DEMO_MS
  return {
    run: {
      id,
      name: 'constellation-demo',
      description: 'A scripted run: a scout, two scan-stage child workflows, a denied push and a summary',
      phases: [
        { title: 'Scout', detail: 'one agent maps the repo' },
        { title: 'Fan out', detail: 'two scan-stage child workflows, one per folder' },
        { title: 'Wrap up', detail: 'the summary, and a flaky test rerun' },
      ],
      status: isOver ? 'completed' : 'running',
      startedAt,
      durationMs: isOver ? DEMO_MS : null,
      agents,
      childParents: {},
      scriptPath: null,
      hasMeta: true,
      hasFolder: true,
      isFinal: isOver,
      journalBytes: 0,
      journalAt: null,
    },
    stats,
    checks,
    waiting: s >= ASK.from && s < ASK.to ? { since: startedAt + ASK.from * SECOND, reason: 'permission', tool: 'Write', summary: 'README.md', count: 1 } : null,
  }
}
