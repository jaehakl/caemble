import type { BoxGridData } from './boxGrid'
import type { ResultProvenance } from './results'

export type ExperimentSourceBundle = Readonly<{
  files: Readonly<Record<string, string>>
}>

export type RecordedDataAxis = Readonly<{
  ticks?: readonly (number | string)[]
  bounds?: readonly [number, number]
  implicitOrdinal?: true
}>

export type PersistedDataTensor = Readonly<{
  shape: readonly number[]
  boxGrid?: BoxGridData
  provenance?: ResultProvenance
  axes?: readonly RecordedDataAxis[]
  storage: Readonly<{ kind: 'inline'; value: unknown }> | Readonly<{ kind: 'base64'; data: string; byteLength: number }>
}>
