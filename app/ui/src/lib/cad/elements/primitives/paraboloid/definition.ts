import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { Tessellation } from '../../../geometry/continuous'
import type { CadElementManifest } from '../../../evaluation/types'
export type ParaboloidAttributes = Readonly<{
  focalLength: number
  radius: number
  tessellation?: Tessellation
}> &
  IntrinsicGeometryAttributes
export const paraboloidManifest = {
  tag: 'paraboloid',
  authoringName: 'Paraboloid',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<Paraboloid id="body" focalLength={3} radius={4} />',
  summary: 'Rotational paraboloid z=rho^2/(4*f), closed by a disk at maximum radius.',
  keywords: ['paraboloid', 'Paraboloid'],
  properties: [
    {
      name: 'focalLength',
      type: 'number',
      required: true,
      authoringValue: '3',
      description: 'Positive focal length f; focus [0,0,f], vertex [0,0,0].',
    },
    {
      name: 'radius',
      type: 'number',
      required: true,
      authoringValue: '4',
      description: 'Positive maximum radius r. Top height is r^2/(4*f). No Z clipping input.',
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
  origin: 'Vertex at origin, opening +Z. Surface 1 is curved; 2 is the top disk. There is no surface 0.',
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
  example: '<Paraboloid id="body" focalLength={3} radius={4} />',
} as const satisfies CadElementManifest<'paraboloid'>
