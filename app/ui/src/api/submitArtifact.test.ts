import { describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createCaembleClient } from './http'
import { sha256Bytes, submitArtifact } from './submitArtifact'
import { cadSourceHash } from '@/lib/cad/source/document'
import type { BuildArtifact } from '@/contracts/build'
import { UPLOAD_CHUNK_BYTES } from '@/contracts/build'

describe('prebuilt remote submission', () => {
  it('uploads multiple distinct Candidate inputs with one registration and one commit', async () => {
    vi.stubGlobal('crypto', webcrypto)
    try {
      const source_bundle = { files: { 'experiment.tsx': 'export {}\n' } }
      const source_hash = await cadSourceHash({ kind: 'experiment', sourceBundle: source_bundle })
      const inputs = [1, 2, 3].map((sample) =>
        new TextEncoder().encode(
          JSON.stringify({
            measurement: { kind: 'measurement', experiment: { sourceHash: source_hash, variables: { sample } } },
          }),
        ),
      )
      const artifact: BuildArtifact = {
        kind: 'caemble.build',
        version: 2,
        mode: 'candidate',
        source_hash,
        source_bundle,
        catalog_revision: 'revision',
        builder_version: '2',
        items: await Promise.all(
          inputs.map(async (bytes, index) => ({
            index: index + 1,
            file: `items/${index + 1}.json`,
            input_hash: await sha256Bytes(bytes),
            byte_length: bytes.length,
          })),
        ),
      }
      const paths: string[] = []
      const uploaded: number[] = []
      const client = createCaembleClient({
        baseUrl: 'https://api.example',
        auth: { kind: 'bearer', token: 'test-key' },
        fetch: async (url, options) => {
          const pathname = new URL(String(url)).pathname
          paths.push(pathname)
          if (pathname.endsWith('/finalize'))
            uploaded.push(JSON.parse(String(options?.body)).input.measurement.experiment.variables.sample)
          if (pathname.endsWith('/batches'))
            expect(JSON.parse(String(options?.body))).toMatchObject({
              mode: 'candidate',
              items: expect.arrayContaining([
                { index: 1, input_hash: artifact.items[0].input_hash, byte_length: inputs[0].length },
              ]),
            })
          if (pathname.endsWith('/commit')) expect(paths.filter((path) => path.endsWith('/finalize'))).toHaveLength(3)
          return Response.json(
            pathname.endsWith('/batches') || pathname.endsWith('/commit')
              ? {
                  id: 'batch',
                  experiment_id: 7,
                  mode: 'candidate',
                  total: 3,
                  created_count: 3,
                  succeeded: 0,
                  failed: 0,
                  cancelled: 0,
                  state: pathname.endsWith('/commit') ? 'queued' : 'uploading',
                  created_at: '',
                  updated_at: '',
                  finished_at: null,
                  last_event_id: 0,
                  read_event_id: 0,
                }
              : { ok: true },
          )
        },
      })
      await submitArtifact({
        client,
        artifact,
        experimentId: 7,
        requestId: 'request',
        readItem: async (item) => inputs[item.index - 1],
      })
      expect(paths.filter((path) => path.endsWith('/batches'))).toHaveLength(1)
      expect(paths.filter((path) => path.endsWith('/commit'))).toHaveLength(1)
      expect(uploaded).toEqual([1, 2, 3])
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('sends large built bytes only to S3 and commits after verified upload', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const source_bundle = { files: { 'experiment.tsx': 'export {}' } }
    const source_hash = await cadSourceHash({ kind: 'experiment', sourceBundle: source_bundle })
    const input = {
      measurement: {
        kind: 'measurement',
        experiment: {
          sourceHash: source_hash,
          variables: { sample: 12 },
          scene: { mesh: 'x'.repeat(UPLOAD_CHUNK_BYTES) },
          taskScenes: {},
          simulationProgram: { pythonSource: 'print(1)', tasks: {}, recordedData: {} },
        },
      },
    }
    const bytes = new TextEncoder().encode(JSON.stringify(input))
    const item = { index: 1, file: 'items/1.json', input_hash: await sha256Bytes(bytes), byte_length: bytes.length }
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
    const received: Uint8Array[] = []
    let reference: Record<string, unknown>,
      verified = false,
      finalized = false
    const transport: typeof fetch = async (url, options) => {
      const address = new URL(String(url))
      if (address.hostname === 'bucket.example') {
        expect(new Headers(options?.headers).has('authorization')).toBe(false)
        received.push(new Uint8Array(await (options!.body as Blob).arrayBuffer()))
        return new Response('')
      }
      const body = options?.body ? JSON.parse(String(options.body)) : undefined
      expect(JSON.stringify(body ?? {}).length).toBeLessThan(65536)
      if (address.pathname === '/storage/uploads') {
        const { chunks, ...metadata } = body.manifest
        reference = { kind: 'caemble.object', version: 1, id: 'object', ...metadata }
        return Response.json({
          reference,
          parts: chunks.map((part: object, index: number) => ({
            ...part,
            headers: {},
            url: `https://bucket.example/${index}`,
          })),
        })
      }
      if (address.pathname.endsWith('/complete')) {
        expect(Buffer.concat(received.map((part) => Buffer.from(part))).equals(Buffer.from(bytes))).toBe(true)
        verified = true
        return Response.json({ reference: reference!, ready: true })
      }
      if (address.pathname.endsWith('/finalize')) {
        expect(verified).toBe(true)
        expect(body).toMatchObject({ input: reference!, projection: { measurement: { experiment: { scene: {} } } } })
        finalized = true
        return Response.json({ ok: true })
      }
      if (address.pathname.endsWith('/commit')) expect(finalized).toBe(true)
      return Response.json({
        id: 'batch',
        experiment_id: 7,
        mode: 'generate',
        total: 1,
        created_count: 1,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        state: finalized ? 'queued' : 'uploading',
        created_at: '',
        updated_at: '',
        finished_at: null,
        last_event_id: 0,
        read_event_id: 0,
        jobs: [
          {
            id: 'job',
            index: 1,
            attempt_count: 1,
            state: 'staged',
            measurement_id: null,
            progress: null,
            last_error: null,
            created_at: '',
            updated_at: '',
          },
        ],
      })
    }
    vi.stubGlobal('fetch', transport)
    try {
      const client = createCaembleClient({
        baseUrl: 'https://api.example',
        auth: { kind: 'bearer', token: 'key' },
        fetch: transport,
      })
      expect(
        (await submitArtifact({ client, artifact, experimentId: 7, requestId: 'request', readItem: async () => bytes }))
          .state,
      ).toBe('queued')
      expect(received).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
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
