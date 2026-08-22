import { LoaderCircle, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, type FormEvent } from 'react'
import { toast } from 'sonner'
import { dbTables, getListRequest } from '@/api'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/use-auth'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import type { GeometryModuleCoordinate } from '@/lib/cad'
import { cn } from '@/lib/utils'
import { GeometryExampleDetail } from './GeometryExampleDetail'
import { GeometryManagerDetail } from './GeometryManagerDetail'
import { GeometryManagerDialogs } from './GeometryManagerDialogs'
import { GeometryPackageList } from './GeometryPackageList'
import { GeometryWorkspaceDetail } from './GeometryWorkspaceDetail'
import {
  GEOMETRY_MANAGER_ALL,
  type GeometryManagerListRow,
  type GeometryManagerRibbonState,
} from './geometryManagerTypes'
import { geometryCoordinateNamespace, geometryCoordinateRepository } from './geometryWorkspaceModel'
import { useGeometryManagerData } from './useGeometryManagerData'
import { useGeometryManagerController } from './useGeometryManagerController'
import { useGeometryManagerMutations } from './useGeometryManagerMutations'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

const PAGE_SIZES = [12, 24, 48] as const

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type GeometryManagerProps = {
  geometry: GeometryManagerState
  onOpenGeometrySource: () => void
  onOpenExperiment: (experimentId: number) => void | Promise<void>
  onUse: (versionId: number, exportName: string, alias: string) => string | Promise<string>
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
  onRibbonStateChange?: (state: GeometryManagerRibbonState | null) => void
}

export function GeometryManager(props: GeometryManagerProps) {
  return (
    <section aria-label="Geometry Manager" className="h-full min-h-0 overflow-hidden">
      <WorkspaceGeometryManager {...props} />
    </section>
  )
}

