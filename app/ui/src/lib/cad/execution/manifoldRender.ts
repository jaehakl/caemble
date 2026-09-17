import { tessellateContinuousPrimitive, type ContinuousPrimitive, type IndexedSurface } from '../geometry/continuous'
import { tessellateFiber } from '../geometry/fiber'
import initManifold, {
  type Manifold as ManifoldSolid,
  type ManifoldToplevel,
  type Mesh as ManifoldMesh,
  type Vec3,
} from 'manifold-3d'
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url'
import type {
  CanonicalAffineMatrixV2,
  CanonicalGeometryNodeV2,
  CanonicalGeometrySceneV2,
  CanonicalPrimitiveNodeV2,
} from '../evaluation/canonicalTypes'
import type { CadScene, CadSceneSurface, CadSceneTreeNode } from '../evaluation/types'
import { canonicalSurfaceMemberEntries } from '../evaluation/canonical'
import { cadSceneHash, type SerializableCadScene, type SerializableCadScenePart } from './meshSerialization'

type Triangle = readonly [number, number, number]
type SourceSurfaces = Readonly<{ nodeId: string; surfaceIndices: ReadonlyMap<number, number> }>
type SurfaceClassifier = (mesh: ManifoldMesh, triangle: number) => number

let manifoldModulePromise: Promise<ManifoldToplevel> | undefined

function meshPointKey(point: ArrayLike<number>) {
  return `${Math.fround(point[0])},${Math.fround(point[1])},${Math.fround(point[2])}`
}

function solidBoundsCenter(solid: ManifoldSolid): Vec3 {
  const bounds = solid.boundingBox()
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ]
}

async function manifoldModule() {
  const testWasmUrl = new URL('../../../../node_modules/manifold-3d/manifold.wasm', import.meta.url)
  const testWasmPath = decodeURIComponent(testWasmUrl.pathname).replace(/^\/([A-Za-z]:\/)/u, '$1')
  manifoldModulePromise ??= initManifold({
    locateFile: () => (import.meta.env.MODE === 'test' ? testWasmPath : manifoldWasmUrl),
  }).then((module) => {
    module.setup()
    return module
  })
  return manifoldModulePromise
}

function triangleNormal(mesh: ManifoldMesh, triangle: number): Vec3 {
  const indices = mesh.triVerts.subarray(triangle * 3, triangle * 3 + 3)
  const first = mesh.position(indices[0])
  const second = mesh.position(indices[1])
  const third = mesh.position(indices[2])
  const ab = [second[0] - first[0], second[1] - first[1], second[2] - first[2]]
  const ac = [third[0] - first[0], third[1] - first[1], third[2] - first[2]]
  const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
  const length = Math.hypot(...cross)
  return [cross[0] / length, cross[1] / length, cross[2] / length]
}

function registerPrimitiveSource(
  solid: ManifoldSolid,
  nodeId: string,
  sources: Map<number, SourceSurfaces>,
  surfaceIndex: (mesh: ManifoldMesh, triangle: number, normal: Vec3) => number,
) {
  let original: ManifoldSolid
  try {
    original = solid.asOriginal()
  } finally {
    solid.delete()
  }
  try {
    const mesh = original.getMesh()
    const surfaceIndices = new Map<number, number>()
    for (let triangle = 0; triangle < mesh.numTri; triangle += 1) {
      const faceId = mesh.faceID[triangle]
      const index = surfaceIndex(mesh, triangle, triangleNormal(mesh, triangle))
      surfaceIndices.set(faceId, index)
    }
    sources.set(original.originalID(), { nodeId, surfaceIndices })
    return original
  } catch (error) {
    original.delete()
    throw error
  }
}

