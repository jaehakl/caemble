import type { BuiltMeasurement, DataTensor } from '../../lib/cad'

export type CaeRecordedDataValue = DataTensor | CaeRecordedDataGroup
// Recursive group nodes require an interface; a direct type alias is rejected as circular by TypeScript.
export interface CaeRecordedDataGroup extends Readonly<Record<string, CaeRecordedDataValue>> {}

export type CaeSimulationStatus = 'validating' | 'running' | 'finalizing'

export type CaeSimulationProgress = Readonly<{
  runId: string
  task: string
  kernel: Readonly<{ name: string; version: string }>
  stage: string
  completed: number
  total?: number
  message?: string
}>

export type CaeStartRequest = Readonly<{
  measurement: BuiltMeasurement
}>

export type CaeNextRequest = Readonly<{
  runId: string
  ackSequence: number | null
}>

export type CaeStartedPayload = Readonly<{
  kind: 'started'
  runId: string
  maxRunSeconds: number
}>

export type CaeRecordPayload = Readonly<{
  kind: 'record'
  sequence: number
  name: string
  value: CaeRecordedDataValue
}>

export type CaeCompletePayload = Readonly<{
  kind: 'complete'
  sequence: number
  recordSequences: readonly number[]
}>

export type CaeFailedPayload = Readonly<{
  kind: 'failed'
  sequence: number
  error: Readonly<{ code: string; message: string }>
}>
