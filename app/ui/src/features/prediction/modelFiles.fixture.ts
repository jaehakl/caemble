import type { PredictionAssetsSnapshot } from './assetManagement'

export const fileState = {
  models: [
    {
      id: 'model',
      name: '긴 한글 온도 예측 모델',
      direction: 'forward',
      experiment_id: 1,
      state: 'active',
      current_revision: 10,
      revisions: [2, 10].map((revision) => ({
        revision,
        state: 'ready',
        dataset_id: 'dataset',
        dataset_revision: 1,
        definition: { fingerprint: 'definition', algorithm: {} },
        source_contracts: {},
        artifact: { files: [{ name: 'x.npy', byteLength: revision * 100, sha256: 'a'.repeat(64) }] },
        replicas:
          revision === 2
            ? []
            : [
                {
                  id: 'copy',
                  storage_id: 'storage',
                  state: 'present',
                  checked_at: '2026-10-01T01:00:00Z',
                  delete_id: null,
                },
              ],
      })),
    },
  ],
  storages: [
    {
      storage_id: 'storage',
      kind: 'predictor_local',
      name: '연구실 저장소',
      accesses: [
        { launcher_id: 'one', connected: true },
        { launcher_id: 'two', connected: false },
      ],
    },
  ],
  launchers: [
    { id: 'one', launcher_name: '장비 A' },
    { id: 'two', launcher_name: '장비 B' },
  ],
  datasets: [],
  operations: [],
  tasks: [],
  listErrors: {},
  loading: false,
  error: null,
  launchersLoaded: true,
} as unknown as PredictionAssetsSnapshot
