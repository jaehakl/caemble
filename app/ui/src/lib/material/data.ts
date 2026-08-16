import { activeCatalogRuntimeSlice } from '../catalog/runtime'
import type { MaterialModelRelationDefinition, MaterialParameterDefinition } from './types'

export type MaterialPropertyKey = string
export type MaterialModelKey = string
export type MaterialCatalogKey = string
export type MaterialPropertyDefinition = MaterialParameterDefinition
export type MaterialPropertyDefinitionFor<Key extends MaterialPropertyKey> = MaterialParameterDefinition & { key: Key }
export type MaterialPropertyQuantityKind<Key extends MaterialPropertyKey> = string & { readonly __materialKey?: Key }
export type MaterialModelDefinition = MaterialModelRelationDefinition
export type MaterialModelDefinitionFor<Key extends MaterialModelKey> = MaterialModelRelationDefinition & { key: Key }

function parameters() {
  return activeCatalogRuntimeSlice().materialParameters.map((entry) => ({
    key: entry.key,
    label_ko: entry.labelKo,
    quantity_kind: entry.quantityKind,
    ...(entry.specialQualifiers.length ? { special_qualifiers: entry.specialQualifiers } : {}),
  })) as MaterialParameterDefinition[]
}

function models() {
  return activeCatalogRuntimeSlice().materialModels.map((entry) => ({
    key: entry.key,
    label_ko: entry.labelKo,
    kind: entry.kind,
    input: { name: entry.input.name, quantity_kind: entry.input.quantityKind },
    output: { name: entry.output.name, quantity_kind: entry.output.quantityKind },
    minimum_samples: entry.minimumSamples,
    shared_basis: entry.sharedBasis,
  })) as MaterialModelRelationDefinition[]
}

function dynamicArray<T>(read: () => readonly T[]) {
  return new Proxy([] as T[], {
    get(_target, property) {
      const value = Reflect.get(read(), property)
      return typeof value === 'function' ? value.bind(read()) : value
    },
    ownKeys() {
      return Reflect.ownKeys(read())
    },
    getOwnPropertyDescriptor(_target, property) {
      return Object.getOwnPropertyDescriptor(read(), property)
    },
  }) as readonly T[]
}

function dynamicMap<T>(read: () => readonly T[], key: (value: T) => string) {
  return new Proxy(Object.create(null) as Record<string, T>, {
    get(_target, property) {
      return typeof property === 'string' ? read().find((value) => key(value) === property) : undefined
    },
    has(_target, property) {
      return typeof property === 'string' && read().some((value) => key(value) === property)
    },
    ownKeys() {
      return read().map(key)
    },
    getOwnPropertyDescriptor(_target, property) {
      return typeof property === 'string' && read().some((value) => key(value) === property)
        ? { configurable: true, enumerable: true }
        : undefined
    },
  }) as Readonly<Record<string, T>>
}

export const materialParameterData = dynamicArray<MaterialParameterDefinition>(parameters)
export const materialModelData = dynamicArray<MaterialModelRelationDefinition>(models)
export const materialParameterByKey = dynamicMap(parameters, (entry) => entry.key)
export const materialModelByKey = dynamicMap(models, (entry) => entry.key)
export const materialParameterDomains = dynamicArray(() =>
  [...new Set(activeCatalogRuntimeSlice().materialParameters.map((entry) => entry.domain))].sort(),
)

export const materialParameterCatalog = new Proxy(Object.create(null) as Record<string, unknown>, {
  get(_target, property) {
    if (property === 'properties') return materialParameterData
    if (property === 'catalog_id') return 'material-parameter-catalog'
    if (property === 'catalog_version') return activeCatalogRuntimeSlice().catalogRevision
    return undefined
  },
})

export const materialModelCatalog = new Proxy(Object.create(null) as Record<string, unknown>, {
  get(_target, property) {
    if (property === 'relations') return materialModelData
    if (property === 'catalog_id') return 'material-model-catalog'
    if (property === 'catalog_version') return activeCatalogRuntimeSlice().catalogRevision
    return undefined
  },
})
