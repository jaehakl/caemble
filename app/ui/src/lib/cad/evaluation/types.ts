import type { Material, ResolvedMaterialVariables } from '../model/core'
import type { Rotation, Vec3 } from '../model/types'
import type { UcumUnit } from '../model/units'

export type GeometryComponent = (props: Record<string, unknown>) => unknown
export type CadElementType = string | GeometryComponent

export type CadNode = {
  type: CadElementType
  props: Record<string, unknown>
  children: unknown[]
}

export type EvaluatedPart = {
  geometry: unknown
  material?: Material
  surfaces?: EvaluatedSurface[]
  ownerNodeKey?: string
  resultNodeKey?: string
}

export type EvaluatedSurface = {
  name: string
  polygonIndices: number[]
}

export type CadSceneSurface = {
  id: string
  name: string
  polygonIndices: number[]
}

export type CadScenePart = {
  id: string
  geometry: unknown
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
  pos: Vec3
  rotate: Rotation | undefined
  scale: Vec3
}

export type CadElementManifest<Tag extends string = string> = Readonly<{
  tag: Tag
  category: 'primitive' | 'operation'
  syntax: string
  summary: string
}>

export type CadElementEvaluationContext = Readonly<{
  inheritedMaterials: readonly Material[] | undefined
  evaluate: (
    value: unknown,
    inheritedMaterials?: readonly Material[],
    trace?: Readonly<{ key: string; label: string; identitySegment?: string }>,
  ) => EvaluatedPart[]
}>

export type PrimitiveElementDefinition<Tag extends string = string> = Readonly<{
  kind: 'primitive'
  tag: Tag
  manifest: CadElementManifest<Tag>
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
