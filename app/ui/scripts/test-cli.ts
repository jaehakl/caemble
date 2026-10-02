import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { documents } from '../src/documentation'
import { calculationExampleInput, calculationExamples } from '../src/authoring/examples'

const repo = path.resolve('../..')
const cli = path.join(repo, 'app/ui/dist-cli/caemble.cjs')
const output = mkdtempSync(path.join(tmpdir(), 'caemble-cli-test-'))
function run(args: string[], expected = 0) {
  const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json', ...args], {
    cwd: output,
    env: { ...process.env, CAEMBLE_API_URL: 'http://127.0.0.1:1', CAEMBLE_API_TOKEN: 'source-path-test' },
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  })
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return JSON.parse(result.stdout)
}
for (const scenario of ['experiment', 'calculation', 'solver']) {
  const guide = run(['agent', 'guide', scenario])
  assert.equal(guide.id, scenario)
  assert.ok(guide.content.length > 1000)
  assert.deepEqual(run(['docs', 'show', scenario]), guide)
}
for (const document of documents) {
  const shown = run(['docs', 'show', document.id])
  assert.equal(shown.content, document.content, document.id)
  assert.equal(shown.sourcePath, document.sourcePath)
}
assert.ok(run(['docs', 'search', 'Nginx']).some((page: { id: string }) => page.id === 'operations.deployment'))
assert.equal(run(['docs', 'show', 'archive.calculation-plan'], 2).error.exitCode, 2)
const metadata = JSON.parse(readFileSync(path.join(repo, 'app/ui/dist-cli/build-info.json'), 'utf8'))
for (const document of documents) {
  const source = document.sourcePath
  assert.equal(
    metadata.inputs[source],
    createHash('sha256')
      .update(readFileSync(path.join(repo, document.sourcePath)))
      .digest('hex'),
  )
}
assert.equal(run(['unknown'], 2).error.exitCode, 2)
assert.match(run(['study', 'list'], 2).error.message, /Unknown command group: study/)
assert.match(run(['optimization', 'create'], 2).error.message, /optimization create/)
writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ kind: 'caemble.build', version: 2 }), 'utf8')
assert.equal(run(['png', 'geometry', output, '--out', path.join(output, 'invalid.png')], 4).error.exitCode, 4)
const forbiddenSource = path.join(output, 'forbidden-source')
mkdirSync(forbiddenSource)
writeFileSync(path.join(forbiddenSource, 'experiment.tsx'), 'export default null')
writeFileSync(path.join(forbiddenSource, 'object.ts'), 'export const unused = 1')
for (const command of ['check', 'build']) {
  const result = run(['experiment', command, forbiddenSource, '--out', path.join(output, command)], 1)
  assert.match(result.error.message, /object\.ts.*Allowed:/)
}
// A validly shaped old artifact must also be rejected before any item read or API request.
writeFileSync(
  path.join(output, 'manifest.json'),
  JSON.stringify({
    kind: 'caemble.build',
    version: 2,
    source_hash: 'a'.repeat(64),
    catalog_revision: 'test',
    builder_version: '2',
    mode: 'candidate',
    source_bundle: { files: { 'experiment.tsx': '', 'sensor.ts': '' } },
    items: [{ index: 1, file: 'items/1.json', input_hash: 'b'.repeat(64), byte_length: 1 }],
  }),
)
for (const args of [
  ['experiment', 'push', forbiddenSource, '--artifact', output],
  ['experiment', 'test', output, '--out', path.join(output, 'results')],
  ['batch', 'submit', output, '--experiment', '1'],
]) {
  const result = run(args, 4)
  assert.match(result.error.details.message, /sensor\.ts.*Allowed:/)
}
const fixture = path.join(output, 'fixture.json')
writeFileSync(fixture, JSON.stringify(calculationExampleInput), 'utf8')
for (const example of calculationExamples) {
  const source = path.join(output, `${example.id}.js`)
  const resultPath = path.join(output, `${example.id}.json`)
  writeFileSync(source, example.source, 'utf8')
  const checked = run(['calculation', 'check', source])
  assert.equal(checked.syntax, 'passed')
  assert.equal(checked.execution, 'not-run')
  const result = run(['calculation', 'run', source, '--fixture', fixture, '--out', resultPath])
  assert.equal(result.source_hash, checked.source_hash)
  assert.deepEqual(result.output, example.expected)
  assert.match(result.input_hash, /^[a-f0-9]{64}$/)
  assert.deepEqual(JSON.parse(readFileSync(`${resultPath}.input.json`, 'utf8')), calculationExampleInput)
  assert.equal(readFileSync(`${resultPath}.source.js`, 'utf8'), example.source)
  if (process.env.CAEMBLE_TEST_PNG === '1') {
    const png = run(['png', 'calculation', resultPath, '--out', `${resultPath}.png`])
    assert.ok(readFileSync(png.path).byteLength > 1000)
    assert.ok(png.renderer.chromium)
    assert.equal(png.provenance.input_hash, result.input_hash)
  }
}
console.log(
  `CLI guide, syntax, fixture execution, provenance${process.env.CAEMBLE_TEST_PNG === '1' ? ', and PNG' : ''} tests passed.`,
)
