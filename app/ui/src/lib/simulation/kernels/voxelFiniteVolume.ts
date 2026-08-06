import { geometries, measurements } from '@jscad/modeling'
import type { CadScenePart, CadSceneSurface } from '../../cad/evaluation/types'
import { createSolidPointTester } from '../../cad/geometry/solid'
import { CadModelError, type DataValueDescriptor } from '../../cad/model/core'
import type { Vec3 } from '../../cad/model/types'
import type { UcumUnit } from '../../cad/model/units'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { transformQuantityValue } from '../../quantitykind/runtime'
import type { KernelExecutionContext } from '../kernelContract'

const neighborOffsets = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
] as const

export const maximumVoxelCount = 250_000

export type VoxelTerminal = Readonly<{
  part: CadScenePart
  surface: CadSceneSurface
}>

export type TerminalVoxelDomain = Readonly<{
  frame: Readonly<{
    axis: Vec3
    length: number
    maximumU: number
    maximumV: number
    minimumU: number
    minimumV: number
    origin: Vec3
    uAxis: Vec3
    vAxis: Vec3
  }>
  grid: Readonly<{
    axialSpacing: number
    occupancy: Uint8Array
    occupiedCount: number
    uSpacing: number
    vSpacing: number
  }>
  shape: readonly [number, number, number]
}>

export type ScalarVoxelSystem = Readonly<{
  activeCells: Int32Array
  activeIndex: Int32Array
  diagonal: Float64Array
  initial: Float64Array
  neighborWeights: readonly number[]
  neighbors: Int32Array
  rightHandSide: Float64Array
}>

export function isotropicIdentityTensorValue(value: unknown, path: string, unit: UcumUnit) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray((value as { value?: unknown }).value)
  ) {
    throw new CadModelError(`${path} must provide a tensor with component shape [3,3].`)
  }
  const descriptor = value as DataValueDescriptor
  const transformed = transformQuantityValue(
    descriptor.value,
    [3, 3],
    { unit: descriptor.unit!, basis: descriptor.basis },
    { unit, basis: identityCartesianBasis },
    `${path}.value`,
  ) as readonly (readonly number[])[]
  const diagonal = [transformed[0][0], transformed[1][1], transformed[2][2]]
  if (diagonal.some((component) => !Number.isFinite(component) || component <= 0)) {
    throw new CadModelError(`${path} must have positive finite diagonal components.`)
  }
  const scale = Math.max(...diagonal)
  const tolerance = 1e-12 + Number.EPSILON
  if (diagonal.some((component) => Math.abs(component - diagonal[0]) / scale > tolerance)) {
    throw new CadModelError(`${path} must be isotropic; diagonal components differ beyond relative tolerance 1e-12.`)
  }
  transformed.forEach((row, rowIndex) =>
    row.forEach((component, columnIndex) => {
      if (rowIndex !== columnIndex && Math.abs(component) / scale > tolerance) {
        throw new CadModelError(`${path} must be isotropic; off-diagonal components exceed relative tolerance 1e-12.`)
      }
    }),
  )
  return (diagonal[0] + diagonal[1] + diagonal[2]) / 3
}

function abortError() {
  const error = new Error('Solver run was cancelled.')
  error.name = 'AbortError'
  return error
}

export function throwIfSolverAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError()
}

async function yieldToWorker(signal: AbortSignal) {
  throwIfSolverAborted(signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  throwIfSolverAborted(signal)
}

function add(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

function scale(vector: Vec3, factor: number): Vec3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

function dot(left: Vec3, right: Vec3) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]
}

function normalize(vector: Vec3, message: string): Vec3 {
  const length = Math.hypot(...vector)
  if (!Number.isFinite(length) || length <= 0) throw new CadModelError(message)
  return scale(vector, 1 / length)
}

