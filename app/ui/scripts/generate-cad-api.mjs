import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { format } from 'prettier'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')
const changed = []

const elementManifestPath = path.join(root, 'src/lib/cad/elements/manifest.json')
const authoringManifestPath = path.join(root, 'src/lib/cad/api/authoring-manifest.json')
const elementManifest = JSON.parse(await readFile(elementManifestPath, 'utf8'))
const authoringManifest = JSON.parse(await readFile(authoringManifestPath, 'utf8'))

const quantityKindDomains = [
  'general',
  'geometry',
  'kinematics',
  'mechanics',
  'fluidDynamics',
  'thermodynamics',
  'transport',
  'electromagnetism',
  'coupledPhenomena',
  'optics',
  'acoustics',
  'chemistry',
  'materials',
  'atomicNuclear',
  'lifeSciences',
  'earthSpace',
  'informationComputing',
  'economicsOperations',
]

const materialParameterDomainCounts = Object.freeze({
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
})

function tsString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function pythonQuantityKindCatalog(sourceHash, data) {
  const entries = Object.entries(data)
  const chunks = (select) =>
    Array.from({ length: Math.ceil(entries.length / 300) }, (_, index) =>
      JSON.stringify(Object.fromEntries(entries.slice(index * 300, (index + 1) * 300).map(select))),
    )
  return [
    '# Generated from Caemble quantity-kind data. Do not edit by hand.',
    `QUANTITY_KIND_SOURCE_SHA256 = ${JSON.stringify(sourceHash)}`,
    'QUANTITY_KIND_TENSOR_ORDERS: dict[str, int] = {}',
    'QUANTITY_KIND_APPLICABLE_UNITS: dict[str, list[str]] = {}',
    ...chunks(([name, entry]) => [name, entry.tensorOrder]).map(
      (chunk) => `QUANTITY_KIND_TENSOR_ORDERS.update(${chunk})`,
    ),
    ...chunks(([name, entry]) => [name, entry.applicableUnits]).map(
      (chunk) => `QUANTITY_KIND_APPLICABLE_UNITS.update(${chunk})`,
    ),
    '',
  ].join('\n')
}

function formatGenerated(relativePath, source) {
  return format(source, {
    filepath: path.join(root, relativePath),
    printWidth: 120,
    semi: false,
    singleQuote: true,
    trailingComma: 'all',
  })
}

function pascalCase(value) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('')
}

function groupedImports(entries, moduleKey, exportKey) {
  const modules = new Map()
  entries.forEach((entry) => {
    const names = modules.get(entry[moduleKey]) ?? []
    if (!names.includes(entry[exportKey])) names.push(entry[exportKey])
    modules.set(entry[moduleKey], names)
  })
  return [...modules.entries()]
    .map(([moduleName, names]) => `import { ${names.join(', ')} } from ${tsString(moduleName)}`)
    .join('\n')
}

async function loadBundledModule(entryPoint) {
  const result = await build({
    bundle: true,
    entryPoints: [entryPoint],
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    define: { 'import.meta.env.MODE': '"test"' },
    write: false,
  })
  const source = Buffer.from(result.outputFiles[0].text).toString('base64')
  return import(`data:text/javascript;base64,${source}`)
}

async function emit(relativePath, content) {
  const outputPath = path.join(root, relativePath)
  let current = ''
  try {
    current = await readFile(outputPath, 'utf8')
  } catch {
    // New generated file.
  }
  if (current === content) return
  changed.push(relativePath)
  if (!checkOnly) await writeFile(outputPath, content, 'utf8')
}

async function validateElementManifest() {
  if (elementManifest.version !== 2 || !Array.isArray(elementManifest.elements)) {
    throw new Error('src/lib/cad/elements/manifest.json must use element manifest format version 2.')
  }
  const tags = new Set()
  for (const element of elementManifest.elements) {
    if (tags.has(element.tag)) throw new Error(`Duplicate CAD element manifest tag: ${element.tag}`)
    tags.add(element.tag)
    const definitionPath = path.join(root, 'src/lib/cad/elements', `${element.definitionModule}.ts`)
    const runtimePath = path.join(root, 'src/lib/cad/elements', `${element.runtimeModule}.ts`)
    const [definition, runtime] = await Promise.all([readFile(definitionPath, 'utf8'), readFile(runtimePath, 'utf8')])
    if (!definition.includes(`export type ${element.attributes}`)) {
      throw new Error(`${element.definitionModule} does not export ${element.attributes}.`)
    }
    if (
      !definition.includes(`export const ${element.manifestExport}`) ||
      !definition.includes(`tag: '${element.tag}'`)
    ) {
      throw new Error(`${element.definitionModule} does not define ${element.manifestExport} for ${element.tag}.`)
    }
    if (!runtime.includes(`export const ${element.definitionExport}`)) {
      throw new Error(`${element.runtimeModule} does not export ${element.definitionExport}.`)
    }
  }
}

function generatedElementRegistry() {
  const elements = elementManifest.elements
  return `// Generated by scripts/generate-cad-api.mjs from manifest.json. Do not edit.\n${groupedImports(
    elements,
    'definitionModule',
    'manifestExport',
  )}\n${groupedImports(elements, 'runtimeModule', 'definitionExport')}\nimport type { CadElementDefinition } from '../evaluation/types'\n\nexport const cadElementCatalog = [\n${elements.map((element) => `  ${element.manifestExport},`).join('\n')}\n] as const\n\nexport const cadElementDefinitions = [\n${elements.map((element) => `  ${element.definitionExport},`).join('\n')}\n] as const satisfies readonly CadElementDefinition[]\n`
}

