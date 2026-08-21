import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { format } from 'prettier'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')
const changed = []

const elementManifestPath = path.join(root, 'src/lib/cad/elements/manifest.json')
const authoringManifestPath = path.join(root, 'src/lib/cad/api/authoring-manifest.json')
const elementManifest = JSON.parse(await readFile(elementManifestPath, 'utf8'))
const authoringManifest = JSON.parse(await readFile(authoringManifestPath, 'utf8'))

function catalogQuery(resource, key) {
  const catalogRoot = path.resolve(root, '../catalog')
  const executable = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const output = execFileSync(
    executable,
    [
      '-m',
      'caemble_catalog',
      '--database',
      path.join(catalogRoot, 'caemble_catalog/catalog.sqlite3'),
      'query',
      resource,
      key,
    ],
    {
      cwd: catalogRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: [catalogRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    },
  )
  return JSON.parse(output)
}

function tsString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
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
  if (current.replaceAll('\r\n', '\n') === content) return
  changed.push(relativePath)
  if (!checkOnly) await writeFile(outputPath, content, 'utf8')
}

function declaredAttributeProperties(source, typeName, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const properties = new Set()
  const collect = (node) => {
    if (ts.isIntersectionTypeNode(node)) {
      node.types.forEach(collect)
      return
    }
    if (ts.isTypeReferenceNode(node) && node.typeName.getText(sourceFile) === 'Readonly') {
      node.typeArguments?.forEach(collect)
      return
    }
    if (!ts.isTypeLiteralNode(node)) return
    node.members.forEach((member) => {
      if (!ts.isPropertySignature(member) || !member.name) return
      const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined
      if (name) properties.add(name)
    })
  }
  sourceFile.statements.forEach((statement) => {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName) collect(statement.type)
  })
  return [...properties]
}

function runtimeDefaultProperties(source, definitionName, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== definitionName || !declaration.initializer)
        continue
      let definition = declaration.initializer
      while (ts.isSatisfiesExpression(definition) || ts.isAsExpression(definition)) definition = definition.expression
      if (!ts.isObjectLiteralExpression(definition)) continue
      const defaultsProperty = definition.properties.find(
        (property) => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'defaultProps',
      )
      if (!defaultsProperty || !ts.isPropertyAssignment(defaultsProperty)) return []
      const call = defaultsProperty.initializer
      const defaults = ts.isCallExpression(call) ? call.arguments[0] : call
      if (!defaults || !ts.isObjectLiteralExpression(defaults)) return []
      return defaults.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return []
        return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? [property.name.text] : []
      })
    }
  }
  return []
}

