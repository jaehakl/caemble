// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCaembleClient } from '@/api/http'
import { cadSourceHash } from '@caemble/execution/cad/source/document'
import {
  hybridOptimizationFixture,
  optimizationFixture,
  trialFixture,
} from '@/features/optimization/fixtures.test-support'
import { optimizationCommand } from './optimization'
import type { CommandContext } from './types'

let directory: string
let context: CommandContext
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>
const variables = {
  radius: 2,
  tensor: [
    [1, 2],
    [3, 4],
  ],
}
const varsSchema = { radius: { shape: [], min: 1, max: 4 }, tensor: { shape: [2, 2], min: 0, max: 5 } }
const config = {
  objective: { calculation_id: 12, direction: 'maximize' },
  axes: [{ name: 'tensor', indices: [0, 1], fixed: true }],
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'caemble-optimization-cli-'))
  const source_bundle = { files: { 'experiment.tsx': 'export default null' } }
  const source_hash = await cadSourceHash({ kind: 'experiment', sourceBundle: source_bundle })
  const bytes = JSON.stringify({
    measurement: { kind: 'measurement', experiment: { sourceHash: source_hash, varsSchema, variables } },
  })
  await mkdir(path.join(directory, 'items'))
  await writeFile(path.join(directory, 'items/1.json'), bytes)
  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      kind: 'caemble.build',
      version: 2,
      builder_version: '2',
      mode: 'candidate',
      source_bundle,
      source_hash,
      catalog_revision: 'fixture',
      items: [
        {
          index: 1,
          file: 'items/1.json',
          byte_length: Buffer.byteLength(bytes),
          input_hash: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }),
  )
  await writeFile(path.join(directory, 'optimization.json'), JSON.stringify(config))
  fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(optimizationFixture))
  const client = createCaembleClient({
    baseUrl: 'https://api.example',
    auth: { kind: 'bearer', token: 'private-key' },
    fetch,
  })
  context = {
    args: [directory],
    options: { experiment: '7', config: path.join(directory, 'optimization.json') },
    environment: {
      repo: directory,
      cae: '',
      python: '',
      cli: '',
      worker: '',
      envPath: '',
      apiUrl: client.baseUrl,
      token: 'private-key',
    },
    client: () => client,
    signal: new AbortController().signal,
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

it('submits artifact Vars without evaluating them and replays an unacknowledged creation', async () => {
  fetch.mockRejectedValueOnce(new TypeError('response lost'))
  await expect(optimizationCommand('create', context)).rejects.toThrow('response lost')
  await optimizationCommand('create', context)
  await optimizationCommand('create', context)
  const bodies = fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)))
  expect(new Set(bodies.map((body) => body.request_id)).size).toBe(1)
  expect(bodies[0]).toMatchObject({ experiment_id: 7, initial_vars: variables, vars_schema: varsSchema, ...config })
  expect(bodies[0].max_trials).toBeUndefined() // Server owns the default budget and all omitted axes.
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/cae/optimizations'))).toBe(true)
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer private-key')
  const receipt = await readFile(`${context.options.config}.submission.json`, 'utf8')
  expect(receipt).not.toContain('private-key')
  expect(JSON.parse(receipt)).toMatchObject({ acknowledged: true, optimizationId: optimizationFixture.id })
  await writeFile(String(context.options.config), JSON.stringify({ ...config, max_trials: 4 }))
  await expect(optimizationCommand('create', context)).rejects.toThrow('different settings')
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('requires an explicit artifact item when multiple candidates exist', async () => {
  const file = path.join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.items.push({ ...manifest.items[0], index: 2, file: 'items/2.json' })
  await writeFile(file, JSON.stringify(manifest))
  await writeFile(path.join(directory, 'items/2.json'), await readFile(path.join(directory, 'items/1.json')))
  await expect(optimizationCommand('create', context)).rejects.toThrow('--item')
  await optimizationCommand('create', { ...context, options: { ...context.options, item: '2' } })
  expect(fetch).toHaveBeenCalledOnce()
})

