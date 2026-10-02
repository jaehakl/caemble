import type * as Monaco from 'monaco-editor'
import coreTypes from '@caemble/execution/cad/api/caemble-core.d.ts?raw'
import jsxTypes from '@caemble/execution/cad/api/cad-jsx.d.ts?raw'
import { cadCompilerOptions } from '@caemble/execution/cad/compiler/options'
import { calculationCompilerOptions } from '@caemble/execution/calculation/compilerOptions'

let didSetup = false

export function setupMonaco(monaco: typeof Monaco) {
  if (didSetup) return

  const typescript = monaco.typescript

  typescript.typescriptDefaults.setCompilerOptions(cadCompilerOptions(typescript))
  typescript.typescriptDefaults.setEagerModelSync(true)

  typescript.javascriptDefaults.setCompilerOptions(calculationCompilerOptions(typescript))
  typescript.javascriptDefaults.setEagerModelSync(true)

  typescript.typescriptDefaults.addExtraLib(coreTypes, 'file:///node_modules/@caemble/core/index.d.ts')
  typescript.typescriptDefaults.addExtraLib(jsxTypes, 'file:///node_modules/@caemble/core/cad-jsx.d.ts')
  didSetup = true
}
