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
  rewriteGeometryImportCoordinates,
  validateGeometrySnapshotHashes,
  type CadDiagnostic,
  type CadScene,
  type EffectiveGeometryGraph,
  type GeometryCoordinate,
  type GeometryDraftOverlay,
  type GeometrySnapshot,
  type GeometrySnapshotModule,
} from '@/lib/cad'
import type { GeometryLocalDraft, WorkbenchDraft } from '../types'

const emptyGeometrySnapshot: GeometrySnapshot = { schemaVersion: 1, roots: [], modules: [] }
const MAX_SEMVER_COMPONENT = 2_147_483_647

function coordinateParts(coordinate: string) {
  const match = /^caemble:geometry\/([^/]+)\/([^/]+)\/([^@]+)@(\d+)\.(\d+)\.(\d+)$/u.exec(coordinate)
  if (!match) throw new Error(`Geometry coordinate가 올바르지 않습니다: ${coordinate}`)
  return {
    namespace: match[1],
    repository: match[2],
    packageName: match[3],
    version: `${match[4]}.${match[5]}.${match[6]}`,
  }
}

function bumpedVersion(version: string, bump: GeometryLocalDraft['bump']) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version)
  if (!match) throw new Error(`SemVer가 올바르지 않습니다: ${version}`)
  const [major, minor, patch] = match.slice(1).map(Number)
  const next =
    bump === 'major' ? [major + 1, 0, 0] : bump === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1]
  if (next.some((part) => part > MAX_SEMVER_COMPONENT)) {
    throw new Error(`SemVer component는 ${MAX_SEMVER_COMPONENT} 이하여야 합니다.`)
  }
  return next.join('.')
}

function retainReachableModules(snapshot: GeometrySnapshot, roots: GeometrySnapshot['roots']) {
  const modules = new Map(snapshot.modules.map((module) => [module.coordinate, module]))
  const reachable = new Set<string>()
  const visit = (coordinate: GeometryCoordinate) => {
    if (reachable.has(coordinate)) return
    reachable.add(coordinate)
    modules.get(coordinate)?.imports.forEach((item) => visit(item.coordinate))
  }
  roots.forEach((root) => visit(root.coordinate))
  return createGeometrySnapshot(
    roots,
    snapshot.modules.filter((module) => reachable.has(module.coordinate)),
  )
}

export function geometryDraftImporters(
  drafts: Readonly<Record<string, GeometryLocalDraft>>,
  coordinate: GeometryCoordinate,
) {
  return Object.values(drafts).filter((draft) => {
    if (draft.coordinate === coordinate) return false
    try {
      return analyzeGeometrySource(draft.source).imports.some((item) => item.coordinate === coordinate)
    } catch {
      return false
    }
  })
}

export function relatedGeometryRootDrafts(drafts: Readonly<Record<string, GeometryLocalDraft>>, targetDraftId: string) {
  const byCoordinate = new Map(Object.values(drafts).map((draft) => [draft.coordinate, draft]))
  const importsByDraftId = new Map(
    Object.values(drafts).map((draft) => {
      try {
        return [draft.draftId, analyzeGeometrySource(draft.source).imports.map((item) => item.coordinate)] as const
      } catch {
        return [draft.draftId, [] as GeometryCoordinate[]] as const
      }
    }),
  )
  const memo = new Map<string, boolean>()
  const reachesTarget = (draft: GeometryLocalDraft, visiting: Set<string>): boolean => {
    if (draft.draftId === targetDraftId) return true
    const cached = memo.get(draft.draftId)
    if (cached !== undefined) return cached
    if (visiting.has(draft.draftId)) return false
    visiting.add(draft.draftId)
    const reaches = (importsByDraftId.get(draft.draftId) ?? []).some((coordinate) => {
      const importedDraft = byCoordinate.get(coordinate)
      return importedDraft ? reachesTarget(importedDraft, visiting) : false
    })
    visiting.delete(draft.draftId)
    memo.set(draft.draftId, reaches)
    return reaches
  }
  return Object.values(drafts).filter((draft) => draft.rootAlias && reachesTarget(draft, new Set<string>()))
}

export function retainReferencedStagedModules(
  drafts: Readonly<Record<string, GeometryLocalDraft>>,
  stagedModules: readonly GeometrySnapshotModule[],
) {
  const staged = new Map(stagedModules.map((module) => [module.coordinate, module]))
  const retained = new Set<GeometryCoordinate>()
  let hasInvalidDraft = false
  const visit = (coordinate: GeometryCoordinate) => {
    if (retained.has(coordinate)) return
    const module = staged.get(coordinate)
    if (!module) return
    retained.add(coordinate)
    module.imports.forEach((item) => visit(item.coordinate))
  }
  Object.values(drafts).forEach((draft) => {
    try {
      analyzeGeometrySource(draft.source).imports.forEach((item) => visit(item.coordinate))
    } catch {
      hasInvalidDraft = true
    }
  })
  if (hasInvalidDraft) return stagedModules
  return stagedModules.filter((module) => retained.has(module.coordinate))
}

export function attachGeometryImportSource(source: string, coordinate: GeometryCoordinate, identifier: string) {
  const analysis = analyzeGeometrySource(source)
  if (analysis.imports.some((item) => item.coordinate === coordinate)) return source
  const start = analysis.defaultExport.start
  const end = analysis.defaultExport.end
  if (start === null || start === undefined || end === null || end === undefined) {
    throw new Error('Geometry default export 위치를 찾을 수 없습니다.')
  }
  const combined = `<union>{${source.slice(start, end)}}{${identifier}}</union>`
  const nextSource = `${source.slice(0, start)}${combined}${source.slice(end)}`
  return `import ${identifier} from ${JSON.stringify(coordinate)};\n${nextSource}`
}