async function validateElementManifest() {
  if (elementManifest.version !== 2 || !Array.isArray(elementManifest.elements)) {
    throw new Error('src/lib/cad/elements/manifest.json must use element manifest format version 2.')
  }
  const tags = new Set()
  const manifests = []
  for (const element of elementManifest.elements) {
    if (tags.has(element.tag)) throw new Error(`Duplicate CAD element manifest tag: ${element.tag}`)
    tags.add(element.tag)
    if (typeof element.authoringName !== 'string' || !element.authoringName.trim()) {
      throw new Error(`CAD element authoring name must not be blank: ${element.tag}`)
    }
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

    const definitionModule = await loadBundledModule(definitionPath)
    const manifest = definitionModule[element.manifestExport]
    if (
      !manifest ||
      manifest.tag !== element.tag ||
      manifest.authoringName !== element.authoringName ||
      manifest.standardTransforms !== element.standardTransforms ||
      !['primitive', 'operation'].includes(manifest.category) ||
      (manifest.category === 'primitive' && !/^[A-Z][A-Za-z0-9]*$/u.test(manifest.authoringName)) ||
      (manifest.category === 'operation' && manifest.authoringName !== manifest.tag) ||
      !manifest.syntax?.trim() ||
      !manifest.summary?.trim() ||
      !Array.isArray(manifest.keywords) ||
      manifest.keywords.length === 0 ||
      manifest.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim()) ||
      !Array.isArray(manifest.properties) ||
      !manifest.children ||
      !['none', 'one', 'many'].includes(manifest.children.count) ||
      typeof manifest.children.description !== 'string' ||
      !manifest.children.description.trim() ||
      typeof manifest.origin !== 'string' ||
      !manifest.origin.trim() ||
      !Array.isArray(manifest.surfaces) ||
      manifest.surfaces.length === 0 ||
      manifest.surfaces.some((surface) => typeof surface !== 'string' || !surface.trim()) ||
      typeof manifest.example !== 'string' ||
      !manifest.example.includes(`<${element.authoringName}`)
    ) {
      throw new Error(`${element.definitionModule} has incomplete CAD authoring metadata.`)
    }

    const commonProperties = new Set(['id', 'position', 'rotation', 'scale', 'pos', 'rotate'])
    const documentedProperties = manifest.properties.map((property) => property.name)
    if (
      new Set(documentedProperties).size !== documentedProperties.length ||
      manifest.properties.some(
        (property) =>
          !property ||
          typeof property.name !== 'string' ||
          !property.name.trim() ||
          commonProperties.has(property.name) ||
          typeof property.type !== 'string' ||
          !property.type.trim() ||
          typeof property.required !== 'boolean' ||
          (property.default !== undefined && typeof property.default !== 'string') ||
          typeof property.authoringValue !== 'string' ||
          !property.authoringValue.trim() ||
          typeof property.description !== 'string' ||
          !property.description.trim(),
      )
    ) {
      throw new Error(`${element.definitionModule} has invalid or duplicated property metadata.`)
    }
    const declaredProperties = declaredAttributeProperties(definition, element.attributes, definitionPath).filter(
      (property) => property !== 'children',
    )
    if (
      declaredProperties.length !== documentedProperties.length ||
      declaredProperties.some((property) => !documentedProperties.includes(property))
    ) {
      throw new Error(
        `${element.definitionModule} property metadata must exactly match ${element.attributes}: declared [${declaredProperties.join(', ')}], documented [${documentedProperties.join(', ')}].`,
      )
    }
    if (manifest.category === 'primitive') {
      if (manifest.properties.some((property) => property.required || property.default === undefined)) {
        throw new Error(`${element.definitionModule} primitive properties must all declare defaults.`)
      }
      const runtimeDefaults = runtimeDefaultProperties(runtime, element.definitionExport, runtimePath)
      if (
        runtimeDefaults.length !== documentedProperties.length ||
        documentedProperties.some((property) => !runtimeDefaults.includes(property))
      ) {
        throw new Error(
          `${element.runtimeModule} defaultProps must exactly match primitive properties: [${documentedProperties.join(', ')}].`,
        )
      }
    }
    manifests.push(manifest)
  }
  return manifests
}

function generatedElementRegistry() {
  const elements = elementManifest.elements
  return `// Generated by scripts/generate-cad-api.mjs from manifest.json. Do not edit.\n${groupedImports(
    elements,
    'definitionModule',
    'manifestExport',
  )}\n${groupedImports(elements, 'runtimeModule', 'definitionExport')}\nimport { cadAuthoringContract } from './authoringContract'\nimport type { CadElementDefinition } from '../evaluation/types'\n\nexport { cadAuthoringContract }\n\nexport const cadPrimitiveAuthoringBindings = Object.freeze({\n${elements
    .filter((element) => element.authoringName !== element.tag)
    .map((element) => `  ${element.authoringName}: ${tsString(element.tag)},`)
    .join(
      '\n',
    )}\n} as const)\n\nexport const cadElementCatalog = [\n${elements.map((element) => `  ${element.manifestExport},`).join('\n')}\n] as const\n\nexport const cadElementDefinitions = [\n${elements.map((element) => `  ${element.definitionExport},`).join('\n')}\n] as const satisfies readonly CadElementDefinition[]\n`
}

