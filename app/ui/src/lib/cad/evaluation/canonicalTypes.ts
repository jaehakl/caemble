import type { UcumUnit } from '../model/units'

export const MAX_CANONICAL_GEOMETRY_TRIANGLES = 2_000_000
export const MAX_CANONICAL_TASK_SCENES = 128
export const MAX_CANONICAL_RENDER_TYPED_ARRAY_BYTES = 128 * 1024 * 1024

export type CanonicalVec3V1 = readonly [number, number, number]
export type CanonicalAffineMatrixV1 = readonly [
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

export type CanonicalPrimitiveNameV1 = 'box' | 'cylinder' | 'sphere' | 'curvedEdgeCylinder' | 'curvedSurfaceSphere'

export type CanonicalPrimitiveNodeV1 = Readonly<{
  kind: 'primitive'
  nodeId: string
  primitive: CanonicalPrimitiveNameV1
  parameters: Readonly<Record<string, unknown>>
}>

export type CanonicalFiberNodeV1 = Readonly<{
  kind: 'fiber'
  nodeId: string
  points: readonly CanonicalVec3V1[]
  radii: readonly number[]
  frames: readonly Readonly<{
    tangent: CanonicalVec3V1
    normal: CanonicalVec3V1
    binormal: CanonicalVec3V1
  }>[]
  radialSegments: number
}>

export type CanonicalTransformNodeV1 = Readonly<{
  kind: 'transform'
  nodeId: string
  matrix: CanonicalAffineMatrixV1
  child: CanonicalGeometryNodeV1
}>

export type CanonicalBooleanNodeV1 = Readonly<{
  kind: 'boolean'
  nodeId: string
  operation: 'union' | 'subtract' | 'intersect'
  children: readonly CanonicalGeometryNodeV1[]
}>

export type CanonicalShellNodeV1 = Readonly<{
  kind: 'shell'
  nodeId: string
  innerOffset: number
  outerOffset: number
  child: CanonicalGeometryNodeV1
}>

export type CanonicalInstanceNodeV1 = Readonly<{
  kind: 'instance'
  nodeId: string
  instanceId: string
  matrix: CanonicalAffineMatrixV1
  child: CanonicalGeometryNodeV1
}>

export type CanonicalGeometryNodeV1 =
  | CanonicalPrimitiveNodeV1
  | CanonicalFiberNodeV1
  | CanonicalTransformNodeV1
  | CanonicalBooleanNodeV1
  | CanonicalShellNodeV1
  | CanonicalInstanceNodeV1

export type CanonicalGeometryMaterialV1 = Readonly<{
  name: string
  source?: string
  version?: string
}>

export type CanonicalGeometryRootV1 = Readonly<{
  id: string
  materialRole: string
  material?: CanonicalGeometryMaterialV1
  node: CanonicalGeometryNodeV1
}>

export type CanonicalGeometryGroupV1 = Readonly<{
  id: string
  name: string
  kind: 'geometry'
  memberIds: readonly string[]
  rootIds: readonly string[]
  missingMemberIds: readonly string[]
}>

export type CanonicalSurfaceSelectorV1 = Readonly<{
  rootId: string
  sourceNodeId: string
  faceKey: string
}>

export type CanonicalSurfaceGroupV1 = Readonly<{
  id: string
  name: string
  kind: 'surface'
  memberIds: readonly string[]
  selectors: readonly CanonicalSurfaceSelectorV1[]
  missingMemberIds: readonly string[]
}>

export type CanonicalGeometrySceneV1 = Readonly<{
  geometryFormatVersion: 1
  geometryHash: string
  lengthUnit: UcumUnit
  roots: readonly CanonicalGeometryRootV1[]
  geometryGroups: readonly CanonicalGeometryGroupV1[]
  surfaceGroups: readonly CanonicalSurfaceGroupV1[]
}>

export type CanonicalGeometrySceneDraftV1 = Omit<CanonicalGeometrySceneV1, 'geometryHash'>
