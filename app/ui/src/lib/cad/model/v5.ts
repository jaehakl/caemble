import type { DefinedKernelTask, KernelIdentity, RecordedDataSpec } from '../simulation/types'
import { canonicalRecordedDataSpec, simulationProgramManifest } from '../simulation/authoring'
import { CadModelError } from './errors'
import { normalizeGeometryGroup, type GeometryGroupMap } from './structure'
import type { Tensor, Vars } from './types'
import { assertUcumUnitComparable, normalizeUcumUnit, type UcumUnit } from './units'
import { normalizeVars, normalizeVarsSchema, type NormalizedVarsSchema, type VarsSchemaEntry } from './vars'

export type VarsSchemaDefinition = Readonly<Record<string, Readonly<VarsSchemaEntry>>>

type ShapeSource<Entry extends VarsSchemaEntry> = Entry['min'] extends readonly unknown[] ? Entry['min'] : Entry['max']
type WidenTensor<Value> = Value extends number
  ? number
  : Value extends readonly unknown[]
    ? { readonly [Index in keyof Value]: WidenTensor<Value[Index]> }
    : never

export type InferVars<Schema extends VarsSchemaDefinition> = Readonly<{
  [Key in keyof Schema]: WidenTensor<ShapeSource<Schema[Key]>>
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
  surfaceGroup?: GeometryGroupMap
  recordedData: Recorded
}>

export type TaskDefinitionOptions<Config> = Readonly<{
  kernel: KernelIdentity
  lengthUnit?: UcumUnit
  geometry?: (context: TaskModelContext) => unknown
  geometryGroup?: GeometryGroupMap
  surfaceGroup?: GeometryGroupMap
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
  readonly apiVersion = 6 as const
  readonly documentType = 'task' as const
  readonly kernel: KernelIdentity
  readonly lengthUnit?: UcumUnit
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: GeometryGroupMap
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
  readonly apiVersion = 6 as const
  readonly documentType = 'experiment' as const
  readonly lengthUnit: UcumUnit
  readonly varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: GeometryGroupMap
  readonly recordedData: Recorded
  readonly geometryFactory: (context: ModelContext<Schema>) => unknown
  private readonly normalizedVarsSchema: NormalizedVarsSchema

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
    this.varsSchema = varsSchema.schema
    this.normalizedVarsSchema = varsSchema.normalized
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
    if (Object.keys(taskDefinitions).length === 0) throw new CadModelError('Experiment requires at least one Task.')
    const tasks = Object.freeze(
      Object.fromEntries(
        Object.entries(taskDefinitions).map(([name, task]) => {
          if (!name.trim() || !(task instanceof TaskDefinition)) throw new CadModelError(`Experiment task "${name}" is invalid.`)
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
