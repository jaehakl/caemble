/// <reference lib="webworker" />

import { dbTables, getListRequest } from '@/api'
import type { CalculationDataAnalysisResponse, MeasurementRecord } from '@/api'
import {
  analyzeRelationships,
  buildAnalysisDataset,
  createCsv,
  getTablePage,
  getRelationshipPlot,
  mineDataset,
  stableSignature,
} from './analysis-engine'
import type { AnalysisProgressStage, AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-types'

type ContextRows = Readonly<{
  measurements: readonly MeasurementRecord[]
}>

type LoadedContext = Readonly<{
  rows: ContextRows
  calculationData: CalculationDataAnalysisResponse
  fingerprint: string
  measurementSignature: string
}>

let dataset: ReturnType<typeof buildAnalysisDataset> | null = null
let experimentId: number | null = null
let measurementSignature = ''
let calculationDataFingerprint = ''
let analysisMeasurementIds = new Set<number>()

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
    ...getListRequest('visible'),
    limit: null,
    filter: { experiment_id: [selectedExperimentId, selectedExperimentId] },
  }
  const response = await dbTables.Measurement.listRows(measurementRequest)
  return { measurements: response.items.filter((row) => row.experiment_id === selectedExperimentId) }
}

async function loadContext(requestId: string, selectedExperimentId: number): Promise<LoadedContext> {
  postProgress(requestId, 'Measurement 조회')
  const rows = await loadContextRows(selectedExperimentId)
  postProgress(requestId, 'Calculation Data 조회')
  const calculationData = await dbTables.CalculationData.analysis(selectedExperimentId)
  const measurementIds = new Set(calculationData.items.map((row) => row.measurement_id))
  const currentMeasurementSignature = stableSignature(
    rows.measurements.filter((row) => row.id !== undefined && measurementIds.has(row.id)),
  )
  return {
    rows,
    calculationData,
    fingerprint: [currentMeasurementSignature, calculationData.fingerprint].join(':'),
    measurementSignature: currentMeasurementSignature,
  }
}

function requireDataset() {
  if (!dataset) throw new Error('먼저 Experiment 데이터를 불러오세요.')
  return dataset
}

async function handleRequest(request: AnalysisWorkerRequest) {
  if (request.type === 'load-context') {
    experimentId = request.experimentId
    const loaded = await loadContext(request.requestId, request.experimentId)
    postProgress(request.requestId, '데이터셋 구성')
    dataset = buildAnalysisDataset({
      calculationData: loaded.calculationData.items,
      experimentId: request.experimentId,
      measurements: loaded.rows.measurements,
      fingerprint: loaded.fingerprint,
    })
    measurementSignature = loaded.measurementSignature
    calculationDataFingerprint = loaded.calculationData.fingerprint
    analysisMeasurementIds = new Set(loaded.calculationData.items.map((row) => row.measurement_id))
    postResponse({ type: 'profile', requestId: request.requestId, profile: dataset.profile })
    return
  }

  if (request.type === 'check-stale') {
    if (experimentId === null) {
      postResponse({ type: 'stale', requestId: request.requestId, stale: false })
      return
    }
    const [response, status] = await Promise.all([
      dbTables.Measurement.listRows({
        ...getListRequest('visible'),
        limit: null,
        filter: { experiment_id: [experimentId, experimentId] },
      }),
      dbTables.CalculationData.analysisStatus(experimentId),
    ])
    postResponse({
      type: 'stale',
      requestId: request.requestId,
      stale:
        stableSignature(response.items.filter((row) => row.id !== undefined && analysisMeasurementIds.has(row.id))) !==
          measurementSignature || status.fingerprint !== calculationDataFingerprint,
    })
    return
  }

  const currentDataset = requireDataset()
  if (request.type === 'relationships') {
    postProgress(request.requestId, '상관 분석', 0, 0)
    const result = analyzeRelationships(currentDataset, (completed, total) =>
      postProgress(request.requestId, '상관 분석', completed, total),
    )
    postResponse({ type: 'relationships', requestId: request.requestId, result })
    return
  }
  if (request.type === 'relationship-plot') {
    postResponse({
      type: 'relationship-plot',
      requestId: request.requestId,
      result: getRelationshipPlot(currentDataset, request.inputKey, request.targetKey),
    })
    return
  }
  if (request.type === 'mine') {
    postProgress(request.requestId, '통계 계산')
    postProgress(request.requestId, 'PCA·군집')
    const result = mineDataset(currentDataset, {
      featureKeys: request.featureKeys,
      outlierFraction: request.outlierFraction,
    })
    postResponse({ type: 'mining', requestId: request.requestId, result })
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
  const blob = createCsv(currentDataset, request.columnKeys)
  postResponse({
    type: 'csv',
    requestId: request.requestId,
    blob,
    filename: 'analysis-data.csv',
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
