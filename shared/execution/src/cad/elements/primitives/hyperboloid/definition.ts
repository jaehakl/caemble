import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { Tessellation } from '../../../geometry/continuous'
import type { CadElementManifest } from '../../../evaluation/types'
export type HyperboloidAttributes = Readonly<{
  focalDistance: number
  axialRadius: number
  radius: number
  tessellation?: Tessellation
}> &
  IntrinsicGeometryAttributes
export const hyperboloidManifest = {
  tag: 'hyperboloid',
  authoringName: 'Hyperboloid',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<Hyperboloid id="body" focalDistance={5} axialRadius={3} radius={4} />',
  summary: 'Positive-Z branch of a two-sheet hyperboloid, closed by a disk at the maximum radius.',
  keywords: ['hyperboloid', 'Hyperboloid'],
  properties: [
    {
      name: 'focalDistance',
      type: 'number',
      required: true,
      authoringValue: '5',
      description: 'Half the focus separation f > a > 0; foci [0,0,+/-f].',
    },
    {
      name: 'axialRadius',
      type: 'number',
      required: true,
      authoringValue: '3',
      description: 'Positive vertex coordinate a; transverse scale b=sqrt(f^2-a^2).',
    },
    {
      name: 'radius',
      type: 'number',
      required: true,
      authoringValue: '4',
      description:
        'Positive maximum radius r. Top height is a*sqrt(1+r^2/b^2); solid height is zTop-a. No Z clipping input.',
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
  origin:
    'The focus midpoint remains the origin; vertex [0,0,a]. Surface 1 is curved; 2 is the top disk. There is no surface 0.',
  surfaces: [
    {
      index: 1,
      label: 'Side',
      description: 'Side',
    },
    {
      index: 2,
      label: 'Top',
      description: 'Top',
    },
  ],
  example: '<Hyperboloid id="body" focalDistance={5} axialRadius={3} radius={4} />',
} as const satisfies CadElementManifest<'hyperboloid'>
