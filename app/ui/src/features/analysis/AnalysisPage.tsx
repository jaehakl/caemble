import { AlertTriangle, Check, LoaderCircle, LogIn, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAuth } from '@/features/auth/use-auth'
import { cn } from '@/lib/utils'
import type { AnalysisColumnDescriptor } from './analysis-types'
import { useAnalysisController } from './useAnalysisController'

export type AnalysisCommand = Readonly<{
  id: number | string
  type: 'reload'
}>

export type AnalysisWorkspaceProps = {
  command?: AnalysisCommand | null
  dataReadable?: boolean
  experimentId: number | null
  embedded?: boolean
  onRequestLogin?: () => void
  onSelectMeasurement?: (measurementId: number) => void
  selectedMeasurementId?: number | null
  settingsContainer?: Element | null
}

const RELATIONSHIP_PAGE_SIZE = 50

function AnalysisSettingsSlot({
  children,
  container,
  description,
  fillHeight = false,
  id,
  title,
}: {
  children: ReactNode
  container?: Element | null
  description?: string
  fillHeight?: boolean
  id: string
  title?: string
}) {
  if (!container) return children
  return createPortal(
    <div className={cn('p-3', fillHeight && 'h-full min-h-0')} data-analysis-settings={id}>
      {title ? (
        <Card className={cn(fillHeight && 'flex h-full min-h-0 flex-col')}>
          <CardHeader className="shrink-0 p-4 pb-0">
            <CardTitle className="text-base">{title}</CardTitle>
            {description ? <CardDescription className="text-xs leading-5">{description}</CardDescription> : null}
          </CardHeader>
          <CardContent className={cn('p-4', fillHeight ? 'min-h-0 flex-1' : 'space-y-4')}>{children}</CardContent>
        </Card>
      ) : (
        children
      )}
    </div>,
    container,
  )
}

function formatNumber(value: number | undefined | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if ((absolute > 0 && absolute < 0.001) || absolute >= 1_000_000) return value.toExponential(3)
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 }).format(value)
}

function columnLabel(column: AnalysisColumnDescriptor | undefined) {
  if (!column) return '—'
  if (column.source === 'measurement-vars') return column.label.replace(/^measurement\.vars\./, '')
  return column.label
}

function columnMeta(column: AnalysisColumnDescriptor | undefined) {
  if (!column) return ''
  return [column.unit, column.quantityKind, column.source].find(Boolean) ?? column.source
}

