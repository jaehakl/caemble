import type * as Monaco from 'monaco-editor'
import coreTypes from '../api/caemble-core.d.ts?raw'
import jsxTypes from '../api/cad-jsx.d.ts?raw'

let didSetup = false

export function setupMonaco(monaco: typeof Monaco) {
  if (didSetup) return

  const typescript = monaco.typescript

  typescript.typescriptDefaults.setCompilerOptions({
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    moduleResolution: typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    jsx: typescript.JsxEmit.React,
    jsxFactory: 'h',
    jsxFragmentFactory: 'Fragment',
    strict: true,
    noEmit: false,
    noEmitOnError: false,
    sourceMap: true,
    inlineSources: true,
  })
  typescript.typescriptDefaults.setEagerModelSync(true)

  typescript.javascriptDefaults.setCompilerOptions({
    target: typescript.ScriptTarget.ES2020,
    module: typescript.ModuleKind.CommonJS,
    moduleResolution: typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: true,
    strict: true,
    noImplicitAny: false,
    noEmit: false,
    noEmitOnError: false,
    sourceMap: true,
    inlineSources: true,
  })
  typescript.javascriptDefaults.setEagerModelSync(true)

  typescript.typescriptDefaults.addExtraLib(coreTypes, 'file:///node_modules/@caemble/core/index.d.ts')
  typescript.typescriptDefaults.addExtraLib(jsxTypes, 'file:///node_modules/@caemble/core/cad-jsx.d.ts')
  didSetup = true
}
