import type { Rotation, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type BooleanAttributes = Readonly<{
  pos?: Vec3
  rotate?: Rotation
  scale?: Vec3
  children?: unknown
}>

export const unionManifest = {
  tag: 'union',
  category: 'operation',
  syntax: '<union>...</union>',
  summary: '같은 Material의 자식 solid를 합칩니다.',
} as const satisfies CadElementManifest<'union'>
export const subtractManifest = {
  tag: 'subtract',
  category: 'operation',
  syntax: '<subtract>base cutter...</subtract>',
  summary: '첫 Geometry의 각 Material part에서 나머지 cutter solid를 뺍니다.',
} as const satisfies CadElementManifest<'subtract'>
export const intersectManifest = {
  tag: 'intersect',
  category: 'operation',
  syntax: '<intersect>shapeA shapeB...</intersect>',
  summary: '모든 자식 solid의 교집합을 구합니다.',
} as const satisfies CadElementManifest<'intersect'>
