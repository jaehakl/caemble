import { describe, expect, it } from 'vitest'
import {
  dcCurrentDensity,
  dcCurrentDensityKernel,
  kernelAuthoring,
  kernelModules,
  steadyStateHeat,
  steadyStateHeatKernel,
} from '.'

describe('production kernel catalog', () => {
  it('contains the DC current-density and steady-state Heat kernels', () => {
    expect(kernelModules).toEqual([dcCurrentDensityKernel, steadyStateHeatKernel])
    expect(kernelAuthoring).toEqual({ dcCurrentDensity, steadyStateHeat })
  })
})
