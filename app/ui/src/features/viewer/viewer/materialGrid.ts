// The development worker must not evaluate the compiler and runner exports from the CAD barrel.
// eslint-disable-next-line no-restricted-imports
import type { CadScenePart } from '@/lib/cad/evaluation/types'
// eslint-disable-next-line no-restricted-imports
import { createSolidPointTester, type SolidPointTester } from '@/lib/cad/geometry/solid'
import { materialColor } from './materialColor'
import { colorFromHex } from './renderParts'

const defaultMaximumCandidatePoints = 100_000
type Vec3 = readonly [number, number, number]

type Bounds = readonly [Vec3, Vec3]

type PreparedPart = SolidPointTester &
  Readonly<{
    color: readonly [number, number, number, number]
  }>

export type MaterialGridResult = Readonly<{
  candidatePointCount: number
  colors: Float32Array
  effectiveSpacing: number
  positions: Float32Array
  requestedSpacing: number
  visiblePointCount: number
}>

export type MaterialGridWorkerRequest = Readonly<{
  parts: CadScenePart[]
  requestId: string
  requestedSpacing: number
}>

export type MaterialGridWorkerResponse =
  | Readonly<{
      requestId: string
      result: MaterialGridResult
      type: 'success'
    }>
  | Readonly<{
      message: string
      requestId: string
      type: 'error'
    }>

function preparePart(part: CadScenePart): PreparedPart | null {
  const color = materialColor(part.material)
  if (color === undefined) return null
  const solid = createSolidPointTester(part.geometry)
  if (!solid) return null

  return {
    ...solid,
    color: colorFromHex(color),
  }
}

function aggregateBounds(parts: readonly PreparedPart[]): Bounds {
  const minimum: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ]
  const maximum: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]

  for (const part of parts) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], part.bounds[0][axis])
      maximum[axis] = Math.max(maximum[axis], part.bounds[1][axis])
    }
  }
  return [minimum, maximum]
}

function gridIndexRange(minimum: number, maximum: number, spacing: number) {
  const scale = Math.max(1, Math.abs(minimum), Math.abs(maximum))
  const coordinateTolerance = Number.EPSILON * scale * 16
  const first = Math.ceil((minimum - coordinateTolerance) / spacing)
  const last = Math.floor((maximum + coordinateTolerance) / spacing)
  return { count: Math.max(0, last - first + 1), first, last }
}

function createGridRanges(bounds: Bounds, spacing: number) {
  return [
    gridIndexRange(bounds[0][0], bounds[1][0], spacing),
    gridIndexRange(bounds[0][1], bounds[1][1], spacing),
    gridIndexRange(bounds[0][2], bounds[1][2], spacing),
  ] as const
}

function countGridPoints(bounds: Bounds, spacing: number) {
  return createGridRanges(bounds, spacing).reduce((total, range) => total * range.count, 1)
}

function countGridPointUpperBound(bounds: Bounds, spacing: number) {
  return bounds[0].reduce((total, minimum, axis) => {
    const length = Math.max(0, bounds[1][axis] - minimum)
    const ratio = length / spacing
    const ratioTolerance = Number.EPSILON * Math.max(1, ratio) * 16
    return total * (Math.floor(ratio + ratioTolerance) + 1)
  }, 1)
}

function resolveEffectiveSpacing(bounds: Bounds, requestedSpacing: number, maximumCandidatePoints: number) {
  if (countGridPoints(bounds, requestedSpacing) <= maximumCandidatePoints) return requestedSpacing

  let lower = requestedSpacing
  let upper = requestedSpacing * 2
  while (countGridPointUpperBound(bounds, upper) > maximumCandidatePoints) {
    lower = upper
    upper *= 2
  }

  for (let iteration = 0; iteration < 60; iteration += 1) {
    const candidate = (lower + upper) / 2
    if (countGridPointUpperBound(bounds, candidate) > maximumCandidatePoints) {
      lower = candidate
    } else {
      upper = candidate
    }
  }

  return upper * (1 + Number.EPSILON * 8)
}

export function createMaterialGrid(
  parts: CadScenePart[],
  requestedSpacing: number,
  maximumCandidatePoints = defaultMaximumCandidatePoints,
): MaterialGridResult {
  if (!Number.isFinite(requestedSpacing) || requestedSpacing <= 0) {
    throw new Error('Material Grid spacing must be a positive finite number.')
  }
  if (!Number.isSafeInteger(maximumCandidatePoints) || maximumCandidatePoints <= 0) {
    throw new Error('Material Grid maximum candidate points must be a positive safe integer.')
  }

  const preparedParts = parts.map(preparePart).filter((part): part is PreparedPart => part !== null)
  if (preparedParts.length === 0) {
    return {
      candidatePointCount: 0,
      colors: new Float32Array(),
      effectiveSpacing: requestedSpacing,
      positions: new Float32Array(),
      requestedSpacing,
      visiblePointCount: 0,
    }
  }

  const bounds = aggregateBounds(preparedParts)
  const effectiveSpacing = resolveEffectiveSpacing(bounds, requestedSpacing, maximumCandidatePoints)
  const ranges = createGridRanges(bounds, effectiveSpacing)
  const candidatePointCount = ranges.reduce((total, range) => total * range.count, 1)
  const positions: number[] = []
  const colors: number[] = []

  for (let xIndex = ranges[0].first; xIndex <= ranges[0].last; xIndex += 1) {
    for (let yIndex = ranges[1].first; yIndex <= ranges[1].last; yIndex += 1) {
      for (let zIndex = ranges[2].first; zIndex <= ranges[2].last; zIndex += 1) {
        const point: Vec3 = [
          xIndex === 0 ? 0 : xIndex * effectiveSpacing,
          yIndex === 0 ? 0 : yIndex * effectiveSpacing,
          zIndex === 0 ? 0 : zIndex * effectiveSpacing,
        ]
        let materialPart: PreparedPart | undefined
        for (let partIndex = preparedParts.length - 1; partIndex >= 0; partIndex -= 1) {
          if (preparedParts[partIndex].contains(point)) {
            materialPart = preparedParts[partIndex]
            break
          }
        }
        if (!materialPart) continue

        positions.push(...point)
        colors.push(...materialPart.color)
      }
    }
  }

  return {
    candidatePointCount,
    colors: new Float32Array(colors),
    effectiveSpacing,
    positions: new Float32Array(positions),
    requestedSpacing,
    visiblePointCount: positions.length / 3,
  }
}
