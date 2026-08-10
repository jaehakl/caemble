import type { QuantityKindName } from '../quantitykind/runtime'

export const materialParameterDomains = Object.freeze([
  'general',
  'mechanical',
  'thermal',
  'thermodynamic',
  'fluid',
  'transport',
  'electrical',
  'magnetic',
  'optical',
  'radiative',
  'acoustic',
  'chemical',
  'combustion',
  'electrochemical',
  'semiconductor',
  'radiation',
  'microstructure',
  'coupled',
  'interface',
] as const)

export type MaterialParameterDomain = (typeof materialParameterDomains)[number]

export interface MaterialParameterDefinition<
  Domain extends MaterialParameterDomain = MaterialParameterDomain,
  QuantityKind extends QuantityKindName = QuantityKindName,
> {
  readonly key: `${Domain}.${string}`
  readonly label_ko: string
  readonly quantity_kind: QuantityKind
  readonly special_qualifiers?: readonly string[]
}

export interface MaterialParameterCatalog {
  readonly catalog_id: 'material-parameter-catalog'
  readonly catalog_version: '0.0.0'
  readonly quantity_kind_data_version: '0.0.1'
  readonly design_rules: Readonly<{
    canonical_key: string
    value_shape: string
    model_parameters: string
    interface_properties: string
    quantity_kind: string
  }>
  readonly global_qualifiers: readonly string[]
  readonly properties: readonly MaterialParameterDefinition[]
}

export interface MaterialModelRelationDefinition<
  Key extends `model.${string}.${string}` = `model.${string}.${string}`,
  InputQuantityKind extends QuantityKindName = QuantityKindName,
  OutputQuantityKind extends QuantityKindName = QuantityKindName,
> {
  readonly key: Key
  readonly label_ko: string
  readonly kind: 'sampled_relation'
  readonly input: Readonly<{
    name: string
    quantity_kind: InputQuantityKind
  }>
  readonly output: Readonly<{
    name: string
    quantity_kind: OutputQuantityKind
  }>
  readonly minimum_samples: number
  readonly shared_basis: boolean
}

export interface MaterialModelCatalog {
  readonly catalog_id: 'material-model-catalog'
  readonly catalog_version: '0.0.0'
  readonly quantity_kind_data_version: '0.0.1'
  readonly relations: readonly MaterialModelRelationDefinition[]
}

const definitionFields = new Set(['key', 'label_ko', 'quantity_kind', 'special_qualifiers'])

export function defineMaterialParameterDomain<
  const Domain extends MaterialParameterDomain,
  const Definitions extends readonly MaterialParameterDefinition<Domain>[],
>(domain: Domain, definitions: Definitions): Definitions {
  const keyPattern = new RegExp(`^${domain}\\.[^.]+$`)

  for (const definition of definitions) {
    if (!keyPattern.test(definition.key)) {
      throw new TypeError(`Material parameter key ${JSON.stringify(definition.key)} must match ${domain}.<property>`)
    }

    for (const field of Object.keys(definition)) {
      if (!definitionFields.has(field)) {
        throw new TypeError(`Material parameter ${definition.key} has unsupported field ${JSON.stringify(field)}`)
      }
    }

    if (definition.special_qualifiers !== undefined) {
      Object.freeze(definition.special_qualifiers)
    }
    Object.freeze(definition)
  }

  return Object.freeze(definitions) as Definitions
}

export function defineMaterialModelRelations<const Definitions extends readonly MaterialModelRelationDefinition[]>(
  definitions: Definitions,
): Definitions {
  const keys = new Set<string>()
  for (const definition of definitions) {
    if (!/^model\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(definition.key)) {
      throw new TypeError(`Material model key ${JSON.stringify(definition.key)} is invalid`)
    }
    if (keys.has(definition.key)) {
      throw new TypeError(`Duplicate Material model key ${definition.key}`)
    }
    if (!Number.isSafeInteger(definition.minimum_samples) || definition.minimum_samples < 2) {
      throw new TypeError(`Material model ${definition.key} must require at least two samples`)
    }
    keys.add(definition.key)
    Object.freeze(definition.input)
    Object.freeze(definition.output)
    Object.freeze(definition)
  }
  return Object.freeze(definitions) as Definitions
}
