import { describe, expect, it, vi } from 'vitest'
import { catalogApi, type CatalogRuntimeSlice } from '@/api/catalog'
import { createExperimentSourceBundle, type ExperimentSourceBundle } from '../cad/source/document'
import { extractCatalogSourceReferences, fetchCatalogRuntimeSlice } from './references'

function bundle(overrides: Partial<Record<'experiment.tsx' | 'material.tsx' | 'tasks/main.tsx', string>> = {}) {
  return createExperimentSourceBundle({
    'experiment.tsx':
      overrides['experiment.tsx'] ??
      `
import { experiment } from '@caemble/core'
const qk = 'geometry.Length'
const dynamicKey = getKey()
const unrelated = { [dynamicKey]: 1 }
export default experiment({
  lengthUnit: 'm', varsSchema: {}, geometry: () => null,
  recordedData: { length: { dtype: 'float64', unit: 'm', quantityKind: qk } },
})
`,
    'material.tsx':
      overrides['material.tsx'] ??
      `
import { Material } from '@caemble/core'
export const Referenced = new Material('Referenced', 'vendor/2026')
export const Copper = new Material('Copper', {
  'electrical.conductivity': { dtype: 'float64', value: 1, unit: 'S.m-1' },
  'model.magnetic.b_h': { kind: 'sampled_relation', input: {}, output: {} },
  color: '#ffaa00',
})
`,
    'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
    'tasks/main.tsx':
      overrides['tasks/main.tsx'] ??
      `
import { defineTask } from '@caemble/core'
const solverName = 'test-solver'
const solverVersion = '1.2.3'
export default defineTask({
  kernel: { name: solverName, version: solverVersion },
  config: () => ({ parameters: {}, initializations: [], boundaryConditions: [], outputs: [] }),
})
`,
  })
}

describe('runtime catalog source references', () => {
  it('collects fixed solver, QuantityKind, Material parameter, and model references', () => {
    expect(extractCatalogSourceReferences(bundle())).toEqual({
      solvers: [{ name: 'test-solver', version: '1.2.3' }],
      draftTaskNames: [],
      quantityKinds: ['geometry.Length'],
      materialParameters: ['electrical.conductivity'],
      materialModels: ['model.magnetic.b_h'],
    })
  })

  it('omits only the reserved Draft Task kernel from the API request', async () => {
    const draft = bundle({
      'tasks/main.tsx': `
import { defineTask } from '@caemble/core'
export default defineTask({
  kernel: { name: 'replace-with-solver', version: '1.0.0' },
  config: () => ({}),
})
`,
    })
    expect(extractCatalogSourceReferences(draft)).toMatchObject({
      solvers: [],
      draftTaskNames: ['main'],
    })

    const runtimeSlice = { catalogRevision: 'draft-revision' } as CatalogRuntimeSlice
    const request = vi.spyOn(catalogApi, 'runtimeSlice').mockResolvedValue(runtimeSlice)
    await fetchCatalogRuntimeSlice(draft)
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ solvers: [] }))
    expect(request.mock.calls[0][0]).not.toHaveProperty('draftTaskNames')
    request.mockRestore()

    expect(
      extractCatalogSourceReferences(
        bundle({
          'tasks/main.tsx': `
import { defineTask } from '@caemble/core'
export default defineTask({
  kernel: { name: 'replace-with-solver', version: '1.0.1' },
  config: () => ({}),
})
`,
        }),
      ).solvers,
    ).toEqual([{ name: 'replace-with-solver', version: '1.0.1' }])
  })

  it('returns one immutable empty slice without an API call for a reference-free Draft-only bundle', async () => {
    const draft = bundle({
      'experiment.tsx': `
import { experiment } from '@caemble/core'
export default experiment({
  lengthUnit: 'm', varsSchema: {}, geometry: () => null, recordedData: {},
})
`,
      'material.tsx': 'export {}',
      'tasks/main.tsx': `
import { defineTask } from '@caemble/core'
export default defineTask({
  kernel: { name: 'replace-with-solver', version: '1.0.0' },
  config: () => ({}),
})
`,
    })
    const request = vi.spyOn(catalogApi, 'runtimeSlice')

    const first = await fetchCatalogRuntimeSlice(draft)
    const second = await fetchCatalogRuntimeSlice(draft)

    expect(request).not.toHaveBeenCalled()
    expect(first).toBe(second)
    expect(first).toEqual({
      schemaVersion: 1,
      catalogRevision: 'draft-only-empty-v1',
      solvers: [],
      quantityKinds: [],
      materialParameters: [],
      materialModels: [],
      materialGlobalQualifiers: [],
      warnings: [],
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.solvers)).toBe(true)
    expect(Object.isFrozen(first.quantityKinds)).toBe(true)
    expect(Object.isFrozen(first.materialParameters)).toBe(true)
    expect(Object.isFrozen(first.materialModels)).toBe(true)
    expect(Object.isFrozen(first.materialGlobalQualifiers)).toBe(true)
    expect(Object.isFrozen(first.warnings)).toBe(true)
    request.mockRestore()
  })

  it('allows a two-argument Material source selector and unrelated computed object keys', () => {
    expect(() => extractCatalogSourceReferences(bundle())).not.toThrow()
  })

  it('rejects references that cannot be known before evaluation', () => {
    expect(() =>
      extractCatalogSourceReferences(
        bundle({
          'experiment.tsx': `
import { experiment } from '@caemble/core'
export default experiment({ lengthUnit: 'm', varsSchema: {}, geometry: () => null,
  recordedData: { value: { dtype: 'float64', unit: 'm', quantityKind: chooseKind() } } })
`,
        }),
      ),
    ).toThrow('quantityKind must be a fixed string literal')
    expect(() =>
      extractCatalogSourceReferences(
        bundle({
          'material.tsx': `
import { Material } from '@caemble/core'
export const Broken = new Material('Broken', { [chooseKey()]: { dtype: 'float64', value: 1, unit: 'm' } })
`,
        }),
      ),
    ).toThrow('Catalog object key must be a fixed string literal')
    expect(() =>
      extractCatalogSourceReferences(
        bundle({
          'tasks/main.tsx': `
import { defineTask } from '@caemble/core'
export default defineTask({ kernel: getSolver(), config: () => ({}) })
`,
        }),
      ),
    ).toThrow('Task kernel must be a fixed object literal')
  })

  it('reuses one immutable runtime slice promise for an identical source reference set', async () => {
    const runtimeSlice = { catalogRevision: 'test-revision' } as CatalogRuntimeSlice
    const request = vi.spyOn(catalogApi, 'runtimeSlice').mockResolvedValue(runtimeSlice)
    const source = bundle() as ExperimentSourceBundle

    const [first, second] = await Promise.all([fetchCatalogRuntimeSlice(source), fetchCatalogRuntimeSlice(source)])

    expect(request).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
    request.mockRestore()
  })
})
