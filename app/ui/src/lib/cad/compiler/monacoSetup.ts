import type * as Monaco from 'monaco-editor'
import coreTypes from '../api/caemble-core.d.ts?raw'
import jsxTypes from '../api/cad-jsx.d.ts?raw'
import { cadCompilerOptions } from './options'
import { calculationCompilerOptions } from '../../calculation/compilerOptions'

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
