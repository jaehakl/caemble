import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Copy, LoaderCircle, Search } from 'lucide-react'
import { dbTables, getListRequest } from '@/api'
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
import type { SavedMeasurement } from '../types'

const pageSize = 12

export function MeasurementPickerDialog({
  experimentId,
  onDuplicate,
  onOpenChange,
  onSelect,
  open,
  selectedId,
}: {
  experimentId: number | null
  onDuplicate: (row: SavedMeasurement) => void
  onOpenChange: (open: boolean) => void
  onSelect: (row: SavedMeasurement) => void
  open: boolean
  selectedId?: number | null
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => {
    if (open) setPage(0)
  }, [experimentId, open, search])

  const request = useMemo(() => {
    const trimmed = search.trim()
    const searchedId = Number(trimmed)
    const textFilter: Record<string, string[]> =
      trimmed && !Number.isSafeInteger(searchedId) ? { vars: [trimmed], material_parameters: [trimmed] } : {}
    return {
      ...getListRequest('mine'),
      offset: page * pageSize,
      limit: pageSize,
      selected_ids: Number.isSafeInteger(searchedId) && searchedId > 0 ? [searchedId] : [],
      search_text: null,
      text_filter: textFilter,
      filter: { experiment_id: [experimentId, experimentId] },
      sort: ['updated_at', 'desc'] as [string, 'desc'],
    }
  }, [experimentId, page, search])
  const query = useQuery({
    queryKey: ['cae-workbench', 'measurements', request],
    queryFn: () => dbTables.Measurement.listRows(request),
    enabled: open && experimentId !== null,
  })
  const total = query.data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Measurement 선택</DialogTitle>
          <DialogDescription>현재 Experiment에 준비된 고정 입력 조건을 선택합니다.</DialogDescription>
        </DialogHeader>
        <label className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Measurement 검색"
            className="pl-9"
            placeholder="ID, 변수 또는 Material 값 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="min-h-64 overflow-y-auto rounded-md border">
          {!experimentId ? (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              먼저 저장된 Experiment를 불러오세요.
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
            <ul className="divide-y">
              {query.data.items.map((raw) => {
                const row = raw as SavedMeasurement
                return (
                  <li className={row.id === selectedId ? 'bg-orange-50' : ''} key={row.id}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <button
                        className="min-w-0 flex-1 text-left hover:text-primary"
                        type="button"
                        onClick={() => {
                          onSelect(row)
                          onOpenChange(false)
                        }}
                      >
                        <span className="flex items-center gap-2 font-medium">
                          Measurement #{row.id}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] ${row.recorded_at ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}
                          >
                            {row.recorded_at ? 'Recorded' : 'Prepared'}
                          </span>
                        </span>
                        <code className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                          {JSON.stringify(row.vars)}
                        </code>
                      </button>
                      <Button
                        aria-label={`Measurement #${row.id} 복제`}
                        size="icon"
                        type="button"
                        variant="ghost"
                        onClick={() => onDuplicate(row)}
                      >
                        <Copy />
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              준비된 Measurement가 없습니다.
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
