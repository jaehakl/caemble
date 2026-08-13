import type { ExperimentRecord, MeasurementRecord, RecordedDataRecord } from '@/api'
import type {
  ExperimentSourceBundle,
  ExperimentSourceDocument,
  GeometryCoordinate,
  GeometrySnapshotModule,
  Vars,
} from '@/lib/cad'

export type SavedExperiment = ExperimentRecord & { id: number }
export type SavedMeasurement = MeasurementRecord & { id: number }
export type SavedRecordedData = RecordedDataRecord & { id?: number }

export type DefinitionStatus = 'empty' | 'new' | 'saved-clean' | 'saved-dirty'
export type WorkbenchTabId = 'experiment' | 'geometry' | 'recorded-data'

export type GeometryLocalDraft = Readonly<{
  draftId: string
  coordinate: GeometryCoordinate
  source: string
  description: string
  baseGeometryVersionId: number | null
  repository: string
  packageName: string
  repositoryId: number | null
  packageId: number | null
  version: string
  bump: 'major' | 'minor' | 'patch'
  rootAlias: string | null
  standalonePreview: boolean
}>

export type WorkbenchDraft = Readonly<{
  version: 5
  savedAt: number
  userKey: string
  experiment: Readonly<{
    record: SavedExperiment | null
    baselineBundle: ExperimentSourceBundle | null
    document: ExperimentSourceDocument | null
    name: string
    description: string
  }>
  candidate: Readonly<{
    vars: Readonly<Vars> | null
    materialParameters: SavedMeasurement['material_parameters'] | null
  }>
  selection: Readonly<{
    measurementId: number | null
  }>
  geometry: Readonly<{
    drafts: Readonly<Record<string, GeometryLocalDraft>>
    stagedModules: readonly GeometrySnapshotModule[]
    selectedCoordinate: GeometryCoordinate | null
    expandedPaths: readonly string[]
  }>
  layout: Readonly<{
    openTabs: readonly WorkbenchTabId[]
    activeTab: WorkbenchTabId | null
    experimentFile: string | null
    splitPercent: number
  }>
}>
