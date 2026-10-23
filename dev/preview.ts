// Plays a preview module's scenes in a real terminal, so pure drawing modules
// can be judged as the terminal paints them. Dev only: the mod never loads it.
//
//   bun dev/preview.ts <previewModule.ts> [--for SECONDS] [--only TEXT] [--check]
//
// A preview module exports `scenes: Scene[]`. Cell colors are hex or a theme
// key; a cell without `c` or `bg` keeps the terminal's own colors. --for stops
// after SECONDS (default 30); --only keeps scenes whose name contains TEXT
// (comma-separated); --check draws every frame without painting, reports each
// scene's size, cost and problems, and exits 1 if there are any.
//
// Also exports a mock kit that copies hooks/draw.tsx's tree rows.

import type { Cell } from '../hooks/skies'
import { HEX, breathe, mix, quantize, shimmer } from '../hooks/motion'

/** hooks/skies.ts's Cell, optionally dim. */
export type PreviewCell = Cell & { dim?: boolean }

export type Scene = {
  name: string
  note?: string
  /** The rows at `t` ms since the preview started; every cell one column wide. */
  draw: (t: number) => PreviewCell[][]
}

/** Claude Code's dark theme, as captured from the real pane's ANSI output. */
export const THEME: Readonly<Record<string, string>> = {
  text: '#ffffff',
  inverseText: '#000000',
  inactive: '#999999',
  subtle: '#505050',
  suggestion: '#b1b9f9',
  remember: '#b1b9f9',
  permission: '#b1b9f9',
  success: '#4eba65',
  error: '#ff6b80',
  warning: '#ffc107',
  merged: '#af87ff',
  autoAccept: '#af87ff',
  claude: '#d77757',
  planMode: '#48968c',
  promptBorder: '#888888',
  bashBorder: '#fd5db1',
  ide: '#4782c8',
}

// ---------------------------------------------------------------- the mock kit

const ORBIT = [...'◐◓◑◒']
const SPIN = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']
const TWINKLE = [...'✦✶✷✸✹✸✷✶']

const at = <T>(list: readonly T[], i: number): T => list[((Math.floor(i) % list.length) + list.length) % list.length] as T

function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** draw.tsx's seed of a key, so a mocked moon has the same phase as in the pane. */
export const seedOf = (key: string) => [...key].reduce((h, ch) => hash(h + (ch.codePointAt(0) ?? 0)), 7)

/** One cell per character of `text`, all in one style. */
export const cells = (text: string, style: Omit<PreviewCell, 't'> = {}): PreviewCell[] => [...text].map(ch => ({ ...style, t: ch }))

/** A row `width` cells wide, laid out like draw.tsx's row(): the label cut to fit between `left` and `right`. */
export function line(width: number, left: PreviewCell[], label: PreviewCell[], right: PreviewCell[], fill: ' ' | '·' = ' '): PreviewCell[] {
  const room = width - left.length - right.length - (right.length > 0 ? 1 : 0)
  const text = label.length <= room ? label : [...label.slice(0, Math.max(0, room - 1)), ...(room > 0 ? [{ ...label[room - 1], t: '…' }] : [])]
  const pad = Math.max(0, room - text.length) + (right.length > 0 ? 1 : 0)
  const gap = fill === '·' && pad >= 4 && right.length > 0 ? cells(` ${'·'.repeat(pad - 2)} `, { c: 'subtle', dim: true }) : cells(' '.repeat(pad))
  return [...left, ...text, ...gap, ...right]
}

/** A running agent's orbiting, breathing moon. */
export const moon = (t: number, id: string): PreviewCell => ({
  t: at(ORBIT, t / 150),
  c: mix(HEX.live, HEX.glow, quantize(breathe(t, 1400, (seedOf(id) % 100) / 100), 6)),
})

/** A label lit by a running agent's sweeping band. */
export function shimmerCells(text: string, t: number, seed: number): PreviewCell[] {
  const chars = [...text]
  return chars.map((ch, i) => {
    const lit = quantize(shimmer(i, chars.length, t + (seed % 1300)), 5)
    return lit > 0.1 ? { t: ch, c: mix(HEX.ink, HEX.shine, lit) } : { t: ch }
  })
}

