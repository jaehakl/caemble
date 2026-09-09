import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { dbTables, type SavedExperimentRecord, type UserData } from '@/api'
import { catalogApi, type CatalogExperimentListItem } from '@/api/catalog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { privateQueryScope } from '@/features/auth/queryKeys'
import { catalogExperimentsQueryOptions } from '@/features/catalog/queryOptions'
import { invalidateExperimentMutation } from './queryInvalidation'
import type { SavedExperiment } from '@/features/cae-workbench/types'
import { experimentManagerListing } from './managerListing'
import { availableExperimentsQueryOptions } from './queryOptions'

type ExperimentManagerProps = {
  authenticated: boolean
  busy?: boolean
  compact?: boolean
  selectedId: number | null
  user: UserData | null
  onDeleteSelected?: (row: SavedExperiment) => void
  onOpenExample: (sourceBundle: SavedExperiment['source_bundle'], name: string, description: string) => void
  onOpenSaved: (row: SavedExperiment) => void
}

export function ExperimentManager({
  authenticated,
  busy = false,
  compact = false,
  selectedId,
  user,
  onOpenExample,
  onOpenSaved,
  onDeleteSelected,
}: ExperimentManagerProps) {
  const queryClient = useQueryClient()
  const [selectedTab, setSelectedTab] = useState<string | null>(null)
  const [filters, setFilters] = useState<Record<string, { search: string; repository: string }>>({})
  const [loadingExample, setLoadingExample] = useState<string | null>(null)
  const queryScope = authenticated ? privateQueryScope(user) : 'public'

  const availableQuery = useQuery(availableExperimentsQueryOptions(queryScope))
  const { tabs } = useMemo(() => experimentManagerListing(availableQuery.data), [availableQuery.data])
  const revealedId = useRef<number | null>(null)
  useEffect(() => {
    if (selectedId === null) {
      revealedId.current = null
      return
    }
    if (revealedId.current === selectedId) return
    const selected = [...(availableQuery.data?.mine ?? []), ...(availableQuery.data?.demos ?? [])].find(
      (row) => row.id === selectedId,
    )
    if (!selected) return
    revealedId.current = selectedId
    setSelectedTab(`namespace:${selected.namespace}`)
  }, [availableQuery.data, selectedId])
  const activeTab =
    selectedTab !== null && tabs.some((tab) => tab.value === selectedTab)
      ? selectedTab
      : availableQuery.isPending
        ? ''
        : tabs[0].value
  const filterKey = `${queryScope}/${activeTab}`
  const search = filters[filterKey]?.search ?? ''
  const repository = filters[filterKey]?.repository ?? 'all'
  const example = activeTab === 'example'
  const exampleQuery = useQuery(
    catalogExperimentsQueryOptions({ q: example ? search.trim() : '', limit: 100 }, example),
  )
  const activeQuery = example ? exampleQuery : availableQuery

  useEffect(() => {
    if (!availableQuery.isPending && activeTab !== selectedTab && !selectedId) setSelectedTab(activeTab)
  }, [activeTab, availableQuery.isPending, selectedId, selectedTab])
  const managedVersions = useMemo(
    () =>
      experimentManagerListing(availableQuery.data, exampleQuery.data?.items).versions.filter((item) =>
        example ? item.kind === 'example' : item.kind === 'saved' && `namespace:${item.namespace}` === activeTab,
      ),
    [activeTab, availableQuery.data, example, exampleQuery.data?.items],
  )
  const repositories = useMemo(
    () => [...new Set(managedVersions.map((item) => item.repository))].sort(),
    [managedVersions],
  )
  const visibleVersions = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return managedVersions.filter(
      (item) =>
        (example || !needle || `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle)) &&
        (repository === 'all' || item.repository === repository),
    )
  }, [example, managedVersions, repository, search])

  useEffect(() => {
    if (
      activeQuery.isSuccess &&
      !activeQuery.isFetching &&
      !search &&
      repository !== 'all' &&
      !repositories.includes(repository)
    ) {
      setFilters((current) => ({ ...current, [filterKey]: { search, repository: 'all' } }))
    }
  }, [activeQuery.isFetching, activeQuery.isSuccess, filterKey, repositories, repository, search])

  const deleteMutation = useMutation({
    mutationFn: async (row: SavedExperimentRecord) => {
      const usage = (await dbTables.Experiment.usage([row.id])).items[0]
      const counts = usage?.derivedCounts ?? row.derivedCounts
      const linked = counts ? counts.measurements + counts.recordedData + counts.calculations : 0
      const detail = linked
        ? `\n연결 데이터 ${linked.toLocaleString()}개도 함께 삭제됩니다 (Measurement ${counts!.measurements}, RecordedData ${counts!.recordedData}, Calculation ${counts!.calculations}).`
        : ''
      const demoDetail = row.isDemo
        ? '\n공개 Demo에서 즉시 제거되며, 다음 정상 Demo가 대표 Demo로 승격될 수 있습니다.'
        : ''
      const version = row.version ?? `${row.version_major}.${row.version_minor}.${row.version_patch}`
      if (
        !window.confirm(
          `${row.namespace}/${row.repository_slug}/${row.experiment_key}@${version}을 영구 삭제할까요?${detail}${demoDetail}`,
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
      await invalidateExperimentMutation(queryClient, queryScope, row.id)
      toast.success('Experiment Version을 삭제했습니다.')
    },
    onError: (cause: unknown) => {
      toast.error(cause instanceof Error ? cause.message : 'Experiment Version을 삭제하지 못했습니다.')
    },
  })

  const openExample = async (experiment: CatalogExperimentListItem) => {
    setLoadingExample(experiment.coordinate)
    try {
      const item = await catalogApi.getExperiment(experiment)
      onOpenExample(item.sourceBundle, item.title, item.description)
    } catch (cause: unknown) {
      toast.error(cause instanceof Error ? cause.message : 'Example을 불러오지 못했습니다.')
    } finally {
      setLoadingExample(null)
    }
  }

  return (
    <section aria-label="Experiment Manager" className="flex h-full min-h-0 flex-col bg-background">
      <Tabs value={activeTab} onValueChange={setSelectedTab} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className={`space-y-3 border-b ${compact ? 'p-3' : 'p-4'}`}>
          <h2 className="font-semibold">Experiment Manager</h2>
          <div className="overflow-x-auto">
            <TabsList aria-label="Experiment namespace" className="w-max justify-start">
              {tabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} disabled={availableQuery.isPending}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <label className="relative block">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input
              aria-label="Experiment 검색"
              className="pl-9"
              placeholder="이름 또는 설명 검색"
              value={search}
              onChange={(event) =>
                setFilters((current) => ({ ...current, [filterKey]: { search: event.target.value, repository } }))
              }
            />
          </label>
          <div>
            <Select
              value={repository}
              onValueChange={(value) =>
                setFilters((current) => ({ ...current, [filterKey]: { search, repository: value } }))
              }
            >
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
        <TabsContent value={activeTab} className={`mt-0 flex min-h-0 flex-1 flex-col gap-3 ${compact ? 'p-2' : 'p-4'}`}>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border">
            {example && exampleQuery.isError ? (
              <div
                className="border-b border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                예제 목록을 불러오지 못했습니다.
              </div>
            ) : null}
            {!example && availableQuery.isError ? (
              <div
                className="border-b border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                저장된 Experiment 목록을 불러오지 못했습니다.
              </div>
            ) : null}
            {visibleVersions.length ? (
              <ul className="divide-y">
                {visibleVersions.map((item) => {
                  const savedRow = item.kind === 'saved' ? item.row : null
                  const manageable = Boolean(
                    savedRow &&
                    user &&
                    (user.roles.includes('admin') || (!savedRow.isDemo && savedRow.user_id === user.id)),
                  )
                  const counts = savedRow?.derivedCounts
                  const linked = counts ? counts.measurements + counts.recordedData + counts.calculations : 0
                  return (
                    <li className={savedRow?.id === selectedId ? 'bg-orange-50/70' : undefined} key={item.coordinate}>
                      <div className={`flex items-start gap-3 ${compact ? 'p-3' : 'p-4'}`}>
                        <button
                          className="min-w-0 flex-1 text-left disabled:opacity-50"
                          disabled={busy || (item.kind === 'example' && loadingExample !== null)}
                          type="button"
                          onClick={() =>
                            item.kind === 'example'
                              ? void openExample(item.item)
                              : onOpenSaved(item.row as SavedExperiment)
                          }
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{item.name}</span>
                            <Badge className="bg-muted text-foreground">v{item.version}</Badge>
                            {item.kind === 'example' && loadingExample === item.coordinate ? (
                              <LoaderCircle className="size-4 animate-spin" />
                            ) : null}
                            {savedRow?.sourceLocked ? <Badge className="bg-amber-600 text-white">Locked</Badge> : null}
                            {savedRow?.isDemo ? (
                              <Badge>{manageable ? 'Demo · 관리자 편집 가능' : 'Demo · 읽기 전용'}</Badge>
                            ) : null}
                            {linked ? (
                              <Badge className="border bg-transparent text-foreground">
                                연결 데이터 {linked.toLocaleString()}
                              </Badge>
                            ) : null}
                          </span>
                          <span
                            className={`mt-1 line-clamp-2 block text-muted-foreground ${compact ? 'text-xs leading-5' : 'text-sm'}`}
                            title={item.description}
                          >
                            {item.description}
                          </span>
                        </button>
                        {manageable && savedRow ? (
                          <Button
                            aria-label={`${savedRow.name} v${item.version} 삭제`}
                            disabled={busy || deleteMutation.isPending}
                            size="icon"
                            type="button"
                            variant="ghost"
                            onClick={() => deleteMutation.mutate(savedRow)}
                          >
                            <Trash2 className="text-destructive" />
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : activeQuery.isPending ? (
              <ManagerMessage loading>Experiment 목록을 불러오는 중…</ManagerMessage>
            ) : (
              <ManagerMessage>조건에 맞는 Experiment가 없습니다.</ManagerMessage>
            )}
          </div>
        </TabsContent>
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
