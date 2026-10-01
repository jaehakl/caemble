import { z } from 'zod'
import { predictionApi } from '@/api/prediction'
import { ApiError } from '@/api/http'
import type { PredictionOperation, PredictionOperationRequest } from '@/contracts/api/prediction'
import type { PredictionAssetController, PredictionAssetWork } from './assetManagement'
import { registerRemoteArtifact } from './remoteAssets'
import { savedPredictionReferenceSchema } from './savedModels'
import { RemotePredictionError } from './remoteProtocol'

const datasetSourceSchema = z
  .object({
    kind: z.enum(['api_dataset', 'predictor_local', 'object_backup']),
    dataset_id: z.string(),
    revision: z.number().int().positive(),
    fingerprint: z.string(),
    storage_id: z.string().nullable().optional(),
    launcher_id: z.string().nullable().optional(),
  })
  .passthrough()

export function startPredictionAssetOperation(
  manager: PredictionAssetController,
  request: Omit<PredictionOperationRequest, 'request_id'>,
) {
  const body = { ...request, request_id: crypto.randomUUID() }
  let submitted = false
  const label =
    request.kind === 'backup'
      ? '모델 백업'
      : request.kind === 'restore'
        ? '복원·검증'
        : request.kind === 'verify'
          ? '저장 파일 확인'
          : '파일 삭제'
  return manager.run(
    `${request.kind}:${request.asset_id}:${request.revision ?? 'all'}:${request.replica_id ?? ''}`,
    label,
    async (work) => {
      if (submitted) {
        try {
          const current = await predictionApi.operation(body.request_id, { signal: work.signal })
          work.operation(current)
          if (['completed', 'succeeded'].includes(current.state)) return current
          if (current.state === 'cancelled') throw new Error('중단한 작업입니다. 필요하면 새 작업을 시작하세요.')
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error
        }
      }
      // Discover the target without expiring a transfer grant while waiting for resources.
      if (body.kind === 'restore') {
        if (!body.target_launcher_id) throw new Error('복원할 장비를 선택하세요.')
        const remote = await work.connect(body.target_launcher_id)
        if (body.target_storage_id && remote.hello!.storageId !== body.target_storage_id)
          throw new Error('연결된 장비의 저장소가 선택한 복원 목적지와 다릅니다.')
        body.target_storage_id = remote.hello!.storageId
      } else if (body.kind === 'backup') {
        if (!body.source_launcher_id) throw new Error('백업할 모델의 원본 장비를 선택하세요.')
        await work.connect(body.source_launcher_id)
        if (body.dataset_source_launcher_id && body.dataset_source_launcher_id !== body.source_launcher_id)
          await work.connect(body.dataset_source_launcher_id)
      }
      submitted = true
      const operation = await predictionApi.createOperation(body, { signal: work.signal })
      work.operation(operation)
      return executePredictionAssetOperation(manager, operation, work)
    },
  )
}

export function retryPredictionAssetOperation(manager: PredictionAssetController, operation: PredictionOperation) {
  return manager.run(`operation:${operation.id}`, '작업 다시 시도', async (work) => {
    const current = await predictionApi.operation(operation.id, { signal: work.signal })
    if (['completed', 'succeeded'].includes(current.state)) {
      work.operation(current)
      return current
    }
    const launcherId =
      operation.kind === 'restore' || operation.kind === 'prepare' || operation.kind === 'verify'
        ? operation.target_launcher_id
        : operation.details.source_launcher_id
    if (typeof launcherId === 'string') await work.connect(launcherId, operation.kind === 'prepare')
    // A prepare receipt may have been registered by the hello reconciliation.
    if (operation.kind === 'prepare') {
      const reconciled = await predictionApi.operation(operation.id, { signal: work.signal })
      if (reconciled.state === 'completed') {
        work.operation(reconciled)
        return reconciled
      }
    }
    const next = await predictionApi.retryOperation(operation.id, {}, { signal: work.signal })
    work.operation(next)
    return executePredictionAssetOperation(manager, next, work)
  })
}

