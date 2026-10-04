import type { PredictionDatasetRecord } from '@/contracts/api/prediction'
import { fileState } from './modelFiles.fixture'

export const datasetFixture: PredictionDatasetRecord = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: '긴 한글 열전달 학습 데이터셋',
  experiment_id: 1,
  source_kind: 'server',
  state: 'active',
  current_revision: 2,
  delete_id: null,
  revisions: [2, 1].map((revision) => ({
    revision,
    fingerprint: `sha256:${String(revision).repeat(64)}`,
    sample_count: 10 * revision,
    payload_available: revision === 2,
    api_payload_available: revision === 2,
    source_contracts: {
      experimentId: 1,
      sourceHash: 'a'.repeat(64),
      varsSchema: { x: { shape: [], min: 0, max: 1 } },
      records: [{ id: 11, name: '온도' }],
      rules: [],
      resultContracts: {},
    },
    replicas:
      revision === 1
        ? []
        : [
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              storage_id: 'server',
              state: 'present',
              artifact: null,
              manifest_sha256: 'b'.repeat(64),
              checked_at: null,
              verified_at: null,
              delete_id: null,
            },
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              storage_id: 'storage',
              state: 'present',
              artifact: { files: [{ name: 'dataset.json', byteLength: 1234, sha256: 'c'.repeat(64) }] },
              manifest_sha256: 'c'.repeat(64),
              checked_at: null,
              verified_at: null,
              delete_id: null,
            },
          ],
  })),
}

export const datasetFileState = {
  ...fileState,
  datasets: [datasetFixture],
  storages: [
    ...fileState.storages,
    { storage_id: 'server', kind: 'api_dataset' as const, name: '서버 원본', checked_at: null, accesses: [] },
  ],
}
