import { describe, expect, it } from 'vitest'
import { identityCartesianBasis } from '../quantitykind/identityBasis'
import { canonicalDataHash, simulationProgramManifest } from './authoring'

describe('canonicalDataHash', () => {
  it.each([
    ['Korean UTF-8', '한글', 'f0d67a21'],
    ['small exponent', 1e-7, 'ce4d481e'],
    ['large exponent', 1e21, '16b2c856'],
    ['UTF-8 key ordering', { 가: 3, é: 1, z: 2 }, '781642d6'],
  ])('has a cross-language golden hash for %s', (_name, value, expected) => {
    expect(canonicalDataHash(value)).toBe(expected)
  })

  it('normalizes negative zero, object insertion order, and undefined object fields', () => {
    expect(canonicalDataHash(-0)).toBe(canonicalDataHash(0))
    expect(canonicalDataHash({ z: 2, a: 1 })).toBe(canonicalDataHash({ a: 1, z: 2 }))
    expect(canonicalDataHash({ a: 1, omitted: undefined })).toBe(canonicalDataHash({ a: 1 }))
  })

  it('rejects non-finite, sparse, circular, non-plain, and invalid-Unicode data', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => canonicalDataHash(Number.NaN)).toThrow('must be finite')
    expect(() => canonicalDataHash([undefined])).toThrow('must contain only')
    expect(() => canonicalDataHash(circular)).toThrow('must not be circular')
    expect(() => canonicalDataHash(new Date())).toThrow('must be plain objects')
    expect(() => canonicalDataHash('\ud800')).toThrow('valid Unicode')
  })
})

describe('simulationProgramManifest', () => {
  it('canonicalizes an omitted tensor basis to the shared identity basis before hashing', () => {
    const manifest = simulationProgramManifest(
      {},
      {
        currentDensity: {
          dtype: 'float64',
          unit: 'A.m-2',
          quantityKind: 'electromagnetism.ElectricCurrentDensity',
        },
      },
      'a'.repeat(64),
      'async def simulate(*, sim, tasks, vars, world):\n    return None\n',
      'b'.repeat(64),
    )

    expect(manifest.recordedData.currentDensity.basis).toEqual(identityCartesianBasis)
    expect(manifest.recordedDataSchemaHash).toBe(canonicalDataHash(manifest.recordedData))
  })
})