function planarSurface(part: CadScenePart, surface: CadSceneSurface, label: string) {
  if (!geometries.geom3.isA(part.geometry)) {
    throw new CadModelError(`${label} ${part.id} must be a 3D solid.`)
  }
  const polygons = geometries.geom3.toPolygons(part.geometry)
  const firstPolygon = polygons[surface.polygonIndices[0]]
  if (!firstPolygon) throw new CadModelError(`Surface ${surface.id} has no polygons.`)
  const plane = geometries.poly3.plane(firstPolygon)
  const tolerance = Math.max(measurements.measureEpsilon(part.geometry) * 10, 1e-9)
  const points: Vec3[] = []
  const weightedCenter: [number, number, number] = [0, 0, 0]
  let totalArea = 0
  surface.polygonIndices.forEach((polygonIndex) => {
    const polygon = polygons[polygonIndex]
    if (!polygon) throw new CadModelError(`Surface ${surface.id} references a missing polygon.`)
    const polygonPoints = geometries.poly3.toPoints(polygon) as Vec3[]
    points.push(...polygonPoints)
    const anchor = polygonPoints[0]
    for (let index = 1; index < polygonPoints.length - 1; index += 1) {
      const second = polygonPoints[index]
      const third = polygonPoints[index + 1]
      const area = Math.hypot(...cross(subtract(second, anchor), subtract(third, anchor))) / 2
      const triangleCenter = scale(add(add(anchor, second), third), 1 / 3)
      weightedCenter[0] += triangleCenter[0] * area
      weightedCenter[1] += triangleCenter[1] * area
      weightedCenter[2] += triangleCenter[2] * area
      totalArea += area
    }
  })
  if (points.length === 0 || !Number.isFinite(totalArea) || totalArea <= 0) {
    throw new CadModelError(`Surface ${surface.id} has no positive-area polygon points.`)
  }
  if (
    points.some(
      (point) => Math.abs(plane[0] * point[0] + plane[1] * point[1] + plane[2] * point[2] - plane[3]) > tolerance,
    )
  ) {
    throw new CadModelError(`${label} terminal Surface ${surface.id} must be planar.`)
  }
  return {
    center: scale(weightedCenter, 1 / totalArea),
    normal: normalize([plane[0], plane[1], plane[2]], `Surface ${surface.id} has an invalid normal.`),
    polygonIndices: surface.polygonIndices,
    surfaceId: surface.id,
  }
}

function localPoint(frame: TerminalVoxelDomain['frame'], s: number, u: number, v: number): Vec3 {
  return add(add(add(frame.origin, scale(frame.axis, s)), scale(frame.uAxis, u)), scale(frame.vAxis, v))
}

function createFrame(
  part: CadScenePart,
  source: ReturnType<typeof planarSurface>,
  reference: ReturnType<typeof planarSurface>,
  label: string,
): TerminalVoxelDomain['frame'] {
  if (!geometries.geom3.isA(part.geometry)) {
    throw new CadModelError(`${label} ${part.id} must be a 3D solid.`)
  }
  const displacement = subtract(reference.center, source.center)
  const axis = normalize(displacement, `${label} terminal centers must have a finite positive separation.`)
  const length = Math.hypot(...displacement)
  const terminalNormalDot = dot(source.normal, reference.normal)
  if (terminalNormalDot > -1 + 1e-7 || dot(source.normal, axis) > -1 + 1e-7 || dot(reference.normal, axis) < 1 - 1e-7) {
    throw new CadModelError(`${label} terminal surfaces must be parallel, opposite, and normal to their center axis.`)
  }

  const projectedY = subtract([0, 1, 0], scale(axis, dot([0, 1, 0], axis)))
  const projectedZ = subtract([0, 0, 1], scale(axis, dot([0, 0, 1], axis)))
  const uAxis = normalize(
    Math.hypot(...projectedY) > 1e-8 ? projectedY : projectedZ,
    `${label} terminal axis could not define a cross-section basis.`,
  )
  const vAxis = normalize(cross(axis, uAxis), `${label} terminal axis could not define a cross-section basis.`)
  const origin = scale(add(source.center, reference.center), 0.5)
  const polygons = geometries.geom3.toPolygons(part.geometry)
  const vertices = polygons.flatMap((polygon) => geometries.poly3.toPoints(polygon))
  let minimumU = Number.POSITIVE_INFINITY
  let maximumU = Number.NEGATIVE_INFINITY
  let minimumV = Number.POSITIVE_INFINITY
  let maximumV = Number.NEGATIVE_INFINITY
  const minimumS = -length / 2
  const maximumS = length / 2
  const axialTolerance = Math.max(measurements.measureEpsilon(part.geometry) * 20, length * 1e-8)

  vertices.forEach((vertex) => {
    const offset = subtract(vertex as Vec3, origin)
    const s = dot(offset, axis)
    if (s < minimumS - axialTolerance || s > maximumS + axialTolerance) {
      throw new CadModelError(`${label} Geometry must remain between its two terminal planes.`)
    }
    const u = dot(offset, uAxis)
    const v = dot(offset, vAxis)
    minimumU = Math.min(minimumU, u)
    maximumU = Math.max(maximumU, u)
    minimumV = Math.min(minimumV, v)
    maximumV = Math.max(maximumV, v)
  })
  ;[
    { terminal: source, terminalLabel: 'source' },
    { terminal: reference, terminalLabel: 'reference' },
  ].forEach(({ terminal, terminalLabel }) => {
    const selectedPolygons = new Set(terminal.polygonIndices)
    polygons.forEach((polygon, polygonIndex) => {
      const liesOnTerminalPlane = geometries.poly3
        .toPoints(polygon)
        .every((point) => Math.abs(dot(subtract(point as Vec3, terminal.center), terminal.normal)) <= axialTolerance)
      if (liesOnTerminalPlane && !selectedPolygons.has(polygonIndex)) {
        throw new CadModelError(
          `${label} ${terminalLabel} terminal Surface ${terminal.surfaceId} must cover the complete end plane.`,
        )
      }
    })
  })
  if (
    !Number.isFinite(maximumU - minimumU) ||
    !Number.isFinite(maximumV - minimumV) ||
    maximumU <= minimumU ||
    maximumV <= minimumV
  ) {
    throw new CadModelError(`${label} cross-section bounds must be finite and positive.`)
  }

  return { axis, length, maximumU, maximumV, minimumU, minimumV, origin, uAxis, vAxis }
}

