import { defineMaterialModelRelations, type MaterialModelCatalog } from './types'

export const materialModelData = defineMaterialModelRelations([
  {
    key: 'model.magnetic_hysteresis.b_h_curve',
    label_ko: 'B-H 곡선',
    kind: 'sampled_relation',
    input: {
      name: 'magnetic_field_strength',
      quantity_kind: 'electromagnetism.MagneticFieldStrength',
    },
    output: {
      name: 'magnetic_flux_density',
      quantity_kind: 'electromagnetism.MagneticFluxDensity',
    },
    minimum_samples: 2,
    shared_basis: true,
  },
  {
    key: 'model.sorption.isotherm',
    label_ko: '흡착 등온선',
    kind: 'sampled_relation',
    input: {
      name: 'relative_humidity',
      quantity_kind: 'thermodynamics.RelativeHumidity',
    },
    output: {
      name: 'equilibrium_mass_fraction',
      quantity_kind: 'MassFraction',
    },
    minimum_samples: 2,
    shared_basis: false,
  },
] as const)

export type MaterialModelDefinition = (typeof materialModelData)[number]
export type MaterialModelKey = MaterialModelDefinition['key']
export type MaterialModelDefinitionFor<Key extends MaterialModelKey> = Extract<
  MaterialModelDefinition,
  { readonly key: Key }
>

export const materialModelByKey = Object.freeze(
  Object.fromEntries(materialModelData.map((definition) => [definition.key, definition])),
) as Readonly<{
  [Key in MaterialModelKey]: MaterialModelDefinitionFor<Key>
}>

export const materialModelCatalog = Object.freeze({
  catalog_id: 'material-model-catalog',
  catalog_version: '0.0.0',
  quantity_kind_data_version: '0.0.1',
  relations: materialModelData,
}) satisfies MaterialModelCatalog
