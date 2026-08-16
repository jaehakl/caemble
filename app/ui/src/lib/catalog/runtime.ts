import type {
  CatalogMaterialModel,
  CatalogMaterialParameter,
  CatalogQuantityKind,
  CatalogRuntimeSlice,
} from '@/contracts/catalog'
import { CadModelError } from '../cad/model/errors'

let currentSlice: CatalogRuntimeSlice | null = null
const sourceSlices = new Map<string, CatalogRuntimeSlice>()

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Reflect.ownKeys(value).forEach((key) => deepFreeze((value as Record<PropertyKey, unknown>)[key]))
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

export function installCatalogRuntimeSlice(slice: CatalogRuntimeSlice) {
  currentSlice = deepFreeze(slice)
}

export function activeCatalogRuntimeSlice() {
  if (!currentSlice) {
    throw new CadModelError('Catalog API data is unavailable. Geometry preview remains available, but catalog-based evaluation is blocked.')
  }
  return currentSlice
}

export function getRuntimeQuantityKind(name: string): CatalogQuantityKind {
  const definition = activeCatalogRuntimeSlice().quantityKinds.find((entry) => entry.name === name)
  if (!definition) throw new CadModelError(`QuantityKind ${name} is not included in the active Solver catalog slice.`)
  return definition
}

export function getRuntimeMaterialParameter(key: string): CatalogMaterialParameter | undefined {
  return activeCatalogRuntimeSlice().materialParameters.find((entry) => entry.key === key)
}

export function getRuntimeMaterialModel(key: string): CatalogMaterialModel | undefined {
  return activeCatalogRuntimeSlice().materialModels.find((entry) => entry.key === key)
}

export function runtimeSolverContracts() {
  return Object.freeze(
    activeCatalogRuntimeSlice().solvers.map(({ name, version, contractDigest }) =>
      Object.freeze({ name, version, contractDigest }),
    ),
  )
}

export function registerSourceCatalogRuntimeSlice(sourceHash: string, slice: CatalogRuntimeSlice) {
  sourceSlices.set(sourceHash, deepFreeze(slice))
  if (sourceSlices.size > 32) sourceSlices.delete(sourceSlices.keys().next().value!)
}

export function sourceCatalogRuntimeSlice(sourceHash: string) {
  const slice = sourceSlices.get(sourceHash)
  if (!slice) {
    throw new CadModelError('이 Experiment source의 Solver catalog 계약이 없습니다. source를 다시 평가하세요.')
  }
  return slice
}

export function sourceCatalogSolverContracts(sourceHash: string) {
  const slice = sourceCatalogRuntimeSlice(sourceHash)
  return Object.freeze(
    slice.solvers.map(({ name, version, contractDigest }) => Object.freeze({ name, version, contractDigest })),
  )
}
