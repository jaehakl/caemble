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
  dcCurrentDensity,
  dcCurrentDensityDescriptor,
  dcCurrentDensityKernel,
  prepareDcCurrentDensity,
  type DcCurrentDensityTaskConfig,
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

function dcWorld(): KernelWorld {
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
        'electrical.conductivity': {
          dtype: 'float64',
          value: [
            [5.96e7, 0, 0],
            [0, 5.96e7, 0],
            [0, 0, 5.96e7],
          ],
          unit: 'S.m-1',
          quantityKind: 'electromagnetism.ElectricConductivity',
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

function config(
  outputs: DcCurrentDensityTaskConfig['outputs'] = [
    {
      key: 'currentDensity',
      methodId: 'dc.current-density',
      target: ['structure.geometry.conductor'],
      parameters: {
        crossSectionPosition: {
          dtype: 'float64',
          value: 0.5,
          unit: '{fraction}',
          quantityKind: 'DimensionlessRatio',
        },
      },
    },
    {
      key: 'totalCurrent',
      methodId: 'dc.total-current',
      target: ['structure.geometry.conductor'],
      parameters: {
        crossSectionPosition: {
          dtype: 'float64',
          value: 0.5,
          unit: '{fraction}',
          quantityKind: 'DimensionlessRatio',
        },
      },
    },
  ],
): DcCurrentDensityTaskConfig {
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
        methodId: 'dc.voxel-grid',
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
        methodId: 'dc.source-potential',
        target: ['structure.surface.sourceTerminal'],
        parameters: {
          voltage: {
            dtype: 'float64',
            value: 1,
            unit: 'mV',
            quantityKind: 'electromagnetism.Voltage',
          },
        },
      },
      {
        methodId: 'dc.reference-potential',
        target: ['structure.surface.referenceTerminal'],
        parameters: {
          voltage: {
            dtype: 'float64',
            value: 0,
            unit: 'mV',
            quantityKind: 'electromagnetism.Voltage',
          },
        },
      },
    ],
    outputs,
  }
}

async function runDc(task = config()) {
  const world = dcWorld()
  return runKernelConformance(dcCurrentDensityKernel, { taskName: 'electric', config: task, world })
}

