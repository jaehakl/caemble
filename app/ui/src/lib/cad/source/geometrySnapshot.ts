import { CadModelError } from '../model/errors'

export const GEOMETRY_SNAPSHOT_SCHEMA_VERSION = 1 as const
export const GEOMETRY_MODULE_FORMAT_VERSION = 1 as const
export const MAX_GEOMETRY_ROOTS = 64
export const MAX_GEOMETRY_MODULES = 256
export const MAX_GEOMETRY_IMPORTS_PER_MODULE = 64
export const MAX_GEOMETRY_GRAPH_DEPTH = 64
export const MAX_GEOMETRY_MODULE_SOURCE_BYTES = 1024 * 1024
export const MAX_GEOMETRY_GRAPH_SOURCE_BYTES = 8 * 1024 * 1024
export const MAX_COMPILED_GEOMETRY_GRAPH_BYTES = 32 * 1024 * 1024
export const MAX_GEOMETRY_SEMVER_COMPONENT = 2_147_483_647

const hashPattern = /^[0-9a-f]{64}$/u
const aliasPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u
const coordinatePattern =
  /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

export type GeometryCoordinate = `caemble:geometry/${string}/${string}/${string}@${number}.${number}.${number}`

export type GeometrySnapshotImport = Readonly<{
  geometryVersionId: number
  coordinate: GeometryCoordinate
  moduleHash: string
}>

export type GeometrySnapshotModule = Readonly<{
  geometryVersionId: number
  coordinate: GeometryCoordinate
  moduleFormatVersion: typeof GEOMETRY_MODULE_FORMAT_VERSION
  cadApiVersion: 5
  description: string | null
  source: string
  sourceHash: string
  moduleHash: string
  imports: readonly GeometrySnapshotImport[]
}>

export type GeometrySnapshotRoot = Readonly<{
  alias: string
  geometryVersionId: number
  coordinate: GeometryCoordinate
  moduleHash: string
}>

export type GeometrySnapshot = Readonly<{
  schemaVersion: typeof GEOMETRY_SNAPSHOT_SCHEMA_VERSION
  roots: readonly GeometrySnapshotRoot[]
  modules: readonly GeometrySnapshotModule[]
}>

function plainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CadModelError(`${path} must be a plain object.`)
  }
}

function onlyKeys(value: object, allowed: readonly string[], path: string) {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknownKey) throw new CadModelError(`${path}.${unknownKey} is not allowed.`)
}

function assertVersionId(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CadModelError(`${path} must be a positive integer.`)
  }
}

export function isGeometryCoordinate(value: unknown): value is GeometryCoordinate {
  if (typeof value !== 'string') return false
  const match = coordinatePattern.exec(value)
  return Boolean(match && match.slice(1).every((component) => Number(component) <= MAX_GEOMETRY_SEMVER_COMPONENT))
}

export function assertGeometryCoordinate(
  value: unknown,
  path = 'Geometry coordinate',
): asserts value is GeometryCoordinate {
  if (!isGeometryCoordinate(value)) {
    throw new CadModelError(`${path} must be an exact caemble:geometry coordinate with an X.Y.Z version.`)
  }
}

export function geometryCoordinateNamespace(coordinate: GeometryCoordinate) {
  return coordinate.split('/')[1]
}

function sourceBytes(source: string) {
  return new TextEncoder().encode(source).byteLength
}

function assertRoot(value: unknown, index: number): asserts value is GeometrySnapshotRoot {
  const path = `Geometry snapshot roots[${index}]`
  plainObject(value, path)
  onlyKeys(value, ['alias', 'geometryVersionId', 'coordinate', 'moduleHash'], path)
  if (typeof value.alias !== 'string' || !aliasPattern.test(value.alias)) {
    throw new CadModelError(`${path}.alias must be an ASCII JavaScript identifier.`)
  }
  assertVersionId(value.geometryVersionId, `${path}.geometryVersionId`)
  assertGeometryCoordinate(value.coordinate, `${path}.coordinate`)
  if (typeof value.moduleHash !== 'string' || !hashPattern.test(value.moduleHash)) {
    throw new CadModelError(`${path}.moduleHash must be a lowercase SHA-256 hash.`)
  }
}