function manifoldFromTriangles(
  module: ManifoldToplevel,
  points: readonly Vec3[],
  triangles: readonly Triangle[],
  surfaceIndices: readonly number[],
  nodeId: string,
  sources: Map<number, SourceSurfaces>,
  classifySurface: SurfaceClassifier,
  origin: Vec3 = [0, 0, 0],
) {
  const localPoints = points.map((point): Vec3 => [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]])
  const keyIds = new Map<number, number>()
  const faceID = Uint32Array.from(
    surfaceIndices.map((key) => {
      const existing = keyIds.get(key)
      if (existing !== undefined) return existing
      const id = keyIds.size + 1
      keyIds.set(key, id)
      return id
    }),
  )
  const mesh = new module.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(localPoints.flat()),
    triVerts: Uint32Array.from(triangles.flat()),
    faceID,
  })
  const input = new module.Manifold(mesh)
  let solid: ManifoldSolid
  try {
    solid = input.asOriginal()
  } finally {
    input.delete()
  }
  try {
    const originalMesh = solid.getMesh()
    const classifiedSurfaceIndices = new Map<number, number>()
    for (let triangle = 0; triangle < originalMesh.numTri; triangle += 1) {
      const faceId = originalMesh.faceID[triangle]
      const surfaceIndex = classifySurface(originalMesh, triangle)
      classifiedSurfaceIndices.set(faceId, surfaceIndex)
    }
    sources.set(solid.originalID(), {
      nodeId,
      surfaceIndices: classifiedSurfaceIndices,
    })
    if (origin.every((value) => value === 0)) return solid
    const translated = solid.translate(origin)
    solid.delete()
    return translated
  } catch (error) {
    solid.delete()
    throw error
  }
}

function ringSolid(
  module: ManifoldToplevel,
  rings: readonly (readonly Vec3[])[],
  nodeId: string,
  sources: Map<number, SourceSurfaces>,
  capIndices: readonly [number, number],
  capCenters: readonly [Vec3, Vec3],
) {
  const radialSegments = rings[0].length
  const points: Vec3[] = rings.flat()
  const firstCenter = points.push(capCenters[0]) - 1
  const lastCenter = points.push(capCenters[1]) - 1
  const triangles: Triangle[] = []
  const surfaceIndices: number[] = []
  for (let radial = 0; radial < radialSegments; radial += 1) {
    const next = (radial + 1) % radialSegments
    triangles.push([firstCenter, next, radial])
    surfaceIndices.push(capIndices[0])
    const endStart = (rings.length - 1) * radialSegments
    triangles.push([lastCenter, endStart + radial, endStart + next])
    surfaceIndices.push(capIndices[1])
  }
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    const start = ring * radialSegments
    const nextStart = start + radialSegments
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const next = (radial + 1) % radialSegments
      triangles.push([start + radial, start + next, nextStart + next])
      triangles.push([start + radial, nextStart + next, nextStart + radial])
      surfaceIndices.push(1, 1)
    }
  }
  const origin = capCenters[0]
  const localPointKey = (point: Vec3) =>
    meshPointKey([point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]])
  const firstRing = new Set(rings[0].map(localPointKey))
  const lastRing = new Set(rings[rings.length - 1].map(localPointKey))
  firstRing.add(localPointKey(capCenters[0]))
  lastRing.add(localPointKey(capCenters[1]))
  const onRing = (mesh: ManifoldMesh, triangle: number, ring: ReadonlySet<string>) =>
    [...mesh.verts(triangle)].every((vertex) => ring.has(meshPointKey(mesh.position(vertex))))
  return manifoldFromTriangles(
    module,
    points,
    triangles,
    surfaceIndices,
    nodeId,
    sources,
    (mesh, triangle) =>
      onRing(mesh, triangle, firstRing) ? capIndices[0] : onRing(mesh, triangle, lastRing) ? capIndices[1] : 1,
    origin,
  )
}

