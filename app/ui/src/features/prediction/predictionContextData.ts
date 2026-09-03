import type { FetchQueryOptions, QueryClient, QueryKey } from '@tanstack/react-query'
import {
  dbTables,
  getListRequest,
  type CalculationDataAnalysisResponse,
  type CalculationDataRecord,
  type ExperimentRecordedDataRecord,
  type PersistedCalculationRecord,
  type PersistedMeasurementRecord,
} from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { calculationsQueryOptions } from '@/features/calculation/queryOptions'
import { experimentRecordsQueryOptions } from '@/features/experiment/queryOptions'
import { measurementsQueryOptions } from '@/features/measurement/queryOptions'
import { calculationSourceHash } from '@/lib/calculation'
import { predictionFingerprint } from './data'

export type SavedPredictionCalculation = PersistedCalculationRecord
export type SavedPredictionMeasurement = PersistedMeasurementRecord

export type PredictionContext = Readonly<{
  analysis: CalculationDataAnalysisResponse
  calculations: readonly SavedPredictionCalculation[]
  experimentId: number
  fingerprint: string
  experimentRecords: readonly ExperimentRecordedDataRecord[]
  measurements: readonly SavedPredictionMeasurement[]
}>

export type PredictionValidationData = Readonly<{
  actual: readonly CalculationDataRecord[]
  currentSourceFingerprints: ReadonlyMap<number, string>
}>

type PredictionContextMetadata = Readonly<{
  calculations: readonly SavedPredictionCalculation[]
  experimentRecords: readonly ExperimentRecordedDataRecord[]
  measurements: readonly SavedPredictionMeasurement[]
}>

async function fetchFreshQuery<TQueryFnData, TError, TData, TQueryKey extends QueryKey, TPageParam>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const request = queryClient.fetchQuery({ ...options, retry: false, staleTime: 0 })
  if (!signal) return request
  // Metadata queries can be shared by other observers. The Query-owned signal controls
  // their transport; a workflow signal only stops this caller from awaiting shared work.
  return new Promise<TData>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    void request.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function contextListRequest(experimentId: number) {
  return {
    ...getListRequest('visible'),
    limit: null,
    filter: { experiment_id: [experimentId, experimentId] as const },
  }
}

async function loadContextMetadata(
  queryClient: QueryClient,
  queryScope: PrivateQueryScope,
  experimentId: number,
  signal?: AbortSignal,
): Promise<PredictionContextMetadata> {
  const listRequest = contextListRequest(experimentId)
  const [calculationResponse, measurementResponse, experimentRecordResponse] = await Promise.all([
    fetchFreshQuery(queryClient, calculationsQueryOptions(queryScope, experimentId, listRequest), signal),
    fetchFreshQuery(queryClient, measurementsQueryOptions(queryScope, experimentId, listRequest), signal),
    fetchFreshQuery(queryClient, experimentRecordsQueryOptions(queryScope, experimentId), signal),
  ])
  signal?.throwIfAborted()
  return Object.freeze({
    calculations: Object.freeze([...calculationResponse.items]),
    experimentRecords: Object.freeze([...experimentRecordResponse.items]),
    measurements: Object.freeze(measurementResponse.items.filter((row) => row.recorded_at !== null)),
  })
}

function contextFingerprint(
  experimentId: number,
  analysisFingerprint: string,
  { calculations, experimentRecords, measurements }: PredictionContextMetadata,
) {
  return predictionFingerprint([
    experimentId,
    analysisFingerprint,
    [...measurements].sort((left, right) => left.id - right.id).map((row) => [row.id, row.updated_at, row.recorded_at]),
    [...experimentRecords].sort((left, right) => left.id - right.id).map((record) => [record.id, record.contract_hash]),
    [...calculations]
      .sort((left, right) => left.id - right.id)
      .map((row) => [
        row.id,
        row.updated_at,
        row.source_hash,
        row.output_layout,
        row.experiment_record_ids,
        row.contract_status,
      ]),
  ])
}

export async function loadPredictionContextData({
  experimentId,
  queryClient,
  queryScope,
  signal,
}: Readonly<{
  experimentId: number
  queryClient: QueryClient
  queryScope: PrivateQueryScope
  signal?: AbortSignal
}>): Promise<PredictionContext> {
  const [metadata, analysis] = await Promise.all([
    loadContextMetadata(queryClient, queryScope, experimentId, signal),
    dbTables.CalculationData.analysis(experimentId, { signal }),
  ])
  signal?.throwIfAborted()
  return Object.freeze({
    ...metadata,
    analysis,
    experimentId,
    fingerprint: contextFingerprint(experimentId, analysis.fingerprint, metadata),
  })
}

export async function loadPredictionContextFingerprint({
  experimentId,
  queryClient,
  queryScope,
  signal,
}: Readonly<{
  experimentId: number
  queryClient: QueryClient
  queryScope: PrivateQueryScope
  signal?: AbortSignal
}>) {
  const [metadata, analysisStatus] = await Promise.all([
    loadContextMetadata(queryClient, queryScope, experimentId, signal),
    dbTables.CalculationData.analysisStatus(experimentId, { signal }),
  ])
  signal?.throwIfAborted()
  return contextFingerprint(experimentId, analysisStatus.fingerprint, metadata)
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
  const calculationRequest = {
    ...getListRequest('visible', calculationIds),
    filter: { experiment_id: [experimentId, experimentId] as const },
    limit: calculationIds.length,
  }
  const [analysis, calculationResponse] = await Promise.all([
    dbTables.CalculationData.analysis(experimentId, { signal }),
    fetchFreshQuery(queryClient, calculationsQueryOptions(queryScope, experimentId, calculationRequest), signal),
  ])
  signal?.throwIfAborted()
  const currentSourceFingerprints = new Map(
    await Promise.all(
      calculationResponse.items.map(
        async (calculation) => [calculation.id, await calculationSourceHash(calculation.source_code)] as const,
      ),
    ),
  )
  signal?.throwIfAborted()
  const calculationDataIds = analysis.items
    .filter((item) => item.measurement_id === measurementId && calculationIds.includes(item.calculation_id))
    .map((item) => item.calculation_data_id)
  const actual: CalculationDataRecord[] = []
  for (let offset = 0; offset < calculationDataIds.length; offset += 50) {
    const selectedIds = calculationDataIds.slice(offset, offset + 50)
    const response = await dbTables.CalculationData.listRows(
      {
        ...getListRequest('visible', selectedIds),
        experiment_id: experimentId,
        limit: selectedIds.length,
        sort: ['id', 'asc'],
      },
      { signal },
    )
    signal?.throwIfAborted()
    actual.push(...response.items)
  }
  return Object.freeze({
    actual: Object.freeze(actual),
    currentSourceFingerprints,
  })
}
