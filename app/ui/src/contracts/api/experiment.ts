import type { ExperimentSourceBundle } from '../cad-persistence'
import type { DataSchema } from './measurement'

export type { ExperimentSourceBundle } from '../cad-persistence'

export type ExperimentDerivedCounts = Readonly<{
  measurements: number
  recordedData: number
  calculations: number
}>

export type ExperimentRecordContract = Readonly<{
  name: string
  quantity_kind: string | null
  tensor_order: number
  dtype: string
  data_schema: DataSchema | null
}>

type ExperimentMetadata = Readonly<{
  namespace: string
  repository: string
  key: string
  name: string
  description: string | null
  sourceBundle: ExperimentSourceBundle
  bundleHash: string
  records: readonly ExperimentRecordContract[]
}>

export type SaveExperimentRequest = ExperimentMetadata &
  (
    | Readonly<{ mode: 'create'; initialVersion?: '0.1.0' }>
    | Readonly<{ mode: 'overwrite'; experimentId: number; baseBundleHash: string }>
    | Readonly<{ mode: 'new_version'; experimentId: number; baseBundleHash: string; bump: 'patch' | 'minor' | 'major' }>
  )

export type SaveExperimentResponse = Readonly<{
  id: number
  action: 'create' | 'overwrite' | 'new_version'
  namespace: string
  repository: string
  key: string
  version: string
  coordinate: string
  bundleHash: string
  sourceLocked: boolean
  derivedCounts: ExperimentDerivedCounts
}>

export type ExperimentUsageResponse = Readonly<{
  items: readonly Readonly<{
    experimentId: number
    sourceLocked: boolean
    derivedCounts: ExperimentDerivedCounts
  }>[]
}>

export type SavedExperimentRecord = Readonly<{
  id: number
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  namespace: string
  repository_slug: string
  experiment_key: string
  version_major: number
  version_minor: number
  version_patch: number
  name: string
  description?: string | null
  source_bundle: ExperimentSourceBundle
  source_hash: string
  repository?: string
  key?: string
  version?: string
  coordinate?: string
  bundleHash?: string
  sourceLocked?: boolean
  derivedCounts?: ExperimentDerivedCounts
  isDemo?: boolean
  demoOrder?: number | null
  demoDefault?: boolean
}>

export type AvailableExperimentRecord = SavedExperimentRecord &
  Readonly<{
    predictionReady: boolean
    predictionCounts: Readonly<{
      recordedMeasurements: number
      readyCalculations: number
      calculationData: number
    }>
    demoOrder: number | null
    demoDefault: boolean
  }>

export type AvailableExperimentsResponse = Readonly<{
  mine: readonly AvailableExperimentRecord[]
  demos: readonly AvailableExperimentRecord[]
}>

export type ExperimentRecordedDataRecord = Readonly<{
  id: number
  created_at?: string | null
  updated_at?: string | null
  experiment_id: number
  name: string
  quantity_kind: string | null
  tensor_order: number
  dtype: string
  data_schema?: DataSchema | null
  contract_hash: string
}>