function generatedJsxDeclaration() {
  const attributes = [...new Set(elementManifest.elements.map((element) => element.attributes))].sort()
  return `// Generated by scripts/generate-cad-api.mjs from elements/manifest.json. Do not edit.\nimport type {\n${attributes.map((name) => `  ${name},`).join('\n')}\n} from '@caemble/core'\n\ndeclare global {\n  function h(type: unknown, attributes: unknown, ...children: unknown[]): unknown\n  function Fragment(props: { children?: unknown }): unknown\n\n  namespace JSX {\n    interface IntrinsicElements {\n${elementManifest.elements.map((element) => `      ${element.tag}: ${element.attributes}`).join('\n')}\n    }\n  }\n}\n\nexport {}\n`
}

function tensorValueType(axes, leafType = 'number') {
  if (!axes?.length) return leafType
  return axes.reduceRight((value, axis) => {
    if (!Number.isSafeInteger(axis.length) || axis.length < 1 || axis.length > 64) {
      throw new Error('Generated authoring tuple axes must have a length from 1 through 64.')
    }
    return `readonly [${Array.from({ length: axis.length }, () => value).join(', ')}]`
  }, leafType)
}

function parameterType(parameter, materialKey) {
  if (materialKey !== undefined) {
    return materialKey.startsWith('model.')
      ? `MaterialSampledRelation<${tsString(materialKey)}>`
      : `MaterialDataValueDescriptor<${tsString(materialKey)}>`
  }
  const data = parameter.data
  if (data.dtype.startsWith('float') && typeof data.quantityKind === 'string') {
    return `FloatParameter<${tsString(data.dtype)}, ${tsString(data.quantityKind)}>`
  }
  const scalarType =
    data.dtype === 'bool'
      ? 'boolean'
      : data.dtype === 'string'
        ? data.values?.length
          ? data.values.map(tsString).join(' | ')
          : 'string'
        : 'number'
  const valueType = tensorValueType(data.axes, scalarType)
  const descriptor = `NonFloatParameter<${tsString(data.dtype)}, ${valueType}>`
  if (
    data.dtype === 'bool' ||
    data.dtype === 'string' ||
    data.dtype.startsWith('int') ||
    data.dtype.startsWith('uint')
  ) {
    return data.axes?.length ? descriptor : `${scalarType} | ${descriptor}`
  }
  throw new Error(`Unsupported generated kernel authoring parameter dtype: ${data.dtype}`)
}

function parameterRecord(parameters, material = false) {
  const entries = Object.entries(parameters)
  if (entries.length === 0) return 'Readonly<Record<string, never>>'
  return `Readonly<{\n${entries
    .map(
      ([name, parameter]) =>
        `    ${tsString(name)}${parameter.required === false ? '?' : ''}: ${parameterType(
          parameter,
          material ? name : undefined,
        )}`,
    )
    .join('\n')}\n  }>`
}

function permutations(values) {
  if (values.length < 2) return [values]
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]),
  )
}

function methodType(prefix, category, methods, includeKey) {
  const typeName = `${prefix}${pascalCase(category.replace(/s$/, ''))}`
  const variants = methods.map((method) => {
    const target = `\`${method.target.source}.${method.target.kind}.\${string}\``
    return `Readonly<{\n    ${includeKey ? 'key: string\n    ' : ''}methodId: ${tsString(method.methodId)}\n    target: readonly ${target}[]\n    parameters: ${parameterRecord(method.parameters).replaceAll('\n', '\n    ')}\n  }>`
  })
  return {
    declaration: `export type ${typeName} =${
      variants.length === 0 ? ' never' : `\n${variants.map((variant) => `  | ${variant}`).join('\n')}`
    }`,
    typeName,
  }
}

function occurrenceListType(typeName, methods) {
  if (methods.length === 0) return 'readonly []'
  if (methods.every((method) => method.minimumOccurrences === 1 && method.maximumOccurrences === 1)) {
    return permutations(methods)
      .map(
        (order) =>
          `readonly [${order
            .map((method) => `Extract<${typeName}, { methodId: ${tsString(method.methodId)} }>`)
            .join(', ')}]`,
      )
      .join('\n    | ')
  }
  return `readonly ${typeName}[]`
}

function camelCase(value) {
  const pascal = pascalCase(value)
  return `${pascal[0].toLowerCase()}${pascal.slice(1)}`
}

function inputPortType(port) {
  const artifactType = port.artifactTypes.map(tsString).join(' | ')
  let valueType
  if (port.maximumOccurrences === 1) {
    valueType = artifactType
  } else if (Number.isSafeInteger(port.maximumOccurrences) && port.minimumOccurrences === port.maximumOccurrences) {
    valueType = `readonly [${Array.from({ length: port.minimumOccurrences }, () => artifactType).join(', ')}]`
  } else if (port.minimumOccurrences > 0) {
    const required = Array.from({ length: port.minimumOccurrences }, () => artifactType)
    valueType = `readonly [${[...required, `...(${artifactType})[]`].join(', ')}]`
  } else {
    valueType = `readonly (${artifactType})[]`
  }
  return port.minimumOccurrences === 0 ? `${valueType} | undefined` : valueType
}

