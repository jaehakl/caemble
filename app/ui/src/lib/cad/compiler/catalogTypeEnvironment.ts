import type * as Monaco from 'monaco-editor'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'

const catalogTypesPath = 'file:///node_modules/@caemble/core/catalog-runtime.d.ts'
let environmentQueue = Promise.resolve()

function literal(value: string) {
  return JSON.stringify(value)
}

export function catalogRuntimeTypes(slice: CatalogRuntimeSlice) {
  const quantityKinds = slice.quantityKinds.map(
    (entry) => `    ${literal(entry.name)}: { readonly domain: ${literal(entry.domain)}; readonly tensorOrder: ${entry.tensorOrder}; readonly applicableUnits: readonly [${entry.applicableUnits.map(literal).join(', ')}] }`,
  )
  const parameters = slice.materialParameters.map(
    (entry) => `    ${literal(entry.key)}: ${literal(entry.quantityKind)}`,
  )
  const models = slice.materialModels.map(
    (entry) => `    ${literal(entry.key)}: Readonly<{
      key: ${literal(entry.key)}
      kind: 'sampled_relation'
      input: Readonly<{ quantity_kind: ${literal(entry.input.quantityKind)} }>
      output: Readonly<{ quantity_kind: ${literal(entry.output.quantityKind)} }>
      minimum_samples: ${entry.minimumSamples}
      shared_basis: ${entry.sharedBasis}
    }>`,
  )
  return `export {}
declare module '@caemble/core' {
  interface CatalogQuantityKindMap {
${quantityKinds.join('\n')}
  }
  interface MaterialPropertyQuantityKindMap {
${parameters.join('\n')}
  }
  interface MaterialModelDefinitionMap {
${models.join('\n')}
  }
}
`
}

export function withCatalogTypeEnvironment<T>(
  monaco: typeof Monaco,
  slice: CatalogRuntimeSlice | undefined,
  run: () => Promise<T>,
) {
  const previous = environmentQueue
  let release: () => void = () => undefined
  environmentQueue = new Promise<void>((resolve) => { release = resolve })
  return previous.then(async () => {
    const disposable = slice
      ? monaco.typescript.typescriptDefaults.addExtraLib(catalogRuntimeTypes(slice), catalogTypesPath)
      : undefined
    try {
      return await run()
    } finally {
      disposable?.dispose()
      release()
    }
  })
}
