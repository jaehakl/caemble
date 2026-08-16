/// <reference lib="webworker" />

import { dbTables, getListRequest } from '@/api'
import { catalogApi } from '@/api/catalog'
import type { MeasurementRecord, RecordedDataRecord } from '@/api'
import {
  ANALYSIS_MAX_ROWS,
  buildAnalysisDataset,
  collectAnalysisQuantityKindNames,
  createCsv,
  createMeasurementRanges,
  getTablePage,
  mineDataset,
  predictDataset,
  stableSignature,
} from './analysis-engine'
import type { AnalysisProgressStage, AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-types'

type ContextRows = Readonly<{
  measurements: readonly MeasurementRecord[]
}>

type LoadedContext = Readonly<{
  rows: ContextRows
  recordedData: readonly RecordedDataRecord[]
  fingerprint: string
  measurementSignature: string
}>

let dataset: ReturnType<typeof buildAnalysisDataset> | null = null
let experimentId: number | null = null
let measurementSignature = ''

function postResponse(response: AnalysisWorkerResponse) {
  self.postMessage(response)
}

function postProgress(requestId: string, stage: AnalysisProgressStage, completed?: number, total?: number) {
  postResponse({
    type: 'progress',
    requestId,
    stage,
    ...(completed === undefined ? {} : { completed }),
    ...(total === undefined ? {} : { total }),
  })
}

async function loadContextRows(selectedExperimentId: number): Promise<ContextRows> {
  const measurementRequest = {
    ...getListRequest('mine'),
    limit: null,
    filter: { experiment_id: [selectedExperimentId, selectedExperimentId] },
  }
  const response = await dbTables.Measurement.listRows(measurementRequest)
  return { measurements: response.items.filter((row) => row.experiment_id === selectedExperimentId) }
}

function rowsSignature(rows: ContextRows) {
  return stableSignature(rows.measurements)
}

async function loadRecordedData(
  requestId: string,
  measurements: readonly MeasurementRecord[],
): Promise<RecordedDataRecord[]> {
  const measurementIds = measurements
    .map((measurement) => measurement.id)
    .filter((id): id is number => Number.isSafeInteger(id) && (id ?? 0) > 0)
  const ranges = createMeasurementRanges(measurementIds)
  if (ranges.length === 0) {
    postProgress(requestId, 'Recorded Data 조회', 0, 0)
    return []
  }

  const allowedMeasurementIds = new Set(measurementIds)
  const responses: RecordedDataRecord[][] = Array.from({ length: ranges.length }, () => [])
  let nextIndex = 0
  let completed = 0
  postProgress(requestId, 'Recorded Data 조회', completed, ranges.length)

  const fetchNext = async (): Promise<void> => {
    while (nextIndex < ranges.length) {
      const index = nextIndex
      nextIndex += 1
      const range = ranges[index]
      const exactIds = new Set(range.ids)
      const response = await dbTables.RecordedData.listRows({
        ...getListRequest('mine'),
        limit: null,
        filter: { measurement_id: [range.min, range.max] },
      })
      responses[index] = response.items.filter(
        (row) => exactIds.has(row.measurement_id) && allowedMeasurementIds.has(row.measurement_id),
      )
      completed += 1
      postProgress(requestId, 'Recorded Data 조회', completed, ranges.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, ranges.length) }, () => fetchNext()))
  return responses.flat()
}

async function loadStableContext(requestId: string, selectedExperimentId: number): Promise<LoadedContext> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    postProgress(requestId, 'Measurement 조회')
    const before = await loadContextRows(selectedExperimentId)
    if (before.measurements.length > ANALYSIS_MAX_ROWS) {
      throw new Error(`Analysis는 최대 ${ANALYSIS_MAX_ROWS.toLocaleString()}개 Measurement까지 지원합니다.`)
    }
    const recordedData = await loadRecordedData(requestId, before.measurements)
    const after = await loadContextRows(selectedExperimentId)
    if (rowsSignature(before) === rowsSignature(after)) {
      const currentMeasurementSignature = stableSignature(after.measurements)
      const fingerprint = [currentMeasurementSignature, stableSignature(recordedData)].join(':')
      return {
        rows: after,
        recordedData,
        fingerprint,
        measurementSignature: currentMeasurementSignature,
      }
    }
  }
  throw new Error('분석 데이터를 읽는 동안 Measurement가 계속 변경되었습니다. 잠시 후 새로고침해 주세요.')
}

