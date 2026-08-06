import type { Rotation, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type BoxAttributes = Readonly<{
  size: Vec3
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
}>

export const boxManifest = {
  tag: 'box',
  category: 'primitive',
  syntax: '<box size={[x,y,z]} pos={[x,y,z]} rotate={{axis,angle}} scale={[x,y,z]} />',
  summary: '축 정렬 직육면체를 생성합니다.',
} as const satisfies CadElementManifest<'box'>
