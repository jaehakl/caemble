import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { Tessellation, Asphere } from '../../../geometry/continuous'
import type { CadElementManifest } from '../../../evaluation/types'
export type AsphericCylinderAttributes = Readonly<{
  radius: number
  centerThickness: number
  top?: Asphere
  bottom?: Asphere
  tessellation?: Tessellation
}> &
  IntrinsicGeometryAttributes
export const asphericCylinderManifest = {
  tag: 'asphericCylinder',
  authoringName: 'AsphericCylinder',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<AsphericCylinder id="body" radius={5} centerThickness={2} />',
  summary:
    'Conic and even-polynomial faces joined by a cylindrical side. Full-aperture positive thickness is certified independently of tessellation.',
  keywords: ['asphericCylinder', 'AsphericCylinder'],
  properties: [
    {
      name: 'radius',
      type: 'number',
      required: true,
      authoringValue: '5',
      description: 'Positive maximum radial aperture in scene length units.',
    },
    {
      name: 'centerThickness',
      type: 'number',
      required: true,
      authoringValue: '2',
      description: 'Positive vertex separation h. Bottom vertex is -h/2; top vertex is +h/2.',
    },
    {
      name: 'top',
      type: 'Asphere',
      required: false,
      authoringValue: '{ curvature: 0, conic: 0, coefficients: [] }',
      description:
        'Top sag along +Z: c*rho^2/(1+sqrt(1-(1+k)*c^2*rho^2)) + sum(A_n*rho^n). Unique even n >= 4. Omitted face is planar.',
    },
    {
      name: 'bottom',
      type: 'Asphere',
      required: false,
      authoringValue: '{ curvature: 0, conic: 0, coefficients: [] }',
      description: 'Bottom sag uses the same +Z sign and coefficient convention as top. Omitted face is planar.',
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
  origin: 'Local Z axis; vertices at -centerThickness/2 and +centerThickness/2. No recentering.',
  surfaces: [
    {
      index: 0,
      label: 'Bottom',
      description: 'Bottom',
    },
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
  example: '<AsphericCylinder id="body" radius={5} centerThickness={2} />',
} as const satisfies CadElementManifest<'asphericCylinder'>