function MetricCard({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-xl border bg-muted/15 p-3.5">
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">
        {typeof value === 'number' ? formatNumber(value) : value}
      </p>
      {detail ? <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

type ScatterPoint = Readonly<{
  x: number
  y: number
  measurementId?: number
}>

function ScatterPlot({
  label,
  onSelectMeasurement,
  points,
  selectedMeasurementId,
  xLabel,
  yLabel,
}: {
  label: string
  onSelectMeasurement?: (measurementId: number) => void
  points: readonly ScatterPoint[]
  selectedMeasurementId?: number | null
  xLabel: string
  yLabel: string
}) {
  const finite = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (finite.length === 0)
    return <p className="py-16 text-center text-sm text-muted-foreground">표시할 좌표가 없습니다.</p>
  const rawMinX = Math.min(...finite.map((point) => point.x))
  const rawMaxX = Math.max(...finite.map((point) => point.x))
  const rawMinY = Math.min(...finite.map((point) => point.y))
  const rawMaxY = Math.max(...finite.map((point) => point.y))
  const paddingX = (rawMaxX - rawMinX || Math.abs(rawMinX) || 1) * 0.06
  const paddingY = (rawMaxY - rawMinY || Math.abs(rawMinY) || 1) * 0.08
  const minX = rawMinX - paddingX
  const maxX = rawMaxX + paddingX
  const minY = rawMinY - paddingY
  const maxY = rawMaxY + paddingY
  const left = 78
  const right = 704
  const top = 18
  const bottom = 326
  const scaleX = (value: number) => left + ((value - minX) / (maxX - minX || 1)) * (right - left)
  const scaleY = (value: number) => bottom - ((value - minY) / (maxY - minY || 1)) * (bottom - top)
  const ticks = Array.from({ length: 5 }, (_, index) => index / 4)
  return (
    <div className="overflow-x-auto">
      <svg
        aria-label={label}
        className="h-auto max-h-[380px] w-full"
        role={onSelectMeasurement ? 'group' : 'img'}
        viewBox="0 0 730 390"
      >
        {ticks.map((ratio) => {
          const x = left + ratio * (right - left)
          const y = bottom - ratio * (bottom - top)
          return (
            <g key={ratio}>
              <line stroke="currentColor" strokeOpacity="0.08" x1={x} x2={x} y1={top} y2={bottom} />
              <line stroke="currentColor" strokeOpacity="0.08" x1={left} x2={right} y1={y} y2={y} />
              <text className="fill-muted-foreground" fontSize="10" textAnchor="middle" x={x} y={bottom + 18}>
                {formatNumber(minX + ratio * (maxX - minX))}
              </text>
              <text
                className="fill-muted-foreground"
                dominantBaseline="middle"
                fontSize="10"
                textAnchor="end"
                x={left - 8}
                y={y}
              >
                {formatNumber(minY + ratio * (maxY - minY))}
              </text>
            </g>
          )
        })}
        <line stroke="currentColor" strokeOpacity="0.35" x1={left} x2={right} y1={bottom} y2={bottom} />
        <line stroke="currentColor" strokeOpacity="0.35" x1={left} x2={left} y1={top} y2={bottom} />
        {finite.map((point, index) => {
          const measurementId = point.measurementId
          const interactive = measurementId != null && onSelectMeasurement !== undefined
          const selected = measurementId != null && measurementId === selectedMeasurementId
          const description = `${measurementId != null ? `Measurement #${measurementId} · ` : ''}${formatNumber(point.x)}, ${formatNumber(point.y)}`
          return (
            <g
              aria-label={interactive ? description : undefined}
              aria-pressed={interactive ? selected : undefined}
              className={interactive ? 'group cursor-pointer outline-none' : undefined}
              key={`${measurementId ?? index}-${index}`}
              onClick={interactive ? () => onSelectMeasurement(measurementId) : undefined}
              onKeyDown={
                interactive
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onSelectMeasurement(measurementId)
                      }
                    }
                  : undefined
              }
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              transform={`translate(${scaleX(point.x)} ${scaleY(point.y)})`}
            >
              <title>{description}</title>
              {interactive ? <circle aria-hidden="true" fill="transparent" r="9" /> : null}
              <circle
                aria-hidden="true"
                className={cn(
                  'stroke-foreground group-focus-visible:opacity-100',
                  selected ? 'opacity-100' : 'opacity-0',
                )}
                fill="none"
                pointerEvents="none"
                r="8"
                strokeWidth="2"
              />
              <circle fill="#ea580c" opacity="0.76" r={3.8} stroke="white" strokeWidth={0.7} />
            </g>
          )
        })}
        <text
          className="fill-foreground"
          fontSize="12"
          fontWeight="600"
          textAnchor="middle"
          x={(left + right) / 2}
          y="378"
        >
          {xLabel}
        </text>
        <text
          className="fill-foreground"
          fontSize="12"
          fontWeight="600"
          textAnchor="middle"
          transform="rotate(-90 18 172)"
          x="18"
          y="172"
        >
          {yLabel}
        </text>
      </svg>
    </div>
  )
}

function SearchableColumnSelect({
  columns,
  fillHeight = false,
  label,
  onChange,
  value,
}: {
  columns: readonly AnalysisColumnDescriptor[]
  fillHeight?: boolean
  label: string
  onChange: (key: string) => void
  value: string
}) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const shown = columns.filter(
    (column) =>
      !needle || `${columnLabel(column)} ${column.key} ${column.unit ?? ''}`.toLocaleLowerCase().includes(needle),
  )
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', fillHeight && 'h-full min-h-0')}>
      <p className="shrink-0 text-sm font-medium">{label}</p>
      <div className="relative shrink-0">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={`${label} 검색`}
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="이름 검색"
          value={query}
        />
      </div>
      <div
        aria-label={label}
        className={cn('space-y-1 overflow-y-auto rounded-lg border p-1.5', fillHeight ? 'min-h-0 flex-1' : 'max-h-44')}
        role="listbox"
      >
        {shown.map((column) => (
          <button
            aria-selected={column.key === value}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60',
              column.key === value && 'bg-primary/10 text-primary',
            )}
            key={column.key}
            onClick={() => onChange(column.key)}
            role="option"
            type="button"
          >
            <Check className={cn('size-4 shrink-0', column.key !== value && 'invisible')} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{columnLabel(column)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {column.unit ?? column.quantityKind ?? column.source}
              </span>
            </span>
          </button>
        ))}
        {shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">일치하는 열이 없습니다.</p>
        ) : null}
      </div>
    </div>
  )
}

