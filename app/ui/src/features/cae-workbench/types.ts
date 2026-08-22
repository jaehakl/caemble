import type { ExperimentRecord, MeasurementRecord, RecordedDataRecord } from '@/api'
import type { ExperimentSourceBundle, ExperimentSourceDocument, Vars } from '@/lib/cad'

export type SavedExperiment = ExperimentRecord & { id: number }
export type SavedMeasurement = MeasurementRecord & { id: number }
export type SavedRecordedData = RecordedDataRecord & { id?: number }

export type DefinitionStatus = 'empty' | 'new' | 'saved-clean' | 'saved-dirty'

/** @deprecated The v14 editor dock is retained only for draft migration. */
export type WorkbenchTabId = 'experiment' | 'experiments' | 'recorded-data' | 'ai-helper'

export const workbenchSectionIds = [
  'experiment',
  'measurement',
  'material',
  'analysis',
  'lab',
  'help',
  'setting',
] as const
export type WorkbenchSectionId = (typeof workbenchSectionIds)[number]

export const bottomDockModes = ['hidden', 'agent', 'console'] as const
export type BottomDockMode = (typeof bottomDockModes)[number]

export const experimentRightTabIds = ['source', 'detail'] as const
export type ExperimentRightTabId = (typeof experimentRightTabIds)[number]

export const measurementRightTabIds = ['recorded-data', 'detail'] as const
export type MeasurementRightTabId = (typeof measurementRightTabIds)[number]

export const analysisTabIds = ['overview', 'relationships', 'mining', 'prediction', 'data'] as const
export type AnalysisTabId = (typeof analysisTabIds)[number]

export const helpKindIds = ['manual', 'geometry', 'materials', 'quantity-kinds', 'solvers'] as const
export type HelpKindId = (typeof helpKindIds)[number]

export const workbenchLayoutLimits = Object.freeze({
  appMinWidthPx: 1280,
  resizeHandlePx: 8,
  leftMinWidthPx: 220,
  leftMaxWidthPx: 420,
  rightMinWidthPx: 340,
  rightMaxWidthPx: 720,
  viewerMinWidthPx: 520,
  viewerMinHeightPx: 300,
  bottomCollapsedHeightPx: 32,
  bottomMinHeightPx: 160,
  bottomMaxHeightPx: 480,
})

export type WorkbenchLayoutState = Readonly<{
  activeSection: WorkbenchSectionId
  activeExperimentFile: string | null
  materialId: number | null
  leftWidthPx: number
  rightWidthPx: number
  bottomMode: BottomDockMode
  bottomHeightPx: number
  rightTabs: Readonly<{
    experiment: ExperimentRightTabId
    measurement: MeasurementRightTabId
  }>
  analysisTab: AnalysisTabId
  help: Readonly<{
    kind: HelpKindId
    item: string | null
  }>
}>

export const defaultWorkbenchLayoutState: WorkbenchLayoutState = Object.freeze({
  activeSection: 'experiment',
  activeExperimentFile: 'experiment.tsx',
  materialId: null,
  leftWidthPx: 280,
  rightWidthPx: 420,
  bottomMode: 'hidden',
  bottomHeightPx: 220,
  rightTabs: Object.freeze({ experiment: 'source', measurement: 'recorded-data' }),
  analysisTab: 'overview',
  help: Object.freeze({ kind: 'manual', item: 'program-overview' }),
})

export type WorkbenchDraftDomain = Readonly<{
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
}>

export type WorkbenchDraftV14 = WorkbenchDraftDomain &
  Readonly<{
    version: 14
    layout: Readonly<{
      openTabs: readonly WorkbenchTabId[]
      activeTab: WorkbenchTabId | null
      experimentFile: string | null
      splitPercent: number
    }>
  }>

export type WorkbenchDraft = WorkbenchDraftDomain &
  Readonly<{
    version: 15
    layout: WorkbenchLayoutState
  }>
