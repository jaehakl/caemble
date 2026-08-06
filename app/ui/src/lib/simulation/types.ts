import type { CadScene } from '../cad/evaluation/types'
import type { DataTensor as CadDataTensor, RecordedDataResult, RecordedDataTensor } from '../cad/model/descriptor'
import type { Vars } from '../cad/model/types'
import type { KernelDescriptor, ResolvedKernelOutputSpec } from './kernelContract'

export type ArtifactType = `${string}@${number}`
export type SimulationObservation = boolean | number | string
export type RecordedDataSpec = RecordedDataResult
export type DataTensor = CadDataTensor

export type SimulationWorld = Readonly<{
  scenes: Readonly<{
    structure: CadScene
    experiment: CadScene
  }>
}>

declare const stateRefBrand: unique symbol
declare const artifactRefBrand: unique symbol

export type StateRef = Readonly<{
  runId: string
  revision: number
  [stateRefBrand]: true
}>

export type ArtifactRef<Type extends ArtifactType = ArtifactType> = Readonly<{
  runId: string
  id: string
  artifactType: Type
  [artifactRefBrand]: true
}>

export type KernelIdentity = Readonly<{
  name: string
  version: string
}>

export type KernelArtifactTypes = Readonly<Record<string, ArtifactType>>
export type KernelInputTypes = Readonly<Record<string, ArtifactType | readonly ArtifactType[] | undefined>>
export type KernelObservationTypes = Readonly<Record<string, SimulationObservation | undefined>>

export type DefinedKernelTask<
  Config = unknown,
  Artifacts extends KernelArtifactTypes = KernelArtifactTypes,
  Observations extends KernelObservationTypes = KernelObservationTypes,
  Inputs extends KernelInputTypes = KernelInputTypes,
> = Readonly<{
  kind: 'caemble-kernel-task'
  kernel: KernelIdentity
  config: Config
  descriptor?: KernelDescriptor
  /** Compile-time capability information. It is not inspected at runtime. */
  __artifacts?: Artifacts
  /** Compile-time capability information. It is not inspected at runtime. */
  __observations?: Observations
  /** Compile-time capability information. It is not inspected at runtime. */
  __inputs?: Inputs
}>

export type ResolvedKernelTask<
  Config = unknown,
  Artifacts extends KernelArtifactTypes = KernelArtifactTypes,
  Observations extends KernelObservationTypes = KernelObservationTypes,
  Inputs extends KernelInputTypes = KernelInputTypes,
> = Readonly<{
  kind: 'caemble-resolved-kernel-task'
  kernel: KernelIdentity
  config: Config
  taskName: string
  __artifacts?: Artifacts
  __observations?: Observations
  __inputs?: Inputs
}>

type ArtifactRefsFor<Value> = Value extends ArtifactType
  ? ArtifactRef<Value>
  : Value extends readonly unknown[]
    ? Readonly<{ [Index in keyof Value]: ArtifactRefsFor<Value[Index]> }>
    : never

type RequiredInputKeys<Inputs extends KernelInputTypes> = {
  [Key in keyof Inputs]-?: [Inputs[Key]] extends [never] ? never : undefined extends Inputs[Key] ? never : Key
}[keyof Inputs]

type OptionalInputKeys<Inputs extends KernelInputTypes> = {
  [Key in keyof Inputs]-?: undefined extends Inputs[Key] ? Key : never
}[keyof Inputs]

export type KernelRunInputs<Inputs extends KernelInputTypes> = Readonly<
  {
    [Key in RequiredInputKeys<Inputs>]-?: ArtifactRefsFor<Inputs[Key]>
  } & {
    [Key in OptionalInputKeys<Inputs>]?: ArtifactRefsFor<Exclude<Inputs[Key], undefined>>
  }
>

export type KernelRunArguments<Inputs extends KernelInputTypes> = [RequiredInputKeys<Inputs>] extends [never]
  ? [input?: Readonly<{ state?: StateRef; inputs?: KernelRunInputs<Inputs> }>]
  : [input: Readonly<{ state?: StateRef; inputs: KernelRunInputs<Inputs> }>]

export type KernelRunResult<
  Artifacts extends KernelArtifactTypes = KernelArtifactTypes,
  Observations extends KernelObservationTypes = KernelObservationTypes,
> = Readonly<{
  state: StateRef
  artifacts: Readonly<{
    [Key in keyof Artifacts]: ArtifactRef<Artifacts[Key]>
  }>
  observations: Observations
}>

export type SimulationTraceArtifact = Readonly<{
  id: string
  artifactType: ArtifactType
}>

export type SimulationTraceEntry = Readonly<{
  sequence: number
  task: string
  kernel: KernelIdentity
  inputStateRevision: number
  outputStateRevision: number | null
  inputArtifacts: Readonly<Record<string, SimulationTraceArtifact | readonly SimulationTraceArtifact[]>>
  status: 'succeeded' | 'failed'
  error?: string
  startedAt: number
  finishedAt: number
}>

export type SimulationProvenance = Readonly<{
  programHash: string
  structureSourceHash: string
  experimentSourceHash: string
  structureSeed: number
  experimentSeed: number
  structureVars: Readonly<Vars>
  experimentVars: Readonly<Vars>
  kernels: readonly KernelIdentity[]
}>

export type RecordedDataEntry = Readonly<{
  spec: RecordedDataSpec
  data: RecordedDataTensor
}>

export type SimulationResult = Readonly<{
  format: 'caemble-run'
  formatVersion: 1
  runId: string
  finalStateRevision: number
  recordedData: Readonly<Record<string, RecordedDataEntry>>
  trace: readonly SimulationTraceEntry[]
  provenance: SimulationProvenance
}>

export type SimulationProgramTaskManifest = Readonly<{
  kernel: KernelIdentity & Readonly<{ descriptorHash: string }>
  descriptor: KernelDescriptor | null
  config: unknown
  configHash: string
  outputArtifacts: Readonly<Record<string, ResolvedKernelOutputSpec>>
}>

export type SimulationProgramManifest = Readonly<{
  formatVersion: 2
  programHash: string
  simulationApiVersion: 1
  pythonSource: string
  pythonSourceHash: string
  tasks: Readonly<Record<string, SimulationProgramTaskManifest>>
  recordedData: Readonly<Record<string, RecordedDataSpec>>
  recordedDataSchemaHash: string
}>

export type SimulationProgress = Readonly<{
  runId: string
  task: string
  kernel: KernelIdentity
  stage: string
  completed: number
  total?: number
  message?: string
}>

export type SimulationRunOptions = Readonly<{
  reportProgress?: (progress: SimulationProgress) => void
}>
