import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createInterface } from 'node:readline/promises'
import { emitKeypressEvents } from 'node:readline'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * @dsh-tui-app — interactive terminal chat driver in the style of Claude
 * Code. On a TTY the bottom of the screen holds a bordered input bar; below
 * it sit the config row (model, effort, permission, step) and the token row
 * (in/out, cache hit, cwd, clock), plus a `/` command menu with arrow/tab
 * completion covering the local commands, the app registry's slash commands
 * (the web surface's /compact /goal /feedback /export …), and user-invocable
 * skills exposed by the active Agent Preset.
 * Shift+Tab cycles the session's permission preset. The turn streams above
 * the bar (tool rows, reasoning, assistant text). On a pipe it falls back to
 * a plain line loop.
 *
 * Rendering contract (the part that keeps the display clean):
 * - Everything above the bar is modeled: completed styled lines live in
 *   `transcript`, the in-flight partial line in `pending`. All output funnels
 *   through emit()/paint(), which keep the model in sync.
 * - The bar is a block of `menu + box` rows drawn in one write; afterwards
 *   the cursor rests ON the input row. hide() walks the cursor up over the
 *   rows above the input row plus the pending line's physical rows, then
 *   erases to end-of-screen and rewrites the pending line, so streaming can
 *   resume mid-line without duplication.
 * - Window resizes reflow the terminal's own rows, so row-count math cannot
 *   be trusted across a width change. onResize() therefore rebuilds the whole
 *   screen from the model (clear + reprint the transcript tail + pending +
 *   bar) in a single write, throttled while the user is dragging.
 *
 * Commands: /help /sessions /resume <id> /new [preset] /preset [id] /exit plus the app registry's
 * slash commands. Keys: enter send, up/down history, tab complete, shift+tab
 * cycle permission, esc interrupt/clear, ctrl+c interrupt (idle: quit),
 * ctrl+l clear, ctrl+u clear input, ctrl+d quit.
 *
 * @module dsh-tui-app
 */

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive loop can start. */
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'attachments', 'llm', 'sessions', 'sessionPersistence', 'sessionController', 'commands', 'permissionPresets', 'skills']

export const Config = z.object({ resume: z.string(), preset: z.string(), images: z.array(z.string()).default([]) })

/** The process streams the runner writes to; tests substitute captures. */
const internals = {
  stdout: process.stdout,
  stderr: process.stderr
}

// ── color / style helpers ───────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = (text) => paint('2', text)
const dimItalic = (text) => paint('2;3', text)
const red = (text) => paint('31', text)
const green = (text) => paint('32', text)
const cyan = (text) => paint('36', text)
/** Claude-style coral accent. */
const accent = (text) => paint('38;2;217;119;87', text)
const accentBold = (text) => paint('1;38;2;217;119;87', text)
/** Border gray, subtler than dim on dark themes. */
const subtle = (text) => paint('38;5;243', text)

/** Approximate terminal display width of one code point (East Asian = 2). */
function charWidth(char) {
  const code = char.codePointAt(0)
  if (
    code === 0x200d || // ZWJ
    (code >= 0x300 && code <= 0x36f) || // combining diacritics
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  ) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) return 2
  return 1
}

/** Visible width of a string with ANSI SGR codes stripped. */
function visibleLen(text) {
  let width = 0
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, '')) width += charWidth(char)
  return width
}

/** Truncate to a visible-width budget, keeping ANSI codes intact. */
function truncateVisible(text, max) {
  let out = ''
  let width = 0
  let i = 0
  while (i < text.length) {
    if (text[i] === '\x1b') {
      const end = text.indexOf('m', i)
      if (end === -1) break
      out += text.slice(i, end + 1)
      i = end + 1
      continue
    }
    const w = charWidth(text[i])
    if (width + w > max) break
    out += text[i]
    width += w
    i += 1
  }
  return out + (out.includes('\x1b') ? '\x1b[0m' : '')
}

/** Physical screen rows a styled line occupies once written (wrapping). */
function physicalRows(text, columns) {
  const width = visibleLen(text)
  if (width === 0) return text === '' ? 0 : 1
  return Math.max(1, Math.ceil(width / columns))
}

const TOOL_ICONS = {
  bash: '⚙️',
  pwsh: '⚙️',
  read: '📋',
  write: '✏️',
  edit: '✏️',
  glob: '🔍',
  grep: '🔍',
  search: '🔍',
  web_search: '🌐',
  web: '🌐',
  subagent: '🔄',
  subagent_fork: '🔄',
  workflow: '🔄'
}

function toolIcon(name) {
  const key = String(name ?? '').split(/[_-]/).pop().toLowerCase()
  return TOOL_ICONS[key] ?? '📦'
}

/** First line of a bash/pwsh argument JSON, for the tool row label. */
function commandPreview(args) {
  if (args === undefined || args === null) return ''
  const raw = typeof args === 'string' ? args : JSON.stringify(args)
  try {
    const parsed = JSON.parse(raw)
    const cmd = parsed.command ?? parsed.cmdline
    if (typeof cmd === 'string') return cmd.replace(/\s+/g, ' ').trim().slice(0, 70)
  } catch {
    // not JSON — ignore
  }
  return ''
}

/** One-line preview of a tool result's first text block. */
function resultPreview(message) {
  const block = message?.content?.find((item) => item.type === 'text' || item.type === 'tool-result')
  let text
  if (block?.type === 'tool-result') {
    text = block.content?.find((item) => item.type === 'text')?.text
  } else {
    text = block?.text
  }
  if (typeof text !== 'string' || text === '') return ''
  return text.replace(/\s+/g, ' ').trim().slice(0, 90)
}

function shortId(id) {
  return id.length > 8 ? `…${id.slice(-8)}` : id
}

