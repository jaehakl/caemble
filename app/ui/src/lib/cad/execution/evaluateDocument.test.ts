import { describe, expect, it, vi } from 'vitest'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { CompiledCadDocument } from '../compiler/types'
import {
  evaluateDocument,
  evaluateGeometryModule,
  inspectDocument,
  preparePredictionDocument,
} from './evaluateDocument'

const mocks = vi.hoisted(() => ({ compile: vi.fn(), install: vi.fn(), register: vi.fn(), run: vi.fn() }))
vi.mock('../compiler/monacoCompiler', () => ({ compileCadDocument: mocks.compile }))
vi.mock('@/lib/catalog/runtime', () => ({
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