function assertImport(
  value: unknown,
  moduleIndex: number,
  importIndex: number,
): asserts value is GeometrySnapshotImport {
  const path = `Geometry snapshot modules[${moduleIndex}].imports[${importIndex}]`
  plainObject(value, path)
  onlyKeys(value, ['geometryVersionId', 'coordinate', 'moduleHash'], path)
  assertVersionId(value.geometryVersionId, `${path}.geometryVersionId`)
  assertGeometryCoordinate(value.coordinate, `${path}.coordinate`)
  if (typeof value.moduleHash !== 'string' || !hashPattern.test(value.moduleHash)) {
    throw new CadModelError(`${path}.moduleHash must be a lowercase SHA-256 hash.`)
  }
}

function assertModule(value: unknown, index: number): asserts value is GeometrySnapshotModule {
  const path = `Geometry snapshot modules[${index}]`
  plainObject(value, path)
  onlyKeys(
    value,
    [
      'geometryVersionId',
      'coordinate',
      'moduleFormatVersion',
      'cadApiVersion',
      'description',
      'source',
      'sourceHash',
      'moduleHash',
      'imports',
    ],
    path,
  )
  assertVersionId(value.geometryVersionId, `${path}.geometryVersionId`)
  assertGeometryCoordinate(value.coordinate, `${path}.coordinate`)
  if (value.moduleFormatVersion !== GEOMETRY_MODULE_FORMAT_VERSION || value.cadApiVersion !== 5) {
    throw new CadModelError(`${path} must use Geometry module format version 1 and CAD API version 5.`)
  }
  if (value.description !== null && typeof value.description !== 'string') {
    throw new CadModelError(`${path}.description must be text or null.`)
  }
  if (typeof value.source !== 'string' || !value.source) throw new CadModelError(`${path}.source must contain text.`)
  const encodedSource = new TextEncoder().encode(value.source)
  if (new TextDecoder('utf-8', { fatal: true }).decode(encodedSource) !== value.source) {
    throw new CadModelError(`${path}.source must contain valid UTF-8 text.`)
  }
  if (encodedSource.byteLength > MAX_GEOMETRY_MODULE_SOURCE_BYTES) {
    throw new CadModelError(`${path}.source exceeds ${MAX_GEOMETRY_MODULE_SOURCE_BYTES} bytes.`)
  }
  if (typeof value.sourceHash !== 'string' || !hashPattern.test(value.sourceHash)) {
    throw new CadModelError(`${path}.sourceHash must be a lowercase SHA-256 hash.`)
  }
  if (typeof value.moduleHash !== 'string' || !hashPattern.test(value.moduleHash)) {
    throw new CadModelError(`${path}.moduleHash must be a lowercase SHA-256 hash.`)
  }
  if (!Array.isArray(value.imports)) throw new CadModelError(`${path}.imports must be an array.`)
  if (value.imports.length > MAX_GEOMETRY_IMPORTS_PER_MODULE) {
    throw new CadModelError(`${path}.imports exceeds ${MAX_GEOMETRY_IMPORTS_PER_MODULE} entries.`)
  }
  value.imports.forEach((item, importIndex) => assertImport(item, index, importIndex))
}