export function createGeometryPublishRequest(
  drafts: Readonly<Record<string, GeometryLocalDraft>>,
  roots: GeometrySnapshot['roots'],
  coordinate: GeometryCoordinate,
  apply: boolean,
) {
  const target = drafts[coordinate]
  if (!target) throw new Error('발행할 Geometry draft를 찾을 수 없습니다.')
  if (apply && target.standalonePreview) {
    throw new Error('Manager에서 연 standalone draft는 Publish only로 발행하세요.')
  }
  if (!apply && target.baseGeometryVersionId === null && geometryDraftImporters(drafts, coordinate).length > 0) {
    throw new Error(
      '다른 local draft가 이 새 Geometry를 import하고 있습니다. Publish & Apply하거나 importer source에서 import를 제거하세요.',
    )
  }
  const localRootDrafts = apply ? relatedGeometryRootDrafts(drafts, target.draftId) : []
  return {
    mode: apply ? ('publish-and-apply' as const) : ('publish-only' as const),
    targetDraftId: target.draftId,
    drafts: Object.values(drafts).map((draft) => ({
      draftId: draft.draftId,
      baseGeometryVersionId: draft.baseGeometryVersionId,
      repositoryId: draft.repositoryId,
      repository: draft.repository,
      package: draft.packageName,
      ...(draft.baseGeometryVersionId ? { bump: draft.bump } : { version: draft.version }),
      description: draft.description || null,
      source: draft.source,
    })),
    currentRoots: [
      ...roots.map((root) => ({ alias: root.alias, geometryVersionId: root.geometryVersionId })),
      ...localRootDrafts.map((draft) => ({ alias: draft.rootAlias!, draftId: draft.draftId })),
    ],
  }
}

export function rebaseNewGeometryDraftConflict(
  drafts: Readonly<Record<string, GeometryLocalDraft>>,
  draftId: string,
  suggestedVersion: string,
) {
  const target = Object.values(drafts).find((draft) => draft.draftId === draftId)
  if (!target || target.baseGeometryVersionId !== null) return null
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(suggestedVersion)) {
    throw new Error(`서버가 제안한 Geometry SemVer가 올바르지 않습니다: ${suggestedVersion}`)
  }
  const parsed = coordinateParts(target.coordinate)
  let nextVersion = suggestedVersion
  let nextCoordinate =
    `caemble:geometry/${parsed.namespace}/${parsed.repository}/${parsed.packageName}@${nextVersion}` as GeometryCoordinate
  while (drafts[nextCoordinate] && drafts[nextCoordinate].draftId !== draftId) {
    nextVersion = bumpedVersion(nextVersion, 'patch')
    nextCoordinate =
      `caemble:geometry/${parsed.namespace}/${parsed.repository}/${parsed.packageName}@${nextVersion}` as GeometryCoordinate
  }
  const replacements = { [target.coordinate]: nextCoordinate }
  const nextDrafts: Readonly<Record<string, GeometryLocalDraft>> = Object.fromEntries(
    Object.values(drafts).map((draft) => {
      const coordinate = draft.draftId === draftId ? nextCoordinate : draft.coordinate
      return [
        coordinate,
        {
          ...draft,
          coordinate,
          source: !draft.source.includes(target.coordinate)
            ? draft.source
            : (() => {
                try {
                  return rewriteGeometryImportCoordinates(draft.source, replacements)
                } catch {
                  return draft.source
                }
              })(),
          ...(draft.draftId === draftId ? { version: nextVersion } : {}),
        },
      ]
    }),
  )
  return { drafts: nextDrafts, nextCoordinate, nextVersion, previousCoordinate: target.coordinate }
}

export function reconcileGeometryDraftNamespace(
  drafts: Readonly<Record<string, GeometryLocalDraft>>,
  namespace: string,
  reservedCoordinates: ReadonlySet<string> = new Set(),
) {
  const replacements: Record<string, GeometryCoordinate> = {}
  for (const draft of Object.values(drafts)) {
    if (draft.baseGeometryVersionId !== null || draft.repositoryId !== null) continue
    const parsed = coordinateParts(draft.coordinate)
    if (parsed.namespace === namespace) continue
    replacements[draft.coordinate] =
      `caemble:geometry/${namespace}/${draft.repository}/${draft.packageName}@${draft.version}` as GeometryCoordinate
  }
  if (!Object.keys(replacements).length) return { drafts, replacements }
  const nextCoordinates = new Set<string>()
  for (const draft of Object.values(drafts)) {
    const coordinate = replacements[draft.coordinate] ?? draft.coordinate
    if (nextCoordinates.has(coordinate) || reservedCoordinates.has(coordinate)) {
      throw new Error(`${coordinate}가 이미 존재하여 기본 namespace를 변경할 수 없습니다.`)
    }
    nextCoordinates.add(coordinate)
  }
  const nextDrafts = Object.fromEntries(
    Object.values(drafts).map((draft) => {
      const coordinate = replacements[draft.coordinate] ?? draft.coordinate
      return [
        coordinate,
        {
          ...draft,
          coordinate,
          source: rewriteGeometryImportCoordinates(draft.source, replacements),
        },
      ]
    }),
  ) as Readonly<Record<string, GeometryLocalDraft>>
  return { drafts: nextDrafts, replacements }
}

