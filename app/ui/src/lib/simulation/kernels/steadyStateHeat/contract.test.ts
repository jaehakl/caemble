import { geometries, primitives } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import type { CadScene, CadScenePart } from '../../../cad/evaluation/types'
import { identityCartesianBasis } from '../../../quantitykind/identityBasis'
import {
  assertKernelCancellationConformance,
  runKernelConformance,
  validateKernelDescriptor,
  validateKernelTaskConfig,
  type KernelWorld,
} from '../../kernelContract'
import {
  prepareSteadyStateHeat,
  steadyStateHeat,
  steadyStateHeatDescriptor,
  steadyStateHeatKernel,
  type SteadyStateHeatTaskConfig,
} from '.'

function emptyScene(): CadScene {
  return {
    lengthUnit: 'm',
    parts: [],
    tree: { key: 'root', label: 'root', children: [] },
    geometryGroups: [],
    surfaceGroups: [],
  }
}

function heatWorld(): KernelWorld {
  const geometry = primitives.cuboid({ size: [100, 5, 5] })
  const polygons = geometries.geom3.toPolygons(geometry)
  const sourcePolygons: number[] = []
  const referencePolygons: number[] = []
  polygons.forEach((polygon, index) => {
    const plane = geometries.poly3.plane(polygon)
    if (plane[0] < -0.99) sourcePolygons.push(index)
    if (plane[0] > 0.99) referencePolygons.push(index)
  })
  const part: CadScenePart = {
    id: 'conductor',
    geometry,
    material: {
      name: 'Copper',
      variables: {
        color: '#d97706',
        'thermal.conductivity': {
          dtype: 'float64',
          value: [
            [401, 0, 0],
            [0, 401, 0],
            [0, 0, 401],
          ],
          unit: 'W.m-1.K-1',
          quantityKind: 'thermodynamics.ThermalConductivity',
          basis: identityCartesianBasis,
        },
      },
    },
    surfaces: [
      { id: 'source', name: 'source', polygonIndices: sourcePolygons },
      { id: 'reference', name: 'reference', polygonIndices: referencePolygons },
    ],
  }
  const structure: CadScene = {
    lengthUnit: 'mm',
    parts: [part],
    tree: { key: 'root', label: 'root', children: [] },
    geometryGroups: [
      {
        id: 'conductor-group',
        name: 'conductor',
        kind: 'geometry',
        memberIds: ['conductor'],
        geometryIds: ['conductor'],
        surfaceIds: [],
        missingMemberIds: [],
      },
    ],
    surfaceGroups: [
      {
        id: 'source-group',
        name: 'sourceTerminal',
        kind: 'surface',
        memberIds: ['source'],
        geometryIds: ['conductor'],
        surfaceIds: ['source'],
        missingMemberIds: [],
      },
      {
        id: 'reference-group',
        name: 'referenceTerminal',
        kind: 'surface',
        memberIds: ['reference'],
        geometryIds: ['conductor'],
        surfaceIds: ['reference'],
        missingMemberIds: [],
      },
    ],
  }
  return { scenes: { structure, experiment: emptyScene() } }
}

function config(): SteadyStateHeatTaskConfig {
  return {
    parameters: {
      relativeTolerance: {
        dtype: 'float64',
        value: 1e-10,
        unit: '{fraction}',
        quantityKind: 'DimensionlessRatio',
      },
      maxIterations: 1000,
    },
    initializations: [
      {
        methodId: 'heat.voxel-grid',
        target: ['structure.geometry.conductor'],
        parameters: {
          gridShape: {
            dtype: 'int32',
            axes: [{ length: 3 }],
            value: [20, 11, 11],
          },
        },
      },
    ],
    boundaryConditions: [
      {
        methodId: 'heat.fixed-temperature',
        target: ['structure.surface.sourceTerminal'],
        parameters: {
          temperature: {
            dtype: 'float64',
            value: 293.15,
            unit: 'K',
            quantityKind: 'thermodynamics.Temperature',
          },
        },
      },
      {
        methodId: 'heat.fixed-temperature',
        target: ['structure.surface.referenceTerminal'],
        parameters: {
          temperature: {
            dtype: 'float64',
            value: 293.15,
            unit: 'K',
            quantityKind: 'thermodynamics.Temperature',
          },
        },
      },
    ],
    outputs: [
      {
        key: 'temperature',
        methodId: 'heat.temperature',
        target: ['structure.geometry.conductor'],
        parameters: {},
      },
      {
        key: 'maximumTemperature',
        methodId: 'heat.maximum-temperature',
        target: ['structure.geometry.conductor'],
        parameters: {},
      },
    ],
  }
}

function uniformHeatSource(value = 5960) {
  const axial = Array.from({ length: 20 }, (_item, index) => -0.05 + (index + 0.5) * 0.005)
  const u = Array.from({ length: 11 }, (_item, index) => -0.0025 + ((index + 0.5) * 0.005) / 11)
  const v = [...u].reverse()
  return {
    value: Array.from({ length: 20 }, () => Array.from({ length: 11 }, () => Array.from({ length: 11 }, () => value))),
    axes: [{ ticks: axial }, { ticks: v }, { ticks: u }],
  }
}