function assertGraph(snapshot: GeometrySnapshot) {
  const modules = new Map(snapshot.modules.map((module) => [module.coordinate, module]))
  if (modules.size !== snapshot.modules.length) throw new CadModelError('Geometry snapshot coordinates must be unique.')
  if (new Set(snapshot.modules.map((module) => module.geometryVersionId)).size !== snapshot.modules.length) {
    throw new CadModelError('Geometry snapshot module version IDs must be unique.')
  }
  if (new Set(snapshot.roots.map((root) => root.alias)).size !== snapshot.roots.length) {
    throw new CadModelError('Geometry snapshot root aliases must be unique.')
  }
  if (new Set(snapshot.roots.map((root) => root.coordinate)).size !== snapshot.roots.length) {
    throw new CadModelError('Geometry snapshot root coordinates must be unique.')
  }
  if (new Set(snapshot.modules.map((module) => geometryCoordinateNamespace(module.coordinate))).size > 1) {
    throw new CadModelError('Geometry snapshot modules must belong to one owner namespace.')
  }

  const reachable = new Set<GeometryCoordinate>()
  const visiting = new Set<GeometryCoordinate>()
  const visit = (coordinate: GeometryCoordinate, chain: readonly string[]) => {
    if (visiting.has(coordinate)) {
      throw new CadModelError(`Geometry snapshot contains a dependency cycle: ${[...chain, coordinate].join(' -> ')}`)
    }
    if (reachable.has(coordinate)) return
    const module = modules.get(coordinate)
    if (!module) throw new CadModelError(`Geometry snapshot dependency is unresolved: ${coordinate}`)
    visiting.add(coordinate)
    try {
      const seenImports = new Set<string>()
      module.imports.forEach((imported) => {
        if (seenImports.has(imported.coordinate)) {
          throw new CadModelError(`Geometry module ${coordinate} imports ${imported.coordinate} more than once.`)
        }
        seenImports.add(imported.coordinate)
        const target = modules.get(imported.coordinate)
        if (
          !target ||
          target.geometryVersionId !== imported.geometryVersionId ||
          target.moduleHash !== imported.moduleHash
        ) {
          throw new CadModelError(
            `Geometry module ${coordinate} import projection does not match ${imported.coordinate}.`,
          )
        }
        visit(imported.coordinate, [...chain, coordinate])
      })
      reachable.add(coordinate)
    } finally {
      visiting.delete(coordinate)
    }
  }

  snapshot.roots.forEach((root) => {
    const module = modules.get(root.coordinate)
    if (!module || module.geometryVersionId !== root.geometryVersionId || module.moduleHash !== root.moduleHash) {
      throw new CadModelError(`Geometry snapshot root projection does not match ${root.coordinate}.`)
    }
    visit(root.coordinate, [])
  })
  const orphan = snapshot.modules.find((module) => !reachable.has(module.coordinate))
  if (orphan) throw new CadModelError(`Geometry snapshot module is not reachable from a root: ${orphan.coordinate}`)

  const longestDepthByCoordinate = new Map<GeometryCoordinate, number>()
  const longestDepth = (coordinate: GeometryCoordinate): number => {
    const cached = longestDepthByCoordinate.get(coordinate)
    if (cached !== undefined) return cached
    const module = modules.get(coordinate)!
    const depth = module.imports.reduce(
      (longest, imported) => Math.max(longest, 1 + longestDepth(imported.coordinate)),
      1,
    )
    longestDepthByCoordinate.set(coordinate, depth)
    return depth
  }
  if (snapshot.roots.some((root) => longestDepth(root.coordinate) > MAX_GEOMETRY_GRAPH_DEPTH)) {
    throw new CadModelError(`Geometry snapshot exceeds dependency depth ${MAX_GEOMETRY_GRAPH_DEPTH}.`)
  }
}

export function assertGeometrySnapshot(value: unknown): asserts value is GeometrySnapshot {
  plainObject(value, 'Geometry snapshot')
  onlyKeys(value, ['schemaVersion', 'roots', 'modules'], 'Geometry snapshot')
  if (value.schemaVersion !== GEOMETRY_SNAPSHOT_SCHEMA_VERSION) {
    throw new CadModelError('Only Geometry snapshot schema version 1 is supported.')
  }
  if (!Array.isArray(value.roots) || !Array.isArray(value.modules)) {
    throw new CadModelError('Geometry snapshot roots and modules must be arrays.')
  }
  if (value.roots.length > MAX_GEOMETRY_ROOTS) {
    throw new CadModelError(`Geometry snapshot exceeds ${MAX_GEOMETRY_ROOTS} roots.`)
  }
  if (value.modules.length > MAX_GEOMETRY_MODULES) {
    throw new CadModelError(`Geometry snapshot exceeds ${MAX_GEOMETRY_MODULES} modules.`)
  }
  value.roots.forEach(assertRoot)
  value.modules.forEach(assertModule)
  const totalBytes = value.modules.reduce((total, module) => total + sourceBytes(module.source), 0)
  if (totalBytes > MAX_GEOMETRY_GRAPH_SOURCE_BYTES) {
    throw new CadModelError(`Geometry snapshot sources exceed ${MAX_GEOMETRY_GRAPH_SOURCE_BYTES} bytes.`)
  }
  assertGraph(value as GeometrySnapshot)
}