export function useGeometryWorkspaceState({
  initialNamespace,
  onSnapshotChange,
  snapshot,
}: {
  initialNamespace: string | null | undefined
  onSnapshotChange: (snapshot: GeometrySnapshot) => void
  snapshot: GeometrySnapshot | null
}) {
  const queryClient = useQueryClient()
  const [namespace, setNamespaceState] = useState(initialNamespace ?? null)
  const [drafts, setDrafts] = useState<Readonly<Record<string, GeometryLocalDraft>>>({})
  const draftsRef = useRef(drafts)
  const [stagedModules, setStagedModules] = useState<readonly GeometrySnapshotModule[]>([])
  const [previewDrafts, setPreviewDrafts] = useState<Readonly<Record<string, GeometryLocalDraft>>>({})
  const [selectedCoordinate, setSelectedCoordinate] = useState<GeometryCoordinate | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [previewStale, setPreviewStale] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [effectiveGraph, setEffectiveGraph] = useState<EffectiveGeometryGraph | null>(null)
  const [previewScene, setPreviewScene] = useState<CadScene | null>(null)
  const [previewSceneHash, setPreviewSceneHash] = useState<string | null>(null)
  const [previewDiagnostics, setPreviewDiagnostics] = useState<readonly CadDiagnostic[]>([])
  const [previewBusy, setPreviewBusy] = useState(false)
  const [repositories, setRepositories] = useState<GeometryRepositoryRecord[]>([])
  const [publishPlan, setPublishPlan] = useState<{
    request: Parameters<typeof geometryApi.planPublish>[0]
    value: Awaited<ReturnType<typeof geometryApi.planPublish>>
  } | null>(null)
  const currentSnapshot = snapshot ?? emptyGeometrySnapshot
  draftsRef.current = drafts
  const stagingConflict = useMemo(() => {
    const persisted = new Map(currentSnapshot.modules.map((module) => [module.coordinate, module]))
    return stagedModules.find((module) => {
      const existing = persisted.get(module.coordinate)
      return existing && existing.moduleHash !== module.moduleHash
    })
  }, [currentSnapshot.modules, stagedModules])

  useEffect(() => setNamespaceState(initialNamespace ?? null), [initialNamespace])

  useEffect(() => {
    if (drafts === previewDrafts) return
    const timeout = window.setTimeout(() => setPreviewDrafts(drafts), 300)
    return () => window.clearTimeout(timeout)
  }, [drafts, previewDrafts])

  const draftOverlay = useMemo(
    () =>
      Object.freeze(
        Object.fromEntries([
          ...stagedModules
            .filter((module) => !currentSnapshot.modules.some((item) => item.coordinate === module.coordinate))
            .map((module) => [module.coordinate, Object.freeze({ source: module.source })] as const),
          ...Object.values(previewDrafts).map(
            (draft) => [draft.coordinate, Object.freeze({ source: draft.source })] as const,
          ),
        ]),
      ) as GeometryDraftOverlay,
    [currentSnapshot.modules, previewDrafts, stagedModules],
  )
  const previewDraftActive = Object.keys(previewDrafts).length > 0 || stagedModules.length > 0
  const effectiveRoots = useMemo(
    () => [
      ...currentSnapshot.roots.map(({ alias, coordinate }) => ({ alias, coordinate })),
      ...Object.values(previewDrafts)
        .filter((draft) => draft.rootAlias)
        .map((draft) => ({ alias: draft.rootAlias!, coordinate: draft.coordinate as GeometryCoordinate })),
      ...Object.values(previewDrafts)
        .filter((draft) => draft.standalonePreview)
        .map((draft, index) => ({ alias: `standalone_${index}`, coordinate: draft.coordinate as GeometryCoordinate })),
    ],
    [currentSnapshot.roots, previewDrafts],
  )

  useEffect(() => {
    if (stagingConflict) {
      setPreviewError(`${stagingConflict.coordinate} staged hash가 현재 snapshot과 충돌합니다.`)
      setPreviewStale(true)
      return
    }
    if (!previewDraftActive) {
      setEffectiveGraph(null)
      setPreviewError(null)
      setPreviewStale(Object.keys(drafts).length > 0)
      return
    }
    let cancelled = false
    void createEffectiveGeometryGraph(currentSnapshot, draftOverlay, effectiveRoots)
      .then((graph) => {
        if (cancelled) return
        setEffectiveGraph(graph)
        setPreviewError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setPreviewError(cause instanceof Error ? cause.message : String(cause))
        setPreviewStale(true)
      })
    return () => {
      cancelled = true
    }
  }, [currentSnapshot, draftOverlay, drafts, effectiveRoots, previewDraftActive, stagingConflict])

  useEffect(() => {
    if (!selectedCoordinate) {
      setPreviewScene(null)
      setPreviewSceneHash(null)
      setPreviewDiagnostics([])
      setPreviewBusy(false)
      setPreviewStale(false)
      return
    }
    const coordinate = selectedCoordinate as GeometryCoordinate
    const available =
      currentSnapshot.modules.some((module) => module.coordinate === coordinate) || Boolean(draftOverlay[coordinate])
    if (!available) return
    const abort = new AbortController()
    setPreviewBusy(true)
    setPreviewStale(true)
    void evaluateGeometryModule(currentSnapshot, coordinate, {
      geometryDrafts: draftOverlay,
      signal: abort.signal,
      timeoutMs: 10_000,
    })
      .then((preview) => {
        if (abort.signal.aborted) return
        setPreviewScene(preview.scene)
        setPreviewSceneHash(preview.sourceHash)
        setPreviewDiagnostics([])
        setPreviewError(null)
        setPreviewStale(false)
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return
        const diagnostics =
          cause instanceof CadCompilationError || cause instanceof CadDocumentEvaluationError ? cause.diagnostics : []
        setPreviewDiagnostics(diagnostics)
        setPreviewError(cause instanceof Error ? cause.message : String(cause))
        setPreviewStale(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setPreviewBusy(false)
      })
    return () => abort.abort()
  }, [currentSnapshot, draftOverlay, selectedCoordinate])

  const reset = useCallback((nextSnapshot: GeometrySnapshot | null = null) => {
    setDrafts({})
    setPreviewDrafts({})
    setStagedModules([])
    setPreviewStale(false)
    setPreviewError(null)
    setEffectiveGraph(null)
    setPreviewScene(null)
    setPreviewSceneHash(null)
    setPreviewDiagnostics([])
    setPublishPlan(null)
    setSelectedCoordinate(nextSnapshot?.roots[0]?.coordinate ?? null)
    setExpandedPaths(nextSnapshot?.roots.map((root) => `root:${root.alias}`) ?? [])
  }, [])

  const restore = useCallback(
    (value: WorkbenchDraft['geometry']) => {
      const reconciled = namespace
        ? reconcileGeometryDraftNamespace(
            value.drafts,
            namespace,
            new Set([...currentSnapshot.modules, ...value.stagedModules].map((module) => module.coordinate)),
          ).drafts
        : value.drafts
      const restoredStagedModules = retainReferencedStagedModules(reconciled, value.stagedModules)
      setDrafts(reconciled)
      setPreviewDrafts(reconciled)
      setStagedModules(restoredStagedModules)
      setSelectedCoordinate(
        value.selectedCoordinate && value.drafts[value.selectedCoordinate]
          ? (Object.values(reconciled).find(
              (draft) => draft.draftId === value.drafts[value.selectedCoordinate!].draftId,
            )?.coordinate ?? value.selectedCoordinate)
          : value.selectedCoordinate,
      )
      setExpandedPaths(value.expandedPaths)
      setPreviewStale(Object.keys(value.drafts).length > 0)
      setPreviewError(null)
      setEffectiveGraph(null)
      setPreviewScene(null)
      setPreviewSceneHash(null)
      setPreviewDiagnostics([])
      setPreviewBusy(false)
      setPublishPlan(null)
    },
    [currentSnapshot.modules, namespace],
  )

  const draftState = useCallback(
    (): WorkbenchDraft['geometry'] => ({ drafts, stagedModules, selectedCoordinate, expandedPaths }),
    [drafts, expandedPaths, selectedCoordinate, stagedModules],
  )

  const togglePath = useCallback((path: string) => {
    setExpandedPaths((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    )
  }, [])

  const editAsNewVersion = useCallback(
    (coordinate: GeometryCoordinate) => {
      const module = currentSnapshot.modules.find((item) => item.coordinate === coordinate)
      if (!module) throw new Error(`${coordinate} snapshot module을 찾을 수 없습니다.`)
      const parsed = coordinateParts(coordinate)
      setDrafts((current) => ({
        ...current,
        [coordinate]: {
          draftId: `version:${module.geometryVersionId}`,
          coordinate,
          source: module.source,
          description: module.description ?? '',
          baseGeometryVersionId: module.geometryVersionId,
          repository: parsed.repository,
          packageName: parsed.packageName,
          repositoryId:
            repositories.find(
              (repository) => repository.namespace === parsed.namespace && repository.slug === parsed.repository,
            )?.id ?? null,
          packageId: null,
          version: bumpedVersion(parsed.version, 'patch'),
          bump: 'patch',
          rootAlias: null,
          standalonePreview: false,
        },
      }))
      setSelectedCoordinate(coordinate)
      setPreviewStale(true)
      setPreviewError(null)
    },
    [currentSnapshot.modules, repositories],
  )

  const editPublishedVersion = useCallback(
    async (versionId: number, repositoryId: number, packageId: number) => {
      const existingDraft = Object.values(draftsRef.current).find((draft) => draft.baseGeometryVersionId === versionId)
      if (existingDraft) {
        setSelectedCoordinate(existingDraft.coordinate)
        return existingDraft
      }
      const snapshotModule = currentSnapshot.modules.find((module) => module.geometryVersionId === versionId)
      if (snapshotModule) {
        editAsNewVersion(snapshotModule.coordinate)
        return null
      }
      const resolved = await geometryApi.resolveVersion(versionId)
      await validateGeometrySnapshotHashes(
        createGeometrySnapshot([{ alias: 'standalone', ...resolved.root }], resolved.modules),
      )
      const parsed = coordinateParts(resolved.root.coordinate)
      const staged = new Map(stagedModules.map((module) => [module.coordinate, module]))
      resolved.modules.forEach((module) => {
        const current = staged.get(module.coordinate)
        if (current && current.moduleHash !== module.moduleHash) {
          throw new Error(`${module.coordinate} staged hash가 현재 graph와 충돌합니다.`)
        }
        staged.set(module.coordinate, module)
      })
      const rootModule = resolved.modules.find((module) => module.geometryVersionId === versionId)
      if (!rootModule) throw new Error('선택한 Geometry module을 resolve 결과에서 찾을 수 없습니다.')
      const draft: GeometryLocalDraft = {
        draftId: `version:${versionId}`,
        coordinate: resolved.root.coordinate,
        source: rootModule.source,
        description: rootModule.description ?? '',
        baseGeometryVersionId: versionId,
        repository: parsed.repository,
        packageName: parsed.packageName,
        repositoryId,
        packageId,
        version: bumpedVersion(parsed.version, 'patch'),
        bump: 'patch',
        rootAlias: null,
        standalonePreview: true,
      }
      setStagedModules([...staged.values()])
      setDrafts((current) => ({ ...current, [draft.coordinate]: draft }))
      setSelectedCoordinate(draft.coordinate)
      setPreviewStale(true)
      setPreviewError(null)
      return draft
    },
    [currentSnapshot.modules, editAsNewVersion, stagedModules],
  )

  const updateSource = useCallback((coordinate: GeometryCoordinate, source: string) => {
    setDrafts((current) => {
      const draft = current[coordinate]
      if (!draft) return current
      const next = { ...current, [coordinate]: { ...draft, source } }
      setStagedModules((modules) => retainReferencedStagedModules(next, modules))
      return next
    })
    setPreviewStale(true)
    setPreviewError(null)
  }, [])

  const setBump = useCallback((coordinate: GeometryCoordinate, bump: GeometryLocalDraft['bump']) => {
    setDrafts((current) => {
      const draft = current[coordinate]
      if (!draft || !draft.baseGeometryVersionId) return current
      const currentVersion = coordinateParts(coordinate).version
      return { ...current, [coordinate]: { ...draft, bump, version: bumpedVersion(currentVersion, bump) } }
    })
  }, [])

  const discardDraft = useCallback(
    (coordinate: GeometryCoordinate) => {
      const target = drafts[coordinate]
      const importers = target?.baseGeometryVersionId === null ? geometryDraftImporters(drafts, coordinate) : []
      if (importers.length) {
        toast.error(
          `${importers[0].coordinate}에서 이 새 Geometry를 import하고 있습니다. importer source에서 import를 제거한 뒤 폐기하세요.`,
        )
        return
      }
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== coordinate)))
      setPreviewDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== coordinate)))
      setStagedModules((current) =>
        retainReferencedStagedModules(
          Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== coordinate)),
          current,
        ),
      )
      const remainsInSnapshot = currentSnapshot.modules.some((module) => module.coordinate === coordinate)
      if (!remainsInSnapshot) setSelectedCoordinate(currentSnapshot.roots[0]?.coordinate ?? null)
      setPreviewStale(Object.keys(drafts).length > 1)
      setPreviewError(null)
    },
    [currentSnapshot.modules, currentSnapshot.roots, drafts],
  )

  const createDraft = useCallback(
    async ({
      repositoryId,
      repository,
      packageName,
      version,
      description,
      source,
      rootAlias,
    }: {
      repositoryId: number | null
      repository: string
      packageName: string
      version: string
      description: string
      source: string
      rootAlias: string | null
    }) => {
      if (!namespace) throw new Error('먼저 Geometry namespace를 설정하세요.')
      const repositoryItem = repositoryId === null ? null : repositories.find((item) => item.id === repositoryId)
      if (repositoryId !== null && !repositoryItem) throw new Error('선택한 Geometry repository를 찾을 수 없습니다.')
      if (repositoryItem?.archived_at) throw new Error('Archive된 Geometry repository에는 발행할 수 없습니다.')
      const repositorySlug = repositoryItem?.slug ?? repository
      const repositoryNamespace = repositoryItem?.namespace ?? namespace
      if (!/^[a-z0-9](?:(?:[a-z0-9-]{0,62})[a-z0-9])?$/u.test(repositorySlug)) {
        throw new Error('Repository는 소문자, 숫자, 하이픈만 사용할 수 있습니다.')
      }
      if (!/^[a-z0-9](?:(?:[a-z0-9-]{0,62})[a-z0-9])?$/u.test(packageName)) {
        throw new Error('Package name은 소문자, 숫자, 하이픈만 사용할 수 있습니다.')
      }
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
        throw new Error('Initial version은 X.Y.Z SemVer여야 합니다.')
      }
      if (version.split('.').some((part) => Number(part) > MAX_SEMVER_COMPONENT)) {
        throw new Error(`SemVer component는 ${MAX_SEMVER_COMPONENT} 이하여야 합니다.`)
      }
      if (rootAlias && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(rootAlias)) {
        throw new Error('Root alias는 JavaScript identifier여야 합니다.')
      }
      if (
        rootAlias &&
        (currentSnapshot.roots.some((root) => root.alias === rootAlias) ||
          Object.values(drafts).some((draft) => draft.rootAlias === rootAlias))
      ) {
        throw new Error(`Root alias ${rootAlias}는 이미 사용 중입니다.`)
      }
      const coordinate =
        `caemble:geometry/${repositoryNamespace}/${repositorySlug}/${packageName}@${version}` as GeometryCoordinate
      if (currentSnapshot.modules.some((module) => module.coordinate === coordinate) || drafts[coordinate]) {
        throw new Error(`${coordinate}는 이미 현재 graph에 있습니다.`)
      }
      const draft: GeometryLocalDraft = {
        draftId: `new:${crypto.randomUUID()}`,
        coordinate,
        source,
        description,
        baseGeometryVersionId: null,
        repository: repositorySlug,
        packageName,
        repositoryId: repositoryItem?.id ?? null,
        packageId: null,
        version,
        bump: 'patch',
        rootAlias,
        standalonePreview: false,
      }
      setDrafts((current) => ({ ...current, [coordinate]: draft }))
      setSelectedCoordinate(coordinate)
      setPreviewStale(true)
      setPreviewError(null)
      return draft
    },
    [currentSnapshot.modules, currentSnapshot.roots, drafts, namespace, repositories],
  )

  const attachDraftImport = useCallback(
    (parentCoordinate: GeometryCoordinate, childCoordinate: GeometryCoordinate) => {
      const existingDraft = drafts[parentCoordinate]
      const module = currentSnapshot.modules.find((item) => item.coordinate === parentCoordinate)
      const source = existingDraft?.source ?? module?.source
      if (source === undefined) throw new Error(`${parentCoordinate} importer source를 찾을 수 없습니다.`)
      if (analyzeGeometrySource(source).imports.some((item) => item.coordinate === childCoordinate)) return
      const identifierBase = `geometry_${coordinateParts(childCoordinate).packageName.replace(/-/gu, '_')}`
      let identifier = identifierBase
      let suffix = 2
      while (new RegExp(`\\b${identifier}\\b`, 'u').test(source)) identifier = `${identifierBase}_${suffix++}`
      const nextSource = attachGeometryImportSource(source, childCoordinate, identifier)
      setDrafts((current) => {
        const draft = current[parentCoordinate]
        if (draft) return { ...current, [parentCoordinate]: { ...draft, source: nextSource } }
        const parsed = coordinateParts(parentCoordinate)
        if (!module) return current
        return {
          ...current,
          [parentCoordinate]: {
            draftId: `version:${module.geometryVersionId}`,
            coordinate: parentCoordinate,
            source: nextSource,
            description: module.description ?? '',
            baseGeometryVersionId: module.geometryVersionId,
            repository: parsed.repository,
            packageName: parsed.packageName,
            repositoryId: null,
            packageId: null,
            version: bumpedVersion(parsed.version, 'patch'),
            bump: 'patch',
            rootAlias: null,
            standalonePreview: false,
          },
        }
      })
      setSelectedCoordinate(parentCoordinate)
      setPreviewStale(true)
    },
    [currentSnapshot.modules, drafts],
  )

  const addRoot = useCallback(
    async (versionId: number, alias: string) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(alias)) throw new Error('Root alias는 JavaScript identifier여야 합니다.')
      if (
        currentSnapshot.roots.some((root) => root.alias === alias) ||
        Object.values(drafts).some((draft) => draft.rootAlias === alias)
      )
        throw new Error(`Root alias ${alias}는 이미 있습니다.`)
      const resolved = await geometryApi.resolveVersion(versionId)
      if (currentSnapshot.roots.some((root) => root.coordinate === resolved.root.coordinate)) {
        throw new Error(`${resolved.root.coordinate}는 이미 root입니다.`)
      }
      const modules = new Map(currentSnapshot.modules.map((module) => [module.coordinate, module]))
      resolved.modules.forEach((module) => {
        const existing = modules.get(module.coordinate)
        if (existing && existing.moduleHash !== module.moduleHash) {
          throw new Error(`${module.coordinate} snapshot hash가 현재 graph와 충돌합니다.`)
        }
        modules.set(module.coordinate, module)
      })
      const next = createGeometrySnapshot(
        [...currentSnapshot.roots, { alias, ...resolved.root }],
        [...modules.values()],
      )
      onSnapshotChange(next)
      setSelectedCoordinate(resolved.root.coordinate)
      setExpandedPaths((current) => [...current, `root:${alias}`])
      return next
    },
    [currentSnapshot.modules, currentSnapshot.roots, drafts, onSnapshotChange],
  )

  const addPublishedImport = useCallback(
    async (parentCoordinate: GeometryCoordinate, versionId: number) => {
      const parent = drafts[parentCoordinate]
      if (!parent) throw new Error('먼저 import를 추가할 Geometry draft를 선택하세요.')
      const resolved = await geometryApi.resolveVersion(versionId)
      await validateGeometrySnapshotHashes(
        createGeometrySnapshot([{ alias: 'staging', ...resolved.root }], resolved.modules),
      )
      if (resolved.root.coordinate === parentCoordinate) throw new Error('Geometry는 자기 자신을 import할 수 없습니다.')
      const snapshotModules = new Map(currentSnapshot.modules.map((module) => [module.coordinate, module]))
      const staged = new Map(stagedModules.map((module) => [module.coordinate, module]))
      resolved.modules.forEach((module) => {
        const persisted = snapshotModules.get(module.coordinate)
        if (persisted && persisted.moduleHash !== module.moduleHash) {
          throw new Error(`${module.coordinate} snapshot hash가 현재 graph와 충돌합니다.`)
        }
        const existing = staged.get(module.coordinate)
        if (existing && existing.moduleHash !== module.moduleHash) {
          throw new Error(`${module.coordinate} staged hash가 현재 graph와 충돌합니다.`)
        }
        staged.set(module.coordinate, module)
      })
      const latestParent = draftsRef.current[parentCoordinate]
      if (!latestParent) throw new Error('선택한 Geometry draft가 더 이상 존재하지 않습니다.')
      const identifierBase = `geometry_${coordinateParts(resolved.root.coordinate).packageName.replace(/-/gu, '_')}`
      let identifier = identifierBase
      let suffix = 2
      while (new RegExp(`\\b${identifier}\\b`, 'u').test(latestParent.source))
        identifier = `${identifierBase}_${suffix++}`
      const nextSource = attachGeometryImportSource(latestParent.source, resolved.root.coordinate, identifier)
      setStagedModules([...staged.values()])
      setDrafts((current) => ({ ...current, [parentCoordinate]: { ...latestParent, source: nextSource } }))
      setSelectedCoordinate(parentCoordinate)
      setPreviewStale(true)
      setPreviewError(null)
      return resolved.root.coordinate
    },
    [currentSnapshot.modules, drafts, stagedModules],
  )

  const removeRoot = useCallback(
    (alias: string) => {
      const roots = currentSnapshot.roots.filter((root) => root.alias !== alias)
      if (roots.length === currentSnapshot.roots.length) return
      const next = retainReachableModules(currentSnapshot, roots)
      onSnapshotChange(next)
      setExpandedPaths((current) => current.filter((path) => path !== `root:${alias}`))
      if (selectedCoordinate && !next.modules.some((module) => module.coordinate === selectedCoordinate)) {
        setSelectedCoordinate(next.roots[0]?.coordinate ?? null)
      }
    },
    [currentSnapshot, onSnapshotChange, selectedCoordinate],
  )

  const refreshRepositories = useCallback(async () => {
    const response = await dbTables.GeometryRepository.listRows({
      ...getListRequest('mine'),
      limit: null,
      null_filter: { archived_at: 'is_null' },
      sort: [
        ['namespace', 'asc'],
        ['slug', 'asc'],
      ],
    })
    setRepositories(response.items)
    return response.items
  }, [])

  const createRepository = useCallback(
    async (slug: string, description: string) => {
      const repository = await geometryApi.createRepository({ slug, description: description || null })
      await refreshRepositories()
      return repository
    },
    [refreshRepositories],
  )

  const archiveRepository = useCallback(
    async (repositoryId: number) => {
      const repository = await geometryApi.archiveRepository(repositoryId)
      await refreshRepositories()
      return repository
    },
    [refreshRepositories],
  )

  const archiveVersion = useCallback(async (versionId: number) => geometryApi.archiveVersion(versionId), [])

  const checkLatestVersion = useCallback(async (coordinate: GeometryCoordinate) => {
    const parsed = coordinateParts(coordinate)
    const repositoryItems = (await dbTables.GeometryRepository.listRows({ ...getListRequest('mine'), limit: null }))
      .items
    const repository = repositoryItems.find(
      (item) => item.namespace === parsed.namespace && item.slug === parsed.repository,
    )
    if (!repository) throw new Error(`${parsed.repository} repository를 찾을 수 없습니다.`)
    const packages = (
      await dbTables.GeometryPackage.listRows({
        ...getListRequest('mine'),
        limit: null,
        filter: { repository_id: [repository.id, repository.id] },
      })
    ).items
    const packageItem = packages.find((item) => item.name === parsed.packageName)
    if (!packageItem) throw new Error(`${parsed.packageName} package를 찾을 수 없습니다.`)
    const versions = (
      await dbTables.GeometryVersion.listRows({
        ...getListRequest('mine'),
        limit: 1,
        filter: { package_id: [packageItem.id, packageItem.id] },
        null_filter: { archived_at: 'is_null' },
        sort: [
          ['version_major', 'desc'],
          ['version_minor', 'desc'],
          ['version_patch', 'desc'],
        ],
      })
    ).items
    return versions[0] ?? null
  }, [])

  const setNamespace = useCallback(
    async (value: string) => {
      const nextNamespace = value.trim()
      const reconciled = reconcileGeometryDraftNamespace(
        drafts,
        nextNamespace,
        new Set([...currentSnapshot.modules, ...stagedModules].map((module) => module.coordinate)),
      )
      const user = await geometryApi.setNamespace(nextNamespace)
      setDrafts(reconciled.drafts)
      setPreviewDrafts(reconciled.drafts)
      if (selectedCoordinate && reconciled.replacements[selectedCoordinate]) {
        setSelectedCoordinate(reconciled.replacements[selectedCoordinate])
      }
      setNamespaceState(user.geometry_namespace)
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      return user.geometry_namespace
    },
    [currentSnapshot.modules, drafts, queryClient, selectedCoordinate, stagedModules],
  )

  const publishRequest = useCallback(
    (coordinate: GeometryCoordinate, apply: boolean) =>
      createGeometryPublishRequest(drafts, currentSnapshot.roots, coordinate, apply),
    [currentSnapshot.roots, drafts],
  )

  const recoverPublishConflict = useCallback(
    async (
      request: Parameters<typeof geometryApi.planPublish>[0],
      conflict: {
        draftId: string
        coordinate: GeometryCoordinate
        suggestedVersion: string
        revisedPlan: Awaited<ReturnType<typeof geometryApi.planPublish>> | null
      },
    ) => {
      if (conflict.revisedPlan) {
        const revisedTarget = conflict.revisedPlan.steps.find((step) => step.draftId === conflict.draftId)
        const currentTarget = Object.values(drafts).find((draft) => draft.draftId === conflict.draftId)
        const coordinateChanged = Boolean(
          revisedTarget && currentTarget && revisedTarget.coordinate !== currentTarget.coordinate,
        )
        const rebased = coordinateChanged
          ? rebaseNewGeometryDraftConflict(drafts, conflict.draftId, revisedTarget!.version)
          : null
        if (rebased) {
          const byId = new Map(Object.values(rebased.drafts).map((draft) => [draft.draftId, draft]))
          const nextRequest = {
            ...request,
            drafts: request.drafts.map((input) => {
              const draft = byId.get(input.draftId)
              return {
                ...input,
                ...(draft ? { source: draft.source } : {}),
                ...(input.draftId === conflict.draftId ? { version: rebased.nextVersion } : {}),
              }
            }),
          }
          setDrafts(rebased.drafts)
          setPreviewDrafts(rebased.drafts)
          if (selectedCoordinate === rebased.previousCoordinate) setSelectedCoordinate(rebased.nextCoordinate)
          setPreviewStale(true)
          const value = await geometryApi.planPublish(nextRequest)
          setPublishPlan({ request: nextRequest, value })
          toast.error(`${conflict.coordinate} 충돌로 ${rebased.nextCoordinate} 계획을 다시 계산했습니다.`)
          return value
        }
        if (revisedTarget) {
          setDrafts((current) =>
            Object.fromEntries(
              Object.entries(current).map(([coordinate, draft]) => [
                coordinate,
                draft.draftId === conflict.draftId ? { ...draft, version: revisedTarget.version } : draft,
              ]),
            ),
          )
        }
        setPublishPlan({ request, value: conflict.revisedPlan })
        toast.error(
          `${conflict.coordinate} 충돌로 ${revisedTarget?.coordinate ?? conflict.suggestedVersion} 계획을 다시 계산했습니다.`,
        )
        return conflict.revisedPlan
      }
      const rebased = rebaseNewGeometryDraftConflict(drafts, conflict.draftId, conflict.suggestedVersion)
      if (rebased) {
        const byId = new Map(Object.values(rebased.drafts).map((draft) => [draft.draftId, draft]))
        const nextRequest = {
          ...request,
          drafts: request.drafts.map((input) => {
            const draft = byId.get(input.draftId)
            return {
              ...input,
              ...(draft ? { source: draft.source } : {}),
              ...(input.draftId === conflict.draftId ? { version: rebased.nextVersion } : {}),
            }
          }),
        }
        setDrafts(rebased.drafts)
        setPreviewDrafts(rebased.drafts)
        if (selectedCoordinate === rebased.previousCoordinate) setSelectedCoordinate(rebased.nextCoordinate)
        setPreviewStale(true)
        const value = await geometryApi.planPublish(nextRequest)
        setPublishPlan({ request: nextRequest, value })
        toast.error(`${conflict.coordinate} 충돌로 ${rebased.nextCoordinate} 계획을 다시 계산했습니다.`)
        return value
      }
      return null
    },
    [drafts, selectedCoordinate],
  )

  const requestPublish = useCallback(
    async (coordinate: GeometryCoordinate, apply: boolean) => {
      setBusy(true)
      try {
        const request = publishRequest(coordinate, apply)
        let value: Awaited<ReturnType<typeof geometryApi.planPublish>>
        try {
          value = await geometryApi.planPublish(request)
        } catch (cause) {
          const parsed =
            cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
          if (!parsed?.success) throw cause
          const recovered = await recoverPublishConflict(request, parsed.data)
          if (!recovered) throw cause
          return recovered
        }
        setPublishPlan({ request, value })
        return value
      } finally {
        setBusy(false)
      }
    },
    [publishRequest, recoverPublishConflict],
  )

  const confirmPublish = useCallback(async () => {
    if (!publishPlan) return null
    setBusy(true)
    try {
      let result: Awaited<ReturnType<typeof geometryApi.publish>>
      try {
        result = await geometryApi.publish({ ...publishPlan.request, planHash: publishPlan.value.planHash })
      } catch (cause) {
        const parsed =
          cause instanceof ApiError && cause.status === 409 ? geometryApi.parsePublishConflict(cause.body) : null
        if (!parsed?.success) throw cause
        const conflict = parsed.data
        if (await recoverPublishConflict(publishPlan.request, conflict)) return null
        setPublishPlan(null)
        throw new Error(
          `${conflict.coordinate}가 이미 존재합니다. 제안 version ${conflict.suggestedVersion}으로 다시 계획하세요.`,
        )
      }
      const publishedDraftIds = new Set(
        publishPlan.value.steps
          .filter((step) => result.published.some((item) => item.coordinate === step.coordinate))
          .map((step) => step.draftId),
      )
      setDrafts((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([, draft]) => !publishedDraftIds.has(draft.draftId)),
        )
        setStagedModules((modules) => retainReferencedStagedModules(next, modules))
        return next
      })
      setPreviewDrafts((current) =>
        Object.fromEntries(Object.entries(current).filter(([, draft]) => !publishedDraftIds.has(draft.draftId))),
      )
      if (publishPlan.request.mode === 'publish-and-apply') {
        onSnapshotChange(result.geometrySnapshot)
        const targetStep = publishPlan.value.steps.find(
          (step) => step.draftId === publishPlan.request.targetDraftId && !step.generated,
        )
        setSelectedCoordinate(targetStep?.coordinate ?? result.geometrySnapshot.roots[0]?.coordinate ?? null)
      } else {
        const selectedExists = currentSnapshot.modules.some((module) => module.coordinate === selectedCoordinate)
        if (!selectedExists) setSelectedCoordinate(currentSnapshot.roots[0]?.coordinate ?? null)
      }
      setPublishPlan(null)
      setPreviewStale(true)
      setPreviewError(null)
      await queryClient.invalidateQueries({ queryKey: ['geometry'] })
      toast.success(
        publishPlan.request.mode === 'publish-and-apply'
          ? `${result.published.length}개 Geometry version을 발행하고 Experiment graph에 적용했습니다.`
          : `${result.published.length}개 Geometry version을 발행했습니다.`,
      )
      return result
    } finally {
      setBusy(false)
    }
  }, [
    currentSnapshot.modules,
    currentSnapshot.roots,
    onSnapshotChange,
    publishPlan,
    queryClient,
    recoverPublishConflict,
    selectedCoordinate,
  ])

  return {
    addRoot,
    addPublishedImport,
    archiveRepository,
    archiveVersion,
    attachDraftImport,
    busy,
    confirmPublish,
    createRepository,
    createDraft,
    currentSnapshot,
    checkLatestVersion,
    discardDraft,
    draftOverlay,
    drafts,
    draftState,
    editAsNewVersion,
    editPublishedVersion,
    effectiveGraph,
    effectiveRoots,
    expandedPaths,
    namespace,
    previewError,
    previewBusy,
    previewDiagnostics,
    previewDraftActive,
    previewScene,
    previewSceneHash,
    previewStale,
    publishPlan,
    refreshRepositories,
    repositories,
    requestPublish,
    reset,
    restore,
    removeRoot,
    selectedCoordinate,
    setBump,
    setNamespace,
    setPreviewError,
    setPreviewStale,
    setPublishPlan,
    setSelectedCoordinate,
    stagedModules,
    togglePath,
    updateSource,
  }
}

export type GeometryWorkspaceState = ReturnType<typeof useGeometryWorkspaceState>
