import type { PredictionExecutionMetrics, PredictionQualityReport } from '@/contracts/api/prediction'

export const qualityReportFixture: PredictionQualityReport = {
  version: 1,
  evaluation: 'pre-save-holdout',
  status: 'complete',
  dataset: { datasetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', revision: 1, fingerprint: 'dataset-fingerprint' },
  definitionFingerprint: 'forward-fingerprint',
  split: {
    version: 1,
    seed: 0,
    holdoutFraction: 0.2,
    fingerprint: 'sha256:' + 'a'.repeat(64),
    trainingMeasurementIds: [1, 2, 3, 4],
    validationMeasurementIds: [5],
    trainingGroupCount: 4,
    validationGroupCount: 1,
    excluded: [],
  },
  records: [
    {
      recordId: 10,
      key: 'temperature',
      unit: 'K',
      status: 'evaluated',
      trainingMeasurementIds: [1, 2, 3, 4],
      evaluatedMeasurementIds: [5],
      evaluatedGroupCount: 1,
      excluded: [],
      components: [{ component: 'value', mae: 0.5, rmse: 0.6, maxAbsoluteError: 1 }],
    },
  ],
}

export const executionMetricsFixture: PredictionExecutionMetrics = {
  version: 1,
  scope: 'process-tree',
  elapsedSeconds: 2.5,
  peakRssBytes: 8 * 1024 ** 2,
  rssStatus: 'measured',
  peakVramBytes: {},
  gpuStatus: 'not-requested',
  rssSamples: 2,
  gpuSamples: 0,
  rssIntervalSeconds: 0.1,
  gpuIntervalSeconds: 0.5,
  sampledCpuSeconds: 1,
  samplingShutdownSeconds: 0.001,
  warnings: [],
  phases: { training: 1.5, validating: 1 },
}
