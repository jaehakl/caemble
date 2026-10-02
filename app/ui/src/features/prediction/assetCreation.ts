import { predictionApi } from '@/api/prediction'
import { ApiError } from '@/api/http'
import type {
  PredictionDatasetRecord,
  PredictionDatasetSelection,
  PredictionModelRecord,
} from '@/contracts/api/prediction'
import type { RecordedDataRule, VarsSchemaEntry } from '@caemble/execution/cad/model'
import type { RecordedResultContracts } from '@caemble/execution/contracts/results'
import type { PredictionContext } from './predictionContextData'
import type { PredictionSetup } from './usePredictionModels'
import type { PredictionDirection } from './types'
import type { PredictionAssetController, PredictionAssetWork } from './assetManagement'
import { predictionFingerprint } from './data'
import { assertSavedPredictionCompatible, savedContractFromSource } from './savedModels'
import { submitPredictionTraining } from './assetOperations'

export type PredictionCreationInput = Readonly<{
  context: PredictionContext
  sourceHash: string
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  rules: readonly RecordedDataRule[]
  resultContracts: RecordedResultContracts
  setup: PredictionSetup
  name: string
  launcherId: string
  direction: PredictionDirection
  dataset?: PredictionDatasetRecord
  datasetRevision?: number
  previous?: PredictionModelRecord
  refreshDataset?: boolean
}>

export function predictionDatasetSelection(
  input: Omit<PredictionCreationInput, 'direction' | 'launcherId'>,
  requestId: string,
): PredictionDatasetSelection {
  return {
    request_id: requestId,
    name: input.dataset?.name || input.name.trim() || `Experiment ${input.context.experimentId} 학습 데이터`,
    experiment_id: input.context.experimentId,
    source_hash: input.sourceHash,
    vars_schema: input.varsSchema,
    calculation_ids: [],
    record_ids: [...new Set(input.setup.recordIds)].sort((a, b) => a - b),
    rules: input.rules,
    result_contracts: input.resultContracts,
    ...(input.dataset ? { expected_revision: input.dataset.current_revision } : {}),
  }
}

