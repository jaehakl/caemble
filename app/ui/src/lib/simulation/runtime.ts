import { applyFrozenMaterialParameters, type BuiltSample, type BuiltSetup } from '../cad/execution/realization'
import { deserializeCadScene } from '../cad/execution/mesh'
import type { RecordedDataTensor } from '../cad/model/descriptor'
import type { Vars } from '../cad/model/types'
import { convertUcumValue } from '../cad/model/units'
import { getQuantityKindComponentShape, transformQuantityValue } from '../quantitykind/runtime'
import {
  assertKernelExecutionResult,
  normalizeKernelArtifactPayload,
  normalizeKernelTaskConfig,
  resolveKernelInputPort,
  resolveKernelOutputSpecs,
  type KernelDataSpec,
  type KernelDefinition,
  type KernelTaskConfig,
} from './kernelContract'
import { simulationProgramManifest } from './authoring'
import { SimulationFatalError, SimulationKernelError } from './errors'
import { KernelRegistry } from './registry'
import { assertSimulationProgramManifest } from './validation'
import type {
  ArtifactRef,
  ArtifactType,
  DefinedKernelTask,
  KernelArtifactTypes,
  KernelInputTypes,
  KernelObservationTypes,
  KernelRunArguments,
  KernelRunInputs,
  KernelRunResult,
  RecordedDataSpec,
  ResolvedKernelTask,
  SimulationProgramManifest,
  SimulationProgress,
  SimulationProvenance,
  SimulationResult,
  SimulationRunOptions,
  SimulationTraceArtifact,
  SimulationTraceEntry,
  SimulationWorld,
  StateRef,
} from './types'

export type SimulationProgramRuntimeDefinition = Readonly<{
  tasks: Readonly<Record<string, DefinedKernelTask>>
  recordedData: Readonly<Record<string, RecordedDataSpec>>
  manifest: SimulationProgramManifest
  simulate: (
    context: Readonly<{
      sim: SimulationScriptApi
      tasks: Readonly<Record<string, ResolvedKernelTask>>
      vars: Readonly<Vars>
      world: SimulationWorld
    }>,
  ) => Promise<StateRef> | StateRef
}>

export type SimulationScriptApi = Readonly<{
  initialState: StateRef
  run: <
    Config,
    Artifacts extends KernelArtifactTypes,
    Observations extends KernelObservationTypes,
    Inputs extends KernelInputTypes,
  >(
    task: ResolvedKernelTask<Config, Artifacts, Observations, Inputs>,
    ...args: KernelRunArguments<Inputs>
  ) => Promise<KernelRunResult<Artifacts, Observations>>
  record: (name: string, artifact: ArtifactRef) => void
  release: (artifact: ArtifactRef) => void
  random: () => number
}>

export type SimulationPreflightIssue = Readonly<{
  task?: string
  message: string
}>

export type SimulationPreflightResult = Readonly<{
  issues: readonly SimulationPreflightIssue[]
}>

type StateSnapshot = ReadonlyMap<string, unknown>

type StoredArtifact = {
  readonly artifactType: ArtifactType
  readonly dataSpec: KernelDataSpec
  readonly producerTask: string
  payload: unknown
  released: boolean
}

type ResolvedProgramTask = Readonly<{
  task: ResolvedKernelTask
  definition: KernelDefinition
  config: KernelTaskConfig
}>

function createWorld(sample: BuiltSample, setup: BuiltSetup): SimulationWorld {
  return Object.freeze({
    scenes: Object.freeze({
      structure: applyFrozenMaterialParameters(deserializeCadScene(sample.structure.scene), sample.materialParameters),
      experiment: applyFrozenMaterialParameters(deserializeCadScene(setup.experiment.scene), setup.materialParameters),
    }),
  })
}

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function kernelKey(task: ResolvedKernelTask) {
  return JSON.stringify([task.kernel.name, task.kernel.version])
}