function curvedEdgeCylinder(
  module: ManifoldToplevel,
  node: CanonicalPrimitiveNodeV2,
  sources: Map<number, SourceSurfaces>,
) {
  const parameters = node.parameters as Readonly<{
    height: number
    azimuthalCurve: readonly Readonly<{ amplitude: number; phase: number }>[]
    verticalCurve: Readonly<{ origin: number; coefficients: readonly number[] }>
    azimuthalSegments: number
    verticalSegments: number
  }>
  const rings = Array.from({ length: parameters.verticalSegments + 1 }, (_, verticalIndex) => {
    const z = -parameters.height / 2 + (parameters.height * verticalIndex) / parameters.verticalSegments
    const offset = z - parameters.verticalCurve.origin
    let verticalRadius = 0
    for (let order = parameters.verticalCurve.coefficients.length - 1; order >= 0; order -= 1) {
      verticalRadius = verticalRadius * offset + parameters.verticalCurve.coefficients[order]
    }
    return Array.from({ length: parameters.azimuthalSegments }, (_, azimuthalIndex): Vec3 => {
      const theta = (Math.PI * 2 * azimuthalIndex) / parameters.azimuthalSegments
      const azimuthalRadius = parameters.azimuthalCurve.reduce(
        (radius, mode, index) => radius + mode.amplitude * Math.cos(index * theta + mode.phase),
        0,
      )
      const radius = azimuthalRadius * verticalRadius
      return [radius * Math.cos(theta), radius * Math.sin(theta), z]
    })
  })
  return ringSolid(
    module,
    rings,
    node.nodeId,
    sources,
    [0, 2],
    [
      [0, 0, -parameters.height / 2],
      [0, 0, parameters.height / 2],
    ],
  )
}

function primitiveSolid(module: ManifoldToplevel, node: CanonicalPrimitiveNodeV2, sources: Map<number, SourceSurfaces>) {
  node = { ...node, parameters: { ...node.parameters, ...node.tessellation } }
  if (node.primitive === 'box') {
    const solid = module.Manifold.cube(node.parameters.size as Vec3, true)
    return registerPrimitiveSource(solid, node.nodeId, sources, (_mesh, _triangle, normal) => {
      const axis = Math.abs(normal[0]) > 0.5 ? 0 : Math.abs(normal[1]) > 0.5 ? 1 : 2
      return axis * 2 + (normal[axis] < 0 ? 0 : 1)
    })
  }
  if (node.primitive === 'cylinder') {
    const { radius, radius_2, height, segments } = node.parameters as Readonly<Record<string, number>>
    let solid: ManifoldSolid
    if (radius === 0) {
      const inverted = module.Manifold.cylinder(height, radius_2, 0, segments, true)
      try {
        solid = inverted.scale([1, 1, -1])
      } finally {
        inverted.delete()
      }
    } else {
      solid = module.Manifold.cylinder(height, radius, radius_2, segments, true)
    }
    const tolerance = Math.min(Math.max(Math.abs(height) * 1e-10, 1e-12), Math.abs(height) / 4)
    return registerPrimitiveSource(solid, node.nodeId, sources, (mesh, triangle) => {
      const z = [...mesh.verts(triangle)].map((vertex) => mesh.position(vertex)[2])
      return z.every((value) => Math.abs(value + height / 2) <= tolerance)
        ? 0
        : z.every((value) => Math.abs(value - height / 2) <= tolerance)
          ? 2
          : 1
    })
  }
  if (node.primitive === 'sphere') {
    const { radius, segments } = node.parameters as Readonly<Record<string, number>>
    return registerPrimitiveSource(module.Manifold.sphere(radius, segments), node.nodeId, sources, () => 0)
  }
  if (node.primitive === 'curvedEdgeCylinder') return curvedEdgeCylinder(module, node, sources)
  if (['asphericCylinder','ellipsoid','hyperboloid','paraboloid'].includes(node.primitive)) return indexedSolid(module, tessellateContinuousPrimitive(node.primitive as ContinuousPrimitive, node.parameters, node.tessellation), node.nodeId, sources)
  throw new Error(`Unsupported primitive: ${node.primitive}`)
}

function indexedSolid(module: ManifoldToplevel, mesh: IndexedSurface, nodeId: string, sources: Map<number, SourceSurfaces>) {
  const originalID = module.Manifold.reserveIDs(1)
  const origin = mesh.points[0]
  const solid = new module.Manifold(new module.Mesh({ numProp: 3,
    vertProperties: Float32Array.from(mesh.points.flatMap(point => point.map((value,axis) => value-origin[axis]))), triVerts: Uint32Array.from(mesh.triangles.flat()),
    faceID: Uint32Array.from(mesh.surfaceIndices), runOriginalID: Uint32Array.of(originalID), runIndex: Uint32Array.of(0, mesh.triangles.length * 3),
  }))
  sources.set(originalID, { nodeId, surfaceIndices: new Map(mesh.surfaceIndices.map(index => [index, index])) })
  try { return solid.translate(origin) } finally { solid.delete() }
}

