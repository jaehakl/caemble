import type {
  ExperimentRecord,
  MeasurementRecord,
  RecordedDataRecord,
  SampleRecord,
  SetupRecord,
  StructureRecord,
} from '@/api'
import type { CadSourceDocument, ExperimentSourceBundle } from '@/lib/cad'

export type SavedStructure = StructureRecord & { id: number }
export type SavedExperiment = ExperimentRecord & { id: number }
export type SavedSample = SampleRecord & { id: number }
export type SavedSetup = SetupRecord & { id: number }
export type SavedMeasurement = MeasurementRecord & { id: number }
export type SavedRecordedData = RecordedDataRecord & { id?: number }

export type DefinitionStatus = 'empty' | 'new' | 'saved-clean' | 'saved-dirty'
export type WorkbenchTabId = 'structure' | 'experiment' | 'recorded-data'

export type WorkbenchDraft = Readonly<{
  version: 1
  savedAt: number
  userKey: string
  structure: Readonly<{
    record: SavedStructure | null
    baselineCode: string | null
    document: CadSourceDocument | null
    name: string
    description: string
  }>
  experiment: Readonly<{
    record: SavedExperiment | null
    baselineBundle: ExperimentSourceBundle | null
    document: CadSourceDocument | null
    name: string
    description: string
  }>
  selection: Readonly<{
    sampleId: number | null
    setupId: number | null
    measurementId: number | null
  }>
  layout: Readonly<{
    openTabs: readonly WorkbenchTabId[]
    activeTab: WorkbenchTabId | null
    experimentFile: string | null
    splitPercent: number
  }>
}>
