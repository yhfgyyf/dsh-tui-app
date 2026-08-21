import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const patch = await readFile(join(root, manifest.dsh?.bundle?.patch ?? ''), 'utf8')

assert.equal(manifest.name, 'dsh-tui-app')
assert.equal(manifest.private, undefined)
assert.equal(manifest.type, 'module')
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
assert.match(patch, /^\s*- id: agent-presets/mu)
assert.match(patch, /^\s*default: standard/mu)
assert.match(patch, /^\s*- id: tui-startup/mu)
assert.match(patch, /^\s*name: 'dsh-tui-app\/startup'/mu)
assert.match(patch, /^\s*- id: tui-runner/mu)
assert.match(patch, /^\s*name: 'dsh-tui-app'/mu)
assert.match(patch, /^\s*images: !!js ctx\.tuiStartup\.images \?\? \[\]/mu)

for (const dependency of [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/schemastery',
  'commander'
]) {
  assert.equal(typeof manifest.peerDependencies[dependency], 'string', `missing peer ${dependency}`)
}

for (const [dependency, range] of Object.entries(manifest.peerDependencies)) {
  if (dependency.startsWith('@deepseek-ai/dsh-')) {
    assert.equal(range, '^0.1.1-rc.1', `${dependency} must target the current DSH rc.1 line`)
  }
}

for (const relative of [
  'lib/index.js',
  'lib/startup.js',
  'cordis.patch.yml',
  'docs/assets/tui-startup.png',
  'LICENSE'
]) {
  await access(join(root, relative))
}

console.log('dsh.bundle manifest, peer contract, patch rows, and runtime files are complete')
