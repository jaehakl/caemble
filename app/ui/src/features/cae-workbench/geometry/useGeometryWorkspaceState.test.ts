// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api'
import {
  createGeometrySnapshot,
  geometryModuleHash,
  geometrySourceHash,
  type GeometryCoordinate,
  type LocalGeometryCoordinate,
} from '@/lib/cad'
import type { WorkbenchDraft } from '../types'
import { useGeometryWorkspaceState } from './useGeometryWorkspaceState'

const api = vi.hoisted(() => ({
  listRows: vi.fn(async () => ({ total: 0, items: [] })),
  planPublish: vi.fn(async () => ({
    planHash: 'a'.repeat(64),
    steps: [] as { draftId: string }[],
    replacements: [] as { draftId: string; localCoordinate: string; coordinate: string }[],
  })),
  publish: vi.fn(async () => ({
    planHash: 'a'.repeat(64),
    published: [],
    replacements: [] as { draftId: string; localCoordinate: string; coordinate: string }[],
  })),
  resolveVersion: vi.fn(),
  createRepository: vi.fn(),
  archiveRepository: vi.fn(),
  archiveVersion: vi.fn(),
  setNamespace: vi.fn(async (namespace: string) => ({ geometry_namespace: namespace })),
}))

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
      createRepository: api.createRepository,
      archiveRepository: api.archiveRepository,
      archiveVersion: api.archiveVersion,
      setNamespace: api.setNamespace,
    },
  }
})

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: new QueryClient() }, children)
}

const emptySnapshot = { schemaVersion: 2 as const, entryImports: [], modules: [] }
const sourceFiles = {
  'experiment.tsx': 'export default 1',
  'geometry.tsx': 'export {}\n',
  'simulate.py': 'pass',
  'tasks/main.tsx': 'export default 1',
}

