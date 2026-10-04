import { predictionApi } from '@/api/prediction'
import { catalogApi } from '@/api/catalog'
import type { SavedExperimentRecord, ExperimentRecordedDataRecord } from '@caemble/execution/contracts/api/experiment'
import type { PredictionDatasetSelection } from '@/contracts/api/prediction'
import { createCadSourceDocument } from '@caemble/execution/cad/source/document'
import { generateRandomVars } from '@caemble/execution/cad/model'
import { inspectDocument, preparePredictionDocument } from '@/lib/cad/execution/evaluateDocument'
import { createCachedCatalogRuntimeSliceResolver } from '@caemble/execution/catalog/references'
import { recordedDataRules } from '@/features/measurement/recordedData'
import type { PredictionAssetController } from './assetManagement'
import { datasetRequest } from './datasetManagement'

const catalogFetcher = createCachedCatalogRuntimeSliceResolver(catalogApi.runtimeSlice)

export function createStandaloneDataset(
  manager: PredictionAssetController,
  input: Readonly<{
    experiment: Pick<SavedExperimentRecord, 'id' | 'source_hash' | 'source_bundle'>
    records: readonly ExperimentRecordedDataRecord[]
    recordIds: readonly number[]
    name: string
  }>,
) {
  const requestId = crypto.randomUUID()
  let body: PredictionDatasetSelection | undefined
  return manager.run(
    `dataset:create:${input.experiment.id}`,
    '학습 데이터 만들기',
    async (work) => {
      if (!body) {
        const selected = input.records.filter((record) => input.recordIds.includes(record.id))
        if (!selected.length || selected.length !== input.recordIds.length)
          throw new Error('학습할 Record를 하나 이상 선택하세요.')
        if (!input.name.trim() || input.name.trim().length > 200)
          throw new Error('데이터셋 이름은 1~200자로 입력하세요.')
        work.progress('저장된 Experiment의 학습 데이터 계약 확인 중')
        const document = createCadSourceDocument('experiment', input.experiment.source_bundle)
        const catalog = await catalogFetcher(document.sourceBundle)
        const options = { catalog, signal: work.signal, timeoutMs: 30000 as const }
        const inspected = await inspectDocument(document, options)
        const candidate = await preparePredictionDocument(
          { document, vars: generateRandomVars(inspected.varsSchema) },
          selected.map((record) => record.name),
          options,
        )
        body = {
          request_id: requestId,
          name: input.name.trim(),
          experiment_id: input.experiment.id,
          source_hash: input.experiment.source_hash,
          vars_schema: candidate.varsSchema,
          record_ids: selected.map((record) => record.id),
          calculation_ids: [],
          rules: recordedDataRules(candidate.simulationProgram.recordedData, 'prediction.forward'),
          result_contracts: candidate.simulationProgram.resultContracts,
        }
      }
      work.progress('학습 데이터 snapshot 저장 중')
      return datasetRequest(() => predictionApi.createDataset(body!, { signal: work.signal }))
    },
    input.experiment.id,
  )
}
