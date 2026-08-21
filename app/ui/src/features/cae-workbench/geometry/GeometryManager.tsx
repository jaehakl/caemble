import type { ColumnDef } from '@tanstack/react-table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Pencil,
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
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/use-auth'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { cn } from '@/lib/utils'
import { GeometryDrafts } from './GeometryDrafts'
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
  onCatalogDraftOpened: () => void
  onEdit: (versionId: number, repositoryId: number, packageId: number) => void | Promise<void>
  onOpenGeometrySource: () => void
  onOpenExperiment: (experimentId: number) => void | Promise<void>
  onUse: (versionId: number, exportName: string, alias: string) => string | Promise<string>
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
}

export function GeometryManager(props: GeometryManagerProps) {
  const auth = useAuth()
  const [tab, setTab] = useState<'official' | 'workspace' | 'drafts'>('official')
  return (
    <Tabs
      aria-label="Geometry Manager"
      className="flex h-full min-h-0 flex-col"
      value={tab}
      onValueChange={(value) => setTab(value as typeof tab)}
    >
      <TabsList className={`mx-4 mt-4 grid ${auth.isAuthenticated ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <TabsTrigger value="official">Official Catalog</TabsTrigger>
        {auth.isAuthenticated ? <TabsTrigger value="workspace">Workspace Packages</TabsTrigger> : null}
        <TabsTrigger value="drafts">Local Drafts ({Object.keys(props.geometry.drafts).length})</TabsTrigger>
      </TabsList>
      <TabsContent className="min-h-0 flex-1 overflow-hidden" value="official">
        <OfficialGeometryCatalog
          {...props}
          authenticated={auth.isAuthenticated}
          onCatalogDraftOpened={() => {
            props.onCatalogDraftOpened()
            setTab('drafts')
          }}
        />
      </TabsContent>
      {auth.isAuthenticated ? (
        <TabsContent className="min-h-0 flex-1 overflow-hidden" value="workspace">
          <WorkspaceGeometryManager
            {...props}
            onEdit={async (...args) => {
              await props.onEdit(...args)
              setTab('drafts')
            }}
          />
        </TabsContent>
      ) : null}
      <TabsContent className="min-h-0 flex-1 overflow-hidden" value="drafts">
        <GeometryDrafts
          authenticated={auth.isAuthenticated}
          geometry={props.geometry}
          onAuthoringStateChange={props.onAuthoringStateChange}
        />
      </TabsContent>
    </Tabs>
  )
}

function OfficialGeometryCatalog({
  authenticated,
  geometry,
  onCatalogDraftOpened,
}: Pick<GeometryManagerProps, 'geometry' | 'onCatalogDraftOpened'> & { authenticated: boolean }) {
  const previewSource = geometry.previewSource
  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
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

  useEffect(() => {
    const items = listQuery.data?.items ?? []
    if (!items.some((item) => item.key === selectedKey)) setSelectedKey(items[0]?.key ?? null)
  }, [listQuery.data?.items, selectedKey])
  useEffect(() => {
    if (!detailSource) return
    try {
      previewSource(detailSource)
    } catch (error) {
      toast.error(message(error))
    }
  }, [detailSource, previewSource])

  const openDraft = () => {
    const item = detailQuery.data
    if (!item) return
    try {
      const result = geometry.openCatalogDraft({ key: item.key, source: item.source, description: item.description })
      toast.success(result.created ? '공식 Geometry를 로컬 Draft로 열었습니다.' : '기존 로컬 Draft를 선택했습니다.')
      onCatalogDraftOpened()
    } catch (error) {
      toast.error(message(error))
    }
  }

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
                    onClick={() => setSelectedKey(item.key)}
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
                <Button disabled={!geometry.namespace} type="button" onClick={openDraft}>
                  로컬 Draft로 열기
                </Button>
              </div>
              {!geometry.namespace && authenticated ? (
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
            <pre className="min-h-0 flex-1 overflow-auto bg-slate-950 p-4 text-xs text-slate-100">
              <code>{detailQuery.data.source}</code>
            </pre>
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
  onEdit,
  onOpenGeometrySource,
  onOpenExperiment,
  onUse,
}: GeometryManagerProps) {
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

  const repositoriesQuery = useQuery({
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
    queryKey: ['geometry', 'manager', 'packages', packageRequest],
    queryFn: () => dbTables.GeometryPackage.listRows(packageRequest),
  })
  const initialVersionQuery = useQuery({
    enabled: initialPackageId === null && initialVersionId !== null,
    queryKey: ['geometry', 'manager', 'initial-version', initialVersionId, listScope],
    queryFn: () =>
      dbTables.GeometryVersion.listRows({
        ...getListRequest(listScope, initialVersionId ? [initialVersionId] : []),
        limit: 1,
      }),
  })
  const selectedPackageQuery = useQuery({
    enabled: selectedPackageId !== null,
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
  const selectedRepository = (repositoriesQuery.data?.items ?? []).find(
    (item) => item.id === selectedPackage?.repository_id,
  )

  const versionsQuery = useQuery({
    enabled: selectedPackageId !== null,
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
    enabled: selectedVersionId !== null,
    queryKey: ['geometry', 'manager', 'resolve', selectedVersionId],
    queryFn: () => geometryApi.resolveVersion(selectedVersionId!),
  })
  const usageQuery = useQuery({
    enabled: versions.length > 0,
    queryKey: ['geometry', 'manager', 'usage', versions.map((item) => item.id)],
    queryFn: () => geometryApi.versionUsage(versions.map((item) => item.id)),
  })
  const dependentRequest = useMemo(
    () => ({ ...getListRequest(listScope), limit: 12, sort: ['updated_at', 'desc'] as [string, 'desc'] }),
    [listScope],
  )
  const dependentsQuery = useQuery({
    enabled: selectedVersionId !== null,
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
    enabled: selectedVersionId !== null,
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
        ...Object.values(geometry.drafts).flatMap((draft) =>
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
        ...Object.values(geometry.drafts).flatMap((draft) =>
          draft.baseGeometryVersionId ? [draft.baseGeometryVersionId] : [],
        ),
      ]),
    [geometry.currentSnapshot.modules, geometry.drafts, geometry.experimentModules, geometry.managerModules],
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

  return (
    <div className="grid h-full min-h-[34rem] grid-cols-[minmax(21rem,36%)_minmax(0,1fr)] overflow-hidden">
      <aside className="flex min-h-0 flex-col border-r bg-muted/10">
        <div className="space-y-3 border-b p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Geometry Packages</h2>
              <p className="text-xs text-muted-foreground">접근 가능한 Package를 exact version 단위로 관리합니다.</p>
            </div>
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
          </div>
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
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {packagesQuery.isLoading ? (
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
                setPendingVersionId(null)
                setSelectedVersionId(null)
                setSelectedPackageId(row.id)
              }}
            />
          )}
        </div>
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
      </aside>

      <main className="min-h-0 overflow-auto p-5">
        {!selectedPackage ? (
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
                <Button
                  disabled={!selectedVersion || Boolean(selectedVersion.archived_at)}
                  onClick={() => {
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
                    void Promise.resolve(onUse(selectedVersion.id, exportName, alias))
                      .then((snippet) => setUsageExample(snippet))
                      .catch((cause: unknown) => toast.error(message(cause)))
                  }}
                >
                  <Plus /> Experiment에서 사용
                </Button>
                <Button
                  disabled={!selectedVersion || selectedPackage.repository_archived_at !== null}
                  onClick={() => {
                    if (!selectedVersion) return
                    void onEdit(selectedVersion.id, selectedPackage.repository_id, selectedPackage.id)
                  }}
                  variant="outline"
                >
                  <Pencil /> Edit as New Version
                </Button>
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
                  {versions.map((version) => (
                    <button
                      className={cn(
                        'mb-1 flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-accent',
                        version.id === selectedVersionId && 'bg-accent',
                      )}
                      key={version.id}
                      onClick={() => setSelectedVersionId(version.id)}
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
                {!selectedVersion ? (
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
                      <div className="h-[28rem] border-t">
                        <CadEditor
                          diagnostics={[]}
                          disposeModelOnUnmount
                          modelPath={`file:///geometry-manager/${selectedVersion.id}.tsx`}
                          onChange={() => undefined}
                          readOnly
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
      <GeometryUsageDialog
        snippet={usageExample ?? ''}
        onOpenChange={(open) => !open && setUsageExample(null)}
        onOpenGeometrySource={onOpenGeometrySource}
        open={usageExample !== null}
      />
    </div>
  )
}
