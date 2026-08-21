import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, type FormEvent } from 'react'
import { toast } from 'sonner'
import { dbTables, geometryApi, getListRequest, type GeometryPackageRecord } from '@/api'
import { catalogApi, catalogQueryKeys, type CatalogGeometryListItem } from '@/api/catalog'
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
  GEOMETRY_MANAGER_EXAMPLES,
  type GeometryManagerRibbonState,
} from './geometryManagerTypes'
import { useGeometryManagerController } from './useGeometryManagerController'
import type { GeometryManagerState } from './useGeometryWorkspaceState'
import type { GeometryDraftVersion } from '../types'

const PAGE_SIZES = [12, 24, 48] as const
const ALL_NAMESPACES = GEOMETRY_MANAGER_ALL
const EXAMPLES_NAMESPACE = GEOMETRY_MANAGER_EXAMPLES

type GeometryListRow =
  | { kind: 'example'; item: CatalogGeometryListItem; sortKey: string }
  | { kind: 'draft'; item: GeometryDraftVersion; sortKey: string }
  | { kind: 'package'; item: GeometryPackageRecord; sortKey: string }

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function coordinateNamespace(coordinate: string | null) {
  return coordinate?.match(/^caemble:geometry\/([^/]+)\//u)?.[1] ?? null
}

function coordinateRepository(coordinate: string | null) {
  const match = coordinate?.match(/^caemble:geometry\/([^/]+)\/([^/]+)\//u)
  return match ? `${match[1]}/${match[2]}` : null
}

type GeometryManagerProps = {
  geometry: GeometryManagerState
  initialPackageId?: number | null
  initialVersionId?: number | null
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
  initialPackageId = null,
  initialVersionId = null,
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
  const refreshRepositories = geometry.refreshRepositories
  const setSelectedCoordinate = geometry.setSelectedCoordinate
  const setSelectedCatalogKey = geometry.setSelectedCatalogKey
  const setManagerView = geometry.setManagerView
  const isAdmin = Boolean(auth.user?.roles.includes('admin'))
  const listScope = isAdmin ? 'visible' : 'mine'
  const queryClient = useQueryClient()
  const controller = useGeometryManagerController({ geometry, initialPackageId, initialVersionId })
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
  const examplesVisible = selectedNamespace === EXAMPLES_NAMESPACE || selectedNamespace === ALL_NAMESPACES
  const workspaceVisible = selectedNamespace !== EXAMPLES_NAMESPACE
  const sessionDraftVersions = useMemo(
    () =>
      draftVersions.filter(
        (draft) =>
          draft.packageId === null &&
          (selectedNamespace === ALL_NAMESPACES || coordinateNamespace(draft.coordinate) === selectedNamespace) &&
          (selectedRepositoryFilter === 'all' || coordinateRepository(draft.coordinate) === selectedRepositoryFilter),
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

  const exampleRepositoriesQuery = useQuery({
    queryKey: catalogQueryKeys.geometryRepositories,
    queryFn: () => catalogApi.listGeometryRepositories(),
  })
  const selectedExampleRepository = selectedRepositoryFilter.startsWith(`${EXAMPLES_NAMESPACE}/`)
    ? selectedRepositoryFilter.slice(EXAMPLES_NAMESPACE.length + 1)
    : undefined
  const examplesListVisible =
    examplesVisible && (selectedRepositoryFilter === 'all' || Boolean(selectedExampleRepository))
  const workspaceListVisible = workspaceVisible && !selectedRepositoryFilter.startsWith(`${EXAMPLES_NAMESPACE}/`)
  const officialListQuery = useQuery({
    enabled: examplesListVisible,
    queryKey: catalogQueryKeys.geometries({
      q: search.trim(),
      repository: selectedExampleRepository,
      limit: 200,
    }),
    queryFn: () => catalogApi.listGeometries({ q: search.trim(), repository: selectedExampleRepository, limit: 200 }),
  })
  const officialDetailQuery = useQuery({
    enabled: geometry.managerView === 'examples' && geometry.selectedCatalogKey !== null,
    queryKey: catalogQueryKeys.geometry(geometry.selectedCatalogKey ?? ''),
    queryFn: () => catalogApi.getGeometry(geometry.selectedCatalogKey!),
  })

  const repositoriesQuery = useQuery({
    enabled: auth.isAuthenticated,
    queryKey: ['geometry', 'manager', 'repositories', listScope],
    queryFn: () =>
      dbTables.GeometryRepository.listRows({
        ...getListRequest(listScope),
        limit: null,
        sort: [
          ['namespace', 'asc'],
          ['slug', 'asc'],
        ],
      }),
  })
  const namespaces = useMemo(() => {
    const values = new Set((repositoriesQuery.data?.items ?? []).map((item) => item.namespace))
    for (const draft of draftVersions) {
      const namespace = coordinateNamespace(draft.coordinate)
      if (namespace) values.add(namespace)
    }
    if (geometry.namespace) values.add(geometry.namespace)
    if (!auth.isAuthenticated) values.add('local')
    if (selectedNamespace !== ALL_NAMESPACES && selectedNamespace !== EXAMPLES_NAMESPACE) values.add(selectedNamespace)
    return [...values].sort()
  }, [auth.isAuthenticated, draftVersions, geometry.namespace, repositoriesQuery.data?.items, selectedNamespace])
  const owners = useMemo(
    () =>
      [
        ...new Set(
          (repositoriesQuery.data?.items ?? [])
            .map((item) => item.user_id)
            .filter((item): item is string => Boolean(item)),
        ),
      ].sort(),
    [repositoriesQuery.data?.items],
  )
  const repositoryOptions = useMemo(() => {
    const options: { key: string; label: string; example: boolean }[] = []
    if (examplesVisible) {
      for (const repository of exampleRepositoriesQuery.data ?? []) {
        options.push({
          key: `${EXAMPLES_NAMESPACE}/${repository.slug}`,
          label: selectedNamespace === ALL_NAMESPACES ? `Examples/${repository.title}` : repository.title,
          example: true,
        })
      }
    }
    if (workspaceVisible) {
      for (const repository of repositoriesQuery.data?.items ?? []) {
        if (selectedNamespace !== ALL_NAMESPACES && repository.namespace !== selectedNamespace) continue
        options.push({
          key: `${repository.namespace}/${repository.slug}`,
          label: selectedNamespace === ALL_NAMESPACES ? `${repository.namespace}/${repository.slug}` : repository.slug,
          example: false,
        })
      }
      for (const draft of draftVersions) {
        const key = coordinateRepository(draft.coordinate)
        const namespace = coordinateNamespace(draft.coordinate)
        if (!key || !namespace || (selectedNamespace !== ALL_NAMESPACES && namespace !== selectedNamespace)) continue
        if (!options.some((item) => item.key === key)) {
          options.push({ key, label: selectedNamespace === ALL_NAMESPACES ? key : draft.repository, example: false })
        }
      }
    }
    return options.sort((left, right) => left.label.localeCompare(right.label))
  }, [
    draftVersions,
    exampleRepositoriesQuery.data,
    examplesVisible,
    repositoriesQuery.data?.items,
    selectedNamespace,
    workspaceVisible,
  ])
  const selectedDbRepository = (repositoriesQuery.data?.items ?? []).find(
    (item) => `${item.namespace}/${item.slug}` === selectedRepositoryFilter,
  )
  const packageRequest = useMemo(
    () => ({
      ...getListRequest(listScope),
      offset: 0,
      limit: (page + 1) * pageSize,
      search_text: search.trim() || null,
      text_filter: {
        ...(selectedNamespace !== ALL_NAMESPACES && selectedNamespace !== EXAMPLES_NAMESPACE
          ? { namespace: [selectedNamespace] }
          : {}),
        ...(ownerFilter ? { owner_id: [ownerFilter] } : {}),
      },
      filter: selectedDbRepository
        ? { repository_id: [selectedDbRepository.id, selectedDbRepository.id] }
        : ({} as Record<string, unknown[]>),
      null_filter:
        archiveFilter === 'all'
          ? ({} as Record<string, 'is_null' | 'is_not_null'>)
          : {
              repository_archived_at: archiveFilter === 'active' ? ('is_null' as const) : ('is_not_null' as const),
            },
      sort: [
        ['updated_at', 'desc'],
        ['name', 'asc'],
      ] as [string, 'asc' | 'desc'][],
    }),
    [archiveFilter, listScope, ownerFilter, page, pageSize, search, selectedDbRepository, selectedNamespace],
  )
  const packagesQuery = useQuery({
    enabled: auth.isAuthenticated && workspaceListVisible,
    queryKey: ['geometry', 'manager', 'packages', packageRequest],
    queryFn: () => dbTables.GeometryPackage.listRows(packageRequest),
  })
  const selectedManagerVersionId =
    geometry.managerModules.find((module) => module.coordinate === geometry.selectedCoordinate)?.geometryVersionId ??
    null
  const requestedInitialVersionId = initialVersionId ?? selectedManagerVersionId
  const initialVersionQuery = useQuery({
    enabled: auth.isAuthenticated && initialPackageId === null && requestedInitialVersionId !== null,
    queryKey: ['geometry', 'manager', 'initial-version', requestedInitialVersionId, listScope],
    queryFn: () =>
      dbTables.GeometryVersion.listRows({
        ...getListRequest(listScope, requestedInitialVersionId ? [requestedInitialVersionId] : []),
        limit: 1,
      }),
  })
  const selectedPackageQuery = useQuery({
    enabled: auth.isAuthenticated && selectedPackageId !== null,
    queryKey: ['geometry', 'manager', 'package', selectedPackageId],
    queryFn: async () => {
      const result = await dbTables.GeometryPackage.listRows({
        ...getListRequest(listScope, selectedPackageId ? [selectedPackageId] : []),
        limit: 1,
      })
      return result.items[0] ?? null
    },
  })
  const selectedPackage = selectedPackageQuery.data ?? null
  const selectedPackageDraft = draftVersions.find((draft) => draft.packageId === selectedPackageId) ?? null
  const versionsQuery = useQuery({
    enabled: auth.isAuthenticated && selectedPackageId !== null,
    queryKey: ['geometry', 'manager', 'versions', selectedPackageId],
    queryFn: () =>
      dbTables.GeometryVersion.listRows({
        ...getListRequest(listScope),
        limit: null,
        filter: selectedPackageId ? { package_id: [selectedPackageId, selectedPackageId] } : {},
        sort: [
          ['version_major', 'desc'],
          ['version_minor', 'desc'],
          ['version_patch', 'desc'],
        ],
      }),
  })
  const versions = useMemo(() => versionsQuery.data?.items ?? [], [versionsQuery.data?.items])
  const selectedVersion = versions.find((item) => item.id === selectedVersionId) ?? null
  const resolvedQuery = useQuery({
    enabled: auth.isAuthenticated && selectedVersionId !== null,
    queryKey: ['geometry', 'manager', 'resolve', selectedVersionId],
    queryFn: () => geometryApi.resolveVersion(selectedVersionId!),
  })
  const usageQuery = useQuery({
    enabled: auth.isAuthenticated && versions.length > 0,
    queryKey: ['geometry', 'manager', 'usage', versions.map((item) => item.id)],
    queryFn: () => geometryApi.versionUsage(versions.map((item) => item.id)),
  })
  const dependentRequest = useMemo(
    () => ({ ...getListRequest(listScope), limit: 12, sort: ['updated_at', 'desc'] as [string, 'desc'] }),
    [listScope],
  )
  const dependentsQuery = useQuery({
    enabled: auth.isAuthenticated && selectedVersionId !== null,
    queryKey: ['geometry', 'manager', 'dependents', selectedVersionId],
    queryFn: () => geometryApi.listDependents(selectedVersionId!, dependentRequest),
  })
  const experimentRequest = useMemo(
    () => ({
      ...getListRequest(listScope),
      offset: experimentPage * 10,
      limit: 10,
      search_text: experimentSearch.trim() || null,
      sort: ['updated_at', 'desc'] as [string, 'desc'],
    }),
    [experimentPage, experimentSearch, listScope],
  )
  const experimentsQuery = useQuery({
    enabled: auth.isAuthenticated && selectedVersionId !== null,
    queryKey: ['geometry', 'manager', 'experiments', selectedVersionId, experimentRequest],
    queryFn: () => geometryApi.listReferencingExperiments(selectedVersionId!, experimentRequest),
  })

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
    if (initialPackageId !== null || initialVersionId !== null) setManagerView('workspace')
  }, [initialPackageId, initialVersionId, setManagerView])
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

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['geometry'] })
    await refreshRepositories()
  }, [queryClient, refreshRepositories])
  const namespaceMutation = useMutation({
    mutationFn: (value: string) => geometry.setNamespace(value),
    onSuccess: async () => {
      await invalidate()
      toast.success('기본 Geometry namespace를 변경했습니다. 기존 좌표는 유지됩니다.')
    },
    onError: (error) => toast.error(message(error)),
  })
  const archiveVersionMutation = useMutation({
    mutationFn: () => geometry.archiveVersion(selectedVersionId!),
    onSuccess: async () => {
      await invalidate()
      toast.success('Geometry version을 archive했습니다.')
    },
    onError: (error) => toast.error(message(error)),
  })
  const archiveVersion = archiveVersionMutation.mutate
  const deleteVersionMutation = useMutation({
    mutationFn: () => dbTables.GeometryVersion.deleteRows([selectedVersionId!]),
    onSuccess: async () => {
      setSelectedVersionId(null)
      await invalidate()
      toast.success('Geometry version을 삭제했습니다.')
    },
    onError: async (error) => {
      await invalidate()
      toast.error(message(error))
    },
  })
  const deleteVersion = deleteVersionMutation.mutate
  const deletePackagesMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const packageVersions = (
        await Promise.all(
          ids.map((id) =>
            dbTables.GeometryVersion.listRows({
              ...getListRequest(listScope),
              limit: null,
              filter: { package_id: [id, id] },
            }),
          ),
        )
      ).flatMap((response) => response.items)
      const localIds = new Set([
        ...geometry.currentSnapshot.modules.map((module) => module.geometryVersionId),
        ...geometry.managerModules.map((module) => module.geometryVersionId),
        ...geometry.experimentModules.map((module) => module.geometryVersionId),
        ...Object.values(geometry.draftVersions).flatMap((draft) =>
          draft.baseGeometryVersionId ? [draft.baseGeometryVersionId] : [],
        ),
      ])
      if (packageVersions.some((version) => localIds.has(version.id))) {
        throw new Error('현재 브라우저의 snapshot, staging 또는 draft가 참조하는 Package는 삭제할 수 없습니다.')
      }
      const deletingVersionIds = new Set(packageVersions.map((version) => version.id))
      const usage = await geometryApi.versionUsage([...deletingVersionIds])
      if (
        usage.items.some(
          (item) =>
            item.experimentCount > 0 ||
            item.dependentVersionIds.some((dependentId) => !deletingVersionIds.has(dependentId)),
        )
      ) {
        throw new Error('저장된 Experiment 또는 선택 밖의 Geometry가 참조하는 Package는 삭제할 수 없습니다.')
      }
      await dbTables.GeometryPackage.deleteRows(ids)
    },
    onSuccess: async (_, ids) => {
      if (selectedPackageId && ids.includes(selectedPackageId)) setSelectedPackageId(null)
      setCheckedPackageIds(new Set())
      await invalidate()
      toast.success(`${ids.length}개 Geometry package를 삭제했습니다.`)
    },
    onError: async (error) => {
      await invalidate()
      toast.error(message(error))
    },
  })
  const deletePackages = deletePackagesMutation.mutate

  const localVersionIds = useMemo(
    () =>
      new Set([
        ...geometry.currentSnapshot.modules.map((module) => module.geometryVersionId),
        ...geometry.managerModules.map((module) => module.geometryVersionId),
        ...geometry.experimentModules.map((module) => module.geometryVersionId),
        ...Object.values(geometry.draftVersions).flatMap((draft) =>
          draft.baseGeometryVersionId ? [draft.baseGeometryVersionId] : [],
        ),
      ]),
    [geometry.currentSnapshot.modules, geometry.draftVersions, geometry.experimentModules, geometry.managerModules],
  )
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

  const geometryListRows = useMemo<GeometryListRow[]>(
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
              sortKey: `${coordinateNamespace(item.coordinate)}/${item.repository}/${item.packageName}`,
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
    if (selectedVersion) archiveVersion()
  }, [archiveVersion, selectedVersion])

  const deleteSelectedVersion = useCallback(() => {
    if (!selectedVersion) return
    if (window.confirm(`${selectedVersion.coordinate}를 삭제할까요?`)) deleteVersion()
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
      selectedDraft,
      selectedExample: officialDetailQuery.data ?? null,
      selectedPackage,
      selectedVersion,
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

  const ribbonStateKey = JSON.stringify({
    archivePending: archiveVersionMutation.isPending,
    authenticated: auth.isAuthenticated,
    busy: geometry.busy,
    filters: controller.filters,
    packageId: selectedPackage?.id ?? null,
    packageSafe: packageUsageSafe,
    selection: controller.selection,
    versionDeleteBlocked,
    versionId: selectedVersion?.id ?? null,
    versionExports: resolvedQuery.data?.root.exports ?? [],
    versionResolving: resolvedQuery.isLoading,
    draftCoordinate: selectedDraft?.coordinate ?? null,
    exampleKey: officialDetailQuery.data?.key ?? null,
  })
  const lastRibbonStateKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastRibbonStateKeyRef.current === ribbonStateKey) return
    lastRibbonStateKeyRef.current = ribbonStateKey
    onRibbonStateChange?.(ribbonState)
  }, [onRibbonStateChange, ribbonState, ribbonStateKey])
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
