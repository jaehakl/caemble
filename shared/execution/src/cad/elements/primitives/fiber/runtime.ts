import type { PrimitiveElementDefinition } from '../../../evaluation/types'
import { fiberManifest } from './definition'
import { normalizeFiber, tessellateFiber } from '../../../geometry/fiber'
import { indexedGeometry, indexedSurfaces, type Tessellation } from '../../../geometry/continuous'
export const fiberDefinition = {
  kind: 'primitive',
  tag: 'fiber',
  manifest: fiberManifest,
  defaultProps: {},
  createGeometry(props) {
    return indexedGeometry(tessellateFiber(normalizeFiber(props), props.tessellation as Tessellation))
  },
  createSurfaces(_geometry, props) {
    return indexedSurfaces(tessellateFiber(normalizeFiber(props), props.tessellation as Tessellation), {
      0: 'Start cap',
      1: 'Side',
      2: 'End cap',
    })
  },
} satisfies PrimitiveElementDefinition<'fiber'>
