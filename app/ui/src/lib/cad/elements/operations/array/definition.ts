import type { IntrinsicGeometryAttributes } from '../../../model/structure'
import type { Tensor, Vec3 } from '../../../model/types'
import type { CadElementManifest } from '../../../evaluation/types'

export type ArrayAttributes = Readonly<{
  shape: readonly [number, number, number]
  period: Vec3
  axes?: Readonly<{ x: Vec3; y: Vec3; z: Vec3 }>
  inject?: Readonly<Record<string, Tensor | Readonly<{ axis: Tensor; angle: Tensor }>>>
  children?: unknown
}> &
  IntrinsicGeometryAttributes

export const arrayManifest = {
  tag: 'array',
  authoringName: 'array',
  category: 'operation',
  standardTransforms: true,
  syntax: '<array shape={[nx,ny,nz]} period={[px,py,pz]} axes={{x,y,z}} inject={tensors}>Geometry</array>',
  summary: '하나의 Geometry를 3차원 격자에 반복 배치합니다.',
  keywords: ['array', 'lattice', 'pattern', 'grid', '배열', '격자', '반복'],
  properties: [
    {
      name: 'shape',
      type: 'readonly [number, number, number]',
      required: true,
      authoringValue: '[1, 1, 1]',
      description: 'X, Y, Z축 cell 개수입니다.',
    },
    {
      name: 'period',
      type: 'Vec3',
      required: true,
      authoringValue: '[0, 0, 0]',
      description: '각 lattice 축의 cell 중심 간격입니다.',
    },
    {
      name: 'axes',
      type: '{ x: Vec3; y: Vec3; z: Vec3 }',
      required: false,
      default: 'world XYZ axes',
      authoringValue: '{ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }',
      description: 'x/y/z lattice 방향이며 런타임에서 정규화됩니다.',
    },
    {
      name: 'inject',
      type: 'Readonly<Record<string, Tensor | { axis: Tensor; angle: Tensor }>>',
      required: false,
      authoringValue: 'undefined',
      description:
        'dense tensor로 cell props를 주입합니다. position/rotation/scale은 XYZ 축 값을 사용합니다.',
    },
  ],
  children: {
    count: 'one',
    description: '격자에 배치할 Geometry component 또는 intrinsic CAD element를 받습니다.',
  },
  origin: '전체 array가 원점 주위에 중심 정렬되며 cell identity에는 $cell-x-y-z가 붙습니다.',
  surfaces: [],
  example:
    '<array id="posts" shape={[3, 1, 1]} period={[20, 0, 0]}><Cylinder id="post" radius={2} height={30} /></array>',
} as const satisfies CadElementManifest<'array'>
