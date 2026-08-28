import {
  AlertTriangle,
  BrainCircuit,
  Check,
  Download,
  LoaderCircle,
  LogIn,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/use-auth'
import type { AnalysisTabId } from '@/features/cae-workbench/types'
import { cn } from '@/lib/utils'
import type {
  AnalysisColumnDescriptor,
  AnalysisMiningResult,
  AnalysisPredictionResult,
  AnalysisProfile,
  AnalysisProgressStage,
  AnalysisRelationshipPlot,
  AnalysisRelationshipsResult,
  AnalysisTablePage,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from './analysis-types'
import analysisWorkerAssetUrl from './analysis.worker.ts?worker&url'

export type AnalysisTab = AnalysisTabId

export type AnalysisCommand = Readonly<{
  id: number | string
  type: 'reload' | 'export-dataset' | 'export-prediction'
}>

export type AnalysisWorkspaceProps = {
  command?: AnalysisCommand | null
  experimentId: number | null
  embedded?: boolean
  onRequestLogin?: () => void
  onTabChange?: (tab: AnalysisTab) => void
  settingsContainer?: Element | null
  tab?: AnalysisTab
}

const RELATIONSHIP_PAGE_SIZE = 50

function AnalysisSettingsSlot({
  children,
  container,
  description,
  id,
  title,
}: {
  children: ReactNode
  container?: Element | null
  description?: string
  id: string
  title?: string
}) {
  if (!container) return children
  return createPortal(
    <div className="p-3" data-analysis-settings={id}>
      {title ? (
        <Card>
          <CardHeader className="p-4 pb-0">
            <CardTitle className="text-base">{title}</CardTitle>
            {description ? <CardDescription className="text-xs leading-5">{description}</CardDescription> : null}
          </CardHeader>
          <CardContent className="space-y-4 p-4">{children}</CardContent>
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

function Histogram({ column }: { column: AnalysisColumnDescriptor }) {
  const bins = column.histogram ?? []
  const maximum = Math.max(1, ...bins.map((bin) => bin.count))
  if (bins.length === 0) return <p className="py-10 text-center text-sm text-muted-foreground">표시할 값이 없습니다.</p>
  return (
    <div className="overflow-x-auto">
      <svg
        aria-label={`${columnLabel(column)} histogram`}
        className="h-56 w-full min-w-[480px]"
        role="img"
        viewBox="0 0 640 220"
      >
        <line stroke="currentColor" strokeOpacity="0.18" x1="36" x2="620" y1="190" y2="190" />
        {bins.map((bin, index) => {
          const width = 570 / bins.length
          const height = (bin.count / maximum) * 160
          return (
            <rect
              className="fill-primary/75"
              height={height}
              key={`${bin.min}-${bin.max}`}
              rx="2"
              width={Math.max(2, width - 4)}
              x={40 + index * width}
              y={190 - height}
            >
              <title>{`${formatNumber(bin.min)}–${formatNumber(bin.max)}: ${bin.count}`}</title>
            </rect>
          )
        })}
        <text className="fill-muted-foreground" fontSize="11" textAnchor="start" x="38" y="211">
          {formatNumber(column.min)}
        </text>
        <text className="fill-muted-foreground" fontSize="11" textAnchor="end" x="618" y="211">
          {formatNumber(column.max)}
        </text>
      </svg>
    </div>
  )
}

type ScatterPoint = Readonly<{
  x: number
  y: number
  measurementId?: number
  cluster?: number
  outlier?: boolean
}>

function ScatterPlot({
  diagonal = false,
  label,
  points,
  xLabel,
  yLabel,
}: {
  diagonal?: boolean
  label: string
  points: readonly ScatterPoint[]
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
  const colors = ['#ea580c', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4f46e5']
  const diagonalStart = Math.max(minX, minY)
  const diagonalEnd = Math.min(maxX, maxY)
  return (
    <div className="overflow-x-auto">
      <svg aria-label={label} className="h-[380px] w-full min-w-[560px]" role="img" viewBox="0 0 730 390">
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
        {diagonal && diagonalStart < diagonalEnd ? (
          <line
            stroke="currentColor"
            strokeDasharray="6 5"
            strokeOpacity="0.45"
            x1={scaleX(diagonalStart)}
            x2={scaleX(diagonalEnd)}
            y1={scaleY(diagonalStart)}
            y2={scaleY(diagonalEnd)}
          />
        ) : null}
        {finite.map((point, index) => (
          <circle
            cx={scaleX(point.x)}
            cy={scaleY(point.y)}
            fill={colors[(point.cluster ?? 0) % colors.length]}
            key={`${point.measurementId ?? index}-${index}`}
            opacity="0.76"
            r={point.outlier ? 5 : 3.8}
            stroke={point.outlier ? '#111827' : 'white'}
            strokeWidth={point.outlier ? 1.5 : 0.7}
          >
            <title>{`${point.measurementId ? `Measurement #${point.measurementId} · ` : ''}${formatNumber(point.x)}, ${formatNumber(point.y)}${point.outlier ? ' · 이상치' : ''}`}</title>
          </circle>
        ))}
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

function ColumnPicker({
  columns,
  disabled,
  max = 500,
  selected,
  onChange,
}: {
  columns: readonly AnalysisColumnDescriptor[]
  disabled: boolean
  max?: number
  selected: readonly string[]
  onChange: (keys: readonly string[]) => void
}) {
  const [query, setQuery] = useState('')
  const available = columns.filter((column) => column.eligible)
  const shown = columns.filter((column) => {
    const needle = query.trim().toLocaleLowerCase()
    return !needle || `${column.label} ${column.key} ${column.source}`.toLocaleLowerCase().includes(needle)
  })
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="분석 열 검색"
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="이름 또는 source 검색"
          value={query}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled || available.length === 0}
          onClick={() => onChange(available.slice(0, max).map((column) => column.key))}
          size="sm"
          type="button"
          variant="outline"
        >
          사용 가능 전체
        </Button>
        <Button
          disabled={disabled || selected.length === 0}
          onClick={() => onChange([])}
          size="sm"
          type="button"
          variant="ghost"
        >
          초기화
        </Button>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {selected.length}/{max}
        </span>
      </div>
      <div className="max-h-80 space-y-3 overflow-y-auto rounded-lg border p-2">
        {(['measurement-vars', 'measurement-material', 'calculation-data'] as const).map((source) => {
          const group = shown.filter((column) => column.source === source)
          if (group.length === 0) return null
          return (
            <div className="space-y-1" key={source}>
              <p className="px-2 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {source === 'measurement-vars'
                  ? 'Input vars'
                  : source === 'measurement-material'
                    ? 'Material'
                    : 'Calculation Data'}
              </p>
              {group.map((column) => {
                const checked = selected.includes(column.key)
                return (
                  <label
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted/60',
                      !column.eligible && 'cursor-not-allowed opacity-55',
                    )}
                    key={column.key}
                  >
                    <input
                      checked={checked}
                      className="mt-0.5 accent-primary"
                      disabled={disabled || !column.eligible}
                      onChange={(event) => {
                        if (!event.target.checked) onChange(selected.filter((key) => key !== column.key))
                        else if (selected.length < max) onChange([...selected, column.key])
                      }}
                      type="checkbox"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" title={column.key}>
                        {columnLabel(column)}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        누락 {(column.missingRatio * 100).toFixed(1)}%{column.unit ? ` · ${column.unit}` : ''}
                      </span>
                      {column.exclusionReason ? (
                        <span className="mt-0.5 block text-xs text-amber-700">{column.exclusionReason}</span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
            </div>
          )
        })}
        {shown.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-muted-foreground">일치하는 열이 없습니다.</p>
        ) : null}
      </div>
    </div>
  )
}

function SearchableColumnSelect({
  columns,
  label,
  onChange,
  value,
}: {
  columns: readonly AnalysisColumnDescriptor[]
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
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="relative">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={`${label} 검색`}
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="이름 검색"
          value={query}
        />
      </div>
      <div aria-label={label} className="max-h-44 space-y-1 overflow-y-auto rounded-lg border p-1.5" role="listbox">
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
  experimentId,
  embedded = false,
  onRequestLogin,
  onTabChange,
  settingsContainer,
  tab: controlledTab,
}: AnalysisWorkspaceProps) {
  const auth = useAuth()
  const [workspaceTab, setWorkspaceTab] = useState<AnalysisTab>(controlledTab ?? 'explore')
  const tab = controlledTab ?? workspaceTab
  const [profile, setProfile] = useState<AnalysisProfile | null>(null)
  const [relationships, setRelationships] = useState<AnalysisRelationshipsResult | null>(null)
  const [relationshipPlot, setRelationshipPlot] = useState<AnalysisRelationshipPlot | null>(null)
  const [mining, setMining] = useState<AnalysisMiningResult | null>(null)
  const [prediction, setPrediction] = useState<AnalysisPredictionResult | null>(null)
  const [tablePage, setTablePage] = useState<AnalysisTablePage | null>(null)
  const [tableOffset, setTableOffset] = useState(0)
  const [relationshipOffset, setRelationshipOffset] = useState(0)
  const [exploreInputKey, setExploreInputKey] = useState('')
  const [exploreTargetKey, setExploreTargetKey] = useState('')
  const [miningFeatureKeys, setMiningFeatureKeys] = useState<readonly string[]>([])
  const [predictionFeatureKeys, setPredictionFeatureKeys] = useState<readonly string[]>([])
  const [predictionTargetKey, setPredictionTargetKey] = useState('')
  const [dataColumnKeys, setDataColumnKeys] = useState<readonly string[]>([])
  const [histogramKey, setHistogramKey] = useState('')
  const [profileSearch, setProfileSearch] = useState('')
  const [profileSource, setProfileSource] = useState<'all' | AnalysisColumnDescriptor['source']>('all')
  const [profileStatus, setProfileStatus] = useState<'all' | 'eligible' | 'excluded'>('all')
  const [whatIf, setWhatIf] = useState<Readonly<Record<string, number>>>({})
  const [outlierPercent, setOutlierPercent] = useState(5)
  const [busy, setBusy] = useState<'export' | 'load' | 'mine' | 'predict' | 'what-if' | null>(null)
  const [relationshipsBusy, setRelationshipsBusy] = useState(false)
  const [plotBusy, setPlotBusy] = useState(false)
  const [progress, setProgress] = useState<AnalysisProgressStage | null>(null)
  const [progressCount, setProgressCount] = useState<Readonly<{ completed: number; total: number }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [workerGeneration, setWorkerGeneration] = useState(0)
  const workerRef = useRef<Worker | null>(null)
  const requestSequence = useRef(0)
  const loadRequestId = useRef('')
  const activeRequestId = useRef('')
  const relationshipsRequestId = useRef('')
  const plotRequestId = useRef('')
  const tableRequestId = useRef('')
  const staleRequestId = useRef('')
  const handledCommandId = useRef<AnalysisCommand['id'] | null>(null)
  const exploreInputRef = useRef('')
  const exploreTargetRef = useRef('')

  exploreInputRef.current = exploreInputKey
  exploreTargetRef.current = exploreTargetKey

  const nextRequestId = useCallback((kind: string) => {
    requestSequence.current += 1
    return `analysis-${kind}-${requestSequence.current}`
  }, [])

  useEffect(() => {
    if (!auth.isAuthenticated || experimentId === null) return
    const workerUrl = new URL(analysisWorkerAssetUrl, window.location.href)
    workerUrl.searchParams.set('response-policy', 'connect-self-v1')
    const worker = new Worker(workerUrl, { type: 'module' })
    workerRef.current = worker
    setProfile(null)
    setRelationships(null)
    setRelationshipPlot(null)
    setMining(null)
    setPrediction(null)
    setTablePage(null)
    setError(null)
    setStale(false)
    setBusy('load')
    setRelationshipsBusy(false)
    setPlotBusy(false)
    setProgress('Measurement 조회')
    const requestId = nextRequestId('load')
    loadRequestId.current = requestId

    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data
      if (response.type === 'progress') {
        if (
          [loadRequestId.current, activeRequestId.current, relationshipsRequestId.current].includes(response.requestId)
        ) {
          setProgress(response.stage)
          setProgressCount(
            response.completed === undefined || response.total === undefined
              ? null
              : { completed: response.completed, total: response.total },
          )
        }
        return
      }
      if (response.type === 'profile' && response.requestId === loadRequestId.current) {
        const features = response.profile.columns
          .filter((column) => column.kind === 'feature' && column.eligible)
          .sort(
            (left, right) =>
              Number(left.source !== 'measurement-vars') - Number(right.source !== 'measurement-vars') ||
              left.key.localeCompare(right.key),
          )
        const inputs = features.filter((column) => column.source === 'measurement-vars')
        const targets = response.profile.columns.filter((column) => column.kind === 'target' && column.eligible)
        const initialInput = inputs[0]?.key ?? ''
        const initialTarget = targets[0]?.key ?? ''
        const defaultFeatures = features.slice(0, 50).map((column) => column.key)
        setProfile(response.profile)
        setExploreInputKey(initialInput)
        setExploreTargetKey(initialTarget)
        exploreInputRef.current = initialInput
        exploreTargetRef.current = initialTarget
        setPredictionTargetKey(initialTarget)
        setMiningFeatureKeys(defaultFeatures)
        setPredictionFeatureKeys(defaultFeatures)
        setDataColumnKeys([initialInput, initialTarget].filter(Boolean))
        setHistogramKey(initialTarget || initialInput)
        setWhatIf(Object.fromEntries(features.map((column) => [column.key, column.p50 ?? 0])))
        setBusy(null)
        setProgress(null)
        setProgressCount(null)
        const relationshipsId = nextRequestId('relationships')
        relationshipsRequestId.current = relationshipsId
        setRelationshipsBusy(true)
        setProgress('상관 분석')
        worker.postMessage({ type: 'relationships', requestId: relationshipsId } satisfies AnalysisWorkerRequest)
        return
      }
      if (response.type === 'relationships' && response.requestId === relationshipsRequestId.current) {
        setRelationships(response.result)
        setRelationshipOffset(0)
        setRelationshipsBusy(false)
        setProgress(null)
        setProgressCount(null)
        const first = response.result.pairs[0]
        const inputKey = first?.inputKey ?? exploreInputRef.current
        const targetKey = first?.targetKey ?? exploreTargetRef.current
        if (inputKey && targetKey) {
          setExploreInputKey(inputKey)
          setExploreTargetKey(targetKey)
          exploreInputRef.current = inputKey
          exploreTargetRef.current = targetKey
          const plotId = nextRequestId('plot')
          plotRequestId.current = plotId
          setPlotBusy(true)
          worker.postMessage({
            type: 'relationship-plot',
            requestId: plotId,
            inputKey,
            targetKey,
          } satisfies AnalysisWorkerRequest)
        }
        return
      }
      if (response.type === 'relationship-plot' && response.requestId === plotRequestId.current) {
        setRelationshipPlot(response.result)
        setPlotBusy(false)
        return
      }
      if (response.type === 'mining' && response.requestId === activeRequestId.current) {
        setMining(response.result)
        setBusy(null)
        setProgress(null)
        return
      }
      if (response.type === 'prediction' && response.requestId === activeRequestId.current) {
        setPrediction(response.result)
        setBusy(null)
        setProgress(null)
        return
      }
      if (response.type === 'prediction-what-if' && response.requestId === activeRequestId.current) {
        setPrediction((current) =>
          current
            ? {
                ...current,
                prediction: response.result.prediction,
                interval: response.result.interval,
                extrapolatedFeatureKeys: response.result.extrapolatedFeatureKeys,
              }
            : current,
        )
        setBusy(null)
        return
      }
      if (response.type === 'table-page' && response.requestId === tableRequestId.current) {
        setTablePage(response.page)
        return
      }
      if (response.type === 'stale' && response.requestId === staleRequestId.current) {
        setStale(response.stale)
        return
      }
      if (response.type === 'csv' && response.requestId === activeRequestId.current) {
        const url = URL.createObjectURL(response.blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = response.filename
        anchor.click()
        URL.revokeObjectURL(url)
        setBusy(null)
        return
      }
      if (response.type === 'error') {
        if (
          [
            loadRequestId.current,
            activeRequestId.current,
            relationshipsRequestId.current,
            plotRequestId.current,
            tableRequestId.current,
          ].includes(response.requestId)
        ) {
          setError(response.message)
          setBusy(null)
          setRelationshipsBusy(false)
          setPlotBusy(false)
          setProgress(null)
        }
      }
    }
    worker.onerror = () => {
      setError('Analysis Worker를 실행하지 못했습니다.')
      setBusy(null)
      setRelationshipsBusy(false)
      setPlotBusy(false)
    }
    worker.postMessage({ type: 'load-context', requestId, experimentId } satisfies AnalysisWorkerRequest)
    return () => {
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
  }, [auth.isAuthenticated, experimentId, nextRequestId, workerGeneration])

  useEffect(() => setMining(null), [outlierPercent, miningFeatureKeys])
  useEffect(() => setPrediction(null), [predictionFeatureKeys, predictionTargetKey])

  useEffect(() => {
    if (tab !== 'data' || !profile || !workerRef.current || dataColumnKeys.length === 0) {
      if (dataColumnKeys.length === 0) setTablePage(null)
      return
    }
    const requestId = nextRequestId('table')
    tableRequestId.current = requestId
    workerRef.current.postMessage({
      type: 'table-page',
      requestId,
      columnKeys: dataColumnKeys,
      offset: tableOffset,
      limit: 100,
    } satisfies AnalysisWorkerRequest)
  }, [dataColumnKeys, nextRequestId, profile, tab, tableOffset])

  useEffect(() => setTableOffset(0), [dataColumnKeys])

  useEffect(() => {
    const check = () => {
      if (!profile || busy || !workerRef.current) return
      const requestId = nextRequestId('stale')
      staleRequestId.current = requestId
      workerRef.current.postMessage({ type: 'check-stale', requestId } satisfies AnalysisWorkerRequest)
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [busy, nextRequestId, profile])

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
  const predictionTarget = targetColumns.find((column) => column.key === predictionTargetKey)
  const histogramColumn = profile?.columns.find((column) => column.key === histogramKey)
  const predictionReady = Boolean(
    predictionTarget &&
    predictionTarget.count >= 20 &&
    predictionTarget.distinctCount >= 5 &&
    (predictionTarget.distinctInputCount ?? 0) >= 5 &&
    predictionFeatureKeys.length > 0,
  )
  const filteredProfileColumns = useMemo(() => {
    const needle = profileSearch.trim().toLocaleLowerCase()
    return (
      profile?.columns.filter(
        (column) =>
          (profileSource === 'all' || column.source === profileSource) &&
          (profileStatus === 'all' || (profileStatus === 'eligible' ? column.eligible : !column.eligible)) &&
          (!needle || `${column.label} ${column.key}`.toLocaleLowerCase().includes(needle)),
      ) ?? []
    )
  }, [profile, profileSearch, profileSource, profileStatus])

  const requestRelationshipPlot = (inputKey: string, targetKey: string) => {
    if (!workerRef.current || !inputKey || !targetKey) return
    setExploreInputKey(inputKey)
    setExploreTargetKey(targetKey)
    exploreInputRef.current = inputKey
    exploreTargetRef.current = targetKey
    setRelationshipPlot(null)
    setPlotBusy(true)
    setError(null)
    const requestId = nextRequestId('plot')
    plotRequestId.current = requestId
    workerRef.current.postMessage({
      type: 'relationship-plot',
      requestId,
      inputKey,
      targetKey,
    } satisfies AnalysisWorkerRequest)
  }

  const runMining = () => {
    if (!workerRef.current || miningFeatureKeys.length < 2) return
    const requestId = nextRequestId('mine')
    activeRequestId.current = requestId
    setBusy('mine')
    setError(null)
    workerRef.current.postMessage({
      type: 'mine',
      requestId,
      featureKeys: miningFeatureKeys,
      outlierFraction: outlierPercent / 100,
    } satisfies AnalysisWorkerRequest)
  }

  const runPrediction = () => {
    if (!workerRef.current || !predictionTargetKey || !predictionReady) return
    const requestId = nextRequestId('predict')
    activeRequestId.current = requestId
    setBusy('predict')
    setError(null)
    workerRef.current.postMessage({
      type: 'predict',
      requestId,
      featureKeys: predictionFeatureKeys,
      targetKey: predictionTargetKey,
      whatIf,
    } satisfies AnalysisWorkerRequest)
  }

  const runWhatIf = () => {
    if (!workerRef.current || !prediction) return
    const requestId = nextRequestId('what-if')
    activeRequestId.current = requestId
    setBusy('what-if')
    setError(null)
    workerRef.current.postMessage({ type: 'predict-what-if', requestId, whatIf } satisfies AnalysisWorkerRequest)
  }

  const exportCsv = useCallback(
    (kind: 'dataset' | 'prediction') => {
      if (!workerRef.current || (kind === 'dataset' && dataColumnKeys.length === 0)) return
      const requestId = nextRequestId('export')
      activeRequestId.current = requestId
      setBusy('export')
      setError(null)
      workerRef.current.postMessage({
        type: 'export-csv',
        requestId,
        kind,
        columnKeys: dataColumnKeys,
      } satisfies AnalysisWorkerRequest)
    },
    [dataColumnKeys, nextRequestId],
  )

  const restartWorker = useCallback(() => setWorkerGeneration((generation) => generation + 1), [])

  useEffect(() => {
    if (!command || handledCommandId.current === command.id) return
    handledCommandId.current = command.id
    if (command.type === 'reload') restartWorker()
    else if (command.type === 'export-dataset') exportCsv('dataset')
    else exportCsv('prediction')
  }, [command, exportCsv, restartWorker])

  if (auth.isLoading)
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <LoaderCircle className="size-7 animate-spin text-muted-foreground" />
      </div>
    )

  if (!auth.isAuthenticated) {
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

  const currentTabLabel = tab === 'explore' ? 'Explore' : tab[0].toUpperCase() + tab.slice(1)
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
          <h2 className="mt-1 text-xl font-semibold tracking-tight">Analysis · {currentTabLabel}</h2>
          {!embedded ? (
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              같은 Experiment의 Measurement 입력과 CalculationData를 브라우저 Worker에서 분석합니다.
            </p>
          ) : null}
        </div>
        {!embedded ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!profile || dataColumnKeys.length === 0 || busy !== null}
              onClick={() => exportCsv('dataset')}
              variant="outline"
            >
              <Download />
              선택 데이터 CSV
            </Button>
            <Button disabled={!prediction || busy !== null} onClick={() => exportCsv('prediction')} variant="outline">
              <Download />
              Prediction CSV
            </Button>
          </div>
        ) : null}
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
        <Tabs
          onValueChange={(value) => {
            const next = value as AnalysisTab
            setWorkspaceTab(next)
            onTabChange?.(next)
          }}
          value={tab}
        >
          {!settingsContainer ? (
            <TabsList className="grid h-auto w-full [grid-template-columns:repeat(auto-fit,minmax(105px,1fr))] gap-1">
              <TabsTrigger value="explore">Explore</TabsTrigger>
              <TabsTrigger value="mining">Mining</TabsTrigger>
              <TabsTrigger value="prediction">Prediction</TabsTrigger>
              <TabsTrigger value="data">Data</TabsTrigger>
            </TabsList>
          ) : null}

          <TabsContent className="space-y-4" value="explore">
            <AnalysisSettingsSlot
              container={settingsContainer}
              description="input vars 하나와 숫자 CalculationData 하나를 선택하면 산점도가 즉시 갱신됩니다."
              id="explore"
              title="Explore"
            >
              <SearchableColumnSelect
                columns={inputColumns}
                label="Input variable"
                onChange={(value) => requestRelationshipPlot(value, exploreTargetKey)}
                value={exploreInputKey}
              />
              <SearchableColumnSelect
                columns={targetColumns}
                label="Calculation Data"
                onChange={(value) => requestRelationshipPlot(exploreInputKey, value)}
                value={exploreTargetKey}
              />
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
                      points={relationshipPlot.points}
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
                          onClick={() =>
                            setRelationshipOffset((offset) => Math.max(0, offset - RELATIONSHIP_PAGE_SIZE))
                          }
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
                    상관계수를 계산할 수 있는 조합이 없습니다. 각 조합에 서로 다른 값과 완전한 표본이 3개 이상
                    필요합니다.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent className="space-y-4" value="mining">
            <AnalysisSettingsSlot
              container={settingsContainer}
              description="여러 feature를 표준화해 PCA, 군집과 reconstruction anomaly를 계산합니다."
              id="mining"
              title="Mining 설정"
            >
              <ColumnPicker
                columns={featureColumns}
                disabled={busy !== null}
                max={50}
                onChange={setMiningFeatureKeys}
                selected={miningFeatureKeys}
              />
              <label className="block space-y-2 text-sm">
                <span className="font-medium">이상치 상위 {outlierPercent}%</span>
                <input
                  aria-label="이상치 비율"
                  className="w-full accent-primary"
                  disabled={busy !== null}
                  max="10"
                  min="1"
                  onChange={(event) => setOutlierPercent(Number(event.target.value))}
                  type="range"
                  value={outlierPercent}
                />
              </label>
              <Button className="w-full" disabled={busy !== null || miningFeatureKeys.length < 2} onClick={runMining}>
                {busy === 'mine' ? <LoaderCircle className="animate-spin" /> : <Sparkles />}Mining 실행
              </Button>
              {miningFeatureKeys.length < 2 ? (
                <p className="text-xs text-amber-700">서로 다른 feature를 2개 이상 선택하세요.</p>
              ) : null}
            </AnalysisSettingsSlot>
            {busy === 'mine' ? (
              <EmptyResult>
                <span>
                  <LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-primary" />
                  {progress ?? 'Mining을 계산하는 중입니다.'}
                </span>
              </EmptyResult>
            ) : mining ? (
              <>
                <div className="grid [grid-template-columns:repeat(auto-fit,minmax(360px,1fr))] gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>PCA projection</CardTitle>
                      <CardDescription>
                        K={mining.clusterCount} · silhouette {formatNumber(mining.silhouette)} · PC1{' '}
                        {(100 * (mining.explainedVariance[0] ?? 0)).toFixed(1)}% · PC2{' '}
                        {(100 * (mining.explainedVariance[1] ?? 0)).toFixed(1)}%
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ScatterPlot
                        label="PCA 2D projection"
                        points={mining.points.map((point) => ({
                          x: point.pc1,
                          y: point.pc2,
                          measurementId: point.measurementId,
                          cluster: point.cluster,
                          outlier: point.outlier,
                        }))}
                        xLabel="PC1"
                        yLabel="PC2"
                      />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Principal component loadings</CardTitle>
                      <CardDescription>PC1 절댓값이 큰 feature부터 표시합니다.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Feature</TableHead>
                            <TableHead>PC1</TableHead>
                            <TableHead>PC2</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[...mining.loadings]
                            .sort((left, right) => Math.abs(right.pc1) - Math.abs(left.pc1))
                            .slice(0, 15)
                            .map((loading) => (
                              <TableRow key={loading.key}>
                                <TableCell>
                                  <span className="block max-w-64 truncate" title={loading.key}>
                                    {columnLabel(profile.columns.find((column) => column.key === loading.key))}
                                  </span>
                                </TableCell>
                                <TableCell>{formatNumber(loading.pc1)}</TableCell>
                                <TableCell>{formatNumber(loading.pc2)}</TableCell>
                              </TableRow>
                            ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </div>
                <Card>
                  <CardHeader>
                    <CardTitle>Reconstruction anomaly</CardTitle>
                    <CardDescription>PCA 90% 설명 분산 reconstruction error가 큰 Measurement입니다.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Measurement</TableHead>
                          <TableHead>Input fingerprint</TableHead>
                          <TableHead>Cluster</TableHead>
                          <TableHead>Anomaly score</TableHead>
                          <TableHead>상태</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {[...mining.points]
                          .sort((left, right) => right.anomalyScore - left.anomalyScore)
                          .slice(0, 15)
                          .map((point) => (
                            <TableRow key={point.measurementId}>
                              <TableCell>#{point.measurementId}</TableCell>
                              <TableCell className="max-w-64 truncate" title={point.inputFingerprint}>
                                {point.inputFingerprint}
                              </TableCell>
                              <TableCell>{point.cluster + 1}</TableCell>
                              <TableCell>{formatNumber(point.anomalyScore)}</TableCell>
                              <TableCell>
                                {point.outlier ? (
                                  <Badge>상위 {(mining.outlierFraction * 100).toFixed(0)}%</Badge>
                                ) : (
                                  '일반'
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            ) : (
              <EmptyResult>
                feature를 2개 이상 선택하고 Mining을 실행하면 PCA, 군집과 이상치 결과가 여기에 표시됩니다.
              </EmptyResult>
            )}
          </TabsContent>

          <TabsContent className="space-y-4" value="prediction">
            <AnalysisSettingsSlot
              container={settingsContainer}
              description="동일 입력을 fold 사이에 분리해 Ridge와 Random Forest를 비교합니다."
              id="prediction"
              title="Prediction 설정"
            >
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Prediction target</span>
                <Select onValueChange={setPredictionTargetKey} value={predictionTargetKey || undefined}>
                  <SelectTrigger aria-label="Prediction target">
                    <SelectValue placeholder="Calculation Data 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetColumns.map((column) => (
                      <SelectItem key={column.key} value={column.key}>
                        {columnLabel(column)}
                        {column.unit ? ` · ${column.unit}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <ColumnPicker
                columns={featureColumns}
                disabled={busy !== null}
                max={50}
                onChange={(keys) => {
                  setPredictionFeatureKeys(keys)
                  setWhatIf(
                    Object.fromEntries(
                      keys.map((key) => [
                        key,
                        whatIf[key] ?? featureColumns.find((column) => column.key === key)?.p50 ?? 0,
                      ]),
                    ),
                  )
                }}
                selected={predictionFeatureKeys}
              />
              <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3 text-xs">
                <p className={predictionTarget && predictionTarget.count >= 20 ? 'text-emerald-700' : 'text-amber-700'}>
                  유효 target 행 {predictionTarget?.count ?? 0} / 20+
                </p>
                <p
                  className={
                    predictionTarget && predictionTarget.distinctCount >= 5 ? 'text-emerald-700' : 'text-amber-700'
                  }
                >
                  서로 다른 target 값 {predictionTarget?.distinctCount ?? 0} / 5+
                </p>
                <p
                  className={
                    predictionTarget && (predictionTarget.distinctInputCount ?? 0) >= 5
                      ? 'text-emerald-700'
                      : 'text-amber-700'
                  }
                >
                  서로 다른 입력 {predictionTarget?.distinctInputCount ?? 0} / 5+
                </p>
                <p className={predictionFeatureKeys.length > 0 ? 'text-emerald-700' : 'text-amber-700'}>
                  선택 feature {predictionFeatureKeys.length} / 1+
                </p>
              </div>
              <Button className="w-full" disabled={busy !== null || !predictionReady} onClick={runPrediction}>
                {busy === 'predict' ? <LoaderCircle className="animate-spin" /> : <BrainCircuit />}모델 비교·학습
              </Button>
              {prediction ? (
                <div className="space-y-3 border-t pt-4">
                  <div>
                    <p className="text-sm font-medium">What-if 입력</p>
                    <p className="mt-1 text-xs text-muted-foreground">재학습 없이 현재 최종 모델에 적용합니다.</p>
                  </div>
                  <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
                    {predictionFeatureKeys.map((key) => {
                      const column = featureColumns.find((item) => item.key === key)
                      if (!column) return null
                      const value = whatIf[key] ?? column.p50 ?? 0
                      const outside =
                        (column.min !== undefined && value < column.min) ||
                        (column.max !== undefined && value > column.max)
                      return (
                        <label className="block space-y-1 text-sm" key={key}>
                          <span className="block truncate font-medium" title={key}>
                            {columnLabel(column)}
                          </span>
                          <Input
                            onChange={(event) =>
                              setWhatIf((current) => ({ ...current, [key]: Number(event.target.value) }))
                            }
                            step="any"
                            type="number"
                            value={value}
                          />
                          <span className={cn('text-xs text-muted-foreground', outside && 'text-amber-700')}>
                            관측 {formatNumber(column.min)}–{formatNumber(column.max)}
                            {outside ? ' · 외삽' : ''}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  <Button className="w-full" disabled={busy !== null} onClick={runWhatIf}>
                    {busy === 'what-if' ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}What-if 계산
                  </Button>
                </div>
              ) : null}
            </AnalysisSettingsSlot>
            {busy === 'predict' ? (
              <EmptyResult>
                <span>
                  <LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-primary" />
                  {progress ?? '교차 검증과 최종 학습을 진행하는 중입니다.'}
                </span>
              </EmptyResult>
            ) : prediction ? (
              <>
                <div className="grid [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))] gap-3">
                  <MetricCard
                    label="Selected model"
                    value={prediction.selectedModel === 'ridge' ? 'Ridge' : 'Random Forest'}
                  />
                  <MetricCard
                    label="OOF R²"
                    value={prediction.metrics[prediction.selectedModel === 'ridge' ? 'ridge' : 'randomForest'].r2}
                  />
                  <MetricCard
                    label="OOF MAE"
                    value={prediction.metrics[prediction.selectedModel === 'ridge' ? 'ridge' : 'randomForest'].mae}
                  />
                  <MetricCard
                    label="OOF RMSE"
                    value={prediction.metrics[prediction.selectedModel === 'ridge' ? 'ridge' : 'randomForest'].rmse}
                  />
                </div>
                <div className="grid [grid-template-columns:repeat(auto-fit,minmax(360px,1fr))] gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>Model comparison</CardTitle>
                      <CardDescription>동일한 grouped folds에서 계산한 OOF 지표입니다.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Model</TableHead>
                            <TableHead>R²</TableHead>
                            <TableHead>MAE</TableHead>
                            <TableHead>RMSE</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <TableRow>
                            <TableCell>
                              Ridge{prediction.selectedModel === 'ridge' ? <Badge className="ml-2">선택</Badge> : null}
                            </TableCell>
                            <TableCell>{formatNumber(prediction.metrics.ridge.r2)}</TableCell>
                            <TableCell>{formatNumber(prediction.metrics.ridge.mae)}</TableCell>
                            <TableCell>{formatNumber(prediction.metrics.ridge.rmse)}</TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell>
                              Random Forest
                              {prediction.selectedModel === 'random-forest' ? (
                                <Badge className="ml-2">선택</Badge>
                              ) : null}
                            </TableCell>
                            <TableCell>{formatNumber(prediction.metrics.randomForest.r2)}</TableCell>
                            <TableCell>{formatNumber(prediction.metrics.randomForest.mae)}</TableCell>
                            <TableCell>{formatNumber(prediction.metrics.randomForest.rmse)}</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Observed × out-of-fold prediction</CardTitle>
                      <CardDescription>점선은 관측값과 예측값이 같은 기준선입니다.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ScatterPlot
                        diagonal
                        label="관측값과 out-of-fold 예측값"
                        points={prediction.rows.map((row) => ({
                          x: row.observed,
                          y: row.predicted,
                          measurementId: row.measurementId,
                          cluster: row.fold,
                        }))}
                        xLabel="관측값"
                        yLabel="OOF 예측값"
                      />
                    </CardContent>
                  </Card>
                </div>
                <div className="grid [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))] gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>Feature importance</CardTitle>
                      <CardDescription>{prediction.importanceMethod}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {prediction.importances.slice(0, 15).map((importance) => (
                        <div
                          className="grid grid-cols-[minmax(0,1fr)_minmax(80px,140px)_48px] items-center gap-2 text-sm"
                          key={importance.key}
                        >
                          <span className="truncate" title={importance.key}>
                            {columnLabel(featureColumns.find((column) => column.key === importance.key))}
                          </span>
                          <span className="h-2 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full bg-primary" style={{ width: `${importance.value * 100}%` }} />
                          </span>
                          <span className="text-right tabular-nums">{(importance.value * 100).toFixed(1)}%</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>What-if result</CardTitle>
                      <CardDescription>
                        범위는 grouped OOF 절대 잔차의 90분위수이며 통계적 신뢰구간이 아닙니다.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-3xl font-semibold tabular-nums">{formatNumber(prediction.prediction)}</p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        잔차 기반 범위 {formatNumber(prediction.interval[0])}–{formatNumber(prediction.interval[1])}
                      </p>
                      {prediction.extrapolatedFeatureKeys.length > 0 ? (
                        <p className="mt-3 text-sm text-amber-700">
                          관측 범위를 벗어난 feature:{' '}
                          {prediction.extrapolatedFeatureKeys
                            .map((key) => columnLabel(featureColumns.find((column) => column.key === key)))
                            .join(', ')}
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                </div>
              </>
            ) : (
              <EmptyResult>
                조건을 충족하는 target과 feature를 선택한 뒤 모델을 학습하면 OOF 검증, 중요도와 What-if 결과가
                표시됩니다.
              </EmptyResult>
            )}
          </TabsContent>

          <TabsContent className="space-y-4" value="data">
            <AnalysisSettingsSlot
              container={settingsContainer}
              description="표와 CSV에 포함할 숫자 열, histogram과 profile 필터를 선택합니다."
              id="data"
              title="Data 설정"
            >
              <ColumnPicker
                columns={profile.columns}
                disabled={busy !== null}
                max={profile.columns.length}
                onChange={setDataColumnKeys}
                selected={dataColumnKeys}
              />
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Histogram</span>
                <Select onValueChange={setHistogramKey} value={histogramKey || undefined}>
                  <SelectTrigger aria-label="Histogram 열">
                    <SelectValue placeholder="열 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {profile.columns
                      .filter((column) => column.histogram?.length)
                      .map((column) => (
                        <SelectItem key={column.key} value={column.key}>
                          {columnLabel(column)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </label>
              <div className="space-y-2 border-t pt-3">
                <p className="text-sm font-medium">Scalar profile 필터</p>
                <Input
                  aria-label="Scalar profile 검색"
                  onChange={(event) => setProfileSearch(event.target.value)}
                  placeholder="열 이름 검색"
                  value={profileSearch}
                />
                <Select
                  onValueChange={(value) => setProfileSource(value as typeof profileSource)}
                  value={profileSource}
                >
                  <SelectTrigger aria-label="Scalar profile source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">모든 source</SelectItem>
                    <SelectItem value="measurement-vars">Input vars</SelectItem>
                    <SelectItem value="measurement-material">Material</SelectItem>
                    <SelectItem value="calculation-data">Calculation Data</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  onValueChange={(value) => setProfileStatus(value as typeof profileStatus)}
                  value={profileStatus}
                >
                  <SelectTrigger aria-label="Scalar profile status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">모든 상태</SelectItem>
                    <SelectItem value="eligible">사용 가능</SelectItem>
                    <SelectItem value="excluded">제외됨</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </AnalysisSettingsSlot>
            <Card>
              <CardHeader>
                <CardTitle>Distribution · {columnLabel(histogramColumn)}</CardTitle>
                <CardDescription>{columnMeta(histogramColumn)}</CardDescription>
              </CardHeader>
              <CardContent>
                {histogramColumn ? (
                  <Histogram column={histogramColumn} />
                ) : (
                  <p className="py-10 text-center text-sm text-muted-foreground">Histogram 열을 선택하세요.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Selected analysis data</CardTitle>
                <CardDescription>
                  현재 선택한 열의 100행 페이지입니다. 같은 선택이 Data CSV에 사용됩니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {dataColumnKeys.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">좌측에서 표시할 열을 선택하세요.</p>
                ) : tablePage ? (
                  <>
                    <Table containerClassName="max-h-[34rem] overflow-auto">
                      <TableHeader className="sticky top-0 z-[1] bg-background">
                        <TableRow>
                          <TableHead>Measurement</TableHead>
                          <TableHead>Input</TableHead>
                          {tablePage.columns.map((key) => {
                            const column = profile.columns.find((item) => item.key === key)
                            return (
                              <TableHead key={key}>
                                <span className="block min-w-28" title={key}>
                                  {columnLabel(column)}
                                </span>
                                {column?.unit ? (
                                  <span className="text-[10px] font-normal text-muted-foreground">{column.unit}</span>
                                ) : null}
                              </TableHead>
                            )
                          })}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tablePage.rows.map((row) => (
                          <TableRow key={row.measurementId}>
                            <TableCell>#{row.measurementId}</TableCell>
                            <TableCell className="max-w-44 truncate" title={row.inputFingerprint}>
                              {row.inputFingerprint}
                            </TableCell>
                            {row.values.map((value, index) => (
                              <TableCell className="tabular-nums" key={tablePage.columns[index]}>
                                {formatNumber(value)}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        {tablePage.total === 0 ? 0 : tablePage.offset + 1}–
                        {Math.min(tablePage.total, tablePage.offset + tablePage.rows.length)} / {tablePage.total}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          disabled={tableOffset === 0}
                          onClick={() => setTableOffset((offset) => Math.max(0, offset - 100))}
                          size="sm"
                          variant="outline"
                        >
                          이전
                        </Button>
                        <Button
                          disabled={tableOffset + 100 >= tablePage.total}
                          onClick={() => setTableOffset((offset) => offset + 100)}
                          size="sm"
                          variant="outline"
                        >
                          다음
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex min-h-40 items-center justify-center">
                    <LoaderCircle className="size-6 animate-spin text-primary" />
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Scalar profile</CardTitle>
                <CardDescription>누락률이 30%를 넘는 feature와 상수 열은 고급 분석에서 제외됩니다.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Column</TableHead>
                      <TableHead>종류</TableHead>
                      <TableHead>평균</TableHead>
                      <TableHead>표준편차</TableHead>
                      <TableHead>p05</TableHead>
                      <TableHead>p50</TableHead>
                      <TableHead>p95</TableHead>
                      <TableHead>누락</TableHead>
                      <TableHead>상태</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredProfileColumns.map((column) => (
                      <TableRow key={column.key}>
                        <TableCell>
                          <span className="block max-w-72 truncate font-medium" title={column.key}>
                            {columnLabel(column)}
                          </span>
                          <span className="text-xs text-muted-foreground">{columnMeta(column)}</span>
                        </TableCell>
                        <TableCell>{column.kind}</TableCell>
                        <TableCell>{formatNumber(column.mean)}</TableCell>
                        <TableCell>{formatNumber(column.std)}</TableCell>
                        <TableCell>{formatNumber(column.p05)}</TableCell>
                        <TableCell>{formatNumber(column.p50)}</TableCell>
                        <TableCell>{formatNumber(column.p95)}</TableCell>
                        <TableCell>{(column.missingRatio * 100).toFixed(1)}%</TableCell>
                        <TableCell>
                          {column.eligible ? (
                            <Badge>사용 가능</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">{column.exclusionReason}</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  )
}
