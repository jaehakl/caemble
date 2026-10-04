import { z } from 'zod'
import { predictionApi } from '@/api/prediction'
import { ApiError } from '@/api/http'
import {
  predictionDatasetSourceSchema,
  type PredictionDatasetRecord,
  type PredictionDatasetSelection,
} from '@/contracts/api/prediction'
import type { PredictionAssetController, PredictionAssetsSnapshot, PredictionAssetWork } from './assetManagement'

export function datasetTrainingReason(state: PredictionAssetsSnapshot, datasetId: string) {
  const busy = state.operations.some(
    (operation) =>
      operation.kind === 'prepare' &&
      operation.details.dataset_id === datasetId &&
      (operation.training?.cleanupPending ||
        !['completed', 'succeeded', 'failed', 'interrupted', 'cancelled', 'superseded'].includes(operation.state)),
  )
  return busy ? '모델 학습에서 사용 중입니다. 학습·프로세스 정리가 끝난 뒤 갱신·삭제할 수 있습니다.' : null
}

export function savedDatasetSelection(dataset: PredictionDatasetRecord, requestId: string): PredictionDatasetSelection {
  const revision = dataset.revisions.find((item) => item.revision === dataset.current_revision)
  const parsed = predictionDatasetSourceSchema.safeParse(revision?.source_contracts)
  if (!parsed.success || parsed.data.experimentId !== dataset.experiment_id || !parsed.data.records.length)
    throw new Error('저장된 Dataset 출처 계약을 확인할 수 없습니다. 원본 Experiment에서 새 Dataset을 만드세요.')
  const source = parsed.data
  return {
    request_id: requestId,
    name: dataset.name,
    experiment_id: dataset.experiment_id,
    source_hash: source.sourceHash,
    vars_schema: source.varsSchema,
    record_ids: source.records.map((record) => record.id),
    calculation_ids: [],
    rules: source.rules,
    result_contracts: source.resultContracts,
    expected_revision: dataset.current_revision,
  }
}

export async function datasetRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      error.message = `${error.message}\n목록을 새로고침하고 현재 revision과 사용 중인 작업을 확인하세요.`
    throw error
  }
}

async function connectDatasetSource(
  manager: PredictionAssetController,
  dataset: PredictionDatasetRecord,
  work: PredictionAssetWork,
) {
  const state = manager.getSnapshot()
  const revision = dataset.revisions.find((item) => item.revision === dataset.current_revision)
  for (const replica of revision?.replicas ?? []) {
    if (!['present', 'unverified'].includes(replica.state)) continue
    const storage = state.storages.find(
      (item) => item.storage_id === replica.storage_id && item.kind === 'predictor_local',
    )
    const access = storage?.accesses.find((item) => item.connected)
    if (!access) continue
    const remote = await work.connect(access.launcher_id)
    if (remote.hello?.storageId !== storage?.storage_id)
      throw new Error('원본 Dataset 저장소와 장비의 저장소가 다릅니다.')
    return remote
  }
  throw new Error('원본 Dataset 장비를 연결하세요.')
}

export function refreshPredictionDataset(
  manager: PredictionAssetController,
  dataset: PredictionDatasetRecord,
  preview: boolean,
) {
  const requestId = crypto.randomUUID()
  return manager.run(
    `${preview ? 'preview' : 'sync'}:${dataset.id}`,
    preview ? '새 데이터 확인' : '학습 데이터 갱신',
    async (work) => {
      const body = dataset.source_kind === 'server' ? savedDatasetSelection(dataset, requestId) : undefined
      if (body)
        return datasetRequest(() =>
          preview
            ? predictionApi.previewDataset(dataset.id, body, { signal: work.signal })
            : predictionApi.syncDataset(dataset.id, body, { signal: work.signal }).then(() => undefined),
        )
      const remote = await connectDatasetSource(manager, dataset, work)
      const result = await remote.command(
        preview ? 'dataset.preview' : 'dataset.sync',
        { datasetId: dataset.id, experimentId: dataset.experiment_id },
        { requestId, signal: work.signal },
      )
      if (preview) return z.object({ added: z.number(), changed: z.number(), removed: z.number() }).parse(result)
      await remote.inspect({ requestId: crypto.randomUUID(), signal: work.signal })
      return undefined
    },
    dataset.experiment_id,
  )
}

export function importPredictionDataset(
  manager: PredictionAssetController,
  experimentId: number,
  launcherId: string,
  importId: string,
) {
  const requestId = crypto.randomUUID()
  return manager.run(
    `import:${launcherId}:${importId}`,
    '외부 Dataset 가져오기',
    async (work) => {
      const remote = await work.connect(launcherId)
      const result = z
        .object({ dataset: z.object({ datasetId: z.string() }) })
        .parse(await remote.command('dataset.import', { importId, experimentId }, { requestId, signal: work.signal }))
      await remote.inspect({ requestId: crypto.randomUUID(), signal: work.signal })
      return result.dataset.datasetId
    },
    experimentId,
  )
}
