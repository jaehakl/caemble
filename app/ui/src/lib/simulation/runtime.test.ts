import { h } from '../cad/evaluation/jsx'
import { evaluateCadScene } from '../cad/evaluation/evaluator'
import { buildSourceOnlyRealization, type BuiltSample, type BuiltSetup } from '../cad/execution/realization'
import { serializeEvaluatedDocumentSnapshot } from '../cad/execution/snapshot'
import { registerDataTensorAttachment, releaseDataTensorAttachments } from '../cad/model/dataTensor'
import {
  ExperimentDefinition,
  structure,
  type ExperimentDefinitionOptions,
  type InferVars,
  type VarsSchemaDefinition,
} from '../cad/model/v3'
import { identityCartesianBasis } from '../quantitykind/identityBasis'
import { defineKernelTask } from './authoring'
import { SimulationKernelError } from './errors'
import type {
  KernelDataSpec,
  KernelDefinition,
  KernelDescriptor,
  KernelInputPortDescriptor,
  KernelObservationDescriptor,
  KernelTaskConfig,
} from './kernelContract'
import { KernelRegistry } from './registry'
import { exportSimulationResult } from './resultExport'
import { runSimulationProgram, type SimulationProgramRuntimeDefinition, type SimulationScriptApi } from './runtime'
import { assertSimulationResult } from './validation'
import type {
  ArtifactRef,
  DefinedKernelTask,
  RecordedDataSpec,
  ResolvedKernelTask,
  SimulationResult,
  SimulationWorld,
  StateRef,
} from './types'
import { describe, expect, it } from 'vitest'

const milliampSpec = Object.freeze({
  dtype: 'float64',
  unit: 'mA',
  quantityKind: 'electromagnetism.ElectricCurrent',
}) satisfies KernelDataSpec

const ampSpec = Object.freeze({
  dtype: 'float64',
  unit: 'A',
  quantityKind: 'electromagnetism.ElectricCurrent',
}) satisfies KernelDataSpec

function Specimen() {
  return h('box', { size: [10, 2, 2] })
}

function Fixture() {
  return h('box', { size: [1, 1, 1] })
}

type ResolvedTasks<Tasks extends Readonly<Record<string, DefinedKernelTask>>> = Readonly<{
  [Key in keyof Tasks]: Tasks[Key] extends DefinedKernelTask<
    infer Config,
    infer Artifacts,
    infer Observations,
    infer Inputs
  >
    ? ResolvedKernelTask<Config, Artifacts, Observations, Inputs>
    : never
}>

const conformanceSimulations = new WeakMap<object, SimulationProgramRuntimeDefinition['simulate']>()

function conformanceExperiment<
  const Schema extends VarsSchemaDefinition,
  const Tasks extends Readonly<Record<string, DefinedKernelTask>>,
  const Recorded extends Readonly<Record<string, RecordedDataSpec>>,
>(
  options: ExperimentDefinitionOptions<Schema, Tasks, Recorded> &
    Readonly<{
      simulate: (
        context: Readonly<{
          sim: SimulationScriptApi
          tasks: ResolvedTasks<Tasks>
          vars: InferVars<Schema>
          world: SimulationWorld
        }>,
      ) => Promise<StateRef> | StateRef
    }>,
) {
  const { simulate, ...definitionOptions } = options
  const definition = new ExperimentDefinition<Schema, Tasks, Recorded>(
    definitionOptions as ExperimentDefinitionOptions<Schema, Tasks, Recorded>,
  )
  conformanceSimulations.set(definition, simulate as SimulationProgramRuntimeDefinition['simulate'])
  return definition
}

function kernelDescriptor(
  name: string,
  artifactType: `${string}@${number}`,
  data: KernelDataSpec,
  inputPorts: Readonly<Record<string, KernelInputPortDescriptor>> = {},
  observations: Readonly<Record<string, KernelObservationDescriptor>> = {},
): KernelDescriptor {
  return Object.freeze({
    name,
    version: '1.0.0',
    description: `${name} test kernel`,
    referenceLengthUnit: 'm',
    minimumOutputs: 1,
    parameters: Object.freeze({}),
    materials: Object.freeze([]),
    inputPorts: Object.freeze(inputPorts),
    observations: Object.freeze(observations),
    methods: Object.freeze({
      initializations: Object.freeze([]),
      boundaryConditions: Object.freeze([]),
      outputs: Object.freeze([
        Object.freeze({
          methodId: `${name}.value`,
          description: 'Test scalar output',
          minimumOccurrences: 0,
          maximumOccurrences: 10,
          target: Object.freeze({
            source: 'structure' as const,
            kind: 'geometry' as const,
            minimumTargets: 0,
            maximumTargets: 0,
            minimumResolved: 0,
            maximumResolved: 0,
          }),
          parameters: Object.freeze({}),
          artifactType,
          data,
        }),
      ]),
    }),
  })
}