/** A node's counts as draw.tsx's countSegs writes them: `2● 1◐ 1✗`. */
export function counts(done: number, running: number, failed = 0): PreviewCell[] {
  const parts: PreviewCell[][] = []
  if (done > 0) parts.push(cells(`${done}●`, { c: 'success' }))
  if (running > 0) parts.push(cells(`${running}◐`, { c: 'claude' }))
  if (failed > 0) parts.push(cells(`${failed}✗`, { c: 'error' }))
  return parts.flatMap((p, i) => (i > 0 ? [{ t: ' ' }, ...p] : p))
}

export type MockAgent = {
  /** Seeds its moon's phase and its label's shimmer. */
  id: string
  label: string
  status?: 'running' | 'done' | 'failed'
  /** Running: the tool on the right ('thinking' when absent). Failed: the error. */
  tool?: string
  /** Elapsed time as the pane writes it, e.g. '0:42'. */
  took?: string
  /** Done: the cost as the pane writes it, e.g. '$0.12'. */
  cost?: string
}

/** An agent row in pieces, so an event can swap the glyph or recolor the rails before joining it. */
export type RowParts = { left: PreviewCell[]; glyph: PreviewCell; label: PreviewCell[]; right: PreviewCell[] }

/** An agent row's pieces as draw.tsx's agentLines draws them; `prefix` precedes the connector (' │  ' under a phase, ' ' under the run). */
export function agentParts(a: MockAgent, t: number, prefix = ' │  ', isLast = false): RowParts {
  const status = a.status ?? 'running'
  const left = cells(`${prefix}${isLast ? '╰─' : '├─'}`, { c: HEX.rail })
  const took = a.took ? cells(` ${a.took}`, { dim: true }) : []
  if (status === 'running') {
    const tool = [...(a.tool ?? 'thinking')].slice(0, 14).join('')
    return { left, glyph: moon(t, a.id), label: shimmerCells(` ${a.label}`, t, seedOf(a.id)), right: [{ t: at(SPIN, t / 80), c: 'suggestion' }, ...cells(` ${tool}`, { c: 'suggestion' }), ...took] }
  }
  if (status === 'failed') return { left, glyph: { t: '✗', c: 'error' }, label: cells(` ${a.label}`), right: [...cells(a.tool ?? 'failed', { c: 'error' }), ...took] }
  const cost = a.cost ? cells(`${a.cost}${a.took ? ' ' : ''}`, { c: 'warning' }) : []
  return { left, glyph: { t: '●', c: 'success' }, label: cells(` ${a.label}`), right: [...cost, ...(a.took ? cells(a.took, { dim: true }) : [])] }
}

/** Joins an agent row's pieces into a row `width` cells wide. */
export const joinParts = (p: RowParts, width: number): PreviewCell[] => line(width, [...p.left, p.glyph], p.label, p.right)

/** An agent row, `width` cells wide. */
export const agentRow = (a: MockAgent, t: number, width: number, prefix = ' │  ', isLast = false): PreviewCell[] =>
  joinParts(agentParts(a, t, prefix, isLast), width)

/** A running agent's detail line: `facts` joined by dim dots, indented under its row. */
export function detailRow(width: number, facts: PreviewCell[][], prefix = ' │  ', isLast = false): PreviewCell[] {
  const indent = cells(`${prefix}${isLast ? '   ' : '│  '}  `, { c: HEX.rail })
  const body = facts.flatMap((f, i) => (i > 0 ? [...cells(' · ', { c: 'subtle', dim: true }), ...f] : f))
  return [...indent, ...body].slice(0, width)
}

/** A phase row (◉), breathing while it runs, with a dotted leader to `right`. */
export function phaseRow(t: number, title: string, width: number, right: PreviewCell[], status: 'running' | 'done' | 'pending' = 'running', isLast = false): PreviewCell[] {
  const swell = quantize(breathe(t, 1700, (seedOf(title) % 100) / 100), 6)
  const glyph: PreviewCell =
    status === 'running' ? { t: '◉', c: mix(HEX.live, HEX.glow, swell) } : status === 'done' ? { t: '◉', c: 'success' } : { t: '○', c: 'inactive' }
  const left = [...cells(` ${isLast ? '╰─' : '├─'}`, { c: HEX.rail }), glyph]
  return line(width, left, cells(` ${title}`, { bold: status === 'running', dim: status === 'pending' }), right, '·')
}

