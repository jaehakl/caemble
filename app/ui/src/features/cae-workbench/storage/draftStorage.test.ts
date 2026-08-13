import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchDraft } from '../types'

const indexedDb = vi.hoisted(() => {
  const values = new Map<IDBValidKey, unknown>()
  return {
    values,
    createStore: vi.fn(() => ({ dbName: 'caemble', storeName: 'cae-workbench-drafts' })),
    del: vi.fn(async (key: IDBValidKey) => values.delete(key)),
    get: vi.fn(async (key: IDBValidKey) => values.get(key)),
    set: vi.fn(async (key: IDBValidKey, value: unknown) => {
      values.set(key, value)
    }),
  }
})

vi.mock('idb-keyval', () => indexedDb)

import {
  ANONYMOUS_WORKBENCH_USER,
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  workbenchDraftUserKey,
} from './draftStorage'

function makeDraft(userKey: string, savedAt: number): WorkbenchDraft {
  return {
    version: 5,
    savedAt,
    userKey,
    experiment: { record: null, baselineBundle: null, document: null, name: '', description: '' },
    candidate: { vars: null, materialParameters: null },
    selection: { measurementId: null },
    geometry: { drafts: {}, stagedModules: [], selectedCoordinate: null, expandedPaths: [] },
    layout: {
      openTabs: ['experiment'],
      activeTab: 'experiment',
      experimentFile: null,
      splitPercent: 50,
    },
  }
}

beforeEach(() => {
  indexedDb.values.clear()
  indexedDb.del.mockClear()
  indexedDb.get.mockClear()
  indexedDb.set.mockClear()
})

