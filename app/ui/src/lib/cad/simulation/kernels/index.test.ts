import { describe, expect, it } from 'vitest'
import {
  dcCurrentDensity,
  dcCurrentDensityDescriptor,
  kernelAuthoring,
  kernelModules,
  steadyStateHeat,
  steadyStateHeatDescriptor,
} from '.'

describe('production kernel authoring catalog', () => {
  it('contains the DC current-density and steady-state Heat kernels', () => {
    expect(kernelModules).toEqual([
      { descriptor: dcCurrentDensityDescriptor },
      { descriptor: steadyStateHeatDescriptor },
    ])
    expect(kernelModules.every((entry) => Reflect.ownKeys(entry).join(',') === 'descriptor')).toBe(true)
    expect(kernelAuthoring).toEqual({ dcCurrentDensity, steadyStateHeat })
  })

  it('keeps each readable TypeScript descriptor identified by name and version', () => {
    expect(kernelModules.map(({ descriptor }) => `${descriptor.name}@${descriptor.version}`)).toEqual([
      'dc-current-density@0.0.0',
      'steady-state-heat@0.0.0',
    ])
  })
})
