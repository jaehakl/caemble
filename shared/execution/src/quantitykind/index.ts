import { activeCatalogRuntimeSlice } from '../catalog/runtime'
import { QuantityKindEntry } from './runtime'
import type { QuantityKindDefinition, QuantityKindName } from './runtime'

export type {
  ApplicableUnit,
  CartesianBasis,
  QuantityKindComponentShape,
  QuantityKindComponentValue,
  QuantityKindDefinition,
  QuantityKindDomain,
  QuantityKindName,
  QuantityKindNameForDomain,
  QuantityKindTensorOrder,
  QuantityMetadata,
  QuantityValueReference,
  ScalarQuantityKindName,
  TensorQuantityKindName,
} from './runtime'
export { transformQuantityValue } from './runtime'
export { identityCartesianBasis } from './identityBasis'

export const QuantityKind = new Proxy(Object.create(null) as Record<string, QuantityKindDefinition<string>>, {
  get(target, name) {
    if (typeof name !== 'string') return undefined
    if (!activeCatalogRuntimeSlice().quantityKinds.some((entry) => entry.name === name)) return undefined
    target[name] ??= new QuantityKindEntry(name)
    return target[name]
  },
  has(_target, name) {
    return typeof name === 'string' && activeCatalogRuntimeSlice().quantityKinds.some((entry) => entry.name === name)
  },
  ownKeys() {
    return activeCatalogRuntimeSlice().quantityKinds.map((entry) => entry.name)
  },
  getOwnPropertyDescriptor(_target, name) {
    return typeof name === 'string' && activeCatalogRuntimeSlice().quantityKinds.some((entry) => entry.name === name)
      ? { configurable: true, enumerable: true }
      : undefined
  },
}) as Readonly<Record<QuantityKindName, QuantityKindDefinition<QuantityKindName>>>
