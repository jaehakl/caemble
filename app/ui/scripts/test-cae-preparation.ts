import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { compileCatalogExample, readCatalogExamples } from './catalog-example-support'
import { prepareCaeMeasurement, type CaePreparationRequest } from '../src/platform/node/build'
import { executeCompiledDocument, inspectCompiledDocument } from '../src/lib/cad/execution/userModule'
import { canonicalGeometryScene } from '../src/lib/cad/evaluation/canonical'
import { analysisGeometryProfile } from '../src/lib/cad/evaluation/precision'
import { buildMeasurement, measurementMaterialSnapshot } from '../src/lib/cad/execution/measurement'
import { resolveSceneMaterials } from '../src/lib/material/document'
import { installCatalogRuntimeSlice } from '../src/lib/catalog/runtime'
import { cadSourceHash } from '../src/lib/cad/source/document'
import type { Tensor } from '../src/lib/cad/model/types'

const { examples, catalog } = readCatalogExamples(path.resolve('../catalog/caemble_catalog/catalog.sqlite3'))
const declarations = path.resolve('src/lib/cad/api')
const temporary = mkdtempSync(path.join(os.tmpdir(), 'caemble-client-build-'))
cpSync('dist-cli', temporary, { recursive: true })
const executable = path.join(temporary, 'worker.cjs')