function clock() {
  const now = new Date()
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

function homePath(path) {
  const home = process.env.HOME
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function formatTokens(count) {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(count)
}

const PERMISSION_LABELS = {
  'danger-full-access': 'full access',
  'workspace-write': 'workspace write',
  'read-only': 'read only'
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⦇', '⦧', '⦏', '⦠']

/** Build the UI-only Guardian block. Audit data never enters an agent message. */
function guardianFeedback(view) {
  if (view?.active !== true || view.lastAudit === undefined) return undefined
  const audit = view.lastAudit
  const verdict = audit.errorCode ?? audit.verdict ?? view.lastVerdict ?? 'unknown'
  const tone = audit.errorCode !== undefined || verdict === 'warning' || verdict === 'critical' || view.paused
    ? 'error'
    : verdict === 'pass' ? 'success' : 'info'
  const lines = [
    `◆ Guardian #${audit.sequence ?? view.auditSequence} · ${String(verdict).toUpperCase()} · ${audit.durationMs ?? 0} ms`,
    `  audit ${audit.id ?? '—'} · trace ${audit.traceFrom ?? '—'}→${audit.traceTo ?? view.traceCursor ?? '—'}`
  ]
  if (audit.summary) lines.push(`  ${audit.summary}`)
  for (const finding of audit.findings ?? []) {
    const recommendation = finding?.recommendation ?? finding?.message
    if (recommendation) lines.push(`  ↳ ${recommendation}`)
  }
  if (audit.errorCode) lines.push(`  reviewer error: ${audit.errorCode}${audit.message ? ` · ${audit.message}` : ''}`)
  const approval = view.pendingApproval?.status === 'pending' ? view.pendingApproval : undefined
  const retryable = view.remediation !== undefined && ['failed', 'execution-failed', 'verification-failed'].includes(view.remediation.phase)
  if (approval?.verdict === 'warning') lines.push('  REVIEW · a execute · e edit & execute · runs after current tool call')
  if (approval?.verdict === 'critical') lines.push('  PAUSED · a execute now · e edit & execute now · c copy feedback')
  else if (retryable) lines.push('  PAUSED · a retry · e edit & retry · c copy feedback')
  else if (view.paused && view.remediation?.phase !== 'completed') lines.push('  PAUSED · repair in progress · c copy feedback · Esc/Ctrl+C stop')
  else if (view.paused) lines.push('  PAUSED · c copy feedback · r resume · Esc/Ctrl+C stop')
  if (view.remediation !== undefined) lines.push(`  REMEDIATION · ${view.remediation.phase} · ${view.remediation.id}`)
  return {
    id: [audit.id ?? audit.sequence, approval?.status, view.remediation?.phase, view.paused].join(':'),
    tone,
    text: lines.join('\n')
  }
}

// ── the bordered input bar (TTY) ────────────────────────────────────────────

const LOCAL_COMMANDS = [
  { name: '/help', desc: 'show this help' },
  { name: '/image', desc: 'attach images · macOS clipboard: Ctrl+V', takesArg: true },
  { name: '/sessions', desc: 'list persisted sessions' },
  { name: '/resume', desc: 'resume a session  ·  ↑/↓ pick · ⌫ delete', takesArg: true },
  { name: '/preset', desc: 'choose preset before the first turn  ·  ↑/↓ pick', takesArg: true },
  { name: '/new', desc: 'start a fresh session, optionally with a preset', takesArg: true },
  { name: '/exit', desc: 'quit' }
]

/** App-command rows shown beside TUI-local commands. */
function registryMenuCommands(commands, agent) {
  return (commands?.list(agent) ?? [])
    .map((command) => ({ name: `/${command.name}`, desc: command.description, takesArg: command.input !== undefined }))
    .filter((item) => !LOCAL_COMMANDS.some((local) => local.name === item.name))
}

/** Web-parity rows for skills a human may invoke explicitly. */
function skillMenuCommands(summaries) {
  return summaries
    .filter((skill) => skill.invocation?.userInvocable === true)
    .map((skill) => ({
      name: `/${skill.name}`,
      desc: skill.invocation.modelInvocable ? skill.description : `user-only · ${skill.description}`,
      takesArg: true
    }))
}

/** Host commands deliberately win names shared with a skill. */
function mergedMenuCommands(commands, agent, summaries) {
  const registry = registryMenuCommands(commands, agent)
  const occupied = new Set([...LOCAL_COMMANDS, ...registry].map((item) => item.name))
  const skills = skillMenuCommands(summaries).filter((item) => !occupied.has(item.name))
  return [...LOCAL_COMMANDS, ...registry, ...skills]
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Match the host tool-skill gesture grammar, including multiple references. */
function invokedSkillNames(text) {
  const names = []
  const gesture = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
  for (const match of text.matchAll(gesture)) {
    const skillName = match[2]
    if (skillName !== undefined && !names.includes(skillName)) names.push(skillName)
  }
  return names
}

function hasUserInvocableSkill(summaries, text) {
  const names = new Set(invokedSkillNames(text))
  return summaries.some((skill) => names.has(skill.name) && skill.invocation?.userInvocable === true)
}

/**
 * Screen manager: a Claude Code-style bordered input bar pinned to the bottom
 * of the terminal, with a transcript model above it. See the module docstring
 * for the rendering contract. In non-TTY mode the bar is disabled and every
 * primitive writes straight through.
 * @param io - process streams.
 * @param status - live status object (model, effort, permission, tokens, …).
 * @param initialMenuCommands - slash-command menu entries (local + app registry).
 */
function makeScreen(io, status, initialMenuCommands = LOCAL_COMMANDS) {
  const out = io.stdout
  const enabled = process.stdin.isTTY && process.stdout.isTTY
  const width = () => Math.max(10, process.stdout.columns ?? 100)
  const height = () => Math.max(4, process.stdout.rows ?? 24)

  // ── transcript model (everything above the bar) ──────────────────────────
  const MAX_TRANSCRIPT = 5000
  const transcript = []
  let pending = ''

  // ── bar state ────────────────────────────────────────────────────────────
  let drawn = false
  let widthAtDraw = 0
  let inputRowIndex = 1 // index of the input row inside the drawn block
  let blockRows = 5
  let menu = []
  let menuIndex = 0
  let menuCommands = initialMenuCommands
  // Selection picker (/model, /effort): a fixed menu with ↑/↓ + enter confirm.
  let picker = null
  let buffer = ''
  let caret = 0
  let composerImages = []
  let history = []
  let historyIndex = -1
  let draft = ''
  let capturing = null // string sink while inside paint(fn)
  let resizeTimer = null
  let lastRebuild = 0

  function visibleWindow() {
    const labels = composerImages.map((_, index) => `[Image #${index + 1}]`).join(' ')
    const prefix = labels === '' ? '' : `${labels}${buffer === '' ? '' : ' '}`
    const max = Math.max(4, width() - 6 - visibleLen(prefix))
    if (visibleLen(buffer) <= max) return { text: buffer, start: 0, caret: visibleLen(buffer.slice(0, caret)) }
    // walk backward from the end to find a window that fits
    let widthSoFar = 0
    let start = buffer.length
    for (let i = buffer.length - 1; i >= 0; i--) {
      const w = charWidth(buffer[i])
      if (widthSoFar + w > max) break
      widthSoFar += w
      start = i
    }
    let end = buffer.length
    if (caret < start) {
      // caret is before the window — rebuild the window from the caret
      start = caret
      widthSoFar = 0
      end = caret
      while (end < buffer.length) {
        const w = charWidth(buffer[end])
        if (widthSoFar + w > max) break
        widthSoFar += w
        end += 1
      }
    }
    return { text: buffer.slice(start, end), start, caret: visibleLen(buffer.slice(start, caret)) }
  }

  function composerPrefix() {
    const labels = composerImages.map((_, index) => `[Image #${index + 1}]`).join(' ')
    return labels === '' ? '' : `${labels}${buffer === '' ? '' : ' '}`
  }

  /** One merged config row below the box: model · preset · effort · permission · step · tokens · cwd · time. */
  function configRow() {
    const cache = status.cache > 0 ? `${Math.round((status.cache / (status.in + status.cache)) * 100)}%` : '0%'
    const cwd = truncateVisible(homePath(status.cwd), 24)
    const tokens = `  ${dim('↓')} ${formatTokens(status.in)}  ${dim('↑')} ${formatTokens(status.out)}  ${subtle('·')}  cache ${cache}   ${subtle(`${cwd} · ${clock()}`)}`
    if (status.busy) {
      const frame = SPINNER[status.tick % SPINNER.length]
      const elapsed = status.elapsed > 0 ? `${status.elapsed}s` : ''
      const bits = [elapsed, status.step > 0 ? `step ${status.step}` : '', status.out > 0 ? `↑ ${formatTokens(status.out)}` : '']
        .filter((part) => part !== '')
        .join(' · ')
      return ` ${accent(frame)} ${dimItalic(`${status.verb}…`)} ${subtle(`(esc to interrupt${bits === '' ? '' : ` · ${bits}`})`)}${tokens}`
    }
    const step = status.step > 0 ? String(status.step) : '–'
    const preset = status.preset === undefined ? '' : `  ${subtle('·')}  preset: ${status.preset}`
    return ` ${accent('✻')} ${status.model}${preset}  ${subtle('·')}  effort: ${status.effort}  ${subtle('·')}  ${status.permission}  ${subtle('·')}  step ${step}${tokens}`
  }

  /** A full-width box row: border, padded/truncated inner, border. */
  function row(inner) {
    const pad = ' '.repeat(Math.max(0, width() - 2 - visibleLen(inner)))
    return `${subtle('│')}${truncateVisible(inner + pad, width() - 2)}${subtle('│')}`
  }

  /** A borderless row below the box (the config/token lines). */
  function plainRow(inner) {
    return truncateVisible(inner, width() - 1)
  }

  function borderRow(left, right) {
    return subtle(`${left}${'─'.repeat(width() - 2)}${right}`)
  }

  function menuRow(item, index) {
    const selected = index === menuIndex
    const nameText = selected ? accentBold(item.name) : item.name
    const marker = selected ? accent('▸') : ' '
    const desc = item.desc === undefined || item.desc === '' ? '' : ` ${dim(item.desc)}`
    return truncateVisible(`  ${marker} ${nameText}${desc}`, width() - 1)
  }

  /**
   * The block as an ordered list of row strings, menu first; the input row's
   * index is recorded for cursor math. The config/token rows sit BELOW the
   * box, outside its borders. Short terminals drop secondary rows.
   */
  function layout() {
    const rows = []
    if (picker !== null) {
      rows.push({ text: truncateVisible(dim(` ${picker.title}`), width() - 1), input: false })
    }
    for (const [index, item] of menu.entries()) rows.push({ text: menuRow(item, index), input: false })
    rows.push({ text: borderRow('╭', '╮'), input: false })
    const win = visibleWindow()
    const prefix = composerPrefix()
    const inputAt = rows.length
    rows.push({ text: row(` ${accentBold('❯')} ${prefix}${win.text}`), input: true, caret: 4 + visibleLen(prefix) + win.caret })
    rows.push({ text: borderRow('╰', '╯'), input: false })
    if (height() >= 9) rows.push({ text: plainRow(configRow()), input: false })
    return { rows, inputAt }
  }

  /**
   * Draw the menu and bar in a single write; leave the cursor on the input
   * row at the caret column. When a partial transcript line is pending the
   * cursor sits at its end (rewritten by hide()), so a newline first moves
   * below it — a display-only newline; the model keeps the line open.
   */
  function draw() {
    if (!enabled) return
    const { rows, inputAt } = layout()
    let frame = pending !== '' ? '\n' : ''
    for (const item of rows) frame += item.text + '\n'
    const caretColumn = rows[inputAt].caret
    frame += `\x1b[${rows.length - inputAt}A\x1b[${caretColumn + 1}G`
    out.write(frame)
    inputRowIndex = inputAt
    blockRows = rows.length
    widthAtDraw = width()
    drawn = true
  }

  /**
   * Erase the bar (and menu) and the pending line, then rewrite the pending
   * line so streaming continues exactly where it stopped. Only valid while
   * the terminal width matches the last draw — resizes go through rebuild().
   */
  function hide() {
    if (!drawn) return
    out.write(`\x1b[${inputRowIndex + physicalRows(pending, width())}A\r\x1b[0J`)
    if (pending !== '') out.write(pending)
    drawn = false
  }

  function refresh() {
    if (!enabled) return
    // A streamed event batch always redraws once after its capture is flushed.
    // Drawing here would make paint() draw a second frame without hiding this one.
    if (capturing !== null) return
    if (width() !== widthAtDraw) {
      rebuild()
      return
    }
    hide()
    draw()
  }

  /**
   * Full-screen rebuild from the transcript model, used after a resize (the
   * terminal reflows its own rows, so incremental erase math no longer maps
   * to physical rows). One write keeps it flicker-free; scrollback survives.
   */
  function rebuild() {
    if (!enabled) return
    widthAtDraw = width() // adopt the new width before laying out
    const { rows, inputAt } = layout()
    const pendingRows = physicalRows(pending, width())
    const tailCount = Math.max(0, height() - rows.length - pendingRows)
    const tail = transcript.slice(-tailCount)
    // bottom-anchored: pad above the tail so the bar lands on the last row
    let frame = '\x1b[2J\x1b[H'
    frame += '\n'.repeat(Math.max(0, tailCount - tail.length))
    for (const line of tail) frame += line + '\n'
    if (pending !== '') frame += pending + '\n'
    for (const item of rows) frame += item.text + '\n'
    frame += `\x1b[${rows.length - inputAt}A\x1b[${rows[inputAt].caret + 1}G`
    out.write(frame)
    inputRowIndex = inputAt
    blockRows = rows.length
    drawn = true
  }

  /** Throttled resize entry point: immediate first paint, then ~120 ms. */
  function onResize() {
    if (!enabled) return
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer)
      resizeTimer = null
    }
    const now = Date.now()
    if (now - lastRebuild > 120) {
      rebuild()
      lastRebuild = now
      return
    }
    resizeTimer = setTimeout(() => {
      resizeTimer = null
      rebuild()
      lastRebuild = Date.now()
    }, 90)
  }

  // ── transcript model ─────────────────────────────────────────────────────

  /**
   * Fold an emitted chunk into the transcript model. Only the escapes this
   * app itself emits above the bar are interpreted: SGR (kept inline), and
   * the row-overwrite pair CUU+EL used by tool results. '\r' is a no-op.
   */
  function feedModel(chunk) {
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]
      if (ch === '\x1b') {
        const match = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(chunk.slice(i))
        if (!match) {
          i += 1
          continue
        }
        const letter = match[2]
        const n = match[1] === '' || match[1] === '0' ? 1 : Number(match[1].split(';')[0])
        if (letter === 'm') {
          pending += match[0]
        } else if (letter === 'A') {
          for (let k = 0; k < n; k++) {
            if (pending === '' && transcript.length > 0) pending = transcript.pop()
          }
        } else if (letter === 'K') {
          pending = ''
        }
        i += match[0].length
        continue
      }
      if (ch === '\r') {
        i += 1
        continue
      }
      if (ch === '\n') {
        transcript.push(pending)
        pending = ''
        if (transcript.length > MAX_TRANSCRIPT) transcript.splice(0, transcript.length - MAX_TRANSCRIPT)
        i += 1
        continue
      }
      pending += ch
      i += 1
    }
  }

  /**
   * Low-level output above the bar. Safe to call with the bar drawn: it
   * hides, writes, and redraws. Inside paint(fn) the chunk is captured and
   * flushed by paint() itself; the transcript model is fed immediately so
   * endLine() and friends see live state mid-capture.
   */
  function emit(chunk) {
    if (!enabled) {
      out.write(chunk)
      return
    }
    if (capturing !== null) {
      capturing += chunk
      feedModel(chunk)
      return
    }
    if (drawn) {
      hide()
      out.write(chunk)
      feedModel(chunk)
      draw()
      return
    }
    out.write(chunk)
    feedModel(chunk)
  }

  /**
   * Write output above the bar. Accepts a string, or a function that receives
   * `emit` and renders through it (streaming paths). Everything is captured
   * into the transcript model before the bar is redrawn.
   */
  function paint(content) {
    if (!enabled) {
      if (typeof content === 'function') content(emit)
      else out.write(content)
      return
    }
    hide()
    if (typeof content === 'function') {
      capturing = ''
      content(emit)
      const chunk = capturing
      capturing = null
      out.write(chunk)
    } else {
      out.write(content)
      feedModel(content)
    }
    draw()
  }

  function text(chunk) {
    emit(chunk)
  }

  /** Close a partial line (no-op when the cursor is already at a line start). */
  function endLine() {
    if (pending !== '') emit('\n')
  }

  function raw(chunk) {
    emit(chunk)
  }

  /** Write an OSC 52 clipboard sequence without adding it to the transcript. */
  function copyToClipboard(text) {
    if (!enabled) return false
    const payload = Buffer.from(String(text)).toString('base64')
    hide()
    out.write(`\x1b]52;c;${payload}\x07`)
    draw()
    return true
  }

  // ── editor mutations (each ends with a refresh) ──────────────────────────

  function updateMenu() {
    if (picker !== null) {
      menu = picker.items
      if (menu.length > 0 && menuIndex >= menu.length) menuIndex = 0
      return
    }
    if (buffer.startsWith('/')) {
      menu = menuCommands.filter((item) => item.name.startsWith(buffer))
      if (menu.length > 0 && menuIndex >= menu.length) menuIndex = 0
    } else {
      menu = []
    }
    if (menu.length === 0) menuIndex = 0
  }

  function insert(chunk) {
    // pastes arrive as one chunk: flatten line breaks, tabs, control chars
    const clean = chunk.replace(/[\r\n]+/g, ' ').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    if (clean === '') return
    buffer = buffer.slice(0, caret) + clean + buffer.slice(caret)
    caret += clean.length
    updateMenu()
    refresh()
  }
  function backspace() {
    if (caret === 0) return
    buffer = buffer.slice(0, caret - 1) + buffer.slice(caret)
    caret -= 1
    updateMenu()
    refresh()
  }
  function deleteForward() {
    if (caret >= buffer.length) return
    buffer = buffer.slice(0, caret) + buffer.slice(caret + 1)
    updateMenu()
    refresh()
  }
  function moveLeft() {
    if (caret > 0) {
      caret -= 1
      refresh()
    }
  }
  function moveRight() {
    if (caret < buffer.length) {
      caret += 1
      refresh()
    }
  }
  function moveHome() {
    if (caret !== 0) {
      caret = 0
      refresh()
    }
  }
  function moveEnd() {
    if (caret !== buffer.length) {
      caret = buffer.length
      refresh()
    }
  }
  function historyBack() {
    if (history.length === 0) return
    if (historyIndex === -1) draft = buffer
    historyIndex = Math.min(history.length - 1, historyIndex + 1)
    buffer = history[historyIndex]
    caret = buffer.length
    updateMenu()
    refresh()
  }
  function historyForward() {
    if (historyIndex === -1) return
    historyIndex -= 1
    buffer = historyIndex === -1 ? draft : history[historyIndex]
    caret = buffer.length
    updateMenu()
    refresh()
  }
  function menuMove(delta) {
    if (menu.length === 0) return
    menuIndex = (menuIndex + delta + menu.length) % menu.length
    refresh()
  }
  function completeTab() {
    if (menu.length === 0) return
    buffer = menu[menuIndex].name
    if (menu[menuIndex].takesArg) buffer += ' '
    caret = buffer.length
    updateMenu()
    refresh()
  }
  /** Open a fixed selection picker: ↑/↓ moves, enter confirms, esc cancels. */
  function openPicker(items, title, onSelect, onCancel, onDelete) {
    picker = { items, title, onSelect, onCancel, onDelete }
    buffer = ''
    caret = 0
    menu = items
    menuIndex = 0
    refresh()
  }

  function pickerActive() {
    return picker !== null
  }

  /** Confirm the highlighted picker item; resolves the pending selection. */
  function confirmPicker() {
    const active = picker
    if (active === null) return
    const value = menu[menuIndex]?.value
    picker = null
    menu = []
    menuIndex = 0
    refresh()
    active.onSelect?.(value)
  }

  /** Delete key in picker mode: notify the caller and close without selecting. */
  function pickerDelete() {
    const active = picker
    if (active === null || active.onDelete === undefined) return
    const value = menu[menuIndex]?.value
    picker = null
    menu = []
    menuIndex = 0
    refresh()
    active.onDelete(value)
    active.onCancel?.()
  }

  function closeMenu() {
    if (menu.length === 0) return
    if (picker !== null) {
      const active = picker
      picker = null
      menu = []
      menuIndex = 0
      refresh()
      active.onCancel?.()
      return
    }
    menu = []
    menuIndex = 0
    refresh()
  }
  function clearBuffer() {
    buffer = ''
    caret = 0
    updateMenu()
    refresh()
  }
  function setBuffer(value) {
    buffer = String(value).replace(/[\r\n]+/g, ' ').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    caret = buffer.length
    historyIndex = -1
    updateMenu()
    refresh()
  }
  function bufferEmpty() {
    return buffer === ''
  }
  function clearScreen() {
    if (enabled) {
      transcript.length = 0
      pending = ''
      out.write('\x1b[2J\x1b[H')
      drawn = false
      draw()
    } else {
      out.write('\x1b[2J\x1b[H')
    }
  }
  /** Replace slash-command completions after switching sessions or a blank session's preset. */
  function setMenuCommands(items) {
    menuCommands = items
    updateMenu()
    refresh()
  }
  /** Replace the non-editable image placeholders shown before the draft. */
  function setComposerImages(images) {
    composerImages = [...images]
    if (drawn) refresh()
  }
  /** Submit the current line (or the selected menu command); returns it. */
  function submit() {
    const line = menu.length > 0 ? menu[menuIndex].name : buffer
    if (line !== '' && !line.startsWith('/')) {
      history.push(line)
      if (history.length > 100) history.shift()
    }
    buffer = ''
    caret = 0
    historyIndex = -1
    menu = []
    menuIndex = 0
    refresh()
    return line
  }

  /** Tidy teardown: erase the bar, leave the transcript, land on a fresh line. */
  function close() {
    if (!enabled) return
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer)
      resizeTimer = null
    }
    hide()
    out.write('\x1b[0m')
  }

  return {
    enabled,
    status,
    draw,
    paint,
    text,
    endLine,
    raw,
    copyToClipboard,
    rowOverwrite: enabled ? '\x1b[1A\r\x1b[2K' : '',
    insert,
    backspace,
    deleteForward,
    moveLeft,
    moveRight,
    moveHome,
    moveEnd,
    historyBack,
    historyForward,
    menuMove,
    completeTab,
    closeMenu,
    openPicker,
    pickerActive,
    confirmPicker,
    pickerDelete,
    clearBuffer,
    setBuffer,
    bufferEmpty,
    menuOpen: () => menu.length > 0,
    clearScreen,
    setMenuCommands,
    setComposerImages,
    refresh,
    onResize,
    close,
    submit
  }
}

