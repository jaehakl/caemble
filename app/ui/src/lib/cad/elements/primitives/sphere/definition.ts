import type { Rotation, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type SphereAttributes = Readonly<{
  radius: number
  segments?: number
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
}>

export const sphereManifest = {
  tag: 'sphere',
  category: 'primitive',
  syntax: '<sphere radius={r} segments={32} pos={[x,y,z]} />',
  summary: '원점 중심의 구를 생성합니다.',
} as const satisfies CadElementManifest<'sphere'>
