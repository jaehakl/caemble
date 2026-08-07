import { transform } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildSourceOnlyRealization, canonicalizeCaeRealizations } from '../src/lib/cad/execution/realization'
import { serializeEvaluatedDocumentSnapshot } from '../src/lib/cad/execution/snapshot'
import { evaluateDocumentEntry, loadCompiledCode } from '../src/lib/cad/execution/userModule'
import {
  CAEMBLE_PROGRAM_EXAMPLE_SEED,
  caembleProgramExamples,
  type CaembleProgramExample,
} from '../src/lib/examples/programs'
import { serializeCaeRequest } from '../src/features/cae/request'

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function compileSource(source: string) {
  return (
    await transform(source, {
      format: 'cjs',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
      loader: 'tsx',
      platform: 'browser',
      target: 'es2020',
    })
  ).code
}

function sourceHash(source: string) {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

async function buildRealizations(example: CaembleProgramExample) {
  const structure = serializeEvaluatedDocumentSnapshot(
    evaluateDocumentEntry(
      loadCompiledCode(await compileSource(example.structureCode), 'structure'),
      'structure',
      sourceHash(example.structureCode),
      CAEMBLE_PROGRAM_EXAMPLE_SEED,
    ),
  )
  const experiment = serializeEvaluatedDocumentSnapshot(
    evaluateDocumentEntry(
      loadCompiledCode(await compileSource(example.experimentCode), 'experiment'),
      'experiment',
      sourceHash(example.experimentCode),
      CAEMBLE_PROGRAM_EXAMPLE_SEED,
      {},
      example.simulationCode,
      sourceHash(example.simulationCode),
    ),
  )
  const sample = buildSourceOnlyRealization(structure)
  const setup = buildSourceOnlyRealization(experiment)
  if (sample.kind !== 'sample' || setup.kind !== 'setup') {
    throw new Error(`${example.id} did not build a sample/setup pair.`)
  }
  return canonicalizeCaeRealizations(sample, setup)
}

const exampleId = argument('example')
const outputArgument = argument('out')
if (!exampleId || !outputArgument) {
  throw new Error('Usage: npm run export:cae-fixture -- --example <id> --out <directory>')
}
const example = caembleProgramExamples.find((candidate) => candidate.id === exampleId)
if (!example) {
  throw new Error(
    `Unknown example ${exampleId}. Available examples: ${caembleProgramExamples.map(({ id }) => id).join(', ')}`,
  )
}
const expected = example.verification.fixture
if (!expected) {
  throw new Error(`Example ${exampleId} has no deterministic CAE fixture expectation.`)
}

const outputDirectory = path.resolve(outputArgument)
const attachmentDirectory = path.join(outputDirectory, 'attachments')
if (outputDirectory === path.parse(outputDirectory).root || outputDirectory === process.cwd()) {
  throw new Error(`Refusing unsafe fixture output directory: ${outputDirectory}`)
}

const canonical = await buildRealizations(example)
const request = serializeCaeRequest(canonical.sample, canonical.setup)
await mkdir(outputDirectory, { recursive: true })
await rm(attachmentDirectory, { recursive: true, force: true })
await mkdir(attachmentDirectory)

const attachments = []
for (const [index, attachment] of request.attachments.entries()) {
  const file = `attachments/${String(index).padStart(3, '0')}-${attachment.id}.bin`
  await writeFile(path.join(outputDirectory, file), attachment.bytes)
  attachments.push({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    byteLength: attachment.bytes.byteLength,
    file,
  })
}
await writeFile(
  path.join(outputDirectory, 'request.json'),
  `${JSON.stringify({ formatVersion: 1, payload: request.payload, attachments }, null, 2)}\n`,
  'utf8',
)
await writeFile(
  path.join(outputDirectory, 'expected.json'),
  `${JSON.stringify({ formatVersion: 1, ...expected }, null, 2)}\n`,
  'utf8',
)

console.log(`Exported ${exampleId} CAE fixture to ${outputDirectory}`)