function generatedJsxDeclaration() {
  const attributes = [...new Set(elementManifest.elements.map((element) => element.attributes))].sort()
  return `// Generated by scripts/generate-cad-api.mjs from elements/manifest.json. Do not edit.\nimport type {\n${attributes.map((name) => `  ${name},`).join('\n')}\n  Geometry,\n  GeometryInvocationAttributes,\n} from '@caemble/core'\n\ndeclare global {\n  function h(type: unknown, attributes: unknown, ...children: unknown[]): unknown\n  function Fragment(props: { children?: unknown }): unknown\n\n  namespace JSX {\n    type LibraryManagedAttributes<Component, Props> = Props extends { readonly id: string }\n      ? Component extends Geometry<infer CustomProps>\n        ? GeometryInvocationAttributes<CustomProps>\n        : Props\n      : Props\n\n    interface IntrinsicElements {\n${elementManifest.elements
    .map((element) =>
      element.authoringName === element.tag
        ? `      ${element.tag}: ${element.attributes}`
        : `      /** @deprecated Import { ${element.authoringName} } from '@caemble/core'. */\n      ${element.tag}: ${element.attributes}`,
    )
    .join('\n')}\n    }\n  }\n}\n\nexport {}\n`
}

function primitiveAuthoringDeclarations() {
  return `// <generated:primitive-authoring-bindings>
${elementManifest.elements
  .filter((element) => element.authoringName !== element.tag)
  .map((element) => `export const ${element.authoringName}: ${tsString(element.tag)}`)
  .join('\n')}
// </generated:primitive-authoring-bindings>`
}

function quantityKindTypes() {
  return `// <generated:quantity-kind-types>
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CatalogQuantityKindMap {}
export type QuantityKindName = keyof CatalogQuantityKindMap extends never ? string : keyof CatalogQuantityKindMap
export type QuantityKindDomain = string
export type QuantityKindNameForDomain<Domain extends QuantityKindDomain> = keyof CatalogQuantityKindMap extends never
  ? string & { readonly __domain?: Domain }
  : { [Name in keyof CatalogQuantityKindMap]: CatalogQuantityKindMap[Name]['domain'] extends Domain ? Name : never }[keyof CatalogQuantityKindMap]
export type TensorQuantityKindName = keyof CatalogQuantityKindMap extends never
  ? string
  : { [Name in keyof CatalogQuantityKindMap]: CatalogQuantityKindMap[Name]['tensorOrder'] extends 0 ? never : Name }[keyof CatalogQuantityKindMap]
export type ScalarQuantityKindName = keyof CatalogQuantityKindMap extends never
  ? string
  : { [Name in keyof CatalogQuantityKindMap]: CatalogQuantityKindMap[Name]['tensorOrder'] extends 0 ? Name : never }[keyof CatalogQuantityKindMap]
export type ApplicableUnit<Name extends QuantityKindName> = Name extends keyof CatalogQuantityKindMap
  ? CatalogQuantityKindMap[Name]['applicableUnits'][number]
  : UcumUnit
// </generated:quantity-kind-types>`
}

