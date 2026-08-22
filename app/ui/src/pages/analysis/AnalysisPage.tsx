import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  BrainCircuit,
  ChartNoAxesCombined,
  Download,
  LoaderCircle,
  LogIn,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dbTables, getListRequest } from '@/api'
import type { ExperimentRecord } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/use-auth'
import { cn } from '@/lib/utils'
import type {
  AnalysisColumnDescriptor,
  AnalysisMiningResult,
  AnalysisPredictionResult,
  AnalysisProfile,
  AnalysisProgressStage,
  AnalysisTablePage,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from './analysis-types'

export type AnalysisTab = 'overview' | 'relationships' | 'mining' | 'prediction' | 'data'

export type AnalysisCommand = Readonly<{
  id: number | string
  type: 'reload' | 'export-dataset' | 'export-prediction'
}>

export type AnalysisWorkspaceProps = {
  command?: AnalysisCommand | null
  experimentId: number | null
  embedded?: boolean
  initialTargetKey?: string | null
  onRequestLogin?: () => void
  onExperimentIdChange?: (id: number) => void
  onTabChange?: (tab: AnalysisTab) => void
  onTargetKeyChange?: (key: string | null) => void
  settingsContainer?: Element | null
  showContextSelectors?: boolean
  tab?: AnalysisTab
}

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
          <CardHeader className="p-3 pb-0">
            <CardTitle className="text-sm">{title}</CardTitle>
            {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
          </CardHeader>
          <CardContent className="space-y-3 p-3">{children}</CardContent>
        </Card>
      ) : (
        children
      )}
    </div>,
    container,
  )
}

function formatNumber(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if ((absolute > 0 && absolute < 0.001) || absolute >= 1_000_000) return value.toExponential(3)
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 }).format(value)
}

function Histogram({ column }: { column: AnalysisColumnDescriptor }) {
  const bins = column.histogram ?? []
  const maximum = Math.max(1, ...bins.map((bin) => bin.count))
  if (bins.length === 0) return <p className="text-sm text-muted-foreground">표시할 숫자 값이 없습니다.</p>
  return (
    <div>
      <svg aria-label={`${column.label} histogram`} className="h-56 w-full" role="img" viewBox="0 0 640 220">
        <line stroke="currentColor" strokeOpacity="0.2" x1="36" x2="620" y1="190" y2="190" />
        {bins.map((bin, index) => {
          const width = 570 / bins.length
          const height = (bin.count / maximum) * 160
          return (
            <g key={`${bin.min}-${bin.max}`}>
              <rect
                className="fill-primary/75"
                height={height}
                rx="2"
                width={Math.max(2, width - 4)}
                x={40 + index * width}
                y={190 - height}
              />
              <title>{`${formatNumber(bin.min)}–${formatNumber(bin.max)}: ${bin.count}`}</title>
            </g>
          )
        })}
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatNumber(column.min)}</span>
        <span>{formatNumber(column.max)}</span>
      </div>
    </div>
  )
}

