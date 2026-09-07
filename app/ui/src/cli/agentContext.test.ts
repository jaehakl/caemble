// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDbTables } from '@/api/api'
import type { CaembleClient } from '@/api/http'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { catalogCommand } from '@/platform/node/environment'
import { buildAgentContext } from './agentContext'
import type { CommandContext } from './types'

vi.mock('@/api/api', () => ({
  createDbTables: vi.fn(),
  getListRequest: () => ({ filter: {}, selected_ids: [], offset: 0, limit: 24 }),
}))
vi.mock('@/platform/node/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/node/environment')>()),
  catalogCommand: vi.fn(async () => ({ catalogRevision: 'live-test-revision' })),
}))

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('bounded external agent context', () => {
  it('includes exact checkout Python and source content while excluding credentials', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'caemble-agent-context-'))
    directories.push(directory)
    for (const [file, source] of Object.entries(starterExperimentSourceBundle.files)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await writeFile(path.join(directory, file), source, 'utf8')
    }
    await writeFile(path.join(directory, '.env'), 'PRIVATE_SECRET=do-not-include', 'utf8')
    await writeFile(
      path.join(directory, 'caemble.json'),
      JSON.stringify({ kind: 'experiment', name: 'Local', apiKey: 'do-not-include' }),
      'utf8',
    )
    const context = {
      environment: {
        repo: path.resolve('../..'),
        cae: path.resolve('../slaves/cae'),
        python: 'unused',
        apiUrl: undefined,
        envPath: path.join(directory, '.env'),
        token: 'do-not-include',
        cli: '',
        worker: '',
      },
      options: { source: directory },
      args: [],
      signal: new AbortController().signal,
      client: () => {
        throw new Error('Local context must not contact the API.')
      },
    } satisfies CommandContext

    const result = await buildAgentContext(context, 'experiment')

    expect(result.source.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.source.complete).toBe(true)
    expect(result.source.files.find(({ file }) => file === 'simulate.py')?.content).toContain('async def simulate')
    const program = result.checkoutSources.find(({ file }) => file.endsWith('/program.py'))
    expect(program).toMatchObject({ complete: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(program?.content).toContain('_ALLOWED_BUILTINS')
    expect(result.checkoutSources.find(({ file }) => file.endsWith('/simulation.py'))?.content).toContain(
      'async def run(',
    )
    expect(JSON.stringify(result)).not.toContain('do-not-include')
    expect(vi.mocked(catalogCommand)).toHaveBeenCalledWith(context.environment, 'meta', [], undefined)
  })

  it('resolves fixed dependencies from record metadata without loading tensors', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'caemble-agent-calculation-'))
    directories.push(directory)
    await writeFile(
      path.join(directory, 'calculation.js'),
      'export default function calculate(record) { return { dtype: "float64", data: Number(record.signal.data) } }',
      'utf8',
    )
    const request = vi.fn(async () => ({
      id: 9,
      experiment_id: 4,
      recorded_at: '2026-01-01',
      recordedData: [{ id: 3, name: 'signal', dtype: 'float64' }],
    }))
    const readRecordedData = vi.fn(() => {
      throw new Error('Tensor hydration is not context capture.')
    })
    vi.mocked(createDbTables).mockReturnValue({
      Experiment: {
        listRows: vi.fn(async () => ({
          total: 1,
          items: [
            {
              id: 4,
              name: 'Test',
              source_hash: 'remote-hash',
              source_bundle: starterExperimentSourceBundle,
              namespace: 'test',
              repository_slug: 'test',
              experiment_key: 'test',
              version_major: 1,
              version_minor: 0,
              version_patch: 0,
            },
          ],
        })),
      },
      ExperimentRecord: {
        listRows: vi.fn(async () => ({
          total: 1,
          items: [{ id: 8, name: 'signal', dtype: 'float64', tensor_order: 0, data_schema: { dtype: 'float64' } }],
        })),
      },
      Measurement: { readRecordedData },
    } as unknown as ReturnType<typeof createDbTables>)
    const context = {
      environment: {
        repo: path.resolve('../..'),
        cae: path.resolve('../slaves/cae'),
        python: 'unused',
        apiUrl: undefined,
        token: undefined,
        envPath: '',
        cli: '',
        worker: '',
      },
      options: { source: directory, measurement: '9' },
      args: [],
      signal: new AbortController().signal,
      client: () => ({ request }) as unknown as CaembleClient,
    } satisfies CommandContext

    const result = await buildAgentContext(context, 'calculation')

    expect(request).toHaveBeenCalledWith('get', '/data/measurement/9', undefined, { signal: context.signal })
    expect(result.dependencies).toMatchObject({
      status: 'analyzed',
      names: ['signal'],
      experimentRecordIds: [8],
      execution: 'not-run',
    })
    expect(readRecordedData).not.toHaveBeenCalled()
    expect(result.source.files.map(({ file }) => file)).toContain('calculation.js')
    expect(result.source.files.map(({ file }) => file)).toContain('experiment.tsx')
  })

  it('captures Solver Python files and reports byte truncation while retaining complete required instructions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'caemble-agent-solver-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'entry.py'), `# ${'한'.repeat(30_000)}\n`, 'utf8')
    const context: CommandContext = {
      environment: {
        repo: path.resolve('../..'),
        cae: path.resolve('../slaves/cae'),
        python: 'unused',
        apiUrl: undefined,
        token: undefined,
        envPath: '',
        cli: '',
        worker: '',
      },
      options: { source: directory },
      args: [],
      signal: new AbortController().signal,
      client: () => {
        throw new Error('Solver source context must remain local.')
      },
    }
    const result = await buildAgentContext(context, 'solver')
    expect(result.source).toMatchObject({ kind: 'solver-source-files', complete: false })
    expect(result.source.files[0]).toMatchObject({ file: 'entry.py', complete: false, nextLine: 1, includedBytes: 0 })
    expect(result.checkoutSources.find(({ file }) => file === 'docs/development/solver-development.md')).toMatchObject({
      complete: true,
    })
    expect(result.checkoutSources.find(({ file }) => file === 'app/slaves/cae/AGENTS.md')).toMatchObject({
      complete: true,
    })
  })
})
