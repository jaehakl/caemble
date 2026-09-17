import type { Vec3 } from '../model/types'
import { positive, subdivisions, type IndexedSurface, type Tessellation } from './continuous'

export type FiberSegment = Readonly<
  { kind: 'line'; length: number } | { kind: 'arc'; radius: number; angle: number; normal: Vec3 }
>
export type FiberPath = Readonly<{ start: Vec3; direction: Vec3; segments: readonly FiberSegment[] }>
export type RadiusKnot = Readonly<{ s: number; radius: number }>
export type FiberDefinition = Readonly<{ path: FiberPath; radiusProfile: readonly RadiusKnot[] }>
type Vector = [number, number, number]

function unit(value: Vec3): Vector {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
    throw new Error('Fiber requires finite Vec3 values.')
  const length = positive(Math.hypot(...value), 'Fiber direction length')
  return value.map((x) => x / length) as Vector
}
function cross(a: Vec3, b: Vec3): Vector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function dot(a: Vec3, b: Vec3) {
  return a.reduce((sum, x, i) => sum + x * b[i], 0)
}
function rotate(v: Vec3, axis: Vec3, angle: number): Vector {
  const w = cross(axis, v),
    c = Math.cos(angle),
    s = Math.sin(angle),
    d = dot(axis, v) * (1 - c)
  return v.map((x, i) => x * c + w[i] * s + axis[i] * d) as Vector
}

export function normalizeFiber(props: Record<string, unknown>): FiberDefinition {
  for (const name of [
    'basePath',
    'helix',
    'fourier',
    'envelopePower',
    'up',
    'pathSegments',
    'radialSegments',
    'points',
    'radii',
    'frames',
  ])
    if (props[name] !== undefined)
      throw new Error(`Fiber ${name} was removed; use declarative path/profile and tessellation.`)
  if (typeof props.radius === 'function')
    throw new Error('Fiber radius callbacks were removed; migrate to radiusProfile and rebuild.')
  if (props.path !== undefined && (props.from !== undefined || props.to !== undefined))
    throw new Error('Fiber path and from/to are mutually exclusive.')
  if (props.radius !== undefined && props.radiusProfile !== undefined)
    throw new Error('Fiber radius and radiusProfile are mutually exclusive.')
  let path: FiberPath
  if (props.path !== undefined) path = props.path as FiberPath
  else {
    const start = (props.from ?? [0, 0, -0.5]) as Vec3,
      end = (props.to ?? [0, 0, 0.5]) as Vec3
    const delta = end.map((x, i) => x - start[i]) as Vector
    path = { start, direction: unit(delta), segments: [{ kind: 'line', length: Math.hypot(...delta) }] }
  }
  if (
    !Array.isArray(path.start) ||
    path.start.length !== 3 ||
    !path.start.every(Number.isFinite) ||
    !Array.isArray(path.segments) ||
    !path.segments.length
  )
    throw new Error('Fiber requires a start and nonempty path segments.')
  let tangent = unit(path.direction),
    length = 0
  const segments = path.segments.map((segment) => {
    if (segment.kind === 'line') {
      length += positive(segment.length, 'Line length')
      return { ...segment }
    }
    if (segment.kind !== 'arc') throw new Error('Fiber supports only Line and Arc segments.')
    const radius = positive(segment.radius, 'Arc radius'),
      normal = unit(segment.normal)
    if (!Number.isFinite(segment.angle) || segment.angle === 0 || Math.abs(segment.angle) >= 2 * Math.PI)
      throw new Error('Arc angle must be nonzero and strictly less than a full turn.')
    if (Math.abs(dot(tangent, normal)) > 1e-10)
      throw new Error('Arc normal must be perpendicular to the incoming tangent.')
    tangent = rotate(tangent, normal, segment.angle)
    length += radius * Math.abs(segment.angle)
    return { ...segment, normal }
  })
  const radiusProfile =
    props.radiusProfile === undefined
      ? [
          { s: 0, radius: positive(props.radius ?? 0.05, 'Fiber radius') },
          { s: length, radius: positive(props.radius ?? 0.05, 'Fiber radius') },
        ]
      : (props.radiusProfile as readonly RadiusKnot[]).map((knot) => ({ ...knot }))
  if (
    radiusProfile.length < 2 ||
    radiusProfile[0].s !== 0 ||
    Math.abs(radiusProfile[radiusProfile.length - 1].s - length) > 1e-10 * length
  )
    throw new Error('Fiber radiusProfile must span the full physical path length.')
  radiusProfile.forEach((knot, i) => {
    positive(knot.radius, 'Fiber profile radius')
    if (!Number.isFinite(knot.s) || (i > 0 && knot.s <= radiusProfile[i - 1].s))
      throw new Error('Fiber profile s must be strictly increasing.')
  })
  radiusProfile[radiusProfile.length - 1].s = length
  const maxRadius = Math.max(...radiusProfile.map((k) => k.radius))
  if (segments.some((s) => s.kind === 'arc' && s.radius <= maxRadius))
    throw new Error('Unsupported Fiber: bend radius must exceed the section radius.')
  const definition = {
    path: { start: [...path.start] as Vector, direction: unit(path.direction), segments },
    radiusProfile,
  }
  validateFiberReach(definition)
  return definition
}

