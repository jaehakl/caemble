import type { CalculationDefinition, MeasurementRecord, RecordedDataRecord, SavedExperimentRecord } from '@/api'
import type { Vars } from '@caemble/execution/cad/model'
import type { ExperimentSourceBundle, ExperimentSourceDocument } from '@caemble/execution/cad/source'

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

export const workbenchSectionIds = ['experiment', 'calculation', 'prediction', 'analysis', 'optimization'] as const
export type WorkbenchSectionId = (typeof workbenchSectionIds)[number]

export const bottomDockModes = ['hidden', 'console'] as const
export type BottomDockMode = (typeof bottomDockModes)[number]

export const workbenchLayoutLimits = Object.freeze({
  appMinWidthPx: 1280,
  resizeHandlePx: 8,
  leftMinWidthPx: 220,
  rightMinWidthPx: 340,
  viewerMinWidthPx: 520,
  viewerMinHeightPx: 300,
  bottomCollapsedHeightPx: 28,
  bottomMinHeightPx: 160,
})

export type WorkbenchLayoutState = Readonly<{
  activeSection: WorkbenchSectionId
  activeExperimentFile: string | null
  leftWidthRatio: number
  analysisLeftWidthRatio?: number
  rightWidthRatio: number
  calculationColumnRatios?: readonly [number, number]
  calculationOutputChartRatio?: number
  bottomMode: BottomDockMode
  bottomHeightRatio: number
  viewerExpanded: boolean
}>

export const defaultWorkbenchLayoutState: WorkbenchLayoutState = Object.freeze({
  activeSection: 'experiment',
  activeExperimentFile: 'experiment.tsx',
  leftWidthRatio: 0.234,
  analysisLeftWidthRatio: 0.4,
  rightWidthRatio: 0.5,
  calculationColumnRatios: Object.freeze([4 / 7, 3 / 7] as const),
  calculationOutputChartRatio: 0.65,
  bottomMode: 'hidden',
  bottomHeightRatio: 0.5,
  viewerExpanded: false,
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
