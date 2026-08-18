import { CadModelError } from '../../../model/core'
import type { Vec3 } from '../../../model/types'
import { Fragment, isCadNode } from '../../../evaluation/jsx'
import { applyTransforms, normalizeDirection, normalizeVec3, unitScale } from '../../../evaluation/transforms'
import type { GeometryOperationDefinition } from '../../../evaluation/types'
import { arrayManifest } from './definition'

const standardAxes = Object.freeze([
  Object.freeze([1, 0, 0] as [number, number, number]),
  Object.freeze([0, 1, 0] as [number, number, number]),
  Object.freeze([0, 0, 1] as [number, number, number]),
] as [Vec3, Vec3, Vec3])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateDenseTensor(value: unknown, path: string): number[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CadModelError(`${path} must contain only finite numbers.`)
    return []
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new CadModelError(`${path} must be a non-empty dense tensor of finite numbers.`)
  }

  const childShape = validateDenseTensor(value[0], `${path}[0]`)
  value.slice(1).forEach((item, index) => {
    const itemShape = validateDenseTensor(item, `${path}[${index + 1}]`)
    if (itemShape.length !== childShape.length || itemShape.some((size, axis) => size !== childShape[axis])) {
      throw new CadModelError(`${path} must be a dense rectangular tensor.`)
    }
  })
  return [value.length, ...childShape]
}

function requireTensorShape(value: unknown, expected: readonly number[], path: string) {
  const actual = validateDenseTensor(value, path)
  if (actual.length !== expected.length || actual.some((size, axis) => size !== expected[axis])) {
    throw new CadModelError(`${path} must have shape [${expected.join(', ')}].`)
  }
}

function normalizeInject(value: unknown, shape: Vec3) {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new CadModelError('<array> inject must be an object of Geometry attribute tensors.')

  const keys = new Set(Object.keys(value))
  if ((keys.has('position') || keys.has('rotation')) && (keys.has('pos') || keys.has('rotate'))) {
    throw new CadModelError('<array> inject cannot mix position/rotation with deprecated pos/rotate.')
  }

  Object.entries(value).forEach(([key, tensor]) => {
    const path = `<array> inject.${key}`
    if (key === 'id' || key === 'materials' || key === 'children') {
      throw new CadModelError(`${path} is not supported.`)
    }
    if (key === 'rotate') {
      if (!isRecord(tensor)) throw new CadModelError(`${path} must be an object with axis and angle tensors.`)
      requireTensorShape(tensor.axis, [...shape, 3], `${path}.axis`)
      requireTensorShape(tensor.angle, shape, `${path}.angle`)
    } else if (key === 'position' || key === 'rotation' || key === 'pos' || key === 'scale') {
      requireTensorShape(tensor, [...shape, 3], path)
    } else {
      const actual = validateDenseTensor(tensor, path)
      if (actual.length < 3 || shape.some((size, axis) => actual[axis] !== size)) {
        throw new CadModelError(`${path} must start with shape [${shape.join(', ')}].`)
      }
    }
  })
  return value
}

function tensorCell(value: unknown, x: number, y: number, z: number) {
  return (((value as unknown[])[x] as unknown[])[y] as unknown[])[z]
}

function injectedPropsAt(inject: Record<string, unknown>, x: number, y: number, z: number) {
  const props: Record<string, unknown> = {}
  Object.entries(inject).forEach(([key, tensor]) => {
    if (key === 'rotate') {
      const rotation = tensor as Record<string, unknown>
      props.rotate = { axis: tensorCell(rotation.axis, x, y, z), angle: tensorCell(rotation.angle, x, y, z) }
    } else {
      props[key] = tensorCell(tensor, x, y, z)
    }
  })
  return props
}

export const arrayDefinition = {
  kind: 'operation',
  tag: arrayManifest.tag,
  manifest: arrayManifest,
  surfacePolicy: 'preserve',
  evaluate(node, context) {
    if (
      node.children.length !== 1 ||
      !isCadNode(node.children[0]) ||
      node.children[0].type === Fragment ||
      node.children[0].props.id === undefined
    ) {
      throw new CadModelError('<array> requires exactly one direct identified Geometry or intrinsic CAD element.')
    }

    const shapeValue = node.props.shape
    if (
      !Array.isArray(shapeValue) ||
      shapeValue.length !== 3 ||
      shapeValue.some((size) => !Number.isSafeInteger(size) || size <= 0)
    ) {
      throw new CadModelError('<array> shape must be an array of exactly three positive integers.')
    }
    const shape = [shapeValue[0], shapeValue[1], shapeValue[2]] as [number, number, number]
    const period = normalizeVec3(node.props.period, '<array> period')
    period.forEach((spacing, axis) => {
      if (spacing < 0 || (shape[axis] > 1 && spacing === 0)) {
        throw new CadModelError(
          `<array> period[${axis}] must be positive when shape[${axis}] is greater than one, and non-negative otherwise.`,
        )
      }
    })

    let axes: readonly [Vec3, Vec3, Vec3] = standardAxes
    if (node.props.axes !== undefined) {
      if (!isRecord(node.props.axes))
        throw new CadModelError('<array> axes must be an object with x, y, and z direction vectors.')
      axes = [
        normalizeDirection(node.props.axes.x, '<array> axes.x'),
        normalizeDirection(node.props.axes.y, '<array> axes.y'),
        normalizeDirection(node.props.axes.z, '<array> axes.z'),
      ]
    }
    const inject = normalizeInject(node.props.inject, shape)
    const child = node.children[0]
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
          if (offset.some((coordinate) => !Number.isFinite(coordinate))) {
            throw new CadModelError('<array> calculated a non-finite cell position.')
          }

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
            ),
          )
        }
      }
    }
    return parts
  },
} satisfies GeometryOperationDefinition<'array'>
