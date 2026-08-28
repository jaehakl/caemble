export type CalculationTotalState = number | 'error' | 'loading'

export type MeasurementCalculationPointState = Readonly<{
  className: string
  description: string
  status: 'complete' | 'incomplete' | 'not-run' | 'unknown'
}>

export function measurementCalculationPointState(
  recordedAt: string | null,
  calculationDataCount: number,
  calculationTotal: CalculationTotalState,
): MeasurementCalculationPointState {
  if (!recordedAt) {
    return {
      className: 'border-slate-400 bg-slate-300 hover:bg-slate-400',
      description: 'Run 전',
      status: 'not-run',
    }
  }
  if (calculationTotal === 'loading' || calculationTotal === 'error') {
    return {
      className: 'border-slate-400 bg-slate-100 hover:bg-slate-200',
      description: calculationTotal === 'loading' ? 'Calculation 상태 확인 중' : 'Calculation 상태 조회 실패',
      status: 'unknown',
    }
  }
  if (calculationDataCount < calculationTotal) {
    return {
      className: 'border-amber-700 bg-amber-400 hover:bg-amber-500',
      description: `Calculation ${calculationDataCount}/${calculationTotal}`,
      status: 'incomplete',
    }
  }
  return {
    className: 'border-emerald-700 bg-emerald-500 hover:bg-emerald-600',
    description: `Calculation 완료 ${calculationDataCount}/${calculationTotal}`,
    status: 'complete',
  }
}
