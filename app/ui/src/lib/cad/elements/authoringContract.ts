import type { CadAuthoringContract } from '../evaluation/types'

export const cadAuthoringContract = {
  apiVersion: 9,
  identity: {
    name: 'id',
    type: 'string',
    required: false,
    default: 'lower-kebab authoring name with sibling ordinal',
    authoringValue: '"geometry"',
    description:
      'Geometry components and primitives receive a lower-kebab local ID from their authoring name. Repeated automatic sibling IDs add -2, -3, and so on. Explicit IDs remain recommended when identity must survive insertion or reordering. Nested IDs form dot-separated solver paths.',
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
        description: 'Exactly three finite numbers giving relative position in the parent coordinate system.',
      },
      {
        name: 'rotation',
        type: 'Vec3',
        required: false,
        default: '[0, 0, 0]',
        authoringValue: '[0, 0, 0]',
        description: 'Exactly three finite XYZ Euler angles in radians.',
      },
      {
        name: 'scale',
        type: 'Vec3',
        required: false,
        default: '[1, 1, 1]',
        authoringValue: '[1, 1, 1]',
        description: 'Exactly three finite per-axis factors applied before rotation and position.',
      },
    ],
    legacyProperties: [
      {
        name: 'pos',
        type: 'Vec3',
        required: false,
        default: '[0, 0, 0]',
        authoringValue: '[0, 0, 0]',
        description:
          'Deprecated v7 compatibility alias containing exactly three finite numbers; new code uses position.',
      },
      {
        name: 'rotate',
        type: '{ axis: Vec3; angle: number }',
        required: false,
        default: 'none',
        authoringValue: '{ axis: [0, 0, 1], angle: 0 }',
        description:
          'Deprecated v7 compatibility axis-angle rotation with a finite angle and nonzero finite axis; new code uses XYZ Euler rotation.',
      },
    ],
    mixing: 'A node cannot mix canonical position/rotation with deprecated pos/rotate.',
  },
} as const satisfies CadAuthoringContract
