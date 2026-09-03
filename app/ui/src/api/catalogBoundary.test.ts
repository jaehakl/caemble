import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogApi } from './catalog'
import { ApiContractError } from './http'

const quantityKind = {
  name: 'Length',
  domain: 'mechanics',
  tensorOrder: 0,
  description: null,
  opaque: false,
  applicableUnits: ['m'],
}

const descriptor = {
  name: 'solver',
  version: '1.0.0',
  description: 'Solver',
  referenceLengthUnit: 'm',
  parameters: {},
  materials: [],
  inputPorts: {},
  observations: {},
  methods: { initializations: [], boundaryConditions: [], outputs: [] },
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function stubJson(body: unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('Catalog API response boundaries', () => {
  it('validates meta fields, preserves extensions, and forwards AbortSignal', async () => {
    const controller = new AbortController()
    const fetchMock = stubJson({
      catalogRevision: 'revision-1',
      quantityKindDataVersion: '1',
      materialCatalogVersion: '1',
      quantityKindCount: 1,
      materialParameterCount: 2,
      materialModelCount: 1,
      solverCount: 1,
      experimentCount: 1,
      materialGlobalQualifiers: ['temperature'],
      materialDesignRules: { canonicalKey: 'domain.name' },
      futureField: 'kept',
    })

    const result = await catalogApi.meta({ signal: controller.signal })

    expect(result).toHaveProperty('futureField', 'kept')
    expect(fetchMock).toHaveBeenCalledWith('/api/catalog/meta', expect.objectContaining({ signal: controller.signal }))
  })

  it('rejects malformed paged QuantityKind items with endpoint context', async () => {
    stubJson({
      items: [{ ...quantityKind, tensorOrder: '0' }],
      nextCursor: null,
      total: 1,
    })

    const result = catalogApi.listQuantityKinds({ limit: 10 })

    await expect(result).rejects.toBeInstanceOf(ApiContractError)
    await expect(result).rejects.toMatchObject({ path: '/catalog/quantity-kinds?limit=10' })
  })

  it('accepts backend-extensible search kinds and fields', async () => {
    stubJson({
      items: [
        {
          kind: 'futureCatalogResource',
          key: 'future.resource',
          title: 'Future resource',
          subtitle: 'Extension',
          futureField: true,
        },
      ],
    })

    const result = await catalogApi.search('future')

    expect(result[0]).toMatchObject({ kind: 'futureCatalogResource', futureField: true })
  })

  it('rejects unsupported MaterialModel semantics before they reach sampled-relation consumers', async () => {
    stubJson({
      items: [
        {
          key: 'model.future.curve',
          labelKo: '미지원 모델',
          kind: 'future_relation',
          input: { name: 'x', quantityKind: 'Dimensionless' },
          output: { name: 'y', quantityKind: 'Dimensionless' },
          minimumSamples: 2,
          sharedBasis: false,
        },
      ],
      nextCursor: null,
      total: 1,
    })

    await expect(catalogApi.listMaterialModels()).rejects.toBeInstanceOf(ApiContractError)
  })

  it('validates the Solver descriptor fields consumed by the catalog UI', async () => {
    stubJson({
      name: 'solver',
      version: '1.0.0',
      description: 'Solver',
      descriptor: { ...descriptor, methods: null },
      materialRequirements: [],
      quantityKindUsages: [],
      producesArtifacts: [],
      consumesArtifacts: [],
    })

    await expect(catalogApi.getSolver('solver', '1.0.0')).rejects.toMatchObject({
      name: 'ApiContractError',
      path: '/catalog/solvers/solver/1.0.0',
    })
  })

  it('preserves extensible Solver descriptor fields after validating its usable shape', async () => {
    stubJson({
      name: 'solver',
      version: '1.0.0',
      description: 'Solver',
      descriptor: {
        ...descriptor,
        parameters: {
          gain: {
            description: 'Gain',
            data: {
              dtype: 'float64',
              unit: '{fraction}',
              quantityKind: 'DimensionlessRatio',
              tensorOrder: 0,
            },
          },
        },
        futureCapability: { enabled: true },
      },
      materialRequirements: [],
      quantityKindUsages: [],
      producesArtifacts: [],
      consumesArtifacts: [],
    })

    const result = await catalogApi.getSolver('solver', '1.0.0')

    expect(result.descriptor).toHaveProperty('futureCapability', { enabled: true })
    expect(result.descriptor.parameters.gain?.data).toHaveProperty('tensorOrder', 0)
  })

  it('rejects KernelValueSpec variants that violate dtype-dependent fields', async () => {
    stubJson({
      name: 'solver',
      version: '1.0.0',
      description: 'Solver',
      descriptor: {
        ...descriptor,
        parameters: {
          count: {
            description: 'Count',
            data: { dtype: 'int32', unit: '1' },
          },
        },
      },
      materialRequirements: [],
      quantityKindUsages: [],
      producesArtifacts: [],
      consumesArtifacts: [],
    })

    await expect(catalogApi.getSolver('solver', '1.0.0')).rejects.toBeInstanceOf(ApiContractError)
  })

  it('validates nested runtime-slice records before installing catalog data', async () => {
    stubJson({
      catalogRevision: 'revision-1',
      solvers: [{ name: 'solver', version: '1.0.0', descriptor }],
      quantityKinds: [{ ...quantityKind, applicableUnits: 'm' }],
      materialParameters: [],
      materialModels: [],
      materialGlobalQualifiers: [],
      warnings: [],
    })

    await expect(
      catalogApi.runtimeSlice({ solvers: [], quantityKinds: [], materialParameters: [], materialModels: [] }),
    ).rejects.toMatchObject({ name: 'ApiContractError', path: '/catalog/runtime-slice' })
  })

  it('validates Experiment source bundles while retaining future summary fields', async () => {
    stubJson({
      key: 'beam',
      namespace: 'caemble',
      repository: 'examples',
      version: '1.0.0',
      coordinate: 'caemble:experiment/caemble/examples/beam@1.0.0',
      title: 'Beam',
      description: 'Example',
      bundleHash: 'hash',
      concepts: [],
      relatedSolvers: [],
      sourceBundle: { files: { 'experiment.tsx': 42 } },
    })

    await expect(catalogApi.getExperiment('beam')).rejects.toMatchObject({
      name: 'ApiContractError',
      path: '/catalog/experiments/beam',
    })
  })
})
