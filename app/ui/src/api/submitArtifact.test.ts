import { describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createCaembleClient } from './http'
import { sha256Bytes, submitArtifact } from './submitArtifact'
import { cadSourceHash } from '@/lib/cad/source/document'
import type { BuildArtifact } from '@/contracts/build'
import { UPLOAD_CHUNK_BYTES } from '@/contracts/build'

describe('prebuilt remote submission', () => {
  it('resumes identical chunks and commits only after every frozen input is finalized', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const source_bundle = { files: { 'experiment.tsx': 'export {}\n', 'simulate.py': '# source\n' } }
    const source_hash = await cadSourceHash({ kind: 'experiment', sourceBundle: source_bundle })
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        measurement: { kind: 'measurement', experiment: { sourceHash: source_hash, variables: { sample: 12 } } },
        presentation: { padding: 'x'.repeat(UPLOAD_CHUNK_BYTES) },
      }),
    )
    const item = { index: 1, file: 'items/1.json', input_hash: await sha256Bytes(bytes), byte_length: bytes.byteLength }
    const artifact: BuildArtifact = {
      kind: 'caemble.build',
      version: 2,
      mode: 'generate',
      source_hash,
      source_bundle,
      catalog_revision: 'revision',
      builder_version: '2',
      items: [item],
    }
    const received = new Map<string, Uint8Array>()
    let failOnce = true,
      finalized = false,
      committed = false
    const requestBodies: unknown[] = []
    const fetch: typeof globalThis.fetch = async (url, options) => {
      const pathname = new URL(String(url)).pathname
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-key')
      expect(options?.credentials).toBe('omit')
      expect(options?.redirect).toBe('error')
      expect(pathname).not.toMatch(/csrf|prepare|validate/)
      if (options?.method === 'PUT') {
        const chunk = new Uint8Array(await (options.body as Blob).arrayBuffer())
        expect(await sha256Bytes(chunk)).toBe(new Headers(options.headers).get('x-chunk-sha256'))
        if (received.has(pathname)) expect(Buffer.from(chunk).equals(Buffer.from(received.get(pathname)!))).toBe(true)
        received.set(pathname, chunk)
        if (pathname.endsWith('/chunks/1') && failOnce) {
          failOnce = false
          return Response.json({ detail: 'temporary failure' }, { status: 503 })
        }
      } else if (pathname.endsWith('/finalize')) finalized = true
      else if (pathname.endsWith('/commit')) {
        expect(finalized).toBe(true)
        committed = true
      } else requestBodies.push(JSON.parse(String(options?.body)))
      return Response.json(
        pathname.endsWith('/batches') || pathname.endsWith('/commit')
          ? {
              id: 'batch',
              experiment_id: 7,
              mode: 'generate',
              total: 1,
              created_count: committed ? 1 : 0,
              uploaded_count: finalized ? 1 : 0,
              succeeded: 0,
              failed: 0,
              cancelled: 0,
              state: committed ? 'queued' : 'uploading',
              created_at: '',
              updated_at: '',
              finished_at: null,
              last_event_id: 0,
              read_event_id: 0,
            }
          : { ok: true },
      )
    }
    const client = createCaembleClient({
      baseUrl: 'https://api.example',
      auth: { kind: 'bearer', token: 'test-key' },
      fetch,
    })
    const options = { client, artifact, experimentId: 7, requestId: 'fixed-request', readItem: async () => bytes }
    await expect(submitArtifact(options)).rejects.toThrow('temporary failure')
    expect(committed).toBe(false)
    expect(finalized).toBe(false)
    expect((await submitArtifact(options)).state).toBe('queued')
    expect(requestBodies[0]).toEqual(requestBodies[1])
    expect(received.size).toBe(2)
    expect(Buffer.concat([...received.values()].map((chunk) => Buffer.from(chunk))).equals(Buffer.from(bytes))).toBe(
      true,
    )
    vi.unstubAllGlobals()
  })

  it('refuses altered source before registering an upload and altered input before uploading', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const fetch = vi.fn()
    const client = createCaembleClient({
      baseUrl: 'https://api.example',
      auth: { kind: 'bearer', token: 'test-key' },
      fetch,
    })
    const artifact: BuildArtifact = {
      kind: 'caemble.build',
      version: 2,
      mode: 'generate',
      source_hash: 'a'.repeat(64),
      source_bundle: { files: {} },
      catalog_revision: 'r',
      builder_version: '2',
      items: [{ index: 1, file: 'items/1.json', input_hash: 'b'.repeat(64), byte_length: 1 }],
    }
    await expect(
      submitArtifact({ client, artifact, experimentId: 1, requestId: 'r', readItem: async () => new Uint8Array([1]) }),
    ).rejects.toThrow('source bundle has changed')
    expect(fetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
