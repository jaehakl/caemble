import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compileCatalogExample, readCatalogExamples } from './catalog-example-support'
import { executeCompiledDocument, inspectCompiledDocument } from '../src/lib/cad/execution/userModule'
import { canonicalGeometryScene } from '../src/lib/cad/evaluation/canonical'
import { assertExperimentAuthoringSemantics } from '../src/lib/cad/simulation/authoringSemantics'
import { installCatalogRuntimeSlice } from '../src/lib/catalog/runtime'
import { resolveSceneMaterials } from '../src/lib/material/document'
import { buildMeasurement } from '../src/lib/cad/execution/measurement'
import type { Tensor } from '../src/lib/cad/model/types'
import { parseCatalogRuntimeSlice } from '../src/contracts/catalogValidators'

const database = path.resolve(process.argv[2] ?? '../catalog/caemble_catalog/catalog.sqlite3')
const outputDirectory = path.resolve(process.argv[3] ?? 'node_modules/.tmp/catalog-examples')
const { examples, catalog } = readCatalogExamples(database)
// Exercise the same response boundary as POST /catalog/runtime-slice before installation.
parseCatalogRuntimeSlice(catalog)
installCatalogRuntimeSlice(catalog)
mkdirSync(outputDirectory, { recursive: true })

for (const example of examples) {
  const compiled = compileCatalogExample(example, catalog)
  const { varsSchema } = inspectCompiledDocument(compiled)
  // The midpoint is deterministic and is the nominal configuration of these examples.
  const variables = Object.fromEntries(
    Object.entries(varsSchema).map(([name, entry]) => [
      name,
      entry.shape.reduceRight<Tensor>(
        (value, length) => Array.from({ length }, () => value),
        (entry.min + entry.max) / 2,
      ),
    ]),
  )
  const evaluated = executeCompiledDocument(compiled, variables, example.sourceBundle.files['simulate.py'])
  assertExperimentAuthoringSemantics(catalog, evaluated)
  const taskNames = Object.keys(evaluated.simulationProgram.tasks)
  assert.deepEqual(
    [
      ...new Set(
        Object.values(evaluated.simulationProgram.tasks).map((task) => `${task.kernel.name}@${task.kernel.version}`),
      ),
    ].sort(),
    example.relatedSolvers.map((solver) => `${solver.name}@${solver.version}`).sort(),
    `${example.key}: relatedSolvers must match the executable task identities`,
  )
  const measurement = buildMeasurement(
    {
      ...evaluated,
      scene: await canonicalGeometryScene(evaluated.scene),
      taskScenes: Object.fromEntries(
        await Promise.all(
          taskNames.map(async (name) => [name, await canonicalGeometryScene(evaluated.taskScenes[name])]),
        ),
      ),
    },
    resolveSceneMaterials(evaluated, null, catalog),
  )
  writeFileSync(path.join(outputDirectory, `${example.key}.json`), JSON.stringify(measurement), 'utf8')
  console.log(`${example.coordinate}: compiled, evaluated, and built ${taskNames.length} tasks`)
}
assert.equal(examples.length, 10)
