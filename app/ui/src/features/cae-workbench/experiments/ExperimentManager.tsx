import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, LoaderCircle, Search, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  dbTables,
  experimentApi,
  getListRequest,
  type ExperimentRecord,
  type GetListRequest,
  type UserData,
} from '@/api'
import { catalogApi, catalogQueryKeys, type CatalogExperimentListItem } from '@/api/catalog'
import { authQueryKey } from '@/features/auth/use-auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { assertExperimentSourceBundle } from '@/lib/cad'
import type { SavedExperiment } from '../types'

type ExperimentManagerProps = {
  authenticated: boolean
  busy?: boolean
  selectedId: number | null
  user: UserData | null
  onDeleteSelected?: (row: SavedExperiment) => void
  onOpenCatalog: (sourceBundle: SavedExperiment['source_bundle'], name: string, description: string) => void
  onOpenSaved: (row: SavedExperiment) => void
}

export function ExperimentManager({
  authenticated,
  busy = false,
  selectedId,
  user,
  onOpenCatalog,
  onOpenSaved,
  onDeleteSelected,
}: ExperimentManagerProps) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'official' | 'saved'>('official')
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<'visible' | 'mine'>('mine')
  const [namespace, setNamespace] = useState('all')
  const [repository, setRepository] = useState('all')
  const [namespaceDraft, setNamespaceDraft] = useState(user?.experiment_namespace ?? '')
  const [loadingOfficial, setLoadingOfficial] = useState<string | null>(null)

  useEffect(() => setNamespaceDraft(user?.experiment_namespace ?? ''), [user?.experiment_namespace])

  const officialQuery = useQuery({
    queryKey: catalogQueryKeys.experiments({ q: search.trim(), limit: 100 }),
    queryFn: () => catalogApi.listExperiments({ q: search.trim(), limit: 100 }),
    enabled: tab === 'official',
  })
  const savedRequest = useMemo<GetListRequest>(
    () => ({
      ...getListRequest(user?.roles.includes('admin') ? scope : 'mine'),
      limit: null,
      search_text: search.trim() || null,
      text_filter: search.trim() ? { workbench: [search.trim()] } : ({} as Record<string, string[]>),
      sort: [
        ['namespace', 'asc'],
        ['repository_slug', 'asc'],
        ['experiment_key', 'asc'],
        ['version_major', 'desc'],
        ['version_minor', 'desc'],
        ['version_patch', 'desc'],
      ],
    }),
    [scope, search, user?.roles],
  )
  const savedQuery = useQuery({
    queryKey: ['cae-workbench', 'experiments', savedRequest],
    queryFn: () => dbTables.Experiment.listRows(savedRequest),
    enabled: authenticated && tab === 'saved',
  })
  const namespaces = useMemo(() => {
    const items = tab === 'official' ? (officialQuery.data?.items ?? []) : (savedQuery.data?.items ?? [])
    return [...new Set(items.map((item) => item.namespace))].sort()
  }, [officialQuery.data?.items, savedQuery.data?.items, tab])
  const repositories = useMemo(
    () =>
      [
        ...new Set(
          (tab === 'official' ? (officialQuery.data?.items ?? []) : (savedQuery.data?.items ?? []))
            .filter((item) => namespace === 'all' || item.namespace === namespace)
            .map((item) => ('repository_slug' in item ? item.repository_slug : item.repository)),
        ),
      ].sort(),
    [namespace, officialQuery.data?.items, savedQuery.data?.items, tab],
  )
  const officialRows = useMemo(
    () =>
      (officialQuery.data?.items ?? []).filter(
        (item) =>
          (namespace === 'all' || item.namespace === namespace) &&
          (repository === 'all' || item.repository === repository),
      ),
    [namespace, officialQuery.data?.items, repository],
  )
  const rows = useMemo(
    () =>
      (savedQuery.data?.items ?? []).filter(
        (item) =>
          (namespace === 'all' || item.namespace === namespace) &&
          (repository === 'all' || item.repository_slug === repository),
      ),
    [namespace, repository, savedQuery.data?.items],
  )
  const savedGroups = useMemo(() => {
    const grouped = new Map<string, ExperimentRecord[]>()
    rows.forEach((row) => {
      const identity = `${row.namespace}/${row.repository_slug}/${row.experiment_key}`
      grouped.set(identity, [...(grouped.get(identity) ?? []), row])
    })
    return [...grouped.entries()].map(
      ([identity, versions]) =>
        [
          identity,
          versions.sort(
            (left, right) =>
              right.version_major - left.version_major ||
              right.version_minor - left.version_minor ||
              right.version_patch - left.version_patch,
          ),
        ] as const,
    )
  }, [rows])

  const namespaceMutation = useMutation({
    mutationFn: (value: string) => {
      const nextNamespace = value.trim()
      if (nextNamespace === 'caemble') {
        throw new Error('caemble namespace는 공식 Experiment 전용입니다.')
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(nextNamespace)) {
        throw new Error('Experiment namespace는 3~32자의 소문자 영숫자와 하이픈으로 입력하세요.')
      }
      return experimentApi.setNamespace(nextNamespace)
    },
    onSuccess: (nextUser) => {
      queryClient.setQueryData(authQueryKey, nextUser)
      setNamespaceDraft(nextUser.experiment_namespace ?? '')
      toast.success(`Experiment namespace를 ${nextUser.experiment_namespace}(으)로 설정했습니다.`)
    },
    onError: (cause: unknown) => {
      toast.error(cause instanceof Error ? cause.message : 'Experiment namespace를 설정하지 못했습니다.')
    },
  })
  const deleteMutation = useMutation({
    mutationFn: async (row: ExperimentRecord) => {
      const usage = (await dbTables.Experiment.usage([row.id])).items[0]
      const counts = usage?.derivedCounts ?? row.derivedCounts
      const linked = counts
        ? counts.measurements + counts.recordedData + counts.designerModels + counts.predictorModels
        : 0
      const detail = linked
        ? `\n연결 데이터 ${linked.toLocaleString()}개도 함께 삭제됩니다 (Measurement ${counts!.measurements}, RecordedData ${counts!.recordedData}, Designer ${counts!.designerModels}, Predictor ${counts!.predictorModels}).`
        : ''
      const version = row.version ?? `${row.version_major}.${row.version_minor}.${row.version_patch}`
      if (
        !window.confirm(
          `${row.namespace}/${row.repository_slug}/${row.experiment_key}@${version}을 영구 삭제할까요?${detail}`,
        )
      ) {
        return false
      }
      await dbTables.Experiment.deleteRows([row.id])
      return true
    },
    onSuccess: async (deleted, row) => {
      if (!deleted) return
      if (row.id === selectedId) onDeleteSelected?.(row as SavedExperiment)
      await queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'experiments'] })
      toast.success('Experiment Version을 삭제했습니다.')
    },
    onError: (cause: unknown) => {
      toast.error(cause instanceof Error ? cause.message : 'Experiment Version을 삭제하지 못했습니다.')
    },
  })

  const openOfficial = async (experiment: CatalogExperimentListItem) => {
    setLoadingOfficial(experiment.coordinate)
    try {
      const item = await catalogApi.getExperiment(experiment)
      assertExperimentSourceBundle(item.sourceBundle)
      onOpenCatalog(item.sourceBundle, item.title, item.description)
    } catch (cause: unknown) {
      toast.error(cause instanceof Error ? cause.message : '공식 Experiment를 불러오지 못했습니다.')
    } finally {
      setLoadingOfficial(null)
    }
  }

  return (
    <section aria-label="Experiment Manager" className="flex h-full min-h-0 flex-col bg-background">
      <header className="space-y-3 border-b p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Experiment Manager</h2>
            <p className="text-sm text-muted-foreground">
              공식 예제와 저장된 namespace / repository / SemVer 목록을 한곳에서 관리합니다.
            </p>
          </div>
          {authenticated ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                namespaceMutation.mutate(namespaceDraft)
              }}
            >
              <Settings2 className="size-4 text-muted-foreground" />
              <Input
                aria-label="Experiment namespace"
                className="h-8 w-44 font-mono text-xs"
                disabled={namespaceMutation.isPending}
                placeholder="namespace"
                value={namespaceDraft}
                onChange={(event) => setNamespaceDraft(event.target.value)}
              />
              <Button disabled={!namespaceDraft.trim() || namespaceMutation.isPending} size="sm" type="submit">
                Namespace 저장
              </Button>
            </form>
          ) : null}
        </div>
        <label className="relative block">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Experiment 검색"
            className="pl-9"
            placeholder="이름, 설명, coordinate 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            value={namespace}
            onValueChange={(value) => {
              setNamespace(value)
              setRepository('all')
            }}
          >
            <SelectTrigger aria-label="Namespace 필터">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">모든 namespace</SelectItem>
              {namespaces.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={repository} onValueChange={setRepository}>
            <SelectTrigger aria-label="Repository 필터">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">모든 repository</SelectItem>
              {repositories.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>
      <Tabs
        className="flex min-h-0 flex-1 flex-col p-4"
        value={tab}
        onValueChange={(value) => {
          setTab(value as typeof tab)
          setNamespace('all')
          setRepository('all')
        }}
      >
        <TabsList className={`grid w-full shrink-0 ${authenticated ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <TabsTrigger value="official">Official Experiments</TabsTrigger>
          {authenticated ? <TabsTrigger value="saved">Saved Experiments</TabsTrigger> : null}
        </TabsList>
        <TabsContent className="min-h-0 flex-1 overflow-auto rounded-md border" value="official">
          {officialQuery.isLoading ? (
            <ManagerMessage loading>공식 Experiment를 불러오는 중…</ManagerMessage>
          ) : officialQuery.isError ? (
            <ManagerMessage>공식 Experiment 목록을 불러오지 못했습니다.</ManagerMessage>
          ) : officialRows.length ? (
            <ul className="divide-y">
              {officialRows.map((item) => (
                <li className="flex items-start gap-3 p-4" key={item.coordinate}>
                  <button
                    className="min-w-0 flex-1 text-left disabled:opacity-50"
                    disabled={busy || loadingOfficial !== null}
                    type="button"
                    onClick={() => void openOfficial(item)}
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{item.title}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">v{item.version}</span>
                    </span>
                    <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                      {item.coordinate}
                    </span>
                    <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{item.description}</span>
                  </button>
                  <Button
                    aria-label={`${item.title} 열기`}
                    disabled={busy || loadingOfficial !== null}
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => void openOfficial(item)}
                  >
                    {loadingOfficial === item.coordinate ? <LoaderCircle className="animate-spin" /> : <ExternalLink />}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <ManagerMessage>조건에 맞는 공식 Experiment가 없습니다.</ManagerMessage>
          )}
        </TabsContent>
        {authenticated ? (
          <TabsContent className="flex min-h-0 flex-1 flex-col gap-3" value="saved">
            {user?.roles.includes('admin') ? (
              <Select value={scope} onValueChange={(value) => setScope(value as typeof scope)}>
                <SelectTrigger aria-label="소유 범위" className="w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="visible">전체 사용자</SelectItem>
                  <SelectItem value="mine">내 Experiment</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              {savedQuery.isLoading ? (
                <ManagerMessage loading>저장된 Experiment를 불러오는 중…</ManagerMessage>
              ) : savedQuery.isError ? (
                <ManagerMessage>저장된 Experiment 목록을 불러오지 못했습니다.</ManagerMessage>
              ) : savedGroups.length ? (
                <ul className="divide-y">
                  {savedGroups.map(([identity, versions]) => (
                    <li key={identity}>
                      <div className="border-b bg-muted/35 px-4 py-2 font-mono text-xs font-semibold">{identity}</div>
                      <ul className="divide-y">
                        {versions.map((row) => {
                          const version =
                            row.version ?? `${row.version_major}.${row.version_minor}.${row.version_patch}`
                          const coordinate = row.coordinate ?? `caemble:experiment/${identity}@${version}`
                          const manageable = Boolean(user && (row.user_id === user.id || user.roles.includes('admin')))
                          const counts = row.derivedCounts
                          const linked = counts
                            ? counts.measurements + counts.recordedData + counts.designerModels + counts.predictorModels
                            : 0
                          return (
                            <li className={row.id === selectedId ? 'bg-orange-50/70' : undefined} key={row.id}>
                              <div className="flex items-start gap-3 p-4 pl-6">
                                <button
                                  className="min-w-0 flex-1 text-left disabled:opacity-50"
                                  disabled={busy}
                                  type="button"
                                  onClick={() => onOpenSaved(row as SavedExperiment)}
                                >
                                  <span className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">{row.name}</span>
                                    <Badge className="bg-muted text-foreground">v{version}</Badge>
                                    {row.sourceLocked ? (
                                      <Badge className="bg-amber-600 text-white">Locked</Badge>
                                    ) : null}
                                    {linked ? (
                                      <Badge className="border bg-transparent text-foreground">
                                        연결 데이터 {linked.toLocaleString()}
                                      </Badge>
                                    ) : null}
                                  </span>
                                  <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                                    {coordinate}
                                  </span>
                                  <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">
                                    {row.description || '설명 없음'}
                                  </span>
                                </button>
                                {manageable ? (
                                  <Button
                                    aria-label={`${row.name} v${version} 삭제`}
                                    disabled={busy || deleteMutation.isPending}
                                    size="icon"
                                    type="button"
                                    variant="ghost"
                                    onClick={() => deleteMutation.mutate(row)}
                                  >
                                    <Trash2 className="text-destructive" />
                                  </Button>
                                ) : null}
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <ManagerMessage>조건에 맞는 저장된 Experiment가 없습니다.</ManagerMessage>
              )}
            </div>
          </TabsContent>
        ) : null}
      </Tabs>
    </section>
  )
}

function ManagerMessage({ children, loading = false }: { children: string; loading?: boolean }) {
  return (
    <div className="grid min-h-64 place-items-center p-6 text-sm text-muted-foreground">
      <span>
        {loading ? <LoaderCircle className="mr-2 inline size-4 animate-spin" /> : null}
        {children}
      </span>
    </div>
  )
}
