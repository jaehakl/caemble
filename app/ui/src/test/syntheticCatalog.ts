import type {
  CatalogMaterialModel,
  CatalogMaterialParameter,
  CatalogQuantityKind,
  CatalogRuntimeSlice,
} from '@/contracts/catalog'
import { installCatalogRuntimeSlice } from '@/lib/catalog/runtime'

type SyntheticQuantityKind = Readonly<
  Pick<CatalogQuantityKind, 'name' | 'applicableUnits'> &
    Partial<Pick<CatalogQuantityKind, 'description' | 'domain' | 'opaque' | 'tensorOrder'>>
>

type SyntheticMaterialParameter = Readonly<
  Pick<CatalogMaterialParameter, 'key' | 'quantityKind'> &
    Partial<Pick<CatalogMaterialParameter, 'domain' | 'labelKo' | 'specialQualifiers'>>
>

export type SyntheticCatalogOptions = Readonly<{
  revision?: string
  quantityKinds?: readonly SyntheticQuantityKind[]
  materialParameters?: readonly SyntheticMaterialParameter[]
  materialModels?: readonly CatalogMaterialModel[]
  solvers?: ReadonlyArray<CatalogRuntimeSlice['solvers'][number]>
  materialGlobalQualifiers?: readonly string[]
}>

export function buildSyntheticSolver(
  name = 'synthetic-solver',
  version = '1',
): CatalogRuntimeSlice['solvers'][number] {
  return {
    name,
    version,
    contractDigest: '0'.repeat(64),
    descriptor: {
      name,
      version,
      description: 'Synthetic test Solver.',
      referenceLengthUnit: 'm',
      minimumOutputs: 0,
      parameters: {},
      materials: [],
      inputPorts: {},
      observations: {},
      methods: { initializations: [], boundaryConditions: [], outputs: [] },
    },
  }
}

export function buildSyntheticCatalog(options: SyntheticCatalogOptions = {}): CatalogRuntimeSlice {
  return {
    schemaVersion: 1,
    catalogRevision: options.revision ?? 'synthetic-test-catalog-v1',
    quantityKinds: (options.quantityKinds ?? []).map((entry) => ({
      name: entry.name,
      domain: entry.domain ?? 'synthetic',
      tensorOrder: entry.tensorOrder ?? 0,
      description: entry.description ?? null,
      opaque: entry.opaque ?? false,
      applicableUnits: [...entry.applicableUnits],
    })),
    materialParameters: (options.materialParameters ?? []).map((entry) => ({
      key: entry.key,
      domain: entry.domain ?? entry.key.split('.')[0],
      labelKo: entry.labelKo ?? entry.key,
      quantityKind: entry.quantityKind,
      specialQualifiers: [...(entry.specialQualifiers ?? [])],
    })),
    materialModels: (options.materialModels ?? []).map((entry) => structuredClone(entry)),
    materialGlobalQualifiers: [...(options.materialGlobalQualifiers ?? ['color', 'errorRate'])],
    solvers: (options.solvers ?? []).map((entry) => structuredClone(entry)),
    warnings: [],
  }
}

export function installSyntheticCatalog(options: SyntheticCatalogOptions = {}) {
  const slice = buildSyntheticCatalog(options)
  installCatalogRuntimeSlice(slice)
  return slice
}
