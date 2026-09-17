import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { compileCatalogExample, readCatalogExamples } from './catalog-example-support'
import { executeCompiledDocument, inspectCompiledDocument } from '../src/lib/cad/execution/userModule'
import { canonicalGeometryScene } from '../src/lib/cad/evaluation/canonical'
import { assertExperimentAuthoringSemantics } from '../src/lib/cad/simulation/authoringSemantics'
import { installCatalogRuntimeSlice } from '../src/lib/catalog/runtime'
import { resolveSceneMaterials } from '../src/lib/material/document'
import { buildMeasurement } from '../src/lib/cad/execution/measurement'
import type { Tensor } from '../src/lib/cad/model/types'
import { parseCatalogRuntimeSlice } from '../src/contracts/catalogValidators'
import { commandJson, resolveEnvironment } from '../src/platform/node/environment'

const { values: options, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { key: { type: 'string', multiple: true }, report: { type: 'string' } },
})
assert.ok(positionals.length <= 2, 'Expected optional database and output directory, followed by --key <key>.')
const database = path.resolve(positionals[0] ?? '../catalog/caemble_catalog/catalog.sqlite3')
const outputDirectory = path.resolve(positionals[1] ?? 'node_modules/.tmp/catalog-examples')
const { examples, catalog, meta } = readCatalogExamples(database)
assert.ok(meta.experimentCount > 0, 'The Catalog must contain executable Examples.')
assert.equal(examples.length, meta.experimentCount, 'The fixture build must cover every Catalog Example.')
assert.equal(new Set(examples.map((example) => example.coordinate)).size, meta.experimentCount)
assert.equal(catalog.catalogRevision, meta.catalogRevision)
const keys = new Set(options.key ?? [])
for (const key of keys) {
  assert.ok(
    examples.some((example) => example.key === key),
    `Unknown Catalog Example: ${key}`,
  )
}
const selectedExamples = keys.size ? examples.filter((example) => keys.has(example.key)) : examples
// Exercise the same response boundary as POST /catalog/runtime-slice before installation.
parseCatalogRuntimeSlice(catalog)
installCatalogRuntimeSlice(catalog)
mkdirSync(outputDirectory, { recursive: true })
const programs: { key: string; source: string; tasks: string[]; records: string[] }[] = []
const started = performance.now()
const report = {
  buildCount: 0,
  catalogRevision: meta.catalogRevision,
  duration: 0,
  keys: [] as string[],
  validated: 0,
}
if (options.report) mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true })

for (const example of selectedExamples) {
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
  const program = measurement.experiment.simulationProgram
  programs.push({
    key: example.key,
    source: program.pythonSource,
    tasks: Object.keys(program.tasks),
    records: Object.keys(program.recordedData),
  })
  report.buildCount += 1
  report.keys.push(example.key)
  report.duration = (performance.now() - started) / 1000
  if (options.report) writeFileSync(options.report, JSON.stringify(report, null, 2), 'utf8')
  console.log(`${example.coordinate}: compiled, evaluated, and built ${taskNames.length} tasks`)
}
const environment = await resolveEnvironment({ repo: path.resolve('../..') })
const validated = (await commandJson(
  environment.python,
  [
    '-X',
    'utf8',
    '-c',
    `
import json, sys
from app.kernel.coordinator.program import validate_and_load_simulate
programs = json.load(sys.stdin)
for program in programs:
    try:
        validate_and_load_simulate(program['source'], task_names=program['tasks'], recorded_names=program['records'])
    except Exception as error:
        raise ValueError(f"{program['key']}: {error}") from error
print(json.dumps({'validated': len(programs)}))
`,
  ],
  { cwd: environment.cae, input: programs },
)) as { validated: number }
assert.equal(validated.validated, selectedExamples.length)
report.validated = validated.validated
report.duration = (performance.now() - started) / 1000
if (options.report) writeFileSync(options.report, JSON.stringify(report, null, 2), 'utf8')
console.log(
  `${selectedExamples.length} of ${meta.experimentCount} Catalog Examples compiled and built at ${meta.catalogRevision}`,
)
