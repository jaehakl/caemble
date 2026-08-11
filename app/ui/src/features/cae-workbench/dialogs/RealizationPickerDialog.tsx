import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, LoaderCircle, Search } from 'lucide-react'
import {
  dbTables,
  getListRequest,
  type GetListRequest,
  type GetListResponse,
  type SampleRecord,
  type SetupRecord,
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
import type { SavedSample, SavedSetup } from '../types'

const pageSize = 12

export function RealizationPickerDialog({
  definitionId,
  kind,
  onOpenChange,
  onSelect,
  open,
  selectedId,
}: {
  definitionId: number | null
  kind: 'sample' | 'setup'
  onOpenChange: (open: boolean) => void
  onSelect: (row: SavedSample | SavedSetup) => void
  open: boolean
  selectedId?: number | null
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => {
    if (open) setPage(0)
  }, [definitionId, open, search])

  const request = useMemo<GetListRequest>(() => {
    const trimmedSearch = search.trim()
    const searchedId = Number(trimmedSearch)
    const selectedIds = Number.isSafeInteger(searchedId) && searchedId > 0 ? [searchedId] : []
    const textFilter: Record<string, string[]> =
      trimmedSearch && selectedIds.length === 0 ? { vars: [trimmedSearch], material_parameters: [trimmedSearch] } : {}
    const filter: Record<string, unknown[]> =
      kind === 'sample'
        ? { structure_id: [definitionId, definitionId] }
        : { experiment_id: [definitionId, definitionId] }
    return {
      ...getListRequest('mine'),
      offset: page * pageSize,
      limit: pageSize,
      selected_ids: selectedIds,
      search_text: null,
      text_filter: textFilter,
      filter,
      sort: ['updated_at', 'desc'],
    }
  }, [definitionId, kind, page, search])
  const query = useQuery<GetListResponse<SampleRecord | SetupRecord>>({
    queryKey: ['cae-workbench', kind, request],
    queryFn: async () =>
      (kind === 'sample'
        ? await dbTables.Sample.listRows(request)
        : await dbTables.Setup.listRows(request)) as GetListResponse<SampleRecord | SetupRecord>,
    enabled: open && definitionId !== null,
  })
  const title = kind === 'sample' ? 'Sample 선택' : 'Setup 선택'
  const total = query.data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85dvh] max-w-3xl overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            현재 {kind === 'sample' ? 'Structure' : 'Experiment'}에 저장된 실현값을 선택합니다.
          </DialogDescription>
        </DialogHeader>
        <label className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label={`${title} 검색`}
            className="pl-9"
            placeholder="ID 또는 저장된 값 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="min-h-64 overflow-y-auto rounded-md border">
          {!definitionId ? (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              먼저 {kind === 'sample' ? 'Structure' : 'Experiment'}를 불러오세요.
            </div>
          ) : query.isLoading ? (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              <span>
                <LoaderCircle className="mr-2 inline size-4 animate-spin" />
                불러오는 중…
              </span>
            </div>
          ) : query.isError ? (
            <div className="grid min-h-64 place-items-center text-sm text-destructive">목록을 불러오지 못했습니다.</div>
          ) : query.data?.items.length ? (
            <ul className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">
              {query.data.items.map((row) => (
                <li className="bg-background" key={row.id}>
                  <button
                    className={`h-full w-full p-3 text-left hover:bg-muted/60 ${row.id === selectedId ? 'bg-orange-50' : ''}`}
                    type="button"
                    onClick={() => {
                      if (!row.id) return
                      onSelect(row as SavedSample | SavedSetup)
                      onOpenChange(false)
                    }}
                  >
                    <span className="flex justify-between gap-3 text-sm font-medium">
                      <span>
                        {kind === 'sample' ? 'Sample' : 'Setup'} #{row.id}
                      </span>
                      <span className="font-normal text-muted-foreground">
                        {row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'}
                      </span>
                    </span>
                    <code className="mt-2 line-clamp-3 block text-xs text-muted-foreground">
                      {JSON.stringify(row.vars)}
                    </code>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              저장된 실현값이 없습니다.
            </div>
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">{total.toLocaleString()}개</span>
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
