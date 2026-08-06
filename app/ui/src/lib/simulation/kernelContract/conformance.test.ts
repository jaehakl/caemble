import { describe, expect, it } from 'vitest'
import type { CadScene } from '../../cad/evaluation/types'
import type { KernelDefinition, KernelDescriptor, KernelTaskConfig, KernelWorld } from './types'
import { runKernelConformance } from './conformance'

const ampSpec = Object.freeze({
  dtype: 'float64' as const,
  unit: 'A',
  quantityKind: 'electromagnetism.ElectricCurrent' as const,
})

const descriptor = Object.freeze({
  name: 'test-conformance',
  version: '1.0.0',
  description: 'Exercises the shared kernel contract.',
  referenceLengthUnit: 'm',
  minimumOutputs: 1,
  parameters: Object.freeze({}),
  materials: Object.freeze([]),
  inputPorts: Object.freeze({
    source: Object.freeze({
      description: 'Required source artifact.',
      artifactTypes: Object.freeze(['test/source@1'] as const),
      minimumOccurrences: 1,
      maximumOccurrences: 1,
      data: ampSpec,
    }),
  }),
  observations: Object.freeze({
    done: Object.freeze({
      description: 'Whether execution completed.',
      type: 'boolean' as const,
    }),
  }),
  methods: Object.freeze({
    initializations: Object.freeze([]),
    boundaryConditions: Object.freeze([]),
    outputs: Object.freeze([
      Object.freeze({
        methodId: 'test.value',
        description: 'Returns a value.',
        minimumOccurrences: 1,
        maximumOccurrences: 1,
        target: Object.freeze({
          source: 'structure' as const,
          kind: 'geometry' as const,
          minimumTargets: 0,
          maximumTargets: 0,
          minimumResolved: 0,
          maximumResolved: 0,
        }),
        parameters: Object.freeze({}),
        artifactType: 'test/value@1',
        data: ampSpec,
      }),
    ]),
  }),
}) satisfies KernelDescriptor

const config = Object.freeze({
  parameters: Object.freeze({}),
  initializations: Object.freeze([]),
  boundaryConditions: Object.freeze([]),
  outputs: Object.freeze([
    Object.freeze({
      key: 'value',
      methodId: 'test.value',
      target: Object.freeze([]),
      parameters: Object.freeze({}),
    }),
  ]),
}) satisfies KernelTaskConfig

function emptyScene(): CadScene {
  return {
    lengthUnit: 'm',
    parts: [],
    tree: { key: 'root', label: 'root', children: [] },
    geometryGroups: [],
    surfaceGroups: [],
  }
}

const world: KernelWorld = Object.freeze({
  scenes: Object.freeze({
    structure: emptyScene(),
    experiment: emptyScene(),
  }),
})

function definition(execute: KernelDefinition<null>['execute']): KernelDefinition<null> {
  return Object.freeze({
    descriptor,
    prepare: () => ({ prepared: null }),
    execute,
  })
}

describe('shared kernel conformance suite', () => {
  it('checks ports and progress while isolating caller-owned state', async () => {
    const state = { count: 0 }
    const result = await runKernelConformance(
      definition(async ({ state: executionState, inputs }, context) => {
        ;(executionState as { count: number }).count += 1
        context.reportProgress({ stage: 'solve', completed: 1, total: 1 })
        return {
          state: executionState,
          artifacts: { value: inputs.source },
          observations: { done: true },
        }
      }),
      { taskName: 'test', config, world },
      { state, inputs: { source: { value: 2 } } },
    )

    expect(state).toEqual({ count: 0 })
    expect(result.result).toMatchObject({
      state: { count: 1 },
      artifacts: { value: { value: 2 } },
      observations: { done: true },
    })
  })

  it('rejects partial output before exposing state or artifacts', async () => {
    const state = { count: 0 }
    await expect(
      runKernelConformance(
        definition(async ({ state: executionState }, context) => {
          ;(executionState as { count: number }).count = 99
          context.reportProgress({ stage: 'solve', completed: 1 })
          return {
            state: executionState,
            artifacts: {},
            observations: { done: true },
          }
        }),
        { taskName: 'test', config, world },
        { state, inputs: { source: { value: 2 } } },
      ),
    ).rejects.toThrow('must exactly match requested output keys')
    expect(state).toEqual({ count: 0 })
  })

  it('rejects non-monotonic progress and prototype-name contract bypasses', async () => {
    await expect(
      runKernelConformance(
        definition(async ({ inputs }, context) => {
          context.reportProgress({ stage: 'solve', completed: 2, total: 2 })
          context.reportProgress({ stage: 'solve', completed: 1, total: 2 })
          return {
            artifacts: { value: inputs.source },
            observations: { done: true },
          }
        }),
        { taskName: 'test', config, world },
        { inputs: { source: { value: 2 } } },
      ),
    ).rejects.toThrow('not monotonic')

    await expect(
      runKernelConformance(
        definition(async ({ inputs }, context) => {
          context.reportProgress({ stage: 'solve', completed: 1 })
          return {
            artifacts: { value: inputs.source },
            observations: { done: true },
          }
        }),
        { taskName: 'test', config, world },
        { inputs: { source: { value: 2 }, toString: { value: 3 } } },
      ),
    ).rejects.toThrow('input toString is not declared')

    await expect(
      runKernelConformance(
        definition(async ({ inputs }, context) => {
          context.reportProgress({ stage: 'solve', completed: 1 })
          return {
            artifacts: { value: inputs.source },
            observations: { done: true, toString: 'not declared' },
          }
        }),
        { taskName: 'test', config, world },
        { inputs: { source: { value: 2 } } },
      ),
    ).rejects.toThrow('unknown observation toString')
  })
})
