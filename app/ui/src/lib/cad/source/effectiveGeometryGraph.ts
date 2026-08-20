import { CadModelError } from '../model/errors'
import { analyzeGeometrySource } from './sourceAnalysis'
import {
  GEOMETRY_MODULE_FORMAT_VERSION,
  CURRENT_CAD_API_VERSION,
  GEOMETRY_SNAPSHOT_SCHEMA_VERSION,
  MAX_GEOMETRY_GRAPH_DEPTH,
  MAX_GEOMETRY_GRAPH_SOURCE_BYTES,
  MAX_GEOMETRY_IMPORTS_PER_MODULE,
  MAX_GEOMETRY_MODULES,
  MAX_GEOMETRY_MODULE_SOURCE_BYTES,
  MAX_GEOMETRY_ENTRY_IMPORTS,
  assertGeometrySnapshot,
  geometryModuleHash,
  geometrySourceHash,
  isGeometryCoordinate,
  isGeometryComponentName,
  validateGeometrySnapshotHashes,
  type CadApiVersion,
  type GeometryCoordinate,
  type GeometrySnapshot,
  type LocalGeometryCoordinate,
} from './geometrySnapshot'

export type GeometryModuleCoordinate = GeometryCoordinate | LocalGeometryCoordinate
export type GeometryModuleDraft = Readonly<{ source: string }>
export type GeometryDraftOverlay = Readonly<Partial<Record<GeometryModuleCoordinate, GeometryModuleDraft>>>

export type EffectiveGeometryModule = Readonly<{
  coordinate: GeometryModuleCoordinate
  cadApiVersion: CadApiVersion
  source: string
  sourceHash: string
  moduleHash: string
  exports: readonly string[]
  imports: readonly Readonly<{
    exportName: string
    alias: string
    coordinate: GeometryModuleCoordinate
  }>[]
}>

export type EffectiveGeometryGraph = Readonly<{
  entryImports: readonly Readonly<{
    exportName: string
    alias: string
    coordinate: GeometryModuleCoordinate
    moduleHash: string
  }>[]
  modules: readonly EffectiveGeometryModule[]
  graphHash: string
}>

const localCoordinatePattern =
  /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?@local$/u

