import { createBishopFrames, type BishopFrame } from '../../../geometry/bishopFrame'
import { resamplePolyline } from '../../../geometry/polyline'
import { interpolate, parseVec3, type MutableVec3 } from '../../../geometry/vec3'
import type { FiberAttributes } from './definition'

export type SampledFiber = {
  points: MutableVec3[]
  radii: number[]
  frames: BishopFrame[]
  radialSegments: number
}

const tau = Math.PI * 2
const defaultPathSegments = 128
const defaultRadialSegments = 12

export function sampleFiber(attributes: FiberAttributes): SampledFiber {
  const from = parseVec3(attributes.from, '<fiber> from')
  const to = parseVec3(attributes.to, '<fiber> to')
  const pathSegments = attributes.pathSegments ?? defaultPathSegments
  const radialSegments = attributes.radialSegments ?? defaultRadialSegments
  const envelopePower = attributes.envelopePower === undefined ? 2 : attributes.envelopePower

  const helix = attributes.helix
  const fourier = attributes.fourier ?? []
  const constructionSegments = pathSegments * 4
  const rawBasePoints = Array.from({ length: constructionSegments + 1 }, (_, index) => {
    const t = index / constructionSegments
    return parseVec3(attributes.basePath?.(t) ?? interpolate(from, to, t), `<fiber> basePath(${t})`)
  })
  rawBasePoints[0] = from
  rawBasePoints[rawBasePoints.length - 1] = to
  const basePoints = resamplePolyline(rawBasePoints, constructionSegments, '<fiber> basePath')
  const baseFrames = createBishopFrames(basePoints, attributes.up, '<fiber> basePath')
  const displacedPoints = basePoints.map((point, index) => {
    const u = index / constructionSegments
    const theta = tau * (helix?.turns ?? 0) * u + (helix?.phase ?? 0)
    const helixRadius =
      helix === undefined ? 0 : typeof helix.radius === 'function' ? helix.radius(u, theta) : helix.radius

    let real = helixRadius * Math.cos(theta)
    let imaginary = helixRadius * Math.sin(theta)
    fourier.forEach((mode, modeIndex) => {
      const modeAngle = tau * (modeIndex + 1) * u + mode.phase
      real -= mode.amplitude * Math.cos(modeAngle)
      imaginary -= mode.amplitude * Math.sin(modeAngle)
    })

    const envelope = index === 0 || index === constructionSegments ? 0 : Math.sin(Math.PI * u) ** envelopePower
    const frame = baseFrames[index]
    return [
      point[0] + envelope * (real * frame.normal[0] - imaginary * frame.binormal[0]),
      point[1] + envelope * (real * frame.normal[1] - imaginary * frame.binormal[1]),
      point[2] + envelope * (real * frame.normal[2] - imaginary * frame.binormal[2]),
    ] as MutableVec3
  })

  displacedPoints[0] = from
  displacedPoints[displacedPoints.length - 1] = to
  const points = resamplePolyline(displacedPoints, pathSegments, '<fiber> displaced centerline')
  const frames = createBishopFrames(points, attributes.up, '<fiber> displaced centerline')
  const radii = points.map((_point, index) => {
    const s = index / pathSegments
    return typeof attributes.radius === 'function' ? attributes.radius(s) : attributes.radius!
  })

  return { points, radii, frames, radialSegments }
}