/** A live run's title row: a twinkling star, the name in bold, then `right`. */
export function runRow(t: number, name: string, width: number, right: PreviewCell[]): PreviewCell[] {
  const star: PreviewCell = { t: at(TWINKLE, t / 130), c: mix(HEX.live, HEX.glow, quantize(breathe(t, 2000), 6)), bold: true }
  return line(width, [{ t: ' ' }, star], cells(` ${name}`, { bold: true }), right)
}

/** A live run's spinner and time, for runRow's right side. */
export const runMark = (t: number, took: string): PreviewCell[] => [...cells(` ${at(SPIN, t / 80)}`, { c: 'claude' }), ...cells(` ${took}`, { dim: true })]

/** The run's own rail, alone on a row. */
export const railRow = (): PreviewCell[] => cells(' │', { c: HEX.rail })

// ---------------------------------------------------------------- the runner

type Out = { write(s: string): unknown; columns?: number; rows?: number }
type Proc = {
  argv: string[]
  cwd(): string
  exit(code?: number): never
  on(signal: string, fn: () => void): void
  stdout: Out
  stderr: Out
}
type Timers = {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(id: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
}

// Annotated, so TypeScript knows `proc.exit` never returns.
const proc: Proc = (globalThis as unknown as { process: Proc }).process
const timers = globalThis as unknown as Timers
const clock = (globalThis as unknown as { performance: { now(): number } }).performance

const FRAME_MS = 33
const ESC = '\x1b['

/** '38;2;r;g;b'-style digits of a color, or null when it is neither hex nor a theme key. */
function rgbOf(color: string): string | null {
  const hex = color.startsWith('#') ? color : THEME[color]
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null
  const n = Number.parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`
}

function sgr(cell: PreviewCell): string {
  const parts = ['0']
  if (cell.bold) parts.push('1')
  if (cell.dim) parts.push('2')
  const fg = cell.c ? rgbOf(cell.c) : null
  const bg = cell.bg ? rgbOf(cell.bg) : null
  if (fg) parts.push(`38;2;${fg}`)
  if (bg) parts.push(`48;2;${bg}`)
  return `${ESC}${parts.join(';')}m`
}

/** A row as ANSI text, at most `room` cells, a new SGR only where the style changes. */
function ansiOf(row: readonly PreviewCell[], room: number): string {
  let out = ''
  let last = ''
  for (const cell of row.slice(0, room)) {
    const style = sgr(cell)
    if (style !== last) out += style
    last = style
    out += cell.t
  }
  return out
}

/** What a scene draws at `t`, or the error it threw. */
function safeDraw(scene: Scene, t: number): { rows: PreviewCell[][]; error: string | null } {
  try {
    return { rows: scene.draw(t), error: null }
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) }
  }
}

type Watch = { widths: number[] | null; warning: string | null }

function caption(scene: Scene, watch: Watch, error: string | null): PreviewCell[] {
  const out = cells(scene.name, { c: HEX.calm })
  if (scene.note) out.push(...cells(`  ${scene.note}`, { c: HEX.rail }))
  const alarm = error ? `threw: ${error}` : watch.warning
  if (alarm) out.push(...cells(`  ⚠ ${alarm}`, { c: HEX.hot }))
  return out
}

/** Warns, once, about the first row whose width differs from the first frame's. */
function watchWidths(watch: Watch, rows: readonly PreviewCell[][]) {
  const widths = rows.map(r => r.length)
  if (watch.widths === null) {
    watch.widths = widths
    return
  }
  if (watch.warning) return
  const i = widths.findIndex((w, k) => watch.widths?.[k] !== undefined && w !== watch.widths[k])
  if (i >= 0) watch.warning = `row ${i} width changed ${watch.widths[i]}→${widths[i]}`
}

/** One frame as ANSI text, and how many rows it took. */
function paintFrame(scenes: readonly Scene[], watches: Watch[], t: number): { text: string; height: number } {
  const cols = proc.stdout.columns ?? 120
  const rows = proc.stdout.rows ?? 40
  const lines: PreviewCell[][] = []
  scenes.forEach((scene, i) => {
    const drawn = safeDraw(scene, t)
    const watch = watches[i] as Watch
    watchWidths(watch, drawn.rows)
    if (i > 0) lines.push([])
    lines.push(caption(scene, watch, drawn.error), ...drawn.rows)
  })
  if (lines.length > rows) {
    const hidden = lines.length - rows + 1
    lines.splice(rows - 1, lines.length, cells(`… ${hidden} more rows: a taller window, or --only`, { c: HEX.hot }))
  }
  // One column short: a full row leaves a pending wrap, and erasing the line would eat its last cell.
  let out = `${ESC}?2026h`
  lines.forEach((row, y) => {
    out += `${ESC}${y + 1};1H${ansiOf(row, cols - 1)}${ESC}0m${ESC}K`
  })
  // Erase what a taller frame left; not when full, where the cursor would clamp onto the last row.
  if (lines.length < rows) out += `${ESC}${lines.length + 1};1H${ESC}0m${ESC}J`
  return { text: `${out}${ESC}?2026l`, height: lines.length }
}

function play(scenes: readonly Scene[], seconds: number) {
  const watches: Watch[] = scenes.map(() => ({ widths: null, warning: null }))
  const start = Date.now()
  let size = ''
  let timer: unknown = null
  let height = 0
  const stop = (code: number) => {
    if (timer !== null) timers.clearInterval(timer)
    // Park the cursor under the last frame so the frame stays on screen.
    proc.stdout.write(`${ESC}0m${ESC}?25h${ESC}${Math.min(height + 1, proc.stdout.rows ?? height + 1)};1H`)
    proc.exit(code)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) proc.on(signal, () => stop(130))
  const tick = () => {
    const now = `${proc.stdout.columns}x${proc.stdout.rows}`
    const clear = now !== size ? `${ESC}2J` : ''
    size = now
    const frame = paintFrame(scenes, watches, Date.now() - start)
    height = frame.height
    proc.stdout.write(clear + frame.text)
  }
  proc.stdout.write(`${ESC}?25l${ESC}2J`)
  tick()
  timer = timers.setInterval(tick, FRAME_MS)
  timers.setTimeout(() => stop(0), seconds * 1000)
}

/** Whether a cell's text is one character a terminal draws one column wide. */
function isNarrow(text: string): boolean {
  const chars = [...text]
  if (chars.length !== 1) return false
  const cp = chars[0]?.codePointAt(0) ?? 0
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return false
  if (/[\p{M}\p{Emoji_Presentation}\uFE0F\u200B-\u200F]/u.test(text)) return false
  const wide: [number, number][] = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
    [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
  ]
  return !wide.some(([a, b]) => cp >= a && cp <= b)
}

const styleKey = (c: PreviewCell) => `${c.c ?? ''}|${c.bg ?? ''}|${c.bold ? 1 : 0}|${c.dim ? 1 : 0}`

/** Draws every scene at every frame of `seconds`, painting nothing; reports sizes, cost and problems. */
function check(scenes: readonly Scene[], seconds: number): number {
  let failed = 0
  for (const scene of scenes) {
    // Keyed by kind and place, so each problem is reported once.
    const problems = new Map<string, string>()
    const note = (key: string, text: string) => {
      if (!problems.has(key)) problems.set(key, text)
    }
    let widths: number[] | null = null
    let maxRows = 0
    let minRows = Number.POSITIVE_INFINITY
    let maxWidth = 0
    let maxRuns = 0
    let maxColors = 0
    let spent = 0
    let frames = 0
    for (let t = 0; t <= seconds * 1000; t += FRAME_MS) {
      const began = clock.now()
      const drawn = safeDraw(scene, t)
      spent += clock.now() - began
      frames += 1
      if (drawn.error) {
        note('threw', `threw at t=${t}: ${drawn.error}`)
        continue
      }
      const rows = drawn.rows
      maxRows = Math.max(maxRows, rows.length)
      minRows = Math.min(minRows, rows.length)
      const colors = new Set<string>()
      rows.forEach((row, y) => {
        maxWidth = Math.max(maxWidth, row.length)
        let runs = 0
        let last = ''
        for (const [x, cell] of row.entries()) {
          if (typeof cell?.t !== 'string' || !isNarrow(cell.t)) note(`char ${y} ${x}`, `row ${y} col ${x}: ${JSON.stringify(cell?.t)} at t=${t} is not one narrow character`)
          for (const color of [cell?.c, cell?.bg]) {
            if (color === undefined) continue
            if (rgbOf(color) === null) note(`color ${color}`, `row ${y} col ${x}: color ${JSON.stringify(color)} is neither #rrggbb nor a theme key`)
            colors.add(color)
          }
          const key = styleKey(cell)
          if (key !== last) runs += 1
          last = key
        }
        maxRuns = Math.max(maxRuns, runs)
      })
      maxColors = Math.max(maxColors, colors.size)
      const now = rows.map(r => r.length)
      if (widths === null) widths = now
      else {
        const y = now.findIndex((w, k) => widths?.[k] !== undefined && w !== widths[k])
        if (y >= 0) note(`width ${y}`, `row ${y} width changes with t (${widths[y]} at t=0, ${now[y]} at t=${t})`)
      }
      if (JSON.stringify(rows) !== JSON.stringify(safeDraw(scene, t).rows)) note('pure', `t=${t} draws differently the second time: is it pure in t?`)
    }
    const rowsText = minRows === maxRows ? `${maxRows} rows` : `${minRows}-${maxRows} rows`
    const cost = (spent / Math.max(1, frames)).toFixed(3)
    proc.stdout.write(`${scene.name}: ${rowsText} × ${maxWidth} cols, ≤${maxRuns} runs a row, ≤${maxColors} colors a frame, ${cost} ms a draw over ${frames} frames\n`)
    for (const p of [...problems.values()].slice(0, 12)) proc.stdout.write(`  problem: ${p}\n`)
    if (problems.size > 12) proc.stdout.write(`  … ${problems.size - 12} more problems\n`)
    if (problems.size > 0) failed += 1
  }
  proc.stdout.write(failed > 0 ? `${failed} of ${scenes.length} scenes have problems\n` : `${scenes.length} scenes, no problems\n`)
  return failed > 0 ? 1 : 0
}