function requireDataset() {
  if (!dataset) throw new Error('먼저 Experiment 데이터를 불러오세요.')
  return dataset
}

async function handleRequest(request: AnalysisWorkerRequest) {
  if (request.type === 'load-context') {
    experimentId = request.experimentId
    const loaded = await loadStableContext(request.requestId, request.experimentId)
    postProgress(request.requestId, 'Catalog 조회')
    const quantityKindNames = collectAnalysisQuantityKindNames(loaded.rows.measurements, loaded.recordedData)
    const quantityKindTensorOrders = new Map<string, number>()
    for (let offset = 0; offset < quantityKindNames.length; offset += 256) {
      const slice = await catalogApi.runtimeSlice({
        solvers: [],
        quantityKinds: quantityKindNames.slice(offset, offset + 256),
        materialParameters: [],
        materialModels: [],
      })
      slice.quantityKinds.forEach((definition) => quantityKindTensorOrders.set(definition.name, definition.tensorOrder))
    }
    postProgress(request.requestId, '데이터셋 구성')
    dataset = buildAnalysisDataset({
      experimentId: request.experimentId,
      measurements: loaded.rows.measurements,
      quantityKindTensorOrders,
      recordedData: loaded.recordedData,
      fingerprint: loaded.fingerprint,
    })
    measurementSignature = loaded.measurementSignature
    postResponse({ type: 'profile', requestId: request.requestId, profile: dataset.profile })
    return
  }

  if (request.type === 'check-stale') {
    if (experimentId === null) {
      postResponse({ type: 'stale', requestId: request.requestId, stale: false })
      return
    }
    const response = await dbTables.Measurement.listRows({
      ...getListRequest('mine'),
      limit: null,
      filter: { experiment_id: [experimentId, experimentId] },
    })
    postResponse({
      type: 'stale',
      requestId: request.requestId,
      stale: stableSignature(response.items) !== measurementSignature,
    })
    return
  }

  const currentDataset = requireDataset()
  if (request.type === 'mine') {
    postProgress(request.requestId, '통계 계산')
    postProgress(request.requestId, 'PCA·군집')
    const result = mineDataset(currentDataset, {
      featureKeys: request.featureKeys,
      xKey: request.xKey,
      yKey: request.yKey,
      targetKey: request.targetKey,
      outlierFraction: request.outlierFraction,
    })
    postResponse({ type: 'mining', requestId: request.requestId, result })
    return
  }
  if (request.type === 'predict') {
    postProgress(request.requestId, '교차 검증')
    const result = predictDataset(
      currentDataset,
      {
        featureKeys: request.featureKeys,
        targetKey: request.targetKey,
        whatIf: request.whatIf,
      },
      () => postProgress(request.requestId, '최종 학습'),
    )
    postResponse({ type: 'prediction', requestId: request.requestId, result })
    return
  }
  if (request.type === 'table-page') {
    postResponse({
      type: 'table-page',
      requestId: request.requestId,
      page: getTablePage(currentDataset, request.columnKeys, request.offset, request.limit),
    })
    return
  }
  const blob = createCsv(currentDataset, request.kind, request.columnKeys)
  postResponse({
    type: 'csv',
    requestId: request.requestId,
    blob,
    filename: request.kind === 'prediction' ? 'analysis-prediction.csv' : 'analysis-data.csv',
  })
}

self.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data
  void handleRequest(request).catch((error: unknown) => {
    postResponse({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : '분석 중 알 수 없는 오류가 발생했습니다.',
    })
  })
}
