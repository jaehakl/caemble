import { CadModelError } from '../model/errors'

export const GEOMETRY_SNAPSHOT_SCHEMA_VERSION = 2 as const
export const GEOMETRY_MODULE_FORMAT_VERSION = 4 as const
export const MAX_GEOMETRY_ENTRY_IMPORTS = 64
export const MAX_GEOMETRY_MODULES = 256
export const MAX_GEOMETRY_IMPORTS_PER_MODULE = 64
export const MAX_GEOMETRY_GRAPH_DEPTH = 64
export const MAX_GEOMETRY_MODULE_SOURCE_BYTES = 1024 * 1024
export const MAX_GEOMETRY_GRAPH_SOURCE_BYTES = 8 * 1024 * 1024
export const MAX_COMPILED_GEOMETRY_GRAPH_BYTES = 32 * 1024 * 1024
export const MAX_GEOMETRY_SEMVER_COMPONENT = 2_147_483_647

const hashPattern = /^[0-9a-f]{64}$/u
const aliasPattern = /^[A-Z][A-Za-z0-9_]*$/u
const reservedAliases = new Set(
  'Array ArrayBuffer Atomics BigInt Blob Boolean DataView Date Document Element Error Event File FinalizationRegistry Float32Array Float64Array FormData Fragment Function Headers History Image Int16Array Int32Array Int8Array Intl JSON Location Map Math Node Number Object Promise Proxy Reflect RegExp Request Response Set SharedArrayBuffer SharedWorker String Symbol Uint16Array Uint32Array Uint8Array Uint8ClampedArray URL URLSearchParams WeakMap WeakRef WeakSet WebAssembly WebSocket Worker XMLHttpRequest'.split(
    ' ',
  ),
)
const coordinatePattern =
  /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

function compareCanonicalText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

export type GeometryCoordinate = `caemble:geometry/${string}/${string}/${string}@${number}.${number}.${number}`
export type LocalGeometryCoordinate = `caemble:geometry/${string}/${string}/${string}@local`

export type GeometrySnapshotImport = Readonly<{
  exportName: string
  alias: string
  geometryVersionId: number
  coordinate: GeometryCoordinate
  moduleHash: string
}>

export type GeometrySnapshotModule = Readonly<{
  geometryVersionId: number
  coordinate: GeometryCoordinate
  moduleFormatVersion: typeof GEOMETRY_MODULE_FORMAT_VERSION
  cadApiVersion: 6
  description: string | null
  source: string
  sourceHash: string
  moduleHash: string
  imports: readonly GeometrySnapshotImport[]
}>

export type GeometrySnapshot = Readonly<{
  schemaVersion: typeof GEOMETRY_SNAPSHOT_SCHEMA_VERSION
  entryImports: readonly GeometrySnapshotImport[]
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
  return Boolean(match && match.slice(1).every((part) => Number(part) <= MAX_GEOMETRY_SEMVER_COMPONENT))
}

export function assertGeometryCoordinate(
  value: unknown,
  path = 'Geometry coordinate',
): asserts value is GeometryCoordinate {
  if (!isGeometryCoordinate(value)) {
    throw new CadModelError(`${path} must be an exact caemble:geometry coordinate with an X.Y.Z version.`)
  }
}

export function isGeometryComponentName(value: unknown): value is string {
  return typeof value === 'string' && aliasPattern.test(value) && !reservedAliases.has(value)
}

export function geometryCoordinateNamespace(coordinate: GeometryCoordinate) {
  return coordinate.split('/')[1]
}

