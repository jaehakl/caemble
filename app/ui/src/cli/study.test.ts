// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCaembleClient } from '@/api/http'
import { cadSourceHash } from '@/lib/cad/source/document'
import { studyFixture, trialFixture } from '@/features/optimization/fixtures.test-support'
import { studyCommand } from './study'
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
  directory = await mkdtemp(path.join(tmpdir(), 'caemble-study-cli-'))
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
  await writeFile(path.join(directory, 'study.json'), JSON.stringify(config))
  fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(studyFixture))
  const client = createCaembleClient({
    baseUrl: 'https://api.example',
    auth: { kind: 'bearer', token: 'private-key' },
    fetch,
  })
  context = {
    args: [directory],
    options: { experiment: '7', config: path.join(directory, 'study.json') },
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
  await expect(studyCommand('create', context)).rejects.toThrow('response lost')
  await studyCommand('create', context)
  await studyCommand('create', context)
  const bodies = fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)))
  expect(new Set(bodies.map((body) => body.request_id)).size).toBe(1)
  expect(bodies[0]).toMatchObject({ experiment_id: 7, initial_vars: variables, vars_schema: varsSchema, ...config })
  expect(bodies[0].max_trials).toBeUndefined() // Server owns the default budget and all omitted axes.
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/cae/studies'))).toBe(true)
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer private-key')
  const receipt = await readFile(`${context.options.config}.submission.json`, 'utf8')
  expect(receipt).not.toContain('private-key')
  expect(JSON.parse(receipt)).toMatchObject({ acknowledged: true, studyId: studyFixture.id })
  await writeFile(String(context.options.config), JSON.stringify({ ...config, max_trials: 4 }))
  await expect(studyCommand('create', context)).rejects.toThrow('different settings')
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('requires an explicit artifact item when multiple candidates exist', async () => {
  const file = path.join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.items.push({ ...manifest.items[0], index: 2, file: 'items/2.json' })
  await writeFile(file, JSON.stringify(manifest))
  await writeFile(path.join(directory, 'items/2.json'), await readFile(path.join(directory, 'items/1.json')))
  await expect(studyCommand('create', context)).rejects.toThrow('--item')
  await studyCommand('create', { ...context, options: { ...context.options, item: '2' } })
  expect(fetch).toHaveBeenCalledOnce()
})

it('reuses a lost retry request and makes the next acknowledged retry explicit', async () => {
  context = { ...context, args: ['study-1'], options: { trial: 'trial-2' } }
  fetch.mockRejectedValueOnce(new TypeError('response lost'))
  await expect(studyCommand('retry', context)).rejects.toThrow('response lost')
  await studyCommand('retry', context)
  await studyCommand('retry', context)
  const ids = fetch.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).request_id)
  expect(ids[0]).toBe(ids[1])
  expect(ids[2]).not.toBe(ids[1])
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/cae/studies/study-1/trials/trial-2/retry'))).toBe(
    true,
  )
})

it.each([
  ['list', '/cae/studies?limit=50&offset=0&experiment_id=7', 'GET', { items: [studyFixture], total: 1 }],
  ['show', '/cae/studies/study-1', 'GET', studyFixture],
  ['trials', '/cae/studies/study-1/trials?offset=0&limit=50', 'GET', { items: [trialFixture], total: 1 }],
  ['stop', '/cae/studies/study-1/stop', 'POST', studyFixture],
  ['resume', '/cae/studies/study-1/resume', 'POST', studyFixture],
  ['delete', '/cae/studies/study-1', 'DELETE', { ok: true }],
])('routes %s through the authenticated shared API', async (command, route, method, response) => {
  fetch.mockResolvedValueOnce(Response.json(response))
  expect(await studyCommand(command, { ...context, args: ['study-1'] })).toMatchObject(
    command === 'list' ? { items: [{ id: studyFixture.id }], total: 1 } : response,
  )
  expect(fetch.mock.calls[0][0]).toBe(`https://api.example${route}`)
  expect(fetch.mock.calls[0][1]?.method?.toUpperCase()).toBe(method)
})

it.each([false, true])('stops observation without server cancellation (interrupt=%s)', async (interrupt) => {
  const controller = new AbortController()
  fetch.mockResolvedValueOnce(Response.json({ ...studyFixture, state: 'running', active: 1 }))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => {
    if (interrupt) controller.abort()
    return true
  })
  await expect(
    studyCommand('watch', { ...context, args: ['study-1'], options: { timeout: '0.05' }, signal: controller.signal }),
  ).rejects.toMatchObject({ exitCode: interrupt ? 130 : 5 })
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1]?.method?.toUpperCase()).toBe('GET')
})
