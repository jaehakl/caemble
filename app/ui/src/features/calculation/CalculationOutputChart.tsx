import { AlertCircle, LoaderCircle } from 'lucide-react'
import type {
  CalculationExecutionErrorCode,
  CalculationSourceDiagnostic,
  NormalizedCalculationOutput,
} from '@/lib/calculation/types'
import { Heatmap } from '@/features/viewer/viewer/Heatmap'
import { LineChart } from '@/features/viewer/viewer/RecordedDataResults'
import { buildScalarHistogram } from './calculationHistogram'

export type CalculationPreviewState =
  | Readonly<{ status: 'idle'; message: string }>
  | Readonly<{ status: 'loading'; message: string }>
  | Readonly<{
      status: 'error'
      code: CalculationExecutionErrorCode | 'input'
      message: string
      diagnostic?: CalculationSourceDiagnostic
    }>
  | Readonly<{ status: 'success'; output: NormalizedCalculationOutput }>

const errorTitles: Readonly<Record<CalculationExecutionErrorCode | 'input', string>> = Object.freeze({
  cancelled: '계산 취소됨',
  compile: 'Source compile 오류',
  input: 'RecordedData 입력 오류',
  'input-too-large': '입력 크기 제한 초과',
  'output-too-large': 'Output 크기 제한 초과',
  policy: '허용되지 않은 Source',
  runtime: '계산 실행 오류',
  timeout: '30초 실행 시간 초과',
})

function scalarText(value: number) {
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumSignificantDigits: 7 })
}

function ScalarHistogram({
  current,
  measurementId,
  values,
}: {
  current: number
  measurementId: number | null
  values: readonly number[]
}) {
  const histogram = buildScalarHistogram(values, current)
  if (!histogram) return null
  const left = 48
  const right = 620
  const bottom = 190
  const height = 145
  const width = right - left
  const x = (value: number) =>
    left + ((value - histogram.domainMin) / (histogram.domainMax - histogram.domainMin)) * width
  const markerX = left + histogram.markerRatio * width
  return (
    <div className="h-full min-h-0 overflow-auto" data-result-visualization="histogram">
      <svg
        aria-label="Calculation scalar output histogram"
        className="h-full min-h-56 w-full min-w-[420px]"
        role="img"
        viewBox="0 0 640 230"
      >
        <line className="stroke-slate-400" x1={left} x2={right} y1={bottom} y2={bottom} />
        {histogram.bins.map((bin, index) => {
          const start = x(bin.min)
          const end = x(bin.max)
          const barHeight = (bin.count / Math.max(1, histogram.maximumCount)) * height
          const barWidth = Math.max(3, end - start - 3)
          return (
            <rect
              className="fill-primary/70"
              height={barHeight}
              key={`${bin.min}-${bin.max}-${index}`}
              rx="2"
              width={barWidth}
              x={bin.min === bin.max ? Math.max(left, Math.min(right - 12, x(bin.min) - 6)) : start + 1.5}
              y={bottom - barHeight}
            >
              <title>{`${scalarText(bin.min)}–${scalarText(bin.max)}: ${bin.count.toLocaleString()} Measurements`}</title>
            </rect>
          )
        })}
        <line className="stroke-orange-600" strokeWidth="3" x1={markerX} x2={markerX} y1="25" y2={bottom} />
        <circle className="fill-orange-600" cx={markerX} cy="25" r="5" />
        <text
          className="fill-orange-700 font-medium"
          fontSize="11"
          textAnchor={markerX > 520 ? 'end' : markerX < 120 ? 'start' : 'middle'}
          x={markerX}
          y="15"
        >
          {measurementId === null ? 'Current' : `Measurement #${measurementId}`} · {scalarText(current)}
        </text>
        <text className="fill-muted-foreground" fontSize="11" textAnchor="start" x={left} y="211">
          {scalarText(histogram.domainMin)}
        </text>
        <text className="fill-muted-foreground" fontSize="11" textAnchor="end" x={right} y="211">
          {scalarText(histogram.domainMax)}
        </text>
      </svg>
    </div>
  )
}

