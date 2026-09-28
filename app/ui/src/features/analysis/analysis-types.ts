export type AnalysisColumnKind = 'feature' | 'target'

export type AnalysisColumnDescriptor = Readonly<{
  key: string
  label: string
  kind: AnalysisColumnKind
  source: 'calculation-data' | 'measurement-material' | 'measurement-vars'
  count: number
  distinctCount: number
  missingRatio: number
  eligible: boolean
  exclusionReason?: string
  unit?: string
  quantityKind?: string
  statistic?: string
}>

export type AnalysisProfile = Readonly<{
  fingerprint: string
  experimentId: number
  rowCount: number
  measurementCount: number
  calculationDataCount: number
  calculationCount: number
  columns: readonly AnalysisColumnDescriptor[]
  warnings: readonly string[]
}>

export type AnalysisRelationshipPair = Readonly<{
  inputKey: string
  targetKey: string
  pearson: number
  spearman: number
  count: number
}>

export type AnalysisRelationshipsResult = Readonly<{
  fingerprint: string
  pairs: readonly AnalysisRelationshipPair[]
}>

export type AnalysisRelationshipPlot = Readonly<{
  fingerprint: string
  inputKey: string
  targetKey: string
  pearson: number | null
  spearman: number | null
  count: number
  points: readonly Readonly<{
    measurementId: number
    x: number
    y: number
  }>[]
}>

export type AnalysisProgressStage =
  'Measurement 조회' | 'Calculation Data 조회' | '데이터셋 구성' | '통계 계산' | '상관 분석'

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
      type: 'relationships'
      requestId: string
    }>
  | Readonly<{
      type: 'relationship-plot'
      requestId: string
      inputKey: string
      targetKey: string
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
      type: 'relationships'
      requestId: string
      result: AnalysisRelationshipsResult
    }>
  | Readonly<{
      type: 'relationship-plot'
      requestId: string
      result: AnalysisRelationshipPlot
    }>
  | Readonly<{
      type: 'error'
      requestId: string
      message: string
    }>