function kernelDeclaration(descriptors) {
  const sections = []
  const usesMaterialSampledRelation = descriptors.some((descriptor) =>
    descriptor.materials.some((material) => Object.keys(material.properties).some((name) => name.startsWith('model.'))),
  )
  descriptors.forEach((descriptor) => {
    const prefix = pascalCase(descriptor.name)
    const initializations = methodType(prefix, 'initializations', descriptor.methods.initializations, false)
    const boundaryConditions = methodType(prefix, 'boundaryConditions', descriptor.methods.boundaryConditions, false)
    const outputs = methodType(prefix, 'outputs', descriptor.methods.outputs, true)
    sections.push(initializations.declaration, boundaryConditions.declaration, outputs.declaration)

    descriptor.materials.forEach((material) => {
      sections.push(
        `export type ${prefix}${pascalCase(material.role)}MaterialVariables = ${parameterRecord(
          material.properties,
          true,
        )}`,
      )
    })

    const outputConstraint =
      descriptor.minimumOutputs > 0
        ? `readonly [${outputs.typeName}, ...${outputs.typeName}[]]`
        : `readonly ${outputs.typeName}[]`
    const configName = `${prefix}TaskConfig`
    sections.push(
      `export type ${configName}<\n  Outputs extends ${outputConstraint} = ${outputConstraint},\n> = Readonly<{\n  parameters: ${parameterRecord(descriptor.parameters).replaceAll('\n', '\n  ')}\n  initializations: ${occurrenceListType(initializations.typeName, descriptor.methods.initializations)}\n  boundaryConditions: ${occurrenceListType(boundaryConditions.typeName, descriptor.methods.boundaryConditions)}\n  outputs: Outputs\n}>`,
    )

    const artifactConditions = descriptor.methods.outputs
      .map(
        (method, index, methods) =>
          `${index === 0 ? '' : '      : '}Output['methodId'] extends ${tsString(method.methodId)}\n      ? ${tsString(method.artifactType)}${
            index === methods.length - 1 ? '\n      : never' : ''
          }`,
      )
      .join('\n')
    const artifactName = `${prefix}ArtifactTypes`
    sections.push(
      `type ${artifactName}<Outputs extends readonly ${outputs.typeName}[]> = Readonly<{\n  [Output in Outputs[number] as Output['key']]:\n    ${artifactConditions}\n}>`,
    )

    const inputEntries = Object.entries(descriptor.inputPorts)
    const inputTypes =
      inputEntries.length === 0
        ? 'Readonly<Record<never, never>>'
        : `Readonly<{\n${inputEntries
            .map(([name, port]) => `    ${tsString(name)}: ${inputPortType(port)}`)
            .join('\n')}\n  }>`
    const observationEntries = Object.entries(descriptor.observations)
    const observationTypes =
      observationEntries.length === 0
        ? 'Readonly<Record<never, never>>'
        : `Readonly<{\n${observationEntries
            .map(
              ([name, observation]) =>
                `    ${tsString(name)}${observation.required === false ? '?' : ''}: ${observation.type}`,
            )
            .join('\n')}\n  }>`
    sections.push(
      `export declare function ${camelCase(descriptor.name)}<\n  const Outputs extends ${outputConstraint},\n>(\n  config: ${configName}<Outputs>,\n): DefinedKernelTask<\n  ${configName}<Outputs>,\n  ${artifactName}<Outputs>,\n  ${observationTypes.replaceAll('\n', '\n  ')},\n  ${inputTypes.replaceAll('\n', '\n  ')}\n>`,
    )
  })

  return `// Generated by scripts/generate-cad-api.mjs from the production kernel descriptors. Do not edit.
// @caemble/kernels declaration version: ${authoringManifest.kernelDeclarationVersion}
import type {
  CartesianBasis,
  DataAxis,
  DefinedKernelTask,
  FloatDataDType,
  MaterialDataValueDescriptor,
${usesMaterialSampledRelation ? '  MaterialSampledRelation,\n' : ''}  QuantityKindName,
  NonFloatDataDType,
  ScalarQuantityKindName,
  UcumUnit,
} from '@caemble/core'

type FloatParameter<
  DType extends FloatDataDType,
  QuantityKind extends QuantityKindName,
> = Readonly<{
  dtype: DType
  value: number | readonly unknown[]
  unit: UcumUnit
  quantityKind: QuantityKind
  axes?: readonly DataAxis[]
}> & (QuantityKind extends ScalarQuantityKindName
  ? Readonly<{ basis?: never }>
  : Readonly<{ basis?: CartesianBasis }>)

type NonFloatParameter<
  DType extends NonFloatDataDType,
  Value extends boolean | string | number | readonly unknown[],
> = Readonly<{
  dtype: DType
  value: Value
  axes?: readonly DataAxis[]
  unit?: never
  quantityKind?: never
  basis?: never
}>

${sections.join('\n\n')}
`
}

