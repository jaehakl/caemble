import type { CalculationDefinition, MeasurementRecord, RecordedDataRecord, SavedExperimentRecord } from '@/api'
import type { Vars } from '@/lib/cad/model'
import type { ExperimentSourceBundle, ExperimentSourceDocument } from '@/lib/cad/source'

export type SavedExperiment = SavedExperimentRecord & { id: number }
export type SavedMeasurement = MeasurementRecord & { id: number }
export type SavedRecordedData = RecordedDataRecord & { id?: number }

export type WorkbenchSelectionContext = Readonly<
  | { experimentId: null; measurementId: null; calculationId: null }
  | { experimentId: number; measurementId: number | null; calculationId: number | null }
>

export type WorkbenchCalculationSelection = Readonly<{
  experimentId: number | null
  calculationId: number | null
}>

export type DefinitionStatus = 'empty' | 'new' | 'saved-clean' | 'saved-dirty'

/** @deprecated The v14 editor dock is retained only for draft migration. */
export type WorkbenchTabId = 'experiment' | 'experiments' | 'recorded-data'

export const workbenchSectionIds = [
  'experiment',
  'measurement',
  'prediction',
  'analysis',
  'admin',
  'lab',
  'help',
  'setting',
] as const
export type WorkbenchSectionId = (typeof workbenchSectionIds)[number]

export const bottomDockModes = ['hidden', 'console'] as const
export type BottomDockMode = (typeof bottomDockModes)[number]

export const experimentRightTabIds = ['source', 'detail'] as const
export type ExperimentRightTabId = (typeof experimentRightTabIds)[number]

export const measurementRightTabIds = ['recorded-data', 'detail'] as const
export type MeasurementRightTabId = (typeof measurementRightTabIds)[number]

export const analysisTabIds = ['explore', 'mining', 'data'] as const
export type AnalysisTabId = (typeof analysisTabIds)[number]

import type { HelpKindId } from '@/documentation/types'
export { helpKindIds, type HelpKindId } from '@/documentation/types'

export const workbenchLayoutLimits = Object.freeze({
  appMinWidthPx: 1280,
  resizeHandlePx: 8,
  leftMinWidthPx: 220,
  rightMinWidthPx: 340,
  viewerMinWidthPx: 520,
  viewerMinHeightPx: 300,
  bottomCollapsedHeightPx: 32,
  bottomMinHeightPx: 160,
})

export type WorkbenchLayoutState = Readonly<{
  activeSection: WorkbenchSectionId
  activeExperimentFile: string | null
  leftWidthRatio: number
  rightWidthRatio: number
  calculationColumnRatios?: readonly [number, number, number, number]
  calculationLeftRowRatios?: readonly [number, number, number]
  calculationOutputChartRatio?: number
  bottomMode: BottomDockMode
  bottomHeightRatio: number
  viewerExpanded: boolean
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
  leftWidthRatio: 0.234,
  rightWidthRatio: 0.5,
  calculationColumnRatios: Object.freeze([0.22, 0.26, 0.26, 0.26] as const),
  calculationLeftRowRatios: Object.freeze([0.45, 0.25, 0.3] as const),
  calculationOutputChartRatio: 0.65,
  bottomMode: 'console',
  bottomHeightRatio: 0.5,
  viewerExpanded: false,
  rightTabs: Object.freeze({ experiment: 'source', measurement: 'recorded-data' }),
  analysisTab: 'explore',
  help: Object.freeze({ kind: 'home', item: null }),
})

export type WorkbenchDraftDomain = Readonly<{
  savedAt: number
  experiment: Readonly<{
    record: SavedExperiment | null
    calculations?: readonly CalculationDefinition[]
    baselineBundle: ExperimentSourceBundle | null
    document: ExperimentSourceDocument | null
    name: string
    description: string
  }>
  candidate: Readonly<{
    vars: Readonly<Vars> | null
    materialSnapshot: SavedMeasurement['material_snapshot'] | null
  }>
  selection: WorkbenchSelectionContext
}>

export type WorkbenchDraft = WorkbenchDraftDomain &
  Readonly<{
    layout: WorkbenchLayoutState
  }>
