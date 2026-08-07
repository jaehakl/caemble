import type { DataTensor as CadDataTensor, RecordedDataResult } from '../model/descriptor'

export type RecordedDataSpec = RecordedDataResult
export type ResolvedDataSchema = RecordedDataSpec & Readonly<{ tensorOrder: number }>
export type DataTensor = CadDataTensor

export type KernelIdentity = Readonly<{
  name: string
  version: string
}>

export type DefinedKernelTask<Config = unknown> = Readonly<{
  kind: 'caemble-kernel-task'
  kernel: KernelIdentity
  config: Config
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
