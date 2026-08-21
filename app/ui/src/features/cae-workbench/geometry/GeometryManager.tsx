import type { ColumnDef } from '@tanstack/react-table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { dbTables, geometryApi, getListRequest, type GeometryPackageRecord } from '@/api'
import { catalogApi, catalogQueryKeys } from '@/api/catalog'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/use-auth'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import type { GeometryModuleCoordinate } from '@/lib/cad'
import { cn } from '@/lib/utils'
import { draftGeometrySource } from './draftGeometrySource'
import { GeometryDraftVersionEditor } from './GeometryDraftVersionEditor'
import { GeometryUsageDialog } from './GeometryUsageDialog'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

const PAGE_SIZES = [12, 24, 48] as const

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type GeometryManagerProps = {
  geometry: GeometryManagerState
  initialPackageId?: number | null
  initialVersionId?: number | null
  onOpenGeometrySource: () => void
  onOpenExperiment: (experimentId: number) => void | Promise<void>
  onUse: (versionId: number, exportName: string, alias: string) => string | Promise<string>
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
}

export function GeometryManager(props: GeometryManagerProps) {
  return (
    <Tabs
      aria-label="Geometry Manager"
      className="flex h-full min-h-0 flex-col"
      value={props.geometry.managerView}
      onValueChange={(value) => props.geometry.setManagerView(value as 'official' | 'workspace')}
    >
      <TabsList className="mx-4 mt-4 grid grid-cols-2">
        <TabsTrigger value="official">Official Catalog</TabsTrigger>
        <TabsTrigger value="workspace">Workspace Packages</TabsTrigger>
      </TabsList>
      <TabsContent className="min-h-0 flex-1 overflow-hidden" value="official">
        <OfficialGeometryCatalog {...props} />
      </TabsContent>
      <TabsContent className="min-h-0 flex-1 overflow-hidden" value="workspace">
        <WorkspaceGeometryManager
          {...props}
          onReturnOfficial={(key) => {
            props.geometry.setSelectedCatalogKey(key)
            props.geometry.setManagerView('official')
          }}
        />
      </TabsContent>
    </Tabs>
  )
}

