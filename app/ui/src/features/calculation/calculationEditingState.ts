import type { CalculationRecord } from '@/api'
import { calculationSourceSkeleton } from '@/lib/calculation'

export type SavedCalculation = CalculationRecord & Readonly<{ id: number; revision: number }>

export type CalculationDraft = Readonly<{
  id: number | null
  baseRevision: number | null
  name: string
  description: string
  sourceCode: string
}>

export type CalculationEditingState = Readonly<{
  serverSnapshot: SavedCalculation | null
  draft: CalculationDraft
  baseline: CalculationDraft
  targetSession: number
}>

export function emptyCalculationDraft(recordName?: string): CalculationDraft {
  return { id: null, baseRevision: null, description: '', name: '', sourceCode: calculationSourceSkeleton(recordName) }
}

export function calculationDraftFromRecord(row: SavedCalculation): CalculationDraft {
  return {
    id: row.id,
    baseRevision: row.revision,
    description: row.description ?? '',
    name: row.name,
    sourceCode: row.source_code,
  }
}

export function calculationDraftsEqual(left: CalculationDraft, right: CalculationDraft) {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.description === right.description &&
    left.sourceCode === right.sourceCode
  )
}

export function createInitialCalculationEditingState(recordName?: string): CalculationEditingState {
  const draft = emptyCalculationDraft(recordName)
  return {
    serverSnapshot: null,
    draft,
    baseline: draft,
    targetSession: 0,
  }
}

export const initialCalculationEditingState = Object.freeze(createInitialCalculationEditingState())

export type CalculationEditingAction =
  | Readonly<{ type: 'experimentChanged'; recordName?: string }>
  | Readonly<{ type: 'selectionChanged'; calculationId: number | null; recordName?: string }>
  | Readonly<{
      type: 'draftReplaced'
      draft: CalculationDraft
      serverSnapshot: SavedCalculation | null
    }>
  | Readonly<{ type: 'serverSnapshotReceived'; record: SavedCalculation }>
  | Readonly<{ type: 'serverSnapshotMissing'; recordName?: string }>
  | Readonly<{ type: 'newStarted'; recordName?: string }>
  | Readonly<{ type: 'templateResolved'; draft: CalculationDraft }>
  | Readonly<{ type: 'sourceEdited'; sourceCode: string }>
  | Readonly<{ type: 'saveCommitted'; draft: CalculationDraft }>
  | Readonly<{ type: 'deleted'; recordName?: string }>

function resetToNew(state: CalculationEditingState, recordName?: string): CalculationEditingState {
  const draft = emptyCalculationDraft(recordName)
  return {
    serverSnapshot: null,
    draft,
    baseline: draft,
    targetSession: state.targetSession + 1,
  }
}

export function calculationEditingReducer(
  state: CalculationEditingState,
  action: CalculationEditingAction,
): CalculationEditingState {
  switch (action.type) {
    case 'experimentChanged':
    case 'newStarted':
    case 'deleted':
      return resetToNew(state, action.recordName)
    case 'selectionChanged':
      if (action.calculationId === null) return resetToNew(state, action.recordName)
      return {
        ...state,
        targetSession: state.targetSession + 1,
      }
    case 'draftReplaced':
      return {
        ...state,
        serverSnapshot: action.serverSnapshot,
        draft: action.draft,
        baseline: action.draft,
        targetSession: state.targetSession + 1,
      }
    case 'serverSnapshotReceived': {
      const next = calculationDraftFromRecord(action.record)
      if (state.draft.id === action.record.id && !calculationDraftsEqual(state.draft, state.baseline)) {
        return { ...state, serverSnapshot: action.record }
      }
      return { ...state, serverSnapshot: action.record, draft: next, baseline: next }
    }
    case 'serverSnapshotMissing':
      if (!calculationDraftsEqual(state.draft, state.baseline)) {
        return { ...state, serverSnapshot: null }
      }
      return resetToNew(state, action.recordName)
    case 'templateResolved':
      return { ...state, draft: action.draft, baseline: action.draft }
    case 'sourceEdited':
      return { ...state, draft: { ...state.draft, sourceCode: action.sourceCode } }
    case 'saveCommitted':
      return {
        ...state,
        serverSnapshot: null,
        draft: action.draft,
        baseline: action.draft,
        targetSession: state.targetSession + 1,
      }
  }
}

export function selectCalculationEditing(state: CalculationEditingState) {
  return {
    draft: state.draft,
    dirty: !calculationDraftsEqual(state.draft, state.baseline),
    targetSession: state.targetSession,
  }
}