describe('steady-state-heat kernel contract', () => {
  it('owns one valid descriptor and exposes its direct task builder', () => {
    expect(validateKernelDescriptor(steadyStateHeatDescriptor)).toEqual([])
    expect(steadyStateHeat(config())).toMatchObject({
      kind: 'caemble-kernel-task',
      kernel: { name: 'steady-state-heat', version: '0.0.0' },
    })
  })

  it('requires two fixed-temperature conditions, a thermal material, and at least one output', () => {
    expect(validateKernelTaskConfig(steadyStateHeatDescriptor, config(), heatWorld())).toEqual([])
    expect(
      validateKernelTaskConfig(
        steadyStateHeatDescriptor,
        { ...config(), boundaryConditions: [config().boundaryConditions[0]] },
        heatWorld(),
      ),
    ).toContainEqual(
      expect.objectContaining({
        path: 'task.boundaryConditions',
        message: 'heat.fixed-temperature must occur 2..2 times; received 1.',
      }),
    )
    expect(
      validateKernelTaskConfig(steadyStateHeatDescriptor, { ...config(), outputs: [] }, heatWorld()),
    ).toContainEqual(
      expect.objectContaining({
        path: 'task.outputs',
        message: 'must contain at least 1 requests.',
      }),
    )
    const world = heatWorld()
    delete (world.scenes.structure.parts[0].material!.variables as Record<string, unknown>)['thermal.conductivity']
    expect(validateKernelTaskConfig(steadyStateHeatDescriptor, config(), world)).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining('thermal.conductivity'),
      }),
    )
  })

  it('solves equal fixed temperatures without a heat source and leaves kernel state unchanged', async () => {
    const { progress, result } = await runKernelConformance(steadyStateHeatKernel, {
      taskName: 'thermal',
      config: config(),
      world: heatWorld(),
    })
    const temperature = result.artifacts.temperature as {
      value: readonly (readonly (readonly number[])[])[]
      axes: readonly { ticks: readonly number[] }[]
    }
    expect(temperature.value).toHaveLength(20)
    expect(temperature.value[0]).toHaveLength(11)
    expect(temperature.value[0][0]).toHaveLength(11)
    expect(temperature.value.flat(2).every((value) => Math.abs(value - 293.15) < 1e-9)).toBe(true)
    expect((result.artifacts.maximumTemperature as { value: number }).value).toBeCloseTo(293.15, 9)
    expect(result.state).toBeUndefined()
    expect(progress.map(({ stage }) => stage)).toEqual(
      expect.arrayContaining(['occupancy', 'connectivity', 'solve', 'output']),
    )
  })

  it('accepts a matching Joule-heating grid and reproduces the one-dimensional analytic maximum', async () => {
    const { result } = await runKernelConformance(
      steadyStateHeatKernel,
      {
        taskName: 'thermal',
        config: config(),
        world: heatWorld(),
      },
      { inputs: { heatSource: uniformHeatSource() } },
    )
    expect((result.artifacts.maximumTemperature as { value: number }).value).toBeCloseTo(293.16853, 4)
    expect(result.observations).toMatchObject({
      iterations: expect.any(Number),
      relativeResidual: expect.any(Number),
    })
  })

  it('rejects heat-source shapes and coordinates that do not match heat.voxel-grid', async () => {
    const wrongShape = uniformHeatSource()
    wrongShape.value.pop()
    wrongShape.axes[0].ticks.pop()
    await expect(
      runKernelConformance(
        steadyStateHeatKernel,
        { taskName: 'thermal', config: config(), world: heatWorld() },
        { inputs: { heatSource: wrongShape } },
      ),
    ).rejects.toMatchObject({
      name: 'SimulationKernelError',
      kind: 'input',
      message: expect.stringContaining('axis 0'),
    })

    const wrongAxes = uniformHeatSource()
    wrongAxes.axes[0].ticks[0] += 0.001
    await expect(
      runKernelConformance(
        steadyStateHeatKernel,
        { taskName: 'thermal', config: config(), world: heatWorld() },
        { inputs: { heatSource: wrongAxes } },
      ),
    ).rejects.toMatchObject({
      name: 'SimulationKernelError',
      kind: 'input',
      message: expect.stringContaining('axis 0'),
    })
  })

  it('normalizes temperature units and reports cancellation as a resource error', async () => {
    const task = config()
    const { prepared } = prepareSteadyStateHeat({
      taskName: 'thermal',
      config: {
        ...task,
        boundaryConditions: task.boundaryConditions.map((condition) => ({
          ...condition,
          parameters: {
            temperature: {
              dtype: 'float64',
              value: 20,
              unit: 'Cel',
              quantityKind: 'thermodynamics.Temperature',
            },
          },
        })),
      },
      world: heatWorld(),
    })
    expect(prepared.sourceTemperature).toBeCloseTo(293.15)
    expect(prepared.referenceTemperature).toBeCloseTo(293.15)
    await expect(assertKernelCancellationConformance(steadyStateHeatKernel, prepared)).resolves.toBeUndefined()
  })
})
