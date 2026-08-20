import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { CadElementManifest } from '../../../evaluation/types'

export type SphereAttributes = Readonly<{
  radius?: number
  segments?: number
}> &
  IntrinsicGeometryAttributes

export const sphereManifest = {
  tag: 'sphere',
  authoringName: 'Sphere',
  category: 'primitive',
  standardTransforms: true,
  syntax: '<Sphere radius={r} segments={32} />',
  summary: '원점 중심의 구를 생성합니다.',
  keywords: ['sphere', 'ball', '구', '구체'],
  properties: [
    {
      name: 'radius',
      type: 'number',
      required: false,
      default: '0.5',
      authoringValue: '0.5',
      description: '유한한 양수 구 반지름입니다.',
    },
    {
      name: 'segments',
      type: 'number',
      required: false,
      default: '32',
      authoringValue: '32',
      description: '표면 분할 해상도이며 4 이상의 안전한 정수여야 합니다.',
    },
  ],
  children: { count: 'none', description: '자식을 받지 않는 primitive입니다.' },
  origin: '구의 중심이 원점에 있습니다.',
  surfaces: ['Outer'],
  example: '<Sphere id="ball" radius={12} position={[0, 0, 12]} />',
} as const satisfies CadElementManifest<'sphere'>
