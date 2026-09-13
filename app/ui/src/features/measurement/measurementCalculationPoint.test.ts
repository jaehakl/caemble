import { expect, it } from 'vitest'
import { measurementCalculationPointState } from './measurementCalculationPoint'

it.each([
  [null, 0, 3, 'not-run', 'Run 전'],
  ['2026-01-01', 2, 4, 'incomplete', 'Calculation 2/4'],
  ['2026-01-01', 4, 4, 'complete', 'Calculation 완료 4/4'],
  ['2026-01-01', 0, 0, 'complete', 'Calculation 완료 0/0'],
  ['2026-01-01', 1, 'loading', 'unknown', 'Calculation 상태 확인 중'],
  ['2026-01-01', 1, 'error', 'unknown', 'Calculation 상태 조회 실패'],
] as const)('describes recorded=%s, completed=%s, total=%s', (recorded, completed, total, status, description) => {
  expect(measurementCalculationPointState(recorded, completed, total)).toMatchObject({ status, description })
})
