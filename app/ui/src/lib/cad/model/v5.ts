import type { DefinedKernelTask, KernelIdentity, RecordedDataSpec } from '../simulation/types'
import { canonicalRecordedDataSpec, simulationProgramManifest } from '../simulation/authoring'
import { CadModelError } from './errors'
import { normalizeGeometryGroup, type GeometryGroupMap, type SurfaceGroupMap } from './structure'
import type { Tensor, Vars } from './types'
import { assertUcumUnitComparable, normalizeUcumUnit, type UcumUnit } from './units'
import { normalizeVars, normalizeVarsSchema, type VarsSchema, type VarsSchemaEntry } from './vars'

export type VarsSchemaDefinition = Readonly<Record<string, Readonly<VarsSchemaEntry>>>

type FixedLengthTensor<
  Length extends number,
  Value,
  Result extends readonly Value[] = readonly [],
> = number extends Length
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
  Recorded extends Readonly<Record<string, RecordedDataSpec>>,
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

function freezeRecordedData<Recorded extends Readonly<Record<string, RecordedDataSpec>>>(recordedData: Recorded) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(recordedData).map(([name, spec]) => [
        name,
        canonicalRecordedDataSpec(spec, `RecordedData ${JSON.stringify(name)}`),
      ]),
    ),
  ) as unknown as Recorded
}

function normalizeLengthUnit(value: unknown, objectName: string) {
  const unit = normalizeUcumUnit(value, `${objectName} lengthUnit`)
  assertUcumUnitComparable(unit, 'm', `${objectName} lengthUnit`)
  return unit
}

export class TaskDefinition<Config = unknown> {
  readonly apiVersion = 10 as const
  readonly documentType = 'task' as const
  readonly kernel: KernelIdentity
  readonly lengthUnit?: UcumUnit
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: SurfaceGroupMap
  readonly geometryFactory?: TaskDefinitionOptions<Config>['geometry']
  readonly configFactory: TaskDefinitionOptions<Config>['config']

  constructor(options: TaskDefinitionOptions<Config>) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new CadModelError('Task options must be an object.')
    }
    if (
      !options.kernel ||
      typeof options.kernel !== 'object' ||
      typeof options.kernel.name !== 'string' ||
      !options.kernel.name.trim() ||
      typeof options.kernel.version !== 'string' ||
      !options.kernel.version.trim()
    ) {
      throw new CadModelError('Task kernel requires a non-empty name and version.')
    }
    if (options.geometry !== undefined && typeof options.geometry !== 'function') {
      throw new CadModelError('Task geometry must be a function when present.')
    }
    if (typeof options.config !== 'function') throw new CadModelError('Task config must be a function.')
    if (options.geometry === undefined && (options.geometryGroup !== undefined || options.surfaceGroup !== undefined)) {
      throw new CadModelError('Task groups require Task-local geometry.')
    }
    this.kernel = Object.freeze({ name: options.kernel.name.trim(), version: options.kernel.version.trim() })
    this.lengthUnit = options.lengthUnit === undefined ? undefined : normalizeLengthUnit(options.lengthUnit, 'Task')
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
    return Object.freeze({
      kind: 'caemble-kernel-task' as const,
      kernel: this.kernel,
      config: this.configFactory(Object.freeze({ vars })),
    })
  }
}

export class ExperimentDefinition<
  Schema extends VarsSchemaDefinition = VarsSchemaDefinition,
  Recorded extends Readonly<Record<string, RecordedDataSpec>> = Readonly<Record<string, RecordedDataSpec>>,
> {
  readonly apiVersion = 10 as const
  readonly documentType = 'experiment' as const
  readonly lengthUnit: UcumUnit
  readonly varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: SurfaceGroupMap
  readonly recordedData: Recorded
  readonly geometryFactory: (context: ModelContext<Schema>) => unknown
  private readonly normalizedVarsSchema: VarsSchema

  constructor(options: ExperimentDefinitionOptions<Schema, Recorded>) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new CadModelError('Experiment options must be an object.')
    }
    if (typeof options.geometry !== 'function') throw new CadModelError('Experiment geometry must be a function.')
    if (!options.recordedData || typeof options.recordedData !== 'object' || Array.isArray(options.recordedData)) {
      throw new CadModelError('Experiment recordedData must be an object.')
    }
    const varsSchema = normalizeVarsSchema(options.varsSchema, 'Experiment')
    this.lengthUnit = normalizeLengthUnit(options.lengthUnit, 'Experiment')
    this.varsSchema = varsSchema
    this.normalizedVarsSchema = varsSchema
    this.geometryGroup = normalizeGeometryGroup(options.geometryGroup, 'geometryGroup', 'Experiment')
    this.surfaceGroup = normalizeGeometryGroup(options.surfaceGroup, 'surfaceGroup', 'Experiment')
    this.recordedData = freezeRecordedData(options.recordedData)
    this.geometryFactory = options.geometry
    Object.freeze(this)
  }

  resolve(vars: InferVars<Schema>) {
    return this.resolveExternal(vars as Readonly<Vars>) as InferVars<Schema>
  }

  resolveExternal(vars: Readonly<Vars>) {
    return normalizeVars(this.normalizedVarsSchema, vars, 'Experiment')
  }

  evaluateGeometry(vars: InferVars<Schema>) {
    return this.geometryFactory(Object.freeze({ vars }))
  }

  evaluateResolvedGeometry(vars: Readonly<Vars>) {
    return this.geometryFactory(Object.freeze({ vars: vars as InferVars<Schema> }))
  }

  createProgramRuntime(
    vars: Readonly<Vars>,
    pythonSource: string,
    taskDefinitions: Readonly<Record<string, TaskDefinition>>,
  ) {
    const tasks = Object.freeze(
      Object.fromEntries(
        Object.entries(taskDefinitions).map(([name, task]) => {
          if (!name.trim() || !(task instanceof TaskDefinition))
            throw new CadModelError(`Experiment task "${name}" is invalid.`)
          return [name, task.createResolvedTask(vars)]
        }),
      ),
    )
    return Object.freeze({
      tasks,
      recordedData: this.recordedData,
      manifest: simulationProgramManifest(tasks, this.recordedData, pythonSource),
    })
  }
}

export function experiment<
  const Schema extends VarsSchemaDefinition,
  const Recorded extends Readonly<Record<string, RecordedDataSpec>>,
>(options: ExperimentDefinitionOptions<Schema, Recorded>) {
  return new ExperimentDefinition(options)
}

export function defineTask<const Config>(options: TaskDefinitionOptions<Config>) {
  return new TaskDefinition(options)
}

export type CadDefinition = ExperimentDefinition
export type ExternalVars = Readonly<Record<string, Tensor>>