describe('source-based Geometry workspace state', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('creates a standalone @local draft with a named multi-export compatible template', () => {
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'jlee',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )
    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'notched-conductor' })
    })
    const draft = Object.values(result.current.drafts)[0]
    expect(draft.coordinate).toBe('caemble:geometry/jlee/common/notched-conductor@local')
    expect(draft.source).toContain('export const NotchedConductor')
    expect(draft.source).not.toContain('export default')
    expect(draft.standalonePreview).toBe(true)
  })

  it('provides a local anonymous namespace without calling repository or publish APIs', async () => {
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          authenticated: false,
          initialNamespace: 'local',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )

    let coordinate = '' as LocalGeometryCoordinate
    act(() => {
      coordinate = result.current.createDraft({ repository: 'common', packageName: 'offline-part' })
    })
    act(() =>
      result.current.updateSource(result.current.drafts[coordinate].source.replace('[100, 12, 10]', '[20, 10, 5]')),
    )

    expect(coordinate).toBe('caemble:geometry/local/common/offline-part@local')
    expect(result.current.drafts[coordinate].source).toContain('[20, 10, 5]')
    expect(api.listRows).not.toHaveBeenCalled()
    await expect(result.current.requestPublish(coordinate)).rejects.toThrow('로그인')
    await expect(result.current.setNamespace('designer')).rejects.toThrow('로그인')
    await expect(result.current.editPublishedVersion(1)).rejects.toThrow('로그인')
    await expect(result.current.usePublishedExport(1, 'Part')).rejects.toThrow('로그인')
    await expect(result.current.createRepository('repo')).rejects.toThrow('로그인')
    await expect(result.current.prepareExperimentSave()).rejects.toThrow('로그인')
    expect(api.planPublish).not.toHaveBeenCalled()
    expect(api.resolveVersion).not.toHaveBeenCalled()
    expect(api.createRepository).not.toHaveBeenCalled()
  })

  it('rekeys unbased local drafts and imports after the signed-in namespace becomes known', async () => {
    const onExperimentChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ authenticated, initialNamespace }: { authenticated: boolean; initialNamespace: string | null }) =>
        useGeometryWorkspaceState({
          authenticated,
          initialNamespace,
          onExperimentChange,
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { initialProps: { authenticated: false, initialNamespace: 'local' }, wrapper },
    )
    const previous = 'caemble:geometry/local/common/part@local' as LocalGeometryCoordinate
    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'part' })
      result.current.setSelectedCoordinate('geometry.tsx')
      result.current.updateSource(`import { Part } from "${previous}"\nexport { Part }\n`)
    })
    act(() => result.current.setSelectedCoordinate(previous))

    rerender({ authenticated: true, initialNamespace: 'designer' })

    const current = 'caemble:geometry/designer/common/part@local'
    await waitFor(() => expect(result.current.drafts[current]).toBeDefined())
    expect(result.current.drafts[previous]).toBeUndefined()
    expect(result.current.entrySource).toContain(current)
    expect(result.current.selectedCoordinate).toBe(current)
    expect(onExperimentChange).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ 'geometry.tsx': expect.stringContaining(current) }),
    )
  })

  it('rekeys only new-repository local coordinates before changing namespace', async () => {
    const onExperimentChange = vi.fn()
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'old-user',
          onExperimentChange,
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )
    act(() => {
      result.current.createDraft({ repository: 'common', packageName: 'part' })
      result.current.setSelectedCoordinate('geometry.tsx')
      result.current.updateSource(
        'import { Part } from "caemble:geometry/old-user/common/part@local"\nexport { Part }\n',
      )
    })
    await act(() => result.current.setNamespace('new-user'))
    expect(api.setNamespace).toHaveBeenCalledWith('new-user')
    expect(result.current.drafts['caemble:geometry/new-user/common/part@local']).toBeDefined()
    expect(result.current.entrySource).toContain('caemble:geometry/new-user/common/part@local')
    expect(onExperimentChange).toHaveBeenCalled()
  })

  it('promotes the selected published occurrence and its importer path on the first source edit', async () => {
    const coordinate = 'caemble:geometry/jlee/common/part@1.0.0' as GeometryCoordinate
    const publishedSource = `import { type Geometry } from '@caemble/core'\nexport const Part: Geometry = () => <box size={[1, 1, 1]} />\n`
    const sourceHash = await geometrySourceHash(publishedSource)
    const module = {
      geometryVersionId: 9,
      coordinate,
      moduleFormatVersion: 4 as const,
      cadApiVersion: 7 as const,
      description: null,
      source: publishedSource,
      sourceHash,
      moduleHash: '',
      imports: [],
    }
    module.moduleHash = await geometryModuleHash(module)
    const snapshot = createGeometrySnapshot(
      [{ exportName: 'Part', alias: 'Part', geometryVersionId: 9, coordinate, moduleHash: module.moduleHash }],
      [module],
    )
    const files = {
      ...sourceFiles,
      'geometry.tsx': `import { Part } from "${coordinate}"\nexport { Part }\n`,
    }
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'jlee',
          onExperimentChange: vi.fn(),
          snapshot,
          sourceFiles: files,
        }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.effectiveGraph).not.toBeNull())
    act(() => {
      result.current.selectOccurrence(coordinate, [{ parent: 'geometry.tsx', alias: 'Part', coordinate }], 'Part')
    })
    act(() => {
      result.current.updateSource(publishedSource.replace('[1, 1, 1]', '[2, 2, 2]'))
    })
    const local = 'caemble:geometry/jlee/common/part@local'
    expect(result.current.drafts[local]?.source).toContain('[2, 2, 2]')
    expect(result.current.entrySource).toContain(local)
    expect(result.current.selectedCoordinate).toBe(local)
    expect(result.current.hasReachableDrafts).toBe(true)
  })

  it('publishes only the target local closure and ignores an unrelated invalid standalone draft', async () => {
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'jlee',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )
    let target = '' as LocalGeometryCoordinate
    act(() => {
      target = result.current.createDraft({ repository: 'common', packageName: 'target' })
      result.current.createDraft({ repository: 'common', packageName: 'unrelated' })
    })
    act(() => {
      result.current.updateSource('export const Broken = <box />')
    })
    await act(() => result.current.requestPublish(target))
    expect(api.planPublish).toHaveBeenCalledWith(
      expect.objectContaining({ drafts: [expect.objectContaining({ package: 'target' })] }),
    )
  })

  it('keeps an unrelated syntactically invalid draft when applying a completed publish', async () => {
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'jlee',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )
    let target = '' as LocalGeometryCoordinate
    act(() => {
      target = result.current.createDraft({ repository: 'common', packageName: 'target' })
      result.current.createDraft({ repository: 'common', packageName: 'unrelated' })
    })
    act(() => {
      result.current.updateSource('export const Broken = <box />')
    })
    const targetDraft = result.current.drafts[target]
    const exact = 'caemble:geometry/jlee/common/target@0.1.0'
    const replacements = [{ draftId: targetDraft.draftId, localCoordinate: target, coordinate: exact }]
    api.planPublish.mockResolvedValueOnce({
      planHash: 'b'.repeat(64),
      steps: [{ draftId: targetDraft.draftId }],
      replacements,
    })
    api.publish.mockResolvedValueOnce({ planHash: 'b'.repeat(64), published: [], replacements })

    await act(() => result.current.requestPublish(target))
    await act(() => result.current.confirmPublish())

    expect(api.publish).toHaveBeenCalled()
    expect(result.current.drafts[target]).toBeUndefined()
    expect(Object.values(result.current.drafts)[0]?.source).toBe('export const Broken = <box />')
  })

  it('refreshes the publish plan instead of publishing source changed behind the dialog', async () => {
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'jlee',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )
    let target = '' as LocalGeometryCoordinate
    act(() => {
      target = result.current.createDraft({ repository: 'common', packageName: 'target' })
    })
    await act(() => result.current.requestPublish(target))
    act(() =>
      result.current.updateSource(result.current.drafts[target].source.replace('[100, 12, 10]', '[50, 12, 10]')),
    )
    await act(() => result.current.confirmPublish())

    expect(api.planPublish).toHaveBeenCalledTimes(2)
    expect(api.publish).not.toHaveBeenCalled()
    expect(result.current.publishPlan?.request.drafts[0].source).toContain('[50, 12, 10]')
  })

  it('reconciles restored new-repository drafts to the current namespace without changing based drafts', () => {
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'new-user',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )
    const previous = 'caemble:geometry/old-user/common/part@local' as LocalGeometryCoordinate
    const restored = {
      drafts: {
        [previous]: {
          draftId: 'draft-1',
          coordinate: previous,
          source: `import { type Geometry } from '@caemble/core'\nexport const Part: Geometry = () => <box />`,
          description: '',
          baseGeometryVersionId: null,
          repository: 'common',
          packageName: 'part',
          repositoryId: null,
          packageId: null,
          version: '0.1.0',
          bump: 'patch' as const,
          standalonePreview: false,
        },
      },
      stagedModules: [],
      selectedCoordinate: previous,
      selectedExport: 'Part',
      expandedPaths: [`Part:${previous}`],
    } satisfies WorkbenchDraft['geometry']
    act(() => {
      result.current.restore(restored, `import { Part } from "${previous}"\nexport { Part }\n`)
    })
    const current = 'caemble:geometry/new-user/common/part@local'
    expect(result.current.drafts[current]).toBeDefined()
    expect(result.current.entrySource).toContain(current)
    expect(result.current.selectedCoordinate).toBe(current)
  })

  it('atomically publishes a projected Geometry and stages the exact Version without changing geometry.tsx', async () => {
    const files = {
      ...sourceFiles,
      'geometry.tsx': `import { type Geometry } from '@caemble/core'\nexport const Part: Geometry = () => <box />\n`,
    }
    const coordinate = 'caemble:geometry/jlee/common/part@0.1.0' as GeometryCoordinate
    const draftId = '00000000-0000-4000-8000-000000000000'
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(draftId)
    api.planPublish.mockResolvedValueOnce({
      planHash: 'a'.repeat(64),
      steps: [
        {
          draftId,
          baseGeometryVersionId: null,
          repositoryId: null,
          repository: 'common',
          package: 'part',
          version: '0.1.0',
          coordinate,
          localCoordinate: 'caemble:geometry/jlee/common/part@local',
          description: 'Uploaded part',
          source: files['geometry.tsx'],
          sourceHash: 'b'.repeat(64),
          moduleHash: 'c'.repeat(64),
          exports: ['Part'],
          imports: [],
        },
      ],
      replacements: [
        {
          draftId,
          localCoordinate: 'caemble:geometry/jlee/common/part@local',
          coordinate,
        },
      ],
    } as never)
    api.publish.mockResolvedValueOnce({
      planHash: 'a'.repeat(64),
      published: [{ id: 42, coordinate }],
      replacements: [
        {
          draftId,
          localCoordinate: 'caemble:geometry/jlee/common/part@local',
          coordinate,
        },
      ],
    } as never)
    api.resolveVersion.mockResolvedValueOnce({
      root: { geometryVersionId: 42, coordinate, moduleHash: 'b'.repeat(64), exports: ['Part'] },
      modules: [],
    })
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'jlee',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles: files,
        }),
      { wrapper },
    )

    let published: Awaited<ReturnType<(typeof result.current)['publishNewGeometry']>> | undefined
    await act(async () => {
      published = await result.current.publishNewGeometry({
        description: 'Uploaded part',
        exportName: 'Part',
        packageName: 'part',
        repository: 'common',
        repositoryId: null,
        source: files['geometry.tsx'],
      })
    })

    expect(published?.version.coordinate).toBe(coordinate)
    expect(api.planPublish.mock.invocationCallOrder[0]).toBeLessThan(api.publish.mock.invocationCallOrder[0])
    expect(api.resolveVersion).toHaveBeenCalledWith(42)
    expect(result.current.entrySource).toBe(files['geometry.tsx'])
    expect(result.current.drafts).toEqual({})
  })

  it('retries one revised plan when the atomic publish request is unchanged', async () => {
    const source = 'export const Part = () => <box />'
    const coordinate = 'caemble:geometry/jlee/common/part@0.1.0' as GeometryCoordinate
    const localCoordinate = 'caemble:geometry/jlee/common/part@local'
    const draftId = '00000000-0000-4000-8000-000000000001'
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(draftId)
    const revisedPlan = {
      planHash: 'b'.repeat(64),
      steps: [
        {
          draftId,
          baseGeometryVersionId: null,
          repositoryId: null,
          repository: 'common',
          package: 'part',
          version: '0.1.0',
          coordinate,
          localCoordinate,
          description: null,
          source,
          sourceHash: 'c'.repeat(64),
          moduleHash: 'd'.repeat(64),
          exports: ['Part'],
          imports: [],
        },
      ],
      replacements: [{ draftId, localCoordinate, coordinate }],
    }
    api.planPublish.mockResolvedValueOnce({ ...revisedPlan, planHash: 'a'.repeat(64) } as never)
    api.publish
      .mockRejectedValueOnce(
        new ApiError(409, 'conflict', {
          code: 'geometry_version_conflict',
          draftId,
          coordinate,
          suggestedVersion: '0.1.0',
          revisedPlan,
        }),
      )
      .mockResolvedValueOnce({
        planHash: revisedPlan.planHash,
        published: [{ id: 43, coordinate }],
        replacements: revisedPlan.replacements,
      } as never)
    api.resolveVersion.mockResolvedValueOnce({
      root: { geometryVersionId: 43, coordinate, moduleHash: 'd'.repeat(64), exports: ['Part'] },
      modules: [],
    })
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'jlee',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )

    await act(() =>
      result.current.publishNewGeometry({
        description: '',
        exportName: 'Part',
        packageName: 'part',
        repository: 'common',
        repositoryId: null,
        source,
      }),
    )

    expect(api.planPublish).toHaveBeenCalledOnce()
    expect(api.publish).toHaveBeenCalledTimes(2)
    expect(api.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ planHash: revisedPlan.planHash, drafts: [expect.objectContaining({ source })] }),
    )
  })

  it('blocks @local dependencies and reports a fixed-version package conflict without mutating drafts', async () => {
    const { result } = renderHook(
      () =>
        useGeometryWorkspaceState({
          initialNamespace: 'jlee',
          onExperimentChange: vi.fn(),
          snapshot: emptySnapshot,
          sourceFiles,
        }),
      { wrapper },
    )
    await expect(
      result.current.publishNewGeometry({
        description: '',
        exportName: 'Parent',
        packageName: 'parent',
        repository: 'common',
        repositoryId: null,
        source: `import { Child } from 'caemble:geometry/jlee/common/child@local'\nexport const Parent = () => <Child id="child" />`,
      }),
    ).rejects.toThrow('@local dependency')
    expect(api.planPublish).not.toHaveBeenCalled()

    const coordinate = 'caemble:geometry/jlee/common/part@0.1.0'
    api.planPublish.mockRejectedValueOnce(
      new ApiError(409, 'conflict', {
        code: 'geometry_version_conflict',
        draftId: 'server-draft',
        coordinate,
        suggestedVersion: '0.1.1',
        revisedPlan: null,
      }),
    )
    await expect(
      result.current.publishNewGeometry({
        description: '',
        exportName: 'Part',
        packageName: 'part',
        repository: 'common',
        repositoryId: null,
        source: 'export const Part = () => <box />',
      }),
    ).rejects.toThrow('다른 Package 이름')
    expect(result.current.drafts).toEqual({})
  })
})
