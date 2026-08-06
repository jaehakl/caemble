import { describe, expect, it, vi } from 'vitest'
import {
  CAD_SOURCE_API_VERSION,
  CAD_SOURCE_FORMAT_VERSION,
  MAX_CAD_SOURCE_BYTES,
  assertCadSourceDocument,
  cadSourceHash,
  createCadSourceDocument,
  rerollCadSourceDocument,
  updateCadSimulationCode,
  updateCadSource,
  type CadSourceDocument,
} from './document'

function sourceDocument(source = 'source'): CadSourceDocument {
  return {
    apiVersion: CAD_SOURCE_API_VERSION,
    formatVersion: CAD_SOURCE_FORMAT_VERSION,
    kind: 'structure',
    realizationSeed: 7,
    source,
  }
}

describe('CadSourceDocument', () => {
  it('hashes the single source and provenance while ignoring realization seed', async () => {
    const document = sourceDocument()
    const differentSeed = { ...document, realizationSeed: 99 }
    const hash = await cadSourceHash(document)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    await expect(cadSourceHash(differentSeed)).resolves.toBe(hash)
    await expect(cadSourceHash(updateCadSource(document, 'changed'))).resolves.not.toBe(hash)
    await expect(cadSourceHash({ ...document, kind: 'experiment' })).resolves.not.toBe(hash)
  })

  it('includes Python simulation source in the Experiment program hash', async () => {
    const document = createCadSourceDocument(
      'experiment',
      'export default experiment({})',
      7,
      'async def simulate(*, sim, tasks, vars, world):\n    return None\n',
    )
    const hash = await cadSourceHash(document)

    await expect(cadSourceHash({ ...document, realizationSeed: 99 })).resolves.toBe(hash)
    await expect(
      cadSourceHash(
        updateCadSimulationCode(
          document,
          'async def simulate(*, sim, tasks, vars, world):\n    return await sim.random()\n',
        ),
      ),
    ).resolves.not.toBe(hash)
  })

  it('changes only source on edits and only seed on reroll', () => {
    const document = sourceDocument('before')
    const edited = updateCadSource(document, 'after')
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
      array[0] = 7
      return array
    }) as Crypto['getRandomValues'])

    try {
      const rerolled = rerollCadSourceDocument(edited)
      expect(edited).toEqual({ ...document, source: 'after' })
      expect(rerolled).toEqual({ ...edited, realizationSeed: 8 })
    } finally {
      getRandomValues.mockRestore()
    }
  })

  it('enforces an exact plain single-file document and its UTF-8 byte limit', () => {
    expect(() => assertCadSourceDocument({ ...sourceDocument(), files: {} })).toThrow('files is not allowed')
    expect(() => assertCadSourceDocument({ ...sourceDocument(), apiVersion: 2 })).toThrow('API version 3')
    expect(() => createCadSourceDocument('structure', 'x'.repeat(MAX_CAD_SOURCE_BYTES + 1), 1)).toThrow(
      `exceeds ${MAX_CAD_SOURCE_BYTES} bytes`,
    )
    expect(() => createCadSourceDocument('structure', '한'.repeat(MAX_CAD_SOURCE_BYTES / 2), 1)).toThrow(
      `exceeds ${MAX_CAD_SOURCE_BYTES} bytes`,
    )
  })
})
