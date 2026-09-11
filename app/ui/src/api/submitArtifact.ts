import { createCaeBatches } from './cae'
import type { CaembleClient } from './http'
import { type BuildArtifact, type BuildArtifactItem } from '@/contracts/build'
import { parseArtifactInput, parseBuildArtifact } from '@/lib/cae/artifact'
import { cadSourceHash } from '@/lib/cad/source/document'
import { externalizeObjects, OBJECT_INLINE_BYTES, uploadObject } from './objectStorage'

export async function sha256Bytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function submitArtifact(
  options: Readonly<{
    client: CaembleClient
    artifact: BuildArtifact
    experimentId: number | null
    preflightMode?: 'brief' | 'full'
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
    ...(options.preflightMode
      ? { preflight: true, execution_mode: options.preflightMode, source_bundle: artifact.source_bundle }
      : {}),
    experiment_source_hash: artifact.source_hash,
    mode: artifact.mode,
    catalog_revision: artifact.catalog_revision,
    builder_version: artifact.builder_version,
    storage_version: 1,
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
    const input = parseArtifactInput(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), artifact)
    let body: unknown = { input }
    if (bytes.length > OBJECT_INLINE_BYTES) {
      const job =
        batch.jobs.find((entry) => entry.index === item.index) ??
        (await batches.read(batch.id, { offset: item.index - 1, limit: 1 }, { signal: options.signal })).jobs[0]
      if (!job || job.index !== item.index) throw new Error('Batch input job is missing.')
      const scope = { purpose: 'input', experiment_id: options.experimentId, job_id: job.id }
      const stored = await uploadObject(options.client, scope, bytes, 'json', options.signal)
      const experiment = input.measurement.experiment
      const projection = (await externalizeObjects(
        options.client,
        scope,
        {
          measurement: {
            ...input.measurement,
            experiment: {
              ...experiment,
              simulationProgram: { ...experiment.simulationProgram, pythonSource: '' },
              scene: {},
              taskScenes: Object.fromEntries(Object.keys(experiment.taskScenes).map((name) => [name, {}])),
            },
          },
        },
        options.signal,
      )) as typeof input
      // The API compares executable source with the saved Experiment; only data
      // becomes an object reference in this metadata projection.
      const projectedExperiment = projection.measurement.experiment
      body = {
        input: stored,
        projection: {
          measurement: {
            ...projection.measurement,
            experiment: {
              ...projectedExperiment,
              simulationProgram: {
                ...projectedExperiment.simulationProgram,
                pythonSource: experiment.simulationProgram.pythonSource,
              },
            },
          },
        },
      }
    }
    await batches.finalize(batch.id, item.index, options.signal, body)
    options.onProgress?.(item.index, artifact.items.length)
  }
  return batches.commit(batch.id, options.signal)
}
