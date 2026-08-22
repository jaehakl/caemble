import {
  analyzeGeometrySource,
  createGeometrySnapshot,
  type GeometryModuleCoordinate,
  type GeometrySnapshot,
  type GeometrySnapshotModule,
  type LocalGeometryCoordinate,
} from '@/lib/cad'
import type { GeometryDraftVersion } from '../types'

const localCoordinatePattern =
  /^caemble:geometry\/([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@local$/u
const exactCoordinatePattern =
  /^caemble:geometry\/([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u

export function geometryCoordinateParts(coordinate: string) {
  const match = exactCoordinatePattern.exec(coordinate) ?? localCoordinatePattern.exec(coordinate)
  if (!match) throw new Error(`Geometry coordinate가 올바르지 않습니다: ${coordinate}`)
  return {
    namespace: match[1],
    repository: match[2],
    packageName: match[3],
    version: match[4] ?? '0.1.0',
  }
}

export function createLocalGeometryCoordinate(namespace: string, repository: string, packageName: string) {
  const coordinate = `caemble:geometry/${namespace}/${repository}/${packageName}@local`
  geometryCoordinateParts(coordinate)
  return coordinate as LocalGeometryCoordinate
}

export function toLocalGeometryCoordinate(coordinate: string) {
  const parts = geometryCoordinateParts(coordinate)
  return createLocalGeometryCoordinate(parts.namespace, parts.repository, parts.packageName)
}

export function isLocalGeometryCoordinate(coordinate: string): coordinate is LocalGeometryCoordinate {
  return localCoordinatePattern.test(coordinate)
}

export function geometryCoordinateNamespace(coordinate: string | null) {
  if (!coordinate) return null
  try {
    return geometryCoordinateParts(coordinate).namespace
  } catch {
    return null
  }
}

export function geometryCoordinateRepository(coordinate: string | null) {
  if (!coordinate) return null
  try {
    const parts = geometryCoordinateParts(coordinate)
    return `${parts.namespace}/${parts.repository}`
  } catch {
    return null
  }
}

export function rewriteGeometryCoordinates(source: string, replacements: Readonly<Record<string, string>>) {
  if (!Object.keys(replacements).some((coordinate) => source.includes(coordinate))) return source
  const analysis = analyzeGeometrySource(source, { allowEmpty: true, allowLocal: true })
  const ranges = new Map<string, { start: number; end: number; coordinate: string }>()
  analysis.imports.forEach((item) => {
    if (!(item.coordinate in replacements)) return
    ranges.set(`${item.specifierStart}:${item.specifierEnd}`, {
      start: item.specifierStart,
      end: item.specifierEnd,
      coordinate: item.coordinate,
    })
  })
  let result = source
  ;[...ranges.values()]
    .sort((left, right) => right.start - left.start)
    .forEach(({ start, end, coordinate }) => {
      result = `${result.slice(0, start)}${replacements[coordinate]}${result.slice(end)}`
    })
  return result
}

export function assertGeometryReplacementsApplicable(
  replacements: readonly Readonly<{ localCoordinate: string; coordinate: string }>[],
  entrySource: string,
  drafts: Readonly<Record<string, GeometryDraftVersion>>,
) {
  const byCoordinate = Object.fromEntries(replacements.map((item) => [item.localCoordinate, item.coordinate]))
  rewriteGeometryCoordinates(entrySource, byCoordinate)
  Object.values(drafts).forEach((draft) => rewriteGeometryCoordinates(draft.source, byCoordinate))
}

export function geometryPublishRequest(
  drafts: Readonly<Record<string, GeometryDraftVersion>>,
  target: GeometryModuleCoordinate,
) {
  const draft = drafts[target]
  if (!draft) throw new Error('발행할 Draft Version을 찾을 수 없습니다.')
  const selected = new Set<string>()
  const pending: string[] = [target]
  while (pending.length) {
    const coordinate = pending.pop()!
    if (selected.has(coordinate)) continue
    const current = drafts[coordinate]
    if (!current) continue
    selected.add(coordinate)
    analyzeGeometrySource(current.source, { allowLocal: true }).imports.forEach((item) => {
      if (isLocalGeometryCoordinate(item.coordinate) && drafts[item.coordinate]) pending.push(item.coordinate)
    })
  }
  return {
    targetDraftId: draft.draftId,
    drafts: Object.values(drafts)
      .filter((item) => selected.has(item.coordinate))
      .sort((left, right) => (left.draftId < right.draftId ? -1 : left.draftId > right.draftId ? 1 : 0))
      .map((item) => ({
        draftId: item.draftId,
        baseGeometryVersionId: item.baseGeometryVersionId,
        repositoryId: item.repositoryId,
        repository: item.repository,
        package: item.packageName,
        ...(item.baseGeometryVersionId === null ? { version: item.version } : { bump: item.bump }),
        description: item.description || null,
        source: item.source,
      })),
  }
}

export function currentGeometryPublishRequest(
  drafts: Readonly<Record<string, GeometryDraftVersion>>,
  request: ReturnType<typeof geometryPublishRequest>,
) {
  const target = Object.values(drafts).find((draft) => draft.draftId === request.targetDraftId)
  if (!target) throw new Error('발행할 Draft Version이 더 이상 존재하지 않습니다.')
  return geometryPublishRequest(drafts, target.coordinate)
}

export function mergeGeometryModules(...groups: readonly (readonly GeometrySnapshotModule[])[]) {
  const modules = new Map<string, GeometrySnapshotModule>()
  groups.flat().forEach((module) => modules.set(module.coordinate, module))
  return [...modules.values()]
}

export function geometrySnapshotFromEntrySource(source: string, modules: readonly GeometrySnapshotModule[]) {
  const analysis = analyzeGeometrySource(source, { allowEmpty: true })
  const byCoordinate = new Map<string, GeometrySnapshotModule>(modules.map((module) => [module.coordinate, module]))
  const reachable = new Set<string>()
  const visit = (coordinate: string) => {
    if (reachable.has(coordinate)) return
    const module = byCoordinate.get(coordinate)
    if (!module) throw new Error(`Geometry snapshot module을 찾을 수 없습니다: ${coordinate}`)
    reachable.add(coordinate)
    module.imports.forEach((item) => visit(item.coordinate))
  }
  const entryImports = analysis.imports.map((item) => {
    const module = byCoordinate.get(item.coordinate)
    if (!module) throw new Error(`Geometry import를 resolve하지 못했습니다: ${item.coordinate}`)
    visit(item.coordinate)
    return {
      exportName: item.exportName,
      alias: item.alias,
      geometryVersionId: module.geometryVersionId,
      coordinate: module.coordinate,
      moduleHash: module.moduleHash,
    }
  })
  return createGeometrySnapshot(
    entryImports,
    modules.filter((module) => reachable.has(module.coordinate)),
  ) as GeometrySnapshot
}
