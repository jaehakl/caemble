import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { CadElementManifest } from '../../../evaluation/types'

export type BooleanAttributes = Readonly<{
  children?: unknown
}> &
  IntrinsicGeometryAttributes

export const unionManifest = {
  tag: 'union',
  authoringName: 'union',
  category: 'operation',
  standardTransforms: true,
  syntax: '<union>...</union>',
  summary: '같은 Material의 자식 solid를 합칩니다.',
  keywords: ['union', 'boolean union', '합집합', '불리언'],
  properties: [],
  children: { count: 'many', description: '합칠 solid를 받습니다.' },
  origin: '자식 좌표를 유지한 채 결과에 이 element의 transform을 적용합니다.',
  surfaces: [],
  example: '<union id="body"><Box size={[10, 10, 10]} /><Cylinder radius={3} height={14} /></union>',
} as const satisfies CadElementManifest<'union'>
export const subtractManifest = {
  tag: 'subtract',
  authoringName: 'subtract',
  category: 'operation',
  standardTransforms: true,
  syntax: '<subtract>base cutter...</subtract>',
  summary: '첫 Geometry의 각 Material part에서 나머지 cutter solid를 뺍니다.',
  keywords: ['subtract', 'difference', 'cut', '차집합', '빼기', '절삭'],
  properties: [],
  children: {
    count: 'many',
    description: '첫 Geometry가 base이고 이후 Geometry가 cutter입니다.',
  },
  origin: '자식 좌표를 유지한 채 결과에 이 element의 transform을 적용합니다.',
  surfaces: [],
  example: '<subtract id="notched"><Box size={[20, 10, 6]} /><Box size={[4, 10, 3]} /></subtract>',
} as const satisfies CadElementManifest<'subtract'>
export const intersectManifest = {
  tag: 'intersect',
  authoringName: 'intersect',
  category: 'operation',
  standardTransforms: true,
  syntax: '<intersect>shapeA shapeB...</intersect>',
  summary: '모든 자식 solid의 교집합을 구합니다.',
  keywords: ['intersect', 'intersection', '교집합', '불리언'],
  properties: [],
  children: {
    count: 'many',
    description: '교차시킬 solid를 받습니다.',
  },
  origin: '자식 좌표를 유지한 채 결과에 이 element의 transform을 적용합니다.',
  surfaces: [],
  example: '<intersect id="overlap"><Box size={[10, 10, 10]} /><Sphere radius={7} /></intersect>',
} as const satisfies CadElementManifest<'intersect'>
