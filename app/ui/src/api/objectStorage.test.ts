import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createCaembleClient } from './http'
import { createDbTables } from './api'
import {
  externalizeObjects,
  objectHash,
  OBJECT_CHUNK_BYTES,
  OBJECT_INLINE_BYTES,
  resolveObjects,
  uploadObject,
} from './objectStorage'

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  vi.stubGlobal('crypto', webcrypto)
  const objects = new Map<
    string,
    {
      reference: Record<string, unknown>
      parts: { byteLength: number; sha256: string }[]
      bytes: Map<number, Uint8Array>
    }
  >()
  const requests: { url: string; body: unknown }[] = []
  let failUpload = true
  const fetcher: typeof fetch = async (url, options) => {
    const address = new URL(String(url))
    const body = options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined
    requests.push({ url: String(url), body })
    if (address.hostname === 'bucket.test') {
      expect(new Headers(options?.headers).has('authorization')).toBe(false)
      expect(options?.credentials).toBe('omit')
      const [, id, part] = address.pathname.split('/')
      const object = objects.get(id)!
      if (options?.method === 'PUT') {
        if (failUpload) {
          failUpload = false
          return new Response('', { status: 403 })
        }
        if (object.bytes.has(Number(part))) return new Response('', { status: 412 })
        const bytes = new Uint8Array(await (options.body as Blob).arrayBuffer())
        expect(await objectHash(bytes)).toBe(object.parts[Number(part)].sha256)
        object.bytes.set(Number(part), bytes)
        return new Response('')
      }
      return new Response(object.bytes.get(Number(part))!.slice().buffer as ArrayBuffer)
    }
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer key')
    if (address.pathname === '/calculation/upsert') return Response.json([{ id: 9, revision: 1 }])
    if (address.pathname === '/calculation_data/save') return Response.json({ id: 10, created: true })
    if (address.pathname === '/storage/uploads') {
      const id = body.manifest.sha256
      const { chunks, ...manifest } = body.manifest
      const reference = { kind: 'caemble.object', version: 1, id, ...manifest }
      if (!objects.has(id)) objects.set(id, { reference, parts: chunks, bytes: new Map() })
      return Response.json({
        reference,
        parts: chunks.map((part: object, index: number) => ({
          ...part,
          url: `https://bucket.test/${id}/${index}`,
          headers: { 'If-None-Match': '*' },
        })),
      })
    }
    const id = address.pathname.split('/')[3]
    const object = objects.get(id)!
    if (address.pathname.endsWith('/complete')) {
      expect(object.bytes.size).toBe(object.parts.length)
      return Response.json({ reference: object.reference, ready: true })
    }
    return Response.json({
      reference: object.reference,
      parts: object.parts.map((part, index) => ({ ...part, url: `https://bucket.test/${id}/${index}`, headers: {} })),
    })
  }
  vi.stubGlobal('fetch', fetcher)
  const client = createCaembleClient({
    baseUrl: 'https://api.test',
    auth: { kind: 'bearer', token: 'key' },
    fetch: fetcher,
  })
  return { client, objects, requests }
}