// ── turn rendering ──────────────────────────────────────────────────────────

function toolLabel(name, args) {
  const key = String(name ?? '').toLowerCase()
  if (key === 'bash' || key === 'pwsh') {
    const cmd = commandPreview(args)
    return cmd !== '' ? `${key}  ${cmd}` : key
  }
  return String(name ?? 'tool')
}

/** Streaming renderer for one agent turn (Claude Code-style rows). */
function makeTurnView(screen) {
  let lastWasCallRow = false
  let lastWasReasoning = false
  let streamedText = ''
  let streamedImageIndex = 0
  return {
    streamedText: () => streamedText,
    text(chunk) {
      if (chunk === '') return
      if (lastWasReasoning) {
        screen.endLine()
        lastWasReasoning = false
      }
      lastWasCallRow = false
      screen.text(chunk)
      streamedText += chunk
    },
    reasoning(chunk) {
      if (chunk === '') return
      if (lastWasCallRow) screen.endLine()
      lastWasCallRow = false
      lastWasReasoning = true
      screen.text(dimItalic(chunk))
    },
    image(attachment) {
      if (lastWasReasoning) screen.endLine()
      lastWasReasoning = false
      screen.endLine()
      screen.raw(`${dim(imagePlaceholder(++streamedImageIndex, attachment))}\n`)
      lastWasCallRow = false
    },
    toolCall(name, args) {
      if (lastWasReasoning) screen.endLine()
      lastWasReasoning = false
      screen.endLine()
      screen.raw(`  ${toolIcon(name)} ${accent(toolLabel(name, args))}\n`)
      lastWasCallRow = true
    },
    toolResult(name, ok, preview) {
      const label = ok ? name : red(name)
      const rowText = `  ${ok ? green('✓') : red('✖')} ${label}${preview !== '' ? dim('  ' + preview) : ''}`
      if (lastWasCallRow && screen.rowOverwrite !== '') {
        screen.raw(screen.rowOverwrite + rowText + '\n')
      } else {
        screen.endLine()
        screen.raw(rowText + '\n')
      }
      lastWasCallRow = false
      lastWasReasoning = false
    },
    finish() {
      screen.paint(() => screen.endLine())
    }
  }
}

/** Aggregate the last assistant text and turn outcome (fallback when no chunks streamed). */
function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Codex-style transcript placeholder with DSH's durable image metadata. */
function imagePlaceholder(index, attachment) {
  const name = attachment?.name === undefined ? '' : ` ${attachment.name}`
  const size = attachment?.width === undefined || attachment?.height === undefined
    ? ''
    : ` · ${attachment.width}×${attachment.height}`
  return `[Image #${index}]${name}${size}`
}

/** Render text and image blocks in order without exposing local filesystem paths. */
function messageDisplay(blocks) {
  let imageIndex = 0
  return (blocks ?? []).map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') return imagePlaceholder(++imageIndex, block.attachment)
    return ''
  }).filter((part) => part !== '').join('\n')
}

/** Resolve a typed model id against every provider group in the catalog. */
function modelCatalogMatches(groups, requested) {
  const rows = groups.flatMap((group) => group.models.map((model) => ({
    provider: group.id,
    providerName: group.name,
    model
  })))
  const qualified = rows.filter((row) => `${row.provider}/${row.model.id}` === requested)
  return qualified.length > 0 ? qualified : rows.filter((row) => row.model.id === requested)
}

/** Normalize the single path form emitted by bracketed terminal paste. */
function normalizePastedPath(raw) {
  const pasted = raw.trim()
  if (pasted === '') return undefined
  if (/^file:\/\//iu.test(pasted)) {
    try {
      const url = new URL(pasted)
      if (url.protocol !== 'file:') return undefined
      return decodeURIComponent(url.pathname)
    } catch {
      return undefined
    }
  }
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(pasted)
  if (windowsPath) return pasted
  let output = ''
  let quote = ''
  let escaped = false
  let betweenTokens = false
  for (const char of pasted) {
    if (escaped) {
      output += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote !== '') {
      if (char === quote) quote = ''
      else output += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/u.test(char)) {
      betweenTokens = output !== ''
      continue
    }
    if (betweenTokens) return undefined
    output += char
  }
  if (escaped) output += '\\'
  if (quote !== '' || output === '') return undefined
  return output
}

