// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type GeometryPackageRecord, type GeometryRepositoryRecord } from '@/api'
import {
  geometryModuleHash,
  geometrySourceHash,
  type GeometryCoordinate,
  type GeometrySnapshotModule,
  type LocalGeometryCoordinate,
} from '@/lib/cad'
import { useGeometryManagerState } from './useGeometryWorkspaceState'

const api = vi.hoisted(() => ({
  listRows: vi.fn(async (): Promise<{ total: number; items: GeometryRepositoryRecord[] }> => ({
    total: 0,
    items: [],
  })),
  packageListRows: vi.fn(async (): Promise<{ total: number; items: GeometryPackageRecord[] }> => ({
    total: 0,
    items: [],
  })),
  planPublish: vi.fn(),
  publish: vi.fn(),
  resolveVersion: vi.fn(),
  setNamespace: vi.fn(async (namespace: string) => ({ geometry_namespace: namespace })),
}))
const cad = vi.hoisted(() => ({ evaluateGeometryModule: vi.fn() }))

vi.mock('@/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api')>()
  return {
    ...original,
    dbTables: {
      ...original.dbTables,
      GeometryPackage: { ...original.dbTables.GeometryPackage, listRows: api.packageListRows },
      GeometryRepository: { ...original.dbTables.GeometryRepository, listRows: api.listRows },
    },
    geometryApi: {
      ...original.geometryApi,
      planPublish: api.planPublish,
      publish: api.publish,
      resolveVersion: api.resolveVersion,
      setNamespace: api.setNamespace,
    },
  }
})
vi.mock('@/lib/cad', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cad')>()
  return { ...original, evaluateGeometryModule: cad.evaluateGeometryModule }
})

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

const emptySnapshot = { schemaVersion: 2 as const, entryImports: [], modules: [] }
const sourceFiles = {
  'experiment.tsx': 'export default 1',
  'geometry.tsx': 'export {}\n',
  'material.tsx': 'export {}\n',
  'simulate.py': 'pass',
  'tasks/main.tsx': 'export default 1',
}

async function geometryModule(
  id: number,
  coordinate: GeometryCoordinate,
  source = 'export const Part = () => <box />',
): Promise<GeometrySnapshotModule> {
  const sourceHash = await geometrySourceHash(source)
  return {
    geometryVersionId: id,
    coordinate,
    moduleFormatVersion: 4,
    cadApiVersion: 7,
    description: null,
    source,
    sourceHash,
    moduleHash: await geometryModuleHash({
      coordinate,
      moduleFormatVersion: 4,
      cadApiVersion: 7,
      sourceHash,
      imports: [],
    }),
    imports: [],
  }
}

function renderState(files: Readonly<Record<string, string>> = sourceFiles) {
  return renderHook(
    () =>
      useGeometryManagerState({
        initialNamespace: 'jlee',
        snapshot: emptySnapshot,
        sourceFiles: files,
      }),
    { wrapper },
  )
}