function ScatterPlot({
  label,
  points,
}: {
  label: string
  points: readonly Readonly<{ x: number; y: number; cluster?: number; outlier?: boolean }>[]
}) {
  const finite = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (finite.length === 0) return <p className="text-sm text-muted-foreground">표시할 좌표가 없습니다.</p>
  const minX = Math.min(...finite.map((point) => point.x))
  const maxX = Math.max(...finite.map((point) => point.x))
  const minY = Math.min(...finite.map((point) => point.y))
  const maxY = Math.max(...finite.map((point) => point.y))
  const scaleX = (value: number) => 35 + ((value - minX) / (maxX - minX || 1)) * 580
  const scaleY = (value: number) => 285 - ((value - minY) / (maxY - minY || 1)) * 250
  const colors = ['#2563eb', '#db2777', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4f46e5']
  return (
    <svg aria-label={label} className="h-80 w-full" role="img" viewBox="0 0 640 320">
      <line stroke="currentColor" strokeOpacity="0.18" x1="35" x2="615" y1="285" y2="285" />
      <line stroke="currentColor" strokeOpacity="0.18" x1="35" x2="35" y1="35" y2="285" />
      {finite.map((point, index) => (
        <circle
          cx={scaleX(point.x)}
          cy={scaleY(point.y)}
          fill={colors[(point.cluster ?? 0) % colors.length]}
          key={index}
          opacity="0.72"
          r={point.outlier ? 5 : 3.5}
          stroke={point.outlier ? '#111827' : 'none'}
          strokeWidth="1.5"
        >
          <title>{`${formatNumber(point.x)}, ${formatNumber(point.y)}${point.outlier ? ' · 이상치' : ''}`}</title>
        </circle>
      ))}
    </svg>
  )
}

function CorrelationHeatmap({
  keys,
  matrix,
}: {
  keys: readonly string[]
  matrix: readonly (readonly (number | null)[])[]
}) {
  const shownKeys = keys.slice(0, 15)
  if (shownKeys.length === 0) return <p className="text-sm text-muted-foreground">상관계수 결과가 없습니다.</p>
  const size = 28
  const margin = 145
  return (
    <div className="overflow-x-auto">
      <svg
        aria-label="Pearson correlation heatmap"
        className="min-w-max"
        role="img"
        viewBox={`0 0 ${margin + size * shownKeys.length + 10} ${margin + size * shownKeys.length + 10}`}
        width={margin + size * shownKeys.length + 10}
      >
        {shownKeys.map((key, index) => (
          <g key={key}>
            <text fontSize="9" textAnchor="end" x={margin - 7} y={margin + index * size + 18}>
              {key.slice(-20)}
            </text>
            <text
              fontSize="9"
              textAnchor="start"
              transform={`rotate(-50 ${margin + index * size + 14} ${margin - 8})`}
              x={margin + index * size + 14}
              y={margin - 8}
            >
              {key.slice(-20)}
            </text>
          </g>
        ))}
        {shownKeys.flatMap((_, row) =>
          shownKeys.map((__, column) => {
            const value = matrix[row]?.[column]
            const intensity = value === null || value === undefined ? 0 : Math.abs(value)
            const color =
              value !== null && value < 0 ? `rgba(37, 99, 235, ${intensity})` : `rgba(220, 38, 38, ${intensity})`
            return (
              <rect
                fill={color}
                height={size - 1}
                key={`${row}-${column}`}
                width={size - 1}
                x={margin + column * size}
                y={margin + row * size}
              >
                <title>{value === null || value === undefined ? '계산 불가' : formatNumber(value)}</title>
              </rect>
            )
          }),
        )}
      </svg>
      {keys.length > shownKeys.length ? (
        <p className="mt-2 text-xs text-muted-foreground">가독성을 위해 선택한 열 중 앞의 15개만 표시합니다.</p>
      ) : null}
    </div>
  )
}

function FeaturePicker({
  columns,
  disabled,
  selected,
  onChange,
}: {
  columns: readonly AnalysisColumnDescriptor[]
  disabled: boolean
  selected: readonly string[]
  onChange: (keys: readonly string[]) => void
}) {
  return (
    <div className="grid max-h-64 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2 xl:grid-cols-3">
      {columns.map((column) => {
        const checked = selected.includes(column.key)
        return (
          <label className={cn('flex gap-2 text-sm', !column.eligible && 'text-muted-foreground')} key={column.key}>
            <input
              checked={checked}
              disabled={disabled || !column.eligible}
              onChange={(event) => {
                if (!event.target.checked) {
                  onChange(selected.filter((key) => key !== column.key))
                  return
                }
                if (selected.length < 50) onChange([...selected, column.key])
              }}
              type="checkbox"
            />
            <span className="min-w-0">
              <span className="block truncate" title={column.label}>
                {column.label}
              </span>
              <span className="block text-xs text-muted-foreground">
                {column.source} · 누락 {(column.missingRatio * 100).toFixed(1)}%
                {column.exclusionReason ? ` · ${column.exclusionReason}` : ''}
              </span>
            </span>
          </label>
        )
      })}
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(value)}</p>
    </div>
  )
}

