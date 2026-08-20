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
      description: 'X, Y, Z축 cell 개수인 정확히 세 개의 양의 안전한 정수입니다.',
    },
    {
      name: 'period',
      type: 'Vec3',
      required: true,
      description: '각 lattice 축의 유한한 cell 중심 간격입니다. cell이 둘 이상이면 양수, 아니면 0 이상이어야 합니다.',
    },
    {
      name: 'axes',
      type: '{ x: Vec3; y: Vec3; z: Vec3 }',
      required: false,
      default: 'world XYZ axes',
      description: '각각 정확히 세 유한 좌표인 0이 아닌 x/y/z lattice 방향이며 런타임에서 정규화됩니다.',
    },
    {
      name: 'inject',
      type: 'Readonly<Record<string, Tensor | { axis: Tensor; angle: Tensor }>>',
      required: false,
      description:
        '비어 있지 않은 dense finite tensor로 cell props를 주입합니다. 선두 shape가 일치해야 하며 position/rotation/scale은 뒤에 길이 3 축이 필요합니다. axis/angle 객체는 deprecated rotate 호환 전용입니다. id/materials/children 및 canonical/legacy transform 혼용은 금지됩니다.',
    },
  ],
  children: {
    count: 'one',
    description: 'id가 있는 Geometry component 또는 intrinsic CAD element를 정확히 하나 받습니다.',
  },
  origin: '전체 array가 원점 주위에 중심 정렬되며 cell identity에는 $cell-x-y-z가 붙습니다.',
  surfaces: ['child-defined'],
  example:
    '<array id="posts" shape={[3, 1, 1]} period={[20, 0, 0]}><Cylinder id="post" radius={2} height={30} /></array>',
} as const satisfies CadElementManifest<'array'>
