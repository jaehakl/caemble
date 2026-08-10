import { QUANTITY_KIND_DATA_VERSION } from '../cad/api/generatedVersions'

type QuantityKindModule = typeof import('./data')
type QuantityKindData = QuantityKindModule['quantityKindData']

const module =
  import.meta.env.MODE === 'test'
    ? await import('./data')
    : ((await import(/* @vite-ignore */ `/assets/quantity-kind-data-${QUANTITY_KIND_DATA_VERSION}.js`)) as Readonly<{
        quantityKindData: QuantityKindData
        opaqueQuantityKindNames: QuantityKindModule['opaqueQuantityKindNames']
      }>)

if (typeof module.quantityKindData !== 'object' || module.quantityKindData === null) {
  throw new Error('The versioned QuantityKind data asset is invalid.')
}

export const quantityKindData = module.quantityKindData as QuantityKindData
export const opaqueQuantityKindNames = module.opaqueQuantityKindNames as QuantityKindModule['opaqueQuantityKindNames']
