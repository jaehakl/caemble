import { transform } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildSourceOnlyMeasurement } from '../src/lib/cad/execution/measurement'
import { serializeEvaluatedDocumentSnapshot } from '../src/lib/cad/execution/snapshot'
import { executeCompiledDocument, inspectCompiledDocument } from '../src/lib/cad/execution/userModule'
import { generateRandomVars } from '../src/lib/cad/model/vars'
import {
  CAD_COMPILER_VERSION,
  type CompiledCadDocument,
  type CompiledCadSource,
  type CompiledGeometryModule,
} from '../src/lib/cad/compiler/types'
import {
  cadSourceHash,
  CAD_SOURCE_API_VERSION,
  createCadSourceDocument,
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  EXPERIMENT_SIMULATION_PATH,
  experimentTaskPaths,
  type ExperimentSourceBundle,
} from '../src/lib/cad/source/document'
import { createEffectiveGeometryGraph } from '../src/lib/cad/source/effectiveGeometryGraph'
import { serializeCaeRequest } from '../src/features/cae/request'
import type { CatalogRuntimeSlice } from '../src/contracts/catalog'
import {
  installCatalogRuntimeSlice,
  registerSourceCatalogRuntimeSlice,
  sourceCatalogSolverContracts,
} from '../src/lib/catalog/runtime'

type CatalogExperiment = Readonly<{
  key: string
  relatedSolvers: readonly Readonly<{ name: string; version: string }>[]
  sourceBundle: ExperimentSourceBundle
  verification: Readonly<{
    fixture?: Readonly<{
      records: readonly unknown[]
      terminal: Readonly<Record<string, unknown>>
    }>
  }>
}>

const catalogRuntimeScript = `import json, sys
from caemble_catalog import Catalog
request = json.load(sys.stdin)
with Catalog.open_readonly() as catalog:
    result = catalog.runtime_slice(
        solvers=[(item["name"], item["version"]) for item in request["solvers"]],
        quantity_kinds=[],
        material_parameters=[],
        material_models=[],
    )
json.dump(result, sys.stdout, ensure_ascii=False)
`

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

function catalogExperiment(key: string) {
  const catalogRoot = path.resolve('../catalog')
  const executable = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const output = execFileSync(
    executable,
    [
      '-m',
      'caemble_catalog',
      '--database',
      path.join(catalogRoot, 'caemble_catalog/catalog.sqlite3'),
      'query',
      'experiment',
      key,
    ],
    {
      cwd: catalogRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: [catalogRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUTF8: '1',
      },
    },
  )
  return JSON.parse(output) as CatalogExperiment
}

function catalogRuntimeSlice(example: CatalogExperiment) {
  const catalogRoot = path.resolve('../catalog')
  const executable = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const output = execFileSync(executable, ['-c', catalogRuntimeScript], {
    cwd: catalogRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: [catalogRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONUTF8: '1',
    },
    input: JSON.stringify({ solvers: example.relatedSolvers }),
  })
  return JSON.parse(output) as CatalogRuntimeSlice
}

async function buildMeasurement(example: CatalogExperiment) {
  const catalog = catalogRuntimeSlice(example)
  installCatalogRuntimeSlice(catalog)
  const experimentDocument = createCadSourceDocument('experiment', example.sourceBundle)
  const sourceHash = await cadSourceHash(experimentDocument)
  registerSourceCatalogRuntimeSlice(sourceHash, catalog)
  const sourcePaths = [
    EXPERIMENT_ENTRY_PATH,
    EXPERIMENT_GEOMETRY_PATH,
    EXPERIMENT_MATERIAL_PATH,
    ...experimentTaskPaths(example.sourceBundle),
  ]
  const sources = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (entryFile) => {
        const source: CompiledCadSource = {
          apiVersion: CAD_SOURCE_API_VERSION,
          compilerVersion: CAD_COMPILER_VERSION,
          entryFile,
          code: await compileSource(example.sourceBundle.files[entryFile]),
          sourceHash,
        }
        return [entryFile, source] as const
      }),
    ),
  )
  const effective = await createEffectiveGeometryGraph(example.sourceBundle.geometrySnapshot)
  const modules = Object.fromEntries(
    await Promise.all(
      effective.modules.map(async (module) => {
        const compiled: CompiledGeometryModule = {
          apiVersion: CAD_SOURCE_API_VERSION,
          compilerVersion: CAD_COMPILER_VERSION,
          entryFile: module.coordinate,
          code: await compileSource(module.source),
          sourceHash,
          geometrySourceHash: module.sourceHash,
          moduleHash: module.moduleHash,
          exports: module.exports,
          imports: module.imports,
        }
        return [module.coordinate, compiled] as const
      }),
    ),
  )
  const geometryGraph: NonNullable<CompiledCadDocument['geometryGraph']> = {
    graphHash: effective.graphHash,
    entryImports: effective.entryImports,
    modules,
  }
  const compiled: CompiledCadDocument = {
    apiVersion: CAD_SOURCE_API_VERSION,
    compilerVersion: CAD_COMPILER_VERSION,
    sourceHash,
    sources,
    geometryGraph,
  }
  const simulationSource = example.sourceBundle.files[EXPERIMENT_SIMULATION_PATH]
  const inspection = inspectCompiledDocument(compiled)
  const experiment = serializeEvaluatedDocumentSnapshot(
    executeCompiledDocument(compiled, generateRandomVars(inspection.varsSchema), simulationSource),
  )
  return buildSourceOnlyMeasurement(experiment)
}

const exampleId = argument('example')
const outputArgument = argument('out')
if (!exampleId || !outputArgument) {
  throw new Error('Usage: npm run export:cae-fixture -- --example <id> --out <directory>')
}
const example = catalogExperiment(exampleId)
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
const request = serializeCaeRequest(measurement, sourceCatalogSolverContracts(measurement.experiment.sourceHash))
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

console.log(`Exported catalog Experiment ${exampleId} CAE fixture to ${outputDirectory}`)
