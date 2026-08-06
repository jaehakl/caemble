import { QUANTITY_KIND_DATA_VERSION } from '../cad/api/generatedVersions'

type QuantityKindData = typeof import('./data').quantityKindData

const module =
  import.meta.env.MODE === 'test'
    ? await import('./data')
    : ((await import(/* @vite-ignore */ `/assets/quantity-kind-data-${QUANTITY_KIND_DATA_VERSION}.js`)) as Readonly<{
        quantityKindData: QuantityKindData
      }>)

if (typeof module.quantityKindData !== 'object' || module.quantityKindData === null) {
  throw new Error('The versioned QuantityKind data asset is invalid.')
}

export const quantityKindData = module.quantityKindData as QuantityKindData
