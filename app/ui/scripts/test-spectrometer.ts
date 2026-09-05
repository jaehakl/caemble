import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { executeCompiledDocument } from '../src/lib/cad/execution/userModule'
import { canonicalGeometryScene } from '../src/lib/cad/evaluation/canonical'
import { assertExperimentAuthoringSemantics } from '../src/lib/cad/simulation/authoringSemantics'
import { installCatalogRuntimeSlice } from '../src/lib/catalog/runtime'
import { sourceOnlyMaterialParameters } from '../src/lib/material'
import type { CatalogRuntimeSlice } from '../src/contracts/catalog'
import type { CompiledCadDocument } from '../src/lib/cad/compiler/types'
import { catalogRuntimeTypes } from '../src/lib/cad/compiler/catalogTypeEnvironment'
import {
  analyzeBundleModuleSource,
  analyzeCadSource,
  analyzeGeometrySource,
  analyzeMaterialSource,
  analyzeTaskSource,
  assertExperimentModuleGraph,
} from '../src/lib/cad/source/sourceAnalysis'

const database = path.resolve(process.argv[2] ?? '../catalog/caemble_catalog/catalog.sqlite3')
const outputDirectory = path.resolve(process.argv[3] ?? 'node_modules/.tmp/spectrometer')
const payload = JSON.parse(
  execFileSync(
    'python',
    [
      '-X',
      'utf8',
      '-c',
      `
import sys,json
sys.path.insert(0,sys.argv[2])
from caemble_catalog import open_catalog
with open_catalog(sys.argv[1]) as c:
 e=c.experiment('czerny-turner-spectrometer')
 runtime=c.runtime_slice(solvers=[('ray-tracing','0.3.0')],quantity_kinds=[],material_parameters=[])
 print(json.dumps(dict(example=e,catalog=runtime,descriptor=c.get_solver_manifest('ray-tracing','0.3.0')['descriptor'])))
`,
      database,
      path.resolve('../catalog'),
    ],
    { encoding: 'utf8' },
  ),
) as {
  example: { sourceBundle: { files: Record<string, string> }; bundleHash: string }
  catalog: CatalogRuntimeSlice
  descriptor: unknown
}
installCatalogRuntimeSlice(payload.catalog)
const files = payload.example.sourceBundle.files
analyzeCadSource(files['experiment.tsx'])
analyzeGeometrySource(files['geometry.tsx'])
analyzeMaterialSource(files['material.tsx'])
analyzeTaskSource(files['tasks/trace.tsx'])
analyzeBundleModuleSource(files['layout.ts'], 'layout.ts')
assertExperimentModuleGraph(files)
const virtualRoot = path.resolve('node_modules/.tmp/spectrometer-source').replaceAll('\\', '/')
const virtualFiles = new Map(
  Object.entries(files)
    .filter(([name]) => /\.tsx?$/u.test(name))
    .map(([name, source]) => [`${virtualRoot}/${name}`, source]),
)
virtualFiles.set(`${virtualRoot}/core.d.ts`, readFileSync('src/lib/cad/api/caemble-core.d.ts', 'utf8'))
virtualFiles.set(`${virtualRoot}/jsx.d.ts`, readFileSync('src/lib/cad/api/cad-jsx.d.ts', 'utf8'))
virtualFiles.set(`${virtualRoot}/catalog.d.ts`, catalogRuntimeTypes(payload.catalog))
const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  baseUrl: virtualRoot,
  paths: { '@caemble/core': ['./core.d.ts'] },
  jsx: ts.JsxEmit.React,
  jsxFactory: 'h',
  jsxFragmentFactory: 'Fragment',
}
const host = ts.createCompilerHost(options)
const readFile = host.readFile.bind(host)
const fileExists = host.fileExists.bind(host)
const directoryExists = host.directoryExists?.bind(host)
host.readFile = (name) => virtualFiles.get(name.replaceAll('\\', '/')) ?? readFile(name)
host.fileExists = (name) => virtualFiles.has(name.replaceAll('\\', '/')) || fileExists(name)
host.directoryExists = (name) => name.replaceAll('\\', '/').startsWith(virtualRoot) || Boolean(directoryExists?.(name))
host.getSourceFile = (name, languageVersion) => {
  const source = host.readFile(name)
  return source === undefined ? undefined : ts.createSourceFile(name, source, languageVersion)
}
const program = ts.createProgram([...virtualFiles.keys()], options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
assert.equal(
  diagnostics.length,
  0,
  ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (name) => name,
    getNewLine: () => '\n',
  }),
)
const compiled: CompiledCadDocument = {
  sourceHash: payload.example.bundleHash,
  sources: Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => /\.tsx?$/u.test(name))
      .map(([name, source]) => [
        name,
        {
          entryFile: name,
          sourceHash: payload.example.bundleHash,
          code: ts.transpileModule(source, {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2022,
              jsx: ts.JsxEmit.React,
              jsxFactory: 'h',
              jsxFragmentFactory: 'Fragment',
            },
            fileName: name,
          }).outputText,
        },
      ]),
  ),
}
const nominal = { slitWidth: 0.05, grooveDensity: 600, gratingAngle: 0, focalLength: 100, detectorOffset: 0 }
const evaluated = executeCompiledDocument(compiled, nominal, files['simulate.py'])
assertExperimentAuthoringSemantics(payload.catalog, evaluated)
assert.equal(evaluated.scene.parts.length, 5)

