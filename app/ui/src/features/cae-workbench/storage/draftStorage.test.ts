// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { geometryModuleHash, geometrySourceHash, type GeometryCoordinate } from '@/lib/cad'
import type { WorkbenchDraft } from '../types'
import {
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  WORKBENCH_DRAFT_STORAGE_KEY,
} from './draftStorage'

function draft(): WorkbenchDraft {
  return {
    version: 11,
    savedAt: 1,
    experiment: { record: null, baselineBundle: null, document: null, name: '', description: '' },
    candidate: { vars: null, materialParameters: null },
    selection: { measurementId: null },
    geometryManager: {
      drafts: {},
      resolvedModules: [],
      selectedCoordinate: null,
      selectedExport: null,
    },
    experimentGeometry: { stagedModules: [] },
    layout: { openTabs: ['experiment'], activeTab: 'experiment', experimentFile: 'geometry.tsx', splitPercent: 50 },
  }
}

beforeEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('Workbench sessionStorage v11', () => {
  it('stores and restores the single session draft, including local Geometry', async () => {
    const coordinate = 'caemble:geometry/local/common/part@local' as const
    const value: WorkbenchDraft = {
      ...draft(),
      geometryManager: {
        ...draft().geometryManager,
        drafts: {
          [coordinate]: {
            draftId: 'part',
            coordinate,
            source:
              "import { type Geometry } from '@caemble/core'\nexport const Part: Geometry = () => <box size={[1, 1, 1]} />",
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
      layout: {
        ...draft().layout,
        openTabs: ['experiment', 'ai-helper'],
        activeTab: 'ai-helper',
      },
    }

    await saveWorkbenchDraft(value)

    expect(sessionStorage).toHaveLength(1)
    await expect(loadWorkbenchDraft()).resolves.toEqual(value)
  })

  it('removes malformed JSON instead of restoring it', async () => {
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, '{not-json')

    await expect(loadWorkbenchDraft()).resolves.toBeNull()
    expect(sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('migrates a v10 Geometry workspace without losing local source', async () => {
    const coordinate = 'caemble:geometry/local/common/part@local' as const
    const exactCoordinate = 'caemble:geometry/local/common/base@1.0.0' as GeometryCoordinate
    const source = 'export const Base = () => <box />'
    const sourceHash = await geometrySourceHash(source)
    const stagedModule = {
      geometryVersionId: 7,
      coordinate: exactCoordinate,
      moduleFormatVersion: 4 as const,
      cadApiVersion: 8 as const,
      description: null,
      source,
      sourceHash,
      moduleHash: await geometryModuleHash({
        coordinate: exactCoordinate,
        moduleFormatVersion: 4,
        cadApiVersion: 8,
        sourceHash,
        imports: [],
      }),
      imports: [],
    }
    const legacy = {
      ...draft(),
      version: 10,
      geometry: {
        drafts: {
          [coordinate]: {
            draftId: 'part',
            coordinate,
            source: 'export const Part = () => <box />',
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
        stagedModules: [stagedModule],
        selectedCoordinate: 'geometry.tsx',
        selectedExport: null,
        expandedPaths: ['geometry.tsx'],
      },
      geometryManager: undefined,
      experimentGeometry: undefined,
    }
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(legacy))

    await expect(loadWorkbenchDraft()).resolves.toMatchObject({
      version: 11,
      geometryManager: {
        drafts: { [coordinate]: { source: 'export const Part = () => <box />' } },
        resolvedModules: [stagedModule],
        selectedCoordinate: null,
      },
      experimentGeometry: { stagedModules: [stagedModule] },
    })
  })

  it('does not read or migrate an unsupported older draft version', async () => {
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify({ ...draft(), version: 9 }))

    await expect(loadWorkbenchDraft()).resolves.toBeNull()
    expect(sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('surfaces session quota failures to the caller', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })

    await expect(saveWorkbenchDraft(draft())).rejects.toThrow('quota exceeded')
  })

  it('clears the one fixed session key', async () => {
    await saveWorkbenchDraft(draft())
    await clearWorkbenchDraft()

    await expect(loadWorkbenchDraft()).resolves.toBeNull()
  })
})
