import type { CanonicalGeometryNodeV2, CanonicalPrimitiveNameV2 } from './canonicalTypes'
import { normalizeFiber } from '../geometry/fiber'
import { normalizeContinuousPrimitive, type ContinuousPrimitive } from '../geometry/continuous'
import type { GeometryEvaluationProfile } from './precision'

export function canonicalPrimitiveNode(
  primitive: string,
  nodeId: string,
  props: Record<string, unknown>,
  profile?: GeometryEvaluationProfile,
): CanonicalGeometryNodeV2 {
  const tessellation = { ...((props.tessellation as Record<string, number>) ?? {}) }
  for (const name of ['segments', 'azimuthalSegments', 'verticalSegments'])
    if (props[name] !== undefined) tessellation[name] = Number(props[name])
  if (profile) {
    for (const key of Object.keys(tessellation))
      tessellation[key] = Math.max(
        tessellation[key],
        key === 'pathSegments' ? profile.pathSegments : profile.angularSegments,
      )
    tessellation.radialSegments = Math.max(tessellation.radialSegments ?? 0, profile.angularSegments)
    tessellation.meridianSegments = Math.max(tessellation.meridianSegments ?? 0, profile.angularSegments)
    if (primitive === 'fiber')
      tessellation.pathSegments = Math.max(tessellation.pathSegments ?? 0, profile.pathSegments)
  }
  if (primitive === 'fiber') return { kind: 'fiber', nodeId, ...normalizeFiber(props), tessellation }
  let parameters: Readonly<Record<string, unknown>>
  if (primitive === 'box') parameters = { size: [...(props.size as readonly number[])] }
  else if (primitive === 'cylinder')
    parameters = { radius: props.radius, radius_2: props.radius_2 ?? props.radius, height: props.height }
  else if (primitive === 'sphere') parameters = { radius: props.radius }
  else if (primitive === 'curvedEdgeCylinder') {
    const vertical = props.verticalCurve as { origin: number; coefficients: readonly number[] }
    parameters = {
      height: props.height,
      azimuthalCurve: (props.azimuthalCurve as readonly { amplitude: number; phase: number }[]).map((value) => ({
        ...value,
      })),
      verticalCurve: { origin: vertical.origin, coefficients: [...vertical.coefficients] },
    }
  } else if (['asphericCylinder', 'ellipsoid', 'hyperboloid', 'paraboloid'].includes(primitive))
    parameters = normalizeContinuousPrimitive(primitive as ContinuousPrimitive, props)
  else throw new Error(`Unsupported Canonical Geometry primitive: ${primitive}. Rebuild with current inputs.`)
  return { kind: 'primitive', nodeId, primitive: primitive as CanonicalPrimitiveNameV2, parameters, tessellation }
}
