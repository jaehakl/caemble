import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { QueryClient } from '@tanstack/react-query'
import { clearPrivateQueryCache } from '@/features/auth/queryCache'
import { authQueryKey, privateQueryScope } from '@/features/auth/queryKeys'
import {
  calculationDataQueryKeys,
  calculationQueryKeys,
} from '@/features/calculation/queryKeys'
import { invalidateCalculationMutation } from '@/features/calculation/queryInvalidation'
import { invalidateExperimentMutation } from '@/features/experiment/queryInvalidation'
import { experimentQueryKeys } from '@/features/experiment/queryKeys'
import { measurementCalculationPointState } from '@/features/measurement/measurementCalculationPoint'
import { measurementQueryKeys } from '@/features/measurement/queryKeys'

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

const explorerSource = readFileSync('src/features/measurement/MeasurementExplorer.tsx', 'utf8')
assert.match(explorerSource, /Run 전/u)
assert.match(explorerSource, /Calculation 미완료/u)
assert.match(explorerSource, /Measurement #\$\{row\.id\} \$\{status\}/u)

const pickerSource = readFileSync('src/features/cae-workbench/dialogs/MeasurementPickerDialog.tsx', 'utf8')
assert.doesNotMatch(pickerSource, /calculationTotal=/u)

const aliceScope = privateQueryScope({ id: 'alice', is_active: true })
const bobScope = privateQueryScope({ id: 'bob', is_active: true })
assert.equal(privateQueryScope(null), 'public')
assert.equal(aliceScope, 'user:alice')
assert.notDeepEqual(experimentQueryKeys.available(aliceScope), experimentQueryKeys.available(bobScope))

const request = {
  scope: 'visible' as const,
  offset: 0,
  limit: 12,
  selected_ids: [] as number[],
  search_text: null,
  text_filter: {},
  filter: { experiment_id: [7, 7] },
  null_filter: {},
  sort: ['updated_at', 'desc'] as const,
}
const queryClient = new QueryClient()
const aliceMeasurementKey = measurementQueryKeys.list(aliceScope, 7, request)
const aliceCalculationKey = calculationQueryKeys.list(aliceScope, 7, request)
const aliceCalculationDataKey = calculationDataQueryKeys.scalars(aliceScope, 7, 11, 13)
const aliceExperimentSummaryKey = experimentQueryKeys.available(aliceScope)
const bobMeasurementKey = measurementQueryKeys.list(bobScope, 7, request)
const aliceOtherMeasurementKey = measurementQueryKeys.list(aliceScope, 8, {
  ...request,
  filter: { experiment_id: [8, 8] },
})
const aliceOtherCalculationKey = calculationQueryKeys.list(aliceScope, 8, {
  ...request,
  filter: { experiment_id: [8, 8] },
})
const aliceOtherCalculationDataKey = calculationDataQueryKeys.scalars(aliceScope, 8, 12, 14)
for (const queryKey of [
  aliceMeasurementKey,
  aliceCalculationKey,
  aliceCalculationDataKey,
  aliceExperimentSummaryKey,
  bobMeasurementKey,
  aliceOtherMeasurementKey,
  aliceOtherCalculationKey,
  aliceOtherCalculationDataKey,
]) {
  queryClient.setQueryData(queryKey, true)
}
await invalidateCalculationMutation(queryClient, aliceScope, 7)
assert.equal(queryClient.getQueryState(aliceMeasurementKey)?.isInvalidated, true)
assert.equal(queryClient.getQueryState(aliceCalculationKey)?.isInvalidated, true)
assert.equal(queryClient.getQueryState(aliceCalculationDataKey)?.isInvalidated, true)
assert.equal(queryClient.getQueryState(aliceExperimentSummaryKey)?.isInvalidated, true)
assert.equal(queryClient.getQueryState(bobMeasurementKey)?.isInvalidated, false)
assert.equal(queryClient.getQueryState(aliceOtherMeasurementKey)?.isInvalidated, false)
assert.equal(queryClient.getQueryState(aliceOtherCalculationKey)?.isInvalidated, false)
assert.equal(queryClient.getQueryState(aliceOtherCalculationDataKey)?.isInvalidated, false)

const experimentMutationClient = new QueryClient()
const experimentDetailKey = experimentQueryKeys.detail(aliceScope, 7)
experimentMutationClient.setQueryData(authQueryKey, { id: 'alice' })
experimentMutationClient.setQueryData(experimentDetailKey, true)
experimentMutationClient.setQueryData(aliceMeasurementKey, true)
experimentMutationClient.setQueryData(aliceCalculationKey, true)
experimentMutationClient.setQueryData(aliceOtherMeasurementKey, true)
await invalidateExperimentMutation(experimentMutationClient, aliceScope, 7)
assert.equal(experimentMutationClient.getQueryState(authQueryKey)?.isInvalidated, true)
assert.equal(experimentMutationClient.getQueryState(experimentDetailKey)?.isInvalidated, true)
assert.equal(experimentMutationClient.getQueryState(aliceMeasurementKey)?.isInvalidated, true)
assert.equal(experimentMutationClient.getQueryState(aliceCalculationKey)?.isInvalidated, true)
assert.equal(experimentMutationClient.getQueryState(aliceOtherMeasurementKey)?.isInvalidated, false)

const logoutClient = new QueryClient()
logoutClient.setQueryData(aliceMeasurementKey, true)
logoutClient.setQueryData(['materials', 'list', 'visible'], true)
logoutClient.setQueryData(['catalog', 'quantity-kinds'], true)
clearPrivateQueryCache(logoutClient)
assert.equal(logoutClient.getQueryState(aliceMeasurementKey), undefined)
assert.equal(logoutClient.getQueryState(['materials', 'list', 'visible']), undefined)
assert.notEqual(logoutClient.getQueryState(['catalog', 'quantity-kinds']), undefined)
queryClient.clear()
experimentMutationClient.clear()
logoutClient.clear()

console.log('Measurement Calculation 상태 테스트 통과')
