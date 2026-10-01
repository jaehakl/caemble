import type { QueryClient } from '@tanstack/react-query'
import {
  dbTables,
  getListRequest,
  type CalculationDataRecord,
  type ExperimentRecordedDataRecord,
  type PersistedCalculationRecord,
} from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { calculationsQueryOptions } from '@/features/calculation/queryOptions'
import { experimentRecordsQueryOptions } from '@/features/experiment/queryOptions'
import { calculationSourceHash } from '@/lib/calculation'
import { predictionFingerprint } from './data'

export type SavedPredictionCalculation = PersistedCalculationRecord
export type PredictionContext = Readonly<{
  calculations: readonly SavedPredictionCalculation[]
  calculationError?: string
  experimentId: number
  fingerprint: string
  experimentRecords: readonly ExperimentRecordedDataRecord[]
}>
export type PredictionValidationData = Readonly<{
  actual: readonly CalculationDataRecord[]
  currentSourceFingerprints: ReadonlyMap<number, string>
}>

type ContextOptions = Readonly<{
  experimentId: number
  queryClient: QueryClient
  queryScope: PrivateQueryScope
  signal?: AbortSignal
}>

async function awaitContext<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
    }
    const cancel = () => {
      finish()
      reject(new DOMException('Prediction context 조회가 취소되었습니다.', 'AbortError'))
    }
    const timeout = setTimeout(() => {
      finish()
      reject(new Error('Prediction 계약 조회 시간이 초과되었습니다. 다시 시도하세요.'))
    }, 30_000)
    signal?.addEventListener('abort', cancel, { once: true })
    void request.then(
      (value) => {
        finish()
        resolve(value)
      },
      (error: unknown) => {
        finish()
        reject(error)
      },
    )
  })
}

/** Saved-model inference needs output contracts only; optional analyses load independently. */
export async function loadPredictionContextData({
  experimentId,
  queryClient,
  queryScope,
  signal,
}: ContextOptions): Promise<PredictionContext> {
  const response = await awaitContext(
    queryClient.fetchQuery({ ...experimentRecordsQueryOptions(queryScope, experimentId), retry: false, staleTime: 0 }),
    signal,
  )
  signal?.throwIfAborted()
  const experimentRecords = Object.freeze([...response.items])
  return Object.freeze({
    experimentId,
    experimentRecords,
    calculations: [],
    fingerprint: predictionFingerprint([experimentId, experimentRecords.map((row) => [row.id, row.contract_hash])]),
  })
}

export async function loadPredictionCalculations({ experimentId, queryClient, queryScope, signal }: ContextOptions) {
  const request = {
    ...getListRequest('visible'),
    limit: null,
    filter: { experiment_id: [experimentId, experimentId] as const },
  }
  const response = await awaitContext(
    queryClient.fetchQuery({
      ...calculationsQueryOptions(queryScope, experimentId, request),
      retry: false,
      staleTime: 0,
    }),
    signal,
  )
  return Object.freeze([...response.items])
}

export async function loadPredictionValidationData({
  calculationIds,
  experimentId,
  measurementId,
  queryClient,
  queryScope,
  signal,
}: Readonly<{
  calculationIds: readonly number[]
  experimentId: number
  measurementId: number
  queryClient: QueryClient
  queryScope: PrivateQueryScope
  signal?: AbortSignal
}>): Promise<PredictionValidationData> {
  if (!calculationIds.length) return { actual: [], currentSourceFingerprints: new Map() }
  const [analysis, calculations] = await Promise.all([
    dbTables.CalculationData.analysis(experimentId, { signal }),
    queryClient.fetchQuery({
      ...calculationsQueryOptions(queryScope, experimentId, {
        ...getListRequest('visible', calculationIds),
        filter: { experiment_id: [experimentId, experimentId] },
        limit: calculationIds.length,
      }),
      retry: false,
      staleTime: 0,
    }),
  ])
  signal?.throwIfAborted()
  const currentSourceFingerprints = new Map(
    await Promise.all(
      calculations.items.map(
        async (calculation) => [calculation.id, await calculationSourceHash(calculation.source_code)] as const,
      ),
    ),
  )
  const ids = analysis.items
    .filter((item) => item.measurement_id === measurementId && calculationIds.includes(item.calculation_id))
    .map((item) => item.calculation_data_id)
  const actual: CalculationDataRecord[] = []
  for (let offset = 0; offset < ids.length; offset += 50) {
    const selected = ids.slice(offset, offset + 50)
    const response = await dbTables.CalculationData.listRows(
      {
        ...getListRequest('visible', selected),
        experiment_id: experimentId,
        limit: selected.length,
        sort: ['id', 'asc'],
      },
      { signal },
    )
    signal?.throwIfAborted()
    actual.push(...response.items)
  }
  return Object.freeze({ actual, currentSourceFingerprints })
}
