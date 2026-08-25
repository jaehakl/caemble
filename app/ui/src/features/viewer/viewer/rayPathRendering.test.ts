import { describe, expect, it } from 'vitest'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import type { RayPathBundle } from '@/lib/cad'
import { createRayPathRenderGeometries } from './rayPathRendering'

installSyntheticCatalog({ quantityKinds: [{ name: 'Length', applicableUnits: ['m', 'mm'] }] })

describe('ray-path viewer geometry', () => {
  it('keeps every stored path in typed line buffers and converts meters to the viewer unit', () => {
    const bundle: RayPathBundle = {
      id: 'primary',
      pathCount: 2,
      segmentCount: 3,
      vertices: new Float32Array([0, 0, 0, 0.001, 0, 0, 0.002, 0, 0, 0, 0.001, 0, 0, 0.002, 0]),
      pathOffsets: new Uint32Array([0, 3, 5]),
      segmentPower: new Float32Array([1, 0.25, 0.5]),
      pathWavelength: new Float32Array([500e-9, 650e-9]),
      segmentEvent: new Uint8Array([1, 5, 7]),
    }

    const [geometry] = createRayPathRenderGeometries([bundle], 'mm')
    expect(geometry.positions).toBeInstanceOf(Float32Array)
    expect(geometry.colors).toBeInstanceOf(Float32Array)
    expect(geometry.indices).toBeInstanceOf(Uint16Array)
    expect([...geometry.positions]).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 2, 0])
    expect([...geometry.indices]).toEqual([0, 1, 1, 2, 3, 4])
  })
})