function quantityKindTypes(quantityKindData) {
  const names = Object.keys(quantityKindData)
  const tensorNames = names.filter((name) => quantityKindData[name].tensorOrder > 0)
  const namesByDomain = quantityKindDomains.map(
    (domain) =>
      `  ${domain}:\n${names
        .filter((name) => quantityKindData[name].domain === domain)
        .map((name) => `    | ${tsString(name)}`)
        .join('\n')}`,
  )
  return `// <generated:quantity-kind-types>\nexport type QuantityKindName =\n${names.map((name) => `  | ${tsString(name)}`).join('\n')}\nexport type QuantityKindDomain =\n${quantityKindDomains.map((domain) => `  | ${tsString(domain)}`).join('\n')}\nexport type QuantityKindNameForDomain<Domain extends QuantityKindDomain> = Readonly<{\n${namesByDomain.join('\n')}\n}>[Domain]\nexport type TensorQuantityKindName =\n${tensorNames.map((name) => `  | ${tsString(name)}`).join('\n')}\nexport type ScalarQuantityKindName = Exclude<QuantityKindName, TensorQuantityKindName>\n// </generated:quantity-kind-types>`
}

function materialCatalogTypes(properties, models) {
  const propertyMap = properties
    .map((property) => `  ${tsString(property.key)}: ${tsString(property.quantity_kind)}`)
    .join('\n')
  const modelMap = models
    .map(
      (model) => `  ${tsString(model.key)}: Readonly<{
    key: ${tsString(model.key)}
    kind: 'sampled_relation'
    input: Readonly<{ quantity_kind: ${tsString(model.input.quantity_kind)} }>
    output: Readonly<{ quantity_kind: ${tsString(model.output.quantity_kind)} }>
    minimum_samples: ${model.minimum_samples}
    shared_basis: ${model.shared_basis}
  }>`,
    )
    .join('\n')
  return `// <generated:material-catalog-types>
// Generated by scripts/generate-cad-api.mjs from the Material property and model catalogs. Do not edit.
export type MaterialPropertyQuantityKindMap = Readonly<{
${propertyMap}
}>
export type MaterialPropertyKey = keyof MaterialPropertyQuantityKindMap
export type MaterialPropertyQuantityKind<Key extends MaterialPropertyKey> =
  MaterialPropertyQuantityKindMap[Key]
export type MaterialPropertyDefinitionFor<Key extends MaterialPropertyKey> = Readonly<{
  key: Key
  quantity_kind: MaterialPropertyQuantityKind<Key>
}>

export type MaterialModelDefinitionMap = Readonly<{
${modelMap}
}>
export type MaterialModelKey = keyof MaterialModelDefinitionMap
export type MaterialModelDefinitionFor<Key extends MaterialModelKey> = MaterialModelDefinitionMap[Key]
export type MaterialCatalogKey = MaterialPropertyKey | MaterialModelKey

type MaterialAuthoringBasis<Name extends QuantityKindName> =
  Name extends ScalarQuantityKindName
    ? Readonly<{ basis?: never }>
    : Readonly<{ basis?: CartesianBasis }>
type MaterialNormalizedBasis<Name extends QuantityKindName> =
  Name extends ScalarQuantityKindName
    ? Readonly<{ basis?: never }>
    : Readonly<{ basis: CartesianBasis }>

export type MaterialDataValueDescriptor<
  Key extends MaterialPropertyKey = MaterialPropertyKey,
> = Key extends MaterialPropertyKey ? Readonly<{
  dtype: FloatDataDType
  value: number | readonly unknown[]
  unit: UcumUnit
  errorRate?: number
  axes?: never
  quantityKind?: never
}> & MaterialAuthoringBasis<MaterialPropertyQuantityKind<Key>> : never

export type NormalizedMaterialDataValueDescriptor<
  Key extends MaterialPropertyKey = MaterialPropertyKey,
> = Key extends MaterialPropertyKey ? Readonly<{
  dtype: FloatDataDType
  value: number | readonly unknown[]
  unit: UcumUnit
  quantityKind: MaterialPropertyQuantityKind<Key>
  errorRate: number
  axes?: never
}> & MaterialNormalizedBasis<MaterialPropertyQuantityKind<Key>> : never

type MaterialModelInputQuantityKind<Key extends MaterialModelKey> =
  MaterialModelDefinitionFor<Key>['input']['quantity_kind']
type MaterialModelOutputQuantityKind<Key extends MaterialModelKey> =
  MaterialModelDefinitionFor<Key>['output']['quantity_kind']
export type MaterialQuantitySeries<Name extends QuantityKindName> = Readonly<{
  unit: UcumUnit
  values: readonly unknown[]
}> & MaterialAuthoringBasis<Name>
export type MaterialSampledRelation<
  Key extends MaterialModelKey = MaterialModelKey,
> = Key extends MaterialModelKey ? Readonly<{
  kind: 'sampled_relation'
  input: MaterialQuantitySeries<MaterialModelInputQuantityKind<Key>>
  output: MaterialQuantitySeries<MaterialModelOutputQuantityKind<Key>>
}> : never

export type MaterialVariable = string | MaterialDataValueDescriptor | MaterialSampledRelation
export type MaterialVariables = Readonly<
  { color?: string; errorRate?: number }
  & { [Key in MaterialPropertyKey]?: MaterialDataValueDescriptor<Key> }
  & { [Key in MaterialModelKey]?: MaterialSampledRelation<Key> }
>
export type NormalizedMaterialVariables = Readonly<
  { color?: string }
  & { [Key in MaterialPropertyKey]?: NormalizedMaterialDataValueDescriptor<Key> }
  & { [Key in MaterialModelKey]?: MaterialSampledRelation<Key> }
>
export type ResolvedMaterialVariables = Readonly<
  { color?: string }
  & { [Key in MaterialPropertyKey]?: DataValueDescriptor }
  & { [Key in MaterialModelKey]?: MaterialSampledRelation<Key> }
>
// </generated:material-catalog-types>`
}