function columnMajor(matrix: CanonicalAffineMatrixV2) {
  return [
    matrix[0],
    matrix[4],
    matrix[8],
    matrix[12],
    matrix[1],
    matrix[5],
    matrix[9],
    matrix[13],
    matrix[2],
    matrix[6],
    matrix[10],
    matrix[14],
    matrix[3],
    matrix[7],
    matrix[11],
    matrix[15],
  ] as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
}

function evaluateNode(
  module: ManifoldToplevel,
  node: CanonicalGeometryNodeV2,
  sources: Map<number, SourceSurfaces>,
): ManifoldSolid {
  if (node.kind === 'primitive') return primitiveSolid(module, node, sources)
  if (node.kind === 'fiber') return indexedSolid(module, tessellateFiber(node, node.tessellation), node.nodeId, sources)
  if (node.kind === 'transform' || node.kind === 'instance') {
    const child = evaluateNode(module, node.child, sources)
    try {
      return child.transform(columnMajor(node.matrix))
    } finally {
      child.delete()
    }
  }
  if (node.kind !== 'boolean') throw new Error('Unsupported canonical Geometry node; rebuild with current inputs.')
  const children: ManifoldSolid[] = []
  try {
    node.children.forEach((child) => children.push(evaluateNode(module, child, sources)))
    return node.operation === 'union'
      ? module.Manifold.union(children)
      : node.operation === 'subtract'
        ? module.Manifold.difference(children)
        : module.Manifold.intersection(children)
  } finally {
    children.forEach((child) => child.delete())
  }
}

function meshPart(
  module: ManifoldToplevel,
  root: CanonicalGeometrySceneV2['roots'][number],
  runtimeScene: Readonly<{tree: CadScene['tree']; parts: readonly Pick<CadScene['parts'][number], 'id' | 'material'>[]}>,
  sources: Map<number, SourceSurfaces>,
): SerializableCadScenePart {
  const solid = evaluateNode(module, root.node, sources)
  try {
    const center = solidBoundsCenter(solid)
    const centered = solid.translate([-center[0], -center[1], -center[2]])
    try {
      const mesh = centered.getMesh()
      const positions = new Float64Array(mesh.numTri * 9)
      const polygonOffsets = Uint32Array.from({ length: mesh.numTri + 1 }, (_, index) => index * 3)
      const surfacePolygons = new Map<string, { sourceNodeId: string; surfaceIndex: number; polygonIndices: number[] }>()
      let run = 0
      for (let triangle = 0; triangle < mesh.numTri; triangle += 1) {
        while (run + 1 < mesh.runIndex.length && triangle * 3 >= mesh.runIndex[run + 1]) run += 1
        const source = sources.get(mesh.runOriginalID[run])
        const surfaceIndex = source?.surfaceIndices.get(mesh.faceID[triangle])
        if (source && surfaceIndex !== undefined) {
          const id = `${source.nodeId}/surface/${surfaceIndex}`
          const surface = surfacePolygons.get(id) ?? { sourceNodeId: source.nodeId, surfaceIndex, polygonIndices: [] }
          surface.polygonIndices.push(triangle)
          surfacePolygons.set(id, surface)
        }
        const vertices = mesh.verts(triangle)
        vertices.forEach((vertex, corner) => {
          const point = mesh.position(vertex)
          positions[triangle * 9 + corner * 3] = point[0] + center[0]
          positions[triangle * 9 + corner * 3 + 1] = point[1] + center[1]
          positions[triangle * 9 + corner * 3 + 2] = point[2] + center[2]
        })
      }
      const surfaces: CadSceneSurface[] = [...surfacePolygons].map(([id, surface]) => ({
        id,
        surfaceIndex: surface.surfaceIndex,
        label: `Surface ${surface.surfaceIndex}`,
        polygonIndices: Uint32Array.from(surface.polygonIndices),
      }))
      const runtimePart = runtimeScene.parts.find((part) => part.id === root.id)
      return {
        id: root.id,
        geometry: { kind: 'mesh', positions, polygonOffsets },
        materialRole: root.materialRole,
        ...(runtimePart?.material === undefined ? {} : { material: runtimePart.material }),
        surfaces,
      }
    } finally {
      centered.delete()
    }
  } finally {
    solid.delete()
  }
}

