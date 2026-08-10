import type { DefinedKernelTask, KernelIdentity, RecordedDataSpec } from '../simulation/types'
import { canonicalRecordedDataSpec, simulationProgramManifest } from '../simulation/authoring'
import { Structure, type StructureGroupMap } from './structure'
import type { Tensor, Vars } from './types'
import type { UcumUnit } from './units'
import type { VarsSchemaEntry } from './vars'

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

export type ModelContext<Schema extends VarsSchemaDefinition> = Readonly<{
  vars: InferVars<Schema>
}>

export type TaskModelContext = Readonly<{ vars: Readonly<Vars> }>

export type StructureDefinitionOptions<Schema extends VarsSchemaDefinition> = Readonly<{
  geometry: (context: ModelContext<Schema>) => unknown
  lengthUnit: UcumUnit
  varsSchema: Schema
  geometryGroup?: StructureGroupMap
  surfaceGroup?: StructureGroupMap
}>

export type ExperimentDefinitionOptions<
  Schema extends VarsSchemaDefinition,
  Recorded extends Readonly<Record<string, RecordedDataSpec>>,
> = Readonly<{
  varsSchema: Schema
  recordedData: Recorded
}>

export type TaskDefinitionOptions<Config> = Readonly<{
  kernel: KernelIdentity
  lengthUnit: UcumUnit
  geometry: (context: TaskModelContext) => unknown
  geometryGroup?: StructureGroupMap
  surfaceGroup?: StructureGroupMap
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

export class StructureDefinition<Schema extends VarsSchemaDefinition = VarsSchemaDefinition> extends Structure {
  readonly apiVersion = 4 as const
  readonly documentType = 'structure' as const
  readonly geometryFactory: (context: ModelContext<Schema>) => unknown

  constructor(options: StructureDefinitionOptions<Schema>) {
    super({
      geometry: () => null,
      lengthUnit: options.lengthUnit,
      varsSchema: options.varsSchema as Record<string, VarsSchemaEntry>,
      geometryGroup: options.geometryGroup,
      surfaceGroup: options.surfaceGroup,
    })
    if (typeof options.geometry !== 'function') {
      throw new Error('Structure geometry must be a function.')
    }
    this.geometryFactory = options.geometry
    Object.freeze(this)
  }

  resolve(partialVars: Partial<InferVars<Schema>> = {}, seed?: number) {
    return this.resolveVars(partialVars as Partial<Vars>, seed, 'Structure') as InferVars<Schema>
  }

  resolveExternal(partialVars: Partial<Vars> = {}, seed?: number) {
    return this.resolveVars(partialVars, seed, 'Structure')
  }

  evaluateGeometry(vars: InferVars<Schema>) {
    return this.geometryFactory(Object.freeze({ vars }))
  }

  evaluateResolvedGeometry(vars: Readonly<Vars>) {
    return this.geometryFactory(Object.freeze({ vars: vars as InferVars<Schema> }))
  }
}

export class TaskDefinition<Config = unknown> extends Structure {
  readonly apiVersion = 4 as const
  readonly documentType = 'task' as const
  readonly kernel: KernelIdentity
  readonly geometryFactory: TaskDefinitionOptions<Config>['geometry']
  readonly configFactory: TaskDefinitionOptions<Config>['config']

  constructor(options: TaskDefinitionOptions<Config>) {
    super({
      geometry: () => null,
      lengthUnit: options.lengthUnit,
      varsSchema: {},
      geometryGroup: options.geometryGroup,
      surfaceGroup: options.surfaceGroup,
    })
    if (
      !options.kernel ||
      typeof options.kernel !== 'object' ||
      typeof options.kernel.name !== 'string' ||
      !options.kernel.name.trim() ||
      typeof options.kernel.version !== 'string' ||
      !options.kernel.version.trim()
    ) {
      throw new Error('Task kernel requires a non-empty name and version.')
    }
    if (typeof options.geometry !== 'function') throw new Error('Task geometry must be a function.')
    if (typeof options.config !== 'function') throw new Error('Task config must be a function.')
    this.kernel = Object.freeze({ name: options.kernel.name.trim(), version: options.kernel.version.trim() })
    this.geometryFactory = options.geometry
    this.configFactory = options.config
    Object.freeze(this)
  }

  evaluateResolvedGeometry(vars: Readonly<Vars>) {
    return this.geometryFactory(Object.freeze({ vars }))
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
> extends Structure {
  readonly apiVersion = 4 as const
  readonly documentType = 'experiment' as const
  readonly recordedData: Recorded

  constructor(options: ExperimentDefinitionOptions<Schema, Recorded>) {
    super({
      geometry: () => null,
      lengthUnit: 'm',
      varsSchema: options.varsSchema as Record<string, VarsSchemaEntry>,
    })
    if (!options.recordedData || typeof options.recordedData !== 'object' || Array.isArray(options.recordedData)) {
      throw new Error('Experiment recordedData must be an object.')
    }
    this.recordedData = freezeRecordedData(options.recordedData)
    Object.freeze(this)
  }

  resolve(partialVars: Partial<InferVars<Schema>> = {}, seed?: number) {
    return this.resolveVars(partialVars as Partial<Vars>, seed, 'Experiment') as InferVars<Schema>
  }

  resolveExternal(partialVars: Partial<Vars> = {}, seed?: number) {
    return this.resolveVars(partialVars, seed, 'Experiment')
  }

  createProgramRuntime(
    vars: Readonly<Vars>,
    pythonSource: string,
    taskDefinitions: Readonly<Record<string, TaskDefinition>>,
  ) {
    if (Object.keys(taskDefinitions).length === 0) throw new Error('Experiment requires at least one Task.')
    const tasks = Object.freeze(
      Object.fromEntries(
        Object.entries(taskDefinitions).map(([name, task]) => {
          if (!name.trim() || !(task instanceof TaskDefinition))
            throw new Error(`Experiment task "${name}" is invalid.`)
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

export function structure<const Schema extends VarsSchemaDefinition>(options: StructureDefinitionOptions<Schema>) {
  return new StructureDefinition(options)
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

export type CadDefinition = StructureDefinition | ExperimentDefinition
export type ExternalVars = Readonly<Record<string, Tensor>>
