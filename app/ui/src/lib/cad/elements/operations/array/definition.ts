import type { Rotation, Tensor, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type ArrayAttributes = Readonly<{
  shape: readonly [number, number, number]
  period: Vec3
  axes?: Readonly<{ x: Vec3; y: Vec3; z: Vec3 }>
  inject?: Readonly<Record<string, Tensor | Readonly<{ axis: Tensor; angle: Tensor }>>>
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
  children?: unknown
}>

export const arrayManifest = {
  tag: 'array',
  category: 'operation',
  syntax: '<array shape={[nx,ny,nz]} period={[px,py,pz]} axes={{x,y,z}} inject={tensors}>Geometry</array>',
  summary: '하나의 Geometry를 3차원 격자에 반복 배치합니다.',
} as const satisfies CadElementManifest<'array'>