export function voxelIndex(i: number, j: number, k: number, shape: readonly [number, number, number]) {
  return (i * shape[1] + j) * shape[2] + k
}

async function buildOccupancy(
  part: CadScenePart,
  frame: TerminalVoxelDomain['frame'],
  shape: readonly [number, number, number],
  context: KernelExecutionContext,
  label: string,
) {
  const tester = createSolidPointTester(part.geometry)
  if (!tester) throw new CadModelError(`${label} ${part.id} must be a valid 3D solid.`)
  const [axialCount, uCount, vCount] = shape
  const axialSpacing = frame.length / axialCount
  const uSpacing = (frame.maximumU - frame.minimumU) / uCount
  const vSpacing = (frame.maximumV - frame.minimumV) / vCount
  const occupancy = new Uint8Array(axialCount * uCount * vCount)
  let occupiedCount = 0

  for (let i = 0; i < axialCount; i += 1) {
    const s = -frame.length / 2 + (i + 0.5) * axialSpacing
    for (let j = 0; j < uCount; j += 1) {
      const u = frame.minimumU + (j + 0.5) * uSpacing
      for (let k = 0; k < vCount; k += 1) {
        const v = frame.minimumV + (k + 0.5) * vSpacing
        const index = voxelIndex(i, j, k, shape)
        if (tester.contains(localPoint(frame, s, u, v))) {
          occupancy[index] = 1
          occupiedCount += 1
        }
        if ((index + 1) % 4096 === 0) {
          context.reportProgress({ stage: 'occupancy', completed: index + 1, total: occupancy.length })
          await yieldToWorker(context.signal)
        }
      }
    }
  }
  if (occupiedCount === 0) throw new CadModelError(`${label} did not occupy any finite-volume cells.`)
  context.reportProgress({ stage: 'occupancy', completed: occupancy.length, total: occupancy.length })
  return { axialSpacing, occupancy, occupiedCount, uSpacing, vSpacing }
}

