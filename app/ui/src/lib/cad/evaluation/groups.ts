import type { GeometryGroupMap } from '../model/core'
import type { CadScene, CadSceneGroup, CadSceneTreeNode } from './types'

export type CadSceneGroupOptions = Readonly<{
  geometryGroup?: GeometryGroupMap
  surfaceGroup?: GeometryGroupMap
}>

function createSelectionId(kind: CadSceneGroup['kind'], name: string) {
  return `@${kind}-group/${encodeURIComponent(name)}`
}

function collectGeometryMembers(tree: CadSceneTreeNode, partIds: ReadonlySet<string>) {
  const members = new Map<string, readonly string[]>()
  const pending = [tree]
  while (pending.length > 0) {
    const node = pending.pop()!
    if (node.groupId && node.geometryIds) members.set(node.groupId, node.geometryIds)
    if (node.geometryId) members.set(node.geometryId, [node.geometryId])
    pending.push(...node.children)
  }
  partIds.forEach((id) => {
    if (!members.has(id)) members.set(id, [id])
  })
  return members
}

function resolveGeometryGroups(scene: CadScene, groups: GeometryGroupMap) {
  const partIds = new Set(scene.parts.map((part) => part.id))
  const geometryMembers = collectGeometryMembers(scene.tree, partIds)

  return Object.entries(groups).map(([name, memberIds]): CadSceneGroup => {
    const geometryIds: string[] = []
    const missingMemberIds: string[] = []
    const seenGeometryIds = new Set<string>()

    memberIds.forEach((memberId) => {
      const resolvedIds = geometryMembers.get(memberId)
      if (!resolvedIds || resolvedIds.length === 0) {
        missingMemberIds.push(memberId)
        return
      }
      resolvedIds.forEach((geometryId) => {
        if (!partIds.has(geometryId) || seenGeometryIds.has(geometryId)) return
        seenGeometryIds.add(geometryId)
        geometryIds.push(geometryId)
      })
    })

    return {
      id: createSelectionId('geometry', name),
      name,
      kind: 'geometry',
      memberIds: [...memberIds],
      geometryIds,
      surfaceIds: [],
      missingMemberIds,
    }
  })
}

function resolveSurfaceGroups(scene: CadScene, groups: GeometryGroupMap) {
  const surfaces = new Map<string, string>()
  scene.parts.forEach((part) => {
    part.surfaces.forEach((surface) => surfaces.set(surface.id, part.id))
  })

  return Object.entries(groups).map(([name, memberIds]): CadSceneGroup => {
    const geometryIds: string[] = []
    const surfaceIds: string[] = []
    const missingMemberIds: string[] = []
    const seenGeometryIds = new Set<string>()
    const seenSurfaceIds = new Set<string>()

    memberIds.forEach((memberId) => {
      const geometryId = surfaces.get(memberId)
      if (!geometryId) {
        missingMemberIds.push(memberId)
        return
      }
      if (!seenSurfaceIds.has(memberId)) {
        seenSurfaceIds.add(memberId)
        surfaceIds.push(memberId)
      }
      if (!seenGeometryIds.has(geometryId)) {
        seenGeometryIds.add(geometryId)
        geometryIds.push(geometryId)
      }
    })

    return {
      id: createSelectionId('surface', name),
      name,
      kind: 'surface',
      memberIds: [...memberIds],
      geometryIds,
      surfaceIds,
      missingMemberIds,
    }
  })
}

export function applyCadSceneGroups(scene: CadScene, options: CadSceneGroupOptions = {}): CadScene {
  const geometryGroup = options.geometryGroup ?? {}
  const surfaceGroup = options.surfaceGroup ?? {}
  return {
    ...scene,
    geometryGroups: resolveGeometryGroups(scene, geometryGroup),
    surfaceGroups: resolveSurfaceGroups(scene, surfaceGroup),
  }
}