function taskConfig(descriptor: KernelDescriptor, key = 'value'): KernelTaskConfig {
  return Object.freeze({
    parameters: Object.freeze({}),
    initializations: Object.freeze([]),
    boundaryConditions: Object.freeze([]),
    outputs: Object.freeze([
      Object.freeze({
        key,
        methodId: descriptor.methods.outputs[0].methodId,
        target: Object.freeze([]),
        parameters: Object.freeze({}),
      }),
    ]),
  })
}

function createRealizations<
  Schema extends VarsSchemaDefinition,
  Tasks extends Readonly<Record<string, DefinedKernelTask>>,
  Recorded extends Readonly<Record<string, RecordedDataSpec>>,
>(definition: ExperimentDefinition<Schema, Tasks, Recorded>) {
  const structureDefinition = structure({
    lengthUnit: 'mm',
    geometry: () => h(Specimen, { id: 'specimen' }),
    varsSchema: {},
  })
  const structureVars = structureDefinition.resolveExternal({}, 11)
  const experimentVars = definition.resolveExternal({}, 13)
  const simulate = conformanceSimulations.get(definition)
  if (!simulate) throw new Error('Runtime conformance test is missing its simulate callback.')
  const runtime = Object.freeze({
    ...definition.createProgramRuntime(
      experimentVars,
      '2'.repeat(64),
      'async def simulate(*, sim, tasks, vars, world):\n    return None\n',
      '3'.repeat(64),
    ),
    simulate,
  })
  const structureSnapshot = serializeEvaluatedDocumentSnapshot({
    kind: 'structure',
    sourceHash: '1'.repeat(64),
    seed: 11,
    scene: evaluateCadScene(
      structureDefinition.evaluateResolvedGeometry(structureVars),
      {
        geometryGroup: structureDefinition.geometryGroup,
        surfaceGroup: structureDefinition.surfaceGroup,
      },
      'Structure',
      structureDefinition.lengthUnit,
    ),
    variables: structureVars,
    varsSchema: structureDefinition.varsSchema,
  })
  const experimentSnapshot = serializeEvaluatedDocumentSnapshot({
    kind: 'experiment',
    sourceHash: '2'.repeat(64),
    seed: 13,
    scene: evaluateCadScene(
      definition.evaluateResolvedGeometry(experimentVars),
      {
        geometryGroup: definition.geometryGroup,
        surfaceGroup: definition.surfaceGroup,
      },
      'Experiment',
      definition.lengthUnit,
    ),
    variables: experimentVars,
    varsSchema: definition.varsSchema,
    simulationProgram: runtime.manifest,
  })
  return {
    definition: runtime,
    sample: buildSourceOnlyRealization(structureSnapshot) as BuiltSample,
    setup: buildSourceOnlyRealization(experimentSnapshot) as BuiltSetup,
  }
}

