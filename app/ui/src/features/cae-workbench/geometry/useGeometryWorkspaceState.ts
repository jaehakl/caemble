import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, dbTables, geometryApi, getListRequest, type GeometryRepositoryRecord } from '@/api'
import {
  CadCompilationError,
  CadDocumentEvaluationError,
  analyzeGeometrySource,
  createEffectiveGeometryGraph,
  createGeometrySnapshot,
  evaluateGeometryModule,
  setGeometryAuthoringGraph,
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

const emptyGeometrySnapshot: GeometrySnapshot = { schemaVersion: 2, entryImports: [], modules: [] }
const localCoordinatePattern =
  /^caemble:geometry\/([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@local$/u
const exactCoordinatePattern =
  /^caemble:geometry\/([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u

function coordinateParts(coordinate: string) {
  const match = exactCoordinatePattern.exec(coordinate) ?? localCoordinatePattern.exec(coordinate)
  if (!match) throw new Error(`Geometry coordinate가 올바르지 않습니다: ${coordinate}`)
  return {
    namespace: match[1],
    repository: match[2],
    packageName: match[3],
    version: match[4] ?? '0.1.0',
  }
}

function localCoordinate(coordinate: string) {
  const parts = coordinateParts(coordinate)
  return `caemble:geometry/${parts.namespace}/${parts.repository}/${parts.packageName}@local` as LocalGeometryCoordinate
}

function rewriteCoordinates(source: string, replacements: Readonly<Record<string, string>>) {
  if (!Object.keys(replacements).some((coordinate) => source.includes(coordinate))) return source
  const analysis = analyzeGeometrySource(source, { allowEmpty: true, allowLocal: true })
  const ranges = new Map<string, { start: number; end: number; coordinate: string }>()
  analysis.imports.forEach((item) => {
    if (!(item.coordinate in replacements)) return
    ranges.set(`${item.specifierStart}:${item.specifierEnd}`, {
      start: item.specifierStart,
      end: item.specifierEnd,
      coordinate: item.coordinate,
    })
  })
  let result = source
  ;[...ranges.values()]
    .sort((left, right) => right.start - left.start)
    .forEach(({ start, end, coordinate }) => {
      result = `${result.slice(0, start)}${replacements[coordinate]}${result.slice(end)}`
    })
  return result
}

function assertReplacementsApplicable(
  replacements: readonly Readonly<{ localCoordinate: string; coordinate: string }>[],
  entrySource: string,
  drafts: Readonly<Record<string, GeometryDraftVersion>>,
) {
  const byCoordinate = Object.fromEntries(replacements.map((item) => [item.localCoordinate, item.coordinate]))
  rewriteCoordinates(entrySource, byCoordinate)
  Object.values(drafts).forEach((draft) => rewriteCoordinates(draft.source, byCoordinate))
}

function geometryPublishRequest(
  drafts: Readonly<Record<string, GeometryDraftVersion>>,
  target: GeometryModuleCoordinate,
) {
  const draft = drafts[target]
  if (!draft) throw new Error('발행할 Draft Version을 찾을 수 없습니다.')
  const selected = new Set<string>()
  const pending: string[] = [target]
  while (pending.length) {
    const coordinate = pending.pop()!
    if (selected.has(coordinate)) continue
    const current = drafts[coordinate]
    if (!current) continue
    selected.add(coordinate)
    analyzeGeometrySource(current.source, { allowLocal: true }).imports.forEach((item) => {
      if (localCoordinatePattern.test(item.coordinate) && drafts[item.coordinate]) pending.push(item.coordinate)
    })
  }
  return {
    targetDraftId: draft.draftId,
    drafts: Object.values(drafts)
      .filter((item) => selected.has(item.coordinate))
      .sort((left, right) => (left.draftId < right.draftId ? -1 : left.draftId > right.draftId ? 1 : 0))
      .map((item) => ({
        draftId: item.draftId,
        baseGeometryVersionId: item.baseGeometryVersionId,
        repositoryId: item.repositoryId,
        repository: item.repository,
        package: item.packageName,
        ...(item.baseGeometryVersionId === null ? { version: item.version } : { bump: item.bump }),
        description: item.description || null,
        source: item.source,
      })),
  }
}

function currentPublishRequest(
  drafts: Readonly<Record<string, GeometryDraftVersion>>,
  request: ReturnType<typeof geometryPublishRequest>,
) {
  const target = Object.values(drafts).find((draft) => draft.draftId === request.targetDraftId)
  if (!target) throw new Error('발행할 Draft Version이 더 이상 존재하지 않습니다.')
  return geometryPublishRequest(drafts, target.coordinate)
}

function mergedModules(...groups: readonly (readonly GeometrySnapshotModule[])[]) {
  const modules = new Map<string, GeometrySnapshotModule>()
  groups.flat().forEach((module) => modules.set(module.coordinate, module))
  return [...modules.values()]
}

function snapshotFromEntrySource(source: string, modules: readonly GeometrySnapshotModule[]) {
  const analysis = analyzeGeometrySource(source, { allowEmpty: true })
  const byCoordinate = new Map<string, GeometrySnapshotModule>(modules.map((module) => [module.coordinate, module]))
  const reachable = new Set<string>()
  const visit = (coordinate: string) => {
    if (reachable.has(coordinate)) return
    const module = byCoordinate.get(coordinate)
    if (!module) throw new Error(`Geometry snapshot module을 찾을 수 없습니다: ${coordinate}`)
    reachable.add(coordinate)
    module.imports.forEach((item) => visit(item.coordinate))
  }
  const entryImports = analysis.imports.map((item) => {
    const module = byCoordinate.get(item.coordinate)
    if (!module) throw new Error(`Geometry import를 resolve하지 못했습니다: ${item.coordinate}`)
    visit(item.coordinate)
    return {
      exportName: item.exportName,
      alias: item.alias,
      geometryVersionId: module.geometryVersionId,
      coordinate: module.coordinate,
      moduleHash: module.moduleHash,
    }
  })
  return createGeometrySnapshot(
    entryImports,
    modules.filter((module) => reachable.has(module.coordinate)),
  )
}

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
}) {
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
  const [managerView, setManagerView] = useState<'official' | 'workspace'>('official')
  const [selectedCatalogKey, setSelectedCatalogKey] = useState<string | null>(null)
  const [selectedCoordinate, setSelectedCoordinateState] = useState<GeometryModuleCoordinate | null>(null)
  const [selectedExport, setSelectedExport] = useState<string | null>(null)
  const [effectiveGraph, setEffectiveGraph] = useState<EffectiveGeometryGraph | null>(null)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [previewScene, setPreviewScene] = useState<CadScene | null>(null)
  const [previewSceneHash, setPreviewSceneHash] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewDiagnostics, setPreviewDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewStale, setPreviewStale] = useState(false)
  const [previewedInputKey, setPreviewedInputKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [publishPlan, setPublishPlan] = useState<{
    request: ReturnType<typeof geometryPublishRequest>
    value: Awaited<ReturnType<typeof geometryApi.planPublish>>
  } | null>(null)

  const draftsRef = useRef(drafts)
  const managerModulesRef = useRef(managerModules)
  const experimentModulesRef = useRef(experimentModules)
  const snapshotRef = useRef(currentSnapshot)
  const entryRef = useRef(entrySource)
  const filesRef = useRef(sourceFiles)
  const initialNamespaceRef = useRef(initialNamespace)
  const authenticatedRef = useRef(authenticated)
  draftsRef.current = drafts
  managerModulesRef.current = managerModules
  experimentModulesRef.current = experimentModules
  snapshotRef.current = currentSnapshot
  entryRef.current = entrySource
  filesRef.current = sourceFiles

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

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      void createEffectiveGeometryGraph(currentSnapshot, experimentAvailableOverlay, entrySource)
        .then((graph) => {
          if (cancelled) return
          setEffectiveGraph(graph)
          setGeometryAuthoringGraph(graph)
          setGraphError(null)
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setGraphError(cause instanceof Error ? cause.message : String(cause))
          }
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [currentSnapshot, entrySource, experimentAvailableOverlay])

  const experimentDraftOverlay = useMemo<GeometryDraftOverlay>(() => {
    const reachable = new Set(effectiveGraph?.modules.map((module) => module.coordinate) ?? [])
    return Object.freeze(
      Object.fromEntries(
        Object.entries(experimentAvailableOverlay).filter(([coordinate]) =>
          reachable.has(coordinate as GeometryModuleCoordinate),
        ),
      ),
    )
  }, [effectiveGraph?.modules, experimentAvailableOverlay])

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
  const selectedAnalysis = useMemo(() => {
    if (!selectedSource) return { exports: [] as readonly string[], error: null as string | null }
    try {
      const exports = analyzeGeometrySource(selectedSource, { allowLocal: true }).exports.map((item) => item.name)
      return { exports, error: exports.length ? null : 'Geometry source에 named export가 없습니다.' }
    } catch (cause) {
      return { exports: [] as readonly string[], error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [selectedSource])
  const selectedExports = selectedAnalysis.exports
  useEffect(() => {
    if (!selectedExports.length) setSelectedExport(null)
    else if (!selectedExport || !selectedExports.includes(selectedExport)) setSelectedExport(selectedExports[0])
  }, [selectedExport, selectedExports])
  useEffect(() => {
    if (!selectedCoordinate || !selectedAnalysis.error) return
    setPreviewBusy(false)
    setPreviewError(selectedAnalysis.error)
    setPreviewDiagnostics([])
    setPreviewStale(true)
  }, [selectedAnalysis.error, selectedCoordinate])

  const previewInputKey = useMemo(
    () =>
      JSON.stringify({
        modules: Object.entries(managerDraftOverlay).sort(([left], [right]) => left.localeCompare(right)),
        selectedCoordinate,
        selectedExport,
      }),
    [managerDraftOverlay, selectedCoordinate, selectedExport],
  )

  useEffect(() => {
    if (!selectedCoordinate || !selectedExport || !selectedExports.includes(selectedExport)) return
    const abort = new AbortController()
    setPreviewBusy(true)
    setPreviewStale(true)
    void evaluateGeometryModule(emptyGeometrySnapshot, selectedCoordinate, selectedExport, {
      geometryDrafts: managerDraftOverlay,
      signal: abort.signal,
      timeoutMs: 10000,
    })
      .then((result) => {
        if (abort.signal.aborted) return
        setPreviewScene(result.scene)
        setPreviewSceneHash(result.sourceHash)
        setPreviewError(null)
        setPreviewDiagnostics([])
        setPreviewedInputKey(previewInputKey)
        setPreviewStale(false)
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return
        setPreviewError(cause instanceof Error ? cause.message : String(cause))
        setPreviewDiagnostics(
          cause instanceof CadCompilationError || cause instanceof CadDocumentEvaluationError ? cause.diagnostics : [],
        )
        setPreviewStale(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setPreviewBusy(false)
      })
    return () => abort.abort()
  }, [managerDraftOverlay, previewInputKey, selectedCoordinate, selectedExport, selectedExports])

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
    setRepositories(response.items)
    return response.items
  }, [authenticated])

  useEffect(() => {
    void refreshRepositories().catch(() => undefined)
  }, [refreshRepositories])

  const applyNamespace = useCallback((nextNamespace: string) => {
    const replacements: Record<string, string> = {}
    Object.values(draftsRef.current).forEach((draft) => {
      if (draft.baseGeometryVersionId !== null || draft.repositoryId !== null) return
      const parts = coordinateParts(draft.coordinate)
      if (parts.namespace !== nextNamespace) {
        replacements[draft.coordinate] =
          `caemble:geometry/${nextNamespace}/${draft.repository}/${draft.packageName}@local`
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
        return [coordinate, { ...draft, coordinate, source: rewriteCoordinates(draft.source, replacements) }]
      }),
    ) as Readonly<Record<string, GeometryDraftVersion>>
    setNamespaceState(nextNamespace)
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    setSelectedCoordinateState((current) =>
      current ? ((replacements[current] ?? current) as GeometryModuleCoordinate) : current,
    )
  }, [])

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
  }, [applyNamespace, authenticated, initialNamespace])

  const updateSource = useCallback(
    (source: string) => {
      if (!selectedCoordinate) return
      if (localCoordinatePattern.test(selectedCoordinate)) {
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
    }: {
      repository: string
      packageName: string
      source?: string
      description?: string
      repositoryId?: number | null
    }) => {
      if (!namespace) throw new Error('기본 Geometry namespace를 먼저 설정하세요.')
      const repositoryRecord = repositories.find((item) => item.id === repositoryId)
      const ownerNamespace = repositoryRecord?.namespace ?? namespace
      const repositorySlug = repositoryRecord?.slug ?? repository
      const coordinate =
        `caemble:geometry/${ownerNamespace}/${repositorySlug}/${packageName}@local` as LocalGeometryCoordinate
      if (draftsRef.current[coordinate]) throw new Error('이 Package의 Draft Version이 이미 있습니다.')
      const draft: GeometryDraftVersion = {
        draftId: crypto.randomUUID(),
        coordinate,
        source: source ?? draftGeometrySource(packageName),
        description,
        baseGeometryVersionId: null,
        originCatalogKey: null,
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
      setSelectedCoordinateState(coordinate)
      return coordinate
    },
    [namespace, repositories],
  )

  const updateCatalogSource = useCallback(
    ({ key, source, description }: { key: string; source: string; description: string }) => {
      if (!namespace) throw new Error('기본 Geometry namespace를 먼저 설정하세요.')
      const coordinate = `caemble:geometry/${namespace}/catalog/${key}@local` as LocalGeometryCoordinate
      const existing = draftsRef.current[coordinate]
      const draft: GeometryDraftVersion = existing
        ? { ...existing, source }
        : {
            draftId: crypto.randomUUID(),
            coordinate,
            source,
            description,
            baseGeometryVersionId: null,
            originCatalogKey: key,
            repository: 'catalog',
            packageName: key,
            repositoryId: null,
            packageId: null,
            version: '0.1.0',
            bump: 'patch',
            standalonePreview: true,
          }
      const next = { ...draftsRef.current, [coordinate]: draft }
      draftsRef.current = next
      setDrafts(next)
      setTransientPreview(null)
      setSelectedCoordinateState(coordinate)
      return { coordinate, created: !existing }
    },
    [namespace],
  )

  const stageResolved = useCallback(
    async (versionId: number, target: 'manager' | 'experiment' = 'manager') => {
      if (!authenticated) throw new Error('Published Geometry 조회는 로그인 후 사용할 수 있습니다.')
      const resolved = await geometryApi.resolveVersion(versionId)
      if (target === 'manager') {
        const next = mergedModules(managerModulesRef.current, resolved.modules)
        managerModulesRef.current = next
        setManagerModules(next)
      } else {
        const next = mergedModules(experimentModulesRef.current, resolved.modules)
        experimentModulesRef.current = next
        setExperimentModules(next)
      }
      return resolved
    },
    [authenticated],
  )

  const previewPublishedVersion = useCallback(
    async (versionId: number) => {
      const resolved = await stageResolved(versionId, 'manager')
      setTransientPreview(null)
      setSelectedCoordinateState(resolved.root.coordinate)
      return resolved
    },
    [stageResolved],
  )

  const previewSource = useCallback((source: string) => {
    analyzeGeometrySource(source, { allowLocal: true })
    const coordinate = `caemble:geometry/local/preview/${crypto.randomUUID()}@local` as LocalGeometryCoordinate
    setTransientPreview({ coordinate, source })
    setSelectedCoordinateState(coordinate)
    return coordinate
  }, [])

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
      const localImport = analysis.imports.find((item) => localCoordinatePattern.test(item.coordinate))
      if (localImport) {
        throw new Error(
          `발행 전 Draft dependency를 먼저 발행하세요: ${coordinateParts(localImport.coordinate).packageName}`,
        )
      }
      const repositoryRecord = repositories.find((item) => item.id === repositoryId)
      if (repositoryId !== null && !repositoryRecord) {
        throw new Error('선택한 Geometry Repository를 더 이상 사용할 수 없습니다.')
      }
      const ownerNamespace = repositoryRecord?.namespace ?? namespace
      const repositorySlug = repositoryRecord?.slug ?? repository
      const coordinate =
        `caemble:geometry/${ownerNamespace}/${repositorySlug}/${packageName}@local` as LocalGeometryCoordinate
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

  const updatePublishedSource = useCallback(
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
      const parts = coordinateParts(coordinate)
      const local = localCoordinate(coordinate)
      const existing = draftsRef.current[local]
      if (existing && existing.baseGeometryVersionId !== versionId) {
        throw new Error('이 Package의 Draft Version을 선택하거나 폐기한 뒤 다른 Version을 편집하세요.')
      }
      const draft: GeometryDraftVersion = existing
        ? { ...existing, source }
        : {
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
      setSelectedCoordinateState(local)
      return { coordinate: local, created: !existing }
    },
    [],
  )

  const usePublishedExport = useCallback(
    async (versionId: number, exportName: string, alias = exportName) => {
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
    return mergedModules(...resolved.map((item) => item.modules))
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
          .map((draft) => [draft.coordinate, { ...draft, source: rewriteCoordinates(draft.source, replacements) }]),
      ) as Readonly<Record<string, GeometryDraftVersion>>
      const publishedModules = await resolvePublishedModules(result.published.map((item) => item.id))
      const allModules = mergedModules(managerModulesRef.current, publishedModules)
      draftsRef.current = nextDrafts
      managerModulesRef.current = allModules
      setDrafts(nextDrafts)
      setManagerModules(allModules)
      const selectedReplacement = result.replacements.find((item) => item.localCoordinate === selectedCoordinate)
      if (selectedReplacement) setSelectedCoordinateState(selectedReplacement.coordinate)
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      return { request }
    },
    [queryClient, resolvePublishedModules, selectedCoordinate],
  )

  const requestPublish = useCallback(
    async (coordinate: GeometryModuleCoordinate) => {
      if (!authenticated) throw new Error('Geometry 저장은 로그인 후 사용할 수 있습니다.')
      const request = geometryPublishRequest(draftsRef.current, coordinate)
      setBusy(true)
      try {
        const value = await geometryApi.planPublish(request)
        assertReplacementsApplicable(value.replacements, 'export {}\n', draftsRef.current)
        setPublishPlan({ request, value })
        return value
      } catch (cause) {
        const parsed =
          cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
        if (parsed?.success && parsed.data.revisedPlan) {
          assertReplacementsApplicable(parsed.data.revisedPlan.replacements, 'export {}\n', draftsRef.current)
          setPublishPlan({ request, value: parsed.data.revisedPlan })
          return parsed.data.revisedPlan
        }
        throw cause
      } finally {
        setBusy(false)
      }
    },
    [authenticated],
  )

  const confirmPublish = useCallback(async () => {
    if (!authenticated) throw new Error('Geometry 저장은 로그인 후 사용할 수 있습니다.')
    if (!publishPlan) return null
    setBusy(true)
    try {
      const currentRequest = currentPublishRequest(draftsRef.current, publishPlan.request)
      if (JSON.stringify(currentRequest) !== JSON.stringify(publishPlan.request)) {
        const value = await geometryApi.planPublish(currentRequest)
        assertReplacementsApplicable(value.replacements, 'export {}\n', draftsRef.current)
        setPublishPlan({ request: currentRequest, value })
        toast.info('Geometry source 변경을 반영해 발행 계획을 갱신했습니다. 내용을 확인해 주세요.')
        return null
      }
      assertReplacementsApplicable(publishPlan.value.replacements, 'export {}\n', draftsRef.current)
      const result = await geometryApi.publish({ ...publishPlan.request, planHash: publishPlan.value.planHash })
      await applyPublished(publishPlan.request, publishPlan.value, result)
      setPublishPlan(null)
      toast.success(`${result.published.length}개 Geometry Version을 발행했습니다.`)
      return result
    } catch (cause) {
      const parsed =
        cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
      if (!parsed?.success || !parsed.data.revisedPlan) throw cause
      const currentRequest = currentPublishRequest(draftsRef.current, publishPlan.request)
      if (JSON.stringify(currentRequest) !== JSON.stringify(publishPlan.request)) {
        const value = await geometryApi.planPublish(currentRequest)
        assertReplacementsApplicable(value.replacements, 'export {}\n', draftsRef.current)
        setPublishPlan({ request: currentRequest, value })
        toast.info('Geometry source 변경을 반영해 발행 계획을 갱신했습니다. 내용을 확인해 주세요.')
        return null
      }
      assertReplacementsApplicable(parsed.data.revisedPlan.replacements, 'export {}\n', draftsRef.current)
      setPublishPlan({ request: publishPlan.request, value: parsed.data.revisedPlan })
      toast.info('다른 변경을 반영해 발행 계획을 갱신했습니다. 내용을 확인한 뒤 다시 발행하세요.')
      return null
    } finally {
      setBusy(false)
    }
  }, [applyPublished, authenticated, publishPlan])

  const prepareExperimentSave = useCallback(async () => {
    if (!authenticated) throw new Error('Experiment 저장은 로그인 후 사용할 수 있습니다.')
    setBusy(true)
    try {
      const local = analyzeGeometrySource(entryRef.current, { allowEmpty: true, allowLocal: true }).imports.find(
        (item) => localCoordinatePattern.test(item.coordinate),
      )
      if (local) {
        throw new Error(
          `Experiment geometry.tsx가 발행 전 Draft Version을 참조합니다. Geometry 탭에서 ${coordinateParts(local.coordinate).packageName}을 먼저 발행하고 exact Version으로 바꾸세요.`,
        )
      }
      const nextSnapshot = snapshotFromEntrySource(
        entryRef.current,
        mergedModules(snapshotRef.current.modules, experimentModulesRef.current),
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
      const nextCoordinate =
        `caemble:geometry/${ownerNamespace}/${repositorySlug}/${packageName}@local` as LocalGeometryCoordinate
      coordinateParts(nextCoordinate)
      if (nextCoordinate !== coordinate && draftsRef.current[nextCoordinate]) {
        throw new Error('이 Package의 Draft Version이 이미 있습니다.')
      }
      const nextDrafts = Object.fromEntries(
        Object.values(draftsRef.current).map((item) => {
          const source = item.source.split(coordinate).join(nextCoordinate)
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
      setSelectedCoordinateState(nextCoordinate)
      return nextCoordinate
    },
    [namespace, repositories],
  )

  const discardDraft = useCallback((coordinate: GeometryModuleCoordinate) => {
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
    setSelectedCoordinateState(null)
    setSelectedExport(null)
  }, [])

  const syncSnapshot = useCallback((value: GeometrySnapshot | null) => {
    const next = value ?? emptyGeometrySnapshot
    snapshotRef.current = next
    experimentModulesRef.current = []
    setCurrentSnapshot(next)
    setExperimentModules([])
    setEffectiveGraph(null)
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
          const parts = coordinateParts(draft.coordinate)
          if (parts.namespace !== namespace) {
            replacements[draft.coordinate] =
              `caemble:geometry/${namespace}/${draft.repository}/${draft.packageName}@local`
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
          nextSource = rewriteCoordinates(source, replacements)
          nextDrafts = Object.fromEntries(
            Object.values(manager.draftVersions).map((draft) => {
              const coordinate = (replacements[draft.coordinate] ?? draft.coordinate) as LocalGeometryCoordinate
              return [coordinate, { ...draft, coordinate, source: rewriteCoordinates(draft.source, replacements) }]
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
      setSelectedCoordinateState(
        nextDrafts !== manager.draftVersions && manager.selection.coordinate
          ? ((replacements[manager.selection.coordinate] ?? manager.selection.coordinate) as GeometryModuleCoordinate)
          : manager.selection.coordinate,
      )
      setSelectedExport(manager.selection.exportName)
      setManagerView(manager.selection.view)
      setSelectedCatalogKey(manager.selection.catalogKey)
      setPreviewScene(null)
      setPreviewSceneHash(null)
      return nextSource
    },
    [namespace],
  )

  const reachableLocalCoordinates = useMemo(() => {
    const reachable = new Set<string>()
    const pending: string[] = []
    try {
      analyzeGeometrySource(entrySource, { allowEmpty: true, allowLocal: true }).imports.forEach((item) => {
        if (localCoordinatePattern.test(item.coordinate)) pending.push(item.coordinate)
      })
      while (pending.length) {
        const coordinate = pending.pop()!
        if (reachable.has(coordinate)) continue
        reachable.add(coordinate)
        const draft = drafts[coordinate]
        if (!draft) continue
        analyzeGeometrySource(draft.source, { allowLocal: true }).imports.forEach((item) => {
          if (localCoordinatePattern.test(item.coordinate)) pending.push(item.coordinate)
        })
      }
    } catch {
      Object.keys(drafts).forEach((coordinate) => {
        if (entrySource.includes(coordinate) || reachable.has(coordinate)) reachable.add(coordinate)
      })
    }
    return reachable
  }, [drafts, entrySource])

  return {
    namespace,
    managerView,
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
      previewedInputKey === previewInputKey &&
      !previewError &&
      !previewStale,
    busy,
    publishPlan,
    setPublishPlan,
    setManagerView,
    setSelectedCatalogKey,
    setNamespace,
    refreshRepositories,
    createRepository: async (slug: string, description?: string | null) => {
      if (!authenticated) throw new Error('Geometry Repository 관리는 로그인 후 사용할 수 있습니다.')
      const result = await geometryApi.createRepository({ slug, description })
      await refreshRepositories()
      return result
    },
    archiveRepository: async (id: number) => {
      if (!authenticated) throw new Error('Geometry Repository 관리는 로그인 후 사용할 수 있습니다.')
      const result = await geometryApi.archiveRepository(id)
      await refreshRepositories()
      return result
    },
    archiveVersion: async (id: number) => {
      if (!authenticated) throw new Error('Published Geometry 관리는 로그인 후 사용할 수 있습니다.')
      const result = await geometryApi.archiveVersion(id)
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      return result
    },
    createDraft,
    updateCatalogSource,
    updatePublishedSource,
    usePublishedExport,
    publishNewGeometry,
    stageResolved,
    previewPublishedVersion,
    previewSource,
    updateSource,
    updateDraftPackage,
    updateDescription: (coordinate: GeometryModuleCoordinate, description: string) => {
      const draft = draftsRef.current[coordinate]
      if (!draft) return
      const next = { ...draftsRef.current, [coordinate]: { ...draft, description } }
      draftsRef.current = next
      setDrafts(next)
    },
    setBump: (coordinate: GeometryModuleCoordinate, bump: GeometryDraftVersion['bump']) => {
      const draft = draftsRef.current[coordinate]
      if (!draft) return
      const next = { ...draftsRef.current, [coordinate]: { ...draft, bump } }
      draftsRef.current = next
      setDrafts(next)
    },
    setVersion: (coordinate: GeometryModuleCoordinate, version: string) => {
      const draft = draftsRef.current[coordinate]
      if (!draft || draft.baseGeometryVersionId !== null) return
      const next = { ...draftsRef.current, [coordinate]: { ...draft, version } }
      draftsRef.current = next
      setDrafts(next)
    },
    discardDraft,
    requestPublish,
    confirmPublish,
    prepareExperimentSave,
    setSelectedCoordinate: (coordinate: GeometryModuleCoordinate | null) => setSelectedCoordinateState(coordinate),
    setSelectedExport,
    syncSnapshot,
    restore,
    draftState: () => ({
      geometryManager: {
        draftVersions: draftsRef.current,
        resolvedModules: managerModulesRef.current,
        selection: {
          view: managerView,
          catalogKey: selectedCatalogKey,
          coordinate: selectedCoordinate,
          exportName: selectedExport,
        },
      } satisfies WorkbenchDraft['geometryManager'],
      experimentGeometry: {
        stagedModules: experimentModulesRef.current,
      } satisfies WorkbenchDraft['experimentGeometry'],
    }),
  }
}

export type GeometryManagerState = ReturnType<typeof useGeometryManagerState>
