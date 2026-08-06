import { CadModelError } from '../../../cad/model/core'
import type { KernelExecutionContext, KernelExecutionResult } from '../../kernelContract'
import {
  buildTerminalVoxelDomain,
  createScalarVoxelSystem,
  denseVoxelValues,
  solveScalarVoxelSystem,
  throwIfSolverAborted,
  voxelAxisTicks,
  voxelIndex,
  type TerminalVoxelDomain,
} from '../voxelFiniteVolume'
import type { PreparedSteadyStateHeatInput } from './prepare'

type DenseArtifact = Readonly<{
  value: readonly unknown[]
  axes?: readonly Readonly<{ ticks?: readonly (number | string)[] }>[]
}>

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-10, Math.abs(right) * 1e-10)
}

function volumetricSource(input: unknown, domain: TerminalVoxelDomain, thermalConductivity: number) {
  const source = new Float64Array(domain.grid.occupancy.length)
  if (input === undefined) return source
  if (typeof input !== 'object' || input === null || !('value' in input) || !Array.isArray(input.value)) {
    throw new CadModelError('Heat input heatSource must be a three-dimensional voxel tensor.')
  }
  const artifact = input as DenseArtifact
  const ticks = voxelAxisTicks(domain)
  const expectedTicks = [ticks.axial, ticks.v, ticks.u]
  if (!artifact.axes || artifact.axes.length !== 3) {
    throw new CadModelError('Heat input heatSource must include three voxel axes.')
  }
  artifact.axes.forEach((axis, axisIndex) => {
    if (
      !axis.ticks ||
      axis.ticks.length !== expectedTicks[axisIndex].length ||
      axis.ticks.some(
        (tick, index) =>
          typeof tick !== 'number' || !Number.isFinite(tick) || !closeEnough(tick, expectedTicks[axisIndex][index]),
      )
    ) {
      throw new CadModelError(`Heat input heatSource axis ${axisIndex} does not match heat.voxel-grid.`)
    }
  })

  const [axialCount, uCount, vCount] = domain.shape
  if (
    artifact.value.length !== axialCount ||
    artifact.value.some(
      (slice) =>
        !Array.isArray(slice) ||
        slice.length !== vCount ||
        slice.some((row) => !Array.isArray(row) || row.length !== uCount),
    )
  ) {
    throw new CadModelError('Heat input heatSource shape must match heat.voxel-grid as [axial][v][u].')
  }
  artifact.value.forEach((slice, i) =>
    (slice as readonly unknown[]).forEach((row, rowIndex) => {
      const k = vCount - rowIndex - 1
      ;(row as readonly unknown[]).forEach((value, j) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new CadModelError(
            `Heat input heatSource value [${i}][${rowIndex}][${j}] must be finite and non-negative.`,
          )
        }
        const global = voxelIndex(i, j, k, domain.shape)
        if (domain.grid.occupancy[global]) source[global] = value / thermalConductivity
      })
    }),
  )
  return source
}

export async function solvePreparedSteadyStateHeat(
  prepared: PreparedSteadyStateHeatInput,
  inputs: Readonly<Record<string, unknown>>,
  context: KernelExecutionContext,
): Promise<KernelExecutionResult> {
  if (Object.keys(inputs).some((name) => name !== 'heatSource')) {
    throw new CadModelError('steady-state-heat received an undeclared artifact input.')
  }
  throwIfSolverAborted(context.signal)
  const {
    domain: heatDomain,
    gridShape,
    maxIterations,
    outputs,
    referenceTemperature,
    referenceTerminal,
    relativeTolerance,
    sourceTemperature,
    sourceTerminal,
    thermalConductivity,
  } = prepared
  const domain = await buildTerminalVoxelDomain(
    heatDomain,
    sourceTerminal,
    referenceTerminal,
    gridShape,
    context,
    'Heat domain',
  )
  const source = volumetricSource(inputs.heatSource, domain, thermalConductivity)
  const system = createScalarVoxelSystem(domain, sourceTemperature, referenceTemperature, source)
  const solved = await solveScalarVoxelSystem(system, relativeTolerance, maxIterations, context, 'Heat')
  const ticks = voxelAxisTicks(domain)
  let temperatureField: Readonly<{ value: unknown; axes: unknown }> | undefined
  let maximumTemperature: number | undefined
  const artifacts: Array<readonly [string, unknown]> = []
  outputs.forEach((output, index) => {
    throwIfSolverAborted(context.signal)
    if (output.methodId === 'heat.temperature') {
      temperatureField ??= Object.freeze({
        value: denseVoxelValues(domain, system, solved.solution),
        axes: Object.freeze([
          Object.freeze({ ticks: ticks.axial }),
          Object.freeze({ ticks: ticks.v }),
          Object.freeze({ ticks: ticks.u }),
        ]),
      })
      artifacts.push([output.key, temperatureField])
    } else {
      maximumTemperature ??= solved.solution.reduce(
        (maximum, value) => Math.max(maximum, value),
        Number.NEGATIVE_INFINITY,
      )
      artifacts.push([output.key, Object.freeze({ value: maximumTemperature })])
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
