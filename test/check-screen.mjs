/**
 * Screen-manager audit harness. Loads makeScreen/makeTurnView straight out of
 * lib/index.js (no dsh runtime needed), wires them to the vt.mjs emulator,
 * and replays the interactions that corrupt the display: keystrokes, slash
 * menu, streaming wrapped text, tool rows, and window resizes.
 *
 * Usage: node dev/check-screen.mjs [path-to-index.js]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Term } from './vt.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ?? join(here, '..', 'lib', 'index.js')

// ── fake a TTY before the module body evaluates ─────────────────────────────
let COLS = 100
let ROWS = 30
delete process.env.NO_COLOR // the harness wants the color path even in CI shells
process.stdout.isTTY = true
process.stdin.isTTY = true
Object.defineProperty(process.stdout, 'columns', { configurable: true, get: () => COLS })
Object.defineProperty(process.stdout, 'rows', { configurable: true, get: () => ROWS })

/** Evaluate the app module in a plain function scope and grab its innards. */
function loadModule(path) {
  let source = readFileSync(path, 'utf8')
  source = source
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .filter((line) => !/^export\s*\{/.test(line))
    .filter((line) => !/z\.object/.test(line))
    .join('\n')
    .replace(/^export /gm, '')
  source += '\nreturn { makeScreen, makeTurnView, internals }'
  return new Function(source)()
}

const { makeScreen, makeTurnView, internals } = loadModule(target)

// ── scenario plumbing ───────────────────────────────────────────────────────
let failures = 0
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function countLines(rows, needle) {
  return rows.filter((row) => row.includes(needle)).length
}

function newScreen() {
  const term = new Term(COLS, ROWS)
  const io = { stdout: { write: (chunk) => term.write(chunk) }, stderr: process.stderr }
  const status = {
    model: 'deepseek-v4-flash',
    preset: 'minimal',
    effort: 'max',
    permission: 'full access',
    step: 0,
    in: 0,
    out: 0,
    cache: 0,
    cwd: '/workspace/demo',
    sessionId: 'session-test-abcdef'
  }
  const screen = makeScreen(io, status)
  return { term, screen, status }
}

/** Occurrences of a needle across scrollback + screen, joined per line. */
function occurrences(term, needle) {
  return countLines(term.all(), needle)
}

function dump(term, title) {
  console.log(`  ── ${title} ──`)
  const back = term.scrollback()
  if (back.length > 0) {
    console.log('  · scrollback ·')
    for (const row of back) console.log(`    |${row}`)
  }
  console.log('  · screen ·')
  for (const row of term.screen()) console.log(`    |${row}`)
  console.log(`    cursor: y=${term.y} x=${term.x} (screenTop=${term.screenTop()})`)
}

// ── 1. initial draw ─────────────────────────────────────────────────────────
console.log('\n[1] initial draw')
{
  const { term, screen } = newScreen()
  screen.draw()
  check('single top border on screen', countLines(term.screen(), '╭') === 1)
  check('single bottom border on screen', countLines(term.screen(), '╰') === 1)
  const inputRow = term.screen().findIndex((row) => row.includes('❯'))
  check('cursor rests on the input row', term.y === term.screenTop() + inputRow,
    `cursor y=${term.y}, input row at screen index ${inputRow} (top=${term.screenTop()})`)
  check('cursor column after the prompt', term.x === 4, `x=${term.x}`)
}

// ── 2. typing refreshes the bar in place ────────────────────────────────────
console.log('\n[2] typing five characters')
{
  const { term, screen } = newScreen()
  screen.draw()
  for (const ch of 'hello') screen.insert(ch)
  check('no stray borders above the box', occurrences(term, '╭') === 1,
    `found ${occurrences(term, '╭')} top borders total`)
  check('single bottom border', occurrences(term, '╰') === 1)
  const inputLine = term.screen().find((row) => row.includes('❯'))
  check('buffer visible in the input row', inputLine?.includes('hello') ?? false, inputLine)
  check('cursor after the typed text', term.x === 4 + 5, `x=${term.x}`)
  dump(term, 'after typing "hello"')
}

console.log('\n[2b] replacing the composer with an editable Guardian draft')
{
  const { term, screen } = newScreen()
  screen.draw()
  screen.setBuffer('repair the dispatch guard')
  const inputLine = term.screen().find((row) => row.includes('❯'))
  check('Guardian draft replaces the composer', inputLine?.includes('repair the dispatch guard') ?? false, inputLine)
  check('cursor follows the replacement draft', term.x === 4 + 'repair the dispatch guard'.length, `x=${term.x}`)
}

// ── 3. slash menu ───────────────────────────────────────────────────────────
console.log('\n[3] slash menu open/close')
{
  const { term, screen } = newScreen()
  screen.draw()
  screen.insert('/')
  check('menu lists all commands', countLines(term.screen(), '/help') === 1 && countLines(term.screen(), '/exit') === 1)
  screen.closeMenu()
  check('menu closes without leftovers', countLines(term.all(), '/sessions') === 0)
  check('box intact after menu', occurrences(term, '╭') === 1 && occurrences(term, '╰') === 1)
}

// ── 4. streaming a long wrapped line repeatedly ─────────────────────────────
console.log('\n[4] streaming a long (wrapping) line in three paints')
{
  const { term, screen } = newScreen()
  screen.draw()
  const chunk = 'lorem-ipsum-dolor-sit-amet-' // 27 cells; 10 chunks = 270 cells > 2 rows at 100 cols
  let streamed = ''
  for (let i = 0; i < 3; i++) {
    screen.paint(() => {
      for (let k = 0; k < (i + 1) * 3; k++) {
        // simulate progressive streaming: the pending line keeps growing
      }
    })
  }
  // simpler faithful replay: three paints, each appending more text
  const term2 = new Term(COLS, ROWS)
  const io2 = { stdout: { write: (c) => term2.write(c) }, stderr: process.stderr }
  const screen2 = makeScreen(io2, { model: 'm', effort: 'e', permission: 'p', step: 0, in: 0, out: 0, cache: 0, cwd: '/tmp', sessionId: 's' })
  screen2.draw()
  for (let round = 0; round < 3; round++) {
    screen2.paint(() => {
      for (let k = 0; k < 4; k++) {
        screen2.text(chunk)
        streamed += chunk
      }
    })
  }
  const joined = term2.logical().join('\n')
  const hits = joined.split('lorem-ipsum').length - 1
  const expected = streamed.split('lorem-ipsum').length - 1
  check('streamed text appears exactly once', hits === expected, `expected ${expected} occurrences, screen holds ${hits}`)
  check('box still singular after streaming', occurrences(term2, '╭') === 1 && occurrences(term2, '╰') === 1)
  dump(term2, 'after streaming')
}

// ── 5. tool call row overwritten by its result ──────────────────────────────
console.log('\n[5] tool call row overwritten by result')
{
  const { term, screen } = newScreen()
  const view = makeTurnView(screen)
  screen.draw()
  screen.paint(() => view.toolCall('bash', JSON.stringify({ command: 'ls -la' })))
  screen.paint(() => view.toolResult('bash', true, 'total 42'))
  const joined = term.all().join('\n')
  check('result row present', joined.includes('total 42'))
  check('call row fully replaced', !joined.includes('⚙️'), `leftover: ${joined.split('\n').filter((l) => l.includes('bash')).join(' | ')}`)
  check('box singular', occurrences(term, '╭') === 1)
}

// ── 6. resize narrower, then wider ──────────────────────────────────────────
console.log('\n[6] resize 100 → 60 → 120')
{
  const { term, screen, status } = newScreen()
  screen.draw()
  for (const ch of 'draft') screen.insert(ch)
  screen.paint(() => screen.text('some earlier answer text that is done\n'))
  COLS = 60
  term.resize(60, ROWS)
  screen.refresh()
  check('single box after narrowing', occurrences(term, '╭') === 1 && occurrences(term, '╰') === 1,
    `borders: ${occurrences(term, '╭')}/${occurrences(term, '╰')}`)
  check('buffer survives narrowing', term.all().join('\n').includes('draft'))
  check('status row survives narrowing', term.all().join('\n').includes('deepseek-v4-flash'))
  COLS = 120
  term.resize(120, ROWS)
  screen.refresh()
  check('single box after widening', occurrences(term, '╭') === 1 && occurrences(term, '╰') === 1)
  check('history not duplicated by resize', countLines(term.all(), 'some earlier answer text that is done') === 1,
    `found ${countLines(term.all(), 'some earlier answer text that is done')}`)
  dump(term, 'after resizes')
}

// ── 7. resize while a partial line is pending ───────────────────────────────
console.log('\n[7] resize with a wrapped pending line mid-stream')
{
  const term = new Term(COLS = 100, ROWS)
  const io = { stdout: { write: (c) => term.write(c) }, stderr: process.stderr }
  const screen = makeScreen(io, { model: 'm', effort: 'e', permission: 'p', step: 0, in: 0, out: 0, cache: 0, cwd: '/tmp', sessionId: 's' })
  screen.draw()
  screen.paint(() => {
    for (let k = 0; k < 6; k++) screen.text('wrap-me-gently-') // 90 cells, wraps at 60
  })
  COLS = 60
  term.resize(60, ROWS)
  screen.refresh()
  const hits = term.logical().join('\n').split('wrap-me-gently').length - 1
  check('pending line not duplicated by resize', hits === 6, `expected 6, got ${hits}`)
  check('single box after resize', occurrences(term, '╭') === 1 && occurrences(term, '╰') === 1)
  COLS = 100 // restore for later scenarios
  term.resize(100, ROWS)
  screen.refresh()
}

// ── 8. Ctrl+L clear ─────────────────────────────────────────────────────────
console.log('\n[8] clearScreen')
{
  const { term, screen } = newScreen()
  screen.draw()
  screen.paint(() => screen.text('transcript line\n'))
  screen.clearScreen()
  check('box redrawn after clear', countLines(term.screen(), '╭') === 1)
}

// ── 9. menu open across a resize ────────────────────────────────────────────
console.log('\n[9] slash menu survives a resize')
{
  const { term, screen } = newScreen()
  screen.draw()
  screen.insert('/')
  COLS = 70
  term.resize(70, ROWS)
  screen.refresh()
  check('menu still listed at new width', countLines(term.screen(), '/help') === 1)
  check('exactly one box with menu open', occurrences(term, '╭') === 1 && occurrences(term, '╰') === 1)
  screen.closeMenu()
  COLS = 100
  term.resize(100, ROWS)
  screen.refresh()
  check('menu closed cleanly after resize', countLines(term.all(), '/sessions') === 0)
}

// ── 10. history recall ──────────────────────────────────────────────────────
console.log('\n[10] history recall')
{
  const { term, screen } = newScreen()
  screen.draw()
  for (const ch of 'first message') screen.insert(ch)
  screen.submit()
  screen.historyBack()
  const inputLine = term.screen().find((row) => row.includes('❯'))
  check('history restores the submitted line', inputLine?.includes('first message') ?? false, inputLine)
  screen.historyForward()
  const cleared = term.screen().find((row) => row.includes('❯'))
  check('history forward restores the draft', cleared !== undefined && !cleared.includes('first message'))
}

// ── 11b. reasoning → text transition ends the line ──────────────────────────
console.log('\n[11b] reasoning → text line break')
{
  const make = () => {
    const term = new Term(COLS, ROWS)
    const io = { stdout: { write: (c) => term.write(c) }, stderr: process.stderr }
    return { term, screen: makeScreen(io, { model: 'm', effort: 'e', permission: 'p', step: 0, in: 0, out: 0, cache: 0, cwd: '/tmp', sessionId: 's', busy: false, tick: 0, elapsed: 0, verb: 'working' }) }
  }
  const a = make()
  a.screen.draw()
  const viewA = makeTurnView(a.screen)
  a.screen.paint(() => {
    viewA.reasoning('thinking here')
    viewA.text('answer')
  })
  const linesA = a.term.logical().filter((l) => l.includes('thinking') || l.includes('answer'))
  check('same-paint transition breaks the line', linesA.length === 2, JSON.stringify(linesA))

  const b = make()
  b.screen.draw()
  const viewB = makeTurnView(b.screen)
  b.screen.paint(() => viewB.reasoning('thinking here'))
  b.screen.paint(() => viewB.text('answer'))
  const linesB = b.term.logical().filter((l) => l.includes('thinking') || l.includes('answer'))
  check('cross-paint transition breaks the line', linesB.length === 2, JSON.stringify(linesB))
}

// ── 11c. refresh requested inside a streaming paint ───────────────────────
console.log('\n[11c] deferred refresh inside streaming paint')
{
  const { term, screen } = newScreen()
  screen.draw()
  screen.paint(() => {
    // Auto routing refreshes slash commands when agent-preset/selected arrives
    // in the same drained batch as the first reasoning delta.
    screen.setMenuCommands([{ name: '/help', desc: 'show help' }])
    screen.text('first reasoning delta')
  })
  check('paint-internal command refresh does not duplicate the input frame',
    occurrences(term, '╭') === 1 && occurrences(term, '╰') === 1,
    `borders: ${occurrences(term, '╭')}/${occurrences(term, '╰')}`)
  check('reasoning survives the deferred refresh',
    term.logical().join('\n').includes('first reasoning delta'))
}

// ── 12. short terminal drops secondary rows ─────────────────────────────────
console.log('\n[12] compact layout on short terminals')
{
  COLS = 100
  ROWS = 10
  const term = new Term(100, 10)
  const io = { stdout: { write: (c) => term.write(c) }, stderr: process.stderr }
  const screen = makeScreen(io, { model: 'm', preset: 'minimal', effort: 'e', permission: 'p', step: 0, in: 0, out: 0, cache: 0, cwd: '/tmp', sessionId: 's', busy: false, tick: 0, elapsed: 0, verb: 'working' })
  screen.draw()
  const boxRows = term.screen().filter((row) => row.startsWith('│') || row.startsWith('╭') || row.startsWith('╰'))
  check('box stays compact when short', boxRows.length === 3, `box rows: ${boxRows.length}`)
  check('status row retained at ten rows', term.screen().some((row) => row.includes('preset: minimal')))
  ROWS = 8
  term.resize(100, 8)
  screen.refresh()
  const compact = term.screen().filter((row) => row.startsWith('│') || row.startsWith('╭') || row.startsWith('╰'))
  check('status row dropped when tiny', compact.length === 3, `box rows: ${compact.length}`)
  ROWS = 30
}

// ── 13. assistant image placeholders ───────────────────────────────────────
console.log('\n[13] Codex-style image placeholders')
{
  COLS = 100
  ROWS = 30
  const { term, screen } = newScreen()
  const view = makeTurnView(screen)
  screen.draw()
  screen.paint(() => {
    view.image({ name: 'chart.png', width: 640, height: 480 })
    view.image({ name: 'detail.webp', width: 320, height: 200 })
  })
  const joined = term.all().join('\n')
  check('first assistant image uses [Image #1]', joined.includes('[Image #1] chart.png · 640×480'))
  check('second assistant image increments the placeholder', joined.includes('[Image #2] detail.webp · 320×200'))
  check('history formatter keeps text and image order', internals.messageDisplay([
    { type: 'text', text: 'before' },
    { type: 'image', attachment: { name: 'chart.png', width: 640, height: 480 } },
    { type: 'text', text: 'after' }
  ]) === 'before\n[Image #1] chart.png · 640×480\nafter')
  check('PNG signature is admitted without a private package export', internals.imageMediaType(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) === 'image/png')
  check('explicit text-only model is rejected before image send', internals.modelAcceptsImages({
    inputModalities: ['text']
  }) === false)
  check('declared image model is accepted before image send', internals.modelAcceptsImages({
    inputModalities: ['text', 'image']
  }) === true)
  check('unknown modality metadata follows DSH permissive preflight', internals.modelAcceptsImages({}) === true)
}

// ── 14. pasted image composer placeholders ────────────────────────────────
console.log('\n[14] pasted image composer placeholders')
{
  COLS = 100
  ROWS = 30
  const { term, screen } = newScreen()
  check('screen exposes pending image placeholders', typeof screen.setComposerImages === 'function')
  if (typeof screen.setComposerImages === 'function') {
    screen.setComposerImages([
      { name: 'first.png' },
      { name: 'second.jpg' }
    ])
    screen.draw()
    screen.insert('describe these')
    const inputLine = term.screen().find((row) => row.includes('❯'))
    check('pending images render before the draft', inputLine?.includes('[Image #1] [Image #2] describe these') ?? false, inputLine)
    screen.setComposerImages([])
    const cleared = term.screen().find((row) => row.includes('❯'))
    check('clearing attachments removes image placeholders', !(cleared?.includes('[Image #') ?? true), cleared)
  }
  check('shell-escaped pasted image paths are normalized',
    internals.normalizePastedPath?.('/tmp/My\\ Image.png') === '/tmp/My Image.png')
  check('quoted pasted image paths are normalized',
    internals.normalizePastedPath?.('"/tmp/My Image.png"') === '/tmp/My Image.png')
  check('filename-only image paste with spaces reaches clipboard fallback',
    internals.pastedImagePath?.('Screenshot 2026-08-20 at 19.00.00.png') === 'Screenshot 2026-08-20 at 19.00.00.png')
  check('ordinary multi-word text is not treated as one image path',
    internals.normalizePastedPath?.('describe this image') === undefined)
  check('built-in help distinguishes Control+V from Command+V on macOS',
    internals.help?.includes('ctrl+v') === true && internals.help?.includes('Control, not Command') === true)
}

// ── 15. multi-provider model catalog ──────────────────────────────────────
console.log('\n[15] multi-provider model catalog')
{
  const groups = [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'shared', name: 'Shared DS' }, { id: 'deepseek-v4-pro', name: 'V4 Pro' }] },
    { id: 'kimi-coding', name: 'Kimi Coding', models: [{ id: 'shared', name: 'Shared Kimi' }, { id: 'kimi-k2.5', name: 'Kimi K2.5' }] }
  ]
  check('provider/model request resolves across the whole catalog',
    internals.modelCatalogMatches?.(groups, 'kimi-coding/kimi-k2.5')?.[0]?.provider === 'kimi-coding')
  check('unique bare model id resolves to its provider',
    internals.modelCatalogMatches?.(groups, 'deepseek-v4-pro')?.[0]?.provider === 'deepseek-official')
  check('ambiguous bare model id keeps both provider choices',
    internals.modelCatalogMatches?.(groups, 'shared')?.length === 2)
}

