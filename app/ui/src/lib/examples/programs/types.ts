import type { ExperimentSourceBundle } from '../../cad/source/document'

export type CaembleProgramExample = Readonly<{
  id: string
  title: string
  description: string
  concepts: readonly string[]
  structureCode: string
  experimentSourceBundle: ExperimentSourceBundle
  verification: Readonly<{
    kernelTasks: readonly string[]
    recordedData: readonly string[]
    expectations: readonly string[]
    fixture?: Readonly<{
      records: readonly Readonly<{
        name: string
        dtype: string
        shape: readonly number[]
        value: unknown
        absoluteTolerance: number
      }>[]
      terminal: Readonly<{
        kind: 'complete'
        sequence: number
        recordSequences: readonly number[]
      }>
    }>
  }>
}>
