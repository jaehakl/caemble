import { predictionApi } from '@/api/prediction'
import { ApiError } from '@/api/http'
import type { PredictionModelRecord } from '@/contracts/api/prediction'
import type { SavedPredictionModel } from './execution'
import { savedPredictionReferenceSchema } from './savedModels'
import { profileJson, type RemoteArtifact, type RemoteHello } from './remoteProtocol'

export function registerRemoteArtifact(artifact: RemoteArtifact) {
  return predictionApi.complete(artifact.modelId, artifact.revision, {
    request_id: artifact.operationId,
    manifest_sha256: artifact.manifestChecksum,
    files: artifact.files,
    profile: profileJson(artifact.profile),
    input_layouts: artifact.inputLayouts,
    output_layouts: artifact.outputLayouts,
    format_version: artifact.formatVersion,
  })
}

/** Reconcile completed local writes using the operation identities reserved before saving. */
export async function reconcileRemoteAssets(hello: RemoteHello) {
  await predictionApi.registerStorage({ storage_id: hello.storageId, launcher_id: hello.launcherId, name: 'Predictor' })
  for (const artifact of hello.models) {
    if (!('manifestChecksum' in artifact)) continue
    try {
      await registerRemoteArtifact(artifact)
    } catch (error) {
      // Tombstones win over stale local registrations. Explicit deletion remains retryable.
      if (!(error instanceof ApiError) || (error.status !== 410 && error.status !== 404)) throw error
    }
  }
  for (const dataset of hello.datasets) {
    if (!('fingerprint' in dataset) || dataset.sourceKind !== 'local') continue
    try {
      await predictionApi.registerDataset({
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
      })
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 410 && error.status !== 404)) throw error
    }
  }
}

export function savedModelReference(
  model: PredictionModelRecord,
  revision = model.current_revision,
): SavedPredictionModel {
  const item = model.revisions.find((entry) => entry.revision === revision && entry.state === 'ready')
  if (!item || !model.storage_id || !model.launcher_id) throw new Error('완성된 저장 모델 revision이 없습니다.')
  return savedPredictionReferenceSchema.parse({
    modelId: model.id,
    modelRevision: revision,
    datasetId: item.dataset_id,
    datasetRevision: item.dataset_revision,
    direction: model.direction,
    fingerprint: item.definition.fingerprint,
    storageId: model.storage_id,
    launcherId: model.launcher_id,
    contract: item.definition.contract,
    manifestChecksum: item.artifact?.manifest_sha256,
  })
}
