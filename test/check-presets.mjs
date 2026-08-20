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
  return { resolvePreset, sessionBlank }
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