const USAGE = 'usage: bun dev/preview.ts <previewModule.ts> [--for SECONDS] [--only TEXT[,TEXT...]] [--check]\n'

async function main() {
  const args = proc.argv.slice(2)
  let file: string | null = null
  let seconds = 30
  let only: string[] = []
  let isCheck = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--for') seconds = Number(args[++i])
    else if (arg === '--only') only = (args[++i] ?? '').toLowerCase().split(',').filter(Boolean)
    else if (arg === '--check') isCheck = true
    else if (arg.startsWith('--') || file !== null) {
      proc.stderr.write(USAGE)
      proc.exit(2)
    } else file = arg
  }
  if (file === null || !Number.isFinite(seconds) || seconds <= 0) {
    proc.stderr.write(USAGE)
    proc.exit(2)
  }
  const path = file.startsWith('/') ? file : `${proc.cwd()}/${file}`
  const loaded = (await import(path)) as { scenes?: unknown }
  if (!Array.isArray(loaded.scenes)) {
    proc.stderr.write(`${file} exports no \`scenes\` array\n`)
    proc.exit(2)
  }
  const all = loaded.scenes as Scene[]
  const scenes = only.length > 0 ? all.filter(s => only.some(o => s.name.toLowerCase().includes(o))) : all
  if (scenes.length === 0) {
    proc.stderr.write(`no scene matches --only ${only.join(',')}; scenes: ${all.map(s => s.name).join(', ')}\n`)
    proc.exit(2)
  }
  if (isCheck) proc.exit(check(scenes, seconds))
  play(scenes, seconds)
}

// Only as the entry point, so preview modules can import the mock kit.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch((e: unknown) => {
    proc.stdout.write(`${ESC}0m${ESC}?25h`)
    proc.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    proc.exit(1)
  })
}
