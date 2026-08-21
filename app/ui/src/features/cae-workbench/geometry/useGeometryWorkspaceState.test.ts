// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api'
import { geometryModuleHash, geometrySourceHash, type GeometryCoordinate, type GeometrySnapshotModule } from '@/lib/cad'
import { useGeometryManagerState } from './useGeometryWorkspaceState'

const api = vi.hoisted(() => ({
  listRows: vi.fn(async () => ({ total: 0, items: [] })),
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

  it('creates and previews a local draft without changing geometry.tsx', async () => {
    const { result } = renderState()
    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'part' })
    })

    await waitFor(() => expect(result.current.publishReady).toBe(true))
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
    expect(result.current.drafts).toEqual({})
    expect(result.current.selectedExport).toBe('Official')
    expect(cad.evaluateGeometryModule).toHaveBeenCalledWith(
      emptySnapshot,
      expect.stringMatching(/^caemble:geometry\/local\/preview\/.+@local$/u),
      'Official',
      expect.objectContaining({ geometryDrafts: expect.any(Object) }),
    )
  })

  it('previews a published Version and edits it as an independent new-Version draft', async () => {
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

    await act(() => result.current.editPublishedVersion(42, 3, 7))
    const draft = result.current.drafts['caemble:geometry/jlee/common/part@local']
    expect(draft).toMatchObject({ baseGeometryVersionId: 42, repositoryId: 3, packageId: 7, version: '1.2.3' })
    expect(result.current.entrySource).toBe(sourceFiles['geometry.tsx'])
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

    await act(() => result.current.editPublishedVersion(42, 3, 7))
    await waitFor(() => expect(result.current.publishReady).toBe(true))
    const draft = result.current.drafts[localCoordinate]!
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
    expect(result.current.drafts).toEqual({})
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
    const { result } = renderState()
    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'part' })
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
    act(() => first.result.current.createDraft({ repository: 'common', packageName: 'local-part' }))
    await act(() => first.result.current.previewPublishedVersion(42))
    await act(() => first.result.current.usePublishedExport(42, 'Part'))
    const stored = first.result.current.draftState()
    first.unmount()

    const second = renderState()
    act(() => {
      second.result.current.restore(stored.geometryManager, stored.experimentGeometry, sourceFiles['geometry.tsx'])
    })

    expect(second.result.current.drafts).toHaveProperty('caemble:geometry/jlee/common/local-part@local')
    expect(second.result.current.managerModules).toEqual([module])
    expect(second.result.current.experimentModules).toEqual([module])
  })
})
