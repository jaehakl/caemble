// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { predictionTrainingCommand } from './predictionTraining'
import type { CommandContext } from './types'

const api = vi.hoisted(() => ({
  datasets: vi.fn(),
  algorithms: vi.fn(),
  reserve: vi.fn(),
  operation: vi.fn(),
  submitTraining: vi.fn(),
  cancelOperation: vi.fn(),
}))
vi.mock('@/api/prediction', () => ({ createPredictionApi: () => api }))
const ids = {
  dataset: '11111111-1111-4111-8111-111111111111',
  storage: '22222222-2222-4222-8222-222222222222',
  launcher: '33333333-3333-4333-8333-333333333333',
  request: '44444444-4444-4444-8444-444444444444',
  model: '55555555-5555-4555-8555-555555555555',
  job: '66666666-6666-4666-8666-666666666666',
}
const config = {
  name: 'MLP fixture',
  dataset_id: ids.dataset,
  dataset_revision: 2,
  storage_id: ids.storage,
  launcher_id: ids.launcher,
  record_ids: [12, 10, 10],
  quality_validation: true,
  algorithm: { kind: 'mlp', hiddenLayers: [32, 32], epochs: 500, batchSize: 32, learningRate: 0.001, seed: 0 },
}
const source = {
  revision: 2,
  fingerprint: 'sha256:frozen',
  payload_available: true,
  api_payload_available: true,
  source_contracts: {
    experimentId: 7,
    varsSchema: { x: { shape: [], min: 0, max: 1 } },
    records: [
      { id: 10, contract_hash: 'ten' },
      { id: 12, contract_hash: 'twelve' },
    ],
  },
  replicas: [{ storage_id: ids.storage, state: 'present' }],
}
const operation = {
  id: ids.request,
  request_id: ids.request,
  kind: 'prepare',
  asset_kind: 'model',
  asset_id: ids.model,
  revision: 1,
  state: 'pending',
  stage: 'preparing',
  error: null,
  grant: { token: 'must-not-print' },
  details: { token: 'must-not-print' },
  training: { jobId: null, cleanupPending: false, resources: { gpu_count: 1 }, grant: { token: 'must-not-print' } },
}
let directory: string
let context: CommandContext

