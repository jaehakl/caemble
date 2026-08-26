import type { Material, ResolvedMaterialVariables } from '../model/core'
import type { Rotation, Vec3 } from '../model/types'
import type { UcumUnit } from '../model/units'
import type { CanonicalGeometryNodeV1 } from './canonicalTypes'

export type GeometryComponent = (props: Record<string, unknown>) => unknown
export type CadElementType = string | GeometryComponent

export type CadNode = {
  type: CadElementType
  props: Record<string, unknown>
  children: unknown[]
}

export type EvaluatedPart = {
  geometry: unknown
  canonicalNode: CanonicalGeometryNodeV1
  materialRole: string
  material?: Material
  surfaces?: EvaluatedSurface[]
  ownerNodeKey?: string
  resultNodeKey?: string
}

export type EvaluatedSurface = {
  surfaceIndex: number
  label: string
  polygonIndices: number[]
}

export type CadSceneSurface = {
  id: string
  surfaceIndex: number
  label: string
  polygonIndices: number[] | Uint32Array
}

export type CadScenePart = {
  id: string
  geometry: unknown
  materialRole: string
  material?: CadSceneMaterial
  surfaces: CadSceneSurface[]
}

export type CadSceneMaterial = Readonly<{
  name: string
  source?: string
  version?: string
  errorRate?: number
  variables: ResolvedMaterialVariables
}>

export type CadSceneTreeNode = {
  key: string
  label: string
  globalId?: string
  groupId?: string
  geometryIds?: string[]
  geometryId?: string
  surfaceId?: string
  children: CadSceneTreeNode[]
}

export type CadSceneGroup = {
  id: string
  name: string
  kind: 'geometry' | 'surface'
  memberIds: string[]
  geometryIds: string[]
  surfaceIds: string[]
  missingMemberIds: string[]
}

export type CadScene = {
  lengthUnit: UcumUnit
  parts: CadScenePart[]
  tree: CadSceneTreeNode
  geometryGroups: CadSceneGroup[]
  surfaceGroups: CadSceneGroup[]
}

export type NormalizedTransforms = {
  family: 'canonical' | 'axis-angle'
  position: Vec3
  rotation: Vec3 | undefined
  rotate: Rotation | undefined
  scale: Vec3
}

export type CadElementPropertyManifest = Readonly<{
  name: string
  type: string
  required: boolean
  default?: string
  authoringValue: string
  description: string
}>

export type CadElementChildrenManifest = Readonly<{
  count: 'none' | 'one' | 'many'
  description: string
}>

export type CadAuthoringContract = Readonly<{
  identity: CadElementPropertyManifest & Readonly<{ pathExample: string }>
  transforms: Readonly<{
    applicationOrder: readonly ['scale', 'rotation', 'position']
    rotationConvention: string
    canonicalProperties: readonly CadElementPropertyManifest[]
  }>
}>

export type CadElementSurfaceManifest = Readonly<{
  index: number
  label: string
  description: string
}>

export type CadElementManifest<Tag extends string = string> = Readonly<{
  tag: Tag
  authoringName: string
  category: 'primitive' | 'operation'
  standardTransforms: boolean
  syntax: string
  summary: string
  keywords: readonly string[]
  properties: readonly CadElementPropertyManifest[]
  children: CadElementChildrenManifest
  origin: string
  surfaces: readonly CadElementSurfaceManifest[]
  example: string
}>

export type CadElementEvaluationContext = Readonly<{
  nodeId: string
  inheritedMaterials: Map<string, MaterialBinding>
  evaluate: (
    value: unknown,
    inheritedMaterials?: Map<string, MaterialBinding>,
    trace?: Readonly<{ key: string; label: string; identitySegment?: string }>,
  ) => EvaluatedPart[]
}>

export type MaterialBinding = Readonly<{
  role: string
  material?: Material
  exposed: Material
}>

export type PrimitiveElementDefinition<Tag extends string = string> = Readonly<{
  kind: 'primitive'
  tag: Tag
  manifest: CadElementManifest<Tag>
  defaultProps: Readonly<Record<string, unknown>>
  createGeometry: (props: Record<string, unknown>) => unknown
  createSurfaces: (geometry: unknown, props: Record<string, unknown>) => EvaluatedSurface[]
}>

export type GeometryOperationDefinition<Tag extends string = string> = Readonly<{
  kind: 'operation'
  tag: Tag
  manifest: CadElementManifest<Tag>
  surfacePolicy: 'preserve' | 'derive'
  evaluate: (node: CadNode, context: CadElementEvaluationContext) => EvaluatedPart[]
}>

export type CadElementDefinition<Tag extends string = string> =
  PrimitiveElementDefinition<Tag> | GeometryOperationDefinition<Tag>
