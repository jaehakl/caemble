import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, LoaderCircle, Search } from 'lucide-react'
import { dbTables, type DefinitionScope, type MeasurementPairListItem, type MeasurementPairListRequest } from '@/api'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export type ResearchPickerMode = 'research' | 'other-structures' | 'other-experiments'

export type ResearchPickerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (pair: MeasurementPairListItem) => void
  mode?: ResearchPickerMode
  structureId?: number | null
  experimentId?: number | null
}

const PAGE_SIZE = 12

function dialogCopy(mode: ResearchPickerMode) {
  if (mode === 'other-structures') {
    return {
      title: '다른 Structure 선택',
      description: '현재 Experiment와 함께 측정된 Structure를 선택합니다.',
    }
  }
  if (mode === 'other-experiments') {
    return {
      title: '다른 Experiment 선택',
      description: '현재 Structure와 함께 측정된 Experiment를 선택합니다.',
    }
  }
  return {
    title: 'Research 불러오기',
    description: '측정 이력이 있는 Structure + Experiment 조합을 검색합니다.',
  }
}

function utcRange(date: string, endOfDay = false) {
  if (!date) return undefined
  return `${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
}

export function ResearchPickerDialog({
  open,
  onOpenChange,
  onSelect,
  mode = 'research',
  structureId,
  experimentId,
}: ResearchPickerDialogProps) {
  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch] = useState('')
  const [structureScope, setStructureScope] = useState<DefinitionScope>('visible')
  const [experimentScope, setExperimentScope] = useState<DefinitionScope>('visible')
  const [measuredFrom, setMeasuredFrom] = useState('')
  const [measuredTo, setMeasuredTo] = useState('')
  const [sort, setSort] = useState('latest_measurement_at:desc')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<MeasurementPairListItem | null>(null)
  const copy = dialogCopy(mode)

  useEffect(() => {
    setPage(0)
    setSelected(null)
  }, [mode, structureId, experimentId])

  const request = useMemo<MeasurementPairListRequest>(() => {
    const [sortField, sortDirection] = sort.split(':') as [
      'latest_measurement_at' | 'measurement_count' | 'structure_name' | 'experiment_name',
      'asc' | 'desc',
    ]
    return {
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
      search_text: search || null,
      structure_id: mode === 'other-experiments' && structureId ? structureId : undefined,
      experiment_id: mode === 'other-structures' && experimentId ? experimentId : undefined,
      exclude_structure_id: mode === 'other-structures' && structureId ? structureId : undefined,
      exclude_experiment_id: mode === 'other-experiments' && experimentId ? experimentId : undefined,
      structure_scope: structureScope,
      experiment_scope: experimentScope,
      measured_from: utcRange(measuredFrom),
      measured_to: utcRange(measuredTo, true),
      sort: [sortField, sortDirection],
    }
  }, [experimentId, experimentScope, measuredFrom, measuredTo, mode, page, search, sort, structureId, structureScope])

  const pairsQuery = useQuery({
    queryKey: ['cae-workbench', 'measurement-pairs', request],
    queryFn: () => dbTables.Measurement.listPairs(request),
    enabled:
      open &&
      (mode === 'research' ||
        (mode === 'other-structures' && Boolean(experimentId)) ||
        (mode === 'other-experiments' && Boolean(structureId))),
    placeholderData: (previous) => previous,
  })

  const pageCount = Math.max(1, Math.ceil((pairsQuery.data?.total ?? 0) / PAGE_SIZE))

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    setPage(0)
    setSelected(null)
    setSearch(draftSearch.trim())
  }

  const choose = () => {
    if (!selected) return
    onSelect(selected)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100dvh-2rem)] max-w-6xl grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
          <form className="flex gap-2" onSubmit={submitSearch}>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Research 검색"
                className="pl-9"
                placeholder="Structure 또는 Experiment 이름과 설명"
                value={draftSearch}
                onChange={(event) => setDraftSearch(event.target.value)}
              />
            </div>
            <Button type="submit" variant="outline">
              검색
            </Button>
          </form>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {mode !== 'other-experiments' ? (
              <label className="grid gap-1 text-xs text-muted-foreground">
                Structure 범위
                <Select
                  value={structureScope}
                  onValueChange={(value: DefinitionScope) => {
                    setPage(0)
                    setStructureScope(value)
                  }}
                >
                  <SelectTrigger aria-label="Structure 범위">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="visible">내 항목 + Public</SelectItem>
                    <SelectItem value="mine">내 항목</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            {mode !== 'other-structures' ? (
              <label className="grid gap-1 text-xs text-muted-foreground">
                Experiment 범위
                <Select
                  value={experimentScope}
                  onValueChange={(value: DefinitionScope) => {
                    setPage(0)
                    setExperimentScope(value)
                  }}
                >
                  <SelectTrigger aria-label="Experiment 범위">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="visible">내 항목 + Public</SelectItem>
                    <SelectItem value="mine">내 항목</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            <label className="grid gap-1 text-xs text-muted-foreground">
              측정 시작일
              <Input
                aria-label="측정 시작일"
                type="date"
                value={measuredFrom}
                onChange={(event) => {
                  setPage(0)
                  setMeasuredFrom(event.target.value)
                }}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              측정 종료일
              <Input
                aria-label="측정 종료일"
                type="date"
                value={measuredTo}
                onChange={(event) => {
                  setPage(0)
                  setMeasuredTo(event.target.value)
                }}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              정렬
              <Select
                value={sort}
                onValueChange={(value) => {
                  setPage(0)
                  setSort(value)
                }}
              >
                <SelectTrigger aria-label="Research 정렬">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="latest_measurement_at:desc">최근 측정순</SelectItem>
                  <SelectItem value="latest_measurement_at:asc">오래된 측정순</SelectItem>
                  <SelectItem value="measurement_count:desc">측정 많은순</SelectItem>
                  <SelectItem value="structure_name:asc">Structure 이름순</SelectItem>
                  <SelectItem value="experiment_name:asc">Experiment 이름순</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
        </div>

        <div className="min-h-64 overflow-auto rounded-lg border">
          {pairsQuery.isLoading ? (
            <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="animate-spin" /> 측정 조합을 불러오는 중입니다.
            </div>
          ) : pairsQuery.isError ? (
            <div className="flex h-64 items-center justify-center text-sm text-destructive">
              측정 조합을 불러오지 못했습니다.
            </div>
          ) : (pairsQuery.data?.items.length ?? 0) === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              조건에 맞는 측정 조합이 없습니다.
            </div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Structure</TableHead>
                  <TableHead>Experiment</TableHead>
                  <TableHead className="w-24 text-right">Measurements</TableHead>
                  <TableHead className="w-44">최근 측정</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pairsQuery.data?.items.map((pair) => {
                  const isSelected =
                    selected?.structure_id === pair.structure_id && selected.experiment_id === pair.experiment_id
                  return (
                    <TableRow
                      key={`${pair.structure_id}:${pair.experiment_id}`}
                      className="cursor-pointer"
                      data-state={isSelected ? 'selected' : undefined}
                      tabIndex={0}
                      onClick={() => setSelected(pair)}
                      onDoubleClick={() => {
                        onSelect(pair)
                        onOpenChange(false)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') setSelected(pair)
                      }}
                    >
                      <TableCell>
                        <div className="font-medium">{pair.structure_name}</div>
                        <div className="max-w-72 truncate text-xs text-muted-foreground">
                          {pair.structure_description || '설명 없음'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{pair.experiment_name}</div>
                        <div className="max-w-72 truncate text-xs text-muted-foreground">
                          {pair.experiment_description || '설명 없음'}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {pair.measurement_count.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {new Date(pair.latest_measurement_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              aria-label="이전 페이지"
              disabled={page === 0 || pairsQuery.isFetching}
              size="icon"
              variant="outline"
              onClick={() => {
                setSelected(null)
                setPage((current) => Math.max(0, current - 1))
              }}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-28 text-center text-sm text-muted-foreground">
              {page + 1} / {pageCount} · {(pairsQuery.data?.total ?? 0).toLocaleString()}개
            </span>
            <Button
              aria-label="다음 페이지"
              disabled={page + 1 >= pageCount || pairsQuery.isFetching}
              size="icon"
              variant="outline"
              onClick={() => {
                setSelected(null)
                setPage((current) => current + 1)
              }}
            >
              <ChevronRight />
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button disabled={!selected} onClick={choose}>
              선택한 조합 불러오기
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
