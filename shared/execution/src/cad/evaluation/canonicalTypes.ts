import type { FiberDefinition } from '../geometry/fiber'
import type { Tessellation } from '../geometry/continuous'
import type { UcumUnit } from '../model/units'
import type { GeometryEvaluationProfile } from './precision'

export type CanonicalVec3V2 = readonly [number, number, number]
export type CanonicalAffineMatrixV2 = readonly [
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

export type CanonicalPrimitiveNameV2 =
  'box' | 'cylinder' | 'sphere' | 'curvedEdgeCylinder' | 'asphericCylinder' | 'ellipsoid' | 'hyperboloid' | 'paraboloid'

export type CanonicalPrimitiveNodeV2 = Readonly<{
  kind: 'primitive'
  nodeId: string
  primitive: CanonicalPrimitiveNameV2
  parameters: Readonly<Record<string, unknown>>
  tessellation?: Readonly<Record<string, number>>
}>

export type CanonicalFiberNodeV2 = FiberDefinition &
  Readonly<{ kind: 'fiber'; nodeId: string; tessellation?: Tessellation }>

export type CanonicalTransformNodeV2 = Readonly<{
  kind: 'transform'
  nodeId: string
  matrix: CanonicalAffineMatrixV2
  child: CanonicalGeometryNodeV2
}>

export type CanonicalBooleanNodeV2 = Readonly<{
  kind: 'boolean'
  nodeId: string
  operation: 'union' | 'subtract' | 'intersect'
  children: readonly CanonicalGeometryNodeV2[]
}>

export type CanonicalInstanceNodeV2 = Readonly<{
  kind: 'instance'
  nodeId: string
  instanceId: string
  matrix: CanonicalAffineMatrixV2
  child: CanonicalGeometryNodeV2
}>

export type CanonicalGeometryNodeV2 =
  | CanonicalPrimitiveNodeV2
  | CanonicalFiberNodeV2
  | CanonicalTransformNodeV2
  | CanonicalBooleanNodeV2
  | CanonicalInstanceNodeV2

export type CanonicalGeometryMaterialV2 = Readonly<{
  name: string
}>

export type CanonicalGeometryRootV2 = Readonly<{
  id: string
  materialRole: string
  material?: CanonicalGeometryMaterialV2
  node: CanonicalGeometryNodeV2
}>

export type CanonicalGeometryGroupV2 = Readonly<{
  id: string
  name: string
  kind: 'geometry'
  memberIds: readonly string[]
  rootIds: readonly string[]
  missingMemberIds: readonly string[]
}>

export type CanonicalSurfaceSelectorV2 = Readonly<{
  rootId: string
  sourceNodeId: string
  surfaceIndex: number
}>

export type CanonicalSurfaceGroupV2 = Readonly<{
  id: string
  name: string
  kind: 'surface'
  memberIds: readonly string[]
  selectors: readonly CanonicalSurfaceSelectorV2[]
  missingMemberIds: readonly string[]
}>

export type CanonicalGeometrySceneV2 = Readonly<{
  version: 2
  geometryHash: string
  meshHash: string
  evaluationProfile?: GeometryEvaluationProfile
  lengthUnit: UcumUnit
  roots: readonly CanonicalGeometryRootV2[]
  geometryGroups: readonly CanonicalGeometryGroupV2[]
  surfaceGroups: readonly CanonicalSurfaceGroupV2[]
}>

export type CanonicalGeometrySceneDraftV2 = Omit<CanonicalGeometrySceneV2, 'geometryHash' | 'meshHash'>
