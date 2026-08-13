import { CAD_API_DECLARATION_FINGERPRINT, CAEMBLE_MONACO_VERSION } from '../api/generatedVersions'
import { CadModelError } from '../model/errors'
import { EXPERIMENT_ENTRY_PATH, EXPERIMENT_GEOMETRY_PATH, experimentTaskName } from '../source/document'
import {
  MAX_COMPILED_GEOMETRY_GRAPH_BYTES,
  MAX_GEOMETRY_GRAPH_DEPTH,
  MAX_GEOMETRY_IMPORTS_PER_MODULE,
  MAX_GEOMETRY_MODULES,
  MAX_GEOMETRY_ENTRY_IMPORTS,
  isGeometryCoordinate,
  isGeometryComponentName,
} from '../source/geometrySnapshot'
import type { GeometryModuleCoordinate } from '../source/effectiveGeometryGraph'

export const CAD_COMPILER_VERSION =
  `monaco-${CAEMBLE_MONACO_VERSION}-api-5-${CAD_API_DECLARATION_FINGERPRINT}-geometry-source-modules-v3` as const

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
  geometryGraph?: CompiledGeometryGraph
}>

export type CompiledGeometryModule = CompiledCadSource &
  Readonly<{
    entryFile: GeometryModuleCoordinate
    geometrySourceHash: string
    moduleHash: string
    exports: readonly string[]
    imports: readonly Readonly<{
      exportName: string
      alias: string
      coordinate: GeometryModuleCoordinate
    }>[]
  }>

export type CompiledGeometryGraph = Readonly<{
  graphHash: string
  entryImports: readonly Readonly<{
    exportName: string
    alias: string
    coordinate: GeometryModuleCoordinate
    moduleHash: string
  }>[]
  modules: Readonly<Record<GeometryModuleCoordinate, CompiledGeometryModule>>
}>

const localCoordinatePattern =
  /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?@local$/u

function isModuleCoordinate(value: string): value is GeometryModuleCoordinate {
  return isGeometryCoordinate(value) || localCoordinatePattern.test(value)
}

function validEntryFile(entryFile: string, allowGeometry: boolean) {
  return (
    entryFile === EXPERIMENT_ENTRY_PATH ||
    entryFile === EXPERIMENT_GEOMETRY_PATH ||
    experimentTaskName(entryFile) !== null ||
    (allowGeometry && isModuleCoordinate(entryFile))
  )
}

