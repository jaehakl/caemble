import { paraboloidManifest } from './definition'
import {
  normalizeContinuousPrimitive,
  tessellateContinuousPrimitive,
  indexedGeometry,
  indexedSurfaces,
  type Tessellation,
} from '../../../geometry/continuous'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
export const paraboloidDefinition = {
  kind: 'primitive',
  tag: 'paraboloid',
  manifest: paraboloidManifest,
  defaultProps: {},
  createGeometry(props) {
    return indexedGeometry(
      tessellateContinuousPrimitive(
        'paraboloid',
        normalizeContinuousPrimitive('paraboloid', props),
        props.tessellation as Tessellation,
      ),
    )
  },
  createSurfaces(_geometry, props) {
    return indexedSurfaces(
      tessellateContinuousPrimitive(
        'paraboloid',
        normalizeContinuousPrimitive('paraboloid', props),
        props.tessellation as Tessellation,
      ),
      { '1': 'Side', '2': 'Top' },
    )
  },
} satisfies PrimitiveElementDefinition<'paraboloid'>
