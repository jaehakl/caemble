import { predictionApi } from '@/api/prediction'
import { ApiError } from '@/api/http'
import type { PredictionModelRecord, PredictionStorage } from '@/contracts/api/prediction'
import type { SavedPredictionModel, PredictionExecutionRoute } from './execution'
import { savedPredictionReferenceSchema } from './savedModels'
import { profileJson, type RemoteArtifact, type RemoteHello } from './remoteProtocol'
import type { PredictionSetup } from './usePredictionModels'

export function registerRemoteArtifact(artifact: RemoteArtifact, signal?: AbortSignal) {
  return predictionApi.complete(
    artifact.modelId,
    artifact.revision,
    {
      request_id: artifact.operationId,
      manifest_sha256: artifact.manifestChecksum,
      files: artifact.files,
      profile: profileJson(artifact.profile),
      input_layouts: artifact.inputLayouts,
      output_layouts: artifact.outputLayouts,
      format_version: artifact.formatVersion,
      verified: artifact.verified !== false,
    },
    { signal },
  )
}

/** Reconcile completed local writes using the operation identities reserved before saving. */
export async function reconcileRemoteAssets(hello: RemoteHello, signal?: AbortSignal) {
  await predictionApi.registerStorage(
    { storage_id: hello.storageId, launcher_id: hello.launcherId, name: 'Predictor' },
    { signal },
  )
  for (const artifact of hello.models) {
    if (!('manifestChecksum' in artifact)) continue
    try {
      await registerRemoteArtifact(artifact, signal)
    } catch (error) {
      // Tombstones win over stale local registrations. Explicit deletion remains retryable.
      // A stale/conflicting receipt must not prevent explicit verification or removal.
      if (!(error instanceof ApiError) || ![404, 409, 410].includes(error.status)) throw error
    }
  }
  for (const dataset of hello.datasets) {
    if (!('fingerprint' in dataset) || dataset.sourceKind !== 'local') continue
    try {
      await predictionApi.registerDataset(
        {
          request_id: dataset.operationId,
          dataset_id: dataset.datasetId,
          revision: dataset.revision,
          ...(dataset.revision > 1 ? { expected_revision: dataset.revision - 1 } : {}),
          name: dataset.name,
          experiment_id: dataset.experimentId,
          source_hash: dataset.sourceHash,
          fingerprint: dataset.fingerprint,
          manifest_sha256: dataset.manifestChecksum,
          storage_id: hello.storageId,
          launcher_id: hello.launcherId,
          sample_count: dataset.sampleCount,
          source_contracts: dataset.sourceContracts,
          verified: dataset.verified !== false,
          payload_available: dataset.payloadAvailable !== false,
        },
        { signal },
      )
    } catch (error) {
      if (!(error instanceof ApiError) || ![404, 409, 410].includes(error.status)) throw error
    }
  }
}

export function savedModelReference(
  model: PredictionModelRecord,
  revision = model.current_revision,
): SavedPredictionModel {
  if (model.direction !== 'forward' || model.support_status === 'retired')
    throw new Error('Inverse 모델은 지원 종료되어 자산 관리만 가능합니다.')
  const item = model.revisions.find((entry) => entry.revision === revision && entry.state === 'ready')
  if (!item) throw new Error('완성된 저장 모델 revision이 없습니다.')
  return savedPredictionReferenceSchema.parse({
    modelId: model.id,
    modelRevision: revision,
    datasetId: item.dataset_id,
    datasetRevision: item.dataset_revision,
    direction: model.direction,
    fingerprint: item.definition.fingerprint,
    contract: item.definition.contract,
    manifestChecksum: item.artifact?.manifest_sha256,
  })
}

export function modelExecutionRoutes(
  model: PredictionModelRecord,
  revision: number,
  storages: readonly PredictionStorage[],
) {
  const item = model.revisions.find((entry) => entry.revision === revision)
  return (item?.replicas ?? []).flatMap((replica) => {
    const storage = storages.find((entry) => entry.storage_id === replica.storage_id)
    if (!storage || storage.kind !== 'predictor_local' || replica.state === 'deleted' || replica.state === 'deleting')
      return []
    return storage.accesses.map((access) => ({
      replicaId: replica.id,
      storageId: replica.storage_id,
      launcherId: access.launcher_id,
      name: storage.name,
      connected: access.connected,
      state: replica.state,
    }))
  })
}

export function preferredModelRoute(
  model: PredictionModelRecord,
  revision: number,
  storages: readonly PredictionStorage[],
  preferred?: PredictionExecutionRoute,
): PredictionExecutionRoute | undefined {
  const routes = modelExecutionRoutes(model, revision, storages)
  const previous =
    preferred &&
    routes.find((route) => route.storageId === preferred.storageId && route.launcherId === preferred.launcherId)
  const route = previous ?? (routes.length === 1 ? routes[0] : undefined)
  return route && { replicaId: route.replicaId, storageId: route.storageId, launcherId: route.launcherId }
}

export function setupUsingSavedModel(
  setup: PredictionSetup,
  model: PredictionModelRecord,
  revision: number,
  route: PredictionExecutionRoute | undefined,
): PredictionSetup {
  const reference = savedModelReference(model, revision)
  const availableRecordIds = Object.keys(reference.contract?.records ?? {}).map(Number)
  const selectedRecordIds =
    setup.models?.forward?.modelId === reference.modelId
      ? setup.recordIds.filter((id) => availableRecordIds.includes(id))
      : []
  return {
    ...setup,
    executionId: 'remote-knn',
    datasetId: reference.datasetId,
    recordIds: selectedRecordIds.length ? selectedRecordIds : availableRecordIds,
    models: { forward: reference },
    routes: { forward: route },
  }
}
