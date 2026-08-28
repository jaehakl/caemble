import { AlertCircle, LoaderCircle } from 'lucide-react'
import type {
  CalculationExecutionErrorCode,
  CalculationSourceDiagnostic,
  NormalizedCalculationOutput,
} from '@/lib/calculation/types'
import { Heatmap } from '@/features/viewer/viewer/Heatmap'
import { LineChart } from '@/features/viewer/viewer/RecordedDataResults'

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

export function CalculationOutputChart({ preview }: { preview: CalculationPreviewState }) {
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
        <div
          aria-label="Calculation scalar output"
          className="flex min-h-40 items-center justify-center rounded border bg-slate-50 px-4 font-mono text-3xl text-slate-900"
          data-result-visualization="scalar"
        >
          {String(data)}
        </div>
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
