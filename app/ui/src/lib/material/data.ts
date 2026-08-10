import { acousticMaterialParameters } from './data/acoustic'
import { chemicalMaterialParameters } from './data/chemical'
import { combustionMaterialParameters } from './data/combustion'
import { coupledMaterialParameters } from './data/coupled'
import { electricalMaterialParameters } from './data/electrical'
import { electrochemicalMaterialParameters } from './data/electrochemical'
import { fluidMaterialParameters } from './data/fluid'
import { generalMaterialParameters } from './data/general'
import { interfaceMaterialParameters } from './data/interface'
import { magneticMaterialParameters } from './data/magnetic'
import { mechanicalMaterialParameters } from './data/mechanical'
import { microstructureMaterialParameters } from './data/microstructure'
import { opticalMaterialParameters } from './data/optical'
import { radiationMaterialParameters } from './data/radiation'
import { radiativeMaterialParameters } from './data/radiative'
import { semiconductorMaterialParameters } from './data/semiconductor'
import { thermalMaterialParameters } from './data/thermal'
import { thermodynamicMaterialParameters } from './data/thermodynamic'
import { transportMaterialParameters } from './data/transport'
import {
  materialModelByKey,
  materialModelCatalog,
  materialModelData,
  type MaterialModelDefinition,
  type MaterialModelDefinitionFor,
  type MaterialModelKey,
} from './modelData'
import {
  materialParameterDomains,
  type MaterialParameterCatalog,
  type MaterialParameterDefinition,
  type MaterialParameterDomain,
} from './types'

export { materialParameterDomains }
export { materialModelByKey, materialModelCatalog, materialModelData }
export type {
  MaterialModelDefinition,
  MaterialModelDefinitionFor,
  MaterialModelKey,
  MaterialParameterCatalog,
  MaterialParameterDefinition,
  MaterialParameterDomain,
}

const materialParametersByDomain = Object.freeze({
  general: generalMaterialParameters,
  mechanical: mechanicalMaterialParameters,
  thermal: thermalMaterialParameters,
  thermodynamic: thermodynamicMaterialParameters,
  fluid: fluidMaterialParameters,
  transport: transportMaterialParameters,
  electrical: electricalMaterialParameters,
  magnetic: magneticMaterialParameters,
  optical: opticalMaterialParameters,
  radiative: radiativeMaterialParameters,
  acoustic: acousticMaterialParameters,
  chemical: chemicalMaterialParameters,
  combustion: combustionMaterialParameters,
  electrochemical: electrochemicalMaterialParameters,
  semiconductor: semiconductorMaterialParameters,
  radiation: radiationMaterialParameters,
  microstructure: microstructureMaterialParameters,
  coupled: coupledMaterialParameters,
  interface: interfaceMaterialParameters,
}) satisfies Readonly<{
  [Domain in MaterialParameterDomain]: readonly MaterialParameterDefinition<Domain>[]
}>

const expectedDomainCounts = Object.freeze({
  general: 14,
  mechanical: 35,
  thermal: 20,
  thermodynamic: 16,
  fluid: 8,
  transport: 18,
  electrical: 15,
  magnetic: 16,
  optical: 13,
  radiative: 2,
  acoustic: 6,
  chemical: 13,
  combustion: 3,
  electrochemical: 14,
  semiconductor: 15,
  radiation: 16,
  microstructure: 11,
  coupled: 8,
  interface: 15,
}) satisfies Readonly<Record<MaterialParameterDomain, number>>

const keys = new Set<string>()
for (const domain of materialParameterDomains) {
  const definitions = materialParametersByDomain[domain]
  const expectedCount = expectedDomainCounts[domain]
  if (definitions.length !== expectedCount) {
    throw new TypeError(
      `Material parameter domain ${domain} has ${definitions.length} definitions; expected ${expectedCount}`,
    )
  }

  for (const definition of definitions) {
    if (keys.has(definition.key)) {
      throw new TypeError(`Duplicate material parameter key ${definition.key}`)
    }
    keys.add(definition.key)

    if (/^(?:mdb|qudt):/.test(definition.quantity_kind)) {
      throw new TypeError(`Material parameter ${definition.key} uses a source-prefixed QuantityKind`)
    }
  }
}

export const materialParameterData = Object.freeze([
  ...generalMaterialParameters,
  ...mechanicalMaterialParameters,
  ...thermalMaterialParameters,
  ...thermodynamicMaterialParameters,
  ...fluidMaterialParameters,
  ...transportMaterialParameters,
  ...electricalMaterialParameters,
  ...magneticMaterialParameters,
  ...opticalMaterialParameters,
  ...radiativeMaterialParameters,
  ...acousticMaterialParameters,
  ...chemicalMaterialParameters,
  ...combustionMaterialParameters,
  ...electrochemicalMaterialParameters,
  ...semiconductorMaterialParameters,
  ...radiationMaterialParameters,
  ...microstructureMaterialParameters,
  ...coupledMaterialParameters,
  ...interfaceMaterialParameters,
] as const)

if (materialParameterData.length !== 258 || keys.size !== 258) {
  throw new TypeError(
    `Material parameter catalog has ${materialParameterData.length} definitions and ${keys.size} unique keys; expected 258`,
  )
}

export type MaterialPropertyDefinition = (typeof materialParameterData)[number]
export type MaterialPropertyKey = MaterialPropertyDefinition['key']
export type MaterialPropertyDefinitionFor<Key extends MaterialPropertyKey> = Extract<
  MaterialPropertyDefinition,
  { readonly key: Key }
>
export type MaterialPropertyQuantityKind<Key extends MaterialPropertyKey> =
  MaterialPropertyDefinitionFor<Key>['quantity_kind']
export type MaterialCatalogKey = MaterialPropertyKey | MaterialModelKey

export const materialParameterByKey = Object.freeze(
  Object.fromEntries(materialParameterData.map((definition) => [definition.key, definition])),
) as Readonly<{
  [Key in MaterialPropertyKey]: MaterialPropertyDefinitionFor<Key>
}>

const designRules = Object.freeze({
  canonical_key:
    'domain.property; do not encode direction, component, temperature, pressure, frequency, wavelength, species, phase, or model branch in the key',
  value_shape:
    'A property is one physical quantity value with no axes; its exact Cartesian component shape is determined only by the referenced QuantityKind tensorOrder.',
  model_parameters:
    'Dependencies and constitutive relations must use a key enumerated in the separate Material model catalog; arbitrary model.* keys are forbidden.',
  interface_properties: 'interface.* records belong to a material/phase pair, not to one bulk material.',
  quantity_kind:
    "reference the single canonical QuantityKind name; domain prefixes identify physical meaning, not the catalog property's usage domain.",
})

const globalQualifiers = Object.freeze([
  'temperature',
  'pressure',
  'frequency',
  'wavelength',
  'phase',
  'composition',
  'material_state',
  'source',
  'measurement_or_derivation_method',
] as const)

export const materialParameterCatalog = Object.freeze({
  catalog_id: 'material-parameter-catalog',
  catalog_version: '0.0.0',
  quantity_kind_data_version: '0.0.1',
  design_rules: designRules,
  global_qualifiers: globalQualifiers,
  properties: materialParameterData,
}) satisfies MaterialParameterCatalog
