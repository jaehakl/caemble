import { primitives } from '@jscad/modeling'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dbTables } from '@/api'
import { serializeCadScene, type EvaluatedExperimentSnapshot } from '@/lib/cad'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import { createDocumentMaterialResolver } from './resolveMaterials'

installSyntheticCatalog({
  quantityKinds: [{ name: 'MassDensity', applicableUnits: ['kg.m-3'] }],
  materialParameters: [{ key: 'general.mass_density', quantityKind: 'MassDensity' }],
})

function scene(materialName: string) {
  return serializeCadScene({
    geometryGroups: [],
    lengthUnit: 'mm',
    parts: [
      {
        id: materialName,
        geometry: primitives.cuboid({ size: [1, 1, 1] }),
        materialRole: materialName.toLowerCase(),
        material: { name: materialName, variables: { color: '#112233' } },
        surfaces: [],
      },
    ],
    surfaceGroups: [],
    tree: { children: [], key: materialName, label: materialName },
  })
}

function materialSnapshot(): EvaluatedExperimentSnapshot {
  return {
    kind: 'experiment',
    scene: scene('Common'),
    taskScenes: { Heat: scene('Task') },
    simulationProgram: {
      formatVersion: 5,
      simulationApiVersion: 3,
      pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      tasks: { Heat: { kernel: { name: 'test', version: '1' }, config: {} } },
      recordedData: {},
    },
    sourceHash: 'e'.repeat(64),
    variables: { width: 2 },
    varsSchema: { width: { shape: [], min: 1, max: 10 } },
  }
}

describe('createDocumentMaterialResolver', () => {
  afterEach(() => vi.restoreAllMocks())

  it('resolves common and Task-local materials into one Measurement snapshot', async () => {
    vi.spyOn(dbTables.MaterialName, 'listRows').mockResolvedValue({ items: [], total: 0 })
    const result = await createDocumentMaterialResolver(null)(materialSnapshot())

    expect(result.materialParameters.materials).toHaveProperty('Common')
    expect(result.taskMaterialParameters.Heat.materials).toHaveProperty('Task')
  })

  it('samples one shared Material declaration once across Experiment and Task scenes', async () => {
    const density = {
      dtype: 'float64' as const,
      value: 10,
      errorRate: 0.2,
      unit: 'kg.m-3',
      quantityKind: 'MassDensity' as const,
    }
    const sharedScene = serializeCadScene({
      geometryGroups: [],
      lengthUnit: 'mm',
      parts: [
        {
          id: 'shared',
          geometry: primitives.cuboid({ size: [1, 1, 1] }),
          materialRole: 'body',
          material: { name: 'Shared', errorRate: 0, variables: { 'general.mass_density': density } },
          surfaces: [],
        },
      ],
      surfaceGroups: [],
      tree: { children: [], key: 'shared', label: 'Shared' },
    })
    const snapshot = { ...materialSnapshot(), scene: sharedScene, taskScenes: { Heat: sharedScene } }
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.75)

    const result = await createDocumentMaterialResolver(null, true)(snapshot)

    expect(random).toHaveBeenCalledTimes(1)
    expect(result.materialParameters.materials.Shared).toEqual(result.taskMaterialParameters.Heat.materials.Shared)
  })

  it('samples one shared database Material once across Experiment and Task scenes', async () => {
    const sharedScene = serializeCadScene({
      geometryGroups: [],
      lengthUnit: 'mm',
      parts: [
        {
          id: 'shared',
          geometry: primitives.cuboid({ size: [1, 1, 1] }),
          materialRole: 'body',
          material: { name: 'Shared', errorRate: 0.2, variables: {} },
          surfaces: [],
        },
      ],
      surfaceGroups: [],
      tree: { children: [], key: 'shared', label: 'Shared' },
    })
    const snapshot = { ...materialSnapshot(), scene: sharedScene, taskScenes: { Heat: sharedScene } }
    vi.spyOn(dbTables.MaterialName, 'listRows').mockResolvedValue({
      items: [{ id: 1, material_id: 7, name: 'Shared', user_id: null }],
      total: 1,
    } as never)
    vi.spyOn(dbTables.Material, 'listRows').mockResolvedValue({
      items: [{ id: 7, color: null }],
      total: 1,
    } as never)
    vi.spyOn(dbTables.MaterialParameter, 'listRows').mockResolvedValue({
      items: [
        {
          id: 11,
          material_id: 7,
          name: 'general.mass_density',
          value: { dtype: 'float64', value: 10, unit: 'kg.m-3' },
          user_id: null,
        },
      ],
      total: 1,
    } as never)
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.75)

    const result = await createDocumentMaterialResolver(null)(snapshot)

    expect(random).toHaveBeenCalledTimes(1)
    expect(result.materialParameters.materials.Shared).toEqual(result.taskMaterialParameters.Heat.materials.Shared)
    expect(result.materialParameters.materials.Shared['general.mass_density'].value).toMatchObject({ value: 11 })
  })

  it('replays an exact frozen schema-v2 snapshot without catalog queries', async () => {
    const empty = { schemaVersion: 1, materials: {} } as const
    const listNames = vi.spyOn(dbTables.MaterialName, 'listRows')
    const result = await createDocumentMaterialResolver({
      schemaVersion: 2,
      experiment: empty,
      tasks: { Heat: empty },
    })(materialSnapshot())

    expect(result.materialParameters).toBe(empty)
    expect(result.taskMaterialParameters.Heat).toBe(empty)
    expect(listNames).not.toHaveBeenCalled()
  })

  it('uses only explicit source values offline and never queries the Material catalog', async () => {
    const listNames = vi.spyOn(dbTables.MaterialName, 'listRows')
    const listMaterials = vi.spyOn(dbTables.Material, 'listRows')
    const listParameters = vi.spyOn(dbTables.MaterialParameter, 'listRows')

    const result = await createDocumentMaterialResolver(null, true)(materialSnapshot())

    expect(result.materialParameters.materials).toHaveProperty('Common')
    expect(result.warnings).toEqual([expect.stringContaining('source-only mode')])
    expect(result.taskMaterialWarnings.Heat).toEqual([expect.stringContaining('source-only mode')])
    expect(listNames).not.toHaveBeenCalled()
    expect(listMaterials).not.toHaveBeenCalled()
    expect(listParameters).not.toHaveBeenCalled()
  })

  it('ignores a previously frozen database snapshot when entering source-only mode', async () => {
    const frozen = {
      schemaVersion: 1 as const,
      materials: {
        Common: {
          'general.mass_density': {
            origin: 'database' as const,
            value: { dtype: 'float32' as const, value: 1, unit: 'kg.m-3' },
            source: null,
            version: null,
            materialId: 1,
            materialParameterId: 1,
          },
        },
      },
    }
    const empty = { schemaVersion: 1 as const, materials: {} }

    const result = await createDocumentMaterialResolver(
      { schemaVersion: 2, experiment: frozen, tasks: { Heat: empty } },
      true,
    )(materialSnapshot())

    expect(result.materialParameters).not.toBe(frozen)
    expect(result.materialParameters.materials.Common).not.toHaveProperty('general.mass_density')
    expect(result.warnings).toEqual([expect.stringContaining('source-only mode')])
  })
})
