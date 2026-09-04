import { AlertCircle, Calculator, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { AvailableExperimentRecord, CalculationDataOutput } from '@/api'
import { TensorEditor, type TensorEditorComparisonStatus } from '@/components/tensor-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { flattenVarsTensor, varsTensorFromFlat, type Tensor, type Vars, type VarsSchemaEntry } from '@/lib/cad/model'
import { VarsPanel } from '../calculation/VarsPanel'
import type {
  PredictionCohortExclusionReason,
  PredictionCohortSummary,
  PredictionDirection,
  PredictionNeighbor,
  PredictionWeighting,
} from './knn'
import { comparePredictionOutput, predictionOutputRange, type PredictionValidationMetric } from './metrics'
import type { PredictionWorkerModelProfile } from './protocol'
import type { PredictionSamplingRange } from './sampling'

export type PredictionVarsSchema = Readonly<Record<string, VarsSchemaEntry>>

const directionLabels: Readonly<Record<PredictionDirection, string>> = {
  forward: 'Forward · 입력 vars',
  inverse: 'Inverse · 예측 vars',
}

export type PredictionVarsPaneProps = Readonly<{
  candidateSessionKey: string
  currentExperimentId: number | null
  demos: readonly AvailableExperimentRecord[]
  direction: PredictionDirection
  disabled: boolean
  guideVisible: boolean
  isDemo: boolean
  manageable: boolean
  loadingExperiments: boolean
  mine: readonly AvailableExperimentRecord[]
  schema: PredictionVarsSchema | null
  samplingRanges: Readonly<Record<string, PredictionSamplingRange>>
  resetValues: Readonly<Record<string, Tensor | undefined>>
  status: string
  updating: boolean
  vars: Readonly<Vars> | null
  onDismissGuide: () => void
  onExperimentChange: (experimentId: number) => void
  onSamplingRangeChange: (key: string, range: PredictionSamplingRange) => void
  onVariableChange: (key: string, value: Tensor) => void
}>

export function PredictionVarsPane({
  candidateSessionKey,
  currentExperimentId,
  demos,
  direction,
  disabled,
  guideVisible,
  isDemo,
  manageable,
  loadingExperiments,
  mine,
  schema,
  samplingRanges,
  resetValues,
  status,
  updating,
  vars,
  onDismissGuide,
  onExperimentChange,
  onSamplingRangeChange,
  onVariableChange,
}: PredictionVarsPaneProps) {
  const currentExperiment = [...mine, ...demos].find((experiment) => experiment.id === currentExperimentId)
  return (
    <section className="flex h-full min-h-0 flex-col gap-2" aria-label="Prediction vars">
      <div className="rounded-lg border bg-card p-2.5">
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor="prediction-experiment">
          Experiment
        </label>
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          disabled={loadingExperiments}
          id="prediction-experiment"
          value={currentExperimentId ?? ''}
          onChange={(event) => onExperimentChange(Number(event.target.value))}
        >
          {currentExperimentId === null ? <option value="">선택하세요</option> : null}
          {mine.length ? (
            <optgroup label="내 Experiment">
              {mine.map((experiment) => (
                <option key={experiment.id} value={experiment.id}>
                  {experiment.isDemo ? '(Demo) ' : ''}
                  {experiment.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {demos.length ? (
            <optgroup label="Demo">
              {demos
                .filter((experiment) => !mine.some((owned) => owned.id === experiment.id))
                .map((experiment) => (
                  <option key={experiment.id} value={experiment.id}>
                    {experiment.demoDefault ? '★ ' : ''}
                    {experiment.name}
                  </option>
                ))}
            </optgroup>
          ) : null}
        </select>
        {isDemo ? (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge>Demo</Badge>
            <Badge className="border bg-transparent text-foreground">
              {manageable ? '관리자 편집 가능' : '읽기 전용'}
            </Badge>
            {currentExperiment && !currentExperiment.predictionReady ? (
              <Badge className="bg-destructive text-white">Not Ready</Badge>
            ) : null}
            <span>
              {manageable
                ? '저장 작업은 현재 공개 데이터에 즉시 반영됩니다.'
                : '브라우저 Prediction은 자유롭게 체험할 수 있습니다.'}
            </span>
          </div>
        ) : null}
      </div>
      {guideVisible ? (
        <div className="relative rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 pr-9 text-xs leading-5">
          <strong>1.</strong> Vars를 바꿔 Forward 결과를 확인하세요. <strong>2.</strong> 오른쪽 결과를 Target으로 움직여
          Inverse Design과 Viewer 형상 변화를 확인하세요.
          <Button
            aria-label="Prediction 안내 닫기"
            className="absolute top-1 right-1 size-7"
            size="icon"
            variant="ghost"
            onClick={onDismissGuide}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <header className="flex flex-wrap items-start justify-between gap-2 rounded-lg border bg-card px-3 py-2.5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Vars</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={status}>
            {status}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {updating ? (
            <Badge className="gap-1 bg-muted text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" /> Updating…
            </Badge>
          ) : null}
          <Badge>{directionLabels[direction]}</Badge>
        </div>
      </header>
      <div className={`flex min-h-0 flex-1 flex-col transition-opacity ${updating ? 'opacity-60' : ''}`}>
        <VarsPanel
          candidateSessionKey={candidateSessionKey}
          disabled={disabled}
          expandFirstByDefault
          schema={schema}
          samplingRanges={samplingRanges}
          resetValues={resetValues}
          vars={vars}
          onSamplingRangeChange={onSamplingRangeChange}
          onVariableChange={onVariableChange}
        />
      </div>
    </section>
  )
}

export type PredictionCalculationPaneMode = 'calculation' | 'prediction' | 'target'

const calculationModeLabels: Readonly<Record<PredictionCalculationPaneMode, string>> = {
  calculation: '직접 계산',
  prediction: '모델 예측',
  target: 'Target 조작',
}

export type PredictionCalculationSeries = Readonly<{
  error?: string | null
  metric?: PredictionValidationMetric | null
  output: CalculationDataOutput | null
  snapshotKey?: string | null
  status: TensorEditorComparisonStatus
}>

export type PredictionCalculationPaneItem = Readonly<{
  actual: PredictionCalculationSeries
  calculationId: number
  constraintMaximum: number
  constraintMinimum: number
  error?: string | null
  extrapolated?: boolean
  maximum: number
  minimum: number
  name: string
  primary: Readonly<{
    output: CalculationDataOutput | null
    role: 'predicted' | 'target'
    status: 'ready' | 'updating' | 'unavailable'
  }>
  repredicted?: PredictionCalculationSeries
}>

const calculationSeriesStyle = Object.freeze({
  predicted: { color: '#2563eb', label: 'Predicted' },
  target: { color: '#f97316', label: 'Target' },
  repredicted: { color: '#7c3aed', label: 'Re-predicted', lineDash: [7, 4] as const },
  actual: { color: '#059669', label: 'Save + Run Actual', lineDash: [3, 3] as const },
})

function metricSummary(metric: PredictionValidationMetric | null | undefined) {
  if (!metric) return null
  if (!metric.compatible) return metric.message ?? '호환되지 않는 CalculationData입니다.'
  return metric.relativeError === null
    ? `MAE ${formatMetric(metric.mae ?? Number.NaN)} · RMSE ${formatMetric(metric.rmse ?? Number.NaN)} · Max ${formatMetric(metric.maxAbsoluteError ?? Number.NaN)}`
    : `Abs ${formatMetric(metric.maxAbsoluteError ?? Number.NaN)} · Rel ${formatMetric(metric.relativeError * 100)}%`
}

export type PredictionCalculationPaneProps = Readonly<{
  disabled: boolean
  items: readonly PredictionCalculationPaneItem[]
  mode: PredictionCalculationPaneMode
  resetKey: string | number
  status: string
  updating: boolean
  onOutputChange: (calculationId: number, output: CalculationDataOutput) => void
}>

export function PredictionCalculationPane({
  disabled,
  items,
  mode,
  resetKey,
  status,
  updating,
  onOutputChange,
}: PredictionCalculationPaneProps) {
  return (
    <section className="flex h-full min-h-0 flex-col gap-2" aria-label="Prediction calculation data">
      <header className="flex flex-wrap items-start justify-between gap-2 rounded-lg border bg-card px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Calculation Data</h3>
            <Badge>{calculationModeLabels[mode]}</Badge>
            {updating ? (
              <Badge className="gap-1 bg-muted text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" /> Updating…
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={status}>
            {status}
          </p>
        </div>
      </header>

      <div
        className={`min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 transition-opacity ${updating ? 'opacity-60' : ''}`}
      >
        {items.length === 0 ? (
          <div className="grid min-h-32 place-items-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            선택된 Calculation이 없습니다.
          </div>
        ) : (
          items.map((item) => {
            const output = item.primary.output
            const outputValues = output
              ? output.shape.length === 0
                ? [output.data as number]
                : (output.data as readonly number[])
              : null
            return (
              <Card key={item.calculationId}>
                <CardHeader className="gap-2 p-4 pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-sm" title={item.name}>
                        {item.name}
                      </CardTitle>
                      <CardDescription className="mt-1 text-xs">Calculation #{item.calculationId}</CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {item.extrapolated ? (
                        <Badge className="text-destructive-foreground bg-destructive">Extrapolation</Badge>
                      ) : null}
                      {item.repredicted?.status === 'ready' ? (
                        <Badge className="bg-violet-100 text-violet-900">Re-predicted</Badge>
                      ) : null}
                      {item.actual.status === 'ready' ? (
                        <Badge className="bg-emerald-100 text-emerald-900">Actual</Badge>
                      ) : null}
                      {output ? (
                        <Badge>
                          {output.dtype} · {output.shape.length === 0 ? 'scalar' : JSON.stringify(output.shape)}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {item.error ? (
                    <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                      <span className="break-words">{item.error}</span>
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  {output ? (
                    <div className="space-y-2">
                      <TensorEditor
                        axes={output.axes}
                        comparison={{
                          primaryColor: calculationSeriesStyle[item.primary.role].color,
                          primaryLabel: calculationSeriesStyle[item.primary.role].label,
                          series: [
                            ...(item.repredicted
                              ? [
                                  {
                                    ...calculationSeriesStyle.repredicted,
                                    id: 'repredicted',
                                    message: item.repredicted.error,
                                    status: item.repredicted.status,
                                    value:
                                      item.repredicted.status === 'ready' && item.repredicted.output
                                        ? varsTensorFromFlat(
                                            item.repredicted.output.shape.length === 0
                                              ? [item.repredicted.output.data as number]
                                              : (item.repredicted.output.data as readonly number[]),
                                            item.repredicted.output.shape,
                                          )
                                        : null,
                                  },
                                ]
                              : []),
                            {
                              ...calculationSeriesStyle.actual,
                              id: 'actual',
                              message: item.actual.error,
                              status: item.actual.status,
                              value:
                                item.actual.status === 'ready' && item.actual.output
                                  ? varsTensorFromFlat(
                                      item.actual.output.shape.length === 0
                                        ? [item.actual.output.data as number]
                                        : (item.actual.output.data as readonly number[]),
                                      item.actual.output.shape,
                                    )
                                  : null,
                            },
                          ],
                        }}
                        constraintMaximum={item.constraintMaximum}
                        constraintMinimum={item.constraintMinimum}
                        disabled={disabled || item.primary.status !== 'ready'}
                        key={`${item.calculationId}:${output.dtype}:${JSON.stringify(output.shape)}`}
                        label={item.name}
                        maximum={item.maximum}
                        minimum={item.minimum}
                        displayDomainResetKey={`${resetKey}:${item.calculationId}`}
                        selectionResetKey={`${resetKey}:${item.calculationId}`}
                        shape={output.shape}
                        value={varsTensorFromFlat(outputValues!, output.shape)}
                        onValueChange={(value) => {
                          const flat = flattenVarsTensor(value, output.shape, item.name)
                          const next = /^u?int/u.test(output.dtype) ? flat.map((member) => Math.round(member)) : flat
                          onOutputChange(item.calculationId, {
                            ...output,
                            data: output.shape.length === 0 ? next[0] : next,
                          })
                        }}
                      />
                      {item.repredicted?.metric ? (
                        <p className="rounded-md border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
                          Target ↔ Re-predicted · {metricSummary(item.repredicted.metric)}
                        </p>
                      ) : null}
                      {item.actual.metric ? (
                        <p className="rounded-md border border-sky-300/70 bg-sky-50 px-2 py-1.5 text-xs text-sky-950">
                          {item.primary.role === 'predicted' ? 'Predicted' : 'Target'} ↔ Actual ·{' '}
                          {metricSummary(item.actual.metric)}
                        </p>
                      ) : null}
                      {item.repredicted?.error && !item.repredicted.metric ? (
                        <p className="rounded-md border border-violet-300/70 bg-violet-50 px-2 py-1.5 text-xs text-violet-950">
                          Re-predicted · {item.repredicted.error}
                        </p>
                      ) : null}
                      {item.actual.error && !item.actual.metric ? (
                        <p className="rounded-md border border-emerald-300/70 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-950">
                          Save + Run Actual · {item.actual.error}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="grid min-h-24 place-items-center rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                      편집할 CalculationData output이 없습니다.
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
    </section>
  )
}

export type PredictionKMode = 'auto' | 'manual'
export type PredictionSetupBusyAction = 'apply' | 'calculate-missing' | 'reload' | null

export type PredictionSetupCalculation = Readonly<{
  description?: string | null
  dependencyNames?: readonly string[]
  disabled?: boolean
  disabledReason?: string
  id: number
  missingCount?: number
  name: string
}>

export type PredictionSetupDialogProps = Readonly<{
  applyDisabled?: boolean
  autoK?: number | null
  busyAction?: PredictionSetupBusyAction
  calculateMissingDisabled?: boolean
  calculateMissingLabel?: string
  calculationWeights: Readonly<Record<number, number>>
  calculations: readonly PredictionSetupCalculation[]
  cohortSummaries: Partial<Record<PredictionDirection, PredictionCohortSummary>>
  kMode: PredictionKMode
  manualK: number
  manualKMaximum?: number
  open: boolean
  reloadDisabled?: boolean
  selectedCalculationIds: readonly number[]
  weighting: PredictionWeighting
  validationMessage?: string | null
  onApply: () => void
  onCalculateMissing: () => void
  onCalculationSelectedChange: (calculationId: number, selected: boolean) => void
  onCalculationWeightChange: (calculationId: number, weight: number) => void
  onCancel: () => void
  onKModeChange: (mode: PredictionKMode) => void
  onManualKChange: (k: number) => void
  onOpenChange: (open: boolean) => void
  onReload: () => void
  onWeightingChange: (weighting: PredictionWeighting) => void
}>

const exclusionLabels: Readonly<Record<PredictionCohortExclusionReason, string>> = {
  'extra-block': '예상하지 않은 데이터 블록',
  'fixed-layout-mismatch': '현재 schema shape 불일치',
  'invalid-tensor': '유효하지 않은 tensor',
  'layout-mismatch': 'dominant cohort shape 불일치',
  'missing-block': '필수 데이터 누락',
}

export function PredictionSetupDialog({
  applyDisabled = false,
  autoK,
  busyAction = null,
  calculateMissingDisabled = false,
  calculateMissingLabel = '누락 데이터 계산',
  calculationWeights,
  calculations,
  cohortSummaries,
  kMode,
  manualK,
  manualKMaximum,
  open,
  reloadDisabled = false,
  selectedCalculationIds,
  weighting,
  validationMessage,
  onApply,
  onCalculateMissing,
  onCalculationSelectedChange,
  onCalculationWeightChange,
  onCancel,
  onKModeChange,
  onManualKChange,
  onOpenChange,
  onReload,
  onWeightingChange,
}: PredictionSetupDialogProps) {
  const busy = busyAction !== null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(920px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>Prediction 설정</DialogTitle>
          <DialogDescription>
            사용할 Calculation과 k-Nearest Neighbor 가중 방식을 선택합니다. 설정 적용 전까지 모델은 변경되지 않습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
          <section className="space-y-3" aria-labelledby="prediction-calculations-heading">
            <div>
              <h3 className="text-sm font-semibold" id="prediction-calculations-heading">
                Calculations
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                여러 Calculation을 동시에 선택할 수 있으며, 각 입력 블록의 거리에 별도 weight를 적용할 수 있습니다.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {calculations.map((calculation) => {
                const selected = selectedCalculationIds.includes(calculation.id)
                return (
                  <Card className={calculation.disabled ? 'opacity-60' : undefined} key={calculation.id}>
                    <CardContent className="space-y-3 p-3">
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          checked={selected}
                          className="mt-0.5 size-4 accent-primary"
                          disabled={busy || calculation.disabled}
                          type="checkbox"
                          onChange={(event) => onCalculationSelectedChange(calculation.id, event.target.checked)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium" title={calculation.name}>
                            {calculation.name}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            Calculation #{calculation.id}
                            {calculation.missingCount === undefined
                              ? ''
                              : ` · 미계산 ${calculation.missingCount.toLocaleString()}건`}
                          </span>
                          {calculation.description ? (
                            <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                              {calculation.description}
                            </span>
                          ) : null}
                          {calculation.dependencyNames?.length ? (
                            <span className="mt-1 block text-[11px] text-muted-foreground">
                              Records · {calculation.dependencyNames.join(', ')}
                            </span>
                          ) : null}
                          {calculation.disabledReason ? (
                            <span className="mt-1 block text-xs text-amber-700">{calculation.disabledReason}</span>
                          ) : null}
                        </span>
                      </label>
                      <label className="block text-xs font-medium">
                        <span className="mb-1 block text-muted-foreground">거리 weight</span>
                        <Input
                          aria-label={`${calculation.name} weight`}
                          aria-invalid={
                            !Number.isFinite(calculationWeights[calculation.id] ?? 1) ||
                            (calculationWeights[calculation.id] ?? 1) < 0
                          }
                          disabled={busy || !selected || calculation.disabled}
                          min="0"
                          step="0.1"
                          type="number"
                          value={calculationWeights[calculation.id] ?? 1}
                          onChange={(event) => onCalculationWeightChange(calculation.id, Number(event.target.value))}
                        />
                      </label>
                    </CardContent>
                  </Card>
                )
              })}
              {calculations.length === 0 ? (
                <div className="col-span-full rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  선택할 수 있는 Calculation이 없습니다.
                </div>
              ) : null}
            </div>
          </section>

          <section className="grid gap-3 md:grid-cols-2" aria-label="kNN 설정">
            <Card>
              <CardHeader className="p-4 pb-3">
                <CardTitle className="text-sm">Neighbor 수</CardTitle>
                <CardDescription className="text-xs">Auto는 cohort 크기에 따라 k를 조정합니다.</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-[minmax(0,1fr)_120px] gap-2 p-4 pt-0">
                <Select
                  disabled={busy}
                  value={kMode}
                  onValueChange={(value) => onKModeChange(value as PredictionKMode)}
                >
                  <SelectTrigger aria-label="k 선택 방식">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto{autoK ? ` · k=${autoK}` : ''}</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  aria-label="Manual k"
                  aria-invalid={
                    !Number.isSafeInteger(manualK) ||
                    manualK < 1 ||
                    (manualKMaximum !== undefined && manualK > manualKMaximum)
                  }
                  disabled={busy || kMode !== 'manual'}
                  max={manualKMaximum}
                  min="1"
                  step="1"
                  type="number"
                  value={manualK}
                  onChange={(event) => onManualKChange(Number(event.target.value))}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-4 pb-3">
                <CardTitle className="text-sm">Neighbor weighting</CardTitle>
                <CardDescription className="text-xs">동일 평균 또는 거리 역가중 평균을 사용합니다.</CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <Select
                  disabled={busy}
                  value={weighting}
                  onValueChange={(value) => onWeightingChange(value as PredictionWeighting)}
                >
                  <SelectTrigger aria-label="Neighbor weighting">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="distance">Distance · 가까운 이웃 우선</SelectItem>
                    <SelectItem value="uniform">Uniform · 동일 weight</SelectItem>
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
          </section>

          <section className="space-y-3" aria-labelledby="prediction-cohort-summary-heading">
            <div>
              <h3 className="text-sm font-semibold" id="prediction-cohort-summary-heading">
                방향별 Cohort
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Forward는 ExperimentRecord별 독립 shape cohort, Inverse는 저장 Output 계약을 사용합니다.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {(['forward', 'inverse'] as const).map((cohortDirection) => {
                const summary = cohortSummaries[cohortDirection]
                const excludedRows = summary
                  ? Object.values(summary.excluded).reduce((total, count) => total + count, 0)
                  : 0
                return (
                  <Card key={cohortDirection}>
                    <CardHeader className="p-4 pb-3">
                      <CardTitle className="text-sm capitalize">{cohortDirection}</CardTitle>
                      <CardDescription className="text-xs">
                        {summary
                          ? `shape baseline · Measurement #${summary.baselineMeasurementId}`
                          : '아직 모델을 만들지 않았습니다.'}
                      </CardDescription>
                      {summary ? (
                        <p
                          className="truncate font-mono text-[10px] text-muted-foreground"
                          title={summary.dominantShapeSignature}
                        >
                          {summary.dominantShapeSignature}
                        </p>
                      ) : null}
                    </CardHeader>
                    <CardContent className="space-y-3 p-4 pt-0">
                      {summary ? (
                        <>
                          <div className="grid grid-cols-4 gap-1 text-center">
                            {[
                              ['전체', summary.totalRows],
                              ['포함', summary.includedRows],
                              ['제외', excludedRows],
                              ['경고', summary.warningMeasurementIds.length],
                            ].map(([label, count]) => (
                              <div className="rounded-md border bg-muted/20 p-1.5" key={label}>
                                <p className="font-semibold tabular-nums">{Number(count).toLocaleString()}</p>
                                <p className="text-[10px] text-muted-foreground">{label}</p>
                              </div>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {(Object.entries(summary.excluded) as readonly [PredictionCohortExclusionReason, number][])
                              .filter(([, count]) => count > 0)
                              .map(([reason, count]) => (
                                <Badge key={reason}>
                                  {exclusionLabels[reason]} {count.toLocaleString()}
                                </Badge>
                              ))}
                            {summary.warningMeasurementIds.length ? (
                              <Badge>metadata 경고 {summary.warningMeasurementIds.length.toLocaleString()}</Badge>
                            ) : null}
                            {excludedRows === 0 && summary.warningMeasurementIds.length === 0 ? (
                              <span className="text-xs text-muted-foreground">제외·경고가 없습니다.</span>
                            ) : null}
                          </div>
                        </>
                      ) : (
                        <p className="py-4 text-center text-xs text-muted-foreground">
                          해당 방향을 실행하면 표시됩니다.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </section>
          {validationMessage ? (
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <span>{validationMessage}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter className="flex-row flex-wrap justify-between border-t px-6 py-4 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || reloadDisabled} type="button" variant="outline" onClick={onReload}>
              {busyAction === 'reload' ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              새로고침
            </Button>
            <Button
              disabled={busy || calculateMissingDisabled}
              type="button"
              variant="outline"
              onClick={onCalculateMissing}
            >
              {busyAction === 'calculate-missing' ? <LoaderCircle className="animate-spin" /> : <Calculator />}
              {calculateMissingLabel}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button disabled={busy} type="button" variant="outline" onClick={onCancel}>
              취소
            </Button>
            <Button disabled={busy || applyDisabled} type="button" onClick={onApply}>
              {busyAction === 'apply' ? <LoaderCircle className="animate-spin" /> : null}
              적용
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type PredictionDetailsDialogProps = Readonly<{
  direction: PredictionDirection
  exclusions?: Readonly<Record<string, number>>
  neighbors: readonly PredictionNeighbor[]
  open: boolean
  profiles: Partial<Record<PredictionDirection, PredictionWorkerModelProfile>>
  forwardRecordProfiles?: readonly Readonly<{
    error: string | null
    name: string
    profile: PredictionWorkerModelProfile | null
    recordId: number
  }>[]
  resultText?: string | null
  retryCalculationsDisabled?: boolean
  retryingCalculations?: boolean
  validationComparisons?: readonly PredictionValidationComparison[]
  validationText?: string | null
  onDirectionChange: (direction: PredictionDirection) => void
  onOpenChange: (open: boolean) => void
  onRetryCalculations?: () => void
}>

export type PredictionValidationComparison = Readonly<{
  actual: CalculationDataOutput | null
  calculationId: number
  direction: PredictionDirection
  error: string | null
  metric: PredictionValidationMetric | null
  name: string
  repredicted: CalculationDataOutput | null
  reference: CalculationDataOutput
}>

function formatMetric(value: number) {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if ((absolute > 0 && absolute < 0.001) || absolute >= 1_000_000) return value.toExponential(3)
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 5 }).format(value)
}

function PredictionValidationComparisonCard({ comparison }: { comparison: PredictionValidationComparison }) {
  const { actual, direction, error, metric, reference, repredicted } = comparison
  const repredictedMetric = repredicted ? comparePredictionOutput(reference, repredicted) : null
  const repredictedActualMetric = repredicted && actual ? comparePredictionOutput(repredicted, actual) : null
  const compatibleRepredicted = repredictedMetric?.compatible ? repredicted : null
  const compatibleActual = !error && metric?.compatible ? actual : null
  const [minimum, maximum] = predictionOutputRange([reference, compatibleRepredicted, compatibleActual])
  const referenceValues =
    reference.shape.length === 0 ? [reference.data as number] : (reference.data as readonly number[])
  const metricRows = [
    ...(direction === 'inverse'
      ? ([
          ['Target ↔ Re-predicted', repredictedMetric],
          ['Target ↔ Actual', metric],
          ['Re-predicted ↔ Actual', repredictedActualMetric],
        ] as const)
      : ([['Predicted ↔ Actual', metric]] as const)),
  ]

  return (
    <Card>
      <CardHeader className="gap-2 p-4 pb-3">
        <CardTitle className="text-sm">{comparison.name}</CardTitle>
        <CardDescription className="text-xs">
          Calculation #{comparison.calculationId} · {reference.dtype} ·{' '}
          {reference.shape.length === 0 ? 'scalar' : JSON.stringify(reference.shape)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <TensorEditor
          axes={reference.axes}
          comparison={{
            primaryColor: calculationSeriesStyle[direction === 'forward' ? 'predicted' : 'target'].color,
            primaryLabel: calculationSeriesStyle[direction === 'forward' ? 'predicted' : 'target'].label,
            series: [
              ...(direction === 'inverse'
                ? [
                    {
                      ...calculationSeriesStyle.repredicted,
                      id: 'repredicted',
                      message: repredictedMetric?.message,
                      status: repredicted
                        ? repredictedMetric?.compatible
                          ? ('ready' as const)
                          : ('incompatible' as const)
                        : ('unavailable' as const),
                      value: compatibleRepredicted
                        ? varsTensorFromFlat(
                            compatibleRepredicted.shape.length === 0
                              ? [compatibleRepredicted.data as number]
                              : (compatibleRepredicted.data as readonly number[]),
                            compatibleRepredicted.shape,
                          )
                        : null,
                    },
                  ]
                : []),
              {
                ...calculationSeriesStyle.actual,
                id: 'actual',
                message: error ?? metric?.message,
                status: compatibleActual ? 'ready' : actual && !error ? 'incompatible' : 'unavailable',
                value: compatibleActual
                  ? varsTensorFromFlat(
                      compatibleActual.shape.length === 0
                        ? [compatibleActual.data as number]
                        : (compatibleActual.data as readonly number[]),
                      compatibleActual.shape,
                    )
                  : null,
              },
            ],
          }}
          disabled
          label={`${comparison.name} validation comparison`}
          maximum={maximum}
          minimum={minimum}
          shape={reference.shape}
          value={varsTensorFromFlat(referenceValues, reference.shape)}
          onValueChange={() => undefined}
        />
        <div className="grid gap-2 sm:grid-cols-3">
          {metricRows.map(([label, pairMetric]) => (
            <div className="rounded-md border bg-muted/20 p-2" key={label}>
              <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
              <p className="mt-1 text-xs tabular-nums">
                {metricSummary(pairMetric) ?? (label.includes('Actual') && error ? error : '비교 데이터가 없습니다.')}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function PredictionDetailsDialog({
  direction,
  exclusions,
  forwardRecordProfiles = [],
  neighbors,
  open,
  profiles,
  resultText,
  retryCalculationsDisabled = false,
  retryingCalculations = false,
  validationComparisons = [],
  validationText,
  onDirectionChange,
  onOpenChange,
  onRetryCalculations,
}: PredictionDetailsDialogProps) {
  const profile = profiles[direction] ?? null
  const resolvedExclusions: Readonly<Record<string, number>> = exclusions ?? profile?.excluded ?? {}
  const visibleExclusions = Object.entries(resolvedExclusions).filter(([, count]) => count > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(860px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Prediction 세부 정보</DialogTitle>
          <DialogDescription>
            방향별 모델 profile, 실제 사용한 이웃과 Record별 cohort shape 진단을 확인합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <Select value={direction} onValueChange={(value) => onDirectionChange(value as PredictionDirection)}>
            <SelectTrigger aria-label="진단 방향" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="forward">Forward 진단</SelectItem>
              <SelectItem value="inverse">Inverse 진단</SelectItem>
            </SelectContent>
          </Select>
          {direction === 'forward' && forwardRecordProfiles.length ? (
            <Card>
              <CardHeader className="p-4 pb-3">
                <CardTitle className="text-sm">ExperimentRecord별 Forward 모델</CardTitle>
                <CardDescription className="text-xs">
                  각 Record의 shape 불일치는 이 행의 cohort에만 영향을 줍니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Record</TableHead>
                      <TableHead>Cohort / k</TableHead>
                      <TableHead>Dominant shape</TableHead>
                      <TableHead>제외</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forwardRecordProfiles.map((record) => (
                      <TableRow key={record.recordId}>
                        <TableCell>
                          <p className="font-medium">{record.name}</p>
                          <p className="text-[10px] text-muted-foreground">ExperimentRecord #{record.recordId}</p>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {record.profile ? `${record.profile.rowCount} / ${record.profile.k}` : '—'}
                        </TableCell>
                        <TableCell
                          className="max-w-64 truncate font-mono text-[10px]"
                          title={record.error ?? record.profile?.dominantShapeSignature}
                        >
                          {record.error ?? record.profile?.dominantShapeSignature ?? '모델 없음'}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {record.profile
                            ? Object.values(record.profile.excluded)
                                .reduce((total, count) => total + count, 0)
                                .toLocaleString()
                            : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
          {profile ? (
            <section className="space-y-2" aria-label="Prediction model profile">
              <p
                className="truncate rounded-md border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground"
                title={profile.dominantShapeSignature}
              >
                Shape baseline · Measurement #{profile.baselineMeasurementId} · {profile.dominantShapeSignature}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Direction</p>
                  <p className="mt-1 font-semibold">{profile.direction === 'forward' ? 'Forward' : 'Inverse'}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Cohort / k</p>
                  <p className="mt-1 font-semibold tabular-nums">
                    {profile.rowCount.toLocaleString()} / {profile.k.toLocaleString()}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Weighting</p>
                  <p className="mt-1 font-semibold capitalize">{profile.weighting}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Scaling</p>
                  <p className="mt-1 font-semibold">{profile.inputScaling}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Input size</p>
                  <p className="mt-1 font-semibold tabular-nums">{profile.inputSize.toLocaleString()}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Output size</p>
                  <p className="mt-1 font-semibold tabular-nums">{profile.outputSize.toLocaleString()}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Persistent memory</p>
                  <p className="mt-1 font-semibold tabular-nums">{profile.persistentBytes.toLocaleString()} B</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Working set</p>
                  <p className="mt-1 font-semibold tabular-nums">{profile.workingSetBytes.toLocaleString()} B</p>
                </div>
              </div>
            </section>
          ) : (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              준비된 모델 profile이 없습니다.
            </div>
          )}

          <Card>
            <CardHeader className="p-4 pb-3">
              <CardTitle className="text-sm">Neighbors</CardTitle>
              <CardDescription className="text-xs">
                현재 예측에 실제 사용된 Measurement와 정규화 weight입니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              {neighbors.length ? (
                <Table containerClassName="max-h-60 overflow-auto">
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead>Measurement</TableHead>
                      <TableHead>Distance²</TableHead>
                      <TableHead>Weight</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {neighbors.map((neighbor) => (
                      <TableRow key={neighbor.measurementId}>
                        <TableCell>#{neighbor.measurementId}</TableCell>
                        <TableCell className="tabular-nums">{formatMetric(neighbor.distanceSquared)}</TableCell>
                        <TableCell className="tabular-nums">{formatMetric(neighbor.weight)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">표시할 neighbor가 없습니다.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-3">
              <CardTitle className="text-sm">Cohort diagnostics</CardTitle>
              <CardDescription className="text-xs">
                shape 불일치는 제외되며 metadata 불일치는 cell index 기준으로 포함됩니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4 pt-0">
              {visibleExclusions.length ? (
                <div className="flex flex-wrap gap-2">
                  {visibleExclusions.map(([reason, count]) => (
                    <Badge key={reason}>
                      {reason} · {count.toLocaleString()}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">제외된 Measurement가 없습니다.</p>
              )}
              {profile?.diagnostics.length ? (
                <Table containerClassName="max-h-96 overflow-auto rounded border">
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead>처리</TableHead>
                      <TableHead>Measurement</TableHead>
                      <TableHead>Block / field</TableHead>
                      <TableHead>차이</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profile.diagnostics.map((diagnostic, index) => (
                      <TableRow
                        key={`${diagnostic.disposition}:${diagnostic.blockKey}:${diagnostic.fieldPath}:${index}`}
                      >
                        <TableCell>
                          <Badge>
                            {diagnostic.disposition === 'excluded'
                              ? `제외 · ${exclusionLabels[diagnostic.reason as PredictionCohortExclusionReason]}`
                              : '경고·포함 · metadata'}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-48 text-xs">
                          {diagnostic.measurementIds.map((id) => `#${id}`).join(', ')}
                        </TableCell>
                        <TableCell className="text-xs">
                          <span className="block font-medium">
                            {diagnostic.side} · {diagnostic.blockKey}
                          </span>
                          <span className="font-mono text-muted-foreground">{diagnostic.fieldPath}</span>
                        </TableCell>
                        <TableCell className="max-w-80 text-xs">
                          <details>
                            <summary className="cursor-pointer truncate">
                              {diagnostic.expected} → {diagnostic.actual}
                            </summary>
                            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 break-all">
                              <dt className="text-muted-foreground">Baseline</dt>
                              <dd>
                                {diagnostic.baselineMeasurementId
                                  ? `Measurement #${diagnostic.baselineMeasurementId}`
                                  : '현재 계약'}
                              </dd>
                              <dt className="text-muted-foreground">Expected</dt>
                              <dd className="font-mono">{diagnostic.expected}</dd>
                              <dt className="text-muted-foreground">Actual</dt>
                              <dd className="font-mono">{diagnostic.actual}</dd>
                              {diagnostic.mismatchCount !== undefined ? (
                                <>
                                  <dt className="text-muted-foreground">Mismatch</dt>
                                  <dd>{diagnostic.mismatchCount.toLocaleString()} cells</dd>
                                </>
                              ) : null}
                              {diagnostic.firstMismatchIndex !== undefined ? (
                                <>
                                  <dt className="text-muted-foreground">First index</dt>
                                  <dd>{diagnostic.firstMismatchIndex.toLocaleString()}</dd>
                                </>
                              ) : null}
                              {diagnostic.maxAbsoluteDifference !== undefined ? (
                                <>
                                  <dt className="text-muted-foreground">Max Δ</dt>
                                  <dd>{formatMetric(diagnostic.maxAbsoluteDifference)}</dd>
                                </>
                              ) : null}
                            </dl>
                          </details>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : profile ? (
                <p className="text-sm text-muted-foreground">layout 차이가 없습니다.</p>
              ) : null}
              {profile?.omittedDiagnosticGroups ? (
                <p className="text-xs text-amber-700">
                  진단 한도로 {profile.omittedDiagnosticGroups.toLocaleString()}개 그룹을 생략했습니다.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {validationText ? (
            <Card>
              <CardHeader className="p-4 pb-3">
                <CardTitle className="text-sm">Validation</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-sm leading-6 whitespace-pre-wrap">{validationText}</CardContent>
            </Card>
          ) : null}
          {validationComparisons.length ? (
            <section className="space-y-3" aria-label="Validation comparison views">
              {validationComparisons.map((comparison) => (
                <PredictionValidationComparisonCard comparison={comparison} key={comparison.calculationId} />
              ))}
            </section>
          ) : null}
          {resultText ? (
            <Card>
              <CardHeader className="p-4 pb-3">
                <CardTitle className="text-sm">Result</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-sm leading-6 whitespace-pre-wrap">{resultText}</CardContent>
            </Card>
          ) : null}
        </div>

        <DialogFooter>
          {onRetryCalculations ? (
            <Button
              disabled={retryCalculationsDisabled || retryingCalculations}
              type="button"
              variant="outline"
              onClick={onRetryCalculations}
            >
              {retryingCalculations ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              Calculation 재시도
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