describe('direct object storage', () => {
  it('downloads at most four distinct references concurrently and reports completion', async () => {
    const { client, requests } = fixture()
    const refs = await Promise.all(
      Array.from({ length: 9 }, (_, i) => uploadObject(client, {}, new TextEncoder().encode(JSON.stringify([i])))),
    )
    const fetcher = globalThis.fetch
    let active = 0
    let maximum = 0
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      try {
        return await fetcher(...args)
      } finally {
        active--
      }
    })
    const progress = vi.fn()
    expect(await resolveObjects(client, [...refs, refs[0]], undefined, progress)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => [i]),
      [0],
    ])
    expect(maximum).toBe(4)
    expect(requests.filter((r) => r.url.includes('/storage/objects/'))).toHaveLength(9)
    expect(progress).toHaveBeenLastCalledWith({ completed: 9, total: 9 })
  })

  it('cancels queued downloads without requesting their tickets', async () => {
    const { client, requests } = fixture()
    const refs = await Promise.all(
      Array.from({ length: 9 }, (_, i) => uploadObject(client, {}, new TextEncoder().encode(JSON.stringify([i])))),
    )
    const controller = new AbortController()
    controller.abort()
    await expect(resolveObjects(client, refs, controller.signal)).rejects.toThrow()
    expect(requests.filter((r) => r.url.includes('/storage/objects/'))).toHaveLength(0)
  })

  it('aborts in-flight downloads and leaves the rest of the queue unstarted', async () => {
    const { client, requests } = fixture()
    const refs = await Promise.all(
      Array.from({ length: 9 }, (_, i) => uploadObject(client, {}, new TextEncoder().encode(JSON.stringify([i])))),
    )
    const controller = new AbortController()
    let started = 0
    vi.stubGlobal(
      'fetch',
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
          if (++started === 4) controller.abort()
        }),
    )
    await expect(resolveObjects(client, refs, controller.signal)).rejects.toThrow()
    expect(started).toBe(4)
    expect(requests.filter((r) => r.url.includes('/storage/objects/'))).toHaveLength(4)
  })

  it('renews an expired download ticket before retrying the same reference', async () => {
    const { client, requests } = fixture()
    const ref = await uploadObject(client, {}, new TextEncoder().encode('[1,2,3]'))
    const fetcher = globalThis.fetch
    let first = true
    vi.stubGlobal('fetch', (...args: Parameters<typeof fetch>) => {
      if (first) {
        first = false
        return Promise.resolve(new Response('', { status: 403 }))
      }
      return fetcher(...args)
    })
    expect(await resolveObjects(client, ref)).toEqual([1, 2, 3])
    expect(requests.filter((r) => r.url.includes('/storage/objects/'))).toHaveLength(2)
  })
  it('stores both Calculation preflight coordinates and output arrays through the bucket', async () => {
    const { client, requests } = fixture()
    const tables = createDbTables(client)
    const ticks = Array.from({ length: 20000 }, (_, index) => index + 0.125)
    const layout = { dtype: 'float64' as const, shape: [ticks.length], axes: [{ name: 'x', ticks }] }
    await tables.Calculation.upsertRow([
      {
        experiment_id: 1,
        name: 'large',
        source_code: '0',
        contract_status: 'ready',
        experiment_record_ids: [],
        preflight_measurement_id: 2,
        output_layout: layout,
      },
    ])
    await tables.CalculationData.save({
      calculation_id: 9,
      measurement_id: 2,
      source_hash: 'a'.repeat(64),
      data: { ...layout, data: Array.from({ length: ticks.length }, () => 0.125) },
    })
    const upsert = requests.find((item) => item.url.endsWith('/calculation/upsert'))!
    const saved = requests.find((item) => item.url.endsWith('/calculation_data/save'))!
    expect(upsert.body).toMatchObject([{ output_layout: { axes: [{ ticks: { kind: 'caemble.object' } }] } }])
    expect(saved.body).toMatchObject({
      data: {
        data: { kind: 'caemble.object' },
        summary: { kind: 'tensor', count: 20000, mean: expect.closeTo(0.125), std: expect.closeTo(0) },
      },
    })
    expect(JSON.stringify(upsert.body).length).toBeLessThan(2048)
    expect(JSON.stringify(saved.body).length).toBeLessThan(2048)
  })

  it('keeps exactly 64 KiB inline and separates larger values including axis arrays', async () => {
    const { client, requests } = fixture()
    const inline = 'x'.repeat(OBJECT_INLINE_BYTES - 2)
    expect(await externalizeObjects(client, {}, inline)).toBe(inline)
    expect(requests).toHaveLength(0)
    const value = {
      shape: [12000],
      axes: [{ ticks: Array.from({ length: 12000 }, (_, i) => i + 0.125) }],
      data: 'x'.repeat(OBJECT_INLINE_BYTES),
    }
    const stored = await externalizeObjects(client, {}, value)
    expect(stored).toMatchObject({ axes: [{ ticks: { kind: 'caemble.object' } }], data: { kind: 'caemble.object' } })
    expect(await resolveObjects(client, stored)).toEqual(value)
    expect(
      requests
        .filter((r) => new URL(r.url).hostname === 'api.test')
        .every((r) => JSON.stringify(r.body ?? '').length < OBJECT_INLINE_BYTES),
    ).toBe(true)
  })

  it('renews URLs, resumes immutable parts, and preserves exact bytes across multiple parts', async () => {
    const { client, requests } = fixture()
    const original = 'x'.repeat(OBJECT_CHUNK_BYTES + 5)
    const bytes = new TextEncoder().encode(JSON.stringify(original))
    const reference = await uploadObject(client, {}, bytes)
    expect(await uploadObject(client, {}, bytes)).toEqual(reference)
    expect(await resolveObjects(client, reference)).toEqual(original)
    expect(requests.filter((r) => r.url.endsWith('/storage/uploads')).length).toBeGreaterThan(2)
  })

  it('deduplicates references in a read and rejects corrupt data', async () => {
    const { client, objects, requests } = fixture()
    const reference = await uploadObject(client, {}, new TextEncoder().encode('[1,2,3]'))
    expect(await resolveObjects(client, { a: reference, b: reference })).toEqual({ a: [1, 2, 3], b: [1, 2, 3] })
    expect(requests.filter((r) => r.url.includes('/storage/objects/'))).toHaveLength(1)
    objects.get(reference.id)!.bytes.get(0)![1] = 55
    await expect(resolveObjects(client, reference)).rejects.toThrow('checksum')
  })

  it('does not request a ticket after cancellation', async () => {
    const { client, requests } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(externalizeObjects(client, {}, 'x'.repeat(OBJECT_INLINE_BYTES), controller.signal)).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })
})
