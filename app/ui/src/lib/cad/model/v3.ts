import type { DefinedKernelTask, RecordedDataSpec } from '../../simulation/types'
import { canonicalRecordedDataSpec, simulationProgramManifest } from '../../simulation/authoring'
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

export type StructureDefinitionOptions<Schema extends VarsSchemaDefinition> = Readonly<{
  geometry: (context: ModelContext<Schema>) => unknown
  lengthUnit: UcumUnit
  varsSchema: Schema
  geometryGroup?: StructureGroupMap
  surfaceGroup?: StructureGroupMap
}>

export type ExperimentDefinitionOptions<
  Schema extends VarsSchemaDefinition,
  Tasks extends Readonly<Record<string, DefinedKernelTask>>,
  Recorded extends Readonly<Record<string, RecordedDataSpec>>,
> = Omit<StructureDefinitionOptions<Schema>, 'geometry' | 'lengthUnit'> &
  Readonly<{
    geometry?: StructureDefinitionOptions<Schema>['geometry']
    lengthUnit?: UcumUnit
    tasks: (context: ModelContext<Schema>) => Tasks
    recordedData: Recorded
  }>

function freezeRecordedData<Recorded extends Readonly<Record<string, RecordedDataSpec>>>(recordedData: Recorded) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(recordedData).map(([name, spec]) => [
        name,
        canonicalRecordedDataSpec(spec, `RecordedData ${JSON.stringify(name)}`),
      ]),
    ),
  ) as Recorded
}

export class StructureDefinition<Schema extends VarsSchemaDefinition = VarsSchemaDefinition> extends Structure {
  readonly apiVersion = 3 as const
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

export class ExperimentDefinition<
  Schema extends VarsSchemaDefinition = VarsSchemaDefinition,
  Tasks extends Readonly<Record<string, DefinedKernelTask>> = Readonly<Record<string, DefinedKernelTask>>,
  Recorded extends Readonly<Record<string, RecordedDataSpec>> = Readonly<Record<string, RecordedDataSpec>>,
> extends Structure {
  readonly apiVersion = 3 as const
  readonly documentType = 'experiment' as const
  readonly geometryFactory: (context: ModelContext<Schema>) => unknown
  readonly tasksFactory: ExperimentDefinitionOptions<Schema, Tasks, Recorded>['tasks']
  readonly recordedData: Recorded

  constructor(options: ExperimentDefinitionOptions<Schema, Tasks, Recorded>) {
    super({
      geometry: () => null,
      lengthUnit: options.lengthUnit ?? 'm',
      varsSchema: options.varsSchema as Record<string, VarsSchemaEntry>,
      geometryGroup: options.geometryGroup,
      surfaceGroup: options.surfaceGroup,
    })
    if (options.geometry !== undefined && typeof options.geometry !== 'function') {
      throw new Error('Experiment geometry must be a function.')
    }
    if (typeof options.tasks !== 'function') {
      throw new Error('Experiment tasks must be a function.')
    }
    if (!options.recordedData || typeof options.recordedData !== 'object' || Array.isArray(options.recordedData)) {
      throw new Error('Experiment recordedData must be an object.')
    }
    this.geometryFactory = options.geometry ?? (() => null)
    this.tasksFactory = options.tasks
    this.recordedData = freezeRecordedData(options.recordedData)
    Object.freeze(this)
  }

  resolve(partialVars: Partial<InferVars<Schema>> = {}, seed?: number) {
    return this.resolveVars(partialVars as Partial<Vars>, seed, 'Experiment') as InferVars<Schema>
  }

  resolveExternal(partialVars: Partial<Vars> = {}, seed?: number) {
    return this.resolveVars(partialVars, seed, 'Experiment')
  }

  evaluateGeometry(vars: InferVars<Schema>) {
    return this.geometryFactory(Object.freeze({ vars }))
  }

  evaluateResolvedGeometry(vars: Readonly<Vars>) {
    return this.geometryFactory(Object.freeze({ vars: vars as InferVars<Schema> }))
  }

  createProgramRuntime(vars: Readonly<Vars>, programHash: string, pythonSource: string, pythonSourceHash: string) {
    const typedVars = vars as InferVars<Schema>
    const tasks = this.tasksFactory(Object.freeze({ vars: typedVars }))
    if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks) || Object.keys(tasks).length === 0) {
      throw new Error('Experiment tasks must return a non-empty object.')
    }
    Object.entries(tasks).forEach(([name, task]) => {
      if (!name.trim() || task.kind !== 'caemble-kernel-task') {
        throw new Error(`Experiment task "${name}" is invalid.`)
      }
    })
    const frozenTasks = Object.freeze({ ...tasks }) as Tasks
    return Object.freeze({
      tasks: frozenTasks,
      recordedData: this.recordedData,
      manifest: simulationProgramManifest(frozenTasks, this.recordedData, programHash, pythonSource, pythonSourceHash),
    })
  }
}

export function structure<const Schema extends VarsSchemaDefinition>(options: StructureDefinitionOptions<Schema>) {
  return new StructureDefinition(options)
}

export function experiment<
  const Schema extends VarsSchemaDefinition,
  const Tasks extends Readonly<Record<string, DefinedKernelTask>>,
  const Recorded extends Readonly<Record<string, RecordedDataSpec>>,
>(options: ExperimentDefinitionOptions<Schema, Tasks, Recorded>) {
  return new ExperimentDefinition(options)
}

export type CadDefinition = StructureDefinition | ExperimentDefinition
export type ExternalVars = Readonly<Record<string, Tensor>>
