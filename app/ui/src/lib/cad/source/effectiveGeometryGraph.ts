import { CadModelError } from '../model/errors'
import { analyzeGeometrySource } from './sourceAnalysis'
import {
  MAX_GEOMETRY_GRAPH_DEPTH,
  MAX_GEOMETRY_GRAPH_SOURCE_BYTES,
  MAX_GEOMETRY_IMPORTS_PER_MODULE,
  MAX_GEOMETRY_MODULES,
  MAX_GEOMETRY_MODULE_SOURCE_BYTES,
  MAX_GEOMETRY_ROOTS,
  assertGeometryCoordinate,
  assertGeometrySnapshot,
  geometryCoordinateNamespace,
  geometryModuleHash,
  geometrySourceHash,
  validateGeometrySnapshotHashes,
  type GeometryCoordinate,
  type GeometrySnapshot,
} from './geometrySnapshot'

export type GeometryModuleDraft = Readonly<{ source: string }>
export type GeometryDraftOverlay = Readonly<Partial<Record<GeometryCoordinate, GeometryModuleDraft>>>
export type GeometryDraftRoot = Readonly<{ alias: string; coordinate: GeometryCoordinate }>

export type EffectiveGeometryModule = Readonly<{
  coordinate: GeometryCoordinate
  source: string
  sourceHash: string
  moduleHash: string
  imports: readonly GeometryCoordinate[]
}>

export type EffectiveGeometryGraph = Readonly<{
  roots: readonly Readonly<{ alias: string; coordinate: GeometryCoordinate; moduleHash: string }>[]
  modules: readonly EffectiveGeometryModule[]
  graphHash: string
}>