function assertCompiledSource(
  value: unknown,
  extraKeys: readonly string[] = [],
  allowGeometry = false,
): asserts value is CompiledCadSource {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CadModelError('Compiled CAD source must be a plain object.')
  }
  const unknownKey = Object.keys(value).find(
    (key) =>
      !['apiVersion', 'compilerVersion', 'entryFile', 'code', 'sourceMap', 'sourceHash', ...extraKeys].includes(key),
  )
  const compiled = value as Partial<CompiledCadSource>
  if (
    unknownKey ||
    compiled.apiVersion !== 5 ||
    compiled.compilerVersion !== CAD_COMPILER_VERSION ||
    typeof compiled.entryFile !== 'string' ||
    !validEntryFile(compiled.entryFile, allowGeometry) ||
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

export function assertCompiledCadSource(value: unknown): asserts value is CompiledCadSource {
  assertCompiledSource(value)
}

function assertCompiledGeometryGraph(value: unknown, documentHash: string): asserts value is CompiledGeometryGraph {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CadModelError('Compiled Geometry graph must be a plain object.')
  }
  const graph = value as Partial<CompiledGeometryGraph>
  const unknownKey = Object.keys(value).find((key) => !['graphHash', 'entryImports', 'modules'].includes(key))
  if (
    unknownKey ||
    typeof graph.graphHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(graph.graphHash) ||
    !Array.isArray(graph.entryImports) ||
    graph.entryImports.length > MAX_GEOMETRY_ENTRY_IMPORTS ||
    typeof graph.modules !== 'object' ||
    graph.modules === null ||
    Array.isArray(graph.modules) ||
    Object.getPrototypeOf(graph.modules) !== Object.prototype
  ) {
    throw new CadModelError('Compiled Geometry graph provenance is invalid.')
  }
  const modules = Object.entries(graph.modules)
  if (modules.length > MAX_GEOMETRY_MODULES) throw new CadModelError('Compiled Geometry graph has too many modules.')
  let compiledBytes = 0
  modules.forEach(([coordinate, module]) => {
    assertCompiledSource(module, ['geometrySourceHash', 'moduleHash', 'exports', 'imports'], true)
    const geometry = module as CompiledGeometryModule
    if (
      !isModuleCoordinate(coordinate) ||
      geometry.entryFile !== coordinate ||
      geometry.sourceHash !== documentHash ||
      !/^[0-9a-f]{64}$/u.test(geometry.geometrySourceHash) ||
      !/^[0-9a-f]{64}$/u.test(geometry.moduleHash) ||
      !Array.isArray(geometry.exports) ||
      geometry.exports.some((name) => !isGeometryComponentName(name)) ||
      !Array.isArray(geometry.imports) ||
      geometry.imports.length > MAX_GEOMETRY_IMPORTS_PER_MODULE ||
      geometry.imports.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          Object.keys(item).some((key) => !['exportName', 'alias', 'coordinate'].includes(key)) ||
          !isGeometryComponentName(item.exportName) ||
          !isGeometryComponentName(item.alias) ||
          !isModuleCoordinate(item.coordinate),
      )
    ) {
      throw new CadModelError(`Compiled Geometry module provenance is invalid: ${coordinate}`)
    }
    compiledBytes += new TextEncoder().encode(`${geometry.code}${geometry.sourceMap ?? ''}`).byteLength
  })
  if (compiledBytes > MAX_COMPILED_GEOMETRY_GRAPH_BYTES) {
    throw new CadModelError('Compiled Geometry graph exceeds 32 MiB.')
  }

  const moduleMap = graph.modules as CompiledGeometryGraph['modules']
  const reachable = new Set<GeometryModuleCoordinate>()
  const visiting = new Set<GeometryModuleCoordinate>()
  const visit = (coordinate: GeometryModuleCoordinate) => {
    if (visiting.has(coordinate)) throw new CadModelError(`Compiled Geometry graph contains a cycle at ${coordinate}.`)
    if (reachable.has(coordinate)) return
    const module = moduleMap[coordinate]
    if (!module) throw new CadModelError(`Compiled Geometry dependency is unresolved: ${coordinate}`)
    visiting.add(coordinate)
    try {
      const aliases = new Set<string>()
      module.imports.forEach((child) => {
        if (aliases.has(child.alias)) {
          throw new CadModelError(`Compiled Geometry module import alias is duplicated: ${child.alias}.`)
        }
        aliases.add(child.alias)
        visit(child.coordinate)
      })
      reachable.add(coordinate)
    } finally {
      visiting.delete(coordinate)
    }
  }
  const entryAliases = new Set<string>()
  graph.entryImports.forEach((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).some((key) => !['exportName', 'alias', 'coordinate', 'moduleHash'].includes(key)) ||
      !isGeometryComponentName(item.exportName) ||
      !isGeometryComponentName(item.alias) ||
      entryAliases.has(item.alias) ||
      !isModuleCoordinate(item.coordinate) ||
      moduleMap[item.coordinate]?.moduleHash !== item.moduleHash
    ) {
      throw new CadModelError('Compiled Geometry entry import provenance is invalid.')
    }
    entryAliases.add(item.alias)
    visit(item.coordinate)
  })
  const orphan = modules.find(([coordinate]) => !reachable.has(coordinate as GeometryModuleCoordinate))
  if (orphan) throw new CadModelError(`Compiled Geometry module is unreachable: ${orphan[0]}`)

  const memo = new Map<GeometryModuleCoordinate, number>()
  const depth = (coordinate: GeometryModuleCoordinate): number => {
    const cached = memo.get(coordinate)
    if (cached !== undefined) return cached
    const value = moduleMap[coordinate]!.imports.reduce(
      (longest, child) => Math.max(longest, 1 + depth(child.coordinate)),
      1,
    )
    memo.set(coordinate, value)
    return value
  }
  if (graph.entryImports.some((item) => depth(item.coordinate) > MAX_GEOMETRY_GRAPH_DEPTH)) {
    throw new CadModelError(`Compiled Geometry graph exceeds dependency depth ${MAX_GEOMETRY_GRAPH_DEPTH}.`)
  }
}

export function assertCompiledCadDocument(value: unknown): asserts value is CompiledCadDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Compiled CAD document must be an object.')
  }
  const compiled = value as Partial<CompiledCadDocument>
  const unknownKey = Object.keys(value).find(
    (key) => !['apiVersion', 'compilerVersion', 'sourceHash', 'sources', 'geometryGraph'].includes(key),
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
  if (compiled.geometryGraph !== undefined) assertCompiledGeometryGraph(compiled.geometryGraph, compiled.sourceHash)
}
