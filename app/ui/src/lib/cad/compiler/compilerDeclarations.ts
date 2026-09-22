import coreTypes from '../api/caemble-core.d.ts?raw'
import jsxTypes from '../api/cad-jsx.d.ts?raw'

// This cache is session-local. Change the version when the compiler protocol or options change.
export const cadCompilerEnvironment = JSON.stringify({ version: 'isolated-monaco-0.56.0-v1', coreTypes, jsxTypes })

export const cadCompilerDeclarations = {
  'file:///node_modules/@caemble/core/index.d.ts': { content: coreTypes, version: 1 },
  'file:///node_modules/@caemble/core/cad-jsx.d.ts': { content: jsxTypes, version: 1 },
}
