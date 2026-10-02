import type { Vec3 } from '../../../model/types'
import { applyTransforms, normalizeDirection, normalizeVec3, unitScale } from '../../../evaluation/transforms'
import type { CadNode, GeometryOperationDefinition } from '../../../evaluation/types'
import { arrayManifest } from './definition'

const standardAxes = Object.freeze([
  Object.freeze([1, 0, 0] as [number, number, number]),
  Object.freeze([0, 1, 0] as [number, number, number]),
  Object.freeze([0, 0, 1] as [number, number, number]),
] as [Vec3, Vec3, Vec3])

function tensorCell(value: unknown, x: number, y: number, z: number) {
  return (((value as unknown[])[x] as unknown[])[y] as unknown[])[z]
}

function injectedPropsAt(inject: Record<string, unknown>, x: number, y: number, z: number) {
  const props: Record<string, unknown> = {}
  Object.entries(inject).forEach(([key, tensor]) => {
    props[key] = tensorCell(tensor, x, y, z)
  })
  return props
}

export const arrayDefinition = {
  kind: 'operation',
  tag: arrayManifest.tag,
  manifest: arrayManifest,
  surfacePolicy: 'preserve',
  evaluate(node, context) {
    const shapeValue = node.props.shape as Vec3
    const shape = [shapeValue[0], shapeValue[1], shapeValue[2]] as [number, number, number]
    const period = normalizeVec3(node.props.period, '<array> period')

    let axes: readonly [Vec3, Vec3, Vec3] = standardAxes
    if (node.props.axes !== undefined) {
      const authoredAxes = node.props.axes as { x: Vec3; y: Vec3; z: Vec3 }
      axes = [
        normalizeDirection(authoredAxes.x, '<array> axes.x'),
        normalizeDirection(authoredAxes.y, '<array> axes.y'),
        normalizeDirection(authoredAxes.z, '<array> axes.z'),
      ]
    }
    const inject = (node.props.inject ?? {}) as Record<string, unknown>
    const child = node.children[0] as CadNode
    const parts = []

    for (let x = 0; x < shape[0]; x += 1) {
      for (let y = 0; y < shape[1]; y += 1) {
        for (let z = 0; z < shape[2]; z += 1) {
          const distances = [
            (x - (shape[0] - 1) / 2) * period[0],
            (y - (shape[1] - 1) / 2) * period[1],
            (z - (shape[2] - 1) / 2) * period[2],
          ]
          const offset = axes[0].map(
            (_coordinate, coordinate) =>
              axes[0][coordinate] * distances[0] +
              axes[1][coordinate] * distances[1] +
              axes[2][coordinate] * distances[2],
          ) as [number, number, number]
          const cell = {
            type: child.type,
            props: { ...child.props, ...injectedPropsAt(inject, x, y, z) },
            children: child.children,
          }
          parts.push(
            ...applyTransforms(
              context.evaluate(cell, context.inheritedMaterials, {
                key: `cell-${x}-${y}-${z}`,
                label: `Cell [${x}, ${y}, ${z}]`,
                identitySegment: `$cell-${x}-${y}-${z}`,
              }),
              {
                family: 'canonical',
                scale: unitScale,
                rotation: undefined,
                rotate: undefined,
                position: offset,
              },
              `${context.nodeId}/cell-${x}-${y}-${z}`,
              `$cell-${x}-${y}-${z}`,
            ),
          )
        }
      }
    }
    return parts
  },
} satisfies GeometryOperationDefinition<'array'>