it('sends a fixed Hybrid model revision, Solver budget and output quality conditions from configuration', async () => {
  const hybrid = {
    model_id: 'model',
    model_revision: 3,
    replica_id: 'replica',
    launcher_id: 'launcher',
    max_solver_runs: 8,
    quality_requirements: [{ recordId: 10, component: 'value', rmseMaximum: 0.001 }],
  }
  await writeFile(String(context.options.config), JSON.stringify({ ...config, hybrid }))
  await optimizationCommand('create', context)
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).hybrid).toEqual(hybrid)
})

it('replays ambiguous Evaluation retries separately from legacy Trial retries', async () => {
  context = { ...context, args: ['optimization-1'], options: { evaluation: 'evaluation-2' } }
  fetch.mockRejectedValueOnce(new TypeError('response lost'))
  await expect(optimizationCommand('retry', context)).rejects.toThrow('response lost')
  await optimizationCommand('retry', context)
  await optimizationCommand('retry', context)
  const ids = fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).request_id)
  expect(ids[0]).toBe(ids[1])
  expect(ids[2]).not.toBe(ids[1])
  expect(
    fetch.mock.calls.every(([url]) =>
      String(url).endsWith('/cae/optimizations/optimization-1/evaluations/evaluation-2/retry'),
    ),
  ).toBe(true)
  await expect(
    optimizationCommand('retry', { ...context, options: { trial: 'trial-1', evaluation: 'evaluation-2' } }),
  ).rejects.toThrow('Choose either')
})

it('replays a lost model update and creates the next update only after acknowledgement', async () => {
  context = { ...context, args: ['optimization-1'], options: {} }
  fetch.mockRejectedValueOnce(new TypeError('response lost'))
  fetch.mockImplementation(async () => Response.json(hybridOptimizationFixture))
  await expect(optimizationCommand('model-update', context)).rejects.toThrow('response lost')
  const result = await optimizationCommand('model-update', context)
  await optimizationCommand('model-update', context)
  const bodies = fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)))
  expect(bodies[0].request_id).toBe(bodies[1].request_id)
  expect(bodies[2].request_id).not.toBe(bodies[1].request_id)
  expect(bodies.every((body) => body.update_mode === 'rebuild')).toBe(true)
  expect(
    fetch.mock.calls.every(([url]) => String(url).endsWith('/cae/optimizations/optimization-1/model-updates')),
  ).toBe(true)
  expect(result).toMatchObject({ model_update: hybridOptimizationFixture.model_update })
})

it('preserves an explicit model update request ID across acknowledged repeats', async () => {
  const requestId = randomUUID()
  context = { ...context, args: ['optimization-1'], options: { 'request-id': requestId } }
  await optimizationCommand('model-update', context)
  await optimizationCommand('model-update', context)
  expect(fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).request_id)).toEqual([
    requestId,
    requestId,
  ])
})

it('sends the requested model update mode and rejects unknown modes before submission', async () => {
  context = { ...context, args: ['optimization-1'], options: { 'update-mode': 'incremental' } }
  await optimizationCommand('model-update', context)
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).update_mode).toBe('incremental')
  context = { ...context, options: { 'update-mode': 'unknown' } }
  await expect(optimizationCommand('model-update', context)).rejects.toThrow('--update-mode')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('reuses a lost retry request and makes the next acknowledged retry explicit', async () => {
  context = { ...context, args: ['optimization-1'], options: { trial: 'trial-2' } }
  fetch.mockRejectedValueOnce(new TypeError('response lost'))
  await expect(optimizationCommand('retry', context)).rejects.toThrow('response lost')
  await optimizationCommand('retry', context)
  await optimizationCommand('retry', context)
  const ids = fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).request_id)
  expect(ids[0]).toBe(ids[1])
  expect(ids[2]).not.toBe(ids[1])
  expect(
    fetch.mock.calls.every(([url]) => String(url).endsWith('/cae/optimizations/optimization-1/trials/trial-2/retry')),
  ).toBe(true)
})

