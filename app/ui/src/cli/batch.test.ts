import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCaembleClient } from '@/api/http'
import { submitArtifact } from '@/api/submitArtifact'
import { openArtifact } from '@caemble/execution/node/artifact'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { batchCommand, batchResources } from './batch'
import type { CommandContext } from './types'

vi.mock('@caemble/execution/node/artifact', () => ({ openArtifact: vi.fn() }))
vi.mock('@/api/submitArtifact', () => ({ submitArtifact: vi.fn() }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const mocked = { existsSync: vi.fn() }
  return { ...actual, ...mocked, default: { ...actual, ...mocked } }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const mocked = { readFile: vi.fn(), writeFile: vi.fn() }
  return { ...actual, ...mocked, default: { ...actual, ...mocked } }
})

afterEach(() => vi.restoreAllMocks())

describe('batch resource arguments', () => {
  it('keeps physical artifact inputs separate and normalizes memory units', () => {
    expect(batchResources({})).toBeUndefined()
    expect(
      batchResources({ 'cpu-cores': '4', 'startup-ram-mib': '1024', 'gpu-count': '1', 'gpu-memory-mib': '2048' }),
    ).toEqual({ cpu_cores: 4, startup_ram_bytes: 1024 ** 3, gpu_count: 1, gpu_memory_bytes: 2 * 1024 ** 3 })
  })
  it.each([
    { 'cpu-cores': '0' },
    { 'cpu-cores': '1.5' },
    { 'startup-ram-mib': '-1' },
    { 'gpu-count': '0', 'gpu-memory-mib': '1' },
    { 'gpu-count': 'not-a-number' },
  ])('rejects invalid requests before submission: %o', (options) => {
    expect(() => batchResources(options)).toThrow()
  })
})
const environment: CommandContext['environment'] = {
  repo: 'D:/caemble',
  cae: 'D:/caemble/app/slaves/cae_simulation',
  python: '',
  envPath: 'D:/caemble/.env',
  apiUrl: 'https://api.example',
  token: 'test-key',
  cli: 'D:/caemble/app/ui/dist-cli/caemble.cjs',
  worker: 'D:/caemble/app/ui/dist-cli/worker.cjs',
}

describe('batch submission resource resume', () => {
  const resources = { cpu_cores: 4, startup_ram_bytes: 1024 ** 3, gpu_count: 1, gpu_memory_bytes: 2 * 1024 ** 3 }
  const saved = { api: 'https://api.example', experimentId: 7, requestId: 'saved-request', resources }
  const stored = {
    directory: path.resolve('artifact'),
    artifact: {
      kind: 'caemble.build' as const,
      version: 2 as const,
      mode: 'candidate' as const,
      source_hash: 'frozen-source',
      source_bundle: { files: { 'experiment.tsx': 'export {}' } },
      catalog_revision: 'frozen-catalog',
      builder_version: '2' as const,
      items: [],
    },
    readItem: vi.fn(),
  }

  it.each([{}, { 'request-id': saved.requestId }])(
    'replays saved resources when flags are omitted: %o',
    async (options) => {
      vi.mocked(openArtifact).mockResolvedValue(stored)
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(saved))
      const fetch = vi.fn<typeof globalThis.fetch>()
      const client = createCaembleClient({ baseUrl: saved.api, auth: { kind: 'bearer', token: 'test-key' }, fetch })

      await batchCommand('submit', {
        environment,
        options: { experiment: '7', ...options },
        args: ['artifact'],
        signal: new AbortController().signal,
        client: () => client,
      })

      expect(submitArtifact).toHaveBeenCalledOnce()
      const submitted = vi.mocked(submitArtifact).mock.calls[0][0]
      expect(submitted).toMatchObject({ requestId: saved.requestId, resources, experimentId: 7 })
      expect(submitted.artifact).toBe(stored.artifact)
      expect(submitted.readItem).toBe(stored.readItem)
      expect(writeFile).toHaveBeenCalledWith(
        path.join(stored.directory, 'submission.json'),
        JSON.stringify(saved, null, 2),
        'utf8',
      )
      await submitted.onRegistered?.('resumed-batch')
      expect(writeFile).toHaveBeenLastCalledWith(
        path.join(stored.directory, 'submission.json'),
        JSON.stringify({ ...saved, batchId: 'resumed-batch' }, null, 2),
        'utf8',
      )
    },
  )

  it.each([{}, { 'request-id': saved.requestId }])(
    'rejects changed resources for the saved request before writing or sending: %o',
    async (options) => {
      vi.mocked(openArtifact).mockResolvedValue(stored)
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(saved))
      const fetch = vi.fn<typeof globalThis.fetch>()
      const client = createCaembleClient({ baseUrl: saved.api, auth: { kind: 'bearer', token: 'test-key' }, fetch })

      await expect(
        batchCommand('submit', {
          environment,
          options: {
            experiment: '7',
            'cpu-cores': '8',
            'startup-ram-mib': '1024',
            'gpu-count': '1',
            'gpu-memory-mib': '2048',
            ...options,
          },
          args: ['artifact'],
          signal: new AbortController().signal,
          client: () => client,
        }),
      ).rejects.toMatchObject({ exitCode: 4, message: expect.stringContaining('different resource settings') })

      expect(writeFile).not.toHaveBeenCalled()
      expect(submitArtifact).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})

