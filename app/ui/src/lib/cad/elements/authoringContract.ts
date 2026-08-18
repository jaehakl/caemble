import type { CadAuthoringContract } from '../evaluation/types'

export const cadAuthoringContract = {
  apiVersion: 7,
  identity: {
    name: 'id',
    type: 'string',
    required: false,
    description:
      'Intrinsic CAD elements may define a stable local ID using Unicode letters, numbers, _ or -. Sibling IDs are unique. Geometry component IDs remain required and already own their result; forward a component id to an intrinsic only when an additional nested segment is intended. Nested IDs form dot-separated solver paths.',
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
        description: 'Exactly three finite numbers giving relative position in the parent coordinate system.',
      },
      {
        name: 'rotation',
        type: 'Vec3',
        required: false,
        default: '[0, 0, 0]',
        description: 'Exactly three finite XYZ Euler angles in radians.',
      },
      {
        name: 'scale',
        type: 'Vec3',
        required: false,
        default: '[1, 1, 1]',
        description: 'Exactly three finite per-axis factors applied before rotation and position.',
      },
    ],
    legacyProperties: [
      {
        name: 'pos',
        type: 'Vec3',
        required: false,
        default: '[0, 0, 0]',
        description:
          'Deprecated v7 compatibility alias containing exactly three finite numbers; new code uses position.',
      },
      {
        name: 'rotate',
        type: '{ axis: Vec3; angle: number }',
        required: false,
        description:
          'Deprecated v7 compatibility axis-angle rotation with a finite angle and nonzero finite axis; new code uses XYZ Euler rotation.',
      },
    ],
    mixing: 'A node cannot mix canonical position/rotation with deprecated pos/rotate.',
  },
} as const satisfies CadAuthoringContract