function quantityKindFacade() {
  return `// Generated by scripts/generate-cad-api.mjs from data.ts. Do not edit.\nimport { quantityKindData } from './runtimeData'\nimport { QuantityKindEntry } from './runtime'\nimport type { QuantityKindDefinition, QuantityKindName } from './runtime'\n\nexport type {\n  ApplicableUnit,\n  CartesianBasis,\n  QuantityKindComponentShape,\n  QuantityKindComponentValue,\n  QuantityKindDefinition,\n  QuantityKindDomain,\n  QuantityKindName,\n  QuantityKindNameForDomain,\n  QuantityKindTensorOrder,\n  QuantityMetadata,\n  QuantityValueReference,\n  ScalarQuantityKindName,\n  TensorQuantityKindName,\n} from './runtime'\n\nexport { transformQuantityValue } from './runtime'\nexport { identityCartesianBasis } from './identityBasis'\nexport { quantityKindData } from './runtimeData'\n\nexport const QuantityKind = Object.freeze(Object.fromEntries(\n  (Object.keys(quantityKindData) as QuantityKindName[]).map((name) => [name, new QuantityKindEntry(name)]),\n)) as unknown as { readonly [Name in QuantityKindName]: QuantityKindDefinition<Name> }\n`
}

function validateMaterialParameterCatalog(
  materialParameterDomains,
  materialParameterData,
  materialParameterCatalog,
  quantityKindData,
) {
  const expectedDomains = Object.keys(materialParameterDomainCounts)
  if (
    !Array.isArray(materialParameterDomains) ||
    materialParameterDomains.length !== expectedDomains.length ||
    materialParameterDomains.some((domain, index) => domain !== expectedDomains[index])
  ) {
    throw new Error(`Material parameter domains must be ${expectedDomains.join(', ')} in that order.`)
  }
  if (!Object.isFrozen(materialParameterDomains)) {
    throw new Error('Material parameter domains must be frozen.')
  }
  if (
    !materialParameterCatalog ||
    materialParameterCatalog.catalog_id !== 'material-parameter-catalog' ||
    materialParameterCatalog.catalog_version !== '0.0.0' ||
    materialParameterCatalog.quantity_kind_data_version !== authoringManifest.quantityKindDataVersion
  ) {
    throw new Error('Material catalog identity or version metadata is invalid.')
  }
  for (const forbiddenField of ['aliases', 'relationships', 'quantity_kind_extensions']) {
    if (Object.prototype.hasOwnProperty.call(materialParameterCatalog, forbiddenField)) {
      throw new Error(`Material catalog must not define ${forbiddenField}.`)
    }
  }
  if (
    !materialParameterCatalog.design_rules ||
    typeof materialParameterCatalog.design_rules.quantity_kind !== 'string' ||
    !Array.isArray(materialParameterCatalog.global_qualifiers)
  ) {
    throw new Error('Material catalog metadata is incomplete.')
  }
  if (
    !Object.isFrozen(materialParameterCatalog) ||
    !Object.isFrozen(materialParameterCatalog.design_rules) ||
    !Object.isFrozen(materialParameterCatalog.global_qualifiers)
  ) {
    throw new Error('Material catalog metadata must be frozen.')
  }
  if (
    !Array.isArray(materialParameterData) ||
    materialParameterData.length !== 258 ||
    materialParameterCatalog.properties !== materialParameterData ||
    !Object.isFrozen(materialParameterData)
  ) {
    throw new Error('Material catalog must expose its frozen 258-property aggregate as properties.')
  }

  const propertyKeys = new Set()
  const actualDomainCounts = Object.fromEntries(expectedDomains.map((domain) => [domain, 0]))
  const allowedFields = new Set(['key', 'label_ko', 'quantity_kind', 'special_qualifiers'])
  for (const property of materialParameterData) {
    if (!property || typeof property !== 'object' || !Object.isFrozen(property)) {
      throw new Error('Every material parameter definition must be a frozen object.')
    }
    for (const field of ['tier', 'scope', 'value_form']) {
      if (Object.prototype.hasOwnProperty.call(property, field)) {
        throw new Error(`Material catalog property ${property.key ?? '<unknown>'} must not define ${field}.`)
      }
    }
    const fields = Object.keys(property)
    if (
      !fields.includes('key') ||
      !fields.includes('label_ko') ||
      !fields.includes('quantity_kind') ||
      fields.some((field) => !allowedFields.has(field))
    ) {
      throw new Error(`Material catalog property ${property.key ?? '<unknown>'} has an invalid schema.`)
    }
    if (
      typeof property.key !== 'string' ||
      typeof property.label_ko !== 'string' ||
      property.label_ko.length === 0 ||
      typeof property.quantity_kind !== 'string'
    ) {
      throw new Error('Material catalog property keys, labels, and QuantityKind references must be strings.')
    }
    if (propertyKeys.has(property.key)) {
      throw new Error(`Duplicate material catalog property key: ${property.key}`)
    }
    propertyKeys.add(property.key)

    const [domain, propertyName, ...extraSegments] = property.key.split('.')
    if (
      !(domain in materialParameterDomainCounts) ||
      !/^[a-z][a-z0-9_]*$/.test(propertyName ?? '') ||
      extraSegments.length > 0
    ) {
      throw new Error(`Material catalog property ${property.key} does not follow its domain naming contract.`)
    }
    actualDomainCounts[domain] += 1
    if (
      /^(?:mdb|qudt):/.test(property.quantity_kind) ||
      !Object.prototype.hasOwnProperty.call(quantityKindData, property.quantity_kind)
    ) {
      throw new Error(`Material catalog property ${property.key} has an invalid QuantityKind reference.`)
    }
    if (
      property.special_qualifiers !== undefined &&
      (!Array.isArray(property.special_qualifiers) ||
        !Object.isFrozen(property.special_qualifiers) ||
        property.special_qualifiers.some((qualifier) => typeof qualifier !== 'string'))
    ) {
      throw new Error(`Material catalog property ${property.key} has invalid special qualifiers.`)
    }
  }
  for (const [domain, expectedCount] of Object.entries(materialParameterDomainCounts)) {
    if (actualDomainCounts[domain] !== expectedCount) {
      throw new Error(
        `Material parameter domain ${domain} must contain ${expectedCount} entries; found ${actualDomainCounts[domain]}.`,
      )
    }
  }
}

