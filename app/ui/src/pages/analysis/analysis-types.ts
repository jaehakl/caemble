export type AnalysisColumnKind = 'feature' | 'target'

export type AnalysisColumnDescriptor = Readonly<{
  key: string
  label: string
  kind: AnalysisColumnKind
  source: 'measurement-material' | 'measurement-vars' | 'recorded-data'
  count: number
  distinctCount: number
  missingRatio: number
  eligible: boolean
  exclusionReason?: string
  unit?: string
  quantityKind?: string
  statistic?: string
  min?: number
  max?: number
  mean?: number
  std?: number
  p05?: number
  p25?: number
  p50?: number
  p75?: number
  p95?: number
  histogram?: readonly Readonly<{ min: number; max: number; count: number }>[]
}>

export type AnalysisProfile = Readonly<{
  fingerprint: string
  experimentId: number
  rowCount: number
  preparedCount: number
  recordedMeasurementCount: number
  recordedDataCount: number
  columns: readonly AnalysisColumnDescriptor[]
  categoricalSummaries: readonly Readonly<{
    name: string
    dtype: string
    quantityKind?: string
    counts: readonly Readonly<{ value: string; count: number }>[]
    excludedReason?: string
  }>[]
  warnings: readonly string[]
}>

export type AnalysisMiningResult = Readonly<{
  fingerprint: string
  featureKeys: readonly string[]
  correlationKeys: readonly string[]
  correlations: readonly (readonly (number | null)[])[]
  spearmanCorrelations: readonly (readonly (number | null)[])[]
  explainedVariance: readonly number[]
  loadings: readonly Readonly<{ key: string; pc1: number; pc2: number }>[]
  points: readonly Readonly<{
    measurementId: number
    inputFingerprint: string
    pc1: number
    pc2: number
    cluster: number
    anomalyScore: number
    outlier: boolean
    x?: number
    y?: number
  }>[]
  clusterCount: number
  silhouette: number
  outlierFraction: number
}>

export type AnalysisPredictionResult = Readonly<{
  fingerprint: string
  targetKey: string
  featureKeys: readonly string[]
  selectedModel: 'random-forest' | 'ridge'
  ridgeAlpha: number
  metrics: Readonly<{
    ridge: Readonly<{ r2: number; mae: number; rmse: number }>
    randomForest: Readonly<{ r2: number; mae: number; rmse: number }>
  }>
  importanceMethod: string
  importances: readonly Readonly<{ key: string; value: number }>[]
  rows: readonly Readonly<{
    measurementId: number
    inputFingerprint: string
    observed: number
    predicted: number
    residual: number
    fold: number
  }>[]
  prediction: number
  interval: readonly [number, number]
  extrapolatedFeatureKeys: readonly string[]
}>

export type AnalysisTablePage = Readonly<{
  fingerprint: string
  offset: number
  total: number
  columns: readonly string[]
  rows: readonly Readonly<{
    measurementId: number
    inputFingerprint: string
    values: readonly (number | null)[]
  }>[]
}>

export type AnalysisProgressStage =
  'Measurement 조회' | 'Recorded Data 조회' | '데이터셋 구성' | '통계 계산' | 'PCA·군집' | '교차 검증' | '최종 학습'

export type AnalysisWorkerRequest =
  | Readonly<{
      type: 'load-context'
      requestId: string
      experimentId: number
    }>
  | Readonly<{
      type: 'check-stale'
      requestId: string
    }>
  | Readonly<{
      type: 'mine'
      requestId: string
      featureKeys: readonly string[]
      xKey: string | null
      yKey: string | null
      targetKey: string | null
      outlierFraction: number
    }>
  | Readonly<{
      type: 'predict'
      requestId: string
      featureKeys: readonly string[]
      targetKey: string
      whatIf: Readonly<Record<string, number>>
    }>
  | Readonly<{
      type: 'table-page'
      requestId: string
      columnKeys: readonly string[]
      offset: number
      limit: number
    }>
  | Readonly<{
      type: 'export-csv'
      requestId: string
      kind: 'dataset' | 'prediction'
      columnKeys: readonly string[]
    }>

export type AnalysisWorkerResponse =
  | Readonly<{
      type: 'progress'
      requestId: string
      stage: AnalysisProgressStage
      completed?: number
      total?: number
    }>
  | Readonly<{
      type: 'profile'
      requestId: string
      profile: AnalysisProfile
    }>
  | Readonly<{
      type: 'stale'
      requestId: string
      stale: boolean
    }>
  | Readonly<{
      type: 'mining'
      requestId: string
      result: AnalysisMiningResult
    }>
  | Readonly<{
      type: 'prediction'
      requestId: string
      result: AnalysisPredictionResult
    }>
  | Readonly<{
      type: 'table-page'
      requestId: string
      page: AnalysisTablePage
    }>
  | Readonly<{
      type: 'csv'
      requestId: string
      blob: Blob
      filename: string
    }>
  | Readonly<{
      type: 'error'
      requestId: string
      message: string
    }>
