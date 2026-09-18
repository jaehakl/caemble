import { describe, expect, it } from 'vitest'
import { createRayPathRenderGeometries } from './rayPathRendering'
import type { PolylineBundle } from '@/lib/cad/model'

describe('equivalent lens path rendering', () => {
  it('leaves the internal reference-plane jump undrawn while preserving both external rays', () => {
    const bundle: PolylineBundle = {
      id: 'lens',
      pathCount: 1,
      segmentCount: 3,
      vertices: Float32Array.from([0, 0, 0, 0, 0, 1, 0.1, 0, 2, 0, 0, 3]),
      pathOffsets: Uint32Array.from([0, 4]),
      segmentPower: Float32Array.from([1, 0.8, 0.8]),
      pathWavelength: Float32Array.from([550e-9]),
      segmentEvent: Uint8Array.from([1, 12, 5]),
    }
    const rendered = createRayPathRenderGeometries([bundle], 'm')
    expect(rendered).toHaveLength(1)
    expect([...rendered[0]!.indices]).toEqual([0, 1, 2, 3])
    expect([...rendered[0]!.positions]).toEqual([0, 0, 0, 0, 0, 1, bundle.vertices[6], 0, 2, 0, 0, 3])
  })
})
