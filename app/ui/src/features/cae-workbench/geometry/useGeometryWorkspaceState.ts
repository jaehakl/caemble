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
import type { GeometryLocalDraft, WorkbenchDraft } from '../types'

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

function pascalCase(value: string) {
  const result = value
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('')
  return /^[A-Z][A-Za-z0-9_]*$/u.test(result) ? result : 'NewGeometry'
}

function defaultGeometrySource(packageName: string) {
  const name = pascalCase(packageName)
  return `import { type Geometry, type Vec3 } from '@caemble/core'

export const ${name}: Geometry<{
  notchPosition: Vec3
  notchSize: Vec3
  size: Vec3
}> = ({
  notchPosition = [0, 4, 2.5],
  notchSize = [30, 5, 6],
  size = [100, 12, 10],
}) => (
  <subtract>
    <box size={size} />
    <box pos={notchPosition} size={notchSize} />
  </subtract>
)
`
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
  drafts: Readonly<Record<string, GeometryLocalDraft>>,
) {
  const byCoordinate = Object.fromEntries(replacements.map((item) => [item.localCoordinate, item.coordinate]))
  rewriteCoordinates(entrySource, byCoordinate)
  Object.values(drafts).forEach((draft) => rewriteCoordinates(draft.source, byCoordinate))
}

function rewriteOccurrence(source: string, alias: string, coordinate: string, replacement: string) {
  const analysis = analyzeGeometrySource(source, { allowEmpty: true, allowLocal: true })
  const imported = analysis.imports.find((item) => item.alias === alias && item.coordinate === coordinate)
  if (!imported) throw new Error(`${alias} import occurrence를 source에서 찾을 수 없습니다.`)
  return `${source.slice(0, imported.specifierStart)}${replacement}${source.slice(imported.specifierEnd)}`
}