describe('multiphysics simulation runtime', () => {
  it('exchanges a typed artifact, converts its unit, loops on scalar observations, and records only final data', async () => {
    const sourceDescriptor = kernelDescriptor('test.source', 'test/current@1', milliampSpec)
    const sinkDescriptor = kernelDescriptor(
      'test.sink',
      'test/current@1',
      ampSpec,
      {
        current: Object.freeze({
          description: 'Current from another physics kernel',
          artifactTypes: Object.freeze(['test/current@1'] as const),
          minimumOccurrences: 1,
          maximumOccurrences: 1,
          data: ampSpec,
        }),
      },
      {
        residual: Object.freeze({
          description: 'Iteration residual',
          type: 'number',
        }),
      },
    )
    let sinkCalls = 0
    const sourceKernel: KernelDefinition = Object.freeze({
      descriptor: sourceDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 1500 } } }
      },
    })
    const sinkKernel: KernelDefinition = Object.freeze({
      descriptor: sinkDescriptor,
      prepare: () => ({ prepared: null }),
      async execute({ inputs }) {
        expect(inputs.current).toEqual({ value: 1.5 })
        sinkCalls += 1
        return {
          artifacts: { value: inputs.current },
          observations: { residual: sinkCalls === 1 ? 0.5 : 0.01 },
        }
      },
    })
    const source = defineKernelTask<
      KernelTaskConfig,
      { value: 'test/current@1' },
      Record<string, never>,
      Record<string, never>
    >(sourceDescriptor, taskConfig(sourceDescriptor))
    const sink = defineKernelTask<
      KernelTaskConfig,
      { value: 'test/current@1' },
      { residual: number },
      { current: 'test/current@1' }
    >(sinkDescriptor, taskConfig(sinkDescriptor))
    const definition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ source, sink }),
      recordedData: { measuredCurrent: ampSpec },
      simulate: async ({ sim, tasks }) => {
        const produced = await sim.run(tasks.source)
        let previous
        for (;;) {
          const current = await sim.run(tasks.sink, {
            inputs: { current: produced.artifacts.value },
          })
          if (previous) sim.release(previous.artifacts.value)
          previous = current
          if (current.observations.residual < 0.1) break
        }
        sim.record('measuredCurrent', previous!.artifacts.value)
        sim.release(produced.artifacts.value)
        return previous!.state
      },
    })
    const { definition: runtime, sample, setup } = createRealizations(definition)
    const result = await runSimulationProgram(
      runtime,
      sample,
      setup,
      new KernelRegistry([sourceKernel, sinkKernel]),
      new AbortController().signal,
      'handoff-run',
    )

    expect(result.finalStateRevision).toBe(0)
    expect(result.recordedData).toEqual({
      measuredCurrent: {
        spec: ampSpec,
        data: { value: 1.5 },
      },
    })
    expect(result.trace).toHaveLength(3)
    expect(result.trace[1].inputArtifacts.current).toEqual({
      id: 'artifact-1',
      artifactType: 'test/current@1',
    })
    expect(JSON.stringify(result)).not.toContain('1500')
    expect(() => assertSimulationResult(result)).not.toThrow()

    const exportBytes = new Uint8Array(16)
    const exportView = new DataView(exportBytes.buffer)
    exportView.setFloat64(0, 2.5, true)
    exportView.setFloat64(8, 3.5, true)
    registerDataTensorAttachment('export.current.0', exportBytes)
    try {
      const exportResult = {
        ...result,
        recordedData: {
          measuredCurrent: {
            spec: { ...ampSpec, axes: [{ length: 2 }] },
            data: {
              shape: [2],
              storage: {
                kind: 'attachments',
                ids: ['export.current.0'],
                byteLength: exportBytes.byteLength,
              },
            },
          },
        },
      } as SimulationResult
      expect(JSON.parse(exportSimulationResult(exportResult)).recordedData.measuredCurrent.data).toEqual({
        value: [2.5, 3.5],
        axes: [{ ticks: [0, 1] }],
      })
    } finally {
      releaseDataTensorAttachments(['export.current.0'])
    }
  })

  it('normalizes unit and basis at the RecordedData boundary before allowing release', async () => {
    const rotatedBasis = Object.freeze([
      Object.freeze([0, 1, 0]),
      Object.freeze([-1, 0, 0]),
      Object.freeze([0, 0, 1]),
    ]) as typeof identityCartesianBasis
    const vectorSourceSpec = Object.freeze({
      dtype: 'float64',
      unit: 'A.m-2',
      quantityKind: 'electromagnetism.ElectricCurrentDensity',
      basis: rotatedBasis,
    }) satisfies KernelDataSpec
    const vectorTargetSpec = Object.freeze({
      ...vectorSourceSpec,
      basis: identityCartesianBasis,
    }) satisfies KernelDataSpec
    const scalarDescriptor = kernelDescriptor('test.record-unit', 'test/milliamp@1', milliampSpec)
    const vectorDescriptor = kernelDescriptor('test.record-basis', 'test/vector@1', vectorSourceSpec)
    const scalarKernel: KernelDefinition = {
      descriptor: scalarDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 1500 } } }
      },
    }
    const vectorKernel: KernelDefinition = {
      descriptor: vectorDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: [1, 0, 0] } } }
      },
    }
    const scalar = defineKernelTask(scalarDescriptor, taskConfig(scalarDescriptor))
    const vector = defineKernelTask(vectorDescriptor, taskConfig(vectorDescriptor))
    const definition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ scalar, vector }),
      recordedData: { current: ampSpec, currentDensity: vectorTargetSpec },
      simulate: async ({ sim, tasks }) => {
        const scalarResult = await sim.run(tasks.scalar)
        const vectorResult = await sim.run(tasks.vector)
        sim.record('current', scalarResult.artifacts.value)
        sim.record('currentDensity', vectorResult.artifacts.value)
        sim.release(scalarResult.artifacts.value)
        sim.release(vectorResult.artifacts.value)
        return vectorResult.state
      },
    })
    const realization = createRealizations(definition)
    const result = await runSimulationProgram(
      realization.definition,
      realization.sample,
      realization.setup,
      new KernelRegistry([scalarKernel, vectorKernel]),
      new AbortController().signal,
      'record-normalization',
    )

    expect(result.recordedData.current.data).toEqual({ value: 1.5 })
    expect(result.recordedData.currentDensity.data).toEqual({ value: [0, 1, 0] })
  })

  it('rejects semantic axis and RecordedData schema mismatches', async () => {
    const timeSeries = Object.freeze({
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
      axes: Object.freeze([Object.freeze({ name: 'time', unit: 's', quantityKind: 'Time' })]),
    }) satisfies KernelDataSpec
    const renamedAxis = Object.freeze({
      ...timeSeries,
      axes: Object.freeze([Object.freeze({ name: 'frequency', unit: 's', quantityKind: 'Time' })]),
    }) satisfies KernelDataSpec
    const producerDescriptor = kernelDescriptor('test.axis-source', 'test/series@1', timeSeries)
    const consumerDescriptor = kernelDescriptor('test.axis-sink', 'test/output@1', ampSpec, {
      series: Object.freeze({
        description: 'A semantically named time-series axis.',
        artifactTypes: Object.freeze(['test/series@1'] as const),
        minimumOccurrences: 1,
        maximumOccurrences: 1,
        data: renamedAxis,
      }),
    })
    const producerKernel: KernelDefinition = {
      descriptor: producerDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: [1], axes: [{ ticks: [0] }] } } }
      },
    }
    const consumerKernel: KernelDefinition = {
      descriptor: consumerDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 1 } } }
      },
    }
    const producer = defineKernelTask(producerDescriptor, taskConfig(producerDescriptor))
    const consumer = defineKernelTask(consumerDescriptor, taskConfig(consumerDescriptor))
    const handoffDefinition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ producer, consumer }),
      recordedData: {},
      simulate: async ({ sim, tasks }) => {
        const produced = await sim.run(tasks.producer)
        const consumed = await sim.run(tasks.consumer, { inputs: { series: produced.artifacts.value } })
        return consumed.state
      },
    })
    const handoff = createRealizations(handoffDefinition)
    await expect(
      runSimulationProgram(
        handoff.definition,
        handoff.sample,
        handoff.setup,
        new KernelRegistry([producerKernel, consumerKernel]),
        new AbortController().signal,
        'axis-mismatch',
      ),
    ).rejects.toThrow('incompatible metadata')

    const recordedDefinition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ producer }),
      recordedData: {
        voltage: {
          dtype: 'float64',
          unit: 'V',
          quantityKind: 'electromagnetism.Voltage',
          axes: [{ name: 'time', unit: 's', quantityKind: 'Time' }],
        },
      },
      simulate: async ({ sim, tasks }) => {
        const produced = await sim.run(tasks.producer)
        sim.record('voltage', produced.artifacts.value)
        return produced.state
      },
    })
    const recorded = createRealizations(recordedDefinition)
    await expect(
      runSimulationProgram(
        recorded.definition,
        recorded.sample,
        recorded.setup,
        new KernelRegistry([producerKernel]),
        new AbortController().signal,
        'record-schema-mismatch',
      ),
    ).rejects.toThrow('incompatible dtype, Quantity Kind, or axis rank')
  })

  it('keeps kernel state namespaced and rolls back state and artifacts from a failed invocation', async () => {
    const descriptor = kernelDescriptor('test.stateful', 'test/count@1', ampSpec)
    let call = 0
    const kernel: KernelDefinition = Object.freeze({
      descriptor,
      prepare: () => ({ prepared: null }),
      async execute({ state }) {
        call += 1
        const current = (state as { count?: number } | undefined)?.count ?? 0
        if (call === 2) {
          if (state) (state as { count: number }).count = 99
          return {
            state,
            artifacts: {},
          }
        }
        if (call === 4) {
          return {
            artifacts: { value: { value: current } },
          }
        }
        const count = current + 1
        return {
          state: { count },
          artifacts: { value: { value: count } },
        }
      },
    })
    const step = defineKernelTask<
      KernelTaskConfig,
      { value: 'test/count@1' },
      Record<string, never>,
      Record<string, never>
    >(descriptor, taskConfig(descriptor))
    let recoveredArtifactId = ''
    const definition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ step }),
      recordedData: { count: ampSpec },
      simulate: async ({ sim, tasks }) => {
        const first = await sim.run(tasks.step)
        await expect(sim.run(tasks.step, { state: first.state })).rejects.toBeInstanceOf(SimulationKernelError)
        const recovered = await sim.run(tasks.step, { state: first.state })
        recoveredArtifactId = recovered.artifacts.value.id
        const unchanged = await sim.run(tasks.step, { state: recovered.state })
        sim.release(first.artifacts.value)
        sim.release(recovered.artifacts.value)
        sim.record('count', unchanged.artifacts.value)
        return unchanged.state
      },
    })
    const { definition: runtime, sample, setup } = createRealizations(definition)
    const result = await runSimulationProgram(
      runtime,
      sample,
      setup,
      new KernelRegistry([kernel]),
      new AbortController().signal,
      'atomic-run',
    )

    expect(result.finalStateRevision).toBe(2)
    expect(recoveredArtifactId).toBe('artifact-2')
    expect(result.recordedData.count.data).toEqual({ value: 2 })
    expect(result.trace.map((entry) => [entry.status, entry.outputStateRevision])).toEqual([
      ['succeeded', 1],
      ['failed', null],
      ['succeeded', 2],
      ['succeeded', 2],
    ])
  })

  it('accepts any structured-cloneable opaque state and uses omission as the unchanged signal', async () => {
    const descriptor = kernelDescriptor('test.opaque-state', 'test/opaque@1', ampSpec)
    let call = 0
    const kernel: KernelDefinition = {
      descriptor,
      prepare: () => ({ prepared: null }),
      async execute({ state }) {
        call += 1
        if (call === 1) {
          return {
            state: new Blob(['opaque state']),
            artifacts: { value: { value: 1 } },
          }
        }
        expect(state).toBeInstanceOf(Blob)
        expect(await (state as Blob).text()).toBe('opaque state')
        return {
          artifacts: { value: { value: 2 } },
        }
      },
    }
    const task = defineKernelTask(descriptor, taskConfig(descriptor))
    const definition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ task }),
      recordedData: { final: ampSpec },
      simulate: async ({ sim, tasks }) => {
        const initialized = await sim.run(tasks.task)
        const unchanged = await sim.run(tasks.task, { state: initialized.state })
        sim.record('final', unchanged.artifacts.value)
        return unchanged.state
      },
    })
    const realization = createRealizations(definition)
    const result = await runSimulationProgram(
      realization.definition,
      realization.sample,
      realization.setup,
      new KernelRegistry([kernel]),
      new AbortController().signal,
      'opaque-state-run',
    )

    expect(result.finalStateRevision).toBe(1)
    expect(result.recordedData.final.data).toEqual({ value: 2 })
  })

  it('keeps kernel identities collision-free when names and versions contain delimiters', async () => {
    const firstDescriptor = Object.freeze({
      ...kernelDescriptor('test@identity', 'test/identity@1', ampSpec),
      version: 'one',
    })
    const secondDescriptor = Object.freeze({
      ...kernelDescriptor('test', 'test/identity@1', ampSpec),
      version: 'identity@one',
    })
    const seenStates: unknown[] = []
    const createKernel = (descriptor: KernelDescriptor): KernelDefinition => ({
      descriptor,
      prepare: () => ({ prepared: null }),
      async execute({ state }) {
        seenStates.push(state)
        const count = ((state as { count?: number } | undefined)?.count ?? 0) + 1
        return {
          state: { count },
          artifacts: { value: { value: count } },
        }
      },
    })
    const first = defineKernelTask(firstDescriptor, taskConfig(firstDescriptor))
    const second = defineKernelTask(secondDescriptor, taskConfig(secondDescriptor))
    const definition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ first, second }),
      recordedData: { final: ampSpec },
      simulate: async ({ sim, tasks }) => {
        const firstRun = await sim.run(tasks.first)
        const secondRun = await sim.run(tasks.second, { state: firstRun.state })
        const finalRun = await sim.run(tasks.first, { state: secondRun.state })
        sim.record('final', finalRun.artifacts.value)
        return finalRun.state
      },
    })
    const realization = createRealizations(definition)
    const result = await runSimulationProgram(
      realization.definition,
      realization.sample,
      realization.setup,
      new KernelRegistry([createKernel(firstDescriptor), createKernel(secondDescriptor)]),
      new AbortController().signal,
      'identity-run',
    )

    expect(seenStates).toEqual([undefined, undefined, { count: 1 }])
    expect(result.finalStateRevision).toBe(3)
    expect(result.recordedData.final.data).toEqual({ value: 2 })
    expect(result.provenance.kernels).toEqual([
      { name: 'test@identity', version: 'one' },
      { name: 'test', version: 'identity@one' },
    ])
  })

  it('latches use-after-release even when orchestration code catches it', async () => {
    const sourceDescriptor = kernelDescriptor('test.release-source', 'test/released@1', ampSpec)
    const sinkDescriptor = kernelDescriptor('test.release-sink', 'test/released@1', ampSpec, {
      value: Object.freeze({
        description: 'Released input',
        artifactTypes: Object.freeze(['test/released@1'] as const),
        minimumOccurrences: 1,
        maximumOccurrences: 1,
      }),
    })
    const sourceKernel: KernelDefinition = {
      descriptor: sourceDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 1 } } }
      },
    }
    const sinkKernel: KernelDefinition = {
      descriptor: sinkDescriptor,
      prepare: () => ({ prepared: null }),
      async execute({ inputs }) {
        return { artifacts: { value: inputs.value } }
      },
    }
    const source = defineKernelTask(sourceDescriptor, taskConfig(sourceDescriptor))
    const sink = defineKernelTask(sinkDescriptor, taskConfig(sinkDescriptor))
    const definition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ source, sink }),
      recordedData: {},
      simulate: async ({ sim, tasks }) => {
        const produced = await sim.run(tasks.source)
        sim.release(produced.artifacts.value)
        try {
          await sim.run(tasks.sink, { inputs: { value: produced.artifacts.value } })
        } catch {
          // Fatal orchestration failures stay latched.
        }
        return produced.state
      },
    })
    const { definition: runtime, sample, setup } = createRealizations(definition)
    await expect(
      runSimulationProgram(
        runtime,
        sample,
        setup,
        new KernelRegistry([sourceKernel, sinkKernel]),
        new AbortController().signal,
        'release-run',
      ),
    ).rejects.toThrow('already been released')
  })

  it('rejects required, unknown, and wrong-type input handoffs before kernel execution', async () => {
    const producerDescriptor = kernelDescriptor('test.input-source', 'test/other@1', ampSpec)
    const consumerDescriptor = kernelDescriptor('test.input-consumer', 'test/current@1', ampSpec, {
      current: Object.freeze({
        description: 'Required current',
        artifactTypes: Object.freeze(['test/current@1'] as const),
        minimumOccurrences: 1,
        maximumOccurrences: 1,
        data: ampSpec,
      }),
    })
    const producerKernel: KernelDefinition = {
      descriptor: producerDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 1 } } }
      },
    }
    const consumerKernel: KernelDefinition = {
      descriptor: consumerDescriptor,
      prepare: () => ({ prepared: null }),
      async execute({ inputs }) {
        return { artifacts: { value: inputs.current } }
      },
    }
    const producer = defineKernelTask(producerDescriptor, taskConfig(producerDescriptor))
    const consumer = defineKernelTask(consumerDescriptor, taskConfig(consumerDescriptor))
    const makeDefinition = (mode: 'required' | 'unknown' | 'prototype' | 'wrong-type') =>
      conformanceExperiment({
        lengthUnit: 'mm',
        geometry: () => h(Fixture, { id: 'fixture' }),
        varsSchema: {},
        tasks: () => ({ producer, consumer }),
        recordedData: {},
        simulate: async ({ sim, tasks }) => {
          if (mode === 'required') {
            await sim.run(tasks.consumer, { inputs: {} })
            return sim.initialState
          }
          const produced = await sim.run(tasks.producer)
          await sim.run(tasks.consumer, {
            inputs:
              mode === 'unknown'
                ? { unexpected: produced.artifacts.value }
                : mode === 'prototype'
                  ? { toString: produced.artifacts.value }
                  : { current: produced.artifacts.value },
          })
          return produced.state
        },
      })

    for (const [mode, message] of [
      ['required', 'requires 1..1 artifacts'],
      ['unknown', 'is not declared'],
      ['prototype', '"toString" is not declared'],
      ['wrong-type', 'does not accept artifact type test/other@1'],
    ] as const) {
      const realization = createRealizations(makeDefinition(mode))
      await expect(
        runSimulationProgram(
          realization.definition,
          realization.sample,
          realization.setup,
          new KernelRegistry([producerKernel, consumerKernel]),
          new AbortController().signal,
          `inputs-${mode}`,
        ),
      ).rejects.toThrow(message)
    }
  })

  it('rejects foreign-run and same-run forged artifact references and concurrent sim.run calls', async () => {
    const descriptor = kernelDescriptor('test.sequential', 'test/sequential@1', ampSpec, {
      value: Object.freeze({
        description: 'Input',
        artifactTypes: Object.freeze(['test/sequential@1'] as const),
        minimumOccurrences: 0,
        maximumOccurrences: 1,
      }),
    })
    const kernel: KernelDefinition = {
      descriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        await Promise.resolve()
        return { artifacts: { value: { value: 1 } } }
      },
    }
    const task = defineKernelTask(descriptor, taskConfig(descriptor))
    let foreignRef: ArtifactRef<'test/sequential@1'> | undefined
    const originDefinition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ task }),
      recordedData: {},
      simulate: async ({ sim, tasks }) => {
        const produced = await sim.run(tasks.task)
        foreignRef = produced.artifacts.value as ArtifactRef<'test/sequential@1'>
        return produced.state
      },
    })
    const origin = createRealizations(originDefinition)
    await runSimulationProgram(
      origin.definition,
      origin.sample,
      origin.setup,
      new KernelRegistry([kernel]),
      new AbortController().signal,
      'origin-run',
    )
    const foreignDefinition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ task }),
      recordedData: {},
      simulate: async ({ sim, tasks }) => {
        await sim.run(tasks.task, { inputs: { value: foreignRef! } })
        return sim.initialState
      },
    })
    const foreign = createRealizations(foreignDefinition)
    await expect(
      runSimulationProgram(
        foreign.definition,
        foreign.sample,
        foreign.setup,
        new KernelRegistry([kernel]),
        new AbortController().signal,
        'foreign-target-run',
      ),
    ).rejects.toThrow('belongs to another run')

    for (const referenceRunId of ['another-run', 'forged-run']) {
      const forgedDefinition = conformanceExperiment({
        lengthUnit: 'mm',
        geometry: () => h(Fixture, { id: 'fixture' }),
        varsSchema: {},
        tasks: () => ({ task }),
        recordedData: {},
        simulate: async ({ sim, tasks }) => {
          try {
            await sim.run(tasks.task, {
              inputs: {
                value: {
                  runId: referenceRunId,
                  id: 'artifact-1',
                  artifactType: 'test/sequential@1',
                } as ArtifactRef<'test/sequential@1'>,
              },
            })
          } catch {
            // Fatal reference failures stay latched.
          }
          return sim.initialState
        },
      })
      const forged = createRealizations(forgedDefinition)
      await expect(
        runSimulationProgram(
          forged.definition,
          forged.sample,
          forged.setup,
          new KernelRegistry([kernel]),
          new AbortController().signal,
          'forged-run',
        ),
      ).rejects.toThrow('forged, uncommitted, or belongs to another run')
    }

    const concurrentDefinition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ task }),
      recordedData: {},
      simulate: async ({ sim, tasks }) => {
        await Promise.all([sim.run(tasks.task), sim.run(tasks.task)])
        return sim.initialState
      },
    })
    const concurrent = createRealizations(concurrentDefinition)
    await expect(
      runSimulationProgram(
        concurrent.definition,
        concurrent.sample,
        concurrent.setup,
        new KernelRegistry([kernel]),
        new AbortController().signal,
        'concurrent-run',
      ),
    ).rejects.toThrow('executed sequentially')
  })

  it('requires every global RecordedData key exactly once and rejects undeclared names', async () => {
    const descriptor = kernelDescriptor('test.record', 'test/record@1', ampSpec)
    const kernel: KernelDefinition = {
      descriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 1 } } }
      },
    }
    const task = defineKernelTask(descriptor, taskConfig(descriptor))
    const makeDefinition = (mode: 'missing' | 'duplicate' | 'undeclared' | 'prototype') =>
      conformanceExperiment({
        lengthUnit: 'mm',
        geometry: () => h(Fixture, { id: 'fixture' }),
        varsSchema: {},
        tasks: () => ({ task }),
        recordedData: { final: ampSpec },
        simulate: async ({ sim, tasks }) => {
          const result = await sim.run(tasks.task)
          if (mode !== 'missing') {
            sim.record(
              mode === 'undeclared' ? 'other' : mode === 'prototype' ? 'toString' : 'final',
              result.artifacts.value,
            )
          }
          if (mode === 'duplicate') sim.record('final', result.artifacts.value)
          return result.state
        },
      })

    for (const [mode, message] of [
      ['missing', 'did not record required RecordedData'],
      ['duplicate', 'recorded more than once'],
      ['undeclared', 'is not declared'],
      ['prototype', '"toString" is not declared'],
    ] as const) {
      const realization = createRealizations(makeDefinition(mode))
      await expect(
        runSimulationProgram(
          realization.definition,
          realization.sample,
          realization.setup,
          new KernelRegistry([kernel]),
          new AbortController().signal,
          `record-${mode}`,
        ),
      ).rejects.toThrow(message)
    }
  })

  it('discards staged RecordedData when a later kernel fails', async () => {
    const firstDescriptor = kernelDescriptor('test.staged', 'test/staged@1', ampSpec)
    const failingDescriptor = kernelDescriptor('test.after-record', 'test/after-record@1', ampSpec)
    const firstKernel: KernelDefinition = {
      descriptor: firstDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 4 } } }
      },
    }
    const failingKernel: KernelDefinition = {
      descriptor: failingDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        throw new SimulationKernelError('backend', failingDescriptor, 'downstream failure')
      },
    }
    const first = defineKernelTask(firstDescriptor, taskConfig(firstDescriptor))
    const failing = defineKernelTask(failingDescriptor, taskConfig(failingDescriptor))
    const definition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ first, failing }),
      recordedData: { final: ampSpec },
      simulate: async ({ sim, tasks }) => {
        const produced = await sim.run(tasks.first)
        sim.record('final', produced.artifacts.value)
        await sim.run(tasks.failing)
        return produced.state
      },
    })
    const realization = createRealizations(definition)

    await expect(
      runSimulationProgram(
        realization.definition,
        realization.sample,
        realization.setup,
        new KernelRegistry([firstKernel, failingKernel]),
        new AbortController().signal,
        'staging-rollback',
      ),
    ).rejects.toThrow('downstream failure')
  })

  it('keeps equal task-local output keys isolated when recording different global names', async () => {
    const firstDescriptor = kernelDescriptor('test.first-local', 'test/local@1', ampSpec)
    const secondDescriptor = kernelDescriptor('test.second-local', 'test/local@1', ampSpec)
    const firstKernel: KernelDefinition = {
      descriptor: firstDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 1 } } }
      },
    }
    const secondKernel: KernelDefinition = {
      descriptor: secondDescriptor,
      prepare: () => ({ prepared: null }),
      async execute() {
        return { artifacts: { value: { value: 2 } } }
      },
    }
    const first = defineKernelTask(firstDescriptor, taskConfig(firstDescriptor))
    const second = defineKernelTask(secondDescriptor, taskConfig(secondDescriptor))
    const definition = conformanceExperiment({
      lengthUnit: 'mm',
      geometry: () => h(Fixture, { id: 'fixture' }),
      varsSchema: {},
      tasks: () => ({ first, second }),
      recordedData: { first: ampSpec, second: ampSpec },
      simulate: async ({ sim, tasks }) => {
        const firstResult = await sim.run(tasks.first)
        const secondResult = await sim.run(tasks.second)
        sim.record('first', firstResult.artifacts.value)
        sim.record('second', secondResult.artifacts.value)
        return secondResult.state
      },
    })
    const realization = createRealizations(definition)
    const result = await runSimulationProgram(
      realization.definition,
      realization.sample,
      realization.setup,
      new KernelRegistry([firstKernel, secondKernel]),
      new AbortController().signal,
      'local-keys',
    )

    expect(result.recordedData.first.data).toEqual({ value: 1 })
    expect(result.recordedData.second.data).toEqual({ value: 2 })
  })
})