describe('CAE workbench draft storage', () => {
  it('keeps one latest draft in each user namespace', async () => {
    const firstAliceDraft = makeDraft('alice', 1)
    const latestAliceDraft = makeDraft('alice', 2)
    const bobDraft = makeDraft('bob', 3)

    await saveWorkbenchDraft(firstAliceDraft)
    await saveWorkbenchDraft(latestAliceDraft)
    await saveWorkbenchDraft(bobDraft)

    await expect(loadWorkbenchDraft('alice')).resolves.toEqual(latestAliceDraft)
    await expect(loadWorkbenchDraft('bob')).resolves.toEqual(bobDraft)
    expect(indexedDb.values).toHaveLength(2)
  })

  it('restores Geometry function draft sources and tree state', async () => {
    const coordinate = 'caemble:geometry/alice/common/bracket@1.0.0' as const
    const stored = {
      ...makeDraft('alice', 4),
      geometry: {
        drafts: {
          [coordinate]: {
            draftId: 'new:bracket',
            coordinate,
            source: 'const Bracket = () => <box size={[1, 2, 3]} />; export default Bracket;',
            description: 'Bracket',
            baseGeometryVersionId: null,
            repository: 'common',
            packageName: 'bracket',
            repositoryId: 3,
            packageId: null,
            version: '1.0.0',
            bump: 'patch' as const,
            rootAlias: 'Bracket',
            standalonePreview: false,
          },
        },
        stagedModules: [],
        selectedCoordinate: coordinate,
        expandedPaths: ['root:bracket'],
      },
    }

    await saveWorkbenchDraft(stored)

    await expect(loadWorkbenchDraft('alice')).resolves.toEqual(stored)
  })

  it('restores a valid staged immutable Geometry closure', async () => {
    const coordinate = 'caemble:geometry/alice/common/bracket@1.0.0' as const
    const parentCoordinate = 'caemble:geometry/alice/common/assembly@1.0.0' as const
    const source = 'const Bracket = () => <box />; export default Bracket;'
    const sourceHash = await crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(source))
      .then((value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join(''))
    const moduleHash = await crypto.subtle
      .digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: 1,
            moduleFormatVersion: 2,
            cadApiVersion: 5,
            coordinate,
            sourceHash,
            imports: [],
          }),
        ),
      )
      .then((value) => [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join(''))
    const stored: WorkbenchDraft = {
      ...makeDraft('alice', 5),
      geometry: {
        drafts: {
          [parentCoordinate]: {
            draftId: 'new:assembly',
            coordinate: parentCoordinate,
            source: `import Bracket from "${coordinate}";\nconst Assembly = () => <Bracket id="bracket" />;\nexport default Assembly;`,
            description: '',
            baseGeometryVersionId: null,
            repository: 'common',
            packageName: 'assembly',
            repositoryId: 3,
            packageId: null,
            version: '1.0.0',
            bump: 'patch',
            rootAlias: null,
            standalonePreview: false,
          },
        },
        stagedModules: [
          {
            geometryVersionId: 9,
            coordinate,
            moduleFormatVersion: 2,
            cadApiVersion: 5,
            description: null,
            source,
            sourceHash,
            moduleHash,
            imports: [],
          },
        ],
        selectedCoordinate: coordinate,
        expandedPaths: [],
      },
    }

    await saveWorkbenchDraft(stored)
    await expect(loadWorkbenchDraft('alice')).resolves.toEqual(stored)
  })

  it('normalizes an empty identity to the anonymous namespace', () => {
    expect(workbenchDraftUserKey(null)).toBe(ANONYMOUS_WORKBENCH_USER)
    expect(workbenchDraftUserKey('  ')).toBe(ANONYMOUS_WORKBENCH_USER)
    expect(workbenchDraftUserKey(' user-id ')).toBe('user-id')
  })

  it('rejects and removes an incompatible stored version', async () => {
    await saveWorkbenchDraft(makeDraft('alice', 1))
    const [key] = indexedDb.values.keys()
    indexedDb.values.set(key, { ...makeDraft('alice', 1), version: 1 })

    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    expect(indexedDb.del).toHaveBeenCalledWith(key, expect.anything())
  })

  it('rejects malformed staged Geometry modules in a current draft', async () => {
    const stored = makeDraft('alice', 1)
    const [key] = ['session:alice']
    await indexedDb.set(key, {
      ...stored,
      geometry: { ...stored.geometry, stagedModules: [{ coordinate: 'not-exact' }] },
    })

    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    expect(indexedDb.del).toHaveBeenCalledWith(key, expect.anything())
  })

  it('rejects malformed local Geometry and layout state before restore', async () => {
    const stored = makeDraft('alice', 1)
    await indexedDb.set('session:alice', {
      ...stored,
      geometry: {
        ...stored.geometry,
        drafts: {
          broken: {
            draftId: 'new:broken',
            coordinate: 'not-exact',
            source: 'export default <box />',
          },
        },
      },
      layout: { ...stored.layout, openTabs: 'experiment' },
    })

    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    expect(indexedDb.del).toHaveBeenCalledWith('session:alice', expect.anything())
  })

  it('migrates a version 2 draft with an empty Geometry workspace', async () => {
    const current = makeDraft('alice', 1)
    const { geometry, ...legacy } = current
    void geometry
    const stored = { ...legacy, version: 2 }
    await indexedDb.set('session:alice', stored)

    await expect(loadWorkbenchDraft('alice')).resolves.toMatchObject({
      version: 5,
      geometry: { drafts: {}, stagedModules: [], selectedCoordinate: null, expandedPaths: [] },
    })
    expect(indexedDb.values.get('session:alice')).toMatchObject({ version: 5 })
  })

  it('keeps Experiment source but clears legacy Geometry workspace state', async () => {
    const stored = {
      ...makeDraft('alice', 1),
      version: 4,
      experiment: { ...makeDraft('alice', 1).experiment, name: 'preserved experiment' },
      geometry: {
        drafts: { legacy: { source: 'export default <box />' } },
        stagedModules: [{ coordinate: 'legacy' }],
        selectedCoordinate: 'legacy',
        expandedPaths: ['legacy'],
      },
    }
    await indexedDb.set('session:alice', stored)

    await expect(loadWorkbenchDraft('alice')).resolves.toMatchObject({
      version: 5,
      experiment: { name: 'preserved experiment' },
      geometry: { drafts: {}, stagedModules: [], selectedCoordinate: null, expandedPaths: [] },
    })
  })

  it('discards a legacy draft whose Experiment contains a non-empty Geometry snapshot', async () => {
    const stored = {
      ...makeDraft('alice', 1),
      version: 4,
      experiment: {
        ...makeDraft('alice', 1).experiment,
        document: {
          sourceBundle: {
            formatVersion: 3,
            files: { 'experiment.tsx': 'export default {}' },
            geometrySnapshot: { schemaVersion: 1, roots: [], modules: [{ coordinate: 'legacy' }] },
          },
        },
      },
    }
    await indexedDb.set('session:alice', stored)

    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    expect(indexedDb.del).toHaveBeenCalledWith('session:alice', expect.anything())
  })

  it('clears only the requested user draft', async () => {
    await saveWorkbenchDraft(makeDraft('alice', 1))
    await saveWorkbenchDraft(makeDraft('bob', 2))

    await clearWorkbenchDraft('alice')

    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    await expect(loadWorkbenchDraft('bob')).resolves.toEqual(makeDraft('bob', 2))
  })
})