function geometryPublishRequest(
  drafts: Readonly<Record<string, GeometryLocalDraft>>,
  target: GeometryModuleCoordinate,
) {
  const draft = drafts[target]
  if (!draft) throw new Error('발행할 Geometry draft를 찾을 수 없습니다.')
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
  drafts: Readonly<Record<string, GeometryLocalDraft>>,
  request: ReturnType<typeof geometryPublishRequest>,
) {
  const target = Object.values(drafts).find((draft) => draft.draftId === request.targetDraftId)
  if (!target) throw new Error('발행할 Geometry draft가 더 이상 존재하지 않습니다.')
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

type OccurrenceEdge = Readonly<{
  parent: 'geometry.tsx' | GeometryModuleCoordinate
  alias: string
  coordinate: GeometryModuleCoordinate
}>

export function useGeometryWorkspaceState({
  authenticated = true,
  initialNamespace,
  onExperimentChange,
  snapshot,
  sourceFiles,
}: {
  authenticated?: boolean
  initialNamespace?: string | null
  onExperimentChange: (snapshot: GeometrySnapshot, files?: Readonly<Record<string, string>>) => void
  snapshot: GeometrySnapshot | null
  sourceFiles: Readonly<Record<string, string>>
}) {
  const queryClient = useQueryClient()
  const [namespace, setNamespaceState] = useState(initialNamespace ?? null)
  const [repositories, setRepositories] = useState<readonly GeometryRepositoryRecord[]>([])
  const [currentSnapshot, setCurrentSnapshot] = useState(snapshot ?? emptyGeometrySnapshot)
  const [entrySource, setEntrySource] = useState(sourceFiles['geometry.tsx'] ?? 'export {}\n')
  const [drafts, setDrafts] = useState<Readonly<Record<string, GeometryLocalDraft>>>({})
  const [stagedModules, setStagedModules] = useState<readonly GeometrySnapshotModule[]>([])
  const [selectedCoordinate, setSelectedCoordinateState] = useState<GeometryModuleCoordinate | 'geometry.tsx' | null>(
    'geometry.tsx',
  )
  const [selectedExport, setSelectedExport] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<readonly OccurrenceEdge[]>([])
  const [expandedPaths, setExpandedPaths] = useState<readonly string[]>(['geometry.tsx'])
  const [effectiveGraph, setEffectiveGraph] = useState<EffectiveGeometryGraph | null>(null)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [previewScene, setPreviewScene] = useState<CadScene | null>(null)
  const [previewSceneHash, setPreviewSceneHash] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewDiagnostics, setPreviewDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewStale, setPreviewStale] = useState(false)
  const [previewedInput, setPreviewedInput] = useState<object | null>(null)
  const [busy, setBusy] = useState(false)
  const [publishPlan, setPublishPlan] = useState<{
    request: ReturnType<typeof geometryPublishRequest>
    value: Awaited<ReturnType<typeof geometryApi.planPublish>>
  } | null>(null)

  const draftsRef = useRef(drafts)
  const stagedRef = useRef(stagedModules)
  const snapshotRef = useRef(currentSnapshot)
  const entryRef = useRef(entrySource)
  const filesRef = useRef(sourceFiles)
  const initialNamespaceRef = useRef(initialNamespace)
  const authenticatedRef = useRef(authenticated)
  draftsRef.current = drafts
  stagedRef.current = stagedModules
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

  const draftOverlay = useMemo<GeometryDraftOverlay>(
    () =>
      Object.freeze(
        Object.fromEntries([
          ...stagedModules.map((module) => [module.coordinate, { source: module.source }] as const),
          ...Object.values(drafts).map((draft) => [draft.coordinate, { source: draft.source }] as const),
        ]),
      ),
    [drafts, stagedModules],
  )

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      void createEffectiveGeometryGraph(currentSnapshot, draftOverlay, entrySource)
        .then((graph) => {
          if (cancelled) return
          setEffectiveGraph(graph)
          setGeometryAuthoringGraph(graph)
          setGraphError(null)
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setGraphError(cause instanceof Error ? cause.message : String(cause))
            setPreviewStale(true)
          }
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [currentSnapshot, draftOverlay, entrySource])

  const selectedModule = useMemo(() => {
    if (!selectedCoordinate || selectedCoordinate === 'geometry.tsx') return null
    return effectiveGraph?.modules.find((item) => item.coordinate === selectedCoordinate) ?? null
  }, [effectiveGraph, selectedCoordinate])
  const entryExports = useMemo(() => {
    try {
      return analyzeGeometrySource(entrySource, { allowEmpty: true, allowLocal: true }).exports.map((item) => item.name)
    } catch {
      return []
    }
  }, [entrySource])
  const selectedExports = useMemo(() => {
    const source =
      selectedCoordinate === 'geometry.tsx'
        ? entrySource
        : selectedCoordinate
          ? (drafts[selectedCoordinate]?.source ?? selectedModule?.source)
          : undefined
    if (!source) return []
    try {
      return analyzeGeometrySource(source, {
        allowEmpty: selectedCoordinate === 'geometry.tsx',
        allowLocal: true,
      }).exports.map((item) => item.name)
    } catch {
      return []
    }
  }, [drafts, entrySource, selectedCoordinate, selectedModule?.source])
  useEffect(() => {
    if (!selectedExports.length) setSelectedExport(null)
    else if (!selectedExport || !selectedExports.includes(selectedExport)) setSelectedExport(selectedExports[0])
  }, [selectedExport, selectedExports])

  const previewInput = useMemo(
    () => ({ currentSnapshot, draftOverlay, effectiveGraph, entrySource, selectedCoordinate, selectedExport }),
    [currentSnapshot, draftOverlay, effectiveGraph, entrySource, selectedCoordinate, selectedExport],
  )

  useEffect(() => {
    if (!selectedCoordinate || selectedCoordinate === 'geometry.tsx' || !selectedExport || !effectiveGraph) return
    const abort = new AbortController()
    setPreviewBusy(true)
    setPreviewStale(true)
    void evaluateGeometryModule(currentSnapshot, selectedCoordinate, selectedExport, {
      geometryDrafts: draftOverlay,
      signal: abort.signal,
      timeoutMs: 10000,
    })
      .then((result) => {
        if (abort.signal.aborted) return
        setPreviewScene(result.scene)
        setPreviewSceneHash(result.sourceHash)
        setPreviewError(null)
        setPreviewDiagnostics([])
        setPreviewedInput(previewInput)
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
  }, [currentSnapshot, draftOverlay, effectiveGraph, previewInput, selectedCoordinate, selectedExport])

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

  const applyExperimentSource = useCallback(
    (nextSource: string, nextSnapshot = snapshotRef.current) => {
      const files = { ...filesRef.current, 'geometry.tsx': nextSource }
      entryRef.current = nextSource
      snapshotRef.current = nextSnapshot
      filesRef.current = files
      setEntrySource(nextSource)
      setCurrentSnapshot(nextSnapshot)
      onExperimentChange(nextSnapshot, files)
    },
    [onExperimentChange],
  )

  const applyNamespace = useCallback(
    (nextNamespace: string) => {
      const replacements: Record<string, string> = {}
      Object.values(draftsRef.current).forEach((draft) => {
        if (draft.baseGeometryVersionId !== null || draft.repositoryId !== null) return
        const parts = coordinateParts(draft.coordinate)
        if (parts.namespace !== nextNamespace) {
          replacements[draft.coordinate] =
            `caemble:geometry/${nextNamespace}/${draft.repository}/${draft.packageName}@local`
        }
      })
      const nextEntry = rewriteCoordinates(entryRef.current, replacements)
      const targetCoordinates = Object.values(draftsRef.current).map(
        (draft) => replacements[draft.coordinate] ?? draft.coordinate,
      )
      if (targetCoordinates.length !== new Set(targetCoordinates).size) {
        throw new Error('namespace 변경 후 local Geometry coordinate가 충돌합니다.')
      }
      const nextDrafts = Object.fromEntries(
        Object.values(draftsRef.current).map((draft) => {
          const coordinate = (replacements[draft.coordinate] ?? draft.coordinate) as LocalGeometryCoordinate
          return [coordinate, { ...draft, coordinate, source: rewriteCoordinates(draft.source, replacements) }]
        }),
      ) as Readonly<Record<string, GeometryLocalDraft>>
      setNamespaceState(nextNamespace)
      draftsRef.current = nextDrafts
      setDrafts(nextDrafts)
      setSelectedCoordinateState((current) =>
        current && current !== 'geometry.tsx'
          ? ((replacements[current] ?? current) as GeometryModuleCoordinate)
          : current,
      )
      setSelectedPath((current) =>
        current.map((edge) => ({
          ...edge,
          parent:
            edge.parent === 'geometry.tsx'
              ? edge.parent
              : ((replacements[edge.parent] ?? edge.parent) as GeometryModuleCoordinate),
          coordinate: (replacements[edge.coordinate] ?? edge.coordinate) as GeometryModuleCoordinate,
        })),
      )
      setExpandedPaths((current) =>
        current.map((path) =>
          Object.entries(replacements).reduce(
            (rewritten, [previous, next]) => rewritten.split(previous).join(next),
            path,
          ),
        ),
      )
      if (Object.keys(replacements).length > 0) applyExperimentSource(nextEntry)
    },
    [applyExperimentSource],
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
        `local Geometry를 로그인 namespace로 조정하지 못했습니다. 충돌하는 draft를 정리한 뒤 다시 적용하세요. ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }, [applyNamespace, authenticated, initialNamespace])

  const moduleByCoordinate = useCallback(
    (coordinate: string) =>
      [...snapshotRef.current.modules, ...stagedRef.current].find((module) => module.coordinate === coordinate),
    [],
  )

  const pathTo = useCallback(
    (coordinate: GeometryModuleCoordinate) => {
      if (selectedPath[selectedPath.length - 1]?.coordinate === coordinate) return selectedPath
      if (!effectiveGraph) return []
      const visit = (
        current: GeometryModuleCoordinate,
        path: readonly OccurrenceEdge[],
        visited: ReadonlySet<string>,
      ): readonly OccurrenceEdge[] | null => {
        if (current === coordinate) return path
        if (visited.has(current)) return null
        const module = effectiveGraph.modules.find((item) => item.coordinate === current)
        for (const imported of module?.imports ?? []) {
          const found = visit(
            imported.coordinate,
            [...path, { parent: current, alias: imported.alias, coordinate: imported.coordinate }],
            new Set([...visited, current]),
          )
          if (found) return found
        }
        return null
      }
      for (const imported of effectiveGraph.entryImports) {
        const first = { parent: 'geometry.tsx' as const, alias: imported.alias, coordinate: imported.coordinate }
        const found = visit(imported.coordinate, [first], new Set())
        if (found) return found
      }
      return []
    },
    [effectiveGraph, selectedPath],
  )

  const promotePath = useCallback(
    (coordinate: GeometryModuleCoordinate, nextSource: string) => {
      const path = pathTo(coordinate)
      const nextDrafts = { ...draftsRef.current }
      let nextEntry = entryRef.current
      for (const edge of path) {
        if (localCoordinatePattern.test(edge.coordinate)) continue
        const module = moduleByCoordinate(edge.coordinate)
        if (!module) throw new Error(`편집할 Geometry module을 찾을 수 없습니다: ${edge.coordinate}`)
        const local = localCoordinate(edge.coordinate)
        const parts = coordinateParts(edge.coordinate)
        nextDrafts[local] ??= {
          draftId: crypto.randomUUID(),
          coordinate: local,
          source: module.source,
          description: module.description ?? '',
          baseGeometryVersionId: module.geometryVersionId,
          repository: parts.repository,
          packageName: parts.packageName,
          repositoryId: null,
          packageId: null,
          version: parts.version,
          bump: 'patch',
          standalonePreview: false,
        }
        if (edge.parent === 'geometry.tsx') {
          nextEntry = rewriteOccurrence(nextEntry, edge.alias, edge.coordinate, local)
        } else {
          const parentLocal = localCoordinate(edge.parent)
          const parent = nextDrafts[parentLocal]
          if (!parent) throw new Error(`상위 Geometry draft를 만들지 못했습니다: ${edge.parent}`)
          nextDrafts[parentLocal] = {
            ...parent,
            source: rewriteOccurrence(parent.source, edge.alias, edge.coordinate, local),
          }
        }
      }
      const selectedLocal = localCoordinate(coordinate)
      const selected = nextDrafts[selectedLocal]
      if (!selected) throw new Error('선택한 Geometry를 local draft로 승격하지 못했습니다.')
      nextDrafts[selectedLocal] = { ...selected, source: nextSource }
      draftsRef.current = nextDrafts
      setDrafts(nextDrafts)
      setSelectedCoordinateState(selectedLocal)
      applyExperimentSource(nextEntry)
    },
    [applyExperimentSource, moduleByCoordinate, pathTo],
  )

  const updateSource = useCallback(
    (source: string) => {
      if (selectedCoordinate === 'geometry.tsx') {
        applyExperimentSource(source)
        return
      }
      if (!selectedCoordinate) return
      if (localCoordinatePattern.test(selectedCoordinate)) {
        const draft = draftsRef.current[selectedCoordinate]
        if (!draft) return
        const next = { ...draftsRef.current, [selectedCoordinate]: { ...draft, source } }
        draftsRef.current = next
        setDrafts(next)
        return
      }
      promotePath(selectedCoordinate, source)
    },
    [applyExperimentSource, promotePath, selectedCoordinate],
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
      if (draftsRef.current[coordinate]) throw new Error('이 Package의 local draft가 이미 열려 있습니다.')
      const draft: GeometryLocalDraft = {
        draftId: crypto.randomUUID(),
        coordinate,
        source: source ?? defaultGeometrySource(packageName),
        description,
        baseGeometryVersionId: null,
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
      setSelectedCoordinateState(coordinate)
      setSelectedPath([])
      return coordinate
    },
    [namespace, repositories],
  )

  const stageResolved = useCallback(
    async (versionId: number) => {
      if (!authenticated) throw new Error('Published Geometry 조회는 로그인 후 사용할 수 있습니다.')
      const resolved = await geometryApi.resolveVersion(versionId)
      const next = mergedModules(stagedRef.current, resolved.modules)
      stagedRef.current = next
      setStagedModules(next)
      return resolved
    },
    [authenticated],
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
      const localImport = analysis.imports.find((item) => localCoordinatePattern.test(item.coordinate))
      if (localImport) {
        throw new Error(`@local dependency를 먼저 발행하세요: ${localImport.coordinate}`)
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
        throw new Error('같은 Package의 local draft가 열려 있습니다. 먼저 발행하거나 폐기하세요.')
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

  const editPublishedVersion = useCallback(
    async (versionId: number, repositoryId?: number, packageId?: number) => {
      const resolved = await stageResolved(versionId)
      const coordinate = resolved.root.coordinate
      const existingPath = effectiveGraph?.modules.some((item) => item.coordinate === coordinate)
      if (existingPath) {
        const module = resolved.modules.find((item) => item.coordinate === coordinate)!
        promotePath(coordinate, module.source)
        return localCoordinate(coordinate)
      }
      const module = resolved.modules.find((item) => item.coordinate === coordinate)!
      const parts = coordinateParts(coordinate)
      const local = localCoordinate(coordinate)
      const draft: GeometryLocalDraft = {
        draftId: crypto.randomUUID(),
        coordinate: local,
        source: module.source,
        description: module.description ?? '',
        baseGeometryVersionId: versionId,
        repository: parts.repository,
        packageName: parts.packageName,
        repositoryId: repositoryId ?? null,
        packageId: packageId ?? null,
        version: parts.version,
        bump: 'patch',
        standalonePreview: true,
      }
      const next = { ...draftsRef.current, [local]: draft }
      draftsRef.current = next
      setDrafts(next)
      setSelectedCoordinateState(local)
      setSelectedPath([])
      return local
    },
    [effectiveGraph?.modules, promotePath, stageResolved],
  )

  const usePublishedExport = useCallback(
    async (versionId: number, exportName: string, alias = exportName) => {
      const resolved = await stageResolved(versionId)
      if (!resolved.root.exports.includes(exportName)) throw new Error(`${exportName} export를 찾을 수 없습니다.`)
      setSelectedCoordinateState('geometry.tsx')
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
      ) as Readonly<Record<string, GeometryLocalDraft>>
      const nextEntry = rewriteCoordinates(entryRef.current, replacements)
      const publishedModules = await resolvePublishedModules(result.published.map((item) => item.id))
      const allModules = mergedModules(snapshotRef.current.modules, stagedRef.current, publishedModules)
      const nextSnapshot = nextEntry.includes('@local')
        ? snapshotRef.current
        : snapshotFromEntrySource(nextEntry, allModules)
      draftsRef.current = nextDrafts
      stagedRef.current = allModules
      setDrafts(nextDrafts)
      setStagedModules(allModules)
      applyExperimentSource(nextEntry, nextSnapshot)
      const selectedReplacement = result.replacements.find((item) => item.localCoordinate === selectedCoordinate)
      if (selectedReplacement) setSelectedCoordinateState(selectedReplacement.coordinate)
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      return { files: filesRef.current, snapshot: nextSnapshot, request }
    },
    [applyExperimentSource, queryClient, resolvePublishedModules, selectedCoordinate],
  )

  const publishNow = useCallback(
    async (request: ReturnType<typeof geometryPublishRequest>) => {
      let plan = await geometryApi.planPublish(request)
      if (JSON.stringify(currentPublishRequest(draftsRef.current, request)) !== JSON.stringify(request)) {
        throw new Error('발행 계획을 만드는 동안 Geometry source가 변경되었습니다. 저장을 다시 시도하세요.')
      }
      assertReplacementsApplicable(plan.replacements, entryRef.current, draftsRef.current)
      let result: Awaited<ReturnType<typeof geometryApi.publish>>
      try {
        result = await geometryApi.publish({ ...request, planHash: plan.planHash })
      } catch (cause) {
        const parsed =
          cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
        if (!parsed?.success || !parsed.data.revisedPlan) throw cause
        if (JSON.stringify(currentPublishRequest(draftsRef.current, request)) !== JSON.stringify(request)) {
          throw new Error('발행 경합을 처리하는 동안 Geometry source가 변경되었습니다. 저장을 다시 시도하세요.')
        }
        plan = parsed.data.revisedPlan
        assertReplacementsApplicable(plan.replacements, entryRef.current, draftsRef.current)
        result = await geometryApi.publish({ ...request, planHash: plan.planHash })
      }
      return applyPublished(request, plan, result)
    },
    [applyPublished],
  )

  const requestPublish = useCallback(
    async (coordinate: GeometryModuleCoordinate) => {
      if (!authenticated) throw new Error('Geometry 저장은 로그인 후 사용할 수 있습니다.')
      const request = geometryPublishRequest(draftsRef.current, coordinate)
      setBusy(true)
      try {
        const value = await geometryApi.planPublish(request)
        assertReplacementsApplicable(value.replacements, entryRef.current, draftsRef.current)
        setPublishPlan({ request, value })
        return value
      } catch (cause) {
        const parsed =
          cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
        if (parsed?.success && parsed.data.revisedPlan) {
          assertReplacementsApplicable(parsed.data.revisedPlan.replacements, entryRef.current, draftsRef.current)
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
        assertReplacementsApplicable(value.replacements, entryRef.current, draftsRef.current)
        setPublishPlan({ request: currentRequest, value })
        toast.info('Geometry source 변경을 반영해 발행 계획을 갱신했습니다. 내용을 확인해 주세요.')
        return null
      }
      assertReplacementsApplicable(publishPlan.value.replacements, entryRef.current, draftsRef.current)
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
        assertReplacementsApplicable(value.replacements, entryRef.current, draftsRef.current)
        setPublishPlan({ request: currentRequest, value })
        toast.info('Geometry source 변경을 반영해 발행 계획을 갱신했습니다. 내용을 확인해 주세요.')
        return null
      }
      assertReplacementsApplicable(parsed.data.revisedPlan.replacements, entryRef.current, draftsRef.current)
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
      while (true) {
        const local = analyzeGeometrySource(entryRef.current, { allowEmpty: true, allowLocal: true }).imports.find(
          (item) => localCoordinatePattern.test(item.coordinate),
        )
        if (!local) break
        const request = geometryPublishRequest(draftsRef.current, local.coordinate as LocalGeometryCoordinate)
        await publishNow(request)
      }
      return { files: filesRef.current, snapshot: snapshotRef.current }
    } finally {
      setBusy(false)
    }
  }, [authenticated, publishNow])

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
      if (referenced && draft.baseGeometryVersionId === null) {
        throw new Error('이 local Geometry를 참조하는 source import를 먼저 제거하세요.')
      }
      const replacement =
        draft.baseGeometryVersionId === null
          ? {}
          : {
              [coordinate]: `caemble:geometry/${coordinateParts(coordinate).namespace}/${draft.repository}/${draft.packageName}@${draft.version}`,
            }
      const nextEntry = rewriteCoordinates(entryRef.current, replacement)
      const next = Object.fromEntries(
        Object.values(draftsRef.current)
          .filter((item) => item.coordinate !== coordinate)
          .map((item) => [item.coordinate, { ...item, source: rewriteCoordinates(item.source, replacement) }]),
      ) as Readonly<Record<string, GeometryLocalDraft>>
      draftsRef.current = next
      setDrafts(next)
      applyExperimentSource(nextEntry)
      setSelectedCoordinateState('geometry.tsx')
    },
    [applyExperimentSource],
  )

  const reset = useCallback((value: GeometrySnapshot | null) => {
    const next = value ?? emptyGeometrySnapshot
    snapshotRef.current = next
    draftsRef.current = {}
    stagedRef.current = []
    setCurrentSnapshot(next)
    setDrafts({})
    setStagedModules([])
    setSelectedCoordinateState('geometry.tsx')
    setSelectedExport(null)
    setSelectedPath([])
    setEffectiveGraph(null)
    setPreviewScene(null)
    setPreviewSceneHash(null)
    setPreviewError(null)
  }, [])

  const restore = useCallback(
    (geometry: WorkbenchDraft['geometry'], source = entryRef.current) => {
      const replacements: Record<string, string> = {}
      if (namespace) {
        Object.values(geometry.drafts).forEach((draft) => {
          if (draft.baseGeometryVersionId !== null || draft.repositoryId !== null) return
          const parts = coordinateParts(draft.coordinate)
          if (parts.namespace !== namespace) {
            replacements[draft.coordinate] =
              `caemble:geometry/${namespace}/${draft.repository}/${draft.packageName}@local`
          }
        })
      }
      let nextSource = source
      let nextDrafts = geometry.drafts
      if (Object.keys(replacements).length) {
        try {
          const targetCoordinates = Object.values(geometry.drafts).map(
            (draft) => replacements[draft.coordinate] ?? draft.coordinate,
          )
          if (targetCoordinates.length !== new Set(targetCoordinates).size) {
            throw new Error('복원한 Geometry draft의 coordinate가 현재 namespace에서 충돌합니다.')
          }
          nextSource = rewriteCoordinates(source, replacements)
          nextDrafts = Object.fromEntries(
            Object.values(geometry.drafts).map((draft) => {
              const coordinate = (replacements[draft.coordinate] ?? draft.coordinate) as LocalGeometryCoordinate
              return [coordinate, { ...draft, coordinate, source: rewriteCoordinates(draft.source, replacements) }]
            }),
          ) as Readonly<Record<string, GeometryLocalDraft>>
        } catch (cause) {
          setGraphError(
            `복원한 draft를 현재 namespace로 조정하지 못했습니다. source 오류를 수정한 뒤 namespace를 다시 적용하세요. ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      }
      draftsRef.current = nextDrafts
      stagedRef.current = geometry.stagedModules
      entryRef.current = nextSource
      setDrafts(nextDrafts)
      setStagedModules(geometry.stagedModules)
      setEntrySource(nextSource)
      setSelectedCoordinateState(
        nextDrafts !== geometry.drafts && geometry.selectedCoordinate && geometry.selectedCoordinate !== 'geometry.tsx'
          ? ((replacements[geometry.selectedCoordinate] ?? geometry.selectedCoordinate) as GeometryModuleCoordinate)
          : geometry.selectedCoordinate,
      )
      setSelectedExport(geometry.selectedExport)
      setExpandedPaths(
        geometry.expandedPaths.map((path) =>
          nextDrafts === geometry.drafts
            ? path
            : Object.entries(replacements).reduce(
                (current, [previous, next]) => current.split(previous).join(next),
                path,
              ),
        ),
      )
      setSelectedPath([])
      setPreviewScene(null)
      setPreviewSceneHash(null)
      return nextSource
    },
    [namespace],
  )

  const selectOccurrence = useCallback(
    (
      coordinate: GeometryModuleCoordinate | 'geometry.tsx',
      path: readonly OccurrenceEdge[] = [],
      exportName: string | null = null,
    ) => {
      setSelectedCoordinateState(coordinate)
      setSelectedPath(path)
      setSelectedExport(exportName)
    },
    [],
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
    repositories,
    currentSnapshot,
    entrySource,
    entryExports,
    drafts,
    stagedModules,
    selectedCoordinate,
    selectedExport,
    selectedExports,
    selectedPath,
    expandedPaths,
    effectiveGraph,
    graphError,
    draftOverlay,
    previewDraftActive: Object.keys(draftOverlay).length > 0,
    hasReachableDrafts: reachableLocalCoordinates.size > 0,
    previewScene,
    previewSceneHash,
    previewError,
    previewDiagnostics,
    previewBusy,
    previewStale,
    publishReady:
      Boolean(selectedCoordinate && selectedCoordinate !== 'geometry.tsx' && drafts[selectedCoordinate]) &&
      previewedInput === previewInput &&
      !previewError,
    busy,
    publishPlan,
    setPublishPlan,
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
    editPublishedVersion,
    editAsNewVersion: async (coordinate: GeometryModuleCoordinate) => {
      if (!authenticated) throw new Error('Published Geometry 편집은 로그인 후 사용할 수 있습니다.')
      const module = moduleByCoordinate(coordinate)
      if (!module) throw new Error('Geometry module을 찾을 수 없습니다.')
      return editPublishedVersion(module.geometryVersionId)
    },
    usePublishedExport,
    publishNewGeometry,
    stageResolved,
    updateSource,
    updateDescription: (coordinate: GeometryModuleCoordinate, description: string) => {
      const draft = draftsRef.current[coordinate]
      if (!draft) return
      const next = { ...draftsRef.current, [coordinate]: { ...draft, description } }
      draftsRef.current = next
      setDrafts(next)
    },
    setBump: (coordinate: GeometryModuleCoordinate, bump: GeometryLocalDraft['bump']) => {
      const draft = draftsRef.current[coordinate]
      if (!draft) return
      const next = { ...draftsRef.current, [coordinate]: { ...draft, bump } }
      draftsRef.current = next
      setDrafts(next)
    },
    discardDraft,
    requestPublish,
    confirmPublish,
    prepareExperimentSave,
    setSelectedCoordinate: (coordinate: GeometryModuleCoordinate | 'geometry.tsx' | null) =>
      selectOccurrence(coordinate ?? 'geometry.tsx'),
    setSelectedExport,
    selectOccurrence,
    togglePath: (path: string) =>
      setExpandedPaths((current) =>
        current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
      ),
    reset,
    restore,
    draftState: (): WorkbenchDraft['geometry'] => ({
      drafts: draftsRef.current,
      stagedModules: stagedRef.current,
      selectedCoordinate,
      selectedExport,
      expandedPaths,
    }),
  }
}

export type GeometryWorkspaceState = ReturnType<typeof useGeometryWorkspaceState>