function markdownText(value) {
  return String(value).replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ')
}

function markdownCode(value) {
  return `\`${String(value).replaceAll('`', '\\`')}\``
}

function materialParameterCatalogMarkdown(materialParameterDomains, materialParameterData, materialParameterCatalog) {
  const [version, status] = materialParameterCatalog.catalog_version.split('-', 2)
  const titleStatus = status ? ` (${status[0].toUpperCase()}${status.slice(1)})` : ''
  const lines = [
    `# Material Parameter Catalog v${version}${titleStatus}`,
    '',
    `- Catalog ID: ${markdownCode(materialParameterCatalog.catalog_id)}`,
    `- QuantityKind data version: ${markdownCode(materialParameterCatalog.quantity_kind_data_version)}`,
    `- Total canonical property keys: **${materialParameterData.length}**`,
    '',
    '## Rules',
    '',
    ...Object.entries(materialParameterCatalog.design_rules).map(
      ([name, description]) => `- **${markdownText(name)}**: ${markdownText(description)}`,
    ),
    '',
    '## Global qualifiers',
    '',
    ...materialParameterCatalog.global_qualifiers.map((qualifier) => `- ${markdownCode(qualifier)}`),
    '',
    '## Canonical keys',
  ]

  for (const domain of materialParameterDomains) {
    const properties = materialParameterData.filter(({ key }) => key.startsWith(`${domain}.`))
    lines.push(
      '',
      `### ${domain} (${properties.length})`,
      '',
      '| Key | Korean label | QuantityKind | Special qualifiers |',
      '|---|---|---|---|',
      ...properties.map((property) => {
        const qualifiers = property.special_qualifiers?.map(markdownCode).join(', ') ?? ''
        return `| ${markdownCode(property.key)} | ${markdownText(property.label_ko)} | ${markdownCode(property.quantity_kind)} | ${qualifiers} |`
      }),
    )
  }
  return `${lines.join('\n')}\n`
}

function materialModelCatalogMarkdown(materialModelCatalog) {
  const lines = [
    '# Material Model Catalog v0.0.0',
    '',
    `- Catalog ID: ${markdownCode(materialModelCatalog.catalog_id)}`,
    `- QuantityKind data version: ${markdownCode(materialModelCatalog.quantity_kind_data_version)}`,
    `- Total canonical model keys: **${materialModelCatalog.relations.length}**`,
    '',
    '| Key | Korean label | Input QuantityKind | Output QuantityKind | Minimum samples | Shared basis |',
    '|---|---|---|---|---:|---|',
    ...materialModelCatalog.relations.map(
      (relation) =>
        `| ${markdownCode(relation.key)} | ${markdownText(relation.label_ko)} | ${markdownCode(relation.input.quantity_kind)} | ${markdownCode(relation.output.quantity_kind)} | ${relation.minimum_samples} | ${relation.shared_basis} |`,
    ),
  ]
  return `${lines.join('\n')}\n`
}

await validateElementManifest()

const [modelRuntime, coreRuntime, kernelContractRuntime, kernelCatalogRuntime] = await Promise.all([
  loadBundledModule(path.join(root, 'src/lib/cad/model/v3.ts')),
  loadBundledModule(path.join(root, 'src/lib/cad/model/core.ts')),
  loadBundledModule(path.join(root, 'src/lib/simulation/kernelContract/index.ts')),
  loadBundledModule(path.join(root, 'src/lib/simulation/kernels/index.ts')),
])
if (
  typeof modelRuntime.structure !== 'function' ||
  typeof modelRuntime.experiment !== 'function' ||
  typeof modelRuntime.StructureDefinition !== 'function' ||
  typeof modelRuntime.ExperimentDefinition !== 'function' ||
  typeof coreRuntime.Material !== 'function' ||
  typeof coreRuntime.Mat !== 'function' ||
  typeof kernelContractRuntime.assertValidKernelDescriptor !== 'function' ||
  !Array.isArray(kernelCatalogRuntime.kernelModules) ||
  !kernelCatalogRuntime.kernelAuthoring ||
  typeof kernelCatalogRuntime.kernelAuthoring !== 'object'
) {
  throw new Error('@caemble/core runtime exports do not match the declaration generator contract.')
}