// A tube with radius below the local curvature radius is locally regular.
// Distant path intervals must also be disjoint. Midpoint balls enclose entire
// intervals by arc length, so this certificate does not depend on tessellation.
export function validateFiberReach(definition: FiberDefinition) {
  const length = definition.radiusProfile[definition.radiusProfile.length - 1].s
  const radius = Math.max(...definition.radiusProfile.map((knot) => knot.radius))
  const turning = (s: number) => {
    let sum = 0,
      remaining = s
    for (const segment of definition.path.segments) {
      const span = segment.kind === 'line' ? segment.length : segment.radius * Math.abs(segment.angle)
      if (segment.kind === 'arc') sum += Math.min(remaining, span) / segment.radius
      remaining -= Math.min(remaining, span)
      if (remaining === 0) break
    }
    return sum
  }
  const pending: [number, number, number, number, number][] = [[0, length, 0, length, 0]]
  let visits = 0
  while (pending.length) {
    const [a, b, c, d, depth] = pending.pop()!
    // Within this turning bound no doubly critical chord can occur.
    if (turning(d) - turning(a) < Math.PI / 2) continue
    if (++visits > 100000 || depth > 48)
      throw new Error('Unsupported Fiber self-intersection or unresolved tube clearance.')
    if (a === c && b === d) {
      const mid = (a + b) / 2
      pending.push([a, mid, a, mid, depth + 1], [mid, b, mid, b, depth + 1], [a, mid, mid, b, depth + 1])
      continue
    }
    const p = evaluateFiber(definition, (a + b) / 2).center,
      q = evaluateFiber(definition, (c + d) / 2).center
    if (Math.hypot(...p.map((value, i) => value - q[i])) > (b - a + d - c) / 2 + 2 * radius) continue
    if (b - a >= d - c) pending.push([a, (a + b) / 2, c, d, depth + 1], [(a + b) / 2, b, c, d, depth + 1])
    else pending.push([a, b, c, (c + d) / 2, depth + 1], [a, b, (c + d) / 2, d, depth + 1])
  }
}