function WorkspaceGeometryManager({
  geometry,
  onAuthoringStateChange,
  onRibbonStateChange,
  onOpenGeometrySource,
  onOpenExperiment,
  onUse,
}: GeometryManagerProps) {
  const auth = useAuth()
  const onUseRef = useRef(onUse)
  onUseRef.current = onUse
  const previewPublishedVersion = geometry.previewPublishedVersion
  const previewSource = geometry.previewSource
  const startVersionDraft = geometry.startVersionDraft
  const requestPublish = geometry.requestPublish
  const discardDraft = geometry.discardDraft
  const setSelectedCoordinate = geometry.setSelectedCoordinate
  const setSelectedCatalogKey = geometry.setSelectedCatalogKey
  const setManagerView = geometry.setManagerView
  const isAdmin = Boolean(auth.user?.roles.includes('admin'))
  const controller = useGeometryManagerController({ geometry })
  const {
    search,
    setSearch,
    page,
    setPage,
    pageSize,
    setPageSize,
    ownerFilter,
    setOwnerFilter,
    archiveFilter,
    setArchiveFilter,
    selectedPackageId,
    setSelectedPackageId,
    selectedVersionId,
    setSelectedVersionId,
    pendingVersionId,
    setPendingVersionId,
    selectedDraftCoordinate,
    setSelectedDraftCoordinate,
    checkedPackageIds,
    setCheckedPackageIds,
    experimentSearch,
    setExperimentSearch,
    experimentPage,
    setExperimentPage,
    usageExample,
    setUsageExample,
    createDialogOpen,
    setCreateDialogOpen,
    createRepositoryId,
    setCreateRepositoryId,
    forkDetail,
    setForkDetail,
    forkRepositoryId,
    setForkRepositoryId,
    repositoryManagerOpen,
    setRepositoryManagerOpen,
    workspaceSettingsOpen,
    setWorkspaceSettingsOpen,
    mobileDetailOpen,
    setMobileDetailOpen,
    changeNamespace,
    changeRepository,
    resetFilters,
    selectExample,
    selectDraft,
    selectPackage,
    selectVersion,
    openDraft,
  } = controller
  const selectedNamespace = controller.filters.namespace
  const selectedRepositoryFilter = controller.filters.repository
  const appliedInitialVersionIdRef = useRef<number | null>(null)
  const draftVersions = useMemo(() => Object.values(geometry.draftVersions), [geometry.draftVersions])
  const sessionDraftVersions = useMemo(
    () =>
      draftVersions.filter(
        (draft) =>
          draft.packageId === null &&
          (selectedNamespace === GEOMETRY_MANAGER_ALL ||
            geometryCoordinateNamespace(draft.coordinate) === selectedNamespace) &&
          (selectedRepositoryFilter === GEOMETRY_MANAGER_ALL ||
            geometryCoordinateRepository(draft.coordinate) === selectedRepositoryFilter),
      ),
    [draftVersions, selectedNamespace, selectedRepositoryFilter],
  )
  const visibleSessionDraftVersions = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return sessionDraftVersions
    return sessionDraftVersions.filter((draft) =>
      `${draft.repository}/${draft.packageName}`.toLowerCase().includes(query),
    )
  }, [search, sessionDraftVersions])
  const selectedDraft = selectedDraftCoordinate ? (geometry.draftVersions[selectedDraftCoordinate] ?? null) : null
  const {
    dependentsQuery,
    examplesListVisible,
    examplesVisible,
    experimentsQuery,
    initialVersionQuery,
    listScope,
    namespaces,
    officialDetailQuery,
    officialListQuery,
    owners,
    packagesQuery,
    repositoriesQuery,
    repositoryOptions,
    resolvedQuery,
    selectedPackage,
    selectedVersion,
    usageQuery,
    versions,
    workspaceListVisible,
    workspaceVisible,
  } = useGeometryManagerData({
    authenticated: auth.isAuthenticated,
    draftVersions,
    experimentPage,
    experimentSearch,
    filters: controller.filters,
    geometry,
    isAdmin,
    selectedPackageId,
    selectedVersionId,
  })
  const selectedPackageDraft = draftVersions.find((draft) => draft.packageId === selectedPackageId) ?? null

  useEffect(() => {
    if (!examplesVisible || geometry.managerView !== 'examples') return
    const items = officialListQuery.data?.items ?? []
    if (geometry.selectedCatalogKey === null && items.length > 0) {
      setSelectedCatalogKey(items[0]?.key ?? null)
    }
  }, [
    examplesVisible,
    geometry.managerView,
    geometry.selectedCatalogKey,
    officialListQuery.data?.items,
    setSelectedCatalogKey,
  ])
  useEffect(() => {
    if (geometry.managerView !== 'examples' || !officialDetailQuery.data?.source) return
    try {
      previewSource(officialDetailQuery.data.source)
    } catch (error) {
      toast.error(message(error))
    }
  }, [geometry.managerView, officialDetailQuery.data?.source, previewSource])
  useEffect(() => {
    setPage(0)
  }, [archiveFilter, ownerFilter, pageSize, search, selectedNamespace, selectedRepositoryFilter, setPage])
  useEffect(() => {
    setExperimentPage(0)
  }, [experimentSearch, selectedVersionId, setExperimentPage])
  useEffect(() => {
    const initialVersion = initialVersionQuery.data?.items[0]
    if (!initialVersion || appliedInitialVersionIdRef.current === initialVersion.id) return
    appliedInitialVersionIdRef.current = initialVersion.id
    setManagerView('workspace')
    setSelectedPackageId(initialVersion.package_id)
    setSelectedVersionId(initialVersion.id)
  }, [initialVersionQuery.data?.items, setManagerView, setSelectedPackageId, setSelectedVersionId])
  useEffect(() => {
    if (!workspaceVisible || geometry.managerView !== 'workspace' || selectedPackageId || selectedDraftCoordinate)
      return
    if (initialVersionQuery.data?.items[0]) return
    const firstDraft = visibleSessionDraftVersions[0]
    if (firstDraft) {
      setSelectedDraftCoordinate(firstDraft.coordinate)
      setSelectedCoordinate(firstDraft.coordinate)
      return
    }
    if (packagesQuery.data?.items[0]) setSelectedPackageId(packagesQuery.data.items[0].id)
  }, [
    setSelectedCoordinate,
    initialVersionQuery.data?.items,
    geometry.managerView,
    packagesQuery.data?.items,
    selectedDraftCoordinate,
    selectedPackageId,
    setSelectedDraftCoordinate,
    setSelectedPackageId,
    visibleSessionDraftVersions,
    workspaceVisible,
  ])
  useEffect(() => {
    if (selectedDraftCoordinate && !geometry.draftVersions[selectedDraftCoordinate]) {
      setSelectedDraftCoordinate(null)
      return
    }
    if (
      selectedPackageId === null &&
      geometry.selectedCoordinate &&
      geometry.draftVersions[geometry.selectedCoordinate]
    ) {
      setSelectedDraftCoordinate(geometry.selectedCoordinate)
    }
  }, [
    geometry.draftVersions,
    geometry.selectedCoordinate,
    selectedDraftCoordinate,
    selectedPackageId,
    setSelectedDraftCoordinate,
  ])
  useEffect(() => {
    if (!selectedPackageId || !geometry.selectedCoordinate || geometry.draftVersions[geometry.selectedCoordinate])
      return
    const published = versions.find((version) => version.coordinate === geometry.selectedCoordinate)
    if (published && published.id !== selectedVersionId) setSelectedVersionId(published.id)
  }, [
    geometry.draftVersions,
    geometry.selectedCoordinate,
    selectedPackageId,
    selectedVersionId,
    setSelectedVersionId,
    versions,
  ])
  useEffect(() => {
    if (!versions.length) {
      if (pendingVersionId !== null) return
      setSelectedVersionId(null)
      return
    }
    if (pendingVersionId !== null) {
      if (versions.some((item) => item.id === pendingVersionId)) {
        setSelectedVersionId(pendingVersionId)
        setPendingVersionId(null)
      }
      return
    }
    if (!versions.some((item) => item.id === selectedVersionId)) setSelectedVersionId(versions[0].id)
  }, [pendingVersionId, selectedVersionId, setPendingVersionId, setSelectedVersionId, versions])
  useEffect(() => {
    if (!selectedVersionId) return
    void previewPublishedVersion(selectedVersionId).catch((error: unknown) => toast.error(message(error)))
  }, [previewPublishedVersion, selectedVersionId])

  const {
    archiveVersionMutation,
    deletePackagesMutation,
    deleteVersionMutation,
    invalidate,
    localVersionIds,
    namespaceMutation,
  } = useGeometryManagerMutations({
    geometry,
    listScope,
    selectedPackageId,
    selectedVersionId,
    setCheckedPackageIds,
    setSelectedPackageId,
    setSelectedVersionId,
  })
  const archiveVersion = archiveVersionMutation.mutate
  const deleteVersion = deleteVersionMutation.mutate
  const deletePackages = deletePackagesMutation.mutate
  const usage = usageQuery.data?.items.find((item) => item.versionId === selectedVersionId)
  const versionDeleteBlocked =
    !selectedVersion || !usage?.deletable || localVersionIds.has(selectedVersion.id) || deleteVersionMutation.isPending
  const packageUsageSafe = versions.every((version) => {
    const item = usageQuery.data?.items.find((entry) => entry.versionId === version.id)
    return (
      Boolean(item) &&
      item!.experimentCount === 0 &&
      item!.dependentVersionIds.every((dependentId) => versions.some((candidate) => candidate.id === dependentId)) &&
      !localVersionIds.has(version.id)
    )
  })

  const geometryListRows = useMemo<GeometryManagerListRow[]>(
    () =>
      [
        ...(examplesListVisible
          ? (officialListQuery.data?.items ?? []).map((item) => ({
              kind: 'example' as const,
              item,
              sortKey: `examples/${item.repository}/${item.key}`,
            }))
          : []),
        ...(workspaceListVisible
          ? visibleSessionDraftVersions.map((item) => ({
              kind: 'draft' as const,
              item,
              sortKey: `${geometryCoordinateNamespace(item.coordinate)}/${item.repository}/${item.packageName}`,
            }))
          : []),
        ...(auth.isAuthenticated && workspaceListVisible
          ? (packagesQuery.data?.items ?? []).map((item) => ({
              kind: 'package' as const,
              item,
              sortKey: `${item.namespace}/${item.repository}/${item.name}`,
            }))
          : []),
      ].sort((left, right) => left.sortKey.localeCompare(right.sortKey)),
    [
      auth.isAuthenticated,
      examplesListVisible,
      officialListQuery.data?.items,
      packagesQuery.data?.items,
      visibleSessionDraftVersions,
      workspaceListVisible,
    ],
  )
  const selectedOutsideFilter = useMemo(() => {
    if (geometry.managerView === 'examples' && geometry.selectedCatalogKey !== null) {
      return (
        !officialListQuery.isLoading &&
        !geometryListRows.some((row) => row.kind === 'example' && row.item.key === geometry.selectedCatalogKey)
      )
    }
    if (selectedDraftCoordinate !== null) {
      return !geometryListRows.some((row) => row.kind === 'draft' && row.item.coordinate === selectedDraftCoordinate)
    }
    if (selectedPackageId !== null) {
      return (
        !packagesQuery.isLoading &&
        !geometryListRows.some((row) => row.kind === 'package' && row.item.id === selectedPackageId)
      )
    }
    return false
  }, [
    geometry.managerView,
    geometry.selectedCatalogKey,
    geometryListRows,
    officialListQuery.isLoading,
    packagesQuery.isLoading,
    selectedDraftCoordinate,
    selectedPackageId,
  ])

  const submitGeometry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      if (auth.isAuthenticated && createRepositoryId === null) throw new Error('Repository를 선택하세요.')
      const coordinate = geometry.createDraft({
        repositoryId: auth.isAuthenticated ? createRepositoryId : null,
        repository: auth.isAuthenticated
          ? (geometry.repositories.find((item) => item.id === createRepositoryId)?.slug ?? '')
          : String(form.get('repository') ?? '').trim(),
        packageName: String(form.get('package') ?? '').trim(),
        description: String(form.get('description') ?? '').trim(),
        source: String(form.get('source') ?? ''),
      })
      selectDraft(coordinate)
      setCreateDialogOpen(false)
      setCreateRepositoryId(null)
    } catch (cause) {
      toast.error(message(cause))
    }
  }
  const submitFork = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!forkDetail) return
    const form = new FormData(event.currentTarget)
    const selectedRepositoryId = forkRepositoryId
    const packageName = String(form.get('package') ?? '').trim()
    void (async () => {
      if (!auth.isAuthenticated) throw new Error('Examples Fork는 로그인 후 사용할 수 있습니다.')
      if (!geometry.namespace) throw new Error('기본 Geometry namespace를 먼저 설정하세요.')
      const matchingRepository = geometry.repositories.find((item) => item.id === selectedRepositoryId)
      if (!matchingRepository || matchingRepository.archived_at !== null) {
        throw new Error('Fork할 Repository를 선택하세요.')
      }
      const repository = matchingRepository.slug
      const repositoryId = matchingRepository.id
      if (matchingRepository) {
        const response = await dbTables.GeometryPackage.listRows({
          ...getListRequest('mine'),
          limit: 100,
          text_filter: { name: [packageName] },
          filter: { repository_id: [matchingRepository.id, matchingRepository.id] },
        })
        if (response.items.some((item) => item.repository_id === matchingRepository.id && item.name === packageName)) {
          throw new Error(
            `${matchingRepository.namespace}/${matchingRepository.slug}/${packageName} Package가 이미 있습니다. 다른 이름을 사용하세요.`,
          )
        }
      }
      const coordinate = geometry.forkOfficial({
        key: forkDetail.key,
        repository,
        packageName,
        source: forkDetail.source,
        description: forkDetail.description,
        repositoryId,
      })
      selectDraft(coordinate)
      setForkDetail(null)
    })().catch((cause: unknown) => toast.error(message(cause)))
  }
  const handleDraftDiscard = useCallback(
    (discarded: (typeof draftVersions)[number]) => {
      setSelectedDraftCoordinate(null)
      if (discarded.originCatalogKey) {
        setSelectedCatalogKey(discarded.originCatalogKey)
        setManagerView('examples')
      } else if (discarded.baseGeometryVersionId) {
        setSelectedVersionId(discarded.baseGeometryVersionId)
        void previewPublishedVersion(discarded.baseGeometryVersionId).catch((cause: unknown) =>
          toast.error(message(cause)),
        )
      }
    },
    [previewPublishedVersion, setManagerView, setSelectedCatalogKey, setSelectedDraftCoordinate, setSelectedVersionId],
  )

  const openSelectedVersionDraft = useCallback(() => {
    try {
      const coordinate = selectedPackageDraft
        ? selectedPackageDraft.coordinate
        : selectedVersion
          ? startVersionDraft({
              versionId: selectedVersion.id,
              coordinate: selectedVersion.coordinate as GeometryModuleCoordinate,
              source: selectedVersion.source,
              description: selectedVersion.description ?? '',
              repositoryId: selectedPackage!.repository_id,
              packageId: selectedPackage!.id,
            })
          : null
      if (!coordinate) return
      openDraft(coordinate)
    } catch (cause) {
      toast.error(message(cause))
    }
  }, [openDraft, selectedPackage, selectedPackageDraft, selectedVersion, startVersionDraft])

  const useSelectedVersion = useCallback(() => {
    if (!selectedVersion) return
    const exports = resolvedQuery.data?.root.exports ?? []
    const exportName =
      exports.length === 1
        ? exports[0]
        : window.prompt(`사용할 named export를 입력하세요.\n${exports.join(', ')}`, exports[0])?.trim()
    if (!exportName || !exports.includes(exportName)) {
      toast.error('Published Geometry의 named export를 선택하세요.')
      return
    }
    const alias = window.prompt('geometry.tsx에서 사용할 local alias', exportName)?.trim()
    if (!alias) return
    void Promise.resolve(onUseRef.current(selectedVersion.id, exportName, alias))
      .then((snippet) => setUsageExample(snippet))
      .catch((cause: unknown) => toast.error(message(cause)))
  }, [resolvedQuery.data?.root.exports, selectedVersion, setUsageExample])

  const archiveSelectedVersion = useCallback(() => {
    if (selectedVersion) archiveVersion(selectedVersion.id)
  }, [archiveVersion, selectedVersion])

  const deleteSelectedVersion = useCallback(() => {
    if (!selectedVersion) return
    if (window.confirm(`${selectedVersion.coordinate}를 삭제할까요?`)) {
      deleteVersion(selectedVersion.id)
    }
  }, [deleteVersion, selectedVersion])

  const deleteSelectedPackage = useCallback(() => {
    if (!selectedPackage) return
    if (window.confirm(`${selectedPackage.name} Package와 모든 Version을 삭제할까요?`)) {
      deletePackages([selectedPackage.id])
    }
  }, [deletePackages, selectedPackage])

  const forkSelectedExample = useCallback(() => {
    if (!officialDetailQuery.data) return
    setForkRepositoryId(null)
    setForkDetail(officialDetailQuery.data)
  }, [officialDetailQuery.data, setForkDetail, setForkRepositoryId])

  const ribbonState = useMemo<GeometryManagerRibbonState>(
    () => ({
      authenticated: auth.isAuthenticated,
      filters: controller.filters,
      isAdmin,
      namespaces,
      owners,
      repositoryOptions,
      filterActions: {
        archive: setArchiveFilter,
        namespace: changeNamespace,
        owner: setOwnerFilter,
        repository: changeRepository,
        reset: resetFilters,
        search: setSearch,
      },
      selection: controller.selection,
      selectionLabel:
        officialDetailQuery.data?.title ??
        selectedDraft?.packageName ??
        selectedPackage?.name ??
        '선택된 Geometry 없음',
      actions: {
        newGeometry: { label: '새 Geometry', onSelect: () => setCreateDialogOpen(true) },
        refresh: { label: '새로고침', onSelect: () => void invalidate() },
        resetFilters: { label: '필터 초기화', onSelect: resetFilters },
        repositoryManager: {
          label: 'Repository 관리',
          onSelect: () => setRepositoryManagerOpen(true),
          disabled: !auth.isAuthenticated,
          disabledReason: !auth.isAuthenticated ? '로그인 후 사용할 수 있습니다.' : undefined,
        },
        workspaceSettings: {
          label: 'Workspace 설정',
          onSelect: () => setWorkspaceSettingsOpen(true),
          disabled: !auth.isAuthenticated,
          disabledReason: !auth.isAuthenticated ? '로그인 후 사용할 수 있습니다.' : undefined,
        },
        forkExample: {
          label: 'Example Fork',
          onSelect: forkSelectedExample,
          disabled: !officialDetailQuery.data || !auth.isAuthenticated || !geometry.namespace,
          disabledReason: !auth.isAuthenticated
            ? '로그인 후 사용할 수 있습니다.'
            : !geometry.namespace
              ? '기본 Geometry namespace를 먼저 설정하세요.'
              : !officialDetailQuery.data
                ? 'Example을 선택하세요.'
                : undefined,
        },
        editVersion: {
          label: selectedPackageDraft ? 'Draft 열기' : '새 Version 편집',
          onSelect: openSelectedVersionDraft,
          disabled:
            !selectedPackageDraft &&
            (!selectedVersion ||
              Boolean(selectedVersion.archived_at) ||
              selectedPackage?.repository_archived_at !== null),
          disabledReason: !selectedVersion && !selectedPackageDraft ? 'Published Version을 선택하세요.' : undefined,
        },
        useInExperiment: {
          label: 'Experiment에서 사용',
          onSelect: useSelectedVersion,
          disabled:
            !selectedVersion ||
            Boolean(selectedVersion.archived_at) ||
            resolvedQuery.isLoading ||
            !(resolvedQuery.data?.root.exports?.length ?? 0),
          disabledReason: !selectedVersion
            ? 'Published Version을 선택하세요.'
            : resolvedQuery.isLoading
              ? 'Published Version source를 불러오는 중입니다.'
              : !(resolvedQuery.data?.root.exports?.length ?? 0)
                ? '사용할 named export가 없습니다.'
                : undefined,
        },
        publishDraft: {
          label: '새 Version 발행',
          onSelect: () => {
            if (selectedDraft)
              void requestPublish(selectedDraft.coordinate).catch((cause) => toast.error(message(cause)))
          },
          disabled: !selectedDraft || !auth.isAuthenticated || geometry.busy || !geometry.publishReady,
          disabledReason: !auth.isAuthenticated
            ? '로그인 후 사용할 수 있습니다.'
            : !selectedDraft
              ? 'Draft를 선택하세요.'
              : geometry.previewStale
                ? 'Preview가 최신 상태가 아닙니다.'
                : undefined,
        },
        discardDraft: {
          label: 'Draft 되돌리기',
          onSelect: () => {
            if (selectedDraft) {
              try {
                discardDraft(selectedDraft.coordinate)
                handleDraftDiscard(selectedDraft)
              } catch (cause) {
                toast.error(message(cause))
              }
            }
          },
          disabled: !selectedDraft,
          disabledReason: !selectedDraft ? 'Draft를 선택하세요.' : undefined,
        },
        archiveVersion: {
          label: 'Archive',
          onSelect: archiveSelectedVersion,
          disabled: !selectedVersion || Boolean(selectedVersion.archived_at) || archiveVersionMutation.isPending,
          disabledReason: !selectedVersion ? 'Published Version을 선택하세요.' : undefined,
        },
        deleteVersion: {
          label: 'Version 삭제',
          onSelect: deleteSelectedVersion,
          disabled: versionDeleteBlocked,
          disabledReason: versionDeleteBlocked ? '참조 중인 Version은 삭제할 수 없습니다.' : undefined,
          destructive: true,
        },
        deletePackage: {
          label: 'Package 삭제',
          onSelect: deleteSelectedPackage,
          disabled: !selectedPackage || !packageUsageSafe || deletePackagesMutation.isPending,
          disabledReason: !selectedPackage
            ? 'Package를 선택하세요.'
            : !packageUsageSafe
              ? '참조 중인 Package는 삭제할 수 없습니다.'
              : undefined,
          destructive: true,
        },
      },
    }),
    [
      archiveSelectedVersion,
      archiveVersionMutation.isPending,
      auth.isAuthenticated,
      changeNamespace,
      changeRepository,
      controller.filters,
      controller.selection,
      deletePackagesMutation.isPending,
      deleteSelectedPackage,
      deleteSelectedVersion,
      discardDraft,
      forkSelectedExample,
      geometry.namespace,
      geometry.busy,
      geometry.publishReady,
      geometry.previewStale,
      handleDraftDiscard,
      invalidate,
      isAdmin,
      namespaces,
      officialDetailQuery.data,
      openSelectedVersionDraft,
      owners,
      packageUsageSafe,
      repositoryOptions,
      requestPublish,
      resetFilters,
      selectedDraft,
      selectedPackage,
      selectedPackageDraft,
      selectedVersion,
      resolvedQuery.data?.root.exports?.length,
      resolvedQuery.isLoading,
      setArchiveFilter,
      setCreateDialogOpen,
      setOwnerFilter,
      setRepositoryManagerOpen,
      setSearch,
      setWorkspaceSettingsOpen,
      useSelectedVersion,
      versionDeleteBlocked,
    ],
  )

  const ribbonStateSnapshot = JSON.stringify(ribbonState, (_key, value) =>
    typeof value === 'function' ? undefined : value,
  )
  const lastRibbonStateSnapshotRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastRibbonStateSnapshotRef.current === ribbonStateSnapshot) return
    lastRibbonStateSnapshotRef.current = ribbonStateSnapshot
    onRibbonStateChange?.(ribbonState)
  }, [onRibbonStateChange, ribbonState, ribbonStateSnapshot])
  useEffect(() => () => onRibbonStateChange?.(null), [onRibbonStateChange])

  return (
    <div className="grid h-full min-h-[34rem] grid-cols-1 overflow-hidden lg:grid-cols-[minmax(20rem,32%)_minmax(0,1fr)]">
      <aside className={cn('flex min-h-0 flex-col border-r bg-muted/10', mobileDetailOpen && 'hidden lg:flex')}>
        <div className="space-y-3 border-b p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Geometry Packages</h2>
              <p className="text-xs text-muted-foreground">{geometryListRows.length}개 항목</p>
            </div>
            <div className="flex gap-2">
              {auth.isAuthenticated ? (
                <Button
                  disabled={!checkedPackageIds.size || deletePackagesMutation.isPending}
                  onClick={() => {
                    const ids = [...checkedPackageIds]
                    if (window.confirm(`${ids.length}개 Package를 삭제할까요? 참조 중이면 서버가 거부합니다.`)) {
                      deletePackagesMutation.mutate(ids)
                    }
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Trash2 /> 선택 삭제
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        <GeometryPackageList
          authenticated={auth.isAuthenticated}
          checkedPackageIds={checkedPackageIds}
          examplesError={officialListQuery.isError}
          examplesLoading={officialListQuery.isLoading}
          examplesVisible={examplesListVisible}
          managerView={geometry.managerView}
          onNextPage={() => setPage((value) => value + 1)}
          onPageSizeChange={(value) => setPageSize(value as (typeof PAGE_SIZES)[number])}
          onSelectDraft={selectDraft}
          onSelectExample={selectExample}
          onSelectPackage={selectPackage}
          onTogglePackage={(id) => {
            setCheckedPackageIds((current) => {
              const next = new Set(current)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }}
          page={page}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          rows={geometryListRows}
          selectedCatalogKey={geometry.selectedCatalogKey}
          selectedDraftCoordinate={selectedDraftCoordinate}
          selectedPackageId={selectedPackageId}
          total={packagesQuery.data?.total ?? 0}
          workspaceError={packagesQuery.isError}
          workspaceLoading={packagesQuery.isLoading}
          workspaceVisible={workspaceListVisible}
        />
      </aside>

      <GeometryManagerDetail
        mobileOpen={mobileDetailOpen}
        onBack={() => setMobileDetailOpen(false)}
        outsideFilter={selectedOutsideFilter}
      >
        {geometry.managerView === 'examples' ? (
          officialDetailQuery.isLoading ? (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : officialDetailQuery.isError ? (
            <div className="grid h-full place-items-center text-sm text-destructive">
              Example Geometry detail을 불러오지 못했습니다.
            </div>
          ) : officialDetailQuery.data ? (
            <GeometryExampleDetail
              authenticated={auth.isAuthenticated}
              detail={officialDetailQuery.data}
              namespace={geometry.namespace}
              onAuthoringStateChange={onAuthoringStateChange}
              onFork={() => {
                setForkRepositoryId(null)
                setForkDetail(officialDetailQuery.data)
              }}
              previewError={geometry.previewError}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              Example Geometry를 선택하세요.
            </div>
          )
        ) : (
          <GeometryWorkspaceDetail
            archivePending={archiveVersionMutation.isPending}
            authenticated={auth.isAuthenticated}
            dependents={dependentsQuery.data?.items ?? []}
            dependentsTotal={dependentsQuery.data?.total ?? 0}
            experimentPage={experimentPage}
            experiments={experimentsQuery.data?.items ?? []}
            experimentsRefetch={experimentsQuery.refetch}
            experimentsTotal={experimentsQuery.data?.total ?? 0}
            experimentSearch={experimentSearch}
            geometry={geometry}
            onArchiveVersion={archiveSelectedVersion}
            onAuthoringStateChange={onAuthoringStateChange}
            onDeleteVersion={deleteSelectedVersion}
            onDiscardDraft={handleDraftDiscard}
            onOpenExperiment={onOpenExperiment}
            onSelectDependent={(packageId, versionId) => {
              selectPackage(packageId)
              setPendingVersionId(versionId)
            }}
            onSelectDraft={openDraft}
            onSelectVersion={selectVersion}
            resolvedModules={resolvedQuery.data?.modules ?? []}
            selectedDraft={selectedDraft}
            selectedPackage={selectedPackage}
            selectedPackageDraft={selectedPackageDraft}
            selectedVersion={selectedVersion}
            selectedVersionId={selectedVersionId}
            setExperimentPage={setExperimentPage}
            setExperimentSearch={setExperimentSearch}
            versionDeleteBlocked={versionDeleteBlocked}
            versions={versions}
          />
        )}
      </GeometryManagerDetail>
      <GeometryManagerDialogs
        authenticated={auth.isAuthenticated}
        createDialogOpen={createDialogOpen}
        createRepositoryId={createRepositoryId}
        forkDetail={forkDetail}
        forkRepositoryId={forkRepositoryId}
        geometry={geometry}
        namespace={geometry.namespace}
        namespacePending={namespaceMutation.isPending}
        onCloseUsage={() => setUsageExample(null)}
        onOpenGeometrySource={onOpenGeometrySource}
        onSubmitFork={submitFork}
        onSubmitGeometry={submitGeometry}
        onSubmitNamespace={(value) =>
          namespaceMutation.mutate(value, {
            onSuccess: () => setWorkspaceSettingsOpen(false),
          })
        }
        repositories={repositoriesQuery.data?.items ?? geometry.repositories}
        repositoryManagerOpen={repositoryManagerOpen}
        setCreateDialogOpen={setCreateDialogOpen}
        setCreateRepositoryId={setCreateRepositoryId}
        setForkDetail={setForkDetail}
        setForkRepositoryId={setForkRepositoryId}
        setRepositoryManagerOpen={setRepositoryManagerOpen}
        setWorkspaceSettingsOpen={setWorkspaceSettingsOpen}
        usageExample={usageExample}
        workspaceSettingsOpen={workspaceSettingsOpen}
      />
    </div>
  )
}