const modified = executeCompiledDocument(compiled, { ...nominal, gratingAngle: 0.5 }, files['simulate.py'])
const originalScene = await canonicalGeometryScene(evaluated.scene)
const modifiedScene = await canonicalGeometryScene(modified.scene)
assert.deepEqual(
  originalScene.roots.find((root) => root.id.startsWith('detector')),
  modifiedScene.roots.find((root) => root.id.startsWith('detector')),
)
assert.notDeepEqual(
  originalScene.roots.find((root) => root.id.startsWith('grating')),
  modifiedScene.roots.find((root) => root.id.startsWith('grating')),
)

const task = evaluated.simulationProgram.tasks.trace
for (const [parameter, value, message] of [
  ['orders', [1, 1, 0], 'duplicates'],
  ['orders', [0], 'same non-zero length'],
  ['efficiencies', [0.5, 0.5, 0.5], 'sum to at most 1'],
  ['grooveDirection', [0, 0, 0], 'non-zero'],
  ['grooveDirection', [0, 1, 0], 'tangent'],
] as const) {
  const invalid = JSON.parse(JSON.stringify(task))
  invalid.config.boundaryConditions[0].parameters[parameter].value = value
  assert.throws(
    () =>
      assertExperimentAuthoringSemantics(payload.catalog, {
        ...evaluated,
        simulationProgram: { ...evaluated.simulationProgram, tasks: { trace: invalid } },
      }),
    new RegExp(message),
  )
}

mkdirSync(outputDirectory, { recursive: true })
const percentTask = JSON.parse(JSON.stringify(task))
percentTask.config.boundaryConditions[0].parameters.efficiencies.unit = '%'
percentTask.config.boundaryConditions[0].parameters.efficiencies.value = [10, 10, 70]
assertExperimentAuthoringSemantics(payload.catalog, {
  ...evaluated,
  simulationProgram: { ...evaluated.simulationProgram, tasks: { trace: percentTask } },
})
const materials = sourceOnlyMaterialParameters(
  evaluated.scene.parts.flatMap((part) => (part.material ? [part.material] : [])),
)
const taskScene = await canonicalGeometryScene(evaluated.taskScenes.trace)
writeFileSync(
  path.join(outputDirectory, 'measurement.json'),
  JSON.stringify({
    descriptor: payload.descriptor,
    task,
    simulationProgram: evaluated.simulationProgram,
    variables: nominal,
    world: {
      experiment: originalScene,
      task: taskScene,
      materials: {
        experiment: { parameters: materials.materialParameters },
        task: { parameters: { materials: {} } },
      },
    },
  }),
)
const refinedScene = JSON.parse(JSON.stringify(originalScene))
const refine = (node: Record<string, unknown>) => {
  if (node.kind === 'primitive' && node.primitive === 'sphere') (node.parameters as { segments: number }).segments *= 2
  if (node.child) refine(node.child as Record<string, unknown>)
  if (Array.isArray(node.children)) node.children.forEach(refine)
}
refinedScene.roots.forEach((root: { node: Record<string, unknown> }) => refine(root.node))
// Fresh domain identity prevents a geometry cache hit at the coarser resolution.
refinedScene.geometryHash += '-refined'
const measurement = JSON.parse(readFileSync(path.join(outputDirectory, 'measurement.json'), 'utf8'))
measurement.world.experiment = refinedScene
writeFileSync(path.join(outputDirectory, 'measurement-refined.json'), JSON.stringify(measurement))
console.log(`Spectrometer authoring and variable checks passed; canonical measurement: ${outputDirectory}`)