function looksLikeImageFilename(path) {
  return /\.(?:png|jpe?g|gif|webp)$/iu.test(path.trim())
}

/** Recover the filename-only form some macOS paste sources emit for images. */
function pastedImagePath(raw) {
  const normalized = normalizePastedPath(raw)
  if (normalized !== undefined && looksLikeImageFilename(normalized)) return normalized
  const filename = raw.trim()
  return looksLikeImageFilename(filename) ? filename : undefined
}

/** Read one filesystem image into the attachment service's input shape. */
async function imageInputFromPath(path) {
  const absolute = resolve(process.cwd(), path)
  const data = await readFile(absolute)
  return {
    data,
    mediaType: imageMediaType(data),
    name: basename(absolute)
  }
}

const MACOS_CLIPBOARD_IMAGE_SCRIPT = [
  'on run argv',
  'set outputPath to item 1 of argv',
  'try',
  'set clipFile to the clipboard as alias',
  'return POSIX path of clipFile',
  'end try',
  'try',
  'set imageData to the clipboard as «class PNGf»',
  'on error errorMessage',
  'error "no image on clipboard: " & errorMessage',
  'end try',
  'set outputFile to open for access POSIX file outputPath with write permission',
  'try',
  'set eof outputFile to 0',
  'write imageData to outputFile',
  'close access outputFile',
  'on error errorMessage',
  'try',
  'close access outputFile',
  'end try',
  'error errorMessage',
  'end try',
  'return outputPath',
  'end run'
]

/** Capture a short UTF-8 subprocess result without involving the user's shell. */
function captureStdout(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new Error(stderr.trim() || `${command} exited with status ${code}`))
    })
  })
}

