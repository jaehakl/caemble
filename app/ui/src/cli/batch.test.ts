import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCaembleClient } from '@/api/http'
import { batchCommand } from './batch'
import type { CommandContext } from './types'

afterEach(() => vi.restoreAllMocks())
const environment: CommandContext['environment'] = {
  repo: 'D:/caemble',
  cae: 'D:/caemble/app/slaves/cae',
  python: '',
  envPath: 'D:/caemble/.env',
  apiUrl: 'https://api.example',
  token: 'test-key',
  cli: 'D:/caemble/app/ui/dist-cli/caemble.cjs',
  worker: 'D:/caemble/app/ui/dist-cli/worker.cjs',
}
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
})