it.each([false, true])(
  'migrates a creation receipt in place without renaming the user config (acknowledged=%s)',
  async (acknowledged) => {
    const configFile = path.join(directory, 'study.json')
    await writeFile(configFile, JSON.stringify(config))
    context = { ...context, options: { ...context.options, config: configFile } }
    await optimizationCommand('create', context)
    const file = `${configFile}.submission.json`
    const { optimizationId, ...receipt } = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...receipt, acknowledged, studyId: optimizationId }))
    fetch.mockClear()
    fetch.mockRejectedValueOnce(new TypeError('response lost'))
    await expect(optimizationCommand('create', context)).rejects.toThrow('response lost')
    const pending = JSON.parse(await readFile(file, 'utf8'))
    expect(pending).toMatchObject({ requestId: receipt.requestId, optimizationId, acknowledged: false })
    expect(pending).not.toHaveProperty('studyId')
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual(config)
    await optimizationCommand('create', context)
    expect(fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).request_id)).toEqual([
      receipt.requestId,
      receipt.requestId,
    ])
  },
)

it.each([false, true])(
  'migrates an unacknowledged retry and recovers interrupted migration (canonical copy=%s)',
  async (canonicalCopy) => {
    context = { ...context, args: [optimizationFixture.id], options: { trial: trialFixture.id } }
    const key = createHash('sha256')
      .update(JSON.stringify([context.client().baseUrl, optimizationFixture.id, trialFixture.id]))
      .digest('hex')
    const legacyFile = path.join(directory, '.data/cli/study-requests', `${key}.json`)
    const file = path.join(directory, '.data/cli/optimization-requests', `${key}.json`)
    const receipt = {
      api: context.client().baseUrl,
      requestId: randomUUID(),
      acknowledged: false,
      body: { study: optimizationFixture.id, trial: trialFixture.id },
      studyId: optimizationFixture.id,
    }
    await mkdir(path.dirname(legacyFile), { recursive: true })
    await writeFile(legacyFile, JSON.stringify(receipt))
    if (canonicalCopy) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(
        file,
        JSON.stringify({
          api: receipt.api,
          requestId: receipt.requestId,
          acknowledged: false,
          body: { optimization: optimizationFixture.id, trial: trialFixture.id },
          optimizationId: optimizationFixture.id,
        }),
      )
    }
    fetch.mockRejectedValueOnce(new TypeError('response lost'))
    await expect(optimizationCommand('retry', context)).rejects.toThrow('response lost')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      requestId: receipt.requestId,
      acknowledged: false,
      optimizationId: optimizationFixture.id,
      body: { optimization: optimizationFixture.id, trial: trialFixture.id },
    })
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await optimizationCommand('retry', context)
    expect(fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).request_id)).toEqual([
      receipt.requestId,
      receipt.requestId,
    ])
    const migrated = JSON.parse(await readFile(file, 'utf8'))
    expect(migrated).not.toHaveProperty('studyId')
    expect(migrated.body).not.toHaveProperty('study')
  },
)

it.each([false, true])(
  'preserves acknowledged retry semantics after migration (explicit replay=%s)',
  async (explicitReplay) => {
    const requestId = randomUUID()
    context = {
      ...context,
      args: [optimizationFixture.id],
      options: { trial: trialFixture.id, ...(explicitReplay ? { 'request-id': requestId } : {}) },
    }
    const key = createHash('sha256')
      .update(JSON.stringify([context.client().baseUrl, optimizationFixture.id, trialFixture.id]))
      .digest('hex')
    const file = path.join(directory, '.data/cli/study-requests', `${key}.json`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({
        api: context.client().baseUrl,
        requestId,
        acknowledged: true,
        body: { study: optimizationFixture.id, trial: trialFixture.id },
        studyId: optimizationFixture.id,
      }),
    )
    await optimizationCommand('retry', context)
    const sent = JSON.parse(String(fetch.mock.calls[0][1]?.body)).request_id
    expect(sent === requestId).toBe(explicitReplay)
  },
)