describe('independent Geometry Manager state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.listRows.mockResolvedValue({ total: 0, items: [] })
    api.packageListRows.mockResolvedValue({ total: 0, items: [] })
    cad.evaluateGeometryModule.mockResolvedValue({
      sourceHash: 'preview-source-hash',
      scene: {
        lengthUnit: 'mm',
        parts: [],
        tree: { key: 'preview', label: 'Preview', children: [] },
        geometryGroups: [],
        surfaceGroups: [],
      },
    })
  })
  afterEach(cleanup)

  it('creates and previews a Draft Version without changing geometry.tsx', async () => {
    const { result } = renderState()
    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'part' })
    })

    await waitFor(() => expect(result.current.previewStale).toBe(false))
    expect(result.current.publishReady).toBe(false)
    expect(result.current.entrySource).toBe(sourceFiles['geometry.tsx'])
    expect(result.current.selectedCoordinate).toBe('caemble:geometry/jlee/common/part@local')
    expect(result.current.experimentDraftOverlay).toEqual({})
  })

  it('previews official source without creating a draft', async () => {
    const { result } = renderState()
    act(() => {
      result.current.previewSource('export const Official = () => <sphere />')
    })

    await waitFor(() => expect(result.current.previewStale).toBe(false))
    expect(result.current.draftVersions).toEqual({})
    expect(result.current.selectedExport).toBe('Official')
    expect(cad.evaluateGeometryModule).toHaveBeenCalledWith(
      emptySnapshot,
      expect.stringMatching(/^caemble:geometry\/local\/preview\/.+@local$/u),
      'Official',
      expect.objectContaining({ geometryDrafts: expect.any(Object) }),
    )
  })

  it('starts a Draft Version explicitly and keeps the Published source immutable', async () => {
    const coordinate = 'caemble:geometry/jlee/common/part@1.2.3' as GeometryCoordinate
    const module = await geometryModule(42, coordinate)
    api.resolveVersion.mockResolvedValue({
      root: { geometryVersionId: 42, coordinate, moduleHash: module.moduleHash, exports: ['Part'] },
      modules: [module],
    })
    const { result } = renderState()

    await act(() => result.current.previewPublishedVersion(42))
    expect(result.current.selectedCoordinate).toBe(coordinate)
    expect(result.current.managerModules).toEqual([module])
    expect(result.current.experimentModules).toEqual([])

    act(() =>
      result.current.startVersionDraft({
        versionId: 42,
        coordinate,
        source: module.source,
        description: '',
        repositoryId: 3,
        packageId: 7,
      }),
    )
    const changedSource = 'export const Part = () => <sphere />'
    act(() => result.current.updateSource(changedSource))
    const draft = result.current.draftVersions['caemble:geometry/jlee/common/part@local']
    expect(draft).toMatchObject({ baseGeometryVersionId: 42, repositoryId: 3, packageId: 7, version: '1.2.3' })
    expect(draft?.source).toBe(changedSource)
    expect(module.source).toBe('export const Part = () => <box />')
    expect(result.current.entrySource).toBe(sourceFiles['geometry.tsx'])
  })

  it('keeps at most one Draft Version per Package', async () => {
    const first = 'caemble:geometry/jlee/common/part@1.2.3' as GeometryCoordinate
    const second = 'caemble:geometry/jlee/common/part@2.0.0' as GeometryCoordinate
    const { result } = renderState()

    act(() =>
      result.current.startVersionDraft({
        versionId: 42,
        coordinate: first,
        source: 'export const Part = () => <box />',
        description: '',
        repositoryId: 3,
        packageId: 7,
      }),
    )

    expect(() =>
      result.current.startVersionDraft({
        versionId: 43,
        coordinate: second,
        source: 'export const Part = () => <sphere />',
        description: '',
        repositoryId: 3,
        packageId: 7,
      }),
    ).toThrow('Draft Version을 선택하거나 폐기')
    expect(Object.keys(result.current.draftVersions)).toHaveLength(1)
  })

  it('keeps concurrent Draft Versions for different Packages', () => {
    const { result } = renderState()

    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'plate' })
      result.current.createDraft({ repository: 'common', packageName: 'bracket' })
    })

    expect(Object.values(result.current.draftVersions).map((draft) => draft.packageName)).toEqual(['plate', 'bracket'])
  })

  it('updates a new Draft Version Package coordinate without losing source', () => {
    const { result } = renderState()
    let coordinate = '' as LocalGeometryCoordinate
    act(() => {
      coordinate = result.current.createDraft({
        repository: 'common',
        packageName: 'plate',
        source: 'export const Plate = () => <box />',
      })
    })

    act(() => {
      result.current.updateDraftPackage(coordinate, {
        repository: 'parts',
        packageName: 'bracket',
        repositoryId: null,
      })
    })

    expect(result.current.draftVersions).toHaveProperty('caemble:geometry/jlee/parts/bracket@local')
    expect(Object.values(result.current.draftVersions)[0]?.source).toBe('export const Plate = () => <box />')
  })

  it('forks Official source into an explicit Workspace Draft Version', () => {
    const { result } = renderState()
    act(() => result.current.previewSource('export const Official = () => <box />'))

    expect(result.current.draftVersions).toEqual({})
    act(() =>
      result.current.forkOfficial({
        key: 'official-box',
        source: 'export const Official = () => <sphere />',
        description: 'Official box',
        repository: 'forks',
        packageName: 'official-box',
        repositoryId: null,
      }),
    )

    expect(Object.values(result.current.draftVersions)[0]).toMatchObject({
      originCatalogKey: 'official-box',
      packageName: 'official-box',
      source: 'export const Official = () => <sphere />',
    })
  })

  it('blocks a new Draft when its target personal Package already exists', async () => {
    api.listRows.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 3,
          user_id: 'user-1',
          namespace: 'jlee',
          slug: 'forks',
          description: null,
          archived_at: null,
          created_at: null,
          updated_at: null,
        },
      ],
    })
    api.packageListRows.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 7,
          repository_id: 3,
          name: 'official-box',
          user_id: 'user-1',
          namespace: 'jlee',
          repository: 'forks',
          repository_archived_at: null,
          version_count: 1,
          latest_version: '0.1.0',
          created_at: null,
          updated_at: null,
        },
      ],
    })
    const { result } = renderState()
    await waitFor(() => expect(result.current.repositories).toHaveLength(1))
    let coordinate = '' as LocalGeometryCoordinate
    act(() => {
      coordinate = result.current.forkOfficial({
        key: 'official-box',
        repository: 'forks',
        packageName: 'official-box',
        source: 'export const Official = () => <box />',
        description: 'Official box',
        repositoryId: 3,
      })
    })
    await waitFor(() => expect(result.current.publishReady).toBe(true))

    await expect(act(() => result.current.requestPublish(coordinate))).rejects.toThrow('Package가 이미 있습니다')
    expect(api.planPublish).not.toHaveBeenCalled()
  })

  it('publishes an edited Version with a server-replanned conflict without changing Experiment state', async () => {
    const coordinate = 'caemble:geometry/jlee/common/part@1.2.3' as GeometryCoordinate
    const nextCoordinate = 'caemble:geometry/jlee/common/part@1.2.4' as GeometryCoordinate
    const localCoordinate = 'caemble:geometry/jlee/common/part@local'
    const currentModule = await geometryModule(42, coordinate)
    const nextModule = await geometryModule(43, nextCoordinate)
    api.resolveVersion.mockImplementation(async (id: number) => ({
      root:
        id === 42
          ? { geometryVersionId: 42, coordinate, moduleHash: currentModule.moduleHash, exports: ['Part'] }
          : { geometryVersionId: 43, coordinate: nextCoordinate, moduleHash: nextModule.moduleHash, exports: ['Part'] },
      modules: [id === 42 ? currentModule : nextModule],
    }))
    const { result } = renderState()

    act(() =>
      result.current.startVersionDraft({
        versionId: 42,
        coordinate,
        source: currentModule.source,
        description: '',
        repositoryId: 3,
        packageId: 7,
      }),
    )
    await waitFor(() => expect(result.current.publishReady).toBe(true))
    const draft = result.current.draftVersions[localCoordinate]!
    const revisedPlan = {
      planHash: 'a'.repeat(64),
      steps: [
        {
          draftId: draft.draftId,
          baseGeometryVersionId: 42,
          repositoryId: 3,
          repository: 'common',
          package: 'part',
          version: '1.2.4',
          coordinate: nextCoordinate,
          localCoordinate,
          description: null,
          source: draft.source,
          sourceHash: nextModule.sourceHash,
          moduleHash: nextModule.moduleHash,
          exports: ['Part'],
          imports: [],
        },
      ],
      replacements: [{ draftId: draft.draftId, localCoordinate, coordinate: nextCoordinate }],
    }
    api.planPublish.mockRejectedValueOnce(
      new ApiError(409, 'conflict', {
        code: 'geometry_version_conflict',
        draftId: draft.draftId,
        coordinate: nextCoordinate,
        suggestedVersion: '1.2.4',
        revisedPlan,
      }),
    )
    api.publish.mockResolvedValue({
      planHash: revisedPlan.planHash,
      published: [
        {
          id: 43,
          packageId: 7,
          coordinate: nextCoordinate,
          version: '1.2.4',
          description: null,
          sourceHash: nextModule.sourceHash,
          moduleHash: nextModule.moduleHash,
          moduleFormatVersion: 4,
          cadApiVersion: 7,
          archivedAt: null,
          createdAt: '2026-08-21T00:00:00Z',
        },
      ],
      replacements: revisedPlan.replacements,
    })

    await act(() => result.current.requestPublish(localCoordinate))
    expect(result.current.publishPlan?.value).toEqual(revisedPlan)
    await act(() => result.current.confirmPublish())

    expect(api.publish).toHaveBeenCalledWith(expect.objectContaining({ planHash: revisedPlan.planHash }))
    expect(result.current.draftVersions).toEqual({})
    expect(result.current.managerModules).toContainEqual(nextModule)
    expect(result.current.experimentModules).toEqual([])
    expect(result.current.entrySource).toBe(sourceFiles['geometry.tsx'])
  })

  it('stages an exact Version for Experiment only through the explicit handoff', async () => {
    const coordinate = 'caemble:geometry/jlee/common/part@1.0.0' as GeometryCoordinate
    const module = await geometryModule(42, coordinate)
    api.resolveVersion.mockResolvedValue({
      root: { geometryVersionId: 42, coordinate, moduleHash: module.moduleHash, exports: ['Part'] },
      modules: [module],
    })
    const { result } = renderState()

    let snippet = ''
    await act(async () => {
      snippet = await result.current.usePublishedExport(42, 'Part', 'Plate')
    })

    expect(snippet).toBe(`import { Part as Plate } from "${coordinate}"`)
    expect(result.current.experimentModules).toEqual([module])
    expect(result.current.managerModules).toEqual([])
    expect(result.current.entrySource).toBe(sourceFiles['geometry.tsx'])
  })

  it('blocks saving a legacy @local Experiment import instead of auto-publishing it', async () => {
    const files = {
      ...sourceFiles,
      'geometry.tsx': "import { Part } from 'caemble:geometry/jlee/common/part@local'\nexport { Part }\n",
    }
    const { result } = renderState(files)
    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'part' })
    })

    await expect(result.current.prepareExperimentSave()).rejects.toThrow('exact Version으로 바꾸세요')
    expect(api.planPublish).not.toHaveBeenCalled()
  })

  it('keeps the last successful preview and disables publishing after an edit error', async () => {
    api.listRows.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 7,
          user_id: 'user-1',
          namespace: 'jlee',
          slug: 'common',
          description: null,
          archived_at: null,
          created_at: null,
          updated_at: null,
        },
      ],
    })
    const { result } = renderState()
    await waitFor(() => expect(result.current.repositories).toHaveLength(1))
    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'part', repositoryId: 7 })
    })
    await waitFor(() => expect(result.current.publishReady).toBe(true))
    const lastScene = result.current.previewScene
    cad.evaluateGeometryModule.mockRejectedValueOnce(new Error('broken source'))

    act(() => result.current.updateSource('export const Broken = () => <box />'))

    await waitFor(() => expect(result.current.previewError).toBe('broken source'))
    expect(result.current.previewScene).toBe(lastScene)
    expect(result.current.previewStale).toBe(true)
    expect(result.current.publishReady).toBe(false)
  })

  it('serializes Manager and Experiment staging separately and restores both', async () => {
    const coordinate = 'caemble:geometry/jlee/common/part@1.0.0' as GeometryCoordinate
    const module = await geometryModule(42, coordinate)
    api.resolveVersion.mockResolvedValue({
      root: { geometryVersionId: 42, coordinate, moduleHash: module.moduleHash, exports: ['Part'] },
      modules: [module],
    })
    const first = renderState()
    act(() => {
      first.result.current.createDraft({ repository: 'common', packageName: 'local-part' })
      first.result.current.setManagerView('workspace')
      first.result.current.setSelectedCatalogKey('official-box')
    })
    await act(() => first.result.current.previewPublishedVersion(42))
    await act(() => first.result.current.usePublishedExport(42, 'Part'))
    const stored = first.result.current.draftState()
    first.unmount()

    const second = renderState()
    act(() => {
      second.result.current.restore(stored.geometryManager, stored.experimentGeometry, sourceFiles['geometry.tsx'])
    })

    expect(second.result.current.draftVersions).toHaveProperty('caemble:geometry/jlee/common/local-part@local')
    expect(second.result.current.managerModules).toEqual([module])
    expect(second.result.current.experimentModules).toEqual([module])
    expect(second.result.current.managerView).toBe('workspace')
    expect(second.result.current.selectedCatalogKey).toBe('official-box')
  })
})
