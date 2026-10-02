import { asphericCylinderManifest } from './definition'
import {
  normalizeContinuousPrimitive,
  tessellateContinuousPrimitive,
  indexedGeometry,
  indexedSurfaces,
  type Tessellation,
} from '../../../geometry/continuous'
import type { PrimitiveElementDefinition } from '../../../evaluation/types'
export const asphericCylinderDefinition = {
  kind: 'primitive',
  tag: 'asphericCylinder',
  manifest: asphericCylinderManifest,
  defaultProps: {},
  createGeometry(props) {
    return indexedGeometry(
      tessellateContinuousPrimitive(
        'asphericCylinder',
        normalizeContinuousPrimitive('asphericCylinder', props),
        props.tessellation as Tessellation,
      ),
    )
  },
  createSurfaces(_geometry, props) {
    return indexedSurfaces(
      tessellateContinuousPrimitive(
        'asphericCylinder',
        normalizeContinuousPrimitive('asphericCylinder', props),
        props.tessellation as Tessellation,
      ),
      { '0': 'Bottom', '1': 'Side', '2': 'Top' },
    )
  },
} satisfies PrimitiveElementDefinition<'asphericCylinder'>
