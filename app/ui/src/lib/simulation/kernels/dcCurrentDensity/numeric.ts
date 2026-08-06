import { CadModelError } from '../../../cad/model/core'
import type { Vec3 } from '../../../cad/model/types'
import type { KernelExecutionContext, KernelExecutionResult } from '../../kernelContract'
import {
  buildTerminalVoxelDomain,
  createScalarVoxelSystem,
  denseVoxelValues,
  scalarGradientAtVoxel,
  solveScalarVoxelSystem,
  throwIfSolverAborted,
  voxelAxisTicks,
  voxelIndex,
  type ScalarVoxelSystem,
  type TerminalVoxelDomain,
} from '../voxelFiniteVolume'
import type { PreparedDcInput } from './prepare'

function scale(vector: Vec3, factor: number): Vec3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

function calculateCrossSection(
  solution: Float64Array,
  system: ScalarVoxelSystem,
  domain: TerminalVoxelDomain,
  crossSectionPosition: number,
  conductivity: number,
  sourceVoltage: number,
  referenceVoltage: number,
  includeValues: boolean,
) {
  const [axialCount, uCount, vCount] = domain.shape
  const { axialSpacing, occupancy, uSpacing, vSpacing } = domain.grid
  const faceIndex = Math.min(axialCount, Math.max(0, Math.round(crossSectionPosition * axialCount)))
  const axialValues: number[][] | undefined = includeValues ? [] : undefined
  let axialSum = 0
  for (let row = 0; row < vCount; row += 1) {
    const k = vCount - row - 1
    const rowValues: number[] | undefined = includeValues ? [] : undefined
    for (let j = 0; j < uCount; j += 1) {
      let currentDensity = 0
      if (faceIndex === 0) {
        const rightGlobal = voxelIndex(0, j, k, domain.shape)
        if (occupancy[rightGlobal]) {
          currentDensity =
            (2 * conductivity * (sourceVoltage - solution[system.activeIndex[rightGlobal]])) / axialSpacing
        }
      } else if (faceIndex === axialCount) {
        const leftGlobal = voxelIndex(axialCount - 1, j, k, domain.shape)
        if (occupancy[leftGlobal]) {
          currentDensity =
            (2 * conductivity * (solution[system.activeIndex[leftGlobal]] - referenceVoltage)) / axialSpacing
        }
      } else {
        const leftGlobal = voxelIndex(faceIndex - 1, j, k, domain.shape)
        const rightGlobal = voxelIndex(faceIndex, j, k, domain.shape)
        if (occupancy[leftGlobal] && occupancy[rightGlobal]) {
          const left = system.activeIndex[leftGlobal]
          const right = system.activeIndex[rightGlobal]
          currentDensity = (conductivity * (solution[left] - solution[right])) / axialSpacing
        }
      }
      currentDensity = Object.is(currentDensity, -0) ? 0 : currentDensity
      axialSum += currentDensity
      rowValues?.push(currentDensity)
    }
    if (rowValues) axialValues?.push(rowValues)
  }
  return {
    axialValues,
    totalCurrent: Math.abs(axialSum * uSpacing * vSpacing),
  }
}

function currentDensity(result: ReturnType<typeof calculateCrossSection>, domain: TerminalVoxelDomain) {
  if (!result.axialValues) {
    throw new CadModelError('DC current-density output requires sampled cross-section values.')
  }
  const ticks = voxelAxisTicks(domain)
  const values = result.axialValues.map((row) => row.map((value) => scale(domain.frame.axis, value)))
  return { uTicks: ticks.u, values, vTicks: ticks.v }
}

function jouleHeating(
  solution: Float64Array,
  system: ScalarVoxelSystem,
  domain: TerminalVoxelDomain,
  conductivity: number,
  sourceVoltage: number,
  referenceVoltage: number,
) {
  const values = new Float64Array(solution.length)
  system.activeCells.forEach((global, active) => {
    const gradient = scalarGradientAtVoxel(domain, system, solution, global, sourceVoltage, referenceVoltage)
    values[active] = conductivity * (gradient[0] ** 2 + gradient[1] ** 2 + gradient[2] ** 2)
  })
  const ticks = voxelAxisTicks(domain)
  return Object.freeze({
    value: denseVoxelValues(domain, system, values),
    axes: Object.freeze([
      Object.freeze({ ticks: ticks.axial }),
      Object.freeze({ ticks: ticks.v }),
      Object.freeze({ ticks: ticks.u }),
    ]),
  })
}

export async function solvePreparedDcCurrentDensity(
  prepared: PreparedDcInput,
  inputs: Readonly<Record<string, unknown>>,
  context: KernelExecutionContext,
): Promise<KernelExecutionResult> {
  if (Object.keys(inputs).length > 0) {
    throw new CadModelError('dc-current-density does not declare artifact input ports.')
  }
  throwIfSolverAborted(context.signal)
  const {
    conductor,
    conductivity,
    gridShape,
    maxIterations,
    outputs,
    referenceTerminal,
    referenceVoltage,
    relativeTolerance,
    sourceTerminal,
    sourceVoltage,
  } = prepared
  const domain = await buildTerminalVoxelDomain(
    conductor,
    sourceTerminal,
    referenceTerminal,
    gridShape,
    context,
    'DC conductor',
  )
  const system = createScalarVoxelSystem(domain, sourceVoltage, referenceVoltage)
  const solved = await solveScalarVoxelSystem(system, relativeTolerance, maxIterations, context, 'DC')
  const crossSectionOutputs = outputs.filter(
    (output): output is Extract<(typeof outputs)[number], { methodId: 'dc.current-density' | 'dc.total-current' }> =>
      output.methodId !== 'dc.joule-heating',
  )
  const densityPositions = new Set(
    crossSectionOutputs
      .filter((output) => output.methodId === 'dc.current-density')
      .map((output) => output.crossSectionPosition),
  )
  const crossSections = new Map<number, ReturnType<typeof calculateCrossSection>>()
  let volumetricHeating: ReturnType<typeof jouleHeating> | undefined
  const artifacts: Array<readonly [string, unknown]> = []
  outputs.forEach((output, index) => {
    throwIfSolverAborted(context.signal)
    if (output.methodId === 'dc.joule-heating') {
      volumetricHeating ??= jouleHeating(solved.solution, system, domain, conductivity, sourceVoltage, referenceVoltage)
      artifacts.push([output.key, volumetricHeating])
    } else {
      let result = crossSections.get(output.crossSectionPosition)
      if (!result) {
        result = calculateCrossSection(
          solved.solution,
          system,
          domain,
          output.crossSectionPosition,
          conductivity,
          sourceVoltage,
          referenceVoltage,
          densityPositions.has(output.crossSectionPosition),
        )
        crossSections.set(output.crossSectionPosition, result)
      }
      if (output.methodId === 'dc.current-density') {
        const density = currentDensity(result, domain)
        artifacts.push([
          output.key,
          Object.freeze({
            value: Object.freeze(
              density.values.map((row) => Object.freeze(row.map((component) => Object.freeze(component)))),
            ),
            axes: Object.freeze([Object.freeze({ ticks: density.vTicks }), Object.freeze({ ticks: density.uTicks })]),
          }),
        ])
      } else {
        artifacts.push([output.key, Object.freeze({ value: result.totalCurrent })])
      }
    }
    context.reportProgress({ stage: 'output', completed: index + 1, total: outputs.length })
  })
  return Object.freeze({
    artifacts: Object.freeze(Object.fromEntries(artifacts)),
    observations: Object.freeze({
      iterations: solved.iterations,
      relativeResidual: solved.relativeResidual,
    }),
  })
}
