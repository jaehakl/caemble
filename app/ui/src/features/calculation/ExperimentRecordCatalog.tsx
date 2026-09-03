import { Braces, LoaderCircle, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ExperimentRecordCatalogItem, ExperimentRecordCatalogStatus } from './experimentRecordCatalogModel'

const statusLabels: Readonly<Record<ExperimentRecordCatalogStatus, string>> = {
  unselected: 'No Measurement',
  loading: 'RecordedData Loading…',
  ready: 'RecordedData Ready',
  missing: 'Missing',
  invalid: 'Invalid',
}

const statusClasses: Readonly<Record<ExperimentRecordCatalogStatus, string>> = {
  unselected: 'bg-muted text-muted-foreground',
  loading: 'bg-blue-100 text-blue-800',
  ready: 'bg-emerald-600 text-white',
  missing: 'bg-amber-500 text-white',
  invalid: 'bg-destructive text-white',
}

function experimentRecordAxesSummary(dataSchema: Readonly<Record<string, unknown>> | null | undefined) {
  const unit = dataSchema && typeof dataSchema.unit === 'string' ? `unit ${dataSchema.unit} · ` : ''
  if (!dataSchema || !Array.isArray(dataSchema.axes) || dataSchema.axes.length === 0) return `${unit}axes —`
  const axes = dataSchema.axes.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `axis ${index} (?)`
    const axis = value as Readonly<Record<string, unknown>>
    const name = typeof axis.name === 'string' && axis.name ? axis.name : `axis ${index}`
    const length =
      typeof axis.length === 'number' && Number.isSafeInteger(axis.length)
        ? axis.length
        : Array.isArray(axis.ticks)
          ? axis.ticks.length
          : 'dynamic'
    return `${name} (${String(length)})`
  })
  return `${unit}axes ${axes.join(' · ')}`
}

export function ExperimentRecordCatalog({
  analysisError,
  experimentId,
  insertDisabledReason,
  items,
  loading,
  loadError,
  onInsert,
}: {
  analysisError: string | null
  experimentId: number | null
  insertDisabledReason: string | null
  items: readonly ExperimentRecordCatalogItem[]
  loading: boolean
  loadError: boolean
  onInsert: (recordName: string) => void
}) {
  const [search, setSearch] = useState('')
  useEffect(() => setSearch(''), [experimentId])
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleItems = useMemo(
    () =>
      normalizedSearch
        ? items.filter((item) => item.record.name.toLocaleLowerCase().includes(normalizedSearch))
        : items,
    [items, normalizedSearch],
  )
  const used = items.filter((item) => item.used).length
  const ready = items.filter((item) => item.status === 'ready').length

  return (
    <section className="flex h-full min-h-0 flex-col gap-2 p-2" aria-label="Experiment Records와 RecordedData">
      <header className="shrink-0 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Experiment Records &amp; RecordedData</h2>
            <p className="text-[10px] text-muted-foreground">
              전체 {items.length.toLocaleString()} · 사용 {analysisError ? '—' : used.toLocaleString()} · 사용 가능{' '}
              {ready.toLocaleString()}
            </p>
          </div>
        </div>
        <label className="relative block">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="ExperimentRecord 이름 검색"
            className="h-7 pl-7 text-xs"
            placeholder="Record 이름 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {analysisError ? (
          <p
            className="line-clamp-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[10px] text-destructive"
            title={analysisError}
          >
            사용 여부 분석 오류: {analysisError}
          </p>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto rounded border">
        {experimentId === null ? (
          <div className="grid h-full min-h-20 place-items-center p-3 text-center text-xs text-muted-foreground">
            먼저 저장된 Experiment를 여세요.
          </div>
        ) : loading ? (
          <div className="grid h-full min-h-20 place-items-center text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        ) : loadError ? (
          <div className="grid h-full min-h-20 place-items-center p-3 text-center text-xs text-destructive">
            ExperimentRecord 목록을 불러오지 못했습니다.
          </div>
        ) : visibleItems.length ? (
          <ul className="divide-y">
            {visibleItems.map((item) => {
              const { record, status, summary } = item
              return (
                <li className="space-y-1.5 px-2 py-2 text-[11px]" key={record.id} title={summary?.error ?? undefined}>
                  <div className="flex items-start gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono font-medium" title={record.name}>
                      {record.name}
                    </span>
                    {item.used === true ? (
                      <Badge className="bg-blue-600 px-1.5 py-0 text-[10px] text-white">Used</Badge>
                    ) : null}
                    <Button
                      aria-label={`${record.name} 참조를 Source Editor에 삽입`}
                      className="h-6 px-2"
                      disabled={insertDisabledReason !== null}
                      size="sm"
                      title={insertDisabledReason ?? `${record.name} 참조를 현재 커서에 삽입`}
                      type="button"
                      variant="outline"
                      onClick={() => onInsert(record.name)}
                    >
                      <Braces /> Insert
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <Badge className={statusClasses[status]}>{statusLabels[status]}</Badge>
                    <span>{record.dtype}</span>
                    <span>tensorOrder {record.tensor_order}</span>
                    <span>QuantityKind {record.quantity_kind ?? '—'}</span>
                  </div>
                  <p
                    className="truncate text-[10px] text-muted-foreground"
                    title={experimentRecordAxesSummary(record.data_schema)}
                  >
                    {experimentRecordAxesSummary(record.data_schema)}
                  </p>
                  {summary?.shape ? (
                    <p className="text-[10px] text-muted-foreground">
                      runtime shape [{summary.shape.join(', ')}] · external axes [
                      {summary.actualAxisLengths?.join(', ') ?? '—'}]
                    </p>
                  ) : null}
                  {summary?.error ? <p className="line-clamp-2 text-[10px] text-destructive">{summary.error}</p> : null}
                </li>
              )
            })}
          </ul>
        ) : items.length ? (
          <div className="grid h-full min-h-20 place-items-center p-3 text-center text-xs text-muted-foreground">
            검색 결과가 없습니다.
          </div>
        ) : (
          <div className="grid h-full min-h-20 place-items-center p-3 text-center text-xs text-muted-foreground">
            저장된 ExperimentRecord가 없습니다.
          </div>
        )}
      </div>
    </section>
  )
}
