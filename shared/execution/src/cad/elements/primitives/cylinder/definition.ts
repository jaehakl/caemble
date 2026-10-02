import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { CadElementManifest } from '../../../evaluation/types'

export type CylinderAttributes = Readonly<{
  radius?: number
  radius_2?: number
  height?: number
  segments?: number
}> &
  IntrinsicGeometryAttributes

export const cylinderManifest = {
  tag: 'cylinder',
  authoringName: 'Cylinder',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<Cylinder radius={r1} radius_2={r2} height={h} segments={32} />',
  summary: '서로 다른 양 끝 반지름을 지원하는 원점 중심의 원기둥을 생성합니다.',
  keywords: ['cylinder', 'cone', 'frustum', '원기둥', '원뿔대'],
  properties: [
    {
      name: 'radius',
      type: 'number',
      required: false,
      default: '0.5',
      authoringValue: '0.5',
      description: '아래쪽 끝의 반지름입니다.',
    },
    {
      name: 'radius_2',
      type: 'number',
      required: false,
      default: 'radius',
      authoringValue: '0.5',
      description: '위쪽 끝의 반지름입니다. 생략하면 radius와 같습니다.',
    },
    {
      name: 'height',
      type: 'number',
      required: false,
      default: '1',
      authoringValue: '1',
      description: 'Z축 방향의 전체 높이입니다.',
    },
    {
      name: 'segments',
      type: 'number',
      required: false,
      default: '32',
      authoringValue: '32',
      description: '둘레 분할 수입니다.',
    },
  ],
  children: { count: 'none', description: '자식을 받지 않는 primitive입니다.' },
  origin: '중심이 원점에 있고 기본 축은 +Z이며 양 끝은 z = ±height/2에 있습니다.',
  surfaces: [
    { index: 0, label: 'Bottom', description: '로컬 -Z 끝 cap입니다. 반지름이 0이면 존재하지 않습니다.' },
    { index: 1, label: 'Side', description: '축을 둘러싼 옆면입니다.' },
    { index: 2, label: 'Top', description: '로컬 +Z 끝 cap입니다. 반지름이 0이면 존재하지 않습니다.' },
  ],
  example: '<Cylinder id="pole" radius={3} height={300} position={[0, 0, 150]} />',
} as const satisfies CadElementManifest<'cylinder'>
