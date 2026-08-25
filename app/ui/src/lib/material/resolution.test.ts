import { describe, expect, it, vi } from 'vitest'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import { readFrozenMaterialParameters, resolveMaterialParameters, sourceOnlyMaterialParameters } from './resolution'
import type { CadSceneMaterial } from '../cad/evaluation/types'
import { applyFrozenMaterialParameters } from '../cad/execution/measurement'

installSyntheticCatalog({
  quantityKinds: [
    { name: 'MassDensity', applicableUnits: ['kg.m-3'] },
    { name: 'synthetic.ThermalConductivity', tensorOrder: 2, applicableUnits: ['W.m-1.K-1'] },
    { name: 'electromagnetism.ElectricConductivity', tensorOrder: 2, applicableUnits: ['S.m-1'] },
    { name: 'thermodynamics.RelativeHumidity', applicableUnits: ['%'] },
    { name: 'DimensionlessRatio', applicableUnits: ['{fraction}', '%'] },
    { name: 'Frequency', applicableUnits: ['Hz'] },
  ],
  materialParameters: [
    { key: 'general.mass_density', quantityKind: 'MassDensity' },
    { key: 'thermal.conductivity', quantityKind: 'synthetic.ThermalConductivity' },
    { key: 'electrical.conductivity', quantityKind: 'electromagnetism.ElectricConductivity' },
    {
      key: 'optical.refractive_index',
      quantityKind: 'DimensionlessRatio',
      specialQualifiers: ['wavelength_or_frequency'],
    },
    { key: 'test.unsampled_ratio', quantityKind: 'DimensionlessRatio' },
  ],
  materialModels: [
    {
      key: 'model.sorption.isotherm',
      labelKo: 'synthetic sorption relation',
      kind: 'sampled_relation',
      input: { name: 'humidity', quantityKind: 'thermodynamics.RelativeHumidity' },
      output: { name: 'ratio', quantityKind: 'DimensionlessRatio' },
      minimumSamples: 2,
      sharedBasis: false,
    },
  ],
})

const sourceMaterial: CadSceneMaterial = {
  name: 'Copper',
  source: 'handbook',
  errorRate: 0,
  variables: {
    color: '#d97706',
    'general.mass_density': {
      dtype: 'float32',
      value: 9000,
      unit: 'kg.m-3',
      quantityKind: 'MassDensity',
    },
  },
}

