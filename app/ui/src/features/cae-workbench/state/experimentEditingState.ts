import type { Vars } from '@/lib/cad/model'
import type { ExperimentSourceBundle, ExperimentSourceDocument } from '@/lib/cad/source'
import type { SavedExperiment, SavedMeasurement, WorkbenchDraft } from '../types'

export type AgentExperimentChange = Readonly<{
  runId: string
  appliedAt: number
  status: 'applied' | 'conflicted'
  files: readonly Readonly<{
    path: string
    before: string | null
    after: string | null
    addedLines: number
    removedLines: number
  }>[]
}>

export type ExperimentEditingState = Readonly<{
  document: ExperimentSourceDocument | null
  record: SavedExperiment | null
  baselineBundle: ExperimentSourceBundle | null
  name: string
  description: string
  candidateVars: Readonly<Vars> | null
  candidateMaterialParameters: SavedMeasurement['material_parameters'] | null
  workspaceSession: number
  agentChange: AgentExperimentChange | null
  agentWorkspaceIdentity: Readonly<{
    baseHash: string
    document: ExperimentSourceDocument
  }> | null
}>

export const initialExperimentEditingState: ExperimentEditingState = Object.freeze({
  document: null,
  record: null,
  baselineBundle: null,
  name: 'Untitled Experiment',
  description: '',
  candidateVars: null,
  candidateMaterialParameters: null,
  workspaceSession: 0,
  agentChange: null,
  agentWorkspaceIdentity: null,
})

export type ExperimentEditingAction =
  | Readonly<{ type: 'recordLoaded'; document: ExperimentSourceDocument; record: SavedExperiment }>
  | Readonly<{
      type: 'draftRestored'
      draft: WorkbenchDraft
      document: ExperimentSourceDocument | null
      candidateMaterialParameters: SavedMeasurement['material_parameters'] | null
    }>
  | Readonly<{
      type: 'newStarted'
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
      type: 'agentApplied'
      document: ExperimentSourceDocument
      change: AgentExperimentChange
    }>
  | Readonly<{ type: 'agentUndoApplied'; document: ExperimentSourceDocument }>
  | Readonly<{ type: 'agentChangeChanged'; change: AgentExperimentChange | null }>
  | Readonly<{
      type: 'agentWorkspaceIdentityChanged'
      identity: ExperimentEditingState['agentWorkspaceIdentity']
    }>
  | Readonly<{
      type: 'candidateLoaded'
      vars: Readonly<Vars>
      materialParameters: SavedMeasurement['material_parameters']
    }>
  | Readonly<{
      type: 'candidateVariablesChanged'
      vars: Readonly<Vars>
      clearMaterialParameters?: boolean
    }>
  | Readonly<{
      type: 'candidateEvaluationAccepted'
      vars: Readonly<Vars>
      materialParameters?: SavedMeasurement['material_parameters']
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
        baselineBundle: action.record.source_bundle,
        name: action.record.name,
        description: action.record.description ?? '',
        candidateVars: null,
        candidateMaterialParameters: null,
        workspaceSession: state.workspaceSession + 1,
        agentChange: null,
        agentWorkspaceIdentity: null,
      }
    case 'draftRestored':
      return {
        ...state,
        document: action.document,
        record: action.draft.experiment.record,
        baselineBundle: action.draft.experiment.baselineBundle,
        name: action.draft.experiment.name,
        description: action.draft.experiment.description,
        candidateVars: action.draft.candidate.vars,
        candidateMaterialParameters: action.candidateMaterialParameters,
        workspaceSession: state.workspaceSession + 1,
        agentChange: null,
        agentWorkspaceIdentity: null,
      }
    case 'newStarted':
      return {
        ...state,
        document: action.document,
        record: null,
        baselineBundle: action.sourceBundle,
        name: action.name,
        description: action.description,
        candidateVars: null,
        candidateMaterialParameters: null,
        workspaceSession: state.workspaceSession + 1,
        agentChange: null,
        agentWorkspaceIdentity: null,
      }
    case 'detached':
      return {
        ...state,
        document: action.document,
        record: null,
        baselineBundle: null,
        candidateVars: null,
        candidateMaterialParameters: null,
        workspaceSession: state.workspaceSession + 1,
        agentChange: null,
        agentWorkspaceIdentity: null,
      }
    case 'sourceEdited':
      return {
        ...state,
        document: action.document,
        candidateMaterialParameters: null,
        agentWorkspaceIdentity: null,
      }
    case 'saveCommitted':
      return {
        ...state,
        record: action.record,
        baselineBundle: action.baselineBundle,
        name: action.record.name,
        description: action.record.description ?? '',
      }
    case 'agentApplied':
      return {
        ...state,
        document: action.document,
        candidateMaterialParameters: null,
        agentChange: action.change,
        agentWorkspaceIdentity: null,
      }
    case 'agentUndoApplied':
      return {
        ...state,
        document: action.document,
        candidateMaterialParameters: null,
        agentChange: null,
        agentWorkspaceIdentity: null,
      }
    case 'agentChangeChanged':
      return { ...state, agentChange: action.change }
    case 'agentWorkspaceIdentityChanged':
      return { ...state, agentWorkspaceIdentity: action.identity }
    case 'candidateLoaded':
      return {
        ...state,
        candidateVars: action.vars,
        candidateMaterialParameters: action.materialParameters,
      }
    case 'candidateVariablesChanged':
      return {
        ...state,
        candidateVars: action.vars,
        candidateMaterialParameters: action.clearMaterialParameters ? null : state.candidateMaterialParameters,
      }
    case 'candidateEvaluationAccepted':
      return {
        ...state,
        candidateVars: action.vars,
        candidateMaterialParameters: action.materialParameters ?? state.candidateMaterialParameters,
      }
    case 'candidateCleared':
      return { ...state, candidateVars: null, candidateMaterialParameters: null }
    case 'candidateMaterialCleared':
      return { ...state, candidateMaterialParameters: null }
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
