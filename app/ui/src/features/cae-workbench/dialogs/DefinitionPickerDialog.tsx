import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, LoaderCircle, Search } from 'lucide-react'
import { dbTables, getListRequest, type ExperimentRecord, type GetListRequest, type GetListResponse } from '@/api'
import { catalogApi, catalogQueryKeys, type CatalogExperimentDetail } from '@/api/catalog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { SavedExperiment } from '../types'

const pageSize = 10

export function DefinitionPickerDialog({
  authenticated = true,
  onOpenChange,
  onSelect,
  onSelectCatalog,
  open,
  selectedId,
}: {
  authenticated?: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (row: SavedExperiment) => void
  onSelectCatalog: (item: CatalogExperimentDetail) => void
  open: boolean
  selectedId?: number | null
}) {
  const [tab, setTab] = useState<'official' | 'saved'>('official')
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<'visible' | 'mine' | 'public'>('visible')
  const [sort, setSort] = useState<'updated' | 'name'>('updated')
  const [page, setPage] = useState(0)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPage(0)
      setDetailError(null)
      if (!authenticated) setTab('official')
    }
  }, [authenticated, open])
  useEffect(() => setPage(0), [search, scope, sort])

  const request = useMemo<GetListRequest>(() => {
    const trimmedSearch = search.trim()
    const textFilter: Record<string, string[]> = trimmedSearch ? { workbench: [trimmedSearch] } : {}
    return {
      ...getListRequest(scope),
      offset: page * pageSize,
      limit: pageSize,
      text_filter: textFilter,
      sort: sort === 'updated' ? ['updated_at', 'desc'] : ['name', 'asc'],
    }
  }, [page, scope, search, sort])
  const officialQuery = useQuery({
    queryKey: catalogQueryKeys.experiments({ q: search.trim(), limit: 100 }),
    queryFn: () => catalogApi.listExperiments({ q: search.trim(), limit: 100 }),
    enabled: open && tab === 'official',
  })
  const savedQuery = useQuery<GetListResponse<ExperimentRecord>>({
    queryKey: ['cae-workbench', 'experiment', request],
    queryFn: () => dbTables.Experiment.listRows(request),
    enabled: open && authenticated && tab === 'saved',
  })
  const total = savedQuery.data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)

  const selectOfficial = async (key: string) => {
    setLoadingKey(key)
    setDetailError(null)
    try {
      const detail = await catalogApi.getExperiment(key)
      onSelectCatalog(detail)
      onOpenChange(false)
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : '공식 Experiment를 불러오지 못했습니다.')
    } finally {
      setLoadingKey(null)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Experiment 불러오기</DialogTitle>
          <DialogDescription>
            공식 카탈로그 항목은 로컬 사본으로 열리며 Save 시 새 사용자 Experiment로 저장됩니다.
          </DialogDescription>
        </DialogHeader>
        <label className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Experiment 검색"
            className="pl-9"
            placeholder="이름, 설명 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
          <TabsList className={`grid w-full ${authenticated ? 'grid-cols-2' : 'grid-cols-1'}`}>
            <TabsTrigger value="official">Official Catalog</TabsTrigger>
            {authenticated ? <TabsTrigger value="saved">Saved Experiments</TabsTrigger> : null}
          </TabsList>
          <TabsContent value="official">
            <div className="min-h-72 overflow-y-auto rounded-md border">
              {officialQuery.isLoading ? (
                <Loading />
              ) : officialQuery.isError ? (
                <Message destructive>공식 카탈로그를 불러오지 못했습니다.</Message>
              ) : officialQuery.data?.items.length ? (
                <ul className="divide-y">
                  {officialQuery.data.items.map((item) => (
                    <li key={item.key}>
                      <button
                        className="grid w-full gap-1 px-4 py-3 text-left hover:bg-muted/60 disabled:opacity-60"
                        disabled={loadingKey !== null}
                        type="button"
                        onClick={() => void selectOfficial(item.key)}
                      >
                        <span className="flex items-center justify-between gap-4">
                          <span className="font-medium">{item.title}</span>
                          <span className="font-mono text-xs text-muted-foreground">{item.key}</span>
                        </span>
                        <span className="line-clamp-2 text-sm text-muted-foreground">{item.description}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.relatedSolvers.map((solver) => `${solver.name}@${solver.version}`).join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <Message>조건에 맞는 공식 Experiment가 없습니다.</Message>
              )}
            </div>
            {detailError ? <p className="mt-2 text-sm text-destructive">{detailError}</p> : null}
          </TabsContent>
          {authenticated ? (
            <TabsContent value="saved">
              <div className="mb-2 grid gap-2 sm:grid-cols-2">
                <Select value={scope} onValueChange={(value) => setScope(value as typeof scope)}>
                  <SelectTrigger aria-label="공개 범위">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="visible">볼 수 있는 항목</SelectItem>
                    <SelectItem value="mine">내 항목</SelectItem>
                    <SelectItem value="public">공개 항목</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}>
                  <SelectTrigger aria-label="정렬">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="updated">최근 수정순</SelectItem>
                    <SelectItem value="name">이름순</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-h-72 overflow-y-auto rounded-md border">
                {savedQuery.isLoading ? (
                  <Loading />
                ) : savedQuery.isError ? (
                  <Message destructive>저장된 Experiment 목록을 불러오지 못했습니다.</Message>
                ) : savedQuery.data?.items.length ? (
                  <ul className="divide-y">
                    {savedQuery.data.items.map((row) => (
                      <li key={row.id}>
                        <button
                          className={`grid w-full gap-1 px-4 py-3 text-left hover:bg-muted/60 ${row.id === selectedId ? 'bg-orange-50' : ''}`}
                          type="button"
                          onClick={() => {
                            if (!row.id) return
                            onSelect(row as SavedExperiment)
                            onOpenChange(false)
                          }}
                        >
                          <span className="flex items-center justify-between gap-4">
                            <span className="font-medium">{row.name}</span>
                            <span className="text-xs text-muted-foreground">#{row.id}</span>
                          </span>
                          <span className="line-clamp-2 text-sm text-muted-foreground">
                            {row.description || '설명 없음'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Message>조건에 맞는 저장된 Experiment가 없습니다.</Message>
                )}
              </div>
            </TabsContent>
          ) : null}
        </Tabs>
        {tab === 'saved' && authenticated ? (
          <DialogFooter className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              {total.toLocaleString()}개 · {page + 1}/{lastPage + 1} 페이지
            </span>
            <div className="flex gap-2">
              <Button disabled={page === 0} size="sm" type="button" variant="outline" onClick={() => setPage(page - 1)}>
                <ChevronLeft /> 이전
              </Button>
              <Button
                disabled={page >= lastPage}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => setPage(page + 1)}
              >
                다음 <ChevronRight />
              </Button>
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Loading() {
  return (
    <div className="grid min-h-72 place-items-center text-sm text-muted-foreground">
      <span>
        <LoaderCircle className="mr-2 inline size-4 animate-spin" /> 불러오는 중…
      </span>
    </div>
  )
}

function Message({ children, destructive = false }: { children: string; destructive?: boolean }) {
  return (
    <div
      className={`grid min-h-72 place-items-center p-6 text-sm ${destructive ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {children}
    </div>
  )
}
