import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, LoaderCircle, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { dbTables, getListRequest } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { SavedMeasurement } from '../types'

const pageSize = 12

export function MeasurementExplorer({
  busy = false,
  className,
  enabled = true,
  experimentId,
  onClearSelection,
  onDelete,
  onSelect,
  selectedId,
}: {
  busy?: boolean
  className?: string
  enabled?: boolean
  experimentId: number | null
  onClearSelection?: () => void
  onDelete?: (rows: readonly SavedMeasurement[]) => Promise<boolean>
  onSelect: (row: SavedMeasurement) => void
  selectedId?: number | null
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [anchorId, setAnchorId] = useState<number | null>(null)
  const [selectedRows, setSelectedRows] = useState<ReadonlyMap<number, SavedMeasurement>>(new Map())
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setPage(0)
    setAnchorId(null)
  }, [search])
  useEffect(() => {
    setPage(0)
    setAnchorId(null)
    setSelectedRows(new Map())
  }, [experimentId])

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
    enabled: enabled && experimentId !== null,
  })
  const total = query.data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1)
  const rows = useMemo(() => (query.data?.items ?? []) as SavedMeasurement[], [query.data?.items])

  useEffect(() => setAnchorId(null), [page])
  useEffect(() => {
    if (!query.isFetching && page > lastPage) setPage(lastPage)
  }, [lastPage, page, query.isFetching])
  useEffect(() => {
    setSelectedRows((current) => {
      const next = new Map(current)
      let changed = false
      rows.forEach((row) => {
        if (next.has(row.id) && next.get(row.id) !== row) {
          next.set(row.id, row)
          changed = true
        }
      })
      return changed ? next : current
    })
  }, [rows])

  const selectRow = (row: SavedMeasurement, event: MouseEvent<HTMLButtonElement>) => {
    const additive = event.ctrlKey || event.metaKey
    const anchorIndex = anchorId === null ? -1 : rows.findIndex((item) => item.id === anchorId)
    const rowIndex = rows.findIndex((item) => item.id === row.id)

    if (event.shiftKey) {
      const range =
        anchorIndex >= 0 && rowIndex >= 0
          ? rows.slice(Math.min(anchorIndex, rowIndex), Math.max(anchorIndex, rowIndex) + 1)
          : [row]
      setSelectedRows((current) => {
        const next = additive ? new Map(current) : new Map<number, SavedMeasurement>()
        range.forEach((item) => next.set(item.id, item))
        return next
      })
      if (anchorIndex < 0) setAnchorId(row.id)
      onSelect(row)
      return
    }

    setAnchorId(row.id)
    if (!additive) {
      setSelectedRows(new Map([[row.id, row]]))
      onSelect(row)
      return
    }

    const next = new Map(selectedRows)
    if (next.has(row.id)) {
      next.delete(row.id)
      if (row.id === selectedId) {
        const remainingRows = Array.from(next.values())
        const remaining = remainingRows[remainingRows.length - 1]
        if (remaining) onSelect(remaining)
        else onClearSelection?.()
      }
    } else {
      next.set(row.id, row)
      onSelect(row)
    }
    setSelectedRows(next)
  }

  const deleteSelected = async () => {
    if (!onDelete || selectedRows.size === 0 || deleting || busy) return
    const selected = Array.from(selectedRows.values())
    const recordedCount = selected.filter((row) => row.recorded_at).length
    if (
      !window.confirm(
        `선택한 Measurement ${selected.length.toLocaleString()}개를 영구 삭제할까요?\nRecorded Measurement ${recordedCount.toLocaleString()}개에 연결된 RecordedData도 함께 삭제됩니다.`,
      )
    ) {
      return
    }
    setDeleting(true)
    try {
      if (await onDelete(selected)) {
        setSelectedRows(new Map())
        setAnchorId(null)
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section
      aria-label="Measurement 목록"
      className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-hidden', className)}
    >
      <label className="relative shrink-0">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input
          aria-label="Measurement 검색"
          className="pl-9"
          placeholder="ID, 변수 또는 Material 값 검색"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="flex shrink-0 items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{selectedRows.size.toLocaleString()}개 선택</span>
        {onDelete ? (
          <Button
            disabled={selectedRows.size === 0 || deleting || busy}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void deleteSelected()}
          >
            {deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            삭제
          </Button>
        ) : null}
      </div>
      <div className="min-h-48 flex-1 overflow-y-auto rounded-md border">
        {experimentId === null ? (
          <div className="grid min-h-48 place-items-center px-4 text-center text-sm text-muted-foreground">
            먼저 저장된 Experiment를 불러오세요.
          </div>
        ) : query.isLoading ? (
          <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
            <span>
              <LoaderCircle className="mr-2 inline size-4 animate-spin" />
              불러오는 중…
            </span>
          </div>
        ) : query.isError ? (
          <div className="grid min-h-48 place-items-center text-sm text-destructive">목록을 불러오지 못했습니다.</div>
        ) : rows.length ? (
          <ul
            aria-label="Measurement 점 배열"
            className="grid grid-cols-[repeat(auto-fill,2rem)] content-start gap-3 p-3"
          >
            {rows.map((row) => {
              const selected = selectedRows.has(row.id)
              const status = row.recorded_at ? 'Recorded' : 'Prepared'
              return (
                <li key={row.id}>
                  <button
                    aria-current={row.id === selectedId ? 'true' : undefined}
                    aria-label={`Measurement #${row.id} ${status}`}
                    aria-pressed={selected}
                    className={cn(
                      'size-8 rounded-sm border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      row.recorded_at
                        ? 'border-emerald-700 bg-emerald-500 hover:bg-emerald-600'
                        : 'border-slate-400 bg-slate-300 hover:bg-slate-400',
                      selected && 'ring-2 ring-primary ring-offset-1',
                      row.id === selectedId && 'outline-2 outline-offset-2 outline-orange-500',
                    )}
                    title={`Measurement #${row.id} · ${status}`}
                    type="button"
                    onClick={(event) => selectRow(row, event)}
                  />
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="grid min-h-48 place-items-center text-sm text-muted-foreground">
            준비된 Measurement가 없습니다.
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3">
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
      </footer>
    </section>
  )
}
