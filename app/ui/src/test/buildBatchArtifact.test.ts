// @vitest-environment node
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { compileCatalogExample, readCatalogExamples } from '../../scripts/catalog-example-support'
import { prepareCaeMeasurement } from '@/platform/node/build'
import type { CadPreparationRequest, CadPreparationResponse } from '@/lib/cad/worker/protocol'
import type { RunnerOperationResultEnvelope } from '@/platform/isolated-runner/protocol'
import type { BuiltArtifactInput } from '@/lib/cae/artifact'
import type { BuildArtifact } from '@/contracts/build'
import type { CaePreparationRequest } from '@/lib/cae/build'
import { measurementMaterialSnapshot } from '@/lib/cad/execution/measurement'
import { sha256Bytes } from '@/api/submitArtifact'
import { buildBatchArtifact } from '@/features/measurement/buildBatchArtifact'

const mocks = vi.hoisted(() => ({
  experiment: vi.fn(),
  catalog: vi.fn(),
  compile: vi.fn(),
  prepare: vi.fn(),
  saveItem: vi.fn(),
  saveManifest: vi.fn(),
  close: vi.fn(),
}))
vi.mock('@/api', () => ({ dbTables: { Experiment: { listRows: mocks.experiment } }, getListRequest: () => ({}) }))
vi.mock('@/features/viewer/workspace/catalogRuntime', () => ({ fetchCatalogRuntimeSlice: mocks.catalog }))
vi.mock('@/lib/cad/compiler/monacoCompiler', () => ({ compileCadDocument: mocks.compile }))
vi.mock('@/platform/isolated-runner/client', () => ({ prepareInIsolatedRunner: mocks.prepare }))
vi.mock('@/platform/browser/artifactStore', () => ({
  BrowserArtifactStore: {
    open: async () => ({ saveItem: mocks.saveItem, saveManifest: mocks.saveManifest, close: mocks.close }),
  },
}))

describe('browser build artifact contract', () => {
  let input: BuiltArtifactInput
  let sourceHash: string
  let bytes: Uint8Array
  let artifact: BuildArtifact
  let request: CaePreparationRequest
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
    reportError: vi.fn(),
  }

  beforeAll(async () => {
    vi.stubGlobal('self', worker)
    await import('@/lib/cad/runner/evaluation.worker')
    const { examples, catalog } = readCatalogExamples(path.resolve('../catalog/caemble_catalog/catalog.sqlite3'))
    const example = examples.find((item) => item.key === 'electro-thermal-notched-bar')!
    sourceHash = example.bundleHash
    request = { source_bundle: example.sourceBundle, source_hash: sourceHash, catalog, mode: 'generate' }
    mocks.experiment.mockResolvedValue({ items: [{ id: 7, source_bundle: example.sourceBundle }] })
    mocks.catalog.mockResolvedValue(catalog)
    mocks.compile.mockResolvedValue(compileCatalogExample(example, catalog))
    mocks.prepare.mockImplementation(
      (request: CadPreparationRequest, callbacks: { onResponse: (response: CadPreparationResponse) => void }) => {
        worker.postMessage.mockImplementation((envelope: RunnerOperationResultEnvelope) => {
          expect(envelope.response.type).toBe('preparation-success')
          callbacks.onResponse(structuredClone(envelope.response) as CadPreparationResponse)
        })
        worker.onmessage!({ data: { type: 'prepare', nonce: 'artifact-regression-test', request } })
        return vi.fn()
      },
    )

    const built = await buildBatchArtifact(
      { request_id: 'browser-build', experiment_id: 7, experiment_source_hash: sourceHash, mode: 'generate' },
      new AbortController().signal,
      vi.fn(),
    )
    artifact = built.artifact
    expect(worker.reportError).not.toHaveBeenCalled()
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    bytes = mocks.saveItem.mock.calls[0][1] as Uint8Array
    input = JSON.parse(new TextDecoder().decode(bytes)) as BuiltArtifactInput
    expect(mocks.saveManifest).toHaveBeenCalledWith(artifact)
  }, 30_000)
  afterAll(() => vi.unstubAllGlobals())

  it('stores only the artifact envelope from a real Catalog build through the worker and browser adapter', async () => {
    expect(Object.keys(input).sort()).toEqual(['measurement', 'presentation'])
    expect(artifact.items[0].input_hash).toBe(await sha256Bytes(bytes))
    expect(artifact.items[0].byte_length).toBe(bytes.byteLength)

    const fixed = await prepareCaeMeasurement(
      {
        ...request,
        mode: 'measurement',
        vars: input.measurement.experiment.variables,
        material_snapshot: measurementMaterialSnapshot(input.measurement),
      },
      path.resolve('src/lib/cad/api'),
    )
    expect(input).toEqual(
      JSON.parse(JSON.stringify({ measurement: fixed.measurement, presentation: fixed.presentation })),
    )
  }, 30_000)

  it.skipIf(!process.env.CAEMBLE_TEST_API_PYTHON)(
    'passes the unchanged stored bytes through the API Python validator',
    () => {
      const checked = execFileSync(
        process.env.CAEMBLE_TEST_API_PYTHON!,
        [
          '-X',
          'utf8',
          '-c',
          'import json,sys; sys.path.insert(0,"app"); from cae.uploads import validate_artifact_item; value=json.load(sys.stdin); print(json.dumps(validate_artifact_item(value,sys.argv[1])))',
          sourceHash,
        ],
        { cwd: path.resolve('../api'), input: bytes, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      )
      expect(JSON.parse(checked)).toEqual(input)
    },
  )

  it('rejects a malformed worker input before saving or hashing it', async () => {
    mocks.experiment.mockResolvedValue({ items: [{ id: 7, source_bundle: request.source_bundle }] })
    mocks.catalog.mockResolvedValue(request.catalog)
    mocks.compile.mockResolvedValue({ sourceHash })
    mocks.prepare.mockImplementation(
      (_request: CadPreparationRequest, callbacks: { onResponse: (response: unknown) => void }) => {
        callbacks.onResponse({ type: 'preparation-success', input: { ...input, warnings: [] } })
        return vi.fn()
      },
    )
    await expect(
      buildBatchArtifact(
        { request_id: 'invalid-build', experiment_id: 7, experiment_source_hash: sourceHash, mode: 'generate' },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('Artifact item must contain measurement and optional presentation.')
    expect(mocks.saveItem).not.toHaveBeenCalled()
    expect(mocks.saveManifest).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledOnce()
  })
})
