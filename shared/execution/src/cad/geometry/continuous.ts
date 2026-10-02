import { geometries } from '@jscad/modeling'
import type { Vec3 } from '../model/types'

export type Tessellation = Readonly<{ radialSegments?: number; pathSegments?: number; meridianSegments?: number }>
export type Asphere = Readonly<{
  curvature: number
  conic: number
  coefficients: readonly Readonly<{ order: number; value: number }>[]
}>
export type ContinuousPrimitive = 'asphericCylinder' | 'ellipsoid' | 'hyperboloid' | 'paraboloid'
export type IndexedSurface = {
  points: [number, number, number][]
  triangles: [number, number, number][]
  surfaceIndices: number[]
}
export type SurfaceEvaluation = { position: Vec3; normal: Vec3; derivativeU: Vec3; derivativeV: Vec3 }

export function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be finite and positive.`)
  return value
}

export function subdivisions(value: unknown, fallback: number, minimum = 3): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum)
    throw new Error(`Tessellation subdivisions must be integers >= ${minimum}.`)
  return value
}

export function normalizeAsphere(input: unknown, radius: number): Asphere {
  const value = (input ?? { curvature: 0, conic: 0, coefficients: [] }) as Asphere
  if (!Number.isFinite(value.curvature) || !Number.isFinite(value.conic) || !Array.isArray(value.coefficients))
    throw new Error('Invalid asphere definition.')
  const coefficients = value.coefficients.map((term) => ({ ...term })).sort((a, b) => a.order - b.order)
  coefficients.forEach((term, index) => {
    if (
      !Number.isInteger(term.order) ||
      term.order < 4 ||
      term.order % 2 ||
      !Number.isFinite(term.value) ||
      coefficients[index - 1]?.order === term.order
    )
      throw new Error('Asphere coefficients require unique even orders >= 4 and finite values.')
  })
  if (1 - (1 + value.conic) * value.curvature ** 2 * radius ** 2 <= 0)
    throw new Error('Asphere aperture reaches an invalid or singular conic domain.')
  return { curvature: value.curvature, conic: value.conic, coefficients }
}

export function sag(face: Asphere, radius: number): { value: number; derivative: number } {
  const q = Math.sqrt(1 - (1 + face.conic) * face.curvature ** 2 * radius ** 2)
  let value = (face.curvature * radius ** 2) / (1 + q)
  let derivative = (face.curvature * radius) / q
  for (const term of face.coefficients) {
    value += term.value * radius ** term.order
    derivative += term.order * term.value * radius ** (term.order - 1)
  }
  return { value, derivative }
}

// Each conic and monomial is monotone on a nonnegative radial interval.
// Enclose the radicand before sqrt: padding only the final sag would miss the
// square root's poor conditioning near the aperture limit.
function sagBounds(face: Asphere, low: number, high: number): [number, number] {
  const conic = (r: number): [number, number] => {
    if (face.curvature === 0 || r === 0) return [0, 0]
    const product = (1 + face.conic) * face.curvature ** 2 * r * r,
      domain = 1 - product
    const error = Number.EPSILON * 16 * (1 + Math.abs(product)) + Number.MIN_VALUE
    if (!Number.isFinite(domain) || domain - error <= 0)
      throw new Error('Asphere conic domain cannot be certified over the aperture.')
    const numerator = face.curvature * r * r,
      numeratorError = Number.EPSILON * 8 * Math.abs(numerator) + Number.MIN_VALUE
    const candidates = [
      (numerator - numeratorError) / (1 + Math.sqrt(domain - error)),
      (numerator - numeratorError) / (1 + Math.sqrt(domain + error)),
      (numerator + numeratorError) / (1 + Math.sqrt(domain - error)),
      (numerator + numeratorError) / (1 + Math.sqrt(domain + error)),
    ]
    const padding = Number.EPSILON * 8 * Math.max(...candidates.map(Math.abs)) + Number.MIN_VALUE
    return [Math.min(...candidates) - padding, Math.max(...candidates) + padding]
  }
  const first = conic(low),
    last = conic(high)
  let lower = Math.min(first[0], last[0]),
    upper = Math.max(first[1], last[1])
  for (const term of face.coefficients) {
    const a = term.value * low ** term.order,
      b = term.value * high ** term.order
    const error =
      Number.EPSILON * 32 * (term.order + 1) * (Math.abs(a) + Math.abs(b) + Math.abs(lower) + Math.abs(upper)) +
      Number.MIN_VALUE
    lower += Math.min(a, b) - error
    upper += Math.max(a, b) + error
  }
  if (!Number.isFinite(lower) || !Number.isFinite(upper))
    throw new Error('Asphere interval exceeds finite numerical range.')
  return [lower, upper]
}

export function normalizeContinuousPrimitive(
  kind: ContinuousPrimitive,
  props: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of ['zMin', 'zMax', 'kind', 'focalLengths'])
    if (props[key] !== undefined) throw new Error(`${kind} does not support ${key}.`)
  if (kind === 'asphericCylinder') {
    const radius = positive(props.radius, 'radius'),
      centerThickness = positive(props.centerThickness, 'centerThickness')
    const top = normalizeAsphere(props.top, radius),
      bottom = normalizeAsphere(props.bottom, radius)
    const pending: [number, number, number][] = [[0, radius, 0]]
    let visits = 0
    while (pending.length) {
      const [lo, hi, depth] = pending.pop()!
      const t = sagBounds(top, lo, hi),
        b = sagBounds(bottom, lo, hi)
      const margin =
        Number.EPSILON *
        64 *
        (centerThickness + Math.max(Math.abs(t[0]), Math.abs(t[1])) + Math.max(Math.abs(b[0]), Math.abs(b[1])))
      if (centerThickness + t[0] - b[1] > margin) continue
      const mid = (lo + hi) / 2
      if ([lo, mid, hi].some((r) => centerThickness + sag(top, r).value - sag(bottom, r).value <= 0))
        throw new Error('AsphericCylinder surfaces intersect or touch.')
      if (++visits > 100000 || depth >= 48)
        throw new Error('AsphericCylinder positive thickness could not be certified over the full aperture.')
      pending.push([lo, mid, depth + 1], [mid, hi, depth + 1])
    }
    return { radius, centerThickness, top, bottom }
  }
  if (kind === 'paraboloid')
    return { focalLength: positive(props.focalLength, 'focalLength'), radius: positive(props.radius, 'radius') }
  const axialRadius = positive(props.axialRadius, 'axialRadius')
  const focalDistance = props.focalDistance as number
  if (
    !Number.isFinite(focalDistance) ||
    focalDistance < 0 ||
    (kind === 'ellipsoid' ? focalDistance >= axialRadius : focalDistance <= axialRadius)
  )
    throw new Error(`Invalid ${kind} focalDistance/axialRadius.`)
  return { focalDistance, axialRadius, ...(kind === 'hyperboloid' ? { radius: positive(props.radius, 'radius') } : {}) }
}

// u is polar angle / pi for Ellipsoid, radial fraction otherwise; v is azimuth.
export function evaluateContinuousSurface(
  kind: ContinuousPrimitive,
  parameters: Record<string, unknown>,
  surface: number,
  u: number,
  v: number,
): SurfaceEvaluation {
  const p = parameters as Record<string, number> & { top: Asphere; bottom: Asphere }
  const valid = kind === 'ellipsoid' ? [0] : kind === 'asphericCylinder' ? [0, 1, 2] : [1, 2]
  if (!valid.includes(surface) || !Number.isFinite(u) || u < 0 || u > 1 || !Number.isFinite(v))
    throw new Error('Invalid continuous surface coordinates.')
  const cos = Math.cos(v),
    sin = Math.sin(v)
  let dr = p.radius,
    dz = 0
  let radius = p.radius * u,
    z: number,
    normal: [number, number, number]
  if (kind === 'ellipsoid') {
    const b = Math.sqrt((p.axialRadius - p.focalDistance) * (p.axialRadius + p.focalDistance))
    radius = b * Math.sin(Math.PI * u)
    z = -p.axialRadius * Math.cos(Math.PI * u)
    dr = b * Math.PI * Math.cos(Math.PI * u)
    dz = p.axialRadius * Math.PI * Math.sin(Math.PI * u)
    normal = [(radius * cos) / b ** 2, (radius * sin) / b ** 2, z / p.axialRadius ** 2]
  } else if (kind === 'asphericCylinder') {
    if (surface === 1) {
      radius = p.radius
      const lo = -p.centerThickness / 2 + sag(p.bottom, radius).value
      const hi = p.centerThickness / 2 + sag(p.top, radius).value
      z = u === 1 ? hi : lo + (hi - lo) * u
      normal = [cos, sin, 0]
      dr = 0
      dz = hi - lo
    } else {
      const result = sag(surface === 0 ? p.bottom : p.top, radius),
        sign = surface === 0 ? -1 : 1
      z = (sign * p.centerThickness) / 2 + result.value
      normal = [-sign * result.derivative * cos, -sign * result.derivative * sin, sign]
      dz = result.derivative * p.radius
    }
  } else {
    const b2 = (p.focalDistance - p.axialRadius) * (p.focalDistance + p.axialRadius)
    const height = (r: number) =>
      kind === 'paraboloid' ? (r * r) / (4 * p.focalLength) : p.axialRadius * Math.sqrt(1 + (r * r) / b2)
    z = height(surface === 2 ? p.radius : radius)
    normal =
      surface === 2
        ? [0, 0, 1]
        : kind === 'paraboloid'
          ? [(radius * cos) / (2 * p.focalLength), (radius * sin) / (2 * p.focalLength), -1]
          : [(radius * cos) / b2, (radius * sin) / b2, -z / p.axialRadius ** 2]
    if (surface !== 2)
      dz = p.radius * (kind === 'paraboloid' ? radius / (2 * p.focalLength) : (p.axialRadius ** 2 * radius) / (b2 * z))
  }
  const length = Math.hypot(...normal)
  return {
    position: [radius * cos, radius * sin, z],
    normal: normal.map((x) => x / length) as [number, number, number],
    derivativeU: [dr * cos, dr * sin, dz],
    derivativeV: [-radius * sin, radius * cos, 0],
  }
}

export function scaleContinuousParameters(kind: ContinuousPrimitive, parameters: Record<string, unknown>, q: number) {
  positive(q, 'Length conversion factor')
  const result = { ...parameters }
  for (const key of ['radius', 'centerThickness', 'axialRadius', 'focalDistance', 'focalLength'])
    if (key in result) result[key] = (result[key] as number) * q
  if (kind === 'asphericCylinder')
    for (const key of ['top', 'bottom']) {
      const face = result[key] as Asphere
      result[key] = {
        curvature: face.curvature / q,
        conic: face.conic,
        coefficients: face.coefficients.map((term) => ({
          order: term.order,
          value: term.value * q ** (1 - term.order),
        })),
      }
    }
  return result
}

export function transformSurface(value: SurfaceEvaluation, matrix: readonly number[]): SurfaceEvaluation {
  const [a, b, c, , d, e, f, , g, h, i] = matrix
  const cofactors = [
    e * i - f * h,
    f * g - d * i,
    d * h - e * g,
    c * h - b * i,
    a * i - c * g,
    b * g - a * h,
    b * f - c * e,
    c * d - a * f,
    a * e - b * d,
  ]
  const determinant = a * cofactors[0] + b * cofactors[1] + c * cofactors[2]
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error('Singular surface transform.')
  const normal = [0, 1, 2].map(
    (row) => value.normal.reduce((sum, x, j) => sum + cofactors[row * 3 + j] * x, 0) / determinant,
  )
  const length = Math.hypot(...normal)
  const vector = (v: Vec3) =>
    [0, 1, 2].map((row) => v.reduce((sum, x, j) => sum + matrix[row * 4 + j] * x, 0)) as [number, number, number]
  const position = vector(value.position).map((x, j) => x + matrix[j * 4 + 3]) as [number, number, number]
  return {
    position,
    normal: normal.map((x) => x / length) as [number, number, number],
    derivativeU: vector(value.derivativeU),
    derivativeV: vector(value.derivativeV),
  }
}

export function tessellateContinuousPrimitive(
  kind: ContinuousPrimitive,
  parameters: Record<string, unknown>,
  settings: Tessellation = {},
): IndexedSurface {
  const count = subdivisions(settings.radialSegments, 64),
    steps = subdivisions(settings.meridianSegments, 32, 2)
  const mesh: IndexedSurface = { points: [], triangles: [], surfaceIndices: [] }
  const points = new Map<string, number>()
  const vertex = (surface: number, u: number, i: number) => {
    const p = evaluateContinuousSurface(kind, parameters, surface, u, (2 * Math.PI * i) / count).position as [
      number,
      number,
      number,
    ]
    if (
      (u === 0 && surface !== 1) ||
      (kind === 'ellipsoid' && (u === 0 || u === 1)) ||
      ((kind === 'hyperboloid' || kind === 'paraboloid') && u === 0)
    )
      p[0] = p[1] = 0
    const key = p.join(',')
    let id = points.get(key)
    if (id === undefined) {
      id = mesh.points.length
      mesh.points.push(p)
      points.set(key, id)
    }
    return id
  }
  const patch = (surface: number, reversed: boolean, meridians: number) => {
    const rings = Array.from({ length: meridians + 1 }, (_, j) =>
      Array.from({ length: count }, (_, i) => vertex(surface, j / meridians, i)),
    )
    for (let j = 0; j < meridians; j++)
      for (let i = 0; i < count; i++) {
        const n = (i + 1) % count,
          a = rings[j][i],
          b = rings[j][n],
          c = rings[j + 1][n],
          d = rings[j + 1][i]
        for (const face of [
          [a, b, c],
          [a, c, d],
        ]) {
          if (new Set(face).size < 3) continue
          mesh.triangles.push((reversed ? face.reverse() : face) as [number, number, number])
          mesh.surfaceIndices.push(surface)
        }
      }
  }
  if (kind === 'ellipsoid') patch(0, false, steps)
  else if (kind === 'asphericCylinder') {
    patch(0, false, steps)
    patch(1, false, 1)
    patch(2, true, steps)
  } else {
    patch(1, false, steps)
    patch(2, true, 1)
  }
  return mesh
}

export function indexedGeometry(mesh: IndexedSurface) {
  return geometries.geom3.create(mesh.triangles.map((face) => geometries.poly3.create(face.map((i) => mesh.points[i]))))
}

export function indexedSurfaces(mesh: IndexedSurface, labels: Readonly<Record<number, string>>) {
  return Object.entries(labels)
    .map(([key, label]) => ({
      surfaceIndex: Number(key),
      label,
      polygonIndices: mesh.surfaceIndices.flatMap((index, i) => (index === Number(key) ? [i] : [])),
    }))
    .filter((surface) => surface.polygonIndices.length)
}