async function validateConnectedDomain(
  grid: TerminalVoxelDomain['grid'],
  shape: readonly [number, number, number],
  context: KernelExecutionContext,
  label: string,
) {
  const { occupancy, occupiedCount } = grid
  const [axialCount, uCount, vCount] = shape
  const sourceCells: number[] = []
  const referenceCells: number[] = []
  for (let j = 0; j < uCount; j += 1) {
    for (let k = 0; k < vCount; k += 1) {
      const sourceIndex = voxelIndex(0, j, k, shape)
      const referenceIndex = voxelIndex(axialCount - 1, j, k, shape)
      if (occupancy[sourceIndex]) sourceCells.push(sourceIndex)
      if (occupancy[referenceIndex]) referenceCells.push(referenceIndex)
    }
  }
  if (sourceCells.length === 0 || referenceCells.length === 0) {
    throw new CadModelError(`${label} grid must contain occupied cells at both terminal planes.`)
  }

  const visited = new Uint8Array(occupancy.length)
  const queue = new Int32Array(occupiedCount)
  let head = 0
  let tail = 1
  let visitedCount = 1
  queue[0] = sourceCells[0]
  visited[sourceCells[0]] = 1
  while (head < tail) {
    const index = queue[head]
    head += 1
    const k = index % vCount
    const j = Math.floor(index / vCount) % uCount
    const i = Math.floor(index / (uCount * vCount))
    for (const [di, dj, dk] of neighborOffsets) {
      const ni = i + di
      const nj = j + dj
      const nk = k + dk
      if (ni < 0 || ni >= axialCount || nj < 0 || nj >= uCount || nk < 0 || nk >= vCount) continue
      const neighbor = voxelIndex(ni, nj, nk, shape)
      if (!occupancy[neighbor] || visited[neighbor]) continue
      visited[neighbor] = 1
      queue[tail] = neighbor
      tail += 1
      visitedCount += 1
    }
    if (head % 8192 === 0) {
      context.reportProgress({ stage: 'connectivity', completed: head, total: occupiedCount })
      await yieldToWorker(context.signal)
    }
  }
  if (visitedCount !== occupiedCount || referenceCells.every((index) => !visited[index])) {
    throw new CadModelError(`${label} finite-volume cells must form one connected domain between both terminals.`)
  }
  context.reportProgress({ stage: 'connectivity', completed: occupiedCount, total: occupiedCount })
}

export async function buildTerminalVoxelDomain(
  part: CadScenePart,
  sourceTerminal: VoxelTerminal,
  referenceTerminal: VoxelTerminal,
  shape: readonly [number, number, number],
  context: KernelExecutionContext,
  label: string,
): Promise<TerminalVoxelDomain> {
  const source = planarSurface(sourceTerminal.part, sourceTerminal.surface, label)
  const reference = planarSurface(referenceTerminal.part, referenceTerminal.surface, label)
  const frame = createFrame(part, source, reference, label)
  const grid = await buildOccupancy(part, frame, shape, context, label)
  await validateConnectedDomain(grid, shape, context, label)
  return Object.freeze({ frame, grid, shape })
}

export function createScalarVoxelSystem(
  domain: TerminalVoxelDomain,
  sourceValue: number,
  referenceValue: number,
  volumeSource?: Float64Array,
): ScalarVoxelSystem {
  const { occupancy } = domain.grid
  const { shape } = domain
  if (volumeSource && volumeSource.length !== occupancy.length) {
    throw new CadModelError('Finite-volume source length must match the voxel grid.')
  }
  const activeIndex = new Int32Array(occupancy.length)
  activeIndex.fill(-1)
  const activeCells = new Int32Array(domain.grid.occupiedCount)
  let activeCount = 0
  occupancy.forEach((occupied, index) => {
    if (!occupied) return
    activeIndex[index] = activeCount
    activeCells[activeCount] = index
    activeCount += 1
  })

  const [axialCount, uCount, vCount] = shape
  const spacings = [domain.grid.axialSpacing, domain.grid.uSpacing, domain.grid.vSpacing]
  const weights = spacings.map((spacing) => 1 / (spacing * spacing))
  const neighborWeights = [weights[0], weights[0], weights[1], weights[1], weights[2], weights[2]]
  const neighbors = new Int32Array(activeCount * neighborOffsets.length)
  neighbors.fill(-1)
  const diagonal = new Float64Array(activeCount)
  const rightHandSide = new Float64Array(activeCount)
  const initial = new Float64Array(activeCount)

  activeCells.forEach((index, active) => {
    const k = index % vCount
    const j = Math.floor(index / vCount) % uCount
    const i = Math.floor(index / (uCount * vCount))
    initial[active] = sourceValue + (referenceValue - sourceValue) * ((i + 0.5) / axialCount)
    if (volumeSource) rightHandSide[active] = volumeSource[index]
    neighborOffsets.forEach(([di, dj, dk], neighborSlot) => {
      const ni = i + di
      const nj = j + dj
      const nk = k + dk
      if (ni < 0 || ni >= axialCount || nj < 0 || nj >= uCount || nk < 0 || nk >= vCount) return
      const neighborGlobal = voxelIndex(ni, nj, nk, shape)
      if (!occupancy[neighborGlobal]) return
      diagonal[active] += neighborWeights[neighborSlot]
      neighbors[active * neighborOffsets.length + neighborSlot] = activeIndex[neighborGlobal]
    })
    if (i === 0) {
      diagonal[active] += 2 * weights[0]
      rightHandSide[active] += 2 * weights[0] * sourceValue
    }
    if (i === axialCount - 1) {
      diagonal[active] += 2 * weights[0]
      rightHandSide[active] += 2 * weights[0] * referenceValue
    }
    if (!Number.isFinite(diagonal[active]) || diagonal[active] <= 0) {
      throw new CadModelError('Finite-volume matrix contains an isolated cell.')
    }
  })

  return { activeCells, activeIndex, diagonal, initial, neighborWeights, neighbors, rightHandSide }
}

