import type { DataTensor as CadDataTensor, RecordedDataResult } from '../model/descriptor'
import type { RecordedResultContracts } from '@/contracts/results'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { ResultVisualization } from '@/contracts/solver'

export type RecordedDataSpec = RecordedDataResult
export type ResolvedDataSchema = RecordedDataSpec & Readonly<{ tensorOrder: number }>
export type RecordedOutputReference = Readonly<{ task: string; output: string }>
export type RecordedDataSpecNode = RecordedDataSpec | RecordedOutputReference | RecordedDataSpecGroup
export interface RecordedDataSpecGroup extends Readonly<Record<string, RecordedDataSpecNode>> {}
export type ResolvedDataSchemaNode = ResolvedDataSchema | ResolvedDataSchemaGroup
export interface ResolvedDataSchemaGroup extends Readonly<Record<string, ResolvedDataSchemaNode>> {}
export interface RecordedDataSchemaTree extends Readonly<Record<string, ResolvedDataSchemaNode>> {}
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
  boxGrids?: Readonly<Record<string, BoxGridData>>
  visualizationContracts?: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          Readonly<{
            artifactType: string
            schema: RecordedDataSpecNode
            visualization: ResultVisualization
          }>
        >
      >
    >
  >
  pythonSource: string
  tasks: Readonly<Record<string, SimulationProgramTaskManifest>>
  recordedData: RecordedDataSchemaTree
  resultContracts: RecordedResultContracts
}>
