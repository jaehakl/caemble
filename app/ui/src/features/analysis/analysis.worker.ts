/// <reference lib="webworker" />

import { dbTables, getListRequest } from '@/api'
import {
  analyzeRelationships,
  buildAnalysisDataset,
  createCsv,
  getTablePage,
  getRelationshipPlot,
  mineDataset,
} from './analysis-engine'
import type { AnalysisProgressStage, AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-types'
import { parseAnalysisWorkerRequest, parseAnalysisWorkerResponse } from './analysisProtocol'

let dataset: ReturnType<typeof buildAnalysisDataset> | null = null

function postResponse(response: AnalysisWorkerResponse) {
  self.postMessage(parseAnalysisWorkerResponse(response))
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

function requireDataset() {
  if (!dataset) throw new Error('먼저 Experiment 데이터를 불러오세요.')
  return dataset
}

async function handleRequest(request: AnalysisWorkerRequest) {
  if (request.type === 'load-context') {
    // Capture the fingerprint before reading inputs so changes during loading remain detectable.
    postProgress(request.requestId, 'Calculation Data 조회')
    const calculationData = await dbTables.CalculationData.analysis(request.experimentId)
    postProgress(request.requestId, 'Measurement 조회')
    const measurements = await dbTables.Measurement.listRows({
      ...getListRequest('visible'),
      limit: null,
      filter: { experiment_id: [request.experimentId, request.experimentId] },
    })
    postProgress(request.requestId, '데이터셋 구성')
    dataset = buildAnalysisDataset({
      calculationData: calculationData.items,
      experimentId: request.experimentId,
      measurements: measurements.items.filter((row) => row.experiment_id === request.experimentId),
      fingerprint: calculationData.fingerprint,
    })
    postResponse({ type: 'profile', requestId: request.requestId, profile: dataset.profile })
    return
  }

  if (request.type === 'check-stale') {
    if (!dataset) {
      postResponse({ type: 'stale', requestId: request.requestId, stale: false })
      return
    }
    const status = await dbTables.CalculationData.analysisStatus(dataset.profile.experimentId)
    postResponse({
      type: 'stale',
      requestId: request.requestId,
      stale: status.fingerprint !== dataset.profile.fingerprint,
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

self.onmessage = (event: MessageEvent<unknown>) => {
  let request: AnalysisWorkerRequest
  try {
    request = parseAnalysisWorkerRequest(event.data)
  } catch {
    const requestId =
      typeof event.data === 'object' && event.data !== null && 'requestId' in event.data &&
      typeof event.data.requestId === 'string' && event.data.requestId.length > 0
        ? event.data.requestId
        : 'invalid-analysis-request'
    postResponse({ type: 'error', requestId, message: 'Analysis Worker 요청 계약이 일치하지 않습니다.' })
    return
  }
  void handleRequest(request).catch((error: unknown) => {
    postResponse({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : '분석 중 알 수 없는 오류가 발생했습니다.',
    })
  })
}