function EmptyResult({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex min-h-44 items-center justify-center px-6 text-center text-sm leading-6 text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  )
}

export function AnalysisWorkspace({
  command,
  dataReadable: dataReadableProp,
  experimentId,
  embedded = false,
  onRequestLogin,
  onSelectMeasurement,
  selectedMeasurementId,
  settingsContainer,
}: AnalysisWorkspaceProps) {
  const auth = useAuth()
  const dataReadable = dataReadableProp ?? auth.isAuthenticated
  const handledCommandId = useRef<AnalysisCommand['id'] | null>(null)
  const {
    busy,
    error,
    exploreInputKey,
    exploreTargetKey,
    plotBusy,
    profile,
    progress,
    progressCount,
    relationshipOffset,
    relationshipPlot,
    relationships,
    relationshipsBusy,
    requestRelationshipPlot,
    restartWorker,
    setRelationshipOffset,
    stale,
  } = useAnalysisController({ dataReadable, experimentId })

  const featureColumns = useMemo(() => profile?.columns.filter((column) => column.kind === 'feature') ?? [], [profile])
  const inputColumns = useMemo(
    () => featureColumns.filter((column) => column.source === 'measurement-vars' && column.eligible),
    [featureColumns],
  )
  const targetColumns = useMemo(
    () => profile?.columns.filter((column) => column.kind === 'target' && column.eligible) ?? [],
    [profile],
  )
  const exploreInput = inputColumns.find((column) => column.key === exploreInputKey)
  const exploreTarget = targetColumns.find((column) => column.key === exploreTargetKey)
  useEffect(() => {
    if (!command || handledCommandId.current === command.id) return
    handledCommandId.current = command.id
    if (command.type === 'reload') restartWorker()
  }, [command, restartWorker])

  if (auth.isLoading)
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <LoaderCircle className="size-7 animate-spin text-muted-foreground" />
      </div>
    )

  if (!dataReadable) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>로그인이 필요합니다</CardTitle>
            <CardDescription>내 Measurement와 CalculationData를 브라우저에서 분석하려면 로그인하세요.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" onClick={onRequestLogin}>
              <LogIn />
              Account 열기
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const relationshipPage =
    relationships?.pairs.slice(relationshipOffset, relationshipOffset + RELATIONSHIP_PAGE_SIZE) ?? []

  return (
    <div
      className={cn(
        'space-y-4',
        embedded ? 'h-full min-h-0 overflow-y-auto p-4' : 'mx-auto max-w-[1500px] px-4 py-6 sm:px-6',
      )}
    >
      <header
        className={cn('flex flex-col justify-between gap-3 border-b pb-3', !embedded && 'lg:flex-row lg:items-end')}
      >
        <div>
          <p className="text-xs font-semibold tracking-wide text-primary uppercase">Browser analysis</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">Analysis · Explore</h2>
          {!embedded ? (
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              같은 Experiment의 Measurement 입력과 CalculationData를 브라우저 Worker에서 분석합니다.
            </p>
          ) : null}
        </div>
      </header>

      {stale ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center">
          <AlertTriangle className="size-5 shrink-0" />
          <p className="flex-1 text-sm">
            Measurement 입력 또는 CalculationData가 변경되었습니다. 현재 분석 결과는 이전 데이터입니다.
          </p>
          <Button onClick={restartWorker} size="sm" variant="outline">
            <RefreshCw />
            새로 불러오기
          </Button>
        </div>
      ) : null}
      {experimentId === null ? <EmptyResult>분석할 Experiment를 먼저 여세요.</EmptyResult> : null}
      {busy === 'load' ? (
        <Card>
          <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3">
            <LoaderCircle className="size-7 animate-spin text-primary" />
            <p className="text-sm font-medium">{progress ?? '데이터를 불러오는 중입니다.'}</p>
            {progressCount && progressCount.total > 0 ? (
              <p className="text-xs text-muted-foreground">
                {progressCount.completed}/{progressCount.total} 완료
              </p>
            ) : null}
            <Button onClick={restartWorker} size="sm" variant="ghost">
              <X />
              취소
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {error ? (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <AlertTriangle className="size-5 shrink-0 text-destructive" />
          <p className="flex-1">{error}</p>
          <Button onClick={restartWorker} size="sm" variant="outline">
            <RefreshCw />
            다시 시도
          </Button>
        </div>
      ) : null}

      {profile ? (
        <div className="space-y-4">
          <AnalysisSettingsSlot
            container={settingsContainer}
            description="input vars 하나와 숫자 CalculationData 하나를 선택하면 산점도가 즉시 갱신됩니다."
            id="explore"
            fillHeight
            title="Explore"
          >
            <div className={cn('grid grid-cols-2 gap-3', settingsContainer && 'h-full min-h-0')}>
              <SearchableColumnSelect
                columns={inputColumns}
                fillHeight={Boolean(settingsContainer)}
                label="Input variable"
                onChange={(value) => requestRelationshipPlot(value, exploreTargetKey)}
                value={exploreInputKey}
              />
              <SearchableColumnSelect
                columns={targetColumns}
                fillHeight={Boolean(settingsContainer)}
                label="Calculation Data"
                onChange={(value) => requestRelationshipPlot(exploreInputKey, value)}
                value={exploreTargetKey}
              />
            </div>
          </AnalysisSettingsSlot>

          <div className="grid [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))] gap-3">
            <MetricCard label="Measurements with data" value={profile.measurementCount} />
            <MetricCard
              label="Input vars"
              value={inputColumns.length}
              detail={`${featureColumns.length}개 전체 feature`}
            />
            <MetricCard
              label="Calculation outputs"
              value={targetColumns.length}
              detail={`${profile.calculationDataCount}개 저장 결과 · ${profile.calculationCount}개 Calculation`}
            />
            <MetricCard label="Calculated pairs" value={relationships?.pairs.length ?? 0} detail="|Pearson r| 순" />
          </div>
          {profile.warnings.map((warning) => (
            <div className="rounded-lg border bg-muted/30 p-3 text-sm" key={warning}>
              {warning}
            </div>
          ))}
          <Card>
            <CardHeader>
              <CardTitle>
                {columnLabel(exploreInput)} × {columnLabel(exploreTarget)}
              </CardTitle>
              <CardDescription>
                {columnMeta(exploreInput)} · {columnMeta(exploreTarget)} · 완전한 값 쌍만 표시합니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {plotBusy ? (
                <div className="flex min-h-72 items-center justify-center">
                  <LoaderCircle className="size-6 animate-spin text-primary" />
                </div>
              ) : relationshipPlot ? (
                <>
                  <ScatterPlot
                    label={`${columnLabel(exploreInput)}와 ${columnLabel(exploreTarget)} 산점도`}
                    onSelectMeasurement={onSelectMeasurement}
                    points={relationshipPlot.points}
                    selectedMeasurementId={selectedMeasurementId}
                    xLabel={`${columnLabel(exploreInput)}${exploreInput?.unit ? ` (${exploreInput.unit})` : ''}`}
                    yLabel={`${columnLabel(exploreTarget)}${exploreTarget?.unit ? ` (${exploreTarget.unit})` : ''}`}
                  />
                  {relationshipPlot.pearson === null ? (
                    <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                      {relationshipPlot.count < 3
                        ? `완전한 값 쌍이 ${relationshipPlot.count}개입니다. 상관계수는 최소 3개가 필요합니다.`
                        : '한 축의 값이 모두 같아 상관계수를 계산할 수 없습니다.'}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="py-20 text-center text-sm text-muted-foreground">
                  선택할 수 있는 input vars와 CalculationData 조합이 없습니다.
                </p>
              )}
            </CardContent>
          </Card>
          <div className="grid [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))] gap-3">
            <MetricCard label="Pearson r" value={formatNumber(relationshipPlot?.pearson)} />
            <MetricCard label="Spearman ρ" value={formatNumber(relationshipPlot?.spearman)} />
            <MetricCard label="Valid pairs" value={relationshipPlot?.count ?? 0} detail="완전한 input/target 쌍" />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Strongest relationships</CardTitle>
              <CardDescription>
                계산 가능한 모든 input vars × CalculationData 조합을 |Pearson r| 순으로 표시합니다. 최소 표본 수는
                3개입니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {relationshipsBusy ? (
                <div className="flex min-h-40 flex-col items-center justify-center gap-2">
                  <LoaderCircle className="size-6 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">{progress ?? '상관관계를 계산하는 중입니다.'}</p>
                  {progressCount && progressCount.total > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {progressCount.completed}/{progressCount.total}
                    </p>
                  ) : null}
                </div>
              ) : relationshipPage.length ? (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-14">순위</TableHead>
                        <TableHead>Input</TableHead>
                        <TableHead>Calculation Data</TableHead>
                        <TableHead>Pearson</TableHead>
                        <TableHead>Spearman</TableHead>
                        <TableHead>n</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {relationshipPage.map((pair, index) => {
                        const input = profile.columns.find((column) => column.key === pair.inputKey)
                        const target = profile.columns.find((column) => column.key === pair.targetKey)
                        const selected = pair.inputKey === exploreInputKey && pair.targetKey === exploreTargetKey
                        return (
                          <TableRow
                            aria-label={`${columnLabel(input)}와 ${columnLabel(target)} 관계 보기`}
                            aria-selected={selected}
                            className="cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
                            key={`${pair.inputKey}:${pair.targetKey}`}
                            onClick={() => requestRelationshipPlot(pair.inputKey, pair.targetKey)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                requestRelationshipPlot(pair.inputKey, pair.targetKey)
                              }
                            }}
                            tabIndex={0}
                          >
                            <TableCell className="tabular-nums">{relationshipOffset + index + 1}</TableCell>
                            <TableCell>
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate font-medium" title={pair.inputKey}>
                                  {columnLabel(input)}
                                </span>
                                {selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="block max-w-64 truncate" title={pair.targetKey}>
                                {columnLabel(target)}
                              </span>
                            </TableCell>
                            <TableCell
                              className={cn(
                                'font-medium tabular-nums',
                                pair.pearson < 0 ? 'text-blue-700' : 'text-red-700',
                              )}
                            >
                              {formatNumber(pair.pearson)}
                            </TableCell>
                            <TableCell className="tabular-nums">{formatNumber(pair.spearman)}</TableCell>
                            <TableCell className="tabular-nums">{pair.count}</TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      {relationshipOffset + 1}–
                      {Math.min(relationships?.pairs.length ?? 0, relationshipOffset + relationshipPage.length)} /{' '}
                      {relationships?.pairs.length ?? 0}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        disabled={relationshipOffset === 0}
                        onClick={() => setRelationshipOffset((offset) => Math.max(0, offset - RELATIONSHIP_PAGE_SIZE))}
                        size="sm"
                        variant="outline"
                      >
                        이전
                      </Button>
                      <Button
                        disabled={relationshipOffset + RELATIONSHIP_PAGE_SIZE >= (relationships?.pairs.length ?? 0)}
                        onClick={() => setRelationshipOffset((offset) => offset + RELATIONSHIP_PAGE_SIZE)}
                        size="sm"
                        variant="outline"
                      >
                        다음
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  상관계수를 계산할 수 있는 조합이 없습니다. 각 조합에 서로 다른 값과 완전한 표본이 3개 이상 필요합니다.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}
