import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { dbTables, getListRequest, type ExperimentRecord, type GetListRequest, type UserData } from '@/api'
import { catalogApi, catalogQueryKeys, type CatalogExperimentListItem } from '@/api/catalog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { assertExperimentSourceBundle } from '@/lib/cad'
import { authQueryKey } from '@/features/auth/use-auth'
import type { SavedExperiment } from '../types'

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

type ManagedExperimentVersion =
  | Readonly<{
      kind: 'example'
      coordinate: string
      description: string
      experimentKey: string
      identity: string
      name: string
      namespace: string
      repository: string
      version: string
      versionParts: readonly [number, number, number]
      item: CatalogExperimentListItem
    }>
  | Readonly<{
      kind: 'saved'
      coordinate: string
      description: string
      experimentKey: string
      identity: string
      name: string
      namespace: string
      repository: string
      version: string
      versionParts: readonly [number, number, number]
      row: ExperimentRecord
    }>

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
  const [search, setSearch] = useState('')
  const [namespace, setNamespace] = useState('all')
  const [repository, setRepository] = useState('all')
  const [loadingExample, setLoadingExample] = useState<string | null>(null)

  const exampleQuery = useQuery({
    queryKey: catalogQueryKeys.experiments({ q: search.trim(), limit: 100 }),
    queryFn: () => catalogApi.listExperiments({ q: search.trim(), limit: 100 }),
  })
  const savedRequest = useMemo<GetListRequest>(
    () => ({
      ...getListRequest('mine'),
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
    [search],
  )
  const savedQuery = useQuery({
    queryKey: ['cae-workbench', 'experiments', savedRequest],
    queryFn: () => dbTables.Experiment.listRows(savedRequest),
    enabled: authenticated,
  })
  const managedVersions = useMemo<readonly ManagedExperimentVersion[]>(() => {
    const examples = (exampleQuery.data?.items ?? []).map((item): ManagedExperimentVersion => {
      const versionParts = item.version.split('.').map(Number) as [number, number, number]
      return {
        kind: 'example',
        coordinate: item.coordinate,
        description: item.description || '설명 없음',
        experimentKey: item.key,
        identity: `${item.namespace}/${item.repository}/${item.key}`,
        name: item.title,
        namespace: item.namespace,
        repository: item.repository,
        version: item.version,
        versionParts,
        item,
      }
    })
    const saved = (savedQuery.data?.items ?? []).map((row): ManagedExperimentVersion => {
      const version = row.version ?? `${row.version_major}.${row.version_minor}.${row.version_patch}`
      const identity = `${row.namespace}/${row.repository_slug}/${row.experiment_key}`
      return {
        kind: 'saved',
        coordinate: row.coordinate ?? `caemble:experiment/${identity}@${version}`,
        description: row.description || '설명 없음',
        experimentKey: row.experiment_key,
        identity,
        name: row.name,
        namespace: row.namespace,
        repository: row.repository_slug,
        version,
        versionParts: [row.version_major, row.version_minor, row.version_patch],
        row,
      }
    })
    return Object.freeze([...examples, ...saved])
  }, [exampleQuery.data?.items, savedQuery.data?.items])
  const namespaces = useMemo(() => {
    return [...new Set(managedVersions.map((item) => item.namespace))].sort()
  }, [managedVersions])
  const repositories = useMemo(
    () =>
      [
        ...new Set(
          managedVersions
            .filter((item) => namespace === 'all' || item.namespace === namespace)
            .map((item) => item.repository),
        ),
      ].sort(),
    [managedVersions, namespace],
  )
  const visibleVersions = useMemo(() => {
    const grouped = new Map<string, ManagedExperimentVersion[]>()
    managedVersions
      .filter(
        (item) =>
          (namespace === 'all' || item.namespace === namespace) &&
          (repository === 'all' || item.repository === repository),
      )
      .forEach((item) => {
        grouped.set(item.identity, [...(grouped.get(item.identity) ?? []), item])
      })
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, versions]) => {
        versions.sort(
          (left, right) =>
            right.versionParts[0] - left.versionParts[0] ||
            right.versionParts[1] - left.versionParts[1] ||
            right.versionParts[2] - left.versionParts[2],
        )
        return versions
      })
  }, [managedVersions, namespace, repository])

  const filtersReady = !exampleQuery.isPending && (!authenticated || !savedQuery.isPending)
  useEffect(() => {
    if (filtersReady && namespace !== 'all' && !namespaces.includes(namespace)) {
      setNamespace('all')
      setRepository('all')
    }
  }, [filtersReady, namespace, namespaces])
  useEffect(() => {
    if (filtersReady && repository !== 'all' && !repositories.includes(repository)) setRepository('all')
  }, [filtersReady, repositories, repository])

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
      await queryClient.invalidateQueries({ queryKey: authQueryKey })
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
      assertExperimentSourceBundle(item.sourceBundle)
      onOpenExample(item.sourceBundle, item.title, item.description)
    } catch (cause: unknown) {
      toast.error(cause instanceof Error ? cause.message : 'Example을 불러오지 못했습니다.')
    } finally {
      setLoadingExample(null)
    }
  }

  return (
    <section aria-label="Experiment Manager" className="flex h-full min-h-0 flex-col bg-background">
      <header className={`space-y-3 border-b ${compact ? 'p-3' : 'p-4'}`}>
        <h2 className="font-semibold">Experiment Manager</h2>
        <label className="relative block">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Experiment 검색"
            className="pl-9"
            placeholder="이름 또는 설명 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className={compact ? 'grid gap-2' : 'grid gap-2 sm:grid-cols-2'}>
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
      <div className={`flex min-h-0 flex-1 flex-col gap-3 ${compact ? 'p-2' : 'p-4'}`}>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          {exampleQuery.isError ? (
            <div
              className="border-b border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              Example 목록을 불러오지 못했습니다.
            </div>
          ) : null}
          {authenticated && savedQuery.isError ? (
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
                  savedRow && user && (savedRow.user_id === user.id || user.roles.includes('admin')),
                )
                const counts = savedRow?.derivedCounts
                const linked = counts
                  ? counts.measurements + counts.recordedData + counts.designerModels + counts.predictorModels
                  : 0
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
          ) : exampleQuery.isPending || (authenticated && savedQuery.isPending) ? (
            <ManagerMessage loading>Experiment 목록을 불러오는 중…</ManagerMessage>
          ) : (
            <ManagerMessage>조건에 맞는 Experiment가 없습니다.</ManagerMessage>
          )}
        </div>
      </div>
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
