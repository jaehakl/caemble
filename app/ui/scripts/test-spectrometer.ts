import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { executeCompiledDocument } from '../src/lib/cad/execution/userModule'
import { canonicalGeometryScene } from '../src/lib/cad/evaluation/canonical'
import { assertExperimentAuthoringSemantics } from '../src/lib/cad/simulation/authoringSemantics'
import { installCatalogRuntimeSlice } from '../src/lib/catalog/runtime'
import { sourceOnlyMaterialParameters } from '../src/lib/material'
import { compileCatalogExample, readCatalogExamples } from './catalog-example-support'

const database = path.resolve(process.argv[2] ?? '../catalog/caemble_catalog/catalog.sqlite3')
const outputDirectory = path.resolve(process.argv[3] ?? 'node_modules/.tmp/spectrometer')
const { examples, catalog } = readCatalogExamples(database)
installCatalogRuntimeSlice(catalog)
const example = examples.find((item) => item.key === 'czerny-turner-spectrometer')!
const files = example.sourceBundle.files
const compiled = compileCatalogExample(example, catalog)
const descriptor = catalog.solvers.find((solver) => solver.name === 'ray-tracing')!.descriptor
const nominal = { slitWidth: 0.05, grooveDensity: 600, gratingAngle: 0, focalLength: 100, detectorOffset: 0 }
const evaluated = executeCompiledDocument(compiled, nominal, files['simulate.py'])
assertExperimentAuthoringSemantics(catalog, evaluated)
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
      assertExperimentAuthoringSemantics(catalog, {
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
assertExperimentAuthoringSemantics(catalog, {
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
    descriptor: descriptor,
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
