// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCaembleClient } from '@/api/http'
import { datasetCommand, validateDatasetArtifact } from './prediction'
import type { CommandContext } from './types'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(corrupt = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'caemble-dataset-export-'))
  directories.push(directory)
  const bytes = Buffer.from('원본 tensor bytes')
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  const reference = {
    kind: 'caemble.object',
    version: 1,
    id: 'object-1',
    encoding: 'base64',
    byteLength: bytes.length,
    sha256: digest(bytes),
  }
  const dataset = {
    kind: 'caemble.prediction.dataset',
    version: 1,
    datasetId: 'dataset-1',
    revision: 2,
    fingerprint: 'fixed-dataset-content',
    experimentId: 7,
    varsSchema: {},
    measurements: [],
    recorded: [reference],
  }
  const raw = Buffer.from(JSON.stringify(dataset))
  const grant = {
    dataset_id: dataset.datasetId,
    revision: 2,
    fingerprint: dataset.fingerprint,
    grant_id: 'grant-1',
    manifest_url: 'https://api.test/prediction/datasets/dataset-1/revisions/2/manifest',
    object_url_template: 'https://api.test/prediction/datasets/dataset-1/revisions/2/objects/{object_id}',
    manifest_sha256: digest(raw),
    token: 'limited-read-grant',
  }
  const chunks = [bytes.subarray(0, 4), bytes.subarray(4)]
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const address = new URL(String(url))
    const headers = new Headers(init?.headers)
    if (address.hostname === 'bucket.test') {
      expect(headers.has('authorization')).toBe(false)
      expect(init?.credentials).toBe('omit')
      expect(init?.redirect).toBe('error')
      return new Response(corrupt ? Buffer.from('damaged') : chunks[Number(address.pathname.slice(1))])
    }
    if (address.pathname.endsWith('/manifest')) {
      expect(headers.get('authorization')).toBe('Bearer limited-read-grant')
      return new Response(raw)
    }
    if (address.pathname.endsWith('/objects/object-1')) {
      expect(headers.get('authorization')).toBe('Bearer limited-read-grant')
      return Response.json({
        reference,
        parts: chunks.map((chunk, index) => ({
          url: `https://bucket.test/${index}`,
          byteLength: chunk.length,
          sha256: digest(chunk),
        })),
      })
    }
    expect(headers.get('authorization')).toBe('Bearer owner-key')
    if (address.pathname.endsWith('/grants')) return Response.json(grant)
    if (address.pathname.endsWith('/release')) return Response.json({ released: true })
    if (address.pathname === '/prediction/datasets')
      return Response.json({ items: [{ id: 'dataset-1', current_revision: 2 }] })
    throw new Error(`Unexpected fixture path: ${address.pathname}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const client = createCaembleClient({
    baseUrl: 'https://api.test',
    auth: { kind: 'bearer', token: 'owner-key' },
    fetch: fetcher,
  })
  const context: CommandContext = {
    environment: {
      repo: '',
      cae: '',
      python: '',
      envPath: '',
      cli: '',
      worker: '',
      apiUrl: 'https://api.test',
      token: 'owner-key',
    },
    args: ['dataset-1'],
    options: { out: directory },
    signal: new AbortController().signal,
    client: () => client,
  }
  return { context, directory, bytes, reference, fetcher }
}

describe('portable Prediction Dataset CLI', () => {
  it('exports pinned bytes and validates without API calls or retained credentials', async () => {
    const { context, directory, bytes, reference, fetcher } = await fixture()
    expect(await datasetCommand('export', context)).toMatchObject({ revision: 2, grantReleased: true })
    expect(await readFile(path.join(directory, `${reference.sha256}.object`))).toEqual(bytes)
    const manifest = await readFile(path.join(directory, 'manifest.json'), 'utf8')
    expect(manifest).not.toContain('owner-key')
    expect(manifest).not.toContain('limited-read-grant')
    fetcher.mockClear()
    expect(await datasetCommand('validate', { ...context, args: [directory] })).toMatchObject({ valid: true, files: 2 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects damaged downloads, releases their grants and publishes no manifest', async () => {
    const { context, directory, fetcher } = await fixture(true)
    await expect(datasetCommand('export', context)).rejects.toThrow(/declared size|checksum/)
    await expect(readFile(path.join(directory, 'manifest.json'))).rejects.toThrow()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/grant-1/release'))).toBe(true)
  })

  it('rejects altered files and paths outside the declared bundle', async () => {
    const { context, directory, reference } = await fixture()
    await datasetCommand('export', context)
    await writeFile(path.join(directory, `${reference.sha256}.object`), 'changed')
    await expect(validateDatasetArtifact(directory, context.signal)).rejects.toThrow('checksum or length changed')
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
    manifest.files[0].name = '../outside.json'
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
    await expect(validateDatasetArtifact(directory, context.signal)).rejects.toThrow('invalid file entry')
  })
})
