/** Evaluate the two pure preset helpers directly from the production source. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const startupSource = readFileSync(join(here, '..', 'lib', 'startup.js'), 'utf8')

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `missing ${name} in lib/index.js`)
  const body = source.indexOf('{', start)
  let depth = 0
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`unterminated ${name} in lib/index.js`)
}

const helpers = new Function(`
  ${extractFunction('resolvePreset')}
  ${extractFunction('sessionBlank')}
  ${extractFunction('guardianFeedback')}
  return { resolvePreset, sessionBlank, guardianFeedback }
`)()

assert.equal(helpers.sessionBlank({ events: [] }), true)
assert.equal(helpers.sessionBlank({ events: [
  { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }
] }), true)
assert.equal(helpers.sessionBlank({ events: [{ type: 'turn/start', data: {} }] }), false)

assert.equal(helpers.resolvePreset({
  meta: { agentPreset: 'standard' },
  events: []
}), 'standard')
assert.equal(helpers.resolvePreset({
  meta: { agentPreset: 'auto' },
  events: [
    { type: 'agent-preset/selected', data: { agentPreset: 'code' } },
    { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }
  ]
}), 'minimal')
assert.equal(helpers.resolvePreset({
  meta: { agentPreset: 'auto' },
  events: [{ type: 'agent-preset/selected', data: { agentPreset: 'cordis' } }]
}), 'cordis')

assert.match(startupSource, /--preset guardian/u)
assert.match(startupSource, /auto\/guardian when installed/u)

const guardianPass = helpers.guardianFeedback({
  active: true,
  auditSequence: 1,
  traceCursor: 9,
  paused: false,
  lastAudit: { id: 'audit-pass', sequence: 1, verdict: 'pass', durationMs: 42, traceFrom: 2, traceTo: 9, summary: 'on track', findings: [] }
})
assert.equal(guardianPass.tone, 'success')
assert.match(guardianPass.text, /Guardian #1 · PASS/u)
assert.match(guardianPass.text, /audit audit-pass · trace 2→9/u)

const guardianCritical = helpers.guardianFeedback({
  active: true,
  paused: true,
  pendingApproval: { auditId: 'audit-critical', verdict: 'critical', status: 'pending' },
  lastAudit: { id: 'audit-critical', sequence: 2, verdict: 'critical', durationMs: 99, findings: [{ recommendation: 'repair the dispatch guard' }] }
})
assert.equal(guardianCritical.tone, 'error')
assert.match(guardianCritical.text, /repair the dispatch guard/u)
assert.match(guardianCritical.text, /a execute now · e edit & execute now/u)
const guardianWarning = helpers.guardianFeedback({
  active: true,
  paused: false,
  pendingApproval: { auditId: 'audit-warning', verdict: 'warning', status: 'pending' },
  lastAudit: { id: 'audit-warning', sequence: 3, verdict: 'warning', durationMs: 50, findings: [{ recommendation: 'tighten the check' }] }
})
assert.match(guardianWarning.text, /e edit & execute · runs after current tool call/u)
const guardianRetry = helpers.guardianFeedback({
  active: true,
  paused: true,
  pendingApproval: { auditId: 'audit-critical', verdict: 'critical', status: 'accepted' },
  remediation: { id: 'remediation-audit-critical', auditId: 'audit-critical', phase: 'execution-failed' },
  lastAudit: { id: 'audit-critical', sequence: 2, verdict: 'critical', durationMs: 99, findings: [] }
})
assert.match(guardianRetry.text, /a retry · e edit & retry/u)
assert.match(source, /guardians\.accept/u)
assert.match(source, /name === 'a'/u)
assert.match(source, /name === 'e'/u)
assert.match(source, /screen\.setBuffer\(editableText\)/u)
assert.match(source, /acceptGuardian\(editedText, edit\.auditId\)/u)
assert.match(source, /guardianView\?\.paused === true && name === 'c'/u)
assert.match(source, /remediation\.phase === 'completed'/u)
assert.match(source, /pendingApproval\?\.verdict !== 'critical' && name === 'r'/u)
assert.match(source, /ctx\.get\('sessionController'\)/u)
assert.match(source, /sessionController\.delete\(\{ sessionId: id \}\)/u)
assert.doesNotMatch(source, /rm\(dirname\(location\.path\)/u)

const collectorStart = startupSource.indexOf('export function collectImagePaths(')
assert.notEqual(collectorStart, -1, 'missing collectImagePaths in lib/startup.js')
const collectorBody = startupSource.indexOf('{', collectorStart)
let collectorEnd = -1
let collectorDepth = 0
for (let index = collectorBody; index < startupSource.length; index += 1) {
  if (startupSource[index] === '{') collectorDepth += 1
  if (startupSource[index] === '}') collectorDepth -= 1
  if (collectorDepth === 0) {
    collectorEnd = index + 1
    break
  }
}
const collectorSource = startupSource.slice(collectorStart, collectorEnd).replace(/^export /, '')
const collectImagePaths = new Function(`${collectorSource}; return collectImagePaths`)()
assert.deepEqual(collectImagePaths('a.png,b.jpg', ['first.webp']), ['first.webp', 'a.png', 'b.jpg'])

console.log('preset lock, durable selection, and repeatable image flag checks passed')
