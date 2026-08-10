import { primitives } from '@jscad/modeling'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dbTables } from '@/api'
import { serializeCadScene, type EvaluatedDocumentSnapshot } from '@/lib/cad'
import { createDocumentMaterialResolver } from './resolveMaterials'

function materialSnapshot(seed: number): EvaluatedDocumentSnapshot {
  return {
    kind: 'structure',
    scene: serializeCadScene({
      geometryGroups: [],
      lengthUnit: 'mm',
      parts: [
        {
          id: 'body',
          geometry: primitives.cuboid({ size: [seed, 1, 1] }),
          material: { name: 'Core', variables: { color: '#112233' } },
          surfaces: [],
        },
      ],
      surfaceGroups: [],
      tree: { children: [], key: 'structure', label: 'Structure' },
    }),
    seed,
    sourceHash: 'e'.repeat(64),
    variables: { width: seed },
    varsSchema: { width: { min: 1, max: 10 } },
  }
}

describe('createDocumentMaterialResolver', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reuses database rows for the same material set and resolves every snapshot locally', async () => {
    const listNames = vi.spyOn(dbTables.MaterialName, 'listRows').mockResolvedValue({
      items: [{ id: 1, material_id: 10, name: 'Core' }],
      total: 1,
    })
    const listMaterials = vi.spyOn(dbTables.Material, 'listRows').mockResolvedValue({
      items: [{ id: 10 }],
      total: 1,
    })
    const listParameters = vi.spyOn(dbTables.MaterialParameter, 'listRows').mockResolvedValue({
      items: [],
      total: 0,
    })
    const resolve = createDocumentMaterialResolver(null)

    const first = await resolve(materialSnapshot(2))
    const second = await resolve(materialSnapshot(4))

    expect(listNames).toHaveBeenCalledOnce()
    expect(listMaterials).toHaveBeenCalledOnce()
    expect(listParameters).toHaveBeenCalledOnce()
    expect(first).not.toBe(second)
    expect('materialParameters' in first).toBe(true)
    expect('materialParameters' in second).toBe(true)
    if (!('materialParameters' in first) || !('materialParameters' in second)) throw new Error('Expected Structure')
    expect(first.materialParameters.materials).toHaveProperty('Core')
    expect(second.materialParameters.materials).toHaveProperty('Core')
  })
})
