import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { Tessellation } from '../../../geometry/continuous'
import type { CadElementManifest } from '../../../evaluation/types'
export type EllipsoidAttributes = Readonly<{
  focalDistance: number
  axialRadius: number
  tessellation?: Tessellation
}> &
  IntrinsicGeometryAttributes
export const ellipsoidManifest = {
  tag: 'ellipsoid',
  authoringName: 'Ellipsoid',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<Ellipsoid id="body" focalDistance={3} axialRadius={5} />',
  summary: 'Prolate ellipsoid defined by a focus pair; focalDistance=0 gives a sphere.',
  keywords: ['ellipsoid', 'Ellipsoid'],
  properties: [
    {
      name: 'focalDistance',
      type: 'number',
      required: true,
      authoringValue: '3',
      description: 'Half the focus separation, f >= 0. Foci are [0,0,+/-f].',
    },
    {
      name: 'axialRadius',
      type: 'number',
      required: true,
      authoringValue: '5',
      description: 'Axial semiaxis a > f. Transverse semiaxis is sqrt(a^2-f^2).',
    },
    {
      name: 'tessellation',
      type: 'Tessellation',
      required: false,
      authoringValue: '{ radialSegments: 64, meridianSegments: 32 }',
      description:
        'Mesh only: radialSegments >= 3 (default 64), meridianSegments >= 2 (default 32). Analysis applies its refinement profile.',
    },
  ],
  children: {
    count: 'none',
    description: 'Closed primitive solid.',
  },
  origin: 'The focus midpoint is the origin; Z vertices are +/-axialRadius. No caps.',
  surfaces: [
    {
      index: 0,
      label: 'Outer',
      description: 'Outer',
    },
  ],
  example: '<Ellipsoid id="body" focalDistance={3} axialRadius={5} />',
} as const satisfies CadElementManifest<'ellipsoid'>
