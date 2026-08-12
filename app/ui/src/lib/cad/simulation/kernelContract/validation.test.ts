import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  normalizeKernelTaskConfig,
  resolveKernelInputPort,
  resolveKernelOutputSpecs,
  validateKernelDescriptor,
  validateKernelTaskConfig,
} from '.'
import type { KernelDescriptor, KernelTaskConfig, KernelValueSpec } from './types'

const valueSpecFixture = JSON.parse(
  readFileSync(new URL('../../model/fixtures/data-schema-golden.v1.json', import.meta.url), 'utf8'),
) as Readonly<{
  valueSpecCases: readonly Readonly<{
    name: string
    spec: Readonly<Record<string, unknown>>
    valid: readonly unknown[]
    invalid: readonly Readonly<{ value: unknown; issue: string }>[]
  }>[]
}>

const descriptor = Object.freeze({
  name: 'test-kernel',
  version: '1.0.0',
  description: 'Contract fixture.',
  referenceLengthUnit: 'm',
  minimumOutputs: 1,
  parameters: {
    tolerance: {
      description: 'Tolerance.',
      data: {
        dtype: 'float64',
        unit: '{fraction}',
        quantityKind: 'DimensionlessRatio',
        minimum: 0,
      },
    },
  },
  materials: [],
  inputPorts: {
    source: {
      description: 'Source field.',
      artifactTypes: ['caemble.test/value@1'],
      minimumOccurrences: 1,
      maximumOccurrences: 1,
      data: {
        dtype: 'float64',
        unit: 'V',
        quantityKind: 'electromagnetism.Voltage',
      },
    },
  },
  observations: {
    converged: { description: 'Whether the solve converged.', type: 'boolean' },
  },
  methods: {
    initializations: [
      {
        methodId: 'test.initialize',
        description: 'Initialize.',
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
    outputs: [
      {
        methodId: 'test.value',
        description: 'Return a value.',
        minimumOccurrences: 0,
        maximumOccurrences: 10,
        target: {
          source: 'experiment',
          kind: 'geometry',
          minimumTargets: 1,
          maximumTargets: 1,
          minimumResolved: 1,
          maximumResolved: 1,
        },
        parameters: {},
        artifactType: 'caemble.test/value@1',
        data: {
          dtype: 'float64',
          unit: 'V',
          quantityKind: 'electromagnetism.Voltage',
        },
      },
    ],
  },
} as const satisfies KernelDescriptor)

const config = Object.freeze({
  parameters: {
    tolerance: {
      dtype: 'float64',
      value: 5,
      unit: '%',
      quantityKind: 'DimensionlessRatio',
    },
  },
  initializations: [
    {
      methodId: 'test.initialize',
      target: ['experiment.geometry.conductor'],
      parameters: {},
    },
  ],
  boundaryConditions: [],
  outputs: [
    {
      key: 'voltage',
      methodId: 'test.value',
      target: ['experiment.geometry.conductor'],
      parameters: {},
    },
  ],
} as const satisfies KernelTaskConfig)

describe('kernel contract validation', () => {
  it('matches the local KernelValueSpec constraint fixture', () => {
    valueSpecFixture.valueSpecCases.forEach((fixture) => {
      const fixtureDescriptor = {
        ...descriptor,
        parameters: {
          fixture: {
            description: 'Shared golden fixture parameter.',
            required: true,
            data: fixture.spec as KernelValueSpec,
          },
        },
      } as KernelDescriptor

      expect(validateKernelDescriptor(fixtureDescriptor), fixture.name).toEqual([])
      fixture.valid.forEach((value, index) => {
        const fixtureConfig = {
          ...config,
          parameters: { fixture: value },
        } as KernelTaskConfig
        expect(validateKernelTaskConfig(fixtureDescriptor, fixtureConfig), `${fixture.name}.valid[${index}]`).toEqual(
          [],
        )
      })
      fixture.invalid.forEach(({ value, issue }, index) => {
        const fixtureConfig = {
          ...config,
          parameters: { fixture: value },
        } as KernelTaskConfig
        const messages = validateKernelTaskConfig(fixtureDescriptor, fixtureConfig)
          .map((entry) => `${entry.path}: ${entry.message}`)
          .join('\n')
        expect(messages, `${fixture.name}.invalid[${index}]`).toContain(issue)
      })
    })
  })

  it('normalizes task quantities and resolves typed ports and output artifacts', () => {
    expect(validateKernelDescriptor(descriptor)).toEqual([])
    expect(validateKernelTaskConfig(descriptor, config)).toEqual([])
    const normalized = normalizeKernelTaskConfig(descriptor, config)
    expect((normalized.parameters.tolerance as { value: number }).value).toBeCloseTo(0.05)
    expect(resolveKernelInputPort(descriptor, 'source')).toMatchObject({
      artifactTypes: ['caemble.test/value@1'],
      minimumOccurrences: 1,
      maximumOccurrences: 1,
    })
    expect(resolveKernelOutputSpecs(descriptor, normalized)).toEqual({
      voltage: {
        artifactType: 'caemble.test/value@1',
        data: {
          dtype: 'float64',
          unit: 'V',
          quantityKind: 'electromagnetism.Voltage',
        },
      },
    })
  })

  it('enforces globally unique method IDs and versioned artifact types', () => {
    const invalid = structuredClone(descriptor) as unknown as {
      methods: {
        boundaryConditions: Array<Record<string, unknown>>
        outputs: Array<Record<string, unknown>>
      }
    }
    invalid.methods.boundaryConditions.push({
      ...invalid.methods.outputs[0],
      methodId: 'test.initialize',
    })
    invalid.methods.outputs[0].artifactType = 'caemble.test/value'
    expect(validateKernelDescriptor(invalid as unknown as KernelDescriptor)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'descriptor.methods.boundaryConditions[0].methodId',
        }),
        expect.objectContaining({
          path: 'descriptor.methods.boundaryConditions[0]',
          message: 'initialization and boundary-condition methods cannot declare results.',
        }),
        expect.objectContaining({
          path: 'descriptor.methods.outputs[0].artifactType',
        }),
      ]),
    )
  })

  it('rejects unknown task fields and duplicate output keys', () => {
    const invalid = {
      ...config,
      recordedData: {},
      outputs: [config.outputs[0], { ...config.outputs[0] }],
    } as unknown as KernelTaskConfig
    expect(validateKernelTaskConfig(descriptor, invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'task.recordedData', message: 'is not allowed.' }),
        expect.objectContaining({
          path: 'task.outputs[1].key',
          message: 'voltage is duplicated within this task.',
        }),
      ]),
    )
  })
})
