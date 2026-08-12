import { primitives } from '@jscad/modeling'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dbTables } from '@/api'
import { serializeCadScene, type EvaluatedExperimentSnapshot } from '@/lib/cad'
import { createDocumentMaterialResolver } from './resolveMaterials'

function scene(materialName: string) {
  return serializeCadScene({
    geometryGroups: [],
    lengthUnit: 'mm',
    parts: [
      {
        id: materialName,
        geometry: primitives.cuboid({ size: [1, 1, 1] }),
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
    varsSchema: { width: { min: 1, max: 10 } },
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
})
