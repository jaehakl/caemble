import type * as Monaco from 'monaco-editor'
import coreTypes from '../api/caemble-core.d.ts?raw'
import jsxTypes from '../api/cad-jsx.d.ts?raw'

const geometryCoordinateTypes = `declare module "caemble:geometry/*" {
  const geometry: unknown
  export default geometry
}`

let didSetup = false

export function setupMonaco(monaco: typeof Monaco) {
  if (didSetup) return

  const typescript = monaco.typescript

  typescript.typescriptDefaults.setCompilerOptions({
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    moduleResolution: typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    jsx: typescript.JsxEmit.React,
    jsxFactory: 'h',
    jsxFragmentFactory: 'Fragment',
    strict: true,
    noEmit: false,
    noEmitOnError: true,
    sourceMap: true,
    inlineSources: true,
  })
  typescript.typescriptDefaults.setEagerModelSync(true)

  typescript.typescriptDefaults.addExtraLib(coreTypes, 'file:///node_modules/@caemble/core/index.d.ts')
  typescript.typescriptDefaults.addExtraLib(jsxTypes, 'file:///node_modules/@caemble/core/cad-jsx.d.ts')
  typescript.typescriptDefaults.addExtraLib(
    geometryCoordinateTypes,
    'file:///node_modules/@caemble/geometries/coordinate.d.ts',
  )
  didSetup = true
}
