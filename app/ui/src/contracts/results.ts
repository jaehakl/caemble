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