function cloneOpaqueState(state: unknown) {
  if (state === undefined) return undefined
  try {
    return structuredClone(state)
  } catch (error) {
    throw new Error(
      `Kernel state must be structured-cloneable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function resolveProgramTasks(
  definition: SimulationProgramRuntimeDefinition,
  registry: KernelRegistry,
  world: SimulationWorld,
): Readonly<{
  tasks: Readonly<Record<string, ResolvedKernelTask>>
  details: ReadonlyMap<ResolvedKernelTask, ResolvedProgramTask>
}> {
  const details = new Map<ResolvedKernelTask, ResolvedProgramTask>()
  const tasks = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.tasks).map(([taskName, authored]) => {
        if (!taskName.trim() || authored.kind !== 'caemble-kernel-task') {
          throw new SimulationFatalError(`Experiment task "${taskName}" is invalid.`)
        }
        const kernel = registry.require(authored.kernel)
        if (kernel.descriptor.name !== authored.kernel.name || kernel.descriptor.version !== authored.kernel.version) {
          throw new SimulationFatalError(`Experiment task "${taskName}" has a mismatched kernel identity.`)
        }
        let config: KernelTaskConfig
        try {
          config = normalizeKernelTaskConfig(kernel.descriptor, authored.config as KernelTaskConfig, world)
        } catch (error) {
          throw new SimulationKernelError(
            'input',
            authored.kernel,
            error instanceof Error ? error.message : String(error),
          )
        }
        const task = Object.freeze({
          kind: 'caemble-resolved-kernel-task' as const,
          kernel: Object.freeze({ ...authored.kernel }),
          config,
          taskName,
        }) as ResolvedKernelTask
        details.set(task, Object.freeze({ task, definition: kernel, config }))
        return [taskName, task]
      }),
    ),
  )
  return Object.freeze({ tasks, details })
}

function assertDefinitionManifest(definition: SimulationProgramRuntimeDefinition, setup: BuiltSetup) {
  assertSimulationProgramManifest(definition.manifest)
  const expected = simulationProgramManifest(
    definition.tasks,
    definition.recordedData,
    definition.manifest.programHash,
    definition.manifest.pythonSource,
    definition.manifest.pythonSourceHash,
  )
  if (JSON.stringify(expected) !== JSON.stringify(definition.manifest)) {
    throw new SimulationFatalError('Simulation Program manifest does not match the evaluated Experiment.')
  }
  if (JSON.stringify(setup.experiment.simulationProgram) !== JSON.stringify(definition.manifest)) {
    throw new SimulationFatalError('Simulation Program does not match the previewed Experiment revision.')
  }
}

function dataSpecsMatch(left: KernelDataSpec | RecordedDataSpec, right: KernelDataSpec | RecordedDataSpec) {
  const leftAxes = left.axes ?? []
  const rightAxes = right.axes ?? []
  return (
    left.dtype === right.dtype &&
    left.unit === right.unit &&
    left.quantityKind === right.quantityKind &&
    JSON.stringify(left.basis) === JSON.stringify(right.basis) &&
    leftAxes.length === rightAxes.length &&
    leftAxes.every((axis, index) => {
      const other = rightAxes[index]
      const ticks = axis.ticks ?? []
      const otherTicks = other.ticks ?? []
      return (
        axis.length === other.length &&
        axis.name === other.name &&
        axis.unit === other.unit &&
        axis.quantityKind === other.quantityKind &&
        ticks.length === otherTicks.length &&
        ticks.every((tick, tickIndex) => Object.is(tick, otherTicks[tickIndex]))
      )
    })
  )
}

function normalizeForDataSpec(
  payload: unknown,
  source: KernelDataSpec,
  target: KernelDataSpec | RecordedDataSpec,
  path: string,
): RecordedDataTensor {
  if (
    source.dtype !== target.dtype ||
    source.quantityKind !== target.quantityKind ||
    (source.axes?.length ?? 0) !== (target.axes?.length ?? 0)
  ) {
    throw new Error(`${path} has an incompatible dtype, Quantity Kind, or axis rank.`)
  }
  const sourceAxes = source.axes ?? []
  const targetAxes = target.axes ?? []
  sourceAxes.forEach((axis, index) => {
    const targetAxis = targetAxes[index]
    if (
      axis.quantityKind !== targetAxis.quantityKind ||
      (targetAxis.name !== undefined && axis.name !== targetAxis.name) ||
      (axis.length !== undefined && targetAxis.length !== undefined && axis.length !== targetAxis.length)
    ) {
      throw new Error(`${path}.axes[${index}] has incompatible metadata.`)
    }
  })

  const normalized = payload as RecordedDataTensor
  if (dataSpecsMatch(source, target)) return normalized

  if (!('value' in normalized)) {
    throw new Error(`${path} must already use the canonical DataSchema before raw DataTensor encoding.`)
  }
  let value: unknown = normalized.value
  if (source.quantityKind !== undefined) {
    const componentShape = getQuantityKindComponentShape(source.quantityKind)
    const outerRank = sourceAxes.length
    const transform = (item: unknown, depth: number, itemPath: string): unknown => {
      if (depth === outerRank) {
        return transformQuantityValue(
          item,
          componentShape,
          { unit: source.unit!, basis: source.basis },
          { unit: target.unit!, basis: target.basis },
          itemPath,
        )
      }
      return Object.freeze(
        (item as readonly unknown[]).map((child, index) => transform(child, depth + 1, `${itemPath}[${index}]`)),
      )
    }
    value = transform(value, 0, `${path}.value`)
  }

  const axes = normalized.axes?.map((axis, index) => {
    const sourceAxis = sourceAxes[index]
    const targetAxis = targetAxes[index]
    if (!axis.ticks) {
      throw new SimulationFatalError(`${path}.axes[${index}].ticks were not preserved during normalization.`)
    }
    const ticks = axis.ticks.map((tick, tickIndex) =>
      typeof tick === 'number' && sourceAxis.unit !== undefined && targetAxis.unit !== undefined
        ? convertUcumValue(tick, sourceAxis.unit, targetAxis.unit, `${path}.axes[${index}].ticks[${tickIndex}]`)
        : tick,
    )
    return Object.freeze({ ticks: Object.freeze(ticks) })
  })
  const targetPayload = Object.freeze({
    value,
    ...(axes === undefined ? {} : { axes: Object.freeze(axes) }),
  })
  const converted = normalizeKernelArtifactPayload(target as KernelDataSpec, targetPayload, path)
  return Object.freeze({
    value: converted.value,
    ...(converted.axes === undefined
      ? {}
      : {
          axes: Object.freeze(converted.axes.map((axis) => Object.freeze({ ticks: axis.ticks }))),
        }),
  })
}

function toTraceArtifact(ref: ArtifactRef): SimulationTraceArtifact {
  return Object.freeze({ id: ref.id, artifactType: ref.artifactType })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function preflightSimulation(
  definition: SimulationProgramRuntimeDefinition,
  sample: BuiltSample,
  setup: BuiltSetup,
  registry: KernelRegistry,
): Promise<SimulationPreflightResult> {
  const issues: SimulationPreflightIssue[] = []
  let resolved: ReturnType<typeof resolveProgramTasks>
  const world = createWorld(sample, setup)
  try {
    assertDefinitionManifest(definition, setup)
    resolved = resolveProgramTasks(definition, registry, world)
  } catch (error) {
    return Object.freeze({
      issues: Object.freeze([Object.freeze({ message: errorMessage(error) })]),
    })
  }

  for (const [taskName, task] of Object.entries(resolved.tasks)) {
    const detail = resolved.details.get(task)!
    try {
      const prepared = await detail.definition.prepare({
        taskName,
        config: detail.config,
        world,
      })
      if (!prepared || typeof prepared !== 'object' || !Object.prototype.hasOwnProperty.call(prepared, 'prepared')) {
        throw new Error('Kernel prepare() must return an object containing prepared.')
      }
      resolveKernelOutputSpecs(detail.definition.descriptor, detail.config)
    } catch (error) {
      issues.push(Object.freeze({ task: taskName, message: errorMessage(error) }))
    }
  }
  return Object.freeze({ issues: Object.freeze(issues) })
}

export async function runSimulationProgram(
  definition: SimulationProgramRuntimeDefinition,
  sample: BuiltSample,
  setup: BuiltSetup,
  registry: KernelRegistry,
  signal: AbortSignal,
  requestedRunId = `simulation-${crypto.randomUUID()}`,
  options: SimulationRunOptions = {},
): Promise<SimulationResult> {
  const runId = requestedRunId
  const world = createWorld(sample, setup)
  assertDefinitionManifest(definition, setup)
  const resolved = resolveProgramTasks(definition, registry, world)
  const states = new Map<number, StateSnapshot>([[0, new Map()]])
  const stateRefs = new WeakSet<object>()
  const artifacts = new Map<string, StoredArtifact>()
  const artifactRefs = new WeakSet<object>()
  const stagedRecordedData = new Map<string, Readonly<{ spec: RecordedDataSpec; data: RecordedDataTensor }>>()
  const prepared = new Map<ResolvedKernelTask, Promise<unknown>>()
  const trace: SimulationTraceEntry[] = []
  let stateSequence = 0
  let artifactSequence = 0
  let invocationSequence = 0
  let running = false
  let activeRunFinished: Promise<void> | null = null
  let fatalError: SimulationFatalError | null = null

  const latchFatal = (error: unknown): never => {
    fatalError ??= error instanceof SimulationFatalError ? error : new SimulationFatalError(errorMessage(error))
    throw fatalError
  }
  const createStateRef = (revision: number) => {
    const ref = Object.freeze({ runId, revision }) as StateRef
    stateRefs.add(ref)
    return ref
  }
  const initialState = createStateRef(0)
  const assertStateRef = (ref: StateRef) => {
    if (
      !ref ||
      typeof ref !== 'object' ||
      ref.runId !== runId ||
      !stateRefs.has(ref) ||
      !Number.isSafeInteger(ref.revision) ||
      !states.has(ref.revision)
    ) {
      latchFatal('Simulation state reference is forged, stale, or belongs to another run.')
    }
  }
  const readArtifact = (ref: ArtifactRef) => {
    if (!ref || typeof ref !== 'object' || ref.runId !== runId || !artifactRefs.has(ref) || !artifacts.has(ref.id)) {
      latchFatal('Simulation artifact reference is forged, uncommitted, or belongs to another run.')
    }
    const stored = artifacts.get(ref.id)!
    if (stored.released) {
      latchFatal(`Simulation artifact ${ref.id} has already been released.`)
    }
    if (ref.artifactType !== stored.artifactType) {
      latchFatal(`Simulation artifact ${ref.id} has an invalid artifact type.`)
    }
    return stored
  }
  const prepareTask = (task: ResolvedKernelTask, detail: ResolvedProgramTask) => {
    let promise = prepared.get(task)
    if (!promise) {
      promise = Promise.resolve(
        detail.definition.prepare({
          taskName: task.taskName,
          config: detail.config,
          world,
        }),
      ).then((result) => {
        if (!result || typeof result !== 'object' || !Object.prototype.hasOwnProperty.call(result, 'prepared')) {
          throw new Error('Kernel prepare() must return an object containing prepared.')
        }
        return result.prepared
      })
      prepared.set(task, promise)
    }
    return promise
  }

  const api = Object.freeze({
    initialState,
    async run<
      Config,
      ArtifactTypes extends KernelArtifactTypes,
      Observations extends KernelObservationTypes,
      InputTypes extends KernelInputTypes,
    >(
      task: ResolvedKernelTask<Config, ArtifactTypes, Observations, InputTypes>,
      ...args: KernelRunArguments<InputTypes>
    ): Promise<KernelRunResult<ArtifactTypes, Observations>> {
      const input = (args[0] ?? {}) as Readonly<{
        state?: StateRef
        inputs?: KernelRunInputs<InputTypes>
      }>
      if (fatalError) throw fatalError
      if (signal.aborted) latchFatal('Simulation run was cancelled.')
      if (running) latchFatal('sim.run() calls must be awaited and executed sequentially.')
      const detail = resolved.details.get(task)
      if (!detail) latchFatal('sim.run() only accepts a task declared by this Experiment.')
      const taskDetail = detail as ResolvedProgramTask
      const inputState = input.state ?? initialState
      assertStateRef(inputState)
      const stateSnapshot = states.get(inputState.revision)!
      const rawInputs = input.inputs ?? {}
      const unknownInput = Object.keys(rawInputs).find(
        (name) => resolveKernelInputPort(taskDetail.definition.descriptor, name) === undefined,
      )
      if (unknownInput) latchFatal(`Kernel input port "${unknownInput}" is not declared.`)

      const normalizedInputs = Object.create(null) as Record<string, unknown>
      const traceInputs = Object.create(null) as Record<
        string,
        SimulationTraceArtifact | readonly SimulationTraceArtifact[]
      >
      Object.entries(taskDetail.definition.descriptor.inputPorts).forEach(([name, port]) => {
        const raw = Object.prototype.hasOwnProperty.call(rawInputs, name)
          ? (rawInputs as Readonly<Record<string, ArtifactRef | readonly ArtifactRef[]>>)[name]
          : undefined
        const refs = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
        if (refs.length < port.minimumOccurrences || refs.length > port.maximumOccurrences) {
          latchFatal(
            `Kernel input port "${name}" requires ${port.minimumOccurrences}..${port.maximumOccurrences} artifacts; ` +
              `received ${refs.length}.`,
          )
        }
        const values = refs.map((ref, index) => {
          const stored = readArtifact(ref)
          if (!port.artifactTypes.includes(stored.artifactType)) {
            latchFatal(`Kernel input port "${name}" does not accept artifact type ${stored.artifactType}.`)
          }
          try {
            return port.data === undefined
              ? stored.payload
              : normalizeForDataSpec(stored.payload, stored.dataSpec, port.data, `inputs.${name}[${index}]`)
          } catch (error) {
            latchFatal(`Kernel input port "${name}" is incompatible: ${errorMessage(error)}`)
          }
        })
        if (refs.length > 0) {
          normalizedInputs[name] = port.maximumOccurrences === 1 ? values[0] : Object.freeze(values)
          traceInputs[name] =
            port.maximumOccurrences === 1 ? toTraceArtifact(refs[0]) : Object.freeze(refs.map(toTraceArtifact))
        }
      })

      running = true
      let finishRun!: () => void
      const runFinished = new Promise<void>((resolve) => {
        finishRun = resolve
      })
      activeRunFinished = runFinished
      const sequence = ++invocationSequence
      const startedAt = Date.now()
      const descriptor = taskDetail.definition.descriptor
      const latestProgress = new Map<string, Readonly<{ completed: number; total?: number }>>()
      try {
        const preparedInput = await prepareTask(task, taskDetail)
        const namespace = kernelKey(task)
        const kernelState = cloneOpaqueState(stateSnapshot.get(namespace))
        const rawResult = await taskDetail.definition.execute(
          Object.freeze({
            prepared: preparedInput,
            state: kernelState,
            inputs: Object.freeze(normalizedInputs),
          }),
          Object.freeze({
            signal,
            reportProgress(progress) {
              const keys = progress && typeof progress === 'object' ? Reflect.ownKeys(progress) : []
              if (
                !progress ||
                keys.some((key) => key !== 'stage' && key !== 'completed' && key !== 'total' && key !== 'message') ||
                typeof progress.stage !== 'string' ||
                !progress.stage.trim() ||
                !Number.isFinite(progress.completed) ||
                progress.completed < 0 ||
                (progress.total !== undefined &&
                  (!Number.isFinite(progress.total) || progress.total < progress.completed)) ||
                (progress.message !== undefined && typeof progress.message !== 'string')
              ) {
                throw new Error('Kernel progress is invalid.')
              }
              const previous = latestProgress.get(progress.stage)
              if (
                previous &&
                (progress.completed < previous.completed ||
                  (previous.total !== undefined && progress.total !== undefined && previous.total !== progress.total))
              ) {
                throw new Error(`Kernel progress for stage ${progress.stage} is not monotonic.`)
              }
              latestProgress.set(progress.stage, progress)
              const event: SimulationProgress = Object.freeze({
                runId,
                task: task.taskName,
                kernel: task.kernel,
                ...progress,
              })
              options.reportProgress?.(event)
            },
          }),
        )
        if (fatalError) throw fatalError
        if (signal.aborted) latchFatal('Simulation run was cancelled.')
        const result = assertKernelExecutionResult(descriptor, taskDetail.config, rawResult)
        const outputSpecs = resolveKernelOutputSpecs(descriptor, taskDetail.config)

        let outputState = inputState
        let nextSnapshot: Map<string, unknown> | undefined
        const normalizedState = result.state === undefined ? undefined : cloneOpaqueState(result.state)
        if (normalizedState !== undefined) {
          nextSnapshot = new Map(stateSnapshot)
          nextSnapshot.set(namespace, normalizedState)
          outputState = createStateRef(stateSequence + 1)
        }

        const pendingArtifacts = Object.entries(result.artifacts).map(([name, payload]) => {
          const spec = outputSpecs[name]
          const id = `artifact-${artifactSequence + 1}`
          artifactSequence += 1
          const ref = Object.freeze({
            runId,
            id,
            artifactType: spec.artifactType,
          }) as ArtifactRef
          return {
            id,
            ref,
            stored: {
              artifactType: spec.artifactType,
              dataSpec: spec.data,
              producerTask: task.taskName,
              payload,
              released: false,
            } satisfies StoredArtifact,
          }
        })

        if (nextSnapshot) {
          stateSequence += 1
          states.set(stateSequence, nextSnapshot)
        }
        pendingArtifacts.forEach(({ id, ref, stored }) => {
          artifacts.set(id, stored)
          artifactRefs.add(ref)
        })
        const refs = Object.freeze(
          Object.fromEntries(pendingArtifacts.map(({ ref }, index) => [Object.keys(result.artifacts)[index], ref])),
        )
        trace.push(
          Object.freeze({
            sequence,
            task: task.taskName,
            kernel: task.kernel,
            inputStateRevision: inputState.revision,
            outputStateRevision: outputState.revision,
            inputArtifacts: Object.freeze(traceInputs),
            status: 'succeeded' as const,
            startedAt,
            finishedAt: Date.now(),
          }),
        )
        return Object.freeze({
          state: outputState,
          artifacts: refs,
          observations: result.observations ?? Object.freeze({}),
        }) as KernelRunResult<ArtifactTypes, Observations>
      } catch (error) {
        trace.push(
          Object.freeze({
            sequence,
            task: task.taskName,
            kernel: task.kernel,
            inputStateRevision: inputState.revision,
            outputStateRevision: null,
            inputArtifacts: Object.freeze(traceInputs),
            status: 'failed' as const,
            error: errorMessage(error),
            startedAt,
            finishedAt: Date.now(),
          }),
        )
        if (error instanceof SimulationFatalError) latchFatal(error)
        if (signal.aborted) latchFatal('Simulation run was cancelled.')
        if (error instanceof SimulationKernelError) throw error
        throw new SimulationKernelError('backend', task.kernel, errorMessage(error))
      } finally {
        running = false
        finishRun()
        if (activeRunFinished === runFinished) activeRunFinished = null
      }
    },
    record(name: string, artifact: ArtifactRef) {
      if (fatalError) throw fatalError
      if (!Object.prototype.hasOwnProperty.call(definition.recordedData, name)) {
        latchFatal(`RecordedData "${name}" is not declared by this Experiment.`)
      }
      const spec = definition.recordedData[name]
      if (stagedRecordedData.has(name)) {
        latchFatal(`RecordedData "${name}" was recorded more than once.`)
      }
      const stored = readArtifact(artifact)
      try {
        const data = normalizeForDataSpec(stored.payload, stored.dataSpec, spec, `recordedData.${name}`)
        stagedRecordedData.set(
          name,
          Object.freeze({
            spec,
            data,
          }),
        )
      } catch (error) {
        latchFatal(`RecordedData "${name}" is incompatible with its artifact: ${errorMessage(error)}`)
      }
    },
    release(artifact: ArtifactRef) {
      if (fatalError) throw fatalError
      const stored = readArtifact(artifact)
      stored.released = true
      stored.payload = undefined
    },
    random: seededRandom(setup.experiment.seed),
  }) as SimulationScriptApi

  let finalState: StateRef
  try {
    finalState = await definition.simulate({
      sim: api,
      tasks: resolved.tasks,
      vars: setup.experiment.variables,
      world,
    })
    if (activeRunFinished) {
      fatalError ??= new SimulationFatalError('Every sim.run() call must be awaited before simulate() returns.')
      await activeRunFinished
    }
    if (fatalError) throw fatalError
    if (signal.aborted) latchFatal('Simulation run was cancelled.')
    assertStateRef(finalState)
    const missing = Object.keys(definition.recordedData).filter((name) => !stagedRecordedData.has(name))
    if (missing.length > 0) {
      latchFatal(`Simulation did not record required RecordedData: ${missing.join(', ')}.`)
    }
  } catch (error) {
    if (activeRunFinished) await activeRunFinished
    stagedRecordedData.clear()
    throw fatalError ?? error
  }

  const kernels = Object.freeze([
    ...new Map(
      trace.map((entry) => [JSON.stringify([entry.kernel.name, entry.kernel.version]), entry.kernel]),
    ).values(),
  ])
  const provenance: SimulationProvenance = Object.freeze({
    programHash: definition.manifest.programHash,
    structureSourceHash: sample.structure.sourceHash,
    experimentSourceHash: setup.experiment.sourceHash,
    structureSeed: sample.structure.seed,
    experimentSeed: setup.experiment.seed,
    structureVars: sample.structure.variables,
    experimentVars: setup.experiment.variables,
    kernels,
  })
  return Object.freeze({
    format: 'caemble-run' as const,
    formatVersion: 1 as const,
    runId,
    finalStateRevision: finalState.revision,
    recordedData: Object.freeze(Object.fromEntries(stagedRecordedData)),
    trace: Object.freeze(trace),
    provenance,
  })
}