export function CalculationOutputChart({
  comparisonMessage,
  measurementId = null,
  preview,
  scalarValues,
}: {
  comparisonMessage?: string
  measurementId?: number | null
  preview: CalculationPreviewState
  scalarValues?: readonly number[]
}) {
  if (preview.status === 'idle') {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
        {preview.message}
      </div>
    )
  }
  if (preview.status === 'loading') {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground" role="status">
        <span>
          <LoaderCircle className="mr-2 inline size-4 animate-spin" />
          {preview.message}
        </span>
      </div>
    )
  }
  if (preview.status === 'error') {
    const diagnostic = preview.code === 'policy' ? preview.diagnostic : undefined
    return (
      <div className="grid h-full place-items-center overflow-auto p-6 text-center">
        <div className="w-full max-w-xl text-sm text-destructive">
          <AlertCircle className="mx-auto size-7" />
          <p className="mt-3 font-semibold">{errorTitles[preview.code]}</p>
          {diagnostic ? (
            <>
              <p className="mt-2 text-xs font-medium">
                Line {diagnostic.range.startLineNumber}, Column {diagnostic.range.startColumn}
              </p>
              <p className="mt-1 text-xs leading-5">{diagnostic.message}</p>
              <pre className="mt-3 overflow-x-auto rounded border border-destructive/20 bg-destructive/5 p-3 text-left font-mono text-xs leading-5 text-foreground">
                <code>
                  {diagnostic.sourceLine}
                  {'\n'}
                  {' '.repeat(Math.max(0, diagnostic.range.startColumn - 1))}
                  {'^'.repeat(Math.max(1, diagnostic.range.endColumn - diagnostic.range.startColumn))}
                </code>
              </pre>
              <p className="mt-2 text-xs leading-5">동일한 상세 내용은 중앙 하단 Console에도 기록됩니다.</p>
            </>
          ) : (
            <p className="mt-1 text-xs leading-5">
              {preview.code === 'policy' ? preview.message : '상세 오류는 중앙 하단 Console에서 확인하세요.'}
            </p>
          )}
        </div>
      </div>
    )
  }

  const output = preview.output
  const data = typeof output.data === 'number' ? output.data : (output.data as readonly number[])
  const fillsHeatmapArea = output.shape.length === 2 && !output.shape.some((length) => length === 0)
  return (
    <div className={fillsHeatmapArea ? 'flex h-full min-h-0 flex-col overflow-hidden p-3' : 'h-full overflow-auto p-3'}>
      <header className="mb-3 flex shrink-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>rank {output.shape.length}</span>
        <span className="font-mono">
          {output.dtype} · {JSON.stringify(output.shape)}
        </span>
      </header>
      {output.shape.length === 0 ? (
        scalarValues?.length ? (
          <ScalarHistogram current={data as number} measurementId={measurementId} values={scalarValues} />
        ) : (
          <div className="space-y-3" data-result-visualization="scalar">
            <div
              aria-label="Calculation scalar output"
              className="flex min-h-40 items-center justify-center rounded border bg-slate-50 px-4 font-mono text-3xl text-slate-900"
            >
              {String(data)}
            </div>
            <p className="text-center text-xs text-muted-foreground">
              {comparisonMessage ?? '저장된 비교 데이터가 없습니다.'}
            </p>
          </div>
        )
      ) : output.shape.some((length) => length === 0) ? (
        <div
          className="grid min-h-56 place-items-center rounded border border-dashed bg-slate-50 p-4 text-center text-sm text-slate-500"
          data-result-visualization={output.shape.length === 1 ? 'line chart' : 'heatmap'}
        >
          Empty Output · shape {JSON.stringify(output.shape)}
        </div>
      ) : output.shape.length === 1 ? (
        <LineChart
          resultUnit={undefined}
          ticks={output.axes[0].ticks}
          values={data as readonly number[]}
          xTitle={`${output.axes[0].name} (${output.axes[0].unit ?? 'unitless'})`}
        />
      ) : (
        <div className="min-h-0 flex-1">
          <Heatmap
            columnTicks={output.axes[1].ticks}
            fillContainer
            getValue={(rowIndex, columnIndex) =>
              (data as readonly number[])[rowIndex * (output.shape[1] ?? 0) + columnIndex]
            }
            preserveTensorAspect
            resultUnit={undefined}
            rowTicks={output.axes[0].ticks}
            tickSignificantDigits={5}
            xTitle={`${output.axes[1].name} (${output.axes[1].unit ?? 'unitless'})`}
            yTitle={`${output.axes[0].name} (${output.axes[0].unit ?? 'unitless'})`}
          />
        </div>
      )}
    </div>
  )
}
