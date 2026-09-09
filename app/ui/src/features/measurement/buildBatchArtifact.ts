import { dbTables, getListRequest } from '@/api'
import { sha256Bytes } from '@/api/submitArtifact'
import { BUILD_VERSION, type BuildArtifact } from '@/contracts/build'
import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'
import { fetchCatalogRuntimeSlice } from '@/features/viewer/workspace/catalogRuntime'
import { prepareBrowserMeasurement } from '@/platform/browser/build'
import { BrowserArtifactStore } from '@/platform/browser/artifactStore'
import { parseArtifactInput } from '@/lib/cae/artifact'
import type { Vars } from '@/lib/cad/model/types'

export type BrowserBatchIntent = Readonly<{
  request_id: string
  experiment_id: number
  experiment_source_hash: string
  mode: 'generate' | 'candidate' | 'measurement'
  count?: number
  vars?: Readonly<Record<string, unknown>>
  material_snapshot?: MeasurementMaterialSnapshot
  measurement_id?: number
  evaluation_timeout_ms?: number
  candidates?: BrowserBatchCandidates
}>

export type BrowserBatchCandidates = Readonly<{
  count: number
  algorithm?: 'monte-carlo' | 'latin-hypercube'
  next: (attempt: number, signal: AbortSignal) => Promise<Readonly<Vars>>
  accepted: (attempt: number) => Promise<void>
  failed: (attempt: number, cause: unknown) => void
}>

export async function buildBatchArtifact(
  request: BrowserBatchIntent,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
) {
  const saved = (
    await dbTables.Experiment.listRows(
      { ...getListRequest(), selected_ids: [request.experiment_id], limit: 1 },
      { signal },
    )
  ).items.find((item) => item.id === request.experiment_id)
  if (!saved?.source_bundle) throw new Error('Experiment source bundle is missing.')
  if (saved.source_hash && saved.source_hash !== request.experiment_source_hash)
    throw new Error('Experiment source changed before preparing the Batch.')
  const source_bundle = saved.source_bundle
  const catalog = await fetchCatalogRuntimeSlice(source_bundle)
  let vars = request.vars
  let material_snapshot = request.material_snapshot
  if (request.mode === 'measurement') {
    const measurement = (
      await dbTables.Measurement.listRows(
        { ...getListRequest(), selected_ids: [request.measurement_id!], limit: 1 },
        { signal },
      )
    ).items.find((item) => item.id === request.measurement_id)
    if (!measurement || measurement.experiment_id !== request.experiment_id)
      throw new Error('The Measurement no longer belongs to this Experiment.')
    vars = measurement.vars
    material_snapshot = measurement.material_snapshot
  }
  const store = await BrowserArtifactStore.open(request.request_id)
  const artifact: BuildArtifact = {
    kind: 'caemble.build',
    version: 2,
    source_hash: request.experiment_source_hash,
    source_bundle,
    catalog_revision: catalog.catalogRevision,
    builder_version: BUILD_VERSION,
    mode: request.mode,
    items: [],
  }
  try {
    const total = request.candidates?.count ?? (request.mode === 'generate' ? (request.count ?? 1) : 1)
    if (!Number.isSafeInteger(total) || total < 1) throw new Error('Batch count must be a positive safe integer.')
    if (request.candidates && request.mode !== 'candidate') throw new Error('Candidate inputs require candidate mode.')
    for (let attempt = 1; attempt <= total; attempt++) {
      signal.throwIfAborted()
      let bytes: Uint8Array
      try {
        const candidateVars = request.candidates ? await request.candidates.next(attempt, signal) : vars
        const input = await prepareBrowserMeasurement(
          {
            source_bundle,
            source_hash: artifact.source_hash,
            catalog,
            mode: request.mode,
            vars: candidateVars as Vars | undefined,
            material_snapshot,
            evaluation_timeout_ms: request.evaluation_timeout_ms,
          },
          signal,
        )
        bytes = new TextEncoder().encode(JSON.stringify(parseArtifactInput(input, artifact)))
      } catch (cause) {
        signal.throwIfAborted()
        if (!request.candidates || (cause as { name?: string })?.name === 'AbortError') throw cause
        request.candidates.failed(attempt, cause)
        onProgress(attempt, total)
        continue
      }
      signal.throwIfAborted()
      const index = artifact.items.length + 1
      const item = {
        index,
        file: `items/${index}.json`,
        input_hash: await sha256Bytes(bytes),
        byte_length: bytes.byteLength,
        ...(request.measurement_id ? { measurement_id: request.measurement_id } : {}),
      }
      await store.saveItem(item, bytes)
      artifact.items.push(item)
      await request.candidates?.accepted(attempt)
      onProgress(attempt, total)
    }
    if (!artifact.items.length) throw new Error('준비에 성공한 Sampling 후보가 없습니다.')
    await store.saveManifest(artifact)
    return { artifact, store }
  } catch (error) {
    store.close()
    throw error
  }
}