export function assertCanonicalGeometrySnapshot(snapshot: GeometrySnapshot) {
  assertGeometrySnapshot(snapshot)
  const aliases = snapshot.roots.map((root) => root.alias)
  const coordinates = snapshot.modules.map((module) => module.coordinate)
  if ([...aliases].sort(compareCanonicalText).some((alias, index) => alias !== aliases[index])) {
    throw new CadModelError('Geometry snapshot roots must be sorted by alias.')
  }
  if ([...coordinates].sort(compareCanonicalText).some((coordinate, index) => coordinate !== coordinates[index])) {
    throw new CadModelError('Geometry snapshot modules must be sorted by coordinate.')
  }
  snapshot.modules.forEach((module) => {
    const imports = module.imports.map((item) => item.coordinate)
    if ([...imports].sort(compareCanonicalText).some((coordinate, index) => coordinate !== imports[index])) {
      throw new CadModelError(`Geometry module imports must be sorted by coordinate: ${module.coordinate}`)
    }
  })
}

export function canonicalizeGeometrySnapshot(snapshot: GeometrySnapshot): GeometrySnapshot {
  assertGeometrySnapshot(snapshot)
  const modules = snapshot.modules
    .map((module) =>
      Object.freeze({
        geometryVersionId: module.geometryVersionId,
        coordinate: module.coordinate,
        moduleFormatVersion: module.moduleFormatVersion,
        cadApiVersion: module.cadApiVersion,
        description: module.description,
        source: module.source,
        sourceHash: module.sourceHash,
        moduleHash: module.moduleHash,
        imports: Object.freeze(
          [...module.imports]
            .sort((left, right) => compareCanonicalText(left.coordinate, right.coordinate))
            .map((item) => Object.freeze({ ...item })),
        ),
      }),
    )
    .sort((left, right) => compareCanonicalText(left.coordinate, right.coordinate))
  const roots = snapshot.roots
    .map((root) => Object.freeze({ ...root }))
    .sort((left, right) => compareCanonicalText(left.alias, right.alias))
  return Object.freeze({
    schemaVersion: GEOMETRY_SNAPSHOT_SCHEMA_VERSION,
    roots: Object.freeze(roots),
    modules: Object.freeze(modules),
  })
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function geometrySourceHash(source: string) {
  const encoded = new TextEncoder().encode(source)
  if (new TextDecoder('utf-8', { fatal: true }).decode(encoded) !== source) {
    throw new CadModelError('Geometry source hash input must contain valid UTF-8 text.')
  }
  return crypto.subtle
    .digest('SHA-256', encoded)
    .then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''))
}

export function geometryModuleHash(
  module: Pick<
    GeometrySnapshotModule,
    'cadApiVersion' | 'coordinate' | 'imports' | 'moduleFormatVersion' | 'sourceHash'
  >,
) {
  return sha256(
    JSON.stringify({
      schemaVersion: GEOMETRY_SNAPSHOT_SCHEMA_VERSION,
      moduleFormatVersion: module.moduleFormatVersion,
      cadApiVersion: module.cadApiVersion,
      coordinate: module.coordinate,
      sourceHash: module.sourceHash,
      imports: [...module.imports]
        .sort((left, right) => compareCanonicalText(left.coordinate, right.coordinate))
        .map(({ coordinate, moduleHash }) => ({ coordinate, moduleHash })),
    }),
  )
}

export async function validateGeometrySnapshotHashes(snapshot: GeometrySnapshot) {
  assertGeometrySnapshot(snapshot)
  for (const module of snapshot.modules) {
    if ((await geometrySourceHash(module.source)) !== module.sourceHash) {
      throw new CadModelError(`Geometry module sourceHash does not match its source: ${module.coordinate}`)
    }
    if ((await geometryModuleHash(module)) !== module.moduleHash) {
      throw new CadModelError(`Geometry module moduleHash does not match its source and imports: ${module.coordinate}`)
    }
  }
}

export function createGeometrySnapshot(
  roots: readonly GeometrySnapshotRoot[],
  modules: readonly GeometrySnapshotModule[],
) {
  return canonicalizeGeometrySnapshot({
    schemaVersion: GEOMETRY_SNAPSHOT_SCHEMA_VERSION,
    roots: [...roots],
    modules: modules.map((module) => ({ ...module, imports: [...module.imports] })),
  })
}
