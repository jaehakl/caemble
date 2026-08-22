import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, dbTables, geometryApi, getListRequest, type GeometryRepositoryRecord } from '@/api'
import {
  analyzeGeometrySource,
  isGeometryComponentName,
  type CadDiagnostic,
  type CadScene,
  type EffectiveGeometryGraph,
  type GeometryDraftOverlay,
  type GeometryModuleCoordinate,
  type GeometrySnapshot,
  type GeometrySnapshotModule,
  type LocalGeometryCoordinate,
} from '@/lib/cad'
import type { GeometryDraftVersion, WorkbenchDraft } from '../types'
import { draftGeometrySource } from './draftGeometrySource'
import {
  assertGeometryReplacementsApplicable,
  createLocalGeometryCoordinate,
  currentGeometryPublishRequest,
  geometryCoordinateParts,
  geometryPublishRequest,
  geometrySnapshotFromEntrySource,
  isLocalGeometryCoordinate,
  mergeGeometryModules,
  rewriteGeometryCoordinates,
  toLocalGeometryCoordinate,
} from './geometryWorkspaceModel'
import { useGeometryPreview } from './useGeometryPreview'

const emptyGeometrySnapshot: GeometrySnapshot = { schemaVersion: 2, entryImports: [], modules: [] }

type GeometryPublishPlanState = Readonly<{
  request: ReturnType<typeof geometryPublishRequest>
  value: Awaited<ReturnType<typeof geometryApi.planPublish>>
}>

export type GeometryManagerState = Readonly<{
  namespace: string | null
  managerView: 'examples' | 'workspace'
  managerNamespace: string
  managerRepository: string
  selectedCatalogKey: string | null
  repositories: readonly GeometryRepositoryRecord[]
  currentSnapshot: GeometrySnapshot
  entrySource: string
  entryExports: readonly string[]
  draftVersions: Readonly<Record<string, GeometryDraftVersion>>
  managerModules: readonly GeometrySnapshotModule[]
  experimentModules: readonly GeometrySnapshotModule[]
  selectedCoordinate: GeometryModuleCoordinate | null
  selectedExport: string | null
  selectedExports: readonly string[]
  effectiveGraph: EffectiveGeometryGraph | null
  graphError: string | null
  managerDraftOverlay: GeometryDraftOverlay
  experimentAvailableOverlay: GeometryDraftOverlay
  experimentDraftOverlay: GeometryDraftOverlay
  hasReachableDrafts: boolean
  previewScene: CadScene | null
  previewSceneHash: string | null
  previewError: string | null
  previewDiagnostics: readonly CadDiagnostic[]
  previewBusy: boolean
  previewStale: boolean
  publishReady: boolean
  busy: boolean
  publishPlan: GeometryPublishPlanState | null
  setPublishPlan: Dispatch<SetStateAction<GeometryPublishPlanState | null>>
  setManagerView: (value: 'examples' | 'workspace') => void
  setManagerNamespace: (value: string) => void
  setManagerRepository: (value: string) => void
  setSelectedCatalogKey: (value: string | null) => void
  setNamespace: (value: string) => Promise<string>
  refreshRepositories: () => Promise<readonly GeometryRepositoryRecord[]>
  createRepository: (slug: string, description?: string | null) => Promise<GeometryRepositoryRecord>
  archiveRepository: (id: number) => ReturnType<typeof geometryApi.archiveRepository>
  restoreRepository: (id: number) => ReturnType<typeof geometryApi.restoreRepository>
  updateRepositoryDescription: (
    id: number,
    description: string,
  ) => ReturnType<typeof geometryApi.updateRepositoryDescription>
  deleteRepository: (id: number) => Promise<void>
  archiveVersion: (id: number) => ReturnType<typeof geometryApi.archiveVersion>
  createDraft: (value: {
    repository: string
    packageName: string
    source?: string
    description?: string
    repositoryId?: number | null
    originCatalogKey?: string | null
  }) => LocalGeometryCoordinate
  forkOfficial: (value: {
    key: string
    repository: string
    packageName: string
    source: string
    description: string
    repositoryId: number | null
  }) => LocalGeometryCoordinate
  startVersionDraft: (value: {
    versionId: number
    coordinate: GeometryModuleCoordinate
    source: string
    description: string
    repositoryId: number | null
    packageId: number
  }) => LocalGeometryCoordinate
  usePublishedExport: (versionId: number, exportName: string, alias?: string) => Promise<string>
  publishNewGeometry: (value: {
    description: string
    exportName: string
    packageName: string
    repository: string
    repositoryId: number | null
    source: string
  }) => Promise<{
    stageError: string | null
    version: Awaited<ReturnType<typeof geometryApi.publish>>['published'][number]
  }>
  stageResolved: (versionId: number, target?: 'manager' | 'experiment') => ReturnType<typeof geometryApi.resolveVersion>
  previewPublishedVersion: (versionId: number) => ReturnType<typeof geometryApi.resolveVersion>
  previewSource: (source: string) => LocalGeometryCoordinate
  updateSource: (source: string) => void
  updateDraftPackage: (
    coordinate: GeometryModuleCoordinate,
    value: { repository: string; packageName: string; repositoryId: number | null },
  ) => LocalGeometryCoordinate | undefined
  updateDescription: (coordinate: GeometryModuleCoordinate, description: string) => void
  setBump: (coordinate: GeometryModuleCoordinate, bump: GeometryDraftVersion['bump']) => void
  setVersion: (coordinate: GeometryModuleCoordinate, version: string) => void
  discardDraft: (coordinate: GeometryModuleCoordinate) => void
  requestPublish: (coordinate: GeometryModuleCoordinate) => Promise<Awaited<ReturnType<typeof geometryApi.planPublish>>>
  confirmPublish: () => Promise<Awaited<ReturnType<typeof geometryApi.publish>> | null>
  prepareExperimentSave: () => Promise<{ files: Readonly<Record<string, string>>; snapshot: GeometrySnapshot }>
  setSelectedCoordinate: (coordinate: GeometryModuleCoordinate | null) => void
  setSelectedExport: Dispatch<SetStateAction<string | null>>
  syncSnapshot: (value: GeometrySnapshot | null) => void
  restore: (
    manager: WorkbenchDraft['geometryManager'],
    experimentGeometry: WorkbenchDraft['experimentGeometry'],
    source?: string,
  ) => string
  draftState: () => Pick<WorkbenchDraft, 'experimentGeometry' | 'geometryManager'>
}>