async function executePredictionAssetOperation(
  manager: PredictionAssetController,
  operation: PredictionOperation,
  work: PredictionAssetWork,
) {
  if (['succeeded', 'completed'].includes(operation.state)) return operation
  if (operation.kind === 'prepare') return resumePreparedModel(manager, operation, work)
  const grant = operation.grant
  if (!grant) throw new Error('작업 전송 권한을 확인하지 못했습니다. 다시 시도하세요.')
  if (operation.kind === 'verify') {
    if (!operation.target_launcher_id) throw new Error('파일을 확인할 장비가 지정되지 않았습니다.')
    const remote = await work.connect(operation.target_launcher_id)
    if (remote.hello!.storageId !== operation.target_storage_id)
      throw new Error('등록된 저장소와 실제 저장소가 다릅니다.')
    const snapshot = manager.getSnapshot()
    const assets = operation.asset_kind === 'model' ? snapshot.models : snapshot.datasets
    const revision = assets
      .find((asset) => asset.id === operation.asset_id)
      ?.revisions.find((item) => item.revision === operation.revision)
    const replica = revision?.replicas.find((item) => item.storage_id === operation.target_storage_id)
    const result = z
      .object({
        state: z.enum(['present', 'missing', 'corrupt']),
        artifact: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(
        await remote.command(
          'artifact.verify',
          {
            kind: operation.asset_kind,
            identity: operation.asset_id,
            revision: operation.revision,
            manifestChecksum:
              replica?.manifest_sha256 ??
              snapshot.models
                .find((model) => model.id === operation.asset_id)
                ?.revisions.find((item) => item.revision === operation.revision)?.artifact?.manifest_sha256,
          },
          { requestId: crypto.randomUUID(), signal: work.signal },
        ),
      )
    const completed = await predictionApi.completeOperation(
      operation.id,
      { receipt: { operationId: operation.id, ...result } },
      { signal: work.signal },
    )
    work.operation(completed)
    return completed
  } else if (operation.kind === 'backup') {
    const launcherId = operation.details.source_launcher_id
    if (typeof launcherId !== 'string') throw new Error('백업할 원본 장비를 확인하지 못했습니다.')
    const remote = await work.connect(launcherId)
    const model = manager.getSnapshot().models.find((item) => item.id === operation.asset_id)
    const revision = model?.revisions.find((item) => item.revision === operation.revision)
    if (!revision) throw new Error('백업할 모델 revision을 찾을 수 없습니다.')
    const source = revision.replicas.find((item) => item.id === operation.source_replica_id)
    if (!source || source.storage_id !== remote.hello!.storageId)
      throw new Error('선택한 모델 복사본의 장비가 아닙니다.')
    const datasetSource = operation.include_dataset ? datasetSourceSchema.parse(operation.details.dataset_source) : null
    const modelRef = {
      modelId: operation.asset_id,
      revision: operation.revision,
      manifestChecksum: source.manifest_sha256 ?? revision.artifact?.manifest_sha256,
    }
    const sourcePayload =
      datasetSource?.kind === 'api_dataset'
        ? { grant: operation.dataset_grant }
        : datasetSource?.kind === 'object_backup'
          ? { backup: grant }
          : datasetSource
            ? {
                local: {
                  datasetId: datasetSource.dataset_id,
                  revision: datasetSource.revision,
                  fingerprint: datasetSource.fingerprint,
                },
              }
            : undefined
    const otherLauncher =
      datasetSource?.kind === 'predictor_local' && datasetSource.launcher_id && datasetSource.launcher_id !== launcherId
        ? datasetSource.launcher_id
        : null
    work.progress('파일 전송·checksum 검증 중')
    await remote.command(
      'artifact.backup',
      {
        operationId: operation.id,
        model: modelRef,
        includeDataset: operation.include_dataset,
        grant,
        datasetSource: sourcePayload,
        slots: otherLauncher ? ['model'] : operation.include_dataset ? ['model', 'dataset'] : ['model'],
      },
      { requestId: crypto.randomUUID(), signal: work.signal },
    )
    if (otherLauncher) {
      const dataRemote = await work.connect(otherLauncher)
      if (dataRemote.hello!.storageId !== datasetSource!.storage_id)
        throw new Error('선택한 학습 데이터 저장소가 연결된 장비와 다릅니다.')
      await dataRemote.command(
        'artifact.backup',
        {
          operationId: operation.id,
          model: modelRef,
          includeDataset: true,
          grant,
          datasetSource: sourcePayload,
          slots: ['dataset'],
        },
        { requestId: crypto.randomUUID(), signal: work.signal },
      )
    }
    const completed = await predictionApi.operation(operation.id, { signal: work.signal })
    if (['completed', 'succeeded'].includes(completed.state)) {
      for (const participant of otherLauncher ? [launcherId, otherLauncher] : [launcherId]) {
        const connection = await work.connect(participant)
        await connection
          .command(
            'operation.inspect',
            { operationId: operation.id, grant },
            { requestId: crypto.randomUUID(), signal: work.signal },
          )
          .catch(() => undefined)
      }
    }
  } else if (operation.kind === 'restore') {
    if (!operation.target_launcher_id) throw new Error('복원 대상 장비가 지정되지 않았습니다.')
    const remote = await work.connect(operation.target_launcher_id)
    if (remote.hello!.storageId !== operation.target_storage_id)
      throw new Error('복원 대상 저장소 identity가 다릅니다.')
    work.progress('백업 다운로드·검증·등록 중')
    await remote.command(
      'artifact.restore',
      { operationId: operation.id, grant },
      { requestId: crypto.randomUUID(), signal: work.signal },
    )
  } else if (operation.kind === 'delete_replica' || operation.kind === 'delete_asset') {
    const state = manager.getSnapshot()
    const asset =
      operation.asset_kind === 'model'
        ? state.models.find((item) => item.id === operation.asset_id)
        : state.datasets.find((item) => item.id === operation.asset_id)
    const replicas =
      asset?.revisions.flatMap((revision) =>
        revision.replicas.map((replica) => ({ ...replica, revision: revision.revision })),
      ) ?? []
    for (const replica of replicas) {
      if (operation.kind === 'delete_replica' && replica.id !== operation.details.replica_id) continue
      if (replica.state === 'deleted') continue
      const storage = state.storages.find((item) => item.storage_id === replica.storage_id)
      if (storage?.kind !== 'predictor_local') continue
      const access = storage.accesses.find((item) => item.connected)
      if (!access) continue // Server retains delete_pending until this location is reachable.
      const remote = await work.connect(access.launcher_id)
      if (remote.hello!.storageId !== replica.storage_id) continue
      work.progress(`${storage.name} 파일 삭제 확인 중`)
      try {
        await remote.command(
          'artifact.remove',
          {
            operationId: operation.id,
            grant,
            replicaId: replica.id,
            kind: operation.asset_kind,
            identity: operation.asset_id,
            revision: replica.revision,
          },
          { requestId: crypto.randomUUID(), signal: work.signal },
        )
      } catch (error) {
        if (!(error instanceof RemotePredictionError) || error.code !== 'copy-in-use') throw error
        work.progress(`${storage.name} 사용 종료 후 삭제 확인 대기`)
      }
    }
  } else throw new Error('이 작업은 자산 상세에서 저장 파일을 확인한 뒤 다시 시도하세요.')
  const result = await predictionApi.operation(operation.id, { signal: work.signal })
  work.operation(result)
  return result
}

async function resumePreparedModel(
  manager: PredictionAssetController,
  operation: PredictionOperation,
  work: PredictionAssetWork,
) {
  if (!operation.target_launcher_id) throw new Error('모델을 준비하던 장비를 확인할 수 없습니다.')
  const remote = await work.connect(operation.target_launcher_id, true)
  if (remote.hello!.storageId !== operation.target_storage_id) throw new Error('모델 준비 저장소가 변경되었습니다.')
  const model = (await predictionApi.models(manager.experimentId!, { signal: work.signal })).find(
    (item) => item.id === operation.asset_id,
  )
  const revision = model?.revisions.find((item) => item.revision === operation.revision)
  if (!model || !revision || revision.state !== 'reserved')
    throw new Error('이 준비 작업은 더 이상 유효하지 않습니다. 모델 목록을 확인하세요.')
  const definition = z
    .object({
      fingerprint: z.string(),
      snapshotFingerprint: z.string(),
      implementationId: z.string(),
      implementationVersion: z.string(),
      preprocessingVersion: z.string(),
      calculationIds: z.array(z.number()).optional(),
      requiredRecordIds: z.array(z.number()).optional(),
      contract: savedPredictionReferenceSchema.shape.contract.optional(),
      algorithm: z.object({
        kind: z.literal('knn'),
        kMode: z.enum(['auto', 'manual']),
        manualK: z.number().int().positive(),
        weighting: z.enum(['uniform', 'distance']),
        calculationWeights: z.record(z.string(), z.number().nonnegative()),
      }),
    })
    .passthrough()
    .parse(revision.definition)
  const dataset = (await predictionApi.datasets(manager.experimentId!, { signal: work.signal })).find(
    (item) => item.id === revision.dataset_id,
  )
  const source = dataset?.revisions.find((item) => item.revision === revision.dataset_revision)
  if (!dataset || !source?.payload_available)
    throw new Error(
      '준비 당시의 Dataset 원본이 없습니다. 완료된 파일을 먼저 확인하거나 동일 revision 백업을 복원하세요.',
    )
  const local = source.replicas.some(
    (copy) => copy.storage_id === remote.hello!.storageId && ['present', 'unverified'].includes(copy.state),
  )
  const grant =
    !local && source.api_payload_available
      ? await predictionApi.grant(dataset.id, source.revision, { signal: work.signal })
      : undefined
  if (!local && !grant)
    throw new Error('준비 당시 Dataset을 이 장비에서 사용할 수 없습니다. 같은 revision을 복원한 뒤 재시도하세요.')
  try {
    const prepared = await remote.prepare(
      {
        kind: 'dataset-revision',
        direction: model.direction,
        fingerprint: source.fingerprint,
        dataset: grant
          ? { grant }
          : { datasetId: dataset.id, revision: source.revision, fingerprint: source.fingerprint },
        model: { modelId: model.id, revision: revision.revision, operationId: revision.operation_id, name: model.name },
      },
      definition,
      { requestId: crypto.randomUUID(), signal: work.signal },
    )
    try {
      await registerRemoteArtifact(prepared.artifact)
    } finally {
      await remote.release(prepared.instance)
    }
    const result = await predictionApi.operation(operation.id, { signal: work.signal })
    work.operation(result)
    return result
  } finally {
    if (grant) await predictionApi.releaseGrant(dataset.id, grant.grant_id)
  }
}

export function verifyPredictionReplica(
  manager: PredictionAssetController,
  assetKind: 'model' | 'dataset',
  assetId: string,
  revision: number,
  replicaId: string,
) {
  return startPredictionAssetOperation(manager, {
    kind: 'verify',
    asset_kind: assetKind,
    asset_id: assetId,
    revision,
    replica_id: replicaId,
  })
}