function applyMatrix(system: ScalarVoxelSystem, input: Float64Array, output: Float64Array) {
  const { diagonal, neighbors, neighborWeights } = system
  for (let index = 0; index < input.length; index += 1) {
    let value = diagonal[index] * input[index]
    for (let slot = 0; slot < neighborOffsets.length; slot += 1) {
      const neighbor = neighbors[index * neighborOffsets.length + slot]
      if (neighbor >= 0) value -= neighborWeights[slot] * input[neighbor]
    }
    output[index] = value
  }
}

export async function solveScalarVoxelSystem(
  system: ScalarVoxelSystem,
  relativeTolerance: number,
  maxIterations: number,
  context: KernelExecutionContext,
  label: string,
) {
  const { diagonal, initial, rightHandSide } = system
  const solution = initial
  const residual = new Float64Array(solution.length)
  const preconditioned = new Float64Array(solution.length)
  const direction = new Float64Array(solution.length)
  const product = new Float64Array(solution.length)
  applyMatrix(system, solution, product)
  let rightHandSideNormSquared = 0
  let residualNormSquared = 0
  let residualPreconditioned = 0
  for (let index = 0; index < solution.length; index += 1) {
    residual[index] = rightHandSide[index] - product[index]
    preconditioned[index] = residual[index] / diagonal[index]
    direction[index] = preconditioned[index]
    rightHandSideNormSquared += rightHandSide[index] ** 2
    residualNormSquared += residual[index] ** 2
    residualPreconditioned += residual[index] * preconditioned[index]
  }
  const rightHandSideNorm = Math.sqrt(rightHandSideNormSquared) || 1
  let relativeResidual = Math.sqrt(residualNormSquared) / rightHandSideNorm
  if (relativeResidual <= relativeTolerance) {
    context.reportProgress({ stage: 'solve', completed: 0, total: maxIterations })
    return { iterations: 0, relativeResidual, solution }
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    throwIfSolverAborted(context.signal)
    applyMatrix(system, direction, product)
    let denominator = 0
    for (let index = 0; index < solution.length; index += 1) {
      denominator += direction[index] * product[index]
    }
    if (!Number.isFinite(denominator) || denominator <= 0) {
      throw new CadModelError(`${label} finite-volume matrix is not positive definite.`)
    }
    const alpha = residualPreconditioned / denominator
    residualNormSquared = 0
    for (let index = 0; index < solution.length; index += 1) {
      solution[index] += alpha * direction[index]
      residual[index] -= alpha * product[index]
      residualNormSquared += residual[index] ** 2
    }
    relativeResidual = Math.sqrt(residualNormSquared) / rightHandSideNorm
    if (relativeResidual <= relativeTolerance) {
      context.reportProgress({ stage: 'solve', completed: iteration, total: maxIterations })
      return { iterations: iteration, relativeResidual, solution }
    }

    let nextResidualPreconditioned = 0
    for (let index = 0; index < solution.length; index += 1) {
      preconditioned[index] = residual[index] / diagonal[index]
      nextResidualPreconditioned += residual[index] * preconditioned[index]
    }
    const beta = nextResidualPreconditioned / residualPreconditioned
    for (let index = 0; index < solution.length; index += 1) {
      direction[index] = preconditioned[index] + beta * direction[index]
    }
    residualPreconditioned = nextResidualPreconditioned
    if (iteration % 8 === 0) {
      context.reportProgress({ stage: 'solve', completed: iteration, total: maxIterations })
      await yieldToWorker(context.signal)
    }
  }

  throw new CadModelError(
    `${label} finite-volume solve did not converge within ${maxIterations} iterations ` +
      `(relative residual ${relativeResidual}).`,
  )
}