describe('remote observation lifecycle', () => {
  it('times out a silent connection without sending server cancellation', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
      if (String(url).includes('/events'))
        return new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }),
        )
      return Response.json({
        id: 'batch',
        experiment_id: 1,
        mode: 'generate',
        total: 1,
        created_count: 1,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        state: 'running',
        created_at: '',
        updated_at: '',
        finished_at: null,
        last_event_id: 1,
        read_event_id: 0,
        jobs: [],
      })
    })
    const client = createCaembleClient({
      baseUrl: 'https://api.example',
      auth: { kind: 'bearer', token: 'test-key' },
      fetch,
    })
    const context: CommandContext = {
      environment,
      options: { timeout: '0.02' },
      args: ['batch'],
      signal: new AbortController().signal,
      client: () => client,
    }
    await expect(batchCommand('watch', context)).rejects.toMatchObject({ exitCode: 5 })
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('/cancel'))).toBe(true)
  })
  it('reports failed terminal jobs as execution failure', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const client = createCaembleClient({
      baseUrl: 'https://api.example',
      auth: { kind: 'bearer', token: 'test-key' },
      fetch: async () =>
        Response.json({
          id: 'batch',
          experiment_id: 1,
          mode: 'generate',
          total: 1,
          created_count: 1,
          succeeded: 0,
          failed: 1,
          cancelled: 0,
          state: 'completed',
          created_at: '',
          updated_at: '',
          finished_at: '2026-09-08T00:00:00Z',
          last_event_id: 2,
          read_event_id: 0,
          jobs: [],
        }),
    })
    await expect(
      batchCommand('watch', {
        environment,
        options: {},
        args: ['batch'],
        signal: new AbortController().signal,
        client: () => client,
      }),
    ).rejects.toMatchObject({ exitCode: 1 })
  })
  it('lists batch summaries and keeps job pages on show', async () => {
    const summary = {
      id: 'batch',
      experiment_id: 1,
      mode: 'generate',
      total: 1,
      created_count: 1,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      state: 'running',
      created_at: '',
      updated_at: '',
      finished_at: null,
      last_event_id: 1,
      read_event_id: 0,
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).includes('/batches/batch')
        ? Response.json({ ...summary, jobs: [] })
        : Response.json({ items: [summary], total: 1, cursor: 1 }),
    )
    const client = createCaembleClient({
      baseUrl: 'https://api.example',
      auth: { kind: 'bearer', token: 'test-key' },
      fetch,
    })
    const context: CommandContext = {
      environment,
      options: {},
      args: ['batch'],
      signal: new AbortController().signal,
      client: () => client,
    }
    expect(await batchCommand('list', context)).toMatchObject({ items: [summary] })
    expect(await batchCommand('show', { ...context, options: { limit: '0' } })).toMatchObject({
      ...summary,
      jobs: [],
    })
    expect(String(fetch.mock.calls[1][0])).toContain('limit=0')
  })
})