function materialCatalogTypes(properties, models) {
  void properties
  void models
  return `// <generated:material-catalog-types>
// Catalog keys are augmented in memory from the active Solver runtime slice.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MaterialPropertyQuantityKindMap {}
export type MaterialPropertyKey = keyof MaterialPropertyQuantityKindMap extends never
  ? string
  : keyof MaterialPropertyQuantityKindMap
export type MaterialPropertyQuantityKind<Key extends MaterialPropertyKey> = Key extends keyof MaterialPropertyQuantityKindMap
  ? MaterialPropertyQuantityKindMap[Key]
  : QuantityKindName
export type MaterialPropertyDefinitionFor<Key extends MaterialPropertyKey> = Readonly<{
  key: Key
  quantity_kind: MaterialPropertyQuantityKind<Key>
}>

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MaterialModelDefinitionMap {}
export type MaterialModelKey = keyof MaterialModelDefinitionMap extends never ? string : keyof MaterialModelDefinitionMap
export type MaterialModelDefinitionFor<Key extends MaterialModelKey> = Key extends keyof MaterialModelDefinitionMap
  ? MaterialModelDefinitionMap[Key]
  : Readonly<{
      key: Key
      kind: 'sampled_relation'
      input: Readonly<{ quantity_kind: QuantityKindName }>
      output: Readonly<{ quantity_kind: QuantityKindName }>
      minimum_samples: number
      shared_basis: boolean
    }>
export type MaterialCatalogKey = MaterialPropertyKey | MaterialModelKey

type MaterialAuthoringBasis<Name extends QuantityKindName> = Name extends ScalarQuantityKindName
  ? Readonly<{ basis?: never }>
  : Readonly<{ basis?: CartesianBasis }>
type MaterialNormalizedBasis<Name extends QuantityKindName> = Name extends ScalarQuantityKindName
  ? Readonly<{ basis?: never }>
  : Readonly<{ basis: CartesianBasis }>

export type MaterialDataValueDescriptor<
  Key extends MaterialPropertyKey = MaterialPropertyKey,
> = Key extends MaterialPropertyKey ? Readonly<{
  dtype: FloatDataDType
  value: number | readonly unknown[]
  unit: ApplicableUnit<MaterialPropertyQuantityKind<Key>>
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
  unit: ApplicableUnit<Name>
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
export type MaterialVariables = keyof MaterialPropertyQuantityKindMap extends never
  ? Readonly<Record<string, unknown> & { color?: string; errorRate?: number }>
  : Readonly<
      { [Key in keyof MaterialPropertyQuantityKindMap]?: MaterialDataValueDescriptor<Key> } &
      { [Key in keyof MaterialModelDefinitionMap]?: MaterialSampledRelation<Key> } &
      { color?: string; errorRate?: number }
    >
export type NormalizedMaterialVariables = keyof MaterialPropertyQuantityKindMap extends never
  ? Readonly<Record<string, unknown> & { color?: string }>
  : Readonly<
      { [Key in keyof MaterialPropertyQuantityKindMap]?: NormalizedMaterialDataValueDescriptor<Key> } &
      { [Key in keyof MaterialModelDefinitionMap]?: MaterialSampledRelation<Key> } &
      { color?: string }
    >
export type ResolvedMaterialVariables = NormalizedMaterialVariables
// </generated:material-catalog-types>`
}

function quantityKindFacade() {
  return `import { activeCatalogRuntimeSlice } from '../catalog/runtime'
import { QuantityKindEntry } from './runtime'
import type { QuantityKindDefinition, QuantityKindName } from './runtime'

export type {
  ApplicableUnit, CartesianBasis, QuantityKindComponentShape, QuantityKindComponentValue,
  QuantityKindDefinition, QuantityKindDomain, QuantityKindName, QuantityKindNameForDomain,
  QuantityKindTensorOrder, QuantityMetadata, QuantityValueReference, ScalarQuantityKindName,
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
  ownKeys() { return activeCatalogRuntimeSlice().quantityKinds.map((entry) => entry.name) },
  getOwnPropertyDescriptor(_target, name) {
    return typeof name === 'string' && activeCatalogRuntimeSlice().quantityKinds.some((entry) => entry.name === name)
      ? { configurable: true, enumerable: true }
      : undefined
  },
}) as Readonly<Record<QuantityKindName, QuantityKindDefinition<QuantityKindName>>>
`
}

const elementCatalog = await validateElementManifest()

