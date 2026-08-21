import type { ExperimentRecord, MeasurementRecord, RecordedDataRecord } from '@/api'
import type {
  ExperimentSourceBundle,
  ExperimentSourceDocument,
  GeometryModuleCoordinate,
  LocalGeometryCoordinate,
  GeometrySnapshotModule,
  Vars,
} from '@/lib/cad'

export type SavedExperiment = ExperimentRecord & { id: number }
export type SavedMeasurement = MeasurementRecord & { id: number }
export type SavedRecordedData = RecordedDataRecord & { id?: number }

export type DefinitionStatus = 'empty' | 'new' | 'saved-clean' | 'saved-dirty'
export type WorkbenchTabId = 'experiment' | 'geometry' | 'recorded-data' | 'ai-helper'

export type GeometryDraftVersion = Readonly<{
  draftId: string
  coordinate: LocalGeometryCoordinate
  source: string
  description: string
  baseGeometryVersionId: number | null
  originCatalogKey: string | null
  repository: string
  packageName: string
  repositoryId: number | null
  packageId: number | null
  version: string
  bump: 'major' | 'minor' | 'patch'
  standalonePreview: boolean
}>

export type WorkbenchDraft = Readonly<{
  version: 12
  savedAt: number
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
  geometryManager: Readonly<{
    draftVersions: Readonly<Record<string, GeometryDraftVersion>>
    resolvedModules: readonly GeometrySnapshotModule[]
    selection: Readonly<{
      view: 'official' | 'workspace'
      catalogKey: string | null
      coordinate: GeometryModuleCoordinate | null
      exportName: string | null
    }>
  }>
  experimentGeometry: Readonly<{
    stagedModules: readonly GeometrySnapshotModule[]
  }>
  layout: Readonly<{
    openTabs: readonly WorkbenchTabId[]
    activeTab: WorkbenchTabId | null
    experimentFile: string | null
    splitPercent: number
  }>
}>