describe('dc-current-density kernel contract', () => {
  it('owns one valid descriptor and exposes the direct task builder', () => {
    expect(validateKernelDescriptor(dcCurrentDensityDescriptor)).toEqual([])
    const task = dcCurrentDensity(config())
    expect(task).toMatchObject({
      kind: 'caemble-kernel-task',
      kernel: { name: 'dc-current-density', version: '0.0.0' },
    })
  })

  it('validates generic output keys and requires at least one requested artifact', () => {
    expect(validateKernelTaskConfig(dcCurrentDensityDescriptor, config(), dcWorld())).toEqual([])
    expect(validateKernelTaskConfig(dcCurrentDensityDescriptor, config([]), dcWorld())).toContainEqual(
      expect.objectContaining({
        path: 'task.outputs',
        message: 'must contain at least 1 requests.',
      }),
    )
    const duplicate = config([
      { ...config().outputs[0], key: 'same' },
      { ...config().outputs[1], key: 'same' },
    ])
    expect(validateKernelTaskConfig(dcCurrentDensityDescriptor, duplicate, dcWorld())).toContainEqual(
      expect.objectContaining({
        path: 'task.outputs[1].key',
        message: 'same is duplicated within this task.',
      }),
    )
    expect(
      validateKernelTaskConfig(
        dcCurrentDensityDescriptor,
        {
          ...config(),
          parameters: {
            ...config().parameters,
            toString: 1,
          },
        },
        dcWorld(),
      ),
    ).toContainEqual({
      path: 'task.parameters.toString',
      message: 'is not declared.',
    })
  })

  it('normalizes descriptor-form integer parameters before execution', () => {
    const task = config()
    const { prepared } = prepareDcCurrentDensity({
      taskName: 'electric',
      config: {
        ...task,
        parameters: {
          ...task.parameters,
          maxIterations: {
            dtype: 'int32',
            value: 750,
          },
        },
      },
      world: dcWorld(),
    })

    expect(prepared.maxIterations).toBe(750)
  })

  it('solves the potential once, returns only requested artifacts, and preserves the 14.9 A golden result', async () => {
    const { prepared, progress, result } = await runDc()
    expect(prepared.sourceVoltage).toBeCloseTo(0.001)
    expect(prepared.conductor).not.toBe(dcWorld().scenes.structure.parts[0])
    expect(Object.keys(result.artifacts)).toEqual(['currentDensity', 'totalCurrent'])
    expect((result.artifacts.totalCurrent as { value: number }).value).toBeCloseTo(14.9, 6)
    expect(result.observations).toMatchObject({
      iterations: expect.any(Number),
      relativeResidual: expect.any(Number),
    })
    expect(result.state).toBeUndefined()
    expect(progress.map(({ stage }) => stage)).toEqual(
      expect.arrayContaining(['occupancy', 'connectivity', 'solve', 'output']),
    )
  })

  it('supports repeated methods at different cross-sections without hidden outputs', async () => {
    const at = (value: number) => ({
      dtype: 'float64' as const,
      value,
      unit: '{fraction}',
      quantityKind: 'DimensionlessRatio' as const,
    })
    const { result } = await runDc(
      config([
        {
          key: 'leftCurrent',
          methodId: 'dc.total-current',
          target: ['structure.geometry.conductor'],
          parameters: { crossSectionPosition: at(0.25) },
        },
        {
          key: 'rightCurrent',
          methodId: 'dc.total-current',
          target: ['structure.geometry.conductor'],
          parameters: { crossSectionPosition: at(0.75) },
        },
      ]),
    )
    expect(Object.keys(result.artifacts)).toEqual(['leftCurrent', 'rightCurrent'])
    expect((result.artifacts.leftCurrent as { value: number }).value).toBeCloseTo(14.9, 6)
    expect((result.artifacts.rightCurrent as { value: number }).value).toBeCloseTo(14.9, 6)
  })

  it('produces a finite uniform 3D Joule-heating field without changing the current solve', async () => {
    const { result } = await runDc(
      config([
        config().outputs[1],
        {
          key: 'jouleHeating',
          methodId: 'dc.joule-heating',
          target: ['structure.geometry.conductor'],
          parameters: {},
        },
      ]),
    )
    const heating = result.artifacts.jouleHeating as {
      value: readonly (readonly (readonly number[])[])[]
      axes: readonly { ticks: readonly number[] }[]
    }
    expect(heating.value).toHaveLength(20)
    expect(heating.value[0]).toHaveLength(11)
    expect(heating.value[0][0]).toHaveLength(11)
    expect(heating.value.flat(2).every((value) => Math.abs(value - 5960) < 1e-4)).toBe(true)
    expect(heating.axes.map(({ ticks }) => ticks.length)).toEqual([20, 11, 11])
    expect((result.artifacts.totalCurrent as { value: number }).value).toBeCloseTo(14.9, 6)
  })

  it('supports arbitrary task-local output keys without prototype collisions', async () => {
    const totalCurrent = config().outputs[1]
    const { result } = await runDc(
      config([
        {
          ...totalCurrent,
          key: '__proto__',
        },
      ]),
    )

    expect(Object.keys(result.artifacts)).toEqual(['__proto__'])
    expect((result.artifacts.__proto__ as { value: number }).value).toBeCloseTo(14.9, 6)
  })

  it('reports cancellation as a structured resource error', async () => {
    const world = dcWorld()
    const { prepared } = prepareDcCurrentDensity({
      taskName: 'electric',
      config: config(),
      world,
    })
    await expect(assertKernelCancellationConformance(dcCurrentDensityKernel, prepared)).resolves.toBeUndefined()

    const largeGrid = config()
    const { prepared: cancellable } = prepareDcCurrentDensity({
      taskName: 'electric',
      config: {
        ...largeGrid,
        initializations: [
          {
            ...largeGrid.initializations[0],
            parameters: {
              gridShape: {
                dtype: 'int32',
                axes: [{ length: 3 }],
                value: [100, 41, 41],
              },
            },
          },
        ],
      },
      world,
    })
    const controller = new AbortController()
    await expect(
      dcCurrentDensityKernel.execute(
        { prepared: cancellable, state: undefined, inputs: {} },
        {
          signal: controller.signal,
          reportProgress(progress) {
            if (progress.stage === 'occupancy') controller.abort()
          },
        },
      ),
    ).rejects.toMatchObject({
      name: 'SimulationKernelError',
      kind: 'resource',
    })
  })
})
