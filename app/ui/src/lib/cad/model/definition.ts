import { canonicalRecordedDataTree, simulationProgramManifestFromResolved } from '../simulation/authoring'
import type { DefinedKernelTask, KernelIdentity, RecordedDataSchemaTree, RecordedDataSpecNode } from '../simulation/types'
import { normalizeGeometryGroup, type GeometryGroupMap, type SurfaceGroupMap } from './structure'
import type { Tensor, Vars } from './types'
import type { UcumUnit } from './units'
import type { VarsSchemaEntry } from './vars'

export type VarsSchemaDefinition = Readonly<Record<string, Readonly<VarsSchemaEntry>>>
type FixedLengthTensor<Length extends number, Value, Result extends readonly Value[] = readonly []> = number extends Length
  ? readonly Value[]
  : Result['length'] extends Length
    ? Result
    : Result['length'] extends 32
      ? readonly Value[]
      : FixedLengthTensor<Length, Value, readonly [...Result, Value]>
type TensorForShape<Shape extends readonly number[]> = number extends Shape['length']
  ? Tensor
  : Shape extends readonly []
    ? number
    : Shape extends readonly [infer Length extends number, ...infer Rest extends readonly number[]]
      ? FixedLengthTensor<Length, TensorForShape<Rest>>
      : never
export type InferVars<Schema extends VarsSchemaDefinition> = Readonly<{
  [Key in keyof Schema]: TensorForShape<Schema[Key]['shape']>
}>
export type ModelContext<Schema extends VarsSchemaDefinition> = Readonly<{ vars: InferVars<Schema> }>
export type TaskModelContext = Readonly<{ vars: Readonly<Vars> }>

export type ExperimentDefinitionOptions<
  Schema extends VarsSchemaDefinition,
  Recorded extends Readonly<Record<string, RecordedDataSpecNode>>,
> = Readonly<{
  geometry: (context: ModelContext<Schema>) => unknown
  lengthUnit: UcumUnit
  varsSchema: Schema
  geometryGroup?: GeometryGroupMap
  surfaceGroup?: SurfaceGroupMap
  recordedData: Recorded
}>
export type TaskDefinitionOptions<Config> = Readonly<{
  kernel: KernelIdentity
  lengthUnit?: UcumUnit
  geometry?: (context: TaskModelContext) => unknown
  geometryGroup?: GeometryGroupMap
  surfaceGroup?: SurfaceGroupMap
  config: (context: TaskModelContext) => Config
}>

export class TaskDefinition<Config = unknown> {
  readonly documentType = 'task' as const
  readonly kernel: KernelIdentity
  readonly lengthUnit?: UcumUnit
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: SurfaceGroupMap
  readonly geometryFactory?: TaskDefinitionOptions<Config>['geometry']
  readonly configFactory: TaskDefinitionOptions<Config>['config']

  constructor(options: TaskDefinitionOptions<Config>) {
    this.kernel = Object.freeze({ ...options.kernel })
    this.lengthUnit = options.lengthUnit
    this.geometryGroup = normalizeGeometryGroup(options.geometryGroup, 'geometryGroup', 'Task')
    this.surfaceGroup = normalizeGeometryGroup(options.surfaceGroup, 'surfaceGroup', 'Task')
    this.geometryFactory = options.geometry
    this.configFactory = options.config
    Object.freeze(this)
  }

  evaluateResolvedGeometry(vars: Readonly<Vars>) {
    return this.geometryFactory?.(Object.freeze({ vars }))
  }

  createResolvedTask(vars: Readonly<Vars>): DefinedKernelTask<Config> {
    return Object.freeze({ kind: 'caemble-kernel-task' as const, kernel: this.kernel, config: this.configFactory({ vars }) })
  }
}

export class ExperimentDefinition<
  Schema extends VarsSchemaDefinition = VarsSchemaDefinition,
  Recorded extends Readonly<Record<string, RecordedDataSpecNode>> = Readonly<Record<string, RecordedDataSpecNode>>,
> {
  readonly documentType = 'experiment' as const
  readonly lengthUnit: UcumUnit
  readonly varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: SurfaceGroupMap
  readonly recordedData: Recorded
  readonly geometryFactory: (context: ModelContext<Schema>) => unknown

  constructor(options: ExperimentDefinitionOptions<Schema, Recorded>) {
    this.lengthUnit = options.lengthUnit
    this.varsSchema = Object.freeze({ ...options.varsSchema })
    this.geometryGroup = normalizeGeometryGroup(options.geometryGroup, 'geometryGroup', 'Experiment')
    this.surfaceGroup = normalizeGeometryGroup(options.surfaceGroup, 'surfaceGroup', 'Experiment')
    this.recordedData = canonicalRecordedDataTree(options.recordedData) as unknown as Recorded
    this.geometryFactory = options.geometry
    Object.freeze(this)
  }

  resolve(vars: InferVars<Schema>) {
    return vars
  }
  resolveExternal(vars: Readonly<Vars>) {
    return vars
  }
  evaluateGeometry(vars: InferVars<Schema>) {
    return this.geometryFactory({ vars })
  }
  evaluateResolvedGeometry(vars: Readonly<Vars>) {
    return this.geometryFactory({ vars: vars as InferVars<Schema> })
  }
  createProgramRuntime(
    vars: Readonly<Vars>,
    pythonSource: string,
    taskDefinitions: Readonly<Record<string, TaskDefinition>>,
  ) {
    const tasks = Object.freeze(
      Object.fromEntries(Object.entries(taskDefinitions).map(([name, task]) => [name, task.createResolvedTask(vars)])),
    )
    return Object.freeze({
      tasks,
      recordedData: this.recordedData,
      manifest: simulationProgramManifestFromResolved(tasks, this.recordedData as unknown as RecordedDataSchemaTree, pythonSource),
    })
  }
}

export function experiment<
  const Schema extends VarsSchemaDefinition,
  const Recorded extends Readonly<Record<string, RecordedDataSpecNode>>,
>(options: ExperimentDefinitionOptions<Schema, Recorded>) {
  return new ExperimentDefinition(options)
}
export function defineTask<const Config>(options: TaskDefinitionOptions<Config>) {
  return new TaskDefinition(options)
}
export type CadDefinition = ExperimentDefinition
export type ExternalVars = Readonly<Record<string, Tensor>>