export function voxelAxisTicks(domain: TerminalVoxelDomain) {
  const { frame, grid, shape } = domain
  return Object.freeze({
    axial: Object.freeze(
      Array.from({ length: shape[0] }, (_value, index) => -frame.length / 2 + (index + 0.5) * grid.axialSpacing),
    ),
    u: Object.freeze(
      Array.from({ length: shape[1] }, (_value, index) => frame.minimumU + (index + 0.5) * grid.uSpacing),
    ),
    v: Object.freeze(
      Array.from({ length: shape[2] }, (_value, row) => {
        const index = shape[2] - row - 1
        return frame.minimumV + (index + 0.5) * grid.vSpacing
      }),
    ),
  })
}

export function denseVoxelValues(domain: TerminalVoxelDomain, system: ScalarVoxelSystem, activeValues: Float64Array) {
  const [axialCount, uCount, vCount] = domain.shape
  return Object.freeze(
    Array.from({ length: axialCount }, (_axial, i) =>
      Object.freeze(
        Array.from({ length: vCount }, (_row, row) => {
          const k = vCount - row - 1
          return Object.freeze(
            Array.from({ length: uCount }, (_column, j) => {
              const active = system.activeIndex[voxelIndex(i, j, k, domain.shape)]
              return active < 0 ? 0 : activeValues[active]
            }),
          )
        }),
      ),
    ),
  )
}

export function scalarGradientAtVoxel(
  domain: TerminalVoxelDomain,
  system: ScalarVoxelSystem,
  values: Float64Array,
  global: number,
  sourceValue: number,
  referenceValue: number,
): readonly [number, number, number] {
  const [axialCount, uCount, vCount] = domain.shape
  const k = global % vCount
  const j = Math.floor(global / vCount) % uCount
  const i = Math.floor(global / (uCount * vCount))
  const active = system.activeIndex[global]
  if (active < 0) return [0, 0, 0]
  const center = values[active]
  const coordinates = [i, j, k]
  const counts = [axialCount, uCount, vCount]
  const spacings = [domain.grid.axialSpacing, domain.grid.uSpacing, domain.grid.vSpacing]

  return Object.freeze(
    coordinates.map((coordinate, axis) => {
      const minusCoordinates = [...coordinates]
      const plusCoordinates = [...coordinates]
      minusCoordinates[axis] -= 1
      plusCoordinates[axis] += 1
      const minus =
        coordinate > 0
          ? system.activeIndex[voxelIndex(minusCoordinates[0], minusCoordinates[1], minusCoordinates[2], domain.shape)]
          : -1
      const plus =
        coordinate < counts[axis] - 1
          ? system.activeIndex[voxelIndex(plusCoordinates[0], plusCoordinates[1], plusCoordinates[2], domain.shape)]
          : -1
      const minusGradient =
        minus >= 0
          ? (center - values[minus]) / spacings[axis]
          : axis === 0 && coordinate === 0
            ? (2 * (center - sourceValue)) / spacings[axis]
            : 0
      const plusGradient =
        plus >= 0
          ? (values[plus] - center) / spacings[axis]
          : axis === 0 && coordinate === counts[axis] - 1
            ? (2 * (referenceValue - center)) / spacings[axis]
            : 0
      return (minusGradient + plusGradient) / 2
    }),
  ) as unknown as readonly [number, number, number]
}