beforeEach(async () => {
  vi.resetAllMocks()
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  directory = await mkdtemp(path.join(os.tmpdir(), 'caemble-mlp-cli-'))
  const file = path.join(directory, 'training.json')
  await writeFile(file, JSON.stringify(config), 'utf8')
  context = {
    environment: {} as CommandContext['environment'],
    options: { config: file, 'request-id': ids.request },
    args: [ids.request],
    signal: new AbortController().signal,
    client: vi.fn(),
  }
  api.datasets.mockResolvedValue([{ id: ids.dataset, state: 'active', source_kind: 'server', revisions: [source] }])
  api.algorithms.mockResolvedValue([
    { kind: 'mlp', implementationVersion: 'mlp-v1', preprocessingVersion: 'box-relative-v2', directions: ['forward'] },
  ])
  api.reserve.mockResolvedValue({ id: ids.model, operation_id: ids.request, reserved_revision: 1 })
  api.operation.mockResolvedValue(operation)
  api.submitTraining.mockResolvedValue({
    ...operation,
    state: 'queued',
    training: { ...operation.training, jobId: ids.job },
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('server-owned Prediction CLI', () => {
  it('requires quality validation when omitted and rejects an explicit opt-out before network access', async () => {
    await writeFile(
      String(context.options.config),
      JSON.stringify({ ...config, quality_validation: undefined }),
      'utf8',
    )
    await predictionTrainingCommand('train', context)
    expect(api.reserve.mock.calls[0][0].definition.qualityValidation.version).toBe(2)
    vi.clearAllMocks()
    await writeFile(String(context.options.config), JSON.stringify({ ...config, quality_validation: false }), 'utf8')
    await expect(predictionTrainingCommand('train', context)).rejects.toThrow()
    expect(api.datasets).not.toHaveBeenCalled()
    expect(api.reserve).not.toHaveBeenCalled()
  })
  it('derives the frozen definition and requests API source even with a local replica', async () => {
    const result = await predictionTrainingCommand('train', context)
    const body = api.reserve.mock.calls[0][0]
    expect(body).toMatchObject({
      request_id: ids.request,
      dataset_source: 'api',
      dataset_revision: 2,
      definition: {
        algorithm: config.algorithm,
        requiredRecordIds: [10, 12],
        snapshotFingerprint: source.fingerprint,
        qualityValidation: { version: 2, minimumGroups: 5 },
        implementationVersion: 'mlp-v1',
      },
    })
    expect(body.definition.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(api.algorithms).toHaveBeenCalledWith({ signal: context.signal }, ids.launcher)
    expect(result).toMatchObject({ operation_id: ids.request, job_id: ids.job, state: 'queued' })
    expect(JSON.stringify(result)).not.toContain('must-not-print')
    await predictionTrainingCommand('train', context)
    expect(api.reserve.mock.calls[1][0]).toEqual(body)
  })

  it('returns an already submitted or failed request without resubmitting it', async () => {
    api.operation.mockResolvedValue({
      ...operation,
      state: 'failed',
      error: 'training failed',
      training: { ...operation.training, jobId: ids.job },
    })
    expect(await predictionTrainingCommand('train', context)).toMatchObject({ state: 'failed' })
    expect(api.submitTraining).not.toHaveBeenCalled()
  })

  it('rejects an unavailable API revision before reserving', async () => {
    api.datasets.mockResolvedValue([
      {
        id: ids.dataset,
        state: 'active',
        source_kind: 'server',
        revisions: [{ ...source, api_payload_available: false }],
      },
    ])
    await expect(predictionTrainingCommand('train', context)).rejects.toThrow('retained API payload')
    expect(api.reserve).not.toHaveBeenCalled()
  })

  it('rejects unsupported fields and invalid hyperparameters before network access', async () => {
    await writeFile(
      String(context.options.config),
      JSON.stringify({ ...config, algorithm: { ...config.algorithm, epochs: true } }),
    )
    await expect(predictionTrainingCommand('train', context)).rejects.toThrow()
    expect(api.datasets).not.toHaveBeenCalled()
  })

  it('projects status without operation or training grants', async () => {
    const result = await predictionTrainingCommand('status', context)
    expect(result).toMatchObject({ operation_id: ids.request, cleanup_pending: false })
    expect(JSON.stringify(result)).not.toMatch(/token|grant|must-not-print/)
  })

  it('cancels only a confirmed training operation', async () => {
    api.operation.mockResolvedValue({ ...operation, kind: 'backup' })
    await expect(predictionTrainingCommand('cancel', context)).rejects.toThrow('not a model training')
    expect(api.cancelOperation).not.toHaveBeenCalled()
    api.operation.mockResolvedValue(operation)
    api.cancelOperation.mockResolvedValue({ ...operation, state: 'cancelled' })
    expect(await predictionTrainingCommand('cancel', context)).toMatchObject({ state: 'cancelled' })
  })

  it('times out observation without cancelling training', async () => {
    await expect(predictionTrainingCommand('watch', { ...context, options: { timeout: '.01' } })).rejects.toMatchObject(
      { exitCode: 5 },
    )
    expect(api.cancelOperation).not.toHaveBeenCalled()
  })

  it('reports completed observation and omits credentials from snapshots', async () => {
    api.operation.mockResolvedValue({ ...operation, state: 'completed' })
    await predictionTrainingCommand('watch', context)
    expect(vi.mocked(process.stdout.write).mock.calls.flat().join('')).not.toMatch(/must-not-print|token|grant/)
    expect(api.cancelOperation).not.toHaveBeenCalled()
  })
})
