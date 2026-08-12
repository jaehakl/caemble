import { CAD_API_DECLARATION_FINGERPRINT, CAEMBLE_MONACO_VERSION } from '../api/generatedVersions'
import { CadModelError } from '../model/errors'
import { EXPERIMENT_ENTRY_PATH, experimentTaskName } from '../source/document'

export const CAD_COMPILER_VERSION =
  `monaco-${CAEMBLE_MONACO_VERSION}-api-5-${CAD_API_DECLARATION_FINGERPRINT}-multi-source-v2` as const

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
  apiVersion: 5
  compilerVersion: typeof CAD_COMPILER_VERSION
  entryFile: string
  code: string
  sourceMap?: string
  sourceHash: string
}>

export type CompiledCadDocument = Readonly<{
  apiVersion: 5
  compilerVersion: typeof CAD_COMPILER_VERSION
  sourceHash: string
  sources: Readonly<Record<string, CompiledCadSource>>
}>

function validEntryFile(entryFile: string) {
  return entryFile === EXPERIMENT_ENTRY_PATH || experimentTaskName(entryFile) !== null
}

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
    compiled.apiVersion !== 5 ||
    compiled.compilerVersion !== CAD_COMPILER_VERSION ||
    typeof compiled.entryFile !== 'string' ||
    !validEntryFile(compiled.entryFile) ||
    typeof compiled.code !== 'string' ||
    typeof compiled.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(compiled.sourceHash)
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

export function assertCompiledCadDocument(value: unknown): asserts value is CompiledCadDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Compiled CAD document must be an object.')
  }
  const compiled = value as Partial<CompiledCadDocument>
  const unknownKey = Object.keys(value).find(
    (key) => !['apiVersion', 'compilerVersion', 'sourceHash', 'sources'].includes(key),
  )
  if (
    unknownKey ||
    compiled.apiVersion !== 5 ||
    compiled.compilerVersion !== CAD_COMPILER_VERSION ||
    typeof compiled.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(compiled.sourceHash) ||
    typeof compiled.sources !== 'object' ||
    compiled.sources === null ||
    Array.isArray(compiled.sources)
  ) {
    throw new CadModelError('Compiled CAD document provenance is invalid.')
  }
  const entries = Object.entries(compiled.sources)
  if (entries.length === 0) throw new CadModelError('Compiled CAD document has no sources.')
  entries.forEach(([path, source]) => {
    assertCompiledCadSource(source)
    if (path !== source.entryFile || source.sourceHash !== compiled.sourceHash) {
      throw new CadModelError('Compiled CAD document source provenance does not match.')
    }
  })
}
