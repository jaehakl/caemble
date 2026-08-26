import type { CadElementManifest } from '../../../evaluation/types'
import type { GeometryIdentityAttributes } from '../../../model/structure'
import type { Vec3 } from '../../../model/types'

type TransformOperationAttributes = Readonly<{
  children?: unknown
}> &
  GeometryIdentityAttributes

export type TranslateAttributes = Readonly<{
  offset: Vec3
}> &
  TransformOperationAttributes

export type RotateAttributes = Readonly<{
  axis: Vec3
  angle: number
}> &
  TransformOperationAttributes

export type ScaleAttributes = Readonly<{
  x: number
  y: number
  z: number
}> &
  TransformOperationAttributes

export const translateManifest = {
  tag: 'translate',
  authoringName: 'translate',
  category: 'operation',
  standardTransforms: false,
  syntax: '<translate offset={[x,y,z]}>Geometry...</translate>',
  summary: '한 개 이상의 child Geometry를 parent 좌표계에서 상대 이동합니다.',
  keywords: ['translate', 'translation', 'offset', '이동', '변위'],
  properties: [
    {
      name: 'offset',
      type: 'Vec3',
      required: true,
      authoringValue: '[0, 0, 0]',
      description: 'parent 좌표계에서 적용할 XYZ 상대 이동입니다.',
    },
  ],
  children: { count: 'many', description: '동일한 상대 이동을 적용할 Geometry를 한 개 이상 받습니다.' },
  origin: 'child의 local 좌표계를 유지한 채 offset만큼 이동합니다.',
  surfaces: [],
  example: '<translate id="moved" offset={[20, 0, 0]}><Box id="body" size={[10, 10, 10]} /></translate>',
} as const satisfies CadElementManifest<'translate'>

export const rotateManifest = {
  tag: 'rotate',
  authoringName: 'rotate',
  category: 'operation',
  standardTransforms: false,
  syntax: '<rotate axis={[x,y,z]} angle={radians(degrees)}>Geometry...</rotate>',
  summary: '한 개 이상의 child Geometry를 원점 기준 axis-angle로 회전합니다.',
  keywords: ['rotate', 'rotation', 'axis angle', 'radians', '회전', '축'],
  properties: [
    {
      name: 'axis',
      type: 'Vec3',
      required: true,
      authoringValue: '[0, 0, 1]',
      description: '오른손 법칙을 적용할 회전축입니다.',
    },
    {
      name: 'angle',
      type: 'number',
      required: true,
      authoringValue: '0',
      description: 'radian 단위의 회전각입니다. degree 입력은 radians()로 변환합니다.',
    },
  ],
  children: { count: 'many', description: '동일한 axis-angle 회전을 적용할 Geometry를 한 개 이상 받습니다.' },
  origin: 'wrapper local 원점을 중심으로 오른손 axis-angle 회전을 적용합니다.',
  surfaces: [],
  example: '<rotate id="turned" axis={[0, 0, 1]} angle={radians(90)}><Box id="body" size={[10, 20, 5]} /></rotate>',
} as const satisfies CadElementManifest<'rotate'>

export const scaleManifest = {
  tag: 'scale',
  authoringName: 'scale',
  category: 'operation',
  standardTransforms: false,
  syntax: '<scale x={sx} y={sy} z={sz}>Geometry...</scale>',
  summary: '한 개 이상의 child Geometry를 원점 기준으로 축별 확대하거나 축소합니다.',
  keywords: ['scale', 'scaling', 'resize', '배율', '확대', '축소'],
  properties: [
    { name: 'x', type: 'number', required: true, authoringValue: '1', description: 'X축에 적용할 배율입니다.' },
    { name: 'y', type: 'number', required: true, authoringValue: '1', description: 'Y축에 적용할 배율입니다.' },
    { name: 'z', type: 'number', required: true, authoringValue: '1', description: 'Z축에 적용할 배율입니다.' },
  ],
  children: { count: 'many', description: '동일한 축별 배율을 적용할 Geometry를 한 개 이상 받습니다.' },
  origin: 'wrapper local 원점을 중심으로 X, Y, Z축 배율을 적용합니다.',
  surfaces: [],
  example: '<scale id="stretched" x={2} y={1} z={1}><Box id="body" size={[10, 10, 10]} /></scale>',
} as const satisfies CadElementManifest<'scale'>