function sourceBytes(source: string) {
  return new TextEncoder().encode(source).byteLength
}

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function createEffectiveGeometryGraph(
  snapshot: GeometrySnapshot,
  drafts: GeometryDraftOverlay = {},
  rootOverrides?: readonly GeometryDraftRoot[],
): Promise<EffectiveGeometryGraph> {
  assertGeometrySnapshot(snapshot)
  await validateGeometrySnapshotHashes(snapshot)
  const sources = new Map<GeometryCoordinate, string>(
    snapshot.modules.map((module) => [module.coordinate, module.source]),
  )
  Object.entries(drafts).forEach(([coordinate, draft]) => {
    assertGeometryCoordinate(coordinate, 'Geometry draft coordinate')
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || typeof draft.source !== 'string') {
      throw new CadModelError(`Geometry draft ${coordinate} must contain source text.`)
    }
    const encodedSource = new TextEncoder().encode(draft.source)
    if (new TextDecoder('utf-8', { fatal: true }).decode(encodedSource) !== draft.source) {
      throw new CadModelError(`Geometry draft ${coordinate} must contain valid UTF-8 text.`)
    }
    if (encodedSource.byteLength > MAX_GEOMETRY_MODULE_SOURCE_BYTES) {
      throw new CadModelError(`Geometry draft ${coordinate} exceeds ${MAX_GEOMETRY_MODULE_SOURCE_BYTES} bytes.`)
    }
    sources.set(coordinate, draft.source)
  })
  const persisted = new Map(snapshot.modules.map((module) => [module.coordinate, module]))
  const modules = new Map<GeometryCoordinate, EffectiveGeometryModule>()
  const visiting = new Set<GeometryCoordinate>()
  let totalSourceBytes = 0
  let ownerNamespace: string | undefined
  const build = async (coordinate: GeometryCoordinate, chain: readonly string[]) => {
    const ready = modules.get(coordinate)
    if (ready) return ready
    if (visiting.has(coordinate)) {
      throw new CadModelError(
        `Effective Geometry graph contains a dependency cycle: ${[...chain, coordinate].join(' -> ')}`,
      )
    }
    const source = sources.get(coordinate)
    if (source === undefined) throw new CadModelError(`Effective Geometry dependency is unresolved: ${coordinate}`)
    if (ownerNamespace && geometryCoordinateNamespace(coordinate) !== ownerNamespace) {
      throw new CadModelError(`Effective Geometry dependency crosses owner namespaces: ${coordinate}`)
    }
    if (modules.size >= MAX_GEOMETRY_MODULES) {
      throw new CadModelError(`Effective Geometry graph exceeds ${MAX_GEOMETRY_MODULES} modules.`)
    }
    totalSourceBytes += sourceBytes(source)
    if (totalSourceBytes > MAX_GEOMETRY_GRAPH_SOURCE_BYTES) {
      throw new CadModelError(`Effective Geometry graph sources exceed ${MAX_GEOMETRY_GRAPH_SOURCE_BYTES} bytes.`)
    }
    const imports = analyzeGeometrySource(source)
      .imports.map((item) => item.coordinate)
      .sort(compareCanonicalText)
    if (imports.length > MAX_GEOMETRY_IMPORTS_PER_MODULE) {
      throw new CadModelError(`Geometry module ${coordinate} exceeds ${MAX_GEOMETRY_IMPORTS_PER_MODULE} imports.`)
    }
    const persistedModule = persisted.get(coordinate)
    const changesPersistedSource =
      Object.prototype.hasOwnProperty.call(drafts, coordinate) && source !== persistedModule?.source
    if (persistedModule && !changesPersistedSource) {
      const projected = [...persistedModule.imports].map((item) => item.coordinate).sort(compareCanonicalText)
      if (projected.length !== imports.length || projected.some((item, index) => item !== imports[index])) {
        throw new CadModelError(`Geometry module source imports do not match its snapshot projection: ${coordinate}`)
      }
    }
    visiting.add(coordinate)
    try {
      const imported: EffectiveGeometryModule[] = []
      for (const child of imports) {
        imported.push(await build(child, [...chain, coordinate]))
      }
      const sourceHash = await geometrySourceHash(source)
      const moduleHash = await geometryModuleHash({
        moduleFormatVersion: 1,
        cadApiVersion: 5,
        coordinate,
        sourceHash,
        imports: imported.map((child) => ({
          geometryVersionId: 1,
          coordinate: child.coordinate,
          moduleHash: child.moduleHash,
        })),
      })
      const module = Object.freeze({
        coordinate,
        source,
        sourceHash,
        moduleHash,
        imports: Object.freeze(imports),
      })
      modules.set(coordinate, module)
      return module
    } finally {
      visiting.delete(coordinate)
    }
  }

  const requestedRoots = rootOverrides ?? snapshot.roots
  if (requestedRoots.length > MAX_GEOMETRY_ROOTS) {
    throw new CadModelError(`Effective Geometry graph exceeds ${MAX_GEOMETRY_ROOTS} roots.`)
  }
  const aliases = new Set<string>()
  const coordinates = new Set<string>()
  requestedRoots.forEach((root) => {
    if (!root || typeof root !== 'object' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(root.alias)) {
      throw new CadModelError('Effective Geometry root alias must be an ASCII JavaScript identifier.')
    }
    assertGeometryCoordinate(root.coordinate, 'Effective Geometry root coordinate')
    ownerNamespace ??= geometryCoordinateNamespace(root.coordinate)
    if (geometryCoordinateNamespace(root.coordinate) !== ownerNamespace) {
      throw new CadModelError('Effective Geometry roots must belong to one owner namespace.')
    }
    if (aliases.has(root.alias)) throw new CadModelError(`Effective Geometry root alias is duplicated: ${root.alias}`)
    if (coordinates.has(root.coordinate)) {
      throw new CadModelError(`Effective Geometry root coordinate is duplicated: ${root.coordinate}`)
    }
    aliases.add(root.alias)
    coordinates.add(root.coordinate)
  })
  const roots: { alias: string; coordinate: GeometryCoordinate; moduleHash: string }[] = []
  for (const root of requestedRoots) {
    const module = await build(root.coordinate, [])
    roots.push(Object.freeze({ alias: root.alias, coordinate: root.coordinate, moduleHash: module.moduleHash }))
  }
  const longestDepthByCoordinate = new Map<GeometryCoordinate, number>()
  const longestDepth = (coordinate: GeometryCoordinate): number => {
    const cached = longestDepthByCoordinate.get(coordinate)
    if (cached !== undefined) return cached
    const module = modules.get(coordinate)!
    const depth = module.imports.reduce((longest, child) => Math.max(longest, 1 + longestDepth(child)), 1)
    longestDepthByCoordinate.set(coordinate, depth)
    return depth
  }
  if (requestedRoots.some((root) => longestDepth(root.coordinate) > MAX_GEOMETRY_GRAPH_DEPTH)) {
    throw new CadModelError(`Effective Geometry graph exceeds dependency depth ${MAX_GEOMETRY_GRAPH_DEPTH}.`)
  }
  const sortedModules = [...modules.values()].sort((left, right) =>
    compareCanonicalText(left.coordinate, right.coordinate),
  )
  const sortedRoots = roots.sort((left, right) => compareCanonicalText(left.alias, right.alias))
  const graphHash = await sha256(
    JSON.stringify({
      roots: sortedRoots,
      modules: sortedModules.map(({ coordinate, sourceHash, moduleHash, imports }) => ({
        coordinate,
        sourceHash,
        moduleHash,
        imports,
      })),
    }),
  )
  return Object.freeze({
    roots: Object.freeze(sortedRoots),
    modules: Object.freeze(sortedModules),
    graphHash,
  })
}