function assertImport(value: unknown, path: string): asserts value is GeometrySnapshotImport {
  plainObject(value, path)
  onlyKeys(value, ['exportName', 'alias', 'geometryVersionId', 'coordinate', 'moduleHash'], path)
  if (!isGeometryComponentName(value.exportName)) {
    throw new CadModelError(`${path}.exportName must be a non-reserved PascalCase identifier.`)
  }
  if (!isGeometryComponentName(value.alias)) {
    throw new CadModelError(`${path}.alias must be a non-reserved PascalCase identifier.`)
  }
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
  if (value.moduleFormatVersion !== GEOMETRY_MODULE_FORMAT_VERSION || value.cadApiVersion !== 6) {
    throw new CadModelError(`${path} must use Geometry module format version 4 and CAD API version 6.`)
  }
  if (value.description !== null && typeof value.description !== 'string') {
    throw new CadModelError(`${path}.description must be text or null.`)
  }
  if (typeof value.source !== 'string' || !value.source) throw new CadModelError(`${path}.source must contain text.`)
  const encoded = new TextEncoder().encode(value.source)
  if (new TextDecoder('utf-8', { fatal: true }).decode(encoded) !== value.source) {
    throw new CadModelError(`${path}.source must contain valid UTF-8 text.`)
  }
  if (encoded.byteLength > MAX_GEOMETRY_MODULE_SOURCE_BYTES) {
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
  value.imports.forEach((item, importIndex) => assertImport(item, `${path}.imports[${importIndex}]`))
}

function assertGraph(snapshot: GeometrySnapshot) {
  const modules = new Map(snapshot.modules.map((module) => [module.coordinate, module]))
  if (modules.size !== snapshot.modules.length) throw new CadModelError('Geometry snapshot coordinates must be unique.')
  if (new Set(snapshot.modules.map((module) => module.geometryVersionId)).size !== snapshot.modules.length) {
    throw new CadModelError('Geometry snapshot module version IDs must be unique.')
  }
  if (new Set(snapshot.entryImports.map((item) => item.alias)).size !== snapshot.entryImports.length) {
    throw new CadModelError('Geometry entry import aliases must be unique.')
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
      const aliases = new Set<string>()
      module.imports.forEach((imported) => {
        if (aliases.has(imported.alias)) {
          throw new CadModelError(`Geometry module ${coordinate} uses import alias ${imported.alias} more than once.`)
        }
        aliases.add(imported.alias)
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

  snapshot.entryImports.forEach((imported) => {
    const module = modules.get(imported.coordinate)
    if (
      !module ||
      module.geometryVersionId !== imported.geometryVersionId ||
      module.moduleHash !== imported.moduleHash
    ) {
      throw new CadModelError(`Geometry entry import projection does not match ${imported.coordinate}.`)
    }
    visit(imported.coordinate, [])
  })
  const orphan = snapshot.modules.find((module) => !reachable.has(module.coordinate))
  if (orphan)
    throw new CadModelError(`Geometry snapshot module is not reachable from geometry.tsx: ${orphan.coordinate}`)

  const memo = new Map<GeometryCoordinate, number>()
  const longestDepth = (coordinate: GeometryCoordinate): number => {
    const cached = memo.get(coordinate)
    if (cached !== undefined) return cached
    const depth = modules
      .get(coordinate)!
      .imports.reduce((longest, imported) => Math.max(longest, 1 + longestDepth(imported.coordinate)), 1)
    memo.set(coordinate, depth)
    return depth
  }
  if (snapshot.entryImports.some((item) => longestDepth(item.coordinate) > MAX_GEOMETRY_GRAPH_DEPTH)) {
    throw new CadModelError(`Geometry snapshot exceeds dependency depth ${MAX_GEOMETRY_GRAPH_DEPTH}.`)
  }
}

export function assertGeometrySnapshot(value: unknown): asserts value is GeometrySnapshot {
  plainObject(value, 'Geometry snapshot')
  onlyKeys(value, ['schemaVersion', 'entryImports', 'modules'], 'Geometry snapshot')
  if (value.schemaVersion !== GEOMETRY_SNAPSHOT_SCHEMA_VERSION) {
    throw new CadModelError('Only Geometry snapshot schema version 2 is supported.')
  }
  if (!Array.isArray(value.entryImports) || !Array.isArray(value.modules)) {
    throw new CadModelError('Geometry snapshot entryImports and modules must be arrays.')
  }
  if (value.entryImports.length > MAX_GEOMETRY_ENTRY_IMPORTS) {
    throw new CadModelError(`Geometry snapshot exceeds ${MAX_GEOMETRY_ENTRY_IMPORTS} entry imports.`)
  }
  if (value.modules.length > MAX_GEOMETRY_MODULES) {
    throw new CadModelError(`Geometry snapshot exceeds ${MAX_GEOMETRY_MODULES} modules.`)
  }
  value.entryImports.forEach((item, index) => assertImport(item, `Geometry snapshot entryImports[${index}]`))
  value.modules.forEach(assertModule)
  const totalBytes = value.modules.reduce(
    (total, module) => total + new TextEncoder().encode(module.source).byteLength,
    0,
  )
  if (totalBytes > MAX_GEOMETRY_GRAPH_SOURCE_BYTES) {
    throw new CadModelError(`Geometry snapshot sources exceed ${MAX_GEOMETRY_GRAPH_SOURCE_BYTES} bytes.`)
  }
  assertGraph(value as GeometrySnapshot)
}

export function assertCanonicalGeometrySnapshot(snapshot: GeometrySnapshot) {
  assertGeometrySnapshot(snapshot)
  const entryKeys = snapshot.entryImports.map((item) => `${item.alias}\0${item.exportName}\0${item.coordinate}`)
  if ([...entryKeys].sort(compareCanonicalText).some((item, index) => item !== entryKeys[index])) {
    throw new CadModelError('Geometry entry imports must be canonically sorted.')
  }
  const coordinates = snapshot.modules.map((module) => module.coordinate)
  if ([...coordinates].sort(compareCanonicalText).some((item, index) => item !== coordinates[index])) {
    throw new CadModelError('Geometry snapshot modules must be sorted by coordinate.')
  }
  snapshot.modules.forEach((module) => {
    const keys = module.imports.map((item) => `${item.alias}\0${item.exportName}\0${item.coordinate}`)
    if ([...keys].sort(compareCanonicalText).some((item, index) => item !== keys[index])) {
      throw new CadModelError(`Geometry module imports must be canonically sorted: ${module.coordinate}`)
    }
  })
}

function canonicalImports(imports: readonly GeometrySnapshotImport[]) {
  return Object.freeze(
    [...imports]
      .sort(
        (left, right) =>
          compareCanonicalText(left.alias, right.alias) ||
          compareCanonicalText(left.exportName, right.exportName) ||
          compareCanonicalText(left.coordinate, right.coordinate),
      )
      .map((item) => Object.freeze({ ...item })),
  )
}

export function canonicalizeGeometrySnapshot(snapshot: GeometrySnapshot): GeometrySnapshot {
  assertGeometrySnapshot(snapshot)
  return Object.freeze({
    schemaVersion: GEOMETRY_SNAPSHOT_SCHEMA_VERSION,
    entryImports: canonicalImports(snapshot.entryImports),
    modules: Object.freeze(
      snapshot.modules
        .map((module) => Object.freeze({ ...module, imports: canonicalImports(module.imports) }))
        .sort((left, right) => compareCanonicalText(left.coordinate, right.coordinate)),
    ),
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
        .sort(
          (left, right) =>
            compareCanonicalText(left.alias, right.alias) ||
            compareCanonicalText(left.exportName, right.exportName) ||
            compareCanonicalText(left.coordinate, right.coordinate),
        )
        .map(({ exportName, alias, coordinate, moduleHash }) => ({ exportName, alias, coordinate, moduleHash })),
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
  entryImports: readonly GeometrySnapshotImport[],
  modules: readonly GeometrySnapshotModule[],
) {
  return canonicalizeGeometrySnapshot({
    schemaVersion: GEOMETRY_SNAPSHOT_SCHEMA_VERSION,
    entryImports: [...entryImports],
    modules: modules.map((module) => ({ ...module, imports: [...module.imports] })),
  })
}
