import type { CalculationDefinition } from '@/api'
import type { Vars } from '@/lib/cad/model'
import type { ExperimentSourceBundle, ExperimentSourceDocument } from '@/lib/cad/source'
import type { SavedExperiment, SavedMeasurement, WorkbenchDraft } from '../types'

export type ExperimentEditingState = Readonly<{
  document: ExperimentSourceDocument | null
  record: SavedExperiment | null
  calculations: readonly CalculationDefinition[]
  baselineBundle: ExperimentSourceBundle | null
  name: string
  description: string
  candidateVars: Readonly<Vars> | null
  candidateMaterialSnapshot: SavedMeasurement['material_snapshot'] | null
  workspaceSession: number
}>

export const initialExperimentEditingState: ExperimentEditingState = Object.freeze({
  document: null,
  record: null,
  calculations: [],
  baselineBundle: null,
  name: 'Untitled Experiment',
  description: '',
  candidateVars: null,
  candidateMaterialSnapshot: null,
  workspaceSession: 0,
})

export type ExperimentEditingAction =
  | Readonly<{ type: 'recordLoaded'; document: ExperimentSourceDocument; record: SavedExperiment }>
  | Readonly<{
      type: 'draftRestored'
      draft: WorkbenchDraft
      document: ExperimentSourceDocument | null
      candidateMaterialSnapshot: SavedMeasurement['material_snapshot'] | null
    }>
  | Readonly<{
      type: 'newStarted'
      calculations?: readonly CalculationDefinition[]
      document: ExperimentSourceDocument
      sourceBundle: ExperimentSourceBundle
      name: string
      description: string
    }>
  | Readonly<{ type: 'detached'; document: ExperimentSourceDocument }>
  | Readonly<{ type: 'sourceEdited'; document: ExperimentSourceDocument }>
  | Readonly<{
      type: 'saveCommitted'
      record: SavedExperiment
      baselineBundle: ExperimentSourceBundle
    }>
  | Readonly<{
      type: 'candidateLoaded'
      vars: Readonly<Vars>
      materialSnapshot: SavedMeasurement['material_snapshot']
    }>
  | Readonly<{
      type: 'candidateVariablesChanged'
      vars: Readonly<Vars>
      clearMaterialSnapshot?: boolean
    }>
  | Readonly<{
      type: 'candidateEvaluationAccepted'
      vars: Readonly<Vars>
      materialSnapshot?: SavedMeasurement['material_snapshot']
    }>
  | Readonly<{ type: 'candidateCleared' }>
  | Readonly<{ type: 'candidateMaterialCleared' }>
  | Readonly<{
      type: 'usageRefreshed'
      experimentId: number
      derivedCounts: NonNullable<SavedExperiment['derivedCounts']>
      sourceLocked: boolean
    }>

export function experimentEditingReducer(
  state: ExperimentEditingState,
  action: ExperimentEditingAction,
): ExperimentEditingState {
  switch (action.type) {
    case 'recordLoaded':
      return {
        ...state,
        document: action.document,
        record: action.record,
        calculations: [],
        baselineBundle: action.record.source_bundle,
        name: action.record.name,
        description: action.record.description ?? '',
        candidateVars: null,
        candidateMaterialSnapshot: null,
        workspaceSession: state.workspaceSession + 1,
      }
    case 'draftRestored':
      return {
        ...state,
        document: action.document,
        record: action.draft.experiment.record,
        calculations: action.draft.experiment.calculations ?? [],
        baselineBundle: action.draft.experiment.baselineBundle,
        name: action.draft.experiment.name,
        description: action.draft.experiment.description,
        candidateVars: action.draft.candidate.vars,
        candidateMaterialSnapshot: action.candidateMaterialSnapshot,
        workspaceSession: state.workspaceSession + 1,
      }
    case 'newStarted':
      return {
        ...state,
        document: action.document,
        record: null,
        calculations: action.calculations ?? [],
        baselineBundle: action.sourceBundle,
        name: action.name,
        description: action.description,
        candidateVars: null,
        candidateMaterialSnapshot: null,
        workspaceSession: state.workspaceSession + 1,
      }
    case 'detached':
      return {
        ...state,
        document: action.document,
        record: null,
        calculations: [],
        baselineBundle: null,
        candidateVars: null,
        candidateMaterialSnapshot: null,
        workspaceSession: state.workspaceSession + 1,
      }
    case 'sourceEdited':
      return {
        ...state,
        document: action.document,
        candidateMaterialSnapshot: null,
      }
    case 'saveCommitted':
      return {
        ...state,
        record: action.record,
        calculations: [],
        baselineBundle: action.baselineBundle,
        name: action.record.name,
        description: action.record.description ?? '',
      }
    case 'candidateLoaded':
      return {
        ...state,
        candidateVars: action.vars,
        candidateMaterialSnapshot: action.materialSnapshot,
      }
    case 'candidateVariablesChanged':
      return {
        ...state,
        candidateVars: action.vars,
        candidateMaterialSnapshot: action.clearMaterialSnapshot ? null : state.candidateMaterialSnapshot,
      }
    case 'candidateEvaluationAccepted':
      return {
        ...state,
        candidateVars: action.vars,
        candidateMaterialSnapshot: action.materialSnapshot ?? state.candidateMaterialSnapshot,
      }
    case 'candidateCleared':
      return { ...state, candidateVars: null, candidateMaterialSnapshot: null }
    case 'candidateMaterialCleared':
      return { ...state, candidateMaterialSnapshot: null }
    case 'usageRefreshed':
      return state.record?.id === action.experimentId
        ? {
            ...state,
            record: {
              ...state.record,
              derivedCounts: action.derivedCounts,
              sourceLocked: action.sourceLocked,
            },
          }
        : state
  }
}