const descriptors = kernelCatalogRuntime.kernelModules.map((definition, index) => {
  const descriptor = definition?.descriptor
  if (!descriptor) throw new Error(`Production kernel catalog entry ${index} has no descriptor.`)
  kernelContractRuntime.assertValidKernelDescriptor(descriptor)
  return descriptor
})
if (descriptors.length === 0) {
  throw new Error('At least one production KernelDescriptor is required for authoring generation.')
}
const kernelIdentities = descriptors.map(({ name, version }) => JSON.stringify([name, version]))
if (new Set(kernelIdentities).size !== kernelIdentities.length) {
  throw new Error('Production KernelDescriptor identities must be unique.')
}
const expectedAuthoringNames = descriptors.map(({ name }) => camelCase(name)).sort()
const actualAuthoringNames = Object.keys(kernelCatalogRuntime.kernelAuthoring).sort()
if (
  expectedAuthoringNames.length !== actualAuthoringNames.length ||
  expectedAuthoringNames.some((name, index) => name !== actualAuthoringNames[index]) ||
  actualAuthoringNames.some((name) => typeof kernelCatalogRuntime.kernelAuthoring[name] !== 'function')
) {
  throw new Error('Production kernel catalog builders do not match descriptor-derived authoring names.')
}

const [quantityModule, materialModule] = await Promise.all([
  loadBundledModule(path.join(root, 'src/lib/quantitykind/data.ts')),
  loadBundledModule(path.join(root, 'src/lib/material/data.ts')),
])
const quantityKindData = quantityModule.quantityKindData
if (!quantityKindData) throw new Error('quantityKindData could not be loaded for declaration generation.')
const {
  materialModelByKey,
  materialModelCatalog,
  materialModelData,
  materialParameterCatalog,
  materialParameterData,
  materialParameterDomains,
} = materialModule
if (
  !materialModelByKey ||
  !materialModelCatalog ||
  !materialModelData ||
  !materialParameterCatalog ||
  !materialParameterData ||
  !materialParameterDomains
) {
  throw new Error('Material parameter data could not be loaded for catalog generation.')
}
const quantityKindNames = Object.keys(quantityKindData)
if (quantityKindNames.length !== 1_216) {
  throw new Error(`QuantityKind data must contain exactly 1,216 entries; found ${quantityKindNames.length}.`)
}
const quantityKindBaseNames = new Set()
for (const [name, entry] of Object.entries(quantityKindData)) {
  if (!quantityKindDomains.includes(entry.domain)) {
    throw new Error(`QuantityKind ${name} has unknown domain ${entry.domain}.`)
  }
  const baseName = entry.domain === 'general' ? name : name.slice(entry.domain.length + 1)
  const expectedName = entry.domain === 'general' ? baseName : `${entry.domain}.${baseName}`
  if (name !== expectedName || baseName.includes('.')) {
    throw new Error(`QuantityKind ${name} does not follow its domain naming contract.`)
  }
  if (quantityKindBaseNames.has(baseName)) {
    throw new Error(`QuantityKind base name ${baseName} is defined more than once.`)
  }
  quantityKindBaseNames.add(baseName)
  if (!Object.isFrozen(entry) || !Object.isFrozen(entry.applicableUnits)) {
    throw new Error(`QuantityKind ${name} and its applicable units must be frozen.`)
  }
}
validateMaterialParameterCatalog(
  materialParameterDomains,
  materialParameterData,
  materialParameterCatalog,
  quantityKindData,
)
if (
  materialModelCatalog.catalog_id !== 'material-model-catalog' ||
  materialModelCatalog.catalog_version !== '0.0.0' ||
  materialModelCatalog.quantity_kind_data_version !== authoringManifest.quantityKindDataVersion ||
  materialModelCatalog.relations !== materialModelData ||
  materialModelData.length !== 2 ||
  Object.keys(materialModelByKey).length !== 2
) {
  throw new Error('Material model catalog identity or relation data is invalid.')
}
for (const relation of materialModelData) {
  if (
    materialModelByKey[relation.key] !== relation ||
    relation.kind !== 'sampled_relation' ||
    !Object.prototype.hasOwnProperty.call(quantityKindData, relation.input.quantity_kind) ||
    !Object.prototype.hasOwnProperty.call(quantityKindData, relation.output.quantity_kind) ||
    !Number.isSafeInteger(relation.minimum_samples) ||
    relation.minimum_samples < 2 ||
    typeof relation.shared_basis !== 'boolean'
  ) {
    throw new Error(`Material model relation ${relation.key} is invalid.`)
  }
}
if (!/^[a-z0-9._-]+$/i.test(authoringManifest.quantityKindDataVersion)) {
  throw new Error('quantityKindDataVersion must be safe to use in an asset filename.')
}
const quantityKindAsset = `// Generated by scripts/generate-cad-api.mjs from src/lib/quantitykind/data.ts. Do not edit.\nconst data=${JSON.stringify(quantityKindData)}\nfor(const entry of Object.values(data)){Object.freeze(entry.applicableUnits);Object.freeze(entry)}\nexport const quantityKindData=Object.freeze(data)\n`
await emit(`public/assets/quantity-kind-data-${authoringManifest.quantityKindDataVersion}.js`, quantityKindAsset)
await emit(
  '../api/app/quantity_kind_catalog.py',
  pythonQuantityKindCatalog(sha256(quantityKindAsset), quantityKindData),
)

