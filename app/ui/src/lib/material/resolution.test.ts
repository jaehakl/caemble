import { describe, expect, it, vi } from 'vitest'
import { readFrozenMaterialParameters, resolveMaterialParameters, sourceOnlyMaterialParameters } from './resolution'
import type { CadSceneMaterial } from '../cad/evaluation/types'
import { applyFrozenMaterialParameters } from '../cad/execution/measurement'

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
