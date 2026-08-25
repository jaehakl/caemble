import { CadModelError } from '../../../model/core'
import type { Rotation, Vec3 } from '../../../model/types'
import { applyTransforms, normalizeDirection, normalizeVec3, origin, unitScale } from '../../../evaluation/transforms'
import type { CadNode, CadElementEvaluationContext, GeometryOperationDefinition } from '../../../evaluation/types'
import { rotateManifest, scaleManifest, translateManifest } from './definition'

const standardTransformProperties = ['position', 'rotation', 'scale', 'pos', 'rotate', 'translation'] as const

function assertDedicatedTransformProps(node: CadNode) {
  const property = standardTransformProperties.find((name) => node.props[name] !== undefined)
  if (property !== undefined) {
    throw new CadModelError(
      `<${node.type}> does not accept ${property}. Use its dedicated transform properties or place the transform directly on the child Geometry.`,
    )
  }
}

function evaluateChildren(node: CadNode, context: CadElementEvaluationContext) {
  assertDedicatedTransformProps(node)
  if (node.children.length === 0) {
    throw new CadModelError(`<${node.type}> requires at least one child Geometry.`)
  }
  return node.children.flatMap((child) => context.evaluate(child, context.inheritedMaterials))
}

function finiteNumber(value: unknown, path: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CadModelError(`${path} must be a finite number.`)
  }
  return value
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
      angle: finiteNumber(node.props.angle, '<rotate> angle'),
    })
    return applyTransforms(
      parts,
      {
        family: 'legacy',
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
      finiteNumber(node.props.x, '<scale> x'),
      finiteNumber(node.props.y, '<scale> y'),
      finiteNumber(node.props.z, '<scale> z'),
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
