import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { measurementCalculationPointState } from '@/features/cae-workbench/measurement/measurementCalculationPoint'

const notRun = measurementCalculationPointState(null, 0, 3)
assert.equal(notRun.status, 'not-run')
assert.match(notRun.className, /slate-300/u)
assert.equal(notRun.description, 'Run 전')

const incomplete = measurementCalculationPointState('2026-01-01T00:00:00Z', 2, 4)
assert.equal(incomplete.status, 'incomplete')
assert.match(incomplete.className, /amber-400/u)
assert.match(incomplete.description, /2\/4/u)

const complete = measurementCalculationPointState('2026-01-01T00:00:00Z', 4, 4)
assert.equal(complete.status, 'complete')
assert.match(complete.className, /emerald-500/u)
assert.match(complete.description, /4\/4/u)

const noCalculations = measurementCalculationPointState('2026-01-01T00:00:00Z', 0, 0)
assert.equal(noCalculations.status, 'complete')
assert.match(noCalculations.description, /0\/0/u)

for (const unavailable of ['loading', 'error'] as const) {
  const state = measurementCalculationPointState('2026-01-01T00:00:00Z', 1, unavailable)
  assert.equal(state.status, 'unknown')
  assert.match(state.className, /slate-100/u)
}

const explorerSource = readFileSync('src/features/cae-workbench/measurement/MeasurementExplorer.tsx', 'utf8')
assert.match(explorerSource, /Run 전/u)
assert.match(explorerSource, /Calculation 미완료/u)
assert.match(explorerSource, /Measurement #\$\{row\.id\} \$\{status\}/u)

const pickerSource = readFileSync('src/features/cae-workbench/dialogs/MeasurementPickerDialog.tsx', 'utf8')
assert.doesNotMatch(pickerSource, /calculationTotal=/u)

const workbenchSource = readFileSync('src/features/cae-workbench/calculation/CalculationWorkbench.tsx', 'utf8')
const batchSource = readFileSync('src/features/cae-workbench/calculation/useCalculationDataActions.ts', 'utf8')
assert.match(workbenchSource, /queryKey: \['cae-workbench', 'measurements'\]/u)
assert.match(batchSource, /queryKey: \['cae-workbench', 'measurements'\]/u)

console.log('Measurement Calculation 상태 테스트 통과')