function OfficialGeometryCatalog({
  geometry,
  onAuthoringStateChange,
}: Pick<GeometryManagerProps, 'geometry' | 'onAuthoringStateChange'>) {
  const previewSource = geometry.previewSource
  const setSelectedCatalogKey = geometry.setSelectedCatalogKey
  const selectedKey = geometry.selectedCatalogKey
  const [search, setSearch] = useState('')
  const listQuery = useQuery({
    queryKey: catalogQueryKeys.geometries({ q: search.trim(), limit: 100 }),
    queryFn: () => catalogApi.listGeometries({ q: search.trim(), limit: 100 }),
  })
  const detailQuery = useQuery({
    queryKey: catalogQueryKeys.geometry(selectedKey ?? ''),
    queryFn: () => catalogApi.getGeometry(selectedKey!),
    enabled: selectedKey !== null,
  })
  const detailSource = detailQuery.data?.source
  const selectedDraft = Object.values(geometry.draftVersions).find((draft) => draft.originCatalogKey === selectedKey)

  useEffect(() => {
    const items = listQuery.data?.items ?? []
    if (!items.some((item) => item.key === selectedKey)) setSelectedCatalogKey(items[0]?.key ?? null)
  }, [listQuery.data?.items, selectedKey, setSelectedCatalogKey])
  useEffect(() => {
    if (!detailSource || selectedDraft) return
    try {
      previewSource(detailSource)
    } catch (error) {
      toast.error(message(error))
    }
  }, [detailSource, previewSource, selectedDraft])

  return (
    <div className="grid h-full min-h-0 gap-4 p-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-md border">
        <label className="relative m-3">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="공식 Geometry 검색"
            className="pl-9"
            placeholder="키, 제목, 설명 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="min-h-0 flex-1 overflow-auto border-t">
          {listQuery.isLoading ? (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : listQuery.isError ? (
            <p className="p-4 text-sm text-destructive">공식 Geometry 카탈로그를 불러오지 못했습니다.</p>
          ) : (
            <ul className="divide-y">
              {listQuery.data?.items.map((item) => (
                <li key={item.key}>
                  <button
                    className={cn(
                      'grid w-full gap-1 p-3 text-left hover:bg-muted/60',
                      selectedKey === item.key && 'bg-muted',
                    )}
                    type="button"
                    onClick={() => setSelectedCatalogKey(item.key)}
                  >
                    <span className="font-medium">{item.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">{item.key}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <section className="flex min-h-0 flex-col overflow-hidden rounded-md border">
        {detailQuery.isLoading ? (
          <div className="grid h-full place-items-center">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        ) : detailQuery.isError ? (
          <p className="p-4 text-sm text-destructive">Geometry detail을 불러오지 못했습니다.</p>
        ) : detailQuery.data ? (
          <>
            <header className="space-y-2 border-b p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{detailQuery.data.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{detailQuery.data.description}</p>
                </div>
                {selectedDraft ? <Badge>Draft Version</Badge> : null}
              </div>
              {!geometry.namespace ? (
                <p className="text-sm text-amber-700">Account에서 기본 Geometry namespace를 먼저 설정하세요.</p>
              ) : null}
              <div className="flex flex-wrap gap-1">
                <Badge>CAD API v{detailQuery.data.cadApiVersion}</Badge>
                <Badge>module v{detailQuery.data.moduleFormatVersion}</Badge>
                <Badge>{detailQuery.data.exportName}</Badge>
                {detailQuery.data.materialRoles.map((role) => (
                  <Badge key={role.role}>{role.role}</Badge>
                ))}
              </div>
            </header>
            {geometry.previewError && selectedDraft ? (
              <div className="border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
                마지막 정상 Viewer scene을 유지합니다. {geometry.previewError}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <CadEditor
                diagnostics={selectedDraft ? geometry.previewDiagnostics : []}
                modelPath={`file:///geometry-manager/official/${detailQuery.data.key}.tsx`}
                value={selectedDraft?.source ?? detailQuery.data.source}
                onAuthoringStateChange={onAuthoringStateChange}
                onChange={(source) => {
                  try {
                    geometry.updateCatalogSource({
                      key: detailQuery.data.key,
                      source,
                      description: detailQuery.data.description,
                    })
                  } catch (error) {
                    toast.error(message(error))
                  }
                }}
              />
            </div>
          </>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Geometry를 선택하세요.</p>
        )}
      </section>
    </div>
  )
}

function WorkspaceGeometryManager({
  geometry,
  initialPackageId = null,
  initialVersionId = null,
  onAuthoringStateChange,
  onOpenGeometrySource,
  onOpenExperiment,
  onUse,
  onReturnOfficial,
}: GeometryManagerProps & { onReturnOfficial: (key: string) => void }) {
  const auth = useAuth()
  const previewPublishedVersion = geometry.previewPublishedVersion
  const isAdmin = Boolean(auth.user?.roles.includes('admin'))
  const listScope = isAdmin ? 'visible' : 'mine'
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(24)
  const [repositoryId, setRepositoryId] = useState<number | null>(null)
  const [namespaceFilter, setNamespaceFilter] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active')
  const [selectedPackageId, setSelectedPackageId] = useState<number | null>(initialPackageId)
  const [checkedPackageIds, setCheckedPackageIds] = useState<Set<number>>(new Set())
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(initialVersionId)
  const [pendingVersionId, setPendingVersionId] = useState<number | null>(null)
  const [experimentSearch, setExperimentSearch] = useState('')
  const [experimentPage, setExperimentPage] = useState(0)
  const [repositoryDescription, setRepositoryDescription] = useState('')
  const [usageExample, setUsageExample] = useState<string | null>(null)
  const [selectedDraftCoordinate, setSelectedDraftCoordinate] = useState<GeometryModuleCoordinate | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const draftVersions = useMemo(() => Object.values(geometry.draftVersions), [geometry.draftVersions])
  const sessionDraftVersions = useMemo(() => draftVersions.filter((draft) => draft.packageId === null), [draftVersions])
  const selectedDraft = selectedDraftCoordinate ? (geometry.draftVersions[selectedDraftCoordinate] ?? null) : null

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
  const namespaces = useMemo(
    () => [...new Set((repositoriesQuery.data?.items ?? []).map((item) => item.namespace))].sort(),
    [repositoriesQuery.data?.items],
  )
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
  const packageRequest = useMemo(
    () => ({
      ...getListRequest(listScope),
      offset: page * pageSize,
      limit: pageSize,
      search_text: search.trim() || null,
      text_filter: {
        ...(namespaceFilter ? { namespace: [namespaceFilter] } : {}),
        ...(ownerFilter ? { owner_id: [ownerFilter] } : {}),
      },
      filter: repositoryId ? { repository_id: [repositoryId, repositoryId] } : ({} as Record<string, unknown[]>),
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
    [archiveFilter, listScope, namespaceFilter, ownerFilter, page, pageSize, repositoryId, search],
  )
  const packagesQuery = useQuery({
    enabled: auth.isAuthenticated,
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
  const selectedRepository = (repositoriesQuery.data?.items ?? []).find(
    (item) => item.id === selectedPackage?.repository_id,
  )

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
    setPage(0)
  }, [archiveFilter, namespaceFilter, ownerFilter, pageSize, repositoryId, search])
  useEffect(() => {
    setExperimentPage(0)
  }, [experimentSearch, selectedVersionId])
  useEffect(() => {
    const initialVersion = initialVersionQuery.data?.items[0]
    if (initialVersion) {
      setSelectedPackageId(initialVersion.package_id)
      setSelectedVersionId(initialVersion.id)
    }
  }, [initialVersionQuery.data?.items])
  useEffect(() => {
    if (!selectedPackageId && packagesQuery.data?.items[0]) {
      if (initialVersionQuery.data?.items[0]) return
      setSelectedPackageId(packagesQuery.data.items[0].id)
    }
  }, [initialVersionQuery.data?.items, packagesQuery.data?.items, selectedPackageId])
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
  }, [geometry.draftVersions, geometry.selectedCoordinate, selectedDraftCoordinate, selectedPackageId])
  useEffect(() => {
    if (!selectedPackageId || !geometry.selectedCoordinate || geometry.draftVersions[geometry.selectedCoordinate])
      return
    const published = versions.find((version) => version.coordinate === geometry.selectedCoordinate)
    if (published && published.id !== selectedVersionId) setSelectedVersionId(published.id)
  }, [geometry.draftVersions, geometry.selectedCoordinate, selectedPackageId, selectedVersionId, versions])
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
  }, [pendingVersionId, selectedVersionId, versions])
  useEffect(() => setRepositoryDescription(selectedRepository?.description ?? ''), [selectedRepository])
  useEffect(() => {
    if (!selectedVersionId) return
    void previewPublishedVersion(selectedVersionId).catch((error: unknown) => toast.error(message(error)))
  }, [previewPublishedVersion, selectedVersionId])

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['geometry'] })
    await geometry.refreshRepositories()
  }
  const namespaceMutation = useMutation({
    mutationFn: (value: string) => geometry.setNamespace(value),
    onSuccess: async () => {
      await invalidate()
      toast.success('기본 Geometry namespace를 변경했습니다. 기존 좌표는 유지됩니다.')
    },
    onError: (error) => toast.error(message(error)),
  })
  const createRepositoryMutation = useMutation({
    mutationFn: ({ slug, description }: { slug: string; description: string }) =>
      geometry.createRepository(slug, description),
    onSuccess: async () => {
      await invalidate()
      toast.success('Geometry repository를 만들었습니다.')
    },
    onError: (error) => toast.error(message(error)),
  })
  const updateRepositoryMutation = useMutation({
    mutationFn: () => geometryApi.updateRepositoryDescription(selectedRepository!.id, repositoryDescription),
    onSuccess: async () => {
      await invalidate()
      toast.success('Repository 설명을 저장했습니다.')
    },
    onError: (error) => toast.error(message(error)),
  })
  const archiveRepositoryMutation = useMutation({
    mutationFn: () => geometry.archiveRepository(selectedRepository!.id),
    onSuccess: async () => {
      await invalidate()
      toast.success('Repository를 archive했습니다.')
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

  const columns = useMemo<ColumnDef<GeometryPackageRecord, unknown>[]>(
    () => [
      {
        id: 'selected',
        header: '',
        cell: ({ row }) => (
          <input
            aria-label={`${row.original.name} 선택`}
            checked={checkedPackageIds.has(row.original.id)}
            onChange={(event) => {
              event.stopPropagation()
              setCheckedPackageIds((current) => {
                const next = new Set(current)
                if (next.has(row.original.id)) next.delete(row.original.id)
                else next.add(row.original.id)
                return next
              })
            }}
            onClick={(event) => event.stopPropagation()}
            type="checkbox"
          />
        ),
      },
      {
        id: 'coordinate',
        header: 'Geometry Package',
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-mono text-xs">
              {row.original.namespace}/{row.original.repository}/{row.original.name}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.original.version_count} versions · latest {row.original.latest_version ?? '없음'}
            </p>
          </div>
        ),
      },
      {
        accessorKey: 'repository_archived_at',
        header: '상태',
        cell: ({ row }) => (
          <Badge className={row.original.repository_archived_at ? 'bg-muted' : 'bg-emerald-600 text-white'}>
            {row.original.repository_archived_at ? 'Archived repo' : 'Active'}
          </Badge>
        ),
      },
      {
        accessorKey: 'updated_at',
        header: 'Updated',
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            {row.original.updated_at ? new Date(row.original.updated_at).toLocaleDateString() : '—'}
          </span>
        ),
      },
    ],
    [checkedPackageIds],
  )

  const submitNamespace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    namespaceMutation.mutate(String(new FormData(event.currentTarget).get('namespace') ?? '').trim())
  }
  const submitRepository = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    createRepositoryMutation.mutate({
      slug: String(form.get('slug') ?? '').trim(),
      description: String(form.get('description') ?? '').trim(),
    })
    event.currentTarget.reset()
  }
  const submitGeometry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      const coordinate = geometry.createDraft({
        repositoryId: Number(String(form.get('repositoryId') ?? '')) || null,
        repository: String(form.get('repository') ?? '').trim(),
        packageName: String(form.get('package') ?? '').trim(),
        description: String(form.get('description') ?? '').trim(),
        source: String(form.get('source') ?? ''),
      })
      setSelectedPackageId(null)
      setSelectedVersionId(null)
      setSelectedDraftCoordinate(coordinate)
      setCreateDialogOpen(false)
    } catch (cause) {
      toast.error(message(cause))
    }
  }
  const handleDraftDiscard = (discarded: (typeof draftVersions)[number]) => {
    setSelectedDraftCoordinate(null)
    if (discarded.originCatalogKey) {
      onReturnOfficial(discarded.originCatalogKey)
    } else if (discarded.baseGeometryVersionId) {
      setSelectedVersionId(discarded.baseGeometryVersionId)
      void geometry
        .previewPublishedVersion(discarded.baseGeometryVersionId)
        .catch((cause: unknown) => toast.error(message(cause)))
    }
  }

  return (
    <div className="grid h-full min-h-[34rem] grid-cols-[minmax(21rem,36%)_minmax(0,1fr)] overflow-hidden">
      <aside className="flex min-h-0 flex-col border-r bg-muted/10">
        <div className="space-y-3 border-b p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Workspace Packages</h2>
              <p className="text-xs text-muted-foreground">Package의 Published 및 Draft Version을 관리합니다.</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setCreateDialogOpen(true)} size="sm">
                <Plus /> 새 Geometry
              </Button>
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
          {auth.isAuthenticated ? (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Geometry 검색"
                  className="pl-9"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="namespace/repository/package 검색"
                  value={search}
                />
              </div>
              <div className={cn('grid gap-2', isAdmin ? 'grid-cols-4' : 'grid-cols-3')}>
                <select
                  aria-label="Namespace 필터"
                  className="h-9 rounded-md border bg-background px-2 text-xs"
                  onChange={(event) => setNamespaceFilter(event.target.value)}
                  value={namespaceFilter}
                >
                  <option value="">모든 namespace</option>
                  {namespaces.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                {isAdmin ? (
                  <select
                    aria-label="Owner 필터"
                    className="h-9 rounded-md border bg-background px-2 text-xs"
                    onChange={(event) => setOwnerFilter(event.target.value)}
                    value={ownerFilter}
                  >
                    <option value="">모든 owner</option>
                    <option value="__orphan__">Orphaned</option>
                    {owners.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                ) : null}
                <select
                  aria-label="Repository 필터"
                  className="h-9 rounded-md border bg-background px-2 text-xs"
                  onChange={(event) => setRepositoryId(Number(event.target.value) || null)}
                  value={repositoryId ?? ''}
                >
                  <option value="">모든 repository</option>
                  {(repositoriesQuery.data?.items ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.namespace}/{item.slug}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Archive 필터"
                  className="h-9 rounded-md border bg-background px-2 text-xs"
                  onChange={(event) => setArchiveFilter(event.target.value as typeof archiveFilter)}
                  value={archiveFilter}
                >
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                  <option value="all">전체</option>
                </select>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">세션 Package는 편집과 Viewer 미리보기를 사용할 수 있습니다.</p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {sessionDraftVersions.length ? (
            <section className="border-b p-2" aria-label="Session Packages">
              <p className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">Session Packages</p>
              {sessionDraftVersions.map((draft) => (
                <button
                  className={cn(
                    'mb-1 grid w-full gap-1 rounded px-2 py-2 text-left hover:bg-accent',
                    selectedDraftCoordinate === draft.coordinate && 'bg-accent',
                  )}
                  key={draft.draftId}
                  onClick={() => {
                    setSelectedPackageId(null)
                    setSelectedVersionId(null)
                    setSelectedDraftCoordinate(draft.coordinate)
                    geometry.setSelectedCoordinate(draft.coordinate)
                  }}
                  type="button"
                >
                  <span className="truncate font-mono text-xs">
                    {draft.repository}/{draft.packageName}
                  </span>
                  <span className="text-[10px] text-muted-foreground">Draft Version</span>
                </button>
              ))}
            </section>
          ) : null}
          {!auth.isAuthenticated ? (
            !sessionDraftVersions.length ? (
              <div className="grid h-48 place-items-center px-6 text-center text-sm text-muted-foreground">
                새 Geometry를 만들거나 Official source를 편집하세요.
              </div>
            ) : null
          ) : packagesQuery.isLoading ? (
            <div className="grid h-48 place-items-center text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <LoaderCircle className="animate-spin" /> 목록 불러오는 중
              </span>
            </div>
          ) : packagesQuery.isError ? (
            <div className="grid h-48 place-items-center text-sm text-destructive">목록을 불러오지 못했습니다.</div>
          ) : (
            <DataTable
              columns={columns}
              data={packagesQuery.data?.items ?? []}
              getRowKey={(row) => String(row.id)}
              selectedKey={selectedPackageId ? String(selectedPackageId) : undefined}
              onRowClick={(row) => {
                setSelectedDraftCoordinate(null)
                geometry.setSelectedCoordinate(null)
                setPendingVersionId(null)
                setSelectedVersionId(null)
                setSelectedPackageId(row.id)
              }}
            />
          )}
        </div>
        {auth.isAuthenticated ? (
          <div className="flex items-center justify-between gap-2 border-t p-3 text-xs">
            <span>{packagesQuery.data?.total.toLocaleString() ?? 0} packages</span>
            <div className="flex items-center gap-1">
              <select
                aria-label="페이지 크기"
                className="h-8 rounded border bg-background px-1"
                onChange={(event) => setPageSize(Number(event.target.value) as typeof pageSize)}
                value={pageSize}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size}>{size}</option>
                ))}
              </select>
              <Button disabled={page === 0} onClick={() => setPage((value) => value - 1)} size="icon" variant="ghost">
                <ChevronLeft />
              </Button>
              <span className="min-w-12 text-center">{page + 1}</span>
              <Button
                disabled={(page + 1) * pageSize >= (packagesQuery.data?.total ?? 0)}
                onClick={() => setPage((value) => value + 1)}
                size="icon"
                variant="ghost"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        ) : null}
      </aside>

      <main className="min-h-0 overflow-auto p-5">
        {selectedDraft && !selectedPackage ? (
          <div className="mx-auto max-w-6xl space-y-4">
            <header>
              <p className="font-mono text-xs text-muted-foreground">{selectedDraft.repository}</p>
              <h2 className="text-xl font-semibold">{selectedDraft.packageName}</h2>
            </header>
            <div className="grid gap-4 xl:grid-cols-[15rem_minmax(0,1fr)]">
              <Card className="overflow-hidden">
                <div className="border-b p-3 text-sm font-semibold">Versions</div>
                <div className="p-2">
                  <button
                    className="flex w-full items-center justify-between rounded bg-amber-50 px-2 py-2 text-left text-sm"
                    type="button"
                  >
                    <span className="font-medium">Draft</span>
                    <Badge>Draft Version</Badge>
                  </button>
                </div>
              </Card>
              <Card className="min-w-0 overflow-hidden">
                <GeometryDraftVersionEditor
                  authenticated={auth.isAuthenticated}
                  draft={selectedDraft}
                  geometry={geometry}
                  onDiscard={handleDraftDiscard}
                  onAuthoringStateChange={onAuthoringStateChange}
                />
              </Card>
            </div>
          </div>
        ) : !selectedPackage ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Geometry Package를 선택하세요.
          </div>
        ) : (
          <div className="mx-auto max-w-6xl space-y-5">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-muted-foreground">
                  {selectedPackage.namespace}/{selectedPackage.repository}
                </p>
                <h2 className="text-xl font-semibold">{selectedPackage.name}</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                {!selectedDraft ? (
                  <Button
                    disabled={!selectedVersion || Boolean(selectedVersion.archived_at)}
                    onClick={() => {
                      if (!selectedVersion) return
                      const exports = resolvedQuery.data?.root.exports ?? []
                      const exportName =
                        exports.length === 1
                          ? exports[0]
                          : window
                              .prompt(`사용할 named export를 입력하세요.\n${exports.join(', ')}`, exports[0])
                              ?.trim()
                      if (!exportName || !exports.includes(exportName)) {
                        toast.error('Published Geometry의 named export를 선택하세요.')
                        return
                      }
                      const alias = window.prompt('geometry.tsx에서 사용할 local alias', exportName)?.trim()
                      if (!alias) return
                      void Promise.resolve(onUse(selectedVersion.id, exportName, alias))
                        .then((snippet) => setUsageExample(snippet))
                        .catch((cause: unknown) => toast.error(message(cause)))
                    }}
                  >
                    <Plus /> Experiment에서 사용
                  </Button>
                ) : null}
                <Button
                  disabled={!packageUsageSafe || deletePackagesMutation.isPending}
                  onClick={() => {
                    if (window.confirm(`${selectedPackage.name} Package와 모든 Version을 삭제할까요?`)) {
                      deletePackagesMutation.mutate([selectedPackage.id])
                    }
                  }}
                  variant="destructive"
                >
                  <Trash2 /> Package 삭제
                </Button>
              </div>
            </header>

            <Card className="grid gap-4 p-4 lg:grid-cols-2">
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">기본 Geometry namespace</h3>
                <form className="flex gap-2" onSubmit={submitNamespace}>
                  <Input
                    defaultValue={geometry.namespace ?? ''}
                    key={geometry.namespace ?? 'unset'}
                    maxLength={32}
                    minLength={3}
                    name="namespace"
                    pattern="[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?"
                    required
                  />
                  <Button disabled={namespaceMutation.isPending} type="submit">
                    변경
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground">
                  새 Repository에만 적용됩니다. 기존 Published Geometry의 좌표와 hash는 바뀌지 않습니다.
                </p>
              </section>
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Repository</h3>
                <div className="flex gap-2">
                  <Input
                    onChange={(event) => setRepositoryDescription(event.target.value)}
                    value={repositoryDescription}
                  />
                  <Button
                    disabled={!selectedRepository || updateRepositoryMutation.isPending}
                    onClick={() => updateRepositoryMutation.mutate()}
                    variant="outline"
                  >
                    설명 저장
                  </Button>
                  <Button
                    disabled={
                      !selectedRepository ||
                      Boolean(selectedRepository.archived_at) ||
                      archiveRepositoryMutation.isPending
                    }
                    onClick={() => {
                      if (window.confirm('이 Repository를 archive할까요?')) archiveRepositoryMutation.mutate()
                    }}
                    variant="outline"
                  >
                    <Archive /> Archive
                  </Button>
                </div>
                <form className="grid grid-cols-[1fr_1.5fr_auto] gap-2" onSubmit={submitRepository}>
                  <Input name="slug" placeholder="새 repository slug" required />
                  <Input name="description" placeholder="설명 (선택)" />
                  <Button disabled={createRepositoryMutation.isPending} type="submit">
                    <Plus /> 만들기
                  </Button>
                </form>
              </section>
            </Card>

            <div className="grid gap-4 xl:grid-cols-[15rem_minmax(0,1fr)]">
              <Card className="overflow-hidden">
                <div className="border-b p-3 text-sm font-semibold">Versions</div>
                <div className="max-h-[34rem] overflow-auto p-2">
                  {selectedPackageDraft ? (
                    <button
                      className="mb-1 flex w-full items-center justify-between rounded bg-amber-50 px-2 py-2 text-left text-sm hover:bg-amber-100"
                      onClick={() => {
                        setSelectedDraftCoordinate(selectedPackageDraft.coordinate)
                        geometry.setSelectedCoordinate(selectedPackageDraft.coordinate)
                      }}
                      type="button"
                    >
                      <span className="font-medium">Draft</span>
                      <Badge>Draft Version</Badge>
                    </button>
                  ) : null}
                  {versions.map((version) => (
                    <button
                      className={cn(
                        'mb-1 flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-accent',
                        version.id === selectedVersionId && 'bg-accent',
                      )}
                      key={version.id}
                      onClick={() => {
                        setSelectedDraftCoordinate(null)
                        setSelectedVersionId(version.id)
                        geometry.setSelectedCoordinate(version.coordinate as GeometryModuleCoordinate)
                      }}
                      type="button"
                    >
                      <span className="font-mono">v{version.version}</span>
                      {version.archived_at ? <Badge className="bg-muted">Archived</Badge> : null}
                    </button>
                  ))}
                  {!versions.length ? (
                    <p className="p-4 text-center text-xs text-muted-foreground">Version 없음</p>
                  ) : null}
                </div>
              </Card>

              <Card className="min-w-0 overflow-hidden">
                {selectedDraft ? (
                  <GeometryDraftVersionEditor
                    authenticated={auth.isAuthenticated}
                    draft={selectedDraft}
                    geometry={geometry}
                    onDiscard={handleDraftDiscard}
                    onAuthoringStateChange={onAuthoringStateChange}
                  />
                ) : !selectedVersion ? (
                  <div className="grid h-48 place-items-center text-sm text-muted-foreground">
                    Version을 선택하세요.
                  </div>
                ) : (
                  <Tabs defaultValue="source">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs" title={selectedVersion.coordinate}>
                          {selectedVersion.coordinate}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          source {selectedVersion.source_hash.slice(0, 12)} · module{' '}
                          {selectedVersion.module_hash.slice(0, 12)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          disabled={Boolean(selectedVersion.archived_at) || archiveVersionMutation.isPending}
                          onClick={() => archiveVersionMutation.mutate()}
                          size="sm"
                          variant="outline"
                        >
                          <Archive /> Archive
                        </Button>
                        <Button
                          disabled={versionDeleteBlocked}
                          onClick={() => {
                            if (window.confirm(`${selectedVersion.coordinate}를 삭제할까요?`))
                              deleteVersionMutation.mutate()
                          }}
                          size="sm"
                          variant="destructive"
                        >
                          <Trash2 /> 삭제
                        </Button>
                      </div>
                    </div>
                    <TabsList className="m-3 mb-0">
                      <TabsTrigger value="source">Source</TabsTrigger>
                      <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
                      <TabsTrigger value="references">References</TabsTrigger>
                    </TabsList>
                    <TabsContent className="m-0" value="source">
                      {selectedPackageDraft ? (
                        <div className="border-t border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                          이 Package에는 Draft Version이 있습니다. Published Version은 미리보기만 가능하며, Draft를
                          선택하거나 폐기한 뒤 편집할 수 있습니다.
                        </div>
                      ) : null}
                      <div className="h-[28rem] border-t">
                        <CadEditor
                          diagnostics={[]}
                          modelPath={`file:///geometry-manager/${selectedVersion.id}.tsx`}
                          onAuthoringStateChange={onAuthoringStateChange}
                          onChange={(source) => {
                            try {
                              const result = geometry.updatePublishedSource({
                                versionId: selectedVersion.id,
                                coordinate: selectedVersion.coordinate as GeometryModuleCoordinate,
                                source,
                                description: selectedVersion.description ?? '',
                                repositoryId: selectedPackage.repository_id,
                                packageId: selectedPackage.id,
                              })
                              setSelectedDraftCoordinate(result.coordinate)
                            } catch (cause) {
                              toast.error(message(cause))
                            }
                          }}
                          readOnly={
                            Boolean(selectedPackageDraft) ||
                            Boolean(selectedVersion.archived_at) ||
                            selectedPackage.repository_archived_at !== null
                          }
                          value={selectedVersion.source}
                        />
                      </div>
                    </TabsContent>
                    <TabsContent className="m-0 space-y-4 border-t p-4" value="dependencies">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div>
                          <p className="text-xs font-semibold">Module format</p>
                          <p className="text-sm">v{selectedVersion.module_format_version}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold">CAD API</p>
                          <p className="text-sm">v{selectedVersion.cad_api_version}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold">Created</p>
                          <p className="text-sm">
                            {selectedVersion.created_at ? new Date(selectedVersion.created_at).toLocaleString() : '—'}
                          </p>
                        </div>
                      </div>
                      <section>
                        <h3 className="mb-2 text-sm font-semibold">Resolved dependency closure</h3>
                        <ul className="space-y-2">
                          {(resolvedQuery.data?.modules ?? []).map((module) => (
                            <li className="rounded border p-3" key={module.coordinate}>
                              <p className="font-mono text-xs break-all">{module.coordinate}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {module.imports.length} exact imports
                              </p>
                            </li>
                          ))}
                        </ul>
                      </section>
                      <section>
                        <h3 className="mb-2 text-sm font-semibold">이 Version을 import하는 Geometry</h3>
                        {(dependentsQuery.data?.items ?? []).map((item) => (
                          <button
                            className="mb-2 flex w-full items-center justify-between rounded border p-3 text-left hover:bg-accent"
                            key={item.id}
                            onClick={() => {
                              setPendingVersionId(item.id)
                              setSelectedPackageId(item.package_id)
                            }}
                            type="button"
                          >
                            <span className="font-mono text-xs break-all">{item.coordinate}</span>
                            <ExternalLink className="size-4" />
                          </button>
                        ))}
                        {!dependentsQuery.data?.total ? (
                          <p className="text-xs text-muted-foreground">Dependent Geometry가 없습니다.</p>
                        ) : null}
                      </section>
                    </TabsContent>
                    <TabsContent className="m-0 space-y-3 border-t p-4" value="references">
                      <div className="flex gap-2">
                        <Input
                          aria-label="참조 Experiment 검색"
                          onChange={(event) => setExperimentSearch(event.target.value)}
                          placeholder="Experiment 이름 또는 설명 검색"
                          value={experimentSearch}
                        />
                        <Button onClick={() => void experimentsQuery.refetch()} size="icon" variant="outline">
                          <RefreshCw />
                        </Button>
                      </div>
                      {(experimentsQuery.data?.items ?? []).map((item) => (
                        <button
                          className="flex w-full items-center justify-between gap-3 rounded border p-3 text-left hover:bg-accent"
                          key={item.id}
                          onClick={() => void onOpenExperiment(item.id)}
                          type="button"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {item.name} · #{item.id}
                            </p>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {item.description || '설명 없음'}
                            </p>
                          </div>
                          <Badge className={item.entry_alias ? 'bg-blue-100 text-blue-900' : 'bg-muted'}>
                            {item.entry_alias ? `Entry · ${item.entry_alias}` : 'Indirect'}
                          </Badge>
                        </button>
                      ))}
                      {!experimentsQuery.data?.total ? (
                        <p className="py-6 text-center text-xs text-muted-foreground">
                          참조하는 Experiment가 없습니다.
                        </p>
                      ) : null}
                      <div className="flex items-center justify-end gap-2 text-xs">
                        <Button
                          disabled={experimentPage === 0}
                          onClick={() => setExperimentPage((value) => value - 1)}
                          size="icon"
                          variant="ghost"
                        >
                          <ChevronLeft />
                        </Button>
                        <span>
                          {experimentPage + 1} / {Math.max(1, Math.ceil((experimentsQuery.data?.total ?? 0) / 10))}
                        </span>
                        <Button
                          disabled={(experimentPage + 1) * 10 >= (experimentsQuery.data?.total ?? 0)}
                          onClick={() => setExperimentPage((value) => value + 1)}
                          size="icon"
                          variant="ghost"
                        >
                          <ChevronRight />
                        </Button>
                      </div>
                    </TabsContent>
                  </Tabs>
                )}
              </Card>
            </div>
          </div>
        )}
      </main>
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <form className="grid max-h-[85dvh] gap-4 overflow-auto" onSubmit={submitGeometry}>
            <DialogHeader>
              <DialogTitle>새 Geometry</DialogTitle>
              <DialogDescription>
                새 Package와 Draft Version을 세션에 만들고 Viewer에서 바로 미리봅니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              {auth.isAuthenticated ? (
                <label className="grid gap-1 text-sm">
                  기존 Repository
                  <select className="h-9 rounded-md border bg-background px-3" name="repositoryId">
                    <option value="">현재 namespace의 새 Repository</option>
                    {geometry.repositories.map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.namespace}/{repository.slug}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="grid gap-1 text-sm">
                Repository slug
                <Input defaultValue="common" name="repository" required />
              </label>
              <label className="grid gap-1 text-sm">
                Package name
                <Input defaultValue="new-geometry" name="package" required />
              </label>
              <label className="grid gap-1 text-sm">
                Description
                <Input name="description" />
              </label>
            </div>
            <label className="grid gap-1 text-sm">
              TSX source
              <textarea
                className="min-h-72 rounded-md border bg-background p-3 font-mono text-xs"
                defaultValue={draftGeometrySource('new-geometry')}
                name="source"
                required
                spellCheck={false}
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateDialogOpen(false)}>
                취소
              </Button>
              <Button type="submit">Draft Version 만들기</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <GeometryUsageDialog
        snippet={usageExample ?? ''}
        onOpenChange={(open) => !open && setUsageExample(null)}
        onOpenGeometrySource={onOpenGeometrySource}
        open={usageExample !== null}
      />
    </div>
  )
}
