import { createCaeBatches } from './cae'
import type { CaembleClient } from './http'
import { UPLOAD_CHUNK_BYTES, type BuildArtifact, type BuildArtifactItem } from '@/contracts/build'
import { parseArtifactInput, parseBuildArtifact } from '@/lib/cae/artifact'
import { cadSourceHash } from '@/lib/cad/source/document'

export async function sha256Bytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function submitArtifact(
  options: Readonly<{
    client: CaembleClient
    artifact: BuildArtifact
    experimentId: number
    requestId: string
    readItem: (item: BuildArtifactItem) => Promise<Uint8Array>
    signal?: AbortSignal
    onRegistered?: (id: string) => void | Promise<void>
    onProgress?: (completed: number, total: number) => void
  }>,
) {
  const artifact = parseBuildArtifact(options.artifact)
  if ((await cadSourceHash({ kind: 'experiment', sourceBundle: artifact.source_bundle })) !== artifact.source_hash)
    throw new Error('Artifact source bundle has changed.')
  const batches = createCaeBatches(options.client)
  options.signal?.throwIfAborted()
  const batch = await batches.create({
    request_id: options.requestId,
    experiment_id: options.experimentId,
    experiment_source_hash: artifact.source_hash,
    mode: artifact.mode,
    catalog_revision: artifact.catalog_revision,
    builder_version: artifact.builder_version,
    items: artifact.items.map(({ index, input_hash, byte_length, measurement_id }) => ({
      index,
      input_hash,
      byte_length,
      measurement_id,
    })),
  })
  await options.onRegistered?.(batch.id)
  if (batch.state !== 'uploading') return batch
  for (const item of artifact.items) {
    options.signal?.throwIfAborted()
    const bytes = await options.readItem(item)
    if (bytes.byteLength !== item.byte_length || (await sha256Bytes(bytes)) !== item.input_hash)
      throw new Error(`Artifact input ${item.index} failed its integrity check.`)
    parseArtifactInput(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), artifact)
    for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES)
      await batches.uploadChunk(
        batch.id,
        item.index,
        offset / UPLOAD_CHUNK_BYTES,
        chunk,
        await sha256Bytes(chunk),
        options.signal,
      )
    }
    await batches.finalize(batch.id, item.index, options.signal)
    options.onProgress?.(item.index, artifact.items.length)
  }
  return batches.commit(batch.id, options.signal)
}