export function createPredictionModel(manager: PredictionAssetController, input: PredictionCreationInput) {
  if (!input.setup.recordIds.length) throw new Error('학습할 BoxGrid를 하나 이상 선택하세요.')
  if (input.previous?.direction === 'inverse') throw new Error('Inverse 모델은 지원 종료되어 관리만 가능합니다.')
  // These identities are captured by retries, including a lost create/reserve response.
  const datasetRequestId = crypto.randomUUID()
  const modelRequestId = crypto.randomUUID()
  const restoreRequestId = crypto.randomUUID()
  let reservationAttempted = false
  return manager.run(`model:${input.previous?.id ?? input.direction}:create`, '모델 만들고 사용', async (work) => {
    if (reservationAttempted) {
      try {
        const operation = await predictionApi.operation(modelRequestId, { signal: work.signal })
        work.operation(operation)
        await submitPredictionTraining(operation, work)
        if (!operation.revision || !operation.target_storage_id || !operation.target_launcher_id)
          throw new Error('예약한 모델 실행 위치를 확인하지 못했습니다.')
        return {
          operationId: operation.id,
          modelId: operation.asset_id,
          revision: operation.revision,
          route: { storageId: operation.target_storage_id, launcherId: operation.target_launcher_id },
        }
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error
      }
    }
    const remote = await work.connect(input.launcherId)
    const hello = remote.hello!
    let dataset = input.dataset
    if (!dataset || input.refreshDataset) {
      work.progress('학습 데이터 revision 확정 중')
      const selection = predictionDatasetSelection(input, datasetRequestId)
      if (dataset?.source_kind === 'local') {
        await remote.command(
          'dataset.sync',
          { datasetId: dataset.id, experimentId: input.context.experimentId },
          { requestId: crypto.randomUUID(), signal: work.signal },
        )
        await remote.inspect({ requestId: crypto.randomUUID(), signal: work.signal })
        dataset = (await predictionApi.datasets(input.context.experimentId)).find((item) => item.id === dataset!.id)
      } else
        dataset = dataset
          ? await predictionApi.syncDataset(dataset.id, selection, { signal: work.signal })
          : await predictionApi.createDataset(selection, { signal: work.signal })
    }
    if (!dataset) throw new Error('학습 데이터 등록을 확인하지 못했습니다. 작업을 다시 시도하세요.')
    const revision = input.refreshDataset
      ? dataset.current_revision
      : (input.datasetRevision ?? dataset.current_revision)
    const source = dataset.revisions.find((item) => item.revision === revision)
    if (!source?.payload_available || dataset.state !== 'active')
      throw new Error('선택한 Dataset revision의 원본을 사용할 수 없습니다.')
    const requiredRecordIds = [...new Set(input.setup.recordIds)].sort((a, b) => a - b)
    const frozen = savedContractFromSource(source.source_contracts)
    const contract = {
      ...frozen,
      records: Object.fromEntries(requiredRecordIds.map((id) => [id, frozen.records[id]])),
    }
    assertSavedPredictionCompatible(
      {
        modelId: '',
        modelRevision: 0,
        datasetId: dataset.id,
        datasetRevision: revision,
        direction: input.direction,
        fingerprint: '',
        contract,
      },
      input.context,
      input.varsSchema,
      requiredRecordIds,
    )
    const algorithm = hello.algorithmDescriptors.find((item) => item.kind === input.setup.algorithm.kind)
    if (!algorithm?.directions.includes(input.direction))
      throw new Error('이 Predictor에서 선택한 알고리즘의 Forward 학습을 지원하지 않습니다.')
    const meaning = {
      snapshotFingerprint: source.fingerprint,
      algorithm: {
        kind: input.setup.algorithm.kind,
        kMode: input.setup.algorithm.kMode,
        manualK: input.setup.algorithm.manualK,
        weighting: input.setup.algorithm.weighting,
      },
      implementationId: remote.id,
      implementationVersion: algorithm.implementationVersion,
      preprocessingVersion: algorithm.preprocessingVersion,
      contract,
      direction: input.direction,
      requiredRecordIds,
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(predictionFingerprint([meaning])))
    const fingerprint = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    const definition = { ...meaning, fingerprint }
    const local = source.replicas.find(
      (replica) => replica.storage_id === hello.storageId && ['present', 'unverified'].includes(replica.state),
    )
    const apiPayload =
      source.api_payload_available ?? (dataset.source_kind === 'server' && revision === dataset.current_revision)
    if (!local && !apiPayload) {
      const backup = source.replicas.find(
        (replica) =>
          replica.state === 'present' &&
          manager
            .getSnapshot()
            .storages.some((storage) => storage.storage_id === replica.storage_id && storage.kind === 'object_backup'),
      )
      if (!backup)
        throw new Error('이 장비에서 선택한 학습 데이터를 읽을 수 없습니다. 원본 장비를 선택하거나 백업을 복원하세요.')
      await restoreTrainingDataset(
        work,
        restoreRequestId,
        dataset.id,
        revision,
        backup.id,
        hello.storageId,
        hello.launcherId,
        remote,
      )
    }
    work.progress('새 모델 revision 예약 중')
    reservationAttempted = true
    const reserved = await predictionApi.reserve(
      {
        request_id: modelRequestId,
        name: input.name.trim() || input.previous?.name || `${dataset.name} · Forward`,
        direction: input.direction,
        dataset_id: dataset.id,
        dataset_revision: revision,
        definition,
        storage_id: hello.storageId,
        launcher_id: hello.launcherId,
        ...(input.previous ? { model_id: input.previous.id, expected_revision: input.previous.current_revision } : {}),
      },
      { signal: work.signal },
    )
    if (!reserved.operation_id || !reserved.reserved_revision)
      throw new Error('학습 작업 예약을 확인하지 못했습니다. 같은 작업을 다시 시도하세요.')
    const operation = await predictionApi.operation(reserved.operation_id, { signal: work.signal })
    work.operation(operation)
    await submitPredictionTraining(operation, work)
    return {
      operationId: operation.id,
      modelId: reserved.id,
      revision: reserved.reserved_revision,
      route: { storageId: hello.storageId, launcherId: hello.launcherId },
    }
  })
}

async function restoreTrainingDataset(
  work: PredictionAssetWork,
  requestId: string,
  datasetId: string,
  revision: number,
  sourceReplicaId: string,
  storageId: string,
  launcherId: string,
  remote: Awaited<ReturnType<PredictionAssetWork['connect']>>,
) {
  const operation = await predictionApi.createOperation(
    {
      request_id: requestId,
      kind: 'restore',
      asset_kind: 'dataset',
      asset_id: datasetId,
      revision,
      source_replica_id: sourceReplicaId,
      target_storage_id: storageId,
      target_launcher_id: launcherId,
    },
    { signal: work.signal },
  )
  work.operation(operation)
  if (['completed', 'succeeded'].includes(operation.state)) return
  if (!operation.grant) throw new Error('학습 데이터 복원 권한을 확인하지 못했습니다.')
  work.progress('선택한 학습 데이터 백업을 준비 장비에 복원 중')
  await remote.command(
    'artifact.restore',
    { operationId: operation.id, grant: operation.grant },
    { requestId: crypto.randomUUID(), signal: work.signal },
  )
}
