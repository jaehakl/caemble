import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, LoaderCircle, Search } from 'lucide-react'
import {
  dbTables,
  getListRequest,
  type ExperimentRecord,
  type GetListRequest,
  type GetListResponse,
  type StructureRecord,
} from '@/api'
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
import type { SavedExperiment, SavedStructure } from '../types'

const pageSize = 10

export function DefinitionPickerDialog({
  authenticated = true,
  kind,
  onOpenChange,
  onSelect,
  open,
  selectedId,
}: {
  authenticated?: boolean
  kind: 'structure' | 'experiment'
  onOpenChange: (open: boolean) => void
  onSelect: (row: SavedStructure | SavedExperiment) => void
  open: boolean
  selectedId?: number | null
}) {
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<'visible' | 'mine' | 'public'>('visible')
  const [sort, setSort] = useState<'updated' | 'name'>('updated')
  const [page, setPage] = useState(0)
  useEffect(() => {
    if (open) setPage(0)
  }, [open, search, scope, sort])
  useEffect(() => {
    if (!authenticated && scope === 'mine') setScope('visible')
  }, [authenticated, scope])

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
  const query = useQuery<GetListResponse<StructureRecord | ExperimentRecord>>({
    queryKey: ['cae-workbench', kind, request],
    queryFn: async () =>
      (kind === 'structure'
        ? await dbTables.Structure.listRows(request)
        : await dbTables.Experiment.listRows(request)) as GetListResponse<StructureRecord | ExperimentRecord>,
    enabled: open,
  })
  const title = kind === 'structure' ? 'Structure 불러오기' : 'Experiment 불러오기'
  const total = query.data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>검색, 공개 범위와 정렬을 조합해 저장된 정의를 선택합니다.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_10rem]">
          <label className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
            <Input
              aria-label={`${title} 검색`}
              className="pl-9"
              placeholder="이름, 설명 검색"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Select value={scope} onValueChange={(value) => setScope(value as typeof scope)}>
            <SelectTrigger aria-label="공개 범위">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="visible">볼 수 있는 항목</SelectItem>
              {authenticated ? <SelectItem value="mine">내 항목</SelectItem> : null}
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
          {query.isLoading ? (
            <div className="grid min-h-72 place-items-center text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 inline size-4 animate-spin" /> 불러오는 중…
            </div>
          ) : query.isError ? (
            <div className="grid min-h-72 place-items-center p-6 text-sm text-destructive">
              목록을 불러오지 못했습니다.
            </div>
          ) : query.data?.items.length ? (
            <ul className="divide-y">
              {query.data.items.map((row) => (
                <li key={row.id}>
                  <button
                    className={`grid w-full gap-1 px-4 py-3 text-left hover:bg-muted/60 ${
                      row.id === selectedId ? 'bg-orange-50' : ''
                    }`}
                    type="button"
                    onDoubleClick={() => {
                      if (!row.id) return
                      onSelect(row as SavedStructure | SavedExperiment)
                      onOpenChange(false)
                    }}
                    onClick={() => {
                      if (!row.id) return
                      onSelect(row as SavedStructure | SavedExperiment)
                      onOpenChange(false)
                    }}
                  >
                    <span className="flex items-center justify-between gap-4">
                      <span className="font-medium">{row.name}</span>
                      <span className="text-xs text-muted-foreground">#{row.id}</span>
                    </span>
                    <span className="line-clamp-2 text-sm text-muted-foreground">{row.description || '설명 없음'}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid min-h-72 place-items-center text-sm text-muted-foreground">
              조건에 맞는 항목이 없습니다.
            </div>
          )}
        </div>
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
      </DialogContent>
    </Dialog>
  )
}
