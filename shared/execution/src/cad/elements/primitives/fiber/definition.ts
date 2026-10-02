import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

import type { Tessellation } from '../../../geometry/continuous'
export type FiberSegment = Readonly<
  { kind: 'line'; length: number } | { kind: 'arc'; radius: number; angle: number; normal: Vec3 }
>
export type FiberPath = Readonly<{ start: Vec3; direction: Vec3; segments: readonly FiberSegment[] }>
export type RadiusKnot = Readonly<{ s: number; radius: number }>
export type FiberAttributes = Readonly<{
  from?: Vec3
  to?: Vec3
  path?: FiberPath
  radius?: number
  radiusProfile?: readonly RadiusKnot[]
  tessellation?: Tessellation
}> &
  IntrinsicGeometryAttributes
export const fiberManifest = {
  tag: 'fiber',
  authoringName: 'Fiber',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<Fiber from={p0} to={p1} radius={r} />',
  summary: 'Line/Arc 중심선과 호 길이에 따른 연속 반경 profile로 닫힌 solid를 만듭니다.',
  keywords: ['fiber', 'sweep', 'tube', '섬유', '튜브'],
  properties: [
    {
      name: 'from',
      type: 'Vec3',
      required: false,
      default: '[0,0,-0.5]',
      authoringValue: '[0,0,-0.5]',
      description: 'Straight centerline start. Mutually exclusive with path.',
    },
    {
      name: 'to',
      type: 'Vec3',
      required: false,
      default: '[0,0,0.5]',
      authoringValue: '[0,0,0.5]',
      description: 'Straight centerline end. Mutually exclusive with path.',
    },
    {
      name: 'radius',
      type: 'number',
      required: false,
      default: '0.05',
      authoringValue: '0.05',
      description: 'Positive constant radius in scene length units. Mutually exclusive with radiusProfile.',
    },
    {
      name: 'path',
      type: 'FiberPath',
      required: false,
      authoringValue: "{ start: [0,0,0], direction: [0,0,1], segments: [{ kind: 'line', length: 10 }] }",
      description:
        "Continuous centerline. Line {kind:'line',length}; Arc {kind:'arc',radius,angle,normal}. Each inherits the preceding endpoint/tangent. Signed angles are radians and normal is the local bending-plane normal.",
    },
    {
      name: 'radiusProfile',
      type: 'readonly RadiusKnot[]',
      required: false,
      authoringValue: '[{ s: 0, radius: 1 }, { s: 10, radius: 0.5 }]',
      description:
        'Positive radius knots at strictly increasing physical arc lengths s, spanning 0 through the full path length. Piecewise linear interpolation preserves slope creases.',
    },
    {
      name: 'tessellation',
      type: 'Tessellation',
      required: false,
      authoringValue: '{ pathSegments: 128, radialSegments: 12 }',
      default: '{ pathSegments: 128, radialSegments: 12 }',
      description:
        'Mesh only. pathSegments >= 1 and radialSegments >= 3. Segment and radius-profile boundaries are always sampled.',
    },
  ],
  children: { count: 'none', description: '자식을 받지 않는 primitive입니다.' },
  origin: '입력한 경로 좌표를 유지합니다. 자동으로 재중심화하지 않습니다.',
  surfaces: [
    { index: 0, label: 'Start cap', description: 'Fiber path의 시작 단면입니다.' },
    { index: 1, label: 'Side', description: 'Fiber path를 따라 생성된 옆면입니다.' },
    { index: 2, label: 'End cap', description: 'Fiber path의 끝 단면입니다.' },
  ],
  example: '<Fiber id="strand" from={[0, 0, 0]} to={[0, 0, 20]} radius={1} />',
} as const satisfies CadElementManifest<'fiber'>
