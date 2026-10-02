import { ellipsoidManifest } from './definition'
import {
  normalizeContinuousPrimitive,
  tessellateContinuousPrimitive,
  indexedGeometry,
  indexedSurfaces,
  type Tessellation,
} from '../../../geometry/continuous'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
export const ellipsoidDefinition = {
  kind: 'primitive',
  tag: 'ellipsoid',
  manifest: ellipsoidManifest,
  defaultProps: {},
  createGeometry(props) {
    return indexedGeometry(
      tessellateContinuousPrimitive(
        'ellipsoid',
        normalizeContinuousPrimitive('ellipsoid', props),
        props.tessellation as Tessellation,
      ),
    )
  },
  createSurfaces(_geometry, props) {
    return indexedSurfaces(
      tessellateContinuousPrimitive(
        'ellipsoid',
        normalizeContinuousPrimitive('ellipsoid', props),
        props.tessellation as Tessellation,
      ),
      { '0': 'Outer' },
    )
  },
} satisfies PrimitiveElementDefinition<'ellipsoid'>