const [modelRuntime, coreRuntime] = await Promise.all([
  loadBundledModule(path.join(root, 'src/lib/cad/model/v5.ts')),
  loadBundledModule(path.join(root, 'src/lib/cad/model/core.ts')),
])
if (
  typeof modelRuntime.experiment !== 'function' ||
  typeof modelRuntime.ExperimentDefinition !== 'function' ||
  typeof modelRuntime.TaskDefinition !== 'function' ||
  typeof coreRuntime.Material !== 'function' ||
  typeof coreRuntime.Mat !== 'function' ||
  typeof coreRuntime.radians !== 'function'
) {
  throw new Error('@caemble/core runtime exports do not match the declaration generator contract.')
}

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
        /\/\/ <generated:primitive-authoring-bindings>[\s\S]*?\/\/ <\/generated:primitive-authoring-bindings>/,
        primitiveAuthoringDeclarations(),
      )
      .replace(
        /\/\/ <generated:quantity-kind-types>[\s\S]*?\/\/ <\/generated:quantity-kind-types>/,
        quantityKindTypes(),
      )
      .replace(
        /\/\/ <generated:material-catalog-types>[\s\S]*?\/\/ <\/generated:material-catalog-types>/,
        materialCatalogTypes(),
      ),
  ),
)
const jsxDeclaration = await formatGenerated('src/lib/cad/api/cad-jsx.d.ts', generatedJsxDeclaration())
const declarationFingerprint = sha256(['@caemble/core', coreDeclaration, 'cad-jsx', jsxDeclaration].join('\0'))
const [authoringReferenceModule, authoringContractModule] = await Promise.all([
  loadBundledModule(path.join(root, 'src/lib/cad/authoringReference.ts')),
  loadBundledModule(path.join(root, 'src/lib/cad/elements/authoringContract.ts')),
])
const geometrySkeleton = catalogQuery('geometry', 'geometry-authoring-skeleton')
const authoringReferencePayload = authoringReferenceModule.buildCadAuthoringReference({
  authoringContract: authoringContractModule.cadAuthoringContract,
  declarationFingerprint,
  elements: elementCatalog,
  geometrySkeleton: geometrySkeleton.source,
})
const authoringReferenceHash = sha256(JSON.stringify(authoringReferencePayload))
const aiAgentPromptToolVersion = `caemble-ai-agent-v4-${authoringReferenceHash.slice(0, 12)}`
const backendAuthoringReference = `${JSON.stringify(
  {
    ...authoringReferencePayload,
    referenceHash: authoringReferenceHash,
    promptToolVersion: aiAgentPromptToolVersion,
  },
  null,
  2,
)}\n`

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
const generatedVersions = await formatGenerated(
  'src/lib/cad/api/generatedVersions.ts',
  `// Generated by scripts/generate-cad-api.mjs. Do not edit.
export const CAEMBLE_CORE_DECLARATION_VERSION = ${tsString(authoringManifest.coreDeclarationVersion)} as const
export const CAEMBLE_MONACO_VERSION = ${tsString(authoringManifest.monacoVersion)} as const
export const CAEMBLE_TYPESCRIPT_VERSION = ${tsString(authoringManifest.typescriptVersion)} as const
export const CAD_API_DECLARATION_FINGERPRINT = ${tsString(declarationFingerprint)} as const
`,
)
const aiAgentSourcePath = path.join(root, 'src/api/aiAgent.ts')
const aiAgentSource = await formatGenerated(
  'src/api/aiAgent.ts',
  await readFile(aiAgentSourcePath, 'utf8').then((source) =>
    source.replace(
      /\/\/ <generated:ai-agent-prompt-tool-version>[\s\S]*?\/\/ <\/generated:ai-agent-prompt-tool-version>/,
      `// <generated:ai-agent-prompt-tool-version>\nexport const AI_AGENT_PROMPT_TOOL_VERSION = ${tsString(aiAgentPromptToolVersion)} as const\n// </generated:ai-agent-prompt-tool-version>`,
    ),
  ),
)

await Promise.all([
  emit('src/lib/cad/elements/generated.ts', generatedElementRegistry()),
  emit('src/lib/cad/api/cad-jsx.d.ts', jsxDeclaration),
  emit('src/lib/cad/api/caemble-core.d.ts', coreDeclaration),
  emit('src/lib/quantitykind/index.ts', await formatGenerated('src/lib/quantitykind/index.ts', quantityKindFacade())),
  emit('src/lib/cad/api/generatedVersions.ts', generatedVersions),
  emit('src/api/aiAgent.ts', aiAgentSource),
  emit('../api/app/ai/cad_authoring_reference.json', backendAuthoringReference),
])

if (checkOnly && changed.length > 0) {
  console.error(`Generated CAD API files are stale:\n${changed.map((file) => `- ${file}`).join('\n')}`)
  process.exitCode = 1
} else if (!checkOnly && changed.length > 0) {
  console.log(`Updated generated CAD API files:\n${changed.map((file) => `- ${file}`).join('\n')}`)
}