const coreDeclarationPath = path.join(root, 'src/lib/cad/api/caemble-core.d.ts')
const coreDeclaration = await formatGenerated(
  'src/lib/cad/api/caemble-core.d.ts',
  await readFile(coreDeclarationPath, 'utf8').then((source) =>
    source
      .replace(
        /^\/\/ @caemble\/core declaration version: .*$/m,
        `// @caemble/core declaration version: ${authoringManifest.coreDeclarationVersion}`,
      )
      .replace(
        /\/\/ <generated:quantity-kind-types>[\s\S]*?\/\/ <\/generated:quantity-kind-types>/,
        quantityKindTypes(quantityKindData),
      )
      .replace(
        /\/\/ <generated:material-catalog-types>[\s\S]*?\/\/ <\/generated:material-catalog-types>/,
        materialCatalogTypes(materialParameterData, materialModelData),
      ),
  ),
)
const kernelsDeclaration = await formatGenerated('src/lib/cad/api/caemble-kernels.d.ts', kernelDeclaration(descriptors))
const jsxDeclaration = await formatGenerated('src/lib/cad/api/cad-jsx.d.ts', generatedJsxDeclaration())
const declarationFingerprint = sha256(
  ['@caemble/core', coreDeclaration, '@caemble/kernels', kernelsDeclaration, 'cad-jsx', jsxDeclaration].join('\0'),
)

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
if (packageJson.dependencies['monaco-editor'] !== authoringManifest.monacoVersion) {
  throw new Error('authoring-manifest Monaco version must equal the exact package.json dependency.')
}
if (packageJson.devDependencies.typescript !== authoringManifest.typescriptVersion) {
  throw new Error('authoring-manifest TypeScript version must equal the exact package.json devDependency.')
}
const monacoTypeScriptMetadata = await readFile(
  path.join(root, 'node_modules/monaco-editor/esm/vs/languages/features/typescript/lib/typescriptServicesMetadata.js'),
  'utf8',
)
const monacoTypeScriptVersion = monacoTypeScriptMetadata.match(/typescriptVersion = "([^"]+)"/)?.[1]
if (monacoTypeScriptVersion !== authoringManifest.typescriptVersion) {
  throw new Error('The test TypeScript version must match the TypeScript version embedded in Monaco.')
}
const kernelVersions = JSON.stringify(
  Object.fromEntries(descriptors.map((descriptor) => [descriptor.name, descriptor.version])),
  null,
  2,
)
const generatedVersions = await formatGenerated(
  'src/lib/cad/api/generatedVersions.ts',
  `// Generated by scripts/generate-cad-api.mjs. Do not edit.
export const CAEMBLE_CORE_DECLARATION_VERSION = ${tsString(authoringManifest.coreDeclarationVersion)} as const
export const CAEMBLE_KERNEL_DECLARATION_VERSION = ${tsString(authoringManifest.kernelDeclarationVersion)} as const
export const CAEMBLE_MONACO_VERSION = ${tsString(authoringManifest.monacoVersion)} as const
export const CAEMBLE_TYPESCRIPT_VERSION = ${tsString(authoringManifest.typescriptVersion)} as const
export const QUANTITY_KIND_DATA_VERSION = ${tsString(authoringManifest.quantityKindDataVersion)} as const
export const CAD_API_DECLARATION_FINGERPRINT = ${tsString(declarationFingerprint)} as const
export const KERNEL_AUTHORING_VERSIONS = Object.freeze(${kernelVersions})
`,
)

await Promise.all([
  emit('src/lib/cad/elements/generated.ts', generatedElementRegistry()),
  emit('src/lib/cad/api/cad-jsx.d.ts', jsxDeclaration),
  emit('src/lib/cad/api/caemble-core.d.ts', coreDeclaration),
  emit('src/lib/cad/api/caemble-kernels.d.ts', kernelsDeclaration),
  emit('src/lib/quantitykind/index.ts', await formatGenerated('src/lib/quantitykind/index.ts', quantityKindFacade())),
  emit('src/lib/cad/api/generatedVersions.ts', generatedVersions),
  emit(
    'src/lib/material/material_parameter_catalog_v0.0.0.md',
    await formatGenerated(
      'src/lib/material/material_parameter_catalog_v0.0.0.md',
      materialParameterCatalogMarkdown(materialParameterDomains, materialParameterData, materialParameterCatalog),
    ),
  ),
  emit(
    'src/lib/material/material_model_catalog_v0.0.0.md',
    await formatGenerated(
      'src/lib/material/material_model_catalog_v0.0.0.md',
      materialModelCatalogMarkdown(materialModelCatalog),
    ),
  ),
])

if (checkOnly && changed.length > 0) {
  console.error(`Generated CAD API files are stale:\n${changed.map((file) => `- ${file}`).join('\n')}`)
  process.exitCode = 1
} else if (!checkOnly && changed.length > 0) {
  console.log(`Updated generated CAD API files:\n${changed.map((file) => `- ${file}`).join('\n')}`)
}
