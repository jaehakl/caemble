import { describe, expect, it } from 'vitest'
import {
  calculationDraftFromRecord,
  calculationEditingReducer,
  createInitialCalculationEditingState,
  selectCalculationEditing,
  type CalculationAgentChange,
  type SavedCalculation,
} from './calculationEditingState'

function savedCalculation(id: number, sourceCode: string, name = `Calculation ${id}`): SavedCalculation {
  return {
    id,
    experiment_id: 3,
    name,
    description: `${name} description`,
    source_code: sourceCode,
    contract_status: 'ready',
    experiment_record_ids: [],
  }
}

const appliedChange: CalculationAgentChange = Object.freeze({
  runId: 'run-1',
  status: 'applied',
  before: 'return before',
  after: 'return after',
  addedLines: 1,
  removedLines: 1,
})

describe('calculationEditingReducer', () => {
  it('loads a server record as one clean editing snapshot', () => {
    const record = savedCalculation(7, 'return server')

    const loaded = calculationEditingReducer(createInitialCalculationEditingState(), {
      type: 'serverSnapshotReceived',
      record,
    })

    expect(loaded.serverSnapshot).toBe(record)
    expect(loaded.draft).toEqual(calculationDraftFromRecord(record))
    expect(loaded.baseline).toBe(loaded.draft)
    expect(selectCalculationEditing(loaded).dirty).toBe(false)
  })

  it('updates the server snapshot without overwriting a dirty local draft on refetch', () => {
    const original = savedCalculation(7, 'return original')
    const loaded = calculationEditingReducer(createInitialCalculationEditingState(), {
      type: 'serverSnapshotReceived',
      record: original,
    })
    const edited = calculationEditingReducer(loaded, { type: 'sourceEdited', sourceCode: 'return local' })
    const refetched = savedCalculation(7, 'return remote', 'Renamed remotely')

    const protectedDraft = calculationEditingReducer(edited, {
      type: 'serverSnapshotReceived',
      record: refetched,
    })

    expect(protectedDraft.serverSnapshot).toBe(refetched)
    expect(protectedDraft.draft.sourceCode).toBe('return local')
    expect(protectedDraft.draft.name).toBe(original.name)
    expect(protectedDraft.baseline).toBe(loaded.baseline)
    expect(selectCalculationEditing(protectedDraft).dirty).toBe(true)
  })

  it('refreshes both draft and baseline when the current snapshot is clean', () => {
    const original = savedCalculation(7, 'return original')
    const loaded = calculationEditingReducer(createInitialCalculationEditingState(), {
      type: 'serverSnapshotReceived',
      record: original,
    })
    const refetched = savedCalculation(7, 'return remote', 'Renamed remotely')

    const refreshed = calculationEditingReducer(loaded, { type: 'serverSnapshotReceived', record: refetched })

    expect(refreshed.draft).toEqual(calculationDraftFromRecord(refetched))
    expect(refreshed.baseline).toBe(refreshed.draft)
    expect(selectCalculationEditing(refreshed).dirty).toBe(false)
  })

  it('keeps a dirty draft when a background refetch no longer contains its server row', () => {
    const original = savedCalculation(7, 'return original')
    const loaded = calculationEditingReducer(createInitialCalculationEditingState(), {
      type: 'serverSnapshotReceived',
      record: original,
    })
    const edited = calculationEditingReducer(loaded, { type: 'sourceEdited', sourceCode: 'return local' })

    const missing = calculationEditingReducer(edited, { type: 'serverSnapshotMissing', recordName: 'temperature' })

    expect(missing.serverSnapshot).toBeNull()
    expect(missing.draft.sourceCode).toBe('return local')
    expect(missing.baseline).toBe(loaded.baseline)
    expect(selectCalculationEditing(missing).dirty).toBe(true)
  })

  it('clears a clean selection when its server row disappears', () => {
    const loaded = calculationEditingReducer(createInitialCalculationEditingState(), {
      type: 'serverSnapshotReceived',
      record: savedCalculation(7, 'return original'),
    })

    const missing = calculationEditingReducer(loaded, { type: 'serverSnapshotMissing', recordName: 'temperature' })

    expect(missing.draft.id).toBeNull()
    expect(missing.draft.sourceCode).toContain('temperature')
    expect(selectCalculationEditing(missing).dirty).toBe(false)
  })

  it('explicit selection and save replace the draft atomically and advance the target session', () => {
    const initial = createInitialCalculationEditingState()
    const selectedRecord = savedCalculation(11, 'return selected')
    const selectedDraft = calculationDraftFromRecord(selectedRecord)
    const selected = calculationEditingReducer(initial, {
      type: 'draftReplaced',
      draft: selectedDraft,
      serverSnapshot: selectedRecord,
    })
    const edited = calculationEditingReducer(selected, { type: 'sourceEdited', sourceCode: 'return edited' })
    const committedDraft = { ...edited.draft, name: 'Committed' }

    const committed = calculationEditingReducer(edited, { type: 'saveCommitted', draft: committedDraft })

    expect(selected).toMatchObject({
      draft: selectedDraft,
      baseline: selectedDraft,
      serverSnapshot: selectedRecord,
      targetSession: 1,
    })
    expect(committed).toMatchObject({
      draft: committedDraft,
      baseline: committedDraft,
      serverSnapshot: null,
      targetSession: 2,
    })
    expect(selectCalculationEditing(committed).dirty).toBe(false)
  })

  it('starts and deletes back to a clean new document', () => {
    const loaded = calculationEditingReducer(createInitialCalculationEditingState(), {
      type: 'serverSnapshotReceived',
      record: savedCalculation(4, 'return saved'),
    })
    const started = calculationEditingReducer(loaded, { type: 'newStarted', recordName: 'temperature' })
    const edited = calculationEditingReducer(started, { type: 'sourceEdited', sourceCode: 'return changed' })
    const deleted = calculationEditingReducer(edited, { type: 'deleted', recordName: 'pressure' })

    expect(started.draft.id).toBeNull()
    expect(started.draft.sourceCode).toContain('temperature')
    expect(started.baseline).toBe(started.draft)
    expect(deleted.draft.sourceCode).toContain('pressure')
    expect(deleted.baseline).toBe(deleted.draft)
    expect(selectCalculationEditing(deleted).dirty).toBe(false)
  })

  it('invalidates Agent state when the externally selected Calculation changes', () => {
    const staged = calculationEditingReducer(createInitialCalculationEditingState(), {
      type: 'agentStaged',
      change: { ...appliedChange, status: 'conflicted' },
    })
    const selected = calculationEditingReducer(staged, { type: 'selectionChanged', calculationId: 8 })
    const cleared = calculationEditingReducer(selected, {
      type: 'selectionChanged',
      calculationId: null,
      recordName: 'temperature',
    })

    expect(selected).toMatchObject({ agentChange: null, agentDiffOpen: false, targetSession: 1 })
    expect(cleared).toMatchObject({
      agentChange: null,
      draft: { id: null },
      targetSession: 2,
    })
    expect(cleared.draft.sourceCode).toContain('temperature')
    expect(cleared.baseline).toBe(cleared.draft)
  })

  it('keeps staged Agent changes separate and applies or undoes source atomically', () => {
    const initial = createInitialCalculationEditingState()
    const conflictedChange = { ...appliedChange, status: 'conflicted' as const }
    const staged = calculationEditingReducer(initial, { type: 'agentStaged', change: conflictedChange })
    const applied = calculationEditingReducer(staged, {
      type: 'agentApplied',
      sourceCode: appliedChange.after,
      change: appliedChange,
    })
    const undone = calculationEditingReducer(applied, { type: 'agentUndoApplied' })

    expect(staged).toMatchObject({ agentChange: conflictedChange, agentDiffOpen: true })
    expect(staged.draft).toBe(initial.draft)
    expect(applied).toMatchObject({
      agentChange: appliedChange,
      agentDiffOpen: false,
      draft: { sourceCode: appliedChange.after },
    })
    expect(undone).toMatchObject({
      agentChange: null,
      agentDiffOpen: false,
      draft: { sourceCode: appliedChange.before },
    })
  })
})
