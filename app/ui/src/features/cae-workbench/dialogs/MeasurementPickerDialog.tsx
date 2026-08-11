import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, LoaderCircle, Search } from 'lucide-react'
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
  onOpenChange,
  onSelect,
  open,
  selectedId,
  structureId,
}: {
  experimentId: number | null
  onOpenChange: (open: boolean) => void
  onSelect: (row: SavedMeasurement) => void
  open: boolean
  selectedId?: number | null
  structureId: number | null
}) {
  const [idSearch, setIdSearch] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => {
    if (open) setPage(0)
  }, [experimentId, idSearch, open, structureId])

  const request = useMemo(() => {
    const searchedId = Number(idSearch)
    const selectedIds = Number.isSafeInteger(searchedId) && searchedId > 0 ? [searchedId] : []
    return {
      ...getListRequest('mine'),
      structure_id: structureId!,
      experiment_id: experimentId!,
      offset: page * pageSize,
      limit: pageSize,
      selected_ids: selectedIds,
      sort: ['updated_at', 'desc'] as [string, 'desc'],
    }
  }, [experimentId, idSearch, page, structureId])
  const query = useQuery({
    queryKey: ['cae-workbench', 'measurements', request],
    queryFn: () => dbTables.Measurement.listContextPage(request),
    enabled: open && structureId !== null && experimentId !== null,
  })
  const total = query.data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85dvh] max-w-3xl overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Measurement 선택</DialogTitle>
          <DialogDescription>현재 Structure + Experiment 조합에 저장된 Measurement를 선택합니다.</DialogDescription>
        </DialogHeader>
        <label className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Measurement ID 검색"
            className="pl-9"
            inputMode="numeric"
            placeholder="Measurement ID 검색"
            value={idSearch}
            onChange={(event) => setIdSearch(event.target.value.replace(/[^0-9]/gu, ''))}
          />
        </label>
        <div className="min-h-64 overflow-y-auto rounded-md border">
          {!structureId || !experimentId ? (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              먼저 저장된 Structure와 Experiment를 불러오세요.
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
              {query.data.items.map((row) => (
                <li key={row.id}>
                  <button
                    className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted/60 ${
                      row.id === selectedId ? 'bg-orange-50' : ''
                    }`}
                    type="button"
                    onClick={() => {
                      if (!row.id) return
                      onSelect(row as SavedMeasurement)
                      onOpenChange(false)
                    }}
                  >
                    <span>
                      <span className="block font-medium">Measurement #{row.id}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Sample #{row.sample_id} + Setup #{row.setup_id}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">
              저장된 Measurement가 없습니다.
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
