import { describe, expect, it, vi } from 'vitest'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { createExperimentSourceBundle } from '@/lib/cad/source/document'
import { createCachedCatalogRuntimeSliceResolver } from './references'

const runtimeSlice: CatalogRuntimeSlice = {
  catalogRevision: 'test-revision',
  solvers: [],
  quantityKinds: [],
  materialParameters: [],
  materialModels: [],
  materialGlobalQualifiers: [],
  warnings: [],
}

describe('catalog runtime slice resolution', () => {
  it('does not fetch a runtime slice for a source without catalog references', async () => {
    const fetchRuntimeSlice = vi.fn(async () => runtimeSlice)
    const resolveRuntimeSlice = createCachedCatalogRuntimeSliceResolver(fetchRuntimeSlice)
    const bundle = createExperimentSourceBundle({ 'experiment.tsx': 'export {}\n' })

    await expect(resolveRuntimeSlice(bundle)).resolves.toMatchObject({ catalogRevision: 'draft-only-empty' })
    expect(fetchRuntimeSlice).not.toHaveBeenCalled()
  })

  it('caches fetched slices by their extracted request', async () => {
    const fetchRuntimeSlice = vi.fn(async () => runtimeSlice)
    const resolveRuntimeSlice = createCachedCatalogRuntimeSliceResolver(fetchRuntimeSlice)
    const bundle = createExperimentSourceBundle({
      'experiment.tsx': "const output = { quantityKind: 'length' }\nexport default output\n",
    })

    await expect(resolveRuntimeSlice(bundle)).resolves.toBe(runtimeSlice)
    await expect(resolveRuntimeSlice(bundle)).resolves.toBe(runtimeSlice)
    expect(fetchRuntimeSlice).toHaveBeenCalledOnce()
    expect(fetchRuntimeSlice).toHaveBeenCalledWith({
      materialModels: [],
      materialParameters: [],
      quantityKinds: ['length'],
      solvers: [],
    })
  })

  it('does not retain a rejected fetch in the cache', async () => {
    const fetchRuntimeSlice = vi.fn(async () => runtimeSlice)
    fetchRuntimeSlice.mockRejectedValueOnce(new Error('temporary catalog failure'))
    const resolveRuntimeSlice = createCachedCatalogRuntimeSliceResolver(fetchRuntimeSlice)
    const bundle = createExperimentSourceBundle({
      'experiment.tsx': "const output = { quantityKind: 'length' }\nexport default output\n",
    })

    await expect(resolveRuntimeSlice(bundle)).rejects.toThrow('temporary catalog failure')
    await expect(resolveRuntimeSlice(bundle)).resolves.toBe(runtimeSlice)
    expect(fetchRuntimeSlice).toHaveBeenCalledTimes(2)
  })
})
