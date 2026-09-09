import { beforeEach, describe, expect, it } from 'vitest'
import { defaultWorkbenchLayoutState, type WorkbenchDraft } from '../types'
import {
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  WORKBENCH_DRAFT_SCHEMA_VERSION,
  workbenchDraftStorageKey,
} from './draftStorage'

const draft: WorkbenchDraft = {
  savedAt: 123,
  experiment: {
    record: null,
    baselineBundle: { files: { 'experiment.tsx': 'export default null' } },
    document: {
      kind: 'experiment',
      sourceBundle: { files: { 'experiment.tsx': 'export default null' } },
    },
    name: 'Local draft',
    description: '',
  },
  candidate: { vars: null, materialSnapshot: null },
  selection: { experimentId: null, measurementId: null, calculationId: null },
  layout: defaultWorkbenchLayoutState,
}

beforeEach(() => sessionStorage.clear())

describe('Workbench draft storage', () => {
  it('migrates the retired Agent dock to Console without discarding the saved draft', async () => {
    const storageKey = workbenchDraftStorageKey('public')
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: WORKBENCH_DRAFT_SCHEMA_VERSION,
        ownerScope: 'public',
        draft: { ...draft, layout: { ...draft.layout, bottomMode: 'agent' } },
      }),
    )
    await expect(loadWorkbenchDraft('public')).resolves.toEqual({
      ...draft,
      layout: { ...draft.layout, bottomMode: 'console' },
    })
  })

  it('restores the retired Material section as Help Material Model', async () => {
    const storageKey = workbenchDraftStorageKey('public')
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: WORKBENCH_DRAFT_SCHEMA_VERSION,
        ownerScope: 'public',
        draft: {
          ...draft,
          layout: {
            ...draft.layout,
            activeSection: 'material',
            help: { kind: 'solvers', item: 'fdtd@2.0.0' },
          },
        },
      }),
    )

    const restored = await loadWorkbenchDraft('public')
    expect(restored?.layout.activeSection).toBe('help')
    expect(restored?.layout.help).toEqual({ kind: 'materials', item: null })
  })

  it('round-trips a local draft and clears retired keys', async () => {
    sessionStorage.setItem('caemble:cae-workbench-draft', 'retired')
    sessionStorage.setItem('caemble:cae-workbench-draft:v1', 'retired')
    await saveWorkbenchDraft('public', draft)

    await expect(loadWorkbenchDraft('public')).resolves.toEqual(draft)
    expect(sessionStorage.getItem('caemble:cae-workbench-draft')).toBeNull()
    expect(sessionStorage.getItem('caemble:cae-workbench-draft:v1')).toBeNull()
  })

  it('discards incompatible legacy drafts instead of restoring old Material snapshots', async () => {
    sessionStorage.setItem('caemble:workbench-draft', JSON.stringify(draft))
    await expect(loadWorkbenchDraft('public')).resolves.toBeNull()
    expect(sessionStorage.getItem('caemble:workbench-draft')).toBeNull()
    for (const version of [1, 2]) {
      const key = workbenchDraftStorageKey('user:first')
      sessionStorage.setItem(key, JSON.stringify({ version, ownerScope: 'user:first', draft }))
      await expect(loadWorkbenchDraft('user:first')).resolves.toBeNull()
      expect(sessionStorage.getItem(key)).toBeNull()
    }
  })

  it('round-trips the full scoped selection context', async () => {
    const record = {
      id: 4,
      user_id: 'first',
      namespace: 'first',
      repository_slug: 'private',
      experiment_key: 'draft',
      version_major: 1,
      version_minor: 0,
      version_patch: 0,
      name: 'Private',
      source_bundle: draft.experiment.baselineBundle!,
      source_hash: 'hash',
    }
    const selectedDraft: WorkbenchDraft = {
      ...draft,
      experiment: { ...draft.experiment, record },
      selection: { experimentId: 4, measurementId: 12, calculationId: 9 },
    }

    await saveWorkbenchDraft('user:first', selectedDraft)
    await expect(loadWorkbenchDraft('user:first')).resolves.toEqual(selectedDraft)
  })

  it('discards child IDs when the stored parent does not match the draft Experiment', async () => {
    const record = {
      id: 4,
      user_id: 'first',
      namespace: 'first',
      repository_slug: 'private',
      experiment_key: 'draft',
      version_major: 1,
      version_minor: 0,
      version_patch: 0,
      name: 'Private',
      source_bundle: draft.experiment.baselineBundle!,
      source_hash: 'hash',
    }
    const storageKey = workbenchDraftStorageKey('user:first')
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: WORKBENCH_DRAFT_SCHEMA_VERSION,
        ownerScope: 'user:first',
        draft: {
          ...draft,
          experiment: { ...draft.experiment, record },
          selection: { experimentId: 8, measurementId: 12, calculationId: 9 },
        },
      }),
    )

    const restored = await loadWorkbenchDraft('user:first')
    expect(restored?.experiment.record?.id).toBe(4)
    expect(restored?.selection).toEqual({ experimentId: 4, measurementId: null, calculationId: null })
  })

  it('normalizes retired layout enum values without discarding the draft', async () => {
    await saveWorkbenchDraft('public', draft)
    const storageKey = workbenchDraftStorageKey('public')
    const envelope = JSON.parse(sessionStorage.getItem(storageKey)!) as Record<string, unknown> & {
      draft: WorkbenchDraft
    }
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        ...envelope,
        draft: {
          ...draft,
          layout: {
            ...draft.layout,
            activeSection: 'retired',
            analysisTab: 'retired',
            bottomMode: 'retired',
            leftWidthRatio: 5,
          },
        },
      }),
    )

    const restored = await loadWorkbenchDraft('public')
    expect(restored?.layout.activeSection).toBe(defaultWorkbenchLayoutState.activeSection)
    expect(restored?.layout.analysisTab).toBe(defaultWorkbenchLayoutState.analysisTab)
    expect(restored?.layout.bottomMode).toBe(defaultWorkbenchLayoutState.bottomMode)
    expect(restored?.layout.leftWidthRatio).toBe(defaultWorkbenchLayoutState.leftWidthRatio)
  })

  it('rejects malformed external storage data', async () => {
    const storageKey = workbenchDraftStorageKey('public')
    sessionStorage.setItem(storageKey, JSON.stringify({ savedAt: 'yesterday' }))
    await expect(loadWorkbenchDraft('public')).resolves.toBeNull()
    expect(sessionStorage.getItem(storageKey)).toBeNull()
  })

  it('rejects malformed Candidate tensors instead of restoring untyped storage data', async () => {
    await saveWorkbenchDraft('public', draft)
    const storageKey = workbenchDraftStorageKey('public')
    const envelope = JSON.parse(sessionStorage.getItem(storageKey)!) as Record<string, unknown> & {
      draft: WorkbenchDraft
    }
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        ...envelope,
        draft: { ...draft, candidate: { ...draft.candidate, vars: { width: [1, 'invalid'] } } },
      }),
    )

    await expect(loadWorkbenchDraft('public')).resolves.toBeNull()
    expect(sessionStorage.getItem(storageKey)).toBeNull()
  })

  it('isolates drafts by account and rejects a mismatched owner envelope', async () => {
    await saveWorkbenchDraft('user:first', draft)
    await expect(loadWorkbenchDraft('user:second')).resolves.toBeNull()
    await expect(loadWorkbenchDraft('user:first')).resolves.toEqual(draft)

    const firstKey = workbenchDraftStorageKey('user:first')
    const secondKey = workbenchDraftStorageKey('user:second')
    sessionStorage.setItem(secondKey, sessionStorage.getItem(firstKey)!)

    await expect(loadWorkbenchDraft('user:second')).resolves.toBeNull()
    expect(sessionStorage.getItem(secondKey)).toBeNull()
  })

  it('removes the current and retired drafts together', async () => {
    await saveWorkbenchDraft('public', draft)
    sessionStorage.setItem('caemble:cae-workbench-draft', 'retired')
    await clearWorkbenchDraft('public')
    expect(sessionStorage.length).toBe(0)
  })
})

it('preserves example Calculations through draft storage', async () => {
  const calculations = [{ name: '평균', description: '예제', source_code: 'export default () => 1' }]
  const exampleDraft = { ...draft, experiment: { ...draft.experiment, calculations } }
  await saveWorkbenchDraft('public', exampleDraft)
  await expect(loadWorkbenchDraft('public')).resolves.toEqual(
    expect.objectContaining({
      experiment: expect.objectContaining({ calculations }),
    }),
  )
})
