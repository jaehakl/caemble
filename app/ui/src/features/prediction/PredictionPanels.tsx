import { TensorEditor } from '@/components/tensor-editor'
import { VarsEditor } from '@/components/vars-editor'
import { varsTensorFromFlat, type Vars } from '@/lib/cad/model'
import type { PredictionVarsSchema, PredictionCalculations } from './usePredictionModels'
import type { SavedPredictionCalculation } from './predictionContextData'
import type { ValidationRow } from './results'
import { predictionOutputRange } from './metrics'

export function PredictionVarsPane({
  candidateSessionKey,
  disabled,
  schema,
  status,
  vars,
  onVarsChange,
}: Readonly<{
  candidateSessionKey: string
  disabled: boolean
  schema: PredictionVarsSchema | null
  status: string
  vars: Readonly<Vars> | null
  onVarsChange: (vars: Readonly<Vars>) => void
}>) {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Prediction vars">
      <header className="border-b px-3 py-2.5">
        <h3 className="text-sm font-semibold">Candidate Vars</h3>
        <p className="mt-1 text-xs text-muted-foreground">Vars를 바꾸면 자동으로 원격 예측합니다.</p>
        <p className="mt-1 text-xs" role="status">
          {status}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {schema && vars ? (
          <VarsEditor
            schema={schema}
            value={vars}
            disabled={disabled}
            resetKey={candidateSessionKey}
            onValueChange={onVarsChange}
          />
        ) : (
          <p className="text-xs text-muted-foreground">Candidate 변수를 준비하는 중입니다.</p>
        )}
      </div>
    </section>
  )
}

export function PredictionCalculationPane({
  calculations,
  result,
  actual,
  busy,
}: Readonly<{
  calculations: readonly SavedPredictionCalculation[]
  result: PredictionCalculations | null
  actual: readonly ValidationRow[]
  busy: boolean
}>) {
  return (
    <section className="space-y-3" aria-label="예측 BoxGrid 분석">
      {busy ? (
        <p role="status" className="text-xs">
          예측 BoxGrid로 Calculation 실행 중…
        </p>
      ) : null}
      {calculations.map((calculation) => {
        const output = result?.values[calculation.id]
        const error = result?.errors[calculation.id]
        const comparison = actual.find((row) => row.calculationId === calculation.id)
        const [minimum, maximum] = predictionOutputRange([output ?? null, comparison?.actual ?? null])
        return (
          <section className="space-y-2 rounded border p-3" key={calculation.id}>
            <h4 className="text-sm font-medium">{calculation.name}</h4>
            {result ? (
              <p className="text-xs text-muted-foreground">
                예측 기반 분석 · Model r{result.source.model.modelRevision}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            {output ? (
              <TensorEditor
                label={calculation.name}
                axes={output.axes}
                shape={output.shape}
                value={varsTensorFromFlat(
                  output.shape.length === 0 ? [output.data as number] : (output.data as readonly number[]),
                  output.shape,
                )}
                minimum={minimum}
                maximum={maximum}
                constraintMinimum={-Number.MAX_VALUE}
                constraintMaximum={Number.MAX_VALUE}
                disabled
                comparison={{
                  primaryColor: '#2563eb',
                  primaryLabel: '예측 기반 분석',
                  series: comparison
                    ? [
                        {
                          id: 'actual',
                          color: '#059669',
                          label: '실제 해석 기반 분석',
                          status: comparison.actual ? 'ready' : 'unavailable',
                          value: comparison.actual
                            ? varsTensorFromFlat(
                                comparison.actual.shape.length === 0
                                  ? [comparison.actual.data as number]
                                  : (comparison.actual.data as readonly number[]),
                                comparison.actual.shape,
                              )
                            : null,
                          message: comparison.error,
                        },
                      ]
                    : [],
                }}
                onValueChange={() => undefined}
              />
            ) : !error && !busy ? (
              <p className="text-xs text-muted-foreground">BoxGrid 예측 후 분석합니다.</p>
            ) : null}
            {comparison?.metric?.compatible ? (
              <p className="text-xs">
                실제 결과 비교 · MAE {comparison.metric.mae?.toPrecision(5)} · Max{' '}
                {comparison.metric.maxAbsoluteError?.toPrecision(5)}
              </p>
            ) : comparison?.error ? (
              <p className="text-xs text-destructive">{comparison.error}</p>
            ) : null}
          </section>
        )
      })}
    </section>
  )
}