describe('Material resolution', () => {
  it('accepts schemaVersion 1 snapshots written before materialColors existed', () => {
    expect(readFrozenMaterialParameters({ schemaVersion: 1, materials: {} })).toEqual({
      schemaVersion: 1,
      materials: {},
    })
  })

  it('uses exact visible names, source tiers, private/latest order, and explicit overrides', () => {
    const result = resolveMaterialParameters(
      [sourceMaterial],
      [{ id: 1, material_id: 7, name: 'Copper', user_id: null }],
      [
        {
          id: 10,
          material_id: 7,
          name: 'thermal.conductivity',
          value: {
            dtype: 'float32',
            value: [
              [390, 0, 0],
              [0, 390, 0],
              [0, 0, 390],
            ],
            unit: 'W.m-1.K-1',
          },
          source: 'other',
          version: '1',
          user_id: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 11,
          material_id: 7,
          name: 'thermal.conductivity',
          value: {
            dtype: 'float32',
            value: [
              [400, 0, 0],
              [0, 400, 0],
              [0, 0, 400],
            ],
            unit: 'W.m-1.K-1',
          },
          source: 'handbook',
          version: '2',
          user_id: 'mine',
          updated_at: '2025-01-01T00:00:00Z',
        },
        {
          id: 12,
          material_id: 7,
          name: 'general.mass_density',
          value: { dtype: 'float32', value: 1, unit: 'kg.m-3' },
          source: 'handbook',
          version: '2',
          user_id: 'mine',
        },
      ],
    )
    expect(result.materialParameters.materials.Copper['thermal.conductivity']).toMatchObject({
      origin: 'database',
      materialParameterId: 11,
      value: {
        value: [
          [400, 0, 0],
          [0, 400, 0],
          [0, 0, 400],
        ],
      },
    })
    expect(result.materialParameters.materials.Copper['general.mass_density']).toMatchObject({
      origin: 'source',
      value: { value: 9000 },
    })
    expect(result.materialParameters.materials.Copper).not.toHaveProperty('color')
  })

  it('keeps source values with a warning for legacy snapshots', () => {
    const result = sourceOnlyMaterialParameters([sourceMaterial])
    expect(result.warnings[0]).toContain('Legacy')
    expect(result.materialParameters.materials.Copper['general.mass_density']).toMatchObject({ origin: 'source' })
  })

  it('does not apply database variation to an already realized source override', () => {
    const result = resolveMaterialParameters(
      [{ ...sourceMaterial, errorRate: 0.5 }],
      [{ id: 1, material_id: 7, name: 'Copper', user_id: null }],
      [
        {
          id: 20,
          material_id: 7,
          name: 'general.mass_density',
          value: { dtype: 'float32', value: 100, unit: 'kg.m-3' },
          user_id: null,
        },
      ],
    )
    expect(result.materialParameters.materials.Copper['general.mass_density'].value).toEqual({
      dtype: 'float32',
      value: 9000,
      unit: 'kg.m-3',
    })
  })

  it('freezes a coherent frequency cohort as one ascending float64 Frequency-axis property', () => {
    const result = resolveMaterialParameters(
      [{ name: 'Glass', source: 'handbook', version: '2', errorRate: 0, variables: {} }],
      [{ id: 1, material_id: 8, name: 'Glass', user_id: null }],
      [
        {
          id: 30,
          material_id: 8,
          name: 'optical.refractive_index',
          value: { dtype: 'float32', value: 160, unit: '%' },
          source: 'handbook',
          version: '2',
          frequency: 6e14,
          user_id: 'mine',
        },
        {
          id: 31,
          material_id: 8,
          name: 'optical.refractive_index',
          value: { dtype: 'float64', value: 1.5, unit: '{fraction}' },
          source: 'handbook',
          version: '2',
          frequency: 5e14,
          user_id: 'mine',
        },
        {
          id: 32,
          material_id: 8,
          name: 'optical.refractive_index',
          value: { dtype: 'float64', value: 9, unit: '{fraction}' },
          source: 'other',
          version: '9',
          frequency: 5e14,
          user_id: 'mine',
        },
        ...[5e14, 6e14].map((frequency, index) => ({
          id: 33 + index,
          material_id: 8,
          name: 'optical.refractive_index',
          value: { dtype: 'float64', value: 8 + index, unit: '{fraction}' },
          source: 'handbook',
          version: '2',
          frequency,
          user_id: null,
          updated_at: '2026-12-31T00:00:00Z',
        })),
      ],
    )

    expect(result.materialParameters.materials.Glass['optical.refractive_index']).toEqual({
      origin: 'database',
      value: {
        dtype: 'float64',
        value: [1.5, 1.6],
        unit: '{fraction}',
        axes: [
          {
            length: 2,
            name: 'frequency',
            ticks: [5e14, 6e14],
            unit: 'Hz',
            quantityKind: 'Frequency',
          },
        ],
      },
      source: 'handbook',
      version: '2',
      materialId: 8,
      materialParameterId: null,
    })
    expect(readFrozenMaterialParameters(result.materialParameters)).toEqual(result.materialParameters)
  })

  it('applies one database error multiplier to the complete frequency curve', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const result = resolveMaterialParameters(
      [{ name: 'Glass', errorRate: 0.1, variables: {} }],
      [{ id: 1, material_id: 8, name: 'Glass', user_id: null }],
      [5e14, 6e14].map((frequency, index) => ({
        id: 40 + index,
        material_id: 8,
        name: 'optical.refractive_index',
        value: { dtype: 'float64', value: 1.5 + index * 0.1, unit: '{fraction}' },
        source: 'handbook',
        version: '1',
        frequency,
        user_id: null,
      })),
    )
    random.mockRestore()

    const value = result.materialParameters.materials.Glass['optical.refractive_index'].value as {
      value: readonly number[]
    }
    expect(value.value[0]).toBeCloseTo(1.35)
    expect(value.value[1]).toBeCloseTo(1.44)
    expect(value.value[0] / 1.5).toBeCloseTo(value.value[1] / 1.6)
  })

  it('keeps temperature and pressure conditions separate when assembling a frequency curve', () => {
    const rows = [
      ...[5e14, 6e14].map((frequency, index) => ({
        id: 70 + index,
        material_id: 8,
        name: 'optical.refractive_index',
        value: { dtype: 'float64' as const, value: 2.5 + index * 0.1, unit: '{fraction}' },
        source: 'handbook',
        version: '1',
        temperature: 400,
        pressure: 101325,
        frequency,
        user_id: null,
      })),
      ...[5e14, 6e14].map((frequency, index) => ({
        id: 72 + index,
        material_id: 8,
        name: 'optical.refractive_index',
        value: { dtype: 'float64' as const, value: 1.5 + index * 0.1, unit: '{fraction}' },
        source: 'handbook',
        version: '1',
        temperature: 300,
        pressure: 101325,
        frequency,
        user_id: null,
      })),
    ]
    const result = resolveMaterialParameters(
      [{ name: 'Glass', variables: {} }],
      [{ id: 1, material_id: 8, name: 'Glass', user_id: null }],
      rows,
    )

    expect(result.materialParameters.materials.Glass['optical.refractive_index'].value).toMatchObject({
      value: [1.5, 1.6],
      axes: [{ ticks: [5e14, 6e14] }],
    })
  })

  it('keeps generic qualifier sets separate when assembling a frequency curve', () => {
    const rows = [
      ...[5e14, 6e14].map((frequency, index) => ({
        id: 80 + index,
        material_id: 8,
        name: 'optical.refractive_index',
        value: { dtype: 'float64' as const, value: 2.5 + index * 0.1, unit: '{fraction}' },
        source: 'handbook',
        version: '1',
        temperature: 300,
        pressure: 101325,
        frequency,
        user_id: null,
      })),
      ...[5e14, 6e14].map((frequency, index) => ({
        id: 82 + index,
        material_id: 8,
        name: 'optical.refractive_index',
        value: { dtype: 'float64' as const, value: 1.5 + index * 0.1, unit: '{fraction}' },
        source: 'handbook',
        version: '1',
        temperature: 300,
        pressure: 101325,
        frequency,
        user_id: null,
      })),
    ]
    const result = resolveMaterialParameters(
      [{ name: 'Glass', variables: {} }],
      [{ id: 1, material_id: 8, name: 'Glass', user_id: null }],
      rows,
      {
        qualifiers: rows.map((row) => ({
          material_parameter_id: row.id,
          name: 'polarization',
          value: row.id < 82 ? 0 : 1,
        })),
      },
    )

    expect(result.materialParameters.materials.Glass['optical.refractive_index'].value).toMatchObject({
      value: [1.5, 1.6],
      axes: [{ ticks: [5e14, 6e14] }],
    })
  })

  it.each([
    {
      label: 'mixed scalar and frequency rows',
      rows: [
        { id: 50, frequency: null },
        { id: 51, frequency: 5e14 },
      ],
      message: 'cannot mix scalar and frequency rows',
    },
    {
      label: 'a one-point frequency series',
      rows: [{ id: 50, frequency: 5e14 }],
      message: 'requires at least two rows',
    },
    {
      label: 'duplicate frequencies',
      rows: [
        { id: 50, frequency: 5e14 },
        { id: 51, frequency: 5e14 },
      ],
      message: 'duplicate frequency rows',
    },
    {
      label: 'a non-positive frequency',
      rows: [
        { id: 50, frequency: 0 },
        { id: 51, frequency: 5e14 },
      ],
      message: 'positive finite Hz value',
    },
  ])('rejects $label within the selected cohort', ({ rows, message }) => {
    expect(() =>
      resolveMaterialParameters(
        [{ name: 'Glass', variables: {} }],
        [{ id: 1, material_id: 8, name: 'Glass', user_id: null }],
        rows.map(({ id, frequency }) => ({
          id,
          material_id: 8,
          name: 'optical.refractive_index',
          value: { dtype: 'float64', value: 1.5, unit: '{fraction}' },
          source: 'handbook',
          version: '1',
          frequency,
          user_id: null,
        })),
      ),
    ).toThrow(message)
  })

  it('rejects frequency rows for a property without a frequency qualifier', () => {
    expect(() =>
      resolveMaterialParameters(
        [{ name: 'Glass', variables: {} }],
        [{ id: 1, material_id: 8, name: 'Glass', user_id: null }],
        [5e14, 6e14].map((frequency, index) => ({
          id: 60 + index,
          material_id: 8,
          name: 'test.unsampled_ratio',
          value: { dtype: 'float64', value: 1.5, unit: '{fraction}' },
          source: 'handbook',
          version: '1',
          frequency,
          user_id: null,
        })),
      ),
    ).toThrow('does not support frequency rows')
  })

  it('rejects a frozen frequency series with non-ascending ticks or a retained row id', () => {
    const entry = {
      origin: 'database',
      value: {
        dtype: 'float64',
        value: [1.5, 1.6],
        unit: '{fraction}',
        axes: [
          {
            length: 2,
            name: 'frequency',
            ticks: [5e14, 6e14],
            unit: 'Hz',
            quantityKind: 'Frequency',
          },
        ],
      },
      source: 'handbook',
      version: '1',
      materialId: 8,
      materialParameterId: null,
    }
    expect(
      readFrozenMaterialParameters({
        schemaVersion: 1,
        materials: { Glass: { 'optical.refractive_index': entry } },
      }),
    ).not.toBeNull()
    expect(
      readFrozenMaterialParameters({
        schemaVersion: 1,
        materials: {
          Glass: {
            'optical.refractive_index': {
              ...entry,
              value: { ...entry.value, axes: [{ ...entry.value.axes[0], ticks: [6e14, 5e14] }] },
            },
          },
        },
      }),
    ).toBeNull()
    expect(
      readFrozenMaterialParameters({
        schemaVersion: 1,
        materials: { Glass: { 'optical.refractive_index': { ...entry, materialParameterId: 50 } } },
      }),
    ).toBeNull()
  })

  it('rejects duplicate names that resolve to different final values', () => {
    expect(() =>
      resolveMaterialParameters(
        [
          sourceMaterial,
          {
            ...sourceMaterial,
            variables: {
              ...sourceMaterial.variables,
              'general.mass_density': { ...sourceMaterial.variables['general.mass_density']!, value: 8000 },
            },
          },
        ],
        [],
        [],
      ),
    ).toThrow('conflicting parameter sets')
  })

  it('samples database scalar and tensor properties afresh with the material error rate', () => {
    const material: CadSceneMaterial = { name: 'Copper', errorRate: 0.1, variables: {} }
    const names = [{ id: 1, material_id: 7, name: 'Copper', user_id: null }]
    const parameters = [
      {
        id: 20,
        material_id: 7,
        name: 'general.mass_density',
        value: { dtype: 'float32', value: 100, unit: 'kg.m-3' },
        user_id: null,
      },
      {
        id: 21,
        material_id: 7,
        name: 'electrical.conductivity',
        value: {
          dtype: 'float64',
          value: [
            [10, 0, 0],
            [0, 20, 0],
            [0, 0, 30],
          ],
          unit: 'S.m-1',
        },
        user_id: null,
      },
    ]
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const first = resolveMaterialParameters([material], names, parameters)
    random.mockReturnValue(1)
    const reroll = resolveMaterialParameters([material], names, [...parameters].reverse())
    random.mockRestore()

    expect(first.materialParameters).not.toEqual(reroll.materialParameters)
    const tensor = first.materialParameters.materials.Copper['electrical.conductivity'].value as {
      value: readonly (readonly number[])[]
    }
    expect(tensor.value[0][0] / 10).toBe(tensor.value[1][1] / 20)
    expect(tensor.value[1][1] / 20).toBe(tensor.value[2][2] / 30)
  })

  it('uses each explicit source property error rate and leaves zero-rate values exact', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const varying = {
      ...sourceMaterial,
      errorRate: 0.99,
      variables: {
        ...sourceMaterial.variables,
        'general.mass_density': {
          dtype: 'float32',
          value: 9000,
          unit: 'kg.m-3',
          quantityKind: 'MassDensity',
          errorRate: 0.5,
        },
      },
    } satisfies CadSceneMaterial
    const low = resolveMaterialParameters([varying], [], [])
    random.mockReturnValue(1)
    const high = resolveMaterialParameters([varying], [], [])
    random.mockClear()
    const exact = resolveMaterialParameters([sourceMaterial], [], [])
    expect(random).not.toHaveBeenCalled()
    random.mockRestore()

    expect(low.materialParameters.materials.Copper['general.mass_density'].value).toMatchObject({ value: 4500 })
    expect(high.materialParameters.materials.Copper['general.mass_density'].value).toMatchObject({ value: 13_500 })
    expect(exact.materialParameters.materials.Copper['general.mass_density'].value).toMatchObject({ value: 9000 })
  })

  it('does not vary sampled relations and rejects resolved DB values outside the dtype range', () => {
    const names = [{ id: 1, material_id: 7, name: 'Copper', user_id: null }]
    const relation = {
      kind: 'sampled_relation',
      input: { unit: '%', values: [0, 100] },
      output: { unit: '{fraction}', values: [0, 0.2] },
    }
    const relationResult = resolveMaterialParameters([{ name: 'Copper', errorRate: 0.5, variables: {} }], names, [
      { id: 22, material_id: 7, name: 'model.sorption.isotherm', value: relation, user_id: null },
    ])
    expect(relationResult.materialParameters.materials.Copper['model.sorption.isotherm'].value).toEqual(relation)

    const random = vi.spyOn(Math, 'random').mockReturnValue(1)
    expect(() =>
      resolveMaterialParameters([{ name: 'Copper', errorRate: 0.5, variables: {} }], names, [
        {
          id: 20,
          material_id: 7,
          name: 'general.mass_density',
          value: { dtype: 'float16', value: 65504, unit: 'kg.m-3' },
          user_id: null,
        },
      ]),
    ).toThrow('must be a finite float16 value in [-65504, 65504]')
    random.mockRestore()
  })

  it('freezes database color separately and keeps source color as the runtime override', () => {
    const uncolored: CadSceneMaterial = { name: 'Copper', variables: {} }
    const names = [{ id: 1, material_id: 7, name: 'Copper', user_id: null }]
    const resolution = resolveMaterialParameters([uncolored], names, [], {
      materials: [{ id: 7, color: '#A1B2C3' }],
    })
    expect(resolution.materialParameters.materialColors).toEqual({
      Copper: { color: '#a1b2c3', materialId: 7 },
    })
    const scene = {
      lengthUnit: 'mm' as const,
      parts: [{ id: 'part', geometry: {}, materialRole: 'body', material: uncolored, surfaces: [] }],
      tree: { key: 'root', label: 'Root', children: [] },
      geometryGroups: [],
      surfaceGroups: [],
    }
    expect(applyFrozenMaterialParameters(scene, resolution.materialParameters).parts[0].material?.variables.color).toBe(
      '#a1b2c3',
    )

    const explicitScene = {
      ...scene,
      parts: [
        {
          ...scene.parts[0],
          material: { ...uncolored, variables: { color: '#d97706' } },
        },
      ],
    }
    expect(
      applyFrozenMaterialParameters(explicitScene, resolution.materialParameters).parts[0].material?.variables.color,
    ).toBe('#d97706')
  })
})
