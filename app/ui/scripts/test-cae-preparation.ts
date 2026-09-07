import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, cpSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileCatalogExample, readCatalogExamples } from './catalog-example-support'
import { prepareCaeMeasurement, type CaePreparationRequest } from '../src/server/caePreparation'
import { executeCompiledDocument, inspectCompiledDocument } from '../src/lib/cad/execution/userModule'
import { canonicalGeometryScene } from '../src/lib/cad/evaluation/canonical'
import { buildMeasurement } from '../src/lib/cad/execution/measurement'
import { resolveMaterialParameters, projectMaterialResolution } from '../src/lib/material/resolution'
import { installCatalogRuntimeSlice } from '../src/lib/catalog/runtime'
import type { Tensor } from '../src/lib/cad/model/types'

const { examples, catalog } = readCatalogExamples(path.resolve('../catalog/caemble_catalog/catalog.sqlite3'))
const declarations = path.resolve('src/lib/cad/api')
const materials = { names: [], materials: [], parameters: [], qualifiers: [] }
const temporary = mkdtempSync(path.join(os.tmpdir(), 'caemble-preparation-'))
cpSync('dist-cae', temporary, { recursive: true })
const executable = path.join(temporary, 'prepare.cjs')

try {
  assert.equal(
    JSON.parse(execFileSync(process.execPath, [executable, '--check'], { cwd: temporary, encoding: 'utf8' })).ready,
    true,
  )
  for (const example of examples) {
    installCatalogRuntimeSlice(catalog)
    const compiled = compileCatalogExample(example, catalog)
    const { varsSchema } = inspectCompiledDocument(compiled)
    const vars = Object.fromEntries(
      Object.entries(varsSchema).map(([name, entry]) => [
        name,
        entry.shape.reduceRight<Tensor>(
          (value, length) => Array.from({ length }, () => value),
          (entry.min + entry.max) / 2,
        ),
      ]),
    )
    const evaluated = executeCompiledDocument(compiled, vars, example.sourceBundle.files['simulate.py'])
    const taskNames = Object.keys(evaluated.taskScenes).sort()
    const commonMaterials = evaluated.scene.parts.flatMap((part) => (part.material ? [part.material] : []))
    const taskMaterials = Object.fromEntries(
      taskNames.map((name) => [
        name,
        evaluated.taskScenes[name].parts.flatMap((part) => (part.material ? [part.material] : [])),
      ]),
    )
    const shared = resolveMaterialParameters([...commonMaterials, ...Object.values(taskMaterials).flat()], [], [])
    const common = projectMaterialResolution(shared, commonMaterials)
    const tasks = Object.fromEntries(
      taskNames.map((name) => [name, projectMaterialResolution(shared, taskMaterials[name])]),
    )
    const expected = buildMeasurement(
      {
        ...evaluated,
        scene: await canonicalGeometryScene(evaluated.scene),
        taskScenes: Object.fromEntries(
          await Promise.all(
            taskNames.map(async (name) => [name, await canonicalGeometryScene(evaluated.taskScenes[name])]),
          ),
        ),
      },
      {
        ...common,
        taskMaterialParameters: Object.fromEntries(taskNames.map((name) => [name, tasks[name].materialParameters])),
        taskMaterialWarnings: Object.fromEntries(taskNames.map((name) => [name, tasks[name].warnings])),
      },
    )
    const request: CaePreparationRequest = {
      source_bundle: example.sourceBundle,
      source_hash: example.bundleHash,
      catalog,
      mode: 'candidate',
      vars,
      material_parameters: { experiment: expected.materialParameters, tasks: expected.taskMaterialParameters },
      materials,
    }
    const actual = JSON.parse(
      execFileSync(process.execPath, [executable], {
        cwd: temporary,
        input: JSON.stringify(request),
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    )
    assert.deepEqual(actual.measurement, JSON.parse(JSON.stringify(expected)), example.key)
    assert.deepEqual(actual.vars, vars)
    assert.deepEqual(actual.material_parameters, request.material_parameters)
    assert.equal('renderScene' in actual.measurement.experiment, false)
    console.log(`${example.key}: isolated artifact matches canonical browser input`)
  }
  assert.equal(examples.length, 9)

  const original = examples.find((example) => example.key === 'electro-thermal-notched-bar')!
  const source_bundle = {
    files: {
      ...original.sourceBundle.files,
      'material.tsx': original.sourceBundle.files['material.tsx'].replace(
        "'electrical.conductivity': {",
        "'electrical.conductivity': { errorRate: 0.1,",
      ),
    },
  }
  const request: CaePreparationRequest = {
    source_bundle,
    source_hash: 'sampled-material-test',
    catalog,
    mode: 'generate',
    materials,
  }
  const random = Math.random
  let samples = 0
  Math.random = () => {
    samples += 1
    return 0.75
  }
  let generated: Awaited<ReturnType<typeof prepareCaeMeasurement>>
  try {
    generated = await prepareCaeMeasurement(request, declarations)
  } finally {
    Math.random = random
  }
  const sampleCount = Object.values(
    inspectCompiledDocument(compileCatalogExample(original, catalog)).varsSchema,
  ).filter((entry) => entry.min !== entry.max).length
  assert.equal(samples, sampleCount + 1, 'Material error samples once across common and task scenes')
  const commonCopper = generated.material_parameters.experiment.materials.Copper
  for (const frozen of Object.values(generated.material_parameters.tasks))
    assert.deepEqual(frozen.materials.Copper, commonCopper)
  const electrical = commonCopper['electrical.conductivity'].value
  const sampledConductivity = (generated.vars.electricalConductivity as number) * 1.05
  assert.deepEqual('value' in electrical && electrical.value, [
    [sampledConductivity, 0, 0],
    [0, sampledConductivity, 0],
    [0, 0, sampledConductivity],
  ])
  Math.random = () => {
    throw new Error('Fixed inputs must never sample again')
  }
  try {
    const retried = await prepareCaeMeasurement(
      {
        ...request,
        mode: 'measurement',
        vars: generated.vars,
        material_parameters: generated.material_parameters,
      },
      declarations,
    )
    assert.deepEqual(retried.measurement, generated.measurement)
  } finally {
    Math.random = random
  }

  const databaseRequest: CaePreparationRequest = {
    ...request,
    source_bundle: {
      files: {
        ...source_bundle.files,
        'material.tsx':
          "import { Material } from '@caemble/core'\nexport const Copper = (_electrical: number, _thermal: number) => new Material('Copper', 'reference', { errorRate: 0.2 })\n",
      },
    },
    materials: {
      names: [{ id: 1, material_id: 17, name: 'Copper' }],
      materials: [{ id: 17, color: '#abcdef' }],
      parameters: Object.entries(commonCopper).map(([name, parameter], index) => ({
        id: index + 1,
        material_id: 17,
        name,
        value: parameter.value,
      })),
      qualifiers: [],
    },
  }
  Math.random = () => 0.75
  try {
    const databaseResult = await prepareCaeMeasurement(databaseRequest, declarations)
    const resolved = databaseResult.material_parameters.experiment
    assert.equal(resolved.materialColors?.Copper.color, '#abcdef')
    assert.equal(resolved.materials.Copper['electrical.conductivity'].origin, 'database')
    assert.equal(resolved.materials.Copper['electrical.conductivity'].materialId, 17)
    const value = resolved.materials.Copper['electrical.conductivity'].value
    assert.deepEqual('value' in value && value.value, [
      [sampledConductivity * 1.1, 0, 0],
      [0, sampledConductivity * 1.1, 0],
      [0, 0, sampledConductivity * 1.1],
    ])
    for (const task of Object.values(databaseResult.material_parameters.tasks)) assert.deepEqual(task, resolved)
  } finally {
    Math.random = random
  }

  const tensorExample = examples.find((example) => example.key === 'random-curved-edge-cylinder-array')!
  const tensor = await prepareCaeMeasurement({ ...request, source_bundle: tensorExample.sourceBundle }, declarations)
  assert.equal(Array.isArray(tensor.vars.arrayPeriodXY) && tensor.vars.arrayPeriodXY.length, 2)
  assert.equal(Array.isArray(tensor.vars.cellHeight) && tensor.vars.cellHeight.length, 4)

  const invalid = spawnSync(process.execPath, [executable], {
    cwd: temporary,
    input: JSON.stringify({ ...request, mode: 'measurement' }),
    encoding: 'utf8',
  })
  assert.equal(invalid.status, 1)
  assert.match(JSON.parse(invalid.stdout).error.message, /frozen Material snapshot/u)
  const forbidden = {
    ...source_bundle,
    files: { ...source_bundle.files, 'material.tsx': 'export const secret = process.env.SECRET\n' },
  }
  const rejected = spawnSync(process.execPath, [executable], {
    cwd: temporary,
    input: JSON.stringify({ ...request, source_bundle: forbidden }),
    encoding: 'utf8',
  })
  assert.equal(rejected.status, 1)
  assert.equal(JSON.parse(rejected.stdout).error.code, 'preparation_failed')
  const looping = {
    files: {
      'experiment.tsx':
        "import { experiment } from '@caemble/core'\nexport default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => { while (true) { /* bounded by runtime */ } }, recordedData: {} })",
      'geometry.tsx': 'export {}',
      'material.tsx': 'export {}',
      'simulate.py': 'pass',
    },
  }
  const timedOut = spawnSync(process.execPath, [executable], {
    cwd: temporary,
    input: JSON.stringify({ ...request, source_bundle: looping, evaluation_timeout_ms: 10 }),
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(timedOut.status, 1)
  assert.equal(JSON.parse(timedOut.stdout).error.code, 'evaluation_timeout')
  console.log('Material sampling, fixed retry, Tensor Vars, policy errors, and standalone deployment passed')
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temporary).startsWith('caemble-preparation-'))
  rmSync(temporary, { recursive: true, force: true })
}
