import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { buildSourceOnlyRealization, type BuiltSample, type BuiltSetup } from '../../cad/execution/realization'
import { serializeEvaluatedDocumentSnapshot } from '../../cad/execution/snapshot'
import { evaluateDocumentEntry, loadCompiledCode } from '../../cad/execution/userModule'
import { ExperimentDefinition } from '../../cad/model/v3'
import { analyzeCadSource } from '../../cad/source/sourceAnalysis'
import {
  dcCurrentDensityKernel,
  KernelRegistry,
  runSimulationProgram,
  steadyStateHeatKernel,
  type SimulationResult,
} from '../../simulation'
import type { CaembleProgramExample } from './types'
import { CAEMBLE_PROGRAM_EXAMPLE_SEED, caembleProgramExamples } from '.'

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

async function prepareExample(example: CaembleProgramExample, seed = CAEMBLE_PROGRAM_EXAMPLE_SEED) {
  analyzeCadSource(example.structureCode, 'structure')
  analyzeCadSource(example.experimentCode, 'experiment')
  const [structureCode, experimentCode] = await Promise.all([
    compileSource(example.structureCode),
    compileSource(example.experimentCode),
  ])
  const structureEntry = loadCompiledCode(structureCode, 'structure')
  const experimentEntry = loadCompiledCode(experimentCode, 'experiment')
  expect(experimentEntry).toBeInstanceOf(ExperimentDefinition)
  if (!(experimentEntry instanceof ExperimentDefinition)) {
    throw new Error(`${example.id} did not compile to an Experiment definition.`)
  }
  const structureSnapshot = serializeEvaluatedDocumentSnapshot(
    evaluateDocumentEntry(structureEntry, 'structure', '1'.repeat(64), seed),
  )
  const experimentSnapshot = serializeEvaluatedDocumentSnapshot(
    evaluateDocumentEntry(experimentEntry, 'experiment', '2'.repeat(64), seed),
  )
  return {
    definition: experimentEntry.createProgramRuntime(experimentSnapshot.variables, experimentSnapshot.sourceHash),
    sample: buildSourceOnlyRealization(structureSnapshot) as BuiltSample,
    setup: buildSourceOnlyRealization(experimentSnapshot) as BuiltSetup,
  }
}

async function runExample(example: CaembleProgramExample, runId: string): Promise<SimulationResult> {
  const prepared = await prepareExample(example)
  return runSimulationProgram(
    prepared.definition,
    prepared.sample,
    prepared.setup,
    new KernelRegistry([dcCurrentDensityKernel, steadyStateHeatKernel]),
    new AbortController().signal,
    runId,
  )
}

function scalarRecordedData(result: SimulationResult, name: string) {
  const data = result.recordedData[name]?.data
  if (!data || typeof data !== 'object' || !('value' in data) || typeof data.value !== 'number') {
    throw new Error(`${name} did not produce a scalar output.`)
  }
  return data.value
}

describe('verified Experiment Program examples', () => {
  it('keeps unique immutable fixtures with matching declared tasks and RecordedData', async () => {
    expect(new Set(caembleProgramExamples.map((example) => example.id)).size).toBe(caembleProgramExamples.length)

    for (const [index, example] of caembleProgramExamples.entries()) {
      const { definition } = await prepareExample(example, 101 + index)
      expect(Object.keys(definition.tasks)).toEqual(example.verification.kernelTasks)
      expect(Object.keys(definition.recordedData)).toEqual(example.verification.recordedData)
      expect(Object.isFrozen(example)).toBe(true)
      expect(Object.isFrozen(example.verification)).toBe(true)
    }
  })

  it('runs the uniform bar to its analytic current without changing stateless kernel state', async () => {
    const example = caembleProgramExamples.find(({ id }) => id === 'dc-uniform-bar')!
    const result = await runExample(example, 'example-uniform')

    expect(scalarRecordedData(result, 'totalCurrent')).toBeCloseTo(14.9, 6)
    expect(result.trace.map(({ task, kernel, status }) => ({ task, kernel, status }))).toEqual([
      {
        task: 'solveCurrent',
        kernel: { name: 'dc-current-density', version: '0.0.0' },
        status: 'succeeded',
      },
    ])
    expect(result.finalStateRevision).toBe(0)
  })

  it('runs the notched conductor and records a finite 21 × 21 vector field', async () => {
    const example = caembleProgramExamples.find(({ id }) => id === 'dc-notched-current-density')!
    const result = await runExample(example, 'example-notched')
    const data = result.recordedData.currentDensity?.data as
      | Readonly<{
          value: readonly (readonly (readonly number[])[])[]
          axes?: readonly Readonly<{ ticks?: readonly number[] }>[]
        }>
      | undefined

    expect(data?.value).toHaveLength(21)
    expect(data?.value.every((row) => row.length === 21 && row.every((vector) => vector.length === 3))).toBe(true)
    expect(data?.value.flat(2).every(Number.isFinite)).toBe(true)
    expect(data?.axes?.map((axis) => axis.ticks?.length)).toEqual([21, 21])
    expect(scalarRecordedData(result, 'totalCurrent')).toBeGreaterThan(0)
    expect(result.trace.map(({ task }) => task)).toEqual(['solveField'])
  })

  it('runs coarse then fine and reproduces RecordedData without hashing tensor payloads', async () => {
    const example = caembleProgramExamples.find(({ id }) => id === 'dc-resolution-study')!
    const [first, second] = await Promise.all([
      runExample(example, 'example-resolution-a'),
      runExample(example, 'example-resolution-b'),
    ])

    expect(scalarRecordedData(first, 'coarseTotalCurrent')).toBeCloseTo(14.9, 6)
    expect(scalarRecordedData(first, 'fineTotalCurrent')).toBeCloseTo(14.9, 6)
    expect(
      first.trace.map(({ task, inputStateRevision, outputStateRevision }) => [
        task,
        inputStateRevision,
        outputStateRevision,
      ]),
    ).toEqual([
      ['solveCoarse', 0, 0],
      ['solveFine', 0, 0],
    ])
    expect(first.recordedData).toEqual(second.recordedData)
    expect(first.finalStateRevision).toBe(0)
  })

  it('hands Joule heating from DC to Heat and records the coupled temperature field', async () => {
    const example = caembleProgramExamples.find(({ id }) => id === 'electro-thermal-uniform-bar')!
    const result = await runExample(example, 'example-electro-thermal')
    const temperature = result.recordedData.temperature?.data as
      | Readonly<{
          value: readonly (readonly (readonly number[])[])[]
          axes?: readonly Readonly<{ ticks?: readonly number[] }>[]
        }>
      | undefined

    expect(scalarRecordedData(result, 'totalCurrent')).toBeCloseTo(14.9, 6)
    expect(scalarRecordedData(result, 'maximumTemperature')).toBeCloseTo(293.16853, 4)
    expect(temperature?.value).toHaveLength(20)
    expect(temperature?.value[0]).toHaveLength(11)
    expect(temperature?.value[0][0]).toHaveLength(11)
    expect(temperature?.axes?.map((axis) => axis.ticks?.length)).toEqual([20, 11, 11])
    expect(result.trace.map(({ task }) => task)).toEqual(['electric', 'thermal'])
    expect(result.trace[1].inputArtifacts.heatSource).toMatchObject({
      artifactType: 'caemble.dc/joule-heating@1',
    })
    expect(result.provenance.kernels).toEqual([
      { name: 'dc-current-density', version: '0.0.0' },
      { name: 'steady-state-heat', version: '0.0.0' },
    ])
    expect(result.finalStateRevision).toBe(0)
  })
})
