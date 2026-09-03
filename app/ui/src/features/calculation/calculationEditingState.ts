import type { CalculationRecord } from '@/api'
import { calculationSourceSkeleton } from '@/lib/calculation'

export type SavedCalculation = CalculationRecord & Readonly<{ id: number }>

export type CalculationDraft = Readonly<{
  id: number | null
  name: string
  description: string
  sourceCode: string
}>

export type CalculationAgentChange = Readonly<{
  runId: string
  status: 'applied' | 'conflicted'
  before: string
  after: string
  addedLines: number
  removedLines: number
}>

export type CalculationEditingState = Readonly<{
  serverSnapshot: SavedCalculation | null
  draft: CalculationDraft
  baseline: CalculationDraft
  agentChange: CalculationAgentChange | null
  agentDiffOpen: boolean
  targetSession: number
}>

export function emptyCalculationDraft(recordName?: string): CalculationDraft {
  return { id: null, description: '', name: '', sourceCode: calculationSourceSkeleton(recordName) }
}

export function calculationDraftFromRecord(row: SavedCalculation): CalculationDraft {
  return {
    id: row.id,
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
    agentChange: null,
    agentDiffOpen: false,
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
  | Readonly<{ type: 'agentStaged'; change: CalculationAgentChange }>
  | Readonly<{ type: 'agentApplied'; sourceCode: string; change: CalculationAgentChange }>
  | Readonly<{ type: 'agentUndoApplied' }>
  | Readonly<{ type: 'agentChangeDismissed' }>
  | Readonly<{ type: 'agentDiffOpenChanged'; open: boolean }>

function resetToNew(state: CalculationEditingState, recordName?: string): CalculationEditingState {
  const draft = emptyCalculationDraft(recordName)
  return {
    serverSnapshot: null,
    draft,
    baseline: draft,
    agentChange: null,
    agentDiffOpen: false,
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
        agentChange: null,
        agentDiffOpen: false,
        targetSession: state.targetSession + 1,
      }
    case 'draftReplaced':
      return {
        ...state,
        serverSnapshot: action.serverSnapshot,
        draft: action.draft,
        baseline: action.draft,
        agentChange: null,
        agentDiffOpen: false,
        targetSession: state.targetSession + 1,
      }
    case 'serverSnapshotReceived': {
      const next = calculationDraftFromRecord(action.record)
      if (
        state.draft.id === action.record.id &&
        (!calculationDraftsEqual(state.draft, state.baseline) || state.agentChange !== null)
      ) {
        return { ...state, serverSnapshot: action.record }
      }
      return { ...state, serverSnapshot: action.record, draft: next, baseline: next }
    }
    case 'serverSnapshotMissing':
      if (!calculationDraftsEqual(state.draft, state.baseline) || state.agentChange !== null) {
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
        agentChange: null,
        agentDiffOpen: false,
        targetSession: state.targetSession + 1,
      }
    case 'agentStaged':
      return { ...state, agentChange: action.change, agentDiffOpen: true }
    case 'agentApplied':
      return {
        ...state,
        draft: { ...state.draft, sourceCode: action.sourceCode },
        agentChange: action.change,
        agentDiffOpen: false,
      }
    case 'agentUndoApplied':
      if (!state.agentChange || state.agentChange.status !== 'applied') return state
      return {
        ...state,
        draft: { ...state.draft, sourceCode: state.agentChange.before },
        agentChange: null,
        agentDiffOpen: false,
      }
    case 'agentChangeDismissed':
      return { ...state, agentChange: null, agentDiffOpen: false }
    case 'agentDiffOpenChanged':
      return { ...state, agentDiffOpen: action.open }
  }
}

export function selectCalculationEditing(state: CalculationEditingState) {
  return {
    agentChange: state.agentChange,
    agentDiffOpen: state.agentDiffOpen,
    draft: state.draft,
    dirty: !calculationDraftsEqual(state.draft, state.baseline),
    targetSession: state.targetSession,
  }
}
