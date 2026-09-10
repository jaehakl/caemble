import type { CaembleClient } from './http'

export const OBJECT_INLINE_BYTES = 64 * 1024
export const OBJECT_CHUNK_BYTES = 8 * 1024 * 1024

export type ObjectReference = Readonly<{
  kind: 'caemble.object'
  version: 1
  id: string
  encoding: 'json' | 'base64'
  sha256: string
  byteLength: number
  length?: number
}>

type ObjectTicket = Readonly<{
  reference: ObjectReference
  ready?: boolean
  parts: readonly Readonly<{ url: string; headers: Record<string, string>; sha256: string; byteLength: number }>[]
}>

export async function objectHash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function uploadObject(
  client: CaembleClient,
  scope: Readonly<Record<string, unknown>>,
  bytes: Uint8Array,
  encoding: ObjectReference['encoding'] = 'json',
  signal?: AbortSignal,
  length?: number,
) {
  const chunks = []
  for (let offset = 0; offset < bytes.length; offset += OBJECT_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + OBJECT_CHUNK_BYTES)
    chunks.push({ byteLength: chunk.length, sha256: await objectHash(chunk) })
  }
  const manifest = {
    encoding,
    sha256: await objectHash(bytes),
    byteLength: bytes.length,
    chunks,
    ...(length === undefined ? {} : { length }),
  }
  const prepare = () =>
    client.request<ObjectTicket>('post', '/storage/uploads', { scope, manifest }, { csrf: 'required', signal })
  let ticket = await prepare()
  if (!ticket.ready) {
    for (let index = 0; index < ticket.parts.length; index++) {
      signal?.throwIfAborted()
      const chunk = bytes.subarray(index * OBJECT_CHUNK_BYTES, (index + 1) * OBJECT_CHUNK_BYTES)
      for (let attempt = 0; ; attempt++) {
        const part = ticket.parts[index]
        let response: Response
        try {
          response = await fetch(part.url, {
            method: 'PUT',
            headers: part.headers,
            body: new Blob([chunk.slice().buffer as ArrayBuffer]),
            credentials: 'omit',
            redirect: 'error',
            signal,
          })
        } catch (error) {
          signal?.throwIfAborted()
          if (attempt >= 2) throw error
          ticket = await prepare()
          if (ticket.ready) break
          continue
        }
        // A previous attempt may have completed before its response was lost.
        // The API verifies the existing object's checksum during completion.
        if (response.ok || response.status === 412) break
        if (attempt >= 2 || (response.status !== 403 && response.status !== 409 && response.status < 500))
          throw new Error(`S3 upload failed (${response.status}).`)
        ticket = await prepare()
        if (ticket.ready) break
      }
    }
  }
  const completed = await client.request<ObjectTicket>(
    'post',
    `/storage/uploads/${ticket.reference.id}/complete`,
    {},
    { csrf: 'required', signal },
  )
  return completed.reference
}

/** Replace large arrays/strings, keeping structural metadata available to the API. */
export async function externalizeObjects(
  client: CaembleClient,
  scope: Readonly<Record<string, unknown>>,
  value: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted()
  if (
    (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object' || Array.isArray(item))) ||
    typeof value === 'string'
  ) {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    if (bytes.length > OBJECT_INLINE_BYTES)
      return uploadObject(client, scope, bytes, 'json', signal, Array.isArray(value) ? value.length : undefined)
  }
  if (Array.isArray(value)) {
    const result = []
    for (const member of value) result.push(await externalizeObjects(client, scope, member, signal))
    return result
  }
  if (value && typeof value === 'object') {
    const entries = []
    for (const [key, member] of Object.entries(value))
      entries.push([key, await externalizeObjects(client, scope, member, signal)])
    return Object.fromEntries(entries)
  }
  return value
}

/** Resolve references only at a consumer boundary, never inside an API list endpoint. */
export type ObjectDownloadProgress = Readonly<{ completed: number; total: number }>

export async function resolveObjects<T>(
  client: CaembleClient,
  value: T,
  signal?: AbortSignal,
  onProgress?: (progress: ObjectDownloadProgress) => void,
): Promise<T> {
  const references = new Map<string, ObjectReference>()
  const resolved = new Map<string, unknown>()
  function collect(member: unknown): void {
    signal?.throwIfAborted()
    if (member && typeof member === 'object' && 'kind' in member && member.kind === 'caemble.object') {
      const ref = member as ObjectReference
      if (ref.version !== 1 || !['json', 'base64'].includes(ref.encoding) || !/^[a-f0-9]{64}$/.test(ref.sha256))
        throw new Error('Unsupported stored object reference.')
      const key = JSON.stringify(ref)
      references.set(key, ref)
    } else if (Array.isArray(member)) member.forEach(collect)
    else if (member && typeof member === 'object') Object.values(member).forEach(collect)
  }
  collect(value)
  const queue = [...references.entries()]
  let next = 0
  let completed = 0
  let failed = false
  onProgress?.({ completed, total: queue.length })
  async function download() {
    while (!failed && next < queue.length) {
      signal?.throwIfAborted()
      const [key, ref] = queue[next++]
      try {
        const result = await (async () => {
          let ticket = await client.request<ObjectTicket>(
            'get',
            `/storage/objects/${encodeURIComponent(ref.id)}`,
            undefined,
            { signal },
          )
          if (
            ticket.reference.sha256 !== ref.sha256 ||
            ticket.reference.byteLength !== ref.byteLength ||
            ticket.reference.encoding !== ref.encoding
          )
            throw new Error('Stored object identity does not match its reference.')
          const bytes = new Uint8Array(ref.byteLength)
          let offset = 0
          for (let index = 0; index < ticket.parts.length; index++) {
            let partBytes: Uint8Array | undefined
            for (let attempt = 0; ; attempt++) {
              try {
                const response = await fetch(ticket.parts[index].url, {
                  credentials: 'omit',
                  redirect: 'error',
                  signal,
                })
                if (!response.ok) throw new Error(`S3 download failed (${response.status}).`)
                partBytes = new Uint8Array(await response.arrayBuffer())
                break
              } catch (error) {
                signal?.throwIfAborted()
                if (attempt >= 2) throw error
                ticket = await client.request<ObjectTicket>(
                  'get',
                  `/storage/objects/${encodeURIComponent(ref.id)}`,
                  undefined,
                  { signal },
                )
              }
            }
            const part = ticket.parts[index]
            if (partBytes.length !== part.byteLength || (await objectHash(partBytes)) !== part.sha256)
              throw new Error('Stored object chunk checksum does not match.')
            bytes.set(partBytes, offset)
            offset += partBytes.length
          }
          if (offset !== ref.byteLength || (await objectHash(bytes)) !== ref.sha256)
            throw new Error('Stored object checksum does not match.')
          if (ref.encoding === 'json') return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          let binary = ''
          for (let start = 0; start < bytes.length; start += 8192)
            binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
          return btoa(binary)
        })()
        signal?.throwIfAborted()
        resolved.set(key, result)
        onProgress?.({ completed: ++completed, total: queue.length })
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, download))
  function visit(member: unknown): unknown {
    signal?.throwIfAborted()
    if (member && typeof member === 'object' && 'kind' in member && member.kind === 'caemble.object')
      return resolved.get(JSON.stringify(member))
    if (Array.isArray(member)) {
      return member.map(visit)
    }
    if (member && typeof member === 'object') {
      const entries = []
      for (const [key, child] of Object.entries(member)) entries.push([key, visit(child)])
      return Object.fromEntries(entries)
    }
    return member
  }
  return visit(value) as T
}