it('preserves conflicting migration receipts and refuses to invent a request ID', async () => {
  context = { ...context, args: [optimizationFixture.id], options: { trial: trialFixture.id } }
  const key = createHash('sha256')
    .update(JSON.stringify([context.client().baseUrl, optimizationFixture.id, trialFixture.id]))
    .digest('hex')
  const legacyFile = path.join(directory, '.data/cli/study-requests', `${key}.json`)
  const file = path.join(directory, '.data/cli/optimization-requests', `${key}.json`)
  const legacy = {
    api: context.client().baseUrl,
    requestId: randomUUID(),
    acknowledged: false,
    body: { study: optimizationFixture.id, trial: trialFixture.id },
  }
  const current = {
    ...legacy,
    requestId: randomUUID(),
    body: { optimization: optimizationFixture.id, trial: trialFixture.id },
  }
  await mkdir(path.dirname(legacyFile), { recursive: true })
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(legacyFile, JSON.stringify(legacy))
  await writeFile(file, JSON.stringify(current))
  await expect(optimizationCommand('retry', context)).rejects.toThrow('Saved requests conflict')
  expect(fetch).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(legacyFile, 'utf8'))).toEqual(legacy)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(current)
})

it('does not overwrite an unreadable receipt or submit an unrelated replacement request', async () => {
  const file = `${context.options.config}.submission.json`
  await writeFile(file, '{"requestId":')
  await expect(optimizationCommand('create', context)).rejects.toThrow('Saved request is invalid')
  expect(fetch).not.toHaveBeenCalled()
  expect(await readFile(file, 'utf8')).toBe('{"requestId":')
})

it.each([
  ['list', '/cae/optimizations?limit=50&offset=0&experiment_id=7', 'GET', { items: [optimizationFixture], total: 1 }],
  ['show', '/cae/optimizations/optimization-1', 'GET', optimizationFixture],
  ['trials', '/cae/optimizations/optimization-1/trials?offset=0&limit=50', 'GET', { items: [trialFixture], total: 1 }],
  ['stop', '/cae/optimizations/optimization-1/stop', 'POST', optimizationFixture],
  ['resume', '/cae/optimizations/optimization-1/resume', 'POST', optimizationFixture],
  ['delete', '/cae/optimizations/optimization-1', 'DELETE', { ok: true }],
])('routes %s through the authenticated shared API', async (command, route, method, response) => {
  fetch.mockResolvedValueOnce(Response.json(response))
  expect(await optimizationCommand(command, { ...context, args: ['optimization-1'] })).toMatchObject(
    command === 'list' ? { items: [{ id: optimizationFixture.id }], total: 1 } : response,
  )
  expect(fetch.mock.calls[0][0]).toBe(`https://api.example${route}`)
  expect(fetch.mock.calls[0][1]?.method?.toUpperCase()).toBe(method)
})

it.each([false, true])('stops observation without server cancellation (interrupt=%s)', async (interrupt) => {
  const controller = new AbortController()
  fetch.mockResolvedValueOnce(Response.json({ ...optimizationFixture, state: 'running', active: 1 }))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => {
    if (interrupt) controller.abort()
    return true
  })
  await expect(
    optimizationCommand('watch', {
      ...context,
      args: ['optimization-1'],
      options: { timeout: '0.05' },
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ exitCode: interrupt ? 130 : 5 })
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1]?.method?.toUpperCase()).toBe('GET')
})

it('writes optimization snapshots when observation completes', async () => {
  fetch.mockResolvedValueOnce(Response.json({ ...optimizationFixture, state: 'completed', active: 0 }))
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await optimizationCommand('watch', { ...context, args: [optimizationFixture.id], options: {} })
  expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
    type: 'snapshot',
    optimization: { id: optimizationFixture.id, state: 'completed' },
  })
  expect(JSON.parse(String(output.mock.calls[0][0]))).not.toHaveProperty('study')
})