export function useGeometryManagerState({
  authenticated = true,
  initialNamespace,
  snapshot,
  sourceFiles,
}: {
  authenticated?: boolean
  initialNamespace?: string | null
  snapshot: GeometrySnapshot | null
  sourceFiles: Readonly<Record<string, string>>
}): GeometryManagerState {
  const queryClient = useQueryClient()
  const [namespace, setNamespaceState] = useState(initialNamespace ?? null)
  const [repositories, setRepositories] = useState<readonly GeometryRepositoryRecord[]>([])
  const [currentSnapshot, setCurrentSnapshot] = useState(snapshot ?? emptyGeometrySnapshot)
  const [entrySource, setEntrySource] = useState(sourceFiles['geometry.tsx'] ?? 'export {}\n')
  const [drafts, setDrafts] = useState<Readonly<Record<string, GeometryDraftVersion>>>({})
  const [managerModules, setManagerModules] = useState<readonly GeometrySnapshotModule[]>([])
  const [experimentModules, setExperimentModules] = useState<readonly GeometrySnapshotModule[]>([])
  const [transientPreview, setTransientPreview] = useState<Readonly<{
    coordinate: LocalGeometryCoordinate
    source: string
  }> | null>(null)
  const [managerView, setManagerView] = useState<'examples' | 'workspace'>('examples')
  const [managerNamespace, setManagerNamespace] = useState('examples')
  const [managerRepository, setManagerRepository] = useState('all')
  const [selectedCatalogKey, setSelectedCatalogKey] = useState<string | null>(null)
  const [selectedCoordinate, setSelectedCoordinateState] = useState<GeometryModuleCoordinate | null>(null)
  const [busy, setBusy] = useState(false)
  const [publishPlan, setPublishPlan] = useState<GeometryPublishPlanState | null>(null)

  const draftsRef = useRef(drafts)
  const managerModulesRef = useRef(managerModules)
  const experimentModulesRef = useRef(experimentModules)
  const snapshotRef = useRef(currentSnapshot)
  const entryRef = useRef(entrySource)
  const filesRef = useRef(sourceFiles)
  const selectedCoordinateRef = useRef(selectedCoordinate)
  const publishedPreviewSequenceRef = useRef(0)
  const initialNamespaceRef = useRef(initialNamespace)
  const authenticatedRef = useRef(authenticated)
  draftsRef.current = drafts
  managerModulesRef.current = managerModules
  experimentModulesRef.current = experimentModules
  snapshotRef.current = currentSnapshot
  entryRef.current = entrySource
  filesRef.current = sourceFiles
  selectedCoordinateRef.current = selectedCoordinate

  const selectCoordinate = useCallback((coordinate: GeometryModuleCoordinate | null) => {
    publishedPreviewSequenceRef.current += 1
    selectedCoordinateRef.current = coordinate
    setSelectedCoordinateState(coordinate)
  }, [])

  useEffect(() => {
    if (!authenticated) {
      setNamespaceState('local')
      return
    }
    if (!initialNamespace) {
      setNamespaceState(null)
      return
    }
    if (Object.keys(draftsRef.current).length === 0) setNamespaceState(initialNamespace)
  }, [authenticated, initialNamespace])
  useEffect(() => {
    const source = sourceFiles['geometry.tsx'] ?? 'export {}\n'
    entryRef.current = source
    setEntrySource(source)
  }, [sourceFiles])

  const managerDraftOverlay = useMemo<GeometryDraftOverlay>(
    () =>
      Object.freeze(
        Object.fromEntries([
          ...managerModules.map((module) => [module.coordinate, { source: module.source }] as const),
          ...Object.values(drafts).map((draft) => [draft.coordinate, { source: draft.source }] as const),
          ...(transientPreview ? ([[transientPreview.coordinate, { source: transientPreview.source }]] as const) : []),
        ]),
      ),
    [drafts, managerModules, transientPreview],
  )

  const experimentAvailableOverlay = useMemo<GeometryDraftOverlay>(
    () =>
      Object.freeze(
        Object.fromEntries([
          ...experimentModules.map((module) => [module.coordinate, { source: module.source }] as const),
          ...Object.values(drafts).map((draft) => [draft.coordinate, { source: draft.source }] as const),
        ]),
      ),
    [drafts, experimentModules],
  )

  const selectedModule = useMemo(() => {
    if (!selectedCoordinate) return null
    return managerModules.find((item) => item.coordinate === selectedCoordinate) ?? null
  }, [managerModules, selectedCoordinate])
  const entryExports = useMemo(() => {
    try {
      return analyzeGeometrySource(entrySource, { allowEmpty: true, allowLocal: true }).exports.map((item) => item.name)
    } catch {
      return []
    }
  }, [entrySource])
  const selectedSource = selectedCoordinate
    ? (drafts[selectedCoordinate]?.source ??
      selectedModule?.source ??
      (transientPreview?.coordinate === selectedCoordinate ? transientPreview.source : undefined))
    : undefined
  const {
    effectiveGraph,
    experimentDraftOverlay,
    graphError,
    previewBusy,
    previewDiagnostics,
    previewError,
    previewInputKey,
    previewScene,
    previewSceneHash,
    previewStale,
    previewedInputKey,
    resetPreview,
    selectedExport,
    selectedExports,
    setGraphError,
    setSelectedExport,
  } = useGeometryPreview({
    currentSnapshot,
    entrySource,
    experimentAvailableOverlay,
    managerDraftOverlay,
    selectedCoordinate,
    selectedSource,
  })

  const refreshRepositories = useCallback(async () => {
    if (!authenticated) {
      setRepositories([])
      return []
    }
    const response = await dbTables.GeometryRepository.listRows({
      ...getListRequest('mine'),
      limit: null,
      sort: [
        ['namespace', 'asc'],
        ['slug', 'asc'],
      ],
    })
    let nextDrafts = draftsRef.current
    for (const draft of Object.values(draftsRef.current)) {
      if (draft.baseGeometryVersionId !== null || draft.repositoryId !== null) continue
      const draftNamespace = geometryCoordinateParts(draft.coordinate).namespace
      const repository = response.items.find(
        (item) => item.archived_at === null && item.namespace === draftNamespace && item.slug === draft.repository,
      )
      if (repository) nextDrafts = { ...nextDrafts, [draft.coordinate]: { ...draft, repositoryId: repository.id } }
    }
    if (nextDrafts !== draftsRef.current) {
      draftsRef.current = nextDrafts
      setDrafts(nextDrafts)
    }
    setRepositories(response.items)
    return response.items
  }, [authenticated])

  useEffect(() => {
    void refreshRepositories().catch(() => undefined)
  }, [refreshRepositories])

  const applyNamespace = useCallback(
    (nextNamespace: string) => {
      const replacements: Record<string, string> = {}
      Object.values(draftsRef.current).forEach((draft) => {
        if (draft.baseGeometryVersionId !== null || draft.repositoryId !== null) return
        const parts = geometryCoordinateParts(draft.coordinate)
        if (parts.namespace !== nextNamespace) {
          replacements[draft.coordinate] = createLocalGeometryCoordinate(
            nextNamespace,
            draft.repository,
            draft.packageName,
          )
        }
      })
      const targetCoordinates = Object.values(draftsRef.current).map(
        (draft) => replacements[draft.coordinate] ?? draft.coordinate,
      )
      if (targetCoordinates.length !== new Set(targetCoordinates).size) {
        throw new Error('namespace 변경 후 Draft Version coordinate가 충돌합니다.')
      }
      const nextDrafts = Object.fromEntries(
        Object.values(draftsRef.current).map((draft) => {
          const coordinate = (replacements[draft.coordinate] ?? draft.coordinate) as LocalGeometryCoordinate
          return [coordinate, { ...draft, coordinate, source: rewriteGeometryCoordinates(draft.source, replacements) }]
        }),
      ) as Readonly<Record<string, GeometryDraftVersion>>
      setNamespaceState(nextNamespace)
      draftsRef.current = nextDrafts
      setDrafts(nextDrafts)
      const selected = selectedCoordinateRef.current
      selectCoordinate(selected ? ((replacements[selected] ?? selected) as GeometryModuleCoordinate) : selected)
    },
    [selectCoordinate],
  )

  useEffect(() => {
    const wasAuthenticated = authenticatedRef.current
    const previousNamespace = initialNamespaceRef.current
    authenticatedRef.current = authenticated
    initialNamespaceRef.current = initialNamespace
    if (!authenticated || !initialNamespace || (wasAuthenticated && previousNamespace === initialNamespace)) return
    try {
      applyNamespace(initialNamespace)
    } catch (cause) {
      setGraphError(
        `Draft Version을 로그인 namespace로 조정하지 못했습니다. 충돌하는 Version을 정리한 뒤 다시 적용하세요. ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }, [applyNamespace, authenticated, initialNamespace, setGraphError])

  const updateSource = useCallback(
    (source: string) => {
      if (!selectedCoordinate) return
      if (isLocalGeometryCoordinate(selectedCoordinate)) {
        const draft = draftsRef.current[selectedCoordinate]
        if (!draft) return
        const next = { ...draftsRef.current, [selectedCoordinate]: { ...draft, source } }
        draftsRef.current = next
        setDrafts(next)
        return
      }
      throw new Error('Published Geometry를 수정하면 Draft Version이 먼저 생성되어야 합니다.')
    },
    [selectedCoordinate],
  )

  const createDraft = useCallback(
    ({
      repository,
      packageName,
      source,
      description = '',
      repositoryId = null,
      originCatalogKey = null,
    }: {
      repository: string
      packageName: string
      source?: string
      description?: string
      repositoryId?: number | null
      originCatalogKey?: string | null
    }) => {
      if (!namespace) throw new Error('기본 Geometry namespace를 먼저 설정하세요.')
      const repositoryRecord = repositories.find((item) => item.id === repositoryId)
      const ownerNamespace = repositoryRecord?.namespace ?? namespace
      const repositorySlug = repositoryRecord?.slug ?? repository
      const coordinate = createLocalGeometryCoordinate(ownerNamespace, repositorySlug, packageName)
      if (draftsRef.current[coordinate]) throw new Error('이 Package의 Draft Version이 이미 있습니다.')
      const draft: GeometryDraftVersion = {
        draftId: crypto.randomUUID(),
        coordinate,
        source: source ?? draftGeometrySource(packageName),
        description,
        baseGeometryVersionId: null,
        originCatalogKey,
        repository: repositorySlug,
        packageName,
        repositoryId,
        packageId: null,
        version: '0.1.0',
        bump: 'patch',
        standalonePreview: true,
      }
      analyzeGeometrySource(draft.source, { allowLocal: true })
      const next = { ...draftsRef.current, [coordinate]: draft }
      draftsRef.current = next
      setDrafts(next)
      setTransientPreview(null)
      selectCoordinate(coordinate)
      return coordinate
    },
    [namespace, repositories, selectCoordinate],
  )

  const forkOfficial = useCallback(
    ({
      key,
      repository,
      packageName,
      source,
      description,
      repositoryId,
    }: {
      key: string
      repository: string
      packageName: string
      source: string
      description: string
      repositoryId: number | null
    }) =>
      createDraft({
        repository,
        packageName,
        source,
        description,
        repositoryId,
        originCatalogKey: key,
      }),
    [createDraft],
  )

  const stageResolved = useCallback(
    async (versionId: number, target: 'manager' | 'experiment' = 'manager') => {
      if (!authenticated) throw new Error('Published Geometry 조회는 로그인 후 사용할 수 있습니다.')
      const resolved = await geometryApi.resolveVersion(versionId)
      if (target === 'manager') {
        const next = mergeGeometryModules(managerModulesRef.current, resolved.modules)
        managerModulesRef.current = next
        setManagerModules(next)
      } else {
        const next = mergeGeometryModules(experimentModulesRef.current, resolved.modules)
        experimentModulesRef.current = next
        setExperimentModules(next)
      }
      return resolved
    },
    [authenticated],
  )

  const previewPublishedVersion = useCallback(
    async (versionId: number) => {
      const sequence = ++publishedPreviewSequenceRef.current
      const resolved = await stageResolved(versionId, 'manager')
      if (sequence !== publishedPreviewSequenceRef.current) return resolved
      setTransientPreview(null)
      selectedCoordinateRef.current = resolved.root.coordinate
      setSelectedCoordinateState(resolved.root.coordinate)
      return resolved
    },
    [stageResolved],
  )

  const previewSource = useCallback(
    (source: string) => {
      analyzeGeometrySource(source, { allowLocal: true })
      const coordinate = `caemble:geometry/local/preview/${crypto.randomUUID()}@local` as LocalGeometryCoordinate
      setTransientPreview({ coordinate, source })
      selectCoordinate(coordinate)
      return coordinate
    },
    [selectCoordinate],
  )

  const publishNewGeometry = useCallback(
    async ({
      description,
      exportName,
      packageName,
      repository,
      repositoryId,
      source,
    }: {
      description: string
      exportName: string
      packageName: string
      repository: string
      repositoryId: number | null
      source: string
    }) => {
      if (!authenticated) throw new Error('Geometry 저장은 로그인 후 사용할 수 있습니다.')
      if (!namespace) throw new Error('기본 Geometry namespace를 먼저 설정하세요.')
      const analysis = analyzeGeometrySource(source, { allowLocal: true })
      if (analysis.exports.length !== 1 || analysis.exports[0]?.name !== exportName) {
        throw new Error(`업로드 source는 ${exportName} export 하나만 포함해야 합니다.`)
      }
      const localImport = analysis.imports.find((item) => isLocalGeometryCoordinate(item.coordinate))
      if (localImport) {
        throw new Error(
          `발행 전 Draft dependency를 먼저 발행하세요: ${geometryCoordinateParts(localImport.coordinate).packageName}`,
        )
      }
      const repositoryRecord = repositories.find((item) => item.id === repositoryId)
      if (repositoryId !== null && !repositoryRecord) {
        throw new Error('선택한 Geometry Repository를 더 이상 사용할 수 없습니다.')
      }
      const ownerNamespace = repositoryRecord?.namespace ?? namespace
      const repositorySlug = repositoryRecord?.slug ?? repository
      const coordinate = createLocalGeometryCoordinate(ownerNamespace, repositorySlug, packageName)
      const exactCoordinate = `caemble:geometry/${ownerNamespace}/${repositorySlug}/${packageName}@0.1.0`
      if (draftsRef.current[coordinate]) {
        throw new Error('같은 Package의 Draft Version이 있습니다. 먼저 발행하거나 폐기하세요.')
      }
      const draftId = crypto.randomUUID()
      const request = {
        targetDraftId: draftId,
        drafts: [
          {
            draftId,
            baseGeometryVersionId: null,
            repositoryId,
            repository: repositorySlug,
            package: packageName,
            version: '0.1.0',
            description: description.trim() || null,
            source,
          },
        ],
      }
      const assertSingleStep = (plan: Awaited<ReturnType<typeof geometryApi.planPublish>>) => {
        const step = plan.steps[0]
        const replacement = plan.replacements[0]
        if (
          plan.steps.length !== 1 ||
          plan.replacements.length !== 1 ||
          step?.draftId !== draftId ||
          step.baseGeometryVersionId !== null ||
          step.repositoryId !== repositoryId ||
          step.repository !== repositorySlug ||
          step.package !== packageName ||
          step.version !== '0.1.0' ||
          step.coordinate !== exactCoordinate ||
          step.localCoordinate !== coordinate ||
          step.description !== request.drafts[0]?.description ||
          step.source !== source ||
          step.exports.length !== 1 ||
          step.exports[0] !== exportName ||
          replacement?.draftId !== draftId ||
          replacement.localCoordinate !== coordinate ||
          replacement.coordinate !== exactCoordinate
        ) {
          throw new Error('새 Geometry 발행 계획이 요청과 일치하지 않습니다.')
        }
      }
      const conflict = (cause: unknown) => {
        const parsed =
          cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
        if (!parsed?.success) return null
        if (!parsed.data.revisedPlan) {
          return new Error(`${parsed.data.coordinate}가 이미 존재합니다. 다른 Package 이름을 사용하세요.`)
        }
        return parsed.data.revisedPlan
      }

      setBusy(true)
      try {
        let plan: Awaited<ReturnType<typeof geometryApi.planPublish>>
        try {
          plan = await geometryApi.planPublish(request)
        } catch (cause) {
          const parsed = conflict(cause)
          if (parsed instanceof Error) throw parsed
          throw cause
        }
        assertSingleStep(plan)
        let result: Awaited<ReturnType<typeof geometryApi.publish>>
        try {
          result = await geometryApi.publish({ ...request, planHash: plan.planHash })
        } catch (cause) {
          const revised = conflict(cause)
          if (revised instanceof Error) throw revised
          if (!revised) throw cause
          assertSingleStep(revised)
          result = await geometryApi.publish({ ...request, planHash: revised.planHash })
        }
        const version = result.published[0]
        const replacement = result.replacements[0]
        if (
          result.published.length !== 1 ||
          result.replacements.length !== 1 ||
          version?.coordinate !== exactCoordinate ||
          replacement?.draftId !== draftId ||
          replacement.localCoordinate !== coordinate ||
          replacement.coordinate !== exactCoordinate
        ) {
          throw new Error('발행된 Geometry Version 응답을 확인하지 못했습니다.')
        }
        let stageError: string | null = null
        try {
          await Promise.all([stageResolved(version.id), refreshRepositories()])
        } catch (cause) {
          stageError = cause instanceof Error ? cause.message : String(cause)
        }
        await queryClient.invalidateQueries({ queryKey: ['geometry'] })
        return { stageError, version }
      } finally {
        setBusy(false)
      }
    },
    [authenticated, namespace, queryClient, refreshRepositories, repositories, stageResolved],
  )

  const startVersionDraft = useCallback(
    ({
      versionId,
      coordinate,
      source,
      description,
      repositoryId,
      packageId,
    }: {
      versionId: number
      coordinate: GeometryModuleCoordinate
      source: string
      description: string
      repositoryId: number | null
      packageId: number
    }) => {
      const parts = geometryCoordinateParts(coordinate)
      const local = toLocalGeometryCoordinate(coordinate)
      const existing = draftsRef.current[local]
      if (existing && existing.baseGeometryVersionId !== versionId) {
        throw new Error('이 Package의 Draft Version을 선택하거나 폐기한 뒤 다른 Version을 편집하세요.')
      }
      const draft: GeometryDraftVersion = existing ?? {
        draftId: crypto.randomUUID(),
        coordinate: local,
        source,
        description,
        baseGeometryVersionId: versionId,
        originCatalogKey: null,
        repository: parts.repository,
        packageName: parts.packageName,
        repositoryId,
        packageId,
        version: parts.version,
        bump: 'patch',
        standalonePreview: true,
      }
      const next = { ...draftsRef.current, [local]: draft }
      draftsRef.current = next
      setDrafts(next)
      setTransientPreview(null)
      selectCoordinate(local)
      return local
    },
    [selectCoordinate],
  )

  const usePublishedExport = useCallback(
    async (versionId: number, exportName: string, alias = exportName) => {
      if (!isGeometryComponentName(alias)) throw new Error(`${alias}는 올바른 Geometry component alias가 아닙니다.`)
      const resolved = await stageResolved(versionId, 'experiment')
      if (!resolved.root.exports.includes(exportName)) throw new Error(`${exportName} export를 찾을 수 없습니다.`)
      return `import { ${exportName}${alias === exportName ? '' : ` as ${alias}`} } from ${JSON.stringify(
        resolved.root.coordinate,
      )}`
    },
    [stageResolved],
  )

  const resolvePublishedModules = useCallback(async (ids: readonly number[]) => {
    const resolved = await Promise.all(ids.map((id) => geometryApi.resolveVersion(id)))
    return mergeGeometryModules(...resolved.map((item) => item.modules))
  }, [])

  const applyPublished = useCallback(
    async (
      request: ReturnType<typeof geometryPublishRequest>,
      plan: Awaited<ReturnType<typeof geometryApi.planPublish>>,
      result: Awaited<ReturnType<typeof geometryApi.publish>>,
    ) => {
      const replacements = Object.fromEntries(
        result.replacements.map((item) => [item.localCoordinate, item.coordinate]),
      )
      const publishedDraftIds = new Set(plan.steps.map((item) => item.draftId))
      const nextDrafts = Object.fromEntries(
        Object.values(draftsRef.current)
          .filter((draft) => !publishedDraftIds.has(draft.draftId))
          .map((draft) => [
            draft.coordinate,
            { ...draft, source: rewriteGeometryCoordinates(draft.source, replacements) },
          ]),
      ) as Readonly<Record<string, GeometryDraftVersion>>
      draftsRef.current = nextDrafts
      setDrafts(nextDrafts)
      const selectedReplacement = result.replacements.find(
        (item) => item.localCoordinate === selectedCoordinateRef.current,
      )
      if (selectedReplacement) selectCoordinate(selectedReplacement.coordinate)
      let stageError: string | null = null
      try {
        const publishedModules = await resolvePublishedModules(result.published.map((item) => item.id))
        const allModules = mergeGeometryModules(managerModulesRef.current, publishedModules)
        managerModulesRef.current = allModules
        setManagerModules(allModules)
      } catch (cause) {
        stageError = cause instanceof Error ? cause.message : String(cause)
      }
      try {
        await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      } catch (cause) {
        const invalidateError = cause instanceof Error ? cause.message : String(cause)
        stageError = stageError ? `${stageError} ${invalidateError}` : invalidateError
      }
      return { request, stageError }
    },
    [queryClient, resolvePublishedModules, selectCoordinate],
  )

  const assertNewPackageTargetsAvailable = useCallback(
    async (request: ReturnType<typeof geometryPublishRequest>) => {
      const targets = request.drafts.filter((draft) => draft.baseGeometryVersionId === null)
      await Promise.all(
        targets.map(async (draft) => {
          const localDraft = Object.values(draftsRef.current).find((item) => item.draftId === draft.draftId)
          if (!localDraft) return
          const parts = geometryCoordinateParts(localDraft.coordinate)
          const repository =
            repositories.find((item) => item.id === draft.repositoryId) ??
            repositories.find((item) => item.namespace === parts.namespace && item.slug === draft.repository)
          if (!repository) return
          const response = await dbTables.GeometryPackage.listRows({
            ...getListRequest('mine'),
            limit: 100,
            text_filter: { name: [draft.package] },
            filter: { repository_id: [repository.id, repository.id] },
          })
          if (response.items.some((item) => item.repository_id === repository.id && item.name === draft.package)) {
            throw new Error(
              `${repository.namespace}/${repository.slug}/${draft.package} Package가 이미 있습니다. 다른 이름을 사용하세요.`,
            )
          }
        }),
      )
    },
    [repositories],
  )

  const requestPublish = useCallback(
    async (coordinate: GeometryModuleCoordinate) => {
      if (!authenticated) throw new Error('Geometry 저장은 로그인 후 사용할 수 있습니다.')
      const target = draftsRef.current[coordinate]
      if (target?.baseGeometryVersionId === null && target.repositoryId === null) {
        throw new Error('발행할 Repository를 선택하거나 새로 만드세요.')
      }
      const request = geometryPublishRequest(draftsRef.current, coordinate)
      setBusy(true)
      try {
        await assertNewPackageTargetsAvailable(request)
        const value = await geometryApi.planPublish(request)
        assertGeometryReplacementsApplicable(value.replacements, 'export {}\n', draftsRef.current)
        setPublishPlan({ request, value })
        return value
      } catch (cause) {
        const parsed =
          cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
        if (parsed?.success && parsed.data.revisedPlan) {
          assertGeometryReplacementsApplicable(parsed.data.revisedPlan.replacements, 'export {}\n', draftsRef.current)
          setPublishPlan({ request, value: parsed.data.revisedPlan })
          return parsed.data.revisedPlan
        }
        throw cause
      } finally {
        setBusy(false)
      }
    },
    [assertNewPackageTargetsAvailable, authenticated],
  )

  const confirmPublish = useCallback(async () => {
    if (!authenticated) throw new Error('Geometry 저장은 로그인 후 사용할 수 있습니다.')
    if (!publishPlan) return null
    setBusy(true)
    try {
      const currentRequest = currentGeometryPublishRequest(draftsRef.current, publishPlan.request)
      await assertNewPackageTargetsAvailable(currentRequest)
      if (JSON.stringify(currentRequest) !== JSON.stringify(publishPlan.request)) {
        const value = await geometryApi.planPublish(currentRequest)
        assertGeometryReplacementsApplicable(value.replacements, 'export {}\n', draftsRef.current)
        setPublishPlan({ request: currentRequest, value })
        toast.info('Geometry source 변경을 반영해 발행 계획을 갱신했습니다. 내용을 확인해 주세요.')
        return null
      }
      assertGeometryReplacementsApplicable(publishPlan.value.replacements, 'export {}\n', draftsRef.current)
      const result = await geometryApi.publish({ ...publishPlan.request, planHash: publishPlan.value.planHash })
      const applied = await applyPublished(publishPlan.request, publishPlan.value, result)
      setPublishPlan(null)
      toast.success(`${result.published.length}개 Geometry Version을 발행했습니다.`)
      if (applied.stageError) {
        toast.warning(`발행은 완료됐지만 Workbench staging을 갱신하지 못했습니다. ${applied.stageError}`)
      }
      return result
    } catch (cause) {
      const parsed =
        cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
      if (!parsed?.success || !parsed.data.revisedPlan) throw cause
      const currentRequest = currentGeometryPublishRequest(draftsRef.current, publishPlan.request)
      if (JSON.stringify(currentRequest) !== JSON.stringify(publishPlan.request)) {
        const value = await geometryApi.planPublish(currentRequest)
        assertGeometryReplacementsApplicable(value.replacements, 'export {}\n', draftsRef.current)
        setPublishPlan({ request: currentRequest, value })
        toast.info('Geometry source 변경을 반영해 발행 계획을 갱신했습니다. 내용을 확인해 주세요.')
        return null
      }
      assertGeometryReplacementsApplicable(parsed.data.revisedPlan.replacements, 'export {}\n', draftsRef.current)
      setPublishPlan({ request: publishPlan.request, value: parsed.data.revisedPlan })
      toast.info('다른 변경을 반영해 발행 계획을 갱신했습니다. 내용을 확인한 뒤 다시 발행하세요.')
      return null
    } finally {
      setBusy(false)
    }
  }, [applyPublished, assertNewPackageTargetsAvailable, authenticated, publishPlan])

  const prepareExperimentSave = useCallback(async () => {
    if (!authenticated) throw new Error('Experiment 저장은 로그인 후 사용할 수 있습니다.')
    setBusy(true)
    try {
      const local = analyzeGeometrySource(entryRef.current, { allowEmpty: true, allowLocal: true }).imports.find(
        (item) => isLocalGeometryCoordinate(item.coordinate),
      )
      if (local) {
        throw new Error(
          `Experiment geometry.tsx가 발행 전 Draft Version을 참조합니다. Geometry 탭에서 ${geometryCoordinateParts(local.coordinate).packageName}을 먼저 발행하고 exact Version으로 바꾸세요.`,
        )
      }
      const nextSnapshot = geometrySnapshotFromEntrySource(
        entryRef.current,
        mergeGeometryModules(snapshotRef.current.modules, experimentModulesRef.current),
      )
      snapshotRef.current = nextSnapshot
      setCurrentSnapshot(nextSnapshot)
      return { files: filesRef.current, snapshot: nextSnapshot }
    } finally {
      setBusy(false)
    }
  }, [authenticated])

  const setNamespace = useCallback(
    async (nextNamespace: string) => {
      if (!authenticated) throw new Error('Geometry namespace 변경은 로그인 후 사용할 수 있습니다.')
      const user = await geometryApi.setNamespace(nextNamespace)
      if (!user.geometry_namespace) throw new Error('Geometry namespace를 설정하지 못했습니다.')
      applyNamespace(user.geometry_namespace)
      return user.geometry_namespace
    },
    [applyNamespace, authenticated],
  )

  const updateDraftPackage = useCallback(
    (
      coordinate: GeometryModuleCoordinate,
      {
        repository,
        packageName,
        repositoryId,
      }: { repository: string; packageName: string; repositoryId: number | null },
    ) => {
      const draft = draftsRef.current[coordinate]
      if (!draft || draft.baseGeometryVersionId !== null) return
      if (!namespace) throw new Error('기본 Geometry namespace를 먼저 설정하세요.')
      const repositoryRecord = repositories.find((item) => item.id === repositoryId)
      if (repositoryId !== null && !repositoryRecord) throw new Error('선택한 Geometry Repository를 찾을 수 없습니다.')
      const ownerNamespace = repositoryRecord?.namespace ?? namespace
      const repositorySlug = repositoryRecord?.slug ?? repository
      const nextCoordinate = createLocalGeometryCoordinate(ownerNamespace, repositorySlug, packageName)
      if (nextCoordinate !== coordinate && draftsRef.current[nextCoordinate]) {
        throw new Error('이 Package의 Draft Version이 이미 있습니다.')
      }
      const nextDrafts = Object.fromEntries(
        Object.values(draftsRef.current).map((item) => {
          const source = rewriteGeometryCoordinates(item.source, { [coordinate]: nextCoordinate })
          return item.coordinate === coordinate
            ? [
                nextCoordinate,
                {
                  ...item,
                  coordinate: nextCoordinate,
                  source,
                  repository: repositorySlug,
                  packageName,
                  repositoryId,
                },
              ]
            : [item.coordinate, { ...item, source }]
        }),
      ) as Readonly<Record<string, GeometryDraftVersion>>
      draftsRef.current = nextDrafts
      setDrafts(nextDrafts)
      selectCoordinate(nextCoordinate)
      return nextCoordinate
    },
    [namespace, repositories, selectCoordinate],
  )

  const discardDraft = useCallback(
    (coordinate: GeometryModuleCoordinate) => {
      const draft = draftsRef.current[coordinate]
      if (!draft) return
      const referenced = [entryRef.current, ...Object.values(draftsRef.current).map((item) => item.source)].some(
        (source) =>
          analyzeGeometrySource(source, { allowEmpty: true, allowLocal: true }).imports.some(
            (item) => item.coordinate === coordinate,
          ),
      )
      if (referenced) {
        throw new Error('이 Draft Version을 참조하는 source import를 먼저 제거하세요.')
      }
      const next = Object.fromEntries(
        Object.values(draftsRef.current)
          .filter((item) => item.coordinate !== coordinate)
          .map((item) => [item.coordinate, item]),
      ) as Readonly<Record<string, GeometryDraftVersion>>
      draftsRef.current = next
      setDrafts(next)
      selectCoordinate(null)
      setSelectedExport(null)
    },
    [selectCoordinate, setSelectedExport],
  )

  const syncSnapshot = useCallback((value: GeometrySnapshot | null) => {
    const next = value ?? emptyGeometrySnapshot
    snapshotRef.current = next
    experimentModulesRef.current = []
    setCurrentSnapshot(next)
    setExperimentModules([])
  }, [])

  const restore = useCallback(
    (
      manager: WorkbenchDraft['geometryManager'],
      experimentGeometry: WorkbenchDraft['experimentGeometry'],
      source = entryRef.current,
    ) => {
      const replacements: Record<string, string> = {}
      if (namespace) {
        Object.values(manager.draftVersions).forEach((draft) => {
          if (draft.baseGeometryVersionId !== null || draft.repositoryId !== null) return
          const parts = geometryCoordinateParts(draft.coordinate)
          if (parts.namespace !== namespace) {
            replacements[draft.coordinate] = createLocalGeometryCoordinate(
              namespace,
              draft.repository,
              draft.packageName,
            )
          }
        })
      }
      let nextSource = source
      let nextDrafts = manager.draftVersions
      if (Object.keys(replacements).length) {
        try {
          const targetCoordinates = Object.values(manager.draftVersions).map(
            (draft) => replacements[draft.coordinate] ?? draft.coordinate,
          )
          if (targetCoordinates.length !== new Set(targetCoordinates).size) {
            throw new Error('복원한 Draft Version의 coordinate가 현재 namespace에서 충돌합니다.')
          }
          nextSource = rewriteGeometryCoordinates(source, replacements)
          nextDrafts = Object.fromEntries(
            Object.values(manager.draftVersions).map((draft) => {
              const coordinate = (replacements[draft.coordinate] ?? draft.coordinate) as LocalGeometryCoordinate
              return [
                coordinate,
                { ...draft, coordinate, source: rewriteGeometryCoordinates(draft.source, replacements) },
              ]
            }),
          ) as Readonly<Record<string, GeometryDraftVersion>>
        } catch (cause) {
          setGraphError(
            `복원한 Draft Version을 현재 namespace로 조정하지 못했습니다. source 오류를 수정한 뒤 namespace를 다시 적용하세요. ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      }
      draftsRef.current = nextDrafts
      managerModulesRef.current = manager.resolvedModules
      experimentModulesRef.current = experimentGeometry.stagedModules
      entryRef.current = nextSource
      setDrafts(nextDrafts)
      setManagerModules(manager.resolvedModules)
      setExperimentModules(experimentGeometry.stagedModules)
      setEntrySource(nextSource)
      selectCoordinate(
        nextDrafts !== manager.draftVersions && manager.selection.coordinate
          ? ((replacements[manager.selection.coordinate] ?? manager.selection.coordinate) as GeometryModuleCoordinate)
          : manager.selection.coordinate,
      )
      setSelectedExport(manager.selection.exportName)
      setManagerView(manager.selection.view)
      setManagerNamespace(manager.selection.namespace)
      setManagerRepository(manager.selection.repository)
      setSelectedCatalogKey(manager.selection.catalogKey)
      resetPreview()
      return nextSource
    },
    [namespace, resetPreview, selectCoordinate, setGraphError, setSelectedExport],
  )

  const reachableLocalCoordinates = useMemo(() => {
    const reachable = new Set<string>()
    const pending: string[] = []
    try {
      analyzeGeometrySource(entrySource, { allowEmpty: true, allowLocal: true }).imports.forEach((item) => {
        if (isLocalGeometryCoordinate(item.coordinate)) pending.push(item.coordinate)
      })
      while (pending.length) {
        const coordinate = pending.pop()!
        if (reachable.has(coordinate)) continue
        reachable.add(coordinate)
        const draft = drafts[coordinate]
        if (!draft) continue
        analyzeGeometrySource(draft.source, { allowLocal: true }).imports.forEach((item) => {
          if (isLocalGeometryCoordinate(item.coordinate)) pending.push(item.coordinate)
        })
      }
    } catch {
      Object.keys(drafts).forEach((coordinate) => {
        if (entrySource.includes(coordinate) || reachable.has(coordinate)) reachable.add(coordinate)
      })
    }
    return reachable
  }, [drafts, entrySource])

  const createRepository = useCallback(
    async (slug: string, description?: string | null) => {
      if (!authenticated) throw new Error('Geometry Repository 관리는 로그인 후 사용할 수 있습니다.')
      const result = await geometryApi.createRepository({ slug, description })
      const next = await refreshRepositories()
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      const created = next.find((repository) => repository.id === result.id)
      if (!created) throw new Error('생성한 Geometry Repository를 다시 불러오지 못했습니다.')
      return created
    },
    [authenticated, queryClient, refreshRepositories],
  )
  const archiveRepository = useCallback(
    async (id: number) => {
      if (!authenticated) throw new Error('Geometry Repository 관리는 로그인 후 사용할 수 있습니다.')
      const result = await geometryApi.archiveRepository(id)
      await refreshRepositories()
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      return result
    },
    [authenticated, queryClient, refreshRepositories],
  )
  const restoreRepository = useCallback(
    async (id: number) => {
      if (!authenticated) throw new Error('Geometry Repository 관리는 로그인 후 사용할 수 있습니다.')
      const result = await geometryApi.restoreRepository(id)
      await refreshRepositories()
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      return result
    },
    [authenticated, queryClient, refreshRepositories],
  )
  const updateRepositoryDescription = useCallback(
    async (id: number, description: string) => {
      if (!authenticated) throw new Error('Geometry Repository 관리는 로그인 후 사용할 수 있습니다.')
      const result = await geometryApi.updateRepositoryDescription(id, description)
      await refreshRepositories()
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      return result
    },
    [authenticated, queryClient, refreshRepositories],
  )
  const deleteRepository = useCallback(
    async (id: number) => {
      if (!authenticated) throw new Error('Geometry Repository 관리는 로그인 후 사용할 수 있습니다.')
      if (Object.values(draftsRef.current).some((draft) => draft.repositoryId === id)) {
        throw new Error('현재 Manager Draft가 연결된 Repository는 삭제할 수 없습니다.')
      }
      const packages = await dbTables.GeometryPackage.listRows({
        ...getListRequest('visible'),
        limit: null,
        filter: { repository_id: [id, id] },
      })
      const versions = (
        await Promise.all(
          packages.items.map((item) =>
            dbTables.GeometryVersion.listRows({
              ...getListRequest('visible'),
              limit: null,
              filter: { package_id: [item.id, item.id] },
            }),
          ),
        )
      ).flatMap((response) => response.items)
      const locallyReferencedVersionIds = new Set([
        ...snapshotRef.current.modules.map((module) => module.geometryVersionId),
        ...managerModulesRef.current.map((module) => module.geometryVersionId),
        ...experimentModulesRef.current.map((module) => module.geometryVersionId),
        ...Object.values(draftsRef.current).flatMap((draft) =>
          draft.baseGeometryVersionId === null ? [] : [draft.baseGeometryVersionId],
        ),
      ])
      if (versions.some((version) => locallyReferencedVersionIds.has(version.id))) {
        throw new Error(
          '현재 Experiment snapshot, staging 또는 Manager 선택이 참조하는 Repository는 삭제할 수 없습니다.',
        )
      }
      await geometryApi.deleteRepository(id)
      await refreshRepositories()
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
    },
    [authenticated, queryClient, refreshRepositories],
  )
  const archiveVersion = useCallback(
    async (id: number) => {
      if (!authenticated) throw new Error('Published Geometry 관리는 로그인 후 사용할 수 있습니다.')
      const result = await geometryApi.archiveVersion(id)
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      return result
    },
    [authenticated, queryClient],
  )
  const updateDescription = useCallback((coordinate: GeometryModuleCoordinate, description: string) => {
    const draft = draftsRef.current[coordinate]
    if (!draft) return
    const next = { ...draftsRef.current, [coordinate]: { ...draft, description } }
    draftsRef.current = next
    setDrafts(next)
  }, [])
  const setBump = useCallback((coordinate: GeometryModuleCoordinate, bump: GeometryDraftVersion['bump']) => {
    const draft = draftsRef.current[coordinate]
    if (!draft) return
    const next = { ...draftsRef.current, [coordinate]: { ...draft, bump } }
    draftsRef.current = next
    setDrafts(next)
  }, [])
  const setVersion = useCallback((coordinate: GeometryModuleCoordinate, version: string) => {
    const draft = draftsRef.current[coordinate]
    if (!draft || draft.baseGeometryVersionId !== null) return
    const next = { ...draftsRef.current, [coordinate]: { ...draft, version } }
    draftsRef.current = next
    setDrafts(next)
  }, [])
  const draftState = useCallback(
    (): Pick<WorkbenchDraft, 'experimentGeometry' | 'geometryManager'> => ({
      geometryManager: {
        draftVersions: draftsRef.current,
        resolvedModules: managerModulesRef.current,
        selection: {
          view: managerView,
          namespace: managerNamespace,
          repository: managerRepository,
          catalogKey: selectedCatalogKey,
          coordinate: selectedCoordinate,
          exportName: selectedExport,
        },
      },
      experimentGeometry: { stagedModules: experimentModulesRef.current },
    }),
    [managerNamespace, managerRepository, managerView, selectedCatalogKey, selectedCoordinate, selectedExport],
  )

  return {
    namespace,
    managerView,
    managerNamespace,
    managerRepository,
    selectedCatalogKey,
    repositories,
    currentSnapshot,
    entrySource,
    entryExports,
    draftVersions: drafts,
    managerModules,
    experimentModules,
    selectedCoordinate,
    selectedExport,
    selectedExports,
    effectiveGraph,
    graphError,
    managerDraftOverlay,
    experimentAvailableOverlay,
    experimentDraftOverlay,
    hasReachableDrafts: reachableLocalCoordinates.size > 0,
    previewScene,
    previewSceneHash,
    previewError,
    previewDiagnostics,
    previewBusy,
    previewStale,
    publishReady:
      Boolean(selectedCoordinate && drafts[selectedCoordinate]) &&
      Boolean(
        selectedCoordinate &&
        drafts[selectedCoordinate] &&
        (!authenticated ||
          drafts[selectedCoordinate].baseGeometryVersionId !== null ||
          drafts[selectedCoordinate].repositoryId !== null),
      ) &&
      previewedInputKey === previewInputKey &&
      !previewError &&
      !previewStale,
    busy,
    publishPlan,
    setPublishPlan,
    setManagerView,
    setManagerNamespace,
    setManagerRepository,
    setSelectedCatalogKey,
    setNamespace,
    refreshRepositories,
    createRepository,
    archiveRepository,
    restoreRepository,
    updateRepositoryDescription,
    deleteRepository,
    archiveVersion,
    createDraft,
    forkOfficial,
    startVersionDraft,
    usePublishedExport,
    publishNewGeometry,
    stageResolved,
    previewPublishedVersion,
    previewSource,
    updateSource,
    updateDraftPackage,
    updateDescription,
    setBump,
    setVersion,
    discardDraft,
    requestPublish,
    confirmPublish,
    prepareExperimentSave,
    setSelectedCoordinate: selectCoordinate,
    setSelectedExport,
    syncSnapshot,
    restore,
    draftState,
  }
}