function isModuleCoordinate(value: string): value is GeometryModuleCoordinate {
  return isGeometryCoordinate(value) || localCoordinatePattern.test(value)
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function createEffectiveGeometryGraph(
  snapshot: GeometrySnapshot,
  drafts: GeometryDraftOverlay = {},
  entrySource?: string,
): Promise<EffectiveGeometryGraph> {
  assertGeometrySnapshot(snapshot)
  await validateGeometrySnapshotHashes(snapshot)
  const sources = new Map<GeometryModuleCoordinate, string>(
    snapshot.modules.map((module) => [module.coordinate, module.source]),
  )
  const apiVersions = new Map<GeometryModuleCoordinate, CadApiVersion>(
    snapshot.modules.map((module) => [module.coordinate, module.cadApiVersion]),
  )
  Object.entries(drafts).forEach(([coordinate, draft]) => {
    if (!isModuleCoordinate(coordinate)) throw new CadModelError(`Geometry draft coordinate is invalid: ${coordinate}`)
    if (!draft || typeof draft.source !== 'string') {
      throw new CadModelError(`Geometry draft ${coordinate} must contain source text.`)
    }
    const bytes = new TextEncoder().encode(draft.source)
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== draft.source) {
      throw new CadModelError(`Geometry draft ${coordinate} must contain valid UTF-8 text.`)
    }
    if (bytes.byteLength > MAX_GEOMETRY_MODULE_SOURCE_BYTES) {
      throw new CadModelError(`Geometry draft ${coordinate} exceeds ${MAX_GEOMETRY_MODULE_SOURCE_BYTES} bytes.`)
    }
    sources.set(coordinate, draft.source)
    apiVersions.set(coordinate, CURRENT_CAD_API_VERSION)
  })

  const entryAnalysis = entrySource
    ? analyzeGeometrySource(entrySource, { allowEmpty: true, allowLocal: true })
    : {
        exports: [],
        imports: snapshot.entryImports.map((item) => ({
          exportName: item.exportName,
          alias: item.alias,
          coordinate: item.coordinate,
        })),
      }
  if (entryAnalysis.imports.length > MAX_GEOMETRY_ENTRY_IMPORTS) {
    throw new CadModelError(`geometry.tsx exceeds ${MAX_GEOMETRY_ENTRY_IMPORTS} imports.`)
  }
  const entryAliases = new Set<string>()
  entryAnalysis.imports.forEach((item) => {
    if (!isGeometryComponentName(item.exportName) || !isGeometryComponentName(item.alias)) {
      throw new CadModelError('geometry.tsx imports must use PascalCase component names.')
    }
    if (!isModuleCoordinate(item.coordinate)) {
      throw new CadModelError(`geometry.tsx import coordinate is invalid: ${item.coordinate}`)
    }
    if (entryAliases.has(item.alias)) throw new CadModelError(`geometry.tsx import alias is duplicated: ${item.alias}`)
    entryAliases.add(item.alias)
  })

  const modules = new Map<GeometryModuleCoordinate, EffectiveGeometryModule>()
  const visiting = new Set<GeometryModuleCoordinate>()
  let totalBytes = 0
  const build = async (
    coordinate: GeometryModuleCoordinate,
    chain: readonly string[],
  ): Promise<EffectiveGeometryModule> => {
    const ready = modules.get(coordinate)
    if (ready) return ready
    if (visiting.has(coordinate)) {
      throw new CadModelError(
        `Effective Geometry graph contains a dependency cycle: ${[...chain, coordinate].join(' -> ')}`,
      )
    }
    const source = sources.get(coordinate)
    if (source === undefined) throw new CadModelError(`Effective Geometry dependency is unresolved: ${coordinate}`)
    if (modules.size >= MAX_GEOMETRY_MODULES) {
      throw new CadModelError(`Effective Geometry graph exceeds ${MAX_GEOMETRY_MODULES} modules.`)
    }
    totalBytes += new TextEncoder().encode(source).byteLength
    if (totalBytes > MAX_GEOMETRY_GRAPH_SOURCE_BYTES) {
      throw new CadModelError(`Effective Geometry graph sources exceed ${MAX_GEOMETRY_GRAPH_SOURCE_BYTES} bytes.`)
    }
    const analysis = analyzeGeometrySource(source, { allowLocal: true })
    if (analysis.imports.length > MAX_GEOMETRY_IMPORTS_PER_MODULE) {
      throw new CadModelError(`Geometry module ${coordinate} has too many imports.`)
    }
    visiting.add(coordinate)
    try {
      const imports = []
      for (const imported of analysis.imports) {
        if (!isModuleCoordinate(imported.coordinate)) {
          throw new CadModelError(`Geometry module ${coordinate} import is invalid: ${imported.coordinate}`)
        }
        const child = await build(imported.coordinate, [...chain, coordinate])
        if (!child.exports.includes(imported.exportName)) {
          throw new CadModelError(
            `Geometry module ${coordinate} imports missing export ${imported.exportName} from ${imported.coordinate}.`,
          )
        }
        imports.push({
          exportName: imported.exportName,
          alias: imported.alias,
          coordinate: imported.coordinate,
          moduleHash: child.moduleHash,
        })
      }
      imports.sort(
        (left, right) =>
          compareText(left.alias, right.alias) ||
          compareText(left.exportName, right.exportName) ||
          compareText(left.coordinate, right.coordinate),
      )
      const sourceHash = await geometrySourceHash(source)
      const cadApiVersion = apiVersions.get(coordinate) ?? CURRENT_CAD_API_VERSION
      const moduleHash = await geometryModuleHash({
        moduleFormatVersion: GEOMETRY_MODULE_FORMAT_VERSION,
        cadApiVersion,
        coordinate: coordinate as GeometryCoordinate,
        sourceHash,
        imports: imports.map((item) => ({
          exportName: item.exportName,
          alias: item.alias,
          geometryVersionId: 1,
          coordinate: item.coordinate as GeometryCoordinate,
          moduleHash: item.moduleHash,
        })),
      })
      const module = Object.freeze({
        coordinate,
        cadApiVersion,
        source,
        sourceHash,
        moduleHash,
        exports: Object.freeze(analysis.exports.map((item) => item.name).sort(compareText)),
        imports: Object.freeze(
          imports.map(({ exportName, alias, coordinate: importedCoordinate }) =>
            Object.freeze({ exportName, alias, coordinate: importedCoordinate }),
          ),
        ),
      })
      modules.set(coordinate, module)
      return module
    } finally {
      visiting.delete(coordinate)
    }
  }

  const entryImports = []
  for (const imported of entryAnalysis.imports) {
    const module = await build(imported.coordinate as GeometryModuleCoordinate, [])
    if (!module.exports.includes(imported.exportName)) {
      throw new CadModelError(`geometry.tsx imports missing export ${imported.exportName} from ${imported.coordinate}.`)
    }
    entryImports.push(
      Object.freeze({
        exportName: imported.exportName,
        alias: imported.alias,
        coordinate: imported.coordinate as GeometryModuleCoordinate,
        moduleHash: module.moduleHash,
      }),
    )
  }
  const memo = new Map<GeometryModuleCoordinate, number>()
  const depth = (coordinate: GeometryModuleCoordinate): number => {
    const cached = memo.get(coordinate)
    if (cached !== undefined) return cached
    const value = modules
      .get(coordinate)!
      .imports.reduce((longest, imported) => Math.max(longest, 1 + depth(imported.coordinate)), 1)
    memo.set(coordinate, value)
    return value
  }
  if (entryImports.some((item) => depth(item.coordinate) > MAX_GEOMETRY_GRAPH_DEPTH)) {
    throw new CadModelError(`Effective Geometry graph exceeds dependency depth ${MAX_GEOMETRY_GRAPH_DEPTH}.`)
  }
  const sortedModules = [...modules.values()].sort((left, right) => compareText(left.coordinate, right.coordinate))
  entryImports.sort(
    (left, right) =>
      compareText(left.alias, right.alias) ||
      compareText(left.exportName, right.exportName) ||
      compareText(left.coordinate, right.coordinate),
  )
  const graphHash = await sha256(
    JSON.stringify({
      schemaVersion: GEOMETRY_SNAPSHOT_SCHEMA_VERSION,
      entryImports,
      modules: sortedModules.map(({ coordinate, cadApiVersion, sourceHash, moduleHash, exports, imports }) => ({
        coordinate,
        cadApiVersion,
        sourceHash,
        moduleHash,
        exports,
        imports,
      })),
    }),
  )
  return Object.freeze({
    entryImports: Object.freeze(entryImports),
    modules: Object.freeze(sortedModules),
    graphHash,
  })
}
