import type { CadScene } from './types'
import type { CadSceneGroupOptions } from './groups'
import type {
  CanonicalGeometryNodeV1,
  CanonicalGeometryRootV1,
  CanonicalGeometrySceneDraftV1,
  CanonicalGeometrySceneV1,
  CanonicalSurfaceGroupV1,
  CanonicalSurfaceSelectorV1,
} from './canonicalTypes'

const drafts = new WeakMap<CadScene, CanonicalGeometrySceneDraftV1>()
const primitiveSurfaceIndices = Object.freeze({
  box: Object.freeze([0, 1, 2, 3, 4, 5]),
  cylinder: Object.freeze([0, 1, 2]),
  sphere: Object.freeze([0]),
  curvedEdgeCylinder: Object.freeze([0, 1, 2]),
  curvedSurfaceSphere: Object.freeze([0]),
})

function sourceSurfaceIndex(
  node: CanonicalGeometryNodeV1,
  index = new Map<string, Set<number>>(),
): Map<string, Set<number>> {
  let surfaceIndices: readonly number[] | undefined
  if (node.kind === 'primitive') {
    surfaceIndices = primitiveSurfaceIndices[node.primitive]
    if (node.primitive === 'cylinder') {
      surfaceIndices = surfaceIndices.filter(
        (surfaceIndex) =>
          (surfaceIndex !== 0 || (node.parameters.radius as number) > 0) &&
          (surfaceIndex !== 2 || (node.parameters.radius_2 as number) > 0),
      )
    }
  } else if (node.kind === 'fiber') {
    surfaceIndices = [0, 1, 2]
  } else if (node.kind === 'boolean') {
    node.children.forEach((child) => sourceSurfaceIndex(child, index))
  } else if (node.kind === 'shell') {
    surfaceIndices = [0, 1]
  } else {
    sourceSurfaceIndex(node.child, index)
  }
  if (surfaceIndices) {
    const existing = index.get(node.nodeId)
    if (existing) surfaceIndices.forEach((surfaceIndex) => existing.add(surfaceIndex))
    else index.set(node.nodeId, new Set(surfaceIndices))
  }
  return index
}

function surfaceMember(memberId: string) {
  const marker = '/surface/'
  const markerIndex = memberId.lastIndexOf(marker)
  if (markerIndex <= 0 || markerIndex + marker.length === memberId.length) return undefined
  const sourceNodeId = memberId.slice(0, markerIndex)
  const rawSurfaceIndex = memberId.slice(markerIndex + marker.length)
  if (!/^(?:0|[1-9]\d*)$/u.test(rawSurfaceIndex)) return undefined
  const surfaceIndex = Number(rawSurfaceIndex)
  if (!Number.isSafeInteger(surfaceIndex)) return undefined
  return { sourceNodeId, surfaceIndex }
}

function canonicalSurfaceGroups(roots: readonly CanonicalGeometryRootV1[], options: CadSceneGroupOptions) {
  const matchesByMember = new Map<string, CanonicalSurfaceSelectorV1[]>()
  roots.forEach((root) => {
    const rootMatches = new Map<string, CanonicalSurfaceSelectorV1>()
    sourceSurfaceIndex(root.node).forEach((surfaceIndices, sourceNodeId) => {
      surfaceIndices.forEach((surfaceIndex) => {
        rootMatches.set(JSON.stringify([sourceNodeId, surfaceIndex]), { rootId: root.id, sourceNodeId, surfaceIndex })
      })
    })
    rootMatches.forEach((selector, key) => {
      const matches = matchesByMember.get(key)
      if (matches) matches.push(selector)
      else matchesByMember.set(key, [selector])
    })
  })
  return Object.entries(options.surfaceGroup ?? {}).map(([name, memberIds]) => {
    const selectors: CanonicalSurfaceSelectorV1[] = []
    const missingMemberIds: string[] = []
    memberIds.forEach((memberId) => {
      const member = surfaceMember(memberId)
      if (!member) {
        missingMemberIds.push(memberId)
        return
      }
      const matches = matchesByMember.get(JSON.stringify([member.sourceNodeId, member.surfaceIndex])) ?? []
      if (matches.length !== 1) {
        missingMemberIds.push(memberId)
        return
      }
      selectors.push(matches[0])
    })
    return {
      id: `@surface-group/${encodeURIComponent(name)}`,
      name,
      kind: 'surface' as const,
      memberIds: [...memberIds],
      selectors,
      missingMemberIds,
    }
  })
}

export function canonicalSurfaceMemberEntries(group: CanonicalSurfaceGroupV1) {
  const missing = new Set(group.missingMemberIds)
  let selectorIndex = 0
  return group.memberIds.flatMap((memberId) => {
    if (missing.has(memberId)) return []
    const selector = group.selectors[selectorIndex]
    selectorIndex += 1
    return selector ? [{ memberId, selector }] : []
  })
}

export function registerCanonicalGeometryScene(
  scene: CadScene,
  roots: readonly CanonicalGeometryRootV1[],
  options: CadSceneGroupOptions,
) {
  const draft: CanonicalGeometrySceneDraftV1 = {
    lengthUnit: scene.lengthUnit,
    roots,
    geometryGroups: scene.geometryGroups.map((group) => ({
      id: group.id,
      name: group.name,
      kind: 'geometry',
      memberIds: [...group.memberIds],
      rootIds: [...group.geometryIds],
      missingMemberIds: [...group.missingMemberIds],
    })),
    surfaceGroups: canonicalSurfaceGroups(roots, options),
  }
  drafts.set(scene, draft)
  return draft
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export async function canonicalGeometryScene(scene: CadScene): Promise<CanonicalGeometrySceneV1> {
  const draft = drafts.get(scene)!
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(draft)))
  const geometryHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return Object.freeze({ ...draft, geometryHash })
}
