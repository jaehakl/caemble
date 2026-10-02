import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  predictionAlgorithmSchema,
  predictionDatasetSchema,
  predictionLocationIdSchema,
  predictionModelSchema,
  predictionOperationSchema,
  predictionStorageSchema,
} from './prediction'

const assetId = '2de8d6f6-56ec-5d53-b8ea-8146eaefac43'
const requestId = '10000000-0000-4000-8000-000000000001'
const launcherId = '20000000-0000-4000-8000-000000000001'
const storageId = '30000000-0000-4000-8000-000000000001'
// Match migration 24's md5(text)::uuid instead of substituting an RFC UUID fixture.
const migratedReplicaId = createHash('md5')
  .update(`model/${assetId}/1/${storageId}`)
  .digest('hex')
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
const migratedStorageId = 'da148b6d-bf41-e61f-cd2f-123456789abc'
const replica = {
  id: migratedReplicaId,
  storage_id: migratedStorageId,
  state: 'unverified',
  manifest_sha256: null,
  artifact: null,
  checked_at: null,
  verified_at: null,
  delete_id: null,
}
const asset = {
  id: assetId,
  name: '기존 저장 모델',
  experiment_id: 1,
  state: 'active',
  current_revision: 1,
  delete_id: null,
}
const model = {
  ...asset,
  direction: 'forward',
  algorithm: 'knn',
  revisions: [
    {
      revision: 1,
      operation_id: requestId,
      state: 'ready',
      dataset_id: assetId,
      dataset_revision: 1,
      dataset_fingerprint: 'dataset',
      definition: { fingerprint: 'model' },
      source_contracts: {},
      artifact: null,
      replicas: [replica],
    },
  ],
}
const dataset = {
  ...asset,
  source_kind: 'server',
  revisions: [
    {
      revision: 1,
      fingerprint: 'dataset',
      payload_available: true,
      replicas: [replica],
    },
  ],
}
const storage = {
  storage_id: migratedStorageId,
  name: '서버 학습 데이터',
  kind: 'api_dataset',
  checked_at: null,
  accesses: [{ launcher_id: launcherId, connected: true, checked_at: null }],
}
const operation = {
  id: requestId,
  request_id: requestId,
  kind: 'restore',
  state: 'pending',
  stage: 'pending',
  asset_kind: 'model',
  asset_id: assetId,
  revision: 1,
  source_replica_id: migratedReplicaId,
  target_storage_id: migratedStorageId,
  target_launcher_id: launcherId,
  include_dataset: false,
  details: {},
  error: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  completed_at: null,
}

describe('Prediction migrated location contracts', () => {
  it('preserves optional native batch capability while accepting legacy descriptors', () => {
    const descriptor = {
      kind: 'knn',
      implementationVersion: 'knn-v1',
      preprocessingVersion: 'box-relative-v2',
      directions: ['forward'],
      representations: ['box-relative-v2'],
      resources: { training: {}, inference: {} },
    }
    expect(predictionAlgorithmSchema.parse({ ...descriptor, supportsNativeBatch: true }).supportsNativeBatch).toBe(true)
    expect(predictionAlgorithmSchema.parse(descriptor).supportsNativeBatch ?? false).toBe(false)
    const cpuFallbackResources = { training: { gpu_count: 0 }, inference: { gpu_count: 0 } }
    expect(predictionAlgorithmSchema.parse({ ...descriptor, cpuFallbackResources }).cpuFallbackResources).toEqual(
      cpuFallbackResources,
    )
  })
  it('preserves model revision names, Optimization origin and training lineage', () => {
    const lineage = { mode: 'rebuild', baseModel: { modelId: assetId, revision: 1 }, recipe: { seed: 7 } }
    const response = {
      ...model,
      revisions: [
        {
          ...model.revisions[0],
          version_name: 'Optimization update 1',
          origin_optimization_id: requestId,
          training_update: lineage,
        },
      ],
    }
    expect(predictionModelSchema.parse(response).revisions[0]).toMatchObject({
      version_name: 'Optimization update 1',
      origin_optimization_id: requestId,
      training_update: lineage,
    })
  })

  it('accepts migrated copy and storage IDs unchanged throughout asset and operation responses', () => {
    expect(z.uuid().safeParse(migratedReplicaId).success).toBe(false)
    expect(z.uuid().safeParse(migratedStorageId).success).toBe(false)
    expect(predictionModelSchema.parse(model).revisions[0].replicas[0]).toEqual(replica)
    expect(predictionDatasetSchema.parse(dataset).revisions[0].replicas[0]).toEqual(replica)
    expect(predictionStorageSchema.parse(storage)).toEqual(storage)
    expect(predictionOperationSchema.parse(operation)).toEqual(operation)
  })

  it.each(['not-an-id', migratedReplicaId.replace(/-/g, ''), ` ${migratedReplicaId}`, `${migratedReplicaId}x`])(
    'continues to reject malformed location IDs: %s',
    (invalid) => {
      expect(predictionLocationIdSchema.safeParse(invalid).success).toBe(false)
      expect(
        predictionModelSchema.safeParse({
          ...model,
          revisions: [{ ...model.revisions[0], replicas: [{ ...replica, id: invalid }] }],
        }).success,
      ).toBe(false)
      expect(predictionStorageSchema.safeParse({ ...storage, storage_id: invalid }).success).toBe(false)
      expect(predictionOperationSchema.safeParse({ ...operation, source_replica_id: invalid }).success).toBe(false)
    },
  )

  it('keeps logical asset, request, operation and launcher identities strict', () => {
    expect(predictionModelSchema.safeParse({ ...model, id: migratedReplicaId }).success).toBe(false)
    expect(predictionDatasetSchema.safeParse({ ...dataset, id: migratedReplicaId }).success).toBe(false)
    expect(predictionOperationSchema.safeParse({ ...operation, id: migratedReplicaId }).success).toBe(false)
    expect(predictionOperationSchema.safeParse({ ...operation, request_id: migratedReplicaId }).success).toBe(false)
    expect(predictionOperationSchema.safeParse({ ...operation, target_launcher_id: migratedReplicaId }).success).toBe(
      false,
    )
    expect(
      predictionStorageSchema.safeParse({
        ...storage,
        accesses: [{ ...storage.accesses[0], launcher_id: migratedReplicaId }],
      }).success,
    ).toBe(false)
  })
})