try {
  assert.ok(existsSync(executable))
  assert.ok(existsSync(path.join(temporary, 'caemble-core.d.ts')))
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
    const evaluated = executeCompiledDocument(
      compiled,
      vars,
      example.sourceBundle.files['simulate.py'],
      analysisGeometryProfile,
    )
    const taskNames = Object.keys(evaluated.taskScenes).sort()
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
      resolveSceneMaterials(evaluated, null, catalog),
    )
    const request: CaePreparationRequest = {
      source_bundle: example.sourceBundle,
      source_hash: example.bundleHash,
      catalog,
      mode: 'candidate',
      vars,
      material_snapshot: measurementMaterialSnapshot(expected),
    }
    const output = path.join(temporary, `${example.key}.json`)
    execFileSync(process.execPath, [executable], {
      cwd: temporary,
      input: JSON.stringify({ operation: 'build', build: request, output }),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    const actual = JSON.parse(readFileSync(output, 'utf8'))
    assert.deepEqual(actual.measurement, JSON.parse(JSON.stringify(expected)), example.key)
    assert.deepEqual(actual.measurement.experiment.variables, vars)
    assert.deepEqual(
      measurementMaterialSnapshot(actual.measurement),
      JSON.parse(JSON.stringify(request.material_snapshot)),
    )
    assert.equal('renderScene' in actual.measurement.experiment, false)
    console.log(`${example.key}: isolated artifact matches canonical browser input`)
  }
  assert.equal(examples.length, 15)

  const fdtd = examples.find((example) => example.key === 'fdtd-drude-slab')!
  const trcBundle = fdtd.sourceBundle
  const rcBundle = {
    files: {
      ...trcBundle.files,
      'tasks/fdtd.tsx': trcBundle.files['tasks/fdtd.tsx'].replace("drudeMethod: 'TRC'", "drudeMethod: 'RC'"),
    },
  }
  assert.notEqual(rcBundle.files['tasks/fdtd.tsx'], trcBundle.files['tasks/fdtd.tsx'])
  assert.equal(rcBundle.files['material.tsx'], trcBundle.files['material.tsx'])
  const rc = await prepareCaeMeasurement(
    {
      source_bundle: rcBundle,
      source_hash: await cadSourceHash({ kind: 'experiment', sourceBundle: rcBundle }),
      catalog,
      mode: 'candidate',
      vars: {},
    },
    declarations,
  )
  const trc = await prepareCaeMeasurement(
    {
      source_bundle: trcBundle,
      source_hash: await cadSourceHash({ kind: 'experiment', sourceBundle: trcBundle }),
      catalog,
      mode: 'candidate',
      vars: {},
    },
    declarations,
  )
  assert.deepEqual(rc.material_snapshot.experiment, trc.material_snapshot.experiment)
  assert.deepEqual(rc.material_snapshot.tasks, trc.material_snapshot.tasks)
  assert.deepEqual(rc.material_snapshot.modelDefinitions, trc.material_snapshot.modelDefinitions)
  assert.deepEqual(rc.material_snapshot.selections, trc.material_snapshot.selections)
  assert.ok(rc.material_snapshot.modelDefinitions.some((model) => model.key === 'em.drude-isotropic@1'))
  assert.equal(rc.material_snapshot.varsHash, trc.material_snapshot.varsHash)
  const rcTask = rc.measurement.experiment.simulationProgram.tasks.fdtd.config
  const trcTask = trc.measurement.experiment.simulationProgram.tasks.fdtd.config
  assert.match(JSON.stringify(rcTask), /"drudeMethod":"RC"/u)
  assert.match(JSON.stringify(trcTask), /"drudeMethod":"TRC"/u)
  assert.deepEqual(JSON.parse(JSON.stringify(rcTask).replace('"drudeMethod":"RC"', '"drudeMethod":"TRC"')), trcTask)
  assert.notEqual(rc.material_snapshot.sourceHash, trc.material_snapshot.sourceHash)
  assert.notEqual(
    createHash('sha256').update(JSON.stringify(rc)).digest('hex'),
    createHash('sha256').update(JSON.stringify(trc)).digest('hex'),
  )
  console.log('FDTD RC/TRC changes Task execution inputs while preserving every physical model input')

  const original = examples.find((example) => example.key === 'electro-thermal-notched-bar')!
  const source_bundle = {
    files: {
      ...original.sourceBundle.files,
      'experiment.tsx': original.sourceBundle.files['experiment.tsx'].replace(
        'electricalConductivity: { min: 5.96e7, max: 5.96e7 }',
        'electricalConductivity: { min: 1e7, max: 9e7 }',
      ),
    },
  }
  const request: CaePreparationRequest = {
    source_bundle,
    source_hash: 'candidate-model-vars-test',
    catalog,
    mode: 'generate',
    vars_mode: 'nominal',
  }
  const random = Math.random
  Math.random = () => {
    throw new Error('Model inputs must have no hidden random sampling')
  }
  try {
    const generated = await prepareCaeMeasurement(request, declarations)
    const commonCopper = generated.material_snapshot.experiment.materials.Copper
    for (const task of Object.values(generated.material_snapshot.tasks))
      assert.deepEqual(task.materials.Copper, commonCopper)
    const parameters = commonCopper.models.conduction.parameters.sigma as { value: unknown }
    assert.deepEqual(parameters.value, [
      [5e7, 0, 0],
      [0, 5e7, 0],
      [0, 0, 5e7],
    ])
    const retried = await prepareCaeMeasurement(
      { ...request, mode: 'measurement', vars: generated.vars, material_snapshot: generated.material_snapshot },
      declarations,
    )
    assert.deepEqual(retried.measurement, generated.measurement)
    const changed = await prepareCaeMeasurement(
      {
        ...request,
        mode: 'candidate',
        vars: { ...generated.vars, electricalConductivity: 6e7 },
        material_snapshot: generated.material_snapshot,
      },
      declarations,
    )
    const changedSigma = changed.material_snapshot.experiment.materials.Copper.models.conduction.parameters.sigma as {
      value: unknown
    }
    assert.deepEqual(changedSigma.value, [
      [6e7, 0, 0],
      [0, 6e7, 0],
      [0, 0, 6e7],
    ])
    assert.notEqual(changed.material_snapshot.varsHash, generated.material_snapshot.varsHash)
    await assert.rejects(
      () =>
        prepareCaeMeasurement(
          { ...request, mode: 'measurement', vars: changed.vars, material_snapshot: generated.material_snapshot },
          declarations,
        ),
      /does not match.*Vars/u,
    )
  } finally {
    Math.random = random
  }

  const tensorExample = examples.find((example) => example.key === 'random-curved-edge-cylinder-array')!
  const tensor = await prepareCaeMeasurement({ ...request, source_bundle: tensorExample.sourceBundle }, declarations)
  assert.equal(Array.isArray(tensor.vars.arrayPeriodXY) && tensor.vars.arrayPeriodXY.length, 2)
  assert.equal(Array.isArray(tensor.vars.cellHeight) && tensor.vars.cellHeight.length, 4)

  const invalid = spawnSync(process.execPath, [executable], {
    cwd: temporary,
    input: JSON.stringify({
      operation: 'build',
      build: { ...request, mode: 'measurement' },
      output: path.join(temporary, 'invalid.json'),
    }),
    encoding: 'utf8',
  })
  assert.equal(invalid.status, 1)
  assert.match(JSON.parse(invalid.stdout).error.message, /Material snapshot/u)
  const forbidden = {
    ...source_bundle,
    files: { ...source_bundle.files, 'material.tsx': 'export const secret = process.env.SECRET\n' },
  }
  const rejected = spawnSync(process.execPath, [executable], {
    cwd: temporary,
    input: JSON.stringify({
      operation: 'build',
      build: { ...request, source_bundle: forbidden },
      output: path.join(temporary, 'forbidden.json'),
    }),
    encoding: 'utf8',
  })
  assert.equal(rejected.status, 1)
  assert.match(JSON.parse(rejected.stdout).error.message, /process|forbidden|policy/iu)
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
    input: JSON.stringify({
      operation: 'build',
      build: { ...request, source_bundle: looping, evaluation_timeout_ms: 10 },
      output: path.join(temporary, 'loop.json'),
    }),
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(timedOut.status, 1)
  const timeoutDiagnostic = JSON.parse(timedOut.stdout).error
  assert.equal(timeoutDiagnostic.code, 'ERR_SCRIPT_EXECUTION_TIMEOUT')
  assert.equal(timeoutDiagnostic.stage, 'build')
  assert.equal(timeoutDiagnostic.sourceHash, request.source_hash)
  assert.equal(timeoutDiagnostic.referenceId, 'diagnostic.experiment')
  assert.equal(timeoutDiagnostic.location, null)
  assert.equal(timeoutDiagnostic.diagnostics[0].location, null)
  console.log('Model Vars reevaluation, frozen replay, Tensor Vars, policy errors, and isolated CLI worker passed')
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temporary).startsWith('caemble-client-build-'))
  rmSync(temporary, { recursive: true, force: true })
}
