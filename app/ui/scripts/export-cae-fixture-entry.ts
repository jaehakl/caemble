import { transform } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildSourceOnlyMeasurement } from '../src/lib/cad/execution/measurement'
import { serializeEvaluatedDocumentSnapshot } from '../src/lib/cad/execution/snapshot'
import { evaluateDocumentEntry, loadCompiledCode, loadCompiledTaskCode } from '../src/lib/cad/execution/userModule'
import { generateRandomVars } from '../src/lib/cad/model/vars'
import {
  cadSourceHash,
  createCadSourceDocument,
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_SIMULATION_PATH,
  experimentTaskName,
  experimentTaskPaths,
} from '../src/lib/cad/source/document'
import { caembleProgramExamples, type CaembleProgramExample } from '../src/lib/examples/programs'
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

async function buildMeasurement(example: CaembleProgramExample) {
  const experimentDocument = createCadSourceDocument('experiment', example.experimentSourceBundle)
  const taskDefinitions = Object.fromEntries(
    await Promise.all(
      experimentTaskPaths(example.experimentSourceBundle).map(async (taskPath) => [
        experimentTaskName(taskPath)!,
        loadCompiledTaskCode(await compileSource(example.experimentSourceBundle.files[taskPath])),
      ]),
    ),
  )
  const experimentSource = example.experimentSourceBundle.files[EXPERIMENT_ENTRY_PATH]
  const simulationSource = example.experimentSourceBundle.files[EXPERIMENT_SIMULATION_PATH]
  const entry = loadCompiledCode(await compileSource(experimentSource))
  const experiment = serializeEvaluatedDocumentSnapshot(
    evaluateDocumentEntry(
      entry,
      await cadSourceHash(experimentDocument),
      generateRandomVars(entry.varsSchema),
      simulationSource,
      taskDefinitions,
    ),
  )
  return buildSourceOnlyMeasurement(experiment)
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

const measurement = await buildMeasurement(example)
const request = serializeCaeRequest(measurement)
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
