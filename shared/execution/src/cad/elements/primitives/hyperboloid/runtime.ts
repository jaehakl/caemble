import { hyperboloidManifest } from './definition'
import {
  normalizeContinuousPrimitive,
  tessellateContinuousPrimitive,
  indexedGeometry,
  indexedSurfaces,
  type Tessellation,
} from '../../../geometry/continuous'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
export const hyperboloidDefinition = {
  kind: 'primitive',
  tag: 'hyperboloid',
  manifest: hyperboloidManifest,
  defaultProps: {},
  createGeometry(props) {
    return indexedGeometry(
      tessellateContinuousPrimitive(
        'hyperboloid',
        normalizeContinuousPrimitive('hyperboloid', props),
        props.tessellation as Tessellation,
      ),
    )
  },
  createSurfaces(_geometry, props) {
    return indexedSurfaces(
      tessellateContinuousPrimitive(
        'hyperboloid',
        normalizeContinuousPrimitive('hyperboloid', props),
        props.tessellation as Tessellation,
      ),
      { '1': 'Side', '2': 'Top' },
    )
  },
} satisfies PrimitiveElementDefinition<'hyperboloid'>
