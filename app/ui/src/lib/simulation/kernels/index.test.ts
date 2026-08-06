import { describe, expect, it } from 'vitest'
import {
  dcCurrentDensity,
  dcCurrentDensityDescriptor,
  kernelAuthoring,
  kernelModules,
  steadyStateHeat,
  steadyStateHeatDescriptor,
} from '.'
import { canonicalDataHash } from '../authoring'

describe('production kernel catalog', () => {
  it('contains the DC current-density and steady-state Heat kernels', () => {
    expect(kernelModules).toEqual([
      { descriptor: dcCurrentDensityDescriptor },
      { descriptor: steadyStateHeatDescriptor },
    ])
    expect(kernelModules.every((entry) => Reflect.ownKeys(entry).join(',') === 'descriptor')).toBe(true)
    expect(kernelAuthoring).toEqual({ dcCurrentDensity, steadyStateHeat })
  })

  it('pins the descriptor hashes registered by the Python CAE slave', () => {
    expect(canonicalDataHash(dcCurrentDensityDescriptor)).toBe('ec79ace3')
    expect(canonicalDataHash(steadyStateHeatDescriptor)).toBe('a955fbb5')
  })
})
