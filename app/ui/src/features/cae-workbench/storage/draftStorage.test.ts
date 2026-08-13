import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchDraft } from '../types'

const indexedDb = vi.hoisted(() => {
  const values = new Map<IDBValidKey, unknown>()
  return {
    values,
    createStore: vi.fn(() => ({})),
    del: vi.fn(async (key: IDBValidKey) => values.delete(key)),
    get: vi.fn(async (key: IDBValidKey) => values.get(key)),
    set: vi.fn(async (key: IDBValidKey, value: unknown) => values.set(key, value)),
  }
})
vi.mock('idb-keyval', () => indexedDb)

import { clearWorkbenchDraft, loadWorkbenchDraft, saveWorkbenchDraft, workbenchDraftUserKey } from './draftStorage'

function draft(userKey: string): WorkbenchDraft {
  return {
    version: 7,
    savedAt: 1,
    userKey,
    experiment: { record: null, baselineBundle: null, document: null, name: '', description: '' },
    candidate: { vars: null, materialParameters: null },
    selection: { measurementId: null },
    geometry: {
      drafts: {},
      stagedModules: [],
      selectedCoordinate: 'geometry.tsx',
      selectedExport: null,
      expandedPaths: ['geometry.tsx'],
    },
    layout: { openTabs: ['experiment'], activeTab: 'experiment', experimentFile: 'geometry.tsx', splitPercent: 50 },
  }
}

beforeEach(() => {
  indexedDb.values.clear()
  vi.clearAllMocks()
})

describe('Workbench IndexedDB v7', () => {
  it('stores valid source-only local drafts per user', async () => {
    const coordinate = 'caemble:geometry/alice/common/part@local' as const
    const value: WorkbenchDraft = {
      ...draft('alice'),
      geometry: {
        ...draft('alice').geometry,
        drafts: {
          [coordinate]: {
            draftId: 'part',
            coordinate,
            source: 'export const Part = () => <box size={[1, 1, 1]} />',
            description: '',
            baseGeometryVersionId: null,
            repository: 'common',
            packageName: 'part',
            repositoryId: null,
            packageId: null,
            version: '0.1.0',
            bump: 'patch',
            standalonePreview: true,
          },
        },
        selectedCoordinate: coordinate,
        selectedExport: 'Part',
      },
    }
    await saveWorkbenchDraft(value)
    await expect(loadWorkbenchDraft('alice')).resolves.toEqual(value)
  })

  it('migrates a geometry-free v6 draft to v7', async () => {
    await indexedDb.set('session:alice', { ...draft('alice'), version: 6, geometry: undefined })
    const migrated = await loadWorkbenchDraft('alice')
    expect(migrated).toMatchObject({
      version: 7,
      geometry: { drafts: {}, selectedCoordinate: 'geometry.tsx', selectedExport: null },
    })
  })

  it('discards legacy drafts containing a Geometry graph or local draft', async () => {
    await indexedDb.set('session:alice', {
      ...draft('alice'),
      version: 6,
      geometry: {
        drafts: { legacy: { source: 'export default <box />' } },
        stagedModules: [],
        selectedCoordinate: null,
        expandedPaths: [],
      },
    })
    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    expect(indexedDb.del).toHaveBeenCalled()
  })

  it('isolates and clears user keys', async () => {
    await saveWorkbenchDraft(draft('alice'))
    await saveWorkbenchDraft(draft('bob'))
    await clearWorkbenchDraft('alice')
    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    await expect(loadWorkbenchDraft('bob')).resolves.toEqual(draft('bob'))
    expect(workbenchDraftUserKey('  ')).toBe('anonymous')
  })
})
