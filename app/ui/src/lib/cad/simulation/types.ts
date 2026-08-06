import type { DataTensor as CadDataTensor, RecordedDataResult } from '../model/descriptor'
import type { KernelDescriptor } from './kernelContract'

export type ArtifactType = `${string}@${number}`
export type SimulationObservation = boolean | number | string
export type RecordedDataSpec = RecordedDataResult
export type ResolvedDataSchema = RecordedDataSpec & Readonly<{ tensorOrder: number }>
export type DataTensor = CadDataTensor

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

export type SimulationProgramTaskManifest = Readonly<{
  kernel: KernelIdentity
  config: unknown
}>

export type SimulationProgramManifest = Readonly<{
  formatVersion: 3
  simulationApiVersion: 1
  pythonSource: string
  tasks: Readonly<Record<string, SimulationProgramTaskManifest>>
  recordedData: Readonly<Record<string, ResolvedDataSchema>>
}>