// ── 16. user-invocable skill slash entries ────────────────────────────────
console.log('\n[16] user-invocable skill slash entries')
{
  const summaries = [
    { name: 'review-code', description: 'Review a change', invocation: { userInvocable: true, modelInvocable: true } },
    { name: 'write-release', description: 'Write release notes', invocation: { userInvocable: true, modelInvocable: false } },
    { name: 'hidden-skill', description: 'Model only', invocation: { userInvocable: false, modelInvocable: true } },
    { name: 'help', description: 'Collides with local help', invocation: { userInvocable: true, modelInvocable: true } },
    { name: 'compact', description: 'Collides with host command', invocation: { userInvocable: true, modelInvocable: true } }
  ]
  const commands = {
    list: () => [{ name: 'compact', description: 'Compact context', input: undefined }]
  }
  const items = internals.mergedMenuCommands?.(commands, {}, summaries) ?? []
  check('user-invocable skills join the slash menu',
    items.some((item) => item.name === '/review-code'))
  check('model-disabled skill stays available with user-only marker',
    items.some((item) => item.name === '/write-release' && item.desc.startsWith('user-only · ')))
  check('user-disabled skill is hidden',
    !items.some((item) => item.name === '/hidden-skill'))
  check('local and host commands win same-name skill collisions',
    items.filter((item) => item.name === '/help').length === 1
      && items.filter((item) => item.name === '/compact').length === 1
      && items.find((item) => item.name === '/compact')?.desc === 'Compact context')
  check('gesture parser matches whitespace-bounded skill references',
    JSON.stringify(internals.invokedSkillNames?.('/review-code inspect /write-release'))
      === JSON.stringify(['review-code', 'write-release'])
      && internals.invokedSkillNames?.('/usr/bin 5/8').length === 0)
  check('only a known user-invocable gesture is admitted as a skill prompt',
    internals.hasUserInvocableSkill?.(summaries, '/review-code inspect') === true
      && internals.hasUserInvocableSkill?.(summaries, '/hidden-skill inspect') === false
      && internals.hasUserInvocableSkill?.(summaries, '/unknown inspect') === false)

  const term = new Term(COLS, ROWS)
  const io = { stdout: { write: (chunk) => term.write(chunk) }, stderr: process.stderr }
  const screen = makeScreen(io, { model: 'm', effort: 'e', permission: 'p', step: 0, in: 0, out: 0, cache: 0, cwd: '/tmp', sessionId: 's' }, items)
  screen.draw()
  screen.insert('/review')
  screen.completeTab()
  const inputLine = term.screen().find((row) => row.includes('❯'))
  check('Tab inserts the Web-style skill prompt with a trailing space',
    inputLine?.includes('/review-code ') ?? false, inputLine)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
