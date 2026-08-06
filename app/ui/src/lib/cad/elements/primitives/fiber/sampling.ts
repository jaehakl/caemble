import { CadModelError } from '../../../model/core'
import { createBishopFrames, type BishopFrame } from '../../../geometry/bishopFrame'
import { resamplePolyline } from '../../../geometry/polyline'
import { interpolate, parseVec3, subtract, vectorLength, type MutableVec3 } from '../../../geometry/vec3'
import type { FiberAttributes, FiberFourierMode, FiberHelix } from './definition'

export type SampledFiber = {
  points: MutableVec3[]
  radii: number[]
  frames: BishopFrame[]
  radialSegments: number
}

const tau = Math.PI * 2
const defaultPathSegments = 128
const defaultRadialSegments = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateSegments(value: unknown, path: string, fallback: number, minimum: number, maximum: number) {
  const segments = value === undefined ? fallback : value
  if (!Number.isSafeInteger(segments) || (segments as number) < minimum || (segments as number) > maximum) {
    throw new CadModelError(`${path} must be an integer from ${minimum} to ${maximum}.`)
  }
  return segments as number
}

function validateHelix(value: unknown): FiberHelix | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new CadModelError('<fiber> helix must be an object.')
  if (typeof value.turns !== 'number' || !Number.isFinite(value.turns)) {
    throw new CadModelError('<fiber> helix.turns must be a finite number.')
  }

  const phase = value.phase === undefined ? 0 : value.phase
  if (typeof phase !== 'number' || !Number.isFinite(phase)) {
    throw new CadModelError('<fiber> helix.phase must be a finite number.')
  }
  if (typeof value.radius !== 'number' && typeof value.radius !== 'function') {
    throw new CadModelError('<fiber> helix.radius must be a finite non-negative number or a function.')
  }
  if (typeof value.radius === 'number' && (!Number.isFinite(value.radius) || value.radius < 0)) {
    throw new CadModelError('<fiber> helix.radius must be a finite non-negative number or a function.')
  }
  return { turns: value.turns, phase, radius: value.radius as FiberHelix['radius'] }
}

function validateFourier(value: unknown): readonly FiberFourierMode[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0) {
    throw new CadModelError('<fiber> fourier must be a non-empty array of amplitude and phase modes.')
  }

  return value.map((mode, index) => {
    if (!isRecord(mode)) throw new CadModelError(`<fiber> fourier[${index}] must be an object.`)
    if (typeof mode.amplitude !== 'number' || !Number.isFinite(mode.amplitude) || mode.amplitude < 0) {
      throw new CadModelError(`<fiber> fourier[${index}].amplitude must be a finite non-negative number.`)
    }
    if (typeof mode.phase !== 'number' || !Number.isFinite(mode.phase)) {
      throw new CadModelError(`<fiber> fourier[${index}].phase must be a finite number.`)
    }
    return { amplitude: mode.amplitude, phase: mode.phase }
  })
}

export function sampleFiber(attributes: FiberAttributes): SampledFiber {
  const from = parseVec3(attributes.from, '<fiber> from')
  const to = parseVec3(attributes.to, '<fiber> to')
  const chordLength = vectorLength(subtract(to, from))
  if (chordLength <= Math.max(1, ...from.map(Math.abs), ...to.map(Math.abs)) * 1e-10) {
    throw new CadModelError('<fiber> from and to must be distinct points.')
  }
  if (attributes.basePath !== undefined && typeof attributes.basePath !== 'function') {
    throw new CadModelError('<fiber> basePath must be a function.')
  }
  if (typeof attributes.radius !== 'number' && typeof attributes.radius !== 'function') {
    throw new CadModelError('<fiber> radius must be a positive finite number or a function.')
  }

  const pathSegments = validateSegments(attributes.pathSegments, '<fiber> pathSegments', defaultPathSegments, 8, 2048)
  const radialSegments = validateSegments(
    attributes.radialSegments,
    '<fiber> radialSegments',
    defaultRadialSegments,
    3,
    64,
  )
  const envelopePower = attributes.envelopePower === undefined ? 2 : attributes.envelopePower
  if (typeof envelopePower !== 'number' || !Number.isFinite(envelopePower) || envelopePower < 1) {
    throw new CadModelError('<fiber> envelopePower must be a finite number greater than or equal to 1.')
  }

  const helix = validateHelix(attributes.helix)
  const fourier = validateFourier(attributes.fourier)
  const constructionSegments = pathSegments * 4
  const rawBasePoints = Array.from({ length: constructionSegments + 1 }, (_, index) => {
    const t = index / constructionSegments
    return parseVec3(attributes.basePath?.(t) ?? interpolate(from, to, t), `<fiber> basePath(${t})`)
  })
  const endpointTolerance = Math.max(1, chordLength) * 1e-6
  if (vectorLength(subtract(rawBasePoints[0], from)) > endpointTolerance) {
    throw new CadModelError('<fiber> basePath(0) must match from.')
  }
  if (vectorLength(subtract(rawBasePoints[rawBasePoints.length - 1], to)) > endpointTolerance) {
    throw new CadModelError('<fiber> basePath(1) must match to.')
  }

  rawBasePoints[0] = from
  rawBasePoints[rawBasePoints.length - 1] = to
  const basePoints = resamplePolyline(rawBasePoints, constructionSegments, '<fiber> basePath')
  const baseFrames = createBishopFrames(basePoints, attributes.up, '<fiber> basePath')
  const displacedPoints = basePoints.map((point, index) => {
    const u = index / constructionSegments
    const theta = tau * (helix?.turns ?? 0) * u + (helix?.phase ?? 0)
    const helixRadius =
      helix === undefined ? 0 : typeof helix.radius === 'function' ? helix.radius(u, theta) : helix.radius
    if (typeof helixRadius !== 'number' || !Number.isFinite(helixRadius) || helixRadius < 0) {
      throw new CadModelError(`<fiber> helix.radius returned an invalid value at u=${u}.`)
    }

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
    const radius = typeof attributes.radius === 'function' ? attributes.radius(s) : attributes.radius
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
      throw new CadModelError(`<fiber> radius must return a positive finite number at s=${s}.`)
    }
    return radius
  })

  return { points, radii, frames, radialSegments }
}
