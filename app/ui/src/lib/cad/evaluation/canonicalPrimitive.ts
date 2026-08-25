import type { CanonicalGeometryNodeV1, CanonicalPrimitiveNameV1 } from './canonicalTypes'
import { canonicalFiberNode } from '../elements/primitives/fiber/runtime'

type FourierMode = Readonly<{ amplitude: number; phase: number }>

function fourier(value: unknown) {
  return (value as readonly FourierMode[]).map(({ amplitude, phase }) => ({ amplitude, phase }))
}

export function canonicalPrimitiveNode(
  primitive: string,
  nodeId: string,
  props: Record<string, unknown>,
  geometry: unknown,
): CanonicalGeometryNodeV1 {
  if (primitive === 'fiber') return canonicalFiberNode(geometry, nodeId)

  let parameters: Readonly<Record<string, unknown>>
  if (primitive === 'box') {
    parameters = { size: [...(props.size as readonly number[])] }
  } else if (primitive === 'cylinder') {
    parameters = {
      radius: props.radius,
      radius_2: props.radius_2 === undefined ? props.radius : props.radius_2,
      height: props.height,
      segments: props.segments,
    }
  } else if (primitive === 'sphere') {
    parameters = { radius: props.radius, segments: props.segments }
  } else if (primitive === 'curvedEdgeCylinder') {
    const verticalCurve = props.verticalCurve as Readonly<{ origin: number; coefficients: readonly number[] }>
    parameters = {
      height: props.height,
      azimuthalCurve: fourier(props.azimuthalCurve),
      verticalCurve: { origin: verticalCurve.origin, coefficients: [...verticalCurve.coefficients] },
      azimuthalSegments: props.azimuthalSegments,
      verticalSegments: props.verticalSegments,
    }
  } else if (primitive === 'curvedSurfaceSphere') {
    parameters = {
      azimuthalCurve: fourier(props.azimuthalCurve),
      polarCurve: fourier(props.polarCurve),
      azimuthalSegments: props.azimuthalSegments,
      polarSegments: props.polarSegments,
    }
  } else {
    throw new Error(`Unsupported Canonical Geometry primitive: ${primitive}`)
  }
  return { kind: 'primitive', nodeId, primitive: primitive as CanonicalPrimitiveNameV1, parameters }
}