function semanticTree(tree: CadSceneTreeNode, parts: readonly SerializableCadScenePart[]) {
  const byGlobalId = new Map<string, CadSceneTreeNode>()
  const clone = (node: CadSceneTreeNode): CadSceneTreeNode => {
    const cloned = { ...node, children: node.children.filter((child) => !child.surfaceId).map(clone) }
    if (cloned.globalId) byGlobalId.set(cloned.globalId, cloned)
    return cloned
  }
  const result = clone(tree)
  parts.forEach((part) => {
    part.surfaces.forEach((surface) => {
      const marker = '/surface/'
      const markerIndex = surface.id.lastIndexOf(marker)
      const sourceNodeId = markerIndex < 0 ? part.id : surface.id.slice(0, markerIndex)
      const owner = byGlobalId.get(sourceNodeId) ?? byGlobalId.get(part.id)
      if (!owner || owner.children.some((child) => child.surfaceId === surface.id)) return
      owner.children.push({
        key: `${owner.key}/${surface.id}`,
        label: `${surface.surfaceIndex} · ${surface.label}`,
        surfaceId: surface.id,
        children: [],
      })
    })
  })
  return result
}

export async function renderCanonicalGeometryScene(
  scene: CanonicalGeometrySceneV2,
  runtimeScene: Readonly<{tree: CadScene['tree']; parts: readonly Pick<CadScene['parts'][number], 'id' | 'material'>[]}>,
): Promise<SerializableCadScene> {
  if (scene.version !== 2) throw new Error('Canonical Geometry v2 is required; migrate source and rebuild previous artifacts.')
  const module = await manifoldModule()
  const sources = new Map<number, SourceSurfaces>()
  const surfaceAliases = new Map<string, Map<string, Set<string>>>()
  scene.surfaceGroups.flatMap(canonicalSurfaceMemberEntries).forEach(({ memberId, selector }) => {
    const sourceId = `${selector.sourceNodeId}/surface/${selector.surfaceIndex}`
    const rootAliases = surfaceAliases.get(selector.rootId) ?? new Map<string, Set<string>>()
    const aliases = rootAliases.get(sourceId) ?? new Set<string>()
    aliases.add(memberId)
    rootAliases.set(sourceId, aliases)
    surfaceAliases.set(selector.rootId, rootAliases)
  })
  const parts: SerializableCadScenePart[] = []
  for (const root of scene.roots) {
    const part = meshPart(module, root, runtimeScene, sources)
    parts.push({
      ...part,
      surfaces: part.surfaces.flatMap((surface) => {
        const aliases = surfaceAliases.get(root.id)?.get(surface.id)
        return aliases ? [...aliases].map((id) => ({ ...surface, id })) : [surface]
      }),
    })
  }
  const geometryGroups = scene.geometryGroups.map((group) => ({
    id: group.id,
    name: group.name,
    kind: 'geometry' as const,
    memberIds: [...group.memberIds],
    geometryIds: [...group.rootIds],
    surfaceIds: [],
    missingMemberIds: [...group.missingMemberIds],
  }))
  const surfaceGroups = scene.surfaceGroups.map((group) => {
    const entries = canonicalSurfaceMemberEntries(group)
    return {
      id: group.id,
      name: group.name,
      kind: 'surface' as const,
      memberIds: [...group.memberIds],
      geometryIds: [...new Set(group.selectors.map((selector) => selector.rootId))],
      surfaceIds: entries.map((entry) => entry.memberId),
      missingMemberIds: [...group.missingMemberIds],
    }
  })
  const renderScene = {
    lengthUnit: scene.lengthUnit,
    parts,
    tree: semanticTree(runtimeScene.tree, parts),
    geometryGroups,
    surfaceGroups,
  }
  return Object.freeze({ ...renderScene, sceneHash: cadSceneHash(renderScene) })
}
