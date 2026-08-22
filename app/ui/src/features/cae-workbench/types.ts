import type { ExperimentRecord, MeasurementRecord, RecordedDataRecord } from '@/api'
import type { ExperimentSourceBundle, ExperimentSourceDocument, Vars } from '@/lib/cad'

export type SavedExperiment = ExperimentRecord & { id: number }
export type SavedMeasurement = MeasurementRecord & { id: number }
export type SavedRecordedData = RecordedDataRecord & { id?: number }

export type DefinitionStatus = 'empty' | 'new' | 'saved-clean' | 'saved-dirty'
export type WorkbenchTabId = 'experiment' | 'experiments' | 'recorded-data' | 'ai-helper'

export type WorkbenchDraft = Readonly<{
  version: 14
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
  layout: Readonly<{
    openTabs: readonly WorkbenchTabId[]
    activeTab: WorkbenchTabId | null
    experimentFile: string | null
    splitPercent: number
  }>
}>
