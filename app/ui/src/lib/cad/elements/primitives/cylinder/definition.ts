import type { Rotation, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type CylinderAttributes = Readonly<{
  radius: number
  radius_2?: number
  height: number
  segments?: number
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
}>

export const cylinderManifest = {
  tag: 'cylinder',
  category: 'primitive',
  syntax: '<cylinder radius={r1} radius_2={r2} height={h} segments={32} pos={[x,y,z]} />',
  summary: '서로 다른 양 끝 반지름을 지원하는 원점 중심의 원기둥을 생성합니다.',
} as const satisfies CadElementManifest<'cylinder'>
