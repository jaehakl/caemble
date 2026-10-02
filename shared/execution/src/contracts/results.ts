import type { ResultVisualization } from './solver'

/** Frozen with the Experiment; a result is one output, even when it contains many tensors. */
export type RecordedResultContract = Readonly<{
  task: string
  output: string
  solver: Readonly<{ name: string; version: string }>
  artifactType: string
  catalogRevision: string
  visualization: ResultVisualization
  schema: Readonly<Record<string, unknown>>
}>

export type RecordedResultContracts = Readonly<Record<string, RecordedResultContract>>

export type ResultProvenance = Readonly<{
  task: string
  solver: Readonly<{ name: string; version: string }>
  stateRevision: number
  invocation: number
  catalogRevision: string
}>

export type MeasurementVisualization = Readonly<{
  contract: Readonly<{ artifactType: string; visualization: ResultVisualization }>
  schema: Readonly<Record<string, unknown>>
  data: unknown
  provenance: ResultProvenance
}>

export type MeasurementVisualizations = Readonly<Record<string, Readonly<Record<string, MeasurementVisualization>>>>