export function AnalysisWorkspace({
  command,
  experimentId: selectedExperimentId,
  embedded = false,
  initialTargetKey = null,
  onRequestLogin,
  onExperimentIdChange,
  onTabChange,
  onTargetKeyChange,
  settingsContainer,
  showContextSelectors = false,
  tab: controlledTab,
}: AnalysisWorkspaceProps) {
  const auth = useAuth()
  const [workspaceTab, setWorkspaceTab] = useState<AnalysisTab>(controlledTab ?? 'overview')
  const tab = controlledTab ?? workspaceTab

  const [profile, setProfile] = useState<AnalysisProfile | null>(null)
  const [mining, setMining] = useState<AnalysisMiningResult | null>(null)
  const [prediction, setPrediction] = useState<AnalysisPredictionResult | null>(null)
  const [tablePage, setTablePage] = useState<AnalysisTablePage | null>(null)
  const [tableOffset, setTableOffset] = useState(0)
  const [selectedFeatureKeys, setSelectedFeatureKeys] = useState<readonly string[]>([])
  const [selectedTargetKey, setSelectedTargetKey] = useState('')
  const [histogramKey, setHistogramKey] = useState('')
  const [xKey, setXKey] = useState('')
  const [yKey, setYKey] = useState('')
  const [whatIf, setWhatIf] = useState<Readonly<Record<string, number>>>({})
  const [outlierPercent, setOutlierPercent] = useState(5)
  const [busy, setBusy] = useState<'export' | 'load' | 'mine' | 'predict' | null>(null)
  const [progress, setProgress] = useState<AnalysisProgressStage | null>(null)
  const [progressCount, setProgressCount] = useState<Readonly<{ completed: number; total: number }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [workerGeneration, setWorkerGeneration] = useState(0)
  const workerRef = useRef<Worker | null>(null)
  const requestSequence = useRef(0)
  const loadRequestId = useRef('')
  const activeRequestId = useRef('')
  const tableRequestId = useRef('')
  const staleRequestId = useRef('')
  const handledCommandId = useRef<AnalysisCommand['id'] | null>(null)
  const targetQueryRef = useRef(initialTargetKey)
  targetQueryRef.current = initialTargetKey

  const experimentsQuery = useQuery({
    queryKey: ['analysis', 'experiments'],
    queryFn: () => dbTables.Experiment.listRows({ ...getListRequest('visible'), limit: null }),
    enabled: auth.isAuthenticated && showContextSelectors,
  })
  const experiments = useMemo(
    () =>
      (experimentsQuery.data?.items ?? []).filter(
        (row): row is ExperimentRecord & { id: number } => row.id !== undefined,
      ),
    [experimentsQuery.data?.items],
  )

  const nextRequestId = useCallback((kind: string) => {
    requestSequence.current += 1
    return `analysis-${kind}-${requestSequence.current}`
  }, [])

  useEffect(() => {
    if (profile) onTargetKeyChange?.(selectedTargetKey || null)
  }, [onTargetKeyChange, profile, selectedTargetKey])

  useEffect(() => {
    if (!auth.isAuthenticated || selectedExperimentId === null) return
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    setProfile(null)
    setMining(null)
    setPrediction(null)
    setTablePage(null)
    setError(null)
    setStale(false)
    setBusy('load')
    setProgress('Measurement 조회')
    const requestId = nextRequestId('load')
    loadRequestId.current = requestId

    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data
      if (response.type === 'progress') {
        if (response.requestId === loadRequestId.current || response.requestId === activeRequestId.current) {
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
          .sort((left, right) => {
            const leftVars = left.source.endsWith('vars') ? 0 : 1
            const rightVars = right.source.endsWith('vars') ? 0 : 1
            return leftVars - rightVars || left.missingRatio - right.missingRatio
          })
          .slice(0, 50)
        const targets = response.profile.columns.filter((column) => column.kind === 'target' && column.eligible)
        const requestedTarget = targetQueryRef.current
        const initialTarget = targets.some((column) => column.key === requestedTarget)
          ? (requestedTarget ?? '')
          : (targets[0]?.key ?? '')
        setProfile(response.profile)
        setSelectedFeatureKeys(features.map((column) => column.key))
        setSelectedTargetKey(initialTarget)
        setHistogramKey(initialTarget || features[0]?.key || '')
        setXKey(features[0]?.key ?? '')
        setYKey(features[1]?.key ?? features[0]?.key ?? '')
        setWhatIf(Object.fromEntries(features.map((column) => [column.key, column.p50 ?? 0])))
        setBusy(null)
        setProgress(null)
        setProgressCount(null)
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
        setProgress(null)
        return
      }
      if (response.type === 'error') {
        if (
          response.requestId === loadRequestId.current ||
          response.requestId === activeRequestId.current ||
          response.requestId === tableRequestId.current
        ) {
          setError(response.message)
          setBusy(null)
          setProgress(null)
        }
      }
    }
    worker.onerror = () => {
      setError('Analysis Worker를 실행하지 못했습니다.')
      setBusy(null)
      setProgress(null)
    }
    worker.postMessage({
      type: 'load-context',
      requestId,
      experimentId: selectedExperimentId,
    } satisfies AnalysisWorkerRequest)
    return () => {
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
    }
  }, [auth.isAuthenticated, nextRequestId, selectedExperimentId, workerGeneration])

  const dataColumnKeys = useMemo(
    () => [...selectedFeatureKeys, ...(selectedTargetKey ? [selectedTargetKey] : [])],
    [selectedFeatureKeys, selectedTargetKey],
  )

  useEffect(() => {
    setMining(null)
  }, [outlierPercent, selectedFeatureKeys, selectedTargetKey, xKey, yKey])

  useEffect(() => {
    setPrediction(null)
  }, [selectedFeatureKeys, selectedTargetKey])

  useEffect(() => {
    if (tab !== 'data' || !profile || !workerRef.current || dataColumnKeys.length === 0) return
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
  const targetColumns = useMemo(
    () => profile?.columns.filter((column) => column.kind === 'target' && column.eligible) ?? [],
    [profile],
  )
  const selectedTarget = targetColumns.find((column) => column.key === selectedTargetKey)
  const histogramColumn = profile?.columns.find((column) => column.key === histogramKey)
  const predictionReady = Boolean(
    profile &&
    profile.rowCount >= 20 &&
    profile.recordedMeasurementCount >= 5 &&
    selectedTarget &&
    selectedTarget.distinctCount >= 5 &&
    selectedFeatureKeys.length > 0,
  )

  const runMining = () => {
    if (!workerRef.current || selectedFeatureKeys.length < 2) return
    const requestId = nextRequestId('mine')
    activeRequestId.current = requestId
    setBusy('mine')
    setError(null)
    workerRef.current.postMessage({
      type: 'mine',
      requestId,
      featureKeys: selectedFeatureKeys,
      xKey: xKey || null,
      yKey: yKey || null,
      targetKey: selectedTargetKey || null,
      outlierFraction: outlierPercent / 100,
    } satisfies AnalysisWorkerRequest)
  }

  const runPrediction = () => {
    if (!workerRef.current || !selectedTargetKey || !predictionReady) return
    const requestId = nextRequestId('predict')
    activeRequestId.current = requestId
    setBusy('predict')
    setError(null)
    workerRef.current.postMessage({
      type: 'predict',
      requestId,
      featureKeys: selectedFeatureKeys,
      targetKey: selectedTargetKey,
      whatIf,
    } satisfies AnalysisWorkerRequest)
  }

  const exportCsv = useCallback(
    (kind: 'dataset' | 'prediction') => {
      if (!workerRef.current) return
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

  const restartWorker = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
    setWorkerGeneration((generation) => generation + 1)
  }, [])

  useEffect(() => {
    if (!command || handledCommandId.current === command.id) return
    handledCommandId.current = command.id
    if (command.type === 'reload') restartWorker()
    else if (command.type === 'export-dataset') exportCsv('dataset')
    else exportCsv('prediction')
  }, [command, exportCsv, restartWorker])

  if (auth.isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <LoaderCircle className="size-7 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!auth.isAuthenticated) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>로그인이 필요합니다</CardTitle>
            <CardDescription>내 Measurement와 Recorded Data를 브라우저에서 분석하려면 로그인하세요.</CardDescription>
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

  return (
    <div className={cn('space-y-5', !embedded && 'mx-auto max-w-[1500px] px-4 py-6 sm:px-6')}>
      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-medium text-primary">Browser analysis workspace</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Analysis</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            같은 Experiment의 Measurement를 통계·마이닝하고 예측 모델을 학습합니다. 데이터와 모델은 이 브라우저 탭의
            Worker 메모리에만 유지됩니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!profile || busy !== null} onClick={() => exportCsv('dataset')} variant="outline">
            <Download />
            분석 데이터 CSV
          </Button>
          <Button disabled={!prediction || busy !== null} onClick={() => exportCsv('prediction')} variant="outline">
            <Download />
            Prediction CSV
          </Button>
        </div>
      </div>

      {showContextSelectors ? (
        <AnalysisSettingsSlot container={settingsContainer} id="context">
          <Card>
            <CardContent className="pt-6">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Experiment</span>
                <Select
                  onValueChange={(value) => {
                    const id = Number(value)
                    onExperimentIdChange?.(id)
                  }}
                  value={selectedExperimentId ? String(selectedExperimentId) : undefined}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Experiment 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {experiments.map((experiment) => (
                      <SelectItem key={experiment.id} value={String(experiment.id)}>
                        {experiment.name} · #{experiment.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </CardContent>
          </Card>
        </AnalysisSettingsSlot>
      ) : null}

      {stale ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center">
          <AlertTriangle className="size-5 shrink-0" />
          <p className="flex-1 text-sm">
            다른 화면에서 Measurement가 변경되었습니다. 현재 분석 결과는 이전 데이터입니다.
          </p>
          <Button onClick={restartWorker} size="sm" variant="outline">
            <RefreshCw />
            새로 불러오기
          </Button>
        </div>
      ) : null}

      {selectedExperimentId === null ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">
            분석할 Experiment를 선택하세요.
          </CardContent>
        </Card>
      ) : null}

      {busy === 'load' ? (
        <Card>
          <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3">
            <LoaderCircle className="size-7 animate-spin text-primary" />
            <p className="text-sm font-medium">{progress ?? '데이터를 불러오는 중입니다.'}</p>
            {progressCount ? (
              <p className="text-xs text-muted-foreground">
                {progressCount.completed}/{progressCount.total} 범위 완료
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
          <AlertTriangle className="size-5 text-destructive" />
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
            const nextTab = value as AnalysisTab
            setWorkspaceTab(nextTab)
            onTabChange?.(nextTab)
          }}
          value={tab}
        >
          {!settingsContainer ? (
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-5">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="relationships">Relationships</TabsTrigger>
              <TabsTrigger value="mining">Mining</TabsTrigger>
              <TabsTrigger value="prediction">Prediction</TabsTrigger>
              <TabsTrigger value="data">Data</TabsTrigger>
            </TabsList>
          ) : null}

          <TabsContent className="space-y-4" value="overview">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard label="Prepared" value={profile.preparedCount} />
              <MetricCard label="Recorded" value={profile.recordedMeasurementCount} />
              <MetricCard label="All Measurements" value={profile.rowCount} />
              <MetricCard label="Recorded Data rows" value={profile.recordedDataCount} />
            </div>
            {profile.rowCount === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-sm text-muted-foreground">
                  이 Experiment에 Measurement가 없습니다.
                </CardContent>
              </Card>
            ) : null}
            {profile.warnings.map((warning) => (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm" key={warning}>
                {warning}
              </div>
            ))}
            <Card>
              <CardHeader>
                <CardTitle>분포</CardTitle>
                <CardDescription>숫자 feature 또는 target의 histogram입니다.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <AnalysisSettingsSlot
                  container={settingsContainer}
                  description="Histogram에 표시할 숫자 열을 선택합니다."
                  id="overview"
                  title="분포 열"
                >
                  <Select onValueChange={setHistogramKey} value={histogramKey || undefined}>
                    <SelectTrigger className="max-w-xl">
                      <SelectValue placeholder="Column 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {profile.columns
                        .filter((column) => column.histogram?.length)
                        .map((column) => (
                          <SelectItem key={column.key} value={column.key}>
                            {column.label}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </AnalysisSettingsSlot>
                {histogramColumn ? <Histogram column={histogramColumn} /> : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Scalar profile</CardTitle>
                <CardDescription>누락률이 30%를 넘는 feature와 상수 열은 분석에서 제외됩니다.</CardDescription>
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
                    {profile.columns.map((column) => (
                      <TableRow key={column.key}>
                        <TableCell>
                          <span className="block max-w-72 truncate font-medium" title={column.key}>
                            {column.label}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {column.unit ?? column.quantityKind ?? column.source}
                          </span>
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
            {profile.categoricalSummaries.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Boolean · String 빈도</CardTitle>
                  <CardDescription>숫자 분석과 Prediction에는 포함하지 않습니다.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  {profile.categoricalSummaries.map((summary) => (
                    <div className="rounded-lg border p-3" key={summary.name}>
                      <p className="font-medium">{summary.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {summary.dtype} · {summary.quantityKind}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {summary.counts.slice(0, 12).map((count) => (
                          <Badge className="border bg-transparent text-foreground" key={count.value}>
                            {count.value}: {count.count}
                          </Badge>
                        ))}
                      </div>
                      {summary.excludedReason ? (
                        <p className="mt-2 text-xs text-destructive">{summary.excludedReason}</p>
                      ) : null}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          <TabsContent className="space-y-4" value="relationships">
            <AnalysisSettingsSlot container={settingsContainer} id="relationships">
              <Card>
                <CardHeader>
                  <CardTitle>관계 설정</CardTitle>
                  <CardDescription>Pearson·Spearman 상관계수와 선택한 두 열의 산점도를 계산합니다.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FeaturePicker
                    columns={featureColumns}
                    disabled={busy !== null}
                    onChange={setSelectedFeatureKeys}
                    selected={selectedFeatureKeys}
                  />
                  <div className="grid gap-3 md:grid-cols-3">
                    <Select onValueChange={setXKey} value={xKey || undefined}>
                      <SelectTrigger>
                        <SelectValue placeholder="X축" />
                      </SelectTrigger>
                      <SelectContent>
                        {featureColumns
                          .filter((column) => column.eligible)
                          .map((column) => (
                            <SelectItem key={column.key} value={column.key}>
                              {column.label}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <Select onValueChange={setYKey} value={yKey || undefined}>
                      <SelectTrigger>
                        <SelectValue placeholder="Y축" />
                      </SelectTrigger>
                      <SelectContent>
                        {[...featureColumns, ...targetColumns]
                          .filter((column) => column.eligible)
                          .map((column) => (
                            <SelectItem key={column.key} value={column.key}>
                              {column.label}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <Select onValueChange={setSelectedTargetKey} value={selectedTargetKey || undefined}>
                      <SelectTrigger>
                        <SelectValue placeholder="상관관계 target" />
                      </SelectTrigger>
                      <SelectContent>
                        {targetColumns.map((column) => (
                          <SelectItem key={column.key} value={column.key}>
                            {column.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button disabled={busy !== null || selectedFeatureKeys.length < 2} onClick={runMining}>
                    {busy === 'mine' ? <LoaderCircle className="animate-spin" /> : <ChartNoAxesCombined />}
                    관계 분석 실행
                  </Button>
                  {busy === 'mine' ? <p className="text-sm text-muted-foreground">{progress}</p> : null}
                </CardContent>
              </Card>
            </AnalysisSettingsSlot>
            {mining ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Pearson heatmap</CardTitle>
                    <CardDescription>파랑은 음의 상관, 빨강은 양의 상관입니다.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CorrelationHeatmap keys={mining.correlationKeys} matrix={mining.correlations} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>산점도</CardTitle>
                    <CardDescription>분석 실행 시 선택한 X·Y 열입니다.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ScatterPlot
                      label="선택 열 산점도"
                      points={mining.points
                        .filter((point) => point.x !== undefined && point.y !== undefined)
                        .map((point) => ({
                          x: point.x!,
                          y: point.y!,
                          cluster: point.cluster,
                          outlier: point.outlier,
                        }))}
                    />
                  </CardContent>
                </Card>
                <Card className="xl:col-span-2">
                  <CardHeader>
                    <CardTitle>Spearman matrix</CardTitle>
                    <CardDescription>순위 기반 단조 관계입니다.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <CorrelationHeatmap keys={mining.correlationKeys} matrix={mining.spearmanCorrelations} />
                  </CardContent>
                </Card>
              </div>
            ) : null}
          </TabsContent>

          <TabsContent className="space-y-4" value="mining">
            <AnalysisSettingsSlot container={settingsContainer} id="mining">
              <Card>
                <CardHeader>
                  <CardTitle>PCA · 군집 · 이상치</CardTitle>
                  <CardDescription>중앙값 보정과 표준화 후 seed 42로 계산합니다.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FeaturePicker
                    columns={featureColumns}
                    disabled={busy !== null}
                    onChange={setSelectedFeatureKeys}
                    selected={selectedFeatureKeys}
                  />
                  <label className="block max-w-md space-y-2 text-sm">
                    <span className="font-medium">이상치 상위 {outlierPercent}%</span>
                    <input
                      className="w-full accent-primary"
                      disabled={busy !== null}
                      max="10"
                      min="1"
                      onChange={(event) => setOutlierPercent(Number(event.target.value))}
                      type="range"
                      value={outlierPercent}
                    />
                  </label>
                  <Button disabled={busy !== null || selectedFeatureKeys.length < 2} onClick={runMining}>
                    {busy === 'mine' ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                    Mining 실행
                  </Button>
                  {busy === 'mine' ? <p className="text-sm text-muted-foreground">{progress}</p> : null}
                </CardContent>
              </Card>
            </AnalysisSettingsSlot>
            {mining ? (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
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
                        cluster: point.cluster,
                        outlier: point.outlier,
                      }))}
                    />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Loading</CardTitle>
                    <CardDescription>PC1·PC2 기여 방향입니다.</CardDescription>
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
                                <span className="block max-w-44 truncate" title={loading.key}>
                                  {loading.key}
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
                <Card className="xl:col-span-2">
                  <CardHeader>
                    <CardTitle>Reconstruction anomaly</CardTitle>
                    <CardDescription>PCA 90% 설명 분산 reconstruction error의 순위 점수입니다.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Measurement</TableHead>
                          <TableHead>Input</TableHead>
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
                              <TableCell className="max-w-44 truncate" title={point.inputFingerprint}>
                                {point.inputFingerprint}
                              </TableCell>
                              <TableCell>{point.cluster}</TableCell>
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
              </div>
            ) : null}
          </TabsContent>

          <TabsContent className="space-y-4" value="prediction">
            <AnalysisSettingsSlot container={settingsContainer} id="prediction">
              <Card>
                <CardHeader>
                  <CardTitle>Data-based Prediction</CardTitle>
                  <CardDescription>
                    동일 입력 조건을 fold 사이에 분리한 최대 5-fold 검증으로 Ridge와 Random Forest를 비교합니다. 최소
                    20행·5개 입력·5개 target 값이 필요합니다.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Select onValueChange={setSelectedTargetKey} value={selectedTargetKey || undefined}>
                    <SelectTrigger className="max-w-xl">
                      <SelectValue placeholder="Prediction target" />
                    </SelectTrigger>
                    <SelectContent>
                      {targetColumns.map((column) => (
                        <SelectItem key={column.key} value={column.key}>
                          {column.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FeaturePicker
                    columns={featureColumns}
                    disabled={busy !== null}
                    onChange={(keys) => {
                      setSelectedFeatureKeys(keys)
                      setWhatIf(
                        Object.fromEntries(
                          keys.map((key) => [
                            key,
                            whatIf[key] ?? featureColumns.find((column) => column.key === key)?.p50 ?? 0,
                          ]),
                        ),
                      )
                    }}
                    selected={selectedFeatureKeys}
                  />
                  {!predictionReady ? (
                    <p className="text-sm text-amber-700">현재 데이터는 Prediction 활성화 조건을 충족하지 않습니다.</p>
                  ) : null}
                  <Button disabled={busy !== null || !predictionReady} onClick={runPrediction}>
                    {busy === 'predict' ? <LoaderCircle className="animate-spin" /> : <BrainCircuit />}
                    모델 비교·학습
                  </Button>
                  {busy === 'predict' ? <p className="text-sm text-muted-foreground">{progress}</p> : null}
                </CardContent>
              </Card>
            </AnalysisSettingsSlot>
            {prediction ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                  <MetricCard label="Ridge R²" value={prediction.metrics.ridge.r2} />
                  <MetricCard label="Ridge MAE" value={prediction.metrics.ridge.mae} />
                  <MetricCard label="Ridge RMSE" value={prediction.metrics.ridge.rmse} />
                  <MetricCard label="RF R²" value={prediction.metrics.randomForest.r2} />
                  <MetricCard label="RF MAE" value={prediction.metrics.randomForest.mae} />
                  <MetricCard label="RF RMSE" value={prediction.metrics.randomForest.rmse} />
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle>관측값 × OOF 예측값</CardTitle>
                      <CardDescription>
                        선택 모델: {prediction.selectedModel} · Ridge α {prediction.ridgeAlpha}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ScatterPlot
                        label="관측값과 out-of-fold 예측값"
                        points={prediction.rows.map((row) => ({
                          x: row.observed,
                          y: row.predicted,
                          cluster: row.fold,
                        }))}
                      />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Feature importance</CardTitle>
                      <CardDescription>{prediction.importanceMethod}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {prediction.importances.slice(0, 15).map((importance) => (
                        <div
                          className="grid grid-cols-[minmax(0,1fr)_120px_48px] items-center gap-2 text-sm"
                          key={importance.key}
                        >
                          <span className="truncate" title={importance.key}>
                            {importance.key}
                          </span>
                          <span className="h-2 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full bg-primary" style={{ width: `${importance.value * 100}%` }} />
                          </span>
                          <span className="text-right tabular-nums">{(importance.value * 100).toFixed(1)}%</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </div>
                <Card>
                  <CardHeader>
                    <CardTitle>What-if</CardTitle>
                    <CardDescription>
                      범위는 교차 검증 절대 잔차의 90분위수이며 통계적 신뢰구간이 아닙니다.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <AnalysisSettingsSlot
                      container={settingsContainer}
                      description="학습된 모델에 적용할 feature 값을 조정합니다."
                      id="prediction-what-if"
                      title="What-if 입력"
                    >
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {selectedFeatureKeys.map((key) => {
                          const column = featureColumns.find((item) => item.key === key)
                          if (!column) return null
                          const value = whatIf[key] ?? column.p50 ?? 0
                          const outside =
                            (column.min !== undefined && value < column.min) ||
                            (column.max !== undefined && value > column.max)
                          return (
                            <label className="space-y-1 text-sm" key={key}>
                              <span className="block truncate font-medium" title={key}>
                                {column.label}
                              </span>
                              <Input
                                onChange={(event) =>
                                  setWhatIf((current) => ({
                                    ...current,
                                    [key]: Number(event.target.value),
                                  }))
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
                      <Button disabled={busy !== null} onClick={runPrediction}>
                        What-if 다시 계산
                      </Button>
                    </AnalysisSettingsSlot>
                    <div className="rounded-lg border bg-primary/5 p-4">
                      <p className="text-sm text-muted-foreground">예측값</p>
                      <p className="mt-1 text-2xl font-semibold">{formatNumber(prediction.prediction)}</p>
                      <p className="text-sm text-muted-foreground">
                        잔차 기반 범위 {formatNumber(prediction.interval[0])}–{formatNumber(prediction.interval[1])}
                      </p>
                      {prediction.extrapolatedFeatureKeys.length > 0 ? (
                        <p className="mt-2 text-sm text-amber-700">
                          관측 범위를 벗어난 feature: {prediction.extrapolatedFeatureKeys.join(', ')}
                        </p>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Out-of-fold 결과</CardTitle>
                    <CardDescription>
                      동일 입력 조건이 학습·검증에 섞이지 않은 관측값, 예측값과 잔차입니다.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Measurement</TableHead>
                          <TableHead>Input</TableHead>
                          <TableHead>Fold</TableHead>
                          <TableHead>관측</TableHead>
                          <TableHead>예측</TableHead>
                          <TableHead>잔차</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {prediction.rows.slice(0, 100).map((row) => (
                          <TableRow key={row.measurementId}>
                            <TableCell>#{row.measurementId}</TableCell>
                            <TableCell className="max-w-44 truncate" title={row.inputFingerprint}>
                              {row.inputFingerprint}
                            </TableCell>
                            <TableCell>{row.fold + 1}</TableCell>
                            <TableCell>{formatNumber(row.observed)}</TableCell>
                            <TableCell>{formatNumber(row.predicted)}</TableCell>
                            <TableCell>{formatNumber(row.residual)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {prediction.rows.length > 100 ? (
                      <p className="mt-3 text-xs text-muted-foreground">
                        화면에는 앞의 100행만 표시합니다. 전체 결과는 Prediction CSV에서 확인할 수 있습니다.
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              </>
            ) : null}
          </TabsContent>

          <TabsContent className="space-y-4" value="data">
            <Card>
              <CardHeader>
                <CardTitle>Compact analysis data</CardTitle>
                <CardDescription>
                  Worker에서 현재 페이지 100행만 가져옵니다. raw tensor는 포함하지 않습니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {tablePage ? (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Measurement</TableHead>
                          <TableHead>Input</TableHead>
                          {tablePage.columns.map((column) => (
                            <TableHead key={column}>{column}</TableHead>
                          ))}
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
                              <TableCell key={tablePage.columns[index]}>{formatNumber(value ?? undefined)}</TableCell>
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
                  <p className="py-12 text-center text-sm text-muted-foreground">페이지를 준비하는 중입니다.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  )
}