export function evaluateFiber(definition: FiberDefinition, s: number, theta = 0, side: 'left' | 'right' = 'right') {
  const { path, radiusProfile } = definition
  let point = [...path.start] as Vector,
    tangent = unit(path.direction)
  const axis = [0, 1, 2].sort((a, b) => Math.abs(tangent[a]) - Math.abs(tangent[b]))[0]
  const reference: Vector = [0, 0, 0]
  reference[axis] = 1
  let normal = unit(cross(tangent, reference)),
    curvature: Vector = [0, 0, 0],
    remaining = s
  for (let i = 0; i < path.segments.length; i++) {
    const segment = path.segments[i],
      length = segment.kind === 'line' ? segment.length : segment.radius * Math.abs(segment.angle)
    const distance = Math.min(Math.max(remaining, 0), length)
    curvature = [0, 0, 0]
    if (segment.kind === 'line') point = point.map((x, j) => x + tangent[j] * distance) as Vector
    else {
      const sign = Math.sign(segment.angle),
        angle = (sign * distance) / segment.radius
      const inward = cross(segment.normal, tangent).map((x) => x * sign) as Vector
      point = point.map(
        (x, j) => x + segment.radius * (tangent[j] * Math.sin(Math.abs(angle)) + inward[j] * (1 - Math.cos(angle))),
      ) as Vector
      tangent = rotate(tangent, segment.normal, angle)
      normal = rotate(normal, segment.normal, angle)
      curvature = cross(segment.normal, tangent).map((x) => (x * sign) / segment.radius) as Vector
    }
    remaining -= length
    if (remaining < 0 || (remaining === 0 && (side === 'left' || i === path.segments.length - 1))) break
  }
  let index = radiusProfile.findIndex((k, i) => i > 0 && (side === 'left' ? s <= k.s : s < k.s))
  if (index < 0) index = radiusProfile.length - 1
  const first = radiusProfile[index - 1],
    last = radiusProfile[index],
    slope = (last.radius - first.radius) / (last.s - first.s)
  const radius = first.radius + (s - first.s) * slope,
    binormal = cross(tangent, normal)
  const radial = normal.map((x, j) => x * Math.cos(theta) + binormal[j] * Math.sin(theta)) as Vector
  const factor = 1 - radius * dot(curvature, radial)
  const outward = unit(radial.map((x, j) => factor * x - slope * tangent[j]) as Vector)
  const derivativeS = tangent.map((x, j) => factor * x + slope * radial[j]) as Vector
  const derivativeTheta = normal.map(
    (x, j) => radius * (-x * Math.sin(theta) + binormal[j] * Math.cos(theta)),
  ) as Vector
  return {
    center: point,
    tangent,
    normal,
    binormal,
    radius,
    position: point.map((x, j) => x + radius * radial[j]) as Vector,
    outward,
    derivativeS,
    derivativeTheta,
  }
}

export function tessellateFiber(definition: FiberDefinition, settings: Tessellation = {}): IndexedSurface {
  if (!definition.path || !definition.radiusProfile)
    throw new Error('Sampled Fiber was removed; migrate source and rebuild.')
  const count = subdivisions(settings.radialSegments, 12),
    steps = subdivisions(settings.pathSegments, 128, 1)
  const length = definition.radiusProfile[definition.radiusProfile.length - 1].s
  let distance = 0
  const boundaries = definition.path.segments.map(
    (segment) => (distance += segment.kind === 'line' ? segment.length : segment.radius * Math.abs(segment.angle)),
  )
  const knots = [...new Set([0, length, ...boundaries, ...definition.radiusProfile.map((k) => k.s)])]
  const samples = [
    ...knots,
    ...Array.from({ length: steps + 1 }, (_, i) => (i * length) / steps).filter(
      (s) => !knots.some((k) => Math.abs(k - s) <= length * Number.EPSILON * 16),
    ),
  ].sort((a, b) => a - b)
  const mesh: IndexedSurface = { points: [], triangles: [], surfaceIndices: [] }
  for (const s of samples)
    for (let i = 0; i < count; i++) mesh.points.push(evaluateFiber(definition, s, (2 * Math.PI * i) / count).position)
  for (let j = 0; j < samples.length - 1; j++)
    for (let i = 0; i < count; i++) {
      const n = (i + 1) % count,
        a = j * count + i,
        b = j * count + n,
        c = (j + 1) * count + n,
        d = (j + 1) * count + i
      mesh.triangles.push([a, b, c], [a, c, d])
      mesh.surfaceIndices.push(1, 1)
    }
  const start = mesh.points.push(evaluateFiber(definition, 0).center) - 1,
    end = mesh.points.push(evaluateFiber(definition, length).center) - 1,
    base = (samples.length - 1) * count
  for (let i = 0; i < count; i++) {
    const n = (i + 1) % count
    mesh.triangles.push([start, n, i], [end, base + i, base + n])
    mesh.surfaceIndices.push(0, 2)
  }
  return mesh
}
