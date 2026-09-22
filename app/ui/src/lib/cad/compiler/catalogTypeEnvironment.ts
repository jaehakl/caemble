import type { CatalogRuntimeSlice, ModelParameterSchema } from '@/contracts/catalog'

function literal(value: string) {
  return JSON.stringify(value)
}

export function catalogRuntimeTypes(slice: CatalogRuntimeSlice) {
  const quantityKinds = slice.quantityKinds.map(
    (entry) => `    ${literal(entry.name)}: { readonly domain: ${literal(entry.domain)}; readonly tensorOrder: ${entry.tensorOrder}; readonly applicableUnits: readonly [${entry.applicableUnits.map(literal).join(', ')}] }`,
  )
  const inputType = (schema: ModelParameterSchema): string => {
    if (schema.kind === 'object') return `Readonly<{ ${Object.entries(schema.fields).map(([name, field]) => `${field.description ? '/** ' + field.description.split('*/').join('') + ' */ ' : ''}readonly ${literal(name)}${schema.required?.includes(name) ? '' : '?'}: ${inputType(field)}`).join('; ')} }>`
    if (schema.kind === 'list') return `ReadonlyArray<${inputType(schema.items)}>`
    const dtype = schema.dtype ?? 'float64'
    let value = dtype === 'string' ? (schema.values?.map(literal).join(' | ') ?? 'string') : dtype === 'bool' ? 'boolean' : 'number'
    for (const length of [...(schema.shape ?? [])].reverse()) value = length <= 32 ? `readonly [${Array.from({ length }, () => value).join(', ')}]` : `ReadonlyArray<${value}>`
    return schema.quantityKind ? `Readonly<{ value: ${value}; unit: ApplicableUnit<${literal(schema.quantityKind)}>; dtype?: FloatDataDType; ${(schema.shape?.length ?? 0) > 0 ? 'basis?: CartesianBasis' : 'basis?: never'} }>` : value
  }
  const models = slice.materialModels.filter((entry) => (entry.subject?.kind ?? 'material') === 'material').map((entry) => `    ${literal(entry.key)}: ${inputType(entry.parameterSchema)}`)
  const interactions = slice.materialModels.filter((entry) => entry.subject?.kind === 'material-pair')
    .map((entry) => `    ${literal(entry.key)}: ${inputType(entry.parameterSchema)}`)
  return `export {}
declare module '@caemble/core' {
  interface CatalogQuantityKindMap {
${quantityKinds.join('\n')}
  }
  interface MaterialModelParameterMap {
${models.join('\n')}
  }
  interface InteractionModelParameterMap {
${interactions.join('\n')}
  }
}
`
}
