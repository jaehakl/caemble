import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCadSourceDocument } from '@/lib/cad'
import { saveCadDefinition } from './saveDefinition'

const mocks = vi.hoisted(() => ({
  experimentSave: vi.fn(),
  semanticHash: vi.fn(),
  structureSave: vi.fn(),
  rawHash: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: {
    Experiment: { save: mocks.experimentSave },
    Structure: { save: mocks.structureSave },
  },
}))

vi.mock('@/lib/cad', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cad')>()
  return {
    ...original,
    cadSemanticHash: mocks.semanticHash,
    rawCodeHash: mocks.rawHash,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.structureSave.mockResolvedValue({ id: 8, action: 'updated', parentId: null })
  mocks.experimentSave.mockResolvedValue({ id: 9, action: 'forked', parentId: 8 })
})

describe('saveCadDefinition', () => {
  it('updates an unchanged selected definition with its raw base hash', async () => {
    mocks.rawHash.mockResolvedValue('a'.repeat(64))
    const document = createCadSourceDocument('structure', 'unchanged source', 11)

    const result = await saveCadDefinition({
      document,
      kind: 'structure',
      savedCode: 'unchanged source',
      selectedId: 8,
      values: { name: 'Structure', description: 'description' },
    })

    expect(mocks.structureSave).toHaveBeenCalledWith({
      id: 8,
      name: 'Structure',
      description: 'description',
      code: 'unchanged source',
      rawCodeHash: 'a'.repeat(64),
      semanticHash: 'a'.repeat(64),
      semanticHashVersion: 1,
      baseRawCodeHash: 'a'.repeat(64),
    })
    expect(mocks.semanticHash).not.toHaveBeenCalled()
    expect(result).toEqual({ id: 8, action: 'updated', parentId: null, code: 'unchanged source', kind: 'structure' })
  })

  it('forces a selected definition into a new root without id or base hashes', async () => {
    mocks.rawHash.mockResolvedValue('b'.repeat(64))
    mocks.semanticHash.mockResolvedValue('c'.repeat(64))
    mocks.structureSave.mockResolvedValue({ id: 12, action: 'created', parentId: null })
    const document = createCadSourceDocument('structure', 'current source', 12)

    await saveCadDefinition({
      document,
      forceRoot: true,
      kind: 'structure',
      savedCode: 'previous source',
      selectedId: 8,
      values: { name: 'New root', description: '' },
    })

    expect(mocks.structureSave).toHaveBeenCalledWith({
      name: 'New root',
      description: null,
      code: 'current source',
      rawCodeHash: 'b'.repeat(64),
      semanticHash: 'c'.repeat(64),
      semanticHashVersion: 1,
    })
  })

  it('includes raw and semantic base hashes when a selected definition changes', async () => {
    mocks.rawHash.mockResolvedValueOnce('d'.repeat(64)).mockResolvedValueOnce('e'.repeat(64))
    mocks.semanticHash.mockResolvedValueOnce('f'.repeat(64)).mockResolvedValueOnce('1'.repeat(64))
    const document = createCadSourceDocument('structure', 'changed source', 13)

    await saveCadDefinition({
      document,
      kind: 'structure',
      savedCode: 'base source',
      selectedId: 8,
      values: { name: 'Child', description: 'branch' },
    })

    expect(mocks.structureSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 8,
        rawCodeHash: 'd'.repeat(64),
        semanticHash: 'f'.repeat(64),
        baseRawCodeHash: 'e'.repeat(64),
        baseSemanticHash: '1'.repeat(64),
      }),
    )
  })

  it('atomically includes current and base Python hashes for an Experiment revision', async () => {
    mocks.rawHash
      .mockResolvedValueOnce('a'.repeat(64))
      .mockResolvedValueOnce('c'.repeat(64))
      .mockResolvedValueOnce('e'.repeat(64))
      .mockResolvedValueOnce('f'.repeat(64))
    mocks.semanticHash.mockResolvedValueOnce('b'.repeat(64)).mockResolvedValueOnce('d'.repeat(64))
    const document = createCadSourceDocument(
      'experiment',
      'experiment source',
      14,
      'async def simulate(*, sim, tasks, vars, world):\n    return 2\n',
    )

    const result = await saveCadDefinition({
      document,
      kind: 'experiment',
      savedCode: 'experiment source',
      savedSimulationCode: 'async def simulate(*, sim, tasks, vars, world):\n    return 1\n',
      selectedId: 8,
      simulationCode: document.simulationCode,
      values: { name: 'Python child', description: 'atomic sources' },
    })

    expect(mocks.experimentSave).toHaveBeenCalledWith({
      id: 8,
      name: 'Python child',
      description: 'atomic sources',
      code: 'experiment source',
      rawCodeHash: 'a'.repeat(64),
      semanticHash: 'b'.repeat(64),
      semanticHashVersion: 1,
      baseRawCodeHash: 'c'.repeat(64),
      baseSemanticHash: 'd'.repeat(64),
      simulationCode: document.simulationCode,
      simulationRawCodeHash: 'e'.repeat(64),
      baseSimulationRawCodeHash: 'f'.repeat(64),
    })
    expect(result).toEqual({
      id: 9,
      action: 'forked',
      parentId: 8,
      code: 'experiment source',
      kind: 'experiment',
      simulationCode: document.simulationCode,
    })
  })
})
