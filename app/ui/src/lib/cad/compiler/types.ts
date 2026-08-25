import { CAD_API_DECLARATION_FINGERPRINT, CAEMBLE_MONACO_VERSION } from '../api/generatedVersions'
import { CadModelError } from '../model/errors'
import {
  CAD_SOURCE_API_VERSION,
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
} from '../source/document'
import {
  assertExperimentSourcePath,
  assertExperimentSourcePaths,
  isExperimentTypeScriptPath,
} from '../source/moduleResolution'

export const CAD_COMPILER_VERSION =
  `monaco-${CAEMBLE_MONACO_VERSION}-api-10-${CAD_API_DECLARATION_FINGERPRINT}-experiment-bundle-v1` as const

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
  apiVersion: typeof CAD_SOURCE_API_VERSION
  compilerVersion: typeof CAD_COMPILER_VERSION
  entryFile: string
  code: string
  sourceMap?: string
  sourceHash: string
}>

export type CompiledCadDocument = Readonly<{
  apiVersion: typeof CAD_SOURCE_API_VERSION
  compilerVersion: typeof CAD_COMPILER_VERSION
  sourceHash: string
  sources: Readonly<Record<string, CompiledCadSource>>
}>

function assertPlainObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CadModelError(message)
  }
}

export function assertCompiledCadSource(value: unknown): asserts value is CompiledCadSource {
  assertPlainObject(value, 'Compiled CAD source must be a plain object.')
  const unknownKey = Object.keys(value).find(
    (key) => !['apiVersion', 'compilerVersion', 'entryFile', 'code', 'sourceMap', 'sourceHash'].includes(key),
  )
  const compiled = value as Partial<CompiledCadSource>
  if (
    unknownKey ||
    compiled.apiVersion !== CAD_SOURCE_API_VERSION ||
    compiled.compilerVersion !== CAD_COMPILER_VERSION ||
    typeof compiled.entryFile !== 'string' ||
    !isExperimentTypeScriptPath(compiled.entryFile) ||
    typeof compiled.code !== 'string' ||
    typeof compiled.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(compiled.sourceHash)
  ) {
    throw new CadModelError('Compiled CAD source provenance is invalid.')
  }
  assertExperimentSourcePath(compiled.entryFile)
  if (compiled.sourceMap !== undefined && typeof compiled.sourceMap !== 'string') {
    throw new CadModelError('Compiled CAD source map is invalid.')
  }
  if (new TextEncoder().encode(`${compiled.code}${compiled.sourceMap ?? ''}`).byteLength > 4 * 1024 * 1024) {
    throw new CadModelError('Compiled CAD source exceeds 4 MiB.')
  }
}

export function assertCompiledCadDocument(value: unknown): asserts value is CompiledCadDocument {
  assertPlainObject(value, 'Compiled CAD document must be a plain object.')
  const compiled = value as Partial<CompiledCadDocument>
  const unknownKey = Object.keys(value).find(
    (key) => !['apiVersion', 'compilerVersion', 'sourceHash', 'sources'].includes(key),
  )
  if (
    unknownKey ||
    compiled.apiVersion !== CAD_SOURCE_API_VERSION ||
    compiled.compilerVersion !== CAD_COMPILER_VERSION ||
    typeof compiled.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(compiled.sourceHash)
  ) {
    throw new CadModelError('Compiled CAD document provenance is invalid.')
  }
  assertPlainObject(compiled.sources, 'Compiled CAD document sources must be a plain object.')
  const entries = Object.entries(compiled.sources)
  const paths = entries.map(([path]) => path)
  assertExperimentSourcePaths(paths)
  if (
    paths.some((path) => !isExperimentTypeScriptPath(path)) ||
    !paths.includes(EXPERIMENT_ENTRY_PATH) ||
    !paths.includes(EXPERIMENT_GEOMETRY_PATH) ||
    !paths.includes(EXPERIMENT_MATERIAL_PATH)
  ) {
    throw new CadModelError('Compiled CAD document is missing required TypeScript sources.')
  }
  let compiledBytes = 0
  entries.forEach(([path, source]) => {
    assertCompiledCadSource(source)
    if (path !== source.entryFile || source.sourceHash !== compiled.sourceHash) {
      throw new CadModelError('Compiled CAD document source provenance does not match.')
    }
    compiledBytes += new TextEncoder().encode(`${source.code}${source.sourceMap ?? ''}`).byteLength
  })
  if (compiledBytes > 32 * 1024 * 1024) {
    throw new CadModelError('Compiled CAD document exceeds 32 MiB.')
  }
}
