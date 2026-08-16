import { describe, expect, it } from 'vitest'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { CadScene } from '../cad/evaluation/types'
import type { KernelDescriptor, KernelTaskConfig, SimulationProgramManifest } from '../cad/simulation'
import { assertCatalogKernelTasks } from './solverValidation'
import { DRAFT_TASK_KERNEL } from './draftTask'

const descriptor = Object.freeze({
  name: 'test-solver',
  version: '1.0.0',
  description: 'Runtime-slice validation fixture.',
  referenceLengthUnit: 'm',
  parameters: {},
  materials: [
    {
      role: 'body',
      description: 'Required body material.',
      target: { category: 'initializations', methodId: 'test.apply' },
      properties: {
        'coating.kind': { description: 'Coating kind.', data: { dtype: 'string', minimumLength: 1 } },
      },
    },
  ],
  inputPorts: {},
  observations: {},
  methods: {
    initializations: [
      {
        methodId: 'test.apply',
        description: 'Apply the model.',
        minimumOccurrences: 1,
        maximumOccurrences: 1,
        target: {
          source: 'experiment',
          kind: 'geometry',
          minimumTargets: 1,
          maximumTargets: 1,
          minimumResolved: 1,
          maximumResolved: 1,
        },
        parameters: {},
      },
    ],
    boundaryConditions: [],
    outputs: [],
  },
} as const satisfies KernelDescriptor)

const config = Object.freeze({
  parameters: {},
  initializations: [{ methodId: 'test.apply', target: ['experiment.geometry.body'], parameters: {} }],
  boundaryConditions: [],
  outputs: [],
} as const satisfies KernelTaskConfig)

const catalog = Object.freeze({
  schemaVersion: 1,
  catalogRevision: 'test',
  solvers: [{ name: descriptor.name, version: descriptor.version, contractDigest: 'a'.repeat(64), descriptor }],
  quantityKinds: [],
  materialParameters: [],
  materialModels: [],
  materialGlobalQualifiers: [],
  warnings: [],
} as const satisfies CatalogRuntimeSlice)

function program(taskConfig: KernelTaskConfig = config): SimulationProgramManifest {
  return Object.freeze({
    formatVersion: 5,
    simulationApiVersion: 3,
    pythonSource: 'async def simulate(**kwargs): pass',
    tasks: { main: { kernel: { name: descriptor.name, version: descriptor.version }, config: taskConfig } },
    recordedData: {},
  })
}

function scene(withMaterial: boolean): CadScene {
  return {
    lengthUnit: 'm',
    parts: [
      {
        id: 'part-1',
        geometry: {},
        materialRole: 'body',
        surfaces: [],
        ...(withMaterial ? { material: { name: 'Steel', variables: { 'coating.kind': 'steel' } } } : {}),
      },
    ],
    tree: { key: 'root', label: 'Root', children: [] },
    geometryGroups: [
      {
        id: 'group-1',
        name: 'body',
        kind: 'geometry',
        memberIds: ['part-1'],
        geometryIds: ['part-1'],
        surfaceIds: [],
        missingMemberIds: [],
      },
    ],
    surfaceGroups: [],
  }
}

describe('runtime-slice Solver validation', () => {
  it('validates method and target configuration before a world is available', () => {
    expect(() => assertCatalogKernelTasks(catalog, program())).not.toThrow()
    expect(() =>
      assertCatalogKernelTasks(
        catalog,
        program({ ...config, initializations: [{ ...config.initializations[0], methodId: 'unknown' }] }),
      ),
    ).toThrow('methodId is not declared')
  })

  it('validates resolved targets and required Material values against final scenes', () => {
    expect(() =>
      assertCatalogKernelTasks(catalog, program(), { experiment: scene(false), tasks: { main: scene(false) } }),
    ).toThrow('requires Material properties coating.kind')
    expect(() =>
      assertCatalogKernelTasks(catalog, program(), { experiment: scene(true), tasks: { main: scene(true) } }),
    ).not.toThrow()
    expect(() =>
      assertCatalogKernelTasks(catalog, program(), {
        experiment: { ...scene(true), geometryGroups: [] },
        tasks: { main: scene(true) },
      }),
    ).toThrow('must resolve to 1..1 parts')
  })

  it('refuses a descriptor that is absent from the exact runtime slice', () => {
    expect(() => assertCatalogKernelTasks({ ...catalog, solvers: [] }, program())).toThrow(
      'requires exactly one test-solver@1.0.0 descriptor',
    )
  })

  it('returns reserved Draft Tasks while continuing to validate real Solver Tasks', () => {
    const mixedProgram: SimulationProgramManifest = Object.freeze({
      ...program(),
      tasks: {
        main: program().tasks.main,
        draft: { kernel: DRAFT_TASK_KERNEL, config: {} as KernelTaskConfig },
      },
    })

    expect(assertCatalogKernelTasks(catalog, mixedProgram)).toEqual(['draft'])
    expect(() =>
      assertCatalogKernelTasks(catalog, {
        ...mixedProgram,
        tasks: {
          ...mixedProgram.tasks,
          unknown: {
            kernel: { name: DRAFT_TASK_KERNEL.name, version: '1.0.1' },
            config: {} as KernelTaskConfig,
          },
        },
      }),
    ).toThrow('requires exactly one replace-with-solver@1.0.1 descriptor')
  })
})