/** Read a copied Finder file or bitmap from the macOS pasteboard as PNG. */
async function readMacosClipboardImage() {
  if (process.platform !== 'darwin') throw new Error('clipboard image paste is only available on macOS')
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-tui-clipboard-'))
  const outputPath = join(temporaryDirectory, 'clipboard.png')
  try {
    const args = MACOS_CLIPBOARD_IMAGE_SCRIPT.flatMap((line) => ['-e', line])
    args.push(outputPath)
    const sourcePath = (await captureStdout('/usr/bin/osascript', args)).trim()
    if (sourcePath === '') throw new Error('the clipboard did not provide an image path')
    return await imageInputFromPath(sourcePath)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

/** Identify one of DSH's supported raster formats from its encoded signature. */
function imageMediaType(data) {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  const ascii = (start, end) => String.fromCharCode(...data.subarray(start, end))
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  throw new Error('unsupported image format (expected PNG, JPEG, GIF, or WebP)')
}

/** Match DSH's host preflight: explicit omission is negative; unknown is allowed. */
function modelAcceptsImages(info) {
  return info.inputModalities === undefined || info.inputModalities.includes('image')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Render one session event into the turn view. */
function renderEvent(event, view, pendingCalls) {
  const data = event.data
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = data.chunk
      if (chunk?.type === 'text-delta') view.text(chunk.text ?? '')
      else if (chunk?.type === 'reasoning-delta') view.reasoning(chunk.text ?? '')
      break
    }
    case 'assistant/message': {
      for (const block of data.message?.content ?? []) {
        if (block.type === 'image') view.image(block.attachment)
      }
      break
    }
    case 'tool/call': {
      pendingCalls.set(`${data.turn}:${data.step}:${data.callId}`, data.name)
      view.toolCall(data.name, data.arguments)
      break
    }
    case 'tool/result': {
      const block = data.message?.content?.find((item) => item.type === 'tool-result')
      let name
      if (block?.toolCallId !== undefined) {
        name = pendingCalls.get(`${data.turn}:${data.step}:${block.toolCallId}`)
      }
      if (name === undefined) name = pendingCalls.get(`${data.turn}:${data.step}`) ?? 'tool'
      view.toolResult(name, data.error === undefined, resultPreview(data.message))
      break
    }
  }
}

/**
 * Drive one turn to quiescence while streaming its events into the view.
 * @param agent - the live agent handle.
 * @param firstSeq - session seq captured before the followup.
 * @param view - the turn renderer.
 * @param screen - the screen manager.
 * @param onEvent - optional status hook, called per rendered event.
 */
async function streamTurn(agent, firstSeq, view, screen, onEvent) {
  const pendingCalls = new Map()
  let index = firstSeq
  let finished = false
  const drain = () => {
    const events = agent.session.events
    if (index >= events.length) return
    const write = () => {
      while (index < events.length) {
        const event = events[index++]
        renderEvent(event, view, pendingCalls)
        onEvent?.(event)
      }
    }
    if (screen.enabled) screen.paint(write)
    else write()
  }
  const done = agent.whenIdle()
  done.then(() => {
    finished = true
  })
  while (!finished) {
    drain()
    await sleep(120)
  }
  drain()
  await done
  drain()
  await done
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io, error) {
  io.stderr.write(red(`✖ ${error instanceof Error ? error.message : String(error)}`) + '\n')
  io.exit(1)
}

const HELP = [
  `${accentBold('  ✻ dsh tui')} ${dim('— keys & commands')}`,
  '',
  `  ${accent('/help')}       show this help`,
  `  ${accent('/sessions')}   list persisted sessions`,
  `  ${accent('/image')}      attach image(s) to the next prompt  ${dim('(/image a.png,b.jpg; /image clear)')}`,
  `  ${accent('/resume')}     resume a session  ${dim('(↑/↓ pick · ⌫ delete · esc cancel)')}`,
  `  ${accent('/preset')}     choose the preset before the first turn  ${dim('(↑/↓ pick, then locked)')}`,
  `  ${accent('/new')}        start a fresh session  ${dim('(/new [preset])')}`,
  `  ${accent('/exit')}       quit`,
  '',
  `  ${accent('/compact')} ${accent('/goal')} ${accent('/feedback')} ${accent('/export')}  ${dim('app commands (in the menu)')}`,
  `  ${accent('/guardian')} ${dim('status | now | history | accept | resume (Guardian preset)')}`,
  `  ${accent('/<skill>')} ${dim('invoke a user-available skill (listed in the / menu)')}`,
  `  ${accent('/model')} ${dim('switch model')}   ${accent('/effort')} ${dim('switch reasoning effort')}  ${dim('(enter opens an ↑/↓ picker)')}`,
  `  ${accent('!<command>')} run a shell command in the workspace (ctrl+c to interrupt)`,
  '',
  `  ${dim('enter')} send   ${dim('↑/↓')} history   ${dim('tab')} complete   ${dim('ctrl+a/e')} line start/end`,
  `  ${dim('shift+tab')} cycle permission: read only → workspace write → full access`,
  `  ${dim('esc')} close menu / interrupt turn   ${dim('ctrl+c')} interrupt turn (idle: quit)`,
  `  ${dim('Guardian review:')} ${dim('a')} execute   ${dim('e')} edit & execute   ${dim('c')} copy   ${dim('r')} resume`,
  `  ${dim('ctrl+v')} paste clipboard image on macOS  ${dim('(Control, not Command)')}`,
  `  ${dim('ctrl+l')} clear screen   ${dim('ctrl+u')} clear input   ${dim('ctrl+d')} quit`,
  '',
  dim('  anything else is sent to the agent')
].join('\n')

/** Resolve the effective permission label for display. */
function permissionLabel(permission) {
  if (permission === undefined) return '—'
  return PERMISSION_LABELS[permission] ?? permission
}

/** The last logged preset selection wins over the creation header. */
function resolvePreset(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return session.meta?.agentPreset ?? session.header?.agentPreset
}

/** A preset remains selectable until the first model-loop turn starts. */
function sessionBlank(session) {
  return !session.events.some((event) => event.type === 'turn/start')
}

/**
 * Run the interactive chat loop: create (or resume) an Agent, read lines,
 * drive each line to quiescence while streaming the turn, and exit on
 * /exit or end of input.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - validated app config carrying the optional resume id.
 * @param io - process-facing effects.
 */
async function run(ctx, config, io) {
  const resumeId = config.resume
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const presets = ctx.get('agentPresets')
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const sessionController = ctx.get('sessionController')
  const rootSkills = ctx.get('skills')
  const guardians = ctx.get('guardians')
  if (agents === undefined || defaultModel === undefined || presets === undefined || attachments === undefined || llm === undefined || sessions === undefined || persistence === undefined || sessionController === undefined || rootSkills === undefined) return

  const selection = defaultModel.currentSelection()
  // Mutable holder: installModelSelection reads `current` fresh on every turn,
  // so /model and /effort switch the live agent's next request in place.
  const holder = { current: selection, assembled: void 0 }
  const agentOptions = { provider: selection.provider, model: selection.model }

  /** Create a fresh agent or resume one on a persisted session. */
  async function startAgent(options) {
    let presetId
    let recordPresetOnResume = false
    if (options.resumeId !== undefined) {
      const inspected = await persistence.inspect(options.resumeId)
      const recordedPreset = resolvePreset(inspected)
      presetId = (await presets.resolve(recordedPreset)).id
      recordPresetOnResume = recordedPreset === undefined
    } else {
      presetId = (await presets.resolve(options.presetId)).id
    }
    const setup = async (agentCtx) => {
      installModelSelection(agentCtx, holder)
      await presets.mount(agentCtx, presetId)
    }
    const created = options.resumeId !== undefined
      ? await agents.resume({ resumeSessionId: options.resumeId, agentOptions, setup })
      : await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd: process.cwd(), agentPreset: presetId },
          agentOptions,
          setup
        })
    if (recordPresetOnResume) {
      created.agent.session.append('agent-preset/selected', { agentPreset: presetId })
      await sessions.flush(created.agent.session)
    }
    return { agent: created.agent, handle: created, presetId }
  }

  let agent
  let agentHandle
  let activePreset
  try {
    const started = await startAgent({ resumeId, presetId: config.preset })
    agent = started.agent
    agentHandle = started.handle
    activePreset = started.presetId
  } catch (error) {
    io.stderr.write(red(`✖ cannot start session: ${error instanceof Error ? error.message : String(error)}`) + '\n')
    io.exit(1)
    return
  }

  let permission = '—'
  const permissionService = ctx.get('permissionPresets')
  try {
    permission = permissionLabel(permissionService?.current(agent.session.events))
  } catch {
    // not mounted or not derivable — display fallback
  }

  const status = {
    model: selection.model,
    preset: activePreset,
    effort: selection.reasoningEffort ?? 'auto',
    permission,
    step: 0,
    in: 0,
    out: 0,
    cache: 0,
    cwd: process.cwd(),
    sessionId: agent.session.id,
    busy: false,
    verb: 'working',
    tick: 0,
    elapsed: 0
  }

  /** Cycle the session's permission preset (shift+tab): read only → workspace write → full access. */
  async function cyclePermission() {
    if (permissionService === undefined) return
    let names
    try {
      names = permissionService.names
    } catch {
      return
    }
    if (names.length === 0) return
    let current = 'custom'
    try {
      current = permissionService.current(agent.session.events)
    } catch {
      // keep the fallback below
    }
    const index = names.indexOf(current)
    const next = names[(index + 1) % names.length]
    try {
      await permissionService.set(agent.session, next)
      status.permission = permissionLabel(permissionService.current(agent.session.events))
      screen.paint(`${dim('permission')} ${cyan(status.permission)}\n`)
    } catch (error) {
      screen.paint(red(`✖ cannot switch permission: ${error instanceof Error ? error.message : String(error)}`) + '\n')
    }
  }

  /** Refresh the displayed permission label for the live session. */
  function refreshPermission() {
    try {
      status.permission = permissionLabel(permissionService?.current(agent.session.events))
    } catch {
      status.permission = '—'
    }
  }

  // App-registry slash commands (the web surface's /compact /goal /feedback
  // /permission /plan /export …) join the local commands in the menu; the
  // runner also registers a TUI-native /export that writes the session log
  // to a file (the web's /export only hands the log to the browser).
  const commands = ctx.get('commands')
  try {
    commands?.register({
      name: 'export',
      description: 'Export this session log as JSONL',
      handler: async (invocation) => {
        try {
          await sessions.flush(agent.session)
          const raw = await persistence.readRaw(agent.session.id)
          if (raw === undefined) return { kind: 'error', text: `session log for ${agent.session.id} not found` }
          const target = join(process.cwd(), `${agent.session.id}.jsonl`)
          await writeFile(target, raw.content)
          return { kind: 'success', text: `exported ${agent.session.id} → ${target}` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
    })
  } catch {
    // a deployment-level /export already exists; leave it in charge
  }

  /** Build the same all-provider advisory model catalog used by the Web app. */
  async function modelCatalog() {
    const entries = await Promise.all(llm.listProviders().map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id)
        const resolved = await Promise.all(models.map(async (model) => ({
          ...model,
          ...await llm.resolveModelInfo(provider.id, model.id)
        })))
        return { kind: 'group', group: { id: provider.id, name: provider.name, models: resolved } }
      } catch (error) {
        return {
          kind: 'failure',
          failure: { id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) }
        }
      }
    }))
    return {
      groups: entries.flatMap((entry) => entry.kind === 'group' && entry.group.models.length > 0 ? [entry.group] : []),
      failures: entries.flatMap((entry) => entry.kind === 'failure' ? [entry.failure] : [])
    }
  }

  /** Open an ↑/↓ picker over the items; resolves the chosen value or null on esc. */
  function pickerPrompt(items, title, onDelete) {
    return new Promise((resolve) => {
      screen.openPicker(items, title, resolve, () => resolve(null), onDelete)
    })
  }

  /** Apply one complete provider/model switch to the default selection and live agent. */
  async function applyModel(row) {
    const current = holder.current
    const efforts = row.model.reasoning?.efforts ?? []
    const preservedEffort = current.provider === row.provider && current.model === row.model.id
      && efforts.some((effort) => String(effort.id) === String(current.reasoningEffort))
      ? current.reasoningEffort
      : undefined
    const reasoningEffort = preservedEffort ?? row.model.reasoning?.defaultEffort
    await defaultModel.saveSelection({
      provider: row.provider,
      model: row.model.id,
      ...reasoningEffort === void 0 ? {} : { reasoningEffort: String(reasoningEffort) }
    })
    holder.current = defaultModel.currentSelection()
    holder.assembled = void 0
    status.model = holder.current.model
    status.effort = holder.current.reasoningEffort ?? 'auto'
    screen.refresh()
    return { kind: 'success', text: `model → ${holder.current.provider}/${holder.current.model}` }
  }

  /** Apply a reasoning-effort switch to the default selection and the live agent. */
  async function applyEffort(level) {
    await defaultModel.saveSelection({
      provider: holder.current.provider,
      model: holder.current.model,
      ...level === 'auto' ? {} : { reasoningEffort: level }
    })
    holder.current = defaultModel.currentSelection()
    holder.assembled = void 0
    status.effort = holder.current.reasoningEffort ?? 'auto'
    screen.refresh()
    return { kind: 'success', text: `effort → ${level}` }
  }

  try {
    commands?.register({
      name: 'model',
      description: 'Switch provider/model (↑/↓ pick, or /model [provider/]id)',
      input: { hint: '[provider/]id' },
      handler: async (invocation) => {
        const requested = invocation.rawInput.trim()
        const catalog = await modelCatalog()
        if (requested !== '') {
          const matches = modelCatalogMatches(catalog.groups, requested)
          if (matches.length === 0) {
            const available = catalog.groups.flatMap((group) => group.models.map((model) => `${group.id}/${model.id}`))
            return { kind: 'error', text: `unknown model "${requested}"${available.length === 0 ? '' : ` (available: ${available.join(', ')})`}` }
          }
          if (matches.length > 1) {
            return { kind: 'error', text: `model "${requested}" exists in multiple providers; use one of: ${matches.map((row) => `${row.provider}/${row.model.id}`).join(', ')}` }
          }
          return await applyModel(matches[0])
        }
        const allRows = catalog.groups.flatMap((group) => group.models.map((model) => ({ provider: group.id, providerName: group.name, model })))
        if (allRows.length === 0) {
          const details = catalog.failures.map((failure) => `${failure.name}: ${failure.message}`).join('; ')
          return { kind: 'error', text: `no models advertised by registered providers${details === '' ? '' : ` (${details})`}` }
        }
        if (!screen.enabled) {
          // piped: print the list instead of opening an interactive picker
          const current = defaultModel.currentSelection()
          const lines = catalog.groups.flatMap((group) => [
            dim(`  ${group.name} (${group.id})`),
            ...group.models.map((model) => `    ${group.id === current.provider && model.id === current.model ? accent('▸') : ' '} ${cyan(model.id)}${model.name !== undefined && model.name !== model.id ? dim(` · ${model.name}`) : ''}`)
          ])
          const failures = catalog.failures.map((failure) => dim(`  ! ${failure.name}: ${failure.message}`))
          return { kind: 'success', text: [dim('models'), ...lines, ...failures, dim('  /model <id> or /model <provider>/<id> to switch')].join('\n') }
        }
        const current = defaultModel.currentSelection()
        const picked = await pickerPrompt(allRows.map((row) => ({
          name: row.model.id,
          desc: [row.providerName, row.model.name !== row.model.id ? row.model.name : '', row.provider === current.provider && row.model.id === current.model ? 'current' : ''].filter(Boolean).join(' · '),
          value: row
        })), 'models · all providers')
        if (picked === undefined || picked === null) return { kind: 'success', text: '' }
        return await applyModel(picked)
      }
    })
  } catch {
    // a deployment-level /model already exists; leave it in charge
  }

  const EFFORT_LEVELS = ['auto', 'off', 'high', 'max']
  try {
    commands?.register({
      name: 'effort',
      description: 'Switch the reasoning effort (↑/↓ pick, or /effort <level>)',
      input: { hint: '<level>' },
      handler: async (invocation) => {
        const requested = invocation.rawInput.trim()
        if (requested !== '') {
          if (!EFFORT_LEVELS.includes(requested)) {
            return { kind: 'error', text: `unknown effort "${requested}" (available: ${EFFORT_LEVELS.join(', ')})` }
          }
          return await applyEffort(requested)
        }
        const current = holder.current.reasoningEffort ?? 'auto'
        if (!screen.enabled) {
          // piped: print the levels instead of opening an interactive picker
          const lines = EFFORT_LEVELS.map((level) => `  ${level === current ? accent('▸') : ' '} ${level === 'auto' ? dim('auto (adapter default)') : cyan(level)}`)
          return { kind: 'success', text: [dim('reasoning effort'), ...lines, dim('  /effort <level> to switch')].join('\n') }
        }
        const picked = await pickerPrompt(EFFORT_LEVELS.map((level) => ({
          name: level,
          desc: `${level === 'auto' ? 'adapter default' : ''}${level === current ? (level === 'auto' ? ' · current' : 'current') : ''}`,
          value: level
        })), 'reasoning effort')
        if (picked === undefined) return { kind: 'success', text: '' }
        return await applyEffort(picked)
      }
    })
  } catch {
    // a deployment-level /effort already exists; leave it in charge
  }

  /** Resolve the same Agent-scoped skill registry and workspace view as Web. */
  function skillRegistry(currentAgent) {
    return presets.serviceFor?.(currentAgent, 'skills') ?? rootSkills
  }

  async function listSkills(currentAgent) {
    return await skillRegistry(currentAgent).list({
      cwd: currentAgent.session.header.cwd ?? process.cwd(),
      scope: currentAgent
    })
  }

  let initialSkills = []
  try {
    initialSkills = await listSkills(agent)
  } catch {
    // Match Web: a failed skill source silently drops only the skill menu group.
  }

  const screen = makeScreen(io, status, mergedMenuCommands(commands, agent, initialSkills))
  let turnActive = false
  let pendingImages = []
  let guardianView
  let guardianSubscription
  let lastGuardianBlockId
  let guardianEdit

  function renderGuardianView(view, { replay = false } = {}) {
    guardianView = view
    const block = guardianFeedback(view)
    if (block === undefined || (!replay && block.id === lastGuardianBlockId)) return
    lastGuardianBlockId = block.id
    const style = block.tone === 'success' ? green : block.tone === 'error' ? red : cyan
    screen.paint(block.text.split('\n').map((line) => style(line)).join('\n') + '\n')
  }

  async function bindGuardian(sessionId, { replay = false } = {}) {
    guardianSubscription?.()
    guardianSubscription = undefined
    guardianView = undefined
    lastGuardianBlockId = undefined
    guardianEdit = undefined
    if (guardians === undefined) return
    guardianSubscription = guardians.subscribe(String(sessionId), (view) => renderGuardianView(view))
    try {
      const view = await guardians.snapshot(String(sessionId))
      if (view?.active === true) renderGuardianView(view, { replay })
    } catch (error) {
      screen.paint(red(`✖ cannot read Guardian state: ${error instanceof Error ? error.message : String(error)}`) + '\n')
    }
  }

  async function copyGuardianFeedback() {
    const block = guardianFeedback(guardianView)
    if (block === undefined) return
    screen.copyToClipboard(block.text)
    screen.paint(green('◆ Guardian feedback copied to terminal clipboard') + '\n')
  }

  async function resumeGuardian() {
    if (guardians === undefined) return
    try {
      const view = await guardians.resume(String(agent.session.id))
      guardianView = view
      screen.paint(green('◆ Guardian resumed') + '\n')
    } catch (error) {
      screen.paint(red(`✖ cannot resume Guardian: ${error instanceof Error ? error.message : String(error)}`) + '\n')
    }
  }

  async function acceptGuardian(editedText, auditId) {
    const retryable = guardianView?.remediation !== undefined && ['failed', 'execution-failed', 'verification-failed'].includes(guardianView.remediation.phase)
    if (guardians === undefined || (guardianView?.pendingApproval?.status !== 'pending' && !retryable)) return
    try {
      const selectedAuditId = auditId ?? guardianView.pendingApproval.auditId
      const view = await guardians.accept(String(agent.session.id), selectedAuditId, editedText)
      guardianView = view
      const delivery = view.remediation?.delivery === 'next-step' ? 'after current tool call' : 'now'
      screen.paint(green(`◆ Guardian remediation accepted · ${delivery} · ${view.remediation?.phase ?? 'queued'}`) + '\n')
    } catch (error) {
      screen.paint(red(`✖ cannot accept Guardian remediation: ${error instanceof Error ? error.message : String(error)}`) + '\n')
    }
  }

  function editGuardian() {
    const retryable = guardianView?.remediation !== undefined && ['failed', 'execution-failed', 'verification-failed'].includes(guardianView.remediation.phase)
    const approval = guardianView?.pendingApproval
    if ((approval?.status !== 'pending' && !retryable) || approval?.auditId === undefined) return
    const editableText = guardianView?.remediation?.instruction ?? approval.editableText
    if (editableText === undefined || editableText === '') {
      screen.paint(red('✖ Guardian did not provide editable remediation text') + '\n')
      return
    }
    guardianEdit = { auditId: approval.auditId }
    screen.setBuffer(editableText)
    screen.paint(cyan('◆ Edit Guardian remediation, then press Enter to execute; Esc cancels') + '\n')
  }

  await bindGuardian(agent.session.id, { replay: resumeId !== undefined })

  /** Save one validated image batch and expose it as composer placeholders. */
  async function attachImageInputs(inputs, announce = true) {
    if (inputs.length === 0) return
    const limits = attachments.imageLimits
    if (pendingImages.length + inputs.length > limits.maxImagesPerMessage) {
      throw new Error(`at most ${limits.maxImagesPerMessage} images can be attached to one prompt`)
    }
    const totalBytes = pendingImages.reduce((sum, image) => sum + image.attachment.bytes, 0)
      + inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > limits.maxMessageImageBytes) {
      throw new Error(`attached images exceed the ${limits.maxMessageImageBytes}-byte per-message limit`)
    }
    const refs = await attachments.saveImages(inputs)
    pendingImages.push(...refs.map((attachment) => ({ type: 'image', attachment })))
    screen.setComposerImages(pendingImages.map((block) => block.attachment))
    if (announce) {
      const lines = refs.map((attachment, index) => dim(`  ${imagePlaceholder(pendingImages.length - refs.length + index + 1, attachment)} attached`))
      screen.paint(lines.join('\n') + '\n')
    }
  }

  /** Attach one filesystem batch to the next prompt, mirroring Codex CLI -i. */
  async function attachImagePaths(paths, announce = true) {
    if (paths.length === 0) return
    const inputs = await Promise.all(paths.map(imageInputFromPath))
    await attachImageInputs(inputs, announce)
  }

  /** Convert an explicit terminal paste to an image attachment when possible. */
  async function attachPastedImage(pasted) {
    const path = pastedImagePath(pasted)
    if (path === undefined) return false
    let input
    try {
      input = await imageInputFromPath(path)
    } catch {
      if (process.platform !== 'darwin') return false
      try {
        input = await readMacosClipboardImage()
      } catch {
        return false
      }
    }
    await attachImageInputs([input], false)
    return true
  }

  async function attachClipboardImage() {
    const input = await readMacosClipboardImage()
    await attachImageInputs([input], false)
  }

  /** Parse the same comma-separated path form accepted by repeatable --image. */
  function imagePaths(raw) {
    return raw.split(',').map((path) => path.trim()).filter((path) => path !== '')
  }

  let menuRefreshRevision = 0
  async function refreshMenuCommands() {
    const revision = ++menuRefreshRevision
    const currentAgent = agent
    let summaries = []
    try {
      summaries = await listSkills(currentAgent)
    } catch {
      // Match Web: keep local/app commands usable when skill discovery fails.
    }
    if (revision !== menuRefreshRevision || currentAgent !== agent) return
    screen.setMenuCommands(mergedMenuCommands(commands, currentAgent, summaries))
  }

  ctx.on('skills/change', () => {
    void refreshMenuCommands()
  })

  /** Interrupt the live turn, Claude Code-style; no-op when idle. */
  function interruptTurn() {
    if (!turnActive) return
    try {
      agent.cancel?.({ kind: 'user' })
    } catch {
      // cancellation is best-effort; the turn settles either way
    }
  }

  /** Switch to a fresh (/new) or persisted (/resume <id> / picker) session. */
  async function switchToSession(target, marker, presetId = status.preset) {
    try {
      const next = await startAgent({ resumeId: target, presetId })
      const previousHandle = agentHandle
      try {
        await previousHandle?.dispose?.()
      } catch {
        // the old agent's teardown is best-effort; the new one is live
      }
      agent = next.agent
      agentHandle = next.handle
      activePreset = next.presetId
      status.sessionId = agent.session.id
      status.preset = activePreset
      status.step = 0
      status.in = 0
      status.out = 0
      status.cache = 0
      refreshPermission()
      await refreshMenuCommands()
      await bindGuardian(agent.session.id, { replay: target !== undefined })
      screen.paint(`${dim(marker)} ${cyan(shortId(agent.session.id))}\n`)
      if (target !== undefined) showHistory(agent.session)
    } catch (error) {
      screen.paint(red(`✖ cannot switch session: ${error instanceof Error ? error.message : String(error)}`) + '\n')
    }
  }

  /** Preset picker shared by `/preset` and direct `/preset <id>`. */
  async function choosePreset(requested) {
    if (!sessionBlank(agent.session)) {
      screen.paint(red(`✖ session already started; preset ${status.preset} is locked — use /new <preset>`) + '\n')
      return
    }
    const available = (await presets.list()).sort((left, right) => {
      const order = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
      return order !== 0 ? order : left.id.localeCompare(right.id)
    })
    let selected = requested
    if (selected === '') {
      if (!screen.enabled) {
        const lines = available.map((preset) => `  ${preset.id === status.preset ? accent('▸') : ' '} ${cyan(preset.id)}${preset.name === undefined ? '' : dim(` · ${preset.name}`)}${preset.broken === undefined ? '' : red(` · broken: ${preset.broken}`)}`)
        screen.paint([dim('agent presets'), ...lines, dim('  /preset <id> to select before the first turn')].join('\n') + '\n')
        return
      }
      const picked = await pickerPrompt(available.map((preset) => ({
        name: preset.name ?? preset.id,
        desc: `${preset.id}${preset.id === status.preset ? ' · current' : ''}${preset.broken === undefined ? '' : ` · broken: ${preset.broken}`}`,
        value: preset.id
      })), 'agent preset · locked after first turn')
      if (picked === null || picked === undefined) return
      selected = picked
    }
    const found = available.find((preset) => preset.id === selected)
    if (found === undefined) {
      screen.paint(red(`✖ unknown preset "${selected}" (available: ${available.map((preset) => preset.id).join(', ')})`) + '\n')
      return
    }
    if (found.broken !== undefined) {
      screen.paint(red(`✖ preset "${selected}" is broken: ${found.broken}`) + '\n')
      return
    }
    if (selected === status.preset) {
      screen.paint(`${dim('preset')} ${cyan(selected)} ${dim('(current; locks after first turn)')}\n`)
      return
    }
    try {
      const preset = await presets.recompose(agent.ctx, selected)
      agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      activePreset = preset.id
      status.preset = preset.id
      await refreshMenuCommands()
      await sessions.flush(agent.session)
      screen.paint(`${dim('preset')} ${cyan(preset.id)} ${dim('· selected for this blank session')}\n`)
    } catch (error) {
      screen.paint(red(`✖ cannot select preset: ${error instanceof Error ? error.message : String(error)}`) + '\n')
    }
  }

  // ── resumed-session history rendering ─────────────────────────────────────

  const MAX_HISTORY_PAIRS = 20
  const MAX_MESSAGE_CHARS = 1500

  /** Extract user/assistant text pairs + token usage from a session log. */
  function historyPairs(session) {
    const pairs = []
    let usage = { in: 0, out: 0, cache: 0 }
    for (const event of session.events) {
      if (event.type === 'user/message') {
        const source = event.data.source?.kind ?? event.data.message?.source?.kind
        if (source !== 'user') continue
        const blocks = event.data.content ?? event.data.message?.content
        const text = messageDisplay(blocks)
        if (text !== '') pairs.push({ role: 'user', text })
      } else if (event.type === 'assistant/message') {
        const text = messageDisplay(event.data.message?.content)
        if (text !== '') pairs.push({ role: 'assistant', text })
        if (event.data.usage !== undefined) {
          usage.in += event.data.usage.inputTokens ?? 0
          usage.out += event.data.usage.outputTokens ?? 0
          usage.cache += event.data.usage.cacheReadTokens ?? 0
        }
      }
    }
    return { pairs, usage }
  }

  /** Render a resumed session's recent history above the bar. */
  function showHistory(session) {
    const { pairs, usage } = historyPairs(session)
    const total = pairs.length
    const shown = pairs.slice(-MAX_HISTORY_PAIRS)
    const lines = []
    if (total > shown.length) {
      lines.push(dim(`  … ${total - shown.length} earlier messages`))
    }
    for (const pair of shown) {
      const text = pair.text.length > MAX_MESSAGE_CHARS ? `${pair.text.slice(0, MAX_MESSAGE_CHARS)}…` : pair.text
      if (pair.role === 'user') {
        lines.push(`${accentBold('❯')} ${text}`)
      } else {
        lines.push(text)
      }
    }
    if (lines.length > 0) screen.paint(lines.join('\n') + '\n')
    if (usage.in > 0 || usage.out > 0) {
      status.in += usage.in
      status.out += usage.out
      status.cache += usage.cache
      screen.refresh()
    }
  }

  // ── session titles + deletion (shared with the web app's session store) ──
  const titleCache = new Map()

  /** Last `session/title` event in a stored session log (the web reads the same way). */
  function titleFromLog(raw) {
    let title
    for (const line of raw.split('\n')) {
      if (line === '') continue
      try {
        const event = JSON.parse(line)
        if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
      } catch {
        // skip malformed lines
      }
    }
    return title
  }

  async function sessionTitle(id) {
    if (titleCache.has(id)) return titleCache.get(id)
    let title = null
    try {
      const raw = await persistence.readRaw(id)
      if (raw !== undefined) title = titleFromLog(raw.content) ?? null
    } catch {
      title = null
    }
    titleCache.set(id, title)
    return title
  }

  /** Effective preset for display; a blank-session selection overrides the header. */
  async function sessionPreset(id, fallback) {
    try {
      return resolvePreset(await persistence.inspect(id)) ?? fallback ?? '—'
    } catch {
      return fallback ?? '—'
    }
  }

  /** Remove a session after its owner has retired and its final write has drained. */
  async function deleteSessionById(id) {
    try {
      const wasCurrent = id === agent.session.id
      if (wasCurrent) {
        // deleting the live session: retire it first, start a fresh one
        await switchToSession(undefined, 'new session', status.preset)
      }
      const deleted = await sessionController.delete({ sessionId: id })
      if (deleted?.sessionId !== id) throw new Error('session controller returned an unexpected session id')
      titleCache.delete(id)
      screen.paint(`${dim('deleted')} ${cyan(shortId(id))}\n`)
    } catch (error) {
      screen.paint(red(`✖ cannot delete session: ${error instanceof Error ? error.message : String(error)}`) + '\n')
    }
  }

  /** /resume picker: only THIS workspace's sessions, titled, ⌫ deletes. */
  async function resumePicker() {
    const cwd = process.cwd()
    let deleteTarget
    while (true) {
      let headers = []
      try {
        headers = await persistence.list()
      } catch (error) {
        screen.paint(red(`✖ cannot list sessions: ${error instanceof Error ? error.message : String(error)}`) + '\n')
        return
      }
      const inWorkspace = headers
        .filter((header) => (header.cwd ?? cwd) === cwd)
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      if (inWorkspace.length === 0) {
        screen.paint(red('✖ no sessions in this workspace') + '\n')
        return
      }
      if (!screen.enabled) {
        const body = []
        for (const header of inWorkspace) {
          const title = await sessionTitle(header.id)
          const preset = await sessionPreset(header.id, header.agentPreset)
          const created = header.createdAt === undefined ? '-' : new Date(header.createdAt).toISOString()
          body.push(`  ${title === null ? cyan(shortId(header.id)) : `${title}  ${dim(shortId(header.id))}`} ${subtle('·')} ${dim(`preset: ${preset}`)} ${subtle('·')} ${dim(header.cwd ?? '-')} ${dim(created)}`)
        }
        screen.paint(body.join('\n') + '\n' + dim('  /resume <id> to resume') + '\n')
        return
      }
      const items = []
      for (const header of inWorkspace) {
        const title = await sessionTitle(header.id)
        const preset = await sessionPreset(header.id, header.agentPreset)
        items.push({
          name: title ?? shortId(header.id),
          desc: `${header.id} · preset: ${preset} · ${header.createdAt === undefined ? '-' : new Date(header.createdAt).toISOString()}${header.id === agent.session.id ? ' · current' : ''}`,
          value: header.id
        })
      }
      deleteTarget = undefined
      const picked = await pickerPrompt(items, 'persisted sessions · workspace · ⌫ delete', (value) => {
        deleteTarget = value
      })
      if (deleteTarget !== undefined) {
        await deleteSessionById(deleteTarget)
        continue
      }
      if (picked === undefined) return
      if (picked === agent.session.id) return // already on it
      await switchToSession(picked, 'resumed')
      return
    }
  }

  // ── `!` shell execution (the human's own shell, outside the agent sandbox) ─
  let shellChild = null
  let shellActive = false
  async function runShell(command) {
    if (command === '') {
      screen.paint(red('✖ usage: !<command>') + '\n')
      return
    }
    screen.paint(`${dim('!')} ${cyan(command)}\n`)
    shellActive = true
    const startedAt = Date.now()
    const result = await new Promise((resolve) => {
      const child = spawn(command, { shell: process.env.SHELL ?? '/bin/bash', cwd: process.cwd() })
      shellChild = child
      let stdout = ''
      let stderr = ''
      const cap = (buffer, text, limit) => {
        if (text.length >= limit) return text
        return (text + buffer).slice(0, limit)
      }
      child.stdout.on('data', (chunk) => {
        stdout = cap(chunk, stdout, 65536)
      })
      child.stderr.on('data', (chunk) => {
        stderr = cap(chunk, stderr, 65536)
      })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      }, 300000)
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ error })
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, stdout, stderr })
      })
    })
    shellChild = null
    shellActive = false
    if (result.error !== undefined) {
      screen.paint(red(`✖ ${result.error.message}`) + '\n')
      return
    }
    const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
    let body = ''
    if (result.stdout !== '') body += result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n'
    if (result.stderr !== '') body += result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n'
    const exited = result.code !== null ? String(result.code) : `sig ${result.signal ?? '?'}`
    body += `${dim('· exit')} ${result.code === 0 ? green('0') : red(exited)}${dim(` · ${duration}s`)}\n`
    screen.paint(body)
  }

  /** Handle one submitted line: a command, a `!` shell line, or a chat turn. */
  async function handleLine(text) {
    if (text.startsWith('!')) {
      await runShell(text.slice(1).trim())
      return
    }
    if (text === '/help') {
      screen.paint(HELP + '\n')
      return
    }
    if (text === '/exit' || text === '/quit') return 'exit'
    if (text === '/sessions') {
      try {
        const headers = await persistence.list()
        if (headers.length === 0) {
          screen.paint(dim('  no persisted sessions') + '\n')
          return
        }
        const body = []
        for (const header of headers) {
          const preset = await sessionPreset(header.id, header.agentPreset)
          const created = header.createdAt === undefined ? '-' : new Date(header.createdAt).toISOString()
          body.push(`  ${cyan(header.id)} ${subtle('·')} ${dim(`preset: ${preset}`)} ${subtle('·')} ${dim(header.cwd ?? '-')} ${dim(created)}`)
        }
        screen.paint(body.join('\n') + '\n')
      } catch (error) {
        screen.paint(red(`✖ cannot list sessions: ${error instanceof Error ? error.message : String(error)}`) + '\n')
      }
      return
    }
    if (text === '/image' || text.startsWith('/image ')) {
      const raw = text.slice('/image'.length).trim()
      if (raw === 'clear') {
        pendingImages = []
        screen.setComposerImages([])
        screen.paint(dim('  image attachments cleared') + '\n')
        return
      }
      if (raw === '') {
        const lines = pendingImages.length === 0
          ? [dim('  no images attached to the next prompt · macOS clipboard: press Ctrl+V (not Command+V)')]
          : pendingImages.map((block, index) => dim(`  ${imagePlaceholder(index + 1, block.attachment)} attached`))
        screen.paint(lines.join('\n') + '\n')
        return
      }
      try {
        await attachImagePaths(imagePaths(raw))
      } catch (error) {
        screen.paint(red(`✖ cannot attach image: ${error instanceof Error ? error.message : String(error)}`) + '\n')
      }
      return
    }
    if (text === '/preset' || text.startsWith('/preset ')) {
      await choosePreset(text.slice('/preset'.length).trim())
      return
    }
    if (text === '/new' || text.startsWith('/new ') || text.startsWith('/resume')) {
      const target = text.startsWith('/resume') ? text.slice('/resume'.length).trim() : undefined
      if (text.startsWith('/resume') && target === '') {
        // no id given: ↑/↓ pick a session of THIS workspace (⌫ deletes)
        await resumePicker()
        return
      }
      const presetId = text.startsWith('/new') ? text.slice('/new'.length).trim() || status.preset : undefined
      await switchToSession(target, target === undefined ? 'new session' : 'resumed', presetId)
      return
    }

    // app-registry slash commands (web surface parity): /compact /goal
    // /feedback /export … run through the commands service.
    const commandName = text.slice(1).split(/\s+/)[0].toLowerCase()
    if (commands !== undefined && commands.find(agent, commandName) !== undefined) {
      try {
        const commandImages = await Promise.all(pendingImages.map(async (block) => {
          const stored = await attachments.readImage(block.attachment)
          return {
            mediaType: stored.ref.mediaType,
            data: Buffer.from(stored.data).toString('base64'),
            ...stored.ref.name === undefined ? {} : { name: stored.ref.name }
          }
        }))
        const outcome = await commands.execute(agent, text, commandImages, new AbortController().signal)
        const result = outcome?.result
        if (result?.kind === 'error') {
          screen.paint(red(`✖ ${result.text ?? 'command failed'}`) + '\n')
        } else if (result?.text !== undefined && result.text !== '') {
          screen.paint(result.text + '\n')
        }
        if (result?.kind === 'success') {
          pendingImages = []
          screen.setComposerImages([])
        }
      } catch (error) {
        screen.paint(red(`✖ ${error instanceof Error ? error.message : String(error)}`) + '\n')
      }
      return
    }
    if (text.startsWith('/')) {
      let skillInvocation = false
      try {
        skillInvocation = hasUserInvocableSkill(await listSkills(agent), text)
      } catch {
        // Skill discovery failure is presented as an unclaimed slash command.
      }
      if (!skillInvocation) {
        screen.paint(red(`✖ unknown command: ${text}`) + '\n')
        return
      }
    }

    // A chat turn: consume the pending image batch, echo Codex-style image
    // placeholders, then stream the reply above the bar.
    if (pendingImages.length > 0) {
      try {
        const info = await llm.resolveModelInfo(holder.current.provider, holder.current.model)
        if (!modelAcceptsImages(info)) {
          screen.paint(red(`✖ current model "${holder.current.model}" does not support image input; use /model or start DSH with an image-capable provider`) + '\n')
          return
        }
      } catch (error) {
        screen.paint(red(`✖ cannot verify image support for "${holder.current.model}": ${error instanceof Error ? error.message : String(error)}`) + '\n')
        return
      }
    }
    const content = [
      ...pendingImages,
      ...(text === '' ? [] : [{ type: 'text', text }])
    ]
    const display = messageDisplay(content).split('\n')
    screen.paint(`${accentBold('❯')} ${display.join('\n  ')}\n`)
    status.step = 0
    status.in = 0
    status.out = 0
    status.cache = 0
    status.busy = true
    status.verb = 'working'
    status.tick = 0
    status.elapsed = 0
    const startedAt = Date.now()
    const ticker = setInterval(() => {
      status.tick += 1
      status.elapsed = Math.floor((Date.now() - startedAt) / 1000)
      screen.refresh()
    }, 120)
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content,
      source: { kind: 'user' }
    }))
    pendingImages = []
    screen.setComposerImages([])
    const view = makeTurnView(screen)
    turnActive = true
    try {
      await streamTurn(agent, firstSeq, view, screen, (event) => {
        if (event.type === 'step/start') status.step = event.data.step
        else if (event.type === 'agent-preset/selected') {
          activePreset = event.data.agentPreset
          status.preset = activePreset
          void refreshMenuCommands()
        }
        else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
          status.in += event.data.usage.inputTokens ?? 0
          status.out += event.data.usage.outputTokens ?? 0
          status.cache += event.data.usage.cacheReadTokens ?? 0
        }
      })
    } finally {
      turnActive = false
      clearInterval(ticker)
      status.busy = false
    }
    view.finish()
    const outcome = summarize(agent.session.events, firstSeq)
    if (view.streamedText() === '' && outcome.text !== '') {
      screen.paint(outcome.text + '\n')
    }
    if (outcome.reason?.kind === 'error') {
      screen.paint(red(`✖ ${outcome.reason.error.code}: ${outcome.reason.error.message}`) + '\n')
    } else if (outcome.reason?.kind === 'aborted') {
      screen.paint(dim('⊘ interrupted') + '\n')
    }
    screen.refresh()
    await sessions.flush(agent.session)
  }

  /** Tear down the terminal and request process exit. */
  function quit(code) {
    guardianSubscription?.()
    guardianSubscription = undefined
    if (screen.enabled) {
      try {
        process.stdin.setRawMode(false)
      } catch {
        // already restored
      }
      process.stdin.removeAllListeners('keypress')
      // a flowing stdin pins the event loop after the tree disposes; pause it
      // so the launcher's graceful exit completes without the 5 s force-quit
      process.stdin.pause()
      screen.close()
      io.stdout.write('\x1b[?2004l')
      io.stdout.write(subtle(`✻ session ${shortId(agent.session.id)} saved`) + dim('  ·  resume: dsh --profile tui --resume ') + cyan(shortId(agent.session.id)) + '\n')
    }
    io.exit(code)
  }

  await attachImagePaths(config.images ?? [])

  if (screen.enabled) {
    // ── interactive TTY: raw-mode editor + bordered input bar ──────────────
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    io.stdout.write('\x1b[?2004h')
    const queue = []
    let waiter = null
    let bracketedPaste = null
    let inputTask = Promise.resolve()
    const pushLine = (value) => {
      queue.push(value)
      if (waiter) {
        const resolve = waiter
        waiter = null
        resolve()
      }
    }
    const nextLine = () => {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((resolve) => {
        waiter = () => resolve(queue.shift())
      })
    }
    const enqueueInputTask = (task) => {
      inputTask = inputTask.then(task).catch((error) => {
        screen.paint(red(`✖ cannot paste image: ${error instanceof Error ? error.message : String(error)}`) + '\n')
      })
    }
    const integratePaste = async (pasted) => {
      if (!(await attachPastedImage(pasted))) screen.insert(pasted)
    }
    process.stdin.on('keypress', (chunk, key) => {
      if (key === undefined) return
      const name = key.name
      if (name === 'paste-start') {
        bracketedPaste = ''
        return
      }
      if (bracketedPaste !== null) {
        if (name === 'paste-end') {
          const pasted = bracketedPaste
          bracketedPaste = null
          enqueueInputTask(() => integratePaste(pasted))
        } else if (chunk !== undefined) {
          bracketedPaste += chunk
        }
        return
      }
      if (key.ctrl && name === 'v' && process.platform === 'darwin') {
        enqueueInputTask(attachClipboardImage)
        return
      }
      if (key.ctrl && name === 'c') {
        if (shellActive) {
          shellChild?.kill('SIGINT')
          return
        }
        if (turnActive) interruptTurn()
        else if (guardianEdit !== undefined) {
          guardianEdit = undefined
          screen.clearBuffer()
          screen.paint(dim('◆ Guardian edit canceled') + '\n')
        }
        else if (!screen.bufferEmpty()) screen.clearBuffer()
        else quit(0)
        return
      }
      if (!key.ctrl && !key.meta && screen.bufferEmpty() && guardianView?.paused === true && name === 'c') {
        enqueueInputTask(copyGuardianFeedback)
        return
      }
      const guardianRetryable = guardianView?.remediation !== undefined && ['failed', 'execution-failed', 'verification-failed'].includes(guardianView.remediation.phase)
      if (!key.ctrl && !key.meta && screen.bufferEmpty() && (guardianView?.pendingApproval?.status === 'pending' || guardianRetryable) && name === 'a') {
        enqueueInputTask(acceptGuardian)
        return
      }
      if (!key.ctrl && !key.meta && screen.bufferEmpty() && (guardianView?.pendingApproval?.status === 'pending' || guardianRetryable) && name === 'e') {
        editGuardian()
        return
      }
      if (!key.ctrl && !key.meta && screen.bufferEmpty() && guardianView?.paused === true && (guardianView?.remediation === undefined || guardianView.remediation.phase === 'completed') && guardianView?.pendingApproval?.verdict !== 'critical' && name === 'r') {
        enqueueInputTask(resumeGuardian)
        return
      }
      if (key.ctrl && name === 'd') {
        if (screen.bufferEmpty()) pushLine('__eof__')
        else screen.deleteForward()
        return
      }
      if (key.ctrl && name === 'u') {
        screen.clearBuffer()
        return
      }
      if (key.ctrl && name === 'a') {
        screen.moveHome()
        return
      }
      if (key.ctrl && name === 'e') {
        screen.moveEnd()
        return
      }
      if (key.ctrl && name === 'l') {
        screen.clearScreen()
        return
      }
      if (name === 'return' || name === 'enter') {
        if (screen.pickerActive()) {
          screen.confirmPicker()
          return
        }
        if (guardianEdit !== undefined) {
          const edit = guardianEdit
          guardianEdit = undefined
          const editedText = screen.submit()
          enqueueInputTask(() => acceptGuardian(editedText, edit.auditId))
          return
        }
        void inputTask.then(() => pushLine(screen.submit()))
        return
      }
      if (name === 'backspace') {
        if (screen.pickerActive()) {
          screen.pickerDelete()
          return
        }
        screen.backspace()
        return
      }
      if (name === 'delete') {
        if (screen.pickerActive()) {
          screen.pickerDelete()
          return
        }
        screen.deleteForward()
        return
      }
      if (name === 'left') {
        screen.moveLeft()
        return
      }
      if (name === 'right') {
        screen.moveRight()
        return
      }
      if (name === 'home') {
        screen.moveHome()
        return
      }
      if (name === 'end') {
        screen.moveEnd()
        return
      }
      if (name === 'up') {
        if (screen.menuOpen()) screen.menuMove(-1)
        else screen.historyBack()
        return
      }
      if (name === 'down') {
        if (screen.menuOpen()) screen.menuMove(1)
        else screen.historyForward()
        return
      }
      if (name === 'tab' && key.shift) {
        cyclePermission()
        return
      }
      if (name === 'tab') {
        if (screen.pickerActive()) {
          screen.confirmPicker()
          return
        }
        screen.completeTab()
        return
      }
      if (name === 'escape') {
        if (screen.menuOpen()) screen.closeMenu()
        else if (guardianEdit !== undefined) {
          guardianEdit = undefined
          screen.clearBuffer()
          screen.paint(dim('◆ Guardian edit canceled') + '\n')
        }
        else if (shellActive) shellChild?.kill('SIGINT')
        else if (turnActive) interruptTurn()
        else if (guardianView?.paused === true) quit(0)
        return
      }
      if (chunk !== undefined && chunk !== '' && !key.ctrl && !key.meta) {
        screen.insert(chunk)
      }
    })
    process.stdin.on('end', () => {
      pushLine('__eof__')
    })
    process.stdout.on('resize', () => screen.onResize())

    // welcome banner, then the bar
    screen.paint([
      '',
      `  ${accentBold('✻ dsh tui')} ${subtle('· deepseek harness')}`,
      `  ${dim(selection.model)}  ${subtle('·')}  ${dim(`preset: ${status.preset}`)}  ${subtle('·')}  ${dim(homePath(process.cwd()))}`,
      `  ${subtle('/help for keys & commands')}`,
      ''
    ].join('\n'))
    if (resumeId !== undefined) {
      screen.paint(`${dim('resumed')} ${cyan(shortId(agent.session.id))}\n`)
      showHistory(agent.session)
    }

    while (true) {
      const input = await nextLine()
      if (input === '__eof__' || input === '__exit__') break
      const text = input.trim()
      if (text === '' && pendingImages.length === 0) continue
      const result = await handleLine(text)
      if (result === 'exit') break
    }
    quit(0)
    return
  }

  // ── piped (non-TTY): plain line loop with the shared output path ─────────
  function statusLine() {
    const cache = status.cache > 0 ? `${Math.round((status.cache / (status.in + status.cache)) * 100)}%` : '0%'
    return dim(`✳️  ${status.model}  ✳️  preset: ${status.preset}  ✳️  effort: ${status.effort}  ✳️  ${status.permission}  ✳️  step ${status.step > 0 ? status.step : '–'}  ✳️  in ${formatTokens(status.in)} / out ${formatTokens(status.out)} / cache ${cache}  ✳️  ${homePath(status.cwd)}  ✳️  ${clock()}`)
  }

  io.stdout.write(statusLine() + '\n')
  if (resumeId !== undefined) {
    io.stdout.write(`${dim('resumed')} ${cyan(shortId(agent.session.id))}\n`)
    showHistory(agent.session)
  }

  // readline/promises `question()` hangs on a second call over a piped
  // (non-TTY) stdin, so the prompt is driven from the 'line'/'close' events
  // with a small pending-read queue.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  const inputQueue = []
  let pendingRead
  let inputClosed = false
  rl.on('line', (input) => {
    if (pendingRead) {
      const resolve = pendingRead
      pendingRead = undefined
      resolve(input)
    } else {
      inputQueue.push(input)
    }
  })
  rl.on('close', () => {
    inputClosed = true
    if (pendingRead) {
      const resolve = pendingRead
      pendingRead = undefined
      resolve(undefined)
    }
  })
  rl.on('SIGINT', () => rl.close())
  function nextLine() {
    if (inputQueue.length > 0) return Promise.resolve(inputQueue.shift())
    if (inputClosed === true) return Promise.resolve(undefined)
    process.stdout.write(dim('> ') + '')
    return new Promise((resolve) => {
      pendingRead = resolve
    })
  }

  while (true) {
    const input = await nextLine()
    if (input === undefined) break // EOF / Ctrl+D / Ctrl+C
    const text = input.trim()
    if (text === '' && pendingImages.length === 0) continue
    const result = await handleLine(text)
    if (result === 'exit') break
    io.stdout.write(statusLine() + '\n')
  }

  rl.close()
  try {
    await sessions.flush(agent.session)
  } catch {
    // final flush is best-effort
  }
  io.exit(0)
}

/**
 * Mount the interactive driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated app config carrying the optional resume id.
 */
export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io = {
    stdout: internals.stdout,
    stderr: internals.stderr,
    exit
  }
  run(ctx, config, io).catch((error) => {
    fail(io, error)
  })
}

internals.sessionBlank = (events) => sessionBlank({ events })
internals.resolvePreset = resolvePreset
internals.imagePlaceholder = imagePlaceholder
internals.messageDisplay = messageDisplay
internals.modelCatalogMatches = modelCatalogMatches
internals.normalizePastedPath = normalizePastedPath
internals.looksLikeImageFilename = looksLikeImageFilename
internals.pastedImagePath = pastedImagePath
internals.imageMediaType = imageMediaType
internals.modelAcceptsImages = modelAcceptsImages
internals.help = HELP
internals.registryMenuCommands = registryMenuCommands
internals.skillMenuCommands = skillMenuCommands
internals.mergedMenuCommands = mergedMenuCommands
internals.invokedSkillNames = invokedSkillNames
internals.hasUserInvocableSkill = hasUserInvocableSkill
internals.guardianFeedback = guardianFeedback

export { internals }
