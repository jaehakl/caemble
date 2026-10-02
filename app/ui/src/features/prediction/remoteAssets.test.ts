import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/http'
import { reconcileRemoteAssets } from './remoteAssets'
import type { RemoteHello } from './remoteProtocol'

const mocks = vi.hoisted(() => ({ operation: vi.fn(), complete: vi.fn(), registerStorage: vi.fn() }))
vi.mock('@/api/prediction', () => ({ predictionApi: mocks }))
const hello = {
  storageId: 'storage',
  launcherId: 'launcher',
  datasets: [],
  models: [
    {
      modelId: 'model',
      revision: 2,
      operationId: 'operation',
      manifestChecksum: 'a'.repeat(64),
      profile: {},
    },
  ],
} as unknown as RemoteHello

beforeEach(() => {
  vi.clearAllMocks()
  mocks.registerStorage.mockResolvedValue(undefined)
  mocks.complete.mockResolvedValue(undefined)
})

it.each(['queued', 'completed'])('does not publish a server training receipt from hello (%s)', async (state) => {
  mocks.operation.mockResolvedValue({ id: 'operation', state, training: { jobId: 'server-job' } })
  await reconcileRemoteAssets(hello)
  expect(mocks.complete).not.toHaveBeenCalled()
})

it('retains legacy completed-file registration when the Operation ledger has no entry', async () => {
  mocks.operation.mockRejectedValue(new ApiError(404, 'not found', {}))
  await reconcileRemoteAssets(hello)
  expect(mocks.complete).toHaveBeenCalledWith(
    'model',
    2,
    expect.objectContaining({ request_id: 'operation' }),
    expect.anything(),
  )
})
