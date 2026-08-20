import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type BoxAttributes = Readonly<{
  size: Vec3
}> &
  IntrinsicGeometryAttributes

export const boxManifest = {
  tag: 'box',
  authoringName: 'Box',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<Box size={[x,y,z]} />',
  summary: '축 정렬 직육면체를 생성합니다.',
  keywords: ['box', 'cuboid', 'rectangular prism', '박스', '직육면체'],
  properties: [
    {
      name: 'size',
      type: 'Vec3',
      required: true,
      description: '각각 X, Y, Z 방향의 전체 길이인 정확히 세 개의 유한한 양수입니다.',
    },
  ],
  children: { count: 'none', description: '자식을 받지 않는 primitive입니다.' },
  origin: '기하 중심이 원점에 있고 모서리는 좌표축과 평행합니다.',
  surfaces: ['-X', '+X', '-Y', '+Y', 'Bottom', 'Top'],
  example: '<Box id="backboard" size={[180, 5, 100]} position={[0, 200, 280]} />',
} as const satisfies CadElementManifest<'box'>
