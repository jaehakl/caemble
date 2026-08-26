import type { Rotation, Vec3 } from '../../../model/types'
import { applyTransforms, normalizeDirection, normalizeVec3, origin, unitScale } from '../../../evaluation/transforms'
import type { CadNode, CadElementEvaluationContext, GeometryOperationDefinition } from '../../../evaluation/types'
import { rotateManifest, scaleManifest, translateManifest } from './definition'

function evaluateChildren(node: CadNode, context: CadElementEvaluationContext) {
  return node.children.flatMap((child) => context.evaluate(child, context.inheritedMaterials))
}

export const translateDefinition = {
  kind: 'operation',
  tag: translateManifest.tag,
  manifest: translateManifest,
  surfacePolicy: 'preserve',
  evaluate(node, context) {
    const parts = evaluateChildren(node, context)
    const position = normalizeVec3(node.props.offset, '<translate> offset')
    return applyTransforms(
      parts,
      {
        family: 'canonical',
        position,
        rotation: undefined,
        rotate: undefined,
        scale: unitScale,
      },
      context.nodeId,
    )
  },
} satisfies GeometryOperationDefinition<'translate'>

export const rotateDefinition = {
  kind: 'operation',
  tag: rotateManifest.tag,
  manifest: rotateManifest,
  surfacePolicy: 'preserve',
  evaluate(node, context) {
    const parts = evaluateChildren(node, context)
    const rotate: Rotation = Object.freeze({
      axis: normalizeDirection(node.props.axis, '<rotate> axis'),
      angle: node.props.angle as number,
    })
    return applyTransforms(
      parts,
      {
        family: 'axis-angle',
        position: origin,
        rotation: undefined,
        rotate,
        scale: unitScale,
      },
      context.nodeId,
    )
  },
} satisfies GeometryOperationDefinition<'rotate'>

export const scaleDefinition = {
  kind: 'operation',
  tag: scaleManifest.tag,
  manifest: scaleManifest,
  surfacePolicy: 'preserve',
  evaluate(node, context) {
    const parts = evaluateChildren(node, context)
    const scale = Object.freeze([
      node.props.x,
      node.props.y,
      node.props.z,
    ]) as Vec3
    return applyTransforms(
      parts,
      {
        family: 'canonical',
        position: origin,
        rotation: undefined,
        rotate: undefined,
        scale,
      },
      context.nodeId,
    )
  },
} satisfies GeometryOperationDefinition<'scale'>
