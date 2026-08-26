import type { CadAuthoringContract } from '../evaluation/types'

export const cadAuthoringContract = {
  identity: {
    name: 'id',
    type: 'string',
    required: false,
    default: 'lower-kebab authoring name with sibling ordinal',
    authoringValue: '"geometry"',
    description:
      'Geometry components and primitives receive a lower-kebab local ID from their authoring name. Repeated automatic sibling IDs add -2, -3, and so on. Explicit IDs remain recommended when identity should survive insertion or reordering. Nested IDs form dot-separated solver paths.',
    pathExample: 'goal.pole',
  },
  transforms: {
    applicationOrder: ['scale', 'rotation', 'position'],
    rotationConvention: 'Right-handed intrinsic XYZ Euler angles in radians, matching the Three/R3F default XYZ order.',
    canonicalProperties: [
      {
        name: 'position',
        type: 'Vec3',
        required: false,
        default: '[0, 0, 0]',
        authoringValue: '[0, 0, 0]',
        description: 'Relative XYZ position in the parent coordinate system.',
      },
      {
        name: 'rotation',
        type: 'Vec3',
        required: false,
        default: '[0, 0, 0]',
        authoringValue: '[0, 0, 0]',
        description: 'XYZ Euler angles in radians.',
      },
      {
        name: 'scale',
        type: 'Vec3',
        required: false,
        default: '[1, 1, 1]',
        authoringValue: '[1, 1, 1]',
        description: 'Per-axis factors applied before rotation and position.',
      },
    ],
  },
} as const satisfies CadAuthoringContract
