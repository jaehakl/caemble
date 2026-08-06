import { CadModelError } from '../model/errors'
import { CAD_API_DECLARATION_FINGERPRINT, CAEMBLE_MONACO_VERSION } from '../api/generatedVersions'

export const CAD_COMPILER_VERSION =
  `monaco-${CAEMBLE_MONACO_VERSION}-api-3-${CAD_API_DECLARATION_FINGERPRINT}-single-source-v1` as const

export type CadDiagnostic = Readonly<{
  code: number | string
  file: string
  message: string
  phase: 'policy' | 'semantic' | 'syntax'
  range: Readonly<{
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }>
  severity: 'error' | 'warning' | 'info'
}>

export type CompiledCadSource = Readonly<{
  apiVersion: 3
  compilerVersion: typeof CAD_COMPILER_VERSION
  entryFile: 'structure.tsx' | 'experiment.tsx'
  code: string
  sourceMap?: string
  sourceHash: string
}>

export function assertCompiledCadSource(value: unknown): asserts value is CompiledCadSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Compiled CAD source must be an object.')
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CadModelError('Compiled CAD source must be a plain object.')
  }
  const unknownKey = Object.keys(value).find(
    (key) => !['apiVersion', 'compilerVersion', 'entryFile', 'code', 'sourceMap', 'sourceHash'].includes(key),
  )
  if (unknownKey) throw new CadModelError(`Compiled CAD source.${unknownKey} is not allowed.`)

  const compiled = value as Partial<CompiledCadSource>
  if (
    compiled.apiVersion !== 3 ||
    compiled.compilerVersion !== CAD_COMPILER_VERSION ||
    (compiled.entryFile !== 'structure.tsx' && compiled.entryFile !== 'experiment.tsx') ||
    typeof compiled.code !== 'string' ||
    typeof compiled.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(compiled.sourceHash)
  ) {
    throw new CadModelError('Compiled CAD source provenance is invalid.')
  }
  if (compiled.sourceMap !== undefined && typeof compiled.sourceMap !== 'string') {
    throw new CadModelError('Compiled CAD source map is invalid.')
  }
  if (compiled.code.length + (compiled.sourceMap?.length ?? 0) > 4 * 1024 * 1024) {
    throw new CadModelError('Compiled CAD source exceeds 4 MiB.')
  }
}
