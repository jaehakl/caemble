import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogRuntimeSlice } from '@caemble/execution/contracts/catalog'
import type { CompiledCadDocument } from '@caemble/execution/cad/compiler/types'
import type { CadGeometryPreviewResponse } from '@caemble/execution/cad/worker/protocol'
import {
  evaluateDocument,
  evaluateGeometryModule,
  inspectDocument,
  preparePredictionDocument,
} from './evaluateDocument'

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  install: vi.fn(),
  register: vi.fn(),
  run: vi.fn(),
  deserialize: vi.fn(),
}))
vi.mock('@caemble/execution/cad/execution/mesh', () => ({ deserializeCadScene: mocks.deserialize }))
vi.mock('../compiler/monacoCompiler', () => ({ compileCadDocument: mocks.compile }))
vi.mock('@caemble/execution/catalog/runtime', () => ({
  installCatalogRuntimeSlice: mocks.install,
  registerSourceCatalogRuntimeSlice: mocks.register,
}))
vi.mock('@/platform/isolated-runner/client', () => ({
  evaluateInIsolatedRunner: mocks.run,
  inspectInIsolatedRunner: mocks.run,
  previewGeometryInIsolatedRunner: mocks.run,
  preparePredictionInIsolatedRunner: mocks.run,
}))

const catalog: CatalogRuntimeSlice = {
  catalogRevision: 'test',
  solvers: [],
  quantityKinds: [],
  materialModels: [],
  warnings: [],
}
const document = { kind: 'experiment' as const, sourceBundle: { files: { 'experiment.tsx': 'export {}' } } }
const compiled: CompiledCadDocument = { sourceHash: 'test', sources: {} }

afterEach(() => vi.useRealTimers())

describe('runner settlement', () => {
  it('rejects a response conversion error instead of leaving the operation pending', async () => {
    vi.useFakeTimers()
    mocks.compile.mockResolvedValue(compiled)
    const error = new Error('Geometry mesh could not be restored.')
    mocks.deserialize.mockImplementation(() => {
      throw error
    })
    let deliver!: (response: CadGeometryPreviewResponse) => void
    mocks.run.mockImplementation((_request, callbacks) => {
      callbacks.onStart()
      deliver = callbacks.onResponse
      return vi.fn()
    })
    const pending = evaluateGeometryModule(document, 'geometry.tsx', 'Part', { catalog })
    const rejected = expect(pending).rejects.toBe(error)
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled())
    expect(() =>
      deliver({
        type: 'geometry-preview-success',
        requestId: 'preview',
        revision: 0,
        documentType: 'geometry',
        sourceHash: compiled.sourceHash,
        scene: {} as Extract<CadGeometryPreviewResponse, { type: 'geometry-preview-success' }>['scene'],
      }),
    ).not.toThrow()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes timers and cancellation listeners when starting the runner throws', async () => {
    vi.useFakeTimers()
    mocks.compile.mockResolvedValue(compiled)
    const abort = new AbortController()
    const removeListener = vi.spyOn(abort.signal, 'removeEventListener')
    const error = new Error('Runner is unavailable.')
    mocks.run.mockImplementation((_request, callbacks) => {
      callbacks.onStart()
      throw error
    })
    await expect(inspectDocument(document, { catalog, signal: abort.signal })).rejects.toBe(error)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a runner when cancellation arrives synchronously during startup', async () => {
    mocks.compile.mockResolvedValue(compiled)
    const abort = new AbortController()
    const cancel = vi.fn()
    mocks.run.mockImplementation(() => {
      abort.abort()
      return cancel
    })
    await expect(inspectDocument(document, { catalog, signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe.each(['inspect', 'evaluate', 'prediction', 'geometry'] as const)('%s cancellation', (operation) => {
  function run(signal: AbortSignal, catalogFetcher = async () => catalog) {
    const options = { signal, catalogFetcher }
    if (operation === 'inspect') return inspectDocument(document, options)
    if (operation === 'evaluate') return evaluateDocument({ document, vars: {} }, options)
    if (operation === 'prediction') return preparePredictionDocument({ document, vars: {} }, [], options)
    return evaluateGeometryModule(document, 'geometry.tsx', 'Part', options)
  }

  it('does not compile or install a catalog after cancellation during fetching', async () => {
    const abort = new AbortController()
    let resolve!: (value: CatalogRuntimeSlice) => void
    const pending = run(
      abort.signal,
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    resolve(catalog)
    await rejected
    expect(mocks.compile).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('forwards the signal and rejects a compile result delivered after cancellation', async () => {
    const abort = new AbortController()
    mocks.compile.mockImplementation(async () => {
      abort.abort()
      return compiled
    })
    await expect(run(abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.compile).toHaveBeenCalledWith(document, {
      catalog,
      catalogRevision: catalog.catalogRevision,
      signal: abort.signal,
    })
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
